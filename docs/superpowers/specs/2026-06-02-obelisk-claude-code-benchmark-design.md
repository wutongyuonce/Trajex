# Obelisk Claude Code Benchmark Design

## Goal

Build a real SkillOpt benchmark for Obelisk where Claude Code is the target agent. The benchmark should train and evaluate `SKILL.md` as operational guidance for querying Obelisk, not as a mock prompt exercise.

The target agent should read the current candidate skill, write an Obelisk query script, run the local Obelisk runtime, and answer with evidence. SkillOpt should then optimize the skill document based on actual successes and failures.

## Scope

The first version is a tiny real benchmark with 8-12 items drawn from observed Claude Code usage of Obelisk. It should run against the local Obelisk database and runtime, using `claude_code_exec` as the target backend.

Out of scope for the first version:

- Mock-only rollout.
- External memory services or daemon processes.
- LLM-generated summaries as benchmark ground truth.
- Broad benchmark packaging for other machines.

## Benchmark Shape

Add a new SkillOpt environment:

```text
skillopt/envs/obelisk_query/
  __init__.py
  adapter.py
  dataloader.py
  rollout.py
  evaluator.py
  prompts/
    analyst_error.md
    analyst_success.md
  skills/
    initial.md

configs/obelisk_query/
  claude_code_tiny.yaml

data/obelisk_query_tiny/
  train/items.json
  val/items.json
  test/items.json
```

The SkillOpt registry should import `ObeliskQueryAdapter` from the new environment under the key `obelisk_query`.

## Item Format

Each item describes a real Obelisk query task plus deterministic scoring hints:

```json
{
  "id": "recent-failures-by-task",
  "task_type": "failure_investigation",
  "question": "找出最近失败的 tool calls，它们分别发生在哪些任务里",
  "must_include": ["tool", "session", "task"],
  "must_use": ["failures", "LIMIT"],
  "forbid": ["thread("],
  "max_result_chars": 12000,
  "expected_facts": ["kairos", "vitest"]
}
```

Fields:

- `question`: the user-facing task for Claude Code.
- `task_type`: category used for score breakdowns and reflection.
- `must_include`: answer-level concepts that should appear.
- `must_use`: query or trace-level markers that should appear in generated artifacts.
- `forbid`: query or trace-level anti-patterns.
- `expected_facts`: facts that should appear in the final answer when stable enough.
- `max_result_chars`: upper bound for the serialized runtime result or answer payload.

## Initial Scenarios

Seed the first split from observed Obelisk usage:

- `development_history`: "关于 obelisk 我们都做了什么，过程中遇到了什么问题？"
- `failure_investigation`: "找出最近失败的 tool calls，它们分别发生在哪些任务里"
- `summary_context`: "你能看到最近的 summary 消息吗"
- `summary_neighbors`: "那你可以看到 summary 前后的消息吗"
- `project_sessions`: "列出 quiet-zero 最近的 session，包括 id 和简要描述"
- `concept_recall`: "查找 dynamic-tasktree 相关旧讨论，说明它是什么"
- `workflow_recall`: "Find sessions where we discussed workflow-script"
- `aggregate_report`: "按照网易云音乐周听歌榜单的方式评价这周 coding 记录"
- `bounded_query_safety`: "找 quiet-zero 相关 summary，但不要返回过大的结果"
- `schema_robustness`: "统计某项目最近 tool calls，不要猜不存在的 timestamp 列"

## Rollout

For each item:

1. Create an isolated work directory under the SkillOpt prediction directory.
2. Render the current candidate skill as `.agents/skills/skillopt-target/SKILL.md`.
3. Write `task.md` with:
   - the query task,
   - the required output contract,
   - the absolute path to the Obelisk runtime,
   - a reminder to write bounded query scripts.
4. Run Claude Code through SkillOpt's existing `claude_code_exec` harness.
5. Require the target to write:
   - `query.mjs`,
   - `answer.json`.
6. Persist:
   - Claude raw trace,
   - generated query,
   - runtime stdout/stderr,
   - parsed answer,
   - scoring report.

The output contract should ask for JSON:

```json
{
  "answer": "plain-language answer",
  "evidence": [
    {
      "type": "session|message|tool_call|summary|workflow",
      "id": "stable identifier",
      "title": "optional title",
      "snippet": "short supporting text"
    }
  ],
  "query_notes": "brief explanation of retrieval strategy"
}
```

## Scoring

`evaluator.py` returns `hard` and `soft`.

Hard pass requires:

- `answer.json` exists and parses.
- The answer includes required facts or concepts for the item.
- At least one evidence entry has a concrete identifier.
- No forbidden query pattern appears.
- Runtime result and final answer stay below `max_result_chars`.

Soft score combines:

- answer fact coverage,
- evidence/provenance quality,
- bounded-query hygiene,
- query execution success,
- avoidance of anti-patterns.

Anti-patterns:

- `thread(` without an item explicitly allowing full session dumps.
- `summaries()` with no filter or limit.
- SQL without `LIMIT` for exploratory list queries.
- full-session or all-project result dumps.
- schema guesses that cause runtime errors.

## Config

`configs/obelisk_query/claude_code_tiny.yaml` should default to a small, low-cost run:

```yaml
env:
  name: obelisk_query
  skill_init: /Users/tomiya/Code/quiet-zero/SKILL.md
  split_mode: split_dir
  split_dir: data/obelisk_query_tiny
  obelisk_runtime: /Users/tomiya/Code/quiet-zero/scripts/runtime.mjs
  exec_timeout: 180
  workers: 1

model:
  optimizer_backend: openai_chat
  target_backend: claude_code_exec

train:
  num_epochs: 1
  train_size: 8
  batch_size: 2

gradient:
  analyst_workers: 1
  minibatch_size: 1
  merge_batch_size: 1

optimizer:
  learning_rate: 1
  min_learning_rate: 1
  lr_scheduler: constant
  use_slow_update: false
  use_meta_skill: false

evaluation:
  use_gate: false
  eval_test: false
```

## Verification

Minimum verification before calling it complete:

1. `uv run python scripts/train.py --help` works in SkillOpt.
2. `uv run python scripts/eval_only.py --config configs/obelisk_query/claude_code_tiny.yaml --skill /Users/tomiya/Code/quiet-zero/SKILL.md --split train --test_env_num 1` runs one item.
3. A one-step training command starts and writes `outputs/obelisk_claude_tiny/best_skill.md`.
4. Generated artifacts include `query.mjs`, `answer.json`, and a score report for at least one task.

## Open Risk

This benchmark depends on local Claude Code history, so the first version is intentionally local and personal. Later packaging can add a fixture Obelisk database, but that should be a separate step.
