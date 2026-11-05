# 006 仓库结构与 Git 策略

本文给出 GitHub 开源项目的目录结构、包边界、提交规范、分支与发布策略。目标是同时满足三类读者：业务/开发使用者、贡献者、AI Agent。

## 1. 目录结构

```text
sap-superagent/
├─ README.md                    # 项目是什么、快速开始、文档索引
├─ HANDOFF.md                   # 交给执行 Agent 的任务书（S0/S1/S2）
├─ handoffs/                    # 任务书与状态看板（H0/H1/H2、STATUS.md）
├─ demo/                        # 设计演示（单文件 HTML + 海报，可在浏览器打开）
├─ AGENTS.md                    # AI Agent 协作规范（已有原则 + 本仓库约定）
├─ LICENSE                      # Apache-2.0（v1 决定；专利授权对企业更友好）
├─ NOTICE                       # 第三方许可声明（含 abap-cli skills 的 MIT 来源）
├─ CONTRIBUTING.md              # 贡献流程、DCO、开发命令
├─ SECURITY.md                  # 漏洞报告、密钥与数据边界
├─ CODE_OF_CONDUCT.md
├─ CHANGELOG.md                 # changesets 生成
├─ package.json                 # workspace root（private）
├─ pnpm-workspace.yaml
├─ tsconfig.base.json
├─ .editorconfig / .gitignore / .env.example / .nvmrc / .npmrc
├─ .github/
│  ├─ workflows/                # ci.yml / release.yml / abap-check.yml(手动)
│  ├─ ISSUE_TEMPLATE/           # feature · bug · sap-object · question
│  └─ pull_request_template.md
├─ docs/                        # 设计文档，按顺序阅读
│  ├─ plan.md                   # 原始需求简报（保留，不修改）
│  ├─ 000-vision.md
│  ├─ 001-review.md
│  ├─ 002-architecture.md
│  ├─ 003-domain-and-protocol.md
│  ├─ 004-sap.md
│  ├─ 005-clients-and-ai.md
│  ├─ 006-repo-and-git.md       # 本文
│  ├─ 007-roadmap.md
│  ├─ 008-hooks.md              # Hook 契约（JIRA/CHARM/Confluence/Teams）
│  ├─ 009-testing.md            # 测试策略与失败场景矩阵
│  └─ reference/                # 调研附录（论文/参考实现/可行性/PDO 映射）
├─ contracts/                   # 协议机器可读契约（生成物入库，便于 review）
│  ├─ openapi.yaml
│  ├─ asyncapi.yaml
│  ├─ json-schema/
│  └─ examples/
├─ packages/
│  ├─ protocol/                 # @sap-superagent/protocol
│  ├─ core/                     # @sap-superagent/core（纯领域逻辑）
│  ├─ server/                   # @sap-superagent/server（控制平面宿主）
│  ├─ ai/                       # @sap-superagent/ai（服务端 AI 阶段）
│  ├─ sap-adapter/              # @sap-superagent/sap（ICF JSON/webhook）
│  ├─ mcp/                      # 可选 MCP server（v1.1，见 005 §2.4）
│  ├─ cli/                      # @sap-superagent/cli
│  ├─ testkit/                  # 内存仓库 + e2e 工具
│  └─ clients/
│     ├─ vscode/                # sap-superagent-vscode（VSIX）
│     └─ web/                   # 可选运维面板
├─ templates/                   # 阶段模板（default / pdo），YAML + schema 校验
├─ prompts/                     # 服务端 AI 提示词覆盖层（包内为默认，这里按 key 合并）
├─ sap/                         # ABAP 侧对象源（abap-cli AFF，独立交付单元）
│  ├─ src/                      # Z 对象源码（DDIC / ICF handler / MIME Web / outbox / jobs）
│  ├─ ui/                       # MIME 静态资源（/zsa/ui）
│  ├─ tests/                    # ABAP Unit
│  └─ README.md                 # abap-cli 创建/推送/激活与验收步骤
├─ examples/
│  ├─ local/                    # M1：一条命令启动的示例配置
│  ├─ hooks.yaml                # Hook 配置示例（见 008）
│  ├─ compose/                  # M2：docker-compose.yml
│  └─ vscode-workspace/         # 示例 .vscode 配置与工作区绑定
├─ scripts/                     # e2e / contract-gen / eval-golden / sap-check 等脚本
├─ .agents/                     # AI Agent 技能与角色（已有 abap-cli skills）
└─ .vscode/                     # 推荐设置、调试配置、任务
```

约定：

- 包名统一 `@sap-superagent/*`，VSCode 扩展与 SAP 包名带前缀避免 Marketplace / SAP 命名冲突。
- `contracts/` 是生成物但入库：协议变更在 PR 里可 review、可 diff。
- `sap/` 是独立交付单元（abap-cli AFF），**不**参与 pnpm workspace；S2 Phase B 用本地包 `$ZSA` + abap-cli 建对象，**abapGit 本轮不实现**；发布时单独打 tag（`sap-v*`）。
- `docs/` 编号文档是权威设计；`docs/reference/` 是调研材料，允许过期，改动不要求同步。
- `HANDOFF.md` + `handoffs/` 是执行交接层：只写“现在做什么/怎么验收”，不重复设计；实现偏离设计时先改 docs。
- `templates/` 只放阶段模板与 schema 引用；模板是配置，不是代码分支。
- 根 `prompts/` 是覆盖层：`packages/ai` 内置默认提示词，加载时按 key 合并；npm 包不依赖根目录存在。
- 不设 `src/` 单体目录；每增加一类能力先问"是否属于已有包"，避免包膨胀。
- 许可证：**Apache-2.0**；贡献采用 **DCO**（提交带 `Signed-off-by`），不引入 CLA。
- `.gitignore` 需覆盖 `.sap-superagent/*`（保留 `!.sap-superagent/workspace.json`）与 `.sap-superagent-worktrees/`。

## 2. 各包的发布与依赖方向

依赖边（`A → B` 表示 A 依赖 B）：

```text
core → protocol
server → core, protocol, ai, sap-adapter
mcp → protocol
cli → server
clients/vscode → protocol
ai → protocol
sap-adapter → protocol
testkit → protocol, core
```

- `protocol` 不依赖任何包；`core` 只依赖 `protocol`；`server` 不反向依赖客户端。
- 客户端只依赖 `protocol`，**不依赖** `server`（可独立发布）。
- 依赖方向由 CI 检查（`dependency-cruiser` 或 eslint 规则），禁止环。

## 3. Git 策略

### 3.1 分支

- `main` 是唯一长期分支，受保护：PR + CI 通过 + 线性历史（squash merge）。
- 短期分支：`feat/<area>-<slug>`、`fix/<area>-<slug>`、`docs/<slug>`、`chore/<slug>`，生命周期 ≤3 天，合并后删除。
- 不设 `develop`；发布从 `main` 打 tag。紧急修复走 `fix/` 分支，不直接推 `main`。
- 每个 AI Agent / 每个人同时只占一个分支；避免多 Agent 共用分支造成不可审计的混合提交。

### 3.2 提交信息（Conventional Commits）

```text
<type>(<scope>): <一句话，中文或英文均可>

<为什么改，1-3 行；不复述 diff>

<验证方式 / 影响面 / 迁移说明>

Refs: #12
```

- `type`：`feat` `fix` `docs` `refactor` `test` `chore` `perf` `build` `ci`。
- `scope` 对应包或目录：`core` `protocol` `server` `ai` `vscode` `sap` `repo` `docs`。
- 一个提交只做一件事；格式/重命名与逻辑改动分开；禁止 `wip`/`update`/`fix bug` 这类信息。
- 破坏性变更：`feat(core)!: ...` 或 body 中 `BREAKING CHANGE:`。
- AI Agent 提交同样遵守；PR 描述中必须写：任务来源、改动摘要、验证命令、风险。

### 3.3 初始提交序列

首次建仓按"可 bisect、每步可验证"的顺序提交，避免一次巨型 `initial commit`：

| # | 提交 | 内容 |
| --- | --- | --- |
| 1 | `chore(repo): initialize repository` | `.gitignore`、LICENSE、editorconfig、README 骨架、AGENTS.md、`docs/plan.md` |
| 2 | `docs: add vision and design review` | `000`、`001` |
| 3 | `docs: add architecture, domain and protocol` | `002`、`003` |
| 4 | `docs: add SAP, client, hook and repository design` | `004`–`009`、`templates/` 说明、`reference/` |
| 5 | `docs: add agent handoffs for S0-S2` | `HANDOFF.md`、`handoffs/`、进度看板 |
| 6 | `feat(protocol): add event envelope and task schemas` | 契约包 + schema 测试 |
| 7 | `feat(core): add demand workflow state machine` | 纯函数 + 单测 |
| 8 | `feat(server): add walking-skeleton API` | SQLite、REST、WS、内存 ai 执行器 |
| 9 | `feat(cli): add local mode init and dev` | M1 一条命令启动 |
| 10 | `feat(vscode): add task inbox and executor registration` | 扩展最小闭环 |
| 11 | `test: add end-to-end walking skeleton` | 需求→AI→领取→工件→完成 |
| 12 | `chore(ci): add ci workflows` | GitHub Actions |

从第 6 步（protocol）起每个提交都应能通过 `pnpm check`；文档提交允许先于实现（设计先行）。

### 3.4 版本与发布

- v1 之前统一 `0.x`；包之间固定版本（fixed versioning），一次发布一个 tag `v0.2.0`，减少版本组合。
- changesets 管理 CHANGELOG 与版本；发布由 GitHub Actions 在 tag 上执行：
  - npm：`protocol`、`core`、`server`、`cli`、`sap-adapter`；
  - GitHub Release：VSIX、Docker 镜像 digest、SAP 包说明；
  - `sap/` 单独 tag `sap-v0.1.0`，附 abap-cli 建对象说明（本地包 `$ZSA`，无 TR）。
- 发布节奏：S0–S1 期间按需；v0.1.0 = walking skeleton 可演示；v1.0.0 = M2 + SAP + 门禁 + 一个 Hook 示例可用。

### 3.5 PR 与 Issue

- PR 模板：背景/改动/验证/风险/截图（客户端改动）；改动 >400 行需要拆分或说明理由；所有提交带 `Signed-off-by`（DCO）。
- CI 必须通过：typecheck、lint、unit、contract diff、build。ABAP 相关改动需要 `abap-check` 手动工作流（连接测试系统 `check`，不自动激活）。
- Issue 模板：feature（背景、期望、验收）、bug（复现、期望、环境）、sap-object（对象、系统、传输请求策略）、question。
- 标签：`area/*`、`type/*`、`good first issue`、`blocked`。里程碑对应 [007-roadmap.md](007-roadmap.md) 的 S0–S5。

### 3.6 安全与合规

- 不提交 `.abap.json`、`.abap-cli/`、`.env`、VSIX、日志、状态目录（`.gitignore` 已覆盖大部分，继续补充）。
- BYOK 模型 Key 只存服务端环境变量/secret manager；示例配置只放 `.env.example`（`OPENAI_BASE_URL`、`OPENAI_API_KEY` 等占位）。
- SAP 凭据只存在于本地 config 或 CI secret，且 CI 只允许测试系统、只读/检查类操作。
- 依赖扫描（Dependabot）+ secret scanning 开启；`SECURITY.md` 写明数据外发边界（需求/代码是否可发给外部模型）。
- `NOTICE` 列出第三方许可：`.agents/skills/abap-cli*` 源自 [chunrichi/abap-cli](https://github.com/chunrichi/abap-cli)（MIT），复制时保留版权声明。
- 失败场景测试矩阵见 [009-testing.md](009-testing.md)；协议变更必须同时更新 `contracts/` 与测试。

## 4. 让 AI Agent 好用的约定

- `AGENTS.md` 固定包含：项目地图（docs 索引）、常用命令、必须遵守的约定（提交规范、生成物勿手改、禁止操作）、验证清单。
- `.agents/skills/` 保存可复用技能（已有 abap-cli 系列）；新增技能先写 SKILL.md 再写代码。
- 所有关键命令放进 `package.json` scripts 或 `scripts/`：`pnpm dev`、`pnpm check`、`pnpm e2e`、`pnpm contract:gen`、`pnpm sap:check`。
- 文档中的路径、命令、字段名必须与代码一致；CI 增加 docs 链接检查与示例命令冒烟。
- 每个 PR 的验证命令可直接复制执行，不依赖隐含环境（除 SAP 相关需显式说明）。
