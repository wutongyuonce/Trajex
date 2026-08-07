# Changelog

## [0.2.4]

### Changed

- Schema migration 只为旧数据库增加新列；已废弃的旧列保留到 rebuild 生成新数据库时再移除。
- Codex 根 thread 改为与 Pi 一致的“删除该 session 的 transcript 派生投影后全量重建”流程，避免依赖增量 upsert 推断历史重写。
- Codex 工具调用结果统一产出 `tool_result` message，让 Codex 工具结果进入统一的 messages 表和 FTS 索引；普通函数、自定义工具、工具搜索和网络搜索调用继续使用统一的工具记录模型。
- Codex session 发现改为依据 `session_meta.payload.parent_thread_id`、`forked_from_id` 及 subagent 元数据识别派生 thread；普通 child/fork/subagent 和 guardian/auto-review thread 不再进入解析与索引。
- `delete-session` 仅替换 transcript 派生数据，保留人工确认的 durable memories；Pi 与 Codex 的全量重放语义保持一致。
- 补充 Codex、Pi JSONL 结构以及 CLI/Core 的索引、投影和查询行为文档。

### Fixed

- 旧数据库启动迁移时不再删除遗留的 `messages.is_sidechain` 列。
- 修复 Codex 工具结果无法作为独立消息查询、全文搜索和详情时间线内容的问题。

## [0.2.4]

### Added

- 支持官方 Pi v3 session JSONL 的递归发现、durable leaf、`firstKeptEntryId` 和 `retainedTail` compaction 重放。
- 为查询 API 增加 `includeInactive`，可显式检索已被替代的 Pi 分支证据。
- App 详情页支持展开 inactive 分支，并保留 hidden 内容的来源级隐藏语义。

### Changed

- 将 Claude、Codex、Pi 的 canonical transcript projection marker 统一升级到 v3；检测到旧 projection 时自动执行完整 canonical rebuild。
- Pi session ID 改为由规范化 `cwd` 与 header `id` 共同确定，避免不同项目复用 session ID 时合并。
- Pi App 配置改为直接保存最终 session directory，默认路径为 `~/.pi/agent/sessions`；Trajex 不读取 provider 环境变量或 CLI 路径参数。
- 搜索和 thread 默认只返回 `visibility='visible'`，`hidden` 始终排除。
- Summary 卡片支持 Markdown 渲染，并继续通过安全清洗链过滤危险 HTML。
- 稳定 App indexer watcher 的生命周期；重新开启 auto-refresh 时立即补做一次 build，rebuild 收尾时依据最新设置恢复 watcher。

### Removed

- **BREAKING:** 从 Claude、Codex、Pi 的 canonical record、SQLite schema 和 App 查询中移除 `is_sidechain`，统一使用 `visibility` 表达 `visible`、`inactive` 和 `hidden`。
- **BREAKING:** Pi 仅支持官方 v3 session 格式，不再保留旧版本统一转换语义。

### Fixed

- 修复 Pi active branch 取最后一条物理 entry 的问题，改为按 durable leaf 解析当前分支。
- 修复 Pi compaction 后仍展示已压缩祖先消息的问题，并正确投影 retained tail 消息。
- 旧数据库启动迁移时自动删除遗留的 `messages.is_sidechain` 列。
- 修复旧数据库在 recent build marker 存在时跳过 schema migration，导致查询读取不到新列的问题。
- Settings 页面现在会显示 rebuild 失败原因，避免索引重建失败后无反馈。

## [0.2.2]

### Added

- 在独立 worker 中执行 Query/Attune 脚本，并在 30 秒后终止未完成的异步脚本。
- 为 Attune 脚本增加事务保护，超时或异常时回滚 memory 修改。
- 增加 SQLite Schema 图和索引/架构说明文档。
- 记录增量索引不推断 transcript 删除、重写和截断的设计决策。

### Changed

- 清理 renderer 中未使用的 `fmtSize`、SubagentDetail 返回逻辑、父会话计算和循环索引。
- 移除 Memory 的 `anchors` 文件引用字段，仅保留可选的 `message_start` / `message_end` 消息证据范围。
- 为 thinking 块增加边框，并收紧其内部的顶部留白、行高和段落间距。
- 将 renderer 的 Markdown 渲染改为本地 `marked`，并使用白名单 sanitizer 过滤危险 HTML 和链接协议。
- 将 Core 的 Node.js 原生模块导入统一为 ESM named imports，移除 `createRequire()` 兼容层。
- 让 `subagents()` 的 `after`/`before` 按关联 session 的 `started_at` 过滤。
- 让没有 `project` 和 `session_id` 的 `remember()` 记录保存为 `NULL` 项目。
- 清理未使用的 Codex agent nickname/role 解析函数和过时的 `tool_calls.presentation` 迁移。
- 更新摘要表说明，明确 compact 和 workflow 摘要来源。
- 补充 CLI/Core、Electron App、TypeScript 包结构和 CodeAct sandbox 文档。

### Fixed

- 校验 Electron `getSessions()` 的 `limit`，拒绝负数、小数和非法值，避免绕过 SQLite 查询数量限制或导致查询报错。
- 修复应用退出时未等待 watcher、索引 worker 和异步停止流程完成的问题。
- 修复 SubagentDetail 快速切换 agent 时旧请求覆盖新内容，并将全文展开改为 Vue 状态驱动。
- 移除 Markdown 对 CDN 版 `marked` 的运行时依赖，防止离线环境渲染失败。
- 修复 Codex `token_count` 缺少 usage 时向 SQLite 传入 `undefined`，统一规范化为 `null`。
- 修复 Query API 对负数、无限值和小数 `limit` 的边界处理。
- 修复空 `sessions: []` 过滤条件被错误忽略的问题。
- 修复 `raw()` 的非法负数 `offset`。
- 防止 `context()` / `trace()` 遇到循环 `parent_uuid` 时无限循环。
- 防止 Pi transcript 的循环 model parent chain 导致递归无限循环。

## [0.2.1]

重构记录见 [重构.md](docs/重构.md)。
