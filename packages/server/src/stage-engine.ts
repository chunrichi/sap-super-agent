import {
  DEFAULT_GATE_TIMEOUT_DAYS,
  newUlid,
  type Approval,
  type Artifact,
  type ArtifactVersion,
  type AuthorType,
  type Demand,
  type StageRun,
  type StageTemplate,
  type StageTemplateFile,
  type Task,
} from '@sap-superagent/protocol';
import {
  canTransitionDemand,
  canTransitionStageRun,
  collectInputRefs,
  evaluateStageCompletion,
  gateForStage,
  missingInputArtifactKinds,
  nextStage,
  parseStructuredOutput,
  type StageCompletionResult,
} from '@sap-superagent/core';
import {
  artifactContentRef,
  checksumOfBytes,
  readArtifactBytes,
  writeArtifactBytes,
} from './artifact-store.js';
import { insertApproval, updateApproval } from './db/approvals.js';
import { conflict } from './errors.js';
import {
  findArtifactByKind,
  findArtifactForStage,
  getArtifact,
  getArtifactVersion,
  insertArtifact,
  insertArtifactVersion,
  latestArtifactRefsByKind,
  markArtifactVersionStale,
  updateArtifact,
} from './db/artifacts.js';
import { getDemand, updateDemand } from './db/demands.js';
import { insertNotification } from './db/notifications.js';
import {
  getStageRun,
  getStageRunByKey,
  hasStageAttempt,
  insertStageAttempt,
  updateStageRun,
} from './db/stages.js';
import { getOpenTaskForStageRun, insertTask } from './db/tasks.js';
import type { TransactionContext } from './db/transaction.js';
import type { ServerContext } from './types.js';

// ---------------------------------------------------------------------------
// Stage lifecycle engine (docs/003 §2.2/§2.4/§2.5/§2.7, H1).
//
// One place decides what happens after a stage attempt produces an artifact:
//   schema + checklist -> gate (approval + waiting_human) or auto-advance;
//   failure -> attempt+1 (new task for vscode / ready for server-ai) or
//   waiting_human when maxAttempts is exhausted; artifact revisions supersede
//   older versions and mark downstream artifacts stale.
// All helpers run inside a `writeTransaction` and append events through `tx`.
// ---------------------------------------------------------------------------

const CONFIRM_GATE_PREFIX = 'confirm:';
const CONFIRM_GATE_ROLE = 'consultant';

export interface StageLedgerRecord {
  model: string | null;
  promptVersion: string | null;
  schemaOk: boolean;
  tokens: number;
  costUsd: number;
  durationMs: number;
  error: string | null;
  startedAt: string;
}

export interface StageOutputInput {
  contentText: string;
  contentType: string;
  authorType: AuthorType;
  authorId: string;
  summary: string | null;
  title: string | null;
}

export interface CompleteStageOutputParams {
  demand: Demand;
  template: StageTemplateFile;
  stageRun: StageRun;
  stageTemplate: StageTemplate;
  output: StageOutputInput;
  ledger: StageLedgerRecord;
}

export interface CompleteStageResult {
  ok: boolean;
  completion: StageCompletionResult | null;
  artifact: Artifact | null;
  version: ArtifactVersion | null;
  stageStatus: StageRun['status'];
  failures: string[];
}

function log(ctx: ServerContext, message: string): void {
  if (ctx.config.logger) console.error(`[stage-engine] ${message}`);
}

function appendStageEvent(
  tx: TransactionContext,
  stageRun: StageRun,
  type: 'stage.ready' | 'stage.started' | 'stage.done' | 'stage.failed' | 'stage.waiting_human',
  data: Record<string, unknown>,
): void {
  tx.append({
    type,
    subject: { type: 'stage_run', id: stageRun.id },
    data: { stageRunId: stageRun.id, demandId: stageRun.demandId, stageKey: stageRun.stageKey, ...data },
    demandId: stageRun.demandId,
  });
}

function notify(
  tx: TransactionContext,
  input: {
    demandId: string;
    stageRunId: string | null;
    approvalId: string | null;
    kind: 'approval.requested' | 'approval.decided' | 'approval.expired' | 'stage.waiting_human' | 'stage.failed';
    requiredRole: Approval['requiredRole'] | null;
    title: string;
    body: string | null;
  },
): void {
  insertNotification(tx.db, {
    id: newUlid(),
    demandId: input.demandId,
    stageRunId: input.stageRunId,
    approvalId: input.approvalId,
    kind: input.kind,
    requiredRole: input.requiredRole,
    title: input.title,
    body: input.body,
    createdAt: tx.now,
    readAt: null,
  });
}

/** Create the vscode task materializing a ready stage attempt (docs/003 §2.2). */
export function planTaskForStage(
  tx: TransactionContext,
  ctx: ServerContext,
  demand: Demand,
  stageTemplate: StageTemplate,
  stageRun: StageRun,
): Task | null {
  if (stageTemplate.executorKind !== 'vscode') return null;
  if (getOpenTaskForStageRun(ctx.db, stageRun.id) !== null) return null;
  const title = `${demand.title} · ${stageTemplate.name}`.slice(0, 200);
  const task: Task = {
    id: newUlid(),
    demandId: demand.id,
    stageRunId: stageRun.id,
    title,
    executorKind: 'vscode',
    requiredRoles: [...stageTemplate.requiredRoles],
    workspaceBinding: demand.workspaceBinding,
    priority: demand.priority,
    dueAt: null,
    state: 'pending',
    lastHolderUserIds: [],
    createdAt: tx.now,
    updatedAt: tx.now,
  };
  insertTask(ctx.db, task);
  tx.append({
    type: 'task.created',
    subject: { type: 'task', id: task.id },
    data: {
      taskId: task.id,
      demandId: demand.id,
      stageRunId: stageRun.id,
      stageKey: stageRun.stageKey,
      executorKind: task.executorKind,
      priority: task.priority,
      title: task.title,
    },
    demandId: demand.id,
  });
  log(ctx, `planned task ${task.id} for stage ${stageRun.stageKey} attempt ${stageRun.attempt}`);
  return task;
}

/**
 * Move to the next template stage (or close the demand). `finalAcceptancePassed`
 * is true when the last stage completes through an approved gate: that *is* the
 * final acceptance, so the demand goes review -> done (docs/003 §2.1).
 */
export function advanceToNextStage(
  tx: TransactionContext,
  ctx: ServerContext,
  demandId: string,
  template: StageTemplateFile,
  doneStageKey: string,
  finalAcceptancePassed: boolean,
): void {
  const demand = getDemand(ctx.db, demandId);
  if (demand === null) return;
  const next = nextStage(template, doneStageKey);
  if (next === undefined) {
    if (demand.status === 'in_progress') {
      const reviewed: Demand = { ...demand, status: 'review', updatedAt: tx.now };
      updateDemand(ctx.db, reviewed);
      if (finalAcceptancePassed && canTransitionDemand('review', 'done')) {
        const done: Demand = { ...reviewed, status: 'done', updatedAt: tx.now };
        updateDemand(ctx.db, done);
        tx.append({
          type: 'demand.updated',
          subject: { type: 'demand', id: demandId },
          data: { demandId, status: 'done', reason: 'final_acceptance_passed' },
          demandId,
        });
      } else {
        tx.append({
          type: 'demand.updated',
          subject: { type: 'demand', id: demandId },
          data: { demandId, status: 'review', reason: 'all_stages_done' },
          demandId,
        });
      }
    }
    return;
  }

  const nextRun = getStageRunByKey(ctx.db, demandId, next.key);
  if (nextRun === null || nextRun.status !== 'pending') return;
  const availability = { byKind: latestArtifactRefsByKind(ctx.db, demandId) };
  if (missingInputArtifactKinds(next, availability).length > 0) return;
  const ready: StageRun = {
    ...nextRun,
    status: 'ready',
    inputRefs: collectInputRefs(next, availability),
    updatedAt: tx.now,
  };
  updateStageRun(ctx.db, ready);
  appendStageEvent(tx, ready, 'stage.ready', {
    executorKind: ready.executorKind,
    attempt: ready.attempt,
    inputRefs: ready.inputRefs,
  });
  planTaskForStage(tx, ctx, demand, next, ready);
}

/** Persist a new immutable artifact version, superseding the previous one. */
export function persistStageArtifact(
  tx: TransactionContext,
  ctx: ServerContext,
  params: {
    demand: Demand;
    template: StageTemplateFile;
    stageRun: StageRun;
    stageTemplate: StageTemplate;
    output: StageOutputInput;
  },
): { artifact: Artifact; version: ArtifactVersion; artifactVersion: number } {
  const { demand, stageRun, stageTemplate, output } = params;
  const bytes = Buffer.from(output.contentText, 'utf8');
  const checksum = checksumOfBytes(bytes);
  const existing =
    (stageRun.outputArtifactId === null ? null : getArtifact(ctx.db, stageRun.outputArtifactId)) ??
    findArtifactByKind(ctx.db, demand.id, stageTemplate.outputArtifactKind);
  const artifactId = existing === null ? newUlid() : existing.id;
  const versionNumber = existing === null ? 1 : existing.currentVersion + 1;
  writeArtifactBytes(ctx.config.stateDir, artifactId, versionNumber, bytes);

  const artifact: Artifact = {
    id: artifactId,
    demandId: demand.id,
    kind: stageTemplate.outputArtifactKind,
    stageKey: stageRun.stageKey,
    stageRunId: stageRun.id,
    state: 'generated',
    currentVersion: versionNumber,
    title: output.title,
    createdAt: existing === null ? tx.now : existing.createdAt,
    updatedAt: tx.now,
  };
  if (existing === null) insertArtifact(ctx.db, artifact);
  else updateArtifact(ctx.db, artifact);

  const contentRef = artifactContentRef(artifactId, versionNumber);
  const version: ArtifactVersion = {
    artifactId,
    version: versionNumber,
    contentRef,
    contentType: output.contentType,
    checksum,
    summary: output.summary,
    authorType: output.authorType,
    authorId: output.authorId,
    stale: false,
    createdAt: tx.now,
  };
  insertArtifactVersion(ctx.db, version);
  updateStageRun(ctx.db, { ...stageRun, outputArtifactId: artifactId, updatedAt: tx.now });

  tx.append({
    type: 'artifact.created',
    subject: { type: 'artifact', id: artifactId },
    data: {
      artifactId,
      demandId: demand.id,
      stageRunId: stageRun.id,
      stageKey: stageRun.stageKey,
      kind: artifact.kind,
      version: versionNumber,
      checksum,
      contentRef,
      authorType: output.authorType,
      authorId: output.authorId,
      supersedes: versionNumber > 1 ? versionNumber - 1 : null,
    },
    demandId: demand.id,
  });
  if (versionNumber > 1) {
    propagateStaleForArtifact(tx, ctx, demand.id, artifact.kind, versionNumber);
  }
  return { artifact, version, artifactVersion: versionNumber };
}

/**
 * Mark downstream artifacts stale when an upstream artifact gets a new version
 * (docs/003 §2.2/§2.4). Pending gate approvals then reject their approve action
 * with `details.reason=artifact_stale` until the stage is regenerated.
 */
export function propagateStaleForArtifact(
  tx: TransactionContext,
  ctx: ServerContext,
  demandId: string,
  upstreamKind: Artifact['kind'],
  upstreamVersion: number,
): string[] {
  const demand = getDemand(ctx.db, demandId);
  if (demand === null) return [];
  const template = ctx.templates.getForDemand(demand);
  if (template === undefined) return [];
  const staled: string[] = [];
  for (const stage of template.stages) {
    if (!stage.inputArtifactKinds.includes(upstreamKind)) continue;
    const downstream = findArtifactForStage(ctx.db, demandId, stage.key);
    if (downstream === null) continue;
    const version = getArtifactVersion(ctx.db, downstream.id, downstream.currentVersion);
    if (version === null || version.stale) continue;
    markArtifactVersionStale(ctx.db, downstream.id, downstream.currentVersion, true);
    staled.push(`${downstream.id}@v${downstream.currentVersion}`);
    tx.append({
      type: 'artifact.stale',
      subject: { type: 'artifact', id: downstream.id },
      data: {
        artifactId: downstream.id,
        demandId,
        stageKey: stage.key,
        artifactVersion: downstream.currentVersion,
        upstreamKind,
        upstreamVersion,
        reason: 'upstream_new_version',
      },
      demandId,
    });
    const stageRun = getStageRunByKey(ctx.db, demandId, stage.key);
    if (stageRun !== null) {
      if (stageRun.status === 'ready') {
        // Refresh inputs so the pending task context points at the new version;
        // the checklist still forces a fresh output version before completion.
        const availability = { byKind: latestArtifactRefsByKind(ctx.db, demandId) };
        updateStageRun(ctx.db, {
          ...stageRun,
          inputRefs: collectInputRefs(stage, availability),
          updatedAt: tx.now,
        });
      }
      if (stageRun.status === 'waiting_human') {
        notify(tx, {
          demandId,
          stageRunId: stageRun.id,
          approvalId: null,
          kind: 'stage.waiting_human',
          requiredRole: stage.gate === 'none' ? CONFIRM_GATE_ROLE : stage.gate.role,
          title: `工件已过期：${stage.name}`,
          body: `上游 ${upstreamKind} 发布了 v${upstreamVersion}，请重新生成工件后再审批。`,
        });
      }
    }
  }
  return staled;
}

/**
 * Apply the gate/advance part of a successful stage completion. The artifact is
 * already persisted (server-AI) or was submitted by the executor (vscode).
 */
export function completeStageAfterArtifact(
  tx: TransactionContext,
  ctx: ServerContext,
  params: {
    demand: Demand;
    template: StageTemplateFile;
    stageRun: StageRun;
    stageTemplate: StageTemplate;
    artifact: Artifact;
    artifactVersion: number;
  },
): StageRun['status'] {
  const { demand, template, stageTemplate, artifact, artifactVersion } = params;
  const stageRun = getStageRun(ctx.db, params.stageRun.id) ?? params.stageRun;
  const gate = gateForStage(template, stageTemplate);
  const needsHuman = gate !== undefined || stageTemplate.autonomy === 'observe';
  const artifactVersionState = getArtifactVersion(ctx.db, artifact.id, artifactVersion);
  const isStale = artifactVersionState?.stale ?? false;

  if (needsHuman) {
    const gateKey = gate === undefined ? `${CONFIRM_GATE_PREFIX}${stageTemplate.key}` : gate.gateKey;
    const requiredRole = gate === undefined ? CONFIRM_GATE_ROLE : gate.role;
    const timeoutDays = gate === undefined ? DEFAULT_GATE_TIMEOUT_DAYS : gate.timeoutDays;
    const timeoutMs =
      ctx.config.gateTimeoutMs ?? timeoutDays * 24 * 60 * 60 * 1000;
    const expiresAt = new Date(Date.parse(tx.now) + timeoutMs).toISOString();
    const approval: Approval = {
      id: newUlid(),
      demandId: demand.id,
      stageRunId: stageRun.id,
      gateKey,
      artifactId: artifact.id,
      artifactVersion,
      state: 'pending',
      requiredRole,
      decision: null,
      decidedBy: null,
      decidedAt: null,
      comment: null,
      expiresAt,
      createdAt: tx.now,
      updatedAt: tx.now,
    };
    insertApproval(ctx.db, approval);
    const inReview: Artifact = { ...artifact, state: 'in_review', updatedAt: tx.now };
    updateArtifact(ctx.db, inReview);
    const waiting: StageRun = {
      ...stageRun,
      status: 'waiting_human',
      finishedAt: tx.now,
      updatedAt: tx.now,
    };
    updateStageRun(ctx.db, waiting);
    tx.append({
      type: 'approval.requested',
      subject: { type: 'approval', id: approval.id },
      data: {
        approvalId: approval.id,
        demandId: demand.id,
        stageRunId: stageRun.id,
        stageKey: stageTemplate.key,
        gateKey,
        artifactId: artifact.id,
        artifactVersion,
        requiredRole,
        expiresAt,
        stale: isStale,
      },
      demandId: demand.id,
    });
    appendStageEvent(tx, waiting, 'stage.waiting_human', {
      attempt: waiting.attempt,
      gateKey,
      artifactId: artifact.id,
      artifactVersion,
      requiredRole,
      stale: isStale,
    });
    notify(tx, {
      demandId: demand.id,
      stageRunId: stageRun.id,
      approvalId: approval.id,
      kind: 'approval.requested',
      requiredRole,
      title: `待审批：${stageTemplate.name}`,
      body: `${demand.title} 的「${stageTemplate.name}」已生成 v${artifactVersion}，角色 ${requiredRole} 需要确认。`,
    });
    return 'waiting_human';
  }

  const doneArtifact: Artifact = { ...artifact, state: 'generated', updatedAt: tx.now };
  updateArtifact(ctx.db, doneArtifact);
  const done: StageRun = {
    ...stageRun,
    status: 'done',
    outputArtifactId: artifact.id,
    finishedAt: tx.now,
    updatedAt: tx.now,
  };
  updateStageRun(ctx.db, done);
  appendStageEvent(tx, done, 'stage.done', {
    attempt: done.attempt,
    outputArtifactId: artifact.id,
    artifactVersion,
  });
  advanceToNextStage(tx, ctx, demand.id, template, stageTemplate.key, false);
  return 'done';
}

/**
 * Fail a stage attempt: retry with attempt+1 (and a fresh task for vscode
 * stages) while attempts remain, otherwise park for a human (docs/003 §2.2).
 */
export function failStageAttempt(
  tx: TransactionContext,
  ctx: ServerContext,
  params: {
    demand: Demand;
    template: StageTemplateFile;
    stageRun: StageRun;
    stageTemplate: StageTemplate;
    reason: string;
    error: string | null;
    /** `false` for non-retryable executor failures (park for a human instead). */
    allowRetry?: boolean;
    ledger: {
      model: string | null;
      promptVersion: string | null;
      schemaOk: boolean;
      tokens: number;
      costUsd: number;
      durationMs: number;
      startedAt: string;
    };
  },
): StageRun['status'] {
  const { demand, stageTemplate, reason } = params;
  const stageRun = getStageRun(ctx.db, params.stageRun.id) ?? params.stageRun;
  // A gate decision does not replace the run ledger of the successful attempt.
  if (!hasStageAttempt(ctx.db, stageRun.id, stageRun.attempt)) {
    insertStageAttempt(ctx.db, {
      stageRunId: stageRun.id,
      attempt: stageRun.attempt,
      model: params.ledger.model,
    promptVersion: params.ledger.promptVersion,
    inputRefs: stageRun.inputRefs,
    schemaOk: params.ledger.schemaOk,
    tokens: params.ledger.tokens,
    costUsd: params.ledger.costUsd,
    durationMs: Math.max(0, params.ledger.durationMs),
      error: params.error,
      startedAt: params.ledger.startedAt,
      finishedAt: tx.now,
    });
  }

  const target: StageRun['status'] = canTransitionStageRun(stageRun.status, 'failed')
    ? 'failed'
    : stageRun.status;
  let failed: StageRun =
    target === 'failed'
      ? { ...stageRun, status: 'failed', finishedAt: tx.now, updatedAt: tx.now }
      : { ...stageRun, updatedAt: tx.now };
  updateStageRun(ctx.db, failed);
  const willRetry =
    (params.allowRetry ?? true) && failed.attempt < stageTemplate.maxAttempts;
  appendStageEvent(tx, failed, 'stage.failed', {
    attempt: failed.attempt,
    error: reason,
    willRetry,
    nextAttempt: willRetry ? failed.attempt + 1 : null,
  });

  if (willRetry && canTransitionStageRun('failed', 'ready')) {
    // Retries re-read the latest upstream versions: the previous attempt may
    // have been rejected while an upstream artifact got a new version.
    const availability = { byKind: latestArtifactRefsByKind(ctx.db, demand.id) };
    failed = {
      ...failed,
      status: 'ready',
      attempt: failed.attempt + 1,
      inputRefs: collectInputRefs(stageTemplate, availability),
      startedAt: null,
      finishedAt: null,
      updatedAt: tx.now,
    };
    updateStageRun(ctx.db, failed);
    appendStageEvent(tx, failed, 'stage.ready', {
      executorKind: failed.executorKind,
      attempt: failed.attempt,
      reason: 'retry_after_failure',
    });
    planTaskForStage(tx, ctx, demand, stageTemplate, failed);
    return 'ready';
  }

  const waiting: StageRun = { ...failed, status: 'waiting_human', updatedAt: tx.now };
  updateStageRun(ctx.db, waiting);
  appendStageEvent(tx, waiting, 'stage.waiting_human', {
    attempt: waiting.attempt,
    error: reason,
  });
  notify(tx, {
    demandId: demand.id,
    stageRunId: waiting.id,
    approvalId: null,
    kind: 'stage.failed',
    requiredRole: stageTemplate.requiredRoles[0] ?? null,
    title: `需要人工处理：${stageTemplate.name}`,
    body: `${demand.title} 的「${stageTemplate.name}」重试 ${stageTemplate.maxAttempts} 次仍失败：${reason}`,
  });
  return 'waiting_human';
}

/**
 * Continue after a gate decision/withdrawal/expiry: the stage either finishes
 * (approve) or starts a new attempt, never stays stuck in waiting_human.
 */
export function retryStageAfterGate(
  tx: TransactionContext,
  ctx: ServerContext,
  params: {
    demand: Demand;
    template: StageTemplateFile;
    stageRun: StageRun;
    stageTemplate: StageTemplate;
    reason: string;
    artifactState: 'superseded' | 'rejected';
    artifact: Artifact;
    approval: Approval;
  },
): StageRun['status'] {
  const { demand, template, stageTemplate, artifact, reason } = params;
  const stageRun = getStageRun(ctx.db, params.stageRun.id) ?? params.stageRun;
  if (artifact.currentVersion === params.approval.artifactVersion) {
    updateArtifact(ctx.db, { ...artifact, state: params.artifactState, updatedAt: tx.now });
  }
  updateStageRun(ctx.db, { ...stageRun, updatedAt: tx.now });
  const outcome = failStageAttempt(tx, ctx, {
    demand,
    template,
    stageRun,
    stageTemplate,
    reason,
    error: reason,
    ledger: {
      model: null,
      promptVersion: null,
      schemaOk: false,
      tokens: 0,
      costUsd: 0,
      durationMs: 0,
      startedAt: stageRun.startedAt ?? tx.now,
    },
  });
  return outcome;
}

/** Approve a pending gate (docs/003 §2.5). Throws on stale/superseded artifacts. */
export function decideApprovalApprove(
  tx: TransactionContext,
  ctx: ServerContext,
  approval: Approval,
  decidedBy: string,
  comment: string | null,
): Approval {
  const stageRun = getStageRun(ctx.db, approval.stageRunId);
  if (stageRun === null) throw new Error(`approval ${approval.id} points at a missing stage run`);
  const demand = getDemand(ctx.db, stageRun.demandId);
  if (demand === null) throw new Error(`approval ${approval.id} points at a missing demand`);
  const template = ctx.templates.getForDemand(demand);
  if (template === undefined) throw new Error(`demand ${demand.id} has no loaded template`);
  const stageTemplate = template.stages.find((stage) => stage.key === stageRun.stageKey);
  if (stageTemplate === undefined) throw new Error(`template has no stage ${stageRun.stageKey}`);

  const artifact = getArtifact(ctx.db, approval.artifactId);
  if (artifact === null) throw new Error(`approval ${approval.id} has no artifact`);
  const version = getArtifactVersion(ctx.db, artifact.id, approval.artifactVersion);
  if (version === null) throw new Error(`approval ${approval.id} artifact version is missing`);
  // --- H1: stale / superseded artifacts block the approval (docs/003 §2.2/§2.4) ---
  if (artifact.currentVersion !== approval.artifactVersion) {
    throw conflict(
      `approval ${approval.id} targets artifact v${approval.artifactVersion} but v${artifact.currentVersion} is current`,
      {
        reason: 'artifact_version_superseded',
        approvalId: approval.id,
        artifactId: artifact.id,
        artifactVersion: approval.artifactVersion,
        currentVersion: artifact.currentVersion,
      },
    );
  }
  if (version.stale) {
    throw conflict(`artifact v${approval.artifactVersion} is stale; regenerate before approving`, {
      reason: 'artifact_stale',
      approvalId: approval.id,
      artifactId: artifact.id,
      artifactVersion: approval.artifactVersion,
    });
  }
  if (stageRun.status !== 'waiting_human') {
    throw conflict(`stage ${stageRun.stageKey} is ${stageRun.status}, not waiting_human`, {
      reason: 'stage_not_waiting_human',
      approvalId: approval.id,
      stageRunId: stageRun.id,
    });
  }

  const approved: Approval = {
    ...approval,
    state: 'approved',
    decision: 'approve',
    decidedBy,
    decidedAt: tx.now,
    comment,
    updatedAt: tx.now,
  };
  updateApproval(ctx.db, approved);
  tx.append({
    type: 'approval.decided',
    subject: { type: 'approval', id: approval.id },
    data: {
      approvalId: approval.id,
      demandId: demand.id,
      stageRunId: stageRun.id,
      gateKey: approval.gateKey,
      decision: 'approve',
      decidedBy,
      comment,
      artifactId: artifact.id,
      artifactVersion: approval.artifactVersion,
    },
    demandId: demand.id,
  });
  notify(tx, {
    demandId: demand.id,
    stageRunId: stageRun.id,
    approvalId: approval.id,
    kind: 'approval.decided',
    requiredRole: approval.requiredRole,
    title: `已通过：${stageTemplate.name}`,
    body: `${demand.title} 的「${stageTemplate.name}」已由 ${decidedBy} 审批通过。`,
  });

  if (artifact.currentVersion === approval.artifactVersion) {
    updateArtifact(ctx.db, { ...artifact, state: 'approved', updatedAt: tx.now });
    tx.append({
      type: 'artifact.approved',
      subject: { type: 'artifact', id: artifact.id },
      data: {
        artifactId: artifact.id,
        demandId: demand.id,
        version: approval.artifactVersion,
        approvedBy: decidedBy,
      },
      demandId: demand.id,
    });
  }

  const done: StageRun = {
    ...stageRun,
    status: 'done',
    finishedAt: tx.now,
    updatedAt: tx.now,
  };
  updateStageRun(ctx.db, done);
  appendStageEvent(tx, done, 'stage.done', {
    attempt: done.attempt,
    outputArtifactId: artifact.id,
    artifactVersion: approval.artifactVersion,
    approvedBy: decidedBy,
  });
  advanceToNextStage(tx, ctx, demand.id, template, stageTemplate.key, true);
  return approved;
}

/** Reject a pending gate: artifact rejected, stage starts a new attempt. */
export function decideApprovalReject(
  tx: TransactionContext,
  ctx: ServerContext,
  approval: Approval,
  decidedBy: string,
  comment: string | null,
): Approval {
  const stageRun = getStageRun(ctx.db, approval.stageRunId);
  if (stageRun === null) throw new Error(`approval ${approval.id} points at a missing stage run`);
  const demand = getDemand(ctx.db, stageRun.demandId);
  if (demand === null) throw new Error(`approval ${approval.id} points at a missing demand`);
  const template = ctx.templates.getForDemand(demand);
  if (template === undefined) throw new Error(`demand ${demand.id} has no loaded template`);
  const stageTemplate = template.stages.find((stage) => stage.key === stageRun.stageKey);
  if (stageTemplate === undefined) throw new Error(`template has no stage ${stageRun.stageKey}`);
  const artifact = getArtifact(ctx.db, approval.artifactId);
  if (artifact === null) throw new Error(`approval ${approval.id} has no artifact`);

  const rejected: Approval = {
    ...approval,
    state: 'rejected',
    decision: 'reject',
    decidedBy,
    decidedAt: tx.now,
    comment,
    updatedAt: tx.now,
  };
  updateApproval(ctx.db, rejected);
  tx.append({
    type: 'approval.decided',
    subject: { type: 'approval', id: approval.id },
    data: {
      approvalId: approval.id,
      demandId: demand.id,
      stageRunId: stageRun.id,
      gateKey: approval.gateKey,
      decision: 'reject',
      decidedBy,
      comment,
      artifactId: artifact.id,
      artifactVersion: approval.artifactVersion,
    },
    demandId: demand.id,
  });
  tx.append({
    type: 'artifact.rejected',
    subject: { type: 'artifact', id: artifact.id },
    data: {
      artifactId: artifact.id,
      demandId: demand.id,
      version: approval.artifactVersion,
      rejectedBy: decidedBy,
      comment,
    },
    demandId: demand.id,
  });
  notify(tx, {
    demandId: demand.id,
    stageRunId: stageRun.id,
    approvalId: approval.id,
    kind: 'approval.decided',
    requiredRole: approval.requiredRole,
    title: `已驳回：${stageTemplate.name}`,
    body: `${demand.title} 的「${stageTemplate.name}」被 ${decidedBy} 驳回，已开始新 attempt。`,
  });
  retryStageAfterGate(tx, ctx, {
    demand,
    template,
    stageRun,
    stageTemplate,
    reason: 'gate_rejected',
    artifactState: 'rejected',
    artifact,
    approval,
  });
  return rejected;
}

/** Withdraw a pending gate (initiator cancels the request; stage retries). */
export function withdrawApproval(
  tx: TransactionContext,
  ctx: ServerContext,
  approval: Approval,
  reason: string,
): Approval {
  const stageRun = getStageRun(ctx.db, approval.stageRunId);
  const demand = stageRun === null ? null : getDemand(ctx.db, stageRun.demandId);
  const template = demand === null ? undefined : ctx.templates.getForDemand(demand);
  const stageTemplate =
    template === undefined ? undefined : template.stages.find((stage) => stage.key === stageRun?.stageKey);
  const artifact = getArtifact(ctx.db, approval.artifactId);
  const withdrawn: Approval = {
    ...approval,
    state: 'withdrawn',
    decidedAt: tx.now,
    comment: reason,
    updatedAt: tx.now,
  };
  updateApproval(ctx.db, withdrawn);
  tx.append({
    type: 'approval.withdrawn',
    subject: { type: 'approval', id: approval.id },
    data: {
      approvalId: approval.id,
      demandId: approval.demandId,
      gateKey: approval.gateKey,
      reason,
      artifactId: approval.artifactId,
      artifactVersion: approval.artifactVersion,
    },
    demandId: approval.demandId,
  });
  if (
    demand !== null &&
    stageRun !== null &&
    template !== undefined &&
    stageTemplate !== undefined &&
    artifact !== null
  ) {
    retryStageAfterGate(tx, ctx, {
      demand,
      template,
      stageRun,
      stageTemplate,
      reason,
      artifactState: 'superseded',
      artifact,
      approval,
    });
  }
  return withdrawn;
}

/** Expire a pending gate (timeout sweeper or M1 admin escalation). */
export function expireApproval(
  tx: TransactionContext,
  ctx: ServerContext,
  approval: Approval,
): Approval {
  const stageRun = getStageRun(ctx.db, approval.stageRunId);
  const demand = stageRun === null ? null : getDemand(ctx.db, stageRun.demandId);
  const template = demand === null ? undefined : ctx.templates.getForDemand(demand);
  const stageTemplate =
    template === undefined
      ? undefined
      : template.stages.find((stage) => stage.key === stageRun?.stageKey);
  const expired: Approval = {
    ...approval,
    state: 'expired',
    decision: null,
    decidedAt: tx.now,
    comment: 'timeout',
    updatedAt: tx.now,
  };
  updateApproval(ctx.db, expired);
  tx.append({
    type: 'approval.expired',
    subject: { type: 'approval', id: approval.id },
    data: {
      approvalId: approval.id,
      demandId: approval.demandId,
      gateKey: approval.gateKey,
      requiredRole: approval.requiredRole,
      expiresAt: approval.expiresAt,
    },
    demandId: approval.demandId,
  });
  notify(tx, {
    demandId: approval.demandId,
    stageRunId: approval.stageRunId,
    approvalId: approval.id,
    kind: 'approval.expired',
    requiredRole: approval.requiredRole,
    title: '门禁已超时',
    body: '审批超时，阶段已按失败重试规则重新排队；请检查是否需要人工推动。',
  });
  const artifact = getArtifact(ctx.db, approval.artifactId);
  if (demand !== null && stageRun !== null && template !== undefined && stageTemplate !== undefined && artifact !== null) {
    retryStageAfterGate(tx, ctx, {
      demand,
      template,
      stageRun,
      stageTemplate,
      reason: 'gate_expired',
      artifactState: 'superseded',
      artifact,
      approval,
    });
  }
  return expired;
}

/** Failure payload for vscode stage completion checks (missing output artifact). */
export function missingOutputArtifactResult(kind: string): StageCompletionResult {
  return {
    ok: false,
    checklist: { passed: false, results: [], failures: [`missing output artifact: ${kind}`] },
    failures: [`missing output artifact: ${kind}`],
  };
}

/** Parse a submitted artifact body as structured JSON for checklist context. */
export function structuredOutput(text: string): unknown {
  return parseStructuredOutput(text);
}

// ---------------------------------------------------------------------------
// vscode task <-> stage integration (H1 §1.1/§1.3): a stage attempt owns one
// task; completing/failing the task drives the stage completion gate.
// ---------------------------------------------------------------------------

export interface VscodeStageOutcome {
  stageStatus: StageRun['status'] | null;
  failures: string[];
  artifactId: string | null;
}

/** Evaluate a completed vscode task's output artifact and gate/advance. */
export function completeVscodeTaskStage(
  tx: TransactionContext,
  ctx: ServerContext,
  params: { task: Task; artifactIds: readonly string[] },
): VscodeStageOutcome {
  const task = params.task;
  if (task.stageRunId === null) {
    return { stageStatus: null, failures: [], artifactId: null };
  }
  const stageRun = getStageRun(ctx.db, task.stageRunId);
  if (stageRun === null) return { stageStatus: null, failures: [], artifactId: null };
  const demand = getDemand(ctx.db, task.demandId);
  if (demand === null) return { stageStatus: null, failures: [], artifactId: null };
  const template = ctx.templates.getForDemand(demand);
  if (template === undefined) return { stageStatus: null, failures: [], artifactId: null };
  const stageTemplate = template.stages.find((stage) => stage.key === stageRun.stageKey);
  if (stageTemplate === undefined) return { stageStatus: null, failures: [], artifactId: null };

  let artifact: Artifact | null = null;
  for (const artifactId of params.artifactIds) {
    const candidate = getArtifact(ctx.db, artifactId);
    if (candidate !== null && candidate.kind === stageTemplate.outputArtifactKind) artifact = candidate;
  }
  if (artifact === null) {
    const candidate = findArtifactByKind(ctx.db, demand.id, stageTemplate.outputArtifactKind);
    if (candidate !== null && candidate.stageRunId === stageRun.id) artifact = candidate;
  }
  if (artifact === null) {
    const completion = missingOutputArtifactResult(stageTemplate.outputArtifactKind);
    failStageAttempt(tx, ctx, {
      demand,
      template,
      stageRun,
      stageTemplate,
      reason: completion.failures.join('; '),
      error: completion.failures.join('; '),
      ledger: emptyLedger(stageRun, tx.now),
    });
    return { stageStatus: 'failed', failures: completion.failures, artifactId: null };
  }

  let contentText = '';
  try {
    contentText = Buffer.from(
      readArtifactBytes(ctx.config.stateDir, artifact.id, artifact.currentVersion),
    ).toString('utf8');
  } catch {
    contentText = '';
  }
  const artifactVersion = getArtifactVersion(ctx.db, artifact.id, artifact.currentVersion);
  const completion = evaluateStageCompletion({
    stage: stageTemplate,
    demand,
    outputText: contentText,
    outputJson: structuredOutput(contentText),
    inputRefs: stageRun.inputRefs,
    latestInputRefs: latestArtifactRefsByKind(ctx.db, demand.id),
    outputStale: artifactVersion?.stale ?? false,
    schemaOk: contentText.trim().length > 0,
    schemaIssues: contentText.trim().length > 0 ? [] : ['artifact content is empty'],
  });
  if (!completion.ok) {
    failStageAttempt(tx, ctx, {
      demand,
      template,
      stageRun,
      stageTemplate,
      reason: completion.failures.join('; '),
      error: completion.failures.join('; '),
      ledger: emptyLedger(stageRun, tx.now),
    });
    return { stageStatus: 'failed', failures: completion.failures, artifactId: artifact.id };
  }
  const stageStatus = completeStageAfterArtifact(tx, ctx, {
    demand,
    template,
    stageRun,
    stageTemplate,
    artifact,
    artifactVersion: artifact.currentVersion,
  });
  return { stageStatus, failures: [], artifactId: artifact.id };
}

/** Fail the stage backing a task that reported failure (docs/003 §2.2). */
export function failVscodeTaskStage(
  tx: TransactionContext,
  ctx: ServerContext,
  params: { task: Task; reason: string; allowRetry?: boolean },
): StageRun['status'] | null {
  const task = params.task;
  if (task.stageRunId === null) return null;
  const stageRun = getStageRun(ctx.db, task.stageRunId);
  if (stageRun === null) return null;
  const demand = getDemand(ctx.db, task.demandId);
  if (demand === null) return null;
  const template = ctx.templates.getForDemand(demand);
  if (template === undefined) return null;
  const stageTemplate = template.stages.find((stage) => stage.key === stageRun.stageKey);
  if (stageTemplate === undefined) return null;
  return failStageAttempt(tx, ctx, {
    demand,
    template,
    stageRun,
    stageTemplate,
    reason: params.reason,
    error: params.reason,
    ...(params.allowRetry === undefined ? {} : { allowRetry: params.allowRetry }),
    ledger: emptyLedger(stageRun, tx.now),
  });
}

function emptyLedger(stageRun: StageRun, now: string): {
  model: string | null;
  promptVersion: string | null;
  schemaOk: boolean;
  tokens: number;
  costUsd: number;
  durationMs: number;
  startedAt: string;
} {
  return {
    model: null,
    promptVersion: null,
    schemaOk: false,
    tokens: 0,
    costUsd: 0,
    durationMs: 0,
    startedAt: stageRun.startedAt ?? now,
  };
}
