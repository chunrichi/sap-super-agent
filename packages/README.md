# packages/

包边界与依赖方向见 [docs/006-repo-and-git.md](../docs/006-repo-and-git.md) §1–§2。

| 包 | 说明 | 状态 |
| --- | --- | --- |
| `protocol` | zod schema + 类型 + 事件 envelope；契约唯一来源 | H0 |
| `core` | 领域模型、状态机、调度与门禁规则（纯函数） | H0 |
| `server` | 控制平面宿主：HTTP/WS、存储、事件、调度、AI runner | H0 |
| `ai` | BYOK 模型适配器 + 服务端阶段流水线 | H0 |
| `sap-adapter` | SAP ICF JSON 客户端、webhook 验签、字段映射、对账 | H2 |
| `cli` | `init` / `dev` / `doctor` / `token`（M1 入口） | H0 |
| `testkit` | 内存仓库、fake AI / fake SAP / e2e harness | H0 |
| `clients/vscode` | VSCode 扩展：任务箱、presence、上下文包、Copilot 工具 | H0 |
| `mcp` | 可选 MCP server（v1.1，不进入本轮） | 未来 |
