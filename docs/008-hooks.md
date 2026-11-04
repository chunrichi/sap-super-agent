# 008 Hook 契约

Hook 是对 JIRA / CHARM / Confluence / Teams 等外部系统的**唯一扩展入口**。v1 只定义契约与一个 `http` 示例目标，不实现具体业务适配。领域概念与事件见 [003-domain-and-protocol.md](003-domain-and-protocol.md)。

## 1. 原则

- **不进阶段图**：Hook 绑定"阶段完成 / 门禁通过 / 需求状态变化"等事件；只有需要人工确认的中间动作（如 CHARM 传输审批）才升格为 Gate 或人工 Task，再由 Hook 通知或回执。
- **至少一次 + 幂等**：每个 Hook 有稳定的 `idempotencyKey`；外部系统不支持幂等时，先查后建。
- **失败可见**：分为可重试（网络/5xx/429）与永久失败（4xx 校验失败）；永久失败进死信并要求人工处理，禁止静默丢弃。
- **可对账**：外部系统返回的 ID（`jiraKey`、`trNumber`、`pageId`）回写工件或需求事件，作为每日对账依据。
- **契约独立于实现**：本文与 `contracts/json-schema/hook-*.json` 是权威定义；适配器只做字段映射，不在核心加业务分支。

## 2. 统一信封

```json
{
  "eventId": "01J...",
  "eventType": "hook.jira.issue.ensure",
  "eventVersion": 1,
  "occurredAt": "2026-11-04T12:00:00Z",
  "subject": {
    "demandId": "4a3f9c2e7b1d48f0a6c5e2d9b8f7a1c3",
    "demandNo": "R-2041",
    "stageRunId": "01J...",
    "artifactId": "01J...",
    "version": 2
  },
  "payload": {},
  "idempotencyKey": "<demandId>:<hook>:<sha256(stableInputs)>",
  "retry": { "maxAttempts": 5, "backoff": "exponential", "deadLetter": true },
  "traceId": "..."
}
```

- `eventVersion` 随 payload schema 演进；目标可拒绝未知版本并进死信。
- `subject` 只放 ID 与版本，不放正文；正文以工件引用给出，避免敏感内容在多个系统复制。
- `idempotencyKey` 由控制平面生成，重放时保持不变。

## 3. 出站目标

| 目标 | 事件类型 | 触发点 | payload 关键字段 | 幂等键 | 失败/对账 |
| --- | --- | --- | --- | --- | --- |
| JIRA issue | `hook.jira.issue.ensure` | 需求分析门禁通过后 | `project`, `issueType`, `summary`, `descriptionRef`, `priority`, `demandNo` | `demandId:jira:<templateVersion>:<sha256(analysis)>` | 先查后建；5xx 退避；4xx 死信；每日按 `demandNo` 对账 |
| CHARM TR | `hook.charm.tr.ensure` | 开发说明确认后（G2/G3） | `targetSystem`, `client`, `owner`, `descriptionRef`, `artifacts[]`, `demandNo` | `demandId:charm:<targetSystem>:<sha256(code_change)>` | **非幂等**：先按业务键查询再建；仍未定则转人工 Task；TR 号回写；每日对账 |
| Confluence | `hook.confluence.page.upsert` | 归档阶段完成 / 发布确认后 | `space`, `parentId`, `title`, `bodyRef`, `labels[]`, `demandNo` | `demandId:confluence:<pageKey>:<version>` | upsert 可安全重试；发布前需 G5；按 pageId 对账 |
| Teams 通知 | `hook.teams.notify` | 待人工任务、门禁、超时升级 | `channel`, `template`, `demandNo`, `deepLink`, `mention` | `eventId` | 通知可丢（TTL 后放弃）但留审计；429 按 `Retry-After`；默认由 SAP 内通知替代 |
| SAP 回写 | `hook.sap.writeback` | 每次阶段/门禁/状态变化 | `demandId`, `status`, `artifactRef`, `approvalResult` | `demandId:writeback:<version>` | 乐观并发 `If-Match`；409 重拉后重放；每日对账 |

## 4. 入站回执

外部系统完成后回调：`POST /hooks/{target}/receipt`（HMAC 或双向 TLS）。

| 字段 | 说明 |
| --- | --- |
| `eventType` | `hook.receipt` |
| `idempotencyKey` | 外部系统 ID + 状态；重复回执不重复推进 |
| `payload.externalId` | `jiraKey` / `trNumber` / `pageId` |
| `payload.status` | `created` / `updated` / `failed` / `cancelled` |
| `payload.detailRef` | 可选，外部系统详情链接 |

回执写入事件日志；按 `externalId` 更新工件的 `links`，并推进对应阶段或标记失败。回执丢失由每日对账修复，**不重放创建动作**。

## 5. 失败语义与重试

| 类别 | 判定 | 处理 |
| --- | --- | --- |
| 可重试 | 网络错误、5xx、429、超时 | 指数退避：控制平面 2s 起、上限 5min、最多 5 次；SAP outbox 按 004 §3.3 |
| 永久失败 | 4xx（字段/权限/校验错误） | 进入死信，通知负责人；阶段不因此失败，由人决定跳过或修正 |
| 非幂等动作 | CHARM 建 TR 等 | 先查后建；无法确认时转人工，不自动重试 |
| 阶段取消 | 需求取消 / 阶段退回 | 未发送的 Hook 标记 `cancelled`；已发送的补发关闭/留言动作 |
| 对账失败 | 外部 ID 找不到 | 记录到对账报告，人工修复；不重放创建 |

## 6. 配置与实现

```yaml
# examples/hooks.yaml（示意）
hooks:
  - id: jira
    event: hook.jira.issue.ensure
    target: http
    url: https://jira.example.com/api/issues
    secretRef: env:JIRA_HOOK_SECRET
    enabled: false
    retry: { maxAttempts: 5, backoff: exponential, deadLetter: true }
```

- 出站队列与 003 的事件日志共用 outbox 机制；每次尝试写事件 `hook.attempted` / `hook.delivered` / `hook.dead`。
- 管理命令：`GET /hooks`（状态与队列深度）、`POST /hooks/{id}/replay`（按 eventId 重放，幂等）。
- 死信与对账结果进入运维面板与每日报告；不默认发聊天通知。
- 具体适配器（JIRA/CHARM/Confluence/Teams）按本契约实现，放 `packages/sap-adapter` 之外的独立包或企业私有仓库，避免开源仓库绑定某家企业系统。

## 7. 验收（S4）

1. 任一阶段事件可配置触发一个 HTTP 目标；payload 通过 JSON Schema 校验。
2. 5xx 触发退避重试，4xx 进死信且可见；重放不产生重复外部单。
3. 回执可推进阶段；重复回执幂等。
4. 每日对账报告能列出"外部系统有、控制平面无"与"控制平面有、外部系统无"两类差异。
