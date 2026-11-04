# DeepSeek《Exploring Super-agent Design》调研

> **一句话结论**：这是 DeepSeek Harness 团队发布的**工程架构长文**（非学术论文、无 arXiv/DOI、数字未公开复现材料），核心贡献是把 OS 经典机制——快慢路径、缓存/局部性、存算分离、Watchdog、投机执行——映射到"常驻多任务 Agent"系统上。对本项目最有用的不是那组实验数字，而是三件事：**Router/Worker 分工**、**Source/Trigger/Thread 事件抽象**、**授权必须先于自主**。
>
> 标注约定：**【事实】**= 官方原文/官方仓库可核；**【推断】**= 我对材料的分析；**【建议】**= 给本项目的动作。调研时间 2026-11-04。

## 1. 出处与可信度（先回答"原文在哪"）

| 类型 | 位置 | 说明 |
| --- | --- | --- |
| 官方英文版（一手） | [X @DeepSeekHarness, 2026-11-01](https://x.com/DeepSeekHarness/status/2116857257245987236) | 标题 *Exploring Super-agent Design: Towards a More Autonomous Agent System*；正文自注"**原文为中文，此为机器翻译**"；镜像可读版 [threadnavigator](https://threadnavigator.com/thread/2116857257245987236/) |
| 中文原文（一手，渠道受限） | 微信公众号「DeepSeek 产品部」《Super-agent 设计探索：迈向更自主的 Agent 系统》，2026-11-01 发布 | **我未取得稳定的官方微信原始链接**（微信链接不可检索稳定定位）。以下全文转载经比对与 X 英文版逐节一致，可作中文全文依据 |
| 中文全文转载（二手） | [uml.org.cn 2026-11-02](http://www.uml.org.cn/ai/202611023.asp?artid=27640) | 署名"作者：DeepSeek 产品部（微信公众号）"，含 §1–§9 全文、实验表格、作者致谢 |
| 中文转载（二手，未直读） | [知乎 p/2099987320443237060](https://zhuanlan.zhihu.com/p/2099987320443237060) | 抓取返回 403，未作为事实来源，仅登记链接 |
| 官方代码（一手） | [deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype) | MIT；仓库创建 2026-10-31，2026-11-04 时约 18.3k stars / 2.0k forks（[GitHub API](https://api.github.com/repos/deepseek-ai/dsh-superagent-prototype)）；README 明确"研究原型，非 DeepSeek 正式产品" |

**可信度判断【推断】**：
- 文章**不是论文**：无作者页、无 DOI、无 arXiv、无实验代码与数据；二手技术整理也指出"DeepSeek 没有发布一份叫 Harness technical report 的正式论文"（[秋月春风的整理](https://yukinoshitasherry.github.io/2611DeepSeekHarness/)）。媒体标题里的"论文/技术报告"不准确。
- 一手性**高**：X 账号为官方账号、GitHub 仓库在 deepseek-ai 组织下，两者互相指认（文末给出原型仓库地址；README 反过来点名文章标题）。
- **数字未经我复现**：§7 的实验是团队内测，基于合成负载与简化环境，原文自称 "indicative only"；下文引用数字时均标来源，不当成基准。【事实】
- 二手报道与原文一致度：DoNews（[链接](https://www.donews.com/news/detail/1/6760986.html)）复述的架构与数字与全文转载一致，可作旁证；其余中文改写在细节上有出入，未采用。

## 2. 核心命题

### 2.1 为什么需要 Super-agent【事实】

- **瓶颈转移**：单任务 Agent 已"越来越少需要人类持续监控与逐步干预"，限制生产力提升的因素从**模型能力**转向**人的注意力**。
- **注意力上限**：现有 Agent 以单一 Session 为基本单位且相互隔离，用户并行多任务要手动切换并记住各 Session 上下文；原文观察"**一个人通常只能同时跟进 3 到 5 个活跃 Session**"。原文金句："单任务的上限取决于模型能力，多任务的上限取决于人的注意力。"
- **简单扩展不够**：在本地单会话 Agent 上接 CLI/MCP/外部连接器可收外部消息，但仍受**单会话同步阻塞、多任务上下文混乱、本地设备离线即停**三个问题约束。
- **解法**：把 Agent 与"单次手动会话"解绑，使其成为跨会话保持上下文、并行推进多任务且互不干扰的**连续实体**——即 Super-agent。

### 2.2 四个基础特征与"为什么单个 ReAct Loop 做不到"【事实】

| 特征 | 含义 | 支撑模块 |
| --- | --- | --- |
| 连续 Continuous | 在 IM/GitHub 评论等原有工作界面交互，始终像同一个 Agent，不需要想"X 会话里有没有 Y 信息" | §2 双层架构 |
| 高效 Productive | 响应快，并行完成多个复杂任务；上一条命令/任务未完就能接新指令 | §2 + §4 |
| 主动 Proactive | 不等逐条指令，持续观察环境事件，值得处理就推进，不需要介入时保持安静 | §3 事件驱动 |
| 持久 Persistent | 始终在线、直连真实工作环境，长期运行中异常自恢复 | §5 存算分离 + §6 Watchdog |

关键论断：**没有任何单个 ReAct Loop 能同时提供这四个特征，它们必须来自循环之外的系统架构**；且"相似设计约束导出相似架构"，个人助手与商业研发 Agent 最终会趋同。【事实】

### 2.3 五大模块【事实】

1. **双层架构**：常驻 **Router 层**（人类交互 + 全局记忆 + 分派，**不执行任务**，甚至可以不配 Bash 工具）+ 上下文隔离的 **Worker 层**（单任务、全套工具、**不直接对人说话**，只向 Router 汇报）。Router 用轻量模型通常够用；Worker 需要最强模型。
2. **事件驱动**：主要输入从"人敲的 prompt"变为环境半结构化事件 **Trigger**（群聊、邮件/日程、代码评审、CI）；**Thread** 是同一 PR/IM 话题/邮件链上的事件流。
3. **面向人的交互**：**异步 ReAct Loop**（`run()` → `start()`/`stop()`，立即返回 Started，结果作为新事件回到会话）实现全双工；多渠道按信道定制规范。
4. **计算/状态/环境分离**：计算进无状态弹性容器、会话状态进数据库；重状态执行环境留在原地，端侧只放**不保存会话状态的轻量 daemon**，支持 **BYOM（Bring Your Own Machine）**。
5. **Watchdog**：主系统之外的独立 **Control Loop**（一个由定时消息驱动的 Watchdog Session），既处理基础设施故障，也**用模型判断 Worker 是否实质推进、是否偏离目标**，可用自然语言问它原因、让它在线改 prompt/触发规则。

事件生命周期四步（§3.1–3.4）：**两级过滤 → 订阅直通 → 上下文组织 → 提前行动**。
- 两级过滤 = 程序策略（Fast Path：来源/群组/白名单）先把噪音挡在模型之前 + 语义策略（Slow Path：LLM 按 prompt 写的策略判断）。
- 订阅直通 = 已归属 Thread 的后续事件由程序**直通**已订阅 Worker，不经 Router；Router 只看未订阅的新事件与跨任务协调。
- 上下文组织 = **Inline & Spill**（把上下文窗口当 Cache：近用信息内联、超预算内容留引用）+ **链式召回 Chain of Recall**（Trigger/Thread/Worker Session 各带唯一 ID，按引用图逐跳召回）。
- 提前行动 = **投机执行**：按环境信号后台先做，有用才交付（内部群配置"静默复现并修复"，只在确认问题且找到简单修复时才说话）。

### 2.4 自主性与人机边界：原文没有"自主性分级"【事实 + 推断】

- 【事实】原文**没有**使用"自主性分级 / Autonomy Level / L1–L5"这类概念，也没有给出分级标准表。它表达自主边界的方式是三处：
  1. 四个基础特征（2.2）；
  2. **"何时行动"**：程序策略 + 语义策略两级过滤（§3.1）；
  3. **"何时说话"**：IM 信道"只在需要决策或验收时通知，只问直接问题、给简短结论"，并给出一条硬规则——**单次回复不超过 100 词**（§4.2）；异步信道（GitHub/邮件/文档）则要结构化、高信息密度。
- 【事实】最接近"分级"的东西不在文章里，而在**原型**：三档接单模式 `off / observe / auto`（observe = 只记录"本来会接单"、不执行）、两种授权强度 `explicit / inferred`、以及按接收范围配置的 admission 表（[docs/002-authorization.md](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/002-authorization.md)）。
- 【推断】文章的"自主"实际是**两条独立轴**：**行动轴**（要不要做，由过滤/规则/模式决定）与**表达轴**（要不要说话，由信道规范决定）。原型把这条判断做实了。对本项目意味着：不要设计单一 L1–L5，而要分别定义"执行自主度"和"通知自主度"。

### 2.5 主 Session / 执行器 Session 的分工（术语映射）【事实】

文章用 **Router / Worker**；原型的领域术语是 **Main Session（主 Session）/ Executor Session（执行器 Session）**，代码与 prompt 里分别叫 `orchestrator` 和 `worker`（[docs/001-domain.md 术语表](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/001-domain.md#L80-L81)）。两套名字是同一分工：

| 维度 | Router / 主 Session | Worker / 执行器 Session |
| --- | --- | --- |
| 职责 | 承接所有人类交互、全局记忆与序点、任务分派、**统一对外回复** | 在隔离上下文中执行单一任务，向 Router 汇报状态与结论 |
| 工具 | 论文：不执行任务、可不配 Bash；原型：14 个 `orchestrator_*` 应用工具，靠 prompt 约束不读代码（[docs/007:490-511](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/007-architecture.md#L490-L511)） | 论文：全套工具；原型：6 个 `orchestrator_*` 业务工具 + 文件/搜索/shell/job/web/skill/todo/subagent，**无**"找人提问/呈现"类工具（[docs/007:517-533](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/007-architecture.md#L517-L533)） |
| 模型 | 轻量即可（长输入短输出，批处理收益大） | 最强模型（直接决定交付质量） |
| 并发 | 单会话常驻，靠**批处理**扛峰值；需要时再分片 | 每任务一会话，隔离；同层 Worker 默认不直接通信 |
| 与人的关系 | 唯一说话者 | 从不直接对人说话 |

与 Agent Team 的区别【事实】：Agent Team 拆**一个**复杂任务、Team Lead 要深挖细节：Router 只做**任务间**的高层关联与分派。反过来，把 Agent Team 的主会话约束成"只做对外交互与派发"，它就等价于这个双层架构。

### 2.6 主动循环（proactive loop）的三个来源【事实 + 推断】

- 【事实】主动性来自**事件驱动**：Trigger 持续进入 → 两层过滤 → 路由 → 上下文组装 → 行动；再叠加**投机执行**（后台先做）。
- 【事实】"循环不阻塞"来自**异步 ReAct Loop**（§4.1）：`start()` 立即返回 Started，工具结果之后作为新事件进会话；原文明确"该异步任务机制**已在 DeepSeek Harness 中实现，但尚未默认开启**"。
- 【事实】"循环坏了能自愈"来自 **Watchdog**（§6）——它在主系统之外，因此主系统失效时它仍在。
- 【推断】文章的循环仍由事件（含 Watchdog 的定时消息）驱动，没有"无输入时自主找活干"的设计（投机执行也由环境信号触发）。这与"LLM 自主规划下一步做什么"是两种不同的主动性；原型的实现也印证了这点——它用"每 2 秒一轮的 pass"驱动到期的 effect 与 Eval（[docs/007:40](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/007-architecture.md#L40)），自主性由**规则+事件**产生，而非模型自由探索。

### 2.7 评估方式与结论（§7，全部为原文自述数字，我未复现）【事实】

设置：群聊 + GitHub CI 消息流同时驱动 4 种端到端方案；每次约 **300 条消息**，其中约 **20 条工作请求**，其余为闲聊/跟进/叫停/CI；编码工作用**只消耗时间的工具**模拟（因此测的是调度与协作，不是单任务执行力）；每方案跑 **5 次**。

| 方案 | 任务完成 p50/p95（分钟） | 每次 cache-read tokens（全 Session） |
| --- | --- | --- |
| **Super-agent** | **12.4 / 15.7** | 2323 万 |
| Super-agent，去掉直通 | 12.6 / 15.5 | 3177 万 |
| 单 Session + Subagent 工具，中性提示 | 20.4 / 29.5 | 605 万 |
| 单 Session + Subagent 工具，提示优先委派 | 13.8 / 29.0 | 1082 万 |

结论三点【事实】：
1. 双层架构 p50/p95 明显优于单 Session；单 Session 高度依赖 prompt——中性提示下 5 次都没调 Subagent，p95 达 29.5 min；优先委派下 5 次有 4 次委派，但仍有 1 次自己干，形成长尾。**架构强制分工压长尾，prompt 只能改善均值。**
2. 成本代价：Super-agent 的 cache-read token 约为单 Session 的 2–4 倍——**用 token 换更短更稳的完成时间**。
3. 去掉直通后完成时间几乎不变，但 Router 决策数 +30%、token +37% → **直通不是提速手段，是给 Router 省钱的机制。**

Router 压测（§7.2）：Trigger 到达率 1→40 条/分钟时，平均 batch 1.0→2.8、单请求耗时 2.5→3.9 s、**单决策摊销推理时间 6.4→1.6 s**——批处理（Prefill 并行）使"积压越多、单决策越便宜"，解释了为何单个常驻 Router 在团队规模下够用。

局限（原文自承）【事实】：合成负载、简化环境、5 次重复、编码用睡眠工具模拟、单一团队规模；"部分设置还可以更严谨，结果仅作初步参考"。→ 它证明了**调度机制可行**，没证明**代码质量更好**。

### 2.8 明确列出的未来方向与未实现部分（§8 + 声明）【事实】

| 开放问题 | 原文要点 | 对本项目是否相关 |
| --- | --- | --- |
| §8.1 双层架构如何扩展 | 何时该给 Router 分片、粒度如何；同层 Worker 何时需要直接通信、什么拓扑；**系统-模型协同设计**（为 Router 的判别/批量分派/召回专项训练）；**长程记忆**（跨月以上）是主要瓶颈 | 高 |
| §8.2 脱离 Session 后如何协作 | 聊天窗口是路径依赖，交互可迁到**领域专用界面**（如直接在 Issue/PR 工作）；界面可保留会话，但"用户看到的一个会话 ≠ 底层一个 Session"；任务中途人工介入/接管/实时协同未解 | **极高**（对应 SAP 需求单界面 / VSCode 扩展） |
| §8.3 上下文边界与 A2A | 部署粒度 = 上下文共享/隔离边界；多实例间 A2A（不特指某协议）的安全可靠协作未解 | 高（多系统/多 SAP 客户端） |
| §8.4 安全与隐私 | 云端 Loop + 端侧 daemon 隐含"互信"假设；Loop 被入侵或**提示注入**攻破 → 所有端侧设备可被接管；即使未被攻破，**凭据进入模型上下文**也会泄露；需要"能使用凭据但从不看见凭据"的机制 | **极高** |

另有两处"未实现"的明确声明【事实】：异步任务机制在 Harness 已实现但**默认未开启**（§4.1）；原型 README 声明"**文中讨论的部分设计是未来方向，原型未实现**"。
文章自述定位：**不提出新理论**，只是把计算机系统的经典工程思想用到 Agent 系统；内部 Super-agent 实例已在持续运行（问题复现修复、代码评审响应、Harness 自身迭代）。作者署名：**Yujia Qiao 完成系统实现与写作**，Huanqi Cao、Zui Chen、Xieting Chu、Tianyi Cui、Shiyuan Feng、Yudong Han、Kexin Liu、Shichun Liu、Gesi Luo、Yifan Shi、Tongrui Xiong、Hanxiang Xu、C.C. Yu、Ziya Zhang、F. Zhou 参与审阅讨论。

## 3. 论文 vs 开源原型：哪些已实现、哪些是愿景

原型自我定位【事实】：面向**单个 GitHub 仓库**的主动式 coding agent（DeepSeek Harness bundle），监听 GitHub、可选飞书；开源版**经过改编，与内部版本、与文章所述实现都不完全相同**（[README](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/README.md)）。

| 论文章节/机制 | 原型状态 | 证据（仓库内路径） |
| --- | --- | --- |
| §2 Router/Worker 双层 | **已实现** | 术语表 Main Session/Executor Session（[001:80-81](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/001-domain.md#L80-L81)）；两套预设 `dsh-superagent-router` / `-worker`（[007:509-516](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/007-architecture.md#L509-L516)） |
| §2.1 Router 批处理 | **已实现** | Thread 上串行 Eval，"期间到达的 Trigger 合并进下一批"（[001:43](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/001-domain.md#L43)）；Eval 批处理（[007:57](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/007-architecture.md#L57)） |
| §2.2 Worker 隔离、不直接说话 | **已实现** | 每 Ticket 一个 Executor Session + 独立目录（[003:23-29](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/003-execution.md#L23-L29)）；worker 无"提问/呈现"类工具（[007:517-533](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/007-architecture.md#L517-L533)） |
| §3 事件驱动 Trigger/Thread | **已实现** | Source→Trigger→Thread→Eval→Ticket（[001:5-19](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/001-domain.md#L5-L19)）；新增 Source 的完整步骤（[008-cookbook](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/008-cookbook.md)） |
| §3.1 两级过滤 Fast/Slow Path | **已实现** | Eval = **Gate（确定性准入）+ Assessment（模型研判）**（[001:33](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/001-domain.md#L33)、[002:9-16](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/002-authorization.md#L9-L16)） |
| §3.2 订阅 + 直通 + 交还 | **已实现** | Subscription 多对多、fan-out 不过 Gate（[001:37](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/001-domain.md#L37)）；Executor 可 `orchestrator_trigger_handback` 交还、`orchestrator_thread_follow` 订阅相关 Thread（[003:110](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/003-execution.md#L110)） |
| §3.3 Inline & Spill | **部分实现** | 注入时邻接消息 400/1200 字、其余消息给 **50 字 stub + `chars` 计数**，`orchestrator_eval_read` 按 id 展开（[007:534-549](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/007-architecture.md#L534-L549)）——正是 Inline+Spill 的雏形 |
| §3.3 链式召回 Chain of Recall | **仅有前置形态** | 可按 id 读 `tickets/triggers/threads/decisions`（[007:550-556](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/007-architecture.md#L550-L556)），但**没有**成文的引用图与多跳召回协议 |
| §3.4 投机执行 | **未实现** | 最接近的是 `observe` 接单模式：只记录"本来会接单"、不执行（[002:91-101](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/002-authorization.md#L91-L101)），性质是灰度而非后台预计算 |
| §4.1 异步 ReAct Loop | **部分实现（不同路数）** | 预设让前台 shell 命令 **5 秒后转后台 job**、后台完成唤醒 Executor、超 30 分钟杀进程（[003:27-39](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/003-execution.md#L27-L39)）；非文章的 `start()/stop()` 工具 |
| §4.2 多信道 + 100 词硬规则 | **已实现** | GitHub / 飞书两个 Source；"Chat messages are one sentence by default, with a hard limit of **100 words**"（[004:79](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/004-prompts.md#L79)、[prompts/replies.md](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/prompts/replies.md)） |
| §5 计算/状态/环境分离、BYOM | **未实现** | 单机部署：`dsh --profile superagent` 跑在 tmux 里，执行目录是本机路径，Executor 以 operator 的 OS 用户跑（[006:5-19](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/006-deployment.md#L5-L19)）；无云端 daemon / 跨设备 |
| §6 Watchdog 外部控制回路 | **简化实现** | 在**另一个 profile** 里建每小时定时任务跑 `status`，按退出码决定是否重启/报告（[006:133-141](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/006-deployment.md#L133-L141)）；**没有**模型判断"是否实质推进/是否偏航" |
| §8.1 长程记忆 | **未实现** | 列为 open question（[007:614](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/007-architecture.md#L614)） |
| §8.3 A2A | **未实现** | 未在 domain 概念中出现 |
| §8.4 凭据"可用不可见" | **未实现（有缓解）** | setup 清除名字含 KEY/PASSWORD/SECRET/TOKEN 的环境变量、用 wrapper CLI 选身份，但作者明说"**These wrappers and directories establish defaults, not a security boundary**"（[003:78-80](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/003-execution.md#L78-L80)、[006:218](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/006-deployment.md#L218)） |

**两个容易被误读的点【推断】**
1. **文章的实验不在原型仓库里**：§7 是团队内部实验（脚本与数据未开源），开源原型只有单元/集成测试（[007:402](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/007-architecture.md#L402)）。媒体所谓"快 39%"（p50 20.4→12.4 分钟）不能说成"原型实测"。
2. **文章在"授权/治理"上明显比原型薄**：原文只在 §3.1 把白名单当作过滤条件之一，没有讨论授权范围、授权按什么版本生效、如何撤回；原型却把这块做成了核心领域模型——Policy（版本化规则 + 各 Source 白名单）、Mandate（不可变授权：范围/强度/规则/身份）、admission 表、三档 accept mode、人 stop 才撤回（002-authorization）。**这可能是原型作者在文章之外补的最大一课，也恰好是企业场景最需要的部分。**

## 4. 对本项目的 5 条启示（SAP 场景 / 去中心化执行）

> 每条格式：**结论一句话**（标注事实/推断）→ 建议动作。

1. **控制平面按"两层"切分，Router 层必须无执行权。**【事实】论文的两层不是性能技巧，而是"让委派成为架构强制而非模型临场判断"——单 Session 方案靠 prompt 改善均值但压不住长尾（p95 29.5/29.0 min vs 15.7 min）。→ **建议**：本项目控制平面只做"人对齐 + 分派 + 全局记忆 + 对外回复"，**不挂 ABAP/命令执行工具**；VSCode 扩展承担 Worker/Executor 角色，二者通过任务与订阅关联。
2. **把 SAP 需求系统做成一个 Source，而不是把 SAP 逻辑写进 Agent。**【事实】原文与原型都把"事件从哪来"抽象为 Source→Trigger→Thread→Channel，GitHub/飞书只是实现；新增一个 Source 有完整步骤文档（008-cookbook）。→ **建议**：SAP 需求单/传输请求/评审评论 = Source 的 Trigger 与 Thread，回复走 Channel（需求单评论/状态变更）；同时保留"多个 Source 可共存"的扩展点，避免 SAP 场景锁死在单一来源。
3. **成本杠杆在"多少事件进模型"，不在模型选型。**【事实】两级过滤（程序 Fast Path 先挡噪音）+ 订阅直通（直通省 Router 30% 决策、37% token）+ 批处理（40 事件/分钟时单决策摊销 6.4→1.6 s）。→ **建议**：控制平面在 Source 侧做确定性过滤（状态/负责人/关键字/白名单/去重），只有候选进 LLM；Router 侧天然合并积压事件再调用模型，不要为"低延迟"提前分片。
4. **授权必须先于自主：把 Policy/Mandate/强度/接单模式做成领域概念。**【事实】原文只在 §3.1 把白名单当过滤条件、没有授权模型；原型却用 Policy 版本 + 不可变 Mandate + `explicit/inferred` 强度 + `off/observe/auto` 三种接单模式兜底，并默认从 `observe`（只记录不执行）起步。→ **建议**：SAP 场景用 SAP 自身的授权对象/审批流做 Gate 的确定性来源，把"谁可以要求、可以做到哪一步、谁可以撤回"写进控制平面领域模型；本项目最大的差异化就在这里，而不是再抄一遍 Router/Worker。
5. **VSCode 执行器正好落在论文 §5.2 的 daemon 形态上，但 §8.4 的安全账必须先算。**【事实】论文给出的"云端 Loop + 端侧无状态轻量 daemon + BYOM + 间歇在线设备重连后自动续跑"与本项目"VSCode 扩展作为客户端执行器"高度同构；同时 §8.4 明确列出两个未解问题——云端被入侵/提示注入会控制全部端侧设备、凭据一旦进上下文就泄露。→ **建议**：扩展侧按"无会话状态、只执行命令并回传结果"设计，凭据不进模型上下文（由扩展本地作用域代理执行 ABAP/网关调用，模型只见能力名与结果摘要）；把"Loop 被攻破时端侧仍安全"作为硬性架构约束写进设计，而不是留作后续优化。

## 5. 未找到 / 未验证清单（避免后人重复踩坑）

- ❌ 未找到**官方微信原文链接**（微信公众号文章无法稳定检索/抓取）；中文全文以 uml.org.cn 转载为准，已与 X 英文版逐节比对一致。
- ❌ 未找到 arXiv / DOI / PDF 版本；x.com 原帖需登录，正文通过 threadnavigator 镜像读取。
- ❌ 知乎转载链接返回 403，未直读。
- ❌ §7 实验的脚本、数据、图表数值表未开源；本文数字全部转述自原文，**未复现**。
- ⚠️ 原型仓库为 2026-10-31 的快照（GitHub 显示 2026-11-03 有推送），本地对照基于该版本 `docs/000–008`；后续若更新，行号可能漂移。
