## 原则

1.删掉多余的标语、说明文字和次要标签。如果删完界面就看不懂，说明布局本身就有问题，直接重新设计。 
2.每次修改都要兼顾用户体验， 开发体验和 AI Agent 的使用体验。三个都要变好，而且不能破坏现有功能。
3. 使用 abap-cli 进行 abap 开发
## 在本仓库工作的 Agent

- 第一次进入先读 `HANDOFF.md`、`handoffs/STATUS.md` 与 `docs/000–009`，再认领 `handoffs/` 中的任务。
- 只改任务书写明的写范围；跨包契约变更先改 `packages/protocol` 与 `docs/003`。
- 每个子项更新 `handoffs/STATUS.md`；提交遵循 `docs/006`（Conventional Commits + DCO）。
- SAP 任务先加载 `.agents/skills/abap-cli/SKILL.md`；只连测试系统。
