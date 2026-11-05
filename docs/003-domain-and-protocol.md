# 003 领域模型与协议

本文定义六个业务概念（需求、阶段、任务、指派、工件、门禁）和三个支撑对象（执行器、Hook、事件），以及控制平面对外契约。实现以本文为准；`packages/protocol` 是机器可读版本。

## 1. 实体关系

```mermaid
erDiagram
  DEMAND ||--o{ STAGE_RUN : has
  DEMAND ||--o{ ARTIFACT : owns
  DEMAND ||--o{ APPROVAL : requires
  DEMAND ||--o{ TASK : produces
  STAGE_RUN ||--o{ TASK : materializes
  TASK ||--o{ ASSIGNMENT : binds
  EXECUTOR ||--o{ ASSIGNMENT : holds
  STAGE_RUN }o--o{ ARTIFACT : consumes_produces
  TASK }o--o{ ARTIFACT : produces
  DEMAND ||--o{ HOOK : triggers
  DEMAND ||--o{ EVENT : audit
```

## 2. 状态机

### 2.1 需求 Demand

```mermaid
stateDiagram-v2
  [*] --> submitted : SAP webhook / 本地创建
  submitted --> in_progress : 第一个阶段就绪
  in_progress --> review : 所有必做阶段完成
  review --> done : 最终验收通过
  review --> in_progress : 退回修改
  submitted --> rejected : 驳回
  in_progress --> cancelled : 撤回/取消
  review --> cancelled
  done --> [*]
```

- `done`、`rejected`、`cancelled` 为终态；退回修改在**同一 StageRun** 上开新 attempt，不新建 StageRun，历史 attempt 与工件版本保留。
- 需求本身不保存执行进度，进度由 StageRun 计算得出（单一事实来源）。

### 2.2 阶段运行 StageRun

```mermaid
stateDiagram-v2
  [*] --> pending
  pending --> ready : 输入工件齐备
  ready --> running : 派发给执行器
  running --> done : 产出工件且 gate=none
  running --> waiting_human : 到达门禁
  running --> failed : 失败（可重试）
  failed --> ready : attempt < maxAttempts
  failed --> waiting_human : 超过重试上限，转人工
  waiting_human --> done : 审批通过
  waiting_human --> running : 审批退回（新 attempt）
  waiting_human --> failed : 审批超时或人工标记失败
  waiting_human --> cancelled : 取消
  pending --> skipped : 模板不启用
  pending --> cancelled
  running --> cancelled
```

规则：

- 一个 Demand 的一个 Stage 只有一个 StageRun；重试/退回都在同一 StageRun 上增加 `attempt`，旧 attempt 的事件与工件保留。
- 阶段完成必须产出声明的输出工件，且通过 **schema 校验 + 模板 checklist**（引用完整性、必填项覆盖、上游版本一致）；只过 schema 不算完成。checklist 断言见 §2.7，失败时按 `maxAttempts` 重试，超过上限转 `waiting_human`，且**不落半成品工件**。
- 每次 `server-ai` 执行都记一条 run ledger（模型、prompt 版本、输入工件版本、token、成本、耗时、失败原因），落在 `stage_attempts`，供成本统计与复现（实现补充）。
- 上游工件产生新版本时，下游已生成工件标记 `stale` 并阻断继续推进（门禁拒绝历史版本的批准），直到重新生成或人工确认。
- 门禁由模板声明（`gate: none | {gateKey, role}`）。没有门禁的阶段按 `autonomy` 决定是否自动推进（§2.7）：`auto` 直接进入下一阶段，`observe` 产出 draft 工件并停在 `waiting_human`。
- 进入门禁时：输出工件状态置 `in_review`，创建一条绑定 `(artifactId, version)` 的 Approval，StageRun 置 `waiting_human`，写 `approval.requested` 事件与通知。审批通过后工件置 `approved`、阶段 `done` 并推进；驳回后工件置 `rejected`、阶段开新 attempt（重新生成新版本，不覆盖）；超时/撤回后阶段同样开新 attempt（超过 `maxAttempts` 则保留 `failed` 并通知人工）。
- `vscode` 阶段就绪时由服务端按模板自动创建 Task（`requiredRoles` 来自模板）；AI 阶段由服务端 stage runner 消费 `ready` 的 StageRun。

### 2.3 任务 Task 与指派 Assignment

Task 字段：

| 字段 | 说明 |
| --- | --- |
| `id` | ULID（控制平面生成） |
| `demandId` | 需求 ID；SAP 来源时为 UUID C32，控制平面不二次生成 |
| `stageRunId` | 产生该任务的阶段运行 |
| `title` | 一句话任务名 |
| `executorKind` | `vscode`（人机）或 `server-ai`（批处理） |
| `requiredRoles` | 角色列表（空表示不限） |
| `workspaceBinding` | 可空：`{repo, projectKey, baseBranch}`；有值时按工作区派发，为空时进入通用任务箱（按角色/团队）。**不含本地路径** |
| `priority` | `high / normal / low` |
| `dueAt` | 期望完成时间（可空） |
| `state` | 见下方状态机 |
| `lastHolderUserIds` | 最近释放/过期该任务的用户（最多 3 个），用于回池降权 |
| `createdAt` / `updatedAt` | UTC 时间 |

Task 状态：`pending → claimed → in_progress → completed | failed | cancelled`；`released/expired` 退回 `pending`。`offered` 只是 WS 提示（不持久化），任务本身仍为 `pending`。

Assignment 状态：`active → completed | released | expired`。

- 任务不预绑定到人。`claim` 原子成功后才产生 Assignment 与租约。
- 租约：默认 60s，客户端每 20s 续约；过期自动 `expired`，任务回 `pending`，已提交工件保留。
- `complete`/`fail` 必须携带当前租约；租约失效后的写入被拒绝，防止两个客户端同时写。
- 任务并发：每执行器 `maxConcurrent`（默认 2），每用户同一需求最多 1 个活跃人工任务（避免自己挤自己）。
- 回池不重复派给刚释放的人：按 `lastHolderUserIds` 对最近 3 位降权（排序加权重），不硬排除。

### 2.4 工件 Artifact

状态：`draft → generated → in_review → approved | rejected`；新版本使旧版本 `superseded`。

- 工件不可变：任何修改产生新 `version`，`artifactId` 不变，`contentRef` 指向存储对象。旧版本的字节与元数据永久保留，版本链可由 `GET /demands/{id}` 的 `artifactChains`（按阶段分组）追溯。
- 工件必须声明 `kind`（`requirement_analysis`、`dev_spec`、`code_change`、`test_doc`、`knowledge_entry`、`free_note`）、`contentType`、`checksum`。
- 工件来源：`ai`（服务端生成）、`human`（SAP 或 Web 编辑）、`agent`（客户端回写）、`import`（外部系统）。
- 人工"确认/调整"通过 `POST /demands/{id}/artifacts` 产生同 `kind` 的新版本（`authorType: human`）：已存在该 kind 的工件时版本号 +1，否则新建工件（v1）。版本号只增不减，不覆盖历史。
- `stale` 标记落在 `artifact_versions`（每个版本独立）：上游同 kind 出现更新版本时，引用旧版本的下游工件当前版本置 `stale=true`，写 `artifact.stale` 事件；门禁批准被拒绝（`409`，`details.reason=artifact_stale`），重新生成或人工确认后清除。

### 2.5 门禁 Approval

状态：`pending → approved | rejected`；`pending → withdrawn`（发起人撤回）；`pending → expired`（`timeoutDays` 到期）。
`approved` 后阶段进入下一阶段；`rejected` 后阶段回 `running`（新 attempt）或按模板 `cancelled`。

- 门禁绑定 `(demandId, stageRunId, gateKey)`，并绑定**具体工件版本 `(artifactId, artifactVersion)`**：审批的对象是那一版内容，之后出现新版本时该 Approval 仍指向旧版本（旧版本被标 `stale` 时批准被拒绝）。
- 同一门禁重复审批幂等：终态（`approved/rejected/withdrawn/expired`）后再决策返回 `409 conflict`，响应携带当前状态。
- 审批人由模板声明的角色决定；角色枚举：`requester`（业务方）、`consultant`（需求顾问/PDO）、`developer`、`ops`。控制平面只做规则校验，身份来自 SAP 或控制平面账号。**M1 本地模式不建模细粒度权限**（HANDOFF §7）：用户/管理员 token 均可决策，`decidedBy` 记录实际操作人；`assignee=me` 返回本地待办。
- 到期：`expiresAt = createdAt + timeoutDays`，由 sweeper 周期检查（生产默认每小时；测试可注入时钟）。到期后 Approval 置 `expired`，阶段按失败重试规则开新 attempt，写 `approval.expired` 事件与通知；`withdrawn` 同理（不标记工件为 rejected）。
- 通知：门禁请求、决策结果、过期、阶段转人工均写 `notifications` 表（`kind`、`requiredRole`、标题、正文、已读时间），`GET /notifications?state=unread` 读取；Teams 等外部渠道留待 Hook（H2 之后），不新增渠道。
- 人工补救：`POST /admin/approvals/{id}/expire` 供 M1 运维强制过期卡住的门禁（等价于到期，写同样的事件与通知）。

### 2.6 执行器 Executor

| 字段 | 说明 |
| --- | --- |
| `kind` | `vscode`（人机客户端）、`server-ai`（服务端批处理）、未来 `ci` / `abap-transport` |
| `user` | 所属用户（vscode）/ 系统账号（server-ai） |
| `capabilities` | `coding`、`doc-review`、`test-run` 等；与任务要求匹配 |
| `roles` | 允许领取的角色（后端、ABAP、测试……） |
| `workspaces` | `{workspaceKey, repo, projectKey, baseBranch, localPathHint?}` 列表；`workspaceKey = sha256(规范化后的工作区 URI)`，只属于执行器（当前打开的目录），任务侧只带 repo/projectKey |
| `activeWorkspaceKey` | 当前**打开**的工作区 key（必须属于 `workspaces`）；由心跳更新；为 `null` 或不属于列表即视为不可派单。实现补充：该字段原在 §3 规则中出现但 §2.6 未定义 |
| `machineIdHash` | `sha256(vscode.env.machineId)`；只存哈希，用于"同目录重复打开"与审计 |
| `presence` | `online / busy / away / offline`，由 WS 连接、心跳与显式状态计算 |
| `accepting` | 布尔；`false` 表示用户暂停接单（仍在线）。`server-ai` 恒为 online 且 accepting=true（全局 paused 除外） |

### 2.7 阶段模板 StageTemplate

| 字段 | 说明 |
| --- | --- |
| `templateId` | 模板 ID，如 `default`、`pdo` |
| `version` | 整数；Demand 创建时固定 `templateVersion`，之后模板变更只影响新 Demand；进行中 Demand 仍用旧版本（旧版本文件应继续保留在 `templates/`） |
| `stages` | 有序阶段：`{key, name, executorKind, inputArtifactKinds[], outputArtifactKind, gate, autonomy, requiredRoles[], maxAttempts, checklist[]}` |
| `gates` | `{gateKey, role, timeoutDays}` |

- `executorKind ∈ {vscode, server-ai}`；`gate ∈ {none} | {gateKey, role}`，`none` 表示无人工门禁，是否自动推进由 `autonomy` 决定。
- `autonomy ∈ {auto, observe}`（默认 `auto`，可省略）：`auto` = 按门禁规则自动推进；`observe` = 只生成草稿并停在 `waiting_human`，不自动进入下一阶段。`observe` 阶段若模板未声明门禁，服务端生成一条**确认门禁**（`gateKey=confirm:<stageKey>`，`requiredRole=consultant`），审批通过后推进。新模板的 `server-ai` 阶段按 golden set 阈值默认 `observe`（`evals/thresholds.json`；见 [009](009-testing.md)）。
- `requiredRoles`：`vscode` 阶段自动创建 Task 时声明的领取角色（空表示不限）。
- `checklist` 是可判定的验收断言 key，闭集：`sections_present`（输出工件的必填章节/字段齐全）、`inputs_referenced`（声明的上游工件存在且阶段记录的就是最新版本）、`not_stale`（上游无更新版本、输出工件未被标 stale）、`acceptance_covered`（需求每条验收标准在输出中有对应条目，结构化输出时生效）；未知 key 在加载模板时拒绝。阶段完成条件 = schema + checklist。
- 同一模板内 stage key、gate key、output artifact kind 均唯一（保证一个 Demand 每种工件只有一条版本链）。
- 模板文件放仓库根 `templates/<templateId>.yaml`，schema 在 `packages/protocol`，启动时校验全部模板；`templateVersion` 写入 Demand；`GET /templates` 只读返回已加载模板与默认模板 ID。
- 内置两个模板：`default`（3 阶段：需求分析 / 开发实现 / 验收归档，门禁 G1/G3/G4）与 `pdo`（6 阶段，见 [005 §4](005-clients-and-ai.md)）。

## 3. 调度规则（确定性）

任务进入可领取池后，按以下规则判定资格；全部满足才可 `claim`：

1. `task.state == pending` 且未被租约占用。
2. `task.executorKind` 与 `executor.kind` 相符：`vscode` 任务只给 vscode 执行器；`server-ai` 任务只给服务端执行器。
3. 角色匹配：`task.requiredRoles ⊆ executor.roles`（空表示不限）。
4. 工作区匹配：`task.workspaceBinding` 为空表示通用任务（按角色/团队即可领取）；非空时要求 `repo/projectKey` 与执行器声明有交集，且 `activeWorkspaceKey` 属于其声明的 workspaces（即**当前打开目录**；目录一换即视为离线）。绑定可由需求顾问在受理时补充，或由用户账号维护的工作区列表决定。
5. 在线约束：vscode 任务要求 presence ∈ {online, busy} 且 `accepting=true`、`load < maxConcurrent`；server-ai 任务不看 presence。
6. 用户并发：同一用户未超过 `maxConcurrentPerUser`。

**离线判定**（任一条件成立即视为不可派单）：WS 断开且心跳超过 TTL；`activeWorkspaceKey` 不属于声明的 workspaces；`accepting=false`；服务端全局 `paused`。客户端不依赖操作系统的"网络在线"事件，也不用本地时钟判断租约过期（以 `serverTime` 为准）。

排序：priority 降序 → dueAt 升序 → createdAt 升序。客户端主动拉取（pull）+ 服务端 WS 提示，倾向"谁先到谁领"。

派发事件：

- 执行器注册 / 心跳 → 服务端重算可领取列表，在心跳响应里返回 `offers`；任务新建或回池时再向已连接客户端推送 `task.offered` 提示帧（H0 广播给所有连接，按执行器过滤在 S3 增强）。
- 任务新增 → 推送给所有满足 1–5 的在线执行器（只含摘要，不含工件内容）。
- 租约过期 → 写 `assignment.expired` 事件，任务回池并推送给其他候选。

## 4. 控制平面协议

### 4.1 通用约定

- Base：`/api/v1`；所有响应 JSON。时间一律 ISO-8601 UTC。控制平面生成的实体（stageRun/task/assignment/approval/event）用 ULID；来自外部系统的实体沿用外部主键并用 `externalId` 标注：`demandId` 用 SAP UUID C32，控制平面不再二次生成。
- 认证：`Authorization: Bearer <token>`。token 类型：`user`（审批/查看）、`executor`（任务操作）、`admin`（运维）。M1 本地模式用 CLI 签发的静态 token；M2/M3 首次登录用 OAuth 2.0 Device Authorization Grant（RFC 8628）换取短期 JWT + refresh token；客户端把 refresh token 存 VSCode `SecretStorage`，不落工作区文件。SAP 入站用 `X-SA-Signature: hmac-sha256(body, secret)` + `X-SA-Timestamp`（±5 分钟）+ `X-SA-Delivery`（幂等键）。
- 写操作支持 `Idempotency-Key`，服务端保留 24h 结果。
- 乐观并发：任务/工件更新可带 `If-Match: <version>`；不一致返回 `409 conflict`。
- 错误体：`{"error":{"code":"lease_expired","message":"...","retryable":true,"details":{}}}`；`429` 带 `Retry-After`。
- 版本化：`/api/v1` 只做加法；破坏性变更升 `v2`。执行器注册时上报 `protocolVersion`，服务端可拒绝过旧版本。

### 4.2 执行器接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/executors/register` | 注册并换取 executor token；声明 kind/user/machineIdHash/capabilities/roles/workspaces/protocolVersion/cliVersion |
| POST | `/executors/{id}/heartbeat` | 每 20s：`{status, load, workspaces?, activeWorkspaceKey?}` → `{serverTime, leaseTtlMs, renewIntervalMs, offers}`；服务端 TTL 60s |
| DELETE | `/executors/{id}` | 优雅下线；立即回收其活跃任务 |
| GET | `/tasks` | 查询可领取任务（已按资格过滤）；`?state=pending&limit=20` |
| GET | `/tasks/{id}` | 任务详情 + 门禁/工件摘要 |
| GET | `/tasks/{id}/context` | 返回 Markdown 上下文包 + JSON（需求摘要、上游工件、验收标准、工作区绑定、禁止项） |
| POST | `/tasks/{id}/claim` | 原子领取（`Idempotency-Key` + `If-Match`）；返回 task + lease + context 摘要；冲突 409 + 当前持有者摘要 |
| POST | `/tasks/{id}/lease/renew` | 续约；返回新过期时间；404/409 时客户端必须停止执行并重新拉状态 |
| POST | `/tasks/{id}/progress` | `{percent?, message, summary?}`；写事件，不阻塞 |
| POST | `/tasks/{id}/artifacts` | 提交工件 `{kind, contentType, contentUrl|contentBase64, checksum, summary}` |
| POST | `/tasks/{id}/question` | 提问 → 生成 `waiting_human` 通知；任务可继续或挂起（模板决定） |
| POST | `/tasks/{id}/complete` | 完成：`{summary, artifactIds, links, openQuestions?}` |
| POST | `/tasks/{id}/fail` | 失败：`{reason, retryable}` |
| POST | `/tasks/{id}/release` | 主动放弃租约，任务回池并通知派发人 |
| GET | `/events/stream?after=<seq>` | SSE 只读降级通道（WS 不可用时）；`Last-Event-ID` 语义同 `after` |

### 4.3 用户与需求接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/demands` | 本地模式创建需求；SAP 模式由 webhook 创建；可指定 `templateId`（默认 `default`），创建时固定 `templateId + version` |
| GET | `/demands/{id}` | 需求、阶段、工件、**按阶段分组的版本链**、门禁、事件时间线 |
| GET | `/demands?status=&assignee=&q=` | 列表与搜索 |
| POST | `/demands/{id}/cancel` | 撤回 |
| POST | `/demands/{id}/artifacts` | 人工"确认/调整"：按 `kind` 产生新版本（`authorType: human`），触发下游 stale 传播 |
| GET | `/templates` | 只读：已加载的阶段模板与默认模板 ID（`docs/003 §2.7` 的完整 schema） |
| GET | `/approvals?assignee=me` | 我的待审批；`state` 可过滤（默认 `pending`） |
| POST | `/approvals/{id}/decisions` | `{decision: "approve"\|"reject", comment}`；终态后返回 `409` |
| POST | `/approvals/{id}/withdraw` | 发起人撤回（`pending → withdrawn`，阶段开新 attempt） |
| GET | `/notifications?state=unread` | 门禁/阶段通知（`docs/003 §2.5`） |
| POST | `/notifications/{id}/read` | 标记已读 |
| GET | `/events?after=<seq>&limit=200` | 增量事件（WS 断线补拉） |
| GET | `/healthz` `/metrics` | 运维 |
| POST | `/admin/approvals/{id}/expire` | M1 运维：强制过期卡住的门禁（幂等，效果同超时） |

### 4.4 WebSocket 事件流

连接：`wss://<host>/api/v1/events?after=<lastSeq>`，token 同 REST。断线重连携带 `lastSeq` 补齐；事件日志保留 ≥7 天（M1 可配 24h），游标超出保留窗口时 REST 返回 `resync_required`，WS 收到控制帧 `{"type":"resync_required","lastSeq","earliestSeq"}`，客户端全量拉取。WS 不可用时降级到 `GET /events/stream`（SSE，只读）。

统一 envelope：

```json
{ "seq": 12043, "id": "01J...", "type": "task.updated", "at": "2026-11-04T12:00:00Z",
  "subject": { "type": "task", "id": "01J..." }, "data": { "state": "in_progress" } }
```

| 方向 | type | 触发 |
| --- | --- | --- |
| 服务端→客户端 | `task.offered` / `task.updated` / `task.cancelled` | 新可领取任务、租约状态变化、任务取消 |
| 服务端→客户端 | `approval.requested` / `approval.decided` / `approval.expired` / `approval.withdrawn` | 门禁请求、决策、超时、撤回 |
| 服务端→客户端 | `artifact.stale` / `demand.updated` | 上游新版本使下游工件 stale、需求状态变化 |
| 服务端→客户端 | `server.ping` | 保活与时钟校准 |
| 客户端→服务端 | `client.pong` / `client.ack {seq}` | 保活与游标确认 |

只推送**摘要**；工件内容与上下文包走 REST 按需拉取，避免大消息与重复传输。

`task.offered` 是**传输帧而非事件**（§2.3：不持久化）：`{type:"task.offered", at, subject:{type:"task",id}, task:{id,demandId,title,executorKind,requiredRoles,workspaceBinding,priority,dueAt}}`，不带 `seq`；任务新建或回池（租约过期、主动 release、执行器下线释放）时推送，客户端据此刷新可领取列表，权威状态仍以 REST/事件日志为准。H0 实现广播给所有已连接客户端（只含摘要）；按执行器资格过滤在 S3 增强。`task.updated`/`task.cancelled` 走统一事件 envelope。

### 4.5 SAP 入站 webhook

`POST /hooks/sap`（HMAC + 幂等键），`data.type`：

| type | 何时 | 控制平面动作 |
| --- | --- | --- |
| `demand.submitted` | 需求提交 | 建 Demand + 启动模板第一阶段 |
| `demand.updated` | 需求字段变化 | 更新快照；必要时重开阶段 |
| `artifact.approved` / `artifact.rejected` | 门禁结果 | 解决对应 Approval，推进/退回阶段 |
| `demand.cancelled` | 取消 | 取消需求与所有任务 |
| `hook.receipt` | 外部系统完成（JIRA/CHARM 回执） | 记录 Hook 回执，推进阶段 |

### 4.6 示例：一次领取与提交

```json
// POST /tasks/01J8.../claim  →
{ "task": { "id": "01J8...", "demandId": "4a3f9c2e7b1d48f0a6c5e2d9b8f7a1c3", "title": "实现需求 R-2041 的取数逻辑",
    "requiredRoles": ["abap"], "workspaceBinding": { "repo": "z-sales", "baseBranch": "main" } },
  "lease": { "expiresAt": "2026-11-04T12:01:00Z", "renewIntervalMs": 20000 },
  "contextUrl": "/api/v1/tasks/01J8.../context" }

// POST /tasks/01J8.../artifacts →
{ "artifact": { "id": "01J9...", "kind": "code_change", "version": 1,
    "contentRef": "artifact://01J9.../v1", "checksum": "sha256:..." }, "taskState": "in_progress" }
```

## 5. 工件与上下文

- **存储可插拔**：本地文件（M1）、S3/对象存储（M2）、SAP 附件/内容仓库（M3）。控制平面只存元数据、checksum 与引用。M1 实现补充：本地模式把内容写到 `SA_STATE_DIR/artifacts/<artifactId>/v<n>.bin`，接口只接受 `contentBase64`（`contentUrl` 预留给 M2 对象存储）；checksum 必须等于解码后字节的 sha256。
- **上下文包**是工件的只读快照，不是新概念：由需求摘要、输入工件、验收标准、工作区绑定和禁止项组成，扩展负责写入 `.sap-superagent/task/<taskId>/context.md`（同目录附 `context.json` 快照），供 Copilot Chat 用 `#file` 引用。
- **审计**：工件每次创建/审批写事件；事件只追加，不更新。

## 6. 扩展点

| 扩展点 | 接口 | v1 实现 | 未来 |
| --- | --- | --- | --- |
| 需求来源 | `SourceAdapter`：`ingest(event)` / `writeBack(demand)` / `reconcile()` | 本地 REST、SAP ICF JSON + webhook | JIRA、ServiceNow |
| 执行器 | 4.2 协议 | `vscode`、`server-ai` | CI、ABAP 传输、DSH session |
| AI 阶段 | `AiStage`：`buildPrompt(ctx)` / `outputSchema` / `model` / `maxCostUsd` | 需求分析、开发说明、测试文档、归档摘要 | 更多模板 |
| Hook 目标 | `HookTarget`：`event` / `payload(demand, artifact)` / `send()` / `idempotencyKey` | 契约见 [008-hooks.md](008-hooks.md)，v1 提供 `http` 示例 | JIRA、CHARM、Confluence、Teams |
| 存储 | `Repository` / `ArtifactStore` / `EventStore` | SQLite + FS；Postgres 可选 | SAP HANA |
| 身份 | `TokenValidator` | 本地签发 token | OIDC / SAP SSO |
