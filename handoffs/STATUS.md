# Handoff 状态看板

> 执行 Agent 每完成一个子项就更新本表，只改自己的行；状态：`todo` → `in_progress` → `review` → `done` / `blocked`。
> 分支名与提交哈希填实际值；"验证"写已跑过的命令与结果（例如 `pnpm check ✅`）。

| ID | 任务书 | 状态 | Owner | 分支 | 最近提交 | 验证 | 备注 / 偏差 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| H0 | [H0-walking-skeleton.md](H0-walking-skeleton.md) | done | lead（协作者 svc-server：server/ai；svc-clients：cli/vscode；verifier：只读验收三轮，最终 YES） | feat/h0-walking-skeleton | d03dc29（代码完结于 8b97215） | `pnpm install --frozen-lockfile` ✅；`pnpm check` ✅（8 包 typecheck + eslint + **252** 单测/集成 + contract 快照 27 schemas / 5 examples / 19 routes）；`pnpm e2e` ✅（4/4，多轮运行无 flake）；`pnpm build` ✅（8/8）；H0 §2 手工冒烟 ✅（healthz → 建需求 → AI 工件 → 手建任务 → 注册/心跳/领取/上下文/工件/完成 → 事件时间线 → SIGINT 优雅退出） | 完成；偏差与遗留见下节 |
| H1 | [H1-gates-and-templates.md](H1-gates-and-templates.md) | done | h1-agent（worktree `.sap-superagent-worktrees/h1`；Lead 集成验收） | feat/h1-gates | 238fd08 | 分支自测：`pnpm check` ✅ 303 tests、`pnpm e2e` ✅ 8/8、`pnpm eval:golden` ✅ 24 cases（schema/checklist/reference 100%，人工修改率 11.2% → auto）；集成验收（integrate/h1-h2）：`pnpm check` ✅ **350 tests**、`pnpm e2e` ✅ 9/9、`pnpm eval:golden` ✅、`pnpm sap:check` ✅、`pnpm build` ✅ 8/8、curl 手工冒烟 G1→自动任务→G3→G4→done ✅ | 任务书 §1.1–§1.7 全部落地；偏差见「H1 偏差与遗留」 |
| H2 | [H2-sap-icf-mime.md](H2-sap-icf-mime.md) | done（Phase A）；Phase B → H2-B | h2-agent（worktree `.sap-superagent-worktrees/h2`；Lead 集成验收） | feat/h2-sap | 0eb35c4 | 分支自测：`pnpm check` ✅ 299 tests、`pnpm e2e` ✅ 5/5、`pnpm sap:check` ✅ 5 pass/1 skip、`pnpm build` ✅；集成验收：SAP 链路已接到 H1 门禁运行时，e2e 9/9（含 SAP 全链路）、`pnpm sap:check` ✅；Phase B 仅只读连通，未做任何 SAP 写操作 | Phase A 交付完成；Phase B 转入 H2-B 行（用户决策 `$ZSA` + abap-cli）。偏差见「H2 Phase A 偏差与遗留」「Lead 集成验收」 |
| H2-B | [H2-sap-icf-mime.md](H2-sap-icf-mime.md)（§1.6 Phase B） | todo | 待认领 | — | — | — | 用户决策（2026-11-05）：本地包 `$ZSA`、无 TR、全部 abap-cli、abapGit 不实现；只读核实：测试系统可达、`$ZSA` 为空。可交付：DDIC/类/ICF/MIME/ABAP Unit/ICF health；端到端回写仍缺控制平面可达 + HMAC + SSO。启动 Prompt 见 [H2 任务书](H2-sap-icf-mime.md) §1.6 |
| S3 | [S3-multi-user-dispatch.md](S3-multi-user-dispatch.md) | done（分支自测通过，待 Lead 集成验收） | s3-agent（worktree `.sap-superagent-worktrees/s3`） | feat/s3-multi-user | 809390d（代码完结；fa801f5 协议 → ad49081 core → 81f234b WS 过滤 → b6fb513 transfer → 5bf90bc/607b8fc 客户端 → 809390d e2e → 本次 docs/STATUS 收尾提交） | `pnpm check` ✅ **401 tests**（protocol 59 / ai 28 / core 52 / vscode 97 / server 67 / testkit 23 / cli 44 / sap-adapter 31；contract 39 schemas / 5 examples / 19 routes）；`pnpm e2e` ✅ **15/15，3.91s**（<5s）；`pnpm build` ✅ 8/8；多执行器 e2e 覆盖 009 #1/#2/#4/#5/#8/#9/#16 + 转交冒烟（手工复现见「S3 验收复现」） | WS `task.offered` 按执行器资格过滤（连接绑定 executorId，user/admin 不收）、`maxConcurrentPerUser`（默认 2，仅 vscode）、`POST /tasks/{id}/transfer`（迁移 v5 审计、回池 + 事件链、幂等、409）、客户端 WS 实时/退避重连/lastSeq(globalState)/resync 全量拉取、任务箱「等待我回答」接 H1 approvals/notifications、工作区切换立即 release、client preflight；偏差见「S3 偏差与遗留」；未 push、未合入 main、未跑真机 Extension Host |

## H0 偏差与遗留（交接给 H1 / H2 / 用户）

1. **协议加法（已同步 docs/003）**：新增 `executor.activeWorkspaceKey` 与 `heartbeatBody.activeWorkspaceKey`（§3 调度早已依赖、§2.6 原先未定义）；`task.offered` 明确定义为**传输帧**（无 `seq`、不持久化）；`stage_attempts` run ledger、M1 本地工件只收 `contentBase64`、WS `resync_required` 控制帧均已写入 003。`contracts/` 快照同步（27 schemas）。
2. **模板是最小集**：`templates/default.yaml` 为 H0 两阶段（需求分析 server-ai + 开发实现 vscode），门禁为空；H1 替换为 3 阶段 G1/G3/G4 并新增 `pdo.yaml`。S0 的开发任务由 `POST /admin/tasks` 手建（H1 起由模板自动产生）。
3. **校验子集**：阶段完成 = 输出 schema 校验；checklist / 上游版本一致 / 工件 stale / 审批端点 / 门禁超时均属 H1（仅建了 `approvals` 表与 schema，无运行时）。
4. **`task.offered` 广播**：新建与回池（租约过期、release、执行器下线）时向所有已连接客户端广播摘要帧，未按执行器资格过滤（S3 增强）；`GET /tasks` 与心跳 `offers` 已按 003 §3 规则 1–6 过滤并应用 `lastHolderUserIds` 降权。
5. **数据与外部系统**：全部夹具为虚构需求；未连接任何 SAP 系统（S2 才做），未做真实 BYOK 网络调用（fake provider 覆盖 e2e，BYOK 适配器有单测）。
6. **真机验证缺口**：真实 VSCode Extension Host（F5/SecretStorage UI）未跑——按 H0 规范用 mock `vscode` 单测（67 个）；VSIX 打包与冒烟留待发布前。
7. **端口**：默认 3080 与开发机上的 DSH Web GUI 冲突；手工冒烟用 `--port`/`SA_HTTP_PORT`。默认值仍按设计保持 3080。
8. **同工作区并行会话**：`demo/`、README 小改、docs/006 一行为**另一会话/用户**在 2026-11-05 01:05 提交并推送（提交 `02d8689` 进入本分支历史、`f752592` 进入 main），不属 H0 产出；本分支 H0 提交为 ff13648…8b97215。
9. **推送状态**：H0 分支未推送；本地比 `origin/feat/h0-walking-skeleton` 领先 **17** 个提交（origin 上是早先的骨架/core/protocol 提交 + 并行会话的 demo 提交）。合并建议：走 PR/squash，不直推 main。

## H1 偏差与遗留（交接给 Lead / 用户）

1. **G3 单角色**：任务书 §1.1 写 "consultant+developer 评审"，协议 gate 只有单 role；v1 实现为 `consultant`（开发者证据由 vscode 阶段的 schema+checklist 与版本链体现），docs/003 §2.5 已注明，未扩协议。
2. **模板版本缺失回退**：Demand 固定 `templateId@version`；registry 优先精确版本，旧版本文件缺失时回退最高已加载版本（docs/003 §2.7 写明）。长期应保留旧版本模板文件，跨重启严格锁定需要 Demand 模板快照（本轮未做）。
3. **通知渠道**：只落 `notifications` 表 + GET/read API；CLI/VSCode 展示不在 H1 写范围，Teams 留 Hook（S4）。
4. **门禁超时 job**：到期检查挂在既有 sweeper tick（默认 1s；生产可调），不是单独每小时 job；`timeoutDays` 语义不变。
5. **observe 工件状态**：observe 草稿以 `in_review` 表示待人工确认（工件状态机无 draft→approved 路径）。
6. **contracts/examples**：未新增示例；新路由已进 `contracts/openapi.yaml`（36 schemas / 5 examples / 19 routes 快照）。

## 交接日志

| 时间 | 事件 |
| --- | --- |
| 2026-11-05 | 仓库初始化，设计与 handoff 提交；H0 待认领 |
| 2026-11-05 | Lead 认领 H0，创建 `feat/h0-walking-skeleton`；提交 pnpm workspace 骨架（ff13648）、protocol（6084e59）、core + `templates/default.yaml`（5ba1c4f） |
| 2026-11-05 | 实现时发现 docs/003 §3 依赖的 `activeWorkspaceKey` 在 §2.6 未定义：按 H0 §1.9 补 protocol 字段与 docs，提交 a86751e（加法，不改既有语义） |
| 2026-11-05 | 并行分派：`svc-server`（server+ai）、`svc-clients`（cli+vscode）；Lead 负责协议/core、testkit/e2e、contracts、CI、docs 与集成验证 |
| 2026-11-05 | 集成完成：`pnpm check` / `pnpm e2e` / `pnpm build` 全绿；提交 ai/server/cli/vscode/testkit/e2e/contracts/docs（955868a…ad227c0） |
| 2026-11-05 | 第一轮独立验收（verifier）：可执行验收项全绿，但发现 6 个交付项缺口（降权、`.env`、单实例锁、`task.offered`、init→dev 测试、内存仓库）→ 全部修复并提交（34353a4…598da4e） |
| 2026-11-05 | 第二轮独立验收：5/6 修复通过；`task.offered` 漏了显式 release 路径，另有 quick-start/.env 准确性问题 → 修复（4050784、8b97215）并补 WS release 测试 |
| 2026-11-05 | H0 标记 done：`pnpm install --frozen-lockfile` / `pnpm check`（252 tests）/ `pnpm e2e`（4/4）/ `pnpm build` 全部通过；H1/H2 解除阻塞（状态 `todo`） |
| 2026-11-05 | 第三轮独立复核（verifier）结论 **H0 DoD met: YES**：六个交付缺口 + D1–D4 全部复现通过，无阻塞项；仅 STATUS 推送计数 16→17 的笔误当场修正 |
| 2026-11-05 | H0 分支 `feat/h0-walking-skeleton`（`d03dc29`）已推送到 origin；工作区干净 |
| 2026-11-05 | 新增 H1/H2 执行交接 [H1-H2-execution-handoff.md](H1-H2-execution-handoff.md)：H0 可复用接口、H1/H2 实施顺序、共享文件协调、环境坑、启动 Prompt；HANDOFF.md/H1/H2 任务书已加指针 |
| 2026-11-05 | H1 认领（h1-agent，worktree + 分支 `feat/h1-gates`，基线 a9e5e98）；契约先行提交 b0e8714：StageTemplate autonomy/requiredRoles/checklist 闭集、Approval 绑定 (artifactId, artifactVersion)、notification/artifactChain、GET /templates、approvals/notifications/withdraw/demand-artifacts/admin-expire 路由、事件 artifact.stale/approval.expired/withdrawn；contracts 27→36 schemas |
| 2026-11-05 | H1 子项 1/7+2/7：core checklist 断言注册表（e60bf32）；templates/default.yaml 3 阶段 G1/G3/G4、templates/pdo.yaml 6 阶段 G1–G5、版本化 registry + GET /templates、core/server 模板测试（8ad6df9）；`pnpm check` 274 tests ✅、`pnpm e2e` 4/4 ✅ |
| 2026-11-05 | H1 子项 3/7–5/7：AI 阶段注册表（0868899）；门禁运行时 + 阶段生命周期引擎 + 迁移 v3（approvals 绑定版本/notifications 表）+ 工件版本/stale/人工修订 + autonomy observe 确认门禁（b3da867）；服务端集成测试 52（含 gates 13，覆盖 009 #13/#14/#15），`pnpm check` 296 tests ✅、`pnpm e2e` 4/4 ✅ |
| 2026-11-05 | H1 子项 6/7：golden set 24 条脱敏 fixture + `evals/thresholds.json` + `packages/ai/src/golden.ts` 评分 + `scripts/eval-golden.mjs`（fake 默认 / BYOK 可切）+ 确定性 `evals/report.json`；report 连跑字节一致，server/ai 均有稳定性测试（commit 3c9b094） |
| 2026-11-05 | H1 子项 7/7：e2e 新增审批通过/驳回/超时/stale 四条真实链路（d7758b0，`pnpm e2e` 8/8）；docs/003（门禁/模板/checklist 最终语义 + G3 单角色 v1 说明）、docs/005（observe/auto 与 golden 阈值闭环、pdo.yaml 映射）、docs/007（S1 完成状态）、README（S0+S1 状态、门禁 curl、模板、eval:golden）更新（9b67568）；lint 收尾 b97da20 |
| 2026-11-05 | H1 完成自测（待 Lead 集成验收）：`pnpm check` ✅ 303 tests；`pnpm e2e` ✅ 8/8；`pnpm eval:golden` ✅ 24 cases（schema/checklist/reference 100%，人工修改率 11.2% → auto）；手工冒烟 §2 以集成/e2e 复现：①审批通过/驳回 = `pnpm --filter @sap-superagent/testkit exec vitest run --config vitest.e2e.config.ts e2e/gates.e2e.test.ts` ②模板切换 = `pnpm --filter @sap-superagent/server exec vitest run test/templates.test.ts` ③stale 阻断 = 同 e2e gates（第 4 条） |

| 2026-11-05 | H2 认领（h2-agent，worktree `.sap-superagent-worktrees/h2`，分支 feat/h2-sap @ a9e5e98）；Phase A 开始：sap-adapter（8b850a5）→ testkit fake ICF（9cf9b1a）→ server hooks/writeback（8b6b525）→ sap:reconcile（fb3f0b8）→ 集成/e2e 测试（505c9d7）→ sap/ AFF 源文件 + `pnpm sap:check`（8a2c87f）→ docs 004/008 契约同步（ba7a943） |
| 2026-11-05 | H2 Phase A 完结自测：`pnpm check` ✅（299 tests，contract 不变）、`pnpm e2e` ✅（5/5，含 SAP 全链路 89ms，总 2.55s）、`pnpm sap:check` ✅ 离线全绿；SAP 只读诊断：`abap doctor`/`abap profile test test` TLS+auth+ADT+ICF ok，`abap deploy status` installed/outdated warning，`abap transport list` 无 open TR |
| 2026-11-05 | H2 Phase B **blocked**，未执行任何 SAP 写操作；所需人工输入：可达测试系统（只读已通）、目标 package（建议 `ZSA_SUPERAGENT`）、传输请求号、Basis SSO/ICF 服务账号配置、控制平面可达 URL 与 HMAC secret 注入方式（`ZSA_CFG` 只存引用） |
| 2026-11-05 | Lead 并行阶段：创建 `.sap-superagent-worktrees/{h1,h2}`（分支 feat/h1-gates、feat/h2-sap @ a9e5e98），启动 h1-agent、h2-agent（共享任务 task-1/task-2，写范围互斥）；基线 `pnpm check` 252 tests ✅ |
| 2026-11-05 | Lead 裁决共享文件：H1 占迁移 v3+、H2 从 v4 起步；`app.ts`/`migrations.ts`/`types.ts` 只追加 + `// --- H1/H2 ---` 标记；H2 Phase B 写操作 blocked、只读诊断可做 |
| 2026-11-05 | H1 完成（feat/h1-gates @ 238fd08）：303 tests / e2e 8/8 / eval:golden 24 cases；H2 完成 Phase A（feat/h2-sap @ 0eb35c4）：299 tests / e2e 5/5 / sap:check 5 pass；两分支均未 push |
| 2026-11-05 | Lead 集成：`integrate/h1-h2` merge `feat/h2-sap`（冲突 3 处按 §4 裁决），commit `bd37fa1` 把 SAP 审批接到 H1 门禁运行时并适配 SAP 测试/e2e；集成门禁 350 tests / e2e 9/9 / eval:golden / sap:check / build 全绿；curl 手工冒烟 G1→自动任务→G3→G4→done 通过；H1/H2 标记 done（H2 Phase B blocked） |
| 2026-11-05 | H1 落地：`feat/h1-gates` 推送 → PR #2 → CI ✅ 56s → merge commit `a510be2` 合入 main；main 树 == H1 tip（`git diff` 为空） |
| 2026-11-05 | H2 落地：`feat/h2-sap` rebase 到新 main（`--onto origin/main a9e5e98`，共享文件取集成版）+ cherry-pick 集成修复，分支树 == `integrate/h1-h2`；推送 → PR #3 → CI ✅ 58s → merge commit `a242afe` 合入 main；main 树 == `integrate/h1-h2`（`git diff` 为空），main push CI ✅ |
| 2026-11-05 | 收尾 docs PR：把「已合入 main / PR #1–#3 / CI 结果」写回 STATUS 与 HANDOFF；远端 `feat/h1-gates`、`feat/h2-sap` 分支合并后删除 |
| 2026-11-05 | 用户决策（H2 Phase B）：目标 package 用**本地包 `$ZSA`**（`$` 前缀，无 TR，对象仅测试系统生效）；全部用 **abap-cli**，**abapGit 本轮不实现**。只读核实：测试系统可达（TLS/auth/ADT/ICF ok）、`$ZSA` 存在且为空、ICF 服务版本 warning 不阻断 |
| 2026-11-05 | 起草 S3 任务书 [S3-multi-user-dispatch.md](S3-multi-user-dispatch.md)（起点盘点/交付物/e2e 覆盖/写范围/启动 Prompt）；新增 H2-B、S3 看板行；HANDOFF、docs/004、docs/006、sap/README 同步 `$ZSA` + abap-cli 决策 |
| 2026-11-05 | S3 认领（s3-agent，worktree `.sap-superagent-worktrees/s3`，分支 `feat/s3-multi-user` @ main `4805103`）；基线 `pnpm check` ✅ 350 tests；协议先行提交 `fa801f5`：docs/003（WS offered 过滤规则、transfer 语义/角色池收窄、规则 6 只约束 vscode）+ protocol（`task.transferred`、`task-transfer`、transfer schema、`DEFAULT_MAX_CONCURRENT_PER_USER=2`）+ contracts 39 schemas |
| 2026-11-05 | S3 server：core 用户并发上限 `ad49081`；WS 连接绑定 executorId + `task.offered` 资格过滤 `81f234b`（复用 claim 判定，`packages/server/test/multi-user.test.ts` 4 tests）；`POST /tasks/{id}/transfer` + 迁移 v5 审计表 `b6fb513`（`transfer.test.ts` 8 tests：旧租约失效、目标可领、事件链、幂等、全部 409 分支）；每步 `pnpm check` ✅ |
| 2026-11-05 | S3 客户端：WS 客户端/approvals API/preflight `5bf90bc`；任务箱「等待我回答」+ 实时刷新 + 工作区切换 release + claim 前 preflight `607b8fc`（vscode 67 → 97 tests；新依赖 `ws`） |
| 2026-11-05 | S3 多执行器 e2e `809390d`：新增 `packages/testkit/e2e/multi-user.e2e.test.ts`（6 tests）覆盖 009 #1/#2/#4/#5/#8/#9/#16 + 转交；`pnpm e2e` 9 → **15/15，3.91s**（<5s 预算） |
| 2026-11-05 | S3 完成自测 + docs 收尾：`pnpm check` ✅ 401 tests、`pnpm e2e` ✅ 15/15（3.91s）、`pnpm build` ✅ 8/8；docs/003/005/007、README、STATUS 同步；手工冒烟四条见「S3 验收复现」 |

## H2 Phase A 偏差与遗留（交接给 H1 / Lead / 用户）

1. **Phase A 交付**：`packages/sap-adapter`（client/mapping/signature/reconcile，31 单测）、`packages/testkit` fake ICF（6 路由 + 超时/409/401/坏 JSON 注入 + HMAC 签名投递）、`packages/server` `/hooks/sap`（HMAC ±5min、`X-SA-Delivery` 幂等、003 §4.5 五类事件 + `hook.receipt`）、`sap-writeback` worker（事件→outbox→PATCH，2s 指数退避≤5min、5 次、4xx 死信、409 重拉重放）、`sap:reconcile`、`sap/` abapGit+AFF 源文件（6 DDIC 表 / 3 类 / ICF 节点 / MIME UI / job / ABAP Unit）、`pnpm sap:check`。
2. **迁移编号**：按 Lead 裁决 H2 使用 **v4**（`sap-deliveries`/`sap_sync_state`/`sap_integration_state` + outbox `last_error/sent_at`），H1 占 v3+；仅追加，未改 v1/v2。集成时若与 H1 冲突由 Lead 重排。
3. **共享文件只做加法**：`http/app.ts`（一行注册 + import）、`types.ts`（`ServerContext.sap?` + import）、`server.ts`（env 解析 + worker 启停 + ctx 字段，均在 `// --- H2 ---` 注释块内）、`db/migrations.ts`（v4 一条）。`config.ts`/`routes/*`/`route-utils.ts` 未改；写回 outbox 由 worker 扫描事件表生成，而不是改 `publish()`。
4. **未改 packages/protocol**：入站 webhook 投递幂等记录放新表 `sap_deliveries`；事件类型沿用协议既有枚举（`demand.created/updated/cancelled`、`artifact.*`、`stage.*`、`approval.decided`）。`contracts/` 无 diff（27/5/19 不变）。
5. **门禁语义 H2 临时实现**：`artifact.approved/rejected` 从 SAP 回来后，若阶段 `waiting_human` → done + 推进下一阶段；`rejected` 把阶段重开为新 attempt（H0 状态机 `done` 终态，这里按 H1 合并前的临时行为绕过）；下一阶段输入工件不齐时按人工 override 强制 ready。H1 合并后应由其审批/门禁运行时替换（代码内已标 `H1 owns the final gate semantics`）。
6. **对账**：`sap:reconcile` 用 `CHANGED_AT` 游标只读对比；因未持久化"上次投影状态"，优先用反向状态映射判断差异（可能把"审批中"与"开发中"这类同源 in_progress 情况视为一致），差异报告不自动修复。
7. **SAP 侧未经真机语法检查**：Phase B blocked，ABAP 源文件只经过 `abap validate:aff`（JSON/companion）与 `abap check content`（离线结构校验）；`cl_abap_hmac`/`/ui2/cl_json`/`cl_system_uuid`/`cl_mime_repository_api` 等 API 需在目标 release 的 `abap check syntax` + ABAP Unit 中复核（`sap/README.md` §Phase B）。`ZSA_DEMAND` 新增 `VERSION` 字段用于 `If-Match`（已补 docs/004 §2/§2.2）。
8. **HMAC 密钥引用**：`ZSA_CFG` 只存 `CONTROL_PLANE_URL` 与 `HMAC_SECRET_REF`；具体 SSF/`CL_ABAP_SEC` 注入方式留待 Phase B 由 Basis 确认（`ZCL_ZSA_EVENT_PUSH=>hmac_secret` 有 TODO 说明）。
9. **e2e 与模板耦合（集成提醒）**：`packages/testkit/e2e/sap.e2e.test.ts` 当前基于 H0 两阶段 `default` 模板断言（AI 阶段自动 done、dev 阶段自动 ready、手建任务入通用箱）。H1 的三阶段 + 门禁模板合并后需要适配；Lead 已确认由其裁决集成适配，本分支以自身基线跑绿为准。
10. **未做的可选项**：审批到期提醒 job（任务书标注"可后置"）；`GET /hooks` 通用管理面与 replay（008 §6 属 S4，本任务仅 SAP 一条 + `/hooks/sap/status`）；SAP 侧对 `If-Match` 的 ETag 变体（真实系统用 `VERSION`）。

## Lead 集成验收（H1+H2）

- **基线决策**：H1/H2 分支从 H0 基线 `a9e5e98` 开出（交接文档 §0.1 备选方案）；H0 由 PR #1 合入 `main`（`de173f2`）后，H1/H2 分别以 PR #2/#3 合入。集成分支 `integrate/h1-h2` 用于合并验收。
- **worktree 隔离**：`.sap-superagent-worktrees/h1`（feat/h1-gates）、`.sap-superagent-worktrees/h2`（feat/h2-sap）、`.sap-superagent-worktrees/integration`（integrate/h1-h2）；两个执行 Agent 全程未共用工作目录、未 push、未动 main。
- **合并与冲突裁决**：`feat/h2-sap` merge 进 `integrate/h1-h2`，冲突 3 处：`packages/server/src/db/migrations.ts`（H1 v3 在前、H2 v4 在后，v1/v2 未动）、`packages/server/src/http/app.ts`（H1 三组路由 + H2 `registerSapRoutes` 并存）、`handoffs/STATUS.md`（两行/两段日志/两节偏差合并）；`types.ts`/`server.ts` 自动合并。
- **语义集成修复**（commit `bd37fa1`）：SAP `artifact.approved/rejected` 不再走 H2 临时门禁逻辑，改为解析绑定 `(artifactId, artifactVersion)` 的 H1 pending Approval，调用 `decideApprovalApprove/decideApprovalReject`（已决门禁重复投递为幂等 no-op）；删除 H2 重复的审批 SQL / 阶段推进片段与重复迁移假设；SAP 集成测试与 e2e 适配 3 阶段 + 门禁模板（G1 停在 waiting_human、SAP 决策推进、驳回开新 attempt、409 重拉重放按新语义断言）。`contracts/` 合并后仍为 36 schemas / 5 examples / 19 routes（H2 未改 protocol）。
- **集成门禁**（`integrate/h1-h2` @ `bd37fa1` + 本节收尾提交）：
  - `pnpm install --frozen-lockfile` ✅（合并后 lockfile 一致）
  - `pnpm check` ✅ **350 tests**（protocol 51 / ai 28 / core 51 / vscode 67 / server 55 / testkit 23 / cli 44 / sap-adapter 31）+ typecheck 9 包 + eslint + contract check
  - `pnpm e2e` ✅ **9/9**（H0 #1/#2/#3/#10 四条 + H1 审批通过/驳回/超时/stale 四条 + H2 SAP Phase A 全链路一条；进程内 fake ICF，3.05s）
  - `pnpm eval:golden` ✅ 24 cases：schema/checklist/reference 100%，人工修改率 11.2% → auto 建议
  - `pnpm sap:check` ✅ 5 pass / 1 skip（AFF `abap validate:aff` 17/17、`abap check content` 6 文件、无凭据/地址/TR；syntax 按设计离线跳过）
  - `pnpm build` ✅ 8/8
  - **curl 手工冒烟** ✅：healthz → `GET /templates`（default 3 阶段/3 门禁、pdo 6 阶段/5 门禁）→ 建 default Demand → G1 前停 `waiting_human`（工件 `in_review`、Approval 绑定 v1）→ `GET /approvals?assignee=me` → approve G1（重复决策 409）→ 自动生成 vscode 任务（`requiredRoles=["developer"]`，context.md 614 字符）→ 注册/心跳/claim → 提交 `code_change` 工件 → complete → G3 approve → G4 approve → demand `done`（3 个工件 approved，事件链完整）→ 通知 6 条未读 → 另建 pdo Demand 6 阶段且原 default Demand 不受影响。
- **落地（已合入 main）**：PR #1 H0 → `de173f2`；PR #2 H1 → `a510be2`（CI ✅ 56s）；PR #3 H2 → `a242afe`（CI ✅ 58s）。H2 在 H1 合入后 rebase 到新 main 并包含集成修复 `4e105c1`，合入后 **`main` 树与 `integrate/h1-h2` 完全一致**（`git diff` 为空）；main 的 push CI 全绿。本地 `integrate/h1-h2` 保留为交付对照，远端 `feat/h1-gates`/`feat/h2-sap` 合并后删除（`feat/h0-walking-skeleton` 属 PR #1，留待用户处理）。
- **待用户/人工输入（H2-B 剩余项）**：控制平面可被测试系统访问的部署/隧道、HMAC secret 注入方式、Basis SSO/ICF 服务账号；`package` 已解决（本地包 `$ZSA`，无 TR）。真实 VSCode Extension Host 冒烟仍留发布前。


## S3 偏差与遗留（交接给 Lead / 用户）

1. **transfer 语义（保守，符合 HANDOFF 不变式 #4）**：转交 = 结束当前 assignment + 回池 + `lastHolderUserIds` 降权 + `task.transferred` 审计事件；`targetUserId` 只是审计/可见性提示，**不锁定**目标（任务仍按 docs/003 §3 规则可领）。`targetRole` 是显式收窄：`requiredRoles` 非空时目标角色必须已在其中（否则 409）；为空（原本不限角色）时允许收窄并在事件记录 `previousRequiredRoles`——这是 transfer 的显式语义，已文档化并有测试。
2. **`maxConcurrentPerUser` 只约束 vscode 人工任务**（server-ai 系统执行器按每执行器 `maxConcurrent`）；默认值从 protocol 旧常量 5 改为任务书要求的 2（该常量 H0 起未被使用，无既有语义变化）；`ServerOptions.maxConcurrentPerUser` 可在测试/部署注入（e2e 未注入，只验证默认 2）。
3. **WS 过滤为每帧实时计算**（连接数 × 任务数），M1 规模（几十任务/几人）足够；M2 若任务量级增大需要索引或缓存资格结果（未做，避免过度设计）。
4. **客户端 preflight 失败 = 阻止领取/开始**并逐条给下一步动作；**未新增任务级 `waiting_human` 状态**（docs/003 §2.3 任务状态机无此状态，只有 StageRun 有），任务留在池中给其他执行器。与任务书 §1.4 "任务转 waiting_human" 的措辞有偏差，已在 docs/005 §2.5 按实现口径写明；若 Lead 要求严格一致，需要新增任务状态/端点（未做）。
5. **未跑真机 VSCode Extension Host / VSIX**（与 H0/H1 一致）：客户端用 mock `vscode` 单测（97 tests），WS 客户端用 fake socket 单测；真实 `ws` 连接只在 server 集成测试中由 `ws` 服务端+probe 验证。发布前仍需要真机冒烟。
6. **`task.offered` 不持久化**（协议既有语义）：断线重连不重放该帧，靠心跳 `offers` / `GET /tasks` / 事件补拉补齐；测试已覆盖"重连后推拉一致"。
7. **客户端命令数**：保持 6 个命令面板命令；审批/通知用 2 个**上下文动作**（只在任务箱行上触发，不进面板），docs/005 §2.2 已同步。
8. **任务箱审批行**只有 `gateKey + requiredRole + 需求短号 + 工件版本`（Approval schema 无需求标题/工件摘要）；如需更丰富展示需服务端补只读聚合字段（未做）。
9. **迁移 v5** 只追加 `task_transfers` 审计表，未改 v1–v4；`task.transferred` 事件类型进入协议枚举 → contracts diff（39 schemas）；无破坏性变更。
10. **未 push、未合入 main**（按任务书约束）；`packages/server/test/ws-helpers.ts` 为抽取的测试工具（原 websocket.test 局部 helper），非生产代码。
11. **e2e 用 fake executor**（testkit），不启动真实 VSCode；多执行器 e2e 每用例独立控制平面（临时 stateDir），总时长 3.91s（基线 9/9 约 3.1s，<5s 预算）。

### S3 验收复现（任务书 §2 手工冒烟，用集成/e2e 复现并记录命令）

| # | 冒烟项 | 复现命令 | 实际输出 |
| --- | --- | --- | --- |
| 1 | 两个执行器同时在线：只有合格者收到 `task.offered`，claim 互斥（一个成功一个 409） | `pnpm --filter @sap-superagent/server exec vitest run test/multi-user.test.ts`；`pnpm --filter @sap-superagent/testkit exec vitest run --config vitest.e2e.config.ts e2e/multi-user.e2e.test.ts -t "general inbox"` | multi-user ✅ 4 tests（WS 过滤/offline+paused 不推送/推拉一致/用户并发）；e2e ✅ #16/#1 用例通过 |
| 2 | 任务转交：原 holder lease 失效、目标可见可领、事件时间线完整 | `pnpm --filter @sap-superagent/server exec vitest run test/transfer.test.ts`；`pnpm --filter @sap-superagent/testkit exec vitest run --config vitest.e2e.config.ts e2e/multi-user.e2e.test.ts -t "transfers a held task"` | transfer ✅ 8 tests（lease 失效/目标可领/事件链/幂等/409）；e2e ✅ 转交用例通过 |
| 3 | 切换工作目录：立即 release 回池，3 秒内出现在另一合格执行器任务箱 | `pnpm --filter @sap-superagent/testkit exec vitest run --config vitest.e2e.config.ts e2e/multi-user.e2e.test.ts -t "workspace switch"`；`pnpm --filter sap-superagent-vscode exec vitest run test/extension.test.ts -t "workspace folder changes"` | e2e ✅（release 后 `offers` 出现并 claim 成功）；客户端单测 ✅（切换目录触发 `POST /tasks/{id}/release` 并提示已释放） |
| 4 | 审批组：G1 审批出现在「等待我回答」，通过后消失并刷新状态栏 | `pnpm --filter sap-superagent-vscode exec vitest run test/extension.test.ts -t "等待我回答"`；`pnpm --filter @sap-superagent/server exec vitest run test/gates.test.ts` | vscode ✅（审批/通知行、决策/已读动作、状态栏计数、WS 实时刷新）；server gates ✅ 13 tests（审批/驳回/超时/stale） |
