# Trajex 架构总览

> 适用于 Trajex 0.3.0。细节契约以 [ADR](adr/README.md) 和测试为准；本文只负责让人快速找到位置。

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
| `packages/core/src/provider-indexing.ts` | 为一次构建生成计划（哪些单元要解析、哪些要撤回），逐单元事务执行，写版本 marker |
| `packages/core/src/persist.ts` | 把记录流写进各表；`delete-session` 与 `retractSessionIds` 负责撤回 |
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

1. **发现**：每个 Provider 的 `discover()` 根据存储的 cursor、watcher 给出的变化路径和已索引会话清单，返回需要处理的 `IndexUnit`（含删除用的 tombstone）。
2. **解析**：`parse(unit, cursor)` 只读来源文件，产出 `TranscriptRecord` 流和新 cursor。Claude 主会话按行增量续读；Codex、Pi、DeepSeek 每次全量重放（ADR-0002）。
3. **写库**：每个单元在一个事务里由 `persist()` 写入，cursor 一起提交；失败只影响该单元，下次重试（ADR-0003）。
4. **收尾**：刷新 FTS、补 project_path、写 `__last_build__` 与 Provider 版本 marker。marker 变化会让该 Provider 一次性全量重放（ADR-0001/0002）。

删除规则（ADR-0004）：来源根目录可读、而某个已索引文件不在了，才撤回对应会话；根目录不存在或读不了时保留上一次快照。文件在同一 Provider 的根目录之间移动（例如 Codex 归档）只会换路径，不会删除。

## 3. 谁负责写库

- **App 在运行时**是唯一常驻写入者：监听来源变化，有界调度增量构建，每 5 分钟做一次完整清点（ADR-0011），并写 `__app_heartbeat__`。
- **CLI** 不起守护进程。每个命令先看 App 心跳：App 活跃（60 秒内有心跳）时只读不写；否则拿写入者租约做一次增量刷新再执行命令。30 秒内刚构建过会跳过。
- **`trajex --build`** 是强制重建：清空派生表后从来源重新建立，来源已经删除的会话不会回来；App 活跃时同样跳过，交给 App。App 设置页的「重建索引」在临时库里重建再替换，保留 `memories`。
- **记忆（memories）**只由人确认后写入，`--attune` 用短事务并发写，不拿写入者租约。

## 4. 改需求从哪里下手

| 需求 | 先看 |
| --- | --- |
| 某个 Agent 的消息解析不对 | 对应 `providers/<agent>.ts` + `docs/formats/<agent>-jsonl.md` + `tests/<agent>-parse.test.mjs` |
| 新增一个 Agent 来源 | `providers/types.ts` 契约、`builtins.ts` 注册、ADR-0002/0004；参考 `deepseek.ts` 与 ADR-0013 |
| 查询结果或参数 | `query.ts` + `trajex-skill/references/api-reference.md` + `tests/query.test.mjs` |
| 表结构 | `schema.sql` + `schema-migrations.ts`；`tests/provider-schema-stability.test.mjs` 固定了 schema 哈希 |
| 桌面页面 | `app/src/renderer/src/views/*.vue`，数据经 `data.js` → `window.trajex` → `app/src/main/index.ts` 的 IPC |
| 实时刷新、监听 | `app/src/main/indexer-service.ts`、`packages/adaptive-watcher/`、ADR-0011 |

## 5. 验证

```bash
npm test            # 全部单元与集成测试（会先构建 CLI）
npm run lint
npm run typecheck   # Core/CLI 与 App 两套 tsconfig
npm --prefix app run dist:mac   # 打包 macOS App
```
