# scripts/

| 脚本 | 用途 | 引入任务 |
| --- | --- | --- |
| `e2e.mjs` | `pnpm e2e`：M1 本地纵向闭环，覆盖 docs/009 失败场景 #1/#2/#3/#10。实际用 Vitest 跑 `packages/testkit/e2e/`（进程内 server + 临时状态目录 + fake AI + fake executor），不依赖网络、SAP 或 VSCode | H0 |
| `contract-gen.mjs` | `pnpm contract:gen`：从 `@sap-superagent/protocol` 的 zod registry 生成 `contracts/json-schema/*.json` 与 `contracts/examples/*.json`，并校验 `contracts/openapi.yaml` 覆盖全部 S0 路由；`--check` 模式用于 `pnpm check` 的快照比对 | H0 |
| `vitest-aliases.mjs` | 各包 Vitest 共享别名：把 `@sap-superagent/*` 指到源码，测试无需先 build | H0 |
| `eval-golden.mjs` | golden set 离线评测，输出 `evals/report.json` | H1 |
| `sap-check.mjs` | `abap validate:aff` + 可用时的 `abap check syntax`（无 SAP 系统时跳过并说明） | H2 |
