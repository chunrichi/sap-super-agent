# Handoff 状态看板

> 执行 Agent 每完成一个子项就更新本表，只改自己的行；状态：`todo` → `in_progress` → `review` → `done` / `blocked`。
> 分支名与提交哈希填实际值；"验证"写已跑过的命令与结果（例如 `pnpm check ✅`）。

| ID | 任务书 | 状态 | Owner | 分支 | 最近提交 | 验证 | 备注 / 偏差 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| H0 | [H0-walking-skeleton.md](H0-walking-skeleton.md) | done | lead（协作者 svc-server：server/ai；svc-clients：cli/vscode；verifier：只读验收三轮，最终 YES） | feat/h0-walking-skeleton | d03dc29（代码完结于 8b97215） | `pnpm install --frozen-lockfile` ✅；`pnpm check` ✅（8 包 typecheck + eslint + **252** 单测/集成 + contract 快照 27 schemas / 5 examples / 19 routes）；`pnpm e2e` ✅（4/4，多轮运行无 flake）；`pnpm build` ✅（8/8）；H0 §2 手工冒烟 ✅（healthz → 建需求 → AI 工件 → 手建任务 → 注册/心跳/领取/上下文/工件/完成 → 事件时间线 → SIGINT 优雅退出） | 完成；偏差与遗留见下节 |
| H1 | [H1-gates-and-templates.md](H1-gates-and-templates.md) | todo | 待认领 | — | — | — | H0 已完成，依赖满足，可认领：审批/门禁、3 阶段与 PDO 模板、checklist、工件 stale/版本、golden set。**执行交接见 [H1-H2-execution-handoff.md](H1-H2-execution-handoff.md)**（§2、§4、§6 启动 Prompt） |
| H2 | [H2-sap-icf-mime.md](H2-sap-icf-mime.md) | todo | 待认领 | — | — | — | H0 已完成；协议已冻结，DDIC/ICF/MIME 前端可先行；联调需本任务实现 `/hooks/sap` 与 `packages/sap-adapter`。**执行交接见 [H1-H2-execution-handoff.md](H1-H2-execution-handoff.md)**（§3、§4、§6 启动 Prompt；先用 abap-cli skill，只连测试系统） |

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
