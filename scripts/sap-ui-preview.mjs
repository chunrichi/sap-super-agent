#!/usr/bin/env node
// Local preview for the SAP MIME UI (sap/ui).
//
// Serves the static files under /sap/zsa/ui/ and mocks the ICF JSON API under
// /sap/zsa/api/* with the same contract as ZCL_ZSA_HTTP_HANDLER, so the UI can
// be developed and screenshotted without an SAP system. Dev-only: `sap/ui` is
// what gets pushed to the MIME repository, this script never is.
//
// Usage: node scripts/sap-ui-preview.mjs [--port 4173] [--scenario default|empty|expired]

import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const uiRoot = join(repoRoot, 'sap', 'ui');
const uiPrefix = '/sap/zsa/ui';
const apiPrefix = '/sap/zsa/api';
const currentUser = 'DEMO_USER';
const scenarios = new Set(['default', 'empty', 'expired', 'pending-row']);
const priorities = new Set(['high', 'normal', 'low']);

const MIME_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
});

// ---------------------------------------------------------------------------
// mock data: every scenario the UI must handle without SAP
// ---------------------------------------------------------------------------

const DEMAND_IDS = Object.freeze({
  pendingDefault: '4a3f9c2e7b1d48f0a6c5e2d9b8f7a1c3',
  pendingPdo: '8b1e5d4c9a2f47e6b3c0d8a1f5e2c7b9',
  completed: 'c7d2a9e4f6b84a1d9e0c3b5f8a2d6e71',
  rejected: 'e2f4b8c1d7a94e3f8b0c6d2a5f1e9c70',
  fresh: '1f7c3a9b5e2d4c8a9b6f0e3d7c1a5b84',
});

function nextHex() {
  return randomUUID().replaceAll('-', '');
}

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function createStore({ scenario = 'default' } = {}) {
  const records = new Map();
  const startedAt = Date.now();
  // Seed demands end at R-2005, so newly created preview demands start at R-2006.
  let sequence = 2005;

  const minutesAgo = (minutes) => new Date(startedAt - minutes * 60_000).toISOString();
  const now = () => new Date().toISOString();
  const nextDemandNo = () => {
    sequence += 1;
    return `R-${sequence}`;
  };

  const makeArtifact = (stageKey, kind, status, createdAt) => ({
    artifactId: nextHex(),
    stageKey,
    stageRunId: nextHex(),
    kind,
    version: 1,
    checksum: `sha256:${nextHex()}`,
    contentRef: `sap://zsa/artifact/${nextHex()}`,
    contentType: 'application/json',
    status,
    createdAt,
  });

  const makeApproval = (demandId, stageKey, gateKey, state, decidedBy = '', decidedAt = '', comment = '') => ({
    approvalId: nextHex(),
    demandId,
    stageKey,
    gateKey,
    state,
    decidedBy,
    comment,
    decidedAt,
  });

  const makeEvent = (type, state, createdAt) => ({
    eventId: nextHex(),
    type,
    state,
    createdAt,
  });

  const register = (demand, detail = {}) => {
    records.set(demand.demandId, {
      demand,
      artifacts: detail.artifacts ?? [],
      approvals: detail.approvals ?? [],
      events: detail.events ?? [],
    });
  };

  const demand = (overrides) => ({
    demandId: '',
    demandNo: '',
    title: '',
    description: '',
    acceptanceCriteria: [],
    requesterUserId: currentUser,
    orgUnit: '',
    priority: 'normal',
    templateId: 'default',
    templateVersion: 1,
    status: '待分析',
    statusText: '待分析',
    stageKey: 'requirement_analysis',
    version: 1,
    createdAt: minutesAgo(120),
    changedAt: minutesAgo(60),
    ...overrides,
  });

  // Default template: status projection 待确认 + stageKey requirement_analysis.
  // Like real SAP, no `pending` approval row exists; the UI infers gate G1.
  register(
    demand({
      demandId: DEMAND_IDS.pendingDefault,
      demandNo: 'R-2001',
      title: '采购申请审批流增加部门预算校验',
      description:
        '采购申请提交时需要按申请部门和费用科目校验预算余额；超预算时进入部门负责人审批，而不是直接生成采购订单。',
      acceptanceCriteria: [
        '提交采购申请时展示部门预算余额与占用额度。',
        '超预算申请自动进入部门负责人审批，并记录审批意见。',
        '预算校验结果写入审批日志，可按采购申请号追溯。',
      ],
      requesterUserId: 'LI_LEI',
      orgUnit: '财务共享中心',
      priority: 'high',
      templateId: 'default',
      status: '待确认',
      statusText: '待确认',
      stageKey: 'requirement_analysis',
      version: 3,
      createdAt: minutesAgo(60 * 26),
      changedAt: minutesAgo(95),
    }),
    {
      artifacts: [makeArtifact('requirement_analysis', 'requirement_analysis', 'generated', minutesAgo(180))],
      approvals: [],
      events: [
        makeEvent('demand.submitted', 'SENT', minutesAgo(190)),
        makeEvent('demand.updated', 'SENT', minutesAgo(180)),
      ],
    },
  );

  // pdo: 待确认 at dev_implementation, G1/G2 already decided (no pending row);
  // the UI infers gate G3 (developer) from the stage mapping.
  register(
    demand({
      demandId: DEMAND_IDS.pendingPdo,
      demandNo: 'R-2002',
      title: '移动端质检录入支持离线缓存',
      description: '车间网络不稳定，质检员需要在移动端离线录入，恢复网络后自动同步并处理冲突。',
      acceptanceCriteria: [
        '断网时质检记录保存在本地，恢复网络后自动同步。',
        '同一条记录出现冲突时提示质检员选择保留版本。',
      ],
      requesterUserId: 'WANG_FANG',
      orgUnit: '智能制造部',
      priority: 'normal',
      templateId: 'pdo',
      status: '待确认',
      statusText: '待确认',
      stageKey: 'dev_implementation',
      version: 4,
      createdAt: minutesAgo(60 * 30),
      changedAt: minutesAgo(240),
    }),
    {
      artifacts: [
        makeArtifact('requirement_analysis', 'requirement_analysis', 'approved', minutesAgo(400)),
        makeArtifact('dev_spec', 'dev_spec', 'approved', minutesAgo(320)),
        makeArtifact('dev_implementation', 'code_change', 'generated', minutesAgo(260)),
      ],
      approvals: [
        makeApproval(
          DEMAND_IDS.pendingPdo,
          'requirement_analysis',
          'G1',
          'approved',
          'CONSULTANT_A',
          minutesAgo(390),
          '范围清晰，可以进入开发说明。',
        ),
        makeApproval(
          DEMAND_IDS.pendingPdo,
          'dev_spec',
          'G2',
          'approved',
          'CONSULTANT_A',
          minutesAgo(310),
          '接口与冲突策略已确认。',
        ),
      ],
      events: [
        makeEvent('demand.submitted', 'SENT', minutesAgo(400)),
        makeEvent('artifact.approved', 'SENT', minutesAgo(390)),
        makeEvent('artifact.approved', 'SENT', minutesAgo(310)),
      ],
    },
  );

  // Completed demand: no pending approval, full history + timeline.
  register(
    demand({
      demandId: DEMAND_IDS.completed,
      demandNo: 'R-2003',
      title: '供应商主数据变更增加双人复核',
      description: '供应商银行账号与结算信息变更需要两人复核后再生效，变更记录保留审计轨迹。',
      acceptanceCriteria: [
        '供应商银行账号变更必须由两名不同用户复核。',
        '复核通过前变更不生效，原数据仍可查询。',
      ],
      requesterUserId: 'ZHANG_MIN',
      orgUnit: '采购部',
      priority: 'normal',
      templateId: 'default',
      status: '已完成',
      statusText: '已完成',
      stageKey: 'acceptance_archive',
      version: 8,
      createdAt: minutesAgo(60 * 72),
      changedAt: minutesAgo(300),
    }),
    {
      artifacts: [
        makeArtifact('requirement_analysis', 'requirement_analysis', 'approved', minutesAgo(60 * 70)),
        makeArtifact('dev_implementation', 'code_change', 'approved', minutesAgo(60 * 50)),
        makeArtifact('acceptance_archive', 'knowledge_entry', 'approved', minutesAgo(300)),
      ],
      approvals: [
        makeApproval(
          DEMAND_IDS.completed,
          'requirement_analysis',
          'G1',
          'approved',
          'CONSULTANT_A',
          minutesAgo(60 * 68),
          '同意进入开发。',
        ),
        makeApproval(
          DEMAND_IDS.completed,
          'dev_implementation',
          'G3',
          'approved',
          'CONSULTANT_A',
          minutesAgo(60 * 48),
          '实现与验收标准一致。',
        ),
        makeApproval(
          DEMAND_IDS.completed,
          'acceptance_archive',
          'G4',
          'approved',
          'ZHANG_MIN',
          minutesAgo(310),
          '已验证通过。',
        ),
        // Legacy rows from pre-contract data: hidden/deduped by the UI.
        makeApproval(DEMAND_IDS.completed, '', 'GATE', 'approved'),
        makeApproval(DEMAND_IDS.completed, 'requirement_analysis', 'G1', 'approved'),
      ],
      events: [
        makeEvent('demand.submitted', 'SENT', minutesAgo(60 * 72)),
        makeEvent('artifact.approved', 'SENT', minutesAgo(60 * 68)),
        makeEvent('hook.receipt', 'SENT', minutesAgo(300)),
      ],
    },
  );

  // Rejected demand: planned state with a rejection comment in the history.
  register(
    demand({
      demandId: DEMAND_IDS.rejected,
      demandNo: 'R-2004',
      title: '应收账龄报表增加区域维度',
      description: '希望应收账龄报表可以按销售区域拆分，支持区域财务对账。',
      acceptanceCriteria: ['报表可按销售区域筛选并导出。'],
      requesterUserId: 'CHEN_HAO',
      orgUnit: '财务共享中心',
      priority: 'low',
      templateId: 'pdo',
      status: '已驳回',
      statusText: '已驳回',
      stageKey: 'requirement_analysis',
      version: 2,
      createdAt: minutesAgo(60 * 50),
      changedAt: minutesAgo(60 * 20),
    }),
    {
      artifacts: [makeArtifact('requirement_analysis', 'requirement_analysis', 'rejected', minutesAgo(60 * 30))],
      approvals: [
        makeApproval(
          DEMAND_IDS.rejected,
          'requirement_analysis',
          'G1',
          'rejected',
          'CONSULTANT_B',
          minutesAgo(60 * 20),
          '验收标准无法量化，请补充可按区域核对的样例数据。',
        ),
      ],
      events: [
        makeEvent('demand.submitted', 'SENT', minutesAgo(60 * 50)),
        makeEvent('artifact.rejected', 'SENT', minutesAgo(60 * 20)),
      ],
    },
  );

  // Fresh demand with empty detail sections: validates every empty state.
  register(
    demand({
      demandId: DEMAND_IDS.fresh,
      demandNo: 'R-2005',
      title: '打印模板支持自定义页眉',
      description: '',
      acceptanceCriteria: [],
      requesterUserId: 'LIU_YANG',
      orgUnit: 'IT 服务部',
      priority: 'low',
      templateId: 'default',
      status: '待分析',
      statusText: '待分析',
      stageKey: 'requirement_analysis',
      version: 1,
      createdAt: minutesAgo(400),
      changedAt: minutesAgo(400),
    }),
  );

  // `pending-row` scenario: keep the explicit pending-approval path covered.
  if (scenario === 'pending-row') {
    const explicit = records.get(DEMAND_IDS.pendingDefault);
    explicit.approvals.push(
      makeApproval(DEMAND_IDS.pendingDefault, 'requirement_analysis', 'G1', 'pending'),
    );
  }

  return {
    list({ status = '', q = '' } = {}) {
      const query = q.trim().toLowerCase();
      return [...records.values()]
        .map((record) => record.demand)
        .filter((item) => (status === '' ? true : item.status === status))
        .filter((item) =>
          query === ''
            ? true
            : `${item.title} ${item.demandNo}`.toLowerCase().includes(query),
        )
        .sort((left, right) => Date.parse(right.changedAt) - Date.parse(left.changedAt));
    },

    detail(demandId) {
      return records.get(demandId) ?? null;
    },

    create(payload) {
      const title = cleanText(payload?.title);
      if (title === '') {
        return { error: { status: 400, code: 'validation', message: 'title is required' } };
      }
      const templateId = payload?.templateId === 'pdo' ? 'pdo' : 'default';
      const demandId = nextHex();
      const timestamp = now();
      const created = {
        demandId,
        demandNo: nextDemandNo(),
        title,
        description: cleanText(payload?.description),
        acceptanceCriteria: Array.isArray(payload?.acceptanceCriteria)
          ? payload.acceptanceCriteria.map(cleanText).filter((item) => item !== '')
          : [],
        requesterUserId: currentUser,
        orgUnit: cleanText(payload?.orgUnit),
        priority: priorities.has(payload?.priority) ? payload.priority : 'normal',
        templateId,
        templateVersion: 1,
        status: '待分析',
        statusText: '待分析',
        stageKey: templateId === 'pdo' ? 'intake' : 'requirement_analysis',
        version: 1,
        createdAt: timestamp,
        changedAt: timestamp,
      };
      records.set(demandId, {
        demand: created,
        artifacts: [],
        approvals: [],
        events: [makeEvent('demand.submitted', 'SENT', timestamp)],
      });
      return { demand: created };
    },

    decide(demandId, payload) {
      const record = records.get(demandId);
      if (record === undefined) {
        return { error: { status: 404, code: 'not_found', message: `demand ${demandId} not found` } };
      }
      const decision = payload?.decision;
      if (decision !== 'approve' && decision !== 'reject') {
        return {
          error: { status: 400, code: 'validation', message: 'decision must be approve or reject' },
        };
      }
      const gateKey = cleanText(payload?.gateKey);
      if (gateKey === '') {
        return { error: { status: 400, code: 'validation', message: 'gateKey is required' } };
      }
      const comment = cleanText(payload?.comment);
      if (decision === 'reject' && comment === '') {
        return {
          error: {
            status: 400,
            code: 'validation',
            message: 'comment is required when rejecting',
          },
        };
      }

      // Real-machine semantics: INSERT a decided approval row. The demand status
      // projection stays as-is until the control plane writes it back, and any
      // legacy `pending` row is left untouched (the UI hides the action area as
      // soon as a decision row for that gate exists).
      const decidedAt = now();
      const state = decision === 'approve' ? 'approved' : 'rejected';
      const approval = makeApproval(
        demandId,
        cleanText(payload?.stageKey) || record.demand.stageKey,
        gateKey,
        state,
        currentUser,
        decidedAt,
        comment,
      );
      record.approvals.push(approval);

      const demand = record.demand;
      demand.version += 1;
      demand.changedAt = decidedAt;
      const eventType = decision === 'approve' ? 'artifact.approved' : 'artifact.rejected';
      record.events.push(makeEvent(eventType, 'NEW', decidedAt));

      return {
        approval: {
          approvalId: approval.approvalId,
          demandId,
          gateKey,
          state,
        },
        demand,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// HTTP: static UI + mock API
// ---------------------------------------------------------------------------

async function handleRequest(request, response, options, store) {
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${options.port}`);
  if (url.pathname === apiPrefix || url.pathname.startsWith(`${apiPrefix}/`)) {
    await handleApi(request, response, url, options, store);
    return;
  }
  await handleStatic(response, url.pathname);
}

async function handleApi(request, response, url, options, store) {
  if (options.scenario === 'expired') {
    sendJson(response, 401, errorBody('unauthorized', 'session expired (scenario=expired)'));
    return;
  }

  const method = request.method ?? 'GET';
  const path = url.pathname.slice(apiPrefix.length) || '/';

  if (method === 'GET' && path === '/demands') {
    const demands =
      options.scenario === 'empty'
        ? []
        : store.list({
            status: url.searchParams.get('status') ?? '',
            q: url.searchParams.get('q') ?? '',
          });
    sendJson(response, 200, { demands, currentUser, serverTime: now() });
    return;
  }

  if (method === 'POST' && path === '/demands') {
    const payload = await readJson(request).catch((error) => error);
    if (payload instanceof Error) {
      sendJson(response, 400, errorBody('validation', payload.message));
      return;
    }
    const created = store.create(payload);
    if (created.error !== undefined) {
      sendJson(response, created.error.status, errorBody(created.error.code, created.error.message));
      return;
    }
    sendJson(response, 201, { demand: created.demand, serverTime: now() });
    return;
  }

  const match = /^\/demands\/([^/]+)(\/approvals)?$/.exec(path);
  if (match !== null) {
    const demandId = decodeURIComponent(match[1]);
    if (match[2] === undefined && method === 'GET') {
      const record = store.detail(demandId);
      if (record === null) {
        sendJson(response, 404, errorBody('not_found', `demand ${demandId} not found`));
        return;
      }
      sendJson(response, 200, {
        demand: record.demand,
        artifacts: record.artifacts,
        approvals: record.approvals,
        events: record.events,
        currentUser,
        serverTime: now(),
      });
      return;
    }
    if (match[2] !== undefined && method === 'POST') {
      const payload = await readJson(request).catch((error) => error);
      if (payload instanceof Error) {
        sendJson(response, 400, errorBody('validation', payload.message));
        return;
      }
      const decided = store.decide(demandId, payload);
      if (decided.error !== undefined) {
        sendJson(response, decided.error.status, errorBody(decided.error.code, decided.error.message));
        return;
      }
      sendJson(response, 201, {
        approval: decided.approval,
        demand: decided.demand,
        serverTime: now(),
      });
      return;
    }
  }

  if (method === 'GET' && path === '/health') {
    sendJson(response, 200, { status: 'ok', system: 'MOCK', version: 'preview', serverTime: now() });
    return;
  }

  sendJson(response, 404, errorBody('not_found', `unknown route ${method} ${url.pathname}`));
}

async function handleStatic(response, pathname) {
  if (pathname === '/') {
    redirect(response, `${uiPrefix}/`);
    return;
  }
  if (pathname === '/favicon.ico') {
    response.writeHead(204);
    response.end();
    return;
  }
  if (pathname === uiPrefix) {
    redirect(response, `${uiPrefix}/`);
    return;
  }
  if (!pathname.startsWith(`${uiPrefix}/`)) {
    sendText(response, 404, `not found: ${pathname}`);
    return;
  }

  const relativePath = decodeURIComponent(pathname.slice(uiPrefix.length + 1)) || 'index.html';
  const filePath = normalize(join(uiRoot, relativePath));
  if (filePath !== uiRoot && !filePath.startsWith(`${uiRoot}${sep}`)) {
    sendText(response, 403, 'forbidden');
    return;
  }

  try {
    const content = await readFile(filePath);
    response.writeHead(200, {
      'content-type': MIME_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': 'no-store',
      'content-length': content.length,
    });
    response.end(content);
  } catch {
    sendText(response, 404, `not found: ${relativePath}`);
  }
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error('request body too large');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('invalid JSON body');
  }
}

function now() {
  return new Date().toISOString();
}

function errorBody(code, message) {
  return { error: { code, message } };
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

function sendText(response, status, text) {
  response.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(text);
}

function redirect(response, location) {
  response.writeHead(302, { location });
  response.end();
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function printHelp() {
  console.log(`Usage: node scripts/sap-ui-preview.mjs [options]

Options:
  --port <number>      Port to listen on (default: 4173)
  --scenario <name>    Mock data: default | empty | expired | pending-row
                       default     = status projection only, gate inferred (like SAP)
                       empty       = demand list returns no rows
                       expired     = every API call returns 401
                       pending-row = explicit pending approval row (legacy path)
  -h, --help           Show this help

The server binds 127.0.0.1 only; Ctrl+C stops it.`);
}

function parseArgs(argv) {
  const options = { port: 4173, scenario: 'default' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--port') {
      options.port = Number.parseInt(argv[index + 1] ?? '', 10);
      index += 1;
    } else if (arg.startsWith('--port=')) {
      options.port = Number.parseInt(arg.slice('--port='.length), 10);
    } else if (arg === '--scenario') {
      options.scenario = argv[index + 1] ?? '';
      index += 1;
    } else if (arg.startsWith('--scenario=')) {
      options.scenario = arg.slice('--scenario='.length);
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!Number.isInteger(options.port) || options.port <= 0 || options.port > 65_535) {
    throw new Error('--port must be an integer between 1 and 65535');
  }
  if (!scenarios.has(options.scenario)) {
    throw new Error(`--scenario must be one of: ${[...scenarios].join(', ')}`);
  }
  return options;
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`[sap-ui-preview] ${error.message}`);
    printHelp();
    process.exit(1);
  }

  const store = createStore({ scenario: options.scenario });
  const server = createServer((request, response) => {
    handleRequest(request, response, options, store).catch((error) => {
      console.error('[sap-ui-preview] request failed:', error);
      if (!response.headersSent) {
        sendJson(response, 500, errorBody('internal_error', `${error}`));
      } else {
        response.end();
      }
    });
  });

  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`[sap-ui-preview] port ${options.port} is already in use; retry with --port <n>`);
    } else {
      console.error('[sap-ui-preview] server error:', error);
    }
    process.exitCode = 1;
  });

  server.listen(options.port, '127.0.0.1', () => {
    const base = `http://127.0.0.1:${options.port}`;
    console.log(`[sap-ui-preview] UI:        ${base}${uiPrefix}/`);
    console.log(`[sap-ui-preview] mock API:  ${base}${apiPrefix}/demands`);
    console.log(`[sap-ui-preview] scenario:  ${options.scenario}   user: ${currentUser}`);
    console.log(`[sap-ui-preview] detail:    ${base}${uiPrefix}/#/demand/${DEMAND_IDS.pendingDefault}`);
    console.log('[sap-ui-preview] routes:    #/list  #/new  #/demand/<id>');
  });

  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    console.log('\n[sap-ui-preview] stopping…');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
