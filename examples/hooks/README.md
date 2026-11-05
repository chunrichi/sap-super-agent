# examples/hooks — 占位适配器（只配置样例 + 字段映射）

JIRA / CHARM / Confluence / Teams 的**占位适配器**：本仓库不实现任何具体系统客户端，也不新增依赖。字段映射在适配器/配置层完成，**不进核心阶段图**（docs/008 §3）。

| 文件 | 逻辑动作 | 订阅的持久事件 | 幂等/失败要点 |
| --- | --- | --- | --- |
| `jira.yaml` | `hook.jira.issue.ensure` | `artifact.approved`（G1 通过） | 先按 demandNo 查后建；5xx 退避、4xx 死信；按 demandNo 每日对账 |
| `charm.yaml` | `hook.charm.tr.ensure` | `artifact.approved`（G3 确认） | **非幂等**：先按业务键查询再建，无法确认转人工；TR 号回执 |
| `confluence.yaml` | `hook.confluence.page.upsert` | `stage.done`（归档完成） | 按 (space,title) upsert 可安全重试；pageId 回执 |
| `teams.yaml` | `hook.teams.notify` | `stage.waiting_human` / `approval.requested` | 通知可丢但留审计；429 按 `Retry-After` |

## 启用一个适配器

1. 把对应文件复制成 `examples/hooks.yaml`（或用 `SA_HOOKS_CONFIG` 指向它），把 `enabled` 改成 `true`；
2. `export <secretRef 的变量名>=...`（secret 只从环境读取，不落库/日志）；
3. 按实际系统改 `url`（以及可选的 `reconcileUrl`），重启控制平面；
4. 用 `GET /hooks`（admin）看队列深度与 `lastError`，用 `pnpm hooks:reconcile` 出每日差异报告。

## 契约

- 出站信封、HMAC 头、重试/死信/重放：`docs/008 §2/§5/§6`（机器可读：`contracts/json-schema/hook-envelope.json`）。
- 入站回执：`POST /hooks/{id}/receipt`（HMAC，body 见 `contracts/json-schema/hook-receipt-body.json`）。
- `reconcileUrl` 返回 JSON 数组或 `{items: [...]}`，元素含 `externalId` / `id` / `key`。
- 无法用配置表达的映射（例如先查后建、复杂鉴权）应放在企业私有适配器实现里，而不是改核心阶段图或本文档。
