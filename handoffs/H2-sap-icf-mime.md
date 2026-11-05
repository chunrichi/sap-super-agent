# H2 — SAP 需求系统（S2：ICF + MIME）

> 依赖：H0 完成协议与 server 骨架（`/hooks/sap` 可先由本任务实现）。DDIC / ICF / MIME 前端可在 H0 进行中先行，联调必须等 H0 的 `/hooks/sap` 与 `packages/sap-adapter` 接口就绪。
> 目标：SAP 内有一个可用的需求系统（列表/详情/审批），提交后 5 分钟内进入控制平面；审批结果 1 分钟内回写 SAP；未绑定仓库的需求正常进入通用任务箱。
> 规格来源：[docs/004](../docs/004-sap.md)、[docs/003](../docs/003-domain-and-protocol.md) §4.5、[docs/008](../docs/008-hooks.md)、[docs/009](../docs/009-testing.md)。

> **交接状态（2026-11-05）**：H0 已完成（`feat/h0-walking-skeleton` @ `d03dc29`，已推送，验收全绿）。执行前先读 [H1-H2-execution-handoff.md](H1-H2-execution-handoff.md)：H0 可复用接口、Phase A/B 顺序、并行协调、SAP 环境坑与启动 Prompt。

## 1. 交付物

### 1.1 SAP 对象（`sap/`，abapGit 可导入）

| 对象 | 说明 |
| --- | --- |
| `ZSA_DEMAND` / `ZSA_DEMAND_T` | 需求主表 + 长文本，字段见 004 §2（`REPO_KEY/PROJECT_KEY` 可空、`TEMPLATE_VERSION`） |
| `ZSA_ARTIFACT` | 工件元数据（含 `STAGE_KEY`、`STAGE_RUN_ID`、`VERSION`、`CHECKSUM`、`CONTENT_REF`） |
| `ZSA_APPROVAL` | 审批记录（`GATE_KEY`、`STATE`、`DECIDED_BY`、`COMMENT`） |
| `ZSA_EVENT_OUT` | 出站事件 outbox（`EVENT_ID`、`TYPE`、`PAYLOAD`、`STATE`、`ATTEMPTS`、`NEXT_AT`） |
| `ZSA_CFG` | 极少量配置（控制平面 URL、HMAC key 引用；不存明文密钥） |
| `ZCL_ZSA_HTTP_HANDLER` | `IF_HTTP_EXTENSION` handler：JSON API + MIME 静态资源路由 |
| `ZCL_ZSA_JSON` | JSON 序列化/反序列化与错误信封（`xco_cp_json`，兼容 `cl_sxml_string_writer`） |
| `ZCL_ZSA_EVENT_PUSH` | outbox 推送 job：HMAC 签名 POST `/hooks/sap`，退避 1s/5s/30s/5min/30min，24h 后 `DEAD` |
| ICF 节点 `ZSA_API` | SICF 路径 `/sap/zsa`（类型码 `HTTP`）；`/api/*` 与 `/ui/*` |
| MIME `/zsa/ui` | 静态 Web 资源：`index.html`、`app.js`、`styles.css`（列表/详情/审批） |
| 后台 job | outbox 推送（每分钟或 bgRFC）；审批到期提醒（可后置） |

- ABAP Unit 覆盖：outbox 选取/退避、HMAC 头、状态映射、handler 路由与错误码。
- abapGit：`sap/.abapgit.xml` + `sap/README.md`（导入顺序：DDIC → 类 → ICF → MIME → job）。
- 所有源文件同时保留 abap-cli 可推送格式（`.tabl.json/.ddic`、`.clas.*`、`.http.json`），便于 `abap push`。

### 1.2 ICF JSON API（handler 内实现）

最小路由（详见 004 §3.2）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/demands` | 列表（`status`、`changedSince`、`q`） |
| GET | `/api/demands/{id}` | 详情 + 工件 + 审批 + 时间线 |
| POST | `/api/demands` | Web 页面创建需求（写需求 + `demand.submitted` outbox） |
| PATCH | `/api/demands/{id}` | 控制平面回写：状态投影、工件元数据（字段白名单） |
| POST | `/api/demands/{id}/approvals` | 审批决策（写 `ZSA_APPROVAL` + `artifact.approved/rejected` outbox） |
| GET | `/api/health` | 探活 |

- JSON：UTF-8、`application/json`、错误信封 `{"error":{"code","message"}}`；字段校验与白名单。
- 认证：Web 走 ICF 登录（SSO，Basis 配置）；API 服务账号（OAuth2 client credentials 或专用 basic over TLS）。**权限模型 v1 不实现**，只记录操作人。

### 1.3 MIME Web 页面

- 三个视图：需求列表（状态筛选/我的待办）、需求详情（工件按阶段分组、审批按钮、时间线）、简单创建表单。
- 原生 JS 或 SAPUI5 均可；不引入 OData；只调同一 ICF JSON API。
- `abap mime push ./sap/ui --root /zsa/ui --tr <TR> --yes` 上传；handler `/ui/*` 默认回落 `index.html`。

### 1.4 `packages/sap-adapter`

- `client.ts`：ICF JSON 客户端（`fetch` + 服务 token/basic；超时/重试/错误映射）。
- `mapping.ts`：控制面状态 ↔ SAP `STATUS` 投影表（004 §2.1）；字段映射与校验。
- `signature.ts`：SAP→控制平面 webhook 的 HMAC 校验（`X-SA-Signature`/`X-SA-Timestamp`/`X-SA-Delivery`）。
- `reconcile.ts`：按 `CHANGED_AT` 游标拉取需求，产出差异报告（只报告，不自动覆盖业务字段）。
- 测试：映射表快照、签名正反例、客户端超时/401/409 处理。

### 1.5 控制平面集成（`packages/server`）

- `src/hooks/sap.ts`：`POST /hooks/sap`（HMAC + 幂等键），事件类型见 003 §4.5：`demand.submitted`、`demand.updated`、`artifact.approved/rejected`、`demand.cancelled`、`hook.receipt`。
- `src/workers/sap-writeback.ts`：消费 outbox 的 `sap.writeback`，调 ICF `PATCH`；2s 起指数退避至 5min、最多 5 次，永久失败进死信；`If-Match`/版本冲突重拉后重放。
- 对账命令：`pnpm --filter @sap-superagent/server sap:reconcile`（或 CLI 子命令），输出差异清单。
- 配置：`SA_SAP_BASE_URL`、`SA_SAP_SERVICE_USER/PASSWORD`（或 token）、`SA_SAP_HOOK_SECRET`；缺失时 SAP 集成自动禁用，不影响 H0/H1。

### 1.6 测试（两阶段）

**Phase A（无 SAP 系统，CI 必过）**

- `packages/testkit` 增加 fake ICF server：实现 1.2 的六条路由 + 故障注入（超时/409/401/坏 JSON）。
- 集成测试：`demand.submitted` → 控制平面建 Demand；审批 → `artifact.approved` → 阶段推进；`sap.writeback` 成功与 409 重放；重复投递幂等；HMAC 错误 401；对账输出差异。
- 覆盖 009 失败场景 **#6、#7、#11、#12**。
- `abap validate:aff` 对所有 SAP JSON/AFF 文件做离线校验（不需要系统）。

**Phase B（SAP 测试系统，人工执行并记录）**

```sh
abap doctor
abap deploy status
# 建对象（示例，实际按 abap-cli skill 语法与本地文件为准）
abap create TABL ZSA_DEMAND --file zsa_demand.tabl.json --package ZSA_SUPERAGENT --tr <TR> --yes
abap pull ZSA_API --type HTTP
abap create HTTP ZSA_API --file http/zsa_api.http.json --package ZSA_SUPERAGENT --tr <TR> --yes
abap mime create /zsa/ui --package ZSA_SUPERAGENT --tr <TR> --yes
abap mime push ./sap/ui --root /zsa/ui --tr <TR> --yes
abap check syntax
abap activate <obj> --yes
```

- 验收：SAP Web 提交需求 → 5 分钟内出现在控制平面；审批 → 1 分钟内回写 SAP 状态；重复点击/断网重试不重复建单；未绑定仓库的需求进入通用任务箱；SSO 登录页面可用。
- 记录：对象清单、传输请求号、截图/curl 输出、失败与修复。

## 2. 验收

```sh
pnpm check
pnpm e2e            # Phase A：fake ICF 全链路
pnpm sap:check      # abap validate:aff + 可用时的 abap check syntax（无系统时跳过并说明）
```

Phase B 按 1.6 手工验收，结果写入 STATUS.md 与最终报告。

## 3. 边界与禁令

- **只连测试系统**；不写生产、不自动激活生产、不提交 SAP 地址/传输请求号。
- **不做权限模型**：不加 SAP 授权对象；不因角色阻塞操作（审计保留操作人）。
- 不用 RAP/OData/Fiori Elements；SAP 端就是 ICF + MIME。
- 不实现 JIRA/CHARM/Confluence/Teams 适配器（只按 008 留 Hook；本任务只做 SAP 这一条）。
- 不改 H0/H1 的 `packages/protocol` 语义；需要新增字段先补 docs/003 和 protocol，再实现。

## 4. 上报格式

完成项、Phase A 命令输出、Phase B 对象/TR/验证记录、偏差、未决。
