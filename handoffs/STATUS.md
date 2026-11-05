# Handoff 状态看板

> 执行 Agent 每完成一个子项就更新本表，只改自己的行；状态：`todo` → `in_progress` → `review` → `done` / `blocked`。
> 分支名与提交哈希填实际值；"验证"写已跑过的命令与结果（例如 `pnpm check ✅`）。

| ID | 任务书 | 状态 | Owner | 分支 | 最近提交 | 验证 | 备注 / 偏差 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| H0 | [H0-walking-skeleton.md](H0-walking-skeleton.md) | done | lead（协作者 svc-server：server/ai；svc-clients：cli/vscode；verifier：只读验收三轮，最终 YES） | feat/h0-walking-skeleton | d03dc29（代码完结于 8b97215） | `pnpm install --frozen-lockfile` ✅；`pnpm check` ✅（8 包 typecheck + eslint + **252** 单测/集成 + contract 快照 27 schemas / 5 examples / 19 routes）；`pnpm e2e` ✅（4/4，多轮运行无 flake）；`pnpm build` ✅（8/8）；H0 §2 手工冒烟 ✅（healthz → 建需求 → AI 工件 → 手建任务 → 注册/心跳/领取/上下文/工件/完成 → 事件时间线 → SIGINT 优雅退出） | 完成；偏差与遗留见下节 |
| H1 | [H1-gates-and-templates.md](H1-gates-and-templates.md) | done | h1-agent（worktree `.sap-superagent-worktrees/h1`；Lead 集成验收） | feat/h1-gates | 238fd08 | 分支自测：`pnpm check` ✅ 303 tests、`pnpm e2e` ✅ 8/8、`pnpm eval:golden` ✅ 24 cases（schema/checklist/reference 100%，人工修改率 11.2% → auto）；集成验收（integrate/h1-h2）：`pnpm check` ✅ **350 tests**、`pnpm e2e` ✅ 9/9、`pnpm eval:golden` ✅、`pnpm sap:check` ✅、`pnpm build` ✅ 8/8、curl 手工冒烟 G1→自动任务→G3→G4→done ✅ | 任务书 §1.1–§1.7 全部落地；偏差见「H1 偏差与遗留」 |
| H2 | [H2-sap-icf-mime.md](H2-sap-icf-mime.md) | done（Phase A）；Phase B → H2-B | h2-agent（worktree `.sap-superagent-worktrees/h2`；Lead 集成验收） | feat/h2-sap | 0eb35c4 | 分支自测：`pnpm check` ✅ 299 tests、`pnpm e2e` ✅ 5/5、`pnpm sap:check` ✅ 5 pass/1 skip、`pnpm build` ✅；集成验收：SAP 链路已接到 H1 门禁运行时，e2e 9/9（含 SAP 全链路）、`pnpm sap:check` ✅；Phase B 仅只读连通，未做任何 SAP 写操作 | Phase A 交付完成；Phase B 转入 H2-B 行（用户决策 `$ZSA` + abap-cli）。偏差见「H2 Phase A 偏差与遗留」「Lead 集成验收」 |
| H2-B | [H2-sap-icf-mime.md](H2-sap-icf-mime.md)（§1.6 Phase B） | done（已合入 main，PR #7） | h2b-agent（worktree `.sap-superagent-worktrees/h2b`） | feat/h2-phase-b | 5cd1b52（AFF）/ 852afe6（bootstrap 重放）/ c867cfc（类修复）/ a074824（docs+STATUS） | 测试系统（profile=test）：`$ZSA` 已创建（TDEVC 复核）；6/6 表 active（DD02L/DD03L：INT4/TIMESTAMPL/STRG 未降级；`abap pull` 与仓库 AFF 逐字节一致）；3 类 + testclasses active（`inspect --activation` ok）+ ABAP Unit 6/6；ICF `/sap/zsa` 已建、handler=`ZCL_ZSA_HTTP_HANDLER`、无凭据探测 **401**（节点可达）；MIME `/zsa/ui` create+push uploaded=3（本地包无 TR）；`ZSA_OUTBOX_PUSH` active；`abap check syntax --all` ✅；`abap validate:aff` 18/18 ✅；`pnpm sap:check` 离线 5 pass/1 skip + `SA_SAP_CHECK_ONLINE=1` 6 pass ✅；**Lead 独立复核**：`pnpm check` 350 tests ✅、`pnpm e2e` 9/9 ✅、`abap test` 3/3+3/3 ✅、`DD03L` INT4/TIMESTAMPL/STRG ✅、`$ZSA` TDEVC PARENTCL=$TMP/DUVUNIT=LOCAL ✅、`pnpm build` ✅ | 偏差与 blocked 见「H2 Phase B 偏差与遗留」；上游缺陷 issue：<https://github.com/chunrichi/abap-cli/issues/34>；关键结论：`$ZSA` 实测不存在（`abap list` 假阴性）、DDIC 表由一次性 bootstrap 建（create TABL 缺陷）、`COMMENT`→`DECISION_COMMENT`、SICF 节点名 `ZSA`；**Lead 集成验收**：PR #7 merge `08b5cdc`，CI ✅ 45s；合入后 main 树 == H2-B 分支；本地 main 复核 check/e2e/sap:check（离线+在线）/build 全绿，`abap test` 6/6、DD03L 抽检通过 |
| S3 | [S3-multi-user-dispatch.md](S3-multi-user-dispatch.md) | done（已合入 main，PR #6） | s3-agent（worktree `.sap-superagent-worktrees/s3`） | feat/s3-multi-user | 809390d（代码完结；fa801f5 协议 → ad49081 core → 81f234b WS 过滤 → b6fb513 transfer → 5bf90bc/607b8fc 客户端 → 809390d e2e → 本次 docs/STATUS 收尾提交） | `pnpm check` ✅ **402 tests**（protocol 59 / ai 28 / core 52 / vscode 98 / server 67 / testkit 23 / cli 44 / sap-adapter 31；contract 39 schemas / 5 examples / 19 routes）；`pnpm e2e` ✅ **15/15，3.91s**（<5s）；`pnpm build` ✅ 8/8；多执行器 e2e 覆盖 009 #1/#2/#4/#5/#8/#9/#16 + 转交冒烟（手工复现见「S3 验收复现」） | WS `task.offered` 按执行器资格过滤（连接绑定 executorId，user/admin 不收）、`maxConcurrentPerUser`（默认 2，仅 vscode）、`POST /tasks/{id}/transfer`（迁移 v5 审计、回池 + 事件链、幂等、409）、客户端 WS 实时/退避重连/lastSeq(globalState)/resync 全量拉取、任务箱「等待我回答」接 H1 approvals/notifications、工作区切换立即 release、client preflight；偏差见「S3 偏差与遗留」；未 push、未合入 main、未跑真机 Extension Host；**Lead 集成验收**：PR #6 merge `5c27eb2`，CI ✅ 46s；合入后 main 树 == S3 分支；Lead 独立复核 check 402 tests / e2e 15/15 / build ✅ |
| S4 | [S4-hooks.md](S4-hooks.md) | done（已合入 main，PR #10） | s4-agent（lead 执行；worktree `.sap-superagent-worktrees/s4`） | feat/s4-hooks | cf395e6（代码完结；merge commit `2b0aecf` 合入 main） | `pnpm check` ✅ **440 tests**（protocol 59 / sap-adapter 31 / ai 28 / core 52 / vscode 98 / server 91 / cli 44 / testkit 37；contract 47 schemas / 7 examples / 22 routes）；`pnpm e2e` ✅ **16/16，4.08s**（<5s，新增通用 Hook 全链路）；`pnpm build` ✅ 8/8；`pnpm hooks:reconcile` ✅（无 state 时说明并退出 0；真实 state 冒烟 4 差异、`--fail-on-diff` 退出 3）；`pnpm install --frozen-lockfile --offline` ✅；**落地：PR #10 → CI ✅ 1m5s → merge commit `2b0aecf` 合入 main，main 树 == 分支树（tree `e5df148`）；main push CI ✅ 66s** | 交付见任务书 §1.1–§1.8；偏差/遗留见「S4 偏差与遗留」；任务书 §2 五条手工冒烟复现见「S4 验收复现」；已推送并合入 main，远端特性分支可删除 |
| S5 | [S5-sap-hosted-mode.md](S5-sap-hosted-mode.md) | done（**Phase A 已合入 main**，PR #13）；**Phase B 部分完成**（SAP 侧对象已激活 + ABAP Unit **15/15**），其余输入 blocked（见「S5 偏差与遗留」「S5 Phase B 进展」） | lead（Team：server-core / server-tests / testkit-e2e / abap-sap / docs-m3；Lead 契约+集成验收） | feat/s5-sap-hosted → 已合入 main | 2811cfa/e5dfe02（契约）→ 5f2c574（server）→ 464a56c（testkit+e2e）→ 4f27e11（SAP AFF）→ 5699915（docs/010/STATUS）→ **merge `1e556f0`（PR #13，CI ✅ 1m9s）**；Phase B 修复 `bd5ff61` + docs → **PR #14 merge `44b67a1`** | `pnpm install --frozen-lockfile --offline` ✅；`pnpm check` ✅ **469 tests**（protocol 59 / sap-adapter 31 / ai 28 / core 52 / vscode 98 / server 108 / cli 44 / testkit 49；contract **59 schemas / 9 examples / 27 routes**）；`pnpm e2e` ✅ **17/17，4.35s**（<5s，含 `sap-hosted` 全链路）；`pnpm build` ✅ 8/8；`pnpm sap:check` ✅ 离线 5 pass/1 skip（29 files；`validate:aff` 20/20、`check content` 10）；`SA_SAP_CHECK_ONLINE=1 pnpm sap:check` ✅ **6 pass / 0 skip**（含 `abap check syntax --all`）；`pnpm contract:check` ✅；**Phase B**：`abap test ZCL_ZSA_AI_BATCH` ✅ **15/15**、`abap pull --active` 与仓库一致 | Phase A 已合入 main（PR #13，merge `1e556f0`，main 树 == 分支树，远端特性分支已删）；Phase B 仍 blocked 输入：控制平面可达 + HMAC/服务账号、SM36/bgRFC、企业 AI 网关（SAP 侧对象部署与 ABAP Unit 已完成） |

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
| 2026-11-05 | H2-B 认领（h2b-agent，worktree `.sap-superagent-worktrees/h2b`，分支 feat/h2-phase-b @ 4805103）；预检：`abap doctor` ok、`profile test test` TLS/auth/ADT/ICF ok、`abap deploy status` installed=true 但 warning `ICF_OUTDATED_DEADLOCK`（2.6.0 vs 2.2.0，不阻断、按裁决不 deploy）、transport list 0 open TR、`abap validate:aff` 17/17。**发现 `$ZSA` 实测不存在**（`abap list --package` 对不存在的包也返回 success/count=0，假阴性；`TDEVC` 复核 rowCount=0） |
| 2026-11-05 | H2-B：`abap create DEVC '$ZSA' --package '$TMP' --package-type development --yes` 创建本地包（TDEVC：DEVCLASS=`$ZSA`/PARENTCL=`$TMP`/DLVUNIT=LOCAL）。6 张 `abap create TABL` 全部 exit 6 `DDIC_CREATE_FAILED`（EXCLASS 硬编码 '2' → 含 INT4/TIMESTAMPL 的表报 enhancement category；AFF `abap.string` 被传成 DATATYPE `STRING`→GOX 报 `STRI` 不支持；`COMMENT` 保留字）。拉取系统上部署的 `ZCL_ABAP_VIBE_ICF_DDIC`(2.6.0) 源码定位为**上游缺陷**（CLI 2.2.0 与 ICF 2.6.0 同源，deploy 无法修复）；Lead 批准 bootstrap 绕行（保持数据模型不降级），并已提 issue <https://github.com/chunrichi/abap-cli/issues/34> |
| 2026-11-05 | H2-B AFF 修复 `5cd1b52`：`abap.timestampl`→`timestampl`（rollname，DD03L 为 ROLLNAME=TIMESTAMPL/DEC21,7）、`COMMENT`→`DECISION_COMMENT`、`ZSA_EVENT_OUT.PAYLOAD` 去 NOT NULL、采用 `abap pull TABL` canonical。bootstrap `852afe6`（`sap/src/zsa_ddic_bootstrap.prog.*`，一次性）：按 ICF 相同 `GOX_GEN_TABLE_STD` 调用但传 EXCLASS（3/4）与 `DATATYPE='STRG'`；运行结果 6/6 created/active，重复运行跳过已存在表 |
| 2026-11-05 | H2-B DDIC 回验：`DD02L` 6/6 `AS4LOCAL='A'`、TABCLASS=TRANSP、CLIDEP=X、CONTFLAG 正确、EXCLASS 3/4；`DD03L` 证明未降级（VERSION/ATTEMPTS=INT4；CREATED_AT/CHANGED_AT/NEXT_AT/DECIDED_AT ROLLNAME=TIMESTAMPL；DESCRIPTION/ACCEPTANCE/PAYLOAD/DECISION_COMMENT/CFG_VALUE=STRG）；6 表 `abap pull TABL` 与仓库 `sap/src/*.tabl.{ddic,json}` **逐字节一致**（12 文件 diff 空）；TADIR 6/6 DEVCLASS=`$ZSA` |
| 2026-11-05 | H2-B 类 `c867cfc`：`abap create CLAS` + push 源码/testclasses + activate；真机最小修复（ABAP SQL strict mode 逗号列表、`UP TO` 位置、INSERT/MODIFY FROM VALUE→工作区、MANDT 列名、参数类型兼容/`escape_json` 收 `clike`、MIME `IF_MR_API` 工厂、HMAC key XSTRING + `ef_hmacstring` hex、`CL_ABAP_TSTMP` 真实秒、`RAISING cx_uuid_error`、类型声明顺序、testclasses 30 字符方法名）。`inspect --activation` 3/3 ok；ABAP Unit `ZCL_ZSA_EVENT_PUSH` 3/3 + `ZCL_ZSA_HTTP_HANDLER` 3/3 |
| 2026-11-05 | H2-B ICF/MIME/job：`abap create HTTP ZSA --file sap/src/zsa.http.json` 成功、`abap pull ZSA --type HTTP` 复核 handler=`ZCL_ZSA_HTTP_HANDLER`/`/sap/zsa/`（ICFHANDLER 绑定）；`abap mime create /zsa/ui` + `abap mime push sap/ui --root /zsa/ui --yes` uploaded=3（本地包无 TR，未触发 TR 错误）；`abap create/push PROG ZSA_OUTBOX_PUSH` active。无凭据 HTTP 探测：`/sap/zsa/api/health`、`/sap/zsa/ui/index.html` 均 **401**（节点已挂载、按设计要求登录）；health 200/SM36 属人工项 |
| 2026-11-05 | H2-B 全量校验 + Lead 独立复核：`abap check syntax --all` ✅；`abap validate:aff` 18/18 ✅；`pnpm sap:check` 离线 5 pass/1 skip ✅；`SA_SAP_CHECK_ONLINE=1 pnpm sap:check` 6 pass/0 skip ✅；Lead 侧：`pnpm check` ✅ 350 tests、`pnpm e2e` ✅ 9/9、`pnpm build` ✅、`abap test` 两人类 3/3+3/3 ✅、`abap select TDEVC/DD03L` 抽检通过。更新 `sap/README.md`、`docs/004-sap.md` 与 H2-B 行/本节日志；`scripts/sap-check.mjs` 同步 `zsa.http.json` 文件名 |
| 2026-11-05 | S3 完成自测 + docs 收尾：`pnpm check` ✅ 402 tests、`pnpm e2e` ✅ 15/15（3.88s）、`pnpm build` ✅ 8/8；docs/003/005/007、README、STATUS 同步；手工冒烟四条见「S3 验收复现」 |
| 2026-11-05 | S3 落地：`feat/s3-multi-user` 推送 → PR #6 → CI ✅ 46s → merge commit `5c27eb2` 合入 main；main 树 == S3 分支（`git diff` 为空）；Lead 独立复核 `pnpm check` 402 tests / `pnpm e2e` 15/15 / `pnpm build` 8/8 ✅ |
| 2026-11-05 | H2-B 落地：分支 rebase 到 S3 后的 main（仅 STATUS 冲突；合并 H2-B 行/日志/偏差节并追加 `a9fe230`）→ 推送 → PR #7 → CI ✅ 45s → merge commit `08b5cdc` 合入 main；main 树 == H2-B 分支；Lead 复核 `pnpm check` 402 tests / `pnpm e2e` 15/15 / `pnpm sap:check` 离线+在线 ✅ / `abap test` 6/6 / DD03L 抽检 ✅ |
| 2026-11-05 | 收尾：STATUS 记录 PR #6/#7 落地与剩余阻塞项；清理本地 worktree 与已合并的本地分支（main 为唯一工作树），远端 `feat/s3-multi-user`、`feat/h2-phase-b` 删除；S0–S3 + H2 Phase B 对象全部在 main |
| 2026-11-05 | 起草 S4 任务书 [S4-hooks.md](S4-hooks.md) + 执行交接 [S4-execution-handoff.md](S4-execution-handoff.md)：契约先行、配置/触发、出站队列（重试/死信/重放）、管理 API、回执（v6）、对账、四个占位适配器、测试/验收与可直接复制的启动 Prompt；HANDOFF 任务表/图/决策/启动 Prompt 同步；新增 S4 看板行 |
| 2026-11-05 | S4 认领（s4-agent，worktree `.sap-superagent-worktrees/s4`，分支 `feat/s4-hooks` @ main `4c15394`）；基线 `pnpm check` ✅ 402 tests（contract 39/5/19）、`pnpm e2e` ✅ 15/15（3.90s）；写范围见任务书 §4（含根 `package.json` 的 `hooks:reconcile` 命令与既有 `yaml` 依赖声明） |
| 2026-11-05 | S4 §1.1 契约冻结 `f26e2d5`：docs/003 §4.4/§4.5/§4.7 + docs/008 定稿（信封/配置/回执/重试/对账/v1 边界）+ `packages/protocol/src/hooks.ts`（hook-envelope、hooks-config、hook-receipt-body/response、hook-status、hook-replay-body/response；47 schemas / 7 examples / 22 routes）+ `examples/hooks.yaml`（全 disabled）。§1.2 配置与触发：`resolveHooksConfig`（文件缺失=全禁用；显式配置缺失/非法/enabled 无 secret 启动失败并给出改法；`env:NAME` secretRef 只在内存）、事件扫描 → `outbox(target='hook:<id>')`、需求取消/阶段退回取消未发送行、迁移 v6（`hook_state`/`hook_receipts`，未改 v1–v5）、server 装配；`packages/server` 77 tests ✅（新增 10 配置/触发测试） |
| 2026-11-05 | S4 §1.3 出站投递：独立 `HookDeliveryWorker`（不改 SAP writeback）——轮询 PENDING → HTTP POST（`content-type: application/json` + `X-SA-*` HMAC）→ 2xx 成功；5xx/429/超时指数退避（2s 起、×2、上限 5min、最多 5 次，env 可调供测试），429 尊重 `Retry-After`，4xx 立即死信；每次尝试/成功/死信写 `hook.attempted`/`hook.delivered`/`hook.dead`，发送前 `hookEnvelopeSchema` 校验（非法/未知 eventVersion 进死信）；取消语义（未发送标 CANCELLED + `hook.cancelled`）。新增 `FakeHookTarget`（进程内 HTTP 目标：记录请求/headers/envelope、HMAC 独立校验、5xx/429/4xx/timeout/坏 JSON 注入、幂等外部单、reconcileUrl 列表）与 `packages/server/src/hooks/hook-signature.ts`（同 SAP 规则、不 import sap-adapter）。测试：`packages/testkit/test/hooks-integration.test.ts` 7 ✅（成功/HMAC/5xx 退避/4xx 死信/429/timeout/未知版本/取消）+ `hook-signature.test.ts` 5 ✅ |
| 2026-11-05 | S4 §1.4 管理 API + 重放：`GET /hooks`（admin；每 Hook 的 enabled/events/outbox 深度 pending/sent/dead/cancelled/lastError/最近一次 attempted|delivered|dead 摘要）；`POST /hooks/{id}/replay`（admin + 必填 `Idempotency-Key`；按 eventId 把 DEAD/SENT/CANCELLED 行重置为 PENDING、`idempotencyKey` 不变；同一 Idempotency-Key 重复 replay 由幂等中间件返回缓存响应，不重复投递/不重复写 `hook.delivered`；新 key 显式重放已发事件会再 POST 同一 `idempotencyKey`，外部按幂等键去重、不重复建单——docs/008 §6 已写明）；根路径注册（与 `/hooks/sap` 同层）。测试：testkit 集成 10 ✅（新增 3：状态/死信 lastError/重放幂等与外部去重/重放参数校验）+ server `hook-routes.test.ts` 2 ✅（无配置空列表 + 401/403/404/400） |
| 2026-11-05 | S4 §1.5 入站回执：`POST /hooks/{target}/receipt`（无 Bearer，`X-SA-Signature`/`X-SA-Timestamp` ±5min/`X-SA-Delivery`，原始 body 验签，独立实现不 import sap-adapter）→ 迁移 v6 `hook_receipts`（`idempotency_key` UNIQUE + `delivery_id`，body 原文）→ `hook.receipt` 事件（subject `hook:<id>`；data 含 receiptId/idempotencyKey/externalId/status/deliveryId/duplicate/linked）；重复 idempotencyKey 或重复 `X-SA-Delivery` 返回 `duplicate:true` 不重复写事件；未知 externalId 只记录（`linked:false`）；未知 target 404、坏签名/过期时间窗 401、坏 JSON/body 400。v1 只记录不推进阶段（`advanceOnReceipt` 配置被启动校验拒绝），docs/008 §4 已写明。测试：testkit 集成 13 ✅（新增 3：回执落库+事件+幂等、验签/时间窗/未知 target/坏 body、未知 externalId 不推进阶段） |
| 2026-11-05 | S4 §1.6 对账：`scripts/hooks-reconcile.mjs` + 根命令 `pnpm hooks:reconcile` + `packages/server/src/hooks-reconcile.ts`（只读；`--state-dir`/`--config`/`--sla-hours`/`--json`/`--fail-on-diff`；默认 state/config 从仓库根解析，加载根 `.env`）。核心 `hooks/reconcile.ts`：两类差异——A「外部有、控制平面无」（配置 `reconcileUrl` 时拉外部列表比对，支持数组/`{items|demands|records|issues}`，否则明确输出「无法比对」）；B「控制平面有、外部无」（delivered 超 SLA 无回执/2xx 无 externalId、死信、未知回执）。只报告不修复、不重放；有差异默认退出 0，`--fail-on-diff` 时 3；无 state 时给出「先跑 pnpm dev」说明并退出 0。测试：`hooks-reconcile.test.ts` 4 ✅（两类差异/SLA/未知回执/无法比对/拉取失败/无 hooks） |
| 2026-11-05 | S4 §1.7 占位适配器（只配置样例 + 文档，未写业务逻辑/未加依赖）：`examples/hooks/{jira,charm,confluence,teams}.yaml`（每个文件 = 可独立使用的 hooks 配置；按 docs/008 §3 注释 logical action/触发事件/payload 映射/幂等键/失败与对账/回执示例；全部 `enabled: false`）+ `examples/hooks/README.md`（启用步骤、契约链接、`reconcileUrl` 形状、映射不进核心阶段图的边界）；测试断言四个文件都能被配置加载器解析且全禁用 |
| 2026-11-05 | S4 §1.8 测试与文档：新增 e2e `packages/testkit/e2e/hooks.e2e.test.ts`（进程内单链路：需求→阶段事件→目标收到信封+HMAC 校验→注入 5xx×2 退避到成功→400 死信可见→replay（同一 idempotencyKey、同 Idempotency-Key 幂等缓存）→签名回执+重复回执幂等+过期时间窗 401→`reconcileHooks` 两类差异；覆盖 docs/009 #11 Hook 侧与任务书 §2 五条冒烟）；`pnpm e2e` 16/16；docs/007 S4 状态、docs/008 replay 幂等口径、README Hook 快速开始 + 门禁命令同步 |
| 2026-11-05 | S4 对账 CLI 收尾修正：`resolveHooksConfig` 增加只读模式（`requireSecrets: false`），`hooks:reconcile` 无需导出 secret（只读不签名/验签）；`scripts/hooks-reconcile.mjs` 直接 spawn tsx（不经 `pnpm exec`）以保留退出码 0/3/2。手工冒烟实测：真实控制平面 + FakeHookTarget 落盘 state → CLI `--sla-hours 0` 输出 4 差异（external_only 1 + dead_letter 1 + delivered_without_receipt 1 + unknown_receipt 1，外部列表 2 items compared），`--fail-on-diff` 退出 3、默认退出 0 |
| 2026-11-05 | S4 完成自测（待 Lead/用户评审）：`pnpm check` ✅ 438 tests（contract 47/7/22）、`pnpm e2e` ✅ 16/16（4.07s）、`pnpm build` ✅ 8/8、`pnpm hooks:reconcile` ✅（真实 state 冒烟 4 差异，退出码 0/3）；任务书 §2 五条冒烟以 e2e/集成 + 真实 state CLI 复现（见「S4 验收复现」）；分支 `feat/s4-hooks` 未 push、未合入 main |
| 2026-11-05 | S4 独立复核（Lead 视角）修复：发现回执幂等键跨 Hook 冲突（`hook_receipts.idempotency_key` 全局 UNIQUE + 查询未按 hook 过滤，两个集成用同一外部幂等键时第二个会被误判 `duplicate:true`）→ v6 改为 `(hook_id, idempotency_key)` 唯一 + 查询按 hook 过滤 + 回归测试（同 key 两个 hook 各自落库）；空/纯注释 hooks 配置文件按“全部禁用”处理（原报错）并加测试；`retry.deadLetter` 文档注明是目标提示字段、控制平面一律死信；测试用固定端口 9099 改为必然拒绝的 `127.0.0.1:1` 消除环境依赖。`pnpm install --frozen-lockfile --offline` ✅ |
| 2026-11-05 | S4 复核修复后最终门禁（HEAD cf395e6 + 本次 docs）：`pnpm check` ✅ 440 tests（server 91 / testkit 37）、contract 47/7/22；`pnpm e2e` ✅ 16/16（4.04s）；`pnpm build` ✅ 8/8；`pnpm hooks:reconcile` ✅；`pnpm install --frozen-lockfile --offline` ✅；分支未 push、未合入 main |
| 2026-11-05 | S4 落地：`feat/s4-hooks` 推送 → PR #10 → CI ✅ 1m5s（install --frozen-lockfile + check 440 tests + e2e 16/16）→ merge commit `2b0aecf` 合入 main；main 树 == 分支树（tree `e5df148` 相同）；main push CI ✅ 66s；docs/007、README 状态与 STATUS 行同步为 done |
| 2026-11-05 | S5 任务书就绪：S0–S4 与 H2 Phase A/B 已全部合入 main（PR #1–#11，main `36e9c75`，check 440 tests / e2e 16/16）；起草 [S5-sap-hosted-mode.md](S5-sap-hosted-mode.md)（Phase A 离线交付：契约 §4.8、v7 job 队列/租约/幂等、SAP job API（HMAC）、ABAP `ZCL_ZSA_AI_BATCH`、SAP 内审批推进、docs/010 M3 部署；Phase B 真机输入清单）与 [S5-execution-handoff.md](S5-execution-handoff.md)（可复用接口/默认决策/启动 Prompt）；HANDOFF 任务表/图/阅读顺序/决策默认值/启动 Prompt 同步，S5 行加入看板（todo/待认领） |
| 2026-11-05 | S5 认领（lead + Team：server-core / server-tests / testkit-e2e / abap-sap / docs-m3；worktree `.sap-superagent-worktrees/s5`，分支 `feat/s5-sap-hosted` @ main `f078533`）；基线 `pnpm check` ✅ 440 tests、`pnpm e2e` ✅ 16/16（4.07s）。**契约冻结** `2811cfa`：`packages/protocol/src/ai-jobs.ts`（12 schemas：job/payload/lease/claim/heartbeat/result/requeue/status）+ 4 个持久事件 `stage.ai_job.queued/claimed/completed/failed`（subject `stage_run`）+ contracts 59 schemas / 9 examples / 27 routes；`packages/ai` 加 `renderAiStageMessages`/`AI_STAGE_SYSTEM_PROMPT`（本地 provider 与 SAP job payload prompt 单源）。`e5dfe02` 契约 docs：docs/003 §4.8（生命周期/租约幂等/payload 数据边界/HMAC job API/结果校验链/事件/runner 恢复语义）+ §4.4 事件行、docs/004 §7.1 M3 边界、docs/005 §3.3 网关路径、docs/007 S5、docs/009 #17/#18 |
| 2026-11-05 | S5 §1.2 控制平面 `5f2c574`：迁移 v7 `sap_ai_jobs`（UNIQUE(stage_run_id,attempt)、lease_expiries、state+created 索引；v1–v6 未动）；`resolveSapAiBatchConfig`（`SA_SAP_AI_*` 10 项、启用缺 `SA_SAP_HOOK_SECRET` 启动失败给改法、`ServerOptions.sapAiBatch` 注入、默认关闭）；`db/sap-ai-jobs.ts` 队列/租约查询；StageRunner 委派（命中后不调本地 provider，`renderAiStageMessages` 入 job + `stage.ai_job.queued`，stage 保持 running）+ 启动恢复 + tick sweeper（租约过期回 queued 不增 attempt；maxLeaseExpiries/maxAge → `failStageAttempt` + expired；阶段取消 → cancelled）；`stage-engine` 抽出 `completeServerAiStage`（checklist/ledger/工件/门禁唯一实现，本地 AI 与 SAP result 共用）；HMAC `next/claim/heartbeat/result` + admin requeue + `/hooks/sap/status` 追加 `aiJobs`；server 集成测试 17（默认关闭/生命周期/幂等/非法输出重试/租约/重启恢复/requeue/status/取消/数据边界），server 108 tests ✅ |
| 2026-11-05 | S5 §1.4/§1.6 测试设施 `464a56c`：`FakeAiGateway`（OpenAI 兼容 `/chat/completions`，5xx/429/超时/坏 JSON/非法输出注入）+ `FakeSapAiBatch`（进程内模拟 `ZCL_ZSA_AI_BATCH`：HMAC next/claim/heartbeat/result、gateway 调用、pump/start/stop、claim 冲突/重复 result/租约过期/网关失败注入）+ 12 个假件单测（testkit 37→49）；新增 `packages/testkit/e2e/sap-hosted.e2e.test.ts`：pdo 6 阶段全链路（SAP batch 生成 intake/requirement_analysis/dev_spec/test_doc/knowledge_entry，SAP Web 审批经 `/hooks/sap`，dev 阶段 FakeExecutor 完成后注销 → 全程无 executor 在线；断言 `stage.ai_job.*` 链、本地 provider 0 调用、6 工件 approved、aiJobs 计数）；`pnpm e2e` 16→**17/17，4.17s** |
| 2026-11-05 | S5 §1.3 SAP 侧 `4f27e11`：`ZCL_ZSA_AI_BATCH`（1268 行：next→claim→企业 AI 网关 OpenAI 兼容→heartbeat 续租→result；HMAC 复用 `ZCL_ZSA_EVENT_PUSH=>signature_hex`、JSON 复用 `ZCL_ZSA_JSON`；4xx/429/5xx/超时分类与本地重试；BAL/SM37 不写正文）+ 16 个 ABAP Unit；`ZSA_AI_BATCH_RUN` SM36 入口；`ZSA_CFG` 新键（`AI_GATEWAY_URL/MODEL`、`AI_KEY_REF` 引用、`AI_TIMEOUT_MS`）；`scripts/sap-check.mjs` 清单 +5；`sap/README` S5 章节；离线 `pnpm sap:check` ✅ 5 pass/1 skip（29 files、validate:aff 20/20、check content 10）；**未连 SAP、未执行写命令/activate/check syntax** |
| 2026-11-05 | S5 §1.5 文档收尾：新建 `docs/010-m3-deployment.md`（拓扑/网络矩阵/TLS/配置与密钥/单节点部署 systemd+compose/反向代理/SQLite 备份恢复/SAP 侧 abap-cli+SM36+bgRFC 可选/数据边界/runbook/Phase A+B checklist/blocked 清单）；README 状态+M3 入口+门禁命令；`.env.example` 加 `SA_SAP_AI_*` 注释样例；docs/002/007/009 同步。**最终门禁**：`pnpm install --frozen-lockfile --offline` ✅、`pnpm check` ✅ **469 tests**、`pnpm e2e` ✅ **17/17，4.35s**、`pnpm build` ✅ 8/8、`pnpm sap:check` ✅、`pnpm contract:check` ✅ 59/9/27。分支未 push、未合入 main；Phase B 真机 blocked，未伪造证据 |
| 2026-11-05 | S5 落地（Phase A）：`feat/s5-sap-hosted` 推送 → **PR #13** → CI ✅ 1m9s → merge `1e556f0` 合入 main；main 树 == 分支树；远端特性分支已删除。**S5 Phase B 部分执行（只连测试系统）**：`abap doctor`/`profile test` ok；`$ZSA` 存在；`ZCL_ZSA_AI_BATCH`（+testclasses）与 `ZSA_AI_BATCH_RUN` create/push/activate 成功（无 TR）；`abap check syntax` 通过；首轮 `abap test` 13/15（2 个测试断言 bug：`find()` 未命中返回 `-1`）→ 修复 `bd5ff61` → **15/15**；`abap pull --active` 回拉与仓库一致；`SA_SAP_CHECK_ONLINE=1 pnpm sap:check` 6 pass。仍 blocked：控制平面可达 + HMAC/服务账号、SM36 窗口、企业 AI 网关 URL/model/key（B3–B10 未执行，未伪造） |
| 2026-11-05 | S5 Phase B 收尾落地：`fix/s5-abap-unit` 推送 → **PR #14** → CI ✅ 1m5s → merge `44b67a1` 合入 main；main 树 == 分支树；本地/远端分支已删。本分支离线门禁：`pnpm check` 469 tests、`pnpm e2e` 17/17（4.32s）、`pnpm build` 8/8、`pnpm sap:check` 离线 5 pass；`pnpm eval:golden` ✅ 24 cases（确定性 report 无 diff） |
| 2026-11-05 | CI 偶发失败修复（docs-only PR #15 暴露）：① S5 租约用例在 120ms lease 下读 live `claim_id` 有竞态 → 断言 claim 响应 + 不变 attempt；② S0 resync 用例固定 sleep/窗口假设 → 轮询到 `resync_required` 并复用其 lastSeq。`fix/ci-flaky-tests` → **PR #16** → CI ✅ 1m10s → merge `ea7dbdf`；两个文件连续 3 次 + server 全量 108 tests 绿 |

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
11. **未做的可选项**：审批到期提醒 job（任务书标注"可后置"）；`GET /hooks` 通用管理面与 replay（008 §6 属 S4，本任务仅 SAP 一条 + `/hooks/sap/status`）；SAP 侧对 `If-Match` 的 ETag 变体（真实系统用 `VERSION`）。

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
12. **e2e 用 fake executor**（testkit），不启动真实 VSCode；多执行器 e2e 每用例独立控制平面（临时 stateDir），总时长 3.91s（基线 9/9 约 3.1s，<5s 预算）。

### S3 验收复现（任务书 §2 手工冒烟，用集成/e2e 复现并记录命令）

| # | 冒烟项 | 复现命令 | 实际输出 |
| --- | --- | --- | --- |
| 1 | 两个执行器同时在线：只有合格者收到 `task.offered`，claim 互斥（一个成功一个 409） | `pnpm --filter @sap-superagent/server exec vitest run test/multi-user.test.ts`；`pnpm --filter @sap-superagent/testkit exec vitest run --config vitest.e2e.config.ts e2e/multi-user.e2e.test.ts -t "general inbox"` | multi-user ✅ 4 tests（WS 过滤/offline+paused 不推送/推拉一致/用户并发）；e2e ✅ #16/#1 用例通过 |
| 2 | 任务转交：原 holder lease 失效、目标可见可领、事件时间线完整 | `pnpm --filter @sap-superagent/server exec vitest run test/transfer.test.ts`；`pnpm --filter @sap-superagent/testkit exec vitest run --config vitest.e2e.config.ts e2e/multi-user.e2e.test.ts -t "transfers a held task"` | transfer ✅ 8 tests（lease 失效/目标可领/事件链/幂等/409）；e2e ✅ 转交用例通过 |
| 3 | 切换工作目录：立即 release 回池，3 秒内出现在另一合格执行器任务箱 | `pnpm --filter @sap-superagent/testkit exec vitest run --config vitest.e2e.config.ts e2e/multi-user.e2e.test.ts -t "workspace switch"`；`pnpm --filter sap-superagent-vscode exec vitest run test/extension.test.ts -t "workspace folder changes"` | e2e ✅（release 后 `offers` 出现并 claim 成功）；客户端单测 ✅（切换目录触发 `POST /tasks/{id}/release` 并提示已释放） |
| 4 | 审批组：G1 审批出现在「等待我回答」，通过后消失并刷新状态栏 | `pnpm --filter sap-superagent-vscode exec vitest run test/extension.test.ts -t "等待我回答"`；`pnpm --filter @sap-superagent/server exec vitest run test/gates.test.ts` | vscode ✅（审批/通知行、决策/已读动作、状态栏计数、WS 实时刷新）；server gates ✅ 13 tests（审批/驳回/超时/stale） |

## H2 Phase B 偏差与遗留（交接给 Lead / 用户）

1. **创建路径偏差（Lead 已批准）**：6 张 DDIC 表不是 `abap create TABL` 直接创建的，而是由一次性的
   `ZSA_DDIC_BOOTSTRAP`（PROG，`$ZSA`，已保留并入库）用与 ICF 服务相同的 `GOX_GEN_TABLE_STD` 调用创建。
   原因：abap-cli 2.2.0 的 `create_ddic_table` 把 `EXCLASS` 硬编码为 `'2'` 且把 AFF `abap.string` 映射为
   `DATATYPE 'STRING'`（GOX 期望 `STRG`）；部署在测试系统上的 ICF 服务 v2.6.0 同源，`abap deploy` 不能修复
   （按 Lead 裁决不升级）。上游 issue：<https://github.com/chunrichi/abap-cli/issues/34>。
2. **增强类别与注解不一致**：绕行按字段类型建成 EXCLASS 3（numeric+char）/4（deep），而仓库 AFF 注解仍是
   `@AbapCatalog.enhancement.category : #NOT_EXTENSIBLE`（该注解在 create 路径本就不生效）。工具修复后可重建为 not-extensible。
   实际类别与 `abap pull` 回读一致，字段名/类型/长度/主键均未降级。
3. **字段改名**：`ZSA_APPROVAL.COMMENT` → `DECISION_COMMENT`（`COMMENT` 是 DDIC 保留字）；对外 JSON/协议字段名仍为 `comment`。
4. **`STRING` 不能 NOT NULL**：`ZSA_EVENT_OUT.PAYLOAD` 的 DDL 去掉 `not null`（SAP 限制 >255 字符字段）。
5. **ICF 节点命名**：SICF 节点名是路径叶子 `ZSA`（服务 `/sap/zsa`），文档早期称 `ZSA_API`；AFF 文件名已改为
   `sap/src/zsa.http.json`，`scripts/sap-check.mjs` 的必需文件清单同步。`$ZSA` 本地包由 abap-cli 在 `$TMP` 下创建。
6. **验证工具陷阱（已写入 sap/README）**：`abap list --package` 对不存在的包返回 success/count=0（假阴性）、
   `abap search` 在本系统对 `$` 包对象返回空；存在性以 `TADIR` / `DD02L` / `abap pull` 为准。
7. **blocked 人工项**：① ICF `/sap/zsa/api/health` 200 与 Web 页面（Basis SSO/ICF 登录或测试服务账号）；
   ② SAP→控制平面 5 分钟入单（控制平面可被测试系统访问 + `SA_SAP_HOOK_SECRET` 注入 + `ZSA_CFG` 配置）；
   ③ 控制平面→SAP 1 分钟回写（服务账号 + `SA_SAP_BASE_URL`）；④ `ZSA_OUTBOX_PUSH` 的 SM36/bgRFC 作业调度。
8. **未做/不阻塞**：`abap deploy` 升级（裁决不升级）；abapGit（本轮不实现）。测试系统版本：`SAP_ABA 75H`（S/4HANA）。
9. **提交状态**：分支 `feat/h2-phase-b` 未 push，未直推 main；工作区 clean 后交 Lead 集成。

## Lead 集成验收（S3 + H2-B）

- **S3（PR #6，merge `5c27eb2`）**：`feat/s3-multi-user` 推送 → CI ✅ 46s → 合入 main，main 树与分支一致（`git diff` 空）。
  交付：协议（`task.transferred`/transfer schema/`maxConcurrentPerUser`）、core 用户并发、server WS `task.offered` 资格过滤 + `POST /tasks/{id}/transfer`（迁移 v5）、VSCode 客户端 WS 实时/重连/审批组、多执行器 e2e（15/15）。偏差见「S3 偏差与遗留」。
- **H2-B（PR #7，merge `08b5cdc`）**：H2-B 分支在 S3 合入后 rebase 到新 main（仅 STATUS 冲突，已合并行/日志/偏差节）；
  推送 → CI ✅ 45s → 合入 main，main 树与分支一致。交付：测试系统本地包 `$ZSA`（6 表/3 类/ICF `/sap/zsa`/MIME `/zsa/ui`/PROG，全部 active；ABAP Unit 6/6；`abap check syntax --all` 通过；离线 `sap:check` 5 pass + 在线 6 pass）。偏差见「H2 Phase B 偏差与遗留」。
- **最终门禁（main）**：`pnpm check` ✅ **402 tests** + contract 39 schemas / 5 examples / 19 routes；`pnpm e2e` ✅ **15/15**（~3.9s）；`pnpm eval:golden` ✅（24 cases，100%/100%/100%，人工修改率 11.2% → auto）；`pnpm sap:check` ✅ 离线 5 pass/1 skip；`SA_SAP_CHECK_ONLINE=1 pnpm sap:check` ✅ 6 pass/0 skip（干净 checkout 下）；`pnpm build` ✅ 8/8；SAP 只读抽检（TDEVC/DD03L/ABAP Unit）通过。
- **落地状态**：`main` = `08b5cdc`；PR #1–#7 全部合入，CI 全绿。远端特性分支已删除；本地 worktree 已清理（main 唯一工作树）。
- **剩余阻塞项（需人工/环境输入）**：① H2-B 端到端：Basis SSO/ICF 登录、控制平面可从测试系统访问 + `SA_SAP_HOOK_SECRET` 注入、控制平面→SAP 服务账号、`ZSA_OUTBOX_PUSH` 的 SM36/bgRFC 调度；② 发布前真实 VSCode Extension Host/VSIX 冒烟；③ abap-cli 上游 [issue #34](https://github.com/chunrichi/abap-cli/issues/34) 修复后可把 6 张表重建为 not-extensible（当前 EXCLASS 3/4 是绕行结果）；④ M2 规模下 WS 资格计算性能（S3 遗留，非阻塞）。
- **已知工具陷阱**（避免再次踩坑）：`abap list --package` 对不存在包返回 success/count=0（假阴性）、`abap search` 对 `$` 包对象为空；`abap check syntax --all` 会递归扫描当前目录（若仓库内还留旧 worktree 会误报，故最终验收前清理 worktree）。以上均写入 sap/README 或本节。

## S4 偏差与遗留（交接给 Lead / 用户）

1. **契约先行已按任务书执行**：`f26e2d5` 冻结 docs/003（§4.4 事件表 + §4.5 指引 + 新增 §4.7 通用 Hook 协议）与 docs/008 定稿，protocol 新增 `hookEnvelope`/`hooksConfig`/`hookReceiptBody|Response`/`hookStatus`/`hookReplayBody|Response` + `hook` subject type + 5 个 hook.* 持久事件；`contracts/` 由 `pnpm contract:gen` 重新生成（47 schemas / 7 examples / 22 routes，CI `--check` 已绿）。
2. **依赖与根配置**：未新增外部包；server 直接声明仓库既有 `yaml@2.9.1`（`packages/core` 已在用，仅补 lockfile importer），根 `package.json` 新增 `hooks:reconcile` 与 `scripts/hooks-reconcile.mjs`（任务书 §1.6 要求）。这两处根文件不在任务书 §4 列表内，属交付所必需，特此标注。
3. **路由挂根路径**：`GET /hooks`、`POST /hooks/{id}/replay`、`POST /hooks/{target}/receipt` 按任务书字面与既有 `/hooks/sap` 同层挂在服务器根路径（非 `/api/v1`）；openapi 用 path-level `servers` 标注，管理端点仍要求 admin token，回执走 HMAC 无 Bearer。
4. **replay 幂等口径（docs/008 §6 已写明）**：同一 `Idempotency-Key` 的重复 replay 由通用幂等中间件返回缓存响应，不重复投递、不重复写 `hook.delivered`；用**新 key** 显式重放已发事件会再次 POST 同一 `idempotencyKey`，外部系统按幂等键去重（e2e 断言外部单数不增），每次成功投递各记一条 `hook.delivered`。
5. **回执 v1 只记录**：落 `hook_receipts`（迁移 v6，追加）+ `hook.receipt` 事件；不回写工件 `links`、不推进阶段；`advanceOnReceipt: true` 在启动/配置加载时被拒绝并给出「改成 false 或等待 v1.1」的可执行错误（任务书默认关闭；docs/008 §4 已写）。回执丢失由对账修复、不重放创建动作。
6. **取消语义为需求级粗粒度**：`demand.cancelled` / `stage.cancelled` / `artifact.rejected` 时取消**同需求**未发送的 Hook 行并写 `hook.cancelled`；已发送保持 `SENT`（v1 不补发关闭动作）——docs/008 §5 已写明。
7. **`GET /hooks` 队列深度含 `cancelled`**：任务书要求 pending/sent/dead，本实现额外返回 `cancelled`（加法，schema `hook-status` 同时覆盖）；`lastAttempt` 由最近一条 `hook.attempted|delivered|dead` 事件推导。
8. **迁移只追加**：v6 一次建 `hook_state`（入队游标）与 `hook_receipts`；v1–v5 未改。Hook 队列复用共享 `outbox`（`target='hook:<id>'`），SAP writeback 仍只扫 `sap.writeback`，`/hooks/sap` 行为与代码未改。
9. **复核修订（v6 为分支内未发布迁移）**：回执幂等约束由全局 `idempotency_key` UNIQUE 改为 `(hook_id, idempotency_key)` 唯一并让查询按 hook 过滤（两个集成可用同一外部幂等键）；因 v6 仅存在于本分支、从未发布或产生既有库，直接修订 v6 而非新建 v7 表重建，v1–v5 仍未动。同时：空/纯注释配置按全禁用处理、`retry.deadLetter` 文档化为目标提示字段、测试去掉固定端口 9099。
10. **HMAC 三份独立实现**：SAP 路径（`sap-adapter`）保持原样；通用 Hook 在 `packages/server/src/hooks/hook-signature.ts` 内按同一规则实现（不 import sap-adapter）；testkit `FakeHookTarget` 再实现一份用于交叉校验。规则本身仍只有一套（`X-SA-Signature/Timestamp/Delivery`，±5min）。
11. **对账**：只读、无需启用 hook 的 secret（`resolveHooksConfig({requireSecrets:false})`）；`--state-dir/--config/--sla-hours/--json/--fail-on-diff`，默认 state/config 从仓库根解析（wrapper 直接 spawn tsx 以保留退出码 0/3/2）。外部列表仅支持无鉴权 GET（数组或 `items|demands|records|issues`），`reconcileUrl` 的自定义 headers/鉴权未建模（v1 边界）。
12. **测试位置**：Hook 集成测试放 `packages/testkit/test/hooks-integration.test.ts`（server 测试若 import testkit 会形成 workspace devDependency 循环），server 侧保留配置/签名/路由/对账单测；e2e 为 `packages/testkit/e2e/hooks.e2e.test.ts`（1 个用例覆盖任务书 §2 五条冒烟，总 e2e 4.04s）。
13. **未做（任务边界）**：pause/resume、管理 UI、MCP、客户端展示、真实 JIRA/CHARM/Confluence/Teams 客户端、回执推进阶段、SAP `/hooks/sap` 重构；`hook.*` 事件会进入事件日志与 WS 事件流（契约有意为之，便于运维观测）。
14. **首次启用会补发历史事件**：入队游标持久化在 `hook_state`；首次启动且尚无游标时从事件日志起点回放匹配事件（至少一次、不静默丢事件）。生产首次启用 Hook 前应评估历史事件是否需要投递（docs/008 §6 已写明）；反转此行为（默认从「现在」开始）需要额外配置项，未纳入 v1。
15. **提交状态**：分支 `feat/s4-hooks`（worktree `.sap-superagent-worktrees/s4`）已推送并经 **PR #10** 合入 main（merge `2b0aecf`，CI ✅ 1m5s；main push CI ✅ 66s；main 树 == 分支树）；无密钥/地址/`.env`/构建产物入库；远端特性分支可在收尾后删除。

### S4 验收复现（任务书 §2 手工冒烟）

| # | 冒烟项 | 复现命令 | 实际输出 |
| --- | --- | --- | --- |
| 1 | 配置 `http` 示例 → 触发阶段事件 → 目标收到 POST（信封/HMAC/`idempotencyKey`/schema 正确） | `pnpm --filter @sap-superagent/testkit exec vitest run --config vitest.e2e.config.ts e2e/hooks.e2e.test.ts`；另用真实控制平面 + FakeHookTarget 手工冒烟 | e2e ✅：`eventType=artifact.created`、`hookEnvelopeSchema` 校验通过、`x-sa-signature` 等于测试侧独立 HMAC 计算值、`x-sa-delivery`=信封 `idempotencyKey`；手工冒烟输出 `envelopeSignature=sha256=a19527…`、`envelopeDeliveryHeader=33915e…:http-example:256175…`、`hook.delivered` 事件含 externalId |
| 2 | 500×2 再 200：可见退避重试与 `hook.attempted`；400：`GET /hooks` 看到死信与 `lastError` | e2e hooks；`pnpm --filter @sap-superagent/testkit exec vitest run test/hooks-integration.test.ts -t "5xx"` / `-t "4xx"` | e2e ✅：`hook.attempted` 两条 error 分别为 `HTTP 500`/`HTTP 503`，随后 `hook.delivered`；集成测试 ✅：4xx 行 `status=DEAD attempts=1 lastError=HTTP 400 …`；手工冒烟 `queueDead=1、lastError="HTTP 400: {"error":"smoke bad field"}"` |
| 3 | 重放死信：目标再次收到且 `idempotencyKey` 不变；重复 replay 不重复投递/不重复建单 | e2e hooks replay 段；`hooks-integration.test.ts -t "replays a dead delivery"` | ✅ `replayed:true status="queued"`；目标最后一条 `X-SA-Delivery` = 原 `idempotencyKey`；同 `Idempotency-Key` 第二次 replay 返回缓存（响应头 `idempotent-replay: true`），目标请求数不增；新 key 重放后外部 `orders` 数仍为 1 |
| 4 | 回执：写 `hook.receipt`；重复回执幂等；未知 externalId 只记录 | e2e hooks receipt 段；`hooks-integration.test.ts -t "records a signed receipt"` / `-t "unknown externalId"` | ✅ 首次 `duplicate:false`、重复 `duplicate:true` 且同一 `receiptId`、`hook.receipt` 事件仅 1 条；未知 externalId `linked:false` 且阶段状态前后一致；过期时间窗/坏签名 401、未知 target 404、坏 body 400 |
| 5 | `pnpm hooks:reconcile` 输出两类差异（或明确说明无法拉取外部列表） | 真实 state（手工冒烟落盘）+ 本地外部列表：`pnpm hooks:reconcile --state-dir <tmp> --config <tmp>/hooks.yaml --sla-hours 0` | ✅ 输出 4 条差异：`external_only` 1（`EXT-ORPHAN`；`external http-example: 2 item(s) compared`）+ `dead_letter` 1 + `delivered_without_receipt` 1（`EXT-2`）+ `unknown_receipt` 1（`EXT-GHOST`）；默认退出 0，`--fail-on-diff` 退出 3；无 state 时输出 `no control-plane state … 5 hook(s), no differences` 退出 0；无 `reconcileUrl` 时输出 `cannot compare (no reconcileUrl configured…)` |

> docs/009 #11（Hook 5xx/4xx/重复回执）由 `hooks-integration.test.ts` + `hooks.e2e.test.ts` 覆盖；#12（SAP 回写 409）沿用 H2 e2e，未改动。


## S5 偏差与遗留（交接给 Lead / 用户）

1. **Phase A 交付（任务书 §1.1–§1.6 全部落地）**：契约（docs/003 §4.8 + `packages/protocol/src/ai-jobs.ts` 12 schemas + 4 个 `stage.ai_job.*` 持久事件 + contracts 59 schemas / 9 examples / 27 routes）；控制平面（迁移 v7 `sap_ai_jobs`、job 队列/租约/幂等、`SA_SAP_AI_BATCH` 等配置、StageRunner 委派不调本地 provider、启动恢复 + tick sweeper、`completeServerAiStage` 单一完成实现、HMAC job API、admin requeue、`/hooks/sap/status` 追加 `aiJobs`）；SAP 侧（`ZCL_ZSA_AI_BATCH` + 15 ABAP Unit（真机 15/15）+ `ZSA_AI_BATCH_RUN` + `ZSA_CFG` 新键 + 离线 `sap:check`）；测试设施（`FakeAiGateway`/`FakeSapAiBatch` + server 集成 17 + pdo 无 executor 全链路 e2e）；M3 部署文档（docs/010 + README + docs/002/007/009 同步）。
2. **契约与显式决策（均在 docs/003 §4.8 允许范围内，已与 docs/010 对齐）**：
   - 新增环境变量 `SA_SAP_AI_JOB_TIMEOUT_MS`（默认 120000）与 `SA_SAP_AI_JOB_MAX_LEASE_EXPIRIES`（默认 2）：任务书要求 payload 带超时/多次过期判失败，但 §1.2 未列出对应 env，独立成项写入 003 §4.8.1 与 010。
   - `X-SA-Timestamp` 容忍窗复用既有 `SA_SAP_HOOK_TOLERANCE_MS`（SAP 集成 env），不引入第二套时间窗配置。
   - **HMAC 幂等去重不新增 delivery 表**：`X-SA-Delivery` 仍为必需头；结果幂等由 job 状态机 + `(stage_run_id, attempt)` 唯一约束实现（重复 result 返回 `200 {duplicate:true, accepted:false}`，不重复写事件/工件/attempt ledger）。
   - 终态 job 保留 `claimId`（审计）、`leaseExpiresAt=null`；job `result` 只存摘要（status/error/usage/durationMs/completedAt），不存 output 正文。
   - `claim` 严格「非 queued → 409」：租约过期但 sweeper 尚未回队的 `claimed` 需等下一 tick（默认 200ms）再 claim，避免双执行。
   - payload `outputSchema` 写 `definition.outputArtifactKind`（不透明引用），ABAP 不解析；prompt 由 `renderAiStageMessages` 单源渲染（system+user）。
   - `ServerOptions.sapAiBatch` 仅用于测试/运维注入（生产通过 env）；传对象未写 `enabled` 视为启用。
   - SAP 模式启动恢复按 run 逐个判断（委派阶段保留 job/幂等补建，非委派阶段沿用 H0–S4 legacy reset），不调用全局 `recoverRunningServerAiStages`。
3. **测试覆盖**：server 集成 17（默认关闭/生命周期/HMAC/幂等/非法输出重试/租约过期与 maxAge/重启恢复/admin requeue/status/取消/数据边界，覆盖 docs/009 #17/#18）；testkit 假件单测 12（HMAC/OpenAI 兼容/故障注入）；e2e 1 条 pdo 六阶段「无任何 executor 在线 + 本地 provider 0 调用 + SAP 审批推进」全链路；既有 440 tests 全部不回归（总 469）。
4. **Phase B（真机）部分完成，剩余 blocked（未伪造证据；同 H2-B 先例）**：
   - ✅ **已完成（2026-11-05）**：测试系统可达（`abap doctor` + `abap profile test test`：TLS/auth/ADT/ICF 全 ok，只连测试系统）；`$ZSA` 本地包存在；`ZCL_ZSA_AI_BATCH` + testclasses、`ZSA_AI_BATCH_RUN` 已 `abap create/push` 并激活（无 TR）；`abap check syntax` 通过；`abap test ZCL_ZSA_AI_BATCH` **15/15**；`SA_SAP_CHECK_ONLINE=1 pnpm sap:check` **6 pass/0 skip**；`abap pull --active` 回拉与仓库源码一致（仅 CRLF/末尾换行差异）。首次真机单测暴露 2 个**测试自身**断言错误（ABAP `find()` 未命中返回 `-1`，断言误写 0）→ 修复 `bd5ff61` 后 15/15。
   - **仍 blocked（人工输入）**：控制平面可从测试系统访问（内网地址/隧道）+ `SA_SAP_HOOK_SECRET` 注入；控制平面→SAP 服务账号（ICF 回写/对账）；SM36/bgRFC 调度窗口与权限；企业 AI 网关 URL/model/key + SAP 安全存储注入方式 + 出口策略/TLS(STRUST)/ICM 网络超时；`ZSA_CFG` 业务键写入（依赖上述值）。
   Phase B 输入清单同步写入 docs/010 §9.3；B3–B10 与端到端 M3 证据需输入齐备后执行。完整命令/输出见「S5 Phase B 进展」。
5. **已知风险 / 遗留**：
   - ABAP 真机语法/激活/ABAP Unit 已通过首轮（15/15，覆盖 `cl_abap_hmac` RFC4231 向量、`/ui2/cl_json` snake_case 映射、result 报文与错误分类）；尚未覆盖 runtime 路径：`cl_http_client` 真实网络调用（连接/超时/错误响应）、BAL `ZSA/AI_BATCH` 日志（SLG0 未配置时静默跳过）、真实网关响应体——需端到端 Phase B 验证。
   - ABAP 未在代码内设置网关 HTTP 超时（沿用 `ZCL_ZSA_EVENT_PUSH` 模式，避免依赖未验证 API）；需在 ICM/SM59 配网络超时（建议 ≤ 控制平面租约 10min）。
   - SAP 批处理无并行线程，心跳为「调用前/按需」续租，单次网关调用中途不续租；由有效超时 + 控制平面 maxAge/租约 sweeper 兜底。
   - 关闭 `SA_SAP_AI_BATCH` 后残留 queued/claimed job 行不再被 sweep（docs/010 §8.6 写明运维边界：关闭前先确认无在途 job）。
   - M3 控制平面为单节点（SQLite + 本地工件目录）无 HA；批处理领取延迟受 SM36 周期约束（建议 1 分钟）。
6. **提交状态**：Phase A 分支 `feat/s5-sap-hosted` 已通过 **PR #13** 合入 main（merge `1e556f0`，CI ✅ 1m9s；main 树 == 分支树；远端特性分支已删除）；Phase B 收尾（`bd5ff61` 断言修复 + 文档/看板）经 **PR #14** 合入 main（merge `44b67a1`，CI ✅ 1m5s；main 树 == 分支树，远端/本地分支已删）。未提交密钥/地址/`.env`/构建产物；`sap/` 无真实地址（仅既有 GitHub issue 链接）；docs/003 契约与 `contracts/` 快照同步提交。

### S5 验收复现（任务书 §2 手工冒烟，用集成/e2e 复现并记录命令）

| # | 冒烟项 | 复现命令 | 实际输出 |
| --- | --- | --- | --- |
| 1 | 默认关闭回归：不设 `SA_SAP_AI_BATCH`，H0–S4 门禁全绿、行为不变 | `pnpm --filter @sap-superagent/server exec vitest run test/sap-ai-jobs.test.ts -t "default off"`；全量 `pnpm check` / `pnpm e2e` | ✅ `2 passed`（unset/`0` 两态：本地 provider 调用 1 次、job API/admin requeue/status 均 404、`sap_ai_jobs` 0 行、无 `stage.ai_job.*`）；全量 `pnpm check` 469 tests、`pnpm e2e` 17/17 绿 |
| 2 | SAP 批处理生成：`SA_SAP_AI_BATCH=1` 建 pdo Demand，无 executor 在线 → intake/requirement_analysis 由 SAP batch 生成（事件/status 计数正确） | `pnpm --filter @sap-superagent/server exec vitest run test/sap-ai-jobs.test.ts -t "enqueues, lists with a signed next"`；`pnpm --filter @sap-superagent/testkit exec vitest run --config vitest.e2e.config.ts e2e/sap-hosted.e2e.test.ts` | ✅ server 生命周期用例 1 passed（stage running + job queued + `stage.ai_job.queued{reason:dispatch}` + 签名 next/claim/heartbeat + `stage.ai_job.claimed`）；e2e 全链路 1 passed（5 个 server-ai 阶段由 FakeSapAiBatch 完成，`aiJobs={succeeded:5,…}`） |
| 3 | SAP 内审批推进：SAP Web 审批（fake webhook）→ 阶段推进；无 client 在线 | 同上 e2e（经 `POST /hooks/sap` `artifact.approved` 批准 confirm:intake/G1/G2/G4/G5，dev 阶段 FakeExecutor 注销后无 executor） | ✅ e2e 1 passed：6 工件 approved、6 门禁 approved、Demand `done`；`presence != offline` 的 executor 数在起点/注销后/结束三次均为 0 |
| 4 | 测试文档与幂等/失败：dev 完成后开发者离线 → SAP batch 生成 test_doc；注入网关超时/非法输出 → 重试到上限转 waiting_human、无半成品；重复 claim/result 幂等 | `... -t "accepts a valid result once"` / `-t "retries non-JSON"` / `-t "SAP-reported failed"`；e2e（test_doc 阶段） | ✅ 幂等用例 1 passed（重复 result `duplicate:true`，completed 事件/attempt/artifact 版本均 1）；失败用例各 1 passed（invalid_output / sap_failed → attempt+1 重试；到 maxAttempts → `waiting_human`，无 artifact 行/`artifact.created`）；e2e 中 test_doc 由 SAP batch 生成并审批 |
| 5 | M3 文档可照做：按 docs/010 在测试环境完成 CP 部署 + SAP 配置，跑通 Phase B checklist | `docs/010-m3-deployment.md`（含 Phase A checklist A1–A11、Phase B checklist B1–B10、§9.3 blocked 输入清单）；Phase B 真机输入缺失 → **blocked，未执行/未伪造** | ✅ docs/010 已交付并被 README/docs/007 链入；Phase A 离线项全部可复现（见 #1–#4 与本行）；Phase B 至今 blocked（输入清单见「S5 偏差与遗留」§4） |

## S5 Phase B 进展（2026-11-05，真机部分完成）

> 只连测试系统（profile `test`，S/4HANA `SAP_ABA 75H`）；未连生产、未自动激活生产、未提交密钥/地址/TR。测试系统可达、`abap doctor` 与 `abap profile test test` 全 ok 后执行 SAP 侧可独立完成部分；**控制平面可达/HMAC/服务账号、SM36 窗口、企业 AI 网关仍缺失 → B3–B10 未执行**。

| 步骤 | 命令 | 实际输出 |
| --- | --- | --- |
| 环境诊断（只读） | `abap doctor --json`；`abap profile test test --json` | doctor：node/tls/install/config/deps/session 全 ok；profile test：TLS ok、auth ok、ADT ok、ICF ok、DDLS source supported |
| 包存在性（只读） | `abap pull '$ZSA' --type DEVC --json` | success：`$ZSA` DEVC written（H2-B 创建的本地包，无 TR） |
| 对象存在性（只读） | `abap pull ZCL_ZSA_AI_BATCH --type CLAS`；`abap pull ZSA_AI_BATCH_RUN --type PROG` | 均 `OBJECT_NOT_FOUND`（尚未部署）→ 部署 |
| 创建类/程序 | `abap create CLAS ZCL_ZSA_AI_BATCH --package '$ZSA' --no-pull --yes`；`abap create PROG ZSA_AI_BATCH_RUN --package '$ZSA' --no-pull --yes` | 均 success（`activated:true`、`transport:""`，本地包无 TR） |
| 推送 + 激活 | `abap push sap/src/zcl_zsa_ai_batch.clas.abap sap/src/zcl_zsa_ai_batch.clas.testclasses.abap --atomic --yes`；`abap push sap/src/zsa_ai_batch_run.prog.abap --yes` | class/testclasses：`activated` stage=activate，failed 0；program：`activated`，failed 0 |
| 语法检查 | `abap check syntax sap/src/zcl_zsa_ai_batch.clas.abap sap/src/zcl_zsa_ai_batch.clas.testclasses.abap sap/src/zsa_ai_batch_run.prog.abap --json` | `failure:false`（ADT syntax check 通过） |
| ABAP Unit（首次） | `abap test ZCL_ZSA_AI_BATCH --json` | **13/15 passed，2 failed**（`GATEWAY_REQUEST_MAPPING` / `RESULT_FAILED_MAPPING`：断言期望 `find()`=0，实际 `-1`）→ 测试自身断言 bug |
| 修复 | `sap/src/zcl_zsa_ai_batch.clas.testclasses.abap` 两处断言改为 `exp = -1` 并注释（commit `bd5ff61`）；重新 `abap push` testclasses | push：`activated`，failed 0 |
| ABAP Unit（复测） | `abap test ZCL_ZSA_AI_BATCH --json` | **15 methods / 15 passed / 0 failed**（覆盖 payload/claim/网关 request/response/result、HMAC RFC4231 向量、X-SA 头、409/4xx/5xx/超时分类、租约续期、有效超时、批次上限、result 交付键幂等） |
| 回拉比对 | `abap pull ZCL_ZSA_AI_BATCH --type CLAS --include-tests --dir /tmp/phaseb-pull --overwrite`；`abap pull ZSA_AI_BATCH_RUN --type PROG --dir /tmp/phaseb-pull --overwrite`；`diff --strip-trailing-cr` | 类源码与仓库**完全一致**（仅 SAP 侧 CRLF）；testclasses/program 仅差文件末尾换行 |
| 在线离线门禁 | `SA_SAP_CHECK_ONLINE=1 pnpm sap:check` | **6 pass / 0 skip / 0 failed**（AFF 20/20、check content 10、`abap check syntax --all` passed） |

**仍 blocked（人工输入，未伪造）**：`ZSA_CFG` 业务键（`AI_GATEWAY_URL`/`AI_GATEWAY_MODEL`/`AI_TIMEOUT_MS`/`AI_KEY_REF` 及 HMAC/SM36 引用）写入；控制平面可达 + `SA_SAP_HOOK_SECRET` 注入；控制平面→SAP 服务账号；SM36/bgRFC 调度窗口；企业 AI 网关 URL/model/key + 安全存储注入 + 出口策略/TLS。就绪后可继续 docs/010 §9.2 的 B3–B10（含端到端 M3 证据）。

**真机发现（已修复）**：ABAP 内置 `find()` 未命中返回 `-1`（原单测断言误写 0，仅在真机执行才暴露）；说明 Phase A 的离线 `abap check content` 不能替代 ABAP Unit，本次已补齐真机 gate。其余真机结论：`cl_abap_hmac`、`/ui2/cl_json=>deserialize(pretty_mode-none)`、`cl_http_client`/BAL 函数调用签名在 S/4HANA `SAP_ABA 75H` 上均可编译/激活；真实网络调用与 BAL 日志运行时行为待端到端 Phase B。
