# Trajex Eval

目标：为 Trajex 建立一套可运行、可审计的 Agent 记忆评测。

评测按类型分目录：`eval/longmemeval/` 放长期聊天历史问答的脚本和 lock；`eval/locomo/` 放跨会话记忆问答的脚本和 lock；`eval/swe-retry/` 放软件修复重试的脚本和 lock；本文件保留三类测试的操作说明。

有如下三类测试：

| 面板           | 任务                        | 核心问题                                      | 主指标               |
| -------------- | --------------------------- | --------------------------------------------- | -------------------- |
| A：LongMemEval | 读长期聊天历史后回答问题    | 记忆系统能否找到并正确使用旧信息？            | 最终回答正确率       |
| B：LoCoMo      | 读多轮多会话历史后回答问题  | 记忆系统能否跨 session 整合人物、事件和时间线？ | 官方问答 F1          |
| C：SWE retry   | 同一 Agent 第一次失败后重做 | Trajex 能否帮助第二次尝试利用失败经验并修好？ | 官方测试是否全部通过 |

统一的因果变量是“记忆 arm”。模型、任务、初始仓库、Agent harness、预算和评分器应尽量保持不变。每个任务都要在每个 arm 上跑一次，这样结果可以按任务配对比较，而不是只比较两个互不相关的平均数。

## [LongMemEval](https://github.com/xiaowu0162/LongMemEval)：读取长期聊天历史后回答问题

> **要直接运行测试，可跳转至** [正式实验：一份 lock、一个命令](#正式)

LongMemEval 是一个长期聊天记忆基准。官方仓库发布 500 个问题，覆盖信息提取、跨会话推理、知识更新、时间推理和拒答；历史是带时间戳、由受控流程编译的聊天会话。

官方当前提供：

- `longmemeval_s_cleaned.json`：500 题，单题约 40 个历史 session、拼接后约 115k token，适合 128k 长上下文实验。
- `longmemeval_m_cleaned.json`：500 题，单题约 500 个历史 session，主要用于更长记忆压力测试。
- `longmemeval_oracle.json`：只保留证据 session；适合测 reader 上限，不适合声称测了真实检索。

这些名称、下载地址、长度说明和测试入口见 [LongMemEval 官方 README](https://github.com/xiaowu0162/LongMemEval#data)。我们的主测试使用 `LongMemEval_S`，并固定具体 revision 和文件 SHA256。官方数据在 2025 年做过 cleaned 更新，因此不能只写“下载最新版”。

单题 schema：

```json
{
  "question_id": "sample_temporal_001",
  "question_type": "temporal-reasoning",
  "question": "我去上海旅行后多久开始学习摄影？",
  "answer": "大约两周后",
  "question_date": "2025-06-01",
  "haystack_session_ids": [
    "session-001",
    "session-002",
    "session-003"
  ],
  "haystack_dates": [
    "2025-01-03",
    "2025-03-10",
    "2025-03-24"
  ],
  "haystack_sessions": [
    [
      {
        "role": "user",
        "content": "我最近在考虑换一把机械键盘。"
      },
      {
        "role": "assistant",
        "content": "你更喜欢什么轴体？"
      }
    ],
    [
      {
        "role": "user",
        "content": "我昨天刚结束上海旅行，拍了很多照片。",
        "has_answer": true
      },
      {
        "role": "assistant",
        "content": "听起来这次旅行很愉快。"
      }
    ],
    [
      {
        "role": "user",
        "content": "我今天正式开始学习摄影了。",
        "has_answer": true
      },
      {
        "role": "assistant",
        "content": "可以先从构图和曝光三要素开始。"
      }
    ]
  ],
  "answer_session_ids": [
    "session-002",
    "session-003"
  ]
}
```

这条数据表示：

* 最终问题是：上海旅行后多久开始学摄影？
* `session-001` 是干扰信息。
* `session-002` 说明旅行约在 3 月 9 日结束。
* `session-003` 说明 3 月 24 日开始学摄影。
* 结合两个 session，答案约为两周。
* `has_answer` 和 `answer_session_ids` 是评分用的标准答案位置，不能让被测 Agent 看到。

六个 `question_type` 的解释：

| 类型                        | 测什么                         | 典型失败                              |
| --------------------------- | ------------------------------ | ------------------------------------- |
| `single-session-user`       | 回忆用户曾明确说过的事实       | 找错同名实体或被干扰 session 带偏     |
| `single-session-assistant`  | 回忆助手以前给出的信息         | 只索引 user turn，漏掉 assistant turn |
| `single-session-preference` | 利用用户偏好生成合适回答       | 找到事实但没有真正个性化回答          |
| `multi-session`             | 合并多个 session 才能回答      | 只召回一半证据                        |
| `temporal-reasoning`        | 根据事件日期、先后和间隔推理   | 语义相似但时间选错；天数 off-by-one   |
| `knowledge-update`          | 旧事实被新事实覆盖后使用最新版 | 把旧值和新值混在一起                  |

### 运行前准备<a id="准备"></a>

以下命令都假定你已经 `cd` 到 **Trajex 项目根目录**（也就是能看到 `eval/`、`packages/`、`package.json` 的目录），不要进入 `eval/` 后再运行。只有安装官方 judge 依赖时会临时 `cd third_party/LongMemEval`，完成后会回到项目根目录。我们约定的本地位置是：

```text
Trajex/                                      # 项目根目录；所有命令从这里运行
├── eval/
│   ├── longmemeval/
│   │   ├── experiment.lock.json              # 你从 example 复制并填写的正式配方
│   │   ├── experiment.lock.json.example      # 正式配方示例
│   │   ├── experiment.smoke-10.lock.json     # 10 题、Pi judge 的 smoke 示例
│   │   └── runs/longmemeval/<run-id>/         # 每次总脚本新建的独立结果包
│   │       ├── experiment.lock.json           # 当时配方的快照
│   │       ├── manifest.jsonl                 # 本次实际抽到的题
│   │       ├── work/                          # 转换出的隔离 Pi histories / Trajex 索引
│   │       ├── none.jsonl / *.telemetry.jsonl # 每个 arm 的回答与用量
│   │       └── summary.md                     # 四 arm 最终对比表
│   └── swe-retry/
└── third_party/
    └── LongMemEval/
        ├── data/longmemeval_s_cleaned.json  # 官方数据；Pi/official judge 都需要
        └── src/evaluation/                  # 官方 Python judge；仅 official judge 需要
```

正式跑 LongMemEval 前，先准备下面几项；它们是外部程序或凭据，不能由 lock 自动安装或保存。

1. **Node.js、uv 与 Trajex CLI。**本仓库的 CLI 要求 Node.js `>=22.13.0`；若使用官方 Python judge，还需要 [uv](https://docs.astral.sh/uv/) 管理其隔离环境。安装/构建 Trajex 后，保证 `trajex` 在 `PATH` 中；发布版可执行：

   ```bash
   # 安装 uv（macOS/Linux）；Windows 或其他安装方式见 uv 官方文档。
   curl -LsSf https://astral.sh/uv/install.sh | sh
   
   npm install --global @trajex-apps/cli
   node --version
   uv --version
   trajex --version
   ```

   只使用 `judge.kind: "pi"` 时，uv 不参与运行；但安装它不影响 Pi judge，之后切换到 `official` judge 时即可直接创建 Python 环境。

2. **Pi CLI 与其模型凭据。**安装 Pi 的 coding-agent CLI（官方包为 `@earendil-works/pi-coding-agent`），并按 [Pi 文档](https://pi.dev) 为你要写入 lock 的 `pi.model` 配好 provider 登录/API key。最低检查是：

   ```bash
   npm install --global @earendil-works/pi-coding-agent
   pi --version
   ```

   评测 runner 不替 Pi 配置模型凭据；`pi.model` 必须是这台机器上 Pi 实际能调用的模型名。Pi 会以启动它的用户权限执行 `trajex_active` 中的 bash，因此只在可信的评测目录运行。

3. **LongMemEval 数据与官方 judge。**克隆官方仓库、下载 `LongMemEval_S` 数据，并用 `uv` 创建仅运行官方 judge 所需的轻量 Python 环境。只使用 `judge.kind: "pi"` 时不必真的运行这一步，但提前准备好不影响后续切到 `official` judge：

   ```bash
   # 把 LongMemEval 官方仓库克隆到当前 Trajex 项目的 third_party/LongMemEval。
   # 其中包含官方 judge 脚本和 Python 依赖清单。
   git clone https://github.com/xiaowu0162/LongMemEval.git third_party/LongMemEval
   
   # 进入刚克隆的官方仓库。
   cd third_party/LongMemEval
   
   # 用 uv 创建项目内隔离的 Python 3.9 环境。
   # 只安装评分所需依赖，不安装复现官方记忆方法需要的 PyTorch/CUDA 大依赖。
   uv venv --python 3.9
   
   # 安装官方 judge（evaluate_qa.py）运行所需的最小 Python 依赖。
   uv pip install --python .venv/bin/python -r requirements-lite.txt
   
   # 创建数据目录；已存在也不会报错。
   mkdir -p data
   
   # 从 Hugging Face 下载清洗后的 LongMemEval_S 数据集。
   # -L 表示遇到重定向时继续跟随；-o 指定保存为 data/longmemeval_s_cleaned.json。
   curl -L -o data/longmemeval_s_cleaned.json \
     https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json
   ```


4. **复制 `eval/longmemeval/experiment.lock.json.example` 为自己的 `eval/longmemeval/experiment.lock.json`。**

   ```json
   // experiment.lock.json.example，_comment 为注释，实际代码中没有，可以直接复制
   {
     "_comment": "复制为 experiment.lock.json 后按需修改。_comment 仅供说明，runner 会忽略它；不要把 API key 写入此文件。",
     "longmemeval": {
       "_comment": "LongMemEval 这一类评测的固定配方。所有相对路径均相对于本 lock 文件所在目录，可改为绝对路径。",
       "input": "../../third_party/LongMemEval/data/longmemeval_s_cleaned.json",
       "_comment_input": "必填。官方 LongMemEval_S 数据文件；正式实验固定下载 revision 后不要中途替换。",
       "manifest": "manifest.jsonl",
       "_comment_manifest": "必填。自动生成的抽题清单、相对于每个 run bundle；可改成 bundle 内的子路径，不能使用 ../ 或绝对路径。",
       "work": "work",
       "_comment_work": "必填。自动生成的 Pi session 与 Trajex 索引工作目录、相对于每个 run bundle；可改成 bundle 内的子路径。",
       "runs": "runs/longmemeval",
       "_comment_runs": "必填。所有 run bundle 的根目录、相对于本 lock 文件；每次实验会在其下新建独立 run-id 子目录，不会覆盖其他 run。",
       "sample": {
         "_comment": "必填。固定本次抽哪些题；改动任一值就代表一次不同实验。",
         "size": 500,
         "_comment_size": "必填，可改。抽题数量；开发建议 10，LongMemEval_S 正式完整评测为 500，不能超过数据集题数。",
         "seed": "trajex-v1",
         "_comment_seed": "必填，可改。确定性抽样种子；相同数据、size 和 seed 会选出相同题目。"
       },
       "pi": {
         "_comment": "Pi Agent 配置。",
         "model": "<Pi model name>",
         "_comment_model": "必填，替换成 Pi 可用的精确模型名；四个 arm 必须相同。",
         "command": "pi",
         "_comment_command": "可选，默认就是 pi。若 Pi 不在 PATH，可填可执行文件的相对或绝对路径。"
       },
       "arms": ["none", "full", "rag_raw", "trajex_active"],
       "_comment_arms": "可选，省略时默认这四个 arm。正式实验保留全部；开发可暂时只填 [\"none\"]。包含 rag_raw 时运行命令必须带 --embedding-api-key。",
       "trajex_command": "trajex",
       "_comment_trajex_command": "可选，仅 trajex_active 使用，默认就是 trajex。若 Trajex 不在 PATH，可填可执行文件路径。",
       "embedding": {
         "_comment": "仅 arms 包含 rag_raw 时必填。",
         "base_url": "https://<WorkspaceId>.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
         "_comment_base_url": "百炼 OpenAI-compatible endpoint；替换 <WorkspaceId>。若用 OpenAI，改为 https://api.openai.com/v1。API key 不放这里，运行时通过 --embedding-api-key 传入。",
         "model": "text-embedding-v4",
         "_comment_model": "可选，默认 text-embedding-v4（百炼）。若用 OpenAI，改为 text-embedding-3-large 或 text-embedding-3-small。"
       },
       "judge": {
         "_comment": "LongMemEval 官方 judge 配置；所有 arm 必须使用同一个 judge model。",
         "kind": "official",
         "_comment_kind": "可选，默认 official。填 pi 时复用上方 pi.model 和 pi.command 作为 judge，不需要本对象其余字段，也不再是官方 OpenAI judge。",
         "evaluator_dir": "../../third_party/LongMemEval/src/evaluation",
         "_comment_evaluator_dir": "必填。LongMemEval 仓库中 evaluate_qa.py 和 print_qa_metrics.py 所在目录；按你的实际克隆位置修改。",
         "model": "gpt-4o",
         "_comment_model": "必填，可改。传给官方 evaluate_qa.py 的 judge 模型名；其凭据按官方 evaluator 的环境变量配置。",
         "python": "../../third_party/LongMemEval/.venv/bin/python",
         "_comment_python": "可选，默认 python。若按 README 用 uv 安装官方 judge，填此路径；也可填 python3 或其他解释器可执行文件路径。"
       }
     }
   }
   ```

   可以自行设置的主要参数有：

   * `longmemeval.size`：题目数量
   * `longmemeval.seed`：确定性抽样种子，相同数据、size 和 seed 会选出相同题目
   * `pi.model`：模型选择，推荐 deepseek-v4-flash
   * `arms`：默认完整的四种

   * `judge.kind`
     * 默认 `official`，`judge.evaluator_dir` 指向 `../../third_party/LongMemEval/src/evaluation`，`judge.python` 指向 `../../third_party/LongMemEval/.venv/bin/python`（两者都相对于 `eval/longmemeval/experiment.lock.json`），不需要激活环境，总脚本会直接调用该解释器。
     * 可设置为 `pi`，直接复用上方的 `pi.model`，不需要在运行最终测试脚本时附上 `--judge-api-key "<OpenAI API Key>"`。

5. **embedding API key（仅 `rag_raw` 需要）。**选择一个 API provider，并将 endpoint/model 固定在 lock。运行总脚本时通过 `--embedding-api-key` 临时传入，不写入 lock：

   - 百炼：在其控制台创建 API key；lock 使用百炼的 OpenAI-compatible `base_url` 和 `text-embedding-v4`。

   - OpenAI：创建可用的 API key；lock 使用 `https://api.openai.com/v1` 和 `text-embedding-3-large` 或 `text-embedding-3-small`。

   注意：`arms` 中不包含 `rag_raw` 时不需要 embedding key。

最后在启动实验的同一终端做一次检查；如果当前只跑 `judge.kind: "pi"` 且 `arms` 中不含 `rag_raw`，那么 `uv` 和 embedding key 都不会被实际用到：

```bash
node --version
pi --version
uv --version
trajex --version
python --version
```

### 1、先生成 manifest

我们首先实现的是下面这条命令：

```bash
node eval/longmemeval/prepare/sample-longmemeval.mjs \
  --input data/longmemeval_s_cleaned.json \
  --output eval/longmemeval/manifests/longmemeval.jsonl \
  --size 100 \
  --seed trajex-v1
```

它不是运行模型，而是从 LongMemEval 中固定“这次具体测哪些题”。四个 arm 必须回答同一批题，才能公平比较：

```text
同一份 manifest
├── none 不给历史，作为基线
├── full 把完整历史直接放进上下文
├── rag_raw 普通 RAG 自动找出相关片段
└── trajex_active Agent 自己调用 Trajex，多轮搜索历史
```

> arm 就是“实验组”或“对照方案”。

参数含义：

- `--input`：LongMemEval 官方 JSON 数据。
- `--output`：本次实验冻结的题目清单。
- `--size`：抽取题数；开发时可用 10，正式实验建议 500。
- `--seed`：确定性选择种子；输入、题数和 seed 相同，输出就相同。

#### `sample-longmemeval.mjs` 做了什么

它先检查 LongMemEval 文件是否合法、题目 ID 是否重复，再按“问题类型 × 是否为无答案题”分组，按原始比例计算每组应选几题。组内使用 `seed + question_id` 的 SHA-256 排序，因此同一输入和 seed 永远选出同一批题。最后只写出题目 ID、类型和源文件指纹，不复制答案、历史正文或证据位置。它本身不调用模型，只为后续四个 arm 固定一份公平、可复现且不泄漏 gold 数据的题目清单。

我们的 manifest 不会复制全部数据，只会记录任务身份：

```json
{
  "question_id": "sample_temporal_001",
  "question_type": "temporal-reasoning",
  "is_abstention": false,
  "source_sha256": "c08d6f7b..."
}
```

它不会保存 `answer`、`answer_session_ids` 或 `haystack_sessions`。这些 gold 数据只能由后续 runner/grader 从原数据读取，不能直接暴露给被测 Agent。

运行评测时，runner 根据 `question_id` 回到原始数据取出问题和历史；grader 单独保管 `answer` 与证据标签。

#### 实现决策

- 仓库主体是 Node.js，因此准备工具优先使用 Node 标准库，不新增 Python 运行时依赖。
- 分层键是 `question_type × is_abstention`。
- 各层名额使用比例分配和 largest remainder 补足。
- 层内选择使用 `SHA-256(seed + question_id)` 排序，不依赖运行时随机数实现。
- 输出按 `question_id` 排序，方便 diff 和断点续跑。
- `source_sha256` 是输入文件原始字节的 SHA-256，用来识别数据版本。
- 开发阶段先跑 10 题验证流程；正式 LongMemEval 使用完整 500 题。

### 2、把 LongMemEval 历史转换成 Trajex 能读的会话

manifest 只说“测哪一道题”，还不能直接让 Trajex 搜索：LongMemEval 的历史是一个嵌套 JSON 数组，而 Trajex 读取的是 Claude、Codex 或 Pi 的会话文件。因此第二步是运行：

```bash
node eval/longmemeval/prepare/prepare-longmemeval-sessions.mjs \
  --input data/longmemeval_s_cleaned.json \
  --manifest eval/longmemeval/manifests/longmemeval.jsonl \
  --output eval/longmemeval/work
```

这条命令不调用模型，也不回答问题。它逐行读取 manifest，根据每个 `question_id` 回到官方原始数据找到对应历史，再为每道题建立一个完全独立的目录：

```text
eval/longmemeval/work/sample_temporal_001/
├── agent-input.json
└── sessions/
    ├── session-001.jsonl
    ├── session-002.jsonl
    └── session-003.jsonl
```

#### `prepare-longmemeval-sessions.mjs` 做了什么

它会检查 manifest 中的题目确实存在、问题和历史数组的长度能一一对应，以及题目/会话 ID 可安全用作文件名。接着把每个 LongMemEval session 按原顺序转换成最小的 Pi v3 JSONL [pi 官方 session-format](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/session-format.md)：一个 session 头、若干条首尾相连的 user/assistant message，以及末尾的 `leaf`。`leaf` 的人话意思是“这条消息链就是当前有效的对话历史”，所以 Trajex 的 Pi provider 会把整段历史正常索引出来。

`haystack_dates` 被转换为 Pi 所需的 ISO 时间；同一个 session 内的消息保持原始顺序。这里没有伪造模型回答、工具调用或检索结果，因为 LongMemEval 只需要测试“能否从聊天历史找出答案”。

每题有两类输出：

- `agent-input.json`：被测 Agent 只看到 `question_id`、题型、问题和提问日期。例如：

  ```json
  {
    "question_id": "sample_temporal_001",
    "question_type": "temporal-reasoning",
    "question": "我去上海旅行后多久开始学习摄影？",
    "question_date": "2025-06-01"
  }
  ```

- `sessions/*.jsonl`：按历史 session 拆分的 Pi 会话文件；runner 将这个 `sessions/` 目录作为 Trajex 的 Pi provider 索引根。

### 3、让每题在隔离的 Trajex 索引中运行

如果直接运行 `trajex --build`，它默认会索引用户真实的 `~/.pi/agent/sessions`，并把数据库写到 `~/.trajex`。这会把日常聊天混进评测历史，也会污染用户自己的索引，因此不能用于评测。

现在 Trajex 支持两个可选环境变量：

```bash
PI_CODING_AGENT_SESSION_DIR=<本题>/sessions
TRAJEX_DIR=<本题>/.trajex
```

runner 会只在启动 `trajex --build` 和 Pi CLI 的**子进程**中设置它们。前者告诉 Trajex“只索引这一题转换出的 JSONL”，后者让索引数据库也写在本题目录。子进程结束后，这两个变量不会修改你的终端环境、Pi 默认会话目录或默认 Trajex 数据库；即使中途报错退出也是如此。

最小验证命令如下。它只为某题建立临时索引，不会调用模型：

```bash
PI_CODING_AGENT_SESSION_DIR=eval/longmemeval/work/<question_id>/sessions \
TRAJEX_DIR=eval/longmemeval/work/<question_id>/.trajex \
trajex --build
```

`trajex_active` 会在同样的隔离环境中启动 Pi，并在 prompt 中要求它用 `trajex --query` 搜索历史。因此它不可能命中别题或用户本地的历史。`none`、`full` 与 `rag_raw` 不需要建立 Trajex 索引。

### 4、运行四个 arm 的共同入口

runner 的共同 Agent 是 Pi CLI：`pi -p` 非交互执行后，stdout 就是该题的 `hypothesis`。每次正式运行至少需要下列参数：

```bash
node eval/longmemeval/run-longmemeval.mjs \
  --work eval/longmemeval/work \
  --arm rag_raw \
  --output eval/longmemeval/runs/rag_raw.jsonl \
  --pi-model <Pi可用模型名> \
  --embedding-api-key "<百炼API Key>" \
  --embedding-base-url "https://<WorkspaceId>.cn-beijing.maas.aliyuncs.com/compatible-mode/v1" \
  --embedding-model "text-embedding-v4"
```

- `--work`：第二步生成的隔离题目目录。
- `--arm`：`none`、`full`、`rag_raw` 或 `trajex_active`；四组必须分别跑，但使用同一 `--pi-model`。
- `--output`：官方 LongMemEval evaluator 可读取的回答 JSONL；每行至少有 `question_id` 与 `hypothesis`。
- `--pi-model`：Pi 实际调用的 llm 模型，必须在实验记录中固定精确值。
- `--embedding-api-key`、`--embedding-base-url` 与 `--embedding-model`：仅 `rag_raw` 需要。key 只在本次进程内使用，runner 不会写入输出、日志或 lock 文件；model 省略时默认百炼的 `text-embedding-v4`。

> 可以选用 openai 的 embedding 模型：
>
> ```bash
> node eval/longmemeval/run-longmemeval.mjs \
>   --work eval/longmemeval/work \
>   --arm rag_raw \
>   --output eval/longmemeval/runs/rag_raw.jsonl \
>   --pi-model <Pi可用模型名> \
>   --embedding-api-key "<OpenAI API Key>" \
>   --embedding-base-url "https://api.openai.com/v1" \
>   --embedding-model "text-embedding-3-large"
> ```
>

**四种 arm**：`none` 只给 Pi 问题；`full` 给问题和全部历史；`rag_raw` 用 BM25 关键词与百炼向量 cosine 混合排序后给动态数量的片段；`trajex_active` 只给问题，由 Pi 自己检索隔离 Trajex 索引。

每个 arm 应输出相同的回答字段：

```json
{"question_id":"...","hypothesis":"模型最终回答"}
```

这是 LongMemEval 官方 evaluator 接受的 JSONL 格式。[官方 Testing Your System](https://github.com/xiaowu0162/LongMemEval#testing-your-system)

这套评测不人为设置字符/token 上限。目标是比较每种记忆方案“充分使用时”的最终正确率、真实 token 消耗和耗时；因此结果必须保留 Pi 实际报告的 input、cache read、output token，而不是只报告正确率。

#### `none` arm

`none` 是没有记忆的基线。它运行时不需要 embedding 参数：

```bash
node eval/longmemeval/run-longmemeval.mjs \
  --work eval/longmemeval/work \
  --arm none \
  --output eval/longmemeval/runs/none.jsonl \
  --pi-model <Pi可用模型名>
```

runner 会按目录名排序逐题读取 `agent-input.json`，以 `pi --model <模型> --no-session --no-context-files --no-extensions --no-skills --no-tools --print <prompt>` 启动 Pi。也就是说，它只让模型看到问题和提问日期；工具、历史文件、项目上下文、Pi 保存的旧 session 都被关闭。Pi stdout 去除首尾空白后写成：

```json
{"question_id":"sample_temporal_001","hypothesis":"模型的最终回答"}
```

这个 JSONL 正是后续 LongMemEval 官方 judge 的输入。Pi 非零退出时 runner 立即失败，而不是悄悄遗漏题目，避免不同 arm 的分母不一致。

#### `full` arm

`full` 也使用同一个命令，只把 `--arm` 改为 `full`：

```bash
node eval/longmemeval/run-longmemeval.mjs \
  --work eval/longmemeval/work \
  --arm full \
  --output eval/longmemeval/runs/full.jsonl \
  --pi-model <Pi可用模型名>
```

runner 会读取该题 `sessions/*.jsonl` 中每个 session 的 header 时间，再按日期拼接所有原始 user/assistant 消息到 Pi prompt。它仍禁用工具，因此 `full` 测的是“模型直接读完全部历史”而不是检索能力。此 arm 不截断历史；实际消耗多少 input token，后续 telemetry 如实记录多少。

#### `rag_raw` 的动态条目数与混合检索

`rag_raw` 不设字符上限。API key 只用于这次 runner 进程的 embedding 请求，不会写入输出、日志或实验 lock 文件。runner 会把每条 user/assistant 消息作为一个检索条目：

1. 用 Node 标准库实现 BM25，按关键词和词频排序。
2. 调百炼 `text-embedding-v4` 得到问题和每条消息的向量；每批最多 10 条。
3. 用 cosine 相似度得到语义排序。
4. 用 Reciprocal Rank Fusion（RRF）合并两个名次，而不是直接相加不同尺度的分数。
5. 从合并排序中取动态数量的消息放进 Pi prompt。

动态数量的公式是：

```text
M = 本题历史中 user/assistant 消息条目数
R = 混合检索产生的候选条目数
K = min(R, max(5, ceil(sqrt(M))))
```

也就是说，历史 100 条消息时取前 10 条；900 条时取前 30 条；候选不够时全取。`session` header、`leaf` 等 Pi 协议条目不计入 `M`，因为它们不是可回答问题的聊天证据。这个公式在任何正式实验前固定，之后只比较正确率、真实 token 和耗时，不能针对结果改 K。最终 prompt、Pi 输入 token、cache token、输出 token 和耗时将在 telemetry 中原样记录。

#### `trajex_active`

`--arm trajex_active` 会先为每道题的 `sessions/` 设定 `PI_CODING_AGENT_SESSION_DIR`，为数据库设定 `<题目>/.trajex`，在该子进程中运行 `trajex --build`，再启动只允许 `bash` 的 Pi。Pi 初始只看到问题，并被要求通过 `trajex --query` 找证据；题目结束后这些环境变量自动失效，不会触碰本机默认历史或数据库。

#### 运行 telemetry

在任一 arm 后加 `--telemetry eval/longmemeval/runs/<arm>.telemetry.jsonl`，runner 会让 Pi 使用 `--mode json`，从最终 assistant 事件读取 provider 返回的 `usage`（input、output、cacheRead、cacheWrite 等字段）并记录每题 `wall_time_ms`。答案仍单独写入官方 judge 使用的 hypotheses JSONL；telemetry 不参与评分。

使用总脚本时不必自己加这个参数：它会对每个 arm 自动生成 telemetry，并在全部评分完成后汇总。

### 5、单独使用 LongMemEval 官方 judge

```bash
node eval/longmemeval/judge-longmemeval.mjs \
  --evaluator-dir third_party/LongMemEval/src/evaluation \
  --hypotheses eval/longmemeval/runs/rag_raw.jsonl \
  --dataset data/longmemeval_s_cleaned.json \
  --model gpt-4o \
  --python python \
  --api-key "<OpenAI API Key>"
```

该命令依次调用官方 [`evaluate_qa.py`](https://github.com/xiaowu0162/LongMemEval/blob/main/src/evaluation/evaluate_qa.py) 和 [`print_qa_metrics.py`](https://github.com/xiaowu0162/LongMemEval/blob/main/src/evaluation/print_qa_metrics.py)；Trajex 不自行判断答案对错。官方产生的 `.eval-results-<model>` 文件保留评分细节，stdout 输出聚合指标。

### 6、可选：使用 Pi judge

若不想为评分单独配置 OpenAI API key，可让 Pi 再做一次“裁判”：它复用 `pi.model` 与可选的 `pi.command`，每题只回答 `yes` 或 `no`。它沿用 LongMemEval 的题型规则（偏好题看个性化、时间题容许日期数量 off-by-one、知识更新看新值、拒答题看是否明确不可回答），但调用链和模型不同，因此产物叫 **Pi judge**，不是官方 judge。

在 lock 中改为：

```json
"judge": {
  "kind": "pi"
}
```

此时 `evaluator_dir`、`model`、`python` 都可删除；总脚本会为每个 arm 输出 `<arm>.pi-judge.jsonl`，其中包含原回答和 Pi 的标签：

```json
{
  "question_id": "...",
  "hypothesis": "被测 Agent 的回答",
  "autoeval_label": {
    "model": "与 pi.model 相同的模型名",
    "label": true,
    "judge": "pi"
  }
}
```

终端还会打印总体正确率、按题型正确率、任务平均正确率和 abstention accuracy。由于被测 Agent 和裁判复用同一 Pi 模型，可能有自评偏差；它适合省去 OpenAI judge 的运行方案或做敏感性对照，正式主报告仍优先保留 `judge.kind: "official"`。

也可单独调用：

```bash
node eval/longmemeval/judge-longmemeval-pi.mjs \
  --hypotheses eval/longmemeval/runs/rag_raw.jsonl \
  --dataset data/longmemeval_s_cleaned.json \
  --output eval/longmemeval/runs/rag_raw.pi-judge.jsonl \
  --pi-model <与 lock 中相同的 Pi 模型>
```



### 正式实验：一份 lock、一个命令<a id="正式"></a>

开发或排错时仍可分别运行前面的 Node 命令；正式结果不应靠人工逐条粘贴命令。按照 [运行前准备](#准备) 复制 [`experiment.lock.json.example`](./longmemeval/experiment.lock.json.example) 为 `eval/longmemeval/experiment.lock.json`，填写 Pi 模型、百炼 endpoint 和 judge 配置后，

> lock 的 `input`、`runs`、`judge.evaluator_dir` 等相对路径相对于 lock 文件所在目录；`manifest` 与 `work` 则相对于每个 run bundle。lock 记录实验配方，不记录密钥。`rag_raw` 在 lock 的 `arms` 列表中时才需要命令行的 `--embedding-api-key`；`embedding.base_url` 和 `embedding.model` 可以配置百炼或 OpenAI。`judge.kind: "official"` 可通过总脚本的 `--judge-api-key` 临时传 key（内部仅注入官方 Python judge 子进程），或使用 `OPENAI_API_KEY` 环境变量；两者都不写入 lock 或结果文件。`judge.kind: "pi"` 复用 Pi 凭据并忽略 `--judge-api-key`。

运行：

```bash
node eval/longmemeval/run-experiment.mjs \
  --lock eval/longmemeval/experiment.lock.json \
  --run-id xxx \
  --embedding-api-key "<百炼/OpenAI API Key>" \
  --judge-api-key "<OpenAI API Key>" # 如果 lock 中 judge.kind: "pi" 则不需要该参数
```

> `--run-id` 只能包含字母、数字、`_`、`-`，建议用能看懂的名称，例如 `lme-s100-gpt-5-20260812`。若省略，总脚本会自动生成“启动时间 + lock 文件 SHA-256 前缀”；修改模型、样本数、arm、judge 或检索参数后，lock 指纹也会变化。若指定的 run-id 已存在，总脚本会拒绝运行，绝不把新产物混入旧目录；同一配方想重复做独立试验时，显式换一个 run-id。

总入口会按固定顺序完成：抽样 manifest → 转换 Pi sessions → 依次运行 `none`、`full`、`rag_raw`、`trajex_active` → 按 `judge.kind` 对每个 arm 评分 → 生成汇总表。每次调用都会建立一个独立的 run bundle：`<runs>/<run-id>/`。其中有 lock 快照、manifest、转换的 work 目录、回答、telemetry、judge 结果和汇总表；官方 judge 生成其原有的 `.eval-results-<judge model>` 详情，Pi judge 生成独立的 `<arm>.pi-judge.jsonl`。

最终先看 run bundle 中的 `summary.md`，即 `<runs>/<run-id>/summary.md`。它不重新评分，只读取上述逐题 judge 结果与 telemetry，因此可以追溯到原始记录。它包含：

- 一张四 arm 对比表：QA accuracy、abstention accuracy、input/cache read/output/cache write token 总数与墙钟时间总和；

  > input 和 cache read
  >
  > - 第 2 轮起，对话前缀和上一轮完全一样 → 命中缓存，算 cacheRead
  > - 只有本轮**新追加**的那一小段（新搜索结果、新工具输出）才算 input

- 一张按 `question_type` 展开的四 arm 正确率表。

若 Pi provider 没有返回 `usage`，对应 token 单元格显示 `—`，不会伪造为 `0`；墙钟时间仍会记录。

最终指标和产物：

| 指标/产物                                   | 如何得到                                                  |
| ------------------------------------------- | --------------------------------------------------------- |
| 每题最终回答                                | `hypotheses.jsonl`                                        |
| 总体与各题型 QA 正确率、abstention accuracy | LongMemEval 官方 `evaluate_qa.py` + `print_qa_metrics.py` |
| 每题 Pi input / output / cache token        | `--telemetry` 时读取 Pi JSON `usage`                      |
| 每题墙钟时间                                | `--telemetry` 的 `wall_time_ms`                           |
| 四 arm 汇总对比表与按题型表                 | 总脚本生成的 `runs/summary.md`                            |

### 当前进度

- [x] LongMemEval manifest CLI，确定性、分层和 gold 字段隔离的端到端测试。
- [x] LongMemEval → Trajex 可索引 Pi session 转换。
- [x] `PI_CODING_AGENT_SESSION_DIR` 与 `TRAJEX_DIR` 的子进程隔离索引。
- [x] `none` arm runner：隔离的无记忆 Pi 基线与 hypotheses JSONL。
- [x] `full` arm runner：把同一批原始历史给 Pi。
- [x] `rag_raw` arm runner：百炼向量 + BM25 混合检索与动态 K。
- [x] `trajex_active` arm runner：每题隔离构建索引后，由允许 bash 的 Pi 主动查询。
- [x] Pi JSON telemetry：每题 usage 与墙钟时间。
- [x] LongMemEval 官方 judge 接入。
- [x] 可选 Pi judge：复用 `pi.model`，独立写出 Pi 标签与聚合指标。
- [x] LongMemEval 总汇总：总脚本自动收集 telemetry，写出四 arm 对比表与按题型表。
- [x] LongMemEval 总入口：`experiment.lock.json` 固定配方，一条命令串联准备、四个 arm 与 judge。
