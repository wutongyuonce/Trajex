# Trajex 架构总览

> 适用于 Trajex 0.4.0。细节契约以 [ADR](adr/README.md) 和测试为准；本文只负责让人快速找到位置。

Trajex 把本机编码 Agent（Claude Code、Codex、Pi、DeepSeek Harness）的会话历史解析成统一记录，写进一个本地 SQLite（`~/.trajex/trajex.sqlite`），再通过 CLI、查询 API 和桌面 App 检索。它只读来源文件，从不修改 Agent 自己的历史。

## 1. 分层

```text
来源文件（~/.claude、~/.codex、Pi、DSH）
        │  discover / parse（纯函数，不碰数据库）
        ▼
packages/core/src/providers/*      ← 每个 Agent 一个 Provider adapter
        │  TranscriptRecord 流
        ▼
provider-indexing.ts → persist.ts → index-finalize.ts   ← 调度、写库、收尾（FTS、project_path）
        │
        ▼
SQLite（schema.sql）  ──►  query.ts（search / messages / sessions / failures …）
        ▲                        ▲
   App daemon 写入           CLI（trajex）与 App 读取
```

| 位置 | 职责 |
| --- | --- |
| `packages/core/src/providers/` | `types.ts` 定义 Provider 契约与记录类型；`registry.ts`/`builtins.ts` 组装四个内建 Provider；`claude.ts`、`codex.ts`、`pi.ts`、`deepseek.ts` 各自负责发现与解析；`file-snapshot.ts` 是共享的文件快照与 cursor 规则 |
| `packages/core/src/parsing.ts` | Provider 共用的纯函数：按行读文件、截断、时间戳规范化、项目路径推断 |
| `packages/core/src/vendor/dsh-zstd.ts` | DeepSeek Harness 多帧 Zstandard 日志的只读帧扫描 |
| `packages/core/src/provider-indexing.ts`、`index-build.ts` | 为一次构建生成计划，逐单元事务执行或标记缺失，调用收尾与快照（CLI 与 App 共用） |
| `packages/core/src/sources.ts`、`snapshots.ts`、`sync.ts` | 来源清单（`sources` 表）、显式清理（purge）、`VACUUM INTO` 快照/恢复与多端文件夹分片同步（ADR-0014） |
| `packages/core/src/persist.ts` | 按来源声明（`source` 记录）归属每一行、原地替换或增量合并、补占位会话 |
| `packages/core/src/index-finalize.ts` | 收尾：FTS 就绪、project_path 推断、workflow 关联修复 |
| `packages/core/src/indexer.ts` | CLI 侧构建入口：写入所有权检查、只读探测、强制重建 |
| `packages/core/src/query.ts`、`session-detail.ts` | 查询 API 与会话详情组装 |
| `packages/core/src/tx.ts`、`writer-lease.ts`、`write-coordinator.ts` | 写事务重试与写入者租约 |
| `packages/core/src/sandbox-worker.ts` | `--query` / `--attune` 脚本的执行 worker（`node:vm`，不是安全隔离） |
| `packages/cli/src/trajex.ts` | `trajex --build / --search / --query / --attune / --version` |
| `packages/adaptive-watcher/` | 目录树 + 精确文件的监听与有界轮询 |
| `app/src/main/` | Electron 主进程：数据库连接、IPC、设置、索引 daemon（`indexer-service.ts` 调度，`indexer-worker.ts` 在 worker 线程里调用 `indexer.ts`） |
| `app/src/preload/` | 暴露给页面的 `window.trajex` API（只走 IPC） |
| `app/src/renderer/` | Vue 页面：会话列表、详情时间线、Activity、记忆、设置 |
| `trajex-skill/` | 给 Agent 使用的查询说明（不随 CLI 打包，见 ADR-0009） |

## 2. 一次索引怎么跑

1. **发现**：每个 Provider 的 `discover()` 根据存储的 cursor、watcher 给出的变化路径和 `sources` 中的已知来源，返回需要处理的 `IndexUnit`（含文件消失时的 `missing: true` 单元）。
2. **解析**：`parse(unit, cursor)` 只读来源文件，先产出 `source` 记录声明归属，再产出数据记录与新 cursor。Claude 主会话按行增量续读；Codex、Pi、DeepSeek 每次全量重放（ADR-0002）。
3. **写库**：每个单元在一个事务里由 `persist()` 写入，project_path 与 cursor 一起提交；失败只影响该单元，下次重试（ADR-0003）。
4. **收尾**：刷新 FTS、写 `__last_build__` 与 Provider 版本 marker，并在需要时拍快照（ADR-0014）。

保留与清理规则（ADR-0004、ADR-0014）：索引是**档案**而非镜像。来源根目录可读、而某个已知文件不在了，只把该来源标记为 `missing`，消息与会话原样保留（`sessions.source_status` 变为 `partial` 或 `missing`）；根目录不存在或读不了时不改状态。文件在同一 Provider 内移动或压缩（例如 Codex 归档或 `.jsonl.zst`）只更新路径。只有 App 设置页里的显式清理（Purge）才会删除 `missing` 来源及其行。

## 3. 谁负责写库

- **App 在运行时**是唯一常驻写入者：监听来源变化，有界调度增量构建，每 5 分钟做一次完整清点（ADR-0011），写 `__app_heartbeat__`，并按设置每天自动拍一份 `VACUUM INTO` 快照（默认保留 3 份）。
- **CLI** 不起守护进程。每个命令先看 App 心跳：App 活跃（60 秒内有心跳）时只读不写；否则拿写入者租约做一次增量刷新再执行命令。30 秒内刚构建过会跳过。
- **重建（`trajex --build` / App「Rebuild index」）** 是安全操作：以空 cursor 重放当前仍存在的来源，已缺失来源的历史与 `memories` 原样保留，开始前自动拍一份 `pre-rebuild` 快照。
- **清理与恢复** 只在 App 设置页提供，执行前都会自动拍快照；恢复后保留当前 `memories` 并增量追平本地会话。
- **记忆（memories）**只由人确认后写入，`--attune` 用短事务并发写，不拿写入者租约。

## 4. 改需求从哪里下手

| 需求 | 先看 |
| --- | --- |
| 某个 Agent 的消息解析不对 | 对应 `providers/<agent>.ts` + `docs/formats/<agent>-jsonl.md` + `tests/<agent>-parse.test.mjs` |
| 新增一个 Agent 来源 | `providers/types.ts` 契约、`builtins.ts` 注册、ADR-0002/0004；参考 `deepseek.ts` 与 ADR-0013 |
| 查询结果或参数 | `query.ts` + `trajex-skill/references/api-reference.md` + `tests/query.test.mjs` |
| 表结构 | `schema.sql` + `schema-migrations.ts`；`tests/provider-schema-stability.test.mjs` 固定了 schema 哈希 |
| 桌面页面 | `app/src/renderer/src/views/*.vue`，数据经 `data.js` → `window.trajex` → `app/src/main/index.ts` 的 IPC，文案统一走 `i18n.js` |
| 实时刷新、监听 | `app/src/main/indexer-service.ts`、`packages/adaptive-watcher/`、ADR-0011 |

## 5. 桌面端 UI 视觉对齐与多语言规范

- **双列设置网格（`.form-row`）：** 左列固定 `180px`，右列 `minmax(0, 1fr)`，间距 `24px`。左列主标题（`line-height: 20px; padding-top: 4px`）与右列首行 `28px` 控件共享同一水平基线；右列所有控件行必须从右列左边缘（`x = 0`）平齐起排，禁止在输入框左侧散放内联文字导致上下两行输入框左边缘错位。
- **操作栏对齐（`.control-bar`）：** 凡「输入框/下拉框 + 操作按钮」组合统一采用 `grid-template-columns: minmax(0, 1fr) auto; gap: 8px;`，输入框/下拉框与按钮高度统一为 `28px`，右侧主操作按钮统一 `min-width: 112px` 居中对齐，确保上下相邻行的输入框左右边缘与按钮左右边缘完全共线。
- **会话列表行（`.srow`）：** 固定统一行高 `60px`，内容垂直居中（`align-items: center`）；左侧年龄/来源色条（`.srow-trajex`）垂直居中嵌入在标题与元信息左侧（`top: 50%; transform: translateY(-50%)`），不占用独立行。
- **中英双语（`app/src/renderer/src/i18n.js`）：** 侧边栏顶部品牌区与设置页均提供一键中/英切换，所有视图、工具栏、空状态与提示文案均通过 `t()` 响应式渲染并持久化到 `localStorage('trajex:locale')`。

## 6. 验证

```bash
npm test            # 全部单元与集成测试（会先构建 CLI）
npm run lint
npm run typecheck   # Core/CLI 与 App 两套 tsconfig
npm --prefix app run dist:mac   # 打包 macOS App
```
