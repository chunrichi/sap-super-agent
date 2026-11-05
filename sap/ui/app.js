// ZSA demand web UI — plain static SPA hosted from the MIME repository.
// No build step, no dependencies, no CDN: it only calls the ICF JSON API
// served by ZCL_ZSA_HTTP_HANDLER (docs/004 §4).

const API_BASE = '/sap/zsa/api';

const PRIORITY_LABELS = Object.freeze({ high: '高', normal: '中', low: '低' });
const PRIORITY_VALUES = ['high', 'normal', 'low'];
const STATUS_OPTIONS = ['待分析', '分析中', '待确认', '开发中', '待验收', '已完成', '已取消', '已驳回'];
const STATUS_TONES = Object.freeze({
  待分析: 'info',
  分析中: 'info',
  待确认: 'warning',
  开发中: 'info',
  待验收: 'warning',
  已完成: 'success',
  已取消: 'neutral',
  已驳回: 'error',
});
const TEMPLATE_LABELS = Object.freeze({ default: '默认模板', pdo: 'PDO 模板' });
const STAGE_LABELS = Object.freeze({
  intake: '受理与澄清',
  requirement_analysis: '需求分析',
  dev_spec: '开发说明',
  dev_implementation: '开发实现',
  test_acceptance: '测试与验收',
  knowledge_archive: '知识归档',
  acceptance_archive: '验收归档',
});
const ROLE_LABELS = Object.freeze({
  consultant: '需求顾问',
  requester: '业务方',
  developer: '开发者',
  ops: '运维',
});
// Gate -> approver role, from templates/{default,pdo}.yaml (docs/003 §2.7).
const TEMPLATE_GATE_ROLES = Object.freeze({
  default: Object.freeze({ G1: 'consultant', G3: 'consultant', G4: 'requester' }),
  pdo: Object.freeze({
    G1: 'consultant',
    G2: 'consultant',
    G3: 'developer',
    G4: 'requester',
    G5: 'ops',
  }),
});
// Stage -> gate for the built-in templates (templates/default.yaml, pdo.yaml).
// SAP only projects the demand status/stage back, so when approvals[] has no
// explicit pending row the gate has to be inferred from the current stage.
const TEMPLATE_STAGE_GATES = Object.freeze({
  default: Object.freeze({
    requirement_analysis: 'G1',
    dev_implementation: 'G3',
    acceptance_archive: 'G4',
  }),
  pdo: Object.freeze({
    requirement_analysis: 'G1',
    dev_spec: 'G2',
    dev_implementation: 'G3',
    test_acceptance: 'G4',
    knowledge_archive: 'G5',
  }),
});
const AWAITING_APPROVAL_STATUSES = Object.freeze(['待确认', '待验收']);
const ARTIFACT_KIND_LABELS = Object.freeze({
  requirement_analysis: '需求分析',
  dev_spec: '开发说明',
  code_change: '代码变更',
  test_doc: '测试文档',
  knowledge_entry: '知识条目',
  free_note: '自由备注',
});
const ARTIFACT_STATUS_LABELS = Object.freeze({
  draft: '草稿',
  generated: '已生成',
  in_review: '审核中',
  approved: '已通过',
  rejected: '已驳回',
  superseded: '已替代',
  stale: '已过期',
});
const ARTIFACT_STATUS_TONES = Object.freeze({
  draft: 'neutral',
  generated: 'info',
  in_review: 'warning',
  approved: 'success',
  rejected: 'error',
  superseded: 'neutral',
  stale: 'warning',
});
const APPROVAL_STATE_LABELS = Object.freeze({
  pending: '待处理',
  approved: '已通过',
  rejected: '已驳回',
  withdrawn: '已撤回',
  expired: '已过期',
});
const APPROVAL_STATE_TONES = Object.freeze({
  pending: 'warning',
  approved: 'success',
  rejected: 'error',
  withdrawn: 'neutral',
  expired: 'neutral',
});
const EVENT_TYPE_LABELS = Object.freeze({
  'demand.submitted': '需求已提交',
  'demand.updated': '需求已更新',
  'artifact.approved': '工件已通过',
  'artifact.rejected': '工件已驳回',
  'demand.cancelled': '需求已取消',
  'hook.receipt': '回执已收到',
});
const EVENT_STATE_LABELS = Object.freeze({
  NEW: '待发送',
  SENT: '已发送',
  DEAD: '投递失败',
});

const app = document.querySelector('#app');
const announcer = document.querySelector('#announcer');
const toastEl = document.querySelector('#toast');
const sessionBanner = document.querySelector('#session-banner');
const reloginButton = document.querySelector('#relogin');
const connectionEl = document.querySelector('#connection');
const userEl = document.querySelector('#current-user');

const listState = { q: '', status: '', demands: [], loadedAt: null };

let currentUser = '';
let viewToken = 0;
let listRequestToken = 0;
let searchTimer = 0;
let announceTimer = 0;
let toastTimer = 0;

class ApiError extends Error {
  constructor(message, { status = 0, code = 'error' } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

const PROPERTY_KEYS = new Set(['value', 'checked', 'disabled', 'selected', 'tabIndex', 'hidden']);

function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = String(value);
    else if (key === 'text') node.textContent = String(value);
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (PROPERTY_KEYS.has(key) && key in node) node[key] = value;
    else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, String(value));
  }
  appendChildren(node, children);
  return node;
}

function appendChildren(node, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

function announce(message) {
  window.clearTimeout(announceTimer);
  announcer.textContent = '';
  announceTimer = window.setTimeout(() => {
    announcer.textContent = message;
  }, 40);
}

function showToast(message, tone = 'success') {
  window.clearTimeout(toastTimer);
  toastEl.textContent = message;
  toastEl.className = tone === 'error' ? 'toast toast--error' : 'toast';
  toastEl.hidden = false;
  toastTimer = window.setTimeout(() => {
    toastEl.hidden = true;
  }, 3200);
}

function setConnection(status, label) {
  connectionEl.dataset.state = status;
  connectionEl.textContent = label;
}

function setCurrentUser(name) {
  if (!name || currentUser === name) return;
  currentUser = name;
  userEl.textContent = name;
  userEl.title = `当前登录用户：${name}`;
  userEl.hidden = false;
}

function showSessionBanner() {
  sessionBanner.hidden = false;
  setConnection('offline', '会话过期');
}

function hideSessionBanner() {
  sessionBanner.hidden = true;
}

// On a direct #/new deep link there is no list/detail response yet, so the
// current SAP user would stay unknown. Probe with a status filter that cannot
// match any demand: cheap, side-effect free, and returns `currentUser`.
let sessionProbe = null;

function probeSession() {
  if (currentUser !== '') return Promise.resolve();
  if (sessionProbe === null) {
    sessionProbe = api(`/demands?status=${encodeURIComponent('__session_probe__')}`)
      .catch(() => undefined)
      .finally(() => {
        sessionProbe = null;
      });
  }
  return sessionProbe;
}

// ---------------------------------------------------------------------------
// formatting
// ---------------------------------------------------------------------------

function formatTime(value) {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const pad = (part) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function sortTime(value) {
  const time = new Date(value ?? '').getTime();
  return Number.isNaN(time) ? Number.POSITIVE_INFINITY : time;
}

function statusBadge(status) {
  const tone = STATUS_TONES[status] ?? 'neutral';
  return h('span', { class: `badge badge--${tone}`, text: status || '未知' });
}

function priorityTag(priority) {
  const label = PRIORITY_LABELS[priority] ?? priority ?? '—';
  return h('span', { class: `priority priority--${priority ?? 'normal'}`, text: label });
}

function artifactStatusBadge(status) {
  const tone = ARTIFACT_STATUS_TONES[status] ?? 'neutral';
  const label = ARTIFACT_STATUS_LABELS[status] ?? status ?? '未知';
  return h('span', { class: `badge badge--${tone}`, text: label });
}

function approvalStateBadge(state) {
  const tone = APPROVAL_STATE_TONES[state] ?? 'neutral';
  const label = APPROVAL_STATE_LABELS[state] ?? state ?? '未知';
  return h('span', { class: `badge badge--${tone}`, text: label });
}

function stageLabel(stageKey) {
  return STAGE_LABELS[stageKey] ?? stageKey ?? '—';
}

function artifactKindLabel(kind) {
  return ARTIFACT_KIND_LABELS[kind] ?? kind ?? '—';
}

function templateLabel(templateId) {
  return TEMPLATE_LABELS[templateId] ?? templateId ?? '—';
}

function eventTypeLabel(type) {
  return EVENT_TYPE_LABELS[type] ?? type ?? '—';
}

function eventStateLabel(state) {
  return EVENT_STATE_LABELS[state] ?? '';
}

function normalizeList(value) {
  if (Array.isArray(value)) return value.filter(Boolean).map((item) => String(item));
  if (typeof value === 'string' && value.trim() !== '') {
    return value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  }
  return [];
}

function templateGateKeys(templateId) {
  const gates = TEMPLATE_GATE_ROLES[templateId] ?? TEMPLATE_GATE_ROLES.default;
  return Object.keys(gates);
}

function requiredRoleLabel(templateId, gateKey) {
  const gates = TEMPLATE_GATE_ROLES[templateId] ?? TEMPLATE_GATE_ROLES.default;
  const role = gates?.[gateKey];
  return role ? ROLE_LABELS[role] ?? role : '';
}

function isDecidedApproval(approval) {
  return approval?.state === 'approved' || approval?.state === 'rejected';
}

/**
 * Resolve the gate the SAP Web user is expected to decide.
 *
 * Real-machine data: the control plane only writes decision rows back to SAP
 * (`artifact.approved/rejected`), so `approvals[]` usually contains no
 * `pending` entry. The demand status projection + stageKey are then the only
 * signal, hence the template stage -> gate fallback. Returns null when there is
 * nothing to decide (no pending state, or the gate already has a decision).
 */
function resolvePendingGate(demand, approvals) {
  const templateId = demand?.templateId ?? '';
  const knownGates = templateGateKeys(templateId);
  const decidedGates = new Set(
    approvals.filter(isDecidedApproval).map((approval) => approval.gateKey),
  );

  // 1a) explicit pending row (current writeback projection / future support).
  const explicit = [...approvals]
    .reverse()
    .find(
      (approval) =>
        approval?.state === 'pending' &&
        knownGates.includes(approval.gateKey) &&
        !decidedGates.has(approval.gateKey),
    );
  if (explicit !== undefined) {
    return { gateKey: explicit.gateKey, stageKey: explicit.stageKey || demand?.stageKey || '' };
  }

  // 1b) infer from the status projection + stage when SAP has no pending row.
  const awaiting = [demand?.status, demand?.statusText].some((status) =>
    AWAITING_APPROVAL_STATUSES.includes(status),
  );
  if (!awaiting) return null;

  const stageGates = TEMPLATE_STAGE_GATES[templateId] ?? TEMPLATE_STAGE_GATES.default;
  const gateKey = stageGates[demand?.stageKey];
  // 1c) a decision already exists for that gate: never offer it again.
  if (!gateKey || decidedGates.has(gateKey)) return null;
  return { gateKey, stageKey: demand?.stageKey || '' };
}

/**
 * Legacy-data hardening for the approval history: drop rows whose gateKey is not
 * a known gate for the template (e.g. the old placeholder `GATE`) and collapse
 * duplicate `(gateKey, state)` rows, preferring the informative one.
 */
function visibleApprovalHistory(approvals, templateId) {
  const knownGates = new Set(templateGateKeys(templateId));
  const informativeScore = (approval) =>
    (approval.decidedBy ? 2 : 0) + (approval.comment ? 1 : 0);
  const byKey = new Map();
  for (const approval of approvals) {
    if (approval === null || approval === undefined) continue;
    if (!knownGates.has(approval.gateKey)) continue;
    const key = `${approval.gateKey}|${approval.state}`;
    const current = byKey.get(key);
    if (current === undefined || informativeScore(approval) > informativeScore(current)) {
      byKey.set(key, approval);
    }
  }
  return [...byKey.values()];
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

async function api(path, { method = 'GET', body } = {}) {
  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method,
      credentials: 'same-origin',
      headers: {
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    setConnection('offline', '连接中断');
    throw new ApiError('无法连接到服务器，请检查网络后重试。', { code: 'network' });
  }

  if (response.status === 401) {
    showSessionBanner();
    throw new ApiError('SAP 会话已过期，请重新登录。', { status: 401, code: 'unauthorized' });
  }

  const contentType = response.headers.get('content-type') ?? '';
  let payload;
  if (contentType.includes('json')) {
    try {
      payload = await response.json();
    } catch {
      payload = undefined;
    }
  } else if (response.ok) {
    // ICF logon redirects answer with an HTML logon page instead of JSON.
    showSessionBanner();
    throw new ApiError('SAP 会话已过期，请重新登录。', { status: 401, code: 'unauthorized' });
  }

  if (!response.ok) {
    // The session/transport is fine; only this request failed (validation, 404, 409, …).
    setConnection('online', '已连接');
    const message = payload?.error?.message ?? `请求失败（HTTP ${response.status}）`;
    throw new ApiError(message, {
      status: response.status,
      code: payload?.error?.code ?? 'http_error',
    });
  }

  if (payload === undefined) {
    throw new ApiError('服务器返回了无法解析的响应。', { status: response.status, code: 'bad_response' });
  }

  hideSessionBanner();
  setConnection('online', '已连接');
  setCurrentUser(typeof payload.currentUser === 'string' ? payload.currentUser : '');
  return payload;
}

// ---------------------------------------------------------------------------
// routing
// ---------------------------------------------------------------------------

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseRoute() {
  const raw = window.location.hash.replace(/^#/, '') || '/list';
  const path = raw.split('?')[0];
  const segments = path.split('/').filter(Boolean);
  if (segments[0] === 'demand' && segments[1]) {
    return { view: 'detail', demandId: safeDecode(segments[1]) };
  }
  if (segments[0] === 'new') return { view: 'new' };
  return { view: 'list' };
}

function navigate(hash) {
  if (window.location.hash === hash) void renderRoute();
  else window.location.hash = hash;
}

function setActiveNav(view) {
  for (const link of document.querySelectorAll('[data-nav]')) {
    const active = link.dataset.nav === view;
    link.classList.toggle('is-active', active);
    if (active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
}

async function renderRoute() {
  const route = parseRoute();
  const token = ++viewToken;
  setActiveNav(route.view === 'new' ? 'new' : 'list');
  if (route.view === 'detail') {
    await renderDetail(route.demandId, token);
    return;
  }
  if (route.view === 'new') {
    renderCreate();
    return;
  }
  renderList(token);
}

function viewHead() {
  return h('div', { class: 'view-head' }, h('a', { class: 'back-link', href: '#/list', text: '← 需求列表' }));
}

// ---------------------------------------------------------------------------
// list view
// ---------------------------------------------------------------------------

function renderList(token) {
  document.title = 'ZSA 需求系统';

  const searchInput = h('input', {
    id: 'list-search',
    type: 'search',
    placeholder: '搜索标题',
    autocomplete: 'off',
    'aria-label': '搜索需求标题',
  });
  searchInput.value = listState.q;

  const statusSelect = h(
    'select',
    { id: 'list-status', 'aria-label': '按状态筛选' },
    h('option', { value: '', text: '全部状态' }),
    STATUS_OPTIONS.map((status) => h('option', { value: status, text: status })),
  );
  statusSelect.value = listState.status;

  const chips = ['待确认', '待验收'].map((status) =>
    h('button', {
      type: 'button',
      class: 'chip',
      'aria-pressed': String(listState.status === status),
      text: status === '待确认' ? '待我确认' : '待我验收',
    }),
  );

  const syncFilters = () => {
    statusSelect.value = listState.status;
    chips.forEach((chip, index) => {
      chip.setAttribute('aria-pressed', String(listState.status === ['待确认', '待验收'][index]));
    });
  };

  const refreshButton = h('button', { type: 'button', class: 'btn btn--small', text: '刷新' });
  const countEl = h('span', { class: 'list-meta__count', text: '加载中…' });
  const hintEl = h('span', { class: 'list-meta__hint' });
  const results = h('div', { class: 'list-results' });
  const ui = { results, countEl, hintEl, refreshButton, searchInput, statusSelect, chips, syncFilters };

  const toolbar = h(
    'div',
    { class: 'list-toolbar' },
    h('div', { class: 'list-toolbar__search' }, searchInput),
    h(
      'div',
      { class: 'list-toolbar__filters' },
      statusSelect,
      chips,
      refreshButton,
    ),
  );

  app.replaceChildren(
    h('section', { class: 'panel' }, toolbar, h('div', { class: 'list-meta' }, countEl, hintEl), results),
  );

  const requestSearch = () => {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      listState.q = searchInput.value.trim();
      void loadList(token, ui);
    }, 280);
  };
  searchInput.addEventListener('input', requestSearch);
  searchInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    window.clearTimeout(searchTimer);
    listState.q = searchInput.value.trim();
    void loadList(token, ui);
  });
  statusSelect.addEventListener('change', () => {
    listState.status = statusSelect.value;
    syncFilters();
    void loadList(token, ui);
  });
  for (const [index, status] of ['待确认', '待验收'].entries()) {
    chips[index].addEventListener('click', () => {
      listState.status = listState.status === status ? '' : status;
      syncFilters();
      void loadList(token, ui);
    });
  }
  refreshButton.addEventListener('click', () => void loadList(token, ui));

  void loadList(token, ui);
}

async function loadList(token, ui) {
  const requestId = ++listRequestToken;
  const firstLoad = ui.results.childElementCount === 0;
  ui.refreshButton.disabled = true;
  ui.results.setAttribute('aria-busy', 'true');
  if (firstLoad) ui.results.replaceChildren(skeletonTable());
  else ui.results.classList.add('is-refreshing');

  try {
    const params = new URLSearchParams();
    if (listState.q) params.set('q', listState.q);
    if (listState.status) params.set('status', listState.status);
    const query = params.size > 0 ? `?${params.toString()}` : '';
    const data = await api(`/demands${query}`);
    if (token !== viewToken || requestId !== listRequestToken) return;
    listState.demands = Array.isArray(data?.demands) ? data.demands : [];
    listState.loadedAt = new Date();
    renderListResults(ui);
  } catch (error) {
    if (token !== viewToken || requestId !== listRequestToken) return;
    const message = error instanceof Error ? error.message : '加载失败';
    if (firstLoad) {
      const retryButton = h('button', { type: 'button', class: 'btn btn--primary', text: '重试' });
      retryButton.addEventListener('click', () => {
        ui.results.replaceChildren();
        void loadList(token, ui);
      });
      ui.results.replaceChildren(stateBlock('加载失败', message, retryButton));
      ui.countEl.textContent = '—';
      announce(`需求列表加载失败：${message}`);
    } else {
      showToast(`刷新失败：${message}`, 'error');
    }
    if (!(error instanceof ApiError) || error.status !== 401) setConnection('offline', '连接中断');
  } finally {
    ui.refreshButton.disabled = false;
    ui.results.classList.remove('is-refreshing');
    ui.results.setAttribute('aria-busy', 'false');
  }
}

function renderListResults(ui) {
  const total = listState.demands.length;
  ui.results.replaceChildren();
  ui.countEl.replaceChildren('共 ', h('strong', { text: String(total) }), ' 条需求');
  ui.hintEl.textContent = listState.loadedAt ? `更新于 ${formatTime(listState.loadedAt)}` : '';

  if (total === 0) {
    ui.results.append(emptyListState(ui));
  } else {
    ui.results.append(
      h(
        'div',
        { class: 'table-wrap' },
        h(
          'table',
          { class: 'table table--demands' },
          h(
            'thead',
            {},
            h(
              'tr',
              {},
              ['编号', '标题', '状态', '优先级', '部门', '更新时间'].map((label) =>
                h('th', { scope: 'col', text: label }),
              ),
            ),
          ),
          h('tbody', {}, listState.demands.map(demandRow)),
        ),
      ),
    );
  }
  announce(`需求列表已更新，共 ${total} 条。`);
}

function demandRow(demand) {
  const demandId = String(demand.demandId ?? '');
  const href = `#/demand/${encodeURIComponent(demandId)}`;
  const open = () => navigate(href);
  return h(
    'tr',
    {
      'data-id': demandId,
      tabindex: '0',
      'aria-label': `打开需求：${demand.title ?? ''}`,
      onclick: (event) => {
        if (event.target instanceof Element && event.target.closest('a')) return;
        open();
      },
      onkeydown: (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        open();
      },
    },
    h('td', { class: 'cell-no', text: demand.demandNo || '—' }),
    h('td', { class: 'cell-title' }, h('a', { class: 'row-title', href, text: demand.title || '（未命名需求）' })),
    h('td', { class: 'cell-status' }, statusBadge(demand.status)),
    h('td', { class: 'cell-priority' }, priorityTag(demand.priority)),
    h('td', { class: 'cell-org', text: demand.orgUnit || '—' }),
    h('td', { class: 'cell-time', text: formatTime(demand.changedAt) }),
  );
}

function emptyListState(ui) {
  const filtering = Boolean(listState.q || listState.status);
  return stateBlock(
    filtering ? '没有匹配的需求' : '还没有需求',
    filtering ? '调整搜索关键词或状态筛选后再试。' : '创建第一条需求，开始分析与审批流程。',
    filtering
      ? h('button', {
          type: 'button',
          class: 'btn',
          text: '清除筛选',
          onclick: () => {
            listState.q = '';
            listState.status = '';
            ui.searchInput.value = '';
            ui.syncFilters();
            void loadList(viewToken, ui);
          },
        })
      : h('a', { class: 'btn btn--primary', href: '#/new', text: '新建需求' }),
  );
}

function stateBlock(title, message, action) {
  return h(
    'div',
    { class: 'state' },
    h('h3', { text: title }),
    h('p', { text: message }),
    action ?? null,
  );
}

function skeletonTable() {
  const cells = () => Array.from({ length: 6 }, () => h('td', {}, h('span', { class: 'skeleton' })));
  return h(
    'div',
    { class: 'table-wrap' },
    h(
      'table',
      { class: 'table', 'aria-label': '需求列表加载中' },
      h('thead', {}, h('tr', {}, Array.from({ length: 6 }, () => h('th', { text: ' ' })))),
      h('tbody', {}, Array.from({ length: 4 }, () => h('tr', { class: 'skeleton-row' }, cells()))),
    ),
  );
}

// ---------------------------------------------------------------------------
// detail view
// ---------------------------------------------------------------------------

async function renderDetail(demandId, token) {
  app.setAttribute('aria-busy', 'true');
  const container = h('div');
  app.replaceChildren(container);
  container.append(
    viewHead(),
    h('section', { class: 'panel' }, h('span', { class: 'skeleton skeleton-block' })),
  );

  try {
    const data = await api(`/demands/${encodeURIComponent(demandId)}`);
    if (token !== viewToken) return;
    paintDetail(container, demandId, data);
  } catch (error) {
    if (token !== viewToken) return;
    const message = error instanceof Error ? error.message : '加载失败';
    container.replaceChildren(
      viewHead(),
      h('section', { class: 'panel' }, stateBlock('加载失败', message, h('button', {
        type: 'button',
        class: 'btn btn--primary',
        text: '重试',
        onclick: () => void renderDetail(demandId, ++viewToken),
      }))),
    );
  } finally {
    app.setAttribute('aria-busy', 'false');
  }
}

function paintDetail(container, demandId, data) {
  const demand = data?.demand ?? {};
  const artifacts = Array.isArray(data?.artifacts) ? data.artifacts : [];
  const approvals = Array.isArray(data?.approvals) ? data.approvals : [];
  const events = Array.isArray(data?.events) ? data.events : [];

  container.replaceChildren(
    viewHead(),
    h(
      'div',
      { class: 'detail-layout' },
      h(
        'div',
        { class: 'detail-main' },
        demandCard(demand),
        artifactsPanel(artifacts),
        approvalHistoryPanel(approvals, demand),
        eventsPanel(events),
      ),
      h('aside', { class: 'detail-aside' }, approvalActionPanel(container, demandId, demand, approvals)),
    ),
  );

  document.title = `${demand.title ?? '需求详情'} · ZSA 需求系统`;
  announce('需求详情已加载。');
}

function demandCard(demand) {
  return h(
    'section',
    { class: 'panel' },
    h(
      'div',
      { class: 'demand-head' },
      h(
        'div',
        { class: 'demand-head__ids' },
        h('p', { class: 'eyebrow', text: demand.demandNo || '' }),
        h('h2', { class: 'demand-title', text: demand.title || '（未命名需求）' }),
      ),
      statusBadge(demand.status),
    ),
    h(
      'dl',
      { class: 'meta-grid' },
      metaItem('提出人', demand.requesterUserId || '—'),
      metaItem('部门', demand.orgUnit || '—'),
      metaItem('优先级', priorityTag(demand.priority)),
      metaItem('模板', templateLabel(demand.templateId)),
      metaItem('当前阶段', stageLabel(demand.stageKey)),
      metaItem('更新时间', formatTime(demand.changedAt)),
    ),
    h(
      'div',
      { class: 'section' },
      h('h3', { class: 'section-title', text: '描述' }),
      h('p', { class: 'prose', text: demand.description || '（无描述）' }),
    ),
    h(
      'div',
      { class: 'section' },
      h('h3', { class: 'section-title', text: '验收标准' }),
      acceptanceList(demand.acceptanceCriteria),
    ),
  );
}

function metaItem(label, value) {
  return h('div', {}, h('dt', { text: label }), h('dd', {}, value));
}

function acceptanceList(criteria) {
  const items = normalizeList(criteria);
  if (items.length === 0) return h('p', { class: 'muted', text: '（无验收标准）' });
  return h('ul', { class: 'checklist' }, items.map((item) => h('li', { text: item })));
}

function artifactsPanel(artifacts) {
  const body =
    artifacts.length === 0
      ? h('p', { class: 'inline-empty', text: '尚无工件。' })
      : h(
          'div',
          { class: 'table-wrap' },
          h(
            'table',
            { class: 'table table--compact table--cards' },
            h(
              'thead',
              {},
              h(
                'tr',
                {},
                ['阶段', '类型', '版本', '状态', '生成时间'].map((label) =>
                  h('th', { scope: 'col', text: label }),
                ),
              ),
            ),
            h(
              'tbody',
              {},
              artifacts.map((artifact) =>
                h(
                  'tr',
                  {},
                  h('td', { 'data-label': '阶段', text: stageLabel(artifact.stageKey) }),
                  h('td', { 'data-label': '类型', text: artifactKindLabel(artifact.kind) }),
                  h('td', { 'data-label': '版本', text: `v${artifact.version ?? '—'}` }),
                  h('td', { 'data-label': '状态' }, artifactStatusBadge(artifact.status)),
                  h('td', { 'data-label': '生成时间', text: formatTime(artifact.createdAt) }),
                ),
              ),
            ),
          ),
        );
  return h('section', { class: 'panel' }, h('h3', { class: 'panel__title', text: '工件' }), body);
}

function approvalHistoryPanel(approvals, demand) {
  const rows = visibleApprovalHistory(approvals, demand?.templateId).sort(
    (left, right) => sortTime(right.decidedAt) - sortTime(left.decidedAt),
  );
  const body =
    rows.length === 0
      ? h('p', { class: 'inline-empty', text: '尚无审批记录。' })
      : h(
          'div',
          { class: 'table-wrap' },
          h(
            'table',
            { class: 'table table--compact table--cards' },
            h(
              'thead',
              {},
              h(
                'tr',
                {},
                ['门禁', '阶段', '结果', '审批人', '时间', '意见'].map((label) =>
                  h('th', { scope: 'col', text: label }),
                ),
              ),
            ),
            h(
              'tbody',
              {},
              rows.map((approval) =>
                h(
                  'tr',
                  {},
                  h('td', { 'data-label': '门禁', text: approval.gateKey || '—' }),
                  h('td', { 'data-label': '阶段', text: stageLabel(approval.stageKey) }),
                  h('td', { 'data-label': '结果' }, approvalStateBadge(approval.state)),
                  h('td', { 'data-label': '审批人', text: approval.decidedBy || '—' }),
                  h('td', { 'data-label': '时间', text: formatTime(approval.decidedAt) }),
                  h('td', { 'data-label': '意见', class: 'cell-comment', text: approval.comment || '—' }),
                ),
              ),
            ),
          ),
        );
  return h('section', { class: 'panel' }, h('h3', { class: 'panel__title', text: '审批历史' }), body);
}

function eventsPanel(events) {
  const rows = [...events].sort((left, right) => sortTime(right.createdAt) - sortTime(left.createdAt));
  const body =
    rows.length === 0
      ? h('p', { class: 'inline-empty', text: '尚无事件记录。' })
      : h(
          'ol',
          { class: 'timeline' },
          rows.map((event) => {
            const stateLabel = eventStateLabel(event.state);
            return h(
              'li',
              { class: 'timeline__item' },
              h('span', { class: 'timeline__dot', 'aria-hidden': 'true' }),
              h(
                'p',
                { class: 'timeline__label' },
                eventTypeLabel(event.type),
                stateLabel ? h('span', { class: 'timeline__state', text: stateLabel }) : null,
              ),
              h('p', { class: 'timeline__time', text: formatTime(event.createdAt) }),
            );
          }),
        );
  return h('section', { class: 'panel' }, h('h3', { class: 'panel__title', text: '事件' }), body);
}

function approvalActionPanel(container, demandId, demand, approvals) {
  const pending = resolvePendingGate(demand, approvals);
  if (!pending) {
    return h(
      'section',
      { class: 'panel approval-card approval-card--empty' },
      h('h3', { class: 'panel__title', text: '审批' }),
      h(
        'div',
        { class: 'approval-empty' },
        h('p', { text: '当前没有待你处理的审批。' }),
        h('p', { class: 'muted', text: '需求进入下一个审批节点后，待办会出现在这里。' }),
      ),
    );
  }

  const roleLabel = requiredRoleLabel(demand.templateId, pending.gateKey);
  const comment = h('textarea', {
    id: 'approval-comment',
    rows: '3',
    placeholder: '通过可选填；驳回时请填写原因',
  });
  const fieldError = h('p', { class: 'field__error', role: 'alert', hidden: true });
  const approveButton = h('button', { type: 'button', class: 'btn btn--primary', text: '通过' });
  const rejectButton = h('button', { type: 'button', class: 'btn btn--danger', text: '驳回' });

  const form = h(
    'form',
    { class: 'approval-form', novalidate: '' },
    h('label', { class: 'field__label', for: 'approval-comment', text: '审批意见（驳回时必填）' }),
    comment,
    fieldError,
    h('div', { class: 'approval-actions' }, approveButton, rejectButton),
  );

  const setBusy = (busy) => {
    comment.disabled = busy;
    approveButton.disabled = busy;
    rejectButton.disabled = busy;
    approveButton.textContent = busy ? '提交中…' : '通过';
    form.setAttribute('aria-busy', String(busy));
  };

  const submit = async (decision) => {
    const value = comment.value.trim();
    if (decision === 'reject' && value === '') {
      comment.setAttribute('aria-invalid', 'true');
      fieldError.textContent = '驳回时请填写审批意见。';
      fieldError.hidden = false;
      comment.focus();
      return;
    }
    comment.removeAttribute('aria-invalid');
    fieldError.hidden = true;
    setBusy(true);
    try {
      await api(`/demands/${encodeURIComponent(demandId)}/approvals`, {
        method: 'POST',
        body: {
          gateKey: pending.gateKey,
          stageKey: pending.stageKey || undefined,
          decision,
          comment: value,
        },
      });
      showToast(decision === 'approve' ? '审批已通过' : '需求已驳回');
      announce(decision === 'approve' ? '审批已通过，正在刷新详情。' : '需求已驳回，正在刷新详情。');
      await refreshDetail(container, demandId);
    } catch (error) {
      setBusy(false);
      const message = error instanceof Error ? error.message : '提交失败';
      fieldError.textContent = message;
      fieldError.hidden = false;
      showToast(`提交失败：${message}`, 'error');
      announce(`提交失败：${message}`);
    }
  };

  approveButton.addEventListener('click', () => void submit('approve'));
  rejectButton.addEventListener('click', () => void submit('reject'));
  comment.addEventListener('input', () => {
    fieldError.hidden = true;
    comment.removeAttribute('aria-invalid');
  });

  return h(
    'section',
    { class: 'panel approval-card' },
    h('h3', { class: 'panel__title', text: '审批' }),
    h(
      'div',
      { class: 'approval-gate' },
      h('span', {
        class: 'approval-gate__title',
        text: `${pending.gateKey || '门禁'} · ${stageLabel(pending.stageKey)}`,
      }),
    ),
    h(
      'p',
      { class: 'approval-meta' },
      '审批角色：',
      roleLabel ? h('span', { class: 'role-chip', text: roleLabel }) : '—',
    ),
    form,
  );
}

async function refreshDetail(container, demandId) {
  try {
    const data = await api(`/demands/${encodeURIComponent(demandId)}`);
    paintDetail(container, demandId, data);
  } catch (error) {
    const message = error instanceof Error ? error.message : '刷新失败';
    showToast(`刷新失败：${message}`, 'error');
  }
}

// ---------------------------------------------------------------------------
// create view
// ---------------------------------------------------------------------------

function renderCreate() {
  document.title = '新建需求 · ZSA 需求系统';

  const titleInput = h('input', {
    id: 'demand-title',
    type: 'text',
    maxlength: '200',
    autocomplete: 'off',
    placeholder: '一句话说明需求',
  });
  const titleError = h('p', { class: 'field__error', hidden: true });
  const descriptionInput = h('textarea', {
    id: 'demand-description',
    rows: '4',
    placeholder: '背景、目标与范围',
  });
  const acceptanceInput = h('textarea', {
    id: 'demand-acceptance',
    rows: '5',
    placeholder: '每行一条验收标准',
  });
  const prioritySelect = h(
    'select',
    { id: 'demand-priority' },
    PRIORITY_VALUES.map((value) =>
      h('option', { value, text: PRIORITY_LABELS[value], selected: value === 'normal' }),
    ),
  );
  const orgUnitInput = h('input', {
    id: 'demand-org',
    type: 'text',
    autocomplete: 'off',
    placeholder: '如：财务共享中心',
  });
  const templateSelect = h(
    'select',
    { id: 'demand-template' },
    h('option', { value: 'default', text: '默认模板' }),
    h('option', { value: 'pdo', text: 'PDO 模板' }),
  );
  const formError = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const submitButton = h('button', { type: 'submit', class: 'btn btn--primary', text: '提交需求' });

  const field = (label, control, options = {}) =>
    h(
      'div',
      { class: 'field' },
      h(
        'label',
        { class: 'field__label', for: control.id ?? undefined },
        label,
        options.required ? h('span', { class: 'field__required', text: ' *' }) : null,
      ),
      control,
      options.hint ? h('p', { class: 'field__hint', text: options.hint }) : null,
    );

  const form = h(
    'form',
    { class: 'panel form-panel', novalidate: '' },
    h('h2', { class: 'panel__title', text: '新建需求' }),
    h(
      'div',
      { class: 'form-grid' },
      field('标题', titleInput, { required: true }),
      field('描述', descriptionInput),
      field('验收标准（每行一条）', acceptanceInput),
      h(
        'div',
        { class: 'form-row' },
        field('优先级', prioritySelect),
        field('部门', orgUnitInput),
        field('模板', templateSelect),
      ),
      formError,
    ),
    h('div', { class: 'form-actions' }, submitButton, h('a', { class: 'btn btn--ghost', href: '#/list', text: '取消' })),
  );

  titleInput.addEventListener('input', () => {
    titleError.hidden = true;
    titleInput.removeAttribute('aria-invalid');
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void submitCreate(
      {
        title: titleInput.value.trim(),
        description: descriptionInput.value.trim(),
        acceptanceCriteria: normalizeList(acceptanceInput.value),
        priority: prioritySelect.value,
        orgUnit: orgUnitInput.value.trim(),
        templateId: templateSelect.value,
      },
      {
        titleInput,
        titleError,
        form,
        formError,
        submitButton,
      },
    );
  });

  app.replaceChildren(viewHead(), form);
  announce('新建需求表单已打开。');
  titleInput.focus();
  void probeSession();
}

async function submitCreate(payload, ui) {
  ui.formError.hidden = true;
  if (payload.title === '') {
    ui.titleInput.setAttribute('aria-invalid', 'true');
    ui.titleError.textContent = '请填写需求标题。';
    ui.titleError.hidden = false;
    ui.titleInput.focus();
    return;
  }
  ui.titleInput.removeAttribute('aria-invalid');
  ui.titleError.hidden = true;
  ui.submitButton.disabled = true;
  ui.submitButton.textContent = '提交中…';
  ui.form.setAttribute('aria-busy', 'true');

  try {
    const created = await api('/demands', { method: 'POST', body: payload });
    const demandId = created?.demand?.demandId;
    showToast('需求已创建');
    announce('需求已创建，正在打开详情。');
    window.location.hash = demandId ? `#/demand/${encodeURIComponent(demandId)}` : '#/list';
  } catch (error) {
    const message = error instanceof Error ? error.message : '提交失败';
    ui.formError.textContent = message;
    ui.formError.hidden = false;
    ui.submitButton.disabled = false;
    ui.submitButton.textContent = '提交需求';
    ui.form.setAttribute('aria-busy', 'false');
    showToast(`提交失败：${message}`, 'error');
    announce(`提交失败：${message}`);
  }
}

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

reloginButton.addEventListener('click', () => window.location.reload());
window.addEventListener('hashchange', () => {
  void renderRoute();
});

if (!window.location.hash) window.history.replaceState(null, '', '#/list');
void renderRoute();
