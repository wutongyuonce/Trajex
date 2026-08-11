# Agent 记忆系统评测指南：LongMemEval × SWE-bench

> 目标：为 Trajex 建立一套可运行、可审计的 Agent 记忆评测。只保留两类任务：长期聊天问答，以及同一 Agent 失败后的再次尝试。数据与评分口径以 LongMemEval、SWE-bench 官方资料为准。

## 1. 到底要测什么

这不是单纯比较“谁搜得更准”，而是比较一个 Agent 在拿到相同历史信息时，**历史以什么形式保存、由谁决定何时取、最终任务是否完成**。

两个主实验回答不同问题：

| 面板 | 任务 | 核心问题 | 主指标 |
|---|---|---|---|
| A：LongMemEval | 读长期聊天历史后回答问题 | 记忆系统能否找到并正确使用旧信息？ | 最终回答正确率 |
| B：SWE retry | 同一 Agent 第一次失败后重做 | Trajex 能否帮助第二次尝试利用失败经验并修好？ | 官方测试是否全部通过 |

统一的因果变量是“记忆 arm”。模型、任务、初始仓库、Agent harness、预算和评分器应尽量保持不变。每个任务都要在每个 arm 上跑一次，这样结果可以按任务配对比较，而不是只比较两个互不相关的平均数。

---

## 2. 公平比较必须先冻结什么

在跑任何模型之前生成一个 `experiment.lock.json`，至少固定：

```json
{
  "experiment_id": "trajex-memory-eval-v1",
  "datasets": {
    "longmemeval": {"name": "longmemeval_s_cleaned", "revision": "commit-or-sha256"},
    "swe_bench": {"name": "princeton-nlp/SWE-bench", "revision": "commit-or-sha256"}
  },
  "task_manifest_sha256": "...",
  "model": "exact-provider/model-version",
  "temperature": 0,
  "reasoning_effort": "xhigh",
  "agent_harness": "exact-harness-version",
  "trajex_commit": "git-commit-sha",
  "skill_prompt_sha256": "...",
  "max_steps": 100,
  "wall_timeout_seconds": 1800,
  "retrieval": {
    "embedding": "BAAI/bge-small-en-v1.5",
    "chunk_tokens": 400,
    "chunk_overlap_tokens": 0,
    "injection_budget_tokens": 4000
  },
  "active_search": {
    "max_hits": 5,
    "max_snippet_chars": 500,
    "max_response_tokens_per_call": 1000,
    "max_visible_tokens_per_task": 4000
  },
  "judge": {"model": "gpt-4o-2024-08-06", "temperature": 0}
}
```

`active_search` 是主动检索 arm 的硬上限：每次最多 5 条、单条最多 500 字符，并且整题累计最多让 Agent 看到 4,000 token 的检索结果。限制必须在运行时执行，不能只写进 prompt。

至少还要固定并记录：

- 模型精确版本，而不只是营销名称；API 模型可能静默更新。
- system prompt、Trajex skill prompt、工具定义和工作目录。
- 最大轮数、超时、最大输出 token、失败重试规则和并发数。
- token 计数器及 tokenizer 版本；字符数不能冒充 token 数。
- 每个 arm 的历史内容来源、顺序、截断方式和总预算。
- embedding 模型、revision、归一化方式、距离函数、chunk 大小、overlap、top-k 与最终预算。
- Trajex commit、索引配置、索引前的源文件哈希、查询结果上限。
- Judge 的精确模型、prompt、温度、失败重试和原始返回。
- SWE-bench package commit、Docker image digest、CPU 架构和每实例超时。

第一次正式运行前，将这里的占位值替换为当前 Trajex 与 Agent harness 的实际 commit/version，并把生成后的 lock 文件随结果一起保存。

### 2.1 Agent 可见输入与 grader 私有数据

评测 runner 必须把数据拆成两个信任域。被测 Agent 只能看到完成任务所需的公开输入；标准答案和评分依据只能由独立 grader 进程读取。

| 面板 | Agent 可以看到 | Agent 绝不能看到 |
|---|---|---|
| LongMemEval | `question`、`question_date`，以及该 arm 允许提供的历史文本 | `answer`、`has_answer`、`answer_session_ids`、oracle history、judge prompt/label |
| SWE-bench | `problem_statement`、`base_commit` 上的仓库，以及该 arm 允许提供的 `attempt_1` 失败记录 | gold `patch`、`test_patch`、`FAIL_TO_PASS`、`PASS_TO_PASS`、未来 git 历史、grader 日志 |

推荐让 runner 先从原始数据生成一份去敏的 `agent_input.json`，再启动 Agent；不要把完整 Hugging Face dataset 目录挂进 Agent 容器。评分阶段使用另一个进程或容器，将 Agent 的答案/patch 与私有 gold 数据重新 join。这样能从权限上防止泄漏，而不是只靠 prompt 说“不要查看答案”。

---

## 3. 面板 A：LongMemEval 长期对话记忆

### 3.1 数据来自哪里

LongMemEval 是一个长期聊天记忆基准。官方仓库发布 500 个问题，覆盖信息提取、跨会话推理、知识更新、时间推理和拒答；历史是带时间戳、由受控流程编译的聊天会话。[官方仓库](https://github.com/xiaowu0162/LongMemEval)

这些历史不是直接采集自某一批真实用户。官方的 custom-history 说明显示：背景属性用于生成问题、证据和模拟用户 session；用于填满长历史的 filler session 来自 ShareGPT 与 UltraChat。因此它是一套“有真实聊天语料成分、但由基准流水线控制证据位置和时间”的合成评测历史。[官方 Creating Custom Chat Histories](https://github.com/xiaowu0162/LongMemEval#-creating-custom-chat-histories)

官方当前提供：

- `longmemeval_s_cleaned.json`：500 题，单题约 40 个历史 session、拼接后约 115k token，适合 128k 长上下文实验。
- `longmemeval_m_cleaned.json`：500 题，单题约 500 个历史 session，主要用于更长记忆压力测试。
- `longmemeval_oracle.json`：只保留证据 session；适合测 reader 上限，不适合声称测了真实检索。

这些名称、下载地址、长度说明和测试入口见 [LongMemEval 官方 README](https://github.com/xiaowu0162/LongMemEval#data)。我们的主测试使用 `LongMemEval_S`，并固定具体 revision 和文件 SHA256。官方数据在 2025 年做过 cleaned 更新，因此不能只写“下载最新版”。[官方变更说明入口](https://github.com/xiaowu0162/LongMemEval)

下载示例：

```bash
git clone https://github.com/xiaowu0162/LongMemEval.git third_party/LongMemEval
cd third_party/LongMemEval
mkdir -p data
wget -O data/longmemeval_s_cleaned.json \
  https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json
shasum -a 256 data/longmemeval_s_cleaned.json
```

### 3.2 单题 schema 与任务类型

官方 schema 见 [LongMemEval README 的 Dataset Format](https://github.com/xiaowu0162/LongMemEval#dataset-format)：

```json
{
  "question_id": "...",
  "question_type": "temporal-reasoning",
  "question": "最终要问的问题",
  "answer": "参考答案或偏好 rubric",
  "question_date": "问题发生时间",
  "haystack_session_ids": ["s1", "s2"],
  "haystack_dates": ["...", "..."],
  "haystack_sessions": [
    [
      {"role": "user", "content": "..."},
      {"role": "assistant", "content": "...", "has_answer": true}
    ]
  ],
  "answer_session_ids": ["s2"]
}
```

`haystack_session_ids`、`haystack_dates`、`haystack_sessions` 是同位置对齐的数组。`has_answer` 与 `answer_session_ids` 是检索 recall 的 gold 标签；最终 QA 则用 `answer` 判断。不要把“找到了 gold session”当成“回答正确”。

六个 `question_type` 的人话解释：

| 类型 | 测什么 | 典型失败 |
|---|---|---|
| `single-session-user` | 回忆用户曾明确说过的事实 | 找错同名实体或被干扰 session 带偏 |
| `single-session-assistant` | 回忆助手以前给出的信息 | 只索引 user turn，漏掉 assistant turn |
| `single-session-preference` | 利用用户偏好生成合适回答 | 找到事实但没有真正个性化回答 |
| `multi-session` | 合并多个 session 才能回答 | 只召回一半证据 |
| `temporal-reasoning` | 根据事件日期、先后和间隔推理 | 语义相似但时间选错；天数 off-by-one |
| `knowledge-update` | 旧事实被新事实覆盖后使用最新版 | 把旧值和新值混在一起 |

如果 `question_id` 以 `_abs` 结尾，该题是 abstention：历史中没有所问信息，系统应明确说不知道。官方检索指标会跳过这 30 题，因为它们没有真实答案位置；但端到端 QA 评分应保留它们。[官方 README：Memory Retrieval](https://github.com/xiaowu0162/LongMemEval#memory-retrieval)

### 3.3 跑完整 500 题，还是抽 100 题

优先跑完整 500 题。这样不需要发明抽样规则，也能保留每类题的原始比例。

如果成本只允许约 100 题，应在看任何结果前生成并冻结分层 manifest：

1. 分层键设为 `(question_type, is_abstention)`；abstention 不要混入普通题。
2. 各层按原始占比分配 100 个名额，用 largest-remainder 补足舍入差额。
3. 每层按 `sha256(seed + question_id)` 排序，取前 `quota` 个；不要依赖 Python 版本可能变化的随机实现。
4. 输出 `question_id`、层、源文件 SHA256、seed 和抽样脚本 commit。
5. 所有 arm 和所有模型必须使用同一个 manifest。

伪代码：

```python
rows = load_json(source)
for row in rows:
    row["stratum"] = (row["question_type"], row["question_id"].endswith("_abs"))
quota = proportional_largest_remainder(count_by_stratum(rows), total=100)
sample = []
for stratum, group in groups(rows):
    ordered = sorted(group, key=lambda x: sha256(f"trajex-v1:{x['question_id']}"))
    sample.extend(ordered[:quota[stratum]])
write_manifest(sample)
```

无论使用 500 题还是 100 题子集，都必须让所有 arm 和模型共用同一 manifest。缺失、超时和 judge 错误保留为单独状态，不能悄悄改变不同模型的分母。

### 3.4 把 LongMemEval 历史转成可索引 session

为让 Trajex 原生索引历史，我们实现确定性的 LongMemEval → session JSONL converter。若目标 harness 使用 pi，则第一行是 session header，后续 entry 用 `id`/`parentId` 形成树，每条消息放在 `message` 字段；具体类型以 [pi 官方 session-format](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/session-format.md) 为准。

推荐每个 LongMemEval history session 对应一个独立 pi session 文件，而不是把 40 个会话合成一个文件。这样 `haystack_session_ids` 能稳定映射到索引 session，并保留日期边界：

```text
LongMemEval question
  ├─ history session s1 + date d1 -> pi session file 1
  ├─ history session s2 + date d2 -> pi session file 2
  └─ ...
```

转换规则：

- header 的 `id` 由 `question_id + haystack_session_id` 确定性生成。
- header/entry timestamp 使用对应 `haystack_dates[i]`，同一 session 内逐 turn 增加 1 ms，避免并列顺序不确定。
- user/assistant turn 原文不改写；保留角色。
- `has_answer` 只写入旁路 gold 文件，绝不能进入 Agent 可见 session。
- 每题使用独立 session root，跑完删除或换目录，防止上一题泄漏。
- 转换后断言 session 数、turn 数、文本 SHA256 与源数据一致，再运行 Trajex 索引构建命令。

最小伪代码：

```python
for item in selected_questions:
    root = run_root / item["question_id"] / "sessions"
    for sid, date, turns in zip(item["haystack_session_ids"],
                                item["haystack_dates"],
                                item["haystack_sessions"]):
        entries = [pi_header(stable_uuid(item["question_id"], sid), date)]
        parent = None
        for n, turn in enumerate(turns):
            entry = pi_message(turn["role"], turn["content"], date_plus_ms(date, n), parent)
            entries.append(entry)
            parent = entry["id"]
        write_jsonl(root / f"{sid}.jsonl", entries)
```

### 3.5 四个 arm：输入、操作、输出、比较点

每个 arm 的最终任务输入都包含同一个 `question` 和 `question_date`。区别只应是历史如何进入 Agent。

| arm | 历史输入 | Agent 能否主动检索 | 送进回答模型的内容 | 主要比较目的 |
|---|---|---:|---|---|
| `none` | 无 | 否 | 问题 | 测无记忆下的先验/猜测底线 |
| `full` | 原始全部历史 | 否 | 问题 + 按时间排列的全部 session | 测长上下文直接阅读上限与成本 |
| `rag_raw` | 原始历史的 400-token chunks | 否 | question embedding 的 top chunks，整题最多 4k token | 测一次性被动向量检索 |
| `trajex_active` | Trajex 索引原始 session | 是 | 开局不注入历史；Agent 自主查询，整题最多返回 4k token | 测主动、多轮、可过滤的检索 |

第一版不加入“LLM 提炼记忆”实验，避免把 distillation 模型质量混入 Trajex 检索效果。`rag_raw` 与 `trajex_active` 必须共享相同的 4k 整题可见检索预算；RAG 的 embedding revision、chunk overlap、top-k 和 tokenizer 必须写入 lock 文件。

每个 arm 应输出相同的回答字段：

```json
{"question_id":"...","hypothesis":"模型最终回答"}
```

这是 LongMemEval 官方 evaluator 接受的 JSONL 格式。[官方 Testing Your System](https://github.com/xiaowu0162/LongMemEval#testing-your-system)

实验系统还应另存不可交给 judge 的运行遥测：检索 query、命中 ID、snippet、输入输出 token、cache token、耗时、工具调用和错误。

### 3.6 固定 judge：怎么判断回答对不对

使用同一 judge 对所有模型、所有 arm 评分。官方脚本支持 `gpt-4o-2024-08-06`、temperature 0、最多输出 10 token，并按题型使用不同 rubric：普通题要求回答包含完整正确信息；时间题允许天数 off-by-one；knowledge-update 只要给出所需的新值即可；preference 看是否正确利用个人信息；abstention 看是否识别为不可回答。实现见官方 [`evaluate_qa.py`](https://github.com/xiaowu0162/LongMemEval/blob/main/src/evaluation/evaluate_qa.py)。

```bash
cd third_party/LongMemEval/src/evaluation
python evaluate_qa.py \
  gpt-4o \
  ../../../runs/longmemeval/trajex_active/hypotheses.jsonl \
  ../../data/longmemeval_s_cleaned.json

python print_qa_metrics.py \
  ../../../runs/longmemeval/trajex_active/hypotheses.jsonl.eval-results-gpt-4o \
  ../../data/longmemeval_s_cleaned.json
```

官方聚合器输出 overall accuracy、各 question type accuracy、task-averaged accuracy 和 abstention accuracy；源码见 [`print_qa_metrics.py`](https://github.com/xiaowu0162/LongMemEval/blob/main/src/evaluation/print_qa_metrics.py)。

建议加两项可靠性检查：

- 随机抽 10% 题做盲人工复核，报告 judge 与人工的一致率。
- Judge API 错误或非 yes/no 输出标记为 `judge_error` 并重试固定次数；最终仍失败则从“运行成功率”单列报告，不允许悄悄删除。

### 3.7 LongMemEval 应报告哪些指标

主指标：

- `QA accuracy = correct / manifest_total`，intent-to-treat，失败/超时计为 0。
- 各 `question_type` accuracy。
- abstention accuracy。
- 相对 `none` 的逐题配对差值与 95% CI。

诊断指标：

- session recall@k：top-k 是否命中任一 `answer_session_ids`。
- turn recall@k：是否命中 `has_answer: true` 的 turn。
- Trajex uptake：至少调用一次搜索的任务比例。
- query 次数、空结果率、每次返回字符/token、中位/95 分位。
- “调用过 Trajex”和“未调用”的条件正确率；这只是机制诊断，不替代 intent-to-treat 主结果。
- 每题模型输入、未缓存输入、缓存读取、输出、judge token 和墙钟时间。

检索 recall 与端到端 QA 必须分开：前者只说明证据进入候选，后者才说明 Agent 使用证据回答成功。

若要与 LongMemEval 官方 retrieval baseline 对齐，直接运行官方 [`print_retrieval_metrics.py`](https://github.com/xiaowu0162/LongMemEval/blob/main/src/evaluation/print_retrieval_metrics.py)：session 粒度报告 `recall_all@5/10` 与 `ndcg_any@5/10`，turn 粒度还报告 `@50`；`_abs` 题不进入检索分母。不要另造一个“命中任一证据的 recall@5”后仍称其为官方指标。

---

## 4. 面板 B：SWE-bench 失败后重试

### 4.1 目的

这个面板测的不是“其他 Agent 的历史能否帮助当前 Agent”，而是一个更直接的问题：

> 同一 Agent 第一次修复失败后，Trajex 能否让第二次尝试有效利用自己的失败记录，减少重复踩坑，并最终通过官方测试？

每个测试任务都有两个阶段：

1. `attempt_1`：不给历史记忆，正常运行 Agent；保存完整 session、命令、工具结果和最终 patch。
2. `attempt_2`：仓库恢复到同一个 `base_commit`，开一个全新 Agent session；不同 arm 以不同方式提供同一份 `attempt_1` 失败记录。

只有 `attempt_1` 经官方测试确认失败的任务，才进入 retry manifest。筛选必须在运行任何 `attempt_2` arm 之前完成并冻结。

### 4.2 SWE-bench 的输入与官方评分

SWE-bench 将真实 GitHub issue 变成软件修复任务：Agent 获得 `base_commit` 上的仓库和 `problem_statement`，输出代码 patch；grader 在隔离的 Docker 环境中应用 patch 并运行官方测试。[官方仓库](https://github.com/SWE-bench/SWE-bench)与[官方 Evaluation Guide](https://www.swebench.com/SWE-bench/guides/evaluation/)

单条数据的关键字段是：

```json
{
  "instance_id": "owner__repo-123",
  "repo": "owner/repo",
  "base_commit": "commit-sha",
  "problem_statement": "Agent 可以看到",
  "patch": "gold solution，Agent 禁止查看",
  "test_patch": "grader 私有",
  "FAIL_TO_PASS": ["原先失败、修复后必须通过的测试"],
  "PASS_TO_PASS": ["原先通过、修复后仍必须通过的测试"]
}
```

加载数据时固定 revision：

```python
from datasets import load_dataset

tasks = load_dataset(
    "princeton-nlp/SWE-bench",
    split="test",
    revision="<PIN_ME>",
)
```

官方评分不比较 patch 文本。它实际运行测试：

- `FAIL_TO_PASS = 1`：针对原 bug 的测试全部从失败变为通过。
- `PASS_TO_PASS = 1`：原本正常的测试仍然全部通过。
- 两者都等于 1，任务才记为 `resolved=true`。

评分实现见 SWE-bench 官方 [`grading.py`](https://github.com/SWE-bench/SWE-bench/blob/main/swebench/harness/grading.py)。

### 4.3 如何生成冻结的 retry manifest

推荐先从 20～50 个成本可接受的 SWE-bench 实例开始。流程如下：

1. 预先冻结候选 `instance_id`、模型、prompt、Agent harness、最大轮数与超时。
2. 对每个候选只运行一次 `attempt_1`。
3. 导出 patch，用官方 harness 评分。
4. 将 `resolved=false` 的任务写入 `swe-retry.jsonl`。
5. 为每条失败 session 保存 SHA256；后续所有 arm 必须使用同一份 session。
6. 冻结 manifest 后，才开始运行 `attempt_2`。

manifest 示例：

```json
{
  "instance_id": "django__django-12345",
  "repo": "django/django",
  "base_commit": "...",
  "attempt_1_session": "artifacts/attempt-1/session.jsonl",
  "attempt_1_session_sha256": "...",
  "attempt_1_patch": "artifacts/attempt-1/model.patch",
  "failure_type": "tests_failed",
  "image_digest": "sha256:..."
}
```

不要根据 `attempt_2` 的结果再删题或定义“hard subset”。如果需要难度分层，应在第二轮运行前根据固定规则定义，例如第一次失败可稳定复现、执行步数或测试时长。

### 4.4 四个 retry arms

四个 arm 都使用完全相同的失败 session、问题描述、模型、仓库状态和预算：

| arm | 第二次尝试看到什么 | 检索方式 | 目的 |
|---|---|---|---|
| `none` | 只有原任务描述和干净仓库 | 无 | 测单纯再试一次的自然成功率 |
| `full` | 原任务描述 + 完整 `attempt_1` 记录 | 无，直接注入 | 测完整失败记录是否有帮助，以及上下文成本 |
| `rag_raw` | 原任务描述 + 从失败记录切出的相关 chunks | 一次被动检索，整题最多 4k token | 测普通 RAG |
| `trajex_active` | 原任务描述；Trajex 索引完整失败 session | Agent 自主多轮查询，整题最多返回 4k token | 测 Trajex 主动检索 |

第一版不加入 distillation，也不加入其他 Agent 的仓库级历史。这样唯一被测记忆就是当前 Agent 自己的第一次失败过程。

`rag_raw` 与 `trajex_active` 必须共享相同的整题可见检索 token 预算。`trajex_active` 还要强制执行每次最大命中数、单条 snippet 长度和累计返回上限，防止完整工具日志淹没上下文。

### 4.5 单个任务的完整运行流程

```python
# 第一轮：生成失败记录
for task in candidate_manifest:
    container = fresh_container(task.image_digest)
    checkout(container, task.base_commit)
    first = run_agent(task.problem_statement, memory=None)
    first_patch = git_diff(container)
    first_grade = grade_with_swebench(task, first_patch)
    save_attempt_1(task, first, first_patch, first_grade)

freeze_retry_manifest(only_unresolved_attempt_1)

# 第二轮：比较四种记忆方式
for task in retry_manifest:
    for arm in deterministic_random_arm_order(task):
        container = fresh_container(task.image_digest)
        checkout(container, task.base_commit)
        assert_clean_tree(container)

        memory = prepare_retry_arm(
            arm=arm,
            failed_session=task.attempt_1_session,
            visible_retrieval_budget=4000,
        )
        second = run_agent(task.problem_statement, memory=memory)
        patch = git_diff(container)
        write_prediction(task.instance_id, arm, patch)
        write_run_json(task, arm, second, patch)

# 独立 grader 阶段
run_official_swebench_harness(all_predictions)
merge_grader_reports_into_runs()
```

每个 arm 必须从全新容器和同一个 `base_commit` 开始。不要在同一 working tree 上依次运行四个 arm。arm 顺序按 task ID 确定性随机化，减少 API 负载或时间漂移固定偏向某个 arm。

Agent 预测文件格式：

```json
{"instance_id":"django__django-12345","model_name_or_path":"provider/model","model_patch":"diff --git ..."}
```

官方评分命令：

```bash
git clone https://github.com/SWE-bench/SWE-bench.git third_party/SWE-bench
pip install -e third_party/SWE-bench

python -m swebench.harness.run_evaluation \
  --dataset_name princeton-nlp/SWE-bench \
  --predictions_path runs/swe-retry/predictions.jsonl \
  --run_id trajex-swe-retry-v1 \
  --max_workers 8
```

正式运行前先用 gold patch 验证 Docker、依赖和测试解析器能够工作；gold 产物不能留在被测 Agent 容器中。

### 4.6 附加诊断指标

除 `resolved rate` 外，还应记录：

- dead-end repetition rate：第二次尝试是否原样重复第一次已失败的命令。
- changed-strategy rate：第二次是否改查了不同文件、运行了不同测试或采用不同修复位置。
- time-to-first-useful-evidence：首次检索到后来实际用于修改的文件/结论需要多久。
- Trajex uptake：第二次运行中至少调用一次 Trajex 的比例。
- query 次数、空结果率、每次/整题返回 token、p50/p95。
- patch apply failure、Agent timeout、grader error 和污染失败。

命令重复应先做确定性规范化，例如去除首尾空白、合并连续空格，但不要使用语义相似度主观判定。

### 4.7 隔离与防泄漏

Agent 只能看到 `problem_statement`、`base_commit` 上的仓库，以及当前 arm 允许提供的 `attempt_1` 内容。以下内容始终由 grader 私有：

- gold `patch` 与 `test_patch`。
- `FAIL_TO_PASS` / `PASS_TO_PASS` 测试名单。
- 第一次评分的详细 gold 对照信息。
- `base_commit` 之后的 git history、tags 和 remotes。
- 宿主机中的 SWE-bench dataset、grader 日志和其他 arm 产物。

推荐禁用 Agent 容器外网、删除 git remotes/tags，并让 runner 在每次启动时保存污染检查报告。

---
## 5. 统一输出：每次运行一行 JSONL

两个面板共用 `runs.jsonl`。字段不适用时填 `null`，不要让不同 runner 各自发明一套输出。

```json
{
  "experiment_id": "trajex-memory-eval-v1",
  "panel": "longmemeval|swe_retry",
  "task_id": "...",
  "repo": "django/django",
  "arm": "trajex_active",
  "replicate": 0,
  "dataset_revision": "...",
  "manifest_sha256": "...",
  "model": "provider/exact-version",
  "temperature": 0,
  "reasoning_effort": "xhigh",
  "prompt_sha256": "...",
  "memory_source_sha256": "...",
  "started_at": "...",
  "wall_ms": 123456,
  "status": "ok|agent_timeout|agent_error|grader_error|contaminated",
  "answer": "LongMemEval only",
  "qa_correct": true,
  "model_patch": "SWE retry only",
  "resolved": true,
  "f2p_passed": 3,
  "f2p_total": 3,
  "p2p_passed": 128,
  "p2p_total": 128,
  "tool_calls": 57,
  "trajex_calls": 3,
  "trajex_nonempty_calls": 3,
  "retrieved_items": 11,
  "retrieved_tokens_visible": 3760,
  "tokens": {
    "input_total": 1597965,
    "input_uncached": 30054,
    "cache_read": 1567911,
    "output": 29594,
    "judge_input": 0,
    "judge_output": 0
  },
  "cost_usd": null,
  "artifact_paths": {
    "events": "...",
    "transcript": "...",
    "prediction": "...",
    "grader_report": "...",
    "contamination_report": "..."
  }
}
```

另存 `retrieval_events.jsonl`，每次查询一行：

```json
{
  "task_id": "...",
  "arm": "trajex_active",
  "step": 12,
  "query": "...",
  "filters": {"after": null, "before": null},
  "hit_ids": ["..."],
  "returned_chars": 1830,
  "returned_tokens": 470,
  "latency_ms": 38
}
```

只有保存逐查询事件，才能检查 uptake、空检索、上下文 flooding、时间过滤和预算是否真的按设计执行。

失败处理采用 intent-to-treat：

- manifest 中的所有任务都进入主指标分母。
- Agent 超时、空 patch、patch 无法应用和测试未完成记为失败。
- 同时单列报告各类运行错误，避免把基础设施问题误判为模型能力。
- `contaminated` 运行作废；修复环境后按预注册规则重跑。

---

## 6. 怎么比较

### 6.1 主指标

LongMemEval：

- overall QA accuracy。
- 各 `question_type` accuracy。
- abstention accuracy。
- `trajex_active - none` 的逐题配对准确率差。
- `trajex_active - rag_raw` 的逐题配对准确率差。

SWE retry：

- `attempt_2 resolved rate`。
- `trajex_active - none` 的逐任务配对成功率差。
- `trajex_active - rag_raw` 的逐任务配对成功率差。
- `attempt_1 → attempt_2` 的 dead-end repetition rate 变化。

主比较必须在运行前写入 `experiment.lock.json`；其他 arm 间比较标为 exploratory。

### 6.2 配对统计

对任意 arm A 与 arm B，每个任务形成一对二元结果：

- `b`：A 成功、B 失败。
- `c`：A 失败、B 成功。
- 配对差值：`(b - c) / n`。
- McNemar exact p-value：只使用 `b + c` 个不一致任务。

95% CI 必须标明算法：

- 单次运行：对 task 做 paired bootstrap，至少 10,000 次。
- 多 replicate：按 task 做 cluster bootstrap，不能把同一任务的重复运行当独立样本。
- 同时报告 `b/c`，让读者知道真正提供比较信号的任务数。

不要只在“不同 arms 结果不一致”的任务上报告主成功率；这类子集只能用于诊断，正式分母仍是冻结 manifest。

### 6.3 重复次数

temperature 0 不等于完全确定。模型服务、工具时序和环境都可能引入变化：

- 冒烟测试：每题每 arm 1 次，用于检查 runner。
- 正式低成本实验：每题每 arm 至少 3 次。
- 如果只能跑 1 次，结论应标为方向性结果，不声称稳定提升。

每个 replicate 使用相同任务和预算，但独立 Agent session、干净工作区及明确的 replicate ID。

### 6.4 成本与工具使用

效果和成本一起报告。每个 arm 至少给出中位数与 p95：

- cumulative input、uncached input、cache read、output token。
- Agent tool calls、Trajex calls、检索响应 token。
- 墙钟时间、模型费用、embedding 建库费用。
- cost per correct answer / resolved task。
- 相对 `none` 的增量成本与增量成功。

Trajex uptake 定义为 `trajex_calls >= 1` 的运行比例。未调用 Trajex 的运行仍保留在主分析里；只统计调用过的任务会产生选择偏差，只能作为机制诊断。

---

## 7. 推荐目录

```text
eval/
├── README.md
├── configs/
│   ├── experiment.lock.json
│   ├── arms.json
│   └── prompts/
│       ├── agent-system.md
│       ├── trajex-skill.md
│       └── longmemeval-answer.md
├── manifests/
│   ├── longmemeval-500.jsonl
│   ├── longmemeval-100-stratified.jsonl
│   ├── swe-candidates.jsonl
│   └── swe-retry.jsonl
├── prepare/
│   ├── download_and_hash.sh
│   ├── sample_longmemeval.py
│   ├── longmemeval_to_sessions.py
│   ├── freeze_swe_retry.py
│   └── contamination_audit.py
├── run/
│   ├── run_longmemeval.py
│   ├── run_swe_attempt_1.py
│   └── run_swe_retry.py
├── score/
│   ├── score_longmemeval.sh
│   ├── export_swe_predictions.py
│   └── analyze_paired.py
├── cache/
│   └── embeddings/
└── runs/<experiment_id>/
    ├── runs.jsonl
    ├── retrieval_events.jsonl
    ├── predictions.jsonl
    ├── judge.jsonl
    ├── reports/
    └── artifacts/<task>/<arm>/<replicate>/
```

建议运行顺序：

```bash
# 1. 下载、固定 revision 和 SHA256
bash eval/prepare/download_and_hash.sh

# 2. 生成 LongMemEval manifest
python eval/prepare/sample_longmemeval.py --all-500

# 3. 运行 SWE 第一轮并冻结失败任务
python eval/run/run_swe_attempt_1.py --config eval/configs/experiment.lock.json
python eval/prepare/freeze_swe_retry.py
python eval/prepare/contamination_audit.py

# 4. 跑两类测试的所有 task × arm × replicate
python eval/run/run_longmemeval.py --config eval/configs/experiment.lock.json
python eval/run/run_swe_retry.py --config eval/configs/experiment.lock.json

# 5. 官方评分
bash eval/score/score_longmemeval.sh
python eval/score/export_swe_predictions.py
python -m swebench.harness.run_evaluation \
  --dataset_name princeton-nlp/SWE-bench \
  --predictions_path eval/runs/<id>/predictions.jsonl \
  --run_id <id> \
  --max_workers 8

# 6. 配对统计
python eval/score/analyze_paired.py --runs eval/runs/<id>/runs.jsonl
```

---

## 8. 实现完成标准

在正式报告结果前，以下产物必须齐全：

- 固定 revision 和 SHA256 的 LongMemEval、SWE-bench 数据说明。
- `experiment.lock.json`、全部 prompts 和 Trajex commit。
- 冻结的 LongMemEval manifest、SWE candidate manifest、SWE retry manifest。
- 每个 task × arm × replicate 的 `runs.jsonl` 记录。
- 每次 Trajex/RAG 查询的 `retrieval_events.jsonl`。
- LongMemEval judge 原始输出。
- SWE-bench prediction patch 与官方 grader report。
- Agent 原始事件流、最终 transcript 和污染检查报告。
- 可从头运行的命令，以及失败后断点续跑规则。

如果其中任一项缺失，仍可以做内部探索，但不应称为可复现的正式 eval。

## 9. 最小但可信的第一版

预算有限时，先跑下面这版：

1. LongMemEval_S 完整 500 题；比较 `none`、`full`、`rag_raw`、`trajex_active`。
2. 预先选择 20～50 个 SWE-bench candidate；第一轮失败项进入 retry manifest。
3. SWE retry 比较相同四个 arms。
4. `rag_raw` 和 `trajex_active` 共享整题 4k 可见检索 token 预算。
5. 每题每 arm 跑 3 次；以 task 为单位做 paired/cluster bootstrap。
6. 发布 lock、manifest、prompts、逐运行 JSONL、patch、judge 输出、grader report 和污染报告。

这两类测试分别回答：

- Trajex 能不能从长期聊天中找出并使用正确事实？
- Trajex 能不能帮助同一个 Agent 利用上一次失败经验，把第二次尝试做得更好？
