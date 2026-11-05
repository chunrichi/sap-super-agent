# S5 执行交接（新 session 从这里开始）

> **读者**：接下来认领 S5（SAP 宿主受限模式 / M3）的执行 Agent。本文件补充"从哪下手、哪些可复用、默认怎么决策、怎么验收"；验收标准以 [S5-sap-hosted-mode.md](S5-sap-hosted-mode.md) 为准，契约以 [docs/003](../docs/003-domain-and-protocol.md) §4.4/§4.8 与 [docs/010](../docs/010-m3-deployment.md) 为准。
> **基线**：`main`（起草时 `36e9c75`，S0–S4 + H2 Phase A/B 全部合入）。基线门禁：`pnpm check` ✅ **440 tests**、`pnpm e2e` ✅ **16/16（~4s）**、`pnpm build` ✅ 8/8、`pnpm sap:check` 离线绿。
> **特点**：**Phase A（1.1–1.6）完全离线**，不需要 SAP 系统、不需要真实 AI 网关；**Phase B（1.7）** 才需要测试系统与企业 AI 网关，且依赖 H2-B 人工输入（控制平面可达/HMAC/服务账号/SM36）。输入缺失时交 Phase A + blocked 报告，不要伪造真机结果。

## 1. 开工（worktree 隔离）

```sh
cd /Users/lei/ai_space/sap_super_agent
git fetch origin && git switch main && git merge --ff-only origin/main
git worktree add .sap-superagent-worktrees/s5 -b feat/s5-sap-hosted main
cd .sap-superagent-worktrees/s5
pnpm install --frozen-lockfile --store-dir /Users/lei/ai_space/sap_super_agent/.pnpm-store --offline
pnpm check   # 基线应绿（440 tests）
pnpm e2e     # 基线应绿（16/16，~4s）
```

- 全程只在这个 worktree 工作；不切分支、不动仓库根、不碰其他 worktree。
- 完成后分支保留给 Lead/用户评审：**不 push、不直推 `main`、不 force push**。
- 在 `handoffs/STATUS.md` 认领 S5 行（owner / 分支 `feat/s5-sap-hosted` / 写范围）。
- Phase A 不需要 SAP；**Phase B 才连测试系统**（profile `test`），先加载 `.agents/skills/abap-cli*/SKILL.md`，执行 `abap doctor` / `abap profile test test`，**永不连生产、不自动激活生产**。

## 2. 可直接复用的接口（不要重写）

| 模块 | 位置 | 用途 |
| --- | --- | --- |
| 阶段执行骨架 | `packages/server/src/workers/stage-runner.ts`（`execute` 的 claim/事件模式、`completeStage`、`failStage`、`markWaitingHuman`） | 委派模式只替换"调用 provider"这一步；结果路径复用完成/失败语义（建议把 `completeStage` 的校验+ledger+工件+门禁抽公共函数） |
| 门禁/阶段状态机 | `packages/server/src/stage-engine.ts`（`persistStageArtifact`、`completeStageAfterArtifact`、`failStageAttempt`、`decideApprovalApprove/Reject`、`expireApproval`）与 `packages/core`（`evaluateStageCompletion`、checklist） | 结果验收、重试/转人工、SAP 审批推进，均复用 |
| AI 阶段定义 | `packages/ai/src/stages.ts`（`AI_STAGE_DEFINITIONS`、`renderAiStagePrompt`、输出 schema、`AiStageDefinition`）、`json-output.ts`（`extractJsonText`/`parseStageOutput`/`StageOutputError`）、`schema.ts`（`StageRunLedger`） | 控制平面渲染 prompt、校验 SAP 回传输出；**ABAP 不复制 AI 逻辑** |
| 事件/事务/WS | `db/events.ts`、`db/transaction.ts`（`writeTransaction` + `tx.append`）、`http/route-utils.ts#publish`、`ws/event-socket.ts` | `stage.ai_job.*` 事件与广播；事务内同时更新 job/stage/ledger |
| SAP 适配 | `packages/sap-adapter/src/signature.ts`（HMAC 头构建/验签）、`client.ts`（`SapIcfClient`）、`mapping.ts` | CP→SAP 回写/对账不变；SAP→CP job API 复用同一套 `X-SA-*` 规则 |
| SAP ABAP | `sap/src/zcl_zsa_json.clas.abap`（JSON）、`zcl_zsa_event_push.clas.abap`（outbox/HMAC/HTTP/退避写法）、`zcl_zsa_http_handler.clas.abap`（ICF 路由/回写）、`zsa_cfg.tabl.*`、`sap/README.md` | 新类/程序按同样风格；可抽公共 HMAC/HTTP 方法但**事件推送行为不变** |
| 测试设施 | `packages/testkit/src/`（`FakeIcfServer`、`FakeModelProvider`、`FakeExecutor`、`apiRequest`/`waitFor`、temp/aliases）、`packages/server/test/helpers.ts`、`packages/testkit/e2e/*`、`vitest.e2e.config.ts` | 新增 `FakeAiGateway`/`FakeSapAiBatch`；e2e 进程内、总时长 <5s |
| 契约/门禁 | `scripts/contract-gen.mjs`、`contracts/`、`scripts/sap-check.mjs`（离线/在线范式）、`scripts/e2e.mjs` | 协议变更必须 `pnpm contract:gen` 提交 diff；SAP 源文件加入 `sap:check` 清单 |
| 装配点 | `packages/server/src/{server.ts,types.ts,config.ts,http/app.ts}`、`db/migrations.ts` | 用 `// --- S5: ... ---` 追加块；迁移从 **v7** 起只追加 |
| 运维面 | `packages/server/src/hooks/sap.ts`（`/hooks/sap/status`）、`http/auth.ts`（`requireAdmin`） | 追加 `aiJobs` 计数与 admin requeue；不改 `/hooks/sap` 入站行为 |

## 3. 建议顺序（每步保持 `pnpm check` 绿）

1. **契约冻结**：docs/003 §4.4 事件 + 新增 §4.8；docs/004 §7 / docs/005 §3.3 / docs/007 更新；`docs/010-m3-deployment.md` 骨架；`packages/protocol` job/claim/heartbeat/result/status schema + 4 个 `stage.ai_job.*` 事件；`pnpm contract:gen` 提交 contracts diff。→ **立即回报 commit hash**。
2. **队列与委派**：迁移 v7 + job store；`SA_SAP_AI_BATCH` 等配置；stage-runner 命中委派时不再调用本地 provider，写 job `QUEUED` + `stage.ai_job.queued`；默认关闭回归测试。
3. **结果路径**：claim/heartbeat/result 幂等；`parseStageOutput` + checklist + ledger + 工件/门禁（抽公共完成函数）；失败/租约过期/超龄/重启恢复；admin requeue；`stage.ai_job.completed|failed`。
4. **HTTP 路由**：`/api/v1/sap/ai-jobs/{next,claim,heartbeat,result}`（HMAC）+ admin requeue + `/hooks/sap/status` 扩展 + 鉴权/幂等测试。
5. **SAP 侧 AFF**：`ZCL_ZSA_AI_BATCH` + testclasses + `ZSA_AI_BATCH_RUN` + `ZSA_CFG` 新键；`scripts/sap-check.mjs` 清单；`pnpm sap:check` 离线绿（`abap validate:aff`/`check content`）。
6. **测试补齐**：`FakeAiGateway`/`FakeSapAiBatch` + server 集成测试 + e2e（pdo 全链路、无 executor 在线、<5s）。
7. **M3 文档收尾**：docs/010 完整（拓扑/网络/配置/密钥/部署/数据边界/runbook/checklist）、README、docs 同步、STATUS 更新。
8. **Phase B（有输入才做）**：测试系统部署/激活/`abap check syntax`/ABAP Unit/`ZSA_CFG`/SM36→端到端与证据；输入缺失则记录 blocked 清单。

每完成一个子项提交（Conventional Commits + `git commit -s`），并更新 STATUS 的 S5 行 + 交接日志（只改自己的行）。

## 4. 决策默认值（不再询问，除非与 docs 冲突）

| 事项 | 默认 |
| --- | --- |
| 启用开关 | `SA_SAP_AI_BATCH=1` 启用；未设置/`0` = H0–S4 行为，完全不变 |
| 委派范围 | `SA_SAP_AI_STAGE_KEYS` 逗号白名单；缺省 = 模板内全部 `server-ai` 阶段 |
| 认证 | SAP→CP 全部 POST + `X-SA-*` HMAC（复用 `SA_SAP_HOOK_SECRET`，±5min，`X-SA-Delivery` 幂等），不走 Bearer；admin 才用 token |
| job 身份 | `(stageRunId, attempt)` 唯一；一个 attempt 一个 job；重试产生新 attempt/job |
| 迁移 | **v7** 起只追加；`sap_ai_jobs` 表 + 必要 key；不改 v1–v6 |
| 租约/超时 | claim 租约 10min（可 heartbeat 续）；`MAX_AGE` 30min 超龄判失败/转人工；批次默认 5 |
| prompt | 控制平面渲染（`renderAiStagePrompt`），SAP 只传输给网关；ABAP 不拼 prompt |
| 网关 | 默认 OpenAI 兼容 `POST <AI_GATEWAY_URL>/chat/completions`；现场可换 ABAP AI SDK（Phase B 决策）；URL/model 存 `ZSA_CFG`，key 走安全存储引用 |
| 结果校验 | 控制平面做 JSON 提取 + 输出 schema + checklist + ledger；SAP 不做业务校验 |
| 成本记账 | 网关侧计费；控制平面记录 token/耗时，`costUsd` 记 0（后续可接价格表），不伪造 Cost |
| 事件 | 新增 `stage.ai_job.queued/claimed/completed/failed`（`subject.type=stage_run`），持久事件 |
| 运维 | admin `POST /api/v1/admin/sap/ai-jobs/{id}/requeue`（幂等）；`/hooks/sap/status` 追加 `aiJobs` 计数/lastError |
| 调度 | 默认 SM36 周期 job；系统支持 bgRFC 时 Phase B 可选，不阻塞 Phase A |
| 依赖 | 不新增外部依赖（Node `fetch` / ABAP `cl_http_client` / 现有 JSON 工具） |
| 模板 | `templates/` 不改；委派由 env 决定；确需改先改 docs/003 并由 Lead 裁决 |
| 测试 | e2e 进程内、总时长 <5s；Phase A 全部用 fake；不依赖网络/SAP |
| Phase B | 输入缺失即 blocked（照 H2-B 先例）；不伪造真机结果；可拆 S5-B |

## 5. 环境与常见坑

- **端口 3080 被 DSH Web GUI 占用**：手工冒烟用 `SA_HTTP_PORT` 或 `pnpm cli dev --port <free>`；测试用端口 0/随机端口。
- `.env` 会真正加载（真实环境变量优先）；同一 state dir 单实例锁。
- TypeScript 严格模式：`exactOptionalPropertyTypes`、`noUncheckedIndexedAccess`、NodeNext（相对导入写 `.js`、`import type`）；**不要关严格性**。
- 测试不依赖 build：workspace 包经 `tsconfig.base.json` paths + `scripts/vitest-aliases.mjs` 指源码；`build` 走 dist。
- 改 protocol 后必须 `pnpm contract:gen` 并提交 `contracts/` diff（CI 是 `--check`）。
- 迁移只追加：v1–v6 不改，新迁移从 **v7** 起；共享文件追加式 + `// --- S5: ... ---`。
- e2e 保持快：进程内 fake SAP batch/AI gateway，不起外部进程、不依赖网络；总时长 <5s（当前基线 ~4.08s，新增文件要控制在 ~0.5s 内；必要时复用现有 e2e 的 server 实例）。
- **Phase A 不需要 SAP/abap-cli**：不要执行 `abap *` 写命令；只可跑 `pnpm sap:check`（离线）。
- **Phase B abap-cli / 测试系统坑（已实测，见 STATUS/sap/README）**：`abap list --package` 对不存在包假阴性、`abap search` 对 `$` 包对象为空（存在性以 TADIR/DD02L/`abap pull` 为准）；`abap create TABL` 在 2.2.0 有缺陷（上游 issue #34），DDIC 沿用一次性 bootstrap；`COMMENT` 是保留字（用 `DECISION_COMMENT`）；`STRING` 不能 NOT NULL；ICF 节点名 `ZSA`（文件 `zsa.http.json`，路径 `/sap/zsa`）；`abap deploy status` 的 warning 不阻断；`abap check syntax --all` 会递归目录（最终验收前清理 worktree）；本地包 `$ZSA` 无 TR；abap-cli 需 Node ≥24.22.1、仅 basic auth。
- **AI 网关**：开发机通常不可达；Phase A 用 `FakeAiGateway`/`FakeSapAiBatch`。绝不提交网关地址/Key/`.env`；SAP 侧 key 只存安全存储引用（`ZSA_CFG` 只存 `AI_KEY_REF`）。
- **Phase B 输入缺失**：控制平面可达/HMAC/服务账号/SM36/AI 网关任一缺失 → 记录 blocked 与所需输入，不要用假数据冒充真机验收。

## 6. 直接复制给新 session 的启动 Prompt

> 你在 `/Users/lei/ai_space/sap_super_agent` 工作。这是一个新 session，负责执行 **S5（SAP 宿主受限模式 / M3：SAP 侧批处理 AI + SAP 内审批）**。
>
> **第一步（worktree 隔离）**：
> 1. `cd /Users/lei/ai_space/sap_super_agent && git fetch origin && git switch main && git merge --ff-only origin/main`
> 2. `git worktree add .sap-superagent-worktrees/s5 -b feat/s5-sap-hosted main`
> 3. 立即 `working_directory({cd: "/Users/lei/ai_space/sap_super_agent/.sap-superagent-worktrees/s5"})`，之后所有文件/命令都在该 worktree 内；不切分支、不动仓库根、不碰其他 worktree。
> 4. `pnpm install --frozen-lockfile --store-dir /Users/lei/ai_space/sap_super_agent/.pnpm-store --offline`，然后跑基线 `pnpm check`（应绿，440 tests）与 `pnpm e2e`（应绿，16/16）。若基线不绿，先停下报告，不要继续。
>
> **然后读**：`HANDOFF.md`、`handoffs/STATUS.md`、[handoffs/S5-sap-hosted-mode.md](S5-sap-hosted-mode.md)（任务书=验收标准）、[handoffs/S5-execution-handoff.md](S5-execution-handoff.md)（本文件）、`docs/003` §4.4（事件表）与 §4.8（S5 契约，待实现）、`docs/004` §3/§7、`docs/005` §3.3、`docs/009` #15、`docs/002` §6/§7、`docs/006`、`AGENTS.md`；Phase B 再加载 `.agents/skills/abap-cli*/SKILL.md` 并读 `sap/README.md`。
>
> **认领**：在 `handoffs/STATUS.md` 的 S5 行填 owner、分支 `feat/s5-sap-hosted`、写范围（任务书 §4）。
>
> **执行要求**：
> - **Phase A 先行**（纯离线）：契约先行（docs/003 §4.8 + 事件、protocol、`pnpm contract:gen`）→ 迁移 v7 + job 队列/委派 → 结果/失败/恢复路径 → SAP job API（HMAC）→ ABAP AFF + 离线 `sap:check` → FakeAiGateway/FakeSapAiBatch + 集成/e2e → docs/010 M3 部署文档。**契约子项完成后立即回报 commit hash。**
> - 默认关闭：未设 `SA_SAP_AI_BATCH=1` 时 H0–S4 行为不变；不改 `/hooks/sap` 入站行为、不改 SAP outbox push、不改模板；不新增依赖；迁移从 v7 起只追加；共享文件追加块。
> - **Phase B（真机）只有拿到输入才做**：控制平面可从测试系统访问 + HMAC secret、服务账号、SM36/bgRFC、企业 AI 网关 URL/model/key 与安全存储注入；缺失则记录 blocked 清单并在报告说明，不要伪造。
> - 每完成一个子项提交（Conventional Commits + `git commit -s`）并更新 STATUS 的 S5 行 + 交接日志。
> - 最终自测：`pnpm check`、`pnpm e2e`（总时长 <5s）、`pnpm build`、`pnpm sap:check`、`pnpm contract:check`；用集成/e2e 复现任务书 §2 五条手工冒烟并记录实际输出。
> - 不 push、不直推 `main`、不 force push；不提交密钥/地址/`.env`。
>
> **完成时报告**：完成项、提交列表、`pnpm check`/`pnpm e2e`/`pnpm build`/`pnpm sap:check` 输出摘要、Phase A 证据（job 生命周期/幂等/失败/无 provider 调用）、Phase B 输入与证据（或 blocked）、与 docs 的偏差、遗留。完成后分支交 Lead/用户评审与 PR。

## 7. 完成定义（DoD）

1. `handoffs/S5-sap-hosted-mode.md` §1 交付物全部存在；Phase A 的 §2 验收命令全部通过（含手工冒烟以集成/e2e 复现并记录）；
2. `contracts/` 快照与协议一致（`pnpm contract:gen` diff 已提交）；
3. docs/003/004/005/007/010 与实现一致；README M3 入口可照做；
4. `handoffs/STATUS.md` 更新；报告已发出；
5. Phase B：真机证据齐全，或按 H2-B 先例记录 blocked 与所需人工输入（不得伪造）；
6. 未越过写范围、未改 H0–S4 语义、未提交禁物、未 push/直推 main。
