# sap/ — SAP 需求系统（S2）

面向 **S/4HANA** 的 ICF + MIME 需求系统。**对象一律用 abap-cli 创建/推送/激活**（本地包 `$ZSA`，无需传输请求）；**abapGit 本轮不实现**。
设计见 [docs/004](../docs/004-sap.md) §2–§4；控制平面契约见 [docs/003](../docs/003-domain-and-protocol.md) §4.5。

> **决策（2026-11-05，用户）**：Phase B 使用**本地包 `$ZSA`**（`$` 前缀本地包，对象仅在测试系统生效、**不需要 TR**）；全部用 abap-cli 实现；abapGit 暂不考虑（`.abapgit.xml` 保留但不再维护/验收）。
>
> **状态（2026-11-05，Phase B 真机落地）**：测试系统上已创建并激活 6 张 DDIC 表、3 个类（含 ABAP Unit）、ICF 节点 `/sap/zsa`、MIME `/zsa/ui` 三个静态资源、后台 job 程序 `ZSA_OUTBOX_PUSH`；`abap validate:aff` 18/18、`pnpm sap:check` 离线/在线（`SA_SAP_CHECK_ONLINE=1`）全绿、ABAP Unit 6/6。
> 端到端两条验收（SAP→控制平面 5 分钟入单、审批 1 分钟回写）与 ICF `/api/health` 200 仍需人工输入：控制平面可被测试系统访问（M2/内网隧道）、HMAC secret 注入方式、Basis SSO/服务账号。详见下文「验收结果与 blocked 项」。
>
> **状态（2026-11-05，S5 Phase A 离线）**：新增 S5/M3 批处理 AI 执行器对象 `ZCL_ZSA_AI_BATCH`（+ABAP Unit 源文件）与 `ZSA_AI_BATCH_RUN` / AFF 元数据；`pnpm sap:check` 离线绿（必需文件 29 个、`abap validate:aff` 20/20、`abap check content` 10 个 ABAP 文件）。**未连 SAP**：真机 `create/push/check syntax/activate/abap test`、`ZSA_CFG` 写入与 SM36 调度均属 Phase B（blocked，人工输入）。

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
| **S5/M3** 批处理 AI 执行器 `ZCL_ZSA_AI_BATCH`（+测试类） | `zcl_zsa_ai_batch.clas.json` + `.clas.abap` + `.clas.testclasses.abap` |
| **S5/M3** AI job 入口 `ZSA_AI_BATCH_RUN` | `zsa_ai_batch_run.prog.json` + `.prog.abap` |
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

## S5 / M3：SAP 批处理 AI 执行器（`ZCL_ZSA_AI_BATCH`）

控制平面把模板中的 `server-ai` 阶段渲染成 AI job，SAP 侧 `ZCL_ZSA_AI_BATCH` 拉取 job → claim →
调企业 AI 网关（OpenAI 兼容）→ heartbeat 续租 → 回传**模型原始输出文本**；JSON 提取、输出 schema、
checklist、ledger、工件与门禁全部留在控制平面。SAP 不拼 prompt、不做业务校验，从而 prompt 与校验单源。
协议权威：[docs/003 §4.8](../docs/003-domain-and-protocol.md#48-sap-批处理-ai-执行器m3s5)；
落地边界：[docs/004 §7.1](../docs/004-sap.md#71-m3-落地边界s5-实现口径)。

| 对象 | 类型 | 文件 | 职责 |
| --- | --- | --- | --- |
| `ZCL_ZSA_AI_BATCH` | CLAS | `src/zcl_zsa_ai_batch.clas.json` + `.clas.abap` | 取 job / claim / 网关调用 / heartbeat / result 回传 / 错误分类 / BAL 日志 |
| `ZCL_ZSA_AI_BATCH`（测试） | CLAS（testclasses） | `src/zcl_zsa_ai_batch.clas.testclasses.abap` | payload 映射、HMAC 向量、claim/result 幂等与 409 分支、网关超时/失败分类、租约续期 |
| `ZSA_AI_BATCH_RUN` | PROG | `src/zsa_ai_batch_run.prog.json` + `.prog.abap` | SM36 周期 job 入口，调用 `run_batch( )` |

### 协议与实现口径

- **SAP → 控制平面**（全部 `POST` + `X-SA-Signature` / `X-SA-Timestamp` / `X-SA-Delivery`，复用
  `SA_SAP_HOOK_SECRET` 的同一套 HMAC，不用 Bearer；时间戳 UTC ISO-8601；签名覆盖 raw body）：
  - `POST {CONTROL_PLANE_URL}/api/v1/sap/ai-jobs/next` body `{"limit":N}` → `{jobs:[],serverTime}`（只读）；
  - `POST .../{id}/claim` body `{}` → `{job,claimId,lease:{expiresAt,renewIntervalMs}}`；
    租约有效期内重复 claim → **409**，本类跳过该 job（交给租约持有者）；
  - `POST .../{id}/heartbeat` body `{claimId}`：批处理 work process 内网关调用是阻塞的，**没有并行
    heartbeat 线程**，因此在"调用窗口可能跨越续租点"时先续租（用与 payload `timeoutMs`、`AI_TIMEOUT_MS`
    取小后的有效超时估算窗口），调用返回后按需再续租；409 视为租约丢失，放弃该 job；
  - `POST .../{id}/result`：
    - 成功 `{claimId,status:"succeeded",outputText,usage,durationMs}`
    - 失败 `{claimId,status:"failed",error:{code,message,retryable},durationMs}`
    - `X-SA-Delivery` 对同一 claim 固定为 `zsa-ai-result-<claimId>`，网络重试时控制平面可幂等去重；
      心跳/claim/next 用唯一交付键。result 409（claim 失效/已被处理）→ 停止重试。
- **SAP → 企业 AI 网关**：`POST {AI_GATEWAY_URL}/chat/completions`（OpenAI 兼容），
  `messages=[{"role":"system","content":payload.systemPrompt},{"role":"user","content":payload.prompt}]`，
  `model` 用 `payload.model`（缺省回退 `ZSA_CFG-AI_GATEWAY_MODEL`），可选 `max_tokens` =
  `payload.maxOutputTokens`；`Authorization: Bearer <key>`，key 由 `AI_KEY_REF` 指向的安全存储/配置条目解析，
  **`ZSA_CFG` 只存引用名，不存明文**。网关 `choices[0].message.content` 原样回传（SAP 不做 JSON 提取）。
- **错误分类**（详见 `classify_gateway_failure`）：
  - 网关 4xx（400/422/401/403/404：key、model、请求配置错）→ 回传 `failed`（`retryable:false`）并写 BAL `E` 告警，
    **不本地重试**；
  - 429/5xx/传输失败/超时 → 本地最多 3 次（间隔 2s/5s，`WAIT UP TO`）后回传 `failed`（`retryable:true`），
    由控制平面按 attempt 语义重试；transport error 文本含 timeout 时错误码为 `GATEWAY_TIMEOUT`，否则 `GATEWAY_TRANSPORT`；
  - heartbeat/result 409 → 租约或 claim 已失效，放弃该 job（控制平面租约过期后重新排队/判定失败）。
- **日志与数据边界**：BAL（SLG1）对象 `ZSA` / 子对象 `AI_BATCH`（SM37 作业日志可见），只写
  jobId / stageKey / attempt / 输出长度 / 耗时 / 状态 / 错误码；**不写 prompt 与 output 正文**，
  不写网关 key。SLG0 未配置时日志调用被静默跳过，不影响 job 完成。result 的 `outputText` 仅在
  SAP→控制平面请求体内传输（属于协议数据，不进日志）。
- **超时说明（Phase B 需 Basis 配置）**：本类调用 `cl_http_client` 时不设置客户端级 timeout API
  （Phase A 无法在真机验证该方法；`ZCL_ZSA_EVENT_PUSH` 同样未设置）。实际网络超时应在 ICM/SM59
  层配置（建议 ≤ 控制平面租约 10min）；`AI_TIMEOUT_MS` 用于计算有效网关超时（与 payload `timeoutMs`
  取小）并驱动续租时机，超时在 SAP 侧被归类为 `GATEWAY_TIMEOUT`（retryable）。

### `ZSA_CFG` 新键（S5；键值表，无 DDIC 结构变更）

复用已有 `CONTROL_PLANE_URL`、`HMAC_SECRET_REF`（见上）；S5 新增/使用：

| 键 | 必填 | 说明 |
| --- | --- | --- |
| `AI_GATEWAY_URL` | S5 启用时必填 | 企业 AI 网关基址（内网），代码追加 `/chat/completions`；若已含完整路径则不再追加 |
| `AI_GATEWAY_MODEL` | payload 无 `model` 时必填 | 默认模型名（payload `model` 优先） |
| `AI_KEY_REF` | 网关需要鉴权时 | 安全存储/配置**引用名**（Basis 应用密钥或 ZSA_CFG 中该名字下的条目）；代码解析后作为 Bearer，**不落明文** |
| `AI_TIMEOUT_MS` | 否 | 单次网关调用超时上限（毫秒，与 payload `timeoutMs` 取小）；缺省 120000 |
| `CONTROL_PLANE_URL` | 必填（复用） | 控制平面基址；代码追加 `/api/v1/sap/ai-jobs/...` |
| `HMAC_SECRET_REF` | 必填（复用） | HMAC secret 的引用名，与 outbox 推送共用 |

维护方式（Phase B，人工）：SE16 打开 `ZSA_CFG`，按 `MANDT / CFG_KEY / CFG_VALUE / CHANGED_AT` 插入键值
（`CFG_VALUE` 只存地址/模型名/引用名/数字，不存密钥明文）；写后可用
`abap select --table ZSA_CFG --fields CFG_KEY,CFG_VALUE --json` 核对。

### Phase B：部署与启用（人工输入，当前 blocked）

1. **对象创建/激活**（本地包 `$ZSA`，无 TR；先确认 `ZCL_ZSA_EVENT_PUSH` 已 active，本类复用其
   public `signature_hex`）：

   ```sh
   abap create CLAS ZCL_ZSA_AI_BATCH --file sap/src/zcl_zsa_ai_batch.clas.json --package '$ZSA' --yes --no-pull
   abap push sap/src/zcl_zsa_ai_batch.clas.abap --yes
   abap push sap/src/zcl_zsa_ai_batch.clas.testclasses.abap --yes
   abap create PROG ZSA_AI_BATCH_RUN --file sap/src/zsa_ai_batch_run.prog.json --package '$ZSA' --yes
   abap push sap/src/zsa_ai_batch_run.prog.abap --yes
   abap check syntax --all        # 只连测试系统
   abap test ZCL_ZSA_AI_BATCH --json
   ```
2. **`ZSA_CFG`**：写入 `AI_GATEWAY_URL` / `AI_GATEWAY_MODEL` / `AI_KEY_REF` / `AI_TIMEOUT_MS`（见上），
   并确认 `CONTROL_PLANE_URL`、`HMAC_SECRET_REF` 已按 H2 配置。
3. **SLG0**（建议）：对象 `ZSA` / 子对象 `AI_BATCH`，供 SM37/SLG1 排查。
4. **SM36**：作业名如 `ZSA_AI_BATCH_RUN`，程序 `ZSA_AI_BATCH_RUN`，周期建议 1–5 分钟；不要同一时间窗口
   并行多实例（多实例语义安全：claim 409 会跳过，但会产生无效流量）。bgRFC 为 Phase B 可选通道，不阻塞。
5. **验收**：控制平面 `SA_SAP_AI_BATCH=1`，无 executor 在线建 pdo Demand →
   `stage.ai_job.*` 事件（queued/claimed/completed）、job 生命周期、`GET /hooks/sap/status` 的 `aiJobs` 计数；
   再注入网关超时/非法输出，验证控制平面重试到 `waiting_human` 且 SAP 侧回传 `failed`（SAP 侧不落半成品）。

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
- **`ZCL_ZSA_AI_BATCH`（S5）**：control plane next/claim JSON 映射（job payload）、OpenAI 兼容网关
  request/response 映射、result succeeded/failed 报文体（prompt 不进入 failed 报文）、HMAC RFC 4231
  已知向量与 `X-SA-*` 头构建、control plane 409/401/5xx 分类、网关 4xx/429/5xx/超时分类、
  租约续期时间点、有效超时（`timeoutMs` 与 `AI_TIMEOUT_MS` 取小）、批次上限、result 交付键幂等。

运行（前两类为 2026-11-05 真机实测 3/3；`ZCL_ZSA_AI_BATCH` 为 S5 Phase A 源文件，真机执行属 Phase B blocked）：

```sh
abap test ZCL_ZSA_EVENT_PUSH --json     # 3 methods / 3 passed（H2-B 实测）
abap test ZCL_ZSA_HTTP_HANDLER --json   # 3 methods / 3 passed（H2-B 实测）
abap test ZCL_ZSA_AI_BATCH --json       # S5 Phase B：15 methods（待真机）
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

S5/M3 新增（Phase A 只交付离线源文件；以下全部 **blocked**，需人工输入后才做 Phase B）：

8. **SAP 侧对象部署**：`ZCL_ZSA_AI_BATCH` + testclasses、`ZSA_AI_BATCH_RUN` 的
   `abap create/push/check syntax/activate/abap test`——本分支未连 SAP，只做了离线
   `pnpm sap:check`（AFF 20/20、`abap check content` 10 文件）。**blocked（需测试系统 + Phase B 窗口）**。
9. **控制平面可达 + HMAC secret 注入**：SAP job API 复用 H2-B 的控制平面可达与 `SA_SAP_HOOK_SECRET`
   输入。**blocked（人工，同 H2-B）**。
10. **企业 AI 网关**：`AI_GATEWAY_URL` / `AI_GATEWAY_MODEL` / key 与出口策略、SAP 安全存储注入方式
    （`AI_KEY_REF` 的实际实现：Basis 应用密钥/SSF/自定义表）与网关 TLS 证书（STRUST）。**blocked（人工）**。
11. **SM36 作业窗口与权限**：`ZSA_AI_BATCH_RUN` 周期作业（含 bgRFC 可选通道）需 Basis 创建与授权；
    调度周期应小于控制平面租约（默认 10min）、与 `AI_TIMEOUT_MS`/ICM 超时协调。**blocked（人工）**。
12. **端到端 M3 证据**：无 executor 在线时 SAP job 驱动 `intake/requirement_analysis/test_doc` 阶段、
    SAP 内审批推进、网关超时/非法输出重试到 `waiting_human`——需 9/10/11 全部就绪后由控制平面
    `SA_SAP_AI_BATCH=1` 驱动，SAP 侧提供 SM37 日志、`GET /hooks/sap/status` 与事件链证据。**blocked（人工）**。

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
- **S5 网关超时**：`ZCL_ZSA_AI_BATCH` 未在代码里调用 `cl_http_client` 客户端级 timeout API
  （Phase A 无真机，不引入未验证 API）；网络超时需 Phase B 在 ICM/SM59 配置（建议 ≤ 控制平面租约）。
  `AI_TIMEOUT_MS` 只用于计算有效网关超时与续租时机；超时/传输失败会以 `GATEWAY_TIMEOUT` /
  `GATEWAY_TRANSPORT`（`retryable:true`）回传。
- **S5 BAL 日志对象**：应用日志对象 `ZSA` / 子对象 `AI_BATCH` 需 SLG0 配置；未配置时记录调用被
  静默跳过（job 不失败），SM37 仍能看到程序 `WRITE` 的汇总行。
- **S5 真机语法/单测未跑**：`ZCL_ZSA_AI_BATCH` 的 `cl_http_client`、`BAL_*` 函数与 `/ui2/cl_json`
  snake_case 反序列化只经过离线 `abap check content`（结构级，不做 API/语法检查），
  Phase B 首次 `abap check syntax` / `abap test` 是必须的 gate。

## 本地离线校验

```sh
pnpm sap:check                          # 离线：结构检查 + abap validate:aff + abap check content
                                        # S5 后：必需文件 29 个、AFF 20/20、10 个 ABAP 文件
SA_SAP_CHECK_ONLINE=1 pnpm sap:check    # 有测试系统时额外跑 abap check syntax（H2-B 实测全绿，S5 待 Phase B）
```
