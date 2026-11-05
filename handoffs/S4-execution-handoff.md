# S4 执行交接（新 session 从这里开始）

> **读者**：接下来认领 S4（Hook 契约 + `http` 示例目标）的执行 Agent。本文件补充"从哪下手、哪些可复用、默认怎么决策、怎么验收"；验收标准以 [S4-hooks.md](S4-hooks.md) 为准，契约以 [docs/008](../docs/008-hooks.md) 为准。
> **基线**：`main`（起草时 `f0f7802`；认领前先 pull 最新）。基线门禁：`pnpm check` ✅ 402 tests、`pnpm e2e` ✅ 15/15、`pnpm build` ✅ 8/8、`pnpm sap:check` 离线绿。
> **特点**：S4 **不需要 SAP / abap-cli**，纯控制平面 + HTTP；全部测试可离线跑。

## 1. 开工（worktree 隔离）

```sh
cd /Users/lei/ai_space/sap_super_agent
git fetch origin && git switch main && git merge --ff-only origin/main
git worktree add .sap-superagent-worktrees/s4 -b feat/s4-hooks main
cd .sap-superagent-worktrees/s4
pnpm install --frozen-lockfile --store-dir /Users/lei/ai_space/sap_super_agent/.pnpm-store --offline
pnpm check   # 基线应绿（402 tests）
pnpm e2e     # 基线应绿（15/15，~4s）
```

- 全程只在这个 worktree 工作；不切分支、不动仓库根、不碰其他 worktree。
- 完成后分支保留给 Lead/用户集成：不 push、不直推 `main`、不 force push。
- 同一时刻一个 Agent 只做一个任务；在 `handoffs/STATUS.md` 认领 S4 行（填 owner/分支/写范围）。

## 2. 可直接复用的接口（不要重写）

| 模块 | 位置 | 用途 |
| --- | --- | --- |
| 事件日志 / 事务 | `packages/server/src/db/transaction.ts`（`writeTransaction`）、`db/events.ts`、`http/route-utils.ts#publish` | 写事件 + WS 广播；Hook 的 attempted/delivered/dead/receipt 必须走这里 |
| outbox 表与消费范式 | `packages/server/src/db/migrations.ts`（outbox v1/v4）、`hooks/sap-store.ts`（outbox helpers）、`workers/sap-writeback.ts` | 参考退避/死信/重放写法；**S4 写独立 worker，不改 SAP worker** |
| HMAC 验签规则 | `packages/sap-adapter/src/signature.ts` | `X-SA-Signature: sha256=<hex>` / `X-SA-Timestamp` ±5min / `X-SA-Delivery`；通用 Hook 在 server 内按同规则实现（不要 import sap-adapter） |
| 路由装配 | `packages/server/src/http/app.ts` | `// --- S4: ... ---` 追加 `registerHookRoutes` |
| 服务装配 | `packages/server/src/server.ts`、`types.ts`、`config.ts` | 追加 Hook 配置解析 + worker 启停；缺失配置 = 全禁用 |
| 协议/契约 | `packages/protocol/src/{enums,events,requests,schemas}.ts`、`scripts/contract-gen.mjs` | 新增 schema/事件/路由；改完 `pnpm contract:gen` 提交 `contracts/` diff |
| 测试设施 | `packages/server/test/helpers.ts`、`packages/testkit/src/http.ts`（`apiRequest`/`waitFor`）、`fake-icf-server.ts`（HTTP fake 参考） | 集成测试 + `FakeHookTarget` + e2e；e2e 进程内、总时长 `<5s` |
| 门禁脚本 | `scripts/e2e.mjs`、`scripts/sap-check.mjs`（离线脚本范式） | 新 `scripts/hooks-reconcile.mjs` 参考其输出/退出码风格 |
| 现有 Hook 特例 | `packages/server/src/hooks/sap.ts`、`hooks/sap-store.ts`、`hooks/sap-config.ts` | SAP 入站/回写保持现状；**不要重构**，只可复用规则 |

## 3. 建议顺序（每步保持 `pnpm check` 绿）

1. **契约冻结**：docs/003（事件类型/3 个端点）+ docs/008 定稿 + protocol schema + `pnpm contract:gen` + `examples/hooks.yaml` 骨架。→ 立即回报 commit hash。
2. **配置加载 + 触发**：`SA_HOOKS_CONFIG` YAML 解析/校验；订阅事件 → 写 outbox 行（target=`hook:<id>`）；信封/幂等键生成；测试。
3. **投递 worker（http）**：HMAC 头、2xx/4xx/5xx/429/timeout 语义、退避/死信、`hook.attempted/delivered/dead` 事件；集成测试。
4. **管理 API**：`GET /hooks`（队列深度/lastError）、`POST /hooks/{id}/replay`（幂等）。
5. **入站回执**：`POST /hooks/{target}/receipt`，迁移 v6 `hook_receipts`，验签/时间窗/重复幂等/未知 id；写 `hook.receipt`。
6. **对账**：`scripts/hooks-reconcile.mjs` + root `hooks:reconcile`。
7. **占位适配器**：`examples/hooks/{jira,charm,confluence,teams}.yaml` + 简短 README（只配置样例/字段映射，不写业务代码）。
8. **测试与文档收尾**：`FakeHookTarget`、e2e、009 #11/#12 断言、docs/003/008/007、README、STATUS；最终跑 `pnpm check` / `pnpm e2e` / `pnpm build` / `pnpm hooks:reconcile`。

## 4. 决策默认值（不再询问，除非与 docs 冲突）

| 事项 | 默认 |
| --- | --- |
| 配置文件 | `SA_HOOKS_CONFIG` 或默认 `examples/hooks.yaml`；文件缺失/全 disabled = 不影响 H0–S3 |
| 入站签名头 | 沿用 `X-SA-Signature` / `X-SA-Timestamp` / `X-SA-Delivery`（与 SAP 一致，docs/008 写明） |
| 出站事件类型 | 新增 `hook.attempted`/`hook.delivered`/`hook.dead`/`hook.receipt`/`hook.cancelled` + subject type `hook`（docs/003 §4.4） |
| outbox 复用 | 复用 `outbox` 表，`target='hook:<id>'`；S4 自有 delivery worker，不碰 `target='sap.writeback'` |
| 迁移 | 从 **v6** 起，只追加；`hook_receipts` 用于回执幂等/审计 |
| 回执推进阶段 | 默认只记录 links/事件；`advanceOnReceipt` 默认 false，若实现先补 docs/003 并复用 H1 `stage-engine` |
| 重试参数 | 2s 起指数退避、上限 5min、最多 5 次；429 尊重 `Retry-After`；4xx 死信（docs/008 §5） |
| replay 语义 | 按 eventId 重放原信封，`idempotencyKey` 不变；重复 replay 幂等 |
| 对账 | 只报告不修复；有差异默认退出码 0，`--fail-on-diff` 时 3；无 `reconcileUrl` 时输出本地口径并说明 |
| 依赖 | 不新增外部依赖（YAML 用已有 `yaml`，HTTP 用 Node `fetch`） |
| 客户端/MCP/通知 | 不做 |

## 5. 环境与常见坑

- **端口 3080 被 DSH Web GUI 占用**：测试用端口 0 / 随机端口；手工冒烟用 `SA_HTTP_PORT` 或 `--port`。
- `.env` 会真正加载（真实环境变量优先）；控制平面同一 state dir 只允许一个实例（文件锁）。
- TypeScript 严格模式：`exactOptionalPropertyTypes`、`noUncheckedIndexedAccess`、NodeNext（相对导入写 `.js`、`import type`）；**不要关严格性**。
- 测试不依赖 build：workspace 包通过 `tsconfig.base.json` paths + `scripts/vitest-aliases.mjs` 指源码；`stress`/`build` 走 dist。
- 改 protocol 后必须 `pnpm contract:gen` 并提交 `contracts/` diff（CI 里是 `--check`）。
- 迁移只追加：不要改 v1–v5；共享文件追加式 + `// --- S4: ... ---` 标记，便于合并。
- e2e 保持快：进程内 fake HTTP 目标，不起外部进程、不依赖网络；总时长 `<5s`（基线 ~3.9s）。
- **不需要 SAP/abap-cli**；不要执行 `abap *` 命令、不要提交 `.abap.json`/`.abap-cli/`。

## 6. 直接复制给新 session 的启动 Prompt

> 你在 `/Users/lei/ai_space/sap_super_agent` 工作。这是一个新 session，负责执行 **S4（Hook 契约与 `http` 示例目标）**。
>
> **第一步（worktree 隔离）**：
> 1. `cd /Users/lei/ai_space/sap_super_agent && git fetch origin && git switch main && git merge --ff-only origin/main`
> 2. `git worktree add .sap-superagent-worktrees/s4 -b feat/s4-hooks main`
> 3. 立即 `working_directory({cd: "/Users/lei/ai_space/sap_super_agent/.sap-superagent-worktrees/s4"})`，之后所有文件/命令都在该 worktree 内；不要切换分支、不动仓库根、不碰其他 worktree。
> 4. `pnpm install --frozen-lockfile --store-dir /Users/lei/ai_space/sap_super_agent/.pnpm-store --offline`，然后跑基线 `pnpm check`（应绿，约 402 tests）与 `pnpm e2e`（应绿，15/15）。若基线不是绿，先停下报告，不要继续。
>
> **然后读**：`HANDOFF.md`、`handoffs/STATUS.md`、`handoffs/S4-hooks.md`（任务书 = 验收标准）、`handoffs/S4-execution-handoff.md`（本文件）、`docs/008-hooks.md` 全文、`docs/003` §4.4/§4.5、`docs/009` #11/#12、`docs/006`、`AGENTS.md`。
>
> **认领**：在 `handoffs/STATUS.md` 的 S4 行填 owner、分支 `feat/s4-hooks`、写范围（任务书 §4）。
>
> **执行要求**：
> - 契约先行：先改 `docs/003` + `packages/protocol` + `pnpm contract:gen`（提交 contracts diff），再实现代码；第一个里程碑（契约）完成后立即向用户/Lead 报 commit hash。
> - 按任务书 §1.1–§1.8 顺序推进，每完成一个子项提交（Conventional Commits + `git commit -s`，一件一提交）并更新 STATUS 的 S4 行 + 交接日志（只改自己的行）。
> - 只改任务书写范围；迁移从 v6 起只追加；共享文件（`app.ts`/`types.ts`/`config.ts`/`server.ts`/`migrations.ts`）用 `// --- S4: ... ---` 追加块；**不改** SAP `/hooks/sap` 行为、不改 H0–S3 语义、不新增依赖。
> - 按本文件 §4 的默认值决策；遇到与 docs/008 冲突或跨包契约变更，先改 docs 再实现并在报告标注。
> - 最终自测：`pnpm check`、`pnpm e2e`（总时长 <5s）、`pnpm build`、`pnpm hooks:reconcile`；用 e2e/集成复现任务书 §2 五条手工冒烟并记录实际输出。
> - 不 push、不直推 `main`、不 force push；不提交密钥/地址/`.env`。
>
> **完成时报告**：完成项、提交列表、`pnpm check`/`pnpm e2e`/`pnpm build`/`pnpm hooks:reconcile` 输出摘要、投递/重试/死信/重放/回执证据、与 docs/008 的偏差、遗留。完成后分支交由 Lead/用户评审与 PR。

## 7. 完成定义（DoD）

1. `handoffs/S4-hooks.md` §1 交付物全部存在，§2 验收命令全部通过（含手工冒烟以集成/e2e 复现并记录）；
2. `contracts/` 快照与协议一致（`pnpm contract:gen` diff 已提交）；
3. docs/008、docs/003 与实现一致；README 快速开始可照做；
4. `handoffs/STATUS.md` 更新；报告已发出；
5. 未越过写范围、未改 SAP 路径行为、未提交禁物、未 push/直推 main。
