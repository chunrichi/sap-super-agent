# 008 Hook 契约

Hook 是对 JIRA / CHARM / Confluence / Teams 等外部系统的**唯一扩展入口**。v1 交付完整契约与一个 `http` 示例目标（S4），不实现具体业务适配；四个占位适配器只提供配置样例与字段映射文档（`examples/hooks/`）。

> 机器可读契约：`packages/protocol/src/hooks.ts` → `contracts/json-schema/hook-*.json`；协议端点与事件见 [003 §4.4/§4.7](003-domain-and-protocol.md)；测试矩阵见 [009 #11](009-testing.md)。

## 1. 原则

- **不进阶段图**：Hook 绑定"阶段完成 / 门禁通过 / 需求状态变化"等持久事件；只有需要人工确认的中间动作（如 CHARM 传输审批）才升格为 Gate 或人工 Task，再由 Hook 通知或回执。字段映射放配置/适配器层，不在核心阶段图加业务分支。
- **至少一次 + 幂等**：每个 Hook 有稳定的 `idempotencyKey`，重放时不变；外部系统不支持幂等时按本契约先查后建。
- **失败可见**：可重试（网络/5xx/429）与永久失败（4xx 校验失败）分开；永久失败进死信并要求人工处理，禁止静默丢弃。
- **可对账**：外部系统返回的 ID（`jiraKey`、`trNumber`、`pageId`）通过回执落库，作为每日对账依据。
- **契约独立于实现**：本文与 `contracts/json-schema/hook-*.json` 是权威定义；适配器只做字段映射。
- **默认关闭**：`examples/hooks.yaml` 全部 `enabled: false`；配置文件缺失 = 全部禁用，不改变 H0–S3 行为。

## 2. 统一信封

出站 POST body = 下面这个信封（`hookEnvelopeSchema`，`contracts/json-schema/hook-envelope.json`）：

```json
{
  "eventId": "01J8ZQ9W3K5M2V7X4C6B8N0P1Q",
  "eventType": "artifact.approved",
  "eventVersion": 1,
  "occurredAt": "2026-11-05T12:00:00.000Z",
  "subject": {
    "type": "artifact",
    "id": "01J8ZQ9W3K5M2V7X4C6B8N0P1R",
    "demandId": "4a3f9c2e7b1d48f0a6c5e2d9b8f7a1c3",
    "stageRunId": "01J8ZQ9W3K5M2V7X4C6B8N0P1S",
    "artifactId": "01J8ZQ9W3K5M2V7X4C6B8N0P1R",
    "version": 2
  },
  "payload": { "artifactId": "01J8...", "gateKey": "G1", "decidedBy": "CONSULTANT01" },
  "idempotencyKey": "4a3f9c2e7b1d48f0a6c5e2d9b8f7a1c3:jira:9f2c...",
  "retry": { "maxAttempts": 5, "backoff": "exponential", "deadLetter": true },
  "traceId": "01J8ZQ9W3K5M2V7X4C6B8N0P1Q"
}
```

| 字段 | 说明 |
| --- | --- |
| `eventId` | **源持久事件**的 id（`GET /events` 的 `id`）；重放不变 |
| `eventType` | 源持久事件类型（配置 `events` 订阅的枚举值，见 003 §4.4）；适配器自行映射到 JIRA/CHARM 等逻辑动作 |
| `eventVersion` | 信封版本，v1 恒为 `1`。目标可拒绝未知版本；控制平面发送前也校验，未知版本直接死信 |
| `occurredAt` | 源事件发生时间（ISO-8601 UTC） |
| `subject` | 只放 ID 与版本：`type`/`id` 为源事件 subject；`demandId`/`demandNo`/`stageRunId`/`artifactId`/`version` 在事件可推导时填 |
| `payload` | 源事件 `data` 快照（只做拷贝，不补业务字段）；正文以工件引用给出，避免敏感内容在多系统复制 |
| `idempotencyKey` | 控制平面生成，重放不变。格式 `<demandId 或 subject.id>:<hookId>:<sha256(eventId)>` |
| `retry` | 该 Hook 的 `retry` 配置快照（`maxAttempts` / `backoff` / `deadLetter`） |
| `traceId` | 关联 id；v1 用源事件 id |

- 发送前用 `hookEnvelopeSchema` 校验落地 payload；校验失败/未知 `eventVersion` 进死信（`hook.dead`，`error` 写清原因），不静默丢弃。
- HMAC 头：`X-SA-Signature: sha256=<hex(HMAC-SHA256(secret, rawBody))>`、`X-SA-Timestamp`（ISO-8601，±5min）、`X-SA-Delivery: <idempotencyKey>`。与 SAP 入站同一套规则（003 §4.1），**不引入第二套签名规范**。
- 2xx 视为成功；成功响应 JSON 里的 `externalId` / `id` / `key`（字符串）会被记录进 `hook.delivered`，可空。

## 3. 出站目标

v1 只实现通用 `http` 目标：配置里的 `url` 收到上面的信封。下表的逻辑动作名是**未来适配器的字段映射口径**，当前由 `examples/hooks/*.yaml` 注明"消费者自行映射"，不进核心阶段图。

| 目标 | 逻辑动作（未来适配器） | 建议订阅的持久事件 | payload 关键字段 | 幂等键 | 失败/对账 |
| --- | --- | --- | --- | --- | --- |
| JIRA issue | `hook.jira.issue.ensure` | `artifact.approved`（需求分析门禁通过） | `project`, `issueType`, `summary`, `descriptionRef`, `priority`, `demandNo` | `demandId:jira:<templateVersion>:<sha256(analysis)>` | 先查后建；5xx 退避；4xx 死信；每日按 `demandNo` 对账 |
| CHARM TR | `hook.charm.tr.ensure` | `artifact.approved`（开发说明确认 G2/G3） | `targetSystem`, `client`, `owner`, `descriptionRef`, `artifacts[]`, `demandNo` | `demandId:charm:<targetSystem>:<sha256(code_change)>` | **非幂等**：先按业务键查询再建；仍未定则转人工 Task；TR 号回执；每日对账 |
| Confluence | `hook.confluence.page.upsert` | `stage.done`（归档阶段完成 / 发布确认） | `space`, `parentId`, `title`, `bodyRef`, `labels[]`, `demandNo` | `demandId:confluence:<pageKey>:<version>` | upsert 可安全重试；发布前需 G5；按 pageId 对账 |
| Teams 通知 | `hook.teams.notify` | `stage.waiting_human` / `approval.requested` | `channel`, `template`, `demandNo`, `deepLink`, `mention` | `eventId` | 通知可丢（TTL 后放弃）但留审计；429 按 `Retry-After`；默认由 SAP 内通知替代 |
| SAP 回写 | `hook.sap.writeback` | 既有 H2 worker（不在 S4 范围） | — | — | 见 [004 §3](004-sap.md)、`pnpm sap:reconcile` |

## 4. 入站回执

外部系统完成后回调：`POST /hooks/{target}/receipt`（`{target}` = 配置的 hook `id`）。认证沿用 `X-SA-*` 头（HMAC ±5min + `X-SA-Delivery` 幂等），不使用 Bearer token：

```json
{
  "eventType": "hook.receipt",
  "idempotencyKey": "JIRA-1234:created",
  "occurredAt": "2026-11-05T12:03:00.000Z",
  "payload": {
    "externalId": "JIRA-1234",
    "status": "created",
    "detailRef": "https://jira.example.com/browse/JIRA-1234"
  }
}
```

| 字段 | 说明 |
| --- | --- |
| `eventType` | 恒为 `hook.receipt` |
| `idempotencyKey` | 外部系统 ID + 状态；重复回执幂等（`duplicate: true`，不重复写事件） |
| `payload.externalId` | `jiraKey` / `trNumber` / `pageId` / 通用外部 ID |
| `payload.status` | `created` / `updated` / `failed` / `cancelled` |
| `payload.detailRef` | 可选，外部系统详情链接 |

落库与事件：

- `hook_receipts` 表（迁移 **v6**，只追加；`idempotency_key` 唯一，`delivery_id` 记 `X-SA-Delivery` 用于审计与重投递去重）记录 `hook_id / idempotency_key / delivery_id / external_id / status / body / received_at`。
- 写持久事件 `hook.receipt`（`subject.type=hook`、`subject.id=<hookId>`），data 含 `receiptId/hookId/idempotencyKey/externalId/status/deliveryId/linked`。
- 重复回执返回 `duplicate: true`，不写第二条事件；未知 `externalId` 只记录（`linked:false`），不失败、不推进。
- **v1 边界**：回执只记录 + 事件。按 `externalId` 回写工件 `links` 与"回执推进阶段"留到后续版本：配置 `advanceOnReceipt: true` 在 v1 启动时报错（要求改为 `false`），语义确定后再复用 H1 阶段推进函数。回执丢失由对账修复，**不重放创建动作**。
- 未知 `{target}` 返回 `404`；签名错误/时间窗过期返回 `401`。

## 5. 失败语义与重试

| 类别 | 判定 | 处理 |
| --- | --- | --- |
| 可重试 | 网络错误、5xx、429、超时 | 指数退避：**2s 起、每次 ×2、上限 5min、最多 5 次**（`retry.maxAttempts` 可配）；429 优先按 `Retry-After`（秒或 HTTP date）等待 |
| 永久失败 | 4xx（字段/权限/校验错误） | 立即进入死信，`lastError` 可见；阶段不因此失败，由人决定跳过或修正 |
| 信封非法 | schema 校验失败 / 未知 `eventVersion` | 直接死信，`hook.dead` 记原因 |
| 非幂等动作 | CHARM 建 TR 等 | 由外部适配器先查后建；无法确认时转人工，不自动重试 |
| 阶段取消 | 需求取消 / 阶段退回（`demand.cancelled`、`stage.cancelled`、`artifact.rejected`） | 同需求**未发送**的 Hook 标 `cancelled` + 写 `hook.cancelled`（v1 粗粒度：按需求，不细分阶段）；**已发送**的只记录、不补发关闭动作 |
| 对账失败 | 外部 ID 找不到 | 记录到对账报告，人工修复；不重放创建 |

每次尝试写持久事件 `hook.attempted`（失败，含 `hookId/target/eventId/attempt/error`）；成功写 `hook.delivered`（含 `attempt/externalId`）；进入死信写 `hook.dead`（含 `attempt/error`）。死信可在 `GET /hooks` 查看并通过 replay 重投。

## 6. 配置与实现

`SA_HOOKS_CONFIG` 指向 YAML；未设置时用仓库根 `examples/hooks.yaml`。文件缺失 = 全禁用；显式配置的路径不存在、YAML/schema 非法、enabled hook 的 secret 缺失都会**启动失败**并给出"现在该改什么"的错误信息（不静默降级）。

可执行格式（`examples/hooks.yaml`；schema `contracts/json-schema/hooks-config.json`）：

```yaml
hooks:
  - id: http-example            # lower-kebab-case，唯一；target/URL 都用它
    target: http                # v1 唯一目标
    url: http://127.0.0.1:9099/hooks/example
    events: [artifact.approved] # 订阅的持久事件类型（003 §4.4）；禁止 hook.*
    secretRef: env:SA_HOOKS_HTTP_SECRET  # 只从环境变量读 secret
    enabled: false              # 默认全禁用
    retry: { maxAttempts: 5, backoff: exponential, deadLetter: true }
    # reconcileUrl: http://127.0.0.1:9099/external/items  # 可选，对账拉外部列表
    # advanceOnReceipt: false   # 预留；v1 必须为 false
```

| 环境变量 | 默认 | 说明 |
| --- | --- | --- |
| `SA_HOOKS_CONFIG` | `examples/hooks.yaml` | 配置文件路径 |
| `SA_HOOKS_POLL_MS` | `500` | 出站 worker 轮询间隔 |
| `SA_HOOKS_RETRY_BASE_MS` | `2000` | 首次退避 |
| `SA_HOOKS_RETRY_MAX_MS` | `300000` | 退避上限（5min） |
| `SA_HOOKS_TIMEOUT_MS` | `10000` | 单次 HTTP 超时 |

- 首次启动且尚无入队游标时，队列会从事件日志起点补发匹配该 Hook `events` 的历史事件（至少一次、不静默丢事件）；生产首次启用 Hook 前应确认历史事件是否需要对外投递，不需要时先在该状态目录上启用一次再清理 outbox/游标。
- 出站队列复用 v1/v4 的 `outbox` 表：`target = 'hook:<id>'`、`id = '<eventId>:<hookId>'`（重扫幂等），payload 存信封 JSON；`status ∈ PENDING/SENT/DEAD/CANCELLED`，`attempts/next_attempt_at/last_error/sent_at/recent` 由 S4 worker 维护。S4 worker 与 SAP writeback 各扫各的 target，互不影响。
- 管理端点：`GET /hooks`（admin，outbox 深度 + `lastError` + 最近一次尝试摘要）、`POST /hooks/{id}/replay`（admin + `Idempotency-Key`，按 `eventId` 重放死信/已发事件，保持 `idempotencyKey` 不变）。同一 `Idempotency-Key` 的重复 replay 返回缓存响应：不重复投递、不重复写 `hook.delivered`；用新 key 显式重放已发事件会再 POST 同一 `idempotencyKey`，目标按幂等键去重、不会重复建单，每次成功投递各记一条 `hook.delivered`。见 003 §4.7。
- 不做 pause/resume、不做 UI、不默认发聊天通知。
- 具体适配器（JIRA/CHARM/Confluence/Teams）按本契约实现，放 `packages/sap-adapter` 之外的独立包或企业私有仓库；本仓库只提供 `examples/hooks/*.yaml` 占位样例。

## 7. 对账

`pnpm hooks:reconcile`（只读；`--state-dir` / `--config` / `--sla-hours` / `--json` / `--fail-on-diff`；**不需要启用 hook 的 secret**——它只读库与外部列表，不签名/验签；有差异默认退出 0，`--fail-on-diff` 时 3，用法错误 2）：

- 读取 `SA_STATE_DIR`（默认 `.sap-superagent/state`）的 SQLite 与同一份 Hook 配置；
- **外部有、控制平面无**：配置了 `reconcileUrl` 时拉外部列表（JSON 数组或 `{items:[]}`，元素含 `externalId`/`id`/`key`），与本地已投递的外部 ID 比对；没有 `reconcileUrl` 时输出"无法比对（未配置 reconcileUrl）"说明；
- **控制平面有、外部无**：`delivered` 超 SLA 无回执（默认 24h，`--sla-hours` 可调）、`dead` 死信、未知回执（回执 `externalId` 不在已投递集合）。
- 差异进入每日报告/运维面板，人工修复；脚本不自动修复、不重放创建动作。

## 8. 占位适配器（只文档 + 配置样例）

`examples/hooks/` 下 `jira.yaml`、`charm.yaml`、`confluence.yaml`、`teams.yaml`：按 §3 写出订阅事件、payload 关键字段、幂等键、失败/对账口径，全部 `enabled: false`。**字段映射在适配器/配置层，不进核心阶段图**；本仓库不写具体系统客户端、不新增依赖。`examples/hooks/README.md` 说明如何复制一份并启用。

## 9. 验收（S4）

1. 任一持久阶段事件可配置触发一个 HTTP 目标；payload 通过 `hookEnvelopeSchema` 校验，HMAC 头与 `idempotencyKey` 正确。
2. 5xx 触发退避重试（`hook.attempted` 可见），4xx 进死信且 `GET /hooks` 可见 `lastError`。
3. 死信 replay 后目标再次收到且 `idempotencyKey` 不变；同一 `Idempotency-Key` 重复 replay 幂等。
4. 回执落 `hook.receipts` + `hook.receipt` 事件；重复回执幂等；未知 `externalId` 只记录。
5. `pnpm hooks:reconcile` 输出两类差异（或明确说明无法拉取外部列表）。

```sh
pnpm check
pnpm e2e          # 进程内 FakeHookTarget，总时长 <5s
pnpm build
pnpm hooks:reconcile
```

对应失败场景 [009 #11](009-testing.md)（Hook 5xx / 4xx / 重复回执）由 `packages/server/test/hooks.test.ts` 与 `packages/testkit/e2e/hooks.e2e.test.ts` 覆盖。
