# sap/ — SAP 需求系统（S2）

面向 **S/4HANA** 的 ICF + MIME 需求系统，供 abapGit 导入与 abap-cli 推送两条路径使用。
设计见 [docs/004](../docs/004-sap.md) §2–§4；控制平面契约见 [docs/003](../docs/003-domain-and-protocol.md) §4.5。

> **状态**：Phase A（代码 + 离线 AFF 校验 + 本目录）已交付；Phase B（真实测试系统建对象、
> ABAP Unit、ICF/MIME 联调）**blocked**，需要：可达的测试系统、目标 package（如
> `ZSA_SUPERAGENT`）、传输请求号、ICF 服务账号 / SSO 配置、控制平面 URL 与 HMAC secret 注入方式。
> 详见 [handoffs/STATUS.md](../handoffs/STATUS.md) 的 H2 行。

## 目录

```text
sap/
├─ .abapgit.xml      abapGit 仓库描述（STARTING_FOLDER=/src/）
├─ src/              ABAP 对象（abap-cli AFF / abapGit 兼容文件格式）
├─ ui/               MIME Repository 静态前端（/zsa/ui）
├─ tests/            ABAP Unit 说明（测试类作为 *.clas.testclasses.abap 与类同目录）
└─ README.md         本文件：导入顺序、配置与验收
```

`src/` 使用 **abap-file-format（AFF）** 布局，可直接被 `abap validate:aff` 校验，并可被
abap-cli `create`/`push` 消费：

| 对象 | 文件 |
| --- | --- |
| `ZSA_DEMAND` / `ZSA_DEMAND_T` / `ZSA_ARTIFACT` / `ZSA_APPROVAL` / `ZSA_EVENT_OUT` / `ZSA_CFG` | `zsa_*.tabl.json` + `.tabl.ddic` (+ `.tabl.settings.json`) |
| `ZCL_ZSA_JSON` / `ZCL_ZSA_EVENT_PUSH` / `ZCL_ZSA_HTTP_HANDLER` | `zcl_zsa_*.clas.json` + `.clas.abap`（+ `.clas.testclasses.abap`） |
| ICF/SICF 节点 `ZSA_API`（`/sap/zsa`，类型码 `HTTP`） | `zsa_api.http.json` |
| 后台 job 程序 `ZSA_OUTBOX_PUSH` | `zsa_outbox_push.prog.json` + `.prog.abap` |
| MIME 前端 `/zsa/ui` | `ui/index.html`、`ui/app.js`、`ui/styles.css` |

## 导入顺序（Phase B）

1. **DDIC**：`ZSA_DEMAND`、`ZSA_DEMAND_T`、`ZSA_ARTIFACT`、`ZSA_APPROVAL`、`ZSA_EVENT_OUT`、`ZSA_CFG`
   （abapGit 从 `/src/` 识别 `.tabl.json` + `.tabl.ddic`；abap-cli 用
   `abap create TABL ZSA_DEMAND --file sap/src/zsa_demand.tabl.json --package <PKG> --tr <TR> --yes`，
   同目录 `.tabl.ddic` / `.tabl.settings.json` 自动带上）。
2. **类**：`ZCL_ZSA_JSON` → `ZCL_ZSA_EVENT_PUSH` → `ZCL_ZSA_HTTP_HANDLER`
   （`abap create CLAS ...` 或 abapGit 导入后 `activate`）。
3. **ICF 节点**：`ZSA_API`，handler = `ZCL_ZSA_HTTP_HANDLER`，路径 `/sap/zsa`
   （`abap create HTTP ZSA_API --file sap/src/zsa_api.http.json --package <PKG> --tr <TR> --yes`）。
4. **MIME 前端**：`abap mime create /zsa/ui --package <PKG> --tr <TR> --yes` 后
   `abap mime push sap/ui --root /zsa/ui --tr <TR> --yes`。
5. **后台 job**：`ZSA_OUTBOX_PUSH` 程序（每 1 分钟，或 bgRFC 调度）——SM36 手建，见 §job。
6. **配置**：维护 `ZSA_CFG` 的 `CONTROL_PLANE_URL` 与 `HMAC_SECRET_REF`（只存引用，不存明文密钥）。
7. **激活与回归**：`abap check syntax && abap activate <obj> --yes`，然后 ABAP Unit + 验收清单。

## ICF 路由

同一节点提供 JSON API 与静态页面（docs/004 §3.2）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/sap/zsa/api/demands` | 列表（`status` / `changedSince` / `q`） |
| GET | `/sap/zsa/api/demands/{id}` | 详情 + 工件 + 审批 + 时间线 |
| POST | `/sap/zsa/api/demands` | Web 页面创建需求（写需求 + `demand.submitted` outbox） |
| PATCH | `/sap/zsa/api/demands/{id}` | 控制平面回写：`STATUS/STATUS_TEXT/STAGE_KEY` + 工件元数据（字段白名单，`If-Match` = `VERSION`） |
| POST | `/sap/zsa/api/demands/{id}/approvals` | 审批决策（写 `ZSA_APPROVAL` + `artifact.approved/rejected` outbox） |
| GET | `/sap/zsa/api/health` | 探活 |
| GET | `/sap/zsa/ui/*` | MIME 前端，默认回落 `index.html` |

- 认证：Web 走 ICF 登录/SSO（Basis 配置），handler 只记录登录用户（`sy-uname`）；控制平面 API 使用
  独立服务账号（ICF 节点上配置 basic over TLS 或 OAuth2 client credentials）。
- **v1 不建模细粒度权限**；回写字段白名单在 handler 内强制执行（`TITLE/DESCRIPTION/...` 拒写）。
- 错误体统一 `{"error":{"code","message"}}`。

## outbox 推送与 HMAC

`ZCL_ZSA_EVENT_PUSH=>run( )` 由 `ZSA_OUTBOX_PUSH` 调度：

- 选取 `STATE='NEW' AND NEXT_AT <= now` 的事件，POST 到 `ZSA_CFG-CONTROL_PLANE_URL`；
- 头：`X-SA-Signature: sha256=<hex(HMAC-SHA256(secret, rawBody))>`、`X-SA-Timestamp`（UTC ISO-8601）、
  `X-SA-Delivery`（= `EVENT_ID`，幂等键）；
- 退避 1s / 5s / 30s / 5min / 30min，最多 5 次，超过 24h 置 `DEAD`（docs/004 §3.3）；
- HMAC secret 由 Basis 以应用密钥/环境注入，`ZSA_CFG` 只保存引用名 `HMAC_SECRET_REF`。

## ABAP Unit

测试类以 `.clas.testclasses.abap` 与主类同目录（abapGit 约定，abap-cli `validate:aff` 也识别为
可选 companion）：

- `ZCL_ZSA_EVENT_PUSH`：退避序列 1/5/30/300/1800、签名格式（`sha256=` + 64 位小写 hex）。
- `ZCL_ZSA_HTTP_HANDLER`：路由分类、回写白名单、ISO⇄TIMESTAMPL 往返。

运行：`abap test ZCL_ZSA_EVENT_PUSH`（或 ADT 中 Run As → ABAP Unit）。

## 验收（Phase B，需测试系统）

1. SAP Web 提交需求 → 5 分钟内出现在控制平面（`demand.submitted`）。
2. 控制平面阶段/门禁变化 → 1 分钟内回写 SAP `STATUS`（`If-Match` 冲突 409 时重拉后重放）。
3. 重复点击/断网重试不重复建单（`X-SA-Delivery` 幂等）。
4. 未绑定仓库的需求进入通用任务箱（`REPO_KEY/PROJECT_KEY` 为空）。
5. SSO 登录页面可用（`/sap/zsa/ui/`）。

对象清单、传输请求号、curl 输出与失败修复记录写入 `handoffs/STATUS.md`；**不提交** SAP 地址、
凭据、`.abap.json`、`.abap-cli/`、TR 号或截图中的敏感信息。

## 本地离线校验

```sh
pnpm sap:check    # abap validate:aff（离线）+ 结构性检查；无 SAP 时跳过 syntax check 并说明
```
