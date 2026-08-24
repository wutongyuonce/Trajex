const app = typeof document === 'undefined' ? null : document.querySelector('#app');
const github = 'https://github.com/wutongyuonce/Trajex';
let catalog;
let tocObserver;

const escapeHtml = (value) => value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
function inline(value) {
  const code = [];
  let html = escapeHtml(value).replace(/`([^`]+)`/g, (_, text) => {
    code.push(`<code>${text}</code>`);
    return `\u0000${code.length - 1}\u0000`;
  });
  html = html
    .replace(/!\[([^\]]*)\]\(([^ )]+)(?: "([^"]+)")?\)/g, (_, alt, src, title) => `<img src="${src}" alt="${alt}"${title ? ` title="${title}"` : ''} />`)
    .replace(/\[([^\]]+)\]\(([^ )]+)(?: "([^"]+)")?\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  return html.replace(/\u0000(\d+)\u0000/g, (_, index) => code[Number(index)]);
}

const isFence = (line) => /^\s*```/.test(line);
const isHeading = (line) => /^#{1,6}\s+/.test(line);
const isListItem = (line) => /^\s*(?:[-+*]|\d+\.)\s+/.test(line);
const isTableRow = (line) => /^\s*\|.*\|\s*$/.test(line);
const isTableDivider = (line) => /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
const isBlockStart = (line) => !line.trim() || isFence(line) || isHeading(line) || isListItem(line) || isTableRow(line) || /^>/.test(line) || /^\s*(?:---+|___+|\*\*\*+)\s*$/.test(line);

function tableCells(line) {
  return line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim());
}

function markdown(source) {
  const lines = source.replaceAll('\r', '').split('\n');
  const out = [];
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (!line.trim()) { i += 1; continue; }
    if (isFence(line)) {
      const language = line.trim().slice(3).trim().replace(/[^\w-]/g, '');
      const code = [];
      for (i += 1; i < lines.length && !isFence(lines[i]); i += 1) code.push(lines[i]);
      i += Number(i < lines.length);
      out.push(`<pre data-language="${language || 'text'}"><code class="language-${language || 'text'}">${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }
    if (isHeading(line)) {
      const [, hashes, text] = line.match(/^(#{1,6})\s+(.*)$/);
      const level = Math.min(hashes.length + 1, 6);
      out.push(`<h${level}>${inline(text.replace(/\s+#+$/, ''))}</h${level}>`);
      i += 1;
      continue;
    }
    if (isTableRow(line) && isTableDivider(lines[i + 1] ?? '')) {
      const head = tableCells(line);
      const rows = [];
      for (i += 2; i < lines.length && isTableRow(lines[i]); i += 1) rows.push(tableCells(lines[i]));
      out.push(`<div class="table-wrap"><table><thead><tr>${head.map((cell) => `<th>${inline(cell)}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${inline(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    if (isListItem(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const tag = ordered ? 'ol' : 'ul';
      const items = [];
      while (i < lines.length && isListItem(lines[i]) && /^\s*\d+\./.test(lines[i]) === ordered) {
        const text = lines[i].replace(/^\s*(?:[-+*]|\d+\.)\s+/, '');
        items.push(`<li>${inline(text)}</li>`);
        i += 1;
      }
      out.push(`<${tag}>${items.join('')}</${tag}>`);
      continue;
    }
    if (/^>/.test(line)) {
      const quote = [];
      while (i < lines.length && (/^>/.test(lines[i]) || !lines[i].trim())) {
        quote.push(lines[i].replace(/^> ?/, ''));
        i += 1;
      }
      out.push(`<blockquote>${markdown(quote.join('\n'))}</blockquote>`);
      continue;
    }
    if (/^\s*(?:---+|___+|\*\*\*+)\s*$/.test(line)) {
      out.push('<hr />');
      i += 1;
      continue;
    }
    const paragraph = [line.trim()];
    for (i += 1; i < lines.length && !isBlockStart(lines[i]); i += 1) paragraph.push(lines[i].trim());
    out.push(`<p>${inline(paragraph.join(' '))}</p>`);
  }
  return out.join('\n');
}

function flatDocs() { return catalog.flatMap((doc) => doc.children ?? [doc]); }
function docLink(doc) { return `#/tutorial/${doc.slug}`; }

function home() {
  app.innerHTML = `<section class="hero page-shell home-hero">
    <div class="hero-copy">
      <p class="eyebrow">AN OPEN SOURCE TRACE INDEX</p>
      <h1>你的 Agent<br />已经留下了<br /><em>答案。</em></h1>
      <p class="lede">Trajex 把 Claude Code、Codex 和 Pi 的本地 session 还原成可查询、可追溯的 SQLite 证据层。<br /><span>每一次过去的 session、subagent 和 workflow，都能被你的 Agent 查询，也能被你亲自浏览。</span></p>
      <div class="hero-actions"><a class="button button-dark" href="#/tutorials">阅读项目教程 <span>↗</span></a><a class="text-link" href="${github}" target="_blank" rel="noreferrer">GitHub ↗</a></div>
    </div>
    <div class="schema-card"><div class="schema-label"><span>SCHEMA / LIVE MAP</span><span>SQLite + FTS5</span></div><img src="/assets/sql_schema.png" alt="Trajex SQLite database schema" /></div>
  </section>
  <section class="home-section page-shell skill-section"><div class="section-intro"><p class="eyebrow">CLI / SKILL</p><h2>让 Agent 替你<br /><em>翻出过去。</em></h2><p>CLI 负责建立索引，trajex-skill 负责把查询带回每一次工作现场。</p></div><div class="skill-content"><div class="terminal-frame"><img src="/assets/boron.sh.png" alt="Trajex CLI help output" /></div><div class="skill-copy"><p class="skill-lead">你可以这样使用 trajex-skill：</p><code>/trajex 上次 auth bug 最后到底改了哪些文件，为什么这么改</code><code>/trajex 这个文件最近在哪些 sessions 里被反复修改</code><code>/trajex 找出最近失败的 tool calls，它们分别发生在哪些任务里</code><code>/trajex 那个 review workflow 的 subagents 各自结论是什么</code></div></div></section>
  <section class="home-section page-shell app-section"><div class="section-intro"><div><p class="eyebrow">THE APP</p><h2>同一份历史，<br /><em>两种阅读方式。</em></h2></div><p>从 session 列表定位工作，再进入详情页沿着消息、工具和 workflow 追踪完整上下文。</p></div><div class="app-gallery"><figure><img src="/assets/sessionlist_light.png" alt="Trajex sessions list in light mode" /><figcaption>Sessions / light</figcaption></figure><figure><img src="/assets/sessionlist_dark.png" alt="Trajex sessions list in dark mode" /><figcaption>Sessions / dark</figcaption></figure><figure><img src="/assets/session_light.png" alt="Trajex session detail in light mode" /><figcaption>Session detail / light</figcaption></figure><figure><img src="/assets/session_dark.png" alt="Trajex session detail in dark mode" /><figcaption>Session detail / dark</figcaption></figure></div></section>`;
}

function tutorials() {
  app.innerHTML = `<section class="tutorial-hero page-shell"><p class="eyebrow">PROJECT DOCUMENTATION</p><h1>读懂 Trajex<br /><em>从它如何读取历史开始。</em></h1><p>两条主线，五组参考。每一篇都从真实源码出发，解释数据怎样流过系统。</p></section><section class="docs-layout page-shell"><aside class="docs-nav"><p class="eyebrow">INDEX</p>${catalog.map((doc) => doc.children ? `<div class="nav-group"><span>${doc.kicker}</span><strong>${doc.title}</strong>${doc.children.map((child) => `<a href="${docLink(child)}">${child.title}</a>`).join('')}</div>` : `<a class="nav-single" href="${docLink(doc)}"><span>${doc.kicker}</span><strong>${doc.title}</strong></a>`).join('')}</aside><div class="doc-cards">${catalog.map((doc, i) => doc.children ? `<div class="doc-group"><p class="eyebrow">${doc.kicker}</p><h2>${doc.title}</h2><p>${doc.description}</p><div class="mini-grid">${doc.children.map((child) => `<a class="mini-card" href="${docLink(child)}"><span>${child.title}</span><b>↗</b></a>`).join('')}</div></div>` : `<a class="doc-row" href="${docLink(doc)}"><span class="row-index">0${i + 1}</span><div><p class="card-kicker">${doc.kicker}</p><h2>${doc.title}</h2><p>${doc.description}</p></div><b>↗</b></a>`).join('')}</div></section>`;
}

function setupToc() {
  const article = document.querySelector('#article');
  const toc = document.querySelector('#article-toc');
  const headings = [...article.querySelectorAll('h2, h3')].filter((heading, index) => index > 0 || heading !== article.firstElementChild);
  if (!headings.length) { toc.hidden = true; return; }
  toc.innerHTML = `<p>本页目录</p>${headings.map((heading, index) => {
    heading.id = `section-${index + 1}`;
    return `<button type="button" class="toc-level-${heading.tagName.slice(1)}" data-target="${heading.id}">${heading.textContent}</button>`;
  }).join('')}`;
  const buttons = [...toc.querySelectorAll('button')];
  buttons.forEach((button) => button.addEventListener('click', () => document.getElementById(button.dataset.target).scrollIntoView({ behavior: 'smooth' })));
  const activate = (id) => buttons.forEach((button) => button.classList.toggle('is-active', button.dataset.target === id));
  activate(headings[0].id);
  tocObserver = new IntersectionObserver((entries) => {
    const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
    if (visible) activate(visible.target.id);
  }, { rootMargin: '-18% 0px -72% 0px' });
  headings.forEach((heading) => tocObserver.observe(heading));
}

async function tutorial(slug) {
  const doc = flatDocs().find((item) => item.slug === slug);
  if (!doc) return tutorials();
  const source = await fetch(`/content/${slug}.md`).then((response) => {
    if (!response.ok) throw new Error(`Unable to load ${slug}`);
    return response.text();
  });
  app.innerHTML = `<section class="article-head page-shell"><a class="back-link" href="#/tutorials">← 教程索引</a></section><section class="article-layout page-shell"><article id="article" class="markdown">${markdown(source)}</article><aside id="article-toc" class="article-toc" aria-label="本页目录"></aside></section>`;
  setupToc();
}

async function route() {
  tocObserver?.disconnect();
  tocObserver = undefined;
  if (!catalog) catalog = await fetch('/content/index.json').then((response) => response.json());
  const routePath = location.hash.replace(/^#\/?/, '');
  window.scrollTo(0, 0);
  if (routePath === 'tutorials') return tutorials();
  if (routePath.startsWith('tutorial/')) return tutorial(routePath.slice('tutorial/'.length));
  return home();
}
if (typeof window !== 'undefined') {
  window.addEventListener('hashchange', route);
  route();
}

export { markdown };
