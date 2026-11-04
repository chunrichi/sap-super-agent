# H0 — Walking Skeleton（S0）

> 任务类型：实现。**必须最先完成**，H1/H2 都依赖它。
> 目标：在 M1 本地模式跑通"需求 → 服务端 AI 分析 → 客户端领取开发任务 → 提交工件 → 完成"的纵向闭环。
> 规格来源：[docs/002](../docs/002-architecture.md)、[docs/003](../docs/003-domain-and-protocol.md)、[docs/005](../docs/005-clients-and-ai.md)、[docs/007](../docs/007-roadmap.md) S0、[docs/009](../docs/009-testing.md)。

## 1. 交付物

### 1.1 仓库骨架

创建 pnpm workspace（根配置已就绪：`package.json`、`pnpm-workspace.yaml`、`tsconfig.base.json`）：

```text
packages/
├─ protocol/            @sap-superagent/protocol
├─ core/                @sap-superagent/core
├─ server/              @sap-superagent/server
├─ ai/                  @sap-superagent/ai
├─ sap-adapter/         占位（H2 实现；H0 只建空包/README 也可）
├─ cli/                 @sap-superagent/cli
├─ testkit/             @sap-superagent/testkit
└─ clients/
   └─ vscode/           sap-superagent-vscode
contracts/              OpenAPI/JSON Schema/示例（生成物入库）
templates/default.yaml  H0 的最小 2 阶段模板（H1 扩展为 3/6 阶段）
scripts/                e2e.mjs、contract-gen.mjs 等
```

- 每个包：`package.json`（`"type": "module"`、`private: true`、`scripts: {typecheck,test,build}`）、`tsconfig.json`（extends `../../tsconfig.base.json`）、`src/index.ts`。
- 依赖建议：`zod`、`ulid`、`fastify`、`ws`、`better-sqlite3`（或 Node 24 `node:sqlite`，只要 e2e 可跑且无需编译开关）、`commander`；测试 `vitest`。根 `pnpm install` 后可跑。
- `.github/workflows/ci.yml`：ubuntu + node 24 + pnpm，跑 `pnpm install --frozen-lockfile && pnpm check && pnpm e2e`。

### 1.2 `packages/protocol`

- zod schema + TS 类型，覆盖 003 §2 实体、§4 请求/响应、§4.4 事件 envelope、错误体。
- 枚举：Demand/StageRun/Task/Assignment/Artifact/Approval 状态；`executorKind ∈ {vscode, server-ai}`；presence `{online,busy,away,offline}` + `accepting`。
- ID 规则：控制面实体 ULID；`demandId` 外部主键（SAP C32）。
- 导出 `contracts/openapi.yaml`（可先手写最小集）与 `contracts/examples/*.json`；`pnpm contract:gen` 做 schema 快照校验。
- 测试：schema 正反例、枚举闭集、错误体形状。

### 1.3 `packages/core`

- 纯函数、无 IO；状态机与规则全部可单测：
  - Demand：`submitted → in_progress → review → done | cancelled | rejected`。
  - StageRun：一 Demand 一 Stage 一个 StageRun；attempt 递增；`pending → ready → running → done | waiting_human | failed → cancelled`。
  - Task：`pending → claimed → in_progress → completed | failed | cancelled`；`released/expired` 回 `pending`；lease 60s/renew 20s。
  - Assignment：`active → completed | released | expired`。
  - Artifact：不可变版本；`draft → generated → in_review → approved | rejected`；`superseded`。
  - Approval：`pending → approved | rejected | withdrawn | expired`。
- 调度资格规则（003 §3）：executorKind、角色、`workspaceBinding`（可空 → 通用箱）、presence/accepting、并发、`lastHolderUserIds` 降权。
- 模板：按 003 §2.7 定义 StageTemplate（H0 只加载 `templates/default.yaml` 的最小子集，H1 扩展）。
- 测试覆盖：每个状态转换的正/反例、一阶段一 StageRun、lease 过期回池、可选绑定分支。

### 1.4 `packages/server`

- HTTP：Fastify（或等价）+ `ws`；实现 003 §4.2/4.3 的 S0 子集：
  - `POST /executors/register`、`POST /executors/{id}/heartbeat`、`DELETE /executors/{id}`
  - `GET /tasks`、`GET /tasks/{id}`、`GET /tasks/{id}/context`、`POST /tasks/{id}/claim`、`/lease/renew`、`/progress`、`/artifacts`、`/complete`、`/fail`、`/release`
  - `POST /demands`、`GET /demands/{id}`、`GET /events?after=`、`/events/stream`（SSE 可后置）、`GET /healthz`
  - **S0 管理端点**：`POST /admin/tasks` 手建开发任务（S0 验证用；S1 由模板自动产生）。
- WS：`/events`（token、`after` 游标、`lastSeq` 补发、`resync_required`）；消息 `task.offered/updated/cancelled`、`server.ping`。
- 存储：SQLite 单文件（`SA_STATE_DIR`）；表：`demands, stage_runs, stage_attempts, tasks, assignments, artifacts, artifact_versions, approvals, executors, events, idempotency, outbox`；迁移脚本入库。
- 事件日志：append-only，带全局 `seq`；写操作先写事件再返回。
- 幂等：`Idempotency-Key` 表（24h）；claim 用 CAS/事务；租约校验。
- Stage runner：消费 `server-ai` 阶段（H0 只有 `requirement_analysis`），调用 `packages/ai`，成功产 Artifact，失败按 attempt 重试/转人工。
- 配置：`.env`（`SA_AI_*`、`SA_STATE_DIR`、`SA_HTTP_PORT`）；启动时建目录、跑迁移；单实例锁（文件锁即可）。
- 测试：集成测试跑 REST/WS 生命周期（supertest 或 fetch）。

### 1.5 `packages/ai`

- `ModelProvider` 接口 + `openai-compatible` + `fake` 两个实现；`SA_AI_PROVIDER` 选择（无 Key 时 `fake`）。
- 阶段 `requirement_analysis`：prompt 模板、输入（Demand 快照）、输出 zod schema、重试上限、run ledger（模型/token/成本/耗时）。
- 默认 prompt 放 `packages/ai/prompts/requirement-analysis.md`；根 `prompts/` 覆盖层 H1 再做。
- 测试：fake provider 产固定 JSON → 阶段完成；非法输出触发重试/失败。

### 1.6 `packages/cli`

- `sap-superagent init`：写 `.sap-superagent/workspace.json`（repo/projectKey/baseBranch/prepare 可空）+ 提示 `.env.example`。
- `sap-superagent dev`：启动 M1 服务、打印 URL 与 dev token；支持 `--port`、`--state-dir`。
- `sap-superagent token`：签发本地 token（M1 静态 token）。
- `sap-superagent doctor`：检查 Node/pnpm/端口/状态目录/模型配置。
- 测试：`init` 后 `dev` 能起来（e2e 可复用）。

### 1.7 `packages/clients/vscode`

- 扩展骨架（`package.json` 含 `engines.vscode`、`activationEvents`、6 个命令）。
- Activity Bar 任务箱：`可领取 / 我的任务 / 等待我回答`（`等待我回答` S1 接入，H0 可空）。
- 命令：`连接控制平面`、`绑定当前工作区`、`领取任务`、`打开任务`、`提交工件`、`暂停接单`。
- executor 注册 + 20s 心跳（TTL 60s）+ claim/续约/心跳失败停手；token 存 `SecretStorage`。
- 上下文包：`.sap-superagent/task/<taskId>/context.md`（需求、验收标准、上游工件、绑定、禁止项）。
- 测试：核心逻辑用 mock `vscode` 单测；**不要求**在 CI 启动真实 VSCode。

### 1.8 `packages/testkit` 与 e2e

- 内存仓库 + fake AI + fake executor + fake SAP（H2 用）。
- `scripts/e2e.mjs`（或 `pnpm e2e`）：启动 server（临时状态目录、fake AI）→ 建 Demand → 等 AI stage done + Artifact → 管理端建 dev task → 模拟客户端 register/claim/complete → 断言事件序列/状态/工件。
- 必须覆盖 009 失败场景 **#1（双 claim 409）、#2（断网回池）、#3（服务端重启补事件）、#10（游标过期 resync）**。

### 1.9 文档

- 更新 `README.md` 快速开始为真实命令（`pnpm install && pnpm dev`）。
- 在 `docs/003` 补实现时发现遗漏的字段（只做必要补充）。
- 更新 `handoffs/STATUS.md`。

## 2. 验收

```sh
pnpm install
pnpm check          # 所有包 typecheck + lint + unit + contract
pnpm e2e            # 纵向闭环 + 失败场景 #1/#2/#3/#10
```

手工冒烟：

1. `pnpm --filter @sap-superagent/cli dev` 起服务；
2. `curl POST /demands` 建需求，30s 内 `GET /demands/{id}` 看到 `requirement_analysis` 工件；
3. `curl POST /admin/tasks` 建开发任务；
4. 用 CLI/testkit 模拟 executor claim → complete，事件时间线完整。

## 3. 不在本任务范围

审批/门禁超时、模板系统（除最小 loader）、工件 stale、golden set、SAP、Hook、MCP、多人 presence 调优、M2 Postgres、M3。
这些属于 H1/H2 或后续任务；不要在本任务里"顺手"实现。

## 4. 上报格式

完成后更新 STATUS.md 并报告：完成项、`pnpm check`/`pnpm e2e` 结果、关键文件、与设计的偏差、遗留问题。
