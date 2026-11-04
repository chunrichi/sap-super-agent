# 001 对原始方案的审视与建议

本文逐条回应 [plan.md](plan.md) 的想法，并结合 DeepSeek super-agent 的公开设计与参考实现、PDO 现状，给出修改建议。目标架构见 [002-architecture.md](002-architecture.md) 起。

## 0. 结论摘要

1. **方向成立**：SAP 内需求系统替代 GitHub/飞书、VSCode 作为开发者客户端、保留服务端 AI 生成，这四点都成立，且比原参考实现更适合企业 SAP 场景。
2. **主进程要拆成两层再谈"可选"**：编排核心（可移植）与 agent 推理运行时（重、依赖生态）不是一回事。SAP 可以承载"需求 + 审批 + 批处理式 AI"，不适合承载"交互式 agent 主循环"。
3. **在线约束只应作用于需要人的阶段**：服务端 AI 阶段必须 7×24 推进；人工任务用"池 + 资格 + 目录 + 租约"领取，而不是推给某个具体的人。
4. **VSCode 扩展不要试图"接管" Copilot 会话**：Chat Participant API 已被官方废弃，扩展也无法读取/驱动 Copilot 会话。应改为 **extension tools + 上下文文件 + custom agent/skill**，让 Copilot 反向调用扩展能力。
5. **概念要收敛**：需求系统天然有状态机，不需要照搬参考实现的 Trigger/Thread/Eval/Mandate 全套。六个业务概念（需求、阶段、任务、指派、工件、门禁）+ 三个支撑对象（执行器、Hook、事件）+ 三个运行时属性（Presence、Lease、Workspace）足够。
6. **PDO 不应 1:1 平移**：九个人工动作收敛为六个阶段，人工只在门禁出现；中间系统只留 Hook 契约。这样"主动处理"才真正成立。
7. **操作简洁靠默认值和收敛，而不是靠更多界面**：一条命令启动、一个任务箱、三类通知、两个 UI 面（SAP 内 Web（ICF+MIME）+ VSCode）。

## 1. 调研基线（先校正两个事实）

### 1.1 DeepSeek 的"super-agent"不是论文，是官方工程长文

- 出处：2026-11-01 官方 X 账号发布 *Exploring Super-agent Design: Towards a More Autonomous Agent System*（自注"原文为中文，此为机翻"），中文原文来自公众号「DeepSeek 产品部」。**没有 arXiv/DOI**。
- 配套开源：[deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype)（MIT，研究原型，README 明确"非正式产品，部分设计未实现"）。
- §7 的性能数字是团队内部合成负载实验（约 300 条消息/轮、只跑 5 次、编码用耗时工具模拟），原文自称 "indicative only"。**可用其结论方向，不能当基准。**
- 详见 [reference/deepseek-superagent-paper.md](reference/deepseek-superagent-paper.md)。

其核心思想对本项目有用的是四条：

1. **Router / Worker 双层**：Router 只做交互、评估、分派，不执行；Worker 隔离上下文、单任务、不直接对人说话。架构强制分工比 prompt 约束可靠——单 Session 靠 prompt 委派只能改善均值，压不住 p95 长尾。
2. **事件驱动**：主输入从"人敲 prompt"变为 Trigger（群聊/PR/CI/需求状态）；同一 Thread 的后续事件直通已订阅的 Worker，不重复经过 Router。
3. **主动 ≠ 自主找活**：主动性来自"规则 + 事件 + 投机执行"，不是模型自由规划；何时说话由信道规则决定，默认安静。
4. **安全是未解问题**：文章自己列出——云端主循环被入侵或提示注入可接管全部端侧设备；凭据进入模型上下文即泄露。要求"能使用凭据但从不看见凭据"。

### 1.2 参考实现能借鉴什么、不能照搬什么

参考实现是 DSH（DeepSeek Harness）的一个 bundle：监听单个 GitHub 仓库（可选飞书），把请求评估成 Ticket，每个 Ticket 起一个 DSH Session + 一个 worktree 目录执行。

| 值得借鉴 | 不要照搬 |
| --- | --- |
| 领域 Engine + 端口 + 持久 Effects/Outbox：领域层零 I/O，主进程可换宿主 | DSH 的 Session/Preset/工具/client-slot 运行时（耦合面大，30 分钟后台、5 秒 shell 都是 DSH 语义） |
| SourceKind 契约：一个 Source 只写"翻译 + 收发 + 名单" | Trigger/Thread/Eval/Mandate/Subscription 全套（需求系统用不到模型判断"接不接单"） |
| 授权与执行分离：不可变授权记录、Policy 版本、结构化提问 | 每个 Ticket 一个服务端 Session + 服务端 worktree（本项目执行在开发者机器） |
| 幂等：事件去重、回复幂等键、全场重放安全 | 只支持单实例、单机部署的假设 |

它**缺少**本项目的关键概念：阶段流水线、工件版本、人工审批门禁、在线状态与工作区绑定。这四项必须新增，也是本项目的差异化。

## 2. 逐条审视用户方案

| # | 原方案 | 判断 | 理由 | 建议 |
| --- | --- | --- | --- | --- |
| 1 | "主进程可选：可某台电脑为主线，可单独部署" | 采纳，但拆概念 | 参考实现的"主进程"同时包含领域编排与 agent 会话运行时；后者可替换成本高。单机模式还有休眠即停的单点问题 | 定义 M1 本地 / M2 独立服务 / M3 SAP 受限宿主；编排核心与宿主适配器分离。M1 只用于个人/演示，团队用 M2 |
| 2 | "甚至可以在 SAP 里搭建主进程" | 部分采纳 | ABAP 有 ICF/MIME/APC/bgRFC/AMC/Business Events，可做需求、审批、短轮询、批处理；但长连接、流式会话、并发调度、模型 SDK 生态与调试效率都不适合交互式 agent 主循环。且网络方向只能是客户端→SAP，SAP 反向连开发机不可行 | M3 = SAP 记录 + 审批 + `bgRFC` 批处理 AI 阶段；交互式编排放在同网段的轻服务里。若"合规禁止任何外部进程"，再评估全 ABAP，但要接受无流式、能力受限 |
| 3 | "feishu/github 插件改为 SAP 内需求系统" | 采纳 | 需求系统是企业内最合理的记录系统；但需求是长周期业务对象，不是聊天消息流 | 保留 Source 适配器思想，去掉 Thread/Eval/Mandate；SAP 只存业务对象 + 状态投影 + 事件 outbox；控制平面存执行态；两边用 ID 关联、不双写真相 |
| 4 | "worktree 改为 VSCode 客户端；用户离线不派任务；打开目录自动拉任务" | 方向采纳，规则修正 | 若"离线"约束所有步骤，服务端 AI 也停摆，与"主动处理"矛盾；把任务推给具体的人会造成休假/离职卡死；worktree 概念本身可保留在客户端 | 人工任务进"可领取池"：在线 + 资格 + 租约；绑定仓库的任务按目录匹配，未绑定的走通用任务箱。服务端 AI 不看在线状态。worktree 作为"打开任务"可选动作 |
| 5 | "开发/业务通过 VSCode 插件基于 Copilot Chat 处理" | 采纳目标，修正实现 | 2026-11 事实：Chat Participant API 已废弃；扩展没有稳定 API 读取/驱动 Copilot 会话（Chat Session API 仍是 proposal）；企业策略可一键禁用扩展工具 | 用 extension tools + 上下文文件 + custom agent/skill；"打开 Chat"仅 best-effort；业务方不装 VSCode，审批在 SAP 完成 |
| 6 | "PDO 流程迁移；中间步骤先不考虑但保留入口；保留服务端 AI 生成；保留 VSCode Copilot 会话" | 采纳 | PDO 的痛点不是 AI 能力，而是"人点按钮推进、产物无版本、执行位置全在服务端、推送式派单" | 九步收敛六阶段；门禁 ≤5（最简 3）；服务端 AI 走 BYOK（自有模型 Key）迁到控制平面作 `server-ai` 执行器；JIRA/CHARM/Confluence/Teams 只定义 Hook 契约；两路 AI 共用 Task/Artifact/门禁契约 |
| 7 | "操作足够简洁" | 采纳，需落成规则 | 参考实现的教训：概念、设置、通知、面板每一处都在消耗注意力 | 六个业务概念；默认三阶段模板（PDO 六阶段作为预设）；通知只三类；两个 UI 面；一条命令启动；一个 `.sap-superagent/workspace.json` 配置 |

## 3. 更好的建议（如果只记五条）

### 3.1 把"自主"拆成两条独立的轴

文章没有"自主性分级"，实际是两条轴，建议本项目显式建模：

- **执行自主度**：谁能自动接活/推阶段。`off`（只记录）、`observe`（只记建议）、`auto`（自动执行）。v1 默认 `observe`，模板按阶段配置。
- **通知自主度**：什么时候打扰人。默认静默；只有"你被派任务""需要你确认""失败需要处理"三类通知。

这样"AI 主动但人不被骚扰"是可配置的，而不是靠 prompt 求模型安静。

### 3.2 控制平面必须没有执行权

Router/Worker 分工的价值是**架构强制**：Router 不挂执行工具，就不会因为"顺手自己干"产生长尾。本项目的控制平面同理：只做编排、派发、记录、门禁判定，不执行代码、不连 SAP 生产、不持有开发者凭据。执行全部落在执行器。

代价是 token/复杂度上升（文章 §7 的 super-agent 方案约 2–4 倍 cache-read token，原文标注 indicative only），换来的是更短更稳的完成时间与更清晰的审计——对企业流程是划算的。

### 3.3 需求系统按"流水线 + 工件 + 门禁"建模，不是工单/聊天流

- 阶段（Stage）是模板：声明输入、输出、执行器类型、门禁。
- 阶段运行（StageRun）是实例：可重试、可退回、产生工件版本。
- 门禁（Gate → Approval）是唯一的人工卡点：一次一个明确决策，带上游 diff 与 checklist。
- 任务（Task）只服务需要在线人工执行的阶段；其余阶段由服务端 AI 直接完成。

这比"照搬参考实现的 Ticket/Assignment"更贴合 PDO，也更少概念。

### 3.4 双 AI 通道统一契约，但边界清晰

- **服务端 AI**：可审计、可复现、可批处理、离线可跑；负责受理、分析、开发说明、测试文档、归档；模型走 **BYOK**（企业自有账号/Key），不绑定 Copilot 订阅。
- **客户端 Copilot**：仓库上下文、人机同屏、实现与调试；负责开发与测试执行。
- 两者都是 `Executor`，共用 Task/StageRun/Artifact/Approval；产出物带 `authorType`、模型/prompt 版本、上游工件版本。
- 不能用"两个系统、两套状态"实现，否则无法回答"最终交付的文档是哪条通道生成的"。

### 3.5 AI 阶段的完成条件不能只有 schema

"服务端 AI 产出通过 JSON Schema 校验 → 阶段完成 → 人只看一眼门禁"是整套主动推进的经济性假设，但 schema 只证明格式，不证明内容可用。若需求分析平均要改 40%，门禁就会退化成第二个编辑界面，人工介入从 3 次涨到 6+ 次。

最小闭环（进 S1）：

1. 每个 server-ai 阶段声明**可判定 checklist**（引用完整性、模板必填项覆盖、上游版本一致），阶段完成 = schema + checklist。
2. 上游工件出新版本时，下游工件标 `stale` 并阻断推进。
3. 用 20–30 条 PDO 历史需求做 golden set 离线评测；人工修改率低于阈值（建议 15%）的阶段才允许 `auto`，否则默认 `observe`（只生成草稿、不推进）。
4. 门禁展示 checklist 结果与未覆盖项，而不是全文 diff——"看一眼"变成"看三个断言"。

### 3.6 安全架构先于功能

文章 §8.4 的两个未解问题在本项目同样成立。三条硬约束：

1. **凭据可用不可见**：控制平面与模型上下文没有 SAP/SSO 凭据；`abap-cli`、git 等动作在开发者本地执行，只回传结果摘要。
2. **提示注入不跨越信任边界**：任务文本、需求、仓库文件都是数据；工具参数白名单；写操作必须人工确认。
3. **审计不可绕过**：每次状态变化写不可变事件；工件记来源、上游版本、checksum；审批记人、时间、意见。

## 4. 概念收敛对照

| 参考实现概念 | 本项目处置 | 说明 |
| --- | --- | --- |
| Source / Trigger / Channel | 保留思想，换实现 | SAP 需求事件与回写、Hook |
| Thread / Subscription / Correlation | 删除 | 需求系统自己承载评论与通知 |
| Eval / Decision / Assessment | v1 删除 | 需求由状态机确定性推进；未来做主动巡检时以 `observe` 重新引入 |
| Policy / Mandate / Policy 版本 | 简化 | 阶段模板 + 门禁角色 + 事件记录；不做作用域与重校验链 |
| Ticket | 拆成 `Task` + `StageRun` | 任务可指派；阶段运行有状态机与工件 |
| Assignment | 保留 + 租约 | 断线/超时回池 |
| Report / Attention | 保留为 Task 事件 + 结构化提问 | 不从自由文本推断"在等人" |
| Effects / Outbox | 沿用机制 | Hook 出站队列、事件日志、幂等 |
| Executor Session / worktree / worker slot | 替换 | VSCode 客户端 + 本地 worktree；调度规则简化 |
| Panel / DSH 前端 | 替换 | SAP 内 Web（ICF+MIME）+ VSCode + 可选运维页 |

## 5. 风险清单

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| Copilot 企业策略禁用 extension tools / agent mode | 客户端 Copilot 集成失效 | 启动探测 + 降级为任务客户端 + abap-cli；MCP 作为备选集成面 |
| Copilot 按用量计费 | 成本不可控 | 按任务/阶段预算；优先用服务端批量生成；客户端交互记录成本 |
| Chat Session API 未转正 | 无法自动化会话 | 不依赖；上下文文件 + tools 保底 |
| abap-cli 仅 basic auth | 强制 SSO 时不可用 | 现场确认；为开发/CI 申请专用 basic-auth 服务账号或企业网关；把 CLI 能力抽象成桥接口 |
| SAP 版本/ABAP AI SDK 限制 | M3 受限 | 先做 M2；SAP 端 ICF+MIME 无 RAP 门槛；M3 按现场 release 评估 |
| 双系统状态漂移 | 审批/状态分叉 | 业务状态以 SAP 为准、执行态以控制平面为准；版本 CAS + 每日对账 |
| 门禁形式化 | 审批失去意义 | 门禁展示上游 diff/checklist；记录意见与耗时 |
| 过度设计 | 启动成本高 | v1 只做 3 阶段 + 3 门禁；其余作为模板预设；MCP/权限/M3 后置 |

## 6. 已确认的假设与待确认的问题

**已确认（本轮补充）**

- SAP 侧为 **S/4HANA（HANA）**。
- SAP 端走 **ICF + MIME** 路线：一个 ICF 节点同时提供 JSON API 与 MIME 托管的 Web 页面，不用 RAP/OData/Fiori Elements。
- **权限暂不建模**；认证支持 **SSO**（Web 走 ICF 登录/IdP，服务调用用服务账号）。
- **MCP 可作为备选集成方式**（v1.1 视需要），v1 用 extension tools + 上下文文件。
- **"生成开发"的最终目标是代码**（分支/提交/PR/ABAP 对象改动 + TR），文档只是阶段输入/输出。
- **服务端 AI 走 BYOK**：自部署或已签安全协议，数据外发无额外限制；Copilot Chat 只在客户端做人机协作。
- **需求不强制绑定仓库**；需要时由需求顾问补充，或由用户账号维护的工作区映射决定派发范围。
- PDO 的核心角色是**需求顾问**（IT 与业务之间的沟通/需求分析人员），业务方提需求并最终验收。

**待确认**

1. 需求系统是新建 Z 对象，还是改造现有 PDO / 复用标准对象？PDO 历史需求如何迁移？
2. JIRA / CHARM / Confluence 的真实触发点、必填字段、是否已有外部 ID 可回写？传输请求审批由谁负责？
3. 开发者是否会跨团队/跨目录接任务？"打开特定目录自动获取任务"是否一一对应？
4. MCP 是否进入 v1 首发范围，还是作为 v1.1 的可选集成？
5. 门禁确认人：需求分析/开发说明由需求顾问确认即可，还是需要业务方会签？最终验收是否由业务方在 SAP 内完成？
6. S/4HANA 具体 release（影响 abap-cli 兼容与 M3 的 ABAP AI SDK 可用性）。

## 7. 建议的下一步

1. 确认第 6 节的待确认项（至少 1、2、5），冻结 v0.1 的模板与门禁。
2. 按 [007-roadmap.md](007-roadmap.md) 从 S0 起步：先写 protocol schema、core 状态机、本地模式闭环，再接 SAP 与 Copilot。
3. 先把"一个需求从提交到可开发"跑通，再补 Hook、多人和 SAP 托管；不要先做 UI 和全量集成。
