# S5 Phase B 执行交接（下一个 session 从这里开始）

> **读者**：接手继续推进本项目的执行 Agent。S5/M3 **Phase A 已合入 `main`**（PR #13/#14），Phase B 已完成"SAP 侧可独立完成"的部分；本文件给出**剩余 Phase B 的人工输入清单、B3–B10 执行步骤、测试系统现状、环境坑**与可直接复制的启动 Prompt。
> **基线（2026-11-05）**：`main = 370286e`（S0–S5 Phase A 全部合入）；门禁 `pnpm check` ✅ **469 tests**（contract 59 schemas / 9 examples / 27 routes）、`pnpm e2e` ✅ **17/17（~4.3s）**、`pnpm build` ✅ 8/8、`pnpm sap:check` ✅ 离线 5 pass/1 skip（在线 `SA_SAP_CHECK_ONLINE=1` 6 pass）。
> **权威文档**：任务书 [S5-sap-hosted-mode.md](S5-sap-hosted-mode.md)（§1.7 Phase B / §2 验收）、协议 [docs/003 §4.8](../docs/003-domain-and-protocol.md)、M3 部署与 checklist [docs/010-m3-deployment.md](../docs/010-m3-deployment.md)（§9.2 B1–B10、§9.3 输入清单）、SAP 对象与 blocked [sap/README.md](../sap/README.md)、看板/证据 [handoffs/STATUS.md](STATUS.md)（「S5 偏差与遗留」「S5 Phase B 进展」）。

## 0. 一分钟现状

- **已完成并合入 `main`**：S0–S4、H2 Phase A/B、S5 Phase A（契约 §4.8、v7 `sap_ai_jobs` 队列/租约/幂等、HMAC job API、ABAP `ZCL_ZSA_AI_BATCH`/`ZSA_AI_BATCH_RUN`、FakeAiGateway/FakeSapAiBatch、pdo 无 executor 全链路 e2e、docs/010）。
- **S5 Phase B 已完成（2026-11-05，测试系统 profile `test`；未碰生产）**：
  - `ZCL_ZSA_AI_BATCH`（+testclasses）与 `ZSA_AI_BATCH_RUN` 已 `abap create/push` 并激活（本地包 `$ZSA`，无 TR）；
  - `abap check syntax` 通过；`abap test ZCL_ZSA_AI_BATCH` **15/15**；`abap pull --active` 回拉与仓库源码一致（仅 SAP 侧 CRLF/末尾换行）；
  - `SA_SAP_CHECK_ONLINE=1 pnpm sap:check` → **6 pass / 0 skip**。
- **仍 blocked（人工输入，不得伪造）**：控制平面可从测试系统访问 + `SA_SAP_HOOK_SECRET` 注入；控制平面→SAP 服务账号；SM36 调度窗口；企业 AI 网关 URL/model/key/安全存储/TLS。因此 `ZSA_CFG` 业务键未写、SM36 未建、端到端 M3 未跑（B3–B10）。
- 详细命令/输出见 [STATUS「S5 Phase B 进展」](STATUS.md#s5-phase-b-进展2026-11-05真机部分完成)。

## 1. 开工检查（先验证环境，再动手）

```sh
cd /Users/lei/ai_space/sap_super_agent
git status --short                      # 应干净
git log --oneline -3                    # main = 370286e 或更新
pnpm install --frozen-lockfile --offline
pnpm check && pnpm e2e && pnpm build && pnpm sap:check

abap --version                          # 期望 2.6.1（>= 2.2.0）
abap doctor --json                      # data.ok = true
abap profile test test --json           # TLS/auth/ADT/ICF 全 ok（只连测试系统）
```

- 任一门禁不绿：先停下报告，不要继续。SAP 侧任何命令都先确认 `--profile test`（`abap profile test test` 的输出）；**永不连生产**。
- `.abap.json` 位于仓库根（gitignored）；abap 命令统一从仓库根运行。
- 已知 warning：`abap pull/push` 的 `SESSION_STORE_FALLBACK`（home 不可写 → workspace store）不阻断；`abap deploy status` 的 `ICF_OUTDATED_DEADLOCK` 不阻断。

## 2. 两条推进线

### A. S5 Phase B 收尾（主任务；依赖人工输入）

输入齐备后按 [docs/010 §9.2](../docs/010-m3-deployment.md) 的 B3–B10 执行；§4 给出逐步命令与证据要求。**输入不齐时**：记录 blocked（哪些输入缺失、已确认到哪一步），不要用假数据冒充真机结果；可以先把 B 线做完。

### B. v1.0 发布准备（不依赖 SAP 输入，可先做）

按 [docs/007 §2](../docs/007-roadmap.md) 发布检查表：

1. `README` 快速开始重跑一遍（M1 本地模式），确认 `pnpm check` / `pnpm e2e` / `pnpm build` / `pnpm sap:check` / `pnpm contract:check` 与文档一致。
2. **VSCode VSIX 冒烟（H0/S3 遗留）**：仓库当前**没有** VSIX 打包脚本/`vsce` 依赖（只有 `packages/clients/vscode` 的 tsc/vitest 脚本）；发布前需补 `@vscode/vsce` 打包步骤（`npx @vscode/vsce package`），在真实 Extension Host 里做任务箱/claim/上下文包/审批动作冒烟。属于发布 gate，非 S5。
3. `pnpm eval:golden`（当前 24 cases：schema/checklist/reference 100%、人工修改率 11.2% → auto 建议；report 确定性、无 diff）。
4. CHANGELOG /版本 tag（`v1.0.0`）/ 许可证与安全声明核查；`AGENTS.md`、`HANDOFF.md` 状态同步。
5. abap-cli 上游 [issue #34](https://github.com/chunrichi/abap-cli/issues/34) 修复后，可把 H2-B 的 6 张表重建为 `#NOT_EXTENSIBLE`（可选，非阻塞）。
6. 文档链接检查：`docs/009` 提到"脚本在 scripts/"，但仓库**暂无** link-check 脚本；如做发布，补一个 `scripts/link-check.mjs` 或人工抽查相对链接。

## 3. Phase B 人工输入清单与就绪检查

| # | 输入 | 用途（卡住什么） | 就绪验证 | 2026-11-05 状态 |
| --- | --- | --- | --- | --- |
| 1 | 控制平面可达（SAP→CP 内网地址/隧道）+ `SA_SAP_HOOK_SECRET`（两侧同一把） | SAP job API `/api/v1/sap/ai-jobs/*` 与 `/hooks/sap` | 从测试系统网络能到 CP `GET /healthz`；CP 的 `.env` 有 `SA_SAP_HOOK_SECRET`，与 SAP 侧安全存储一致；`abap run`/HTTP 探测无凭据 401、带 HMAC 200 | ❌ 缺 |
| 2 | 控制平面→SAP 服务账号（ICF 回写/对账） | `SA_SAP_BASE_URL` + `pnpm sap:reconcile` / 回写 | CP 配好服务账号后 `pnpm sap:reconcile` 能拉取需求；H2-B 曾证实 ICF 节点可达（无凭据 401），缺登录凭据 | ❌ 缺 |
| 3 | SM36 调度窗口与作业权限 | `ZSA_AI_BATCH_RUN`、`ZSA_OUTBOX_PUSH` 周期 job | Basis 创建 SM36 job 并跑出 SM37 成功日志；周期建议 1min、必须 < CP 租约（默认 10min）、与 `AI_TIMEOUT_MS`/ICM 超时协调 | ❌ 缺 |
| 4 | 企业 AI 网关 URL/model/key + 安全存储注入 + 出口策略/TLS | `ZCL_ZSA_AI_BATCH` 调网关 | `ZSA_CFG` 的 `AI_GATEWAY_URL/MODEL` 可用；`AI_KEY_REF` 安全存储取值成功；STRUST 信任网关证书；ICM/SM59 配网络超时；SAP release/许可确认走网关还是 ABAP AI SDK | ❌ 缺 |
| 5 | 测试系统（S/4HANA，profile `test`）可达、`abap doctor` 通过 | 所有 SAP 侧步骤 | `abap profile test test --json` 全 ok | ✅ 已满足 |

> 输入齐备前不要写 `ZSA_CFG` 业务键、不要建 SM36 job（值不确定会留脏配置）。

## 4. Phase B 执行步骤（B3–B10，输入齐备后）

### B3 写入 `ZSA_CFG`（6 键）并验证安全存储

| KEY | 值来源 | 说明 |
| --- | --- | --- |
| `CONTROL_PLANE_URL` | 输入 1 | CP 的 base URL（如 `https://<cp-host>:<port>`）；SAP 侧拼接 `/api/v1/sap/ai-jobs/...` 与 `/hooks/sap` |
| `HMAC_SECRET_REF` | 输入 1 | 指向安全存储中 HMAC secret 的引用名（**不存明文**） |
| `AI_GATEWAY_URL` | 输入 4 | OpenAI 兼容网关 base URL；`ZCL_ZSA_AI_BATCH` 追加 `/chat/completions` |
| `AI_GATEWAY_MODEL` | 输入 4 | 兜底模型（payload 的 `model` 优先） |
| `AI_KEY_REF` | 输入 4 | 网关 key 的安全存储引用名（**不存明文**） |
| `AI_TIMEOUT_MS` | 输入 4（可默认 120000） | 有效网关超时 = min(payload `timeoutMs`, 本值)；网络层超时仍由 ICM/SM59 控制 |

- 写入方式：SE16/SE16N 手工插入或在测试系统执行一次性程序（ZSA_CFG 表结构见 [sap/src/zsa_cfg.tabl.ddic](../sap/src/zsa_cfg.tabl.ddic)）；只连测试系统、**不记录真实地址/密钥**。
- 验证：`abap select --table ZSA_CFG --fields CFG_KEY,CFG_VALUE --where "MANDT = '100'" --json`（表名/字段以实际为准，注意 `MANDT`）；确认不含明文 secret。
- 安全存储：`AI_KEY_REF`/`HMAC_SECRET_REF` 的实际实现（Basis 应用密钥 / SSF / 自定义加密表）由 Basis 确认；ABAP 侧取值接口若需调整，走 abap-cli 修改 `ZCL_ZSA_AI_BATCH`（先 `pull` 后 `push`，不手改系统源码）。

### B4 控制平面可达与回写/对账

1. CP 侧：按 [docs/010 §5](../docs/010-m3-deployment.md) 部署（systemd 或 docker compose），配置 `SA_STATE_DIR`、`SA_HTTP_PORT`、`SA_SAP_HOOK_SECRET`、`SA_SAP_BASE_URL`、服务账号；启动后用 `GET /healthz` 验证。
2. SAP 侧：用 `abap run` / 临时 report 或网关探测确认能到 CP（无 MAC 401、带 HMAC 200）。
3. CP→SAP：`pnpm sap:reconcile` 只读对账应能跑通（H2-B 遗留项）。

### B5 SM36 调度

1. SM36 创建周期 job：程序 `ZSA_AI_BATCH_RUN`（S5）+ `ZSA_OUTBOX_PUSH`（H2-B）；周期建议 1 分钟，互不重叠（多实例并发安全：claim 409 跳过，但会产生无效流量）。
2. SM37 观察首次执行：无 dump、有汇总 WRITE 行；失败看 BAL `ZSA/AI_BATCH`（SLG0 未配置时 BAL 静默跳过，SM37 仍有 `WRITE` 汇总）。
3. 可在 SM37 手动立即执行一次做冒烟；确认没有产生重复工件/事件。

### B6 端到端 M3（核心验收）

前置：CP 以 `SA_SAP_AI_BATCH=1` + `SA_SAP_AI_STAGE_KEYS`（可选，白名单）启动；SAP 侧 job 已能跑、`ZSA_CFG` 已配。

流程与证据：

1. SAP Web 提交 pdo 需求（ICF+MIME 页面）→ 5 分钟内进 CP（`demand.submitted` outbox 推送成功）。
2. 无开发者在线：SAP batch 生成 `intake`/`requirement_analysis`（`stage.ai_job.queued/claimed/completed` 事件、`GET /hooks/sap/status` 的 `aiJobs` 计数）。
3. SAP 内审批 G1/G2（SAP Web → `POST /api/v1/demands/{id}/approvals` → outbox → `/hooks/sap`）→ 阶段推进；无 client 在线。
4. `dev_implementation` 由 vscode 执行器完成（真机可用开发者或测试 executor claim/complete）后注销 → 之后无 executor 在线；SAP batch 生成 `test_doc`；审批 G4/G5；`knowledge_archive`；需求 `done`。
5. 证据：事件链（`GET /api/v1/events`）、`ZSA_DEMAND`/`ZSA_ARTIFACT` 查询、SM37 日志、`GET /hooks/sap/status`、`sap/README.md` 的 Phase B 记录；**不记录密钥/真实地址**。

### B7 失败演练

- 网关 5xx/超时/非法输出：`stage.ai_job.failed`（reason `sap_failed`/`invalid_output`），控制平面重试到 `waiting_human`，**无半成品工件**；`aiJobs.failed` / `lastError` 可见。
- admin requeue：`POST /api/v1/admin/sap/ai-jobs/{id}/requeue`（admin Bearer，幂等）；记录 200/409 分支。
- 重复 result/claim：幂等（不重复工件/attempt/事件）。

### B8 数据边界核对

- SAP 与 CP 日志无 prompt/输出正文（BAL/SM37、CP stdout）。
- `ZSA_CFG` 无明文密钥；CP 不持有网关 key。
- 出口策略：SAP→网关仅内网/白名单；CP 与 SAP 日志、防火墙记录核对。

### B9 重启/升级演练

- 重启 CP：`CLAIMED` 且租约过期的 job 回 `queued`、`running` 无 job 幂等补建；SAP 侧 SM37 继续处理；无重复工件/事件。
- 升级：SQLite 迁移 v7 只追加；按 docs/010 §5.8 备份→停服→升级→启动。

### B10 记录

- 更新 [handoffs/STATUS.md](STATUS.md) S5-B 行（状态/owner/分支/提交/验证/偏差）与「S5 Phase B 进展」；
- [docs/010 §9.2](../docs/010-m3-deployment.md) checklist 勾选（B3–B10）；
- 报告：命令与输出摘要、证据（脱敏）、与契约偏差、遗留。

## 5. 测试系统已部署对象（2026-11-05 实测，勿重复 create）

| 来源 | 对象 | 状态 |
| --- | --- | --- |
| H2-B | `ZSA_DEMAND`/`ZSA_DEMAND_T`/`ZSA_ARTIFACT`/`ZSA_APPROVAL`/`ZSA_EVENT_OUT`/`ZSA_CFG` | 已创建并 active（EXCLASS 3/4 为 abap-cli 缺陷绕行） |
| H2-B | `ZCL_ZSA_JSON`、`ZCL_ZSA_EVENT_PUSH`、`ZCL_ZSA_HTTP_HANDLER`（各 3 ABAP Unit）、ICF `/sap/zsa`、MIME `/zsa/ui`、`ZSA_OUTBOX_PUSH` | 已创建并 active |
| S5 | `ZCL_ZSA_AI_BATCH`（15 ABAP Unit）、`ZSA_AI_BATCH_RUN` | 已创建并 active；`abap test` 15/15 |

- **存在性判断**：`abap pull <name>` / TADIR / DD02L；**不要**用 `abap list --package`（对不存在包假阴性）或 `abap search`（对 `$` 包对象返回空）。
- 已存在对象再 `abap create` 会 `OBJECT_EXISTS`：走 `abap pull` → 编辑 → `abap push`。
- `$ZSA` 是本地包（`$` 前缀，无 TR）；不要建传输请求。

## 6. 环境与已知坑（已实测）

- **abap-cli 2.6.1**（Node 24.22.x）；`.abap.json` 在仓库根、gitignored；`SESSION_STORE_FALLBACK` warning 不阻断。
- **`SA_SAP_CHECK_ONLINE=1 pnpm sap:check`** 会 `abap check syntax --all` 递归扫仓库根；worktree 已清理，当前为 6 pass/0 skip。
- **DDIC 创建缺陷**：abap-cli 2.2.0 `create TABL` 的 EXCLASS/STRING 问题（上游 issue #34）已用一次性 bootstrap 绕行；本 session 用 2.6.1，新建对象是 CLAS/PROG，未受影响。
- **ABAP Unit 真机教训**：ABAP `find()` 未命中返回 `-1`（不是 0）——离线 `check content` 不能替代 `abap test`。
- **网关无客户端 timeout API**：`ZCL_ZSA_AI_BATCH` 未设 `cl_http_client` timeout（沿用 event_push 模式），需 ICM/SM59 配网络超时（建议 ≤ 租约 10min）；`AI_TIMEOUT_MS` 只驱动有效超时计算与续租时机。
- **非 ASCII prompt 的 HMAC/HTTP 编码**：与 outbox 同机制，Phase B 必须用含中文的 prompt 真机打通验证。
- **BAL 日志**：应用日志对象 `ZSA`/`AI_BATCH` 需 SLG0 配置；未配置时 BAL 调用静默跳过（job 不失败）。
- **CI**：GitHub Actions `pnpm check` + `pnpm e2e`（约 1 分钟）；时间竞态测试已修（PR #16），不要重新引入固定 sleep/紧窗口断言。工作流只对 `main` push 与 PR 触发。
- **端口 3080** 被 DSH Web GUI 占用：手工冒烟用 `SA_HTTP_PORT`/`--port` 或测试端口 0。
- **迁移/契约纪律**：迁移只追加（当前最新 v7）；改 protocol 必须 `pnpm contract:gen` 提交 `contracts/` diff（CI `--check`）。
- **测试 flake**：`pnpm check` 的 server 测试对时间敏感（租约/retention），复跑一次再判断；不要用固定端口/固定地址。

## 7. 验收 / DoD

**Phase B（S5-B）done 需同时满足**：

1. [docs/010 §9.2](../docs/010-m3-deployment.md) B1–B10 全部完成并有脱敏证据；
2. `pnpm check` / `pnpm e2e` / `pnpm build` / `pnpm sap:check` / `pnpm contract:check` 仍全绿；
3. 无开发者在线时 SAP batch 能生成需求分析/测试文档、SAP 内审批可推进、错误可重试/转人工；
4. 数据边界证据（日志无正文、无明文 key、无外网外发）；
5. `handoffs/STATUS.md` 更新（S5-B 行 + 证据）；未提交密钥/地址/`.env`/TR。

**发布准备（B 线）**：见 §2；VSIX 真实 Extension Host 冒烟是唯一未完成的客户端 gate。

## 8. 可直接复制的启动 Prompt

> 你在 `/Users/lei/ai_space/sap_super_agent` 工作（`main` 应为 `370286e` 或更新）。先读 `HANDOFF.md`、`handoffs/STATUS.md`、[handoffs/S5-phase-b-handoff.md](S5-phase-b-handoff.md)（本文件），再按需读 [docs/010](../docs/010-m3-deployment.md) §9、[docs/003 §4.8](../docs/003-domain-and-protocol.md)、[sap/README.md](../sap/README.md)。第一步跑开工检查（`git status`、`pnpm check`/`pnpm e2e`、`abap doctor`/`abap profile test test`），确认环境后再动手。S5 Phase A 已合入；Phase B 只剩人工输入（控制平面可达 + HMAC/服务账号、SM36、企业 AI 网关）。**有输入**：按本 handoff §4 做 B3–B10 并收集脱敏证据；**无输入**：记录 blocked 清单，转做 §2 的 v1.0 发布准备（README 复跑、golden eval、VSIX 打包方案、CHANGELOG/tag、链接检查）。规则：只连测试系统、不连生产、不 push 直推 main（走分支 + PR + CI）、不提交密钥/地址/`.env`、不伪造真机结果、每完成子项更新 STATUS 并提交（Conventional Commits + `git commit -s`）。

## 9. 不要做的事

- 不连生产 SAP、不自动激活生产、不创建/提交真实传输请求。
- 不提交密钥、真实地址、`.env`、`.abap.json`、日志、构建产物。
- 不直接 push `main`/不 force push main；所有改动走分支 + PR + CI（`gh` 已认证）。
- 不伪造 Phase B 真机证据；输入缺失就记录 blocked。
- 不改已冻结契约（docs/003 §4.8 / `packages/protocol/src/ai-jobs.ts` / `contracts/`）；如必须改，先改 docs/003 + protocol 并 `pnpm contract:gen`，由 Lead/用户裁决。
- 不重复 `abap create` 已存在对象；不用 `abap list --package`/`abap search` 判断 `$` 包对象存在性。
