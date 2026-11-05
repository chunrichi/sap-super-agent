# packages/

包边界与依赖方向见 [docs/006-repo-and-git.md](../docs/006-repo-and-git.md) §1–§2。

| 包 | 说明 | 状态 |
| --- | --- | --- |
| `protocol` | zod schema + 类型 + 事件 envelope；契约唯一来源（`contracts/` 由它生成） | S0 完成 |
| `core` | 领域模型、状态机、调度与门禁规则（纯函数，无 IO） | S0 完成 |
| `server` | 控制平面宿主：Fastify HTTP/WS、`node:sqlite` 存储、事件日志、租约/心跳 sweeper、AI stage runner | S0 完成 |
| `ai` | BYOK 模型适配器（OpenAI 兼容 + fake）、`requirement_analysis` 阶段、run ledger | S0 完成 |
| `sap-adapter` | SAP ICF JSON 客户端、webhook 验签、字段映射、对账 | 占位，S2（H2）实现 |
| `cli` | `init` / `dev` / `token` / `doctor`（M1 入口） | S0 完成 |
| `testkit` | 临时状态目录、fake executor/SAP、`pnpm e2e` harness | S0 完成 |
| `clients/vscode` | VSCode 扩展：任务箱、presence、上下文包、6 个命令 | S0 完成 |
| `mcp` | 可选 MCP server（v1.1，不进入本轮） | 未来 |
