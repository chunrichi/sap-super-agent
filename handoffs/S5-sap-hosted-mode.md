# S5 — SAP 宿主受限模式（M3：SAP 侧批处理 AI + SAP 内审批）

> 依赖：S0–S4 与 H2 Phase A/B 已完成并合入 `main`（起草基线 `main@36e9c75`；认领前先 pull 最新，基线门禁 `pnpm check` **440 tests** / `pnpm e2e` **16/16** 绿、`pnpm sap:check` 离线绿）。
> 目标：把"需求分析 / 测试文档"等**结构化 AI 阶段**从控制平面的 Node `server-ai` 执行器切到 **SAP 内批处理执行器**：SAP 侧 job 拉取任务、调用企业 AI 网关、回传结果；控制平面仍独占状态机/校验/门禁/审批推进，SAP 内审批直接驱动阶段。部署为 M3：控制平面轻服务与 SAP 同网段，数据与流程不离开企业边界。
> 规格来源：[docs/002 §6/§7](../docs/002-architecture.md)、[docs/004 §7](../docs/004-sap.md)、[docs/005 §3.3](../docs/005-clients-and-ai.md)、[docs/007 S5](../docs/007-roadmap.md)、[docs/009 #15](../docs/009-testing.md)；协议契约以 [docs/003](../docs/003-domain-and-protocol.md) + 本文为准，M3 部署口径以本切片新建的 `docs/010-m3-deployment.md` 为准。
> 执行交接（可复用接口/默认决策/环境坑/启动 Prompt）：[S5-execution-handoff.md](S5-execution-handoff.md)。

## 0. 起点（已具备，不要重写）

- **控制平面**：`packages/server/src/workers/stage-runner.ts`（`ready server-ai → running → runAiStage → completeStage`：schema/checklist/ledger/工件/门禁）；`stage-engine.ts`（`persistStageArtifact`/`completeStageAfterArtifact`/`failStageAttempt`/审批推进）；事件日志 + WS（`db/events.ts`、`db/transaction.ts`、`http/route-utils.ts#publish`）。
- **AI 能力**：`packages/ai` 已导出 `AI_STAGE_DEFINITIONS`、`renderAiStagePrompt(definition, input)`、`parseStageOutput(schema, rawText, label)`、阶段输出 schema 与 `StageRunLedger`；`runAiStage` 供本地执行器使用。
- **SAP 侧（`$ZSA`，H2 Phase B 已部署并 active）**：6 张表、`ZCL_ZSA_JSON`（JSON 序列化/反序列化）、`ZCL_ZSA_EVENT_PUSH`（outbox 选取、HMAC、HTTP、退避）、`ZCL_ZSA_HTTP_HANDLER`（ICF `/sap/zsa`）、MIME `/zsa/ui`、`ZSA_OUTBOX_PUSH`（SM36 job）；`ZSA_CFG` 极少量配置。
- **审批联邦**：SAP `artifact.approved/rejected` → `POST /hooks/sap`（HMAC + 幂等）→ H1 门禁 `decideApprovalApprove/Reject` 已实现并有测试；S5 只需补"SAP 内审批在无 client 在线时驱动阶段"的证明。
- **测试设施**：`packages/testkit`（`FakeIcfServer`、`FakeModelProvider`、`FakeExecutor`、helpers、`apiRequest`/`waitFor`）；e2e 进程内、总时长 <5s；contract 快照 + `pnpm contract:check`；`pnpm sap:check`（离线 `abap validate:aff`/`check content`）。
- **已知人工阻塞（H2-B，S5 Phase B 复用）**：控制平面可从测试系统访问 + `SA_SAP_HOOK_SECRET` 注入、控制平面→SAP 服务账号、SM36/bgRFC 调度窗口。S5 Phase B 另加：企业 AI 网关 URL/model/key 与出口策略、SAP 安全存储注入方式。

## 1. 交付物

> **Phase A（1.1–1.6）：纯离线可验收，不需要 SAP 系统与真实 AI 网关。**
> **Phase B（1.7）：真机验收，依赖 §1.7 人工输入；输入缺失时按 H2-B 先例交付 Phase A 并记录 blocked/转 S5-B。**

### 1.1 契约先行（第一步）

- `docs/003` 新增 **§4.8 SAP 批处理 AI 执行器（M3）**：job 生命周期（`QUEUED → CLAIMED → SUCCEEDED | FAILED | EXPIRED | CANCELLED`）、租约/幂等、SAP→控制平面 HMAC 认证（复用 `X-SA-*`，不引入第二套签名）、结果校验/ledger/门禁推进、admin 运维面、数据边界。
- `docs/003` §4.4 事件表新增持久事件：`stage.ai_job.queued`、`stage.ai_job.claimed`、`stage.ai_job.completed`、`stage.ai_job.failed`（`subject.type=stage_run`，供运维与审计）。
- `docs/004` §7 更新"M3 落地边界"（SAP 只做批处理执行器 + 网关调用，不做交互式 agent；控制平面轻量服务同网段）；`docs/005` §3.3 补 M3 网关路径；`docs/007` S5 状态。
- `packages/protocol`：`sapAiJobSchema`/`sapAiJobPayloadSchema`/`sapAiJobsResponse`/`sapAiJobClaimBody|Response`/`sapAiJobHeartbeatBody|Response`/`sapAiJobResultBody|Response`/`sapAiJobStatus` 等；`pnpm contract:gen` 提交 `contracts/` diff。
- **本子项完成后立即回报 commit hash**（与 S4 同样的契约先行节奏）。
- ⚠️ 设计要点：**prompt 由控制平面渲染**（`renderAiStagePrompt`）后放进 job payload；SAP 只做"取 prompt → 调企业 AI 网关 → 回传模型原始输出文本"，JSON 提取/schema/checklist/ledger/门禁全部留在控制平面。这样 prompt/校验单源，ABAP 不复制 AI 逻辑。

### 1.2 控制平面：SAP AI job 队列 + 执行器 API

- **默认关闭**：`SA_SAP_AI_BATCH` 未设置/`0` 时行为与 H0–S4 完全一致（stage-runner 本地调用 provider）。
- 配置（env，写入 docs/010）：
  - `SA_SAP_AI_BATCH=1` 启用 SAP 批处理模式；
  - `SA_SAP_AI_STAGE_KEYS`：可选逗号白名单；缺省 = 当前模板内**全部 `server-ai` 阶段**；
  - `SA_SAP_AI_JOB_LEASE_MS`（默认 600000 = 10min）、`SA_SAP_AI_JOB_MAX_AGE_MS`（默认 1800000 = 30min，超龄判该 attempt 失败/转人工）、`SA_SAP_AI_JOB_BATCH_SIZE`（默认 5）。
- 迁移 **v7**（只追加，v1–v6 不改）：`sap_ai_jobs`（`id`、`stage_run_id`、`demand_id`、`attempt`、`stage_key`、`state`、`payload`、`claim_id`、`lease_expires_at`、`result`、`last_error`、`created_at`、`updated_at`，`UNIQUE(stage_run_id, attempt)`）；入队游标/恢复所需状态放同表或 `sap_integration_state`（只追加 key）。
- API（SAP→控制平面，**POST + `X-SA-*` HMAC**（复用 `SA_SAP_HOOK_SECRET`，±5min，`X-SA-Delivery` 幂等），**不走 Bearer**；admin 运维面才用 token）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/v1/sap/ai-jobs/next` | body `{limit?}` → 可领取 job 列表（只读，不改变状态） |
| POST | `/api/v1/sap/ai-jobs/{id}/claim` | body `{}` → `{job, claimId, lease.expiresAt}`；租约有效期内重复 claim → `409` |
| POST | `/api/v1/sap/ai-jobs/{id}/heartbeat` | body `{claimId}` → 续租；claim 不匹配/过期 → `409` |
| POST | `/api/v1/sap/ai-jobs/{id}/result` | body `{claimId, status:"succeeded"\|"failed", outputText?, usage?, error?}`；成功时控制平面做 JSON 提取 + 输出 schema + checklist + ledger + 工件/门禁（复用 `completeStage` 语义）；重复 result 幂等（`X-SA-Delivery` / `(jobId,attempt)`） |
| POST | `/api/v1/admin/sap/ai-jobs/{id}/requeue` | admin token；把 FAILED/EXPIRED/超龄 job 重新排入（运维手动恢复，幂等） |
| GET | `/hooks/sap/status` | 在现有响应中**追加** `aiJobs: {queued, claimed, succeeded, failed, expired, lastError}`（不破坏现有字段） |
- **StageRunner 集成**（关键）：
  - 阶段 ready 且命中委派：沿用现有 claim（`running` + `stage.started`），随后**不调用本地 provider**，渲染 prompt 并写 job `QUEUED` + `stage.ai_job.queued`；stage 保持 `running` 等待结果；
  - 结果成功：把 `completeStage` 中"校验 + ledger + 工件 + 门禁/observe"抽成公共函数（**不要复制两份语义**），调用后写 `stage.ai_job.completed`；
  - 结果失败 / 输出非法：复用 `failStageAttempt`（重试到 `maxAttempts` → `waiting_human`，不落半成品工件），写 `stage.ai_job.failed`；
  - 租约过期：job 回到可领取（不增 attempt）；超过 `MAX_AGE` 或多次过期 → 按失败处理（重试/转人工）；
  - 重启恢复：`CLAIMED` 且过期 → `QUEUED`；`running` 但无 job → 补建（幂等）。
  - 断言：启用时**本地 `ctx.aiProvider` 不被调用**（数据边界/成本测试）。
- **数据边界**：job payload 含 prompt/模型/schema 引用/超时，不含凭据；控制平面不持有 AI 网关 key；日志不打印 prompt/output 正文（只打 ids/长度/耗时）。

### 1.3 SAP 侧 ABAP（`$ZSA`，abap-cli AFF）

- 新类 `ZCL_ZSA_AI_BATCH`：
  - 拉取（`/api/v1/sap/ai-jobs/next`）→ claim → 调用企业 AI 网关（默认 OpenAI 兼容 `POST <AI_GATEWAY_URL>/chat/completions`，model 来自 payload 或 `ZSA_CFG`；现场可换 ABAP AI SDK）→ heartbeat（长任务）→ 回传 result；
  - HMAC（`X-SA-Signature/Timestamp/Delivery`）与 JSON 复用现有 `ZCL_ZSA_EVENT_PUSH`/`ZCL_ZSA_JSON` 规则（可抽公共静态方法/类，**事件推送行为保持不变**）；
  - 退避与最多尝试、租约过期后重新拉取；失败写 BAL/SM37 日志（不写 prompt/输出正文）；
  - 网关错误分类：5xx/429/超时 → 本地重试或回传 `failed`（由控制平面按 attempt 语义处理）；4xx（key/model 错）→ 回传 `failed` 并告警。
- 新 testclasses（ABAP Unit）：JSON 映射、HMAC 头、claim/result 幂等、超时/失败、租约续期；真机 `abap check syntax` + `abap test` 通过。
- 新程序 `ZSA_AI_BATCH_RUN`：SM36 周期 job 默认（**bgRFC 为 Phase B 可选通道**，按系统能力）；不改 `ZSA_OUTBOX_PUSH`。
- `ZSA_CFG` 新键：`AI_GATEWAY_URL`、`AI_GATEWAY_MODEL`、`AI_KEY_REF`（安全存储引用，**不存明文**）、`AI_TIMEOUT_MS`；复用 `CONTROL_PLANE_URL` 与 HMAC secret 引用。
- `scripts/sap-check.mjs` 必需文件清单更新；`abap validate:aff` / `abap check content` 离线全绿。

### 1.4 SAP 内审批直接驱动阶段（端到端证明）

- 复用 H2/H1 审批联邦（不新增 ABAP 控制逻辑）：SAP Web 审批 → `POST /api/v1/demands/{id}/approvals` → outbox → `/hooks/sap` → 控制平面 stage-engine 推进。
- S5 补"**无任何 executor 在线**"的断言与真机证据：SAP 内审批通过后 AI 阶段继续由 SAP job 生成，直到需求完成。

### 1.5 M3 部署与运维文档

- 新建 `docs/010-m3-deployment.md`（S5 交付物，docs/007 链入）：
  - 拓扑图：SAP（`$ZSA`/ICF/MIME/批处理 job）↔ 轻量控制平面（Node + SQLite，同网段）↔ 企业 AI 网关；无外网依赖；
  - 网络矩阵：SAP→CP（job API + `/hooks/sap`）、CP→SAP（ICF 回写/对账）、SAP→AI 网关（HTTPS）、运维入口；防火墙/TLS/证书要求；
  - 配置/env/secret 表（`SA_SAP_AI_*`、`SA_SAP_*`、`SA_STATE_DIR`、`SA_HTTP_PORT`、HMAC、服务账号、网关 key 引用）；
  - 单节点部署（systemd unit / docker compose；SQLite 加密卷 + 备份；反向代理/TLS）；SM36/bgRFC 配置步骤；
  - **数据边界声明**：需求/工件/事件/日志不出企业；prompt/输出仅在 CP→SAP→内网网关路径；SAP 与 CP 日志不落正文；
  - runbook：job 卡住/租约过期/积压/网关超时/失败重排（admin requeue）/监控面板/SM37 日志排查；
  - M3 验收 checklist（与 §2 Phase B 对齐）。
- `README` 增加 M3 文档入口与"最小 M3 部署"命令；`docs/002`/`docs/004`/`docs/007` 同步。

### 1.6 测试（Phase A 完全离线）

- `packages/testkit`：
  - `FakeSapAiBatch`：进程内模拟 SAP 批处理执行器（HMAC 拉取/claim/心跳/回传；可配置为调用 `FakeAiGateway` 或直接产出合法输出；故障注入：网关超时、5xx、非法 JSON/schema、重复 result、claim 冲突、租约过期）；
  - `FakeAiGateway`：OpenAI 兼容响应（`choices[0].message.content`），支持故障注入（超时/5xx/坏 JSON/429）。
- `packages/server` 集成测试（新增 `test/sap-ai-jobs.test.ts` 等）：
  1. 默认关闭：不委派、行为与 H0–S4 一致；
  2. job 生命周期与队列：ready→QUEUED→CLAIMED→SUCCEEDED；claim 幂等/冲突；heartbeat 续租；
  3. result 幂等（重复 result 只完成一次、只写一条 `stage.ai_job.completed`、只有一条 dispatch/attempt ledger）；
  4. 输出非法/网关失败 → 重试到 `maxAttempts` → `waiting_human`，无半成品工件；
  5. 租约过期重回队列；超龄/多次过期 → 失败/转人工；
  6. 重启恢复（CLAIMED 过期 → QUEUED；running 无 job → 补建）；
  7. admin requeue 幂等；`GET /hooks/sap/status` aiJobs 计数/lastError；
  8. 启用时本地 provider 调用次数为 0（数据边界）。
- e2e（`packages/testkit/e2e/sap-hosted.e2e.test.ts`，进程内，**`pnpm e2e` 总时长 <5s**）：
  - pdo Demand → SAP batch 生成 `intake`/`requirement_analysis` → fake SAP Web 审批（`/hooks/sap`）G1/G2 → dev 阶段由 `FakeExecutor` 完成并注销（模拟开发者离线）→ SAP batch 生成 `test_doc` → SAP 审批 G4/G5 → `knowledge_entry` → Demand `done`；
  - 断言全程无 executor 在线、事件链含 `stage.ai_job.*`、provider 未被调用、工件版本/门禁正确。
- 覆盖 [docs/009 #15](../docs/009-testing.md)（AI 超时/输出不合 schema → 重试到上限转人工、不产生半成品、成本/token 记账）+ 新增失败场景：重复 claim/result、租约过期、SAP job 失败。
- 命令：`pnpm check`、`pnpm e2e`、`pnpm build`、`pnpm sap:check`、`pnpm contract:check`。

### 1.7 Phase B（真机，依赖人工输入；可拆到 S5-B）

- **前置输入（缺失即 blocked，按 H2-B 先例在 STATUS 记录）**：
  1. 控制平面可从测试系统访问（内网地址/隧道）+ `SA_SAP_HOOK_SECRET` 注入；
  2. 控制平面→SAP 服务账号（ICF 回写/对账）；
  3. SM36/bgRFC 调度窗口与权限；
  4. 企业 AI 网关 URL/model/key（SAP 安全存储引用）与出口策略；SAP 系统 release/许可是否走 ABAP AI SDK；
  5. 测试系统（S/4HANA `SAP_ABA 75H`，profile `test`）可达、`abap doctor` 通过。
- **步骤**：`abap pull`（新类/程序）→ `abap push` → `abap check syntax` → `abap activate` → `abap test`（ABAP Unit）→ `ZSA_CFG` 写入网关配置（key 走安全存储）→ SM36 job（或 bgRFC）→ 端到端：SAP Web 提交需求 → 无开发者在线自动生成需求分析 → SAP 审批 → 测试文档 → 归档完成。
- **证据**：`abap` 命令输出、ABAP Unit 结果、SM37 job log、`ZSA_DEMAND`/`ZSA_ARTIFACT` 查询、控制平面 `GET /hooks/sap/status`、事件链；记录到 STATUS。
- 只连测试系统；**不自动激活到生产**；不提交密钥/地址/`.env`。

## 2. 验收

```sh
pnpm install --frozen-lockfile
pnpm check          # 现有 440 tests 不回归 + 新增
pnpm e2e            # 现有 16/16 + 新增，总时长 <5s
pnpm build
pnpm sap:check      # 离线；有测试系统时附加在线（Phase B）
pnpm contract:check
```

手工冒烟（Phase A 可用 `FakeSapAiBatch`/e2e 复现；Phase B 用真机并记录实际输出）：

1. **默认关闭回归**：不设 `SA_SAP_AI_BATCH`，H0–S4 门禁全绿、行为不变。
2. **SAP 批处理生成**：设 `SA_SAP_AI_BATCH=1`，建 pdo Demand，无任何 executor 在线 → `intake`/`requirement_analysis` 由 SAP batch 生成（`stage.ai_job.*` 事件、`GET /hooks/sap/status` aiJobs 计数正确）。
3. **SAP 内审批推进**：SAP Web 审批 G1/G2（fake webhook / 真机）→ 阶段推进；无 client 在线。
4. **测试文档与幂等/失败**：dev 完成后开发者离线 → SAP batch 生成 `test_doc`；注入网关超时/非法输出 → 重试到上限转 `waiting_human`、无半成品；重复 claim/result 幂等（不重复完成、不重复工件/事件）。
5. **M3 文档可照做**：按 docs/010 在测试环境完成 CP 部署 + SAP 配置，跑通 Phase B checklist。

## 3. 边界与禁令

- **不实现** ABAP 内交互式 agent / 流式输出 / ABAP 全量控制平面；SAP 只做批处理执行器 + 网关调用；不做 SSO/Basis 配置本身（人工项）。
- **不改** H0–S4 语义；`/hooks/sap` 入站行为保持不变（可复用签名/JSON 工具，行为不变）；SAP outbox push 不改。
- **契约先行**：先 `docs/003` + `packages/protocol` + `pnpm contract:gen`，再实现；跨包契约变更不得只改一侧。
- 迁移从 **v7** 起、只追加；共享文件（`app.ts`/`types.ts`/`config.ts`/`server.ts`/`migrations.ts`）用 `// --- S5: ... ---` 追加块。
- 不新增外部依赖（HTTP 用 Node `fetch`/ABAP `cl_http_client`；JSON 用仓库/`ZCL_ZSA_JSON`；不引入 SDK 包）。
- 默认关闭；`templates/` 原则不改（委派由 env 决定；若确需模板字段，先改 docs/003 再实现）。
- 不实现暂停/恢复 UI、MCP、客户端展示；不默认外部 SaaS 模型。
- 不提交密钥/地址/`.env`；不 push、不直推 `main`、不 force push；只连测试系统、不自动激活生产。

## 4. 写范围

`packages/protocol/**`、`packages/server/**`、`packages/ai/**`（只做加法：导出/复用，不改既有阶段语义）、`packages/testkit/**`、`packages/sap-adapter/**`（只做加法：签名/JSON 复用）、`contracts/**`、`docs/003-domain-and-protocol.md`、`docs/004-sap.md`、`docs/005-clients-and-ai.md`、`docs/007-roadmap.md`、`docs/009-testing.md`、`docs/010-m3-deployment.md`（新建）、`sap/**`、`scripts/sap-check.mjs`、`README.md`、`handoffs/STATUS.md`。

`templates/**`、`packages/clients/**`、`packages/core/**` 不在本轮；确需改动先在报告中说明并由 Lead 裁决。

## 5. 上报格式

完成项、Phase A 命令与关键输出（`pnpm check` / `pnpm e2e` / `pnpm build` / `pnpm sap:check` / `contract` 快照）、Phase B 输入清单与证据（或 blocked 原因）、与 docs 的偏差、遗留/未决。

## 6. 启动 Prompt

见 [S5-execution-handoff.md](S5-execution-handoff.md) §6（可直接复制给新 session）。
