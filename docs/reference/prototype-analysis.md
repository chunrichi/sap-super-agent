# 参考实现分析：dsh-superagent 原型 → SAP super-agent

> 对象：`/tmp/dsh-sa/dsh-superagent-prototype-main`（DSH bundle，MIT；README:3 自述为 research prototype，非生产代码）。
> 读法：先 docs/000–008，再按 `src/core/ports.ts` → `src/sources/kind.ts` → `src/executor/dsh.ts` → `src/app/runtime.ts` 抽源码。
> 标注：**【事实】** = 源码/文档可直接核对（附 `路径:行`）；**【推断】** = 由事实推出；**【建议】** = 对 [000-vision.md](../000-vision.md) 的取舍判断。
> 注意术语冲突：原型 `gate`（准入，确定性判定谁能触发）≠ 本项目 `Gate`（人工门禁）。下文一律写「准入 gate」与「人工 Gate」。

## 0. 结论先行

1. **【事实】** 它的可复用资产不是代码，而是四条边界：领域 `Engine` + 六个端口（`src/core/ports.ts:12-133`）、`SourceKind` 契约（`src/sources/kind.ts:85-113`）、`Executor` 三方法端口（`src/core/ports.ts:55-69`）、管理 API 与面板分离。**【建议】** 本项目照搬这四条边界，丢弃宿主实现。
2. **【事实】** 主 Session 只做路由、worker Session 只做实现，是结构性写死的（`prompts/orchestrator.md:1-16`、`prompts/worker.md:1-10`、工具白名单 `src/app/sessions.ts:262-297`）。**【建议】** 对应到本项目即「控制平面编排 + VSCode 执行」，但项目还缺一个它没有的概念：阶段流水线（Stage/StageRun），只能部分借鉴。
3. **【事实】** 授权在宿主代码里强制，提示词只解释；`Mandate` 不可变、记录 Policy 版本、恢复前重校验（`src/core/model.ts:126-133`、`src/policy.ts:213-240`）。**【建议】** SAP 端必须保留「授权记录与版本」这一层，即使 v1 只有一个 Source。
4. **【事实】** 每个 Ticket = 一个持久 Session + 一个工作目录 + 一条 `prepare` 命令（`src/executor/dsh.ts:24,96-111,247-262`）。**【建议】** 迁到 VSCode 后这条不能照搬：Session 变成客户端会话，目录变成开发者本地 worktree，`prepare` 变成客户端 preflight。
5. **【事实】** 与 DSH 的耦合集中在 Session/Agent 生命周期、agent preset、工具注册、client slots 与 subprocess（`package.json:62-86`、`src/app/sessions.ts:138-155`、`src/client/index.tsx:48-58`）。**【推断】** 换掉主进程的成本主要在「会话运行时」，不在领域层与授权层。

## 1. 分层与运行时

### 1.1 组装与生命周期 【事实】

- 插件形态：`export const name / inject / apply(ctx, config)`（`src/index.ts:7-25`），`cordis` Context 上以 Service 暴露（`src/app/runtime.ts:59,88`）。
- `package.json:30-46` 的两个强耦合字段：`dsh.bundle.patch`（bundle 层插入插件与 preset）与 `dsh.client.inject`（前端 UI 包）；构建产物导出 `./client`、`./github-watch`、`./feishu-watch`（`package.json:11-21`）。
- 组合根 `Runtime` 不含领域规则（docs/007:29-35）。启动顺序：锁目录 → 开 SQLite → 注册 HTTP → setup → `sessions.install()` → `executor.install()` → 确保主 Session → Policy sync → `executor.resume()` → passes/effects 启动（`src/app/runtime.ts:201-218`）。关停按逆序 cancel/wait/drain（`runtime.ts:230-253`）。
- 一个 2 秒一轮的 pass 驱动「due effects + `evaluateDue`」（docs/007:40）；所有外部副作用先进 `Effects` 队列，事务提交后才执行（docs/007:166-171）。

### 1.2 核心分层 【事实】

| 层 | 职责 | 关键文件 |
| --- | --- | --- |
| Engine | 唯一写 Trigger/Thread/Decision/Ticket/Assignment；同步方法、每命令一事务；按角色发 `Pick` 接口 | `src/core/engine.ts:24-50,260-270` |
| 五个内部 Part | Intake / Evals / Tickets / Assignments / Replies，单向依赖 | `src/core/engine.ts:31-37`、docs/007:52-64 |
| Store | 单 SQLite 文件 `<stateDir>/orchestrator.sqlite`；domain repos + read queries + settings + outbox receipts + KV | `src/app/store.ts`、docs/007:450-486 |
| Effects | 持久副作用队列（6 种 kind：assessment/launch/delivery/relay/notice/reply），按 kind 限流、指数退避、`Later` 不计数 | `src/app/effects.ts:11-21`、docs/007:172-181 |
| Outbox | 回复幂等收据，唯一写 `outbox` 表；未发送消息有 waiting 语义 | `src/app/outbox.ts`、docs/007:149-162 |

**【建议】** 这套「Engine 单写 + 端口 + 持久副作用 + 幂等 outbox」是控制平面最值得抄的部分：它天然适配「本地 / 独立服务 / SAP 托管」三种宿主，因为领域层零 I/O（docs/007:257-259）。

### 1.3 两个 Session 【事实】

- 主 Session（`orchestrator`）：`dsh-superagent-router` preset，14 个应用工具，只有路由/评估/配置权限；`noWait` guard 拒绝 `sleep`、>30s 前台命令、>5s job 等待（`src/app/sessions.ts:61-86,262-264`、docs/007:509-515）。
- Executor Session（`worker`）：命名 `worker-<ticketId>`（`src/executor/dsh.ts:24`），`dsh-superagent-worker` preset，6 个应用工具（`orchestrator_read/ack/report/thread_unrelated/thread_follow/trigger_handback`，docs/007:517-532），`danger-full-access` 权限（`sessions.ts:152`）。
- worker 的子 agent 用 DSH `standard` preset，并按 ticket 生命周期回收工具（`sessions.ts:289-312`、docs/003:47）。

**【推断】** 这种「两个角色、两套工具、两套提示词」不是为 DSH 定制，而是 agent 系统的通用模式；VSCode 执行器可复用同一分工，只是把 worker 的运行时交给扩展内的 Copilot Chat。

### 1.4 状态目录与锁 【事实】

- `<stateDir>` 同时放：`orchestrator.sqlite`、锁、`worker-bin` 命令 shim、`worker-gitconfig`、`work/` ticket 目录（docs/006:94-96、`src/infra/environment.ts:18-20`）。
- 启动即 `lockSync(stateDir, {stale:30s})`，锁丢失视为故障（`runtime.ts:90-94`）。**【推断】** 单写者假设是它敢于「内存态 + SQLite」简化的前提；本项目若主进程可多实例，这个假设要最先打破。

## 2. 领域流与状态机

### 2.1 主链路 【事实】

`Source → Trigger → Thread → Eval(准入 gate + assessment) → Decision → Ticket(+Mandate) → Assignment → Report → Channel`（docs/001:7-19 的 mermaid；`src/core/engine.ts:42-247`）。

1. Source 收事件 → `Engine.receive(trigger)`：幂等存储、按 scope 过滤、扇出到订阅该 Thread 的 Ticket、其余入 Eval 队列（`engine.ts:42-48`、docs/007:68）。
2. 同一 Thread 同时只有一个 Eval；期间到达的 Trigger 合批（`Thread.evaluating`，`src/core/model.ts:157-182`）。
3. Eval 产出 Decision：`accept`（原子创建 Ticket+Mandate+Assignment+Subscriptions+确认语，`engine.ts:100`、docs/007:73）/ `ignore` / `stop` / `unavailable`。
4. Ticket 状态由自己定义，不跟随 Executor：open ↔ ended，人发消息可 resume（`model.ts:277-308`、docs/001:35,56）。
5. Assignment：`pending → running → ended`，与 Ticket 独立；只有最终 Report 能让 Ticket 结束（`model.ts:211-233`、docs/001:36）。
6. Report 状态集：`progress/waiting/ready/blocked/failed/dropped`；`dropped` 结束 Ticket，`ready` 无后续 Thread 时完成（`model.ts:211-233`、docs/003:92-106）。

### 2.2 值得抄的不变式 【事实】

- **重复事件幂等**：Trigger id 稳定、重复 accept 只建一个 Ticket（docs/001:28、docs/008:120）。
- **人消息归属唯一**：一条人消息若已到达某 Ticket，就不进 Eval；Executor 拥有它，主 Session 只能 stop（docs/002:22-26）。
- **上下文不等于授权**：Subscription 扇出/context-only follow 不带任何权限（docs/002:20,40-42）。
- **状态与执行器解耦**：同一 Ticket 可换 Executor、可重试、可被多人接手（docs/001:56）。

**【建议】** 第 2、3 条直接映射到本项目：「SAP 需求评论」都应回到 Ticket，而 VSCode 执行器对评论只有「处理或交回」两种动作；这正好是「人在 VSCode、真相在控制平面」的机制化表达。

## 3. 扩展点契约（可移植的核心）

### 3.1 SourceKind 契约 【事实】

`SourceKind`（`src/sources/kind.ts:85-113`）必填：`kind`（稳定 id）、`title/description`（双语）、`schema`（zod）、`fields`（表单描述，非手写 UI）、`health`（独占健康条目）。可选能力：

| 可选成员 | 作用 | 依据 |
| --- | --- | --- |
| `scope(meta, config)` | 收不收、是否 observe 全量、对应哪行准入表（`row`） | `kind.ts:96-98`、docs/008:136-149 |
| `channel{allowed,send,link}` | 出站写信道；`send` 返回 `sent/gone`，其余抛错重试；用 `message.id` 幂等 | `kind.ts:46-56`、docs/008:151-180 |
| `threadContext` | 给评估读消息窗口/图片 | `kind.ts:58-83`、docs/008:182-204 |
| `policy{schema,fields,explicit,rows,sync}` | 该 Source 自己的允许名单、准入表行、名单同步 | `kind.ts:28-41`、docs/008:212-234 |
| `environment{variables,values}` | 注册执行环境变量（禁止放凭据） | `kind.ts:112`、`src/app/execution-environment.ts:9-46` |
| `find/repliesTo/refreshLabels/facts` | 搜索、回复关系、显示名、setup 事实 | `kind.ts:90-110` |

- 宿主侧能力通过窄接口 `SourceContext` 暴露：`receive/atomic/state(KV)/threads/tickets/triggers/notify/report`（`src/sources/host.ts:31-66`）；插件只拿到 `SourceHost`（`host.ts:23-27`）。
- 插件入口固定为「`ctx.effect(register)` + 一个轮询循环」，注释明确要求：等 `ctx.ready`、读 `ctx.config`、移动 cursor 放在 `receive` 之后、逐条容错、只报自己声明的 health（docs/008:252-332）。
- **【事实】** 新增一个 Source 的完整清单 = 11 步（docs/008:413-425）：映射概念 → 写 kind → Trigger 翻译 → scope → Channel → threadContext → Policy part → 环境变量 → 插件入口与循环 → 构建/导出/patch 插入 → 测试。

### 3.2 Executor 端口 【事实】

`Executor`（`src/core/ports.ts:55-69`）只有三方法，且**只排期、不返回结果**：

```ts
start(ticket, assignment): void      // 排队 launch
deliver(ticket, assignment): void    // 投递等待中的 Inputs
stop(ticket, assignment, reason): void
```

结果通过 `EngineForExecutor` 回调宿主（`src/core/engine.ts:269-270`）：`assignmentStarted`、`inputsDelivered`、`inputsRead`、`turnEnded`、`deliveryFailed`、`report`、`assignmentInterrupted`、`markUnrelated`、`handback`、`followForContext`、`reply`。端口里没有任何 DSH 类型——这是最干净的一处抽象。

`DshExecutor`（`src/executor/dsh.ts:207-236`）额外承担：`WorkerSlots` 并发、`launch/delivery` 两个 effect handler、`prepare(ticket, outcome)` 钩子生成目录与 assignment 文本（`dsh.ts:238-240`、`runtime.ts:137-138`）。

**【建议】** VSCode 执行器直接实现这个端口即可复用领域层；但必须补两件原型没有的事：**租约/心跳**（离线不派）与**客户端能力声明**（哪个 workspace 能接什么任务）。这两件可以在端口外做一层 `Dispatch`，不必改端口语义。

### 3.3 Channel / Outbox 【事实】

- 出站统一走 `Outbox.send(message)`，幂等键是 `message.id`；`status/withdraw` 提供 `pending/sent/dropped`（`src/core/ports.ts:71-83`）。
- 顺序：同 Ticket 同会话按队列顺序发送，前一条失败 3 次才放行后续；其他 Ticket 不等待（docs/003:175-191）。
- 丢弃语义：只有「会话不存在/不再监听」才丢，且保留 `dropped` 记录永不重发（docs/003:183-191）。

**【建议】** SAP 需求评论就是 Channel；把「写回需求系统」做成唯一出口 + 幂等键（需求号+评论序号），可以直接继承这套语义。

### 3.4 Panel client 与管理 API 【事实】

- 前端是一个 cordis client 插件：`inject = ['slots','locale','sessions','uiWorkspace']`，向三个 slot 注册（`main` 面板、`sidebar.panellist` 图标、`plugins.row.config` 配置页）（`src/client/index.tsx:48-58`）。
- 面板只读 HTTP：`GET state / settings / sources / prompts`，`PUT settings/<block>`（带 `revision` CAS）、`POST executor/pause`、`POST tickets/<id>/retry|stop` 等；同源 + `x-orchestrator-request: 1` 校验（docs/006:159-207、`src/app/http.ts`、`src/app/api.ts`）。
- 路由与信息架构：6 个 tab（overview/source/trigger/eval/execution/settings）+ 5 个设置组（source/eval/execution/prompts/deployment）（`src/client/route.ts:7-10`、docs/005:15-42）。
- 设计原则：先「需要人做什么」，再「系统是否健康」，再「单条历史」；一个概念只在一个 tab；健康态不占空间（docs/005:7-11,50-58）。

**【建议】** 面板不要照搬 UI（它强依赖 DSH 设计令牌与 slot），**照搬 API 契约与三问信息架构**。VSCode 扩展作为「执行器客户端」时，需要的恰恰是这套 API 的一个子集（领任务/心跳/报告/读原始需求）。

### 3.5 Prompts / Skills / Tools 【事实】

- 提示词 = `prompts/*.md` 文本拼装，顺序固定（shared → 团队三节 → subscriptions/replies → 角色说明 → admission/环境/Policy）；Policy 段每次请求重新生成并放最后（docs/004:44-61）。
- 团队可覆写的只有少数「part」，覆写记录 `base`，升级时标记 **Default updated**（docs/004:20-42）。
- 边界：**工具与宿主校验 > 内置提示词 > 规则 > 团队文本 > 外部文本**（docs/004:63-71）；提示词不能改变授权（docs/004:36）。
- 技能：`skills/dsh-superagent-{feishu,github}/SKILL.md` 按需加载；运行时按 prompt revision 绑定/替换 skill scope（`sessions.ts:314-327`）。
- 工具注册：`agent.ctx.tools.register({name,description,parameters})`，主 Session 再 `restrict/guard`（`sessions.ts:206-216,262-268`）。

**【建议】** 本项目的「服务端 AI 生成流水线」不要写成 worker 提示词里的隐式步骤，而应做成**显式阶段 + 工件 + 人工 Gate**；提示词只负责「本阶段怎么干」，这与原型「facts 由宿主强制、流程由规则表达」的分工一致。

### 3.6 替换清单 【事实 + 推断】

| 想替换 | 必须实现/提供 | 可沿用 | 代价点 |
| --- | --- | --- | --- |
| Source | `SourceKind` 必填 6 项 + 需要的可选能力 + `SourceContext` 循环 + KV cursor + 设置/policy 接线 | Thread/Subscription/评估/回写全链路 | 低–中；SAP 需求系统需定 Trigger/Thread/Channel 三种 id |
| Executor | `start/deliver/stop` + 全部 `EngineForExecutor` 回调 + prepare 钩子 + 并发语义 | Engine/Policy/Outbox/面板 | 中；VS 扩展需加租约/心跳/离线队列 |
| Channel | `allowed/send/link`，`sent/gone` 语义与幂等 | Outbox 重试/顺序/丢弃 | 低 |
| Panel | HTTP API 客户端 | 视图模型（`src/app/views/*`）与三问 IA | 中；DSH slot/CSS 不可复用 |
| 主进程 | 重实现 Runtime 组合根 + Session 运行时 + effects 驱动 | `src/core/*` 几乎全部、`src/policy.ts`、`src/app/{effects,outbox,store}.ts` | 高；见 §6 |

## 4. 执行模型

- **一 Ticket 一 Session 一目录**：Session id `worker-<ticketId>`；目录名 = `WorktreeNameSchema` + ticket id 前 12 位（`src/executor/dsh.ts:24,57,96-111`），根目录 = `executor.directory || <stateDir>/work`（`src/app/execution-environment.ts:21`）。
- **prepare 只跑一次**：目录不存在时用 `sh -c` 在父目录执行，10 分钟超时；失败记 `PrepareFailed`，**不自动重试**（避免把失败残留当已准备），空目录会删掉（`dsh.ts:28,43,247-262`）。典型命令是 `git fetch` + `git worktree add`（docs/006:149-156）。
- **执行变量**：Executor 注册 `DSH_SUPERAGENT_{DIR,NAME,TICKET,BLOCKED_COMMANDS}`，Source 注册自己的变量；命令读环境变量，worker 从提示词读值（`src/app/execution-environment.ts:9-46`、docs/003:63-76）。**没有安全边界**，worker 仍可按绝对路径执行任意程序（docs/003:80）；隔离靠独立 OS 账号（docs/006:13-19）。
- **并发**：`WorkerSlots` 在 launch/wake 前同步预留槽位；人的消息可额外多占 1 槽，唤醒优先于新 launch（`dsh.ts:171-199`、docs/003:55-61）。
- **后台规则**：turn 结束仍有 shell job/subagent 时占着槽、保持 working；30 分钟后 kill shell job 并报 waiting（`dsh.ts:32,634-656`）；交给人的 handoff 立即释放槽，subagent 停、job 留给对方（`dsh.ts:588-600`）。
- **恢复**：重启后 `resume()` 把未完成的 Assignment 按创建顺序标记中断并带 recovery note 重启；`failed` 且等人则等（`dsh.ts:524-537`）；输入读取用 `session/event: user/message` 判定，避免「已投递未读」被误算（`dsh.ts:495-503`、docs/003:150）。

**【建议】** VSCode 版保留「一任务一隔离目录 + 一次性 prepare」的思想，但 `prepare` 下移到客户端并重新定义为 preflight（目录存在、分支基线、依赖已装、CLI 可用）。30 分钟后台/额外槽位/`worker-<id>` 命名都是 DSH 运行时细节，不应进本项目契约。

## 5. 授权模型

- **两层 Eval**：确定性准入 gate + 模型 assessment（docs/001:33、docs/007:136-147）。gate 在 `src/policy.ts:167-242`：先分人/机器，再查允许名单、`scope().observed`、准入表格子、Thread 后续；输出 `{strength, basis}` 或拒绝码（`not_a_member/not_human/admission_ignored/...`）。
- **允许名单按 Source 独立**，跨 Source 身份永不映射（docs/001:39、docs/002:32）；名单可外部同步（Feishu 群成员，`kind.ts:39-40`）。
- **准入表**：行 = 接收范围（群/私聊/Issue/PR/评论/CI），列 = 三种「在不在名单 × 有没有 @」组合；默认 `listedUnaddressed=inferred`、其余 `ignore`（`src/admission.ts:10-13`、docs/002:56-75）。
- **accept mode**：`off / observe / auto`；`observe` 只记 `would_accept` 不接单（`src/policy.ts:83-87,55-58`、docs/002:91-101）。
- **assessment 约束**：必须对每个启用规则各判一次、必须方向明确（`directionAllowed`）、必须给 `intent_evidence`、必须匹配至少一条规则（`src/policy.ts:26-61`）。
- **Mandate 不可变**：记录 strength/scope/Policy 版本/admission basis；只有三种事件改变它——accept、人 stop、恢复前重校验失败（`model.ts:126-133`、docs/002:125-145）。
- **Policy version = hash(rules, mode, 各 Source 的 policy part)**（`src/policy.ts:111-118`）；变更**不吊销**在办 Ticket，只发 `policy-changed` Input 说明哪条规则/资格/模式变了（`policy.ts:144-165`、docs/002:107-123）。
- **stop/resume**：面板 stop 是命令；聊天里说 stop 是普通 Trigger 由 Eval 决定；resume 不重新 Eval，但按 Mandate basis 重校验（`policy.ts:213-240`、docs/002:125-145）。

**【建议】** 本项目 v1 虽然只有一个 Source（SAP），也必须保留「准入表 + accept mode + 不可变授权记录 + Policy 版本」四件套，只是把「名单」换成 SAP 用户/角色、把「机器人名单」换成服务端 AI 的触发白名单。人工 Gate 属于另一个维度（人确认阶段产出），不要塞进准入 gate。

## 6. 与 DSH 的耦合面

| 能力 | 依赖 | 通用思想可搬？ |
| --- | --- | --- |
| 插件生命周期 `ctx.effect/on/inject`、Service、fiber restart | `@deepseek-ai/cordis`（`src/index.ts:7-25`、`runtime.ts:59,88,203`） | 思想可搬（注册/注销成对），API 不可搬 |
| Session/Agent：创建、rename、cancel、whenIdle、inbox、session/event、preset | `dsh-agent/dsh-session/dsh-session-persistence/dsh-permission-presets`（`sessions.ts:138-155,232-249`） | 不可搬；本项目换成 VSCode 会话 + 服务端任务运行时 |
| 工具注册与白名单 | `agent.ctx.tools.register/restrict/guard`（`sessions.ts:206-216,262-297`） | 思想可搬（能力白名单），API 不可搬 |
| 提示词注入 | `systemPrompt.section`、`AGENTS.md` 注入、`dsh-skill`（`sessions.ts:244-257`） | 思想可搬 |
| 客户端 UI | `dsh-client-ui-{slots,layout,sidebar,settings,plugin-manager}` + React（`client/index.tsx:2-58`） | 信息架构可搬，组件不可搬 |
| 子进程/shell/后台作业 | `dsh-subprocess`、preset 里 `tool-bash/tool-jobs` 的超时（`cordis.patch.yml:39-74`） | 不可搬；VSCode 侧用扩展 API/终端 |
| 部署 | `dsh` CLI、profile、tmux 脚本、`stateDir`（docs/006:71-132） | 不可搬；本项目需要自己的启动方式（`npx` 一条命令） |
| 模型 | DSH 的 LLM provider 与 role model（`sessions.ts:150`、`src/app/role-models.ts`） | 可替换，思想是「按角色配模型」 |

**【推断】** 真正不可移植的只有两处：**Agent/Session 运行时**（谁持有对话历史、谁执行工具）与**客户端 UI 容器**。领域、授权、队列、幂等、面板 IA 都不依赖 DSH。

## 7. 移植到「去中心化执行 + 可替换主进程」的最小重设计集

**【建议】** 按优先级排序，前 4 条是 v1 必须，后 4 条是演进项：

1. **控制平面契约独立于宿主**：把 `src/core/ports.ts` 的 6 个端口照搬成项目自己的 `ports`；主进程只负责「领域 + 持久队列 + HTTP API」，不实现 AI 会话。宿主适配层（本地 Node / 独立服务 / SAP 内嵌）只做启动、存储路径、鉴权。
2. **Executor 端口加租约**：`start/deliver/stop` 之外补 `claim(executorId, capabilities)`、`heartbeat(leaseId)`、`expire(leaseId)`；离线即租约过期、任务回队列。原型「slots 满则 `Later` 重试」的语义可以原样保留在服务端。
3. **工作区归属反转**：原型的目录在服务端（`<stateDir>/work/<name>`）；本项目目录在开发者机器。控制平面只存 `WorkspaceRef{repo, path, member}`，`prepare` 变成客户端 preflight，服务端只校验「该执行器声明拥有该 workspace」。
4. **报告幂等化**：沿用它「requestId / message.id 去重」的做法（`sessions.ts:162-169`、`dsh.ts:448-466`），把 `Assignment→Report` 做成可重放的 HTTP 事件流；这是断线重连与离线补交的基础。
5. **多实例/多控制平面**：原型靠 `lockSync(stateDir)` 单写（`runtime.ts:90-94`）。要支持「SAP 托管 + 本地开发」，需把 SQLite 换 Postgres、把锁换成 leader election 或按 aggregate 分片。
6. **VSCode 侧运行时**：Copilot Chat 负责对话与代码，扩展负责「领任务 → 建 worktree → 注入控制平面上下文 → 上报进度/产物」。原型的 worker 工具白名单（`WORK_TOOLS`）可直接翻译成扩展允许调用的命令集合。
7. **服务端 AI 流水线**：复用原型「主 Session 不写代码、只编排」的分工，但把一次性评估换成显式阶段机（Stage→StageRun→Artifact），人工确认点用结构化 `Attention`（`Ticket.attention`，由 WorkerReport 设置，`src/core/model.ts:275`），而不是从自由文本推断「在等人」（docs/001:60 明确拒绝这种做法）。
8. **面板/API**：保留管理 API 与三问 IA，前端可先用最小 Web 页，VSCode 扩展复用同一 API。原型的 6 tab 可映射为：需求（Source/Trigger 合并）/ 阶段（Eval）/ 任务与执行（Execution）/ 设置（Settings）。

## 8. 与 [000-vision](../000-vision.md) 概念的映射与缺口

| 本项目概念 | 原型最接近者 | 可继承的规则 | 缺口 |
| --- | --- | --- | --- |
| Demand 需求 | Thread（+ Ticket 根） | 一条 Thread 有多个 Ticket、事件不可变、人消息归属唯一 | 原型没有「需求级状态机」，需新增 |
| Stage / StageRun | 无 | — | **最大缺口**：Eval 是一次性判定，不是可重入阶段；需新设计阶段机与工件版本 |
| Task 任务 | Ticket | 动作授权（Mandate）、状态不跟随执行器、恢复重校验 | 需补「任务模板/阶段绑定」 |
| Assignment 指派 | Assignment | pending/running/ended、Report 六态、turnEnded/inputsRead 语义 | 需补租约/心跳/在线状态 |
| Artifact 工件 | Report.summary / PR / 评论 | 版本化保存、事实与草稿区分（诚实状态） | 原型无工件模型，需新增 |
| Gate 人工门禁 | Attention（结构化提问） | 一次一个具体问题、走原会话投递、可撤销 | 原型是问答不是审批；需加 approve/reject 决策与审计 |
| Executor | Executor 端口 | 三方法 + 回调全集 + 并发语义 | VSCode/Copilot 运行时 |
| Source | SourceKind | 契约全套 | SAP 需求系统适配 |
| Channel | SourceChannel + Outbox | 幂等发送、顺序、丢弃语义 | 需求系统评论/状态流转 |
| Presence / Workspace | 无 | — | 需新增（心跳、目录绑定） |
| Hook | 无（Feishu/GitHub 硬编码） | — | 需新增契约；原型 docs/007:275-287 正好列了「通用模块里硬编码 Source」的反面教材 |

## 9. 结论

**最值得借鉴 3 点**
1. **领域 Engine + 6 端口 + 持久 Effects/Outbox**：控制平面可换宿主，领域层零 I/O。
2. **SourceKind 契约（含 scope/admission/Channel/environment）**：一个 Source 只写「翻译 + 收发 + 名单」，其余全复用；新增触发源的成本最低。
3. **授权与执行分离**：不可变 Mandate + Policy 版本 + 恢复前重校验 + 结构化 Attention，而不是靠提示词约束 agent。

**最不该照搬 2 点**
1. **DSH 的 Session/Preset/工具/客户端 slot 运行时**：耦合面大、不可替换，且它的 30 分钟后台、5 秒 shell、额外 worker 槽都是 DSH 特有语义。
2. **它对「阶段/工件/人工审批」的缺失**：原型只有一次性 Eval + 自由 Report，没有 StageRun/Artifact/Gate；本项目若照抄会把服务端 AI 流水线压回 worker 提示词，重蹈「不可审计」的覆辙。

**读文分工**：概念与规则看 docs/000–005；扩展开发看 docs/008；模块索引看 docs/007；部署/权限模型看 docs/006。原型 README:3 的「research prototype」声明提醒：其工程实践不可直接当生产基线。
