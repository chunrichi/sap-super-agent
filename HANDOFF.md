# HANDOFF — 交给执行 Agent 的任务书

> 本文件是**交接入口**。新接手的 Agent（或人）按本文顺序阅读，然后从 [handoffs/STATUS.md](handoffs/STATUS.md) 认领任务。
> 设计文档（docs/000–009）是权威规范；本文件只负责"现在做什么、按什么顺序、怎么算完成"。

## 0. 一分钟了解

- **项目**：面向 SAP 研发交付的 super-agent。需求记录在 SAP（ICF + MIME 自建 Web），编排在可移植控制平面（本地 M1 / 独立服务 M2），编码在开发者 VSCode（Copilot Chat 人机协作），重复文档由服务端 AI（BYOK）主动生成。
- **当前状态（2026-11-05）**：**H0 / S0 已完成**（`feat/h0-walking-skeleton` @ `a9e5e98`，已推送）；**H1 / S1 已完成**（`feat/h1-gates` @ `238fd08`：模板/门禁/checklist/工件版本与 stale/autonomy/golden set）；**H2 / S2 Phase A 已完成，Phase B blocked**（`feat/h2-sap` @ `0eb35c4`：fake ICF + `sap-adapter` + `/hooks/sap` + 回写 worker + `sap/` ABAP 源文件，未连接真实系统、未做 SAP 写操作）。H1+H2 已在 `integrate/h1-h2` 合并验收：`pnpm check`（**350 tests**）/ `pnpm e2e`（**9/9**）/ `pnpm eval:golden` / `pnpm sap:check` / `pnpm build` 全绿 + curl 手工冒烟通过；三个分支均**未 push**。详见 [handoffs/STATUS.md](handoffs/STATUS.md) 的「Lead 集成验收」。
- **本轮目标（已达成）**：S1（门禁与模板，H1）与 S2（SAP 需求系统，H2）——H1 全量完成；H2 Phase A（离线/CI 全链路）完成，Phase B（真实测试系统联调）等待用户提供 package/TR/Basis 配置。
- **下一棒**：先读 [handoffs/STATUS.md](handoffs/STATUS.md) 的「Lead 集成验收」与「H2 Phase A 偏差与遗留」，再按 [docs/006](docs/006-repo-and-git.md) 走 PR（H0→main 先合，再 H1/H2 或 `integrate/h1-h2`）；之后是 S3（多人在线与派发）与 H2 Phase B。执行协调与 worktree 用法见 [handoffs/H1-H2-execution-handoff.md](handoffs/H1-H2-execution-handoff.md)。

## 1. 阅读顺序

1. 本文 + [handoffs/STATUS.md](handoffs/STATUS.md)
2. [docs/000-vision.md](docs/000-vision.md) → [001-review.md](docs/001-review.md)：为什么这样做、哪些方案被拒绝
3. [docs/002-architecture.md](docs/002-architecture.md) → [003-domain-and-protocol.md](docs/003-domain-and-protocol.md)：架构与协议，写代码前必须读完
4. 任务对应文档：
   - S0/S1：[005-clients-and-ai.md](docs/005-clients-and-ai.md)、[007-roadmap.md](docs/007-roadmap.md)、[009-testing.md](docs/009-testing.md)
   - S2：[004-sap.md](docs/004-sap.md)、[008-hooks.md](docs/008-hooks.md)
5. [docs/006-repo-and-git.md](docs/006-repo-and-git.md)：目录、提交、PR 约定
6. [AGENTS.md](AGENTS.md) 与 `.agents/skills/abap-cli*/SKILL.md`（SAP 任务必须加载技能后再动手）

## 2. 不变式（任何改动都不能破坏）

1. **真相归属**：SAP 存业务对象/审批/审计；控制平面存执行态（任务/指派/租约/事件）；VSCode 存代码工作区。三者用 ID 关联，不互写真相。
2. **协议以 003 为准**。实现需要偏离时，先改 003 与 `packages/protocol`，再改代码；不得只改一侧。
3. **在线只约束人工任务**：`server-ai` 阶段 7×24 推进，不看 presence；`vscode` 任务才要求在线 + 资格 + 目录 + 租约。
4. **任务不预绑定到人**：池 + claim + lease；离线/超时回池；最近持有者降权。
5. **SAP 端走 ICF + MIME**：一个 ICF handler 同时提供 JSON API 与 MIME 静态页；不用 RAP/OData/Fiori Elements。ABAP 对象一律用 `abap-cli` 开发。
6. **认证与权限**：Web 走 ICF 登录 + SSO；控制平面用服务账号；**v1 不建模细粒度权限**（只记录操作人）。
7. **服务端 AI 走 BYOK**（OpenAI 兼容 / DeepSeek / Azure / 自部署网关）；Key 只在服务端；Copilot Chat 只做客户端协作，**不用 Chat Participant**，用 extension tools + 上下文文件 + custom agent/skill。
8. **需求不强制绑仓库**：`workspaceBinding` 可空；未绑定任务进通用任务箱，绑定的按工作区匹配。
9. **安全**：凭据可用不可见；写操作人工确认；事件不可变、工件版本不可变。
10. **开源**：Apache-2.0 + DCO（`git commit -s`）；不提交 `.env`、`.abap.json`、SAP 地址、日志、构建产物。

## 3. 任务总览

| ID | 任务书 | 目标 | 依赖 | 主要写范围 |
| --- | --- | --- | --- | --- |
| **H0** | [handoffs/H0-walking-skeleton.md](handoffs/H0-walking-skeleton.md) | S0：本地 M1 闭环（需求→AI 分析→客户端领取→工件→完成） | 无 | `packages/**`、`contracts/**`、`scripts/**`、`.github/workflows/**`、`templates/default.yaml` |
| **H1** | [handoffs/H1-gates-and-templates.md](handoffs/H1-gates-and-templates.md) | S1：门禁/审批、阶段模板、工件版本与 stale、golden set 评测 | H0 | `packages/core/**`、`packages/server/**`、`packages/ai/**`、`templates/**`、`evals/**`、`scripts/eval-golden.mjs` |
| **H2** | [handoffs/H2-sap-icf-mime.md](handoffs/H2-sap-icf-mime.md) | S2：SAP DDIC + ICF JSON + MIME Web + 事件 outbox + `sap-adapter` | H0（协议冻结；DDIC/ICF 可提前） | `sap/**`、`packages/sap-adapter/**`、`packages/server/src/hooks/sap*`、`packages/server/src/workers/sap*` |

```text
H0（done）──┬──> H1（done：feat/h1-gates）
            └──> H2（Phase A done：feat/h2-sap；Phase B blocked 等待测试系统/package/TR）
                          │
                          └──> 集成验收（integrate/h1-h2，已合并，未 push）
```

> **当前进度（2026-11-05）**：H0/H1 done；H2 Phase A done、Phase B blocked。并行采用 worktree 隔离（`.sap-superagent-worktrees/{h1,h2}`，分支 `feat/h1-gates` / `feat/h2-sap`），集成分支 `integrate/h1-h2`；门禁、冒烟与偏差详见 [handoffs/STATUS.md](handoffs/STATUS.md)。

- 同一时刻**一个 Agent 只做一个任务**。需要并行时，在 `handoffs/STATUS.md` 登记 owner + 写范围，避免两个 Agent 改同一目录。
- H2 与 H1 的 `packages/server` 写范围有交集：H1 只改 `packages/server/src/{core 集成,approvals,templates}.ts`，H2 只改 `packages/server/src/hooks/` 与 `workers/sap-*`；都要改共享文件时在 STATUS.md 协调。

## 4. 环境（已实测）

| 项 | 值 |
| --- | --- |
| OS | macOS arm64（Apple Silicon） |
| Node | v24.22.2（要求 `^22.19.0 || >=24.0.0`；abap-cli 需 ≥24.22.1） |
| pnpm | 10.17.1（通过 `corepack enable`） |
| git | 2.54.0 |
| abap-cli | 2.2.0，`abap doctor` 通过；SAP profile `test` 已配置在本机（`.abap.json` 被 gitignore，不提交） |

首次命令：

```sh
corepack enable
pnpm install
pnpm check
pnpm e2e
```

没有外部模型时：使用 `fake` provider（`SA_AI_PROVIDER=fake`），e2e 不依赖网络。
没有 SAP 测试系统时：H2 先交付"本地 fake ICF + abapGit 就绪对象"，在 STATUS.md 标注 `phase A`；有系统时再跑 `phase B`。
手工冒烟注意：本机 3080 被 DSH Web GUI 占用，用 `pnpm cli dev --port <free>` 或 `SA_HTTP_PORT`；`.env` 会真正加载，同一状态目录有单实例锁。

## 5. 工作方式（对执行 Agent 的硬约束）

- **分支**：`feat/h0-<slug>`、`feat/h1-<slug>`、`feat/h2-<slug>`；从 `main` 开，短生命周期；不直推 `main`。
- **提交**：Conventional Commits + `git commit -s`（DCO）；一个提交一件事；不混合格式化与逻辑改动。
- **范围**：只改任务书写明的写范围；跨包契约改动先改 `packages/protocol` + docs，再实现。
- **进度**：每完成一个子项更新 [handoffs/STATUS.md](handoffs/STATUS.md)（状态、分支、提交、验证结果、偏差）。
- **回报**：任务完成时向用户/Lead 报告：完成项、验证命令与关键输出、与设计的偏差、未决问题。
- **禁止**：force push、修改 `LICENSE`/`NOTICE`、提交密钥/状态目录、连生产 SAP、把 DSH 或 Copilot 作为控制面必需依赖、引入 `Chat Participant`。
- **质量门**：`pnpm check` + `pnpm e2e` 必须绿；对应 [009-testing.md](docs/009-testing.md) 的失败场景要覆盖；协议变更同步 `contracts/`。
- **文档**：实现偏离设计时先改 docs；新增概念需在 003 说明理由。

## 6. 完成定义（DoD）

一个任务可标记 `done` 需同时满足：

1. 任务书列出的交付物全部存在，且 `pnpm install && pnpm check` 通过；
2. 任务书列出的验收命令全部通过（含指定失败场景）；
3. 相关 docs 与实际一致；README 的快速开始可用；
4. `handoffs/STATUS.md` 更新；最终报告已发出；
5. 没有越过写范围、没有提交禁物。

## 7. 已知决策与默认值

| 事项 | 默认（不再询问，按此执行） |
| --- | --- |
| 需求系统 | 新建最小 Z 表 + ICF/MIME Web；PDO 历史迁移不在本轮 |
| 权限 | v1 不建模；只记录操作人；后续接 SAP 授权 |
| JIRA / CHARM / Confluence / Teams | 只按 [008](docs/008-hooks.md) 定义契约与 `http` 示例目标，不实现具体适配器 |
| MCP | v1.1 可选；本轮不实现 |
| SAP 系统 | 只连测试系统；对象用 abap-cli 建，传输请求由使用者提供 |
| 服务端模型 | BYOK；无 Key 时用 fake provider |
| M3（SAP 内批处理 AI） | 不在本轮 |
| 门禁 | H1 默认模板 3 阶段 G1/G3/G4；PDO 6 阶段作为预设 |

遇到 [001 §6](docs/001-review.md) 的待确认项时，按本表默认推进，并在报告里标注。

## 8. 如何启动一个新的执行 Agent

让新 Agent 在仓库根目录第一次发言时带上：

> 你在 `/Users/lei/ai_space/sap_super_agent` 工作。先读 `HANDOFF.md`、`handoffs/STATUS.md`、`docs/000–009`，然后从 `handoffs/` 认领一个未完成任务（H1 或 H2；H0 已完成，参见 `handoffs/H1-H2-execution-handoff.md`），严格按任务书的写范围、验收标准执行；完成后更新 `handoffs/STATUS.md` 并回报。不要越过任务边界，不要直推 `main`。

Lead/用户可用 `handoffs/STATUS.md` 之外的 `git log --oneline` 与 `pnpm check` 交叉验证进度。
