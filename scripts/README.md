# scripts/

| 脚本 | 用途 | 引入任务 |
| --- | --- | --- |
| `e2e.mjs` | `pnpm e2e`：M1 本地纵向闭环，覆盖 docs/009 失败场景 #1/#2/#3/#10。实际用 Vitest 跑 `packages/testkit/e2e/`（进程内 server + 临时状态目录 + fake AI + fake executor），不依赖网络、SAP 或 VSCode | H0 |
| `contract-gen.mjs` | `pnpm contract:gen`：从 `@sap-superagent/protocol` 的 zod registry 生成 `contracts/json-schema/*.json` 与 `contracts/examples/*.json`，并校验 `contracts/openapi.yaml` 覆盖全部 S0 路由；`--check` 模式用于 `pnpm check` 的快照比对 | H0 |
| `vitest-aliases.mjs` | 各包 Vitest 共享别名：把 `@sap-superagent/*` 指到源码，测试无需先 build | H0 |
| `eval-golden.mjs` | golden set 离线评测，输出 `evals/report.json` | H1 |
| `sap-check.mjs` | `pnpm sap:check`：`abap validate:aff` + `abap check content`，可用时再加 `abap check syntax`（无 SAP 系统时跳过并说明） | H2 |
| `link-check.mjs` | `pnpm link:check`：离线 markdown 相对链接与 GitHub 标题锚点检查（大小写敏感、`--json`、坏链 exit 1） | v1.0 发布准备 |
| `vsix-package.mjs` | `pnpm package:vsix`：esbuild 单文件 bundle + clean-room stage + vsce 打包与 VSIX 内容校验（产物 `tmp/vsix/*.vsix`） | v1.0 发布准备 |
| `vscode-smoke.mjs` | `pnpm vscode:smoke`：真实控制平面 + 真实 VSCode Extension Host 冒烟（任务箱/claim/上下文包/审批）；需要桌面版 VSCode，CI 不跑 | v1.0 发布准备 |
