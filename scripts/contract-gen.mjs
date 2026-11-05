#!/usr/bin/env node
// Contract snapshot generator (H0 §1.2):
//  - derives JSON Schema files from the zod registry in @sap-superagent/protocol
//  - materializes the committed request/response examples
//  - verifies contracts/openapi.yaml documents every S0 route
//
// Usage: node scripts/contract-gen.mjs [--check]
//   (no flag)  writes contracts/json-schema/*.json and contracts/examples/*.json
//   --check    compares generated content against the committed files
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const checkOnly = process.argv.includes('--check');
const protocolDist = path.join(root, 'packages/protocol/dist/index.js');

if (!existsSync(protocolDist)) {
  console.error('protocol is not built; run: pnpm --filter @sap-superagent/protocol run build');
  process.exit(1);
}

const { contractSchemas, z } = await import(pathToFileURL(protocolDist).href);

const jsonSchemaDir = path.join(root, 'contracts/json-schema');
const examplesDir = path.join(root, 'contracts/examples');

// Examples are part of the public contract: clients copy them into fixtures.
const examples = {
  'event-envelope.json': {
    seq: 12043,
    id: '01J8ZQ9W3K5M2V7X4C6B8N0P1Q',
    type: 'task.offered',
    at: '2026-11-04T12:00:00.000Z',
    subject: { type: 'task', id: '01J8ZQ9W3K5M2V7X4C6B8N0P1R' },
    data: { demandId: '4a3f9c2e7b1d48f0a6c5e2d9b8f7a1c3', priority: 'normal' },
  },
  'error-body.json': {
    error: {
      code: 'lease_expired',
      message: 'lease expired; re-read the task before writing',
      retryable: true,
      details: { taskId: '01J8ZQ9W3K5M2V7X4C6B8N0P1R' },
    },
  },
  'create-demand-body.json': {
    title: 'R-2041 取数逻辑',
    description: '按销售组织汇总开票金额，输出 ALV 列表',
    acceptanceCriteria: ['金额与 MARA 一致', '空结果返回 0'],
    priority: 'normal',
    requester: { userId: 'REQ001', orgUnit: 'PDO' },
    workspaceBinding: { repo: 'z-sales', projectKey: 'SALES', baseBranch: 'main' },
  },
  'register-executor-body.json': {
    kind: 'vscode',
    user: 'DEV001',
    machineIdHash: 'sha256:example',
    protocolVersion: '1.0.0',
    cliVersion: '0.0.0',
    capabilities: ['coding'],
    roles: ['developer'],
    workspaces: [
      {
        workspaceKey: 'wk-z-sales',
        repo: 'z-sales',
        projectKey: 'SALES',
        baseBranch: 'main',
      },
    ],
  },
  'claim-task-response.json': {
    task: {
      id: '01J8ZQ9W3K5M2V7X4C6B8N0P1Q',
      demandId: '4a3f9c2e7b1d48f0a6c5e2d9b8f7a1c3',
      stageRunId: '01J8ZQ9W3K5M2V7X4C6B8N0P1R',
      title: '实现需求 R-2041 的取数逻辑',
      executorKind: 'vscode',
      requiredRoles: ['developer'],
      workspaceBinding: { repo: 'z-sales', baseBranch: 'main' },
      priority: 'normal',
      dueAt: null,
      state: 'claimed',
      lastHolderUserIds: [],
      createdAt: '2026-11-04T12:00:00.000Z',
      updatedAt: '2026-11-04T12:00:00.000Z',
    },
    lease: { expiresAt: '2026-11-04T12:01:00.000Z', renewIntervalMs: 20000 },
    contextUrl: '/api/v1/tasks/01J8ZQ9W3K5M2V7X4C6B8N0P1Q/context',
    serverTime: '2026-11-04T12:00:00.000Z',
  },
  // --- S4: generic Hook contract (docs/008 §2/§4) ---
  'hook-envelope.json': {
    eventId: '01J8ZQ9W3K5M2V7X4C6B8N0P1Q',
    eventType: 'artifact.approved',
    eventVersion: 1,
    occurredAt: '2026-11-05T12:00:00.000Z',
    subject: {
      type: 'artifact',
      id: '01J8ZQ9W3K5M2V7X4C6B8N0P1R',
      demandId: '4a3f9c2e7b1d48f0a6c5e2d9b8f7a1c3',
      stageRunId: '01J8ZQ9W3K5M2V7X4C6B8N0P1S',
      artifactId: '01J8ZQ9W3K5M2V7X4C6B8N0P1R',
      version: 2,
    },
    payload: { artifactId: '01J8ZQ9W3K5M2V7X4C6B8N0P1R', gateKey: 'G1' },
    idempotencyKey: '4a3f9c2e7b1d48f0a6c5e2d9b8f7a1c3:http-example:9f2c0a',
    retry: { maxAttempts: 5, backoff: 'exponential', deadLetter: true },
    traceId: '01J8ZQ9W3K5M2V7X4C6B8N0P1Q',
  },
  'hook-receipt-body.json': {
    eventType: 'hook.receipt',
    idempotencyKey: 'JIRA-1234:created',
    occurredAt: '2026-11-05T12:03:00.000Z',
    payload: {
      externalId: 'JIRA-1234',
      status: 'created',
      detailRef: 'https://jira.example.com/browse/JIRA-1234',
    },
  },
  // --- S5: SAP-batch AI executor (docs/003 §4.8) ---
  'sap-ai-job.json': {
    id: '01J8ZQ9W3K5M2V7X4C6B8N0P1Q',
    stageRunId: '01J8ZQ9W3K5M2V7X4C6B8N0P1R',
    demandId: '4a3f9c2e7b1d48f0a6c5e2d9b8f7a1c3',
    attempt: 1,
    stageKey: 'requirement_analysis',
    state: 'queued',
    payload: {
      stageRunId: '01J8ZQ9W3K5M2V7X4C6B8N0P1R',
      demandId: '4a3f9c2e7b1d48f0a6c5e2d9b8f7a1c3',
      stageKey: 'requirement_analysis',
      stageName: '需求分析',
      attempt: 1,
      promptVersion: 'requirement-analysis/v1',
      systemPrompt: '你是 SAP 研发交付流程中的结构化文档助手。只输出符合要求的单个 JSON 对象。',
      prompt: '# 需求分析\\n请按模板要求输出 JSON。',
      model: 'gateway-model',
      outputSchema: 'requirement_analysis',
      timeoutMs: 120000,
    },
    claimId: null,
    leaseExpiresAt: null,
    result: null,
    lastError: null,
    createdAt: '2026-11-05T12:00:00.000Z',
    updatedAt: '2026-11-05T12:00:00.000Z',
  },
  'sap-ai-job-result-body.json': {
    claimId: 'CLAIM-01J8ZQ9W3K5M2V7X4C6B8N0P1S',
    status: 'succeeded',
    outputText: '{"summary":"示例模型原始输出"}',
    usage: { promptTokens: 812, completionTokens: 240, totalTokens: 1052, model: 'gateway-model' },
    durationMs: 2340,
  },
};

// The committed examples must validate against the schemas they illustrate.
const EXAMPLE_SCHEMA_MAP = {
  'event-envelope.json': 'event-envelope',
  'error-body.json': 'error-body',
  'create-demand-body.json': 'create-demand-body',
  'register-executor-body.json': 'register-executor-body',
  'claim-task-response.json': 'claim-task-response',
  'hook-envelope.json': 'hook-envelope',
  'hook-receipt-body.json': 'hook-receipt-body',
  // --- S5: SAP-batch AI executor ---
  'sap-ai-job.json': 'sap-ai-job',
  'sap-ai-job-result-body.json': 'sap-ai-job-result-body',
};

const REQUIRED_OPENAPI_PATHS = [
  '/healthz',
  '/executors/register',
  '/executors/{id}',
  '/executors/{id}/heartbeat',
  '/tasks',
  '/tasks/{id}',
  '/tasks/{id}/context',
  '/tasks/{id}/claim',
  '/tasks/{id}/lease/renew',
  '/tasks/{id}/progress',
  '/tasks/{id}/artifacts',
  '/tasks/{id}/complete',
  '/tasks/{id}/fail',
  '/tasks/{id}/release',
  '/demands',
  '/demands/{id}',
  '/demands/{id}/cancel',
  '/events',
  '/admin/tasks',
  // --- S4: generic Hook surface (root paths, docs/003 §4.7) ---
  '/hooks',
  '/hooks/{id}/replay',
  '/hooks/{target}/receipt',
  // --- S5: SAP-batch AI executor surface (HMAC, docs/003 §4.8) ---
  '/sap/ai-jobs/next',
  '/sap/ai-jobs/{id}/claim',
  '/sap/ai-jobs/{id}/heartbeat',
  '/sap/ai-jobs/{id}/result',
  '/admin/sap/ai-jobs/{id}/requeue',
];

const failures = [];
const writes = [];

function emplace(relativePath, content) {
  const absolutePath = path.join(root, relativePath);
  if (checkOnly) {
    if (!existsSync(absolutePath)) {
      failures.push(`missing ${relativePath}`);
      return;
    }
    const current = readFileSync(absolutePath, 'utf8');
    if (current !== content) failures.push(`stale ${relativePath} (run pnpm contract:gen)`);
    return;
  }
  writeFileSync(absolutePath, content);
  writes.push(relativePath);
}

mkdirSync(jsonSchemaDir, { recursive: true });
mkdirSync(examplesDir, { recursive: true });

for (const [name, schema] of Object.entries(contractSchemas)) {
  let jsonSchema;
  try {
    jsonSchema = z.toJSONSchema(schema, {
      target: 'draft-2020-12',
      io: 'output',
      unrepresentable: 'any',
    });
  } catch (error) {
    failures.push(`cannot derive JSON Schema for ${name}: ${error.message}`);
    continue;
  }
  emplace(`contracts/json-schema/${name}.json`, `${JSON.stringify(jsonSchema, null, 2)}\n`);
}

for (const [name, example] of Object.entries(examples)) {
  emplace(`contracts/examples/${name}`, `${JSON.stringify(example, null, 2)}\n`);
  const schemaName = EXAMPLE_SCHEMA_MAP[name];
  const schema = schemaName === undefined ? undefined : contractSchemas[schemaName];
  if (schema !== undefined) {
    const parsed = schema.safeParse(example);
    if (!parsed.success) {
      failures.push(
        `example ${name} does not validate against ${schemaName}: ${parsed.error.issues
          .map((issue) => `${issue.path.join('.') || '<root>'} ${issue.message}`)
          .join('; ')}`,
      );
    }
  }
}

const openapiPath = path.join(root, 'contracts/openapi.yaml');
if (!existsSync(openapiPath)) {
  failures.push('missing contracts/openapi.yaml');
} else {
  const openapi = readFileSync(openapiPath, 'utf8');
  for (const routePath of REQUIRED_OPENAPI_PATHS) {
    if (!openapi.includes(`  ${routePath}:`)) {
      failures.push(`contracts/openapi.yaml does not document S0 route ${routePath}`);
    }
  }
}

if (checkOnly) {
  if (failures.length > 0) {
    console.error(`contract check failed:\n- ${failures.join('\n- ')}`);
    process.exit(1);
  }
  console.log(
    `contract check ok: ${Object.keys(contractSchemas).length} schemas, ${Object.keys(examples).length} examples, ${REQUIRED_OPENAPI_PATHS.length} routes`,
  );
} else {
  if (failures.length > 0) {
    console.error(`contract generation had problems:\n- ${failures.join('\n- ')}`);
    process.exit(1);
  }
  console.log(`wrote ${writes.length} generated contract files`);
}
