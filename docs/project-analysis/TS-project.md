# TypeScript Monorepo：从创建到发布

本文以 **npm workspaces + TypeScript + ESM** 为基线，说明如何建立、开发、验证和发布一个多包 TypeScript 项目。它覆盖两种常见结构：

- **应用优先**：共享代码包不单独发布，由 CLI 或应用一并编译和分发。Trajex 属于此类。
- **库优先**：多个库和 CLI 都作为独立 npm 包发布，包之间按依赖顺序构建。`pi` 属于此类。

选择前先明确边界：只有被外部项目直接安装、导入或升级的模块，才需要成为公开 npm 包；仅供仓库内部使用的模块应保持 `private`。不要为了“以后可能复用”而拆包。

## 1. 必要术语

| 术语 | 含义 |
| --- | --- |
| monorepo | 一个 Git 仓库中维护多个可独立构建的包。 |
| workspace | 包管理器识别的子包目录。npm 会把本地 workspace 链接到根 `node_modules`，并统一安装依赖。 |
| package | 具有自身 `package.json` 的可构建或可发布单元。 |
| ESM | ECMAScript 模块系统，使用 `import` / `export`。本文默认采用它。 |
| `dist` | 编译产物目录，通常包含 `.js`、`.d.ts` 与运行时资源。不要提交到 Git，除非发布机制另有要求。 |
| `exports` | `package.json` 中的公开入口表。它限定使用者可导入的路径，并映射到构建后的文件。 |
| declaration | TypeScript 声明文件（`.d.ts`），让 JavaScript 包也能为使用者提供类型。 |
| lockstep versioning | 多个发布包始终使用同一个版本号，并在同一次发布中一起升级。 |
| tarball | `npm pack` 生成、实际会上传到 npm 的压缩包；发布前应检查其内容。 |

## 2. 先确定发布模型

### 模型 A：私有核心 + 公开 CLI（Trajex）

目录示例：

```text
repo/
├── package.json
├── tsconfig.json
├── packages/
│   ├── core/                 # @scope/core，private: true
│   │   └── src/
│   └── cli/                  # @scope/cli，发布到 npm
│       ├── src/
│       └── scripts/build.mjs
└── tests/
```

CLI 构建时将 `core/src` 一同编译进 CLI 的 `dist`。用户只安装 CLI，一个 npm 包即可运行。这适合核心实现不需要被第三方直接导入的工具型项目。

优点是发布简单、内部 API 不会成为兼容性承诺；代价是其他项目不能把 `core` 当作库依赖。

### 模型 B：多个公开库 + 公开 CLI（pi）

`pi` 的实际结构可概括为：

```text
pi/
├── package.json
├── tsconfig.base.json
├── tsconfig.json
├── scripts/
│   ├── sync-versions.js
│   ├── publish.mjs
│   └── release.mjs
└── packages/
    ├── ai/                   # @earendil-works/pi-ai
    ├── agent/                # 依赖 pi-ai
    ├── tui/
    ├── storage/sqlite-node/  # 依赖 pi-ai、pi-agent-core
    └── coding-agent/         # CLI，依赖前述库
```

这里的 `ai`、`agent`、`tui`、存储层与 CLI 都可独立安装。构建必须按依赖顺序进行，例如先 `ai`，再 `agent`，最后 `coding-agent`；后者的构建配置会读取前者的 `dist/*.d.ts` 来完成类型解析。

这种模型适合 SDK、插件生态或多个产品共用的稳定库。它需要更严谨的版本、兼容性和发布顺序管理。

## 3. 初始化仓库

以下命令创建一个模型 B 的最小骨架；模型 A 只需保留 `core` 和 `cli`。

```bash
mkdir my-monorepo && cd my-monorepo
git init
npm init -y
mkdir -p packages/core/src packages/cli/src
```

根 `package.json` 负责 workspace 编排和全仓命令，不应作为待发布的业务包：

```json
{
  "name": "my-monorepo",
  "private": true,
  "type": "module",
  "workspaces": ["packages/*"],
  "engines": { "node": ">=22.19.0" },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "lint": "eslint .",
    "test": "npm run test --workspaces --if-present",
    "build": "npm run build --workspaces --if-present"
  }
}
```

`private: true` 是保护措施：它阻止误把根目录发布到 npm。`type: module` 让 `.js` 默认按 ESM 运行。根 `engines` 应与 CI 和本地实际支持的 Node 版本一致；所有发布包也应重复声明该字段，因为使用者只会读取子包的元数据。

安装共享工具链：

```bash
npm install -D typescript @types/node eslint @eslint/js globals typescript-eslint
```

根依赖适合放编译器、检查器和统一脚本。某个包运行时需要的库必须写在该包自己的 `dependencies` 中，不能依赖根目录“碰巧装了它”。提交生成的 `package-lock.json`，使本地与 CI 使用同一依赖图。

可选的 `.npmrc`：

```ini
save-exact=true
```

它让新安装的依赖固定到精确版本。`pi` 同时设置了 `min-release-age=2`，用于降低刚发布的供应链包被立即安装的风险；只有团队已确认 npm 配置支持并接受该策略时再添加。

## 4. 定义包与依赖关系

一个可发布库的最小 `packages/core/package.json`：

```json
{
  "name": "@my-scope/core",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" }
  },
  "files": ["dist", "README.md", "LICENSE"],
  "engines": { "node": ">=22.19.0" },
  "scripts": {
    "clean": "node -e \"import('node:fs/promises').then(fs => fs.rm('dist', { recursive: true, force: true }))\"",
    "build": "tsc -p tsconfig.build.json",
    "test": "node --test",
    "prepublishOnly": "npm run clean && npm run build"
  },
  "publishConfig": { "access": "public" }
}
```

`main` 和 `types` 保持对旧工具的兼容；现代 Node 与 TypeScript 应主要通过 `exports` 解析入口。新增子路径入口时必须同时增加 `exports`，例如：

```json
"./oauth": { "types": "./dist/oauth.d.ts", "import": "./dist/oauth.js" }
```

不要把 `src`、测试、私有配置或整个仓库发布出去；`files` 是发布白名单。可以用 `npm pack --dry-run` 验证它。

在另一个 workspace 中依赖它时，先写真实的包依赖：

```json
{
  "dependencies": {
    "@my-scope/core": "^0.1.0"
  }
}
```

然后在根目录运行 `npm install` 更新锁文件。npm 会在开发中解析为本地 workspace；打包发布时仍保留这个 semver 范围。不要手工复制 `dist`，也不要依赖未声明的“幽灵依赖”。

CLI 包还需要 `bin`：

```json
{
  "name": "@my-scope/cli",
  "bin": { "my-cli": "dist/cli.js" },
  "files": ["dist", "README.md", "LICENSE"],
  "publishConfig": { "access": "public" }
}
```

`bin` 的键是用户执行的命令，值是包内入口文件。入口文件应有 shebang：

```ts
#!/usr/bin/env node
```

构建后确认该文件可执行；`pi` 的 `coding-agent` 构建会显式对 `dist/cli.js` 执行 `chmod +x`。

## 5. TypeScript 与 ESM 配置

建议将检查配置和编译配置分开：前者覆盖整个仓库且不产出文件，后者以每个包为单位生成 `dist`。

根 `tsconfig.base.json` 放共享的编译选项：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "types": ["node"],
    "strict": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "allowImportingTsExtensions": true,
    "rewriteRelativeImportExtensions": true
  }
}
```

根 `tsconfig.json` 只作全仓类型检查：

```json
{
  "extends": "./tsconfig.base.json",
  "compilerOptions": { "noEmit": true },
  "include": ["packages/*/src/**/*", "packages/*/test/**/*"],
  "exclude": ["**/dist/**", "node_modules"]
}
```

每个包的 `tsconfig.build.json` 负责产物：

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist", "**/*.d.ts"]
}
```

`rootDir` 决定输出路径，`src/foo.ts` 因而变成 `dist/foo.js`。`declaration: true` 生成 `.d.ts`；库通常必须保留它，纯 CLI 可按需关闭。

在 Node ESM 中，源码中的相对导入应使用 TypeScript 后缀，例如 `import { x } from './x.ts'`。`allowImportingTsExtensions` 允许检查这种写法，`rewriteRelativeImportExtensions` 在构建时将其改为 `./x.js`，以便 Node 运行产物。不要把源码中相对导入写成 `.js`，否则直接运行 TypeScript 源码时会产生不一致。

`pi` 的根检查配置使用 `paths`，把包名暂时映射到 `src`，以便未构建时也能完成跨包类型检查；而包的构建配置将 `paths` 指向依赖包的 `dist/*.d.ts`。这解释了它必须按 `tui → ai → agent → storage → coding-agent` 等依赖顺序构建。对于只有两个包的项目，优先让依赖关系保持简单，不要为了方便检查就滥用 `paths`；它只影响 TypeScript，不能改变 Node 运行时的模块解析。

## 6. 构建资源、检查与测试

`tsc` 只处理 TypeScript 与声明文件，不会复制 SQL、JSON、模板、图片和许可证。资源被运行时代码读取时，必须在 build 中复制。最小脚本可以是：

```js
// packages/cli/scripts/build.mjs
import { cpSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

rmSync('dist', { recursive: true, force: true });
execFileSync('npx', ['--no-install', 'tsc', '-p', 'tsconfig.build.json'], { stdio: 'inherit' });
cpSync('src/assets', 'dist/assets', { recursive: true });
```

Trajex 正是用一个很小的脚本完成“删除旧 `dist`、编译 CLI 与 core、复制 `schema.sql` 和许可证”。`pi` 的 coding-agent 则额外复制主题 JSON、PNG、HTML/CSS/JS 模板等资源。资源清单应由实际运行时读取路径决定，不要无差别复制整个 `src`。

ESLint 9+ 使用 flat config。根 `eslint.config.js` 可从以下最小配置开始：

```js
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**'] },
  js.configs.recommended,
  {
    files: ['**/*.ts'],
    extends: [...tseslint.configs.recommended],
    languageOptions: { globals: { ...globals.node } },
  },
);
```

基础质量门应覆盖：

```bash
npm run typecheck
npm run lint
npm test
npm run build
npm pack --workspace @my-scope/core --dry-run
```

最后一项非常重要：它按 npm 的真实打包规则列出将发布的文件。检查入口 JS、`.d.ts`、资源、README、LICENSE 是否都在其中，且没有源代码、测试和密钥文件。

## 7. 开发、提交与 CI

日常开发应从根目录执行 workspace 命令：

```bash
npm install
npm run build --workspace @my-scope/core
npm run test --workspace @my-scope/core
npm run build --workspace @my-scope/cli
```

提交前运行根质量门。CI 至少应使用锁文件安装、全仓检查、测试、构建和打包预检：

```yaml
name: verify
on: [push, pull_request]
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run typecheck
      - run: npm run lint
      - run: npm test
      - run: npm run build
      - run: npm pack --workspace @my-scope/cli --dry-run
```

只有在 CI 上需要发布时，才配置 npm token 或 npm trusted publishing（OIDC）。发布权限必须限制在受保护分支、受保护标签或受控 GitHub Environment 中，不能把 token 暴露给普通 pull request。

## 8. 发布：轻量模型与锁步模型

### Trajex 的轻量发布流程

Trajex 的 `@trajex/core` 为 `private: true`，只有 `@trajex-apps/cli` 发布。CLI 的 `prepack` 生命周期会先运行构建；其 `tsconfig.build.json` 的 `rootDir: '..'` 与 `include` 同时包含 `cli/src` 和 `core/src`，所以 core 被编进 CLI 的 tarball。

```bash
# 首次：npm login
npm run typecheck && npm run lint && npm test
npm pack --workspace @trajex-apps/cli --dry-run
npm version patch --workspace @trajex-apps/cli
npm publish --workspace @trajex-apps/cli
```

发布前检查版本、Git 状态和 tarball。`npm publish` 不可撤销地占用版本号；即使发现问题，也应发布修复版本而不是假定能覆盖旧版本。

### pi 的锁步发布流程

`pi` 公开发布 `pi-ai`、`pi-agent-core`、`pi-storage-sqlite-node`、`pi-tui` 与 `pi-coding-agent`，并要求它们使用同一个版本号。根脚本提供：

```bash
npm run publish:dry        # 清理、构建、检查，并以 npm pack 验证所有发布包
npm run release:patch      # 完整发布准备：升版本、更新 CHANGELOG、检查、测试、提交、打 tag、推送
```

其 `release.mjs` 会检查工作区干净、升级所有 workspace 版本、同步内部依赖版本、刷新锁文件、更新 CHANGELOG、生成发布产物、运行检查与测试、提交并创建 `vX.Y.Z` 标签。标签推送后由 CI 执行发布。`publish.mjs` 则按依赖顺序发布，并在每包发布前：确认 `dist` 存在、检查版本是否已发布、执行 `npm pack --dry-run`。这使重试安全：已经成功发布的包会被跳过。

对于新项目，只有在多个包确实必须同时发布和兼容时才采用锁步版本。独立演进的库更适合各自版本号，但也需要相应的变更记录和兼容性管理工具。

## 9. 发布前最终清单

- 根与所有发布包的 Node 版本、模块类型、许可证和仓库地址一致且正确。
- 每个运行时依赖都在对应包的 `dependencies`，没有依赖根目录或其他包的偶然安装结果。
- 每个公开导入路径都有对应的 `exports`、JS 产物和 `.d.ts`。
- `dist` 含所有运行时资源；`npm pack --dry-run` 中只包含应发布的文件。
- 从干净目录执行 `npm ci && npm run build && npm test` 成功。
- 版本号、CHANGELOG、Git tag 与 npm 上的目标版本一致；发布凭据只在受控 CI 环境可用。

按以上边界建立项目，可以从 Trajex 的“私有实现 + 一个可安装 CLI”平滑扩展到 `pi` 的“多个可发布库 + CLI + 锁步发布”结构，而不需要先引入 Turborepo、Nx、Changesets 等额外编排工具。确实出现构建耗时、任务缓存或独立版本管理的实际需求后，再选择相应工具。
