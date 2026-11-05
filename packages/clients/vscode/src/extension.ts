// VSCode extension entry point (docs/005 §2). Wires the task inbox, status bar,
// executor heartbeat, the realtime WS subscription and the user-facing commands.
// All control-plane calls go through `ControlPlaneClient`; all workspace file IO
// stays local.
import { createHash } from 'node:crypto';
import * as vscode from 'vscode';
import { ARTIFACT_KINDS } from '@sap-superagent/protocol';
import type {
  Approval,
  ArtifactKind,
  Notification,
  SubmitArtifactBody,
  Task,
} from '@sap-superagent/protocol';
import { ControlPlaneClient, ControlPlaneError, type TaskContextResponse } from './client.js';
import { EventStreamClient, type SocketLike } from './events.js';
import { ExecutorRuntime, type ExecutorState } from './executor.js';
import { evaluatePreflight } from './preflight.js';
import { ConnectionStatusBar } from './statusBar.js';
import {
  APPROVAL_ACTION_COMMAND,
  INBOX_VIEW_ID,
  READ_NOTIFICATION_COMMAND,
  TaskInboxProvider,
  describeTask,
  type InboxData,
  type WaitingItem,
} from './tasksView.js';
import {
  readWorkspaceBinding,
  toExecutorWorkspace,
  workspaceKeyForFolder,
  writeContextPackage,
  writeWorkspaceBinding,
} from './workspace.js';
import { TOKEN_ENV_VAR, TOKEN_SECRET_STORAGE_KEY, machineIdHash, resolveExecutorUser } from './token.js';

const CONFIG_SECTION = 'sapSuperAgent';
const DEFAULT_CONTROL_PLANE_URL = 'http://127.0.0.1:3080';
const CLAIMED_TASKS_STATE_KEY = 'sapSuperAgent.claimedTasks';
/** Global (not workspace-scoped) WS cursor: `context.globalState` per S3. */
const LAST_EVENT_SEQ_KEY = 'sapSuperAgent.lastEventSeq';
const INBOX_REFRESH_INTERVAL_MS = 30_000;

/** Event types that change the inbox / status bar and trigger a refresh. */
const REFRESH_EVENT_TYPES = new Set([
  'task.created',
  'task.updated',
  'task.released',
  'task.transferred',
  'task.cancelled',
  'task.claimed',
  'task.completed',
  'task.failed',
  'approval.requested',
  'approval.decided',
  'approval.expired',
  'approval.withdrawn',
  'artifact.stale',
  'demand.updated',
  'stage.waiting_human',
  'stage.failed',
]);

let client: ControlPlaneClient | undefined;
/** User/admin-token client for approvals/notifications (executor token is separate). */
let userClient: ControlPlaneClient | undefined;
let runtime: ExecutorRuntime | undefined;
let statusBar: ConnectionStatusBar | undefined;
let inbox: TaskInboxProvider | undefined;
let eventStream: EventStreamClient | undefined;
let extensionContext: vscode.ExtensionContext | undefined;
let refreshTimer: ReturnType<typeof setInterval> | undefined;
let socketFactory: ((url: string) => SocketLike) | undefined;
let availableTasks: Task[] = [];
let waitingApprovals: Approval[] = [];
let unreadNotifications: Notification[] = [];
let lastExecutorState: ExecutorState | undefined;
let lastWorkspaceFolder: string | null | undefined;
let refreshInFlight: Promise<void> | null = null;
let refreshQueued = false;
let authWarningShown = false;

const claimedTasks = new Map<string, Task>();

/**
 * @internal Test seam: inject a WS factory (unit tests never open a socket).
 * Pass `undefined` to restore the real `ws` implementation.
 */
export function setEventSocketFactory(factory: ((url: string) => SocketLike) | undefined): void {
  socketFactory = factory;
}

function configuration(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration(CONFIG_SECTION);
}

function controlPlaneUrl(): string {
  return configuration().get<string>('controlPlaneUrl', DEFAULT_CONTROL_PLANE_URL);
}

function isAccepting(): boolean {
  return configuration().get<boolean>('accepting', true);
}

function currentWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
  return vscode.workspace.workspaceFolders?.[0];
}

async function resolveToken(context: vscode.ExtensionContext): Promise<string | undefined> {
  const fromEnv = process.env[TOKEN_ENV_VAR]?.trim();
  if (fromEnv !== undefined && fromEnv !== '') {
    return fromEnv;
  }
  const stored = await context.secrets.get(TOKEN_SECRET_STORAGE_KEY);
  return stored === undefined || stored.trim() === '' ? undefined : stored;
}

function updateStatusBar(state?: ExecutorState): void {
  if (statusBar === undefined) {
    return;
  }
  const effective = state ?? lastExecutorState;
  statusBar.update({
    connection: effective?.connection ?? 'offline',
    accepting: effective?.accepting ?? isAccepting(),
    pendingCount: effective?.pendingCount ?? availableTasks.length + claimedTasks.size,
  });
}

function asTask(value: unknown): Task | undefined {
  if (value === null || typeof value !== 'object') {
    return undefined;
  }
  const candidate = value as Partial<Task>;
  return typeof candidate.id === 'string' && typeof candidate.title === 'string' && typeof candidate.state === 'string'
    ? (candidate as Task)
    : undefined;
}

function asApproval(value: unknown): Approval | undefined {
  if (value === null || typeof value !== 'object') {
    return undefined;
  }
  const candidate = value as Partial<Approval>;
  return typeof candidate.id === 'string' && typeof candidate.gateKey === 'string' && candidate.state === 'pending'
    ? (candidate as Approval)
    : undefined;
}

function asNotification(value: unknown): Notification | undefined {
  if (value === null || typeof value !== 'object') {
    return undefined;
  }
  const candidate = value as Partial<Notification>;
  return typeof candidate.id === 'string' && typeof candidate.title === 'string'
    ? (candidate as Notification)
    : undefined;
}

async function persistClaimedTasks(context: vscode.ExtensionContext): Promise<void> {
  await context.workspaceState.update(CLAIMED_TASKS_STATE_KEY, [...claimedTasks.values()]);
}

function syncRuntimeActiveTasks(): void {
  runtime?.setActiveTasks([...claimedTasks.keys()]);
}

/** "等待我回答" rows: pending gates + unread notifications that are not already gates. */
function buildWaitingItems(): WaitingItem[] {
  const pendingApprovalIds = new Set(waitingApprovals.map((approval) => approval.id));
  const items: WaitingItem[] = waitingApprovals.map((approval) => ({
    kind: 'approval' as const,
    approval,
  }));
  for (const notification of unreadNotifications) {
    if (notification.approvalId !== null && pendingApprovalIds.has(notification.approvalId)) {
      continue;
    }
    items.push({ kind: 'notification' as const, notification });
  }
  return items;
}

function showActionableError(error: unknown, prefix: string): void {
  if (error instanceof ControlPlaneError) {
    if (error.status === 401 || error.status === 403) {
      if (!authWarningShown) {
        authWarningShown = true;
        void vscode.window.showWarningMessage(
          '控制平面拒绝了 token（401/403）。请运行 “SAP Super Agent: 连接控制平面” 重新授权；已暂停接单，不会静默重试。',
        );
      }
      return;
    }
    void vscode.window.showWarningMessage(`${prefix}：${error.message}`);
    return;
  }
  void vscode.window.showWarningMessage(`${prefix}：${error instanceof Error ? error.message : String(error)}`);
}

async function doRefreshInbox(): Promise<void> {
  if (inbox === undefined) {
    return;
  }
  if (client !== undefined) {
    try {
      const response = await client.listTasks({ state: 'pending' });
      availableTasks = response.tasks.filter((task) => task.executorKind === 'vscode');
    } catch (error) {
      // Offline is expected; the status bar already reflects the connection.
      if (!(error instanceof ControlPlaneError) || error.status !== 0) {
        availableTasks = [];
      }
    }
  }
  if (userClient !== undefined) {
    try {
      const [approvals, notifications] = await Promise.all([
        userClient.listApprovals({ assignee: 'me', state: 'pending' }),
        userClient.listNotifications({ state: 'unread' }),
      ]);
      waitingApprovals = approvals.approvals;
      unreadNotifications = notifications.notifications;
    } catch (error) {
      showActionableError(error, '读取审批/通知失败');
    }
  }
  const data: InboxData = {
    available: availableTasks,
    mine: [...claimedTasks.values()],
    waiting: buildWaitingItems(),
  };
  inbox.refresh(data);
  const pendingCount = data.available.length + data.mine.length + data.waiting.length;
  runtime?.setPendingCount(pendingCount);
  updateStatusBar();
}

/**
 * Refresh the inbox; concurrent triggers (WS frames + timer + command) coalesce
 * into at most one in-flight REST round, re-running once if another arrived.
 */
function refreshInbox(): Promise<void> {
  if (refreshInFlight !== null) {
    refreshQueued = true;
    return refreshInFlight;
  }
  refreshInFlight = (async () => {
    do {
      refreshQueued = false;
      await doRefreshInbox();
    } while (refreshQueued && inbox !== undefined);
  })().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

/** Release every held task (workspace switch / reconnect), best effort. */
async function releaseClaimedTasks(reason: string): Promise<number> {
  const released: string[] = [];
  for (const taskId of [...claimedTasks.keys()]) {
    if (client !== undefined && client.registeredExecutorId !== null) {
      try {
        await client.release(taskId);
        released.push(taskId);
      } catch {
        // The lease may already be gone (expiry); dropping it locally is right.
      }
    }
    claimedTasks.delete(taskId);
  }
  syncRuntimeActiveTasks();
  if (extensionContext !== undefined) {
    await persistClaimedTasks(extensionContext);
  }
  if (released.length > 0) {
    void vscode.window.showInformationMessage(
      `已释放 ${released.length} 个任务（${reason}），它们已回到可领取池。`,
    );
  }
  return released.length;
}

async function resyncAfterGap(context: vscode.ExtensionContext, frame: { lastSeq: number; earliestSeq: number }): Promise<void> {
  // Full pull (docs/003 §4.4): authoritative inbox + retained event replay.
  await refreshInbox();
  if (client === undefined) {
    return;
  }
  try {
    const replay = await client.listEvents(Math.max(frame.earliestSeq - 1, 0));
    await context.globalState.update(LAST_EVENT_SEQ_KEY, replay.lastSeq);
    eventStream?.seek(replay.lastSeq);
  } catch {
    // The next reconnect will hit resync_required again; state stays authoritative via REST.
  }
  await refreshInbox();
}

function handleEventType(type: string): void {
  if (REFRESH_EVENT_TYPES.has(type)) {
    void refreshInbox();
  }
}

function stopEventStream(): void {
  eventStream?.stop();
  eventStream = undefined;
}

function startEventStream(context: vscode.ExtensionContext): void {
  stopEventStream();
  if (client === undefined || lastExecutorState?.connection !== 'online') {
    return;
  }
  const afterSeq = context.globalState.get<number>(LAST_EVENT_SEQ_KEY, 0);
  eventStream = new EventStreamClient({
    url: client.eventStreamUrl(),
    afterSeq,
    ...(socketFactory === undefined ? {} : { createSocket: socketFactory }),
    onEvent: (event) => handleEventType(event.type),
    onTaskOffered: () => {
      // Transport hint: refresh the inbox immediately instead of waiting for a poll.
      void refreshInbox();
    },
    onResync: (frame) => {
      void resyncAfterGap(context, frame);
    },
    onSeq: (seq) => {
      void context.globalState.update(LAST_EVENT_SEQ_KEY, seq);
    },
  });
  eventStream.start();
}

async function startExecutor(context: vscode.ExtensionContext): Promise<void> {
  extensionContext = context;
  const token = await resolveToken(context);
  if (token === undefined) {
    updateStatusBar();
    return;
  }
  const url = controlPlaneUrl();
  const folder = currentWorkspaceFolder();
  const binding = folder === undefined ? undefined : await readWorkspaceBinding(folder.uri.fsPath);
  const workspace =
    folder === undefined
      ? null
      : (toExecutorWorkspace(binding, workspaceKeyForFolder(folder.uri.fsPath), folder.name) ?? null);
  // docs/005 §2.5 / docs/009 #5: switching the open folder releases held tasks,
  // even for unbound tasks (an unbound workspace has no workspaceKey at all).
  const folderPath = folder?.uri.fsPath ?? null;
  if (lastWorkspaceFolder !== undefined && lastWorkspaceFolder !== folderPath && claimedTasks.size > 0) {
    stopEventStream();
    await releaseClaimedTasks(`工作区已切换：${lastWorkspaceFolder ?? '无'} → ${folderPath ?? '无'}`);
  }
  lastWorkspaceFolder = folderPath;

  client ??= new ControlPlaneClient({ baseUrl: url, token });
  client.setBaseUrl(url);
  // `token` is the user/admin token from SecretStorage; register exchanges it
  // for the executor token used by heartbeat/claim/WS (server-side rule).
  client.setBaseToken(token);
  userClient ??= new ControlPlaneClient({ baseUrl: url, token });
  userClient.setBaseUrl(url);
  userClient.setToken(token);

  if (runtime !== undefined) {
    stopEventStream();
    await runtime.stop({ unregister: true });
    runtime = undefined;
  }

  runtime = new ExecutorRuntime({
    client,
    user: resolveExecutorUser({ token, machineId: vscode.env.machineId }),
    machineIdHash: machineIdHash(vscode.env.machineId),
    workspace,
    roles: ['developer'],
    capabilities: ['coding', 'doc-review'],
    accepting: isAccepting(),
    onState: (state) => {
      lastExecutorState = state;
      updateStatusBar(state);
      if (state.connection === 'paused') {
        stopEventStream();
      }
    },
    onError: (message) => {
      void vscode.window.showWarningMessage(message);
    },
    onOffers: () => {
      void refreshInbox();
    },
    onLeaseLost: (taskId, error) => {
      claimedTasks.delete(taskId);
      syncRuntimeActiveTasks();
      void persistClaimedTasks(context);
      void vscode.window.showWarningMessage(
        `任务 ${taskId} 的租约已失效（${error.message}），已从“我的任务”移除。`,
      );
      void refreshInbox();
    },
  });
  syncRuntimeActiveTasks();
  await runtime.start();
  if (lastExecutorState?.connection === 'online') {
    startEventStream(context);
  }
  await refreshInbox();
}

function requireClient(): ControlPlaneClient | undefined {
  if (client === undefined) {
    void vscode.window.showWarningMessage('尚未连接控制平面。请先运行 “SAP Super Agent: 连接控制平面”。');
  }
  return client;
}

async function chooseTask(onlyMine: boolean, arg?: unknown): Promise<Task | undefined> {
  const direct = asTask(arg);
  if (direct !== undefined) {
    return direct;
  }
  const candidates = onlyMine ? [...claimedTasks.values()] : availableTasks;
  if (candidates.length === 0) {
    void vscode.window.showInformationMessage(
      onlyMine ? '当前没有进行中的任务。请先在任务箱领取任务。' : '当前没有可领取任务。',
    );
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(
    candidates.map((task) => ({ label: task.title, description: describeTask(task), task })),
    { placeHolder: onlyMine ? '选择你的任务' : '选择要领取的任务' },
  );
  return picked?.task;
}

async function commandConnect(context: vscode.ExtensionContext): Promise<void> {
  const url = await vscode.window.showInputBox({
    prompt: '控制平面地址',
    value: controlPlaneUrl(),
    placeHolder: DEFAULT_CONTROL_PLANE_URL,
    ignoreFocusOut: true,
  });
  if (url === undefined || url.trim() === '') {
    return;
  }
  const token = await vscode.window.showInputBox({
    prompt: '用户 token（CLI: sap-superagent token，默认 kind=user）',
    password: true,
    ignoreFocusOut: true,
    validateInput: (value) => (value.trim() === '' ? 'token 不能为空' : undefined),
  });
  if (token === undefined || token.trim() === '') {
    return;
  }
  await context.secrets.store(TOKEN_SECRET_STORAGE_KEY, token.trim());
  await configuration().update('controlPlaneUrl', url.trim(), vscode.ConfigurationTarget.Global);
  authWarningShown = false;
  await startExecutor(context);
  if (lastExecutorState?.connection === 'online') {
    void vscode.window.showInformationMessage('已连接控制平面。');
  }
}

async function commandBindWorkspace(context: vscode.ExtensionContext): Promise<void> {
  const folder = currentWorkspaceFolder();
  if (folder === undefined) {
    void vscode.window.showWarningMessage('请先打开一个工作区文件夹，再绑定工作区。');
    return;
  }
  const existing = await readWorkspaceBinding(folder.uri.fsPath);
  const repo = await vscode.window.showInputBox({
    prompt: '仓库名（repo，写在 .sap-superagent/workspace.json）',
    value: existing?.repo ?? '',
    ignoreFocusOut: true,
  });
  if (repo === undefined) {
    return;
  }
  const projectKey = await vscode.window.showInputBox({
    prompt: '项目 key（projectKey，可留空）',
    value: existing?.projectKey ?? '',
    ignoreFocusOut: true,
  });
  if (projectKey === undefined) {
    return;
  }
  const baseBranch = await vscode.window.showInputBox({
    prompt: '基线分支（baseBranch）',
    value: existing?.baseBranch ?? 'main',
    ignoreFocusOut: true,
  });
  if (baseBranch === undefined) {
    return;
  }
  const filePath = await writeWorkspaceBinding(folder.uri.fsPath, {
    repo,
    projectKey,
    baseBranch,
    prepare: existing?.prepare ?? null,
  });
  void vscode.window.showInformationMessage(`已写入 ${filePath}。`);
  await startExecutor(context);
}

async function commandClaimTask(context: vscode.ExtensionContext, arg?: unknown): Promise<void> {
  const activeClient = requireClient();
  if (activeClient === undefined) {
    return;
  }
  const task = await chooseTask(false, arg);
  if (task === undefined) {
    return;
  }
  // docs/005 §2.5 preflight: never claim work we cannot execute safely.
  const preflight = evaluatePreflight({
    workspaceTrusted: vscode.workspace.isTrusted ?? true,
    hasWorkspaceFolder: currentWorkspaceFolder() !== undefined,
  });
  if (!preflight.ok) {
    void vscode.window.showWarningMessage(preflight.issues.map((issue) => `${issue.message} → ${issue.action}`).join('\n'));
    return;
  }
  try {
    const response = await activeClient.claim(task.id);
    claimedTasks.set(response.task.id, response.task);
    syncRuntimeActiveTasks();
    await persistClaimedTasks(context);
    await refreshInbox();
    void vscode.window.showInformationMessage(`已领取：${response.task.title}`);
    await commandOpenTask(context, response.task);
  } catch (error) {
    if (error instanceof ControlPlaneError && error.status === 409) {
      void vscode.window.showWarningMessage('任务已被其他人领取或状态已变化，正在刷新任务箱。');
      await refreshInbox();
      return;
    }
    throw error;
  }
}

async function commandOpenTask(context: vscode.ExtensionContext, arg?: unknown): Promise<void> {
  const activeClient = requireClient();
  if (activeClient === undefined) {
    return;
  }
  const task = asTask(arg) ?? (await chooseTask(false));
  if (task === undefined) {
    return;
  }
  const folder = currentWorkspaceFolder();
  let response: TaskContextResponse;
  try {
    response = await activeClient.getContext(task.id);
  } catch (error) {
    if (error instanceof ControlPlaneError) {
      void vscode.window.showWarningMessage(`读取任务上下文失败：${error.message}`);
      return;
    }
    throw error;
  }

  if (folder !== undefined) {
    const paths = await writeContextPackage(folder.uri.fsPath, task.id, response);
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(paths.markdownPath));
    await vscode.window.showTextDocument(document, { preview: true });
    void vscode.window.showInformationMessage(`上下文包：${paths.markdownPath}`);
  } else {
    // No folder open: still show the context pack in an untitled Markdown tab.
    const markdown = response.markdown.trim() === '' ? JSON.stringify(response.json, null, 2) : response.markdown;
    const document = await vscode.workspace.openTextDocument({ content: markdown, language: 'markdown' });
    await vscode.window.showTextDocument(document, { preview: true });
  }
  await context.workspaceState.update('sapSuperAgent.lastOpenedTaskId', task.id);
}

async function commandSubmitArtifact(context: vscode.ExtensionContext, arg?: unknown): Promise<void> {
  const activeClient = requireClient();
  if (activeClient === undefined) {
    return;
  }
  const task = await chooseTask(true, arg);
  if (task === undefined) {
    return;
  }
  const kindItem = await vscode.window.showQuickPick(
    ARTIFACT_KINDS.map((kind) => ({ label: kind })),
    { placeHolder: '工件类型' },
  );
  if (kindItem === undefined) {
    return;
  }
  const summary = await vscode.window.showInputBox({
    prompt: '工件摘要（会写入事件时间线）',
    ignoreFocusOut: true,
    validateInput: (value) => (value.trim() === '' ? '摘要不能为空' : undefined),
  });
  if (summary === undefined || summary.trim() === '') {
    return;
  }

  const editor = vscode.window.activeTextEditor;
  const content =
    editor === undefined
      ? `# ${task.title}\n\n${summary.trim()}\n`
      : editor.document.getText();
  const body: SubmitArtifactBody = {
    kind: kindItem.label as ArtifactKind,
    contentType: editor === undefined ? 'text/markdown' : editor.document.languageId,
    contentBase64: Buffer.from(content, 'utf8').toString('base64'),
    checksum: `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`,
    summary: summary.trim(),
    title: task.title,
  };

  try {
    const response = await activeClient.submitArtifact(task.id, body);
    void vscode.window.showInformationMessage(
      `工件已提交：${response.artifact.kind} v${response.version.version}`,
    );
    const action = await vscode.window.showInformationMessage('工件已提交。要现在完成任务吗？', '完成任务', '稍后');
    if (action === '完成任务') {
      const completed = await activeClient.complete(task.id, {
        summary: summary.trim(),
        artifactIds: [response.artifact.id],
        links: [],
        openQuestions: [],
      });
      claimedTasks.delete(task.id);
      syncRuntimeActiveTasks();
      await persistClaimedTasks(context);
      await refreshInbox();
      void vscode.window.showInformationMessage(`任务已完成：${completed.task.title}`);
    }
  } catch (error) {
    if (error instanceof ControlPlaneError) {
      void vscode.window.showWarningMessage(`提交工件失败：${error.message}`);
      return;
    }
    throw error;
  }
}

/** Tree action: decide a pending gate without leaving the inbox (docs/005 §2.2). */
async function commandApprovalAction(arg?: unknown): Promise<void> {
  const approval = asApproval(arg);
  if (approval === undefined || userClient === undefined) {
    return;
  }
  const choice = await vscode.window.showQuickPick(
    [
      { label: '通过', description: 'approve', decision: 'approve' as const },
      { label: '驳回', description: 'reject', decision: 'reject' as const },
    ],
    { placeHolder: `审批 ${approval.gateKey}（需求 ${approval.demandId}）` },
  );
  if (choice === undefined) {
    return;
  }
  const comment = await vscode.window.showInputBox({
    prompt: '审批意见（可留空）',
    ignoreFocusOut: true,
  });
  if (comment === undefined) {
    return;
  }
  try {
    await userClient.decideApproval(approval.id, {
      decision: choice.decision,
      ...(comment.trim() === '' ? {} : { comment: comment.trim() }),
    });
    await refreshInbox();
    void vscode.window.showInformationMessage(`审批已提交：${approval.gateKey} ${choice.label}。`);
  } catch (error) {
    if (error instanceof ControlPlaneError && error.status === 409) {
      void vscode.window.showWarningMessage('该审批已被其他人处理，正在刷新任务箱。');
      await refreshInbox();
      return;
    }
    showActionableError(error, '提交审批失败');
  }
}

/** Tree action: mark an unread notification as read. */
async function commandReadNotification(arg?: unknown): Promise<void> {
  const notification = asNotification(arg);
  if (notification === undefined || userClient === undefined) {
    return;
  }
  try {
    await userClient.markNotificationRead(notification.id);
    await refreshInbox();
  } catch (error) {
    if (error instanceof ControlPlaneError && error.status === 404) {
      await refreshInbox();
      return;
    }
    showActionableError(error, '标记通知已读失败');
  }
}

async function commandToggleAccepting(context: vscode.ExtensionContext): Promise<void> {
  const next = !isAccepting();
  await configuration().update('accepting', next, vscode.ConfigurationTarget.Global);
  runtime?.setAccepting(next);
  updateStatusBar();
  void vscode.window.showInformationMessage(next ? '已恢复接单。' : '已暂停接单（仍在线，不会领取新任务）。');
  void context.workspaceState.update('sapSuperAgent.accepting', next);
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  extensionContext = context;
  inbox = new TaskInboxProvider();
  const treeView = vscode.window.createTreeView(INBOX_VIEW_ID, {
    treeDataProvider: inbox,
    showCollapseAll: true,
  });
  statusBar = new ConnectionStatusBar({ connection: 'offline', accepting: isAccepting(), pendingCount: 0 });

  const restored = context.workspaceState.get<Task[]>(CLAIMED_TASKS_STATE_KEY, []);
  for (const task of restored) {
    const valid = asTask(task);
    if (valid !== undefined) {
      claimedTasks.set(valid.id, valid);
    }
  }

  context.subscriptions.push(
    treeView,
    statusBar,
    inbox,
    vscode.commands.registerCommand('sapSuperAgent.connect', () => commandConnect(context)),
    vscode.commands.registerCommand('sapSuperAgent.bindWorkspace', () => commandBindWorkspace(context)),
    vscode.commands.registerCommand('sapSuperAgent.claimTask', (arg?: unknown) => commandClaimTask(context, arg)),
    vscode.commands.registerCommand('sapSuperAgent.openTask', (arg?: unknown) => commandOpenTask(context, arg)),
    vscode.commands.registerCommand('sapSuperAgent.submitArtifact', (arg?: unknown) =>
      commandSubmitArtifact(context, arg),
    ),
    vscode.commands.registerCommand('sapSuperAgent.toggleAccepting', () => commandToggleAccepting(context)),
    // Context actions for the "等待我回答" group (not contributed to the palette).
    vscode.commands.registerCommand(APPROVAL_ACTION_COMMAND, (arg?: unknown) => commandApprovalAction(arg)),
    vscode.commands.registerCommand(READ_NOTIFICATION_COMMAND, (arg?: unknown) =>
      commandReadNotification(arg),
    ),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(`${CONFIG_SECTION}.accepting`)) {
        runtime?.setAccepting(isAccepting());
        updateStatusBar();
      }
      if (event.affectsConfiguration(`${CONFIG_SECTION}.controlPlaneUrl`)) {
        void startExecutor(context);
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void startExecutor(context);
    }),
  );

  refreshTimer = setInterval(() => {
    void refreshInbox();
  }, INBOX_REFRESH_INTERVAL_MS);
  context.subscriptions.push({
    dispose: () => {
      if (refreshTimer !== undefined) {
        clearInterval(refreshTimer);
        refreshTimer = undefined;
      }
    },
  });

  const token = await resolveToken(context);
  if (token !== undefined) {
    await startExecutor(context);
  } else {
    updateStatusBar();
  }
}

export async function deactivate(): Promise<void> {
  if (refreshTimer !== undefined) {
    clearInterval(refreshTimer);
    refreshTimer = undefined;
  }
  stopEventStream();
  const current = runtime;
  runtime = undefined;
  await current?.stop({ unregister: true });
  statusBar?.dispose();
  statusBar = undefined;
  inbox = undefined;
  client = undefined;
  userClient = undefined;
  extensionContext = undefined;
  availableTasks = [];
  waitingApprovals = [];
  unreadNotifications = [];
  lastWorkspaceFolder = undefined;
  lastExecutorState = undefined;
  authWarningShown = false;
}
