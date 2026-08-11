# Changelog

## [Unreleased]

### Added

- 支持通过 `PI_CODING_AGENT_SESSION_DIR` 与 `TRAJEX_DIR` 为 CLI/Core 指定隔离的 Pi 会话根和索引目录，便于评测或临时任务避免触碰默认用户数据。

## [0.2.5] - 2026-08-11

### Added

- 增加孤立 tool result 的时间线组装回归测试，确保空壳 result 不会打断相邻 assistant 消息与 tool call 的合并。
- 为 Provider 增加已索引 session 清单、结构化来源根诊断与显式撤回能力：当权威 inventory 确认某个旧 transcript 已删除，Claude、Codex、Pi 会生成清理单元，删除对应的 transcript 派生投影。
- 增加来源根可靠性边界：Claude 的 `projects`、Codex 的 `sessions` 或 Pi 的配置 session 根暂时不存在/不可读时保留上一次索引快照；根层可枚举后，缺失或不可读的后代目录按空子树参与删除 reconciliation。
- 为 CLI/Core 与 App force rebuild 增加清理前 Provider 根预检；App 临时库 rebuild 会从当前数据库读取 Provider provenance，来源根不可用时保留旧数据库。
- 补充 Provider 解析、删除对账与共享 persist 事务的 ADR、项目解析说明和 README 文档。

### Changed

- 统一 Claude、Codex 与 Pi 的工具结果投影：`messages.text` 只保留最多 1,000 字符的首尾预览，`tool_results.content` 保留最多 10,000 字符的首尾内容，并通过 v4 canonical marker 自动重建旧投影。
- 统一 persist 的撤回语义：`retractSessionIds` 在消费 record generator 前清理旧 session 投影，保留 `memories`；空 tombstone unit 只负责触发该清理。
- Claude 继续按 cursor 增量读取，遇到 cursor 之后的损坏 JSONL 行时提交此前的有效前缀，并把 cursor 停在损坏行之前；Codex、Pi 对变更文件全量重放，但同样只提交损坏行之前的有效前缀。
- Claude 在检测到文件被重写/截断、旧 cursor 超过当前文件长度时回退到文件开头重新解析，避免把新文件误当作已消费内容。
- 重新按项目架构重排 ADR：ADR-0002 负责 Provider parse，ADR-0003 负责统一 persist/事务，ADR-0004 负责来源清单与删除判断；运行时契约与构建发布 ADR 顺延到最后。
- 查询、原文读取和 attune 在业务访问前独立确认 SQLite schema 可读；最近构建标记只控制 Provider 数据扫描，不再跳过必要的安全加列迁移。

### Fixed

- 修复 App 启动时来源根暂时不可用后不再自动恢复索引的问题：不完整 inventory 会指数退避全量重试，目录恢复后补建 watcher，最长重试间隔 10 分钟。
- 修复 `subagents()` 的时间筛选：`after` / `before` 现在按子代理自身的首末消息活动区间判断，不再使用所属 session 的开始时间。
- 修复同一路径被新 session ID 替换时旧派生数据残留的问题。
- 修复“目录暂时消失”被误判为“全部 transcript 已删除”、从而清空历史索引的问题。
- 重新开启 auto-refresh 时立即启动增量 build，不再等待文件事件的防抖窗口；快速切换时以最后一次设置为准。
- 手动 rebuild 遇到 writer/database busy 时保留旧数据库，并在 Settings 显示原因；单文件失败继续遵循 best-effort 语义。
- 修复 schema 升级被活跃 daemon 或其他 writer 阻塞时继续执行新版 SQL、最终暴露 `no such column` 的问题；CLI 与 App 现在返回明确的 `daemon_active` / `writer_busy` 诊断。

## [0.2.4]

### Changed

- 统一普通 agent 与 workflow agent 详情页的消息渲染，复用主 session 时间线组件；thinking、summary、meta、tool call、workflow agent 和展开状态保持一致。
- Schema migration 只为旧数据库增加新列；已废弃的旧列保留到 rebuild 生成新数据库时再移除。
- Codex 根 thread 改为与 Pi 一致的“删除该 session 的 transcript 派生投影后全量重建”流程，避免依赖增量 upsert 推断历史重写。
- Codex 工具调用结果统一产出 `tool_result` message，让 Codex 工具结果进入统一的 messages 表和 FTS 索引；普通函数、自定义工具、工具搜索和网络搜索调用继续使用统一的工具记录模型。
- Codex session 发现改为依据 `session_meta.payload.parent_thread_id`、`forked_from_id` 及 subagent 元数据识别派生 thread；普通 child/fork/subagent 和 guardian/auto-review thread 不再进入解析与索引。
- `delete-session` 仅替换 transcript 派生数据，保留人工确认的 durable memories；Pi 与 Codex 的全量重放语义保持一致。
- 补充 Codex、Pi JSONL 结构以及 CLI/Core 的索引、投影和查询行为文档。

### Fixed

- 旧数据库启动迁移时不再删除遗留的 `messages.is_sidechain` 列。
- 修复 Codex 工具结果无法作为独立消息查询、全文搜索和详情时间线内容的问题。

## [0.2.3]

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
