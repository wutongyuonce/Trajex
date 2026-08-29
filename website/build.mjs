import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const site = resolve(import.meta.dirname);
const dist = join(site, 'dist');
const sourceDir = join(root, 'docs', 'project-analysis');
const assetDir = join(root, '.github', 'assets');
const assets = ['trajex-wordmark-d.svg', 'trajex-wordmark-l.svg', 'sql_schema.png', 'boron.sh.png', 'sessionlist_light.png', 'sessionlist_dark.png', 'session_light.png', 'session_dark.png'];

const docs = [
  { slug: 'cli-core', file: 'cli&core-analysis.md', title: 'CLI & Core', kicker: '主线教程', description: '从 provider 到 canonical record，再到 SQLite 与查询层。' },
  { slug: 'app', file: 'app-analysis.md', title: 'App Architecture', kicker: '主线教程', description: 'Electron 主进程、IPC、索引服务与 Session Detail 的完整链路。' },
  { slug: 'jsonl', file: null, title: 'JSONL Field Notes', kicker: '参考文档', description: 'Claude、Codex、Pi 三种 transcript 格式的并排观察。', children: [
    { slug: 'codex-jsonl', file: 'codex-jsonl.md', title: 'Codex JSONL' },
    { slug: 'claude-jsonl', file: 'claude-code-jsonl.md', title: 'Claude JSONL' },
    { slug: 'pi-jsonl', file: 'pi-jsonl.md', title: 'Pi JSONL' }
  ] },
  { slug: 'skill', file: 'SKILL-analysis.md', title: 'Skill Layer', kicker: '参考文档', description: 'Trajex skill 如何把检索能力交给 agent。' },
  { slug: 'sqlite', file: 'sqlite-入门.md', title: 'SQLite Primer', kicker: '参考文档', description: '索引、FTS5、事务和查询边界。' }
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
