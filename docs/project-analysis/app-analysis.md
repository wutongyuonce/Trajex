# Trajex App 架构解析（Vue / Electron 入门版）

> 本文按当前 `app/` 目录的代码梳理（版本见 `app/package.json`）。它和 [cli&core-analysis.md](./cli&core-analysis.md) 配套阅读：后者解释「原始 Agent 日志怎样成为统一数据和 SQLite」，本文解释「桌面 App 怎样维护这些数据并把它变成界面」。

## 0. 先用一句话建立全局感觉

Trajex App 是一个 Electron 桌面程序：它在本机持续监听 Claude Code、Codex、Pi 等 Agent 的历史文件；用后台线程把变化写入 SQLite；再让 Vue 页面通过受限的 IPC API 浏览会话、记忆和统计数据。

它**不是**「Vue 直接读取 JSONL 文件」的应用。真正的数据主链路是：

```text
Agent 写本机历史文件
Claude、Codex、Pi 等工具各自会把会话、消息、执行记录写到本地文件。
这一步是“原始数据产生”，Trajex 不需要让 Agent 改接自己的接口。
        │
        ▼
Electron 主进程监听文件（chokidar）
App 像一个后台观察员，盯着这些历史目录有没有新增或修改文件。
它会等文件写完、合并短时间内连续变化，避免 Agent 正在写文件时就读到半截内容。
        │
        ▼
Node Worker Thread 做索引
监听服务发现稳定变化后，把处理工作交给后台 worker。
Worker 负责读取历史、识别不同 Agent 的格式、提取会话和消息，并把数据存起来；放在 worker 中可避免卡住 Electron 主进程和界面。
        │
        ▼
~/.trajex/trajex.sqlite 本地数据库
这是 Trajex 的“统一记忆库”。
原始历史可能是很多工具、很多格式、很多文件；数据库把它们整理成可查询的结构，并保存索引、摘要、关系或标记等衍生信息。
        │
        ▼
Electron main 的 IPC handler 查询与组装
页面不能直接随意访问本机文件或数据库，因此会向主进程发请求，例如“给我最近会话”“加载这个会话详情”。
主进程执行 SQL、补齐关联数据，再返回页面真正需要的结果。
        │
        ▼
preload 注入 window.trajex 白名单 API
这是安全闸门。网页界面只拿到明确允许的少量能力，例如 listSessions()、getSession()；它拿不到 Node、文件系统或任意 SQL 权限。
所以即使页面代码出问题，危害范围也更小。
        │
        ▼
Vue renderer 渲染界面
最后 Vue 把 API 返回的数据变成列表、详情、Memory、Activity、Settings。
它负责展示和用户交互，不负责直接读文件、建索引或操作数据库。
```

因此，排查问题时先问它属于哪一层：

| 现象 | 优先看哪里 |
| --- | --- |
| 某个 Agent 的日志没有进入数据库 | `packages/core/src/providers/`、`app/src/main/indexer.ts` |
| 数据库有数据但 App 没显示 | `app/src/main/index.ts` 的 SQL / IPC、`app/src/renderer/src/data.js` |
| 会话详情的工具、Thinking、Workflow 排版不对 | `packages/core/src/session-detail.ts`、`session-timeline-items.mjs`、`SessionTimelineRow.vue` |
| 文件改了，界面没有自动刷新 | `indexer-service.ts`、worker、`notifyIndexUpdated()`、`session-live*.mjs` |

## 1. 给 Vue / Electron 初学者的四个名词

### 1.1 Electron 的三个进程边界

Electron 同时具备「桌面程序」和「网页」能力，但它不会把所有代码放进一个 JavaScript 环境。

```text
┌──────────────────────────────────────────────────────────┐
│ main process（主进程，Node / Electron 权限）               │
│ 创建窗口、打开 SQLite、文件监听、系统文件与对话框、IPC     │
└───────────────────────┬──────────────────────────────────┘
                        │ IPC
┌───────────────────────▼──────────────────────────────────┐
│ preload（预加载脚本，安全桥）                              │
│ 只把允许的能力挂到 window.trajex                           │
└───────────────────────┬──────────────────────────────────┘
                        │ 浏览器 API
┌───────────────────────▼──────────────────────────────────┐
│ renderer（渲染进程，Vue 网页）                             │
│ 组件、路由、状态、DOM、CSS；没有 Node 文件系统权限          │
└──────────────────────────────────────────────────────────┘
```

### 1.2 为什么 renderer 不能直接 `import fs`

创建窗口时，main 明确设置：

```ts
webPreferences: {
  preload: path.join(__dirname, '..', 'preload', 'index.js'),
  contextIsolation: true,
  nodeIntegration: false,
}
```

这表示网页代码与 Electron/Node 上下文隔离，且没有 Node integration。即使某条日志的 Markdown 含有恶意脚本，页面也不能直接读你的磁盘。renderer 想查数据，唯一正规路径是：

```js
const sessions = await window.trajex.getSessions({ source: 'all' });
```

### 1.3 IPC 是什么

IPC（Inter-Process Communication）就是**进程间调用**：

```text
renderer: window.trajex.getSessions()
    ↓
preload: ipcRenderer.invoke('db:getSessions')
    ↓
main: ipcMain.handle('db:getSessions', ...) 运行 SQL
    ↓ Promise 返回查询结果
renderer: Vue 状态更新，组件重新渲染
```

`invoke/handle` 是一问一答的异步 RPC。反方向的 `webContents.send()` / `ipcRenderer.on()` 是主进程主动通知页面，例如「索引完成」。

### 1.4 Vue 在本项目里做什么

Vue 只管理界面：`state` 是响应式对象；`computed()` 从状态导出展示数据；组件模板里的 `{{ value }}` 和 `v-for` 自动随状态变化刷新。

本项目没有 Vuex/Pinia。跨页面共享的轻量状态直接放在 `renderer/src/store.js`：会话目录、记忆、项目、统计、筛选条件、选择状态等。路由状态则交给 Vue Router，不混入 store。

## 2. 和 Core / CLI 的关系

请先把职责边界记成这张图：

```text
                    packages/core
┌───────────────────────────────────────────────────────────────┐
│ provider adapters: 原始 Claude/Codex/Pi 文件 -> TranscriptRecord│
│ persist/indexer: 统一记录 -> SQLite                             │
│ session-detail: SQLite 行/记录 -> 可显示的会话语义              │
└───────────────┬───────────────────────────────────────────────┘
                │ 被复用，而非复制
      ┌─────────┴──────────┐
      ▼                    ▼
 CLI（一次性命令）      Electron App（常驻 daemon + UI）
 `packages/cli/`        `app/`
```

- Core 是事实层：provider 差异、canonical `TranscriptRecord`、数据库 schema、写入语义、会话详情组装都在那里。
- CLI 是薄命令行入口：用户或 Agent 主动运行时，调用 Core。
- App 是常驻入口：它用自己的 `better-sqlite3` 连接和后台监听语义，但复用 Core 的 provider registry、索引计划、持久化、事务和详情组装。

App 不应重新理解 Codex/Claude 的原始 wire format；新增 provider 的主要修改也应留在 Core。详情展示所需的新字段，先考虑通过 Core 的 `session-detail.ts` 组装出来，再传给 renderer。

## 3. App 目录与构建产物

```text
app/
├── electron.vite.config.ts      三端构建规则
├── package.json                 开发、打包、测试命令
├── src/
│   ├── main/                    主进程 + 索引后台服务
│   ├── preload/                 window.trajex 安全桥
│   ├── renderer/                Vue 应用和 CSS
│   └── shared/                  main/preload/renderer 共用契约
├── resources/icon.png           macOS 图标
└── tests/                       Electron 与纯 Node 测试
```

`electron.vite.config.ts` 会分别构建三类入口：

| 层 | 源入口 | 产物用途 |
| --- | --- | --- |
| main | `src/main/index.ts` 和 4 个 `indexer*` 文件 | 输出到 `out/main/`；worker 必须是可单独加载的 JS 文件 |
| preload | `src/preload/index.ts` | 输出 CommonJS 的 `out/preload/index.js`，供 Electron 加载 |
| renderer | `src/renderer/index.html` | Vite 打出的 Vue/HTML/CSS/JS 静态页面 |

主进程的五个 Rollup input 不能随便合并。`indexer-worker-client.ts` 在运行时用 `new Worker(.../indexer-worker.js)` 启动旁边的独立文件。

`app/package.json` 的常用命令：

```bash
cd app
npm run dev                    # Vite 开发服务器 + Electron
npm run pack                   # 构建未签名的目录包
npm run build                  # 构建并交给 electron-builder 打包
npm run test:electron          # 并发/索引 Electron 测试
npm run test:electron:timeline # 长会话虚拟列表测试
npm run test:electron:reader-state # 阅读位置状态测试
npm run test:local-links       # 本地 Markdown 链接纯 Node 测试
```

打包时 `schema.sql` 会被作为额外资源带入应用；`better-sqlite3` 被解包，以便它的原生模块能被 Electron 加载。

### 3.1 安装后的 `.app`：二进制、代码和原生模块分别是什么

macOS 打包完成后，Trajex 的 `.app` 大致是下面这个样子（省略图标、框架和签名文件）：

```text
Trajex.app/
└── Contents/
    ├── MacOS/Electron                 Electron 宿主二进制
    └── Resources/
        ├── app.asar                   打包后的 App JS / HTML / CSS 等资源
        ├── app.asar.unpacked/         需要真实文件路径的原生模块
        │   └── node_modules/better-sqlite3/.../*.node
        └── scripts/schema.sql         extraResources 带入的数据库 schema
```

- **`Electron` 宿主二进制**：是真正的机器码。Electron 在编译时已组合 Chromium、Node.js 和 Electron 自身的原生能力；它启动后负责创建 main process 和 renderer process。
- **`app.asar`**：是应用资源归档，不是把 TypeScript/JavaScript 编译成机器码。Electron/Node 会从中读取构建后的 JavaScript，再由 V8 在运行时执行。它的作用主要是整理和打包应用资源，不是安全边界。
- **`better-sqlite3` 的 `.node` 文件**：是提前用 C/C++ 编译的原生动态库。系统动态加载器需要真实的磁盘文件路径，因此 `app/package.json` 用 `asarUnpack` 把它放到 `app.asar.unpacked/`，而不是只留在归档内。
- **`schema.sql`**：不是运行时代码，而是 App 创建或迁移 SQLite 时要读取的数据文件；项目通过 `extraResources` 将它放进 `Resources/scripts/`。

启动链路可以理解成：**宿主二进制启动 → 读取 `app.asar` 中的 main 入口 JS 解析为机器码指令→ main 创建窗口和后台服务 → Chromium 加载 renderer 页面**。开发模式下 renderer 来自 Vite 开发服务器；生产模式下来自构建后的本地 `index.html`。

### 3.2 main、preload、renderer、worker 实际在哪运行

它们都能写 JavaScript，但不是同一个执行环境，也不应互相越权：

```text
Electron 宿主进程
│
├─ main process（一个 Node/Electron 主进程）
│  ├─ 创建 BrowserWindow、监听文件、访问 SQLite、处理 IPC
│  └─ 启动 Node worker thread 做索引
│
└─ BrowserWindow
   └─ Chromium renderer process（每个窗口一个网页进程）
      ├─ preload 的 isolated world：可用 ipcRenderer，只做安全桥
      └─ renderer 的 main world：Vue、DOM、CSS，只能用 window.trajex
```

- **main process** 是桌面 App 的后端：本项目入口是 `app/src/main/index.ts`。它有 Node 和 Electron 的系统权限。

- **renderer process** 是窗口里的 Chromium 网页进程。Vue 应用运行在这里；每个 `BrowserWindow` 都会有独立的 renderer process。

- **preload** 不是另一个进程。它和 Vue 同在 renderer process，但运行在 Chromium 的 **isolated world**（独立 JavaScript world/全局对象）中，页面脚本不能直接取得它的 `ipcRenderer`。

- **Node worker thread** 也不是一个新 Electron 窗口或一个独立命令行程序；它是 main process 用 Node.js `worker_threads` 开出的后台线程。它有自己的 V8 isolate，适合文件扫描、JSONL 解析和 SQLite 写入，避免阻塞 main 的窗口与 IPC 工作。

  ```ts
  import { Worker } from 'node:worker_threads'
  new Worker('indexer-worker.ts')
  ```

可以粗略说「Electron 各层都由 V8 执行 JavaScript」，但不要把它理解为一个共享的 V8 实例：main、worker、renderer 都有独立的 JavaScript 执行环境；preload 与页面则是同一 renderer process 内的不同 world。

### 3.3 这套设置如何限制权限

`createWindow()` 使用了下面的配置：

```ts
webPreferences: {
  preload: path.join(__dirname, '..', 'preload', 'index.js'),
  contextIsolation: true,
  nodeIntegration: false,
}
```

- `nodeIntegration: false`：Vue 页面没有 `require`、Node `process`、`fs` 等 Node 全局能力，不能直接读写用户文件。
- `contextIsolation: true`：preload 和页面脚本的 JavaScript 上下文相互隔离。页面即使覆盖自己的 `window` 属性，也不能取得 preload 内部持有的 `ipcRenderer`。
- `preload`：项目用 `contextBridge.exposeInMainWorld('trajex', {...})` 只暴露 `window.trajex` 中列出的函数。例如 `getSessions()` 只能请求 `db:getSessions`，它既不能执行任意 SQL，也不能任意调用 Node API。

完整请求方向是：

```text
Vue renderer
  window.trajex.getSessions()
      ↓ contextBridge 暴露的包装函数
preload isolated world
  ipcRenderer.invoke('db:getSessions')
      ↓ Electron IPC
main process
  ipcMain.handle('db:getSessions', handler)
      ↓
SQLite / 文件系统；结果按 Promise 原路返回
```

因此，preload 的 API 是权限白名单，而不是方便 Vue 调用 Electron 的普通工具文件。新增能力时应由 main 校验输入并处理实际操作，再显式加到 preload；不要把 `ipcRenderer`、`fs` 或数据库连接直接暴露给页面。

### 3.4 本项目构建设置与运行时的对应关系

`app/electron.vite.config.ts` 将源码拆成三份产物：main 输出到 `out/main/`，preload 输出为 Electron 可加载的 CommonJS `out/preload/index.js`，renderer 输出为静态网页资源。worker 也被列为独立 main entry，才能在打包后由 `new Worker(.../indexer-worker.js)` 加载。

`app/package.json` 中和上述结构直接相关的配置是：

| 配置 | 当前作用 |
| --- | --- |
| `main: "out/main/index.js"` | 指定 Electron 启动的 main 入口 |
| `files: ["out/**"]` | 将三个构建产物带入安装包 |
| `asarUnpack: ["node_modules/better-sqlite3/**/*"]` | 让 `better-sqlite3` 原生 `.node` 模块留在真实文件系统中 |
| `extraResources` | 将 Core 的 `schema.sql` 复制到应用 Resources 目录 |

## 4. 从启动到看到页面：完整启动链路

### 4.1 主进程先启动

`app/src/main/index.ts` 在 `app.whenReady()` 后依次做两件事：

```text
startBackgroundResources({ runStartupBuild: true })
    ├─ 创建/复用 indexer worker
    ├─ 打开已有的 ~/.trajex/trajex.sqlite
    ├─ 启动 indexer service（heartbeat + watcher）
    └─ 请求一次 startup build

createWindow()
    ├─ 创建 BrowserWindow
    ├─ 加载 preload
    └─ 开发时 loadURL(Vite)，生产时 loadFile(renderer/index.html)
```

数据库尚不存在时，普通 `openDb()` 会返回 `null`；首次索引由 worker 创建数据库和 schema。已有数据库需要补列时，main 只有取得 writer lease 后才迁移并把真实连接交给 IPC；若 lease 被占用，真实连接立即关闭，后续 SQL 统一报告 `schema upgrade is blocked by writer_busy`，不会继续暴露旧结构的 `no such column`。退出时 `before-quit` 会先停止 watcher、终止 worker、关闭数据库，再真正退出，避免后台线程或 SQLite 连接被硬切断。

### 4.2 renderer 再启动 Vue

`app/src/renderer/src/main.js` 是 Vue 的入口：

```text
createApp(App)
  -> app.use(router)
  -> app.mount('#app')
  -> router.isReady() 后
  -> fetchInitialData() 并行读取 memories / sessions / stats / projects
  -> commitInitialData() 写入 store
```

它还注册三种全局刷新来源：

1. 首次路由就绪；
2. 窗口从后台回到前台（`visibilitychange`）；
3. main 发来的 `trajex:index-updated`。

若用户正在阅读 `SessionDetail`，全局目录刷新会先延迟。详情页走自己的增量更新，避免一个全量目录刷新把正在读的长时间线打断。

## 5. 索引 daemon：文件变化如何进入 SQLite

这是 App 最重要的后台主链路。

```text
providerRegistry.watchRoots(providerRoots)
   │  Claude / Codex / Pi 等已配置根目录
   ▼
chokidar 监听 .jsonl / .json 的 add、change、unlink
   │
   ▼
createIndexerService.scheduleBuild('watch', changedPath)
   │  Set 去重变化路径；2s debounce；至少 500ms 写稳定等待
   ▼
worker client.postMessage({ id, args })
   ▼
indexer-worker.ts: buildIndex(args)
   ▼
app/main/indexer.ts
   │  writer lease -> provider plan -> persist -> finalize
   ▼
SQLite commit
   ▼
main/index.ts: notifyIndexUpdated(affectedSessionIds)
   │
   ├─ trajex:index-updated
   └─ trajex:session-updated { sessionId }
```

### 5.1 `main/indexer-service.ts`：只负责调度，不解析数据

`createIndexerService()` 是 watcher 和节流器。它不知道 Claude/Codex 格式，也不写业务 SQL；它只负责什么时候请求一次构建。

| 状态/参数 | 含义 |
| --- | --- |
| `changedPaths: Set` | 收集并去重本轮变化的文件 |
| `running` | 当前是否已有 build 在跑 |
| `pending` | build 期间是否又发生变化；结束后再跑一次 |
| `debounceMs = 2000` | 多次文件事件合为一次构建 |
| `stabilityMs = 500` | 等写入稳定，避免读取半截 JSONL |
| `heartbeatMs = 30000` | 每 30 秒更新一次 daemon 存活标记 |
| `deferredRetryMs = 250` | 遇到 writer busy 后的短暂重试 |

`chokidar` 在 Node 的文件事件 API 上做跨平台归一化（macOS FSEvents、Linux inotify、Windows ReadDirectoryChangesW）。这里使用 `awaitWriteFinish`，再加 service 自己的 debounce，重点是正确性而非「每一次保存都立刻建索引」。

当配置目录暂时不存在时，service 不会崩溃，而是按 `watchRetryMs = 5000` 重试建立监听。

### 5.2 worker：让窗口不被索引工作卡住

- `indexer-worker-client.ts`：main 侧客户端。懒创建 `Worker`，给每个请求分配递增 `id`，在 `pending: Map<id, {resolve,reject}>` 里等待响应；worker 出错/退出时拒绝所有未完成请求。
- `indexer-worker.ts`：真正的 worker 入口。收到 `{ id, args }` 后调用 `buildIndex(args)`，把 `result` 或序列化的错误传回。

索引包含文件扫描、JSONL 解析、事务写入和 FTS 重建，放在 worker 的目的就是保证 `BrowserWindow`、IPC 和窗口拖动仍然流畅。

### 5.3 `main/indexer.ts`：App 版的索引执行器

它复用 Core 的 `createProviderIndexPlan()`、`indexProviderPlan()`、事务工具和 writer lease，但负责 Electron daemon 特有的连接和结果格式。

`buildIndex()` 的顺序是：

```text
1. 获取跨进程 writer lease；拿不到返回 { deferred: true }
2. openIndexDb()：创建目录、打开 better-sqlite3、安装/迁移 schema
3. 创建内置 provider registry 和本次 provider index plan；临时库 rebuild 从旧库读取 Provider provenance
4. force/canonical rebuild 先预检现有 Provider 来源根，通过后才清理会话派生表（保留 memories）
5. 逐项执行 provider plan
   └─ 每个 unit 通过可重试 SQLite 写事务进入数据库
6. 一个 finalize 事务：补 project_path、补 Workflow 父链接、保证 FTS、写索引 marker
7. PASSIVE WAL checkpoint，关闭本次 worker 的数据库连接
8. 返回 affectedSessionIds，供 UI 精确刷新
```

几个容易混淆的点：

- **writer lease** 在独立的 `writer.lock.sqlite` 上保证同一时刻只有一个索引写者，避免 App 与 CLI 抢写。

Workflow 的 `parent_tool_use_id` 最终指向 `tool_calls.id`。App finalize 会调用 Core 的 `healWorkflowParentLinks()`：当 workflow JSON 先入库、主 transcript 的 `tool_result` 后到时，按同一 session 的唯一 `run_id` 从 `tool_results.content` 找到对应的 `Workflow` tool call，并把 `tool_results.tool_use_id` 回填；无法确认时保持 `NULL`，不按 workflow 名称猜测。
- **deferred 不是失败**。遇到锁忙时 service 会稍后再试，不把数据库并发看成解析错误。
- `changedPaths` 让 provider plan 尽可能只处理变化的单元；手动 rebuild 的 `force: true` 才走全量重建。
- force 重建会先读取旧库的 Provider provenance 并预检现有来源根；任一根不可用时在清理前整体失败。通过后才建立临时数据库、复制旧库的 `memories`，成功后原子替换主数据库。因此根目录故障或中途失败都不会替换当前可用索引。

### 5.4 heartbeat 的意义

`writeHeartbeat()` 在 `index_state` 写入 `__app_heartbeat__` marker。它说明常驻 App 还活着、正在负责更新索引；Core/CLI 可据此避免无意义地和 daemon 竞争写入权。它不是业务数据，也不是某个真实 JSONL 的进度。

## 6. SQLite、设置与系统能力

### 6.1 数据库位置与连接

默认数据库是 `~/.trajex/trajex.sqlite`；设置文件是 `~/.trajex/settings.json`。App 的 main 使用 `better-sqlite3`，配置 busy timeout 与 WAL，并在持有 writer lease 时安装 schema / 补列迁移。schema 已经可读时，即使另一个 writer 暂时持锁也可以继续读取；只有“确实需要迁移但无法取得 lease”时才阻止 IPC 数据访问。

Core 的 schema、表含义和 provider 解析请看 `cli&core-analysis.md`。App 主要读取：

```text
sessions / messages / tool_calls / tool_results
subagents / workflows / workflow_agents / summaries
memories / index_state
```

### 6.2 `main/provider-settings.ts`

这里是纯设置转换层，不碰 Electron UI：

- `resolveProviderRoots()`：把 `settings.json` 中 `providerRoots.<id>`（兼容旧的 `<id>Dir`）和 provider 默认根目录合成实际路径。
- `setPersistedSetting()`：更新嵌套 provider root 设置，空值则删除覆盖项。
- `buildSourceCatalog()`：把 registry descriptor、目录是否存在、每种 source 的会话统计组合成 Settings 页面可直接展示的数组。

主进程的 `settings:set` 在根目录变化时会停止旧 watcher、按新设置重新打开数据库/启动 watcher；`autoRefresh` 关闭时则停掉 daemon。`settings:rebuildIndex` 负责上节的临时库重建流程。

### 6.3 仅由 main 执行的本地文件操作

`main/local-markdown-link.mjs` 处理 Markdown 中的本地绝对路径链接：

- 去掉可选的 `:line[:column]` 后缀；
- 只接受真实存在的绝对文件；
- 预览最多读取 12 KiB，二进制文件不显示文本预览；
- 真正用系统默认程序打开前弹确认框。

相应 renderer 代码只能请求预览/打开，不能任意调用 `fs`。

## 7. IPC：页面到底可以调用什么

`app/src/preload/index.ts` 是 **API 白名单的唯一清单**。它通过：

```ts
contextBridge.exposeInMainWorld('trajex', { ... })
```

把下面能力放到 `window.trajex`。新增 renderer 能力的完整路线必须是：main handler -> preload 白名单 -> renderer 调用；不要绕过 preload。

| API 分组 | preload 方法 | main 中做的事 |
| --- | --- | --- |
| 全局目录 | `getSessions`、`getProjects`、`getStats`、`getUsageStats` | 查询 sessions、项目聚合、统计 / token 使用量 |
| 主会话详情 | `getSessionMessages`、`getSessionToolCalls`、`getSessionToolResults`、`getSessionSubagents`、`getSessionWorkflows`、`getSessionSummaries` | 从多张表读行；详情组装在 renderer/Core 完成 |
| 增量详情 | `getSessionPatch` | main 组装显示快照后与 cursor 比较，返回 patch 与最新 session metadata |
| 子代理详情 | `getSubagentMessages`、`getSubagentToolCalls`、`getSubagentToolResults`、`getSubagentSummaries` | 用 `agent_id` 查询同样的事实 |
| 原始内容与链接 | `getMessageFullText`、`readMemoryFile`、`previewLocalMarkdownLink`、`openLocalMarkdownLink` | 通过 provider `raw()` 回读原始内容，或安全处理本地 Markdown 链接 |
| Memory | `getMemories`、`archiveMemory`、`restoreMemory` | 列表查询；归档/恢复在 writer lease 下更新软删除字段 |
| Settings | `getSettings`、`browseFolder`、`setSetting`、`revealPath`、`rebuildIndex` | 读写 JSON、系统对话框、显示路径、重建数据库 |
| 订阅 | `onIndexUpdated`、`onSessionUpdated` | 监听 main 主动发送的事件，并返回取消订阅函数 |

`main/index.ts` 的 `sourceWhereClause()` 统一处理 `source` 筛选：`source: 'all'` 不过滤，指定 source 只取那一类，未指定时采用 Claude 兼容默认值。所有 SQL 参数通过预编译语句传入，不把页面字符串拼成 SQL 值。

### 7.1 `getMessageFullText` 为什么不只查数据库

为了索引大小和性能，普通消息正文可能被截断。用户点击「加载完整内容」时，main 根据 message、session、subagent/workflow 元数据调用 provider registry 的 `raw()`；provider 知道如何回到该 source 的原始日志。这样 renderer 仍然不需要理解任何 provider 原始格式。

工具结果走另一条路径：`content_type === 'tool_result'` 的 message 只是时间线和 FTS 使用的最多 1,000 字符首尾预览，不会独立渲染。Core 以 `tool_use_id` 将 `tool_results.content` 挂到对应 tool call，App 的工具卡片展示这份最多 10,000 字符的首尾结果；当前工具卡片没有独立的 `raw()` 全文展开入口。

## 8. 从数据库行到详情时间线

会话详情不是把 `messages` 表逐行 `v-for`。它有两层投影：先在 Core 解决事实关系，再在 renderer 解决 UI 行。

```text
SQLite rows
  messages + tool_calls + tool_results + workflows + workflow_agents + summaries
        │
        ▼
packages/core/src/session-detail.ts
  assembleSessionDetail(...)
        │ AssembledMessage[] / workflows / summaries
        ▼
renderer/session-timeline-items.mjs
        │ TimelineItem[]（真正的虚拟列表行）
        ▼
components/SessionTimelineRow.vue
        │ 一行选择对应 Vue 模板、折叠与格式化
        ▼
浏览器 DOM
```

### 8.1 Core assembly：先解决「这些记录属于谁」

`session-detail.ts` 的输出不是模糊的 `Record[]`，而是可读消息块：

| 输入 | 组装规则 |
| --- | --- |
| `message` | 成为基础 `AssembledMessage` |
| `tool_call` | 以 `message_uuid` 挂到 `message.tool_calls[]` |
| `tool_result` | 以 `tool_use_id` 挂到对应 tool call 的 `result`，展示最多 10,000 字符的首尾内容；对应的预览 message 不会单独显示 |
| `workflow` | 以 `parent_tool_use_id` 关联到名为 `Workflow` 的工具调用 |
| `workflow_agent` | 以 `run_id` 归入 workflow 的 `agents[]` |
| `summary` | 留在 `summaries[]`，按时间插入 UI 时间线 |

几个展示友好的归并规则也在这一层完成：连续 thinking 被合并并尽量挂到后续 assistant 消息的 `_thinking`；连续 tool use 与前面的 assistant 文本归为一次 assistant 回合；隐藏消息不进入详情。这一层是 provider 无关的，不能在 renderer 重新做一次 join。

### 8.2 UI assembly：再决定「占几个时间线行」

`session-timeline-items.mjs` 很薄，只将已组装的数据切成稳定 `TimelineItem`：

| `kind` | 何时生成 | 为什么单独一行 |
| --- | --- | --- |
| `message` | 普通用户/assistant 消息 | 文本、附着的 thinking、普通工具一起显示 |
| `thinking` | 没有可附着目标的纯 thinking | 需要单独的可折叠行 |
| `meta` | `is_meta === 1` | 用紧凑的 System 样式 |
| `workflow` | 有已关联 workflow 的 `Workflow` 工具 | 展示 agent、phase 和跳转 |
| `workflow-tools` | 同一消息里 workflow 之外还有工具 | 不让普通工具被 workflow 卡片吞掉 |
| `summary` | Core summaries | 按 timestamp 插到消息间 |

特意不对所有 item 做全局排序。消息原来的 transcript 顺序是权威顺序；全局排序会让缺失或相同时间戳的消息错序，也会破坏虚拟列表的行身份。

### 8.3 `SessionTimelineRow.vue` 与展示辅助文件

`SessionTimelineRow.vue` 根据 `item.kind` 选择模板，负责用户可见交互：展开/收起、显示 raw、加载完整文本、跳转子代理。它不查询数据库。

- `session-timeline-presentation.mjs`：把一个时间线 item 预处理成标题、HTML、工具详情、workflow 分组等展示模型。
- `tool-renderer.js`：纯格式化器，转义 HTML、简单高亮 JSON/JavaScript、将终端/CodeAct 工具输入输出变成可读块。
- `utils.js`：时间、项目名、文本和 Markdown 工具；Markdown 使用 `marked` 并用 `DOMPurify` 做净化。

## 9. 长会话为何不会卡：数据缓存、patch 与虚拟列表

### 9.1 `renderer/src/data.js`：renderer 的数据访问层

组件不要到处直接调用 `window.trajex`。`data.js` 集中承担「IPC 原始数据 -> Vue 能用的数据」：

| 函数 | 做什么 |
| --- | --- |
| `fetchInitialData()` | 并行读取 memory、session、stats、projects，但不立刻改状态 |
| `commitInitialData()` | 转换 memory 字段，更新全局目录，同时保留已经加载的会话详情 |
| `loadSessionDetail(id)` | 并行获取六组详情行，调用 Core assembly，建立本地 patch cursor |
| `fetchSessionDetailPatch(id)` | 有缓存 cursor 时请求最小增量；无缓存则让上层走全量加载 |
| `materializeSessionDetailPatch()` | 用 shared patch 算法生成新快照，并算出是否只是尾部追加 |
| `loadSubagentDetail(id)` | 用同一 assembly 逻辑加载子代理会话 |
| `loadFullText()` / `loadMemoryMarkdown()` | 在用户需要时才读取完整原始文本或记忆文件 |

详情快照最多缓存 3 个会话，避免切换多个长会话时无限占用 renderer 内存。

### 9.2 `shared/session-patch.mjs`：增量更新协议

它由 main 和 renderer 共用。核心是为每张详情表选择稳定主键：

```text
messages -> uuid              toolCalls -> id
toolResults -> tool_use_id    subagents -> agent_id
workflows -> run_id           summaries -> id
```

`createSessionPatchCursor(snapshot)` 记录每行的「位置 + 内容 hash」。main 的 `createSessionPatch(snapshot, cursor)` 只返回变更行、删除 ID、新 hash、正确位置；renderer 的 `applySessionPatch()` 只在必要时删除、插入或重排。若只是末尾新增，它直接追加数组。

这里的 patch 操作对象是**已组装的显示快照**。当前详情 IPC 返回 `messages`、`workflows`、`summaries` 三组显示数据；另外三张表的表名仍保留在共用协议中，便于完整的详情快照比较。

### 9.3 `SessionDetail.vue`：实时阅读协调器

这是最大的 renderer view。它不只显示消息，还把「实时更新」和「用户正阅读」协调起来：

```text
收到 trajex:session-updated
  -> 当前会话：请求 detail patch
  -> 用户正滚动：先保留最新快照，不移动页面
  -> 用户停止滚动：应用最新 patch
  -> reconcile timeline item，尽量保留未变行对象
  -> 虚拟列表测量/恢复阅读锚点
```

相关小模块分别只做一个小问题：

| 文件 | 职责 |
| --- | --- |
| `session-live.mjs` | 记录非当前会话是否变脏；以后打开时强制刷新 |
| `session-live-reload.mjs` | 合并多次通知；滚动时不提交会导致跳动的快照 |
| `session-global-refresh.mjs` | 当前在详情页时，延迟全局目录的全量提交 |
| `session-timeline.mjs` | 全量快照 fallback 时复用未变消息对象，并识别 tail-only |
| `session-timeline-viewport.mjs` | `@tanstack/vue-virtual` 的行高估算、可见范围、锚点恢复 |
| `session-timeline-scroll-policy.mjs` | 用户滚动期间抑制虚拟列表的自动位置修正 |
| `session-user-scroll.mjs` | 识别 wheel/scroll/scrollend 的连续手势 |
| `session-reader-state.mjs` | LRU 缓存 12 个会话的锚点、折叠状态、全文展开状态 |
| `session-disclosures.mjs` | 管理某个消息/工具/summary 的展开与 raw 开关 |
| `session-sidechains.mjs` | 迁移为按 `visibility` 展开 Pi 的 inactive 分支；默认只展示 visible |
| `session-segment-navigation.mjs` | 将 conversation round 分段，支持右侧小导航 |

这组代码看似多，但边界明确：它们都不懂 SQL、provider 或 Vue 页面业务，只保护长列表阅读体验。

## 10. Vue 页面和组件地图

### 10.1 路由

`renderer/src/router.js` 使用 hash 路由（地址类似 `#/sessions/<id>`），并按需懒加载各 view：

| 路径 | View | 页面作用 |
| --- | --- | --- |
| `/sessions` | `SessionList.vue` | 会话目录、搜索、项目/来源筛选、噪声会话折叠 |
| `/sessions/:id` | `SessionDetail.vue` | 主会话的虚拟时间线与实时阅读 |
| `/sessions/:id/agent/:agentId` | `SubagentDetail.vue` | 单个子代理详情 |
| `/memory`、`/memory/:id` | `MemoryList.vue` | Memory 列表、详情、归档/恢复、撤销窗口 |
| `/activity` | `Activity.vue` | token 用量、热力图、连续工作日、会话活动 |
| `/settings` | `Settings.vue` | provider 根目录、自动刷新、索引重建、数据库路径 |

`App.vue` 是外壳：侧边栏、顶部工具栏、来源筛选、全局快捷键、面包屑和 `<router-view>`。它不承载某页的数据库读取逻辑。

### 10.2 每个 view 的职责

| 文件 | 数据来源 | 核心职责 |
| --- | --- | --- |
| `SessionList.vue` | `state.sessions` | 按搜索、项目、来源、排序得到可见会话；跳转详情 |
| `SessionDetail.vue` | `data.js` 的 detail snapshot + session 事件 | 增量加载、虚拟列表、阅读位置、全文、子代理跳转、字体和分段导航 |
| `SubagentDetail.vue` | `loadSubagentDetail()` | 子代理的消息、工具、summary 与全文加载 |
| `MemoryList.vue` | `state.memories` + `data.js` | 选择、键盘操作、详情 Markdown 懒读、归档/恢复和短时撤销 |
| `Activity.vue` | `state.sessions` + `getUsageStats()` | 派生活动热力图、周/月趋势、连续天数，点击回到会话 |
| `Settings.vue` | `window.trajex.getSettings()` | 修改 source 根目录和自动刷新、调用重建索引 |

### 10.3 可复用组件与纯 UI 辅助

| 文件 | 作用 |
| --- | --- |
| `components/SessionTimelineRow.vue` | 一个时间线 item 的渲染与点击交互 |
| `components/ActivityLedger.vue` / `ActivityLedgerRow.vue` | 将活动会话按 source/项目组合成可展开 ledger |
| `components/FlapNumber.vue` | 对数字变化使用可尊重 reduced-motion 偏好的翻牌动画 |
| `activity-ledger.mjs` | Activity ledger 的分组与元信息格式化 |
| `flap-number.mjs` | 翻牌队列和状态机，限制中间帧数量 |
| `keyboard-shortcuts.mjs` | 全局与 Memory 页面快捷键规则 |
| `sidebar-projects.mjs` | 按项目统计并生成侧边栏项目列表 |
| `source-catalog.mjs` | source 名称/颜色的查找与 fallback |
| `local-markdown-links.js` | renderer 侧悬停预览与点击请求；实际文件读写仍在 main |

### 10.4 样式

`renderer/styles/` 是按页面区域拆分的普通 CSS：`base.css`（基础变量/重置）、`sidebar.css`、`toolbar.css`、`list.css`、`detail.css`。入口 `main.js` 全局 import 它们，不使用 CSS-in-JS。

## 11. 两条 UI 数据流

### 11.1 普通查询流：打开一个会话

```text
点击 SessionList 的某一项
  -> router.push({ name: 'SessionDetail', params: { id } })
  -> SessionDetail.vue mounted
  -> data.loadSessionDetail(id)
  -> preload 的 6 个 db:getSession* IPC
  -> main/index.ts 从 SQLite 读取各表
  -> Core assembleSessionDetail(rows)
  -> renderer 建立 snapshot + patch cursor
  -> reconcileTimelineItems(messages, summaries)
  -> TanStack Virtual 只渲染可见的 SessionTimelineRow
```

首次加载时 renderer 组装详情；刷新时 main 会先组装显示快照再产生 patch。两者都通过 `shared/session-detail-assembly.mjs` 复用 Core 的唯一 `assembleSessionDetail` seam，不产生两套不同的归并规则。

### 11.2 实时索引流：Agent 又写了一条消息

```text
原始 JSONL 改变
  -> watcher 调度 worker build
  -> worker 写入 SQLite，返回 affectedSessionIds
  -> main 向所有窗口发 index-updated，向受影响会话发 session-updated
  -> main.js 让目录数据失效（详情页期间暂存）
  -> 当前 SessionDetail 请求 patch，非当前 session 标脏
  -> patch 应用后只更新改变的时间线数据
```

这两个事件刻意同时存在：`index-updated` 面向 sessions/memory/projects 等全局目录；`session-updated` 面向某一篇正在阅读的详情，避免为了尾部新增一条消息而重取整个应用目录。

## 12. 修改需求时应从哪里下手

先沿着数据方向改，不要从 UI 直接越层。

| 想改什么 | 最小正确入口 |
| --- | --- |
| 新增一种 Agent/provider | Core 的 `providers/<name>.ts`、`builtins.ts`；App 通常只自动从 registry 得到 settings/watch roots |
| 改某 provider 的原始事件解析 | Core provider adapter；不要在 Vue 或 App SQL 中识别原始 JSONL |
| 新增数据库事实字段 | `schema.sql` + migrations + `TranscriptRecord` + persist + Core assembly；之后才考虑 App IPC/UI |
| 给详情添加已有事实的展示 | 优先 `packages/core/src/session-detail.ts`，再按需要改 main 查询、timeline item、row 组件 |
| 给首页添加新的统计 | `main/index.ts` 加只读 IPC handler -> preload -> `data.js` / 对应 view |
| 改实时体验 | `session-live*` / patch / viewport；不要用整页 reload 作为常规方案 |
| 改设置中 provider 目录 | `provider-settings.ts` 与 `settings:*` IPC；要重启 watcher 才会生效 |

新增 IPC 时要检查四处是否齐全：

```text
1. main/index.ts: ipcMain.handle('xxx', ...)
2. preload/index.ts: window.trajex.xxx = () => ipcRenderer.invoke('xxx')
3. renderer 的 data.js 或 view：调用 window.trajex.xxx
4. shared/：只有跨边界 payload 需要稳定类型时才新增类型
```

## 13. 测试与验证边界

App 的测试不要求 UI 截图，而是验证最容易回归的机制：

| 测试文件 | 守住的行为 |
| --- | --- |
| `tests/electron-concurrency.mjs` + child | 多进程/写锁下索引不会破坏 SQLite |
| `tests/electron-session-virtualization.mjs` | 长时间线的虚拟列表与更新行为 |
| `tests/electron-session-reader-state.mjs` | 切换会话后阅读锚点与展开状态恢复 |
| `tests/local-markdown-link.test.mjs` | 本地 Markdown 路径解析和预览边界 |

非 UI 逻辑变动时，优先补最小可运行测试到对应目录；纯一行样式或文案不必强行添加测试。更完整的 provider、schema、persist、query 测试在根目录和 `packages/core`，见 `cli&core-analysis.md`。

## 14. 最后再记住四条原则

1. **Core 管事实，App 管常驻索引和阅读体验。** Provider 原始格式不要泄漏进 Vue。
2. **main 有权限，renderer 没权限，preload 是门卫。** 新能力走白名单 IPC。
3. **详情先 assembly，再渲染。** 工具结果、thinking、workflow 的关联不应散落在组件里。
4. **实时更新以 patch 为常态。** 长会话阅读中避免无差别全量 reload。

理解这四条后，沿着「文件 -> worker -> SQLite -> IPC -> data.js -> Vue view」这条线读代码，就不会在 Electron、Vue 和 Core 的边界间迷路。
