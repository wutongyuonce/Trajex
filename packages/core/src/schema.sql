-- Trajex 统一 SQLite 数据模型。
--
-- 此文件保存可再生 transcript 索引与人工确认的 memories。Provider 先输出
-- TranscriptRecord，persist 再按本 schema 写表；FTS 虚表与 trigger 由 SQLite
-- 从 messages/memories 自动维护，查询层使用 MATCH 而不是扫描原表。

-- ============================================================
-- 1. 会话表：每次 AI 工具对话作为一个 session
-- ============================================================
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,             -- 会话唯一 ID，由 provider 生成
  title TEXT,                      -- 会话标题
  project TEXT,                    -- 项目 slug（dash 编码的路径，如 "Users-my-app"）
  project_path TEXT,               -- 项目真实绝对路径（由 refreshSessionProjectPaths 填充）
  started_at TEXT,                 -- 会话开始时间（ISO 8601）
  ended_at TEXT,                   -- 会话结束时间（ISO 8601）
  git_branch TEXT,                 -- 会话期间的 git 分支
  version TEXT,                    -- 生成该会话的 CLI 版本
  message_count INTEGER DEFAULT 0, -- 消息总数
  jsonl_path TEXT,                 -- 来源 JSONL 文件的绝对路径
  source TEXT DEFAULT 'claude');   -- 来源标识：claude / codex / pi

-- ============================================================
-- 2. 消息表：单条对话消息，是搜索和展示的核心实体
-- ============================================================
CREATE TABLE IF NOT EXISTS messages (
  uuid TEXT PRIMARY KEY,           -- 消息唯一 ID
  session_id TEXT,                 -- 所属会话（FK -> sessions.id）
  type TEXT,                       -- user / assistant
  parent_uuid TEXT,                -- 父消息 UUID，构成线程链
  timestamp TEXT,                  -- ISO 时间戳
  role TEXT,                       -- 同 type，冗余用于查询
  text TEXT,                       -- 消息文本内容（FTS 搜索列）
  content_type TEXT,               -- text / thinking / tool_use / unknown / skill_instructions
  is_meta INTEGER DEFAULT 0,       -- 1 = 系统生成的 meta 消息（如 system-reminder）
  visibility TEXT DEFAULT 'visible', -- visible / hidden（hidden 的消息仅在原始文件可见）
  model TEXT,                      -- 使用的 AI 模型名
  is_sidechain INTEGER DEFAULT 0,  -- 1 = 子代理线程的消息（非主会话）
  agent_id TEXT,                   -- 所属子代理 ID（非空时表示是子代理消息）
  input_tokens INTEGER,            -- 该消息的输入 token 数（含 cache）
  output_tokens INTEGER,           -- 该消息的输出 token 数
  cwd TEXT,                        -- 该消息发出时的工作目录
  skill TEXT,                      -- 该消息关联的 skill 名（如 "Skill" 调用）
  turn_duration_ms INTEGER,        -- 该轮次耗时（由 MessageTurnDurationRecord 填充）
  source TEXT DEFAULT 'claude');   -- 来源标识

-- ============================================================
-- 3. 工具调用表：AI 在执行代码、读文件等操作时的工具调用
-- ============================================================
CREATE TABLE IF NOT EXISTS tool_calls (
  id TEXT PRIMARY KEY,             -- 工具调用 ID（provider 原生或 namespaced）
  message_uuid TEXT,               -- 所属消息（FK -> messages.uuid）
  session_id TEXT,                 -- 所属会话
  name TEXT,                       -- 工具名：Read / Edit / Bash / Write 等
  input_json TEXT,                 -- 调用参数 JSON 字符串
  file_path TEXT);                 -- 操作的目标文件路径（部分工具适用）

-- ============================================================
-- 4. 工具结果表：对应工具调用的执行输出
-- ============================================================
CREATE TABLE IF NOT EXISTS tool_results (
  tool_use_id TEXT PRIMARY KEY,    -- 对应 tool_calls.id
  message_uuid TEXT,               -- 结果所属消息
  session_id TEXT,                 -- 所属会话
  content TEXT,                    -- 执行结果文本内容
  file_path TEXT,                  -- 操作的目标文件路径
  is_error INTEGER DEFAULT 0);     -- 1 = 执行错误

-- ============================================================
-- 5. 子代理表：AI 发起的子对话/子任务
-- ============================================================
CREATE TABLE IF NOT EXISTS subagents (
  agent_id TEXT PRIMARY KEY,       -- 子代理 ID
  session_id TEXT,                 -- 所属会话
  parent_tool_use_id TEXT,         -- 触发该子代理的 tool_call.id
  agent_type TEXT,                 -- 代理类型描述（如 "codex-auto-review"）
  description TEXT,                -- 代理任务描述
  duration_ms INTEGER,             -- 执行耗时
  total_tokens INTEGER);           -- 消耗的总 token 数

-- ============================================================
-- 6. 工作流表：Task/Workflow 粒度的运行记录
-- ============================================================
CREATE TABLE IF NOT EXISTS workflows (
  run_id TEXT PRIMARY KEY,         -- 工作流运行 ID
  session_id TEXT,                 -- 所属会话
  parent_tool_use_id TEXT,         -- 触发该工作流的 tool_call.id
  task_id TEXT,                    -- 任务 ID
  script TEXT,                     -- 执行的 CodeAct 脚本
  result_json TEXT,                -- 执行结果 JSON
  timestamp TEXT,                  -- 时间戳
  agent_count INTEGER DEFAULT 0,   -- 包含的子代理数
  duration_ms INTEGER,             -- 总耗时
  total_tokens INTEGER,            -- 总 token 数
  status TEXT,                     -- 状态（success / failure / running 等）
  workflow_name TEXT);             -- 工作流名称

-- ============================================================
-- 7. 工作流代理表：工作流中每个子代理的详细阶段信息
--     注意：同一 agent_id 可以由两个独立单元贡献列字段，
--     persist 用 COALESCE 合并（ON CONFLICT DO UPDATE SET）
-- ============================================================
CREATE TABLE IF NOT EXISTS workflow_agents (
  agent_id TEXT PRIMARY KEY,       -- 代理 ID
  run_id TEXT,                     -- 所属工作流 ID
  session_id TEXT,                 -- 所属会话
  agent_type TEXT,                 -- 代理类型
  description TEXT,                -- 描述
  phase TEXT,                      -- 阶段名
  label TEXT,                      -- 标签
  model TEXT,                      -- 使用的模型
  state TEXT,                      -- 状态
  duration_ms INTEGER,             -- 耗时
  tokens INTEGER,                  -- token 数
  tool_calls INTEGER);             -- 工具调用次数

-- ============================================================
-- 8. 索引进度表：记录每个文件/特殊标记的索引状态
--     jsonl_path 特殊值：
--       __last_build__     → 上次构建时间（用于防抖）
--       __app_heartbeat__  → 桌面 App 心跳时间（判断 daemon 存活）
--       __claude/__codex/__pi_canonical_transcript_v*__ → 适配器迁移标记
-- ============================================================
CREATE TABLE IF NOT EXISTS index_state (
  jsonl_path TEXT PRIMARY KEY,     -- 文件路径 或 系统标记
  mtime REAL,                      -- 文件修改时间（毫秒）或心跳时间
  lines_processed INTEGER);        -- JSONL 已处理行数（用于增量 resume）

-- ============================================================
-- 9. 摘要表：会话摘要（来自 compact、工作流等）
-- ============================================================
CREATE TABLE IF NOT EXISTS summaries (
  id TEXT PRIMARY KEY,             -- 摘要 ID
  session_id TEXT,                 -- 所属会话
  agent_id TEXT,                   -- 子 Agent 摘要所属 Agent（主会话为空）
  timestamp TEXT,                  -- 摘要时间
  source TEXT,                     -- 摘要类型（如 compact、workflow）
  content TEXT);                   -- 摘要文本

-- ============================================================
-- 10. 消息全文搜索（FTS5 虚拟表，content-backed）
--     外挂 messages 表，触发器自动同步，查询用 MATCH
-- ============================================================
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  uuid UNINDEXED,                  -- 透传字段，不参与全文检索
  session_id UNINDEXED,            -- 透传字段，不参与全文检索
  text,                            -- FTS 索引列：消息文本
  content=messages,                -- 外挂 messages 表
  content_rowid=rowid);            -- 使用 messages 的 rowid 映射

-- messages 插入后：同步到 FTS
CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, uuid, session_id, text)
  VALUES (new.rowid, new.uuid, new.session_id, new.text);
END;

-- messages 删除后：从 FTS 移除（'delete' 是 FTS5 的特殊命令）
CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, uuid, session_id, text)
  VALUES ('delete', old.rowid, old.uuid, old.session_id, old.text);
END;

-- messages 更新后：先删旧索引再插新数据
CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, uuid, session_id, text)
  VALUES ('delete', old.rowid, old.uuid, old.session_id, old.text);
  INSERT INTO messages_fts(rowid, uuid, session_id, text)
  VALUES (new.rowid, new.uuid, new.session_id, new.text);
END;

-- ============================================================
-- 11. B-Tree 索引：加速 messages 的常用查询路径
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
CREATE INDEX IF NOT EXISTS idx_messages_agent ON messages(agent_id);
CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(session_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_sessions_source ON sessions(source);
CREATE INDEX IF NOT EXISTS idx_messages_source ON messages(source);
CREATE INDEX IF NOT EXISTS idx_tc_session_name ON tool_calls(session_id, name);
CREATE INDEX IF NOT EXISTS idx_tc_message ON tool_calls(message_uuid);
CREATE INDEX IF NOT EXISTS idx_tc_file ON tool_calls(file_path);
CREATE INDEX IF NOT EXISTS idx_tr_session ON tool_results(session_id);
CREATE INDEX IF NOT EXISTS idx_tr_message ON tool_results(message_uuid);
CREATE INDEX IF NOT EXISTS idx_sa_session ON subagents(session_id);
CREATE INDEX IF NOT EXISTS idx_wf_session ON workflows(session_id);
CREATE INDEX IF NOT EXISTS idx_wa_run ON workflow_agents(run_id);
CREATE INDEX IF NOT EXISTS idx_summaries_session ON summaries(session_id);

-- ============================================================
-- 12. 记忆表：用户通过 attune API (remember/forget) 创建的持久记忆
--     不受索引重建影响，软删除（deleted_at 非空表示已删除）
-- ============================================================
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,             -- 记忆唯一 ID（"mem-时间戳-随机"）
  session_id TEXT,                 -- 关联的会话 ID
  project TEXT,                    -- 关联的项目名
  message_start TEXT,              -- 记忆覆盖的起始消息 UUID
  message_end TEXT,                -- 记忆覆盖的结束消息 UUID
  path TEXT,                       -- 引用的文件路径
  anchors TEXT,                    -- Legacy column retained for existing databases; no longer used
  summary TEXT,                    -- 记忆摘要文本（FTS 索引列）
  created_at TEXT,                 -- 创建时间（ISO 8601）
  deleted_at TEXT,                 -- 删除时间（软删除标记）
  deleted_reason TEXT);            -- 删除原因

-- ============================================================
-- 13. 记忆全文搜索（FTS5，去变音符号分词器）
--     外挂 memories 表，支持 path 和 summary 的全文检索
-- ============================================================
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  id UNINDEXED,                    -- 透传字段
  path,                            -- 文件路径（可搜索）
  summary,                         -- 摘要（可搜索）
  content=memories,                -- 外挂 memories 表
  content_rowid=rowid,
  tokenize='unicode61 remove_diacritics 1');  -- 多语言分词，去除变音符号

-- memories 插入/删除/更新的自动同步触发器
CREATE TRIGGER IF NOT EXISTS memories_fts_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, id, path, summary)
  VALUES (new.rowid, new.id, new.path, new.summary);
END;
CREATE TRIGGER IF NOT EXISTS memories_fts_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, id, path, summary)
  VALUES ('delete', old.rowid, old.id, old.path, old.summary);
END;
CREATE TRIGGER IF NOT EXISTS memories_fts_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, id, path, summary)
  VALUES ('delete', old.rowid, old.id, old.path, old.summary);
  INSERT INTO memories_fts(rowid, id, path, summary)
  VALUES (new.rowid, new.id, new.path, new.summary);
END;

-- ============================================================
-- 14. memories 表的 B-Tree 索引
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project);
CREATE INDEX IF NOT EXISTS idx_memories_session ON memories(session_id);
CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at);
