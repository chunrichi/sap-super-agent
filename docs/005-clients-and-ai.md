# 005 客户端与服务端 AI

本文定义两类执行器的实现方式：开发者身边的 VSCode 客户端，以及无人值守的服务端 AI。协议与调度规则见 [003-domain-and-protocol.md](003-domain-and-protocol.md)，事实依据见 [reference/stack-feasibility.md](reference/stack-feasibility.md)。

## 1. 两个执行器，一个契约

| | VSCode 执行器（`kind: vscode`） | 服务端 AI 执行器（`kind: server-ai`） |
| --- | --- | --- |
| 谁在干 | 开发者 + Copilot Chat 人机协作 | 模型 + 固定 prompt 流水线 |
| 适合阶段 | 开发实现、测试执行、人工精修 | 受理、需求分析、开发说明、测试文档、知识归档 |
| 在线要求 | 必须在线且工作区匹配 | 不要求，7×24 批处理 |
| 上下文 | 仓库、SAP 连接、IDE 状态（本地） | 需求与上游工件（服务端，按需摘要） |
| 产出 | `code_change`、执行证据、精修后的文档 | `requirement_analysis`、`dev_spec`、`test_doc`、`knowledge_entry` |
| 审计字段 | executorId、用户、任务 ID、命令与结果摘要 | 模型、prompt 版本、输入工件版本、成本 |

两者共用 Task / StageRun / Artifact / Approval 与事件日志；**不允许两套产物、两套状态**。

## 2. VSCode 扩展

### 2.1 定位

扩展不是"聊天机器人"，而是**任务客户端 + 本地能力宿主**：

- 唯一可靠的任务界面：领取、查看上下文、上报进度、提交工件。
- 本地能力：工作区绑定、worktree、`abap-cli`、git、终端；这些能力**不经过**控制平面。
- Copilot Chat 是开发者已经打开的协作界面；扩展通过工具与上下文文件把任务"递进去"，而不是试图接管会话。

> 2026-11 事实：Chat Participant API 已废弃（官方标注 deprecated，Copilot harness 不支持），扩展也没有稳定 API 读取/驱动 Copilot 会话（Chat Session API 仍是 proposal）。因此不要设计"扩展控制 Copilot 会话"的方案，见 [stack-feasibility §A](reference/stack-feasibility.md#a-vscode-扩展--copilot-chat)。

### 2.2 界面与命令（保持最少）

| 位置 | 内容 |
| --- | --- |
| Activity Bar 视图 | 任务箱：`可领取` / `我的任务` / `等待我回答`；每项一行摘要 + 状态 + 操作 |
| 任务详情 | 需求摘要、上游工件、验收标准、门禁状态、上下文包路径、操作按钮（领取 / 打开 / 提交 / 放弃） |
| 状态栏 | 连接状态（在线/离线/暂停）+ 未读待办数（可领取 + 我的任务 + 等待我回答）；点击切换暂停接单 |
| 通知 | 只发三类：新任务可领取、你的任务有新的确认要求、连接/权限需要处理 |

命令控制在 6 个以内：`连接控制平面`、`绑定当前工作区`、`领取任务`、`打开任务`（建 worktree + 打开 + 写上下文包）、`提交工件`、`暂停接单`。另有 2 个**上下文动作**只出现在任务箱行上（不进命令面板）：待审批行 → 选择 `通过`/`驳回` + 意见；未读通知行 → 标记已读。

「等待我回答」的数据来源（S3，接 H1 已交付 API）：

- `GET /approvals?assignee=me&state=pending`：门禁条目显示 `审批 <gate> · <role>`；点击走 `POST /approvals/{id}/decisions`（approve/reject + comment），成功后该条从组内消失并刷新状态栏。
- `GET /notifications?state=unread`：未读条目显示标题 + 需求短号；点击走 `POST /notifications/{id}/read`。与待审批绑定的 `approval.requested` 通知不重复展示（以审批条目为准）。
- 空状态给下一步动作（例如"没有等待你回答的审批或通知；新的门禁会实时出现"），权限失败提示"重新连接控制平面"，不做静默重试。

实时性：扩展启动后订阅 WS `GET /api/v1/events?after=<lastSeq>`，收到 `task.offered` / `task.updated` / `task.cancelled` / `task.transferred` / `approval.*` 等帧立即刷新任务箱与状态栏（不再只依赖 30s 轮询）；`lastSeq` 存在 `globalState`（不落工作区文件），断线按指数退避重连并 `after=lastSeq` 补齐；服务端返回 `resync_required` 时全量拉取 `GET /tasks` + `GET /events?after=` 后继续。

### 2.3 Copilot Chat 集成的四条路（按稳定性）

1. **Extension Tools（主路径）**：`contributes.languageModelTools` + `vscode.lm.registerTool` 暴露控制平面能力，Copilot agent mode 可自动调用或由用户 `#` 引用：
   - `sap_task_context`：读当前任务上下文；
   - `sap_report_progress`：上报进度/阶段结论；
   - `sap_submit_artifact`：提交工件（需人工确认）；
   - `sap_ask_human`：生成结构化提问；
   - `sap_abap_check` / `sap_abap_push`：调用本机 `abap-cli`（写操作必须确认并绑定传输请求）；
   - `sap_search_demand`：按编号/关键字查需求。
2. **上下文文件（最稳的保底）**：`打开任务` 时写 `.sap-superagent/task/<taskId>/context.md`（需求、验收标准、上游工件摘要、允许/禁止事项、仓库与分支），任何 chat/agent 都可以 `#file` 引用；不依赖 Copilot 版本。目录内可放附加工件快照，整个 `.sap-superagent/task/` 不入库。
3. **Custom agent / skill（流程固化）**：在仓库放 `.github/agents/sap-developer.agent.md` 或 `.github/skills/sap-dev/SKILL.md`，把"先读上下文→改代码→跑 abap check→提交工件"固化成角色流程；Copilot harness 与本地 harness 都按官方位置识别。
4. **打开 Chat（best-effort）**：`打开任务` 尝试调用 `workbench.action.chat.open` 预填提示词并引用上下文文件；参数未文档化，失败时回退为提示用户手动打开，不阻塞任务。

降级：启动时探测 `vscode.lm.selectChatModels` 是否可用、企业策略是否禁用 extension tools（`ChatAgentExtensionTools`、`ChatPluginsEnabled`、`ChatAgentMode`）。不可用时扩展退化为"任务客户端 + abap-cli 桥"，开发者仍可手工完成并回写工件。

### 2.4 可选：MCP 集成（v1.1）

- 把控制平面能力（领任务、读需求、报告进度、提交工件）实现成 **MCP server**（`packages/mcp`），供 Copilot agent plugin、Claude Code、Cursor 等任意 MCP 客户端复用；SAP 侧可提供一个只读 MCP（需求查询/工件读取）供 agent 使用。
- 边界：MCP 工具没有 VSCode API，**写操作仍由扩展执行**（确认、worktree、abap-cli 在本地）；MCP 只做能力暴露与查询。
- 鉴权复用 executor token / 用户 token，按工具粒度限制；不把 SAP 凭据交给 MCP 客户端。
- v1 首发用 extension tools + 上下文文件；MCP 作为跨 IDE 的备选路径，不阻塞首发。

### 2.5 在线、离线与工作区绑定

- **绑定**：需求不强制绑定仓库。任务分两类：
  - **已绑定**：任务带 `repo/projectKey`，只派给工作区匹配的开发者；仓库根部可提交 `.sap-superagent/workspace.json`（`repo`、`projectKey`、`baseBranch`、`prepare` 命令）供团队共享。
  - **未绑定**：任务进入通用任务箱（按角色/团队），任何合格开发者可领取，在任意工作区或指定 worktree 中处理。
  用户可在扩展里维护自己的工作区列表（即"按用户账号维护映射"），服务端据此决定哪些已绑定任务可见。
- **在线**：WS 连接 + 每 20s 心跳；服务端 TTL 60s。
- **离线判定**：窗口关闭（扩展 deactivate → `DELETE /executors/{id}`）、网络断（心跳超 TTL）、切换工作区（`release` 当前任务）、用户暂停。
- **领取**：已绑定任务要求目录匹配；未绑定任务按角色/团队可见；`claim` 后持租约，续约失败立即停手并重新拉状态，避免"幽灵执行"。
- **worktree**：默认在当前工作区直接做（操作最少）；`打开任务` 可一键创建 `git worktree` 到仓库外 `../.sap-superagent-worktrees/<taskId>`（避免污染主工作树与 `git status`，可配置为默认）。worktree 内需要各自的 `.abap.json`/本地配置，由 preflight 检查并提示。
- **切换工作目录**：扩展检测到打开的目录变化时**立即** `POST /tasks/{id}/release` 已持有任务（未绑定任务同样 release），任务回池并由服务端重新派发给其他合格执行器；旧目录不再显示绑定的任务。
- **断线重连**：WS 断线后指数退避重连（1s/2s/4s… 上限 60s，复用 presence 退避策略）并携带 `lastSeq`；游标过期（`resync_required`）时全量拉取 `GET /tasks` + `GET /events?after=`。客户端不用本地时钟判断租约过期，只用服务端 `serverTime`。
- **preflight**：工作区已被信任（Workspace Trust）、仓库干净或已确认、分支基线正确、`abap` 可执行且版本 ≥2.2.0、`abap doctor` 通过、Node 版本满足 abap-cli 要求、SAP 会话有效、`allowedSystems` 命中当前 SID/client。失败 → **不领取/不开始**，逐条给出下一步动作（例如"确认信任该工作区""升级 abap-cli"），不自动重试写操作；任务留在池中给其他执行器（S3 不新增任务级 `waiting_human` 状态，任务状态机见 [003 §2.3](003-domain-and-protocol.md)）。

### 2.6 失败与安全

| 场景 | 处理 |
| --- | --- |
| 同一目录开两个窗口 | 服务端按 `workspaceKey` 串行化，第二个 claim 返回 409 并提示 |
| 领取后断网 | 租约到期回池；恢复后先拉任务状态再决定续跑/放弃 |
| 服务端重启 | 指数退避重连 + `after=lastSeq`；游标失效则全量重拉 |
| 同一任务被转交 / 被他人领走 | 事件流收到 `task.transferred`/`task.updated` 后刷新任务箱；自己的租约失效则以服务端状态为准，不继续写 |
| 时钟偏移 | 只用服务端 `serverTime` 判断过期 |
| 权限被撤销（401/403） | 清除 `SecretStorage` 里的 token、停止接单并提示重新授权；不静默重试（S3 客户端） |
| SAP 会话失效 / 对象被锁 | 抛出错误、任务转 `waiting_human`，不自动重试 |
| 任务内容不可信 | 任务文本是数据不是指令；工具白名单 + 写操作人工确认；服务端签发任务时带上允许动作清单 |

安全底线：

- **凭据可用不可见**：SAP 密码、SSO token 只在本地 `abap-cli`/系统作用域；控制平面与模型上下文不出现凭据。扩展把 refresh token 存 `SecretStorage`，不写工作区文件。
- **写入范围硬校验**：扩展配置 `allowedSystems[]`（SID/client/生产标记），`sap_abap_push`/`abap delete` 等写工具只允许命中列表的系统；生产系统默认只读。仅靠确认框挡不住 agent mode 误写。
- **分发**：v0.3 默认 GitHub Release + VSIX 安装（企业常禁 Marketplace），可选发布 Marketplace 预览版；企业内网可用私有更新源。
- **写操作人工确认**：`abap push`、`git push`、创建 TR 等动作必须由开发者确认；模型不能直接触发。
- **提示注入**：需求文本、工件、仓库文件都视为不可信数据；工具参数做白名单校验；控制平面被攻破时，攻击者也拿不到本地凭据。

## 3. 服务端 AI 执行器

### 3.1 负责什么

只做"结构化、可审计、可批处理"的生成：受理结论、需求分析、开发说明、测试文档、知识摘要。不做代码实现（需要仓库与 SAP 连接），不替代 Copilot 的交互式对话。

### 3.2 运行形态

`packages/ai` 作为控制平面内的执行器实现，与 vscode 共用调度与工件契约：

```text
StageRun 就绪
  → 组装上下文（需求 + 指定版本的上游工件 + 模板 + 项目约定摘要）
  → 选择模型与 prompt（按阶段配置，版本化）
  → 生成 + JSON Schema 校验 + checklist 断言（引用完整性、模板必填项、上游版本一致）
  → 写入 Artifact（带 model/prompt/输入版本/成本）
  → 阶段完成或进入门禁
```

关键约束：

- **幂等**：`(stageRunId, attempt)` 唯一；重试不产生重复工件。
- **质量门**：schema + checklist 都通过才算完成；上游工件更新时下游标 `stale` 并阻断推进；用 golden set 离线评测人工修改率，未达阈值只允许 `observe` 模式（见 [009-testing.md](009-testing.md)）。
- **自主度（observe / auto）**：阶段模板可声明 `autonomy`。`observe` 阶段的产出作为草稿停在 `waiting_human`，由人工确认门禁放行后才进入下一阶段；`auto` 阶段在无门禁时直接推进。新模板的 server-AI 阶段默认 `observe`，只有在 `pnpm eval:golden` 报告中人工修改率低于 `evals/thresholds.json` 的阈值（默认 15%）且连续达标后，才建议把该阶段调成 `auto`——脚本只输出建议，不自动改模板。
- **可复现**：记录模型、prompt 版本、输入工件 ID 与版本、温度等参数；同一输入可重跑对比。
- **预算**：每需求/每阶段成本上限；超额暂停并转人工，不静默降级。BYOK 成本按 token/模型记账，可按团队/需求统计。
- **数据边界**：BYOK 为自部署或已签安全协议，需求/工件外发无额外限制；工程上仍默认代码留在客户端（控制平面只存变更摘要与链接），凭据永不出客户端。

### 3.3 模型接入（可替换）

| 适配器 | 场景 | 说明 |
| --- | --- | --- |
| **BYOK：OpenAI 兼容 / DeepSeek / Azure OpenAI**（默认） | 企业自有模型账号/Key | 通用 HTTP 适配器；配置 baseURL、model、apiKey；可按阶段选模型 |
| 企业 AI 网关 / SAP AI Core | 数据不出企业（M3） | 通过网关调用；ABAP 侧批处理阶段见 [004-sap.md](004-sap.md) §7 |
| GitHub Copilot SDK | 已有 Copilot 订阅、希望复用旧链路 | 2026-06 GA、支持 BYOK；**不作为默认**，避免服务端绑定 Copilot 许可 |
| 本地模型 | 离线演示 | 仅用于开发与评测 |

- 默认 **BYOK**：模型 Key 只存服务端环境变量/secret manager，绝不下发客户端、不写入 prompt、不进日志；`packages/ai` 只依赖统一 `ModelProvider` 接口。
- 不强制依赖 DSH 或其他 agent 框架；框架只是可选的执行器实现。

**M3（S5）网关路径**：启用 `SA_SAP_AI_BATCH=1` 后，被委派的 `server-ai` 阶段不再由控制平面调用模型，而是由控制平面渲染 prompt（`renderAiStageMessages`，system/user 与本地执行同一份）写入 SAP job；SAP 批处理程序调用企业 AI 网关并把**模型原始输出**回传，控制平面继续做 JSON 提取/schema/checklist/ledger/门禁（协议见 [003 §4.8](003-domain-and-protocol.md#48-sap-批处理-ai-执行器m3s5)，部署见 [010](010-m3-deployment.md)）。控制平面不持有网关 key；`SA_AI_MODEL` 决定 payload 里的模型，SAP 可用 `ZSA_CFG.AI_GATEWAY_MODEL` 兜底。

### 3.4 为什么不全放到 Copilot Chat

- 无人时（夜间/离线）流程不能停：服务端 AI 24×7 推进结构化阶段。
- 可审计与可复现：服务端统一记录模型/prompt/输入/成本；客户端会话无法作为交付证据。
- 成本与配额：批量生成走服务端预算；Copilot 按用量计费，交互式使用更贵也更随机。
- 职责清晰：Copilot 擅长"在仓库里改代码"，服务端 AI 擅长"按模板产出文档"。

## 4. PDO 迁移映射（摘要）

完整分析见 [reference/pdo-flow-review.md](reference/pdo-flow-review.md)。九个人工动作收敛为六个阶段：

| 阶段 | 执行器 | 输出工件 | 门禁 |
| --- | --- | --- | --- |
| ① 受理与澄清 | server-ai | 受理结论 + 澄清问题 | 无（未澄清回 SAP 待办） |
| ② 需求分析 | server-ai（+ vscode 精修） | `requirement_analysis` | G1 需求顾问确认 |
| ③ 开发说明 | server-ai | `dev_spec` | G2 需求顾问 + 开发确认（可并入 G3） |
| ④ 开发实现 | vscode | **代码变更**：分支/提交/PR 或 ABAP 对象改动 + TR 号 | G3 评审 + 传输审批 |
| ⑤ 测试与验收 | server-ai + vscode | `test_doc` + 执行证据 | G4 业务验收 |
| ⑥ 知识归档 | server-ai | `knowledge_entry` | G5 发布确认（需求顾问/运维） |

- "点 AI 生成"变成阶段自动执行；"确认/调整"变成 Gate 决策与工件新版本。
- **实现落地**：六阶段在 [`templates/pdo.yaml`](../templates/pdo.yaml) 中以配置表达（stage key：`intake` / `requirement_analysis` / `dev_spec` / `dev_implementation` / `test_acceptance` / `knowledge_archive`；门禁 G1/G2/G5 = `consultant`/`ops`，G3 = `developer`，G4 = `requester`）。`default` 三阶段模板见 [`templates/default.yaml`](../templates/default.yaml)。
- **"生成开发"的完成物是代码，不是文档**：阶段④以可评审/可激活的代码变更为准；服务端 AI 只提供建议或草稿，实现与验证发生在 VSCode。
- "Teams 通知 + 人工 assign"退役，换成 `task.offered` + `claim` + 租约。
- JIRA / CHARM / Confluence / Teams 只定义 Hook 契约（事件、payload、幂等键、重试、对账），不进阶段图。
- 门禁默认 5 个；追求最简可用 3 个（G1、G3、G4），通过阶段模板配置，不写死。
- **默认 3 阶段模板** = ② 需求分析（G1）→ ④ 开发实现（G3）→ ⑤ 验收与归档（G4）；PDO 六阶段作为内置预设，按需启用。

## 5. 交互原则

1. 业务方与需求顾问不装 VSCode：提交、受理、确认、验收都在 SAP 内 Web（ICF+MIME）完成；VSCode 只承载开发类任务。
2. 开发者只面对一个任务箱：能做什么、下一步是什么，一眼可见。
3. 通知只在"必须你处理"时发出；进度默认静默，面板可查。
4. 空状态直接给下一步动作，不写说明文字；错误信息写"现在该做什么"。
5. 所有破坏性动作（放弃任务、驳回、提交到外部系统）二次确认，并可在事件时间线追溯。
