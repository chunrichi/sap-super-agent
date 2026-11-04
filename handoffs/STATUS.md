# Handoff 状态看板

> 执行 Agent 每完成一个子项就更新本表，只改自己的行；状态：`todo` → `in_progress` → `review` → `done` / `blocked`。
> 分支名与提交哈希填实际值；"验证"写已跑过的命令与结果（例如 `pnpm check ✅`）。

| ID | 任务书 | 状态 | Owner | 分支 | 最近提交 | 验证 | 备注 / 偏差 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| H0 | [H0-walking-skeleton.md](H0-walking-skeleton.md) | in_progress | lead（svc-server: server/ai；svc-clients: cli/vscode） | feat/h0-walking-skeleton | a86751e | protocol 49 单测 ✅；core 35 单测 ✅（`pnpm --filter … run test`）；全量 `pnpm check`/`pnpm e2e` 待集成后跑 | 进行中：骨架/protocol/core 已提交；server/ai、cli/vscode、testkit/e2e、contracts 并行开发 |
| H1 | [H1-gates-and-templates.md](H1-gates-and-templates.md) | blocked_by:H0 | — | — | — | — | 等 H0 的 protocol/core/server 骨架与模板 loader |
| H2 | [H2-sap-icf-mime.md](H2-sap-icf-mime.md) | blocked_by:H0 | — | — | — | — | DDIC/ICF/MIME 可在协议冻结后先行；联调等 H0 的 sap hook |

## 交接日志

| 时间 | 事件 |
| --- | --- |
| 2026-11-05 | 仓库初始化，设计与 handoff 提交；H0 待认领 |
| 2026-11-05 | Lead 认领 H0，创建 `feat/h0-walking-skeleton`；提交 pnpm workspace 骨架（ff13648）、protocol（6084e59）、core + `templates/default.yaml`（5ba1c4f） |
| 2026-11-05 | 实现时发现 docs/003 §3 依赖的 `activeWorkspaceKey` 在 §2.6 未定义：按 H0 §1.9 补 protocol 字段与 docs，提交 a86751e（加法，不改既有语义） |
| 2026-11-05 | 并行分派：`svc-server`（server+ai）、`svc-clients`（cli+vscode）；Lead 负责 testkit/e2e、contracts、CI、docs 与集成验证 |
