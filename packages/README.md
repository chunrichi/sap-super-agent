# packages/

包边界与依赖方向见 [docs/006-repo-and-git.md](../docs/006-repo-and-git.md) §1–§2。

| 包 | 说明 | 状态 |
| --- | --- | --- |
| `protocol` | zod schema + 类型 + 事件 envelope；契约唯一来源（`contracts/` 由它生成） | v1.0 可用（59 schemas / 9 examples / 27 routes） |
| `core` | 领域模型、状态机、调度与门禁规则（纯函数，无 IO） | v1.0 可用 |
| `server` | 控制平面宿主：Fastify HTTP/WS、`node:sqlite` 存储、事件日志、租约/心跳 sweeper、AI stage runner、M3 SAP job 队列 | v1.0 可用 |
| `ai` | BYOK 模型适配器（OpenAI 兼容 + fake）、阶段 prompt/输出校验、run ledger、golden set | v1.0 可用 |
| `sap-adapter` | SAP ICF JSON 客户端、webhook 验签、字段映射、对账 | v1.0 可用（H2 Phase A；Phase B 端到端 blocked） |
| `cli` | `init` / `dev` / `token` / `doctor`（M1 入口） | v1.0 可用 |
| `testkit` | 临时状态目录、fake executor/SAP/AI gateway/SAP batch、`pnpm e2e` harness | v1.0 可用 |
| `clients/vscode` | VSCode 扩展：任务箱、presence、上下文包、审批、VSIX 打包与真实 Extension Host 冒烟 | v1.0 可用（VSIX） |
| `mcp` | 可选 MCP server（v1.1，不进入本轮） | 未来 |
