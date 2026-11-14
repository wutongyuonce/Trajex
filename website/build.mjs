import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const site = resolve(import.meta.dirname);
const dist = join(site, 'dist');
const sourceDir = join(root, 'docs');
const assetDir = join(root, '.github', 'assets');
const assets = ['trajex-wordmark-d.svg', 'trajex-wordmark-l.svg', 'sql_schema.png', 'boron.sh.png', 'sessionlist_light.png', 'sessionlist_dark.png', 'session_light.png', 'session_dark.png'];

const docs = [
  { slug: 'architecture', file: 'architecture.md', title: 'Architecture', kicker: '主线教程', description: '从来源文件到 Provider、SQLite 与查询层，以及 CLI 与 App 的写入分工。' },
  { slug: 'jsonl', file: null, title: 'Session Formats', kicker: '参考文档', description: 'Claude Code、Codex、Pi、DeepSeek Harness 四种会话格式与 Trajex 的投影规则。', children: [
    { slug: 'claude-jsonl', file: 'formats/claude-code-jsonl.md', title: 'Claude Code' },
    { slug: 'codex-jsonl', file: 'formats/codex-jsonl.md', title: 'Codex' },
    { slug: 'pi-jsonl', file: 'formats/pi-jsonl.md', title: 'Pi' },
    { slug: 'deepseek-jsonl', file: 'formats/deepseek-harness-jsonl.md', title: 'DeepSeek Harness' }
  ] }
];

const existingDist = await readdir(dist).catch(() => []);
await Promise.all(existingDist.filter((name) => name !== '.vercel').map((name) => rm(join(dist, name), { recursive: true, force: true })));
await mkdir(join(dist, 'content'), { recursive: true });
await mkdir(join(dist, 'assets'), { recursive: true });
await cp(join(site, 'index.html'), join(dist, 'index.html'));
await cp(join(site, 'styles.css'), join(dist, 'styles.css'));
await cp(join(site, 'app.js'), join(dist, 'app.js'));
await Promise.all(assets.map((asset) => cp(join(assetDir, asset), join(dist, 'assets', asset))));

const flat = docs.flatMap((doc) => doc.children ?? [doc]);
for (const doc of flat) {
  if (!doc.file) continue;
  await writeFile(join(dist, 'content', `${doc.slug}.md`), await readFile(join(sourceDir, doc.file), 'utf8'));
}
await writeFile(join(dist, 'content', 'index.json'), JSON.stringify(docs));
console.log(`Built ${flat.length} tutorials to ${relative(root, dist)}`);
