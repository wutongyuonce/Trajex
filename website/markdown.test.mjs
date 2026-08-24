import assert from 'node:assert/strict';
import { markdown } from './app.js';

const html = markdown(`# 标题

1. 第一项
2. 第二项

| 字段 | 含义 |
| --- | --- |
| \`type\` | **类型** |

> 多行
> 引用

\`\`\`json
{"ok": true}
\`\`\``);

assert.match(html, /<h2>标题<\/h2>/);
assert.match(html, /<ol><li>第一项<\/li><li>第二项<\/li><\/ol>/);
assert.match(html, /<thead>.*<th>字段<\/th>/);
assert.match(html, /<blockquote><p>多行 引用<\/p><\/blockquote>/);
assert.match(html, /data-language="json"/);
