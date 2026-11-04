# H1 — 门禁与模板（S1）

> 依赖：H0 完成（protocol/core/server 骨架可跑）。可与 H2 并行，但不要改 `packages/server/src/hooks/` 与 `workers/sap-*`（属于 H2）。
> 目标：让"人工确认"成为一等公民；支持默认 3 阶段与 PDO 6 阶段模板；工件版本可追溯；AI 产出有可判定的完成条件。
> 规格来源：[docs/003](../docs/003-domain-and-protocol.md) §2.2/2.4/2.5/2.7、[docs/005](../docs/005-clients-and-ai.md) §3/§4、[docs/007](../docs/007-roadmap.md) S1、[docs/009](../docs/009-testing.md)。

## 1. 交付物

### 1.1 模板系统

- `packages/core/src/template.ts`：按 003 §2.7 的 `StageTemplate` 实现 zod schema + loader + validator：
  - 字段：`templateId, version, stages[{key,name,executorKind,inputArtifactKinds[],outputArtifactKind,gate,maxAttempts,checklist[]}], gates[{gateKey,role,timeoutDays}]`。
  - `gate: none | {gateKey, role}`；`checklist` 是可判定断言 key（实现见 1.3）。
- `templates/default.yaml`：3 阶段 = 需求分析（G1, `consultant`）→ 开发实现（G3, `consultant`+`developer` 评审）→ 验收归档（G4, `requester`）。
- `templates/pdo.yaml`：6 阶段，按 [005 §4](../docs/005-clients-and-ai.md) 表格（受理/分析/开发说明/开发/测试验收/归档），门禁 G1–G5。
- `templateVersion` 固定：Demand 创建时记录 `templateId + version`；模板后续变更只影响新 Demand；进行中 Demand 忽略新版本。
- `packages/server`：启动时加载模板并校验；API `GET /templates`（只读）；管理端可选 `POST /admin/demands` 指定模板（本地模式用）。
- 测试：模板 schema 正反例；切换模板不影响在办 Demand；未知 stage/artifact kind 拒绝。

### 1.2 Approval 与 Gate

- core：Approval 状态机 `pending → approved | rejected | withdrawn | expired`；`expired` 由 `timeoutDays` 计算（定时 job）。
- Gate 是模板规则（无状态）；StageRun 到门禁进入 `waiting_human`；审批结果驱动 `running`（新 attempt）或 `cancelled`/`done`。
- server：
  - `GET /approvals?assignee=me`、`POST /approvals/{id}/decisions`（approve/reject + comment）；幂等（终态后再决策返回 409）。
  - Approval 到期 job（默认每小时）；到期写事件 + 通知。
  - 门禁通知：本地/CLI 输出 + `notifications` 表；Teams 通过 H2 之后的 Hook，不实现。
- 测试：审批通过推进、驳回退新 attempt、撤回、超时、终态幂等；StageRun 不卡死（009 #14）。

### 1.3 阶段完成条件（schema + checklist）

- `packages/core/src/checklist.ts`：可判定断言注册表，至少：
  - `sections_present`：输出工件包含模板要求的章节/字段；
  - `inputs_referenced`：引用的上游工件 ID/版本存在；
  - `not_stale`：上游无更新版本（或已确认忽略）；
  - `acceptance_covered`：每条验收标准在输出中有对应条目（关键项）。
- `packages/server`：stage done 判定 = 输出工件 schema 通过 **且** checklist 通过；不通过 → attempt+1 或转 `waiting_human`（按 maxAttempts）。
- 工件 `stale` 传播：上游产生新版本时，下游已生成工件标 `stale` 并阻断阶段推进；门禁展示 stale 原因。

### 1.4 工件版本与 supersede

- 已有 H0 的不可变版本基础上补齐：
  - 新版本创建时旧版本 `superseded`；
  - `Approval` 绑定 `(artifactId, version)`；
  - 退回修改生成新 attempt/新工件版本，不覆盖；
  - `GET /demands/{id}` 返回按阶段分组的版本链与 stale 标记。
- 测试：版本链、审批绑定版本、退回留痕、stale 传播（009 #13）。

### 1.5 自主度模式（执行/通知两条轴的可配置部分）

- 阶段模板支持 `autonomy: auto | observe`（默认 `observe` 用于新模板的 server-ai 阶段：只生成草稿 + 不自动推进；H0 已有最小实现可扩展）。
- `observe`：阶段产出 draft 工件，停在 `waiting_human`，不自动进入下一阶段；`auto`：按门禁规则自动推进。
- 通知保持三类；不新增渠道。

### 1.6 Golden set 评测

- `evals/golden/`：20–30 条脱敏的需求 fixture（JSON：标题、描述、验收标准、期望 checklist 结果、人工基线摘要）。
- `scripts/eval-golden.mjs`（根命令 `pnpm eval:golden`）：用 fake provider 或真实 BYOK 跑 `requirement_analysis`，输出 `evals/report.json`：
  - schema 通过率、checklist 通过率、引用完整性、人工修改行占比（fixture 提供基线）、每阶段成本。
- 阈值配置 `evals/thresholds.json`（人工修改率 <15% → `auto` 建议，否则 `observe`）；脚本只给建议，不自动改模板。
- 测试：脚本在 fake provider 下稳定输出报告；schema 快照。

### 1.7 测试与文档

- 新增集成测试覆盖 009 #13/#14/#15；更新 `docs/003`（模板/审批/checklist 最终字段）、`docs/005`（observe/auto）、`docs/007`（S1 勾选）、`README`。
- `handoffs/STATUS.md` 更新。

## 2. 验收

```sh
pnpm check
pnpm e2e            # 含审批流：通过、驳回、超时
pnpm eval:golden    # fake provider 下产出 report.json，阈值判定可复现
```

手工冒烟：

1. 用 `default.yaml` 建 Demand：分析阶段生成工件后停在 G1；审批通过 → 开发任务出现；驳回 → 新 attempt。
2. 切到 `pdo.yaml` 新建 Demand，进行中的 default Demand 不受影响。
3. 上游分析出新版本 → 开发说明工件标 `stale`，G3 阻断并提示。

## 3. 不在本任务范围

SAP、Hook 具体适配器、MCP、M3、细粒度权限、真实模型质量调优（只做评测框架与阈值）。
不要改 `packages/protocol` 已有字段语义；需要新增字段时先在 003 补充。

## 4. 上报格式

完成项、验收命令输出摘要、评测报告路径与关键指标、偏差、遗留。
