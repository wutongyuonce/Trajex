// Copyright (C) 2026 tommy0103 and contributors.
// Copyright (C) 2026 wutongyuonce and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// Utility functions ported from the vanilla JS utils.js.
// Pure helpers with no side-effects on global state (except formatProjectLabel which reads store).

import { state } from './store.js';
import DOMPurify from 'dompurify';
import { marked } from 'marked';

// --- Time / formatting ---

export function pad2(n) { return String(n).padStart(2, '0'); }

export function isSameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export function fmtListTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  const hhmm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  if (isSameDay(d, now)) return hhmm;
  const mmdd = `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}`;
  if (d.getFullYear() === now.getFullYear()) return `${mmdd} ${hhmm}`;
  return `${d.getFullYear()}/${mmdd} ${hhmm}`;
}

export function fmtRelative(ts) {
  const diff = Date.now() - ts;
  const min = 60000, hr = 3600000, day = 86400000;
  if (diff < 0) return 'in the future';
  if (diff < min) return 'just now';
  if (diff < hr) return Math.floor(diff / min) + 'm ago';
  if (diff < day) return Math.floor(diff / hr) + 'h ago';
  if (diff < day * 30) return Math.floor(diff / day) + 'd ago';
  if (diff < day * 365) return Math.floor(diff / (day * 30)) + 'mo ago';
  return Math.floor(diff / (day * 365)) + 'y ago';
}

export function fmtClockTime(iso) {
  const d = new Date(iso);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// --- HTML / Markdown ---

export function escapeHTML(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function highlightPlain(text, query) {
  if (!query) return escapeHTML(text);
  const safe = escapeHTML(text);
  const q = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return safe.replace(new RegExp(q, 'gi'), m => `<mark>${m}</mark>`);
}

const MARKDOWN_ALLOWED_TAGS = [
  'a', 'abbr', 'b', 'blockquote', 'br', 'code', 'del', 'details', 'em',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'li', 'mark', 'ol',
  'p', 'pre', 's', 'strong', 'sub', 'sup', 'summary', 'table', 'tbody', 'td',
  'tfoot', 'th', 'thead', 'tr', 'u', 'ul',
];

const MARKDOWN_ALLOWED_ATTR = [
  'alt', 'class', 'colspan', 'height', 'href', 'rel', 'rowspan', 'src',
  'start', 'target', 'title', 'width',
];

const MARKDOWN_ALLOWED_URI_REGEXP = /^(?:(?:https?|mailto|tel|file):|#|\/|[^:/?#]+(?:[/?#]|$))/i;

export function isSafeMarkdownHref(href) {
  if (typeof href !== 'string' || !href.trim()) return false;
  const value = href.trim();
  if (value.startsWith('#')) return true;
  try {
    const url = new URL(value, 'https://trajex.invalid');
    if (url.protocol === 'file:') return !url.hostname || url.hostname === 'localhost';
    return ['http:', 'https:', 'mailto:', 'tel:'].includes(url.protocol);
  } catch {
    return false;
  }
}

export function sanitizeMarkdown(html) {
  const clean = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: MARKDOWN_ALLOWED_TAGS,
    ALLOWED_ATTR: MARKDOWN_ALLOWED_ATTR,
    ALLOW_DATA_ATTR: false,
    ALLOWED_URI_REGEXP: MARKDOWN_ALLOWED_URI_REGEXP,
  });
  const container = document.createElement('div');
  container.innerHTML = clean;
  for (const link of container.querySelectorAll('a[href]')) {
    if (!isSafeMarkdownHref(link.getAttribute('href'))) link.removeAttribute('href');
  }
  for (const image of container.querySelectorAll('img[src]')) {
    if (!isSafeMarkdownHref(image.getAttribute('src'))) image.remove();
  }
  return container.innerHTML;
}

export function resolveRelativeMarkdownHref(href, cwd) {
  if (typeof href !== 'string' || typeof cwd !== 'string' || !cwd.startsWith('/')) return href;
  const rawHref = href.trim();
  if (!rawHref || /^(?:[A-Za-z][A-Za-z\d+.-]*:|\/|\\|#|\?)/.test(rawHref)) return href;
  try {
    return new URL(rawHref.replaceAll(':', '%3A'), `file://${cwd.replace(/\/+$/, '')}/`).href;
  } catch {
    return href;
  }
}

export function highlightTextNodes(rootEl, query) {
  if (!query) return;
  const q = query.toLowerCase();
  const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT, null);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const text = node.nodeValue;
    if (!text) continue;
    const lower = text.toLowerCase();
    if (!lower.includes(q)) continue;
    const frag = document.createDocumentFragment();
    let last = 0, i = lower.indexOf(q);
    while (i !== -1) {
      if (i > last) frag.appendChild(document.createTextNode(text.slice(last, i)));
      const mark = document.createElement('mark');
      mark.textContent = text.slice(i, i + q.length);
      frag.appendChild(mark);
      last = i + q.length;
      i = lower.indexOf(q, last);
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    node.parentNode.replaceChild(frag, node);
  }
}

export function renderMarkdown(text, opts = {}) {
  if (text == null) return '';
  const cls = opts.variant === 'msg' ? 'markdown-msg'
            : opts.variant === 'compact' ? 'markdown-compact'
            : 'markdown-body';
  const container = document.createElement('div');
  container.className = cls;
  container.innerHTML = marked.parse(text);
  if (opts.cwd) {
    for (const link of container.querySelectorAll('a[href]')) {
      link.setAttribute('href', resolveRelativeMarkdownHref(link.getAttribute('href'), opts.cwd));
    }
  }
  container.innerHTML = sanitizeMarkdown(container.innerHTML);
  if (opts.query) highlightTextNodes(container, opts.query.trim());
  return container.outerHTML;
}

// --- Duration / tokens / tooltip ---

export function fmtDuration(ms) {
  if (!ms) return '—';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (sec || !parts.length) parts.push(`${sec}s`);
  return parts.join(' ');
}

export function fmtTokens(n) {
  if (!n) return '0';
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(2) + 'B';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

export function fmtTooltipDate(isoDay) {
  const d = new Date(isoDay + 'T00:00:00');
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const day = d.getDate();
  const suffix = day === 1 || day === 21 || day === 31 ? 'st' : day === 2 || day === 22 ? 'nd' : day === 3 || day === 23 ? 'rd' : 'th';
  const thisYear = new Date().getFullYear();
  if (d.getFullYear() === thisYear) return `${months[d.getMonth()]} ${day}${suffix}`;
  return `${months[d.getMonth()]} ${day}${suffix}, ${d.getFullYear()}`;
}

export function positionTooltip(el, x, y) {
  const pad = 12;
  const rect = el.getBoundingClientRect();
  let left = x + pad;
  if (left + rect.width > window.innerWidth - pad) left = x - rect.width - pad;
  el.style.left = left + 'px';
  el.style.top = (y - 28) + 'px';
}

// --- Project label ---

export function formatProjectLabel(slug) {
  if (!slug) return '(no project)';
  // Find the shortest project_path for this slug (most likely the project root)
  const sessions = state.sessions.filter(s => s.project === slug && s.project_path);
  if (sessions.length) {
    const shortest = sessions.reduce((a, b) => a.project_path.length <= b.project_path.length ? a : b);
    const parts = shortest.project_path.split('/');
    return parts[parts.length - 1];
  }
  return slug.replace(/^-/, '');
}
