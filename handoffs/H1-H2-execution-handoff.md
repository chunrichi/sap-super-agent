# H1/H2 执行交接（H0 之后的下一棒）

> **读者**：接下来认领 H1（S1 门禁与模板）或 H2（S2 SAP 需求系统）的执行 Agent（可两个并行）。
> **基线**：`feat/h0-walking-skeleton` @ `d03dc29`，已推送 `origin/feat/h0-walking-skeleton`；H0（S0 walking skeleton）已完成，独立验收经多轮复核后结论 DoD met: YES。
> **目标**：完成 H1 + H2，即路线图 S1（人工确认一等公民、3/6 阶段模板、工件版本、golden set）与 S2（SAP 内需求系统：DDIC + ICF JSON + MIME Web + 事件 outbox + 回写）。
> **本文件只补充"现在从哪儿下手"**；验收标准仍以 [H1 任务书](H1-gates-and-templates.md)、[H2 任务书](H2-sap-icf-mime.md) 与 [HANDOFF §6 DoD](../HANDOFF.md) 为准。

## 0. 开工前一次性决策（Lead/人类）

1. **基线固化（推荐）**：把 `feat/h0-walking-skeleton` 以 PR / squash 合入 `main`（线性历史），然后
   `git checkout main && git pull && git checkout -b feat/h1-<slug>`；H2 同理。
   备选：直接从 `feat/h0-walking-skeleton` 开 H1/H2 分支，等 H0 合入 main 后再 rebase；**不要**在已完成的 H0 分支上继续提交，**不要** force push。
2. **并行方式**：H1、H2 可以并行，但**不要两个 Agent 共用同一个工作目录**。用独立 worktree 隔离：
   ```sh
   git worktree add ../sap-super-agent-h1 feat/h1-gates
   git worktree add ../sap-super-agent-h2 feat/h2-sap
   ```
   （H0 期间曾有另一会话在本 checkout 并行提交 demo，导致分支历史混入无关提交；用 worktree 可避免。）
3. 在 [handoffs/STATUS.md](STATUS.md) 认领行：填 owner、分支、写范围；同一时刻一人一个任务。

## 1. H0 已交付什么（可直接复用，不要重写）

**验证现状**（在基线上实测）：`pnpm install --frozen-lockfile`、`pnpm check`（8 包 typecheck + eslint + **252** 单测/集成 + contract 快照）、`pnpm e2e`（4/4，覆盖 009 #1/#2/#3/#10）、`pnpm build`（8/8）全绿；手工冒烟（需求→AI 工件→手建任务→领取→工件→完成→事件时间线）通过。

| 模块 | 可复用接口 / 关键位置 |
| --- | --- |
| `packages/protocol` | zod schema + 类型：entities / requests / events / errors / templates / 请求响应类型；`demandId`=UUID C32、控制面实体=ULID；`contractSchemas` 注册表（contracts 由此生成）；`wsTaskOfferedFrameSchema`、`wsServerControlMessageSchema` |
| `packages/core` | 状态机与断言（transitions）、调度资格 `evaluateClaimEligibility` / `rankTasks({forUserId})`、模板 `parseTemplate/validateTemplate/findStage/findGate`、上下文包 `buildTaskContextMarkdown`、阶段输入就绪判断（stage.ts） |
| `packages/server` | `startServer(options)`（`.env`、单实例锁、AI provider、WS、sweeper、stage runner 全部装配）；`createApp` 路由装配在 `src/http/app.ts`；DB 迁移 `src/db/migrations.ts`（v1+v2，**新增只追加 v3+**）；事务+事件 `writeTransaction(db, publish(ctx), fn)`；post-commit 发布器 `src/http/route-utils.ts#publish`（广播事件 + `task.offered` 传输帧）；worker 参考 `src/workers/stage-runner.ts`、`src/workers/sweepers.ts`；token `loadOrCreateStateSecret/issueToken/verifyToken`；env `resolveEnv`；锁 `StateDirLock/InstanceLockedError` |
| `packages/ai` | `ModelProvider`、`FakeModelProvider`（可脚本化响应，用于重试测试）、`createModelProviderFromEnv`、`runRequirementAnalysisStage`（prompt/zod/ledger 参考实现） |
| `packages/cli` | `init/dev/token/doctor`；`program.ts` 增命令；`startDevServer` 可注入 |
| `packages/clients/vscode` | `ControlPlaneClient`（REST 封装、错误映射）、任务箱/心跳/上下文包/SecretStorage；H1 的"等待我回答"分组目前为空，接审批即可 |
| `packages/testkit` | `FakeExecutor`、`InMemoryRepository/InMemoryEventLog`、fake SAP 占位、`apiRequest/waitFor` |
| 测试范式 | 服务端集成测试 `packages/server/test/helpers.ts`（临时 state dir + 随机端口 + fake AI）；e2e `packages/testkit/e2e/`（单 fork、<3s） |
| 已知 H0 偏差/handover | 见 [STATUS.md](STATUS.md) 的"H0 偏差与遗留"（模板最小、checklist/审批未实现、`task.offered` 广播未过滤、工件只收 base64 等） |

**扩展点的当前形态（H1/H2 必须改的）：**
- `stage-runner.ts` 目前**硬编码** `requirement_analysis`（直接 import `runRequirementAnalysisStage`）。H1 必须改成按模板 `stage.key`/`executorKind` 的 **AI 阶段注册表**，新增 `dev_spec`/`test_doc`/`knowledge_entry` 阶段。
- 审批：协议 schema、`approvals` 表、core 状态机都已存在，但**没有 API/运行时**（H1 才接）。`GET /approvals`、`POST /approvals/{id}/decisions` 与门禁推进都在 H1。
- `packages/server/src/hooks/` 与 `workers/sap-*`、`packages/sap-adapter`、`sap/` 尚不存在（H2 创建）。
- 根脚本 `eval:golden`、`sap:check` 已声明但脚本文件未实现（分别由 H1/H2 交付）。

## 2. H1 — 门禁与模板（S1）

**任务书**：[H1-gates-and-templates.md](H1-gates-and-templates.md)（逐项交付物/验收/冒烟）。**规格**：docs/003 §2.2/2.4/2.5/2.7、docs/005 §3/§4、docs/009 #13/#14/#15。
**写范围**：`packages/core/**`、`packages/server/**`（避开 `src/hooks/` 与 `workers/sap-*`）、`packages/ai/**`、`templates/**`、`evals/**`、`scripts/eval-golden.mjs`；跨包契约先改 `packages/protocol` + docs/003。
**建议顺序（每步保持 `pnpm check` 绿）：**
1. **模板系统**：按 003 §2.7 扩展 schema（如需 `autonomy` 等新字段，先改 protocol+docs）；`templates/default.yaml` 扩成 3 阶段（需求分析 G1/consultant → 开发实现 G3/consultant+developer → 验收归档 G4/requester），新增 `templates/pdo.yaml` 6 阶段（门禁 G1–G5）；server 启动加载/校验全部模板，`GET /templates`、`POST /admin/demands` 指定模板；Demand 固定 `templateId+version`，新版本只影响新 Demand。
2. **Approval/Gate**：迁移 v3 起追加（`approvals` 表已存在但按需补列）；StageRun 到门禁 → `waiting_human`；`GET /approvals?assignee=me`、`POST /approvals/{id}/decisions`（approve/reject，终态 409 幂等）；到期 job 加进 sweeper（timeoutDays）；`approval.requested/decided` 事件与通知记录。
3. **checklist + 阶段完成判定**：新增 `packages/core/src/checklist.ts` 断言注册表（`sections_present`/`inputs_referenced`/`not_stale`/`acceptance_covered`），server 阶段完成 = schema + checklist；不通过 → attempt+1 或 `waiting_human`。
4. **工件版本/supersede/stale**：新版本创建时旧版本 `superseded`；Approval 绑定 `(artifactId,version)`；退回产生新 attempt/新版本；上游新版本 → 下游 `stale` 阻断并体现在 `GET /demands/{id}` 与门禁展示。
5. **autonomy（auto/observe）**：模板字段 + stage runner 行为（observe 产出 draft 停 `waiting_human`；auto 按门禁推进）。
6. **golden set**：`evals/golden/*.json` 20–30 条脱敏夹具；`scripts/eval-golden.mjs` + `pnpm eval:golden`；`evals/thresholds.json`（人工修改率 <15% → auto 建议）；fake provider 下稳定输出 `evals/report.json`。
7. **测试/文档**：覆盖 009 #13/#14/#15；e2e 增加审批通过/驳回/超时与 stale 阻断；更新 docs/003/005/007、README 与 STATUS。

**验收命令**：`pnpm check`、`pnpm e2e`（含审批流）、`pnpm eval:golden`；手工冒烟 3 条见任务书 §2。
**边界**：不改 H0 已有字段语义；不实现 SAP/Hook/MCP/M3/细粒度权限；模板是配置不是代码分支。

## 3. H2 — SAP 需求系统（S2）

**任务书**：[H2-sap-icf-mime.md](H2-sap-icf-mime.md)。**规格**：docs/004、docs/003 §4.5、docs/008、docs/009 #6/#7/#11/#12。
**写范围**：`sap/**`、`packages/sap-adapter/**`、`packages/server/src/hooks/sap*`、`packages/server/src/workers/sap-*`；需要改共享文件（`http/app.ts`、`db/migrations.ts`、`types.ts`、protocol/contracts）时与 H1 串行并在 STATUS 登记。
**SAP 侧强制流程**：先加载 `.agents/skills/abap-cli/SKILL.md`（SAP 任务不加载技能不许动手）；`abap doctor`、`abap deploy status`；**只连测试系统**（本机 `.abap.json` 有 test profile，禁止提交）；**用户决策（2026-11-05）：目标 package 用本地包 `$ZSA`（无 TR，对象仅测试系统生效）；全部用 abap-cli；abapGit 本轮不实现**；不自动激活生产。
**Phase A（无 SAP 系统，CI 必过）——先做：**
1. `packages/testkit` 增 fake ICF server：需求列表/详情/创建/PATCH/审批/health 六条路由 + 故障注入（超时/409/401/坏 JSON）。
2. `packages/sap-adapter`：`client.ts`（fetch、超时/重试/错误映射）、`mapping.ts`（控制面状态 ↔ SAP `STATUS` 投影表）、`signature.ts`（HMAC `X-SA-Signature`/`X-SA-Timestamp`/`X-SA-Delivery`）、`reconcile.ts`（`CHANGED_AT` 游标差异报告）。
3. `packages/server`：`src/hooks/sap.ts`（`POST /hooks/sap`：HMAC + 幂等键 + 003 §4.5 事件类型）、`src/workers/sap-writeback.ts`（outbox 消费、2s 起指数退避至 5min、最多 5 次、死信、`If-Match` 409 重拉重放）、`scripts/sap-check.mjs` + `pnpm sap:check`、（可选）`sap:reconcile` 命令。
4. 配置：`SA_SAP_BASE_URL`、`SA_SAP_SERVICE_USER/PASSWORD`（或 token）、`SA_SAP_HOOK_SECRET`；缺失时 SAP 集成自动禁用，不影响 H0/H1。
5. 集成测试覆盖 009 #6/#7/#11/#12，并加 `abap validate:aff` 离线校验（无系统时跳过并说明）。
**Phase B（有测试系统，人工执行并记录）：** 按任务书 §1.6 用 **abap-cli** 建 DDIC（`ZSA_DEMAND/_T`、`ZSA_ARTIFACT`、`ZSA_APPROVAL`、`ZSA_EVENT_OUT`、`ZSA_CFG`）、`ZCL_ZSA_HTTP_HANDLER`/`ZCL_ZSA_JSON`/`ZCL_ZSA_EVENT_PUSH`、ICF 节点 `ZSA_API`、MIME `/zsa/ui` 三个视图、outbox 推送 job（package 一律 `$ZSA`，无 TR）；`sap/` 只维护 abap-cli AFF 可推送格式（**abapGit 本轮不实现**）；ABAP Unit 覆盖 outbox/退避/HMAC/映射/路由；验收 5 条（5 分钟入控制平面、1 分钟回写、重试不重复建单、未绑定需求进通用任务箱、SSO 页面可用）；记录对象/TR/curl/截图，不提交 SAP 地址/凭据/TR。
**验收命令**：`pnpm check`、`pnpm e2e`（Phase A 全链路）、`pnpm sap:check`；Phase B 按任务书人工验收并写入 STATUS 与最终报告。

## 4. H1/H2 并行协调规则（重要）

- **分支**：H1 用 `feat/h1-<slug>`，H2 用 `feat/h2-<slug>`；基于 H0 基线（或已合并的 main）。不直推 main、不 force push。
- **共享文件串行**：`packages/protocol/**` + `docs/003` + `contracts/**`（契约先行）、`packages/server/src/http/app.ts`（路由注册）、`packages/server/src/db/migrations.ts`（**只追加**，编号顺延；H1 先加则 H1 的编号在前）、`packages/server/src/types.ts`（ServerContext/Options 扩展）。
  - 规则：谁先改谁负责 `pnpm contract:gen` 并提交 contracts diff；另一人 merge/rebase 后重跑 `pnpm check`。
- **建议顺序**：H1 先落 protocol/模板/审批（S2 的门禁回写依赖它）；H2 Phase A（sap-adapter/fake ICF/hooks）可完全并行，H2 的 `/hooks/sap` 对 Approval 的推进在 H1 合并后再接。
- **e2e 保持快**：Phase A 的 SAP 全链路不要起外部进程，用 fake ICF + 进程内 server（参考现有 e2e）。
- 每个子项更新 STATUS（只改自己的行 + 交接日志）。

## 5. 环境与常见坑（H0 实测）

- Node `v24.22.2`、pnpm `10.17.1`；`corepack enable && pnpm install`。
- **端口 3080 被本机 DSH Web GUI 占用**：手工冒烟用 `pnpm cli dev --port <free>` 或 `SA_HTTP_PORT`；CI/e2e 用端口 0。
- `.env` 会真正加载（真实环境变量优先）；复制 `.env.example` 是安全的（默认 fake provider）。同一 state dir 只允许一个控制平面（文件锁），第二个实例会报错。
- TypeScript 严格模式：`exactOptionalPropertyTypes`、`noUncheckedIndexedAccess`、NodeNext（相对导入写 `.js`、`import type`）；**不要为了省事关掉**。
- 测试不依赖 build：workspace 包通过 `tsconfig.base.json` paths + `scripts/vitest-aliases.mjs` 指向源码；`pnpm build` 走 dist 拓扑序，两者不要混。
- `contracts/json-schema`、`contracts/examples` 是生成物：改 protocol 后跑 `pnpm contract:gen` 提交 diff；`pnpm check` 里是 `--check`。
- 事件/派发：写操作必须在 `writeTransaction` 里 append 事件；跨提交后再广播由 `publish(ctx)` 负责（并对新建/回池任务补 `task.offered` 传输帧）。
- 迁移只追加：不要改 v1/v2 SQL。
- DCO：每个提交 `git commit -s`；Conventional Commits（docs/006）；一个提交一件事。
- SAP：只连测试系统；不提交 `.abap.json`、`.env`、状态目录、TR、SAP 地址；abap-cli 2.2.0，MIME 非 TTY 需 `--yes`。

## 6. 可直接复制的启动 Prompt

### H1 Agent（S1）
> 你在 `/Users/lei/ai_space/sap_super_agent` 工作（或从 H0 基线新建的 worktree）。先读 `HANDOFF.md`、`handoffs/STATUS.md`、`handoffs/H0-walking-skeleton.md`、`handoffs/H1-gates-and-templates.md`、`handoffs/H1-H2-execution-handoff.md`，然后在 `handoffs/STATUS.md` 认领 H1。严格按任务书写范围与验收标准执行；跨包契约先改 `packages/protocol` + `docs/003` 再实现（`pnpm contract:gen`）。不要动 `sap/**`、`packages/sap-adapter`、`packages/server/src/hooks/`、`packages/server/src/workers/sap-*`（属于 H2）。每完成一个子项更新 STATUS；用 Conventional Commits + `git commit -s`；不要直推 main、不要 force push。完成时报告：完成项、`pnpm check`/`pnpm e2e`/`pnpm eval:golden` 结果、偏差、遗留。

### H2 Agent（S2）
> 你在 `/Users/lei/ai_space/sap_super_agent` 工作（或从 H0 基线新建的 worktree）。先读 `HANDOFF.md`、`handoffs/STATUS.md`、`handoffs/H0-walking-skeleton.md`、`handoffs/H2-sap-icf-mime.md`、`handoffs/H1-H2-execution-handoff.md`，然后认领 H2。**动手前必须加载 `.agents/skills/abap-cli/SKILL.md`**；只连测试系统，不提交 SAP 地址/凭据/TR。先交付 Phase A（fake ICF + `packages/sap-adapter` + `/hooks/sap` + sap writeback + `pnpm sap:check`，覆盖 009 #6/#7/#11/#12），再按任务书 §1.6 执行 Phase B：用 abap-cli 在本地包 `$ZSA`（无 TR）建对象/激活/ABAP Unit，记录对象清单、命令输出与 curl（abapGit 暂不投入）。H1 占用的文件（approvals/templates/core 集成）不要改；共享文件按交接文档 §4 串行协调。Conventional Commits + `git commit -s`；不直推 main、不 force push。完成时报告：完成项、Phase A 命令输出、Phase B 记录、偏差、遗留。

## 7. 交接状态

- H0：**done**，`feat/h0-walking-skeleton` @ `d03dc29` 已推送（`origin/feat/h0-walking-skeleton`）；工作区干净。
- H1/H2：`todo`（依赖 H0 已满足），任务书与本文档为执行入口。
- 另一会话的 demo 提交（`demo/` 等）已在 main 与 H0 分支历史中，属用户产物，无需处理。
- 建议合并方式：H0 → main 用 PR/squash；H1/H2 各自 PR。仓库默认 main 只接受 PR + CI。
