# HANDOFF — 交给执行 Agent 的任务书

> 本文件是**交接入口**。新接手的 Agent（或人）按本文顺序阅读，然后从 [handoffs/STATUS.md](handoffs/STATUS.md) 认领任务。
> 设计文档（docs/000–009，S5 将新增 docs/010）是权威规范；本文件只负责"现在做什么、按什么顺序、怎么算完成"。

## 0. 一分钟了解

- **项目**：面向 SAP 研发交付的 super-agent。需求记录在 SAP（ICF + MIME 自建 Web），编排在可移植控制平面（本地 M1 / 独立服务 M2），编码在开发者 VSCode（Copilot Chat 人机协作），重复文档由服务端 AI（BYOK）主动生成。
- **当前状态（2026-11-06）**：**S0–S5 Phase A 与 H2 Phase A/B 已完成并合入 `main`**（PR #1–#20）；**v1.0.0 已于 2026-11-06 打 tag 并发布 GitHub Release（含 VSIX 附件；tag 指向 `main` 的发布提交）**：CHANGELOG、SECURITY 支持版本与报告渠道、版本统一 `1.0.0`、VSIX 打包 `pnpm package:vsix` + 真实 VSCode Extension Host 冒烟 `pnpm vscode:smoke`、离线链接检查 `pnpm link:check`、CI 增 build/sap:check/link:check；**发布前后完成一轮 UI 完善（PR #20，已合入 `main`）**：SAP ICF/MIME 需求/审批页重构（hash 路由、搜索筛选、待审批门禁推断、审批历史、响应式，`pnpm sap:ui:preview` 本地预览）+ ICF handler `currentUser`/`decidedAt`/审批人缺省登录用户 + VSCode 任务箱图标/中文/空态/欢迎页；SAP 页面因 ICF SSO 未配置仍 401，真机目视待 Basis 登录。已合入的能力：H1（门禁/模板/checklist/golden set）、H2 Phase A（fake ICF + `sap-adapter` + `/hooks/sap` + 回写 worker）+ **Phase B**（测试系统本地包 `$ZSA`：6 表/3 类/ICF `ZSA`/MIME/ABAP Unit 6/6）、S3（多人在线与派发）、**S4（Hook 契约 + `http` 示例目标）**、**S5 Phase A（M3：契约 §4.8 + v7 job 队列/租约/幂等 + HMAC job API + ABAP `ZCL_ZSA_AI_BATCH` + 无 executor 全链路 e2e + docs/010）**。main 门禁：`pnpm check` **486 tests**（contract 59 schemas / 9 examples / 27 routes）/ `pnpm e2e` **17/17，~4.3s** / `pnpm build` 8/8 / `pnpm sap:check`（离线 5 pass/1 skip；`SA_SAP_CHECK_ONLINE=1` 在线 6 pass）/ `pnpm eval:golden`（24 cases）/ `pnpm link:check`。**S5 Phase B 仍 blocked**：SAP 侧对象已激活、`abap check syntax` 通过、ABAP Unit **15/15**（PR #14 merge `44b67a1`）；缺控制平面可达 + HMAC/服务账号、SM36、企业 AI 网关（未伪造真机结果，见 STATUS「S5 Phase B 进展」）。**执行交接**：[handoffs/S5-phase-b-handoff.md](handoffs/S5-phase-b-handoff.md)（Phase B 输入清单/B3–B10/发布准备/启动 Prompt）；发布步骤见 [docs/006 §3.4](docs/006-repo-and-git.md)。
- **当前冲刺（2026-11-06 起）**：**v1.0.0 已发布（tag + GitHub Release + VSIX）+ 界面完善已合入（PR #20）+ S5 Phase B 收尾（blocked，等人工输入）**。发布前检查已完成：README 快速开始隔离复跑 16 项、VSIX 打包与真实 Extension Host 冒烟（任务箱/claim/上下文包/审批）PASS、golden eval 确定性一致、链接检查 0 坏链。Phase B 缺：[docs/010 §9.3](docs/010-m3-deployment.md#93-phase-b-人工输入清单blocked-判据) 第 1–4 项输入。**接手先读 [handoffs/S5-phase-b-handoff.md](handoffs/S5-phase-b-handoff.md)** 与本文件 §3/§7。
- **下一棒**：① 拿到人工输入后按 [docs/010 §9.2](docs/010-m3-deployment.md#92-phase-b真机测试系统) 完成 Phase B B3–B10（`ZSA_CFG` 写入、SM36、端到端 M3 证据、失败演练、数据边界、重启，不伪造）；② 可选后续：SAP Web 真机 SSO 登录目视（测试系统 ICF 仍 401）、控制平面把 pending 审批投影到 SAP（替代前端推断）、新增模板同步前端 stage→gate 映射、NOTICE 补 abap-cli MIT 全文与 `.agents/agents/abap-developer.agent.md` 来源、changesets/release.yml 自动化、abap-cli [issue #34](https://github.com/chunrichi/abap-cli/issues/34) 修复后重建 DDIC；③ 新版本发布按 [docs/006 §3.4](docs/006-repo-and-git.md)（更新 CHANGELOG → 门禁 → annotated tag → GitHub Release 附 VSIX）。

## 1. 阅读顺序

1. 本文 + [handoffs/STATUS.md](handoffs/STATUS.md)
2. [docs/000-vision.md](docs/000-vision.md) → [001-review.md](docs/001-review.md)：为什么这样做、哪些方案被拒绝
3. [docs/002-architecture.md](docs/002-architecture.md) → [003-domain-and-protocol.md](docs/003-domain-and-protocol.md)：架构与协议，写代码前必须读完
4. 任务对应文档：
   - S0/S1：[005-clients-and-ai.md](docs/005-clients-and-ai.md)、[007-roadmap.md](docs/007-roadmap.md)、[009-testing.md](docs/009-testing.md)
   - S2：[004-sap.md](docs/004-sap.md)、[008-hooks.md](docs/008-hooks.md)
   - S4：[008-hooks.md](docs/008-hooks.md)、[003 §4.4/§4.7](docs/003-domain-and-protocol.md)、[009 #11](docs/009-testing.md)
   - S5：[003 §4.4/§4.8](docs/003-domain-and-protocol.md)、[004 §3/§7](docs/004-sap.md)、[005 §3.3](docs/005-clients-and-ai.md)、[009 #15](docs/009-testing.md)、docs/010-m3-deployment.md（S5 新建）、`sap/README.md`（Phase B）
   - S5-B（当前）：[handoffs/S5-phase-b-handoff.md](handoffs/S5-phase-b-handoff.md)（Phase B 输入清单/B3–B10 步骤/测试系统现状/发布准备/启动 Prompt）
5. [docs/006-repo-and-git.md](docs/006-repo-and-git.md)：目录、提交、PR 约定
6. [AGENTS.md](AGENTS.md) 与 `.agents/skills/abap-cli*/SKILL.md`（SAP 任务必须加载技能后再动手）

## 2. 不变式（任何改动都不能破坏）

1. **真相归属**：SAP 存业务对象/审批/审计；控制平面存执行态（任务/指派/租约/事件）；VSCode 存代码工作区。三者用 ID 关联，不互写真相。
2. **协议以 003 为准**。实现需要偏离时，先改 003 与 `packages/protocol`，再改代码；不得只改一侧。
3. **在线只约束人工任务**：`server-ai` 阶段 7×24 推进，不看 presence；`vscode` 任务才要求在线 + 资格 + 目录 + 租约。
4. **任务不预绑定到人**：池 + claim + lease；离线/超时回池；最近持有者降权。
5. **SAP 端走 ICF + MIME**：一个 ICF handler 同时提供 JSON API 与 MIME 静态页；不用 RAP/OData/Fiori Elements。ABAP 对象一律用 `abap-cli` 开发。
6. **认证与权限**：Web 走 ICF 登录 + SSO；控制平面用服务账号；**v1 不建模细粒度权限**（只记录操作人）。
7. **服务端 AI 走 BYOK**（OpenAI 兼容 / DeepSeek / Azure / 自部署网关）；Key 只在服务端；Copilot Chat 只做客户端协作，**不用 Chat Participant**，用 extension tools + 上下文文件 + custom agent/skill。**M3（S5）** 例外：AI Key 存 SAP 安全存储（`ZSA_CFG` 只存引用），由 SAP 批处理 job 调用企业网关，仍不出企业边界；控制平面不持有网关 Key。
8. **需求不强制绑仓库**：`workspaceBinding` 可空；未绑定任务进通用任务箱，绑定的按工作区匹配。
9. **安全**：凭据可用不可见；写操作人工确认；事件不可变、工件版本不可变。
10. **开源**：Apache-2.0 + DCO（`git commit -s`）；不提交 `.env`、`.abap.json`、SAP 地址、日志、构建产物。

## 3. 任务总览

| ID | 任务书 | 目标 | 依赖 | 主要写范围 |
| --- | --- | --- | --- | --- |
| **H0** | [handoffs/H0-walking-skeleton.md](handoffs/H0-walking-skeleton.md) | S0：本地 M1 闭环（需求→AI 分析→客户端领取→工件→完成） | 无 | `packages/**`、`contracts/**`、`scripts/**`、`.github/workflows/**`、`templates/default.yaml` |
| **H1** | [handoffs/H1-gates-and-templates.md](handoffs/H1-gates-and-templates.md) | S1：门禁/审批、阶段模板、工件版本与 stale、golden set 评测 | H0 | `packages/core/**`、`packages/server/**`、`packages/ai/**`、`templates/**`、`evals/**`、`scripts/eval-golden.mjs` |
| **H2** | [handoffs/H2-sap-icf-mime.md](handoffs/H2-sap-icf-mime.md) | S2：SAP DDIC + ICF JSON + MIME Web + 事件 outbox + `sap-adapter`（Phase A done；Phase B 用 `$ZSA` + abap-cli） | H0（协议冻结） | `sap/**`、`packages/sap-adapter/**`、`packages/server/src/hooks/sap*`、`packages/server/src/workers/sap*` |
| **S3** | [handoffs/S3-multi-user-dispatch.md](handoffs/S3-multi-user-dispatch.md) | S3：多人在线与派发（WS 资格过滤、客户端实时、任务转交、工作区匹配、任务箱审批组） | S0–S2 Phase A | `packages/core/**`、`packages/server/**`、`packages/protocol/**`、`packages/clients/vscode/**`、`packages/testkit/**`、`contracts/**`、`docs/003/005/007` |
| **S4** | [handoffs/S4-hooks.md](handoffs/S4-hooks.md) | S4：Hook 契约 + `http` 示例目标（配置订阅、出站队列/重试/死信、管理/重放、回执、对账、四个占位适配器文档） | H0–S3 | `packages/protocol/**`、`packages/server/**`、`packages/testkit/**`、`contracts/**`、`docs/003/008/007`、`examples/hooks*`、`scripts/hooks-reconcile.mjs` |
| **S5** | [handoffs/S5-sap-hosted-mode.md](handoffs/S5-sap-hosted-mode.md) | S5/M3：SAP 批处理 AI 阶段（job 队列/租约/幂等 + ABAP 调企业 AI 网关）+ SAP 内审批推进 + M3 部署文档（Phase A 离线；Phase B 真机依赖人工输入） | H0–S4（尤其 S2/S4 的 ICF、HMAC、审批联邦） | `packages/protocol/**`、`packages/server/**`、`packages/ai/**`（加法）、`packages/testkit/**`、`packages/sap-adapter/**`（加法）、`contracts/**`、`docs/003/004/005/007/009`、`docs/010-m3-deployment.md`、`sap/**`、`scripts/sap-check.mjs`、`README.md`、`handoffs/STATUS.md` |
| **S5-B** | [handoffs/S5-phase-b-handoff.md](handoffs/S5-phase-b-handoff.md) | Phase B 真机收尾（ZSA_CFG/SM36/端到端 M3/失败演练/数据边界，**blocked**）+ v1.0 发布准备（**已就绪**：CHANGELOG/SECURITY/版本 1.0.0/VSIX 打包+真实 Extension Host 冒烟/链接检查；tag 待确认） | S5 Phase A（已合入 main）+ 人工输入（CP 可达/HMAC、服务账号、SM36、企业 AI 网关） | `sap/**`、`docs/010`、`sap/README.md`、`handoffs/STATUS.md`；发布准备另涉及 `packages/clients/vscode/**`、`README.md`、`scripts/**`、`CHANGELOG.md`、`SECURITY.md`、`.vscode/**`、`.github/workflows/ci.yml` |

```text
H0/H1/H2（Phase A+B）/S3/S4/S5 Phase A ──> main（PR #1–#16，CI 绿；main = 370286e）

main ──┬──> S5-B Phase B 收尾（需人工输入：CP 可达/HMAC/服务账号、SM36、企业 AI 网关；步骤见 handoffs/S5-phase-b-handoff.md）
       ├──> v1.0.0 已发布（2026-11-06：annotated tag + GitHub Release + VSIX 附件）
       ├──> 界面完善已合入（SAP Web + VSCode 任务箱，PR #20）
       └──> 人工项：H2-B 端到端（与 S5-B 输入重叠，可一并完成）
```

> **当前进度（2026-11-06）**：S0–S5 Phase A 与 H2 Phase A/B、v1.0 发布物料、界面完善全部完成并合入 `main`（PR #1–#20，CI 全绿）。**v1.0.0 已发布**：annotated tag `v1.0.0` + GitHub Release（VSIX 附件，release notes 取 [CHANGELOG](CHANGELOG.md) 并如实写 Phase B blocked）。S5 Phase B 已完成 SAP 侧可独立部分（对象激活、`abap check syntax`、ABAP Unit 15/15、在线 `sap:check` 6 pass），2026-11-05 晚复核 `ZSA_CFG` 0 行 / `TBTCO ZSA%` 0 → 其余输入仍 blocked。**接手先读 [handoffs/S5-phase-b-handoff.md](handoffs/S5-phase-b-handoff.md)**；详细证据见 [handoffs/STATUS.md](handoffs/STATUS.md) S5/S5-B 行、「S5 Phase B 进展」「v1.0 发布准备进展」「UI 完善进展」。

- 同一时刻**一个 Agent 只做一个任务**。需要并行时，在 `handoffs/STATUS.md` 登记 owner + 写范围，避免两个 Agent 改同一目录。
- 历史写范围交集提示：H2 与 H1 的 `packages/server` 交集已合并（H1 门禁 + H2 hooks 并存）；S5 与既有代码的交集在 `workers/stage-runner.ts`（委派点）、`stage-engine.ts`（抽公共完成函数）与 `db/migrations.ts`（v7）；共享文件追加式改动 + `// --- S5: ... ---`。

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
| SAP 系统 | 只连测试系统；**Phase B 用本地包 `$ZSA`（无 TR，对象仅测试系统生效）**；对象一律用 abap-cli 建，**abapGit 本轮不实现**；不自动激活生产 |
| 服务端模型 | BYOK；无 Key 时用 fake provider |
| M3（SAP 内批处理 AI，S5） | 任务书 [handoffs/S5-sap-hosted-mode.md](handoffs/S5-sap-hosted-mode.md)；**Phase A 已合入 `main`（PR #13，merge `1e556f0`）**（Team 并行：server-core/server-tests/testkit-e2e/abap-sap/docs-m3 + Lead 契约/集成）；默认关闭（`SA_SAP_AI_BATCH=1` 才启用）、不改 H0–S4、迁移从 v7 起、不新增依赖、SAP 只做批处理执行器不做交互式 agent；**Phase B 部分完成**（SAP 侧对象+ABAP Unit 15/15），剩余 blocked：控制平面可达 + HMAC/服务账号、SM36、企业 AI 网关（docs/010 §9.3）；**接手执行步骤见 [handoffs/S5-phase-b-handoff.md](handoffs/S5-phase-b-handoff.md)** |
| v1.0.0 发布 | **已于 2026-11-06 发布**（annotated tag `v1.0.0` + GitHub Release `v1.0.0`，附 VSIX；release notes 取自 [CHANGELOG](CHANGELOG.md) 并如实写 Phase B blocked）。发布物 = 源码 tag + GitHub Release + VSIX；**不发布 npm/Docker 镜像**；后续版本按 [docs/006 §3.4](docs/006-repo-and-git.md) 手动流程 |
| 门禁 | H1 默认模板 3 阶段 G1/G3/G4；PDO 6 阶段作为预设 |
| 多人在线（S3） | 任务书 [handoffs/S3-multi-user-dispatch.md](handoffs/S3-multi-user-dispatch.md)；worktree `.sap-superagent-worktrees/s3`，分支 `feat/s3-<slug>` |
| H2-B 剩余 | 端到端需人工：Basis SSO/ICF 登录、控制平面可从测试系统访问 + HMAC secret 注入、控制平面→SAP 服务账号、SM36/bgRFC 调度；本轮只做本地包对象 + ABAP Unit + ICF 节点部署与离线/在线校验 |
| S4（Hook） | 任务书 [handoffs/S4-hooks.md](handoffs/S4-hooks.md)；单 Agent、worktree `.sap-superagent-worktrees/s4`、分支 `feat/s4-hooks`；不新增依赖、不改 SAP `/hooks/sap`、迁移从 v6 起；`http` 示例目标 + 四份占位配置样例，不做具体业务适配 |

遇到 [001 §6](docs/001-review.md) 的待确认项时，按本表默认推进，并在报告里标注。

## 8. 如何启动一个新的执行 Agent

让新 Agent 在仓库根目录第一次发言时带上：

> 你在 `/Users/lei/ai_space/sap_super_agent` 工作（`main` 应为最新合并提交；需要隔离时从最新 `main` 建 worktree）。先读 `HANDOFF.md`、`handoffs/STATUS.md`、**[handoffs/S5-phase-b-handoff.md](handoffs/S5-phase-b-handoff.md)**（Phase B 输入清单/B3–B10 步骤/测试系统现状/发布准备/启动 Prompt），再按需读 `docs/003` §4.8、`docs/010` §9、`sap/README.md`、[CHANGELOG.md](CHANGELOG.md)；SAP 操作前加载 `.agents/skills/abap-cli*/SKILL.md`。现状：S0–S5 Phase A 与 H2 Phase A/B 已合入 `main`（`pnpm check` 469 tests / `pnpm e2e` 17/17 / `pnpm link:check` 0 坏链）；**v1.0.0 已于 2026-11-06 发布**（tag + GitHub Release + VSIX；CHANGELOG/SECURITY/版本 1.0.0，`pnpm package:vsix`/`pnpm vscode:smoke`/`pnpm link:check` 随仓库）；S5 Phase B 已完成 SAP 侧对象部署 + ABAP Unit 15/15，B3–B10 依赖人工输入（2026-11-05 晚复核 `ZSA_CFG` 0 行、`TBTCO ZSA%` 0）。新版本发布按 docs/006 §3.4（更新 CHANGELOG → 门禁 → annotated tag → GitHub Release 附 VSIX）；**有输入**按 handoff §4 完成 B3–B10 并收集脱敏证据；**无输入**记录 blocked。只连测试系统、不伪造真机结果、不直推 `main`；每完成子项更新 `handoffs/STATUS.md` 并提交（Conventional Commits + `git commit -s`）。

Lead/用户可用 `handoffs/STATUS.md` 之外的 `git log --oneline` 与 `pnpm check` 交叉验证进度。
