# 技术栈可行性调研（2026-11）

> 范围：VSCode + Copilot Chat 扩展能力、在线/离线派单协议、SAP 托管控制平面、abap-cli。
> 证据等级：**【事实】** 官方文档/实测；**【推断】** 由事实推导、未逐条验证；**【建议】** 本项目的可执行选择。
> 方法：2026-11-04 抓取 VSCode/Copilot 官方文档与 changelog、SAP Help 官方页面（新版页面为 JS 渲染，部分以 URL + 文档标题/检索摘要核对，标注处已注明）、本机 abap-cli 只读检查。**未修改任何 SAP 系统**，只跑了 `abap --version` 与 `abap doctor`（均只读），并读取本地 skills 与 DSH 插件样例（`deepseek-plugin-delete`、`deepseek-usage-dashboard` 是 DSH 宿主插件形态，与 VSCode 扩展 API 不通用，未作为选型依据）。

## 0. 结论摘要

| 问题 | 结论 | 等级 |
| --- | --- | --- |
| VSCode 扩展能否集成 Copilot Chat | 能，但方向变了：**不要做 Chat Participant**（已废弃），改用 extension tools + agent plugin（skills/MCP）+ Language Model API | 事实 |
| 扩展能否读取/驱动 Copilot 会话 | **不能可靠做到**。没有稳定的“读会话/注入消息”公开 API；Chat Session API 仍是 proposal | 事实+推断 |
| 扩展能否让 Copilot 调我们的能力 | **能**：`contributes.languageModelTools` + `lm.registerTool`，Copilot agent mode 会自动/`#` 调用；工具里可跑 abap-cli、调控制平面 | 事实 |
| 服务端 AI 批量生成 | **GitHub Copilot SDK 已 GA**（2026-06），6 语言、MCP/自定义工具、BYOK，适合替换旧 PDO 的服务端生成链路 | 事实 |
| 在线/离线安全派单 | WebSocket 推送 + REST 幂等领取 + lease/心跳 + 断线补拉；**客户端主动连服务端**，离线/关窗即不派单 | 建议 |
| SAP 托管控制平面 | **有限可行**：ICF/OData/APC/bgRFC/AMC 都有，但交互式调度、长连接、会话运行时不适合 ABAP；推荐 SAP 只做需求+审批+投影 | 建议 |
| abap-cli | 本机 2.2.0 可用、`doctor` 通过；适合扩展 shell out；**仅 basic auth** 是硬限制 | 事实 |

## A. VSCode 扩展 + Copilot Chat

### A1. 2026-11 的硬事实（先看这条，决定架构）

- 【事实】**Chat Participant API 已废弃**：官方文档标题即 “Chat participants (deprecated)”，明确 “not supported in the Copilot harness. The Chat Participant API remains available for Local harness compatibility. Do not use it for new Copilot integrations.”
  <https://code.visualstudio.com/api/extension-guides/ai/chat>
- 【事实】官方推荐的替代路径：**agent plugin（skills + MCP server + 可选 MCP Apps）**，需要编辑器 API 时用 **extension tools**，需要长期角色时用 **custom agents**。
  <https://code.visualstudio.com/api/extension-guides/ai/ai-extensibility-overview>
- 【事实】VSCode 现在有 **harness 概念**：Copilot harness 用 Copilot SDK 跑在 **Agent Host**（独立进程，AHP JSON-RPC over WebSocket）；Local harness 跑在 extension host。扩展提供的 tools **只在“扩展所在编辑器窗口已连接”时可用**。
  <https://code.visualstudio.com/docs/agents/concepts/agent-harnesses>
  <https://code.visualstudio.com/docs/agents/concepts/agent-host>
- 【事实】Agent Host Protocol 是开放的（JSON-RPC + 不可变状态 + URI 频道、断线补 action），并有 `code agent host` 可独立启动。
  <https://code.visualstudio.com/docs/agents/concepts/agent-host>
  <https://microsoft.github.io/agent-host-protocol/>

### A2. 可用的集成面（按稳定性排序）

| 能力 | API/机制 | 状态 | 限制 | 用途 |
| --- | --- | --- | --- | --- |
| 工具调用 | `contributes.languageModelTools` + `vscode.lm.registerTool` | 官方指南（未见 preview 标注） | 扩展工具需窗口在线；用户会看到确认框（可 Always Allow，企业可策略收紧） | 让 Copilot 调“领任务/查需求/跑 abap-cli/提交工件” |
| 自有 LLM 调用 | `vscode.lm.selectChatModels` + `sendRequest` | 官方指南（未见 preview 标注） | 需要用户 consent 弹窗；无 system message；有配额/限流；模型族会变 | 扩展自己的“生成/摘要/校验”，不进入 Copilot 会话 |
| 私有模型接入 | Language Model Chat Provider API | 官方指南（较新） | 需评估稳定度与企业管理策略 | 把企业 LLM 网关接进 chat |
| 插件化工作流 | Agent plugin：skills + MCP server + MCP Apps | 官方推荐 | MCP 工具**无** VSCode API；需分发/配置 | 跨客户端复用的领域工作流 |
| 角色化 | Custom agents（`.github/agents`）、skills（`.github/skills`/`.agents/skills`）、instructions | 官方文档 | Copilot harness 不读旧 profile 位置，需迁移 | 把“SAP 需求→开发说明→测试文档”固化成技能 |
| 启动 chat | `workbench.action.chat.open`（文档中以快捷键命令出现）；`vscode.editorChat.start`（内置命令“Invoke a new editor chat session”） | 命令存在，**参数未文档化** | 只能 best-effort 预填，不保证版本间兼容 | “从任务面板打开 chat 并带入上下文”的兜底 |

依据：<https://code.visualstudio.com/api/extension-guides/ai/tools>、<https://code.visualstudio.com/api/extension-guides/ai/language-model>、<https://code.visualstudio.com/api/extension-guides/ai/language-model-chat-provider>、<https://code.visualstudio.com/docs/agents/run/chat-view>、<https://code.visualstudio.com/api/references/commands>

### A3. 扩展能否读取/驱动 Copilot 会话（重点结论）

- 【事实】官方扩展 API 参考里 chat 命名空间仍是 `createChatParticipant`；没有公开的“读取当前 Copilot 会话消息/注入消息”的稳定 API。
  <https://code.visualstudio.com/api/references/vscode-api#chat>
- 【事实】Chat Session API 不是公开稳定 API：当前稳定 API 参考的 chat 命名空间只有 `createChatParticipant`；Chat Session API 只出现在 **api-proposal** issue #268063（已关闭）中，提出 `chat.createChatSessionController` / `ChatSessionItemProvider`，用于列出会话与创建新会话；该 API 已被 GitHub Coding Agent、Claude Code 采用，但提案状态意味着第三方稳定版扩展不能依赖。
  <https://github.com/microsoft/vscode/issues/268063>
- 【推断】“agent 可跨会话协调（列出/新建/读最近上下文/发消息）”是 **Copilot harness 的内置 agent 能力**，不是给第三方扩展的 API。
  <https://code.visualstudio.com/docs/agents/concepts/sessions>
- 【推断】`workbench.action.chat.open` 可预填 prompt，但参数不在官方命令参考中，跨版本可能失效；不能作为产品级集成面。
- 【建议】**不要试图“接管” Copilot 会话**。把集成反过来：扩展是任务的宿主，chat 只是人机协作界面：
  1. 扩展侧边栏（TreeView/Webview）显示“我的任务/待审批/工件”，这是唯一可靠的任务 UI；
  2. 任务上下文写成工作区文件（如 `.sap-agent/task/<id>.md`），custom agent/skill 读文件即可获得上下文；
  3. Copilot 通过 extension tools 反向调用扩展（领任务、拉对象、跑 `abap check/push`、提交工件）；
  4. 需要“一键进 chat”时，best-effort 调 `workbench.action.chat.open` 并明确降级提示。

### A4. 计费与企业策略（会影响能否落地）

- 【事实】Copilot 自 **2026-06-01** 起全面转为 **usage-based billing（GitHub AI Credits）**，各 plan 含月度额度，超出按量计费；组织/企业可设 user-level budget；Copilot code review 另消耗 Actions minutes。
  <https://github.blog/changelog/2026-06-01-updates-to-github-copilot-billing-and-plans/>
  <https://docs.github.com/copilot/concepts/billing/usage-based-billing-for-individuals>
  <https://docs.github.com/copilot/concepts/billing/usage-based-billing-for-organizations-and-enterprises>
- 【事实】企业策略可一键关闭本方案依赖的能力：`ChatAgentMode`（关 agent）、`ChatAgentExtensionTools`（关扩展工具）、`ChatPluginsEnabled`（关 agent plugin）、`ChatMCP`（all/registry/none）、`ChatToolsAutoApprove`、`ChatAgentNetworkFilter`（域名白名单/黑名单）、`ChatApprovedAccountOrganizations`（必须登录指定 GitHub 组织）、`ChatDefaultModel`。
  <https://code.visualstudio.com/docs/enterprise/manage-ai-settings>
- 【事实】扩展发布需遵守 Copilot 扩展可接受使用政策；用 LM API 的扩展建议不要强依赖 Copilot（避免非 Copilot 用户不可用）。
  <https://code.visualstudio.com/api/extension-guides/ai/language-model>
- 【建议】把“Copilot 可用性”做成能力探测：启动时检查 `vscode.lm.selectChatModels` 是否返回模型、extension tools 是否被策略禁用；不可用时扩展降级为“纯任务客户端 + abap-cli”，不阻塞主流程。
- 【建议】数据合规：扩展把需求文本/ABAP 源码发给控制平面或第三方模型前，必须在 README 写清数据流与留存；LM API 的 prompt 经 Copilot 服务（受 GitHub 数据策略约束），强监管数据走企业网关/BYOK；企业可用 `ChatAgentNetworkFilter` 把网络限制到内网域名。

### A5. GitHub Copilot SDK（服务端批量生成）

- 【事实】Copilot SDK **2026-06-02 GA**：Node/TS、Python、Go、.NET、Rust、Java 六语言；能力含自定义工具与 MCP、系统提示分段定制、OpenTelemetry、GitHub OAuth/App/env token/**BYOK**（OpenAI/Foundry/Anthropic 等）、cloud/remote sessions、hook 系统、多客户端共享会话。
  <https://github.blog/changelog/2026-06-02-copilot-sdk-is-now-generally-available/>
  <https://github.com/github/copilot-sdk>
  <https://docs.github.com/copilot/how-tos/copilot-sdk>
- 【事实】GA 后对所有 Copilot 订阅者开放；非 Copilot 用户可通过 BYOK 使用。
- 【建议】旧 PDO 的“服务端调 Copilot SDK 生成需求分析/开发说明/测试文档”可以保留，迁到控制平面（本地/独立服务器）执行；**不要**把 SDK 塞进 SAP（SAP 内没有 Node/Go 运行时，ABAP 侧只能走 ABAP AI SDK/企业网关）。

## B. 在线/离线安全派单协议

> 与 [003-domain-and-protocol.md](../003-domain-and-protocol.md) 的协议设计配套：本节补协议层证据、字段级细节与失败场景。

### B1. 协议选型（有官方依据）

| 需求 | 选型 | 依据 |
| --- | --- | --- |
| 服务端→客户端实时推送 | WebSocket（`wss://`） | RFC 6455 <https://www.rfc-editor.org/rfc/rfc6455> |
| 只读观察/降级通道 | SSE（单向下行、自动重连、`Last-Event-ID`） | WHATWG <https://html.spec.whatwg.org/multipage/server-sent-events.html> |
| 领取/提交等写操作 | HTTPS REST + `Idempotency-Key` | RFC 9110 <https://www.rfc-editor.org/rfc/rfc9110>；幂等键草案 <https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/> |
| 设备/无浏览器登录 | OAuth 2.0 Device Authorization Grant（`device_code`） | RFC 8628 <https://www.rfc-editor.org/rfc/rfc8628> |
| token 自包含校验 | JWT（短期 access + 刷新） | RFC 7519 <https://www.rfc-editor.org/rfc/rfc7519> |
| 能力协商/请求取消/进度 | 借鉴 LSP/DAP：initialize/capabilities、请求 id、cancel、progress | LSP <https://microsoft.github.io/language-server-protocol/>；DAP <https://microsoft.github.io/debug-adapter-protocol/> |
| lease 语义参考 | Kubernetes Lease（renewTime/leaseDuration） | <https://kubernetes.io/docs/concepts/architecture/leases/> |

【建议】最终形态：**WS 负责 presence + 推送（只推摘要），REST 负责所有状态变更（幂等），SSE 作为只读 fallback**。不用长轮询作为主通道（延迟与连接成本高），SAP 托管场景除外（见 C）。

### B2. 字段级建议（在 003 的接口上补强）

| 环节 | 字段 | 建议值/规则 |
| --- | --- | --- |
| 注册 | `executorId`、`userId`、`deviceFingerprint`（`sha256(vscode.env.machineId)`）、`workspaces[]`、`capabilities[]`、`protocolVersion`、`cliVersion` | 指纹只存哈希；capabilities 声明 `abap-cli`、`copilot`、`sapProfiles` |
| 目录绑定 | `workspaceKey = sha256(canonical(workspaceFolderUri))`；`repoId`、`baseBranch` | **服务端只派发 `workspaceKey` 命中“当前打开目录”的任务**；目录一换即视为离线。用 `workspace.workspaceFolders` / `onDidChangeWorkspaceFolders` 监听 <https://code.visualstudio.com/api/references/vscode-api#workspace> |
| 心跳 | `POST /executors/{id}/heartbeat`，20s 间隔，服务端 TTL 60s | 返回 `serverTime`（客户端算偏移）、`leaseTtlMs`、`offers[]`（摘要） |
| 领取 | `POST /tasks/{id}/claim` + `Idempotency-Key` + `If-Match` | 原子 CAS；成功返回 `lease{leaseId, expiresAt, renewIntervalMs}`；冲突返回 409 + 当前 holder 摘要 |
| 续约 | `POST /tasks/{id}/lease/renew`（heartbeat 携带也可） | 续约失败（404/409）立即停止执行并重新拉状态，避免“幽灵执行” |
| 重连 | WS `?after=<seq>`；客户端本地持久化 `lastSeq` | 服务端从事件 outbox 回放；回放失败返回 `resync_required`，客户端全量拉取 |
| 完成/失败 | `POST /complete` / `/fail` / `/release` | 全部幂等；`release` 立即回池并触发再派发 |
| 优雅下线 | `DELETE /executors/{id}`；窗口关闭/扩展 deactivate 时调用 | 服务端立即回收 lease；来不及调用则由 TTL 兜底 |
| 认证 | 用户 token（审批/查看）、executor token（任务操作）、admin token | 扩展用 `context.secrets`（SecretStorage）存 refresh token，**不落工作区文件** <https://code.visualstudio.com/api/references/vscode-api#SecretStorage> |

### B3. 离线判定（本项目核心约束）

- 【建议】离线 = 以下任一：WS 断开且 REST 心跳超 TTL；窗口关闭（`onDidChangeWindowState` 不聚焦**不算**离线，只降优先级）；`workspaceFolders` 不含绑定的 `workspaceKey`；用户显式“暂停接单”。
- 【建议】服务端派发前二次校验：executor 在线 + lease 可用 + `workspaceKey` 命中 + 用户未暂停；**绝不把任务推给离线执行器**，离线期间任务留在池里。
- 【推断】VSCode 公开 API 没有“网络在线/离线”事件（API 参考中未见），不要依赖系统网络状态；用 WS 断线 + 心跳 TTL + `serverTime` 偏移判定。

### B4. 失败场景清单（必须写进测试）

| 场景 | 现象 | 处理 |
| --- | --- | --- |
| 同一目录开两个窗口 | 双 claim | 服务端按 `workspaceKey` 串行化，第二个返回 409；客户端提示“该目录已有执行器” |
| 领取后断网 | 任务卡住 | lease 到期回池；客户端恢复后先 `GET /tasks/{id}` 对账，再决定续跑/放弃 |
| 服务端重启 | WS 全断 | 客户端指数退避重连 + `after=lastSeq`；服务端 outbox 保留 ≥24h |
| 时钟偏移 | lease 误判 | 只用服务端 `serverTime` 计算过期；客户端不本地判过期 |
| 用户切走目录 | 任务与目录不匹配 | 立即 `release`；服务端把任务标记“被中断”，可重派 |
| SAP 会话超时（abap-cli 400） | push 失败 | 扩展捕获 `AUTH_ERROR`，提示重登；任务转 `waiting_human`，不自动重试写操作 |
| SAP 对象被他人锁 | `LOCK_FAILED` | 不重试；上报 holder 信息，转人工 |
| 任务内容不可信 | 注入/越权 | 服务端签发任务只含“允许的命令白名单”；扩展执行前校验；写操作必须人工确认 |
| 权限被撤销 | 401/403 | 清 token、停止接单、提示重新授权 |

## C. SAP 托管控制平面可行性

### C1. 能力盘点

| 能力 | 官方事实 | 对本项目的适用性 |
| --- | --- | --- |
| ICF（HTTP handler） | AS ABAP 的 HTTP 框架，handler 类实现请求处理（按请求占用 work process 为【推断】）<https://help.sap.com/docs/SUPPORT_CONTENT/abapconn/3354079807.html> | **适合**：OData/REST 需求 CRUD、审批、查询；**不适合**：长轮询/长连接 hub |
| APC（ABAP Push Channel） | ABAP Channels 自 **7.40 SP05** 引入（官方 keyword doc 标题）<https://help.sap.com/doc/abapdocu_latest_index_htm/latest/en-us/ABENNEWS-740_SP05-ABAP_CHANNELS.html>；APC 文档见 <https://help.sap.com/docs/ABAP_PLATFORM_NEW/05d041d3df1a4595a3c45f57c15e2325/99911508963d452c80d9def3dd864f4f.html>、架构见 <https://help.sap.com/docs/ABAP_PLATFORM_NEW/05d041d3df1a4595a3c45f57c15e2325/ba8715393bf1497da659f4322db8f272.html> | **有限适合**：服务器→浏览器推送；需要 Basis 配置/激活、连接数/运维成本高；不建议做通用控制平面 |
| AMC（ABAP Messaging Channels） | SAP 内 session 间 publish/subscribe <https://help.sap.com/doc/abapdocu_latest_index_htm/latest/en-US/abenamc.html> | **只适合 SAP 内部**事件，外部客户端不可用 |
| bgRFC | qRFC 的后继，支持 exactly once / exactly once in order，SAP→SAP 异步 <https://help.sap.com/saphelp_ppm400/helpdata/en/b5/1051421310c153e10000000a1550b0/content.htm> | **适合** SAP 内部长任务/批处理；不能替代对外派单 |
| Business Events / RAP events | RAP 业务事件可经事件代理外发 <https://help.sap.com/docs/abap-cloud/abap-rap/business-events> | **适合** SAP→控制平面的通知（webhook/Event Mesh）；不适合承载控制平面 |
| OData / RAP | RAP 是 ABAP Cloud 的服务开发模型；经典系统需 7.55+/S/4HANA 1909+（**推断，按现场 release 确认**） | **适合**需求系统对外 API；版本门槛需现场核实 |
| ABAP AI SDK / AI Core | ABAP AI SDK 文档属 “Generative AI in ABAP Cloud” 文档域 <https://help.sap.com/docs/abap-ai/generative-ai-in-abap-cloud/abap-cloud-documentation-landscape>；约束见 <https://help.sap.com/docs/abap-ai/generative-ai-in-abap-cloud/recommendations-and-constraints-for-abap-ai-sdk>；AI Core 在 BTP | **有限适合**：结构化、批处理式生成（需求分析/测试文档）；**不适合**流式多轮会话；classic on-prem 7.5x 能否用需按 release/许可确认（**推断**） |
| 版本基线 | ABAP Platform 2025 What's New <https://help.sap.com/doc/dbd707a7a338430ebb6c0d2544b4bdde/2025.000/en-US/WN_ABAP_PLATFORM_OP2025_EN.pdf>；S/4HANA 2025 概览 <https://www.sap.com/docs/download/2025/12/a43c7800-317f-0010-bca6-c68f7e60039b.pdf> | 以 `abap whoami`（需 ICF 服务）或 Basis 给出的 release 为准 |

> 核对说明：SAP Help 新版页面为 JS 渲染，上述 SAP 条目以官方 URL + 文档标题/检索摘要核对；涉及具体 release 的条目已在表中标“需现场确认”。

### C1.5 ABAP 版本要求速查

| 能力 | 版本要求 | 证据 |
| --- | --- | --- |
| ICF | 经典 AS ABAP 长期提供（6.40 起）；S/4HANA/ABAP Platform 均可用 | 【推断】需按现场 release 确认 |
| APC / AMC（ABAP Channels） | **ABAP 7.40 SP05 起** | 【事实】官方 keyword doc 标题 <https://help.sap.com/doc/abapdocu_latest_index_htm/latest/en-us/ABENNEWS-740_SP05-ABAP_CHANNELS.html> |
| bgRFC | 与 qRFC 并行的较新异步 RFC（SAP Library 有专章）；具体起始 release 需确认 | 【推断】<https://help.sap.com/saphelp_ppm400/helpdata/en/b5/1051421310c153e10000000a1550b0/content.htm> |
| RAP / OData 服务 | RAP 需 7.55+/S/4HANA 1909+；经典 7.5x 只能用 Gateway/OData | 【推断】按现场 release 确认 |
| ABAP AI SDK | ABAP Cloud 域（BTP ABAP environment / S/4HANA Cloud）；on-prem 的 ABAP Cloud 可用性需确认 | 【推断】<https://help.sap.com/docs/abap-ai/generative-ai-in-abap-cloud/availability> |
| 当前基线 | ABAP Platform 2025 / S/4HANA 2025 | 【事实】<https://help.sap.com/doc/dbd707a7a338430ebb6c0d2544b4bdde/2025.000/en-US/WN_ABAP_PLATFORM_OP2025_EN.pdf> |

> 现场核对命令：`abap whoami`（经 ICF 服务返回 user/system/client/ABAP release）、`abap deploy status`（ICF 服务版本）；拿不到时找 Basis。

### C2. NAT / 反向连接

- 【推断】SAP 主动连开发者笔记本不可行：开发机无稳定入站地址、企业防火墙/终端安全策略通常禁止；SAP 出站 HTTP 需 SM59 目的地 + 代理/防火墙白名单，且 ABAP 端发起连接难以携带用户身份。
- 【事实】因此可行方向只有 **客户端 → SAP**（内网 HTTPS/ICF）或 **客户端 → 控制平面**（公网/内网 HTTPS）。
- 【建议】若必须 SAP 托管：让 VSCode 扩展主动连 SAP ICF 的 OData/REST 端点（短轮询 15–30s，或 APC WebSocket，需 Basis 配合）；**不要**设计 SAP 反向推送。

### C3. 明确边界：什么必须放 SAP，什么不要放

| 放 SAP（必须/推荐） | 不放 SAP（明确不要） |
| --- | --- |
| 需求单、字段、附件元数据、审批与审计（原生权限/传输/合规） | 交互式 agent 主循环、多轮会话、流式输出 |
| 需求状态投影、对外事件 outbox、TR 号回写 | 租约/presence/派单调度（高频写、需要低延迟） |
| ABAP 对象操作（经 abap-cli/ADT/ICF） | WebSocket 长连接 hub、消息队列、模型编排 |
| 可选：批处理式 AI 阶段（ABAP AI SDK/企业 AI 网关 + bgRFC） | 服务端 Copilot SDK（SAP 无 Node/Go 运行时；ABAP 侧无法跑） |
| 可选：Fiori 需求/审批界面 | 开发者本机文件系统与 VSCode 交互 |

### C4. 三种部署模式的可行性判定（对齐 [004-sap.md](../004-sap.md)）

1. **SAP 记录 + 外部控制平面（推荐）**：控制平面本地或独立服务器；SAP 用 OData/RAP 暴露需求/审批，事件用 outbox + 定时 job 推 webhook（SAP 出站）。派单走 WS + lease，客户端连控制平面。**这是唯一能同时满足“离线不派单 + Copilot 人机协作 + 服务端 AI”的形态。**
2. **SAP 记录 + SAP 批处理 AI（强监管备选）**：AI 生成在 SAP 内异步跑（bgRFC/后台 job + ABAP AI SDK/企业网关）；派单仍建议外置，或退化为 ICF 短轮询。适合“数据不出 SAP”，但要接受：无流式、无 WS、AI 模型能力受 ABAP AI SDK 约束、开发调试成本高。
3. **全 ABAP 主进程（不推荐）**：把 Router/Worker/会话/工具调用都塞进 ABAP；受限点：work process 并发模型、无 Node 生态、无 Copilot SDK、APC/ICF 运维复杂、版本门槛（RAP 7.55+）。只在“合规禁止任何外部进程”时考虑。

> **项目决策（2026-11-05）**：SAP 端最终选择 **ICF + MIME** 路线（见 [004-sap.md](../004-sap.md)），不使用 RAP/OData；Web 认证走 SSO，v1 暂不建模细粒度权限。本文 §C 的 OData/RAP 分析仅作备选参考。

## D. abap-cli 工作流与限制

### D1. 本机实测（只读）

- `which abap` → `/opt/homebrew/bin/abap`；`abap --version` → **2.2.0**（【事实】实测）。
- `abap doctor` → `ok: true`；`env.node/env.tls/env.config/env.deps/session.store/session.key` 均 ok；一条提示：`env.install: ok — abap-cli unknown — install location could not be resolved`（【事实】实测，未修复）。
- 本地 skills 版本 **2.2.0**（`.agents/skills/abap-cli*`）；上游 README 示例显示 **2.6.0 / 51 个对象类型**（本地 skill 为 36 个注册类型）→ **本地 CLI 版本低于上游最新**（【推断】基于版本号与类型数对比，需确认是否为有意固定旧版）。
  <https://github.com/chunrichi/abap-cli>

### D2. 在本项目中怎么用（开发 SAP 侧对象）

- 标准写路径：`abap init/profile add` → `abap search/inspect` → `abap pull` → 本地编辑 AFF 文件 → `abap check syntax` → `abap push --tr <TR>`（lock→write→activate→unlock）→ `abap activate`/`abap test`/`abap run` 验证。
- DDIC/数据/报表/SICF/事务码/MIME：需先 `abap deploy --yes` 部署自带 ICF 服务 `/sap/abap_cli`（默认装 3 个全局类到 `$TMP`，无需传输；生产建议 `--package/--tr`）。
- 写盘前 `abap validate:aff`（纯本地 schema 校验）；多文件 `push --atomic`；所有命令 `--json` + 稳定退出码（0/2/3/4/5/6/7/8/9）。
- 【建议】VSCode 扩展用 `child_process` 调 `abap`，解析 `--json` 信封；把 CLI 版本写进扩展的 `engines`/启动检查；`abap doctor` + `abap deploy status` 作为“环境就绪”检查。**服务端 AI 生成不经过 abap-cli**，只在需要动 SAP 对象时调用。

### D3. 限制（直接影响架构）

- **仅 basic auth**：X.509、浏览器 SSO、OAuth password grant、Kerberos 均不支持；BTP ABAP Environment/trial、SAML SSO 系统连不上（【事实】官方 README + 本地 skill）。企业若强制 SSO，这是硬阻塞，需要企业网关/服务账号方案或换工具。
- 密码只进 OS keychain；`.abap.json` 绑工作区；需要 Node **24.22.1+**。
- 通道限制：`TTYP/MSAG/DDLS` 在 ECC 旧内核降级或报错；`DDLS` 在 ECC 不支持；textpool 写在某些 release 不可用；`SRVB` 无 push；`DEVC` 无 push；`ENHO/ENHS` 只读。
- 安全边界：CLI 会写 SAP（push/delete/activate）；扩展必须把“写操作”放在人工确认之后，并绑定传输请求。

## E. 风险与待验证项（建议进 M0/M1 清单）

1. 企业 Copilot 策略是否允许 extension tools / agent plugin（`ChatAgentExtensionTools`、`ChatPluginsEnabled`）——找 IT 用 `Developer: Policy Diagnostics` 确认。
2. Copilot usage-based 计费下“每个任务消耗多少 AI Credits”——先做小样本计量，再定预算。
3. Chat Session API 是否转正（跟踪 microsoft/vscode#268063）——转正前不做依赖。
4. SAP 现场 release / RAP / ABAP AI SDK 可用性——用 `abap whoami`、`abap deploy status` 与 Basis 确认。
5. abap-cli 与企业 SSO 的冲突——决定是否引入企业 AI/ABAP 网关或换用 ADT 直连方案。
6. 若选 SAP 托管：APC 连接数、ICF 并发、短轮询对 work process 的压力——需 Basis 压测。

## F. 参考链接（按主题）

**VSCode / Copilot**
- Chat participants（deprecated）：<https://code.visualstudio.com/api/extension-guides/ai/chat>
- AI extensibility 总览：<https://code.visualstudio.com/api/extension-guides/ai/ai-extensibility-overview>
- Language Model Tool API：<https://code.visualstudio.com/api/extension-guides/ai/tools>
- Language Model API：<https://code.visualstudio.com/api/extension-guides/ai/language-model>
- Language Model Chat Provider：<https://code.visualstudio.com/api/extension-guides/ai/language-model-chat-provider>
- Agent plugins：<https://code.visualstudio.com/docs/agent-customization/agent-plugins>
- Agent skills：<https://code.visualstudio.com/docs/agent-customization/agent-skills>
- Custom agents：<https://code.visualstudio.com/docs/agent-customization/custom-agents>
- 自定义迁移（含 Chat Participant 替换指南）：<https://code.visualstudio.com/docs/agent-customization/migrate-customizations>
- Agent harness：<https://code.visualstudio.com/docs/agents/concepts/agent-harnesses>
- Agent Host 架构：<https://code.visualstudio.com/docs/agents/concepts/agent-host>
- Sessions 概念：<https://code.visualstudio.com/docs/agents/concepts/sessions>
- 企业 AI 策略：<https://code.visualstudio.com/docs/enterprise/manage-ai-settings>
- 企业策略总览：<https://code.visualstudio.com/docs/enterprise/policies>
- 内置命令参考：<https://code.visualstudio.com/api/references/commands>
- API 参考（workspace/SecretStorage/env/chat）：<https://code.visualstudio.com/api/references/vscode-api>
- Workspace Trust：<https://code.visualstudio.com/api/extension-guides/workspace-trust>
- 远程扩展：<https://code.visualstudio.com/api/advanced-topics/remote-extensions>

**Copilot SDK / 计费**
- SDK GA changelog：<https://github.blog/changelog/2026-06-02-copilot-sdk-is-now-generally-available/>
- SDK 仓库：<https://github.com/github/copilot-sdk>
- SDK 文档：<https://docs.github.com/copilot/how-tos/copilot-sdk>
- 计费切换：<https://github.blog/changelog/2026-06-01-updates-to-github-copilot-billing-and-plans/>
- 个人计费：<https://docs.github.com/copilot/concepts/billing/usage-based-billing-for-individuals>
- 组织/企业计费：<https://docs.github.com/copilot/concepts/billing/usage-based-billing-for-organizations-and-enterprises>
- 预算：<https://docs.github.com/copilot/concepts/billing/budgets-for-usage-based-billing>
- Trust Center：<https://copilot.github.trust.page/faq>

**协议**
- RFC 6455 WebSocket：<https://www.rfc-editor.org/rfc/rfc6455>
- WHATWG SSE：<https://html.spec.whatwg.org/multipage/server-sent-events.html>
- RFC 9110 HTTP：<https://www.rfc-editor.org/rfc/rfc9110>
- RFC 8628 Device Grant：<https://www.rfc-editor.org/rfc/rfc8628>
- RFC 7519 JWT：<https://www.rfc-editor.org/rfc/rfc7519>
- Idempotency-Key 草案：<https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/>
- LSP：<https://microsoft.github.io/language-server-protocol/>
- DAP：<https://microsoft.github.io/debug-adapter-protocol/>
- Kubernetes Lease：<https://kubernetes.io/docs/concepts/architecture/leases/>
- Agent Host Protocol：<https://microsoft.github.io/agent-host-protocol/>

**SAP**
- ICF：<https://help.sap.com/docs/SUPPORT_CONTENT/abapconn/3354079807.html>
- ABAP Channels 7.40 SP05：<https://help.sap.com/doc/abapdocu_latest_index_htm/latest/en-us/ABENNEWS-740_SP05-ABAP_CHANNELS.html>
- ABAP Push Channels：<https://help.sap.com/docs/ABAP_PLATFORM_NEW/05d041d3df1a4595a3c45f57c15e2325/99911508963d452c80d9def3dd864f4f.html>
- APC 架构：<https://help.sap.com/docs/ABAP_PLATFORM_NEW/05d041d3df1a4595a3c45f57c15e2325/ba8715393bf1497da659f4322db8f272.html>
- AMC：<https://help.sap.com/doc/abapdocu_latest_index_htm/latest/en-US/abenamc.html>
- bgRFC：<https://help.sap.com/saphelp_ppm400/helpdata/en/b5/1051421310c153e10000000a1550b0/content.htm>
- RAP Business Events：<https://help.sap.com/docs/abap-cloud/abap-rap/business-events>
- ABAP AI SDK 可用性：<https://help.sap.com/docs/abap-ai/generative-ai-in-abap-cloud/availability>
- ABAP AI SDK 约束：<https://help.sap.com/docs/abap-ai/generative-ai-in-abap-cloud/recommendations-and-constraints-for-abap-ai-sdk>
- ABAP Platform 2025 What's New：<https://help.sap.com/doc/dbd707a7a338430ebb6c0d2544b4bdde/2025.000/en-US/WN_ABAP_PLATFORM_OP2025_EN.pdf>
- S/4HANA 2025 概览：<https://www.sap.com/docs/download/2025/12/a43c7800-317f-0010-bca6-c68f7e60039b.pdf>

**abap-cli**
- 仓库：<https://github.com/chunrichi/abap-cli>
- 架构：<https://github.com/chunrichi/abap-cli/blob/main/docs/architecture.md>
- 支持类型：<https://github.com/chunrichi/abap-cli/blob/main/docs/supported.md>
- 本地 skills：`.agents/skills/abap-cli*/SKILL.md`（版本 2.2.0）
