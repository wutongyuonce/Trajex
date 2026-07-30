/**
 * Provider 与规范 transcript 的跨模块类型契约。
 *
 * 文件定位：定义 adapter 与共享索引/展示层之间唯一可交换的语言。
 *
 * 核心类型：
 * - IndexUnit / Cursor：索引调度层与 adapter 之间的工作单元与进度标记
 * - TranscriptRecord 联合类型：adapter 产出的统一规范记录流
 * - Provider / ProviderAdapter：每个 AI 工具适配器必须实现的接口契约
 * - RawLookup / RawRecord：外部 UI/桌面端查询原始消息行时使用的分页查询协议
 *
 * 调用链：
 *   indexer.ts / buildIndex()
 *     → adapter.discover()        → 返回 IndexUnit[]
 *     → adapter.parse(unit, cursor) → Generator<TranscriptRecord>
 *     → persist.ts 消费 TranscriptRecord 写入 SQLite
 *
 * 设计原则：
 * - 仅含类型定义，无运行时逻辑，消费者必须用 `import type` 引入
 * - 字段形状与 SQLite schema 对应，但数据库只是序列化载体而非语义来源
 * - 每个 adapter 所有自己的发现/变更检测/断点恢复，因为格式相关（JSONL 文件、
 *   SQLite 库、目录树等）
 */
// Core provider contract (see docs/adr/0001).
//
// The indexing layer splits along two orthogonal axes:
//   - Provider axis: pure per-source adapters (claude, codex, later opencode,
//     pi, …) that discover their own work and parse it into records. A source is
//     NOT assumed to be a single JSONL file — an adapter may read a SQLite store,
//     a directory tree, etc. So discovery, change-detection, and resume cursoring
//     are all adapter-owned and format-specific.
//   - Consumer axis: shared, provider-agnostic modules consume the canonical
//     transcript for persistence and session-detail presentation.
//
// This file defines only the shapes crossing that seam. Many fields mirror the
// SQLite schema, but the database is a serialization adapter rather than the
// source of transcript semantics. Types only — no runtime code — so consumers
// must import with `import type`.

// ──────────────────────────────────────────────
// 索引调度层基础类型
// ──────────────────────────────────────────────

/**
 * 不透明的断点/水位标记。调度层原样存储（写入 index_state 表）并在下次运行时交回；
 * 只有生成它的 adapter 能解释其内容。
 *
 * JSONL adapter 可能编码为 `"${mtime}:${line}"`；SQLite-backed 的 adapter 可能
 * 编码为 rowid 或时间戳。
 */
export type Cursor = string | null;

/**
 * adapter 发现的一个索引工作单元。不一定对应一个文件——
 * 基于文件时 `key` 是路径，基于数据库时可能是 `"${dbPath}#${internalId}"`。
 * `meta` 携带 adapter 私有数据，调度层原封不动传递给 parse()。
 */
export interface IndexUnit {
  /** 作为 index_state cursor key 的稳定标识。 */
  key: string;
  /** 此 unit 索引到的会话 ID。 */
  sessionId: string;
  /** 项目 slug（dash 编码的路径），当来源能提供时填写。 */
  project?: string;
  /** 为子代理 transcript 设置，使其消息携带 agent_id。 */
  isSubagent?: boolean;
  agentId?: string;
  /** adapter 私有负载，对调度层完全不透明。 */
  meta?: unknown;
}

/**
 * 调度层提供给 adapter.discover() 的上下文。
 */
export interface DiscoverContext {
  /** 查询某 unit key 上次持久化的光标值。 */
  lastCursor(key: string): Cursor;
  /** 当 daemon 处于 changed-path 模式时，限制在此路径集合内发现变更。 */
  changedPaths?: string[];
}

// ──────────────────────────────────────────────
// 规范 Transcript 记录类型体系
// ──────────────────────────────────────────────

/**
 * 所有 provider adapter 产出的统一规范记录流。persist.ts 消费它写入数据库，
 * session-detail 层面直接消费它用于展示。
 *
 * 大多数 record 种类映射到一个 schema 表；update/retraction 类记录编码标准的状态转换。
 */
export type TranscriptRecord =
  | SessionRecord
  | MessageRecord
  | ToolCallRecord
  | ToolResultRecord
  | SummaryRecord
  | SubagentRecord
  | WorkflowRecord
  | WorkflowAgentRecord
  | MessageTurnDurationRecord
  | DeleteSessionRecord;

export type MessageVisibility = 'visible' | 'hidden';

/**
 * 单条消息记录。核心记录类型，对应 schema 的 messages 表。
 */
export interface MessageRecord {
  kind: 'message';
  uuid: string;
  session_id: string;
  type: string;
  parent_uuid: string | null;
  timestamp: string | null;
  role: string | null;
  text: string | null;
  content_type: string | null;
  is_meta: 0 | 1;
  /** provider 归一化的显示可见性；展示层绝不从文本内容推断。 */
  visibility: MessageVisibility;
  model: string | null;
  is_sidechain: 0 | 1;
  agent_id: string | null;
  /** provider 归一化的总输入 token 数，包含 provider 报告的缓存输入。 */
  input_tokens: number | null;
  output_tokens: number | null;
  cwd: string | null;
  skill: string | null;
  source: string;
}

/**
 * 工具调用记录。对应 schema 的 tool_calls 表。
 */
export interface ToolCallRecord {
  kind: 'tool_call';
  id: string;
  message_uuid: string;
  session_id: string;
  name: string;
  input_json: string;
  file_path: string | null;
}

/**
 * 工具执行结果记录。对应 schema 的 tool_results 表。
 */
export interface ToolResultRecord {
  kind: 'tool_result';
  tool_use_id: string;
  message_uuid: string;
  session_id: string;
  content: string;
  file_path: string | null;
  is_error: 0 | 1;
}

/**
 * 会话摘要记录。对应 schema 的 summaries 表。
 */
export interface SummaryRecord {
  kind: 'summary';
  id: string;
  session_id: string;
  timestamp: string | null;
  source: string;
  content: string;
}

/**
 * 子代理记录。和 workflow_agent 类似，一行可能由解析过程中的多个点
 * （spawn 事件 vs 代理自身线程）共同贡献，所以非关键字段可空，
 * persist 用 COALESCE 按列合并。
 */
export interface SubagentRecord {
  kind: 'subagent';
  agent_id: string;
  session_id: string;
  parent_tool_use_id?: string | null;
  agent_type?: string | null;
  description?: string | null;
  duration_ms?: number | null;
  total_tokens?: number | null;
}

/**
 * 工作流运行记录。对应 schema 的 workflows 表。
 * `agent_count` 是可选的展示元数据；persist 仍会计算权威聚合值，
 * 因为代理可能在其他运行中到齐。
 */
export interface WorkflowRecord {
  kind: 'workflow';
  run_id: string;
  session_id: string;
  parent_tool_use_id?: string | null;
  task_id: string | null;
  script: string | null;
  result_json: string | null;
  timestamp: string | null;
  agent_count: number;
  duration_ms: number | null;
  total_tokens: number | null;
  status: string | null;
  workflow_name: string | null;
}

/**
 * 工作流代理记录。一行由**两个独立单元**贡献（顺序不定）：
 * - 子代理 .meta.json 单元填写 agent_type / description
 * - 工作流 run json 单元填写 phase / label / model / state / duration_ms / tokens / tool_calls
 *
 * 每个可选字段只在对应单元知晓时填充，persist 按列合并：
 * `ON CONFLICT(agent_id) DO UPDATE SET col = COALESCE(excluded.col, col)`
 * 所有贡献者必须使用统一的 agent_id 键，确保合并到同一行。
 */
export interface WorkflowAgentRecord {
  kind: 'workflow_agent';
  agent_id: string;
  run_id: string;
  session_id: string;
  agent_type?: string | null;
  description?: string | null;
  phase?: string | null;
  label?: string | null;
  model?: string | null;
  state?: string | null;
  duration_ms?: number | null;
  tokens?: number | null;
  tool_calls?: number | null;
}

// ──────────────────────────────────────────────
// 操作类记录（不对应独立表，而是更新/删除操作）
// ──────────────────────────────────────────────

/**
 * 更新操作记录（不对应表）：设置 messages 表的 turn_duration_ms。
 * 该列由一条独立行填充（可能是后续运行），persist 应用为定向 UPDATE，
 * 不会影响消息的其他列。
 */
export interface MessageTurnDurationRecord {
  kind: 'message-turn-duration';
  uuid: string;
  turn_duration_ms: number | null;
}

/**
 * 撤回操作记录（不对应表）。adapter 在需要移除已索引的会话时发出此记录——
 * 例如 Codex 的 guardian / auto-review 线程。persist 执行级联删除该会话下所有表数据。
 */
export interface DeleteSessionRecord {
  kind: 'delete-session';
  sessionId: string;
}

// ──────────────────────────────────────────────
// 会话聚合记录
// ──────────────────────────────────────────────

/**
 * 会话级聚合记录。单元记录产出后由 adapter 发出一次，因为
 * started_at/ended_at/message_count 需要跨整个流计算。
 * title/ended_at 可由 adapter 从来源特有辅助文件（claude history.jsonl、
 * codex session_index.jsonl）补充；persist 使用 COALESCE upsert，
 * 确保不会覆盖已有的值。
 *
 * project_path 不在此设置——调度层的全局 pass
 * （refreshSessionProjectPaths）从持久化的消息 cwd 推导。
 *
 * countMode 告知 persist 如何处理 message_count：
 * - 'delta'（Claude）：每次只 yield 新消息，persist 累加到已有行
 * - 'total'（Codex）：每次 yield 所有消息，persist 替换
 *   空 cursor 的 'delta' 解析等价于 'total'
 */
export interface SessionRecord {
  kind: 'session';
  id: string;
  title: string | null;
  project: string | null;
  started_at: string | null;
  ended_at: string | null;
  git_branch: string | null;
  version: string | null;
  message_count: number;
  countMode: 'total' | 'delta';
  jsonl_path: string;
  source: string;
}

// ──────────────────────────────────────────────
// Provider 接口体系
// ──────────────────────────────────────────────

/**
 * Provider 核心接口。纯数据源描述：不接触 Trajex 数据库。
 * 它拥有自己的发现、变更检测和断点恢复，因为这些是格式相关的
 * （文件 mtime、数据库水位标记等）。
 *
 * `parse` 是 generator —— yield 记录流，RETURN 新的 cursor 给 persist 持久化。
 */
export interface Provider {
  /** 稳定的来源标签，存储在数据库行的 source 列，如 'claude' | 'codex'。 */
  readonly name: string;
  /** 利用存储的 cursor 检测变更，发现需要（重新）索引的单元。 */
  discover(ctx: DiscoverContext): IndexUnit[];
  /** 从 `cursor` 处恢复，yield 一个 unit 的记录流；return 新的 cursor。 */
  parse(unit: IndexUnit, cursor: Cursor): Generator<TranscriptRecord, Cursor>;
}

/**
 * 序列化的来源元数据，供设置页面和渲染层消费。
 */
export interface ProviderDescriptor {
  readonly id: string;
  readonly name: string;
  readonly vendor: string;
  readonly defaultRoot: string;
  readonly color: string;
}

/**
 * 原始消息查询请求。外部 UI/桌面端需要查看原始 JSONL 行内容时使用。
 */
export interface RawLookup {
  readonly source: string;
  readonly messageUuid: string;
  readonly session: Record<string, unknown> | null;
  readonly agentId: string | null;
  readonly subagent?: Record<string, unknown> | null;
  readonly workflowAgent?: Record<string, unknown> | null;
}

/**
 * 原始消息行响应。支持分页读取（totalLength / offset / limit / hasMore），
 * 用于渲染器展开显示长文本。
 */
export interface RawRecord {
  readonly text: string;
  readonly totalLength?: number;
  readonly offset?: number;
  readonly limit?: number;
  readonly hasMore?: boolean;
  /** provider 投影的完整消息体，供渲染器展开。 */
  readonly messageText?: string | null;
}

/**
 * 完整的 adapter 接口。被所有索引和展示调用方使用。
 * 在 Provider 基础上补充了描述元数据、文件监视和原始消息查询能力。
 */
export interface ProviderAdapter extends Provider {
  readonly descriptor: ProviderDescriptor;
  /** 索引语义版本标记；缺失时触发一次 provider 自有的全量重放。 */
  readonly indexVersionMarker?: string;
  watchRoots(configuredRoot: string): string[];
  raw(input: RawLookup): RawRecord | null;
}
