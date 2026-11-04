# 安全策略

## 报告问题

不要在公开 Issue 中提交真实系统信息、凭据、需求内容或代码。请通过仓库维护者的私有渠道报告，并说明影响范围与复现步骤。

## 数据与凭据边界

- 控制平面与模型上下文**不持有**开发者的 SAP/SSO 凭据；ABAP 操作在开发者本地由 `abap-cli` 执行。
- 服务端模型走 BYOK：Key 只存服务端环境变量/secret manager，不入库、不下发客户端、不写日志。
- 仓库中禁止出现 `.env`、`.abap.json`、`.sap-superagent/` 状态、SAP 系统地址与传输请求号。
- SAP 侧接口只连测试系统；生产写操作（传输、激活）由企业流程控制。

## 支持范围

设计阶段：安全模型与威胁边界见 [docs/002-architecture.md](docs/002-architecture.md) §7、[docs/005-clients-and-ai.md](docs/005-clients-and-ai.md) §2.5。
