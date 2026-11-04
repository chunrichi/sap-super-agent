# 贡献指南

本项目仍处于设计落地阶段；先阅读 [HANDOFF.md](HANDOFF.md) 与 [docs/006-repo-and-git.md](docs/006-repo-and-git.md)。

## 开发命令

```sh
corepack enable
pnpm install
pnpm check        # typecheck + lint + unit + contract
pnpm e2e          # 本地模式全链路（M1）
```

SAP 侧改动另需：

```sh
abap doctor
abap check syntax
```

## 提交

- Conventional Commits，scope 用包名或目录：`feat(core): ...`、`fix(vscode): ...`、`docs(004): ...`。
- 一个提交只做一件事；提交信息写"为什么"，不写"改了什么"的流水账。
- 所有提交带 DCO 签名：`git commit -s`（`Signed-off-by`）。
- 不提交密钥、`.env`、`.abap.json`、`.sap-superagent/` 状态、日志与构建产物。

## 分支与 PR

- 从 `main` 开短期分支：`feat/<area>-<slug>`、`fix/<area>-<slug>`、`docs/<slug>`。
- PR 使用仓库模板，说明关联的 handoff 任务、验证命令、风险。
- 协议变更必须同时更新 `packages/protocol`、`contracts/` 与 docs 的对应章节。

## SAP 开发

- 统一使用 [abap-cli](.agents/skills/abap-cli/SKILL.md)；先读 skill，再执行 `pull → 编辑 → check → push --tr → activate`。
- 只连测试系统；生产传输走企业既有流程，CI 不自动激活生产。
