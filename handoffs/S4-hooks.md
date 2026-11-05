# S4 — Hook 契约与 `http` 示例目标

> 依赖：H0/H1/H2/S3 已完成并合入 `main`（起草基线 `f0f7802`；认领前用最新 `main`，要求 `pnpm check` 402 tests / `pnpm e2e` 15/15 绿）。
> 目标：让 PDO 的中间步骤有**正式扩展入口**——Hook 作为对外部系统的唯一扩展点：统一信封、配置驱动的事件订阅、出站队列（重试/退避/死信/重放）、入站回执（幂等）、管理/对账命令，以及 `http` 示例目标 + 四个占位适配器文档。
> 规格来源：[docs/008](../docs/008-hooks.md)（权威契约）、[docs/003 §4.4/§4.5](../docs/003-domain-and-protocol.md)、[docs/009 #11/#12](../docs/009-testing.md)、[docs/007 S4](../docs/007-roadmap.md)。
> 执行交接（可复用接口、启动 Prompt、环境坑）：[S4-execution-handoff.md](S4-execution-handoff.md)。

## 0. 起点（已具备，不要重写）

- **事件日志**：`packages/server/src/db/events.ts`、`writeTransaction` + `publish(ctx)`、WS 广播；事件类型枚举在 `packages/protocol/src/enums.ts`（`EVENT_TYPES`）。
- **outbox 表**：v1 建、v4 加 `last_error/sent_at`（迁移只追加）；SAP writeback 的消费模式在 `packages/server/src/workers/sap-writeback.ts`（2s 起指数退避≤5min、最多 5 次、4xx 死信、409 重拉重放）——**可参考，不照搬 SAP 特例**。
- **入站 HMAC 验签参考**：`packages/sap-adapter/src/signature.ts`（`X-SA-Signature: sha256=<hex>` / `X-SA-Timestamp` ±5min / `X-SA-Delivery` 幂等，常量时间比较）。
- **装配点**：`packages/server/src/http/app.ts`（路由注册）、`server.ts`（worker 启停）、`types.ts`（`ServerOptions`/`ServerContext`）、`config.ts`（env 解析）。
- **测试范式**：`packages/server/test/helpers.ts`（临时 state dir + 随机端口 + fake AI）、`packages/testkit/e2e/*`（进程内、`<5s`）、`packages/testkit/src/http.ts`（`apiRequest`/`waitFor`）、`packages/testkit/src/fake-icf-server.ts`（HTTP fake 参考）。
- **既有 SAP 路径**：`POST /hooks/sap`（HMAC + `sap_deliveries` 幂等）**保持现状**；通用 Hook 是其并行机制，不重构 SAP 语义。

## 1. 交付物

### 1.1 契约先行（第一步）

- `docs/003`：
  - §4.4 事件表补持久事件类型：`hook.attempted`、`hook.delivered`、`hook.dead`、`hook.receipt`、`hook.cancelled`（新增 subject type `hook`）；
  - 补协议：`GET /hooks`、`POST /hooks/{id}/replay`、`POST /hooks/{target}/receipt`（含认证/幂等要求）；
  - 明确通用 Hook 入站沿用 `X-SA-*` 头（与 SAP 一致），避免第二套签名规范。
- `docs/008` 定稿：统一信封（§2 已定义）、配置 schema（§6 扩展为可执行格式）、出站目标字段映射原则、回执语义、对账口径、`http` 示例目标契约。
- `packages/protocol`：`hookEnvelopeSchema`、`hookConfigSchema`、`hookReceiptBodySchema`、`hook-status`/`replay` 请求响应 schema、事件/主题类型；`pnpm contract:gen` 提交 `contracts/` diff（json-schema + openapi）。
- `examples/hooks.yaml`：默认全 `enabled: false`；包含 `http` 示例 + jira/charm/confluence/teams 四个占位（字段映射按 docs/008 §3）。

### 1.2 配置与触发

- 配置加载：`SA_HOOKS_CONFIG` 指向 YAML（默认 `examples/hooks.yaml`）；文件缺失 = 全部禁用，**不影响 H0–S3 行为**；启动时校验，错误信息必须写"现在该改什么"。
- 触发：配置 `events: [<persisted event type>]` 声明订阅；事件提交后为每个启用的 Hook 生成一条 outbox 行（target = `hook:<id>`），信封含 `eventId/eventType/eventVersion/occurredAt/subject/payload/idempotencyKey/retry/traceId`；`idempotencyKey` 稳定，重放不变（docs/008 §2）。
- secretRef：`env:NAME` 形式；secret 只在服务端读取，不落库明文、不进日志。

### 1.3 出站队列与投递（`http` 目标）

- 通用 delivery worker（可复用 SAP writeback 的退避/死信骨架但新建独立模块）：轮询 PENDING → HTTP POST（`content-type: application/json` + HMAC 头）→ 2xx 成功；5xx/429/超时重试；4xx 死信；指数退避 2s 起、上限 5min、最多 5 次；429 尊重 `Retry-After`。
- 每次尝试/成功/死信写持久事件 `hook.attempted` / `hook.delivered` / `hook.dead`（含 hookId、target、attempt、error、externalId 可空）；死信可经 `GET /hooks` 查看。
- 取消语义：需求取消/阶段退回时，未发送的 Hook 标 `cancelled` + 写 `hook.cancelled`；已发送的 v1 只记录（不补发关闭动作）。
- 出站 payload 发送前用契约 JSON Schema 校验；校验失败进死信（不静默丢弃）。

### 1.4 管理 API 与重放

- `GET /hooks`（admin）：每个 Hook 的 `enabled`、`events`、queue depth（`pending/sent/dead`）、`lastError`、最近一次尝试摘要。
- `POST /hooks/{id}/replay`（admin + `Idempotency-Key`）：按 `eventId` 重放死信/已发事件；保持 `idempotencyKey` 不变；重复 replay 幂等（不产生重复外部单、不重复写 hook.delivered）。
- 保持最小：不做 pause/resume、不做 UI。

### 1.5 入站回执

- `POST /hooks/{target}/receipt`：HMAC 验签（`X-SA-Signature`/`X-SA-Timestamp` ±5min/`X-SA-Delivery` 幂等，复用 `signature.ts` 规则；通用 Hook 不应 import `@sap-superagent/sap-adapter`，在 `packages/server/src/hooks/` 内实现或抽公共模块）。
- Body 按 docs/008 §4：`eventType=hook.receipt`、`idempotencyKey`、`payload.externalId/status/detailRef`。
- 落库：`hook_receipts` 表（迁移 **v6 起，只追加**，不改 v1–v5）；字段建议 `idempotency_key/target/external_id/status/delivery_id/body/received_at`；写事件 `hook.receipt`。
- 重复回执幂等（如 `duplicate: true`）；未知 `externalId` 记录但不推进、不失败。
- "回执推进阶段"：v1 默认**只记录 + links/事件**；若配置 `advanceOnReceipt: true`，先补 docs/003 语义，再复用 H1 `stage-engine` 的审批/推进函数（默认关闭）。

### 1.6 对账

- `scripts/hooks-reconcile.mjs` + 根命令 `pnpm hooks:reconcile`：只报告不自动修复；两类差异：
  - 外部有、控制平面无（配置了 `reconcileUrl` 时拉外部列表比对；否则输出"无法比对"说明）；
  - 控制平面有、外部无（delivered 超 SLA 无回执 / 死信 / 未知回执）。
- 输出人类可读摘要 + 可选 `--json`；有差异默认退出码 0，`--fail-on-diff` 时 3。

### 1.7 占位适配器（只文档 + 配置样例，不实现业务逻辑）

- `examples/hooks/`：`jira.yaml`、`charm.yaml`、`confluence.yaml`、`teams.yaml`（按 docs/008 §3 的 eventType/payload 关键字段/幂等键/失败与对账写样例，`enabled: false`），外加简短 README 说明"字段映射在适配器/配置层，不进核心阶段图"。
- 不新增依赖、不写具体系统客户端。

### 1.8 测试与文档

- `packages/testkit`：`FakeHookTarget`（进程内 HTTP 目标：记录请求/headers/idempotencyKey；故障注入 5xx/429/timeout/4xx/坏 JSON；可暴露 `reconcileUrl` 外部列表）。
- 集成测试：触发→投递成功；5xx 退避到上限；4xx 死信；429 Retry-After；未知 eventVersion 死信；replay 幂等；回执验签/时间窗/重复幂等/未知 id；`GET /hooks` 队列深度与 lastError。
- e2e（进程内，保持 `pnpm e2e` 总时长 `<5s`）：需求→阶段事件→HTTP 目标收到 Hook→注入 5xx/4xx→死信→replay→回执→对账；覆盖 docs/009 #11/#12 的 Hook 侧断言。
- 更新 `docs/008`（最终契约）、`docs/003`（事件/端点）、`docs/007`（S4 勾选）、`README`（Hook 快速开始 + `pnpm hooks:reconcile`）、`handoffs/STATUS.md`（S4 行 + 偏差）。
- 门禁：`pnpm check`（现有 402 tests 不回归 + 新增）、`pnpm e2e`（现有 15/15 + 新增，总时长 <5s）、`pnpm build`；`pnpm hooks:reconcile` 可跑。

## 2. 验收

```sh
pnpm check
pnpm e2e
pnpm build
pnpm hooks:reconcile
```

手工冒烟（无本地 HTTP 服务时可用 `FakeHookTarget`/e2e 复现并记录实际输出）：

1. 配好 `examples/hooks.yaml` 的 `http` 示例 → 触发一个阶段事件 → 目标收到 POST：信封字段、HMAC 头、`idempotencyKey`、JSON Schema 均正确。
2. 目标先返回 500 ×2 再 200：可见退避重试与 `hook.attempted` 事件；目标返回 400：`GET /hooks` 能看到死信与 `lastError`。
3. 重放死信：目标再次收到且 `idempotencyKey` 不变；重复 replay 不产生重复外部单/重复事件。
4. 发送回执：写入 `hook.receipt` 与 links/对账输出；重复回执幂等；未知 externalId 只记录。
5. `pnpm hooks:reconcile` 输出两类差异（或明确说明无法拉取外部列表）。

## 3. 边界与禁令

- **不实现** JIRA/CHARM/Confluence/Teams 的具体业务适配（只配置样例 + 字段映射文档）。
- **不改** H0–S3 已完成语义；SAP `/hooks/sap` 保持现状（可抽公共签名工具，行为不变）；不重构 `sap-writeback`。
- 不新增外部依赖（YAML 解析用仓库已有 `yaml`；HTTP 目标用 Node `fetch`）。
- 迁移只追加（**v6 起**，不改 v1–v5）；共享文件（`app.ts`/`types.ts`/`config.ts`/`server.ts`/`migrations.ts`）只做追加式改动 + `// --- S4: ... ---` 注释块。
- 契约先行：先 `docs/003` + `packages/protocol` + `pnpm contract:gen`，再实现。
- 不实现 MCP、不做客户端 UI、不引入聊天通知。
- 不提交密钥/地址/`.env`；不 push、不直推 `main`、不 force push。

## 4. 写范围

`packages/protocol/**`、`packages/server/**`、`packages/testkit/**`、`contracts/**`、`docs/003-domain-and-protocol.md`、`docs/008-hooks.md`、`docs/007-roadmap.md`、`examples/hooks.yaml`、`examples/hooks/**`、`scripts/hooks-reconcile.mjs`、`README.md`、`handoffs/STATUS.md`。

## 5. 上报格式

完成项、`pnpm check`/`pnpm e2e`/`pnpm build`/`pnpm hooks:reconcile` 输出摘要、投递/重试/死信/重放/回执证据、与 docs/008 的偏差、遗留/未决。

## 6. 启动 Prompt

见 [S4-execution-handoff.md](S4-execution-handoff.md) §6（可直接复制给新 session）。
