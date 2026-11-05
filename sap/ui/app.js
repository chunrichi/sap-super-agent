// ZSA demand UI — plain static SPA in the MIME repository (docs/004 §4).
// It calls only the same ICF JSON API served by ZCL_ZSA_HTTP_HANDLER; no OData,
// no build step, no external CDN.

const API = '/sap/zsa/api';

const app = document.querySelector('#app');
const navButtons = [...document.querySelectorAll('[data-view]')];

let currentView = 'list';
let currentDemandId = null;

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) node.append(child);
  return node;
}

async function api(path, options = {}) {
  const response = await fetch(`${API}${path}`, {
    headers: { accept: 'application/json', ...(options.body ? { 'content-type': 'application/json' } : {}) },
    ...options,
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : undefined;
  if (!response.ok) {
    const message = body?.error?.message ?? `HTTP ${response.status}`;
    throw new Error(message);
  }
  return body;
}

function statusClass(status) {
  if (status === '已完成') return 'status ok';
  if (status === '待确认' || status === '待验收') return 'status warn';
  return 'status';
}

function showError(error) {
  app.replaceChildren(el('div', { class: 'card error', text: `加载失败：${error.message}` }));
}

async function renderList() {
  const status = document.querySelector('#filter-status')?.value ?? '';
  const q = document.querySelector('#filter-q')?.value ?? '';
  const params = new URLSearchParams();
  if (status) params.set('status', status);
  if (q) params.set('q', q);
  const data = await api(`/demands${params.size ? `?${params}` : ''}`);
  const rows = data.demands.map((demand) =>
    el('tr', { 'data-id': demand.demandId, onclick: () => openDetail(demand.demandId) }, [
      el('td', { text: demand.demandNo ?? '' }),
      el('td', { text: demand.title }),
      el('td', {}, [el('span', { class: statusClass(demand.status), text: demand.status })]),
      el('td', { text: demand.orgUnit ?? '' }),
      el('td', { text: (demand.changedAt ?? '').replace('T', ' ').slice(0, 16) }),
    ]),
  );
  app.replaceChildren(
    el('div', { class: 'card' }, [
      el('div', { class: 'row' }, [
        el('label', { for: 'filter-status', text: '状态' }),
        el('select', { id: 'filter-status', onchange: () => renderList() }, [
          el('option', { value: '', text: '全部' }),
          ...['待分析', '分析中', '待确认', '开发中', '待验收', '已完成', '已取消', '已驳回'].map(
            (value) => el('option', { value, text: value }),
          ),
        ]),
        el('label', { for: 'filter-q', text: '搜索' }),
        el('input', { id: 'filter-q', placeholder: '标题', onchange: () => renderList() }),
      ]),
    ]),
    el('table', {}, [
      el('thead', {}, [
        el('tr', {}, ['编号', '标题', '状态', '部门', '更新时间'].map((text) => el('th', { text }))),
      ]),
      el('tbody', {}, rows),
    ]),
  );
  const statusSelect = document.querySelector('#filter-status');
  if (statusSelect) statusSelect.value = status;
  const qInput = document.querySelector('#filter-q');
  if (qInput) qInput.value = q;
}

function timelineItem(event) {
  return el('li', { class: 'muted', text: `${event.createdAt ?? ''}  ${event.type}  (${event.state})` });
}

async function openDetail(demandId) {
  currentView = 'detail';
  currentDemandId = demandId;
  const detail = await api(`/demands/${encodeURIComponent(demandId)}`);
  const demand = detail.demand;
  const artifactList = detail.artifacts.length
    ? el('table', {}, [
        el('thead', {}, [el('tr', {}, ['阶段', '类型', '版本', '状态'].map((text) => el('th', { text })))]),
        el('tbody', {}, detail.artifacts.map((artifact) =>
          el('tr', {}, [
            el('td', { text: artifact.stageKey ?? '' }),
            el('td', { text: artifact.kind }),
            el('td', { text: String(artifact.version) }),
            el('td', { text: artifact.status }),
          ]),
        )),
      ])
    : el('p', { class: 'muted', text: '尚无工件' });

  const approvalButtons = el('div', { class: 'actions' }, [
    el('button', {
      class: 'primary',
      text: '通过',
      onclick: () => decide(demandId, 'approve'),
    }),
    el('button', {
      text: '驳回',
      onclick: () => decide(demandId, 'reject'),
    }),
  ]);

  app.replaceChildren(
    el('div', { class: 'card' }, [
      el('div', { class: 'row' }, [
        el('h2', { text: demand.title }),
        el('span', { class: 'spacer' }),
        el('span', { class: statusClass(demand.status), text: demand.status }),
      ]),
      el('p', { class: 'muted', text: `${demand.demandNo ?? ''} · ${demand.requesterUserId ?? ''}` }),
      el('h3', { text: '描述' }),
      el('p', { text: demand.description || '（无）' }),
      el('h3', { text: '验收标准' }),
      demand.acceptanceCriteria?.length
        ? el('ul', {}, demand.acceptanceCriteria.map((item) => el('li', { text: item })))
        : el('p', { class: 'muted', text: '（无）' }),
    ]),
    el('div', { class: 'card' }, [
      el('h3', { text: '工件（按阶段）' }),
      artifactList,
      el('h3', { text: '审批' }),
      approvalButtons,
    ]),
    el('div', { class: 'card' }, [
      el('h3', { text: '事件时间线' }),
      el('ul', { class: 'timeline' }, (detail.events ?? []).map(timelineItem)),
    ]),
    el('button', { text: '返回列表', onclick: () => show('list') }),
  );
}

async function decide(demandId, decision) {
  const comment = window.prompt(decision === 'approve' ? '通过意见（可选）' : '驳回原因');
  if (decision === 'reject' && !comment) return;
  await api(`/demands/${encodeURIComponent(demandId)}/approvals`, {
    method: 'POST',
    body: JSON.stringify({
      gateKey: 'G1',
      stageKey: 'requirement_analysis',
      decision,
      decidedBy: 'SAP_WEB_USER',
      comment: comment ?? '',
    }),
  });
  await openDetail(demandId);
}

function renderCreate() {
  currentView = 'create';
  const form = el('form', { class: 'card', onsubmit: submitCreate }, [
    el('h2', { text: '新建需求' }),
    el('label', { for: 'title', text: '标题' }),
    el('input', { id: 'title', name: 'title', required: 'required', maxlength: '200' }),
    el('label', { for: 'description', text: '描述' }),
    el('textarea', { id: 'description', name: 'description' }),
    el('label', { for: 'acceptance', text: '验收标准（每行一条）' }),
    el('textarea', { id: 'acceptance', name: 'acceptance' }),
    el('div', { class: 'row' }, [
      el('div', {}, [
        el('label', { for: 'priority', text: '优先级' }),
        el('select', { id: 'priority', name: 'priority' }, ['high', 'normal', 'low'].map(
          (value) => el('option', { value, text: value }),
        )),
      ]),
      el('div', {}, [
        el('label', { for: 'orgUnit', text: '部门' }),
        el('input', { id: 'orgUnit', name: 'orgUnit' }),
      ]),
    ]),
    el('div', { class: 'actions' }, [el('button', { class: 'primary', text: '提交', type: 'submit' })]),
  ]);
  app.replaceChildren(form);
}

async function submitCreate(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  try {
    const created = await api('/demands', {
      method: 'POST',
      body: JSON.stringify({
        title: data.get('title'),
        description: data.get('description') ?? '',
        acceptanceCriteria: String(data.get('acceptance') ?? '')
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean),
        priority: data.get('priority'),
        orgUnit: data.get('orgUnit') ?? '',
        requesterUserId: 'SAP_WEB_USER',
      }),
    });
    await openDetail(created.demand.demandId);
  } catch (error) {
    showError(error);
  }
}

async function show(view) {
  currentView = view;
  for (const button of navButtons) button.classList.toggle('active', button.dataset.view === view);
  try {
    if (view === 'create') renderCreate();
    else if (view === 'detail' && currentDemandId) await openDetail(currentDemandId);
    else await renderList();
  } catch (error) {
    showError(error);
  }
}

for (const button of navButtons) {
  button.addEventListener('click', () => {
    currentDemandId = null;
    void show(button.dataset.view);
  });
}

void show('list');
