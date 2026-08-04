# Changelog

## [Unreleased]

### Added

- 在独立 worker 中执行 Query/Attune 脚本，并在 30 秒后终止未完成的异步脚本。
- 为 Attune 脚本增加事务保护，超时或异常时回滚 memory 修改。
- 增加 SQLite Schema 图和索引/架构说明文档。
- 记录增量索引不推断 transcript 删除、重写和截断的设计决策。

### Changed

- 让 `subagents()` 的 `after`/`before` 按关联 session 的 `started_at` 过滤。
- 让没有 `project` 和 `session_id` 的 `remember()` 记录保存为 `NULL` 项目。
- 清理未使用的 Codex agent nickname/role 解析函数和过时的 `tool_calls.presentation` 迁移。
- 更新摘要表说明，明确 compact 和 workflow 摘要来源。
- 补充 CLI/Core、Electron App、TypeScript 包结构和 CodeAct sandbox 文档。

### Fixed

- 修复 Query API 对负数、无限值和小数 `limit` 的边界处理。
- 修复空 `sessions: []` 过滤条件被错误忽略的问题。
- 修复 `raw()` 的非法负数 `offset`。
- 防止 `context()` / `trace()` 遇到循环 `parent_uuid` 时无限循环。
- 防止 Pi transcript 的循环 model parent chain 导致递归无限循环。

## [0.2.1]

重构记录见 [重构.md](docs/重构.md)。
