# Handoff 状态看板

> 执行 Agent 每完成一个子项就更新本表，只改自己的行；状态：`todo` → `in_progress` → `review` → `done` / `blocked`。
> 分支名与提交哈希填实际值；"验证"写已跑过的命令与结果（例如 `pnpm check ✅`）。

| ID | 任务书 | 状态 | Owner | 分支 | 最近提交 | 验证 | 备注 / 偏差 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| H0 | [H0-walking-skeleton.md](H0-walking-skeleton.md) | todo | — | — | — | — | 无代码起点；先建 monorepo 骨架 |
| H1 | [H1-gates-and-templates.md](H1-gates-and-templates.md) | blocked_by:H0 | — | — | — | — | 等 H0 的 protocol/core/server 骨架 |
| H2 | [H2-sap-icf-mime.md](H2-sap-icf-mime.md) | blocked_by:H0 | — | — | — | — | DDIC/ICF/MIME 可在协议冻结后先行；联调等 H0 的 sap hook |

## 交接日志

| 时间 | 事件 |
| --- | --- |
| 2026-11-05 | 仓库初始化，设计与 handoff 提交；H0 待认领 |
