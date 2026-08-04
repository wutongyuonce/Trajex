/**
 * Session Detail 组装模块。
 *
 * 模块定位：把规范 TranscriptRecord 流或持久化表行（SessionDetailRows）转为
 * renderer 可直接消费的 SessionDetailSnapshot；它是“原始索引事实”和
 * “详情展示模型”之间的纯转换层。
 *
 * 核心职责：
 * - 接受两种输入形态：新鲜全量解析的记录流 / 持久化 round-trip 后的多表行
 * - 按 message_uuid / tool_use_id 重新附着 tool call 与结果，隐藏表拆分
 * - 合并连续 thinking / tool_use 消息，展开 workflow agents，过滤非主线程消息
 * - 输出 session 头 + 有序消息 + workflow 树 + 摘要的稳定展示契约
 *
 * 调用链：
 *   provider adapter（claude/codex/pi 全量解析）→ assembleSessionDetail()
 *   app 主进程 / renderer data 层（SQL 拼装 SessionDetailRows）→ assembleSessionDetail()
 *   ↓
 *   assembleTranscriptRecords() → assembleMessages() → SessionDetailSnapshot
 */
import type {
  TranscriptRecord,
  MessageRecord,
  SessionRecord,
  SummaryRecord,
  ToolCallRecord,
  ToolResultRecord,
  WorkflowAgentRecord,
  WorkflowRecord,
} from './providers/types.ts';

/** 去掉判别字段 kind 后的记录主体。 */
type WithoutKind<T extends { kind: string }> = Omit<T, 'kind'>;

/** 详情页单条消息的展示形态：兼容字段透传，关键字段显式声明。 */
export interface SessionDetailMessage {
  [key: string]: unknown;
  uuid: string;
  type: string | null;
  timestamp: string | null;
  text: string | null;
  content_type: string | null;
  is_meta: 0 | 1;
  turn_duration_ms: number | null;
}

/** tool call 对应的执行结果（去掉 kind 的 ToolResultRecord）。 */
export type SessionDetailToolResult = WithoutKind<ToolResultRecord>;

/** workflow 下单个 agent 的展示摘要。 */
export interface SessionDetailWorkflowAgent {
  agent_id: string;
  phase: string | null;
  label: string | null;
  state: string | null;
  tokens: number | null;
  duration_ms: number | null;
}

/** 详情页 workflow 树节点：run 头信息 + 展开后的 agents 数组。 */
export interface SessionDetailWorkflow {
  [key: string]: unknown;
  run_id: string;
  parent_tool_use_id: string | null;
  workflow_name: string | null;
  status: string | null;
  duration_ms: number | null;
  total_tokens: number | null;
  /** 缺省时由 agents 数组长度兜底（agent_count ?? agents.length）。 */
  agent_count: number | null;
  agents: SessionDetailWorkflowAgent[];
}

/** 组装后的 tool call：结果、workflow、subagent 三类关联挂在同一 call 上。 */
export interface AssembledToolCall {
  id: string;
  name: string;
  input_json: string | null;
  result: SessionDetailToolResult | null;
  workflow?: SessionDetailWorkflow;
  subagent?: Pick<SessionSubagentRow, 'agent_id' | 'parent_tool_use_id' | 'agent_type' | 'description'>;
}

/** 组装后的消息：在 SessionDetailMessage 上叠加 tool_calls 与合并后的 _thinking。 */
export interface AssembledMessage extends SessionDetailMessage {
  [key: string]: unknown;
  tool_calls?: AssembledToolCall[];
  _thinking?: string;
}

/** 详情展示的顶层输出：session 头 + 有序消息 + workflow 树 + 摘要。 */
export interface SessionDetailSnapshot {
  session: SessionDetailSession | null;
  messages: AssembledMessage[];
  workflows: SessionDetailWorkflow[];
  summaries: SessionDetailSummary[];
}

export type SessionDetailSummary = WithoutKind<SummaryRecord> & Record<string, unknown>;

export type SessionDetailSession = Omit<WithoutKind<SessionRecord>, 'countMode'>;

/** 输入形态之一：DB session 表行（主键 id 必填，其余兼容透传）。 */
export interface SessionDetailSessionRow {
  [key: string]: unknown;
  id: string;
  title?: string | null;
  project?: string | null;
  started_at?: string | null;
  ended_at?: string | null;
  git_branch?: string | null;
  version?: string | null;
  message_count?: number | null;
  jsonl_path?: string | null;
  source?: string | null;
}

/** DB messages 表行。 */
export interface SessionMessageRow {
  [key: string]: unknown;
  uuid: string;
  session_id?: string | null;
  type?: string | null;
  role?: string | null;
  parent_uuid?: string | null;
  timestamp?: string | null;
  text?: string | null;
  content_type?: string | null;
  is_meta?: number | boolean | null;
  visibility?: string | null;
}

/** DB tool_results 表行。 */
export interface SessionToolResultRow {
  [key: string]: unknown;
  tool_use_id: string;
  message_uuid?: string | null;
  session_id?: string | null;
  content?: string | null;
}

/** DB tool_calls 表行。 */
export interface SessionToolCallRow {
  [key: string]: unknown;
  id: string;
  message_uuid: string;
  session_id?: string | null;
  name: string;
  input_json?: string | null;
}

/** DB subagents 表行（通过 parent_tool_use_id 挂到父消息的 tool call 上）。 */
export interface SessionSubagentRow {
  [key: string]: unknown;
  agent_id: string;
  session_id?: string | null;
  parent_tool_use_id?: string | null;
  agent_type?: string | null;
  description?: string | null;
}

/** DB workflow_agents 表行：workflow run 下的单个 agent 摘要。 */
export interface SessionWorkflowAgentRow {
  [key: string]: unknown;
  agent_id: string;
  run_id?: string | null;
  session_id?: string | null;
  phase?: string | null;
  label?: string | null;
  state?: string | null;
  tokens?: number | null;
  duration_ms?: number | null;
}

/** DB workflows 表行：可内嵌 agents 数组（round-trip 展开后的形态）。 */
export interface SessionWorkflowRow {
  [key: string]: unknown;
  run_id: string;
  session_id?: string | null;
  parent_tool_use_id?: string | null;
  workflow_name?: string | null;
  status?: string | null;
  duration_ms?: number | null;
  total_tokens?: number | null;
  agent_count?: number | null;
  agents?: SessionWorkflowAgentRow[] | null;
}

/** DB summaries 表行。 */
export interface SessionSummaryRow {
  [key: string]: unknown;
  id: string | number;
  session_id?: string | null;
}

/** 输入形态之二：renderer/持久化层的多表行集合（由上层 SQL 查询拼装）。 */
export interface SessionDetailRows {
  session?: SessionDetailSessionRow | null;
  messages?: SessionMessageRow[];
  toolCalls?: SessionToolCallRow[];
  toolResults?: SessionToolResultRow[];
  subagents?: SessionSubagentRow[];
  workflows?: SessionWorkflowRow[];
  summaries?: SessionSummaryRow[];
}

/** 剥掉记录上的 kind 判别字段，保留其余字段。 */
function withoutKind<T extends { kind: string }>(record: T): WithoutKind<T> {
  const { kind: _kind, ...value } = record;
  return value;
}

/**
 * 将扁平 message/tool 记录组装成 renderer 需要的有序消息块。工具调用与结果按
 * message_uuid、tool_use_id 重新附着，避免 UI 了解数据库表的拆分方式。
 *
 * 定位：assembleTranscriptRecords() 的展示层后处理；输入消息已按主线程过滤并排序。
 *
 * 被谁调用：
 *   - assembleTranscriptRecords()
 *
 * 调用了谁：
 *   - withoutKind()
 *
 * @param messages   有序的主线程消息（content_type 为 tool_result 的会被吞并）
 * @param toolCalls  session 下全部 tool_call 记录
 * @param toolResults session 下全部 tool_result 记录
 * @param subagents  session 下全部 subagent 摘要（按 parent_tool_use_id 挂载）
 * @param workflows  session 下全部 workflow 树（按 parent_tool_use_id 挂载）
 * @returns 可直接渲染的 AssembledMessage[]，消息条数可能少于输入（连续片段已合并）
 */
function assembleMessages(
  messages: SessionDetailMessage[],
  toolCalls: ToolCallRecord[],
  toolResults: ToolResultRecord[],
  subagents: Array<Pick<SessionSubagentRow, 'agent_id' | 'parent_tool_use_id'>>,
  workflows: SessionDetailWorkflow[],
): AssembledMessage[] {
  // 索引一：tool_use_id → 执行结果，供后续给每个 tool call 补 result。
  const resultsByCallId = new Map<string, SessionDetailToolResult>();
  for (const result of toolResults) resultsByCallId.set(result.tool_use_id, withoutKind(result));

  // 索引二：parent_tool_use_id → workflow / subagent。
  // workflow 与 subagent 都以“父 tool call 的 id”为锚点，挂在同一个 call 上。
  const callsByMessageUuid = new Map<string, AssembledToolCall[]>();
  const workflowsByCallId = new Map(
    workflows
      .filter((workflow) => workflow.parent_tool_use_id)
      .map((workflow) => [workflow.parent_tool_use_id as string, workflow]),
  );
  const subagentsByCallId = new Map(
    subagents
      .filter((subagent) => subagent.parent_tool_use_id)
      .map((subagent) => [subagent.parent_tool_use_id as string, subagent]),
  );
  // 索引三：message_uuid → 该消息发起的全部 tool call（含 result/workflow/subagent）。
  for (const toolCall of toolCalls) {
    const call: AssembledToolCall = {
      id: toolCall.id,
      name: toolCall.name,
      input_json: toolCall.input_json,
      result: resultsByCallId.get(toolCall.id) ?? null,
    };
    const workflow = workflowsByCallId.get(toolCall.id);
    if (workflow) call.workflow = workflow;
    const subagent = subagentsByCallId.get(toolCall.id);
    if (subagent) call.subagent = subagent;
    const calls = callsByMessageUuid.get(toolCall.message_uuid) ?? [];
    calls.push(call);
    callsByMessageUuid.set(toolCall.message_uuid, calls);
  }

  // 先把 tool_calls 附着到各消息，再进入合并阶段。
  const raw = messages.map((message): AssembledMessage => {
    const assembled: AssembledMessage = { ...message };
    const calls = callsByMessageUuid.get(message.uuid);
    if (calls?.length) assembled.tool_calls = calls;
    return assembled;
  });

  // 合并阶段：把 Provider 切碎的消息片段还原成用户可读的“一条消息”。
  const output: AssembledMessage[] = [];
  for (let index = 0; index < raw.length; index++) {
    const message = raw[index];
    // tool_result 不独立成条：其内容已经挂在对应 tool call 的 result 上。
    if (message.content_type === 'tool_result') continue;

    // thinking 片段合并：把紧邻的连续 thinking 段拼成一段，若有紧随其后的
    // assistant 消息则存进它的 _thinking（保留在 UI 折叠区），否则独立成条。
    if (message.type === 'assistant' && message.content_type === 'thinking') {
      const thinkingParts = [message.text ?? ''];
      let nextIndex = index + 1;
      while (
        nextIndex < raw.length
        && raw[nextIndex].type === 'assistant'
        && raw[nextIndex].content_type === 'thinking'
      ) {
        thinkingParts.push(raw[nextIndex].text ?? '');
        nextIndex++;
      }
      if (
        nextIndex < raw.length
        && raw[nextIndex].type === 'assistant'
        && raw[nextIndex].content_type !== 'thinking'
      ) {
        raw[nextIndex]._thinking = thinkingParts.join('\n\n');
        index = nextIndex - 1;
        continue;
      }
      output.push({ ...message, text: thinkingParts.join('\n\n'), content_type: 'thinking' });
      index = nextIndex - 1;
      continue;
    }

    // tool_use 片段合并：把连续的多条 tool_use（中间夹着 tool_result）合并成
    // 一条 assistant 消息，tool_calls 全部汇入同一条展示。
    if (message.type === 'assistant' && message.content_type === 'tool_use') {
      const merged: AssembledMessage = {
        ...message,
        tool_calls: [...(message.tool_calls ?? [])],
      };
      const mergedCalls = merged.tool_calls ?? [];
      if (message._thinking) merged._thinking = message._thinking;
      let nextIndex = index + 1;
      while (nextIndex < raw.length) {
        const next = raw[nextIndex];
        if (next.content_type === 'tool_result') {
          nextIndex++;
          continue;
        }
        if (next.type === 'assistant' && next.content_type === 'tool_use') {
          if (next.tool_calls) mergedCalls.push(...next.tool_calls);
          if (next.text && !merged.text) merged.text = next.text;
          nextIndex++;
          continue;
        }
        break;
      }
      output.push(merged);
      index = nextIndex - 1;
      continue;
    }

    // 普通 assistant 消息：同样向后吞并紧随的 tool_use 片段（含中间的
    // tool_result），使其文本与工具调用同条展示；无调用时删掉空数组。
    const assembled: AssembledMessage = { ...message };
    if (message._thinking) assembled._thinking = message._thinking;
    if (message.type === 'assistant'
      && message.content_type !== 'tool_use'
      && message.content_type !== 'thinking') {
      if (!assembled.tool_calls) assembled.tool_calls = [];
      let nextIndex = index + 1;
      while (nextIndex < raw.length) {
        const next = raw[nextIndex];
        if (next.content_type === 'tool_result') {
          nextIndex++;
          continue;
        }
        if (next.type === 'assistant' && next.content_type === 'tool_use') {
          if (next.tool_calls) assembled.tool_calls.push(...next.tool_calls);
          nextIndex++;
          continue;
        }
        break;
      }
      if (!assembled.tool_calls.length) delete assembled.tool_calls;
      index = nextIndex - 1;
    }
    output.push(assembled);
  }

  return output;
}

/**
 * 直接从 Provider 的规范记录流组装详情快照。要求传入的是全新全量解析
 * （cursor = null）；Provider 专属的线协议语义须在此 seam 之前已解析完成。
 */
function assembleTranscriptRecords(records: Iterable<TranscriptRecord>): SessionDetailSnapshot {
  let session: SessionDetailSession | null = null;
  const messages: SessionDetailMessage[] = [];
  const messagesByUuid = new Map<string, SessionDetailMessage>();
  const mainMessageUuids = new Set<string>();
  const toolCalls: ToolCallRecord[] = [];
  const toolResults: ToolResultRecord[] = [];
  const subagents: Extract<TranscriptRecord, { kind: 'subagent' }>[] = [];
  const workflows: WorkflowRecord[] = [];
  const workflowAgentsById = new Map<string, WorkflowAgentRecord>();
  const summaries: SessionDetailSummary[] = [];

  // 单遍扫描记录流：按 kind 分桶到各自集合，同时建立 uuid → 消息索引。
  for (const record of records) {
    switch (record.kind) {
      case 'session':
        // 详情组装需要“一次性全量”视角：delta 增量无法还原完整 session 视图。
        if (record.countMode === 'delta') {
          throw new Error('Direct session detail assembly requires a fresh full parse (cursor = null), not a provider delta');
        }
        session = {
          id: record.id,
          title: record.title,
          project: record.project,
          started_at: record.started_at,
          ended_at: record.ended_at,
          git_branch: record.git_branch,
          version: record.version,
          message_count: record.message_count,
          jsonl_path: record.jsonl_path,
          source: record.source,
        };
        break;
      case 'message': {
        // hidden 消息对用户不可见，直接丢弃。
        if (record.visibility === 'hidden') break;
        const message: SessionDetailMessage = {
          uuid: record.uuid,
          type: record.type || record.role,
          timestamp: record.timestamp,
          text: record.text,
          content_type: record.content_type,
          is_meta: record.is_meta,
          // turn_duration_ms 不随 message 事件带出时保持 null，稍后由
          // message-turn-duration 事件按 uuid 回填。
          turn_duration_ms: typeof (record as MessageRecord & { turn_duration_ms?: unknown }).turn_duration_ms === 'number'
            ? (record as MessageRecord & { turn_duration_ms: number }).turn_duration_ms
            : null,
        };
        messages.push(message);
        messagesByUuid.set(message.uuid, message);
        // agent_id === null 表示主线程消息；subagent 的消息在详情页不展示。
        if (record.agent_id === null) mainMessageUuids.add(message.uuid);
        break;
      }
      case 'tool_call':
        toolCalls.push(record);
        break;
      case 'tool_result':
        toolResults.push(record);
        break;
      case 'subagent':
        subagents.push(record);
        break;
      case 'workflow':
        workflows.push(record);
        break;
      case 'workflow_agent':
        // workflow agent 可能被拆成多次事件发射：按 agent_id 合并，后到的事件
        // 只覆盖非空字段，避免覆盖掉之前已解析出的信息。
        workflowAgentsById.set(record.agent_id, {
          ...(workflowAgentsById.get(record.agent_id) ?? record),
          ...Object.fromEntries(
            Object.entries(record).filter(([, value]) => value !== null && value !== undefined),
          ),
        } as WorkflowAgentRecord);
        break;
      case 'summary':
        summaries.push(withoutKind(record));
        break;
      case 'message-turn-duration': {
        // 迟到的事件：把 turn_duration_ms 回填到已登记的消息上。
        const message = messagesByUuid.get(record.uuid);
        if (message) message.turn_duration_ms = record.turn_duration_ms;
        break;
      }
      case 'delete-session':
        // 删除标记只影响持久化增量，详情组装直接忽略。
        break;
    }
  }

  // workflow 树：把散落的 workflow_agent 记录按 run_id 归并进各自的 run。
  const assembledWorkflows: SessionDetailWorkflow[] = workflows.map((workflow) => {
    const agents = [...workflowAgentsById.values()]
      .filter((agent) => agent.run_id === workflow.run_id)
      .map((agent) => ({
        agent_id: agent.agent_id,
        phase: agent.phase ?? null,
        label: agent.label ?? null,
        state: agent.state ?? null,
        tokens: agent.tokens ?? null,
        duration_ms: agent.duration_ms ?? null,
      }));
    return {
      run_id: workflow.run_id,
      parent_tool_use_id: workflow.parent_tool_use_id ?? null,
      workflow_name: workflow.workflow_name,
      status: workflow.status,
      duration_ms: workflow.duration_ms,
      total_tokens: workflow.total_tokens,
      // 缺省 agent_count 时用实际 agents 数量兜底，避免 UI 显示空计数。
      agent_count: workflow.agent_count ?? agents.length,
      agents,
    };
  });

  // 主线程过滤：session 存在时只展示主线程消息（subagent 内部对话归入 workflow）；
  // session === null（如持久化行未带 session）则显示全部，避免误删数据。
  const detailMessages = session === null
    ? messages
    : messages.filter((message) => mainMessageUuids.has(message.uuid));
  // 消息按时间戳排序（同时间戳按 uuid 稳定排序），保证展示顺序可复现。
  detailMessages.sort((left, right) => {
    const leftTimestamp = left.timestamp ?? '';
    const rightTimestamp = right.timestamp ?? '';
    if (leftTimestamp !== rightTimestamp) return leftTimestamp < rightTimestamp ? -1 : 1;
    return left.uuid < right.uuid ? -1 : left.uuid > right.uuid ? 1 : 0;
  });

  return {
    session,
    messages: assembleMessages(detailMessages, toolCalls, toolResults, subagents, assembledWorkflows),
    workflows: assembledWorkflows,
    summaries,
  };
}

/**
 * 将 SQLite 多表行逆投影回 TranscriptRecord，使持久化快照与实时解析共用同一
 * assembleTranscriptRecords() 展示逻辑。
 */
function sessionDetailRecordsFromRows(input: SessionDetailRows): TranscriptRecord[] {
  // 逆投影：每张表行 → 对应 kind 的 TranscriptRecord，并补齐缺省字段，
  // 使持久化快照能复用与实时解析完全相同的组装逻辑。
  const records: TranscriptRecord[] = [];
  if (input.session) {
    const session = input.session;
    // 字符串字段逐一校验：非字符串回退为 null，避免脏数据污染展示。
    records.push({
      kind: 'session',
      id: session.id,
      title: typeof session.title === 'string' ? session.title : null,
      project: typeof session.project === 'string' ? session.project : null,
      started_at: typeof session.started_at === 'string' ? session.started_at : null,
      ended_at: typeof session.ended_at === 'string' ? session.ended_at : null,
      git_branch: typeof session.git_branch === 'string' ? session.git_branch : null,
      version: typeof session.version === 'string' ? session.version : null,
      message_count: typeof session.message_count === 'number' ? session.message_count : 0,
      countMode: 'total',
      jsonl_path: typeof session.jsonl_path === 'string' ? session.jsonl_path : '',
      source: typeof session.source === 'string' ? session.source : '',
    });
  }
  for (const message of input.messages ?? []) {
    // 消息行透传所有未知字段，同时把 role 并入 type（role 只是线协议层概念）。
    records.push({
      ...message,
      kind: 'message',
      uuid: message.uuid,
      session_id: typeof message.session_id === 'string' ? message.session_id : '',
      type: typeof message.type === 'string' ? message.type : typeof message.role === 'string' ? message.role : '',
      parent_uuid: typeof message.parent_uuid === 'string' ? message.parent_uuid : null,
      timestamp: typeof message.timestamp === 'string' ? message.timestamp : null,
      role: typeof message.role === 'string' ? message.role : null,
      text: typeof message.text === 'string' ? message.text : null,
      content_type: typeof message.content_type === 'string' ? message.content_type : null,
      is_meta: message.is_meta ? 1 : 0,
      visibility: message.visibility === 'hidden' ? 'hidden' : 'visible',
      model: typeof message.model === 'string' ? message.model : null,
      is_sidechain: message.is_sidechain ? 1 : 0,
      agent_id: typeof message.agent_id === 'string' ? message.agent_id : null,
      input_tokens: typeof message.input_tokens === 'number' ? message.input_tokens : null,
      output_tokens: typeof message.output_tokens === 'number' ? message.output_tokens : null,
      cwd: typeof message.cwd === 'string' ? message.cwd : null,
      skill: typeof message.skill === 'string' ? message.skill : null,
      source: typeof message.source === 'string' ? message.source : '',
    });
  }
  for (const toolCall of input.toolCalls ?? []) {
    records.push({
      ...toolCall,
      kind: 'tool_call',
      id: toolCall.id,
      message_uuid: toolCall.message_uuid,
      session_id: typeof toolCall.session_id === 'string' ? toolCall.session_id : '',
      name: toolCall.name,
      input_json: typeof toolCall.input_json === 'string' ? toolCall.input_json : '',
      file_path: typeof toolCall.file_path === 'string' ? toolCall.file_path : null,
    });
  }
  for (const result of input.toolResults ?? []) {
    records.push({
      ...result,
      kind: 'tool_result',
      tool_use_id: result.tool_use_id,
      message_uuid: typeof result.message_uuid === 'string' ? result.message_uuid : '',
      session_id: typeof result.session_id === 'string' ? result.session_id : '',
      content: typeof result.content === 'string' ? result.content : '',
      file_path: typeof result.file_path === 'string' ? result.file_path : null,
      is_error: result.is_error ? 1 : 0,
    });
  }
  for (const subagent of input.subagents ?? []) {
    records.push({
      ...subagent,
      kind: 'subagent',
      agent_id: subagent.agent_id,
      session_id: typeof subagent.session_id === 'string' ? subagent.session_id : '',
      parent_tool_use_id: typeof subagent.parent_tool_use_id === 'string' ? subagent.parent_tool_use_id : null,
      agent_type: typeof subagent.agent_type === 'string' ? subagent.agent_type : null,
      description: typeof subagent.description === 'string' ? subagent.description : null,
      duration_ms: typeof subagent.duration_ms === 'number' ? subagent.duration_ms : null,
      total_tokens: typeof subagent.total_tokens === 'number' ? subagent.total_tokens : null,
    });
  }
  for (const workflow of input.workflows ?? []) {
    records.push({
      ...workflow,
      kind: 'workflow',
      run_id: workflow.run_id,
      session_id: typeof workflow.session_id === 'string' ? workflow.session_id : '',
      parent_tool_use_id: typeof workflow.parent_tool_use_id === 'string' ? workflow.parent_tool_use_id : null,
      task_id: typeof workflow.task_id === 'string' ? workflow.task_id : null,
      script: typeof workflow.script === 'string' ? workflow.script : null,
      result_json: typeof workflow.result_json === 'string' ? workflow.result_json : null,
      timestamp: typeof workflow.timestamp === 'string' ? workflow.timestamp : null,
      agent_count: typeof workflow.agent_count === 'number' ? workflow.agent_count : 0,
      duration_ms: typeof workflow.duration_ms === 'number' ? workflow.duration_ms : null,
      total_tokens: typeof workflow.total_tokens === 'number' ? workflow.total_tokens : null,
      status: typeof workflow.status === 'string' ? workflow.status : null,
      workflow_name: typeof workflow.workflow_name === 'string' ? workflow.workflow_name : null,
    });
    for (const agent of workflow.agents ?? []) {
      records.push({
        ...agent,
        kind: 'workflow_agent',
        agent_id: agent.agent_id,
        run_id: typeof agent.run_id === 'string' ? agent.run_id : workflow.run_id,
        session_id: typeof agent.session_id === 'string'
          ? agent.session_id
          : typeof workflow.session_id === 'string' ? workflow.session_id : '',
        ...(typeof agent.agent_type === 'string' ? { agent_type: agent.agent_type } : {}),
        ...(typeof agent.description === 'string' ? { description: agent.description } : {}),
        ...(typeof agent.phase === 'string' ? { phase: agent.phase } : {}),
        ...(typeof agent.label === 'string' ? { label: agent.label } : {}),
        ...(typeof agent.model === 'string' ? { model: agent.model } : {}),
        ...(typeof agent.state === 'string' ? { state: agent.state } : {}),
        ...(typeof agent.duration_ms === 'number' ? { duration_ms: agent.duration_ms } : {}),
        ...(typeof agent.tokens === 'number' ? { tokens: agent.tokens } : {}),
        ...(typeof agent.tool_calls === 'number' ? { tool_calls: agent.tool_calls } : {}),
      });
    }
  }
  for (const summary of input.summaries ?? []) {
    records.push({
      ...summary,
      kind: 'summary',
      id: String(summary.id),
      session_id: typeof summary.session_id === 'string' ? summary.session_id : '',
      timestamp: typeof summary.timestamp === 'string' ? summary.timestamp : null,
      source: typeof summary.source === 'string' ? summary.source : '',
      content: typeof summary.content === 'string' ? summary.content : '',
    });
  }
  return records;
}

/**
 * Session Detail 的公开入口：接受规范记录流或持久化行两种输入，统一输出展示快照。
 * 这是详情展示的唯一 seam；Provider 线协议差异必须在此之前解决。
 */
export function assembleSessionDetail(
  input: Iterable<TranscriptRecord> | SessionDetailRows,
): SessionDetailSnapshot {
  const records = Symbol.iterator in input
    ? input as Iterable<TranscriptRecord>
    : sessionDetailRecordsFromRows(input as SessionDetailRows);
  return assembleTranscriptRecords(records);
}
