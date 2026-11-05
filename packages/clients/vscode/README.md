# SAP Super Agent · VSCode 扩展

任务客户端 + 本地能力宿主（docs/005 §2）：在 VSCode 里领取控制平面下发的开发任务、打开上下文包、上报进度/工件，并在「等待我回答」里处理审批门禁。扩展**不接管 Copilot Chat 会话**；它只负责把任务、上下文和门禁递到开发者手边。

- 扩展 ID：`sap-superagent.sap-superagent-vscode`
- 最低 VSCode：`^1.90.0`
- 运行时零外部依赖：发布物是 esbuild 打出的单文件 `dist/extension.cjs`（`vscode` 由宿主注入）

## 安装

### 方式 A：安装 VSIX（发布/内网分发）

从 GitHub Release 下载 `sap-superagent-vscode-<version>.vsix`，或本地打包：

```sh
pnpm package:vsix      # 产物：tmp/vsix/sap-superagent-vscode-1.0.0.vsix
```

安装（`code` 是 VSCode 自带 CLI）：

```sh
code --install-extension tmp/vsix/sap-superagent-vscode-1.0.0.vsix
```

也可以在 VSCode 命令面板运行 **Extensions: Install from VSIX…** 选择文件。

> 本仓库开发环境若全局导出了 `ELECTRON_RUN_AS_NODE=1`，`code` CLI 会退化成 Node 而报错；此时用
> `env -u ELECTRON_RUN_AS_NODE code --install-extension …`。

### 方式 B：源码开发（F5）

```sh
pnpm --filter sap-superagent-vscode run build   # esbuild 单文件 bundle → dist/extension.cjs
```

用 VSCode 打开本仓库根目录，按 **F5** 或 Run and Debug → **Run Extension**（`.vscode/launch.json` 已配好；`preLaunchTask` 会先跑上面的 build）。

## 连接控制平面

1. 启动本地控制平面（默认 `http://127.0.0.1:3080`）：

   ```sh
   pnpm dev            # 或：pnpm cli dev --port <port> --state-dir <dir>
   ```

   启动日志会打印 `user` / `admin` token。
2. 命令面板 → **SAP Super Agent: 连接控制平面**，填控制平面地址 + user token。token 存进 VSCode `SecretStorage`，不会写入工作区文件。
3. 自动化/冒烟场景可用环境变量 `SAP_SUPERAGENT_TOKEN` 提供 token（优先于 SecretStorage）；`controlPlaneUrl` 也可在设置里预置。

相关设置（`settings.json`）：

```jsonc
{
  "sapSuperAgent.controlPlaneUrl": "http://127.0.0.1:3080",
  "sapSuperAgent.accepting": true
}
```

## 使用

命令面板（命令控制在 6 个以内）：

| 命令 | 作用 |
| --- | --- |
| `SAP Super Agent: 连接控制平面` | 填地址 + token，注册执行器并开始心跳/订阅事件 |
| `SAP Super Agent: 绑定当前工作区` | 写 `.sap-superagent/workspace.json`（`repo` / `projectKey` / `baseBranch` / `prepare`） |
| `SAP Super Agent: 领取任务` | 领取可领取任务（已绑定任务要求工作区匹配） |
| `SAP Super Agent: 打开任务` | 生成 `.sap-superagent/task/<taskId>/context.md`（+ `context.json`）并打开 |
| `SAP Super Agent: 提交工件` | 提交 `code_change` 等工件并确认是否完成任务 |
| `SAP Super Agent: 暂停/恢复接单` | 在线但不再领取新任务 |

Activity Bar 的 **任务箱**分三组：`可领取` / `我的任务` / `等待我回答`。第三组里的门禁行点开即可 **通过/驳回**（带意见），未读通知行可标记已读；WS 推送会实时刷新，不等 30s 轮询。

上下文包目录 `.sap-superagent/task/` 不入库（git 忽略），只留在本地，供任何 chat/agent 通过 `#file` 引用。

## 开发与自测

```sh
pnpm --filter sap-superagent-vscode run typecheck   # tsc --noEmit
pnpm --filter sap-superagent-vscode run test        # vitest
pnpm --filter sap-superagent-vscode run check       # typecheck + test
pnpm --filter sap-superagent-vscode run build       # esbuild 单文件 bundle
```

### 真实 Extension Host 冒烟（发布 gate）

```sh
pnpm vscode:smoke
```

脚本自动完成：起真实本地控制平面（临时 state dir + 空闲端口，绝不占用 3080）→ 建需求/任务/待审批 → 用真实 VSCode 二进制启动 Extension Host（临时 user-data/extensions 目录 + 临时工作区）→ 驱动真实命令（任务箱领取、上下文包、审批动作）→ 通过 HTTP/文件系统断言并清理，成功输出 `[vscode-smoke] PASS` 与证据行。

前置条件：本机装有桌面版 VSCode（CI 不跑）。macOS 默认路径 `/Applications/Visual Studio Code.app/Contents/MacOS/Code`；其他平台或自定义安装用：

```sh
SAP_SUPERAGENT_VSCODE_BIN=/path/to/Code pnpm vscode:smoke
# 保留临时目录（日志/状态库/工作区）便于排查：
SAP_SUPERAGENT_SMOKE_KEEP=1 pnpm vscode:smoke
```

## 打包发布物

```sh
pnpm package:vsix
```

- esbuild 把 `src/extension.ts` 打成单文件 `dist/extension.cjs`（`vscode` external，`@sap-superagent/protocol` 与 `ws` 内联）；
- 只把运行时必要文件放进 VSIX：`package.json`、`README.md`、`LICENSE`、`dist/extension.cjs`；`src/`、`test/`、`node_modules/`、`tsconfig*`、`*.map` 一律不进包；
- 版本号来自 `packages/clients/vscode/package.json`（当前 `1.0.0`），产物在 `tmp/vsix/`（git 忽略）。

## 故障排查

| 现象 | 处理 |
| --- | --- |
| 状态栏一直离线 / 提示 401、403 | token 无效或过期：重新连接控制平面；若用 `SAP_SUPERAGENT_TOKEN`，请在启动 VSCode 的环境里更新 |
| 已绑定任务在任务箱里看不到 | 打开的工作区目录与 `.sap-superagent/workspace.json` 的 `repo`/`projectKey`/`baseBranch` 不一致，或扩展尚未注册完成（等状态栏变「在线」） |
| `pnpm dev` 起不来（端口占用） | 3080 可能被其它本地服务占用：`pnpm cli dev --port 38080`，并在扩展设置里同步 `controlPlaneUrl` |
| `code` 命令行为像 Node | shell 里取消了 `ELECTRON_RUN_AS_NODE`（见上文安装说明） |
| F5 启动的是旧代码 | F5 前先 `pnpm --filter sap-superagent-vscode run build`（launch 的 `preLaunchTask` 通常已自动执行） |
