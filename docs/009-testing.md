# 009 测试策略

本文把 [003](003-domain-and-protocol.md) 的规则与 [reference/stack-feasibility.md](reference/stack-feasibility.md) 的失败场景变成可执行的测试矩阵。每个 MVP 切片（见 [007-roadmap.md](007-roadmap.md)）必须附本文对应的用例才算完成。

## 1. 分层

| 层 | 范围 | 工具 | 运行时机 |
| --- | --- | --- | --- |
| 单元 | `core` 状态机、调度规则、checklist 判定、门禁校验；纯函数、内存仓库 | vitest | 每次提交 |
| 契约 | protocol schema 快照、OpenAPI/AsyncAPI diff、Hook 信封 schema、示例 payload | vitest + schema 校验 | 每次提交 |
| 集成 | `server` + SQLite + 假 SAP / 假 LLM / 假执行器；REST + WS 生命周期 | vitest + supertest/ws | 每次提交 |
| 端到端 | M1 本地模式全链路：建需求 → AI 阶段 → 门禁 → 客户端领取 → 工件 → 完成 | 脚本（`pnpm e2e`）+ 假执行器 | 每次提交 |
| 客户端 | VSCode 扩展：任务箱、claim/续约、上下文包、工具函数（mock `vscode` API） | vitest + `@vscode/test-electron` | 每次提交；VSIX 冒烟在发布前 |
| SAP 侧 | ABAP Unit（outbox 选取/退避、HMAC、字段映射、审批状态机、AI batch 的 JSON 映射/claim/result/超时分类）；`abap check syntax` | abap-cli + 测试系统 | 手动工作流（不连生产） |
| AI 质量 | golden set 回归：checklist 通过率、人工修改率、引用完整性 | 离线评测脚本 | 每周 / prompt 变更时 |

## 2. 失败场景矩阵（必须覆盖）

| # | 场景 | 层 | 断言 |
| --- | --- | --- | --- |
| 1 | 同一目录开两个窗口 / 双重 claim | 集成 | 第二个 claim 返回 409；只有一个 Assignment active |
| 2 | 领取后断网 | 集成 + e2e | 租约到期回池；恢复后先拉状态再续跑；无重复工件 |
| 3 | 服务端重启 | 集成 | WS 重连按 `lastSeq` 补齐；租约/任务/工件不丢；无重复派发 |
| 4 | 客户端时钟偏移 | 集成 | 只用 `serverTime` 判定过期；本地时钟错误不影响租约 |
| 5 | 用户切换工作目录 | 客户端 + 集成 | 立即 release；任务回池；新目录不显示该任务 |
| 6 | SAP 会话超时（abap-cli 400） | 客户端 | 不自动重试写操作；任务转 `waiting_human`；提示重新登录 |
| 7 | SAP 对象被锁 | 客户端 | 不重试；上报 holder；任务转人工 |
| 8 | 任务内容注入/越权 | 集成 + 客户端 | 任务文本被当数据；工具参数白名单拒绝越权动作；写操作需确认 |
| 9 | 权限被撤销（401/403） | 集成 + 客户端 | 清 token、停止接单、提示重新授权；不静默重试 |
| 10 | WS 事件游标过期 | 集成 | 返回 `resync_required`；客户端全量拉取后状态一致 |
| 11 | Hook 5xx / 4xx / 重复回执 | 集成 | 5xx 退避重试；4xx 死信；重复回执幂等；重放不重复建单 |
| 12 | SAP 回写 409 | 集成 | 重拉后 CAS 重放；最终一致；每日对账无差异 |
| 13 | 上游工件出新版本 | 集成 | 下游工件标 `stale`，阶段阻断，门禁提示 |
| 14 | 审批超时 / 撤销 | 集成 | Approval 转 `expired`/`withdrawn`；StageRun 不卡死 |
| 15 | 服务端 AI 超时 / 输出不合 schema | 集成 | 重试到上限转人工；不产生半成品工件；成本记账 |
| 16 | 需求未绑定仓库 / 用户账号映射变化 | 集成 + 客户端 | 未绑定任务进入通用任务箱；绑定任务只对匹配工作区可见；映射变化后可见性正确刷新 |
| 17 | SAP 批处理 job 重复 claim / 重复 result（S5/M3） | 集成 + e2e | 第二个 claim 返回 409；重复 result 幂等（只完成一次、只写一条 `stage.ai_job.completed`、只有一条 attempt ledger、不重复工件） |
| 18 | SAP 批处理 job 租约过期 / 超龄 / 网关失败（S5/M3） | 集成 + e2e | 租约过期回 `queued`（不增 attempt）；多次过期/超龄按阶段失败（重试到 `maxAttempts` → `waiting_human`）；网关失败/非法输出不产生半成品工件；启用时本地 provider 调用次数为 0 |

## 3. AI 输出质量评测

- **golden set**：20–30 条脱敏的 PDO 历史需求，覆盖简单/中等/歧义/跨模块；每条有期望 checklist 与人工基线版本。
- **指标**：schema 通过率、checklist 通过率、引用完整性（每条验收标准可追到需求锚点）、人工修改行占比、单阶段成本。
- **阈值**：人工修改率 <15% 的阶段才允许 `auto`；否则默认 `observe`（只出草稿）。阈值可配置，但默认保守。
- **回归**：prompt 变更必须跑 golden set 并与上一版对比；劣化超过阈值阻止合并。
- **真实样本**：上线后每周抽样 5 条真实需求，记录人工修改率；连续两周超标则降级该阶段自主度。

## 4. CI 门禁

```sh
pnpm check        # typecheck + lint + unit + contract
pnpm e2e          # 进程内全链路（含 SAP 宿主批处理 AI，见 §2 #17/#18）
pnpm build        # 所有包按依赖拓扑序构建
pnpm sap:check    # SAP AFF 离线校验（CI 不连 SAP；在线 check syntax 手动）
pnpm contract:gen # 生成 openapi/json-schema 并检查 diff（S5 后为 59 schemas / 9 examples / 27 routes）
```

- PR 必须通过上述命令；协议变更必须附 `contracts/` diff 与迁移说明。
- 客户端改动额外跑 `pnpm --filter vscode test`；发布前构建 VSIX 并冒烟安装。
- SAP 改动走 `pnpm sap:check` 离线门禁（`abap validate:aff` + `abap check content`）+ 手动 `abap-check` 工作流：连接测试系统，`check syntax` + ABAP Unit；**永不连生产**。
- M3 部署文档（[010](010-m3-deployment.md)）的验收 checklist 在 Phase B 真机上执行，证据记录到 `handoffs/STATUS.md`。
- 文档改动跑本地链接检查（脚本在 `scripts/`）。

## 5. 测试数据与环境

- 所有夹具使用虚构需求、虚构仓库名、虚构 SAP 对象；禁止使用真实客户数据。
- 假 SAP 适配器实现 ICF JSON 最小子集（需求/审批/回写），支持故障注入（超时/409/401）；假 LLM 返回固定 JSON，用于 e2e 与成本测试。
- M3（S5）用 `FakeSapAiBatch`（进程内模拟 SAP 批处理执行器，HMAC 调 job API）与 `FakeAiGateway`（OpenAI 兼容响应 + 超时/5xx/429/坏 JSON 注入）；**测试不依赖真实 SAP 系统或真实 AI 网关**。
- 集成测试默认 SQLite 内存库；Postgres 相关用例在 CI 单独矩阵（M2）。
