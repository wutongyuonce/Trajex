以下是 `trajex-skill/references/` 下每个文件的作用：

| 文件                         | 内容/用途                                                    |
| ---------------------------- | ------------------------------------------------------------ |
| **`api-reference.md`**       | Helper API 的完整参考手册。定义 `--query` 脚本中可用的所有函数签名、参数选项、返回形状：`search()`、`context()`、`sql()`、`overview()`、`sessions()`、`memories()`、`trace()`、`thread()`、`raw()`、`workflowTree()`、`fileHistory()`、`failures()`，以及 `--attune` 中的 `remember()`、`forget()`。按 ADR-0007，此文件是**权威合约**，返回形状被 contract tests 锁住。 |
| **`pitfalls.md`**            | 错误排查清单。覆盖 FTS5 语法错误（`-`、标点符号误解析）、缺少列/别名猜错、运行时 JSON 过大、空结果处理、SQL 侧计数 vs 肉眼计数。出错了先读这里。 |
| **`query-patterns.md`**      | 可复用的 `trajex --query` 脚本模板。用于广泛综合、进度总结、设计历史、周/月回顾等场景。提供 first-pass 模式（overview + memories + search）、faceted detail pass、memory mutation 脚本。不是新 API，是现有 helper 的编排模式。 |
| **`retrieval-semantics.md`** | 查询设计框架。定义四条原则：Scope First（分类用户请求后再选工具）、Plan Before Probe（综合类任务优先写脚本而非交互式探针）、Structure Before Text（先利用数据库结构，再让模型读文本）、Evidence Before Conclusion（返回证据后再综合结论）。写非简单查询前先读。 |
| **`schema.md`**              | SQLite schema 快速参考。列出每个表（`sessions`、`messages`、`tool_calls`、`tool_results`、`summaries`、`subagents`、`workflows`、`workflow_agents`、`memories`、`index_state`、FTS 表）的列含义，以及关键外键关系和常见安全 JOIN 写法。写 `sql()` 前读。 |

简单来说，面向 agent 的分层查阅顺序是：

1. 需要写查询 → 先看 `retrieval-semantics.md`（设计框架）
2. 需要模板 → `query-patterns.md`（可复制的编排模式）
3. 需要精确 API 签名 → `api-reference.md`（权威合约）
4. 需要 SQL 字段名 → `schema.md`（表结构）
5. 出错 → `pitfalls.md`（排查清单）
