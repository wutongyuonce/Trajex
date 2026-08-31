<div align="center">

<sub><strong><a href="README.md">中文</a></strong> · <a href="README.en.md">English</a></sub>

<br>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/assets/trajex-wordmark-d.svg">
  <img src=".github/assets/trajex-wordmark-l2.svg" alt="Trajex" width="460">
</picture>

### 面向 Agent 的通用本地会话记忆平台

<a href="https://github.com/wutongyuonce/Trajex/stargazers"><img src="https://img.shields.io/github/stars/wutongyuonce/Trajex?style=flat-square" alt="stars"></a>
<a href="https://github.com/wutongyuonce/Trajex/releases"><img src="https://img.shields.io/github/v/tag/wutongyuonce/Trajex?label=version&style=flat-square" alt="version"></a>
<a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue?style=flat-square" alt="license"></a>

</div>

将来自不同 provider —— Codex、Claude Code、Pi 的 JSONL 历史解析为同一套 canonical record 并持久化至 SQLite，通过 FTS5 全文索引实现毫秒级历史检索。

* 采用 **CodeAct 智能体设计范式**，提供可编程 JS Query API，让 Agent 将 **“编写可执行代码”** 作为核心行动方式
* 配套 Electron + Vue 桌面端，将同一份索引转化为可读的会话时间线，用户可通过 App 直观浏览

## Acknowledgements

Trajex 源自 [tommy0103/obelisk](https://github.com/tommy0103/obelisk)，基于上游 `07f975d`（2026-07-22）快照发展而来。Trajex 在此基础上对索引核心进行了改写与精简，修复了一些 bug，并优化了桌面应用，包括白天/黑夜主题切换、Codex-like 的纵向进度条和本地文件链接预览。

Pi 会话支持的实现骨架来自上游 [PR #4](https://github.com/tommy0103/obelisk/pull/4)；当前会话身份、tombstone 以及 compaction / retained tail 等设计语义来自上游 [PR #23](https://github.com/tommy0103/obelisk/pull/23)。未来 Trajex 可能会在不破坏现有功能与兼容性的前提下，同步 [obelisk](https://github.com/tommy0103/obelisk) 的后续改动。感谢 obelisk 的开发者为 Agent 基础设施和智能体工程实践所作出的贡献。

## 同一个索引的两面

Trajex 有两面，它们共享同一个 SQLite 索引：

**Agent 侧** — `trajex` CLI 负责本地运行时；另有一个独立的 Agent skill 教会 coding agents 如何搜索和查询自己的会话历史。Agent 会编写 JS 查询，在本地运行，并用自然语言回答。

**App 侧** — Electron 桌面 app，供人浏览 sessions、管理 memories，以及查看使用统计。

两者都读取同一个 `~/.trajex/trajex.sqlite` 数据库。索引器会读取 `~/.claude/projects` 中的 Claude Code transcripts、`~/.codex/sessions` 和 `~/.codex/archived_sessions` 中的 Codex transcripts，以及 `~/.pi/agent/sessions` 中的 Pi sessions。

## 多 Provider 支持

Codex 和 Claude Code 根据当前真实文件测试得出的 schema 进行处理，官方没有提供格式规范。

Trajex 会把每个 provider 都索引到同一个 SQLite schema 中，而不是维护彼此分离的数据库。数据行会带有 `source` 值；非 Claude 的 ID 会带 provider 前缀，因此不会冲突。

工具结果使用三层投影：`messages.text` 只保留最多 1,000 字符的首尾预览，供 `thread()` 与 FTS 检索；`tool_results.content` 保留最多 10,000 字符，超长时保留首部与尾部；需要完整证据时再通过 `raw()` 分段回读原始 transcript。因此工具结果的中间内容不进入 `messages_fts`。

| Provider | 内部 id 形态 | 原因 |
|---|---|---|
| Claude | `e9d4f0a1-…`（原样） | 原生格式 |
| Codex | `codex:6f3c2a9e-…` | 避免与 Claude 的 UUID 撞主键 |
| Pi | `pi:<原始id>:<cwd哈希>` | 树状会话，带 scope 区分项目/分支 |

> * Claude / Codex：它们的 id 是"会话级全局唯一"的;
> * Pi：默认 id 也是全局唯一的（uuidv7），但 Pi 支持显式传入 --session-id 这类项目局部 id（不校验唯一性），且同一份会话文件可能出现在多个项目目录下。所以只靠原始 id 跨项目可能撞，把 cwd 哈希并进主键是防御性兜底（同时让文件移动后身份保持稳定）。

三个内置 Provider 的解析边界不同：Claude 用包含 mtime、行数、文件大小、ctime 和 inode 的 cursor 从上次位置增量读取；Codex 为了在 `event_msg` 与 `response_item` 之间去重会对变更文件全量重放。两者都跳过已换行结束的坏 JSON 记录，但会把未换行的残缺尾行留给下次重试。Pi 为了重算树状分支、durable leaf 和 compaction 也会全量重放；多次 compaction 以最近的 `retainedTail` checkpoint 为最早有效边界，更早物理消息保留为 inactive 证据。Pi 当前仍在 JSON 语法损坏行前提交有效前缀，但已成功解析出的树若存在重复 ID、循环、非法 leaf 或 compaction 结构，则整份 session 不提交；缺失父节点仍按官方 orphan root 处理。Pi 原文回查会按 UUID 还原具体 assistant block 或 `retainedTail` 消息，详情页可展开完整文本，且不会连带返回同一 checkpoint 的其他 retained 消息。对删除，Provider 的来源根目录是唯一回退边界：根目录缺失或根层无法枚举时，普通 build 保留该 Provider 的上一次快照；根层可枚举后，本次清单即有权威性，缺失或不可读的子目录按空子树处理并清理对应旧索引。清理只作用于可重新生成的 transcript 派生数据，`memories` 不会被删除。

Codex 只索引根 thread 为普通 Trajex session。带有 `parent_thread_id`、`forked_from_id` 或其他 parent-thread metadata 的 child/fork/subagent thread（包括 guardian/auto-review thread）全部忽略，不挂接到 `subagents` 表。Codex 不会产生 Claude 风格的 workflow metadata，因此只有 Codex 历史时，workflow 相关表可能为空。Codex 和 Pi 一样对变更文件做全量重放：先删除该 session 的旧派生投影，再从当前 JSONL 全量重建。

每个 Pi 官方 v3 session JSONL 文件会成为一个 Trajex session。Pi 的会话条目是树状的，Trajex 会根据 durable leaf 和 compaction（包括 retained tail）计算当前上下文：当前记录为 `visible`，已被取代但保留的分支证据为 `inactive`，来源明确隐藏的 transport context 为 `hidden`。工具调用使用每次消息 occurrence 的 canonical ID，结果只关联同一 `parentId` 分支内最近的原始 `toolCallId`，避免分叉复用 ID 时串线。详情页默认只展示 visible 记录，其他分支可显式展开。

为了支持 app 实时刷新，Trajex 会按 provider 声明的 typed targets 监听目录和精确文件：目录交给 `@parcel/watcher`，精确文件用有上限的 stat 轮询；macOS 还会轮询最近活跃的最多 64 个 transcript。App 每 5 分钟再做一次完整清点。Claude 的目标包括 `~/.claude/projects` 与 `history.jsonl`，Codex 包括 `~/.codex/sessions`、`archived_sessions` 与 `session_index.jsonl`，Pi 默认是 `~/.pi/agent/sessions`。App Settings 中 Claude 与 Codex 配置的是各自的 provider root（默认 `~/.claude` / `~/.codex`），Pi 配置最终 session directory。Trajex 不读取环境变量或 CLI 参数。如果某个已有快照的来源根暂时不可用，daemon 会保留旧快照并重试；目录恢复后会立即重新清点。

## App 与 CLI 的关系

桌面 App 和 CLI 可以独立安装：安装 App 不需要先安装 CLI，安装 CLI 也不需要单独安装 Core。两者各自携带运行所需的 Core，并在同时使用时共享同一个本地索引数据库。

* CLI 没有运行时 npm dependencies，并使用 Node 22 内置的 `node:sqlite` 与 FTS5。

* App 有运行时 npm dependencies：`better-sqlite3` 作为 Electron 侧的 SQLite 驱动，`@parcel/watcher` 提供跨平台递归目录事件。两者都包含需要在打包时保留真实磁盘路径的原生模块。

第一次打开 App 或者第一次运行 CLI 查询 `/trajex --build` 会构建索引，其中一方已完成后，另一方复用同一份索引，通常只做增量检查/更新。100 个 sessions 通常需要约 5 秒。之后会进行增量重建。

普通增量构建只会重新解析受变化路径影响的 transcript；周期 reconcile 会重做完整 Provider discovery，但不会强制重放每个未变 transcript。删除清理遵循上面的来源根边界；force rebuild 会先检查现有索引中每个 Provider 的来源根，任一根缺失或根层不可读就会在清理前整体中止，原数据库保持不变。全部通过后才强制重建全库派生索引。CLI 和 App 的 rebuild 层级不同：CLI 的 `/trajex --build` 清空 sessions、messages 等派生表，并从当前磁盘文件重新索引（record 级重建），不会重建 SQLite 文件本身，需要彻底重建文件时得先删除 `~/.trajex/trajex.sqlite` 再重新构建；App 的手动重建则先构建全新的临时数据库、复制旧库的 memories，成功后原子替换主数据库文件，等于重建 SQLite 文件并套用当前 schema。两种 rebuild 都会保留人工确认的 memories 层。另外，schema 列的新增由打开数据库时的迁移（schema-migrations）幂等处理；迁移只增加新列，不删除旧列。查询、原文读取和 attune 会先独立确认 schema 可读，最近构建标记只决定是否扫描 Provider 数据，不能跳过必要迁移；迁移若被 daemon 或其他 writer 阻塞，会返回明确诊断而不是继续产生 `no such column`。旧列只有在 rebuild 生成新数据库时才会消失。当可选 app 正在运行时，它就是 active indexer：它监听 Provider targets，并在 worker thread 中构建索引。仅凭新鲜的 `__app_heartbeat__` 就意味着 daemon 拥有写入职责，因此 CLI 调用会保持只读；另有一个独立的 SQLite writer lease 防止跨进程写入重叠。`__app_last_successful_build__` marker 不参与写入判断，记录的是 App 索引新鲜度，仅用于观测记录。

## App：给人使用的界面

一个配套桌面 app，用于浏览由 CLI 或 app daemon 维护的同一个索引。

<div align="center">
  <img src=".github/assets/sessionlist_light.png" alt="Trajex App" width="720">
</div>

<div align="center">
  <img src=".github/assets/sessionlist_dark.png" alt="Trajex App" width="720">
</div>

<div align="center">
  <img src=".github/assets/session_light.png" alt="Trajex App" width="720">
</div>

<div align="center">
  <img src=".github/assets/session_dark.png" alt="Trajex App" width="720">
</div>

<div align="center">
  <img src=".github/assets/activity_light.png" alt="Trajex App" width="720">
</div>

<div align="center">
  <img src=".github/assets/activity_dark.png" alt="Trajex App" width="720">
</div>

<div align="center">
  <img src=".github/assets/settings_light.png" alt="Trajex App" width="720">
</div>

<div align="center">
  <img src=".github/assets/settings_dark.png" alt="Trajex App" width="720">
</div>

- **Sessions** — 浏览所有 sessions，支持搜索、项目过滤、可读 tool calls，包括 diffs、terminal output、file viewers
- **Memory** — 已注册 memory files 的列表和详情视图
- **Activity** — GitHub 风格热力图、每周/累计 token 图表
- **Settings** — 数据源配置、自动刷新、重建索引

目前 macOS 预构建版本可在 [Releases](https://github.com/wutongyuonce/trajex/releases) 获取。源码 app 可在 macOS、Windows 和 Linux 上本地运行。

## 安装 CLI 和 Skill

### 推荐：交给 Agent 安装

将根目录的 [`SKILL.md`](SKILL.md) 作为 prompt 交给有 shell 权限的
coding Agent，或让它读取下面的安装指南：

```text
请读取并按此安装指南完成 Trajex 安装：
https://raw.githubusercontent.com/wutongyuonce/trajex/main/SKILL.md
```

`trajex-installer` 会先安装并验证 CLI，再询问将 `/trajex` skill 安装到当前
项目还是全局；不会擅自改变安装范围。

### 手动安装/更新

Trajex 需要 Node.js 22.13 或更高版本。安装平台无关的 CLI：

```bash
npm install --global @trajex-apps/cli
trajex --version
```

在 macOS、Linux 或 WSL 上，CLI-only installer 等价于：

```bash
curl -fsSL https://raw.githubusercontent.com/wutongyuonce/trajex/main/install.sh | sh
```

然后安装 `/trajex` skill。默认安装到当前项目；如需全局可用，加上 `--global`：

```bash
npx --yes skills add wutongyuonce/trajex-skill
# 或：npx --yes skills add wutongyuonce/trajex-skill --global
```

## 使用 CLI、trajex-skill

<div align="center">
  <img src=".github/assets/boron.sh.png" alt="CLI Help" width="720">
</div>

你可以这样使用 trajex-skill：

```
/trajex 上次 auth bug 最后到底改了哪些文件，为什么这么改
/trajex 这个文件最近在哪些 sessions 里被反复修改
/trajex 找出最近失败的 tool calls，它们分别发生在哪些任务里
/trajex 那个 review workflow 的 subagents 各自结论是什么
```

### 工作原理

```
你提出问题
  ↓
Agent 针对 SQLite 索引编写 JS 查询
  ↓
通过 trajex --query <script> 运行
  ↓
读取 JSON 结果，用自然语言回答
```

核心 API：`search()`、`context()`、`sql()`，以及结构化 helpers：`sessions`、`memories`、`summaries`、`workflows`、`failures`、`fileHistory` 等。

### Memory 层

当一次检索产生了值得保留的结论时，Agent 会提出一个 markdown memory file。经过用户批准后，它会通过 `trajex --attune <script>` 注册该文件。未来 sessions 中可以通过 `memories()` 召回这些 memories。它是一个 synthesis cache，不是原始证据的替代品。

## 本地运行 App

安装 [Node.js 22](https://nodejs.org/) 和 npm，然后从 app 自己的 package 目录运行：

```bash
git clone https://github.com/wutongyuonce/trajex.git
cd trajex/app
npm ci
npm run dev
```

`electron-vite` 会启动 renderer dev server 并打开 Electron。首次运行时，Trajex 会创建 `~/.trajex/trajex.sqlite`，索引可用的 Claude Code、Codex 和 Pi transcripts，然后监听它们的变化。默认 sources 可在 **Settings** 中改为其他目录。在 Windows 上，Trajex 还会检查常见 WSL distributions 中的 Claude Code 目录。

## 调试 App

- Renderer 改动使用 Vite hot module replacement。在 macOS 上用 `Cmd+Option+I`，在 Windows/Linux 上用 `Ctrl+Shift+I` 打开 Electron DevTools。
- Main-process 和 preload logs 会出现在运行 `npm run dev` 的终端中；它们的源码改动由 electron-vite 重新构建。
- 如果要把 Node debugger attach 到 Electron main process，用 `npm run dev -- --inspect=5858` 启动，然后把 debugger attach 到 5858 端口。
- development app 会读取并更新真实的 `~/.trajex` 索引。在测试破坏性 rebuild 前请先备份。要隔离运行，可以用 disposable home directory 启动，例如 macOS/Linux 上 `HOME=/tmp/trajex-dev npm run dev`，Windows 上先设置临时 `USERPROFILE`，然后在 **Settings** 中选择 fixture source directories。

`better-sqlite3` 为常见平台提供预构建 binaries。如果 `npm ci` 回退到本地编译，请安装对应平台的 C/C++ 构建工具，然后重新运行 `npm ci`。

## 构建与打包 App

从 `app/` 目录执行：

```bash
# 编译 main/preload/renderer 并打包（electron-builder 按当前平台配置出安装包，
# macOS 上等价于 dist:mac）；仅想编译产物可执行 npx electron-vite build
npm run build

# 生成未压缩的 App 目录
npm run pack

# 生成 macOS DMG 和 ZIP 安装包
npm run dist:mac
```

流程是先由 `electron-vite` 编译 Electron 的 main/preload/renderer，再由
`electron-builder` 重建原生依赖、组装 App 并生成安装包。产物位于
`app/release/`；`npm run pack` 生成 `release/mac-arm64/Trajex.app`，
`npm run dist:mac` 生成 DMG 和 ZIP。没有 Apple Developer ID 时，产物不会签名。
仅编译不打包时，`electron-vite` 的产物在 `app/out/`。

## 发布 npm 包

只有 `@trajex-apps/cli` 会发布到 npm；`@trajex/core` 是 private workspace，
构建时被 CLI 直接编译进自身，不单独发布。

### 前置条件

- 已登录 npm，且账号是 `@trajex-apps` scope 所属组织的有发布权限成员（Owner/Admin）；
- 账号已启用 2FA（npm 要求发布者启用）。发布时使用 `npm login` 生成的会话令牌，
  或带 bypass-2FA 权限的 access token。

### 发布步骤

```bash
# 1. 登录（一次性）
npm login

# 2. 升版本：每次发布前必须升号，npm 不允许覆盖已发布的版本
npm version patch -w @trajex-apps/cli
# 或指定具体版本（--no-git-tag-version：只改文件，不创建 git tag/commit）：
npm version 0.2.1 -w @trajex-apps/cli --no-git-tag-version

# 3. 发布（prepack 钩子会自动先执行 build:cli 再上传）
npm publish --workspace @trajex-apps/cli

# 4. 验证
npm view @trajex-apps/cli version
npm i -g @trajex-apps/cli   # 本地全局更新
```

### 说明

- `packages/cli` 的 `prepack: "npm run build"` 保证发布的永远是新鲜构建产物；
- `files: ["dist", "README.md"]` 决定 tarball 内容，`publishConfig.access: "public"`
  允许组织 scope 以公共包发布；
- 误升版本号后，在**尚未发布**前可随时用
  `npm version <版本> -w @trajex-apps/cli --no-git-tag-version` 回退；
- 发布刚完成后立刻 `npm view` 可能短暂 404（registry CDN 传播延迟），稍等重试即可。

## SQLite Schema

<div align="center">
  <img src=".github/assets/sql_schema.png" alt="Trajex App" width="900">
</div>

| Layer | Source | 捕获内容 |
|-------|--------|----------|
| **Sessions** | Claude `<project>/<sessionId>.jsonl`; Codex `sessions/YYYY/MM/DD/*.jsonl`; Pi recursive official v3 `*.jsonl` | Title、project、timestamps、git branch、source |
| **Messages** | user + assistant turns | Full text、model、token usage、parent chain |
| **Tool calls** | every tool invocation | Tool name、input、file paths |
| **Subagents** | Claude `subagents/agent-<id>.jsonl` | Agent type、description、full conversation |
| **Workflows** | Claude `workflows/wf_<runId>.json` | Script、result、agent count |
| **Workflow agents** | Claude `subagents/workflows/wf_<runId>/` | Per-agent transcripts |
| **Memories** | registered markdown files | Conclusions linked to source sessions |

通过 FTS5 实现的全文搜索会覆盖所有 layers。

## 结构

```
packages/core/                # @trajex/core npm workspace（TypeScript + ESM）
├── src/
│   ├── providers/
│   │   ├── types.ts          # Provider + TranscriptRecord contract
│   │   ├── claude.ts         # Claude Code adapter（行增量）
│   │   ├── codex.ts          # Codex adapter（全量重解析）
│   │   └── pi.ts             # Pi adapter（v3 context + visibility projection）
│   ├── session-detail.ts     # Provider-independent transcript projection
│   ├── persist.ts            # Binding-agnostic record writer（upsert/merge）
│   ├── tx.ts                 # Write transaction + connection config
│   ├── write-coordinator.ts  # Bounded retry policy
│   ├── writer-lease.ts       # Cross-process single-writer lease（SQLite lock DB）
│   ├── core.ts               # buildIndex / searchText / executeQuery / executeAttune
│   ├── indexer.ts            # Skill orchestration（discover → persist → finalize）
│   ├── parsing.ts            # Pure helpers（node:sqlite-free, app-consumable）
│   ├── db.ts                 # node:sqlite lifecycle + migrations
│   ├── query.ts              # Query/attune sandbox API（helpers）
│   └── schema.sql            # SQLite schema（single source of truth）
├── package.json
└── dist/                     # Generated package JS, declarations, and schema

packages/cli/                 # @trajex-apps/cli npm workspace
├── src/trajex.ts            # CLI shell
├── scripts/build.mjs         # Compiles CLI + readable Core into one package
├── package.json
└── dist/                     # Generated platform-neutral npm payload

trajex-skill/                    # docs-only trajex agent skill 的源码
├── SKILL.md                  # Query and memory workflow
└── references/               # Progressive-disclosure API/schema/pattern docs

app/                          # Electron desktop app（electron-vite + Vue）
├── src/main/                 # TypeScript main process（consumes shared core）
├── src/preload/              # CJS preload（sandbox）
├── src/renderer/             # Vue renderer
└── electron.vite.config.ts

install.sh                    # POSIX CLI-only installer
CONTEXT.md                    # Project glossary
docs/adr/                     # Architecture decision records（0001–0006）
```

### 生成的构建产物

- `packages/core/dist/` 由 `npm run build:core` 生成。它是编译后的内部 `@trajex/core` workspace：JavaScript、type declarations 和 `schema.sql`。
- `packages/cli/dist/` 由 `npm run build:cli` 生成。它是可发布的 `@trajex-apps/cli` payload：薄命令 shell、可读的 compiled Core，以及 `schema.sql`。
- `packages/cli/dist/` 是生成产物，不应该手动编辑。Electron app 会直接 import `packages/core/src/`，以便 electron-vite 可以 bundle Core。

## 许可证与版权

Trajex 采用 [GNU AGPL-3.0-only](LICENSE) 许可证发布。
