# scripts/

| 脚本 | 用途 | 引入任务 |
| --- | --- | --- |
| `e2e.mjs` | 本地模式纵向闭环 | H0 |
| `contract-gen.mjs` | 从 protocol 生成/校验 OpenAPI 与示例 | H0 |
| `eval-golden.mjs` | golden set 离线评测，输出 `evals/report.json` | H1 |
| `sap-check.mjs` | `abap validate:aff` + 可用的 `abap check syntax` | H2 |
