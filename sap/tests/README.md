# ABAP Unit（SAP 侧）

ABAP Unit 测试类放在 **主类同目录**，采用 abapGit 的 `*.clas.testclasses.abap` companion 布局
（abap-cli `validate:aff` 同样把它识别为 CLAS 的可选 companion）：

| 主类 | 测试文件 | 覆盖 |
| --- | --- | --- |
| `ZCL_ZSA_EVENT_PUSH` | `src/zcl_zsa_event_push.clas.testclasses.abap` | outbox 退避序列、HMAC 签名格式 |
| `ZCL_ZSA_HTTP_HANDLER` | `src/zcl_zsa_http_handler.clas.testclasses.abap` | handler 路由分类、回写字段白名单、时间戳往返 |

运行（测试系统，只读命令）：

```sh
abap test ZCL_ZSA_EVENT_PUSH
abap test ZCL_ZSA_HTTP_HANDLER
```

Phase B 验收时把执行结果（通过/失败数、失败详情）记录到 `handoffs/STATUS.md`；
**不要**把 SAP 地址、凭据或传输请求号写进本目录。
