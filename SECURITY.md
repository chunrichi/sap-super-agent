# 安全策略

本文说明 SAP Super Agent 的安全边界、受支持版本与漏洞报告方式。安全模型与威胁边界的完整推导见
[docs/002 §7 非功能基线](docs/002-architecture.md#7-非功能基线)、
[docs/005 §2.6 失败与安全](docs/005-clients-and-ai.md#26-失败与安全)；
M3 部署相关的网络、密钥与数据边界见 [docs/010 §4](docs/010-m3-deployment.md#4-配置环境变量与密钥)、
[§7](docs/010-m3-deployment.md#7-数据边界声明)。

## 支持版本

SAP Super Agent 使用语义化版本。只有最新发布线会获得安全修复：

| 版本 | 支持状态 |
| --- | --- |
| `1.0.x`（当前发布线） | ✅ 接受漏洞报告并发布安全修复 |
| `< 1.0.0`（开发/预发布版本，未公开发布） | ❌ 不再维护，请升级到 `1.x` |

安全修复以补丁版本发布（例如 `1.0.1`）；发布说明会描述受影响范围与升级建议，不公开未修复细节。

## 报告漏洞

**不要在公开 Issue 中提交漏洞细节、真实系统信息、凭据、需求内容或业务代码。** 请使用以下私有渠道：

- 首选：在 GitHub 仓库的 **Security** 标签页提交 [Private vulnerability report](https://github.com/chunrichi/sap-super-agent/security/advisories/new)
  （GitHub Security Advisory，仅维护者可见）；或
- 通过维护者在 GitHub 个人主页公开的联系方式，先取得私下沟通渠道。

报告时请尽量提供：

- 受影响版本/提交、部署模式（M1 本地 / M2 团队服务 / M3 SAP 宿主）与相关配置（脱敏）；
- 影响范围与复现步骤（用虚构数据，不要附带真实 SAP 系统地址、凭据或客户数据）；
- 你认为可行的修复方向（可选）。

我们会在确认后同步评估结论与修复计划；在修复版本发布前，请勿公开披露细节。修复发布后可注明报告者
（如你愿意署名）。本仓库当前**不提供**奖金/漏洞赏金计划。

## 数据与凭据边界

### 控制平面与客户端

- 控制平面与模型上下文**不持有**开发者的 SAP/SSO 凭据；ABAP 操作在开发者本地由 `abap-cli` 执行。
- VSCode 扩展把控制平面 token 存在 `SecretStorage`，不写入工作区文件；SAP 密码/SSO token 不进入控制平面。
- 服务端模型走 BYOK：模型 Key 只存服务端环境变量或 secret manager，不入库、不下发客户端、不写日志、
  不进入 prompt 回显。
- 任务文本、工件内容与仓库文件视为**不可信数据**而不是指令；写操作（`abap push`、`git push`、创建传输等）
  必须由开发者确认。

### M3（SAP 宿主模式）

- 企业 AI 网关 key **只在 SAP 安全存储**：`ZSA_CFG.AI_KEY_REF` 只保存引用名，SAP 以引用取 key 调网关；
  key 不进入 job payload、不回传控制平面、不写日志，**控制平面不持有**。
- prompt 与模型原始输出只在「控制平面 → SAP → 企业内网网关」路径传输；SAP 与控制平面日志不落正文。
- SAP↔控制平面使用 HMAC（`X-SA-Signature` / `X-SA-Timestamp` ±5 分钟 / `X-SA-Delivery` 幂等），
  M3 job API 复用同一规则；secret 由两边共同持有（控制平面环境变量、SAP 安全存储引用）。
- 控制平面 token 签名密钥 `auth.secret` 位于 `$SA_STATE_DIR`（首次启动生成，权限 `0600`）；
  状态目录备份必须包含它，否则已签发 token 全部失效。
- 单节点部署：一个 Node 进程 + SQLite + 本地工件目录；同一状态目录只允许一个实例（`.instance.lock`），
  不支持多副本/水平扩展。详细配置、权限、TLS、备份与轮换见
  [docs/010 §4.4](docs/010-m3-deployment.md#44-密钥与文件权限) 与 [§5](docs/010-m3-deployment.md#5-单节点部署控制平面)。

### 仓库与交付物

仓库中禁止出现：

- `.env`、`.env.*`（`.env.example` 只有占位符）、`*.pem`、`*.key` 等密钥文件；
- `.abap.json`、`.abap-cli/`、`.sap-superagent/` 状态（客户端状态中可能含系统/客户端信息）；
- 真实 SAP 系统地址、客户端号、服务账号、传输请求号与客户数据；
- `.vsix`、日志、构建产物与本地临时目录。

以上均在 `.gitignore` 内；离线校验命令（`pnpm check`、`pnpm e2e`、`pnpm sap:check`）不需要真实凭据。
SAP 侧交付（`sap/`）只连测试系统；生产写操作（传输、激活）由企业既有流程控制。

## 供应链与依赖

- 依赖通过 `pnpm-lock.yaml` 锁定，CI 使用 `pnpm install --frozen-lockfile`；运行时依赖见各包 `package.json`。
- 第三方来源与许可：`.agents/skills/abap-cli*` 源自 [chunrichi/abap-cli](https://github.com/chunrichi/abap-cli)
  （MIT），设计参考 dsh-superagent（MIT），声明见 [NOTICE](NOTICE)；本仓库主体为 Apache-2.0（[LICENSE](LICENSE)）。
- CI 只执行安装、静态检查、单测/集成与 e2e，不注入 SAP/模型/发布凭据。

## 已知缺口（如实说明）

- `1.0.0` **未进行独立第三方安全审计或渗透测试**，本文不声称存在或不存在任何特定 CVE；
  威胁模型与边界以设计文档为准。
- 自动依赖扫描/secret scanning 依赖 GitHub 仓库设置（Dependabot、secret scanning），
  当前 CI 工作流未包含这两项。
- 权限模型 v1 为粗粒度（user/admin/executor token）；SAP 页面走 SSO，但 v1 不建模 SAP 权限映射，
  生产采用前需按企业运维规范加访问控制。
- M3 Phase B 真机端到端仍 blocked（控制平面可达/HMAC/服务账号、SM36、企业 AI 网关输入缺失），
  未做真机验收；详见 [docs/010 §9.3](docs/010-m3-deployment.md#93-phase-b-人工输入清单blocked-判据)。
