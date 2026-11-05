# Changelog

本项目的用户可见变更记录在本文件。

格式遵循 [Keep a Changelog 1.1.0](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本 2.0.0](https://semver.org/lang/zh-CN/)。
改动范围以 README、[docs/](docs/) 与 `contracts/` 为准；测试与环境说明见 [docs/009](docs/009-testing.md)。

## [Unreleased]

## [1.0.0] - 2026-11-05

首个发布版本。覆盖路线图 S0–S5 Phase A（本地闭环、门禁/模板/golden、SAP 需求系统、多人在线派发、
Hook、SAP 批处理 AI），以及 S5 Phase B 中 SAP 侧可独立验证的部分。Phase B 其余输入仍 blocked，
未做真机端到端验收，见 [Known issues](#known-issues)。

### Added

#### 协议与契约

- `@sap-superagent/protocol`：zod schema 与 TypeScript 类型、事件 envelope、错误体与各阶段请求/响应定义，
  是控制平面、CLI 与客户端共享的唯一契约（[docs/003](docs/003-domain-and-protocol.md)）。
- 机器可读契约入库并由 `pnpm contract:gen` 生成：`contracts/json-schema/`（59 个 JSON Schema）、
  `contracts/examples/`（9 个示例）、`contracts/openapi.yaml`；`pnpm contract:check` 校验快照与 27 条核心路由说明。
- 执行器注册携带 `cliVersion`（持久化并在执行器实体中返回）；协议版本 `protocolVersion` 固定为 `1.0.0`。

#### 控制平面（server）

- M1 本地模式一条命令启动：Fastify HTTP + WebSocket，`node:sqlite` 持久化（迁移 v1–v7 只追加），
  单状态目录单实例锁（[docs/002](docs/002-architecture.md)）。
- 需求 → 阶段 → 任务主流程：阶段模板驱动、确定性领取规则（角色/工作区/在线/并发）、租约续约与过期回收、
  presence 心跳、Idempotency-Key、不可变事件日志与 `after=lastSeq` 补流。
- 审批门禁：通过/驳回/撤回/超时；工件不可变版本、supersede、上游新版本导致的 `stale` 传播与门禁阻断。
- 多人在线与派发：WS `task.offered` 只发给满足资格的执行器连接、每用户并发上限（默认 2）、
  任务转交回池（审计事件 + 幂等 + 冲突 409）与客户端断线重连 `resync_required` 全量恢复。
- 通用 Hook：配置驱动事件订阅、出站 outbox（指数退避/死信/取消/重放）、入站 HMAC 回执、只读对账命令
  `pnpm hooks:reconcile`（[docs/008](docs/008-hooks.md)）。
- SAP 集成：`/hooks/sap` 入站 webhook（HMAC ±5 分钟、`X-SA-Delivery` 幂等）、回写 worker、
  `pnpm sap:reconcile`（[docs/004](docs/004-sap.md)）。
- M3（默认关闭）`sap_ai_jobs` 队列：租约/幂等/sweeper/重启恢复、HMAC job API
  （`next`/`claim`/`heartbeat`/`result`）、admin requeue 与 `/hooks/sap/status` 队列计数
  （[docs/003 §4.8](docs/003-domain-and-protocol.md#48-sap-批处理-ai-执行器m3s5)）。

#### 核心领域（core）

- 需求/阶段状态机、调度规则、阶段模板 registry（`default` 3 阶段 G1/G3/G4、`pdo` 6 阶段 G1–G5）、
  checklist 断言与上下文包生成；模板与断言都是配置而非代码分支。
- golden set 离线评测框架 `pnpm eval:golden`（24 条脱敏 PDO 需求，见下）。

#### 服务端 AI（ai）

- BYOK 模型接入：OpenAI 兼容 / DeepSeek / Azure OpenAI 通过 baseURL/model 配置；无 Key 时使用离线
  fake provider（e2e 与离线开发不依赖网络）。模型 Key 只在服务端，见 [docs/005](docs/005-clients-and-ai.md)。
- 阶段 prompt 渲染、结构化输出校验、run ledger（token/成本记账）。
- golden set 评测：`pnpm eval:golden` 输出 `evals/report.json`，本版本 24 cases，
  schema / checklist / reference integrity 均 100%，人工修改率 11.2%，autonomy 建议 `auto`（脚本只给建议，不改模板）。

#### CLI（cli）

- `sap-superagent init` / `dev` / `token` / `doctor`：初始化工作区绑定、启动本地控制平面、
  单独签发 user/admin token、环境自检（Node/pnpm/端口/状态目录/模板/AI）。

#### VSCode 扩展（clients/vscode）

- 任务箱：可领取 / 我的任务 / 「等待我回答」（审批与未读通知），领取、打开任务（生成
  `.sap-superagent/task/<taskId>/context.md` 供 Copilot Chat `#file` 引用）、提交工件、切换接单。
- token 存 `SecretStorage`；WS 实时刷新、指数退避重连、`lastSeq` 持久化与全量 resync；
  工作区绑定与切换目录立即回池；claim 前 client preflight（工作区信任、仓库状态、`abap` 可用性等）。
- 发布前新增可复现 VSIX 打包与真实 VS Code Extension Host 冒烟脚本（`pnpm package:vsix` /
  `pnpm vscode:smoke`），本地/发布前运行，CI 不跑（依赖图形宿主）。

#### SAP 侧（sap/）

- 测试系统本地包 `$ZSA`（无传输请求）内对象：6 张 DDIC 表（`ZSA_DEMAND`、`ZSA_DEMAND_T`、
  `ZSA_ARTIFACT`、`ZSA_APPROVAL`、`ZSA_EVENT_OUT`、`ZSA_CFG`）、`ZCL_ZSA_JSON`、
  `ZCL_ZSA_EVENT_PUSH`、`ZCL_ZSA_HTTP_HANDLER`、ICF 节点 `/sap/zsa`、MIME `/zsa/ui`、
  SM36 入口 `ZSA_OUTBOX_PUSH`；AFF 源文件入库，`pnpm sap:check` 离线校验（不连 SAP）。
- M3：`ZCL_ZSA_AI_BATCH`（取 job → 企业 AI 网关 → 回传模型原始输出）与 `ZSA_AI_BATCH_RUN`
  SM36 周期 job 入口、`ZSA_CFG` 新键；测试系统上 ABAP Unit 15/15（Phase B 的 B1/B2）。

#### 示例与文档

- Hook 占位适配器 `examples/hooks/`（JIRA / CHARM / Confluence / Teams，只配置样例）+ `http` 示例目标。
- 部署与运维：[docs/010](docs/010-m3-deployment.md)（M3 拓扑、网络矩阵、TLS、配置与密钥边界、
  单节点 systemd/docker compose、反向代理、SQLite 备份恢复、SAP 侧 SM36/bgRFC、数据边界、runbook、
  Phase A/B 验收 checklist）。
- 端到端测试 `pnpm e2e`：17 条进程内全链路（需求→AI→门禁→任务→多执行器→Hook→SAP 回写→SAP 批处理 AI），
  总时长约 4 秒；CI 为 GitHub Actions，执行 `pnpm install --frozen-lockfile` + `pnpm check` + `pnpm e2e`。
- 仓库物料：CONTRIBUTING（Conventional Commits + DCO）、CODE_OF_CONDUCT、SECURITY、NOTICE
  （声明 `.agents/skills/abap-cli*` 的 MIT 来源）、Issue/PR 模板、设计文档 000–010、设计演示 `demo/`。

### Changed

- 版本统一为 `1.0.0`：8 个 workspace 包、CLI `--version`、`GET /healthz` 返回的 `version`、
  `contracts/openapi.yaml` 的 `info.version`、执行器注册示例的 `cliVersion`；线协议版本 `protocolVersion`
  保持 `1.0.0` 不变。
- 阶段模板从 S0 的手建任务演进为配置驱动：`templates/default.yaml`（3 阶段 G1/G3/G4）与
  `templates/pdo.yaml`（6 阶段 G1–G5），`POST /admin/tasks` 仅保留给 S0 兼容与运维手建。
- `server-ai` 阶段在 M3 下可委派给 SAP 批处理 job；不设置 `SA_SAP_AI_BATCH` 时行为与 S0–S4 一致。
- Hook 默认全部禁用（`examples/hooks.yaml` 全部 `enabled: false`），不改变既有部署行为。

### Fixed

- SAP 侧对象在真实测试系统激活后修复的兼容问题：ABAP SQL strict mode、`UP TO` 位置、
  HMAC hex 计算、`cl_system_uuid`/MIME API、`COMMENT` 保留字与 DDIC 字段类型降级等（PR #7）。
- ABAP Unit 断言错误（`find()` 未命中返回 `-1`）修复后 `ZCL_ZSA_AI_BATCH` 单测 15/15（PR #14）。
- 修复两处 CI 偶发失败：SAP job 租约用例的时序竞态、S0 resync 用例对固定等待窗口的假设（PR #16）。
- Hook 回执幂等键按 Hook 作用域隔离，修复同一外部幂等键在不同 Hook 间被误判为重复的问题。

### Security

- 控制平面与模型上下文不持有 SAP/SSO 凭据；BYOK 模型 Key 只在服务端环境变量/secret manager，
  不入库、不下发客户端、不写日志。
- SAP↔控制平面 HMAC（`X-SA-Signature` / `X-SA-Timestamp` ±5 分钟 / `X-SA-Delivery`）覆盖 Hook 投递与
  M3 job API；mutation 接口要求认证与幂等键。
- M3 的 AI 网关 key 只在 SAP 安全存储（`ZSA_CFG.AI_KEY_REF` 只存引用名），控制平面不持有；
  prompt 与模型原始输出只在「控制平面 → SAP → 企业内网网关」路径传输，SAP/控制平面日志不落正文。
- 仓库不含真实 SAP 地址与凭据：`.env`、`.abap.json`、`.abap-cli/`、客户端状态、`.vsix`、日志与构建产物
  均已 gitignore；`.env.example` 只有占位符。
- 本版本**未进行独立第三方安全审计或渗透测试**，不声称存在或不存在特定 CVE；安全模型见
  [docs/002 §7](docs/002-architecture.md#7-非功能基线)、[docs/005 §2.6](docs/005-clients-and-ai.md#26-失败与安全)、
  [docs/010 §7](docs/010-m3-deployment.md#7-数据边界声明)；报告渠道见 [SECURITY.md](SECURITY.md)。

### Known issues

- **S5 Phase B（M3 真机端到端）仍 blocked**：SAP 侧对象已在测试系统创建/激活且 ABAP Unit 15/15
  （B1/B2），但 B3–B10 未执行。缺少的输入：控制平面可达 + HMAC/服务账号、SM36 调度窗口、
  企业 AI 网关 URL/model/key 与安全存储。未做真机端到端验收，不以离线 e2e 代替；清单见
  [docs/010 §9.3](docs/010-m3-deployment.md#93-phase-b-人工输入清单blocked-判据)。
- **单节点、无 HA**：控制平面是一个 Node 进程 + SQLite + 本地工件目录，不支持多副本/水平扩展；
  高可用按「快速重启 + 备份恢复」设计（[docs/010 §5.7](docs/010-m3-deployment.md#57-端口单实例与伸缩边界)）。
- **SM36 调度粒度**：SAP 周期 job 建议 1 分钟，M3 的 AI 阶段端到端延迟通常为 1–2 个周期；
  更低延迟不在本版本范围（[docs/010 §6.5](docs/010-m3-deployment.md#65-sm36-周期-job默认调度通道)）。
- **ABAP 网络超时依赖 ICM**：`ZCL_ZSA_AI_BATCH` 未在代码里设置 `cl_http_client` 客户端级 timeout，
  网络超时需在 ICM/SM59 配置（建议 ≤ 控制平面租约），Phase B 首次真机验证时复核
  （[docs/010 §6.8](docs/010-m3-deployment.md#68-出站代理与防火墙)）。
- **权限模型 v1 粗粒度**：token 分为 user/admin/executor，无细粒度角色/多租户；SAP 页面走 SSO，
  但 v1 不建模 SAP 权限映射。
- **Hook v1 边界**：四个适配器只是配置样例，不实现业务逻辑；入站回执只记录 + 发事件，不推进阶段
  （`advanceOnReceipt` 必须为 `false`），按 `externalId` 回写工件链接留给后续版本（[docs/008 §4](docs/008-hooks.md#4-入站回执)）。
- **模板版本回退**：需求固定 `templateId@version`；旧版本模板文件缺失时回退到最高已加载版本，
  跨重启严格锁定留待后续（[docs/003 §2.7](docs/003-domain-and-protocol.md#27-阶段模板-stagetemplate)）。
- **G3 单角色**：协议 gate 只声明一个角色，G3 以 `consultant` 作为主审批角色，多角色会签留给后续
  （[docs/003 §2.5](docs/003-domain-and-protocol.md#25-门禁-approval)）。
- **VSCode 扩展**：真实 Extension Host 冒烟只在本地/发布前执行（CI 无图形宿主）；未发布到
  VS Code Marketplace，按 GitHub Release / VSIX 分发。
- **M3 网关兼容性**：默认 OpenAI 兼容 `POST <AI_GATEWAY_URL>/chat/completions`；ABAP AI SDK 与
  bgRFC 属 Phase B 决策，本版本不实现（[docs/010 §10](docs/010-m3-deployment.md#10-已知限制)）。

[Unreleased]: https://github.com/chunrichi/sap-super-agent/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/chunrichi/sap-super-agent/releases/tag/v1.0.0
