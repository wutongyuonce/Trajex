# Changelog

## [Unreleased]

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
