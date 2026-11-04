# 设计评审：交付前问题清单

> **修复状态（2026-11-05）**：P0 已全部修复；P1 已修复绝大多数（涉及门禁状态、模板/字段、认证、路径、SAP 表与投影、扩展安全、许可证、测试矩阵）；未修复项（P2 的表格去重、部分 P1 的表述润色）作为后续清理项保留。本文行号对应修复前快照，仅供追溯。

> 评审基准：[plan.md](../plan.md) 的十条诉求；事实基准：`reference/` 四份调研（以 stack-feasibility 的 2026-11 官方结论为准）。
> 快照：2026-11-05 00:12。评审期间文档被并发修改（003 于 00:02、006/007 于 00:07），本文按最新版核对，行号以此快照为准。
> 已闭合、不重复计入：presence TTL 统一 60s（002:155）、`Task.offered` 改为非持久化提示（003:69）、007 §0 改为引用 001 §6（007:7）。
> 分级：**P0** 必须改（否则交付有错，6 条）/ **P1** 应改（18 条）/ **P2** 可选（10 条）。每条给出位置、问题、为什么是问题、可直接落地的改法。

## 0. 结论

- **方向成立，覆盖度不是主要问题**：plan.md 十条诉求都有回应，没有完全遗漏项；缺陷集中在三处"回应放错位置/口径冲突"和一处"未经用户确认的改写"（§1）。
- **最该先修的是四个未闭合的契约**：需求↔仓库绑定、Hook 契约的权威位置、ID 类型、阶段模板与任务字段。这四项不闭合，S0/S1 无法按文档开工（P0-1/2/3/6）。
- **与调研事实一致性总体良好**（§5）：没有继续使用已废弃的 Chat Participant，没有把 SAP 当 agent 运行时，abap-cli 仅 basic auth 已正确反映。
- **最大隐性风险不在架构**：整套"主动推进"的经济性押在"服务端 AI 产出只需人看一眼"上，而当前阶段完成条件只有 JSON Schema 校验（§6）。

## 1. 对 plan.md 的覆盖度

| # | plan.md 诉求 | 落点 | 判定 |
| --- | --- | --- | --- |
| 1 | 主进程可选：某台电脑为主线 / 单独部署 | 002 §2 M1/M2；001:48 | ✅ 明确 |
| 2 | 甚至可以在 SAP 里搭主进程 | 004 §7；002:46,50 | ⚠️ 有答案但自相矛盾：000:14/002:35 仍称"SAP 是编排核心宿主"（P0-4） |
| 3 | feishu/github 改为 SAP 内需求系统 | 004 §2–4；001:50 | ✅ 明确 |
| 4 | worktree 改为 VSCode 客户端；离线不派单；打开目录自动取任务 | 003 §3；005 §2.4 | ⚠️ "自动取任务"无协议触发（P1-2）；需求无仓库绑定（P0-1） |
| 5 | 开发/业务都可通过 VSCode 插件基于 Copilot Chat 处理 | 005 §2.3；001:52 | ⚠️ 被改成"业务方不装 VSCode"，未进待确认清单（P1-14） |
| 6 | PDO 迁移；中间步骤先不做但留入口；保留服务端 AI；保留 VSCode Copilot 会话 | 005 §4；pdo §2–3 | ⚠️ Hook 契约只存在于非权威的 reference（P0-2） |
| 7 | 操作足够简洁 | 001:54；005 §2.2,§5 | ✅ 已落成规则（6 命令/3 通知/2 UI 面） |
| 8 | GitHub 目录结构 | 006 §1 | ⚠️ 缺 `templates/` 与 Hook 契约文档位（P0-2/P0-6） |
| 9 | git 提交策略 | 006 §3 | ✅ 可执行；.gitignore 有缺口（P1-10） |
| 10 | 类似但实现/依赖与 DeepSeek 不同 | 002:67；001 §1.2 | ✅ 明确不依赖 DSH |

结论：无遗漏诉求；需要修的是 2、4、5、6、8 的回应方式，而不是补新章节。

## 2. P0：必须改

### P0-1 需求没有仓库/工作区绑定，S3 的派单规则无法执行

- 位置：`docs/004-sap.md:23`（`ZSA_DEMAND` 字段表无 repo/projectKey）；依赖方 `docs/003-domain-and-protocol.md:112`（human 任务按 `task.workspaceBinding.repo/projectKey` 匹配执行器）、`003:13`（Task 由 StageRun 产生）
- 问题：需求从 SAP 进来时没有任何字段说明它属于哪个仓库/项目；阶段模板也没有仓库来源。S3 的"目录匹配"没有判定依据。
- 为什么是问题：这是用户第 4 条诉求的核心机制。业务方提交需求时不知道仓库；不显式建模，实现者只能按 `ORG_UNIT` 猜或让派单人手工填，S3 验收"同一任务不会双写、可被他人领取"无法复现。
- 改法：`ZSA_DEMAND` 增加 `REPO_KEY CHAR64`、`PROJECT_KEY CHAR40`（可空）；在 003 §2.6 增加 `Task.workspaceBinding` 来源规则——"① 受理阶段 server-ai 给出候选，G1 门禁确认；未确认前 ④ 阶段不生成 human 任务（保持 pending，不进池）"；007 S2 验收加一条"SAP 需求缺 repo/projectKey 时不产生 human 任务"。

### P0-2 Hook 契约只写在"允许过期"的调研附录里

- 位置：`docs/reference/pdo-flow-review.md:136-177`（唯一完整契约：信封、四目标、失败语义）；`docs/006-repo-and-git.md:71` 明确"`docs/reference/` 是调研材料，允许过期，改动不要求同步"；主文档只有 `docs/003-domain-and-protocol.md:229` 一行 `HookTarget`。
- 问题：用户明确要求"中间步骤先不做，但保留入口"，而入口的字段级契约（eventType、payload、idempotencyKey、retry/deadLetter、对账）只存在于被声明可过期的附录；S4（`007:52`）要交付的正是这份契约。
- 为什么是问题：003 开头写"实现以本文为准"（`003:3`），S4 无法引用一个自认会过期的文件；契约不权威等于没有承诺。
- 改法：新增 `docs/008-hooks.md`，把 pdo-flow-review §3.2/§3.3/§3.4 的信封、四个 Hook 表、失败语义原样移入；003:229 的 HookTarget 行改为"契约见 `docs/008-hooks.md`"；pdo-flow-review §3 缩为一句引用；006 §1 目录树补 `008-hooks.md`。

### P0-3 ID 规范冲突：ULID 与 SAP UUID C32 并存

- 位置：`docs/003-domain-and-protocol.md:130`（"ID 为 ULID"）与 `003:206`（示例 `demandId: "01J7..."`）；`docs/004-sap.md:36`（`DEMAND_ID` 用 `cl_system_uuid=>create_uuid_c32_static( )`）。
- 问题：需求主键在 SAP 侧是 32 位 UUID，协议却规定 ULID，示例又把 demandId 写成 ULID；同一字段两种格式。
- 为什么是问题：protocol 是唯一契约来源（`002:56`），字段格式不确定会让 schema、幂等键、对账游标三处同时出错，且 SAP 回写时无法对齐主键。
- 改法：003:130 改为"控制平面生成的实体（stageRun/task/assignment/approval/event）用 ULID；来自外部系统的实体沿用外部主键，并在 envelope 中以 `externalId` 标注"；003:206 的 `demandId` 改为 C32 形式并在 004:36 补一句"SAP UUID 即协议 `demandId`，控制平面不再二次生成"。

### P0-4 "SAP 作为编排核心宿主"与 SAP 侧结论互斥

- 位置：`docs/000-vision.md:14`（"可移植的编排核心，三种宿主：本地 / 独立服务 / SAP"）、`docs/002-architecture.md:35`（"同一份领域核心可以跑在三种宿主里"）vs `002:46,50`（M3 仍需轻量服务跑交互编排）与 `docs/004-sap.md:122`（不建议在 ABAP 实现完整交互式主循环）。
- 问题：方向锚点声称 core 可跑在 SAP，SAP 文档的结论是 core 不在 ABAP；用户第 2 条诉求因此得到两个互斥答案。
- 为什么是问题：000 是"后续文档只依赖前面概念"的锚点（`000:3`）；照 000 排期会去做 ABAP 版 core，而 004 已判定该路径"不推荐、长期负担"。
- 改法：000:14 改为"可移植的编排核心，两种宿主：本地进程 / 独立服务；SAP 是需求与审批的记录系统，M3 下 SAP 侧只跑批处理 AI 与投影回写"；002:35 同改；002 §2 M3 行首改为"**M3 SAP 内批处理（不是主进程）**"。

### P0-5 abap-cli 开发命令不可执行

- 位置：`docs/004-sap.md:99-104`。
- 问题：与仓库自带技能（`.agents/skills/abap-cli-edit/references/commands-quick.md:10,46,76,134`）不符：`pull` 是 `abap pull <name> --type TABL`；`create` 必带 `<type> <name> --package --tr`；`push` 目标是 main `.tabl.json`（`.tabl.ddic` 是同目录 sidecar，不是 push 参数）；语法检查是 `abap check syntax`；激活是 `abap activate <name> --yes`。
- 为什么是问题：AGENTS.md 原则 3 规定 ABAP 开发统一走 abap-cli，004 §6 是唯一落地指南；照抄会直接失败（exit 2 USAGE 或找不到文件），S2 无法开工。
- 改法（替换 99–104 行）：
  ```sh
  abap doctor
  abap pull ZSA_DEMAND --type TABL
  abap create TABL ZSA_DEMAND --file zsa_demand.tabl.json --package ZSA_SUPERAGENT --tr <TR> --yes
  abap push zsa_demand.tabl.json --tr <TR>   # main JSON；.tabl.ddic/.tabl.settings.json 同目录自动带
  abap check syntax
  abap activate ZSA_DEMAND --yes
  abap transport list
  ```

### P0-6 003 声称"实现以本文为准"，但缺 StageTemplate 与 Task 字段表

- 位置：`docs/003-domain-and-protocol.md:3`（权威声明）、`003:65`（"门禁由模板声明"）但全篇无 Stage 实体/模板 schema；`003:67-76` 只有 Task 状态，`priority/dueAt/workspaceBinding/executorKind` 被引用（`003:112,118`）却无字段定义；`docs/006-repo-and-git.md:5-73` 目录树无 `templates/`；`docs/004-sap.md:23` 只有 `TEMPLATE_ID` 没有 `TEMPLATE_VERSION`，而 `007:31` 要求"模板切换不影响进行中需求"。
- 问题：S1 的交付项是"阶段模板（默认 3 阶段 / PDO 6 阶段）+ 模板可切换"，模板的字段、文件格式、放置目录、版本固定规则全部缺失；Task 字段也没有权威定义。
- 为什么是问题：模板是阶段状态机的输入，没有 schema 就没有"实现以 003 为准"，S0/S1 会各写一套 YAML；没有版本固定，"模板切换不影响进行中需求"无法成立。
- 改法：003 新增 §2.7 `StageTemplate`：`{templateId, version, stages:[{key, executorKind, inputArtifactKinds[], outputArtifactKind, gate: none|{gateKey, role}, maxAttempts}], gates:[{gateKey, role, timeoutDays}]}`；新增 §2.3.1 Task 字段表（`id/demandId/stageRunId/title/executorKind/requiredRoles/workspaceBinding/priority/dueAt/state/lastHolderUserIds`）；文件放 `templates/<templateId>.yaml`（006 目录树补一行），schema 进 `packages/protocol`；Demand 固定 `templateVersion`，变更只影响新 Demand；004:23 补 `TEMPLATE_VERSION NUMC4`。

## 3. P1：应改

| # | 位置 | 问题 | 为什么是问题 | 改法 |
| --- | --- | --- | --- | --- |
| 1 | `000:60`、`005:34`、`003:163` | "他人无法领走"、任务箱"等待我确认"、`GET /demands?assignee=` 仍是"指名/推送"口径，与"任务不预绑定到人"（`003:73`）冲突 | 池模型是本项目与 PDO 的核心差异，口径不统一会让实现回到推送式派单 | 000:60 改为"合格执行器都可领取，同一任务同一时刻只有一个持有者"；005:34 第三组改为"等待我回答的问题"；003:163 参数改 `claimedBy=me` |
| 2 | `003:142`、`003:122`、`000:61` | heartbeat 的 `workspaces?` 是可选的，派发依赖"工作区绑定变化"事件但该事件不在 003 §4.4 事件表里；"打开目录 10 秒内看到待办"无协议保证 | 用户第 4 条诉求的验收标准无法实现，只能靠轮询碰运气 | heartbeat 必传 `activeWorkspaceKey`；003 §4.4 增加 `executor.workspace.changed` 事件；TTL 60s 下把"10 秒"改为"绑定变化后 ≤2s 推送" |
| 3 | `003:103`、`003:110`、`003:97` | presence 枚举 `online/busy/away/offline` 不含 `paused`，但 `003:116` 与 `005:36` 把暂停当状态；任务用 `human/server`，执行器用 `vscode/server-ai`，两套 kind 命名 | 状态机与协议字段无法一一对应，实现会各自加字段 | presence 保持四值，另加 `accepting: boolean`（paused = 在线但不接单）；`task.executorKind ∈ {'vscode','server-ai'}`，删除 human/server |
| 4 | `002:122` | "门禁只有两种状态：waiting_human 与 resolved" | 与 `003:88` Approval 五态、`003:49` StageRun.waiting_human 冲突，三个概念被压成一个 | 改为"Gate 是模板规则（无状态）；Approval 是实例（pending/approved/rejected/withdrawn/expired）；StageRun.waiting_human 是阶段状态"，删掉 `resolved` |
| 5 | `003:39`、`003:63` | 退回"只增加新的 StageRun"与"重跑产生新 attempt"二义 | 一个 Stage 对应几个 StageRun 决定主键与幂等键，二义会导致重跑重复产工件 | 定：一个 Demand 的一个 Stage 只有一个 StageRun，重试/退回都是新 attempt，旧 attempt 保留 |
| 6 | `003:45-59` | StageRun 状态机缺边：`waiting_human→cancelled/failed` 无；Approval `withdrawn/expired` 无对应转换；`running→done` 与 `running→waiting_human` 条件未区分 | 门禁撤销/超时是 007 §0 明确要有的场景（超时 3 天升级），状态机会卡死 | 补三条边并注明"仅 gate=none 时 running→done"；Approval 非 approved 时 StageRun 回 running（新 attempt）或 cancelled |
| 7 | `003:101`、`003:112` | `workspaceKey = sha256(本地 URI)` 是机器本地值，服务端无法为任务预生成，但 `003:112` 的措辞像任务侧字段 | SAP 侧与多机场景下任务无法携带 workspaceKey，匹配规则不可实现 | 明确"workspaceKey 只属于 Executor（当前打开目录），Task 只带 repo/projectKey"；003:112 改写为"执行器当前打开的 workspaceKey 必须属于其声明的 workspaces" |
| 8 | `002:118` | "不重复派给同一个人"没有任何状态支撑（Assignment 历史未建模为规则） | 规则不落字段就必然被实现遗漏，回池后同一人反复领取 | 003 §3 增加规则：按 `Task.lastHolderUserIds` 对最近释放者降权（不硬排除），并在 Task 字段表加该字段 |
| 9 | `002:134`、`003:131` | 认证模型冲突：002 说"个人 token + executor token"，003 说 OAuth Device Grant + 短期 JWT + refresh | 两者工作量差数周；M1 本地模式也不会自带 OAuth 服务器 | 统一：M1 用静态 token（CLI 签发）；M2/M3 用 RFC 8628 + JWT；002:134 与 003:131 各补一句适用模式 |
| 10 | `003:219`、`005:50`、`005:64`、`006:157` | 上下文包路径冲突（`context/` vs `task/`）；worktree 建在仓库内 `.sap-superagent/worktrees/`；.gitignore 未覆盖 `.sap-superagent/` | 嵌套 worktree 会污染主工作树 `git status` 与 IDE 索引；生成物与需提交的 `workspace.json` 混放会导致误提交 | 统一为 `.sap-superagent/task/<taskId>/context.md`；worktree 移到 `../.sap-superagent-worktrees/<taskId>`；.gitignore 增 `.sap-superagent/*` + `!.sap-superagent/workspace.json` |
| 11 | `004:25`、`004:72` | `ZSA_ARTIFACT` 无 `STAGE_KEY`/`STAGE_RUN_ID`，但需求详情页要求"工件列表（按阶段分组）" | Fiori 页面无法按阶段分组，只能按 KIND 猜 | 增加 `STAGE_KEY CHAR30`、`STAGE_RUN_ID CHAR32`；模型/prompt 版本留在控制平面，不回写 SAP |
| 12 | `004:32`、`003:26-37` | SAP 投影 7 值（待分析…已取消）与 Demand 状态机 6 态无映射表；`rejected` 没有投影值 | 回写时会出现无法映射的状态，双系统漂移从这里开始 | 在 004 §2.1 加映射表（submitted→待分析、in_progress→分析中/开发中、门禁→待确认、review→待验收、done→已完成、rejected→已驳回或已取消），并写明"表驱动，放 sap-adapter" |
| 13 | `007:89`、`007:32`、`005:145` | 人工介入目标写的是"确认分析、确认开发说明、验收"（G1/G2/G4），默认模板却是 G1/G3/G4 | v1 的"最简 3 门禁"到底哪三个，两处给出不同答案 | 统一为 G1/G3/G4（评审取代技术确认），007:89 改为"确认分析、评审、验收" |
| 14 | `001:125-134`、`007:7` | 待确认问题缺两条：①业务方是否需要 VSCode（plan.md:15 原文是"开发/业务"）；②谁决定需求的 repo/projectKey 绑定 | 前者是被静默改写的用户诉求，后者是 P0-1 的业务前提，都不该默认；007:7 已改为引用 001 §6，但 001 §6 里没有这两条 | 在 001 §6 补问题 9"业务方是否需要 VSCode 只读视图，还是审批全在 SAP"、问题 10"需求与仓库的对应关系由谁维护" |
| 15 | `004:115-117` | 把本机 `abap-cli 2.2.0` 当设计前提（调研 D1：上游已 2.6.0，51 类 vs 本地 36 类）；能力边界未提 OData V2 的 SEGW 在 abap-cli 无对象类型（SRVB 无 push） | S2 的"OData V2 基线"在 ECC 上没有 abap-cli 开发路径，与 AGENTS 原则 3 冲突 | 改为"要求 abap-cli ≥2.2.0，扩展启动校验版本"；004 §3.2 补"ECC 的 SEGW 服务用 GUI/abapGit 建，abap-cli 覆盖 DDIC/类/ICF 节点" |
| 16 | `005:48`、`005:64`、`005:81`、`007:69` | 扩展侧三处未定义：`sap_abap_push` 只靠人工确认防生产写入；preflight 不检查 Workspace Trust；VSCode 分发在 Marketplace 与 VSIX 之间未决 | 企业常禁 Marketplace 且受限工作区不应执行 abap-cli/git；仅靠确认框挡不住 agent mode 误写 | 扩展配置 `allowedSystems[]`（SID/client）硬校验；preflight 加"工作区已信任"；v0.3 默认 GitHub Release VSIX + 内网更新源，Marketplace 可选 |
| 17 | `006:12`、`README:77` | 许可证与 DCO 未决（README 仍写"建议值，待确认"），无 NOTICE/第三方许可清单，PR 流程未要求 `Signed-off-by` | 开源发布前必须定；`.agents/skills/abap-cli*` 来自 chunrichi/abap-cli（MIT），不声明会违反许可 | README 与 006 定 Apache-2.0；加 `NOTICE`（含 abap-cli skills 来源与 MIT 声明）；CI 加 DCO 签名校验 |
| 18 | `002:157`、`007` 各切片 | 测试策略只有"单测 + schema 快照 + e2e"，stack-feasibility B4 的 9 条失败场景（双 claim、断网、重启、时钟、切目录、SAP 会话、对象锁、注入、401）未进任何验收 | 这些正是本项目最容易出错的地方，不写进验收就不会被测 | 007 每个切片加"必须覆盖的失败场景"列，或新增 `docs/009-testing.md` 把 B4 清单转成测试用例矩阵 |

## 4. P2：可选

| # | 位置 | 问题 | 改法 |
| --- | --- | --- | --- |
| 1 | `003:172` | 事件保留窗口未定义，但 `resync_required` 语义依赖它 | 写明"事件日志保留 ≥7 天（M1 可配 24h），超出即要求全量 resync" |
| 2 | `000:27` vs `pdo-flow-review:199` | 概念数量三种说法（六个 / 6+3+3 / 003 的 9 实体） | 统一为"6 业务概念 + 3 支撑对象 + 3 运行时属性"，与 pdo §4.2 对齐 |
| 3 | `001:71` | "参考实现约 2–4 倍 cache token"归属错误：该数字是文章 §7 对 super-agent 方案的实测，且原文自称 indicative only | 改为"文章 §7 的 super-agent 方案约 2–4 倍 cache-read token（indicative only）" |
| 4 | `007:88` | "比 PDO 现状缩短 50%"没有基线，PDO 无度量数据（pdo-flow-review:4 已说明无本地代码） | 先采集 PDO 近 3 个月真实时长，或改为绝对目标"≤3 个工作日" |
| 5 | `002:45` vs `002:133` | M2 存储"Postgres（默认 SQLite 也可）"与"SQLite 默认，Postgres 可选"矛盾 | 统一：M2 默认 Postgres，SQLite 仅 M1 |
| 6 | `README:11-18` vs `000:11-17`；`001:99-111` vs `pdo:181-195`；`005:132-139` vs `pdo:76-83`；`002:126-136` vs `001:46-54` | 四组内容近似重复的表格，各写一份 | 各保留一处为权威，其余改引用；避免两处改一处的漂移 |
| 7 | `005:60` | 没有 `.sap-superagent/workspace.json` 的仓库如何绑定未定义 | 加降级：从 `git remote` 推导 repo，projectKey 由用户选择并写入用户级配置 |
| 8 | `002:142` vs `007:23-24` | S0 验收要"领取开发任务"，但 S0 交付只有 1 个 AI 阶段（需求分析），开发任务无来源 | 明确 S0 用"手建任务"或把默认模板前两阶段（②④）纳入 S0 |
| 9 | `003:200` | Hook 回执事件名 `assignment.external.done` 与 Assignment 实体（任务-执行器绑定）冲突 | 改名 `external.task.done` 或 `hook.receipt` |
| 10 | `006:51`、`002:59` | 根目录 `prompts/` 与 `packages/ai` 内置提示词的关系（默认 vs 覆盖）未定义，npm 发布不会带根目录 prompts | 写明"包内为默认，根 `prompts/` 为团队覆盖层，加载时按 key 合并" |

## 5. 已核实、无需修改

- **Chat Participant**：`001:10`、`002:135`、`005:28` 均按 2026-11 官方 deprecated 结论设计，全文未使用；替代路径（extension tools + 上下文文件 + custom agent/skill）与 stack-feasibility §A 一致。
- **SAP 托管边界**：`004:122-138` 与 stack-feasibility §C3/C4 一致——ICF/OData 可承载需求与审批，APC 有限，SAP 反向连开发机不可行，Copilot SDK 不进 SAP。
- **abap-cli 仅 basic auth**：`004:116` 与 stack D3 一致，并明确"强制 SSO 时是硬阻塞"；未发现把它当可用 SSO 通道的表述。
- **"不是论文"**：`001:17-22` 明确是官方工程长文、无 arXiv/DOI、数字 indicative only；正文未把 p95 或 2–4x 当项目基准（唯一归属瑕疵见 P2-3）。
- **数字使用**：007 的 5 分钟/30 秒/10 秒均为项目自设目标，不是论文数字；唯一缺基线的是 P2-4。

## 6. 反向挑战：最可能失败的设计假设

**假设**："服务端 AI 的结构化产出只要通过 JSON Schema 校验，就可以作为阶段完成物进入门禁"（`003:64` "输出工件通过 schema 校验后阶段才能 done"；`005:98` "生成 + JSON Schema 校验 + 自检"）。

**为什么它最可能失败**：整套"主动推进"的经济性建立在"人只在门禁看一眼就过"上，但 schema 只能证明格式，不能证明内容可用。PDO 的经验是人工调整是常态（pdo-flow-review:42,53）。若需求分析平均要改 40%，门禁就退化成第二个编辑界面，人工介入从 3 次涨到 6+ 次，`007:89` 的指标直接失效；更糟的是审批人变成橡皮章——`001:122` 已列"门禁形式化"风险，但缓解措施只针对 UI 展示，不针对生成质量，等于没有闭环。

**替代方案（最小改动，可进 S1）**：

1. 每个 server-ai 阶段声明"可判定验收清单"而不是全文审批：引用完整性（每条验收标准可追到需求原文锚点）、模板 checklist 覆盖度（缺项自动退回重生成）、上游版本一致性（上游变更后旧工件标 `stale` 并阻断推进）。
2. 阶段完成条件从"schema 校验通过"改为"schema + checklist 通过"（`003:64`）。
3. 先做 20–30 条 PDO 历史需求的 golden set 离线评测；人工修改率低于阈值（建议 15%）的阶段才允许 `auto`，否则默认 `observe`（只生成草稿、不推进阶段）。评测任务写进 007 S1。
4. 门禁展示 checklist 结果与未覆盖项，而不是全文 diff——这样"看一眼"变成"看三个断言"。

若不做这四条，架构上线后最可能出现的结局是：AI 阶段跑得很快，但每个门禁都要重写，用户最终关掉自动推进，回到"点按钮"——也就是 PDO 现状。
