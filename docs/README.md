# Trajex 文档

本目录只放**当前有效**的文档，适用于 Trajex **0.3.0**（`package.json`、`@trajex-apps/cli`、桌面 App 同版本）。历史改动看 [CHANGELOG](../CHANGELOG.md) 与 git 历史，不在这里保留过程记录。

## 文档地图

| 文档 | 内容 | 什么时候读 |
| --- | --- | --- |
| [architecture.md](architecture.md) | 模块分层、数据流、CLI 与 App 的写入分工、改需求从哪里下手 | 第一次读代码、改动跨模块时 |
| [adr/](adr/README.md) | 13 份架构决策（ADR-0001–0013）：当前契约、不变量与失败语义 | 改变某条行为之前 |
| [formats/claude-code-jsonl.md](formats/claude-code-jsonl.md) | Claude Code transcript / workflow 格式与 Trajex 的投影 | 改 `providers/claude.ts` |
| [formats/codex-jsonl.md](formats/codex-jsonl.md) | Codex rollout 格式、去重与线程规则 | 改 `providers/codex.ts` |
| [formats/pi-jsonl.md](formats/pi-jsonl.md) | Pi v3 session 树、compaction 与可见性 | 改 `providers/pi.ts` |
| [formats/deepseek-harness-jsonl.md](formats/deepseek-harness-jsonl.md) | DeepSeek Harness v0–v4、多帧 Zstandard、会话树 | 改 `providers/deepseek.ts` |

仓库其他位置的文档：使用说明见 [README](../README.md)，领域术语见 [CONTEXT.md](../CONTEXT.md)，Agent 查询接口见 [trajex-skill/](../trajex-skill/SKILL.md)，评测见 [eval/README.md](../eval/README.md)。

## 版本基线

| 项目 | 当前值 |
| --- | --- |
| Trajex / CLI / App | 0.3.0 |
| Node.js | CLI ≥ 22.13；读取 DeepSeek 压缩日志需 ≥ 22.15 |
| 索引位置 | `$TRAJEX_DIR/trajex.sqlite`，默认 `~/.trajex/trajex.sqlite` |
| Provider 投影 marker | `__claude_canonical_transcript_v1.1__`、`__codex_canonical_transcript_v1.2__`、`__pi_canonical_transcript_v1.1__`、`__deepseek_canonical_transcript_v1__` |
| 来源格式 | Claude Code 2.1.x（观测）；Codex rollout（观测，CLI 0.94–0.130 / Desktop 0.146–0.147）；Pi session v3；DeepSeek Harness session v0–v4 |

Claude Code 与 Codex 没有公开稳定的 transcript schema，对应格式文档是观测性说明；Pi 与 DeepSeek Harness 文档以上游公开规范为准。

## 维护规则

- **权威顺序**：代码 + 测试 > ADR > 本目录其他文档。三者不一致时以代码和测试为事实，并在同一个提交里修正文档。
- **改行为就改 ADR**：用户可见行为、不变量、失败语义、资源上限变化时，更新对应 ADR；新增一类决策才新增 ADR，并登记到 [adr/README.md](adr/README.md)。
- **改格式就改 formats/**：Provider 投影规则变化（字段、可见性、cursor、marker）时更新对应格式文档；提升 marker 时同步上面的版本基线表。
- **不写过程文档**：研究笔记、重构总结、一次性方案在完成后不留在 `docs/`；结论写进 ADR，过程留在 PR 与 git 历史。
- **链接用相对路径**，不要写本机绝对路径。
