# ABAP Unit（SAP 侧）

ABAP Unit 测试类放在 **主类同目录**，采用 abapGit 的 `*.clas.testclasses.abap` companion 布局
（abap-cli `validate:aff` 同样把它识别为 CLAS 的可选 companion）：

| 主类 | 测试文件 | 覆盖 |
| --- | --- | --- |
| `ZCL_ZSA_EVENT_PUSH` | `src/zcl_zsa_event_push.clas.testclasses.abap` | outbox 退避序列、HMAC 签名格式 |
| `ZCL_ZSA_HTTP_HANDLER` | `src/zcl_zsa_http_handler.clas.testclasses.abap` | handler 路由分类、回写字段白名单、时间戳往返 |
| `ZCL_ZSA_AI_BATCH`（S5） | `src/zcl_zsa_ai_batch.clas.testclasses.abap` | control plane job/payload JSON 映射、OpenAI 兼容网关 request/response、result 报文体、HMAC 已知向量与 `X-SA-*` 头、claim/result 409 分类、网关 4xx/429/5xx/超时分类、租约续期、有效超时、批次上限、result 交付键幂等 |

运行（测试系统，只读命令）：

```sh
abap test ZCL_ZSA_EVENT_PUSH
abap test ZCL_ZSA_HTTP_HANDLER
abap test ZCL_ZSA_AI_BATCH        # S5 Phase A 源文件；真机执行属 Phase B blocked
```

Phase B 验收时把执行结果（通过/失败数、失败详情）记录到 `handoffs/STATUS.md`；
**不要**把 SAP 地址、凭据或传输请求号写进本目录。
