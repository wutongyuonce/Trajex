
以下是每个 ADR 的简要总结：

---

**ADR-0001 — Indexing is a registry of pure provider adapters over one shared persist layer**

将索引拆成两个正交轴：Provider 轴是纯适配器注册表（Claude、Codex、Pi 各自实现 `discover`/`parse` 等接口），持久化轴是共享的 binding-agnostic writer。不再每个 provider 一个索引器，不再每个 binding 一个 persist 层。修正了早期草案中"一个 parse core + 两个 persist"的错误假设。

---

**ADR-0002 — The runtime contract is two-tier, with api-reference.md authoritative**

把 runtime 合约冻结为两层：Tier 1（硬冻结，golden tests）覆盖四个 CLI verb 的 I/O 信封；Tier 2（锁在 `api-reference.md`）覆盖 helper 的返回形状。`api-reference.md` 从描述性文档升级为权威合约，改动必须同步更新文档并 bump 版本。

---

**ADR-0003 — Core is authored in TypeScript, shipped as precompiled ESM JavaScript**

Core（`@trajex/core` npm workspace）用 TypeScript 编写，预编译为 ESM JavaScript + `.d.ts` 发布。`@trajex-apps/cli` 发布的是预编译 JS，安装时无 build 步骤。Electron main process 迁移到 ESM（Phase 5）以 import 同一份 Core。renderer（Vue）不受影响。

---

**ADR-0004 — The CLI ships readable compiled JS; the skill remains docs-only**

`@trajex-apps/cli` 发布 readable、non-bundled、non-minified 的 `tsc` 编译输出（保留 module 结构 + 注释，~1:1 映射 TS 源码），外加 `schema.sql`。agent skill 只发布 `SKILL.md` + `references/` + metadata，所有可执行动作委托给已安装的 `trajex` 命令。明确拒绝 bundling，因为它用可审计性换取了边际的体积节省。

---

**ADR-0005 — The app builds with electron-vite (TS + ESM), packages with electron-builder**

采用 electron-vite 构建所有三个进程（main、preload、renderer），用 electron-builder 打包（DMG/ZIP）。preload 保持 CommonJS（sandbox 不支持 ESM preload）。app 从源码消费 Core（electron-vite 会 bundle `packages/core/src/`），注入 `better-sqlite3`。双层 typechecking：root 项目严格（含 `noImplicitAny`），app 项目对内部 SQLite helper 更宽松。

---

**ADR-0006 — Write-transaction rollback safety and SQLite concurrency**

解决 `cannot rollback - no transaction is active` bug。关键决策：`tx.ts` 提供 binding-agnostic 的事务原语（`BEGIN IMMEDIATE` + 安全的 rollback），从不屏蔽主异常；`write-coordinator.ts` 提供上层的等幂重试策略；`writer.lock.sqlite` 提供跨进程排他锁；fresh `__app_heartbeat__` 让 CLI 保持只读，不竞争写入。

---

**ADR-0007 — Canonical transcript records are the session-detail seam**

每个 provider adapter 发射规范的 `TranscriptRecord` 流，adapter 拥有所有 source-specific 的解释权（重复事件、稳定 ID、工具关系、消息分类、可见性）。`assembleSessionDetail(input)` 是唯一的 session-detail seam，接受新鲜 parse 流或持久化 round-trip 后的行，但从不检查 provider 来源，从不解析消息文本来恢复 provider 语义。