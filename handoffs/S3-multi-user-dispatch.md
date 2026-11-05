# S3 — 多人在线与派发

> 依赖：H0（walking skeleton）、H1（门禁/模板）、H2 Phase A（SAP 集成接口）均已在 `main`。H2 Phase B（真实测试系统建对象）可与本任务并行，二者写范围不重叠。
> 目标：支持一个团队的真实协作——多执行器下 presence/租约/资格/工作区匹配正确；任务可转交；客户端实时收到"属于自己"的任务；断线重连补齐事件；同一任务不会双写。
> 规格来源：[docs/003 §2.3/§3/§4.2/§4.4](../docs/003-domain-and-protocol.md)、[docs/005 §2.2/§2.5](../docs/005-clients-and-ai.md)、[docs/009 #1–#5/#8/#9/#16](../docs/009-testing.md)、[docs/007 S3](../docs/007-roadmap.md)。

## 0. 起点：已具备的（不要重写）

- **租约**：60s TTL / 20s 续约、过期回池、`assignment.expired` 事件；执行器心跳超时判离线并释放任务（`packages/server/src/workers/sweepers.ts`、`lease.ts`）。
- **资格规则 1–6**：`executorKind`、角色、`workspaceBinding`（可空→通用箱）、presence/accepting、用户并发（当前仅"同需求 1 个活跃人工任务"）、`lastHolderUserIds` 降权（`packages/core/src/scheduling.ts`、`packages/server/src/offers.ts`）。
- **已过滤的读取路径**：`GET /tasks` 与心跳 `offers` 已按资格过滤；claim 用 CAS/事务。
- **WS 事件**：`/api/v1/events?after=` 补发、`resync_required`、`task.offered` 传输帧（**当前广播给所有连接，未按资格过滤** = H0 偏差 #4，本任务修复）。
- **客户端骨架**：executor 注册/心跳/续约/暂停、工作区绑定、任务箱三组（「等待我回答」仍为空）、SecretStorage。
- **既有 e2e**：覆盖 009 #1（双 claim 409）、#2（租约过期回池）、#3（重启补事件）、#10（游标过期 resync）。

## 1. 交付物

### 1.1 WS `task.offered` 按执行器资格过滤（核心）

- WS 连接建立时已校验 token；把 `executorId`（executor token）绑定到连接存续期；user/admin 连接只收事件流、不收 `task.offered`。
- 任务新建/回池（`task.created` / `task.released` / `task.updated→pending`）时，只向满足 docs/003 §3 规则 1–5 的**在线**执行器连接推送；不要复制过滤逻辑，复用 `listEligiblePendingTasks` 的判定。
- `task.updated`/`task.cancelled` 等事件保持统一事件语义（003 §4.4）；只对传输帧 `task.offered` 做资格过滤。
- 测试：两个执行器（不同角色/工作区）同一服务端，只有一个收到帧；offline/paused 执行器不收到；重连后心跳 offers 与 WS 帧一致。

### 1.2 客户端实时接收与断线重连

- VSCode 扩展订阅 WS `/api/v1/events?after=<lastSeq>`：收到 `task.offered` / `task.updated` / `task.cancelled` 后刷新任务箱与状态栏；`lastSeq` 存 `globalState`（不落工作区文件）。
- 断线指数退避重连（复用 presence 的退避策略）；收到 `{"type":"resync_required"}` 时全量拉取 `GET /tasks` + `GET /events?after=`；重连期间事件不丢。
- 验收：已绑定任务在打开对应目录后 **≤2s** 出现（测试设短 `heartbeatSweepMs`/`presenceTtlMs`）；离线期间变化在重连后补齐；不依赖本地时钟判断过期。
- 测试：客户端 mock `vscode` 单测（WS 帧处理/重连/resync），不要求真机 Extension Host。

### 1.3 用户并发上限与任务转交

- `maxConcurrentPerUser`（默认 2）进入 `ServerOptions`/`ServerConfig` + claim 资格（docs/003 §3 规则 6），与现有"同需求 1 个活跃人工任务"并存。
- 新增 `POST /tasks/{id}/transfer`：持有租约者把任务转交到指定 `user` 或角色池；语义 = 结束当前 assignment（`released` + 事件）+ 回池（带 `lastHolderUserIds` 降权）/定向重新派发；要求当前租约、幂等键、目标用户必须满足角色与并发约束；v1 只记录操作人（不建模权限）。
- 协议先行：先改 [docs/003 §4.2](../docs/003-domain-and-protocol.md) 与 `packages/protocol`，`pnpm contract:gen` 提交 contracts diff；迁移只追加（如需转交审计表，从 v5 起）。
- 测试：转交后原持有者租约立即失效、目标池可领取、事件链完整、同一任务不会双写；非持有者转交 409。

### 1.4 工作区切换 / 多窗口 / 权限失败端到端

- e2e 多执行器场景（进程内，总时长 <5s）：009 #5 切换工作目录立即 release 并回池；#1 同目录双窗口 claim 409（多执行器复核）；#2 presence 掉线 60s 内回池、他人可领；#4 客户端时钟偏移不影响租约；#8 任务内容注入不执行（工具白名单/确认）；#9 401/403 清 token、停止接单、提示重新授权；#16 未绑定需求进通用任务箱、绑定需求只对匹配工作区可见。
- 客户端 preflight：工作区信任/仓库状态/`abap` 不可用等失败 → 任务转 `waiting_human` 给出下一步动作，不自动重试写操作（docs/005 §2.5）。

### 1.5 任务箱「等待我回答」接审批/通知

- `tasksView`/`extension` 第三组接 **H1 已交付 API**：`GET /approvals?assignee=me`（pending）+ `GET /notifications?state=unread`；点击审批 →
  `POST /approvals/{id}/decisions`（approve/reject + comment）、`POST /notifications/{id}/read`；审批后组内消失并刷新状态栏。
- 空状态直接给下一步动作；错误提示写"现在该做什么"（docs/005 §5）。
- 测试：mock `vscode` 单测 + 服务端集成测试；通知未读数与状态栏一致。

### 1.6 测试与文档

- 多执行器 e2e（至少覆盖 009 #1–#5、#8、#9、#16 各一条，进程内 fake executor，保持 `pnpm e2e` <5s）。
- 客户端 mock 单测：WS 重连/resync、approvals 组、工作区切换 release。
- 更新 [docs/003](../docs/003-domain-and-protocol.md)（WS 过滤规则、transfer 端点、`maxConcurrentPerUser`）、[docs/005](../docs/005-clients-and-ai.md)（客户端实时性与任务箱）、[docs/007](../docs/007-roadmap.md)（S3 勾选）、README、`handoffs/STATUS.md`。
- 失败场景与偏差写进 STATUS；不引入真实 VSCode 启动依赖。

## 2. 验收

```sh
pnpm check      # typecheck 9 包 + eslint + 单测/契约（预计 350+ tests）
pnpm e2e        # 含多执行器：资格过滤、转交、工作区切换、presence、审批组
pnpm build
```

手工冒烟（可用 e2e/集成复现并记录实际输出）：

1. 两个执行器（不同角色/工作区）同时在线：只有合格者收到 `task.offered`，claim 互斥（一个成功一个 409）。
2. 任务转交：原持有者 lease 失效、目标用户任务箱可见并可领取，事件时间线完整。
3. 切换工作目录：立即 release 回池，3 秒内出现在另一合格执行器的任务箱。
4. 审批组：G1 审批出现于「等待我回答」，通过后消失、任务箱刷新。

## 3. 边界与禁令

- 不改 H0/H1/H2 的既有字段语义；协议变更先改 docs/003 + `packages/protocol`，并提交 `contracts/` diff。
- 不做 M2/Postgres、SSO/OIDC、细粒度权限、MCP、SAP 侧改动（SAP 属 H2 Phase B）。
- 真实 VSCode Extension Host / VSIX 冒烟仍留发布前；统一用 mock `vscode` 单测。
- 只改本任务书写明的写范围；共享文件（`protocol`、`docs/003`、`contracts`、`server/src/http/app.ts`、`server/src/db/migrations.ts`、`server/src/types.ts`）只做追加式改动 + `// --- S3: ... ---` 标记。
- 与 H2 Phase B 并行时：Phase B 只改 `sap/**`、`docs/004`、`scripts/sap-check.mjs`、`handoffs/STATUS.md` 的 H2 行；本任务不碰这些路径。

## 4. 写范围

`packages/core/**`、`packages/server/**`、`packages/protocol/**`、`packages/clients/vscode/**`、`packages/testkit/**`、`contracts/**`、`docs/003`、`docs/005`、`docs/007`、`README.md`、`handoffs/STATUS.md`。

## 5. 上报格式

完成项、`pnpm check`/`pnpm e2e`/`pnpm build` 输出摘要、客户端 mock 测试结果、与设计的偏差、遗留/未决。

## 6. 启动 Prompt（可直接复制给新的执行 Agent）

> 你在 `/Users/lei/ai_space/sap_super_agent/.sap-superagent-worktrees/s3` 工作（分支 `feat/s3-multi-user`，基线 `main`）。先读 `HANDOFF.md`、`handoffs/STATUS.md`、`handoffs/S3-multi-user-dispatch.md`、`docs/003` §2.3/§3/§4.2/§4.4、`docs/005` §2、`docs/009`、`docs/006`。然后在 `handoffs/STATUS.md` 认领 S3。严格按任务书写范围与验收执行：协议先行（docs/003 + `packages/protocol` + `pnpm contract:gen`），再实现 server/客户端/测试；不要改 `sap/**`、`docs/004`、`docs/008`（H2 Phase B 并行）。每完成一个子项更新 STATUS；Conventional Commits + `git commit -s`；不 push、不直推 main、不要 force push。完成时报告：完成项、`pnpm check`/`pnpm e2e`/`pnpm build` 结果、偏差、遗留。
