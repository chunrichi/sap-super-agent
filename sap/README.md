# sap/ — SAP 需求系统（S2）

面向 **S/4HANA** 的 ICF + MIME 需求系统。**对象一律用 abap-cli 创建/推送/激活**（本地包 `$ZSA`，无需传输请求）；**abapGit 本轮不实现**。
设计见 [docs/004](../docs/004-sap.md) §2–§4；控制平面契约见 [docs/003](../docs/003-domain-and-protocol.md) §4.5。

> **决策（2026-11-05，用户）**：Phase B 使用**本地包 `$ZSA`**（`$` 前缀本地包，对象仅在测试系统生效、**不需要 TR**）；全部用 abap-cli 实现；abapGit 暂不考虑（`.abapgit.xml` 保留但不再维护/验收）。
>
> **状态（2026-11-05，Phase B 真机落地）**：测试系统上已创建并激活 6 张 DDIC 表、3 个类（含 ABAP Unit）、ICF 节点 `/sap/zsa`、MIME `/zsa/ui` 三个静态资源、后台 job 程序 `ZSA_OUTBOX_PUSH`；`abap validate:aff` 18/18、`pnpm sap:check` 离线/在线（`SA_SAP_CHECK_ONLINE=1`）全绿、ABAP Unit 6/6。
> 端到端两条验收（SAP→控制平面 5 分钟入单、审批 1 分钟回写）与 ICF `/api/health` 200 仍需人工输入：控制平面可被测试系统访问（M2/内网隧道）、HMAC secret 注入方式、Basis SSO/服务账号。详见下文「验收结果与 blocked 项」。

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
| ICF/SICF 节点 `/sap/zsa`（SICF 节点名 `ZSA`，类型码 `HTTP`） | `zsa.http.json` |
| 后台 job 程序 `ZSA_OUTBOX_PUSH` | `zsa_outbox_push.prog.json` + `.prog.abap` |
| DDIC bootstrap（一次性，见下） | `zsa_ddic_bootstrap.prog.json` + `.prog.abap` |
| MIME 前端 `/zsa/ui` | `ui/index.html`、`ui/app.js`、`ui/styles.css` |

## 实际落地结果（2026-11-05，测试系统）

| 对象 | 类型 | 状态 | 证据 |
| --- | --- | --- | --- |
| `$ZSA`（package） | DEVC | created（本地包，super `$TMP`，swcomp LOCAL） | `TDEVC`：DEVCLASS=$ZSA / PARENTCL=$TMP / DLVUNIT=LOCAL |
| `ZSA_DEMAND` | TABL | active（EXCLASS=3） | `DD02L` AS4LOCAL=A；`DD03L` INT4/TIMESTAMPL/CHAR 齐全；pull 与仓库 AFF 一致 |
| `ZSA_DEMAND_T` | TABL | active（EXCLASS=4） | 同上；`LANG` 为 key，`DESCRIPTION/ACCEPTANCE` 为 STRG |
| `ZSA_ARTIFACT` | TABL | active（EXCLASS=3） | 同上 |
| `ZSA_APPROVAL` | TABL | active（EXCLASS=4） | 同上；`DECISION_COMMENT`（`COMMENT` 是 DDIC 保留字） |
| `ZSA_EVENT_OUT` | TABL | active（EXCLASS=4） | 同上；`PAYLOAD` 为 STRG（长字段不能 NOT NULL） |
| `ZSA_CFG` | TABL | active（EXCLASS=4） | 同上 |
| `ZCL_ZSA_JSON` | CLAS | active（5 个 include 全 active） | `abap inspect --activation` ok=true |
| `ZCL_ZSA_EVENT_PUSH` | CLAS | active + ABAP Unit 3/3 | `abap test` pass；testclasses 已推送 |
| `ZCL_ZSA_HTTP_HANDLER` | CLAS | active + ABAP Unit 3/3 | 同上 |
| `ZSA_DDIC_BOOTSTRAP` | PROG | active（一次性 workaround，保留） | 见下节 |
| ICF 节点 `/sap/zsa` | HTTP（SICF `ZSA`） | 已创建；handler 绑定 | `ICFHANDLER`：ICF_NAME=ZSA / ICFHANDLER=ZCL_ZSA_HTTP_HANDLER；`abap pull ZSA --type HTTP` 成功 |
| MIME `/zsa/ui` | MIME folder | 已创建；3 个文件上传 | `abap mime create/push` 返回 uploaded=3 |
| `ZSA_OUTBOX_PUSH` | PROG | active（job 入口，SM36 人工调度） | `abap create/push` activated=true |

## 为什么有 `ZSA_DDIC_BOOTSTRAP`（abap-cli 2.2.0 DDIC create 缺陷）

真机上 `abap create TABL` 建不了本项目的表（测试系统 + abap-cli 2.2.0）：

1. **增强类别硬编码**：内置 ICF 服务 `ZCL_ABAP_VIBE_ICF_DDIC=>create_ddic_table` 调
   `build_table_header` 时**不传 `iv_exclass`**，默认 `'2'`（Can Be Enhanced (Char. Type)）。
   只要表里有数值字段（`INT4`、`TIMESTAMPL` 等）或深类型（`STRING`），`GOX_GEN_TABLE_STD`
   就以 `Current enhancement category Can Be Enhanced (Char. Type) is incorrect ...` 失败。
2. **STRING 类型映射错**：`build_field_entries` 把 AFF 的 `abap.string` 原样以
   DDIC `DATATYPE='STRING'` 传给 GOX（GOX 期望 `STRG`），报 `Data type STRI is not supported`。
3. （已在上游以 issue 记录：<https://github.com/chunrichi/abap-cli/issues/34>；CLI 2.2.0 与部署在测试系统上的
   ICF 服务 v2.6.0 同源，`abap deploy` 升级不能修复，故本轮不升级。）

绕行：`sap/src/zsa_ddic_bootstrap.prog.*` 是一个**一次性** ABAP 报告，用与 ICF 服务相同的
`GOX_GEN_TABLE_STD` 调用建表，但显式传 `EXCLASS`（含 STRING 的表 = `4`/deep，纯数值 = `3`）和
`DATATYPE='STRG'`；已存在的表跳过。**它不是常规交付路径**，TTAB 定义唯一真值仍是
`sap/src/*.tabl.{json,ddic}`（建表后 `abap pull TABL` 与仓库逐字节一致）。

```sh
# 首次创建（可执行报表骨架；AFF json 保留作元数据/回读对照）
abap create PROG ZSA_DDIC_BOOTSTRAP --package '$ZSA' \
  --description 'ZSA DDIC bootstrap (one-off, GOX with EXCLASS)' --template report --yes
abap push sap/src/zsa_ddic_bootstrap.prog.abap --yes
abap run-report ZSA_DDIC_BOOTSTRAP --json
```

## 创建顺序（Phase B 实测版，abap-cli）

本地包 `$` 前缀无需 `--tr`；非交互模式必须 `--yes`。执行前先 `abap doctor` / `abap deploy status`。

0. **本地包（一次性前提）**：`$ZSA` 需要先存在。注意 `abap list --package '$ZSA'` 对**不存在的包也返回
   success/count=0**（假阴性），存在性以 `abap select TDEVC` 为准。

   ```sh
   abap create DEVC '$ZSA' --package '$TMP' --description 'ZSA SAP Superagent demand system (local package)' \
     --package-type development --yes
   abap select --table TDEVC --fields DEVCLASS,PARENTCL,DLVUNIT --where "DEVCLASS = '\$ZSA'" --json
   ```

1. **DDIC**（ICF 通道；`abap create TABL` 受上述缺陷影响 → 用 bootstrap 建表，见上节）：

   ```sh
   abap run-report ZSA_DDIC_BOOTSTRAP --json        # 6/6 表 created/active
   # 回验（每张表都会写 3 个文件，可与仓库 sap/src/ 比对）
   abap pull ZSA_DEMAND --type TABL --dir /tmp/zsa-pull --overwrite --json
   ```

2. **类**（ADT；先 create 空对象，再 push AFF 源码并激活）：

   ```sh
   abap create CLAS ZCL_ZSA_JSON         --file sap/src/zcl_zsa_json.clas.json         --package '$ZSA' --yes --no-pull
   abap create CLAS ZCL_ZSA_EVENT_PUSH   --file sap/src/zcl_zsa_event_push.clas.json   --package '$ZSA' --yes --no-pull
   abap create CLAS ZCL_ZSA_HTTP_HANDLER --file sap/src/zcl_zsa_http_handler.clas.json --package '$ZSA' --yes --no-pull

   abap push sap/src/zcl_zsa_json.clas.abap --yes
   abap push sap/src/zcl_zsa_event_push.clas.abap --yes
   abap push sap/src/zcl_zsa_event_push.clas.testclasses.abap --yes
   abap push sap/src/zcl_zsa_http_handler.clas.abap --yes
   abap push sap/src/zcl_zsa_http_handler.clas.testclasses.abap --yes
   ```

3. **ICF 节点**（handler = `ZCL_ZSA_HTTP_HANDLER`，路径 `/sap/zsa`；SICF 节点名是 `ZSA`，
   所以 AFF 文件名是 `zsa.http.json`，`abap pull ZSA --type HTTP` 可回读）：

   ```sh
   abap create HTTP ZSA --file sap/src/zsa.http.json --package '$ZSA' --yes
   abap pull ZSA --type HTTP --dir /tmp/zsa-pull --overwrite --json
   ```

4. **MIME 前端**（本地包无需 TR；非 TTY 必须 `--yes`）：

   ```sh
   abap mime create /zsa/ui --package '$ZSA' --yes
   abap mime push sap/ui --root /zsa/ui --dry-run --yes   # 3 files planned
   abap mime push sap/ui --root /zsa/ui --yes              # uploaded: 3
   ```

5. **后台 job**：`ZSA_OUTBOX_PUSH` 程序（每 1 分钟或 bgRFC 调度）——**SM36 手工建 job**，本目录不含调度：

   ```sh
   abap create PROG ZSA_OUTBOX_PUSH --file sap/src/zsa_outbox_push.prog.json --package '$ZSA' --yes
   abap push sap/src/zsa_outbox_push.prog.abap --yes
   ```

6. **配置**：维护 `ZSA_CFG` 的 `CONTROL_PLANE_URL` 与 `HMAC_SECRET_REF`（只存引用，不存明文密钥）；
   HMAC secret 本身由 Basis 注入（见下文 blocked 项）。

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

- 选取 `STATE='NEW' AND NEXT_AT <= now` 的事件（`UP TO iv_limit ROWS`），POST 到 `ZSA_CFG-CONTROL_PLANE_URL`；
- 头：`X-SA-Signature: sha256=<hex(HMAC-SHA256(secret, rawBody))>`、`X-SA-Timestamp`（UTC ISO-8601）、
  `X-SA-Delivery`（= `EVENT_ID`，幂等键）；
- 退避 1s / 5s / 30s / 5min / 30min，最多 5 次，超过 24h 置 `DEAD`（docs/004 §3.3）；
  时间计算用 `CL_ABAP_TSTMP=>add/subtract`（真实秒，不是 DIFF 的十进制差）；
- HMAC secret 由 Basis 以应用密钥/环境注入，`ZSA_CFG` 只保存引用名 `HMAC_SECRET_REF`。
  实现：`CL_ABAP_HMAC=>calculate_hmac_for_char`（`if_key` 由 `CL_ABAP_CODEPAGE=>convert_to` 从 UTF-8 转 XSTRING，
  `ef_hmacstring` 即 hex 摘要，转小写）。

## ABAP Unit

测试类以 `.clas.testclasses.abap` 与主类同目录（abap-cli `validate:aff` 识别为可选 companion）：

- `ZCL_ZSA_EVENT_PUSH`：退避序列 1/5/30/300/1800、签名格式（`sha256=` + 64 位小写 hex）。
- `ZCL_ZSA_HTTP_HANDLER`：路由分类、回写白名单、ISO⇄TIMESTAMPL 往返。

运行（实测 2026-11-05：两类的 3 个用例全部通过）：

```sh
abap test ZCL_ZSA_EVENT_PUSH --json     # 3 methods / 3 passed
abap test ZCL_ZSA_HTTP_HANDLER --json   # 3 methods / 3 passed
```

## 验收结果与 blocked 项（Phase B）

已在测试系统完成（本地包内可完成部分）：

1. 6 张 DDIC 表 + 3 个类（含 testclasses）+ ICF 节点 + MIME 目录/资源 + job 程序均创建并激活；
   `abap check syntax --all` 与 `SA_SAP_CHECK_ONLINE=1 pnpm sap:check` 全绿。
2. `abap test` ABAP Unit 6/6 通过（outbox 退避 / HMAC 头 / 状态映射 / handler 路由）。
3. ICF 节点 HTTP 层可达：`GET /sap/zsa/api/health` 返回 **401**（服务已挂载、按设计要求登录），
   而 `/sap/zsa/ui/index.html` 同样 401；无凭据时无法读取 200 响应体（见 blocked 项）。

需要人工输入才能完成（做到哪步如实记录）：

4. **ICF `/api/health` 200 / Web 页面可用**：需 Basis 配置 ICF 登录（SSO）或提供不落盘的测试服务账号；
   本轮无凭据，仅证明节点可达 + 401。**blocked（人工）**。
5. **SAP Web 提交需求 → 5 分钟内出现在控制平面**（`demand.submitted` outbox 推送成功）：
   需**控制平面可被测试系统访问**（M2 部署/内网隧道）+ `SA_SAP_HOOK_SECRET` 注入 + `ZSA_CFG` 配置。**blocked（人工）**。
6. **控制平面阶段/门禁变化 → 1 分钟内回写 SAP `STATUS`**（`If-Match` 冲突 409 重拉重放重放）：
   需**控制平面→SAP 服务账号**与 `SA_SAP_BASE_URL`。**blocked（人工）**。
7. **SM36 调度 job**：`ZSA_OUTBOX_PUSH` 程序已激活，作业定义需人工在测试系统 SM36（或 bgRFC）创建。
   **blocked（人工）**。

记录：对象清单、abap-cli 命令与输出（本地包无 TR，不记录 TR）、失败与修复见
[handoffs/STATUS.md](../handoffs/STATUS.md) 的 H2-B 行与「H2 Phase B 偏差与遗留」。

## 已知问题（真机实测）

- **`abap create TABL` 缺陷**：见上文；已提上游 issue <https://github.com/chunrichi/abap-cli/issues/34>。
- **增强类别不是 `#NOT_EXTENSIBLE`**：bootstrap 绕行把含数值/深类型的表建成 EXCLASS 3/4（`#EXTENSIBLE_CHARACTER_NUMERIC` /
  `#EXTENSIBLE_ANY`），与仓库 AFF 里的 `@AbapCatalog.enhancement.category : #NOT_EXTENSIBLE` 注解不一致
  （该注解在 abap-cli 的 create 路径本来就不生效）。修好工具后可重建成 `#NOT_EXTENSIBLE`。
- **`COMMENT` 是 DDIC 保留字**：`ZSA_APPROVAL` 的列改名为 `DECISION_COMMENT`；对外 JSON 字段名仍是 `comment`。
- **`STRING` 字段不能 `NOT NULL`**：`ZSA_EVENT_OUT.PAYLOAD` 的 DDL 去掉了 `not null`（SAP 对 >255 长字段的限制）。
- **`abap list --package` 假阴性**：包不存在也返回 success/count=0；`abap search` 在本系统对 `$` 包对象返回空。
  对象存在性以 `TADIR` / `DD02L` / `abap pull` 为准。
- **ICF 节点名**：SICF 节点名是路径叶子 `ZSA`（服务路径 `/sap/zsa`），不是文档早期写的 `ZSA_API`；
  AFF 文件名因此是 `zsa.http.json`。

## 本地离线校验

```sh
pnpm sap:check                          # 离线：结构检查 + abap validate:aff + abap check content
SA_SAP_CHECK_ONLINE=1 pnpm sap:check    # 有测试系统时额外跑 abap check syntax（本轮实测全绿）
```
