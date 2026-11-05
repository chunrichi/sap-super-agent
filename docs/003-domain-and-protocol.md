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
- 用户并发上限：每用户 `maxConcurrentPerUser`（默认 2，`ServerOptions.maxConcurrentPerUser` 可配）只约束人工（`vscode`）任务；与"同需求 1 个活跃人工任务"并存。`server-ai` 执行器（系统账号）不受该上限约束，仍按每执行器 `maxConcurrent`。
- 回池不重复派给刚释放的人：按 `lastHolderUserIds` 对最近 3 位降权（排序加权重），不硬排除。
- 任务转交：持有租约的执行器可 `POST /tasks/{id}/transfer` 把任务交还池子。必须区分"转交"与"定向指派"：
  - 转交 = 结束当前 assignment（`released` + `assignment.released` 事件）+ 任务回 `pending`（`task.transferred` 事件 + `lastHolderUserIds` 降权）。**任务仍按 §3 规则在池中可领取，不锁定给任何人**；`targetUserId` 只是事件审计与即时可见性提示（目标用户"可领取"而非"独占"），不改变"任务不预绑定到人"的不变式。
  - `targetRole` 是**显式收窄角色池**的语义：把 `task.requiredRoles` 设为 `[targetRole]`（事件 `task.transferred` 记录 `previousRequiredRoles` 与 `requiredRoles`）。原 `requiredRoles` 非空时，目标角色必须已在其中（否则 `409 conflict`）；原 `requiredRoles` 为空（原本不限角色）时允许收窄——这是 transfer 的显式语义，任务可见性随之变化，客户端/审计以事件中记录的原值为准。
  - 转交后原租约立即失效；非持有者、终态任务、目标用户不满足角色/并发约束均返回 `409`。

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
- **v1 实现说明（单角色门禁）**：协议 `gate` 只声明一个 `role`。任务书把 G3 描述为"consultant + developer 评审"，v1 以 `consultant` 作为 G3 的主审批角色，开发者的实现证据由 vscode 阶段完成判定（schema + checklist）与工件版本链体现；多角色会签留给后续版本，不为此扩展协议。
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
- `autonomy ∈ {auto, observe}`（默认 `auto`，可省略）：`auto` = 按门禁规则自动推进；`observe` = 只生成草稿并停在 `waiting_human`，不自动进入下一阶段（工件状态记 `in_review`，等待确认）。`observe` 阶段若模板未声明门禁，服务端生成一条**确认门禁**（`gateKey=confirm:<stageKey>`，`requiredRole=consultant`），审批通过后推进。新模板的 `server-ai` 阶段按 golden set 阈值默认 `observe`（`evals/thresholds.json`，人工修改率 ≥15% 即保持 observe；见 [009](009-testing.md)）。
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
6. 用户并发：同一用户未超过 `maxConcurrentPerUser`（默认 2；服务端 `ServerOptions.maxConcurrentPerUser` 可配）。只约束人工（`vscode`）任务；`server-ai` 按每执行器 `maxConcurrent` 计。

**离线判定**（任一条件成立即视为不可派单）：WS 断开且心跳超过 TTL；`activeWorkspaceKey` 不属于声明的 workspaces；`accepting=false`；服务端全局 `paused`。客户端不依赖操作系统的"网络在线"事件，也不用本地时钟判断租约过期（以 `serverTime` 为准）。

排序：priority 降序 → dueAt 升序 → createdAt 升序。客户端主动拉取（pull）+ 服务端 WS 提示，倾向"谁先到谁领"。

派发事件：

- 执行器注册 / 心跳 → 服务端重算可领取列表，在心跳响应里返回 `offers`；任务新建或回池时再向已连接客户端推送 `task.offered` 提示帧（传输帧、不持久化）。
- 任务新增 → 只推送给满足规则 1–5 的**在线**执行器连接（只含摘要，不含工件内容）。WS 连接在握手时校验 token 并绑定身份：`executor` token 绑定其 `executorId`（连接存续期），`user`/`admin` 连接只收事件流、不收 `task.offered`。资格判定与 claim / 心跳 `offers` **复用同一实现**，不复制逻辑（H0 的"广播给所有连接"行为已由 S3 替换）。
- 租约过期 / 主动 release / 转交 → 写 `assignment.expired|released` 与 `task.*` 事件，任务回池并按上面的规则推送给其他合格候选。

## 4. 控制平面协议

### 4.1 通用约定

- Base：`/api/v1`；所有响应 JSON。时间一律 ISO-8601 UTC。控制平面生成的实体（stageRun/task/assignment/approval/event）用 ULID；来自外部系统的实体沿用外部主键并用 `externalId` 标注：`demandId` 用 SAP UUID C32，控制平面不再二次生成。
- 认证：`Authorization: Bearer <token>`。token 类型：`user`（审批/查看）、`executor`（任务操作）、`admin`（运维）。M1 本地模式用 CLI 签发的静态 token；M2/M3 首次登录用 OAuth 2.0 Device Authorization Grant（RFC 8628）换取短期 JWT + refresh token；客户端把 refresh token 存 VSCode `SecretStorage`，不落工作区文件。SAP 入站（§4.5）与通用 Hook 入站（§4.7）共用同一套 webhook 规则：`X-SA-Signature: hmac-sha256(body, secret)` + `X-SA-Timestamp`（±5 分钟）+ `X-SA-Delivery`（幂等键）；两者都不使用 Bearer token，secret 按 `env:NAME` 引用、只在服务端读取。
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
| POST | `/tasks/{id}/transfer` | 持有租约者转交：`{targetUserId? \| targetRole?, comment?}`（二者至少其一）；结束当前 assignment（`released`）+ 回池 + `task.transferred` 事件；`targetRole` 显式收窄 `requiredRoles`（见 §2.3）；非持有者/终态/目标不满足角色或并发约束返回 `409`；支持 `Idempotency-Key` |
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
| 服务端→客户端 | `task.offered` / `task.updated` / `task.cancelled` / `task.transferred` | 新可领取任务、租约状态变化、任务取消、任务转交 |
| 服务端→客户端 | `approval.requested` / `approval.decided` / `approval.expired` / `approval.withdrawn` | 门禁请求、决策、超时、撤回 |
| 服务端→客户端 | `artifact.stale` / `demand.updated` | 上游新版本使下游工件 stale、需求状态变化 |
| 服务端→客户端 | `hook.attempted` / `hook.delivered` / `hook.dead` / `hook.cancelled` | 通用 Hook 的一次投递尝试失败、投递成功、进入死信、取消（持久事件，`subject.type=hook`，`subject.id=<hookId>`；`GET /hooks` 读 outbox 与这些事件） |
| 服务端→客户端 | `hook.receipt` | 外部系统入站回执落库（持久事件，`subject.type=hook`；见 §4.7） |
| 服务端→客户端 | `stage.ai_job.queued` / `stage.ai_job.claimed` / `stage.ai_job.completed` / `stage.ai_job.failed` | S5/M3：SAP 批处理 AI job 入队/领取/完成/失败（持久事件，`subject.type=stage_run`；见 §4.8） |
| 服务端→客户端 | `server.ping` | 保活与时钟校准 |
| 客户端→服务端 | `client.pong` / `client.ack {seq}` | 保活与游标确认 |

只推送**摘要**；工件内容与上下文包走 REST 按需拉取，避免大消息与重复传输。

`task.offered` 是**传输帧而非事件**（§2.3：不持久化）：`{type:"task.offered", at, subject:{type:"task",id}, task:{id,demandId,title,executorKind,requiredRoles,workspaceBinding,priority,dueAt}}`，不带 `seq`；任务新建或回池（租约过期、主动 release、转交、执行器下线释放）时推送，客户端据此刷新可领取列表，权威状态仍以 REST/事件日志为准。**S3 起按执行器资格过滤**：连接在握手时绑定 `executorId`（`executor` token），推送前用与 claim 相同的 §3 规则 1–6 实时判定，只发给当前有资格领取的在线执行器；`user`/`admin` 连接只收事件流、不收该帧。客户端断线重连携带 `lastSeq`；游标超出保留窗口时用 `resync_required` 控制帧要求全量拉取。`task.updated`/`task.cancelled`/`task.transferred` 走统一事件 envelope（不按执行器过滤）。

`hook.*` 事件是持久事件（进事件日志、可补拉），`subject.type=hook` 是 S4 新增的 subject 类型；它们不推给执行器做任务提示，运维面读取 outbox 深度与最近一次尝试摘要（§4.7）。

### 4.5 SAP 入站 webhook

`POST /hooks/sap`（HMAC + 幂等键），`data.type`：

| type | 何时 | 控制平面动作 |
| --- | --- | --- |
| `demand.submitted` | 需求提交 | 建 Demand + 启动模板第一阶段 |
| `demand.updated` | 需求字段变化 | 更新快照；必要时重开阶段 |
| `artifact.approved` / `artifact.rejected` | 门禁结果 | 解决对应 Approval，推进/退回阶段 |
| `demand.cancelled` | 取消 | 取消需求与所有任务 |
| `hook.receipt` | 外部系统完成（JIRA/CHARM 回执） | 记录 Hook 回执，推进阶段 |

通用 Hook（JIRA/CHARM/Confluence/Teams 等）走 §4.7 的配置驱动出站 + 独立回执端点；本节 SAP 路径保持不变（`/hooks/sap` 仍由 SAP 专用的投递幂等表负责），两者共用 webhook 签名头但不共享状态。

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

### 4.7 通用 Hook 协议（S4）

Hook 是控制平面对外部系统的唯一扩展入口（契约见 [008-hooks.md](008-hooks.md)）。v1 只实现 `http` 目标：配置文件（`SA_HOOKS_CONFIG`，默认 `examples/hooks.yaml`）声明订阅的**持久事件类型**，事件提交后由出站队列投递统一信封；外部系统用 HMAC 回执。文件缺失或全部 `enabled: false` 时 Hook 完全禁用，不影响 H0–S3 行为。

配置（可执行格式见 008 §6）：

| 字段 | 说明 |
| --- | --- |
| `id` | lower-kebab-case，唯一；outbox `target='hook:<id>'`、URL `{id}`/`{target}` 都用它 |
| `target` | v1 只有 `http` |
| `url` | 出站 POST 地址（http/https） |
| `events` | 订阅的持久事件类型（§4.4）；禁止订阅 `hook.*`（会形成回环），启动校验拒绝 |
| `secretRef` | `env:NAME`；只用于出站 HMAC 与入站回执验签，不落库/日志 |
| `enabled` | 默认 `false`（示例文件全禁用） |
| `retry` | `{maxAttempts, backoff: "exponential", deadLetter}`，默认 5 次 / 2s 起 / 上限 5min |
| `reconcileUrl` | 可选；`pnpm hooks:reconcile` 拉外部列表做双向比对 |
| `advanceOnReceipt` | 预留，v1 必须为 `false`（回执只记录，不推进阶段） |

端点（与 SAP 一样挂在根路径，供外部系统直接调用；管理端点用 admin token）：

| 方法 | 路径 | 认证 | 说明 |
| --- | --- | --- | --- |
| GET | `/hooks` | `admin` | 每个配置 Hook 的 `enabled`/`events`/outbox 深度（pending/sent/dead/cancelled）/`lastError`/最近一次尝试摘要 |
| POST | `/hooks/{id}/replay` | `admin` + `Idempotency-Key` | body `{eventId}`；把该 Hook 对应 outbox 行重置为待投递（死信/已发/已取消皆可），保持 `idempotencyKey` 不变；重复 replay 靠 `Idempotency-Key` 幂等 |
| POST | `/hooks/{target}/receipt` | HMAC（`X-SA-*`） | 外部系统回执；body 见 008 §4；重复回执幂等（`duplicate:true`），未知 `externalId` 只记录 |

出站语义：

- 每次尝试写 `hook.attempted`，成功写 `hook.delivered`（外部响应里的 `externalId`/`id`/`key` 可空），最终失败写 `hook.dead`；4xx 立即死信，5xx/429/超时按指数退避重试，429 尊重 `Retry-After`。
- 发送前用 `hookEnvelopeSchema` 校验落地信封（含 `eventVersion=1`）；校验失败或未知版本直接进死信，不静默丢弃。
- 需求取消 / 阶段退回（`demand.cancelled`、`stage.cancelled`、`artifact.rejected`）时，同需求未发送的 Hook 行标 `cancelled` 并写 `hook.cancelled`；已发送的 v1 只记录、不补发关闭动作。
- 回执落 `hook_receipts`（迁移 v6，只追加）+ `hook.receipt` 事件；v1 **只记录不推进阶段**，`advanceOnReceipt=true` 在启动时报"改成 false 或等待 v1.1"。

对账：`pnpm hooks:reconcile` 只读；报告两类差异（外部有、控制平面无；控制平面有、外部无 = delivered 超 SLA 无回执 / 死信 / 未知回执），有差异默认退出码 0、`--fail-on-diff` 时 3。

### 4.8 SAP 批处理 AI 执行器（M3，S5）

M3 下控制平面可以把模板中的 `server-ai` 阶段**委派**给 SAP 侧批处理执行器（`ZCL_ZSA_AI_BATCH`）：控制平面仍独占状态机、输出校验、checklist、ledger、工件与门禁/审批推进；SAP 只做"取 prompt → 调企业 AI 网关 → 回传模型原始输出文本"。prompt 由控制平面渲染（`renderAiStageMessages`），ABAP **不拼 prompt、不做 JSON 提取/业务校验**，从而 prompt 与校验单源。

**默认关闭**：`SA_SAP_AI_BATCH` 未设置/`0` 时 H0–S4 行为完全不变（本地 `ctx.aiProvider` 执行，SAP job API 不注册、404）。

#### 4.8.1 启用与配置（控制平面 env）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `SA_SAP_AI_BATCH` | 关闭 | `1`/`true` 启用；`0`/`false`/未设置关闭；其他值启动失败并给出改法 |
| `SA_SAP_AI_STAGE_KEYS` | 全部 `server-ai` 阶段 | 逗号白名单；只委派命中的 stage key（按模板阶段 key） |
| `SA_SAP_AI_JOB_LEASE_MS` | `600000`（10min） | claim 租约；heartbeat 续租，建议每租约一半续一次 |
| `SA_SAP_AI_JOB_MAX_AGE_MS` | `1800000`（30min） | job 超龄终态；按阶段失败处理（重试/转人工） |
| `SA_SAP_AI_JOB_BATCH_SIZE` | `5` | `next` 默认/最大批次（上限 50） |
| `SA_SAP_AI_JOB_TIMEOUT_MS` | `120000` | 写入 payload 的单次网关调用超时提示 |
| `SA_SAP_AI_JOB_MAX_LEASE_EXPIRIES` | `2` | 同一 job 第 N 次租约过期即按失败处理 |
| `SA_SAP_HOOK_SECRET` | — | **必需**（启用时）；SAP→控制平面 HMAC 复用该 secret，缺失则启动失败 |
| `SA_AI_MODEL` | provider 默认 | 写入 payload 的模型（SAP 可用 `ZSA_CFG.AI_GATEWAY_MODEL` 兜底） |

#### 4.8.2 job 生命周期与租约

```text
queued ──claim──> claimed ──result(succeeded)──> succeeded
   ^                  ├────result(failed)──────> failed
   │                  ├────maxAge/多次过期─────> expired
   └──lease expired───┘（不增 attempt）
queued/claimed ──阶段或需求取消──> cancelled
```

- **身份**：`(stageRunId, attempt)` 唯一 → 一个 attempt 一个 job；阶段重试产生新 attempt，也就产生新 job。旧 job 保留为审计记录。
- **queued**：可被 `next` 列出；`created_at` 升序返回。
- **claimed**：带 `claimId`（服务端 ULID）与租约；租约有效期内重复 claim → `409`。
- **租约过期**：sweeper 把 `claimed` 且租约过期的 job 放回 `queued`（`claimId/lease` 清空，**不增 attempt**），lease 过期计数 +1；计数达到 `SA_SAP_AI_JOB_MAX_LEASE_EXPIRIES` → 按阶段失败处理（`expired` + `stage.ai_job.failed`）。
- **超龄**：`now - created_at > SA_SAP_AI_JOB_MAX_AGE_MS` 的未终态 job → `expired` + 按阶段失败处理。
- **结果幂等**：job 已 `succeeded`/`failed`/`expired`/`cancelled` 时重复 result 返回 `200 {duplicate:true, accepted:false}`（不重复写事件/工件/attempt ledger）；`queued` 状态发 result → `409`；claimId 不匹配 → `409`。
- **取消**：阶段或需求被取消后，sweeper 把该 attempt 的未终态 job 置 `cancelled`（终态、审计）。

#### 4.8.3 job payload（数据边界）

| 字段 | 说明 |
| --- | --- |
| `stageRunId` / `demandId` / `stageKey` / `stageName` / `attempt` | 身份与展示 |
| `promptVersion` | prompt 版本（进 ledger） |
| `systemPrompt` / `prompt` | 控制平面渲染的 system/user 文本；SAP 原样发给网关 |
| `model` | 控制平面钉住的模型（SAP 可被 `ZSA_CFG` 覆盖） |
| `outputSchema` | 控制平面输出 schema 的不透明引用；**SAP 不解析** |
| `timeoutMs` | 单次网关调用超时提示 |
| `maxOutputTokens?` | 可选网关上限 |

payload **不含**凭据、网关地址、SAP 地址；日志只打 ids/长度/耗时，不打印 prompt/output 正文。prompt/输出只在"控制平面 → SAP → 企业内网网关"路径传输。

#### 4.8.4 SAP → 控制平面 API（HMAC，无 Bearer）

全部 `POST` + `X-SA-Signature/Timestamp/Delivery`（复用 §4.1/§4.5 的 HMAC 规则，±5 分钟，secret=`SA_SAP_HOOK_SECRET`）；鉴权失败 `401`。返回体均含 `serverTime`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/v1/sap/ai-jobs/next` | body `{limit?}` → `{jobs:[...], serverTime}`；只读，不改状态 |
| POST | `/api/v1/sap/ai-jobs/{id}/claim` | body `{}` → `{job, claimId, lease:{expiresAt,renewIntervalMs}, serverTime}`；租约有效期内重复 claim → `409` |
| POST | `/api/v1/sap/ai-jobs/{id}/heartbeat` | body `{claimId}` → `{jobId, claimId, lease, serverTime}`；claim 不匹配/租约已过期/已终态 → `409` |
| POST | `/api/v1/sap/ai-jobs/{id}/result` | body `{claimId, status:"succeeded", outputText, usage?, durationMs?}` 或 `{claimId, status:"failed", error:{code?,message,retryable?}, usage?, durationMs?}` → `{job, accepted, duplicate, stageRunId, stageStatus, serverTime}` |
| POST | `/api/v1/admin/sap/ai-jobs/{id}/requeue` | **admin Bearer**；body `{reason?}`；把 `failed`/`expired`/`cancelled` 且阶段仍 `running`（同一 attempt）的 job 重新排入 `queued`；已 `queued` → `requeued:false` 幂等；`claimed` 或阶段已推进 → `409` |
| GET | `/hooks/sap/status` | 现有响应**追加** `aiJobs:{queued,claimed,succeeded,failed,expired,cancelled,lastError}`（仅启用时出现；admin Bearer） |

result 的成功路径（控制平面）：提取 JSON（`extractJsonText`）→ 输出 schema（`parseStageOutput`）→ checklist（`evaluateStageCompletion`）→ attempt ledger → 工件 + 门禁/推进（复用 §2.2 的完成语义，与本地 AI 阶段同一份实现）。**非法输出/schema 失败按阶段失败处理**（重试到 `maxAttempts` → `waiting_human`，不落半成品工件），并写 `stage.ai_job.failed`。

#### 4.8.5 事件（持久，`subject.type=stage_run`）

| type | data 关键字段 | 何时 |
| --- | --- | --- |
| `stage.ai_job.queued` | `jobId, stageRunId, demandId, stageKey, attempt, reason`（`dispatch`/`retry`/`lease_expired`/`recovered`/`requeued`） | 入队、租约过期回队、重启恢复、admin requeue |
| `stage.ai_job.claimed` | `jobId, stageRunId, demandId, stageKey, attempt, claimId, leaseExpiresAt` | SAP claim 成功 |
| `stage.ai_job.completed` | `jobId, stageRunId, demandId, stageKey, attempt, artifactId, artifactVersion, stageStatus, tokens, durationMs` | 结果被接受并完成/转门禁 |
| `stage.ai_job.failed` | `jobId, stageRunId, demandId, stageKey, attempt, reason, error, willRetry, stageStatus`（`reason`: `sap_failed`/`invalid_output`/`checklist_failed`/`max_age_exceeded`/`lease_expired`/`stage_cancelled`） | 结果失败/非法输出/超龄/多次过期/取消 |

#### 4.8.6 控制平面执行语义（StageRunner）

- 阶段 `ready` 且命中委派：沿用现有 stage claim（`running` + `stage.started`），随后**不调用本地 `ctx.aiProvider`**；渲染 prompt 并写 job `queued` + `stage.ai_job.queued`，阶段保持 `running` 等结果。
- 结果成功：公共完成函数（与本地 AI 阶段同一实现）→ 写 `stage.ai_job.completed`；阶段可落 `done` 或门禁 `waiting_human`。
- 结果失败/输出非法：`failStageAttempt`（attempt+1 `ready` 或超限 `waiting_human`；不落半成品）→ 写 `stage.ai_job.failed`；重试的新 attempt 由 runner 在下一 tick 重新入队。
- 租约过期/超龄：见 §4.8.2；SAP 端应 heartbeat 续租，超龄后由控制平面判定失败。
- **重启恢复**：启动时 `claimed` 且租约过期 → `queued`（`recovered`）；`running` 且无 job 的被委派阶段 → 幂等补建（同 attempt）；非委派的 `running` server-ai 阶段保持 H0–S4 的 reset 行为。
- **不委派/开关关闭**：与 H0–S4 完全一致（本地 provider）。
- 成本记账：`model` 来自 payload，`tokens` 来自 SAP 回传 `usage`，`costUsd=0`（网关侧计费），`durationMs` 用 SAP 回传值或服务端计时；不伪造 Cost。

#### 4.8.7 边界

- SAP 只做批处理执行器 + 网关调用；不实现交互式 agent、流式输出、ABAP 全量控制平面。
- SAP 不做 JSON 提取/schema/checklist/门禁判断；不做业务重试决策（只做网关层重试与 `failed` 回传）。
- 不新增外部依赖（Node `fetch` / ABAP `cl_http_client`）；不改 `/hooks/sap` 入站行为与 SAP outbox push。
- 数据边界：需求/工件/事件/日志不出企业；prompt/输出仅走控制平面→SAP→内网网关；控制平面不持有网关 key。

## 5. 工件与上下文

- **存储可插拔**：本地文件（M1）、S3/对象存储（M2）、SAP 附件/内容仓库（M3）。控制平面只存元数据、checksum 与引用。M1 实现补充：本地模式把内容写到 `SA_STATE_DIR/artifacts/<artifactId>/v<n>.bin`，接口只接受 `contentBase64`（`contentUrl` 预留给 M2 对象存储）；checksum 必须等于解码后字节的 sha256。
- **上下文包**是工件的只读快照，不是新概念：由需求摘要、输入工件、验收标准、工作区绑定和禁止项组成，扩展负责写入 `.sap-superagent/task/<taskId>/context.md`（同目录附 `context.json` 快照），供 Copilot Chat 用 `#file` 引用。
- **审计**：工件每次创建/审批写事件；事件只追加，不更新。

## 6. 扩展点

| 扩展点 | 接口 | v1 实现 | 未来 |
| --- | --- | --- | --- |
| 需求来源 | `SourceAdapter`：`ingest(event)` / `writeBack(demand)` / `reconcile()` | 本地 REST、SAP ICF JSON + webhook | JIRA、ServiceNow |
| 执行器 | 4.2 协议 | `vscode`、`server-ai` | CI、ABAP 传输、DSH session |
| AI 阶段 | `AiStage`：`buildPrompt(ctx)` / `outputSchema` / `model` / `maxCostUsd` | 受理澄清、需求分析、开发说明、测试文档、知识归档（`packages/ai` 注册表，按 stage key 解析） | 更多模板 |
| Hook 目标 | `HookTarget`：`event` / `payload(demand, artifact)` / `send()` / `idempotencyKey` | S4：配置驱动订阅 + `http` 目标 + 出站队列/重试/死信/重放 + 入站回执（§4.7，契约 [008-hooks.md](008-hooks.md)） | JIRA、CHARM、Confluence、Teams（只提供配置样例，见 `examples/hooks/`） |
| 存储 | `Repository` / `ArtifactStore` / `EventStore` | SQLite + FS；Postgres 可选 | SAP HANA |
| 身份 | `TokenValidator` | 本地签发 token | OIDC / SAP SSO |
