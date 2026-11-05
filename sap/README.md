# sap/ — SAP 需求系统（S2）

面向 **S/4HANA** 的 ICF + MIME 需求系统。**对象一律用 abap-cli 创建/推送/激活**（本地包 `$ZSA`，无需传输请求）；**abapGit 本轮不实现**。
设计见 [docs/004](../docs/004-sap.md) §2–§4；控制平面契约见 [docs/003](../docs/003-domain-and-protocol.md) §4.5。

> **决策（2026-11-05，用户）**：Phase B 使用**本地包 `$ZSA`**（`$` 前缀本地包，对象仅在测试系统生效、**不需要 TR**）；全部用 abap-cli 实现；abapGit 暂不考虑（`.abapgit.xml` 保留但不再维护/验收）。
>
> **状态**：Phase A（代码 + 离线 AFF 校验 + 本目录）已交付并合入 `main`；Phase B 可推进「建对象 + 激活 + ABAP Unit + ICF health」。
> 端到端两条验收（SAP→控制平面 5 分钟入单、审批 1 分钟回写）仍需要：控制平面可被测试系统访问（M2/内网隧道）、
> HMAC secret 注入方式、Basis SSO（Web 登录）。详见 [handoffs/STATUS.md](../handoffs/STATUS.md) 的 H2 行。

## 目录

```text
sap/
├─ src/              ABAP 对象（abap-cli AFF / 可推送格式）
├─ ui/               MIME Repository 静态前端（/zsa/ui）
├─ tests/            ABAP Unit 说明（测试类作为 *.clas.testclasses.abap 与类同目录）
├─ .abapgit.xml      legacy：abapGit 描述文件，本轮不使用（导出留待后续）
└─ README.md         本文件：创建顺序、配置与验收
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

## 创建顺序（Phase B，abap-cli）

本地包 `$` 前缀无需 `--tr`；非交互模式必须 `--yes`。执行前先：

```sh
abap doctor
abap deploy status
abap list --package '$ZSA' --json   # 确认本地包存在/为空
```

1. **DDIC**（ICF 通道；同目录 `.tabl.ddic` / `.tabl.settings.json` 自动带上）：

   ```sh
   abap create TABL ZSA_DEMAND    --file sap/src/zsa_demand.tabl.json    --package '$ZSA' --yes
   abap create TABL ZSA_DEMAND_T  --file sap/src/zsa_demand_t.tabl.json  --package '$ZSA' --yes
   abap create TABL ZSA_ARTIFACT  --file sap/src/zsa_artifact.tabl.json  --package '$ZSA' --yes
   abap create TABL ZSA_APPROVAL  --file sap/src/zsa_approval.tabl.json  --package '$ZSA' --yes
   abap create TABL ZSA_EVENT_OUT --file sap/src/zsa_event_out.tabl.json --package '$ZSA' --yes
   abap create TABL ZSA_CFG       --file sap/src/zsa_cfg.tabl.json       --package '$ZSA' --yes
   ```

2. **类**（ADT；创建后 `pull` 回本地再编辑/推送）：

   ```sh
   abap create CLAS ZCL_ZSA_JSON          --file sap/src/zcl_zsa_json.clas.json          --package '$ZSA' --yes
   abap create CLAS ZCL_ZSA_EVENT_PUSH    --file sap/src/zcl_zsa_event_push.clas.json    --package '$ZSA' --yes
   abap create CLAS ZCL_ZSA_HTTP_HANDLER  --file sap/src/zcl_zsa_http_handler.clas.json  --package '$ZSA' --yes
   ```

3. **ICF 节点** `ZSA_API`（handler = `ZCL_ZSA_HTTP_HANDLER`，路径 `/sap/zsa`）：

   ```sh
   abap create HTTP ZSA_API --file sap/src/zsa_api.http.json --package '$ZSA' --yes
   ```

4. **MIME 前端**：

   ```sh
   abap mime create /zsa/ui --package '$ZSA' --yes
   abap mime push sap/ui --root /zsa/ui --yes   # 若本地包仍要求 TR：先 --dry-run 确认，再找 Lead/用户
   ```

5. **后台 job**：`ZSA_OUTBOX_PUSH` 程序（每 1 分钟或 bgRFC 调度）——SM36 手建，见 §job。
6. **配置**：维护 `ZSA_CFG` 的 `CONTROL_PLANE_URL` 与 `HMAC_SECRET_REF`（只存引用，不存明文密钥）。
7. **激活与回归**：`abap check syntax` + `abap activate <obj> --yes`，然后 ABAP Unit + 验收清单。

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

测试类以 `.clas.testclasses.abap` 与主类同目录（abap-cli `validate:aff` 识别为可选 companion）：

- `ZCL_ZSA_EVENT_PUSH`：退避序列 1/5/30/300/1800、签名格式（`sha256=` + 64 位小写 hex）。
- `ZCL_ZSA_HTTP_HANDLER`：路由分类、回写白名单、ISO⇄TIMESTAMPL 往返。

运行：`abap test ZCL_ZSA_EVENT_PUSH`（或 ADT 中 Run As → ABAP Unit）。

## 验收（Phase B，需测试系统）

本地包内可完成：

1. 6 张 DDIC 表 + 3 个类 + ICF 节点 + MIME 目录均创建并激活；`abap check syntax` 全绿。
2. `abap test <class>` ABAP Unit 通过（outbox 退避 / HMAC 头 / 状态映射 / handler 路由）。
3. ICF `GET /sap/zsa/api/health` 返回 200（ICF 节点与服务已激活、login 配置可用）。

需要人工输入才能完成（做到哪步如实记 STATUS）：

4. SAP Web 提交需求 → 5 分钟内出现在控制平面（`demand.submitted` outbox 推送成功）：需**控制平面可被测试系统访问 + `SA_SAP_HOOK_SECRET` 注入**。
5. 控制平面阶段/门禁变化 → 1 分钟内回写 SAP `STATUS`（`If-Match` 冲突 409 重拉重放）：需**控制平面→SAP 服务账号**。
6. SSO 登录页面可用：需 Basis 配置（本轮不阻塞对象/ABAP Unit 验收）。

记录：对象清单、abap-cli 命令与输出（本地包无 TR，不记录 TR）、关键 curl 输出、失败与修复；
**不提交** SAP 地址/凭据/`.abap.json`/`.abap-cli/`/截图中的敏感信息。结果写入 `handoffs/STATUS.md`。

## 本地离线校验

```sh
pnpm sap:check                          # 离线：结构检查 + abap validate:aff + abap check content（无 SAP 时跳过 syntax check 并说明）
SA_SAP_CHECK_ONLINE=1 pnpm sap:check    # 有测试系统时额外跑 abap check syntax
```
