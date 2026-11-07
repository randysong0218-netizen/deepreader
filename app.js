/* DeepReader — 英文原著阅读伴侣
 * 纯前端：书籍、进度、生词、划线都存在本机 IndexedDB；AI 由用户自带 Key，直接从浏览器调用。
 */
'use strict';

/* ======================= 小工具 ======================= */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isMobile = () => window.matchMedia('(max-width: 899px)').matches;
const MOCK = /[?&]mock=1/.test(location.search);
const MAX_FILE = 1000 * 1024 * 1024;
function scrollToEl(el, where = 'start', smooth = false) {
  const sc = $('#reader-scroll'); if (!el || !sc) return;
  const r = el.getBoundingClientRect(), top = sc.getBoundingClientRect().top;
  let d = r.top - top - 12; if (where === 'center') d = r.top - top - sc.clientHeight / 2 + r.height / 2;
  sc.scrollTo({ top: sc.scrollTop + d, behavior: smooth ? 'smooth' : 'auto' });
}
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), ms);
}
function download(name, text, type = 'text/plain') {
  const blob = new Blob([text], { type: type + ';charset=utf-8' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('已复制'); } catch { toast('复制失败，请手动选择文字复制'); }
}
const loadedLibs = {};
function loadLib(src) {
  if (!loadedLibs[src]) loadedLibs[src] = new Promise((res, rej) => {
    const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('无法加载 ' + src)); document.head.appendChild(s);
  });
  return loadedLibs[src];
}
function mdToHtml(md) {
  const lines = String(md || '').split(/\n/); let html = '', inList = false;
  const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\*(.+?)\*/g, '<i>$1</i>');
  for (const raw of lines) {
    const l = raw.trim();
    if (/^[-*•]\s+/.test(l)) { if (!inList) { html += '<ul>'; inList = true; } html += '<li>' + inline(l.replace(/^[-*•]\s+/, '')) + '</li>'; continue; }
    if (inList) { html += '</ul>'; inList = false; }
    if (!l) continue;
    const h = l.match(/^(#{1,4})\s+(.*)/);
    if (h) html += `<h3>${inline(h[2])}</h3>`; else html += `<p>${inline(l)}</p>`;
  }
  if (inList) html += '</ul>';
  return html;
}

/* ======================= 设置 ======================= */
const PROVIDERS = {
  qwen: { name: '通义千问（阿里云百炼）', base: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', keyUrl: 'https://bailian.console.aliyun.com/?tab=model#/api-key', note: '国内直连，推荐中国大陆用户。新用户每个模型送免费额度，用完后按量计费也很便宜。' },
  glm: { name: '智谱 GLM-4-Flash', base: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash-250414', keyUrl: 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys', note: '国内直连，GLM-4-Flash 免费使用，适合零成本。' },
  gemini: { name: 'Google Gemini', base: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-3.1-flash-lite', keyUrl: 'https://aistudio.google.com/apikey', note: '有免费额度。中国大陆需要能访问 Google 的网络。若提示模型不可用，可把模型改成 gemini-flash-lite-latest。' },
  siliconflow: { name: '硅基流动 SiliconFlow', base: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen2.5-7B-Instruct', keyUrl: 'https://cloud.siliconflow.cn/account/ak', note: '国内直连，部分小模型免费，解析质量略低。' },
  deepseek: { name: 'DeepSeek', base: 'https://api.deepseek.com', model: 'deepseek-chat', keyUrl: 'https://platform.deepseek.com/api_keys', note: '需要少量充值，价格很低，中文解析质量好。' },
  custom: { name: '自定义（OpenAI 兼容接口）', base: '', model: '', keyUrl: '', note: '填写任意 OpenAI 兼容服务的地址和模型名。' },
};
const DEFAULTS = {
  provider: 'qwen', keys: {}, models: {}, bases: {},
  accent: 'en-US', voiceUS: '', voiceGB: '', rate: 0.95, slowRate: 0.6,
  fontSize: 19, theme: 'auto', autoReveal: false, sentSpk: 'always', prefetch: 2,
};
let S = loadSettings();
function loadSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('dr.settings') || '{}') }; } catch { return { ...DEFAULTS }; }
}
function saveSettings() { try { localStorage.setItem('dr.settings', JSON.stringify(S)); } catch {} applySettings(); }
function applySettings() {
  document.documentElement.style.setProperty('--read-size', S.fontSize + 'px');
  if (S.theme === 'auto') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', S.theme);
  $('#reader')?.classList.toggle('hide-sent-spk', S.sentSpk !== 'always');
  $('#ai-banner').hidden = hasAI();
}
function aiCfg() {
  const p = PROVIDERS[S.provider] || PROVIDERS.qwen;
  return { id: S.provider, key: (S.keys[S.provider] || '').trim(), model: ((S.provider === 'gemini' && /^gemini-2\.5-flash$/.test((S.models.gemini || '').trim()) ? '' : S.models[S.provider]) || p.model).trim(), base: (S.bases[S.provider] || p.base).trim().replace(/\/+$/, '') };
}
const hasAI = () => MOCK || !!aiCfg().key;

/* ======================= IndexedDB ======================= */
const STORES = { books: 'id', content: 'id', progress: 'bookId', cache: 'id', words: 'id', marks: 'id', gloss: 'id' };
let _db;
function db() {
  if (_db) return _db;
  _db = new Promise((res, rej) => {
    const r = indexedDB.open('deepreader', 1);
    r.onupgradeneeded = () => { for (const [n, k] of Object.entries(STORES)) if (!r.result.objectStoreNames.contains(n)) r.result.createObjectStore(n, { keyPath: k }); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  return _db;
}
async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(store, mode); const st = t.objectStore(store); let out;
    const r = fn(st); if (r && 'onsuccess' in r) r.onsuccess = () => (out = r.result);
    t.oncomplete = () => res(out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
  });
}
const idb = {
  get: (s, k) => tx(s, 'readonly', (st) => st.get(k)),
  put: (s, v) => tx(s, 'readwrite', (st) => st.put(v)),
  del: (s, k) => tx(s, 'readwrite', (st) => st.delete(k)),
  all: (s) => tx(s, 'readonly', (st) => st.getAll()),
  prefix: (s, p) => tx(s, 'readonly', (st) => st.getAll(IDBKeyRange.bound(p, p + '￿'))),
  delPrefix: (s, p) => tx(s, 'readwrite', (st) => st.delete(IDBKeyRange.bound(p, p + '￿'))),
};

/* ======================= 分句 ======================= */
const ABBR = /(?:^|[\s(“"'])(Mr|Mrs|Ms|Messrs|Dr|St|Jr|Sr|Prof|Gen|Col|Capt|Lt|Sgt|Rev|Hon|Gov|Pres|vs|etc|viz|cf|No|Nos|Vol|Vols|pp|ch|Ch|Fig|Mt|Ft|Co|Inc|Ltd|Bros|i\.e|e\.g|a\.m|p\.m|U\.S|A\.D|B\.C)\.$/;
function splitSentences(text) {
  const t = String(text).replace(/\s+/g, ' ').trim();
  if (!t) return [];
  const out = []; let start = 0;
  const re = /[.!?…]+["'”’)\]]*(?=\s+["'“‘(\[—-]?[A-Z0-9])/g; let m;
  while ((m = re.exec(t))) {
    const end = m.index + m[0].length;
    const head = t.slice(start, m.index + 1);
    if (m[0][0] === '.' && (ABBR.test(head) || /(?:^|\s)[A-Z]\.$/.test(head))) continue;
    out.push(t.slice(start, end).trim()); start = end;
  }
  if (start < t.length) out.push(t.slice(start).trim());
  const merged = [];
  for (const s of out) { if (merged.length && s.replace(/[^A-Za-z]/g, '').length < 2) merged[merged.length - 1] += ' ' + s; else merged.push(s); }
  return merged.filter(Boolean);
}
const wordCount = (s) => (s.match(/[A-Za-z’']+/g) || []).length;
function lemmaVariants(w) {
  w = w.toLowerCase().replace(/[’']s$/, '');
  const v = new Set([w]);
  const add = (x) => x.length > 2 && v.add(x);
  if (w.endsWith('ies')) add(w.slice(0, -3) + 'y');
  if (w.endsWith('es')) add(w.slice(0, -2));
  if (w.endsWith('s')) add(w.slice(0, -1));
  if (w.endsWith('ied')) add(w.slice(0, -3) + 'y');
  if (w.endsWith('ed')) { add(w.slice(0, -2)); add(w.slice(0, -1)); if (w.length > 5 && w[w.length - 3] === w[w.length - 4]) add(w.slice(0, -3)); }
  if (w.endsWith('ing')) { add(w.slice(0, -3)); add(w.slice(0, -3) + 'e'); if (w.length > 6 && w[w.length - 4] === w[w.length - 5]) add(w.slice(0, -4)); }
  if (w.endsWith('ly')) { add(w.slice(0, -2)); if (w.endsWith('ily')) add(w.slice(0, -3) + 'y'); }
  if (w.endsWith('er')) add(w.slice(0, -2)); if (w.endsWith('est')) add(w.slice(0, -3));
  return [...v];
}

/* ======================= 导入：各种格式 → {title, author, chapters:[{title, paras:[{t,h}]}]} ======================= */
const CH_RE = /^(?:(?:chapter|chap\.|part|book|volume|section|canto|letter|act)\s+(?:[0-9]+|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty[\w-]*|thirty[\w-]*|forty[\w-]*|fifty[\w-]*|the\s+\w+)\b.{0,60}|(?:prologue|epilogue|preface|introduction|foreword|afterword|contents)\b.{0,40}|第[一二三四五六七八九十百千零〇0-9]+[章节部卷回篇].{0,30})$/i;
const BLOCK = 'p,h1,h2,h3,h4,h5,h6,li,blockquote,pre,div,dd,dt,td,th,figcaption,section,article,aside,header,footer,tr,table,ul,ol,dl,body';
const LEAF_SKIP = new Set(['UL', 'OL', 'DL', 'TABLE', 'TR', 'SECTION', 'ARTICLE', 'BODY']);
function cleanText(s) { return s.replace(/­/g, '').replace(/[​-‍﻿]/g, '').replace(/\s+/g, ' ').trim(); }
function leafBlocks(root) {
  const res = [];
  const walk = (el) => {
    const kids = [...el.children].filter((c) => c.matches(BLOCK));
    if (!kids.length) { if (!LEAF_SKIP.has(el.tagName.toUpperCase()) || el.textContent.trim()) res.push(el); return; }
    // 有块级子元素，但也夹着直接文字：把文字作为一个段落保留
    let loose = '';
    for (const n of el.childNodes) {
      if (n.nodeType === 3) loose += n.textContent;
      else if (n.nodeType === 1 && !n.matches(BLOCK)) loose += n.textContent;
      else { if (cleanText(loose)) res.push({ loose: cleanText(loose) }); loose = ''; walk(n); }
    }
    if (cleanText(loose)) res.push({ loose: cleanText(loose) });
  };
  walk(root);
  return res;
}
function prepDom(doc) {
  $$('script,style,noscript,svg,math,img,figure > img', doc).forEach((e) => e.remove());
  $$('sup', doc).forEach((e) => { if (/^[\s\d*†‡§,\[\]]{1,6}$/.test(e.textContent)) e.remove(); });
  $$('br', doc).forEach((e) => e.replaceWith(doc.createTextNode(' ')));
}
function parseXml(text, type = 'application/xhtml+xml') {
  let doc = new DOMParser().parseFromString(text, type);
  if (doc.querySelector('parsererror')) doc = new DOMParser().parseFromString(text, 'text/html');
  return doc;
}
function pushPara(ch, t, h) { t = cleanText(t); if (t) ch.paras.push(h ? { t, h: 1 } : { t }); }
function finalizeBook(book) {
  const norm = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]/g, '');
  for (const c of book.chapters) while (c.paras.length && c.title && norm(c.paras[0].t) === norm(c.title)) c.paras.shift();
  book.chapters = book.chapters.filter((c) => c.paras.length);
  book.chapters.forEach((c, i) => { if (!c.title) c.title = '第 ' + (i + 1) + ' 部分'; });
  if (!book.chapters.length) throw new Error('没有在文件里找到文字。如果是扫描版 PDF（图片），目前无法识别。');
  return book;
}

/* ---- EPUB：按目录（nav / ncx）切分章节，支持一个文件里多个章节锚点 ---- */
async function parseEpub(file, prog) {
  await loadLib('lib/jszip.min.js');
  prog('正在解压 EPUB…');
  const zip = await JSZip.loadAsync(file);
  const read = async (p) => { const f = zip.file(p) || zip.file(decodeURIComponent(p)); return f ? f.async('string') : null; };
  const container = parseXml(await read('META-INF/container.xml'), 'application/xml');
  const opfPath = container.querySelector('rootfile').getAttribute('full-path');
  const dir = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '');
  const resolve = (base, href) => {
    const parts = (dir(base) + href.split('#')[0]).split('/'); const outp = [];
    for (const x of parts) { if (x === '..') outp.pop(); else if (x && x !== '.') outp.push(x); }
    try { return decodeURIComponent(outp.join('/')); } catch { return outp.join('/'); }
  };
  const opf = parseXml(await read(opfPath), 'application/xml');
  const meta = (n) => { const el = opf.getElementsByTagName('dc:' + n)[0] || opf.getElementsByTagName(n)[0]; return el ? cleanText(el.textContent) : ''; };
  const manifest = {};
  for (const it of opf.getElementsByTagName('item')) manifest[it.getAttribute('id')] = { path: resolve(opfPath, it.getAttribute('href')), type: it.getAttribute('media-type') || '', props: it.getAttribute('properties') || '' };
  const spineEl = opf.getElementsByTagName('spine')[0];
  const spine = [...opf.getElementsByTagName('itemref')].map((r) => manifest[r.getAttribute('idref')]).filter((m) => m && /html|xml/.test(m.type));

  // 目录
  const toc = [];
  const navItem = Object.values(manifest).find((m) => m.props.split(/\s+/).includes('nav'));
  if (navItem) {
    const nav = parseXml(await read(navItem.path) || '');
    const navs = [...nav.getElementsByTagName('nav')];
    const tocNav = navs.find((n) => (n.getAttribute('epub:type') || n.getAttributeNS?.('http://www.idpf.org/2007/ops', 'type') || '').includes('toc')) || navs[0];
    if (tocNav) for (const a of tocNav.getElementsByTagName('a')) {
      const href = a.getAttribute('href'); if (!href) continue;
      toc.push({ title: cleanText(a.textContent), path: resolve(navItem.path, href), frag: href.includes('#') ? decodeURIComponent(href.split('#')[1]) : '' });
    }
  }
  if (!toc.length) {
    const ncxId = spineEl?.getAttribute('toc');
    const ncxItem = manifest[ncxId] || Object.values(manifest).find((m) => /ncx/.test(m.type));
    if (ncxItem) {
      const ncx = parseXml(await read(ncxItem.path) || '', 'application/xml');
      for (const np of ncx.getElementsByTagName('navPoint')) {
        const label = np.getElementsByTagName('text')[0]; const content = np.getElementsByTagName('content')[0];
        if (!content) continue; const src = content.getAttribute('src');
        toc.push({ title: cleanText(label?.textContent || ''), path: resolve(ncxItem.path, src), frag: src.includes('#') ? decodeURIComponent(src.split('#')[1]) : '' });
      }
    }
  }
  const tocByPath = {};
  for (const e of toc) (tocByPath[e.path] ||= []).push(e);

  const book = { title: meta('title') || file.name.replace(/\.\w+$/, ''), author: meta('creator'), chapters: [] };
  let cur = null;
  const startChapter = (title) => {
    if (cur && !cur.paras.length && cur.fromToc) { cur.title = cur.title && title && cur.title !== title ? cur.title + ' · ' + title : (title || cur.title); return; }
    cur = { title, paras: [], fromToc: true }; book.chapters.push(cur);
  };
  for (let i = 0; i < spine.length; i++) {
    const item = spine[i];
    if (navItem && item.path === navItem.path && spine.length > 2) continue;
    prog(`正在读取章节 ${i + 1} / ${spine.length}…`);
    const html = await read(item.path); if (!html) continue;
    const doc = parseXml(html); prepDom(doc);
    const body = doc.body || doc.getElementsByTagName('body')[0] || doc.documentElement;
    const entries = tocByPath[item.path] || [];
    const fragMap = new Map(entries.filter((e) => e.frag).map((e) => [e.frag, e.title]));
    const whole = entries.find((e) => !e.frag);
    if (whole) startChapter(whole.title);
    else if (!toc.length) { const h = body.querySelector('h1,h2,h3'); cur = { title: h ? cleanText(h.textContent) : '', paras: [] }; book.chapters.push(cur); }
    else if (!cur) { cur = { title: '开篇', paras: [] }; book.chapters.push(cur); }
    const fired = new Set();
    for (const el of leafBlocks(body)) {
      if (el.loose) { pushPara(cur, el.loose); continue; }
      if (fragMap.size) {
        const ids = [];
        for (let a = el; a && a !== body.parentNode; a = a.parentElement) if (a.id) ids.push(a.id);
        el.querySelectorAll?.('[id]').forEach((d) => ids.push(d.id));
        for (const id of ids) if (fragMap.has(id) && !fired.has(id)) { fired.add(id); startChapter(fragMap.get(id)); }
      }
      pushPara(cur, el.textContent, /^H[1-6]$/i.test(el.tagName));
    }
  }
  return finalizeBook(book);
}

/* ---- PDF：按书签切章；没有书签时识别 “Chapter …” 行；去页码、页眉 ---- */
async function parsePdf(file, prog) {
  await loadLib('lib/pdf.min.js');
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'lib/pdf.worker.min.js';
  prog('正在打开 PDF…');
  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const meta = await pdf.getMetadata().catch(() => null);
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    if (i % 5 === 1) prog(`正在提取文字：第 ${i} / ${pdf.numPages} 页…`);
    const page = await pdf.getPage(i); const tc = await page.getTextContent();
    const rows = [];
    for (const it of tc.items) {
      if (!it.str) continue;
      const x = it.transform[4], y = it.transform[5], h = Math.abs(it.transform[3]) || it.height || 10;
      let row = rows.find((r) => Math.abs(r.y - y) < Math.max(2, h * 0.4));
      if (!row) { row = { y, h, items: [] }; rows.push(row); }
      row.items.push({ x, w: it.width, s: it.str }); row.h = Math.max(row.h, h);
    }
    rows.sort((a, b) => b.y - a.y);
    const lines = rows.map((r) => {
      r.items.sort((a, b) => a.x - b.x); let s = '', lastEnd = null;
      for (const it of r.items) { if (lastEnd != null && it.x - lastEnd > r.h * 0.18 && !/\s$/.test(s) && !/^\s/.test(it.s)) s += ' '; s += it.s; lastEnd = it.x + it.w; }
      return { y: r.y, h: r.h, x: r.items[0].x, end: lastEnd, t: s.replace(/\s+/g, ' ').trim() };
    }).filter((l) => l.t);
    pages.push(lines);
    page.cleanup?.();
  }
  // 页眉页脚：在很多页的顶部/底部重复出现的行
  const norm = (t) => t.replace(/\d+/g, '#').toLowerCase();
  const freq = {};
  pages.forEach((ls) => { const edge = [...ls.slice(0, 2), ...ls.slice(-2)]; new Set(edge.filter((l) => l.t.length <= 60).map((l) => norm(l.t) + "@" + Math.round(l.y / 4))).forEach((k) => (freq[k] = (freq[k] || 0) + 1)); });
  const repeated = new Set(Object.keys(freq).filter((k) => freq[k] >= 4 && freq[k] >= pages.length * 0.5));
  const isJunk = (l, idx, n) => /^[\divxlc\s\-–—.]+$/i.test(l.t) && l.t.length < 8 || ((idx < 2 || idx >= n - 2) && repeated.has(norm(l.t) + "@" + Math.round(l.y / 4)));

  // 书签 → 章节起始页
  let starts = [];
  try {
    let outline = await pdf.getOutline();
    if (outline && outline.length < 3 && outline.some((o) => o.items?.length)) outline = outline.flatMap((o) => [o, ...(o.items || [])]);
    for (const o of outline || []) {
      let dest = o.dest; if (typeof dest === 'string') dest = await pdf.getDestination(dest);
      if (!Array.isArray(dest)) continue;
      const idx = typeof dest[0] === 'number' ? dest[0] : await pdf.getPageIndex(dest[0]);
      starts.push({ page: idx, title: cleanText(o.title) });
    }
    starts.sort((a, b) => a.page - b.page);
  } catch { starts = []; }

  const book = { title: cleanText(meta?.info?.Title || '') || file.name.replace(/\.pdf$/i, ''), author: cleanText(meta?.info?.Author || ''), chapters: [] };
  let cur = null, buf = '', prev = null;
  const flush = () => { if (buf && cur) pushPara(cur, buf); buf = ''; };
  const newCh = (title) => { flush(); cur = { title, paras: [] }; book.chapters.push(cur); };
  if (!starts.length || starts[0].page > 0) newCh(starts.length ? '开篇' : '');
  let si = 0, sawHeading = false;
  const allW = pages.flat().map((l) => l.end - l.x).sort((a, b) => a - b);
  const fullW = allW[Math.floor(allW.length * 0.9)] || 400;
  for (let p = 0; p < pages.length; p++) {
    while (si < starts.length && starts[si].page <= p) { newCh(starts[si].title); si++; prev = null; }
    const ls = pages[p]; const n = ls.length;
    const gaps = []; for (let i = 1; i < n; i++) gaps.push(ls[i - 1].y - ls[i].y);
    const med = gaps.sort((a, b) => a - b)[Math.floor(gaps.length / 2)] || 14;
    const minX = Math.min(...ls.map((l) => l.x));
    for (let i = 0; i < n; i++) {
      const l = ls[i]; if (isJunk(l, i, n)) continue;
      if (!starts.length && l.t.length < 70 && CH_RE.test(l.t)) { newCh(l.t); sawHeading = true; prev = l; continue; }
      let brk = false;
      if (!prev) brk = !!buf && /[.!?"”’:]$/.test(buf);
      else if (prev.page !== p) brk = /[.!?"”’:]$/.test(buf) && (prev.end - prev.x) < fullW * 0.85;
      else {
        const gap = prev.y - l.y;
        brk = gap > med * 1.45 || (l.x > minX + l.h * 1.2 && l.x < minX + l.h * 6) || ((prev.end - prev.x) < fullW * 0.75 && /[.!?"”’:]$/.test(prev.t));
      }
      if (brk) flush();
      if (buf.endsWith('-') && /^[a-z]/.test(l.t)) buf = buf.slice(0, -1) + l.t; else buf += (buf ? ' ' : '') + l.t;
      prev = { ...l, page: p };
    }
  }
  flush();
  // 既没有书签也没识别到章节标题：每 15 页一部分
  if (!starts.length && !sawHeading && book.chapters.length === 1 && book.chapters[0].paras.length > 200) {
    const all = book.chapters[0].paras; book.chapters = [];
    for (let i = 0; i < all.length; i += 150) book.chapters.push({ title: `第 ${book.chapters.length + 1} 部分`, paras: all.slice(i, i + 150) });
  }
  return finalizeBook(book);
}

/* ---- TXT / Markdown / 粘贴 ---- */
async function decodeText(file) {
  const buf = await file.arrayBuffer();
  let t = new TextDecoder('utf-8').decode(buf);
  if ((t.match(/�/g) || []).length > 20) { try { t = new TextDecoder('gb18030').decode(buf); } catch {} }
  return t;
}
function parsePlain(text, title) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blank = lines.filter((l) => !l.trim()).length;
  const blankMode = blank > lines.length * 0.05;
  const book = { title, author: '', chapters: [] };
  let cur = { title: '', paras: [] }; book.chapters.push(cur);
  let buf = '';
  const flush = () => { if (buf) pushPara(cur, buf); buf = ''; };
  for (const raw of lines) {
    const l = raw.trim();
    const md = l.match(/^#{1,2}\s+(.+)/);
    if ((md || (l.length < 70 && CH_RE.test(l))) ) {
      flush();
      if (cur.paras.length || cur.title) { cur = { title: '', paras: [] }; book.chapters.push(cur); }
      cur.title = md ? md[1] : l; continue;
    }
    if (!l) { flush(); continue; }
    if (/^#{3,6}\s+/.test(l)) { flush(); pushPara(cur, l.replace(/^#+\s+/, ''), true); continue; }
    if (!blankMode) { pushPara(cur, l); continue; }
    if (buf.endsWith('-') && /^[a-z]/.test(l)) buf = buf.slice(0, -1) + l; else buf += (buf ? ' ' : '') + l;
  }
  flush();
  if (book.chapters.length === 1 && book.chapters[0].paras.length > 250) {
    const all = book.chapters[0].paras; book.chapters = [];
    for (let i = 0; i < all.length; i += 150) book.chapters.push({ title: `第 ${book.chapters.length + 1} 部分`, paras: all.slice(i, i + 150) });
  }
  return finalizeBook(book);
}

/* ---- HTML / DOCX ---- */
function parseHtmlDoc(doc, title) {
  prepDom(doc);
  const body = doc.body || doc.documentElement;
  const counts = { H1: $$('h1', body).length, H2: $$('h2', body).length };
  const chTag = counts.H1 >= 2 ? 'H1' : counts.H2 >= 2 ? 'H2' : counts.H1 ? 'H1' : null;
  const book = { title: cleanText(doc.title || '') || title, author: '', chapters: [] };
  let cur = { title: '', paras: [] }; book.chapters.push(cur);
  for (const el of leafBlocks(body)) {
    if (el.loose) { pushPara(cur, el.loose); continue; }
    const tag = el.tagName.toUpperCase(); const txt = cleanText(el.textContent);
    if (tag === chTag || (/^(P|DIV)$/.test(tag) && txt.length < 60 && CH_RE.test(txt) && !chTag)) {
      if (cur.paras.length || cur.title) { cur = { title: '', paras: [] }; book.chapters.push(cur); }
      cur.title = txt; continue;
    }
    pushPara(cur, txt, /^H[1-6]$/.test(tag));
  }
  return finalizeBook(book);
}
async function parseDocx(file, prog) {
  await loadLib('lib/mammoth.browser.min.js'); prog('正在读取 Word 文档…');
  const r = await mammoth.convertToHtml({ arrayBuffer: await file.arrayBuffer() });
  return parseHtmlDoc(new DOMParser().parseFromString(r.value, 'text/html'), file.name.replace(/\.docx$/i, ''));
}
async function parseFb2(file) {
  const doc = parseXml(await decodeText(file), 'application/xml');
  const book = { title: cleanText(doc.querySelector('book-title')?.textContent || '') || file.name, author: cleanText(doc.querySelector('author')?.textContent || ''), chapters: [] };
  const body = doc.querySelector('body');
  const secs = body ? [...body.children].filter((c) => c.tagName === 'section') : [];
  const walkSec = (sec, ch) => { for (const c of sec.children) { if (c.tagName === 'title') continue; if (c.tagName === 'section') { const t = c.querySelector('title'); if (t) pushPara(ch, t.textContent, true); walkSec(c, ch); } else pushPara(ch, c.textContent, c.tagName === 'subtitle'); } };
  for (const s of secs) { const ch = { title: cleanText(s.querySelector('title')?.textContent || ''), paras: [] }; walkSec(s, ch); book.chapters.push(ch); }
  return finalizeBook(book);
}
async function parseFile(file, prog) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  if (file.size > MAX_FILE) throw new Error('文件超过 1000 MB，暂不支持。');
  if (ext === 'epub') return parseEpub(file, prog);
  if (ext === 'pdf') return parsePdf(file, prog);
  if (ext === 'docx') return parseDocx(file, prog);
  if (ext === 'fb2') return parseFb2(file);
  if (/^(html?|xhtml)$/.test(ext)) return parseHtmlDoc(parseXml(await decodeText(file), 'text/html'), file.name.replace(/\.\w+$/, ''));
  if (/^(txt|md|markdown|text)$/.test(ext) || !ext) return parsePlain(await decodeText(file), file.name.replace(/\.\w+$/, ''));
  if (/^(mobi|azw3?|kfx)$/.test(ext)) throw new Error('Kindle 格式（MOBI/AZW3）暂不支持。可以用免费软件 Calibre 转成 EPUB 再导入。');
  throw new Error('不支持的文件格式：.' + ext);
}

/* ======================= 朗读（浏览器自带，免费） ======================= */
const tts = {
  id: null, seq: 0,
  voices() { return speechSynthesis.getVoices().filter((v) => /^en[-_]/i.test(v.lang)); },
  pick(accent) {
    const want = accent || S.accent; const vs = this.voices();
    const chosen = want === 'en-GB' ? S.voiceGB : S.voiceUS;
    const named = vs.find((v) => v.name === chosen); if (named) return named;
    const same = vs.filter((v) => v.lang.replace('_', '-').toLowerCase() === want.toLowerCase());
    const pref = want === 'en-GB' ? ['Daniel', 'Serena', 'Kate', 'Google UK English Female', 'Libby', 'Sonia', 'Arthur'] : ['Samantha', 'Ava', 'Allison', 'Google US English', 'Aria', 'Jenny', 'Alex'];
    for (const p of pref) { const v = same.find((x) => x.name.includes(p)); if (v) return v; }
    return same[0] || vs[0] || null;
  },
  mark(id, on) { if (id) $$(`[data-tts="${CSS.escape(id)}"]`).forEach((b) => b.classList.toggle('playing', on)); },
  stop() { const id = this.id; this.id = null; this.seq++; try { speechSynthesis.cancel(); } catch {} this.mark(id, false); $$('.sent.reading').forEach((e) => e.classList.remove('reading')); $('#btn-readall')?.classList.remove('on'); },
  // 再点一次同一个按钮 = 停止
  toggle(id, texts, opts = {}) {
    if (!('speechSynthesis' in window)) { toast('这个浏览器不支持朗读'); return; }
    if (this.id === id) { this.stop(); return; }
    this.stop(); this.id = id; this.mark(id, true);
    const seq = ++this.seq; const list = Array.isArray(texts) ? texts : [texts];
    const voice = this.pick(opts.accent); const rate = opts.rate || S.rate;
    let i = 0;
    const next = () => {
      if (seq !== this.seq) return;
      if (i >= list.length) { this.mark(id, false); if (this.id === id) this.id = null; opts.onEnd?.(); return; }
      const idx = i++; const u = new SpeechSynthesisUtterance(list[idx]);
      if (voice) u.voice = voice; u.lang = voice?.lang || opts.accent || S.accent; u.rate = rate;
      u.onstart = () => opts.onItem?.(idx);
      u.onend = next; u.onerror = (e) => { if (e.error !== 'interrupted' && e.error !== 'canceled') next(); };
      speechSynthesis.speak(u);
    };
    setTimeout(next, 60);
  },
};
if ('speechSynthesis' in window) speechSynthesis.onvoiceschanged = () => {};
let ttsN = 0;
function spkBtn(text, opts = {}) {
  const id = opts.id || 't' + (++ttsN);
  spkBtn.map.set(id, { text, opts });
  return `<button class="spk ${opts.cls || ''}" data-tts="${esc(id)}" title="${esc(opts.title || '朗读（再点一次停止）')}" aria-label="朗读">${opts.label || '<svg><use href="#i-speak"/></svg>'}</button>`;
}
spkBtn.map = new Map();
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-tts]'); if (!b || b.dataset.custom) return;
  const it = spkBtn.map.get(b.dataset.tts); if (!it) return;
  e.stopPropagation(); e.preventDefault();
  const t = typeof it.text === 'function' ? it.text() : it.text;
  tts.toggle(b.dataset.tts, t, it.opts);
}, true);

/* ======================= AI ======================= */
class AIError extends Error { constructor(msg, code) { super(msg); this.code = code; } }
async function aiChat(kind, messages, { json = true, maxTokens = 2500, payload } = {}) {
  if (MOCK) { await sleep(500); return mockAI(kind, payload); }
  const c = aiCfg();
  if (!c.key) throw new AIError('还没有设置 AI Key。点右上角齿轮 → AI 服务，填入免费的千问 / 智谱 / Gemini Key。', 'nokey');
  if (!c.base || !c.model) throw new AIError('请在设置里填写接口地址和模型名。', 'cfg');
  const body = { model: c.model, messages, temperature: 0.3, max_tokens: maxTokens };
  if (c.id === 'qwen') body.enable_thinking = false;
  if (c.id === 'gemini' && /2\.5-flash/.test(c.model)) body.reasoning_effort = 'none';
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    let res;
    try {
      res = await fetch(c.base + '/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + c.key }, body: JSON.stringify(body) });
    } catch (e) {
      throw new AIError(`连不上 ${PROVIDERS[c.id]?.name || 'AI 服务'}。可能是网络无法访问（例如中国大陆访问 Gemini），或者该服务不允许浏览器直接调用。可以在设置里换一个服务。`, 'net');
    }
    if (res.ok) {
      const data = await res.json();
      const text = data.choices?.[0]?.message?.content || '';
      if (!json) return text;
      try { return parseJSON(text); } catch { lastErr = new AIError('AI 返回的格式不对，正在重试…', 'format'); continue; }
    }
    const errText = await res.text().catch(() => '');
    if (c.id === 'qwen' && /access to model denied|not eligible|eligible for using/i.test(errText)) throw new AIError('Key 是对的，但这个账号暂时没有「' + c.model + '」的使用权限。请到阿里云百炼控制台：① 确认已开通「模型服务」；② 如果 Key 是在子业务空间创建的，给该空间授权这个模型，或改用主账号默认空间的 Key；③ 如果是国际站（新加坡）账号，把接口地址改成 https://dashscope-intl.aliyuncs.com/compatible-mode/v1；④ 如果开了「免费额度用完即停」且额度已用完，可以把模型换成 qwen-turbo 或 qwen-flash 再试。', 'auth');
    if (res.status === 401 || res.status === 403) throw new AIError('API Key 无效或没有权限，请在设置里检查。' + shortErr(errText), 'auth');
    if (res.status === 429) { lastErr = new AIError('免费额度的调用频率到上限了，稍等一分钟再试。' + shortErr(errText), 'rate'); await sleep(4000 * (attempt + 1)); continue; }
    if (res.status === 404) throw new AIError('模型「' + c.model + '」不可用（可能已下线或名字写错）。请在设置 → AI 服务里把模型改成默认值' + (PROVIDERS[c.id]?.model ? '「' + PROVIDERS[c.id].model + '」' : '') + '后再试。' + shortErr(errText), 'cfg');
    lastErr = new AIError(`AI 服务出错（${res.status}）` + shortErr(errText), 'http');
    if (res.status < 500) break;
    await sleep(1500);
  }
  throw lastErr;
}
function shortErr(t) { try { const j = JSON.parse(t); t = j.error?.message || j.message || t; } catch {} return t ? '：' + String(t).slice(0, 140) : ''; }
function parseJSON(text) {
  let t = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) t = t.slice(a, b + 1);
  return JSON.parse(t);
}
// 简单队列：当前段落优先，预读段落排后；并发 2
const aiQ = { items: [], running: 0, limit: 2 };
function enqueue(key, fn, urgent) {
  const ex = aiQ.items.find((x) => x.key === key);
  if (ex) { if (urgent) { aiQ.items.splice(aiQ.items.indexOf(ex), 1); aiQ.items.unshift(ex); } return ex.promise; }
  let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; });
  const item = { key, fn, resolve, reject, promise };
  urgent ? aiQ.items.unshift(item) : aiQ.items.push(item);
  pump(); return promise;
}
function pump() {
  while (aiQ.running < aiQ.limit && aiQ.items.length) {
    const it = aiQ.items.shift(); aiQ.running++;
    it.fn().then(it.resolve, it.reject).finally(() => { aiQ.running--; pump(); });
  }
}
const SYS = '你是一位英语文学与人文社科原著的阅读导师，学生是中文母语者，英语大约大学六级水平。你只输出 JSON，不输出任何其它文字。中文表达简洁、准确、口语化。';
const typeLabel = (b) => (b?.type === 'thought' ? '思想/非虚构类' : '文学类');

/* 段落批量解析：一次请求拿到整段每一句的翻译、重点词、结构、人物概念 */
const memAna = new Map(); const inflight = new Map();
function anaKey(ch, p) { return `a|${R.book.id}|${ch}|${p}`; }
async function getParaAnalysis(ch, p, urgent) {
  const key = anaKey(ch, p);
  if (memAna.has(key)) return memAna.get(key);
  if (inflight.has(key)) { if (urgent) enqueueBump(key); return inflight.get(key); }
  const pr = (async () => {
    const cached = await idb.get('cache', key);
    if (cached) { memAna.set(key, cached.v); return cached.v; }
    const sents = R.sents(ch, p); const book = R.book;
    const chunks = []; for (let i = 0; i < sents.length; i += 8) chunks.push(i);
    const parts = await Promise.all(chunks.map((start) => enqueue(key + '|' + start, () => analyzeChunk(book, ch, p, sents, start, Math.min(start + 8, sents.length)), urgent)));
    const v = { s: [] };
    for (const part of parts) for (const it of part.s || []) if (Number.isInteger(it.i) && it.i < sents.length) v.s[it.i] = it;
    memAna.set(key, v);
    await idb.put('cache', { id: key, v, at: Date.now() });
    await registerEntities(ch, p, v);
    return v;
  })();
  inflight.set(key, pr);
  pr.catch(() => {}).finally(() => inflight.delete(key));
  return pr;
}
function enqueueBump(key) { for (const it of aiQ.items) if (it.key.startsWith(key + '|')) { aiQ.items.splice(aiQ.items.indexOf(it), 1); aiQ.items.unshift(it); } }
async function analyzeChunk(book, ch, p, sents, a, b) {
  const known = [...R.gloss.values()].slice(0, 80).map((g) => g.name).join(', ') || '无';
  const para = sents.join(' ');
  const list = sents.slice(a, b).map((s, k) => `[${a + k}] ${s}`).join('\n');
  const user = `书名：${book.title}${book.author ? '（' + book.author + '）' : ''}，${typeLabel(book)}
已知人物/概念：${known}
所在章节：${R.content.chapters[ch].title}
段落全文（用于理解语境）：
"""${para.slice(0, 3000)}"""

请逐句分析下面这些句子：
${list}

返回 JSON：
{"s":[{"i":句子编号,"zh":"自然流畅的中文翻译","v":[{"w":"原文中的词形","l":"词典原形","ipa":"美式音标，如 /ɪndɪˈfætɪɡəbl/","pos":"词性缩写，如 adj.","en":"简短英文释义，不超过12个词","zh":"中文释义，不超过8个字","ctx":"它在这句话里的具体意思，不超过15个字"}],"st":null,"e":[{"n":"名字","k":"人物/概念/地点/组织","d":"不超过25字的说明"}]}]}

规则：
1. v 只挑对六级水平读者有难度、或在这里有特殊含义的词和短语，每句 0–5 个；常见词不要挑。短语动词、习语可以挑。
2. 句子超过 18 个词或结构复杂时，st 写成 {"main":"句子主干（原文）","parts":[{"t":"成分，如 定语从句/状语从句/分词短语/同位语/插入语","x":"对应原文片段","n":"作用说明，不超过20字"}]}；否则 st 为 null。
3. e 只列书中人物、地名、虚构概念、专有名词；“已知”列表中的也要列出名字，d 可以留空。没有就给 []。
4. ctx 要具体说出这个词在此处的含义、语气或言外之意，不要写“结合原句理解”这类空话。`;
  return aiChat('para', [{ role: 'system', content: SYS }, { role: 'user', content: user }], { maxTokens: 400 + (b - a) * 450, payload: { sents, a, b } });
}
async function getWordDetail(word, sentence, loc) {
  const key = `w|${word.toLowerCase()}|${loc}`;
  const c = await idb.get('cache', key); if (c) return c.v;
  const user = `单词或短语："${word}"
所在句子："${sentence}"
书名：${R.book?.title || ''}
返回 JSON：
{"w":"词典原形","ipa_us":"美式音标","ipa_uk":"英式音标","pos":"词性","en":"简短英文释义，不超过12个词","zh":"中文释义，不超过8个字","ctx":"在这句话中的具体意思，不超过15个字","ex":"一个新的、贴近生活的英文例句","ex_zh":"例句的中文翻译","img":true 或 false（具体可见的事物，如 turbine、embryo、piercing 为 true；抽象词如 whereas、atonement 为 false）,"cmp":"如果是抽象词：与 1–2 个近义词的区别，中文，不超过40字；具体词留空"}`;
  const v = await enqueue(key, () => aiChat('word', [{ role: 'system', content: SYS }, { role: 'user', content: user }], { maxTokens: 600, payload: { word, sentence } }), true);
  await idb.put('cache', { id: key, v, at: Date.now() });
  return v;
}
async function getParaNote(ch, p) {
  const key = `n|${R.book.id}|${ch}|${p}`;
  const c = await idb.get('cache', key); if (c) return c.v;
  const paras = R.content.chapters[ch].paras;
  const prevText = paras.slice(Math.max(0, p - 2), p).map((x) => x.t).join(' ').slice(-1200);
  const lit = R.book.type !== 'thought';
  const ask = lit
    ? '请对“本段”做简洁的文学分析：写作手法、意象与修辞、人物刻画、反讽或言外之意、这段在故事中的作用。'
    : '请说明“本段”在讲什么：核心论点、论证方式、关键概念，以及它和上下文的关系。';
  const user = `书名：${R.book.title}（${typeLabel(R.book)}），章节：${paras && R.content.chapters[ch].title}
前文（供参考）："""${prevText}"""
本段："""${paras[p].t.slice(0, 4000)}"""
${ask}
用中文，3–5 条要点，每条一两句话，不要复述翻译。返回 JSON：{"title":"一句话概括，不超过20字","points":["要点1","要点2"]}`;
  const v = await enqueue(key, () => aiChat('note', [{ role: 'system', content: SYS }, { role: 'user', content: user }], { maxTokens: 900, payload: { lit } }), true);
  await idb.put('cache', { id: key, v, at: Date.now() });
  return v;
}
async function getStructure(sentence, loc) {
  const key = `st|${loc}`;
  const c = await idb.get('cache', key); if (c) return c.v;
  const user = `分析这个英文句子的结构："${sentence}"
返回 JSON：{"main":"句子主干（主语+谓语+宾语等，原文）","parts":[{"t":"成分，如 主语/谓语/定语从句/状语从句/分词短语/同位语/插入语","x":"对应原文片段","n":"作用说明，不超过20字"}]}`;
  const v = await enqueue(key, () => aiChat('struct', [{ role: 'system', content: SYS }, { role: 'user', content: user }], { maxTokens: 700, payload: { sentence } }), true);
  await idb.put('cache', { id: key, v, at: Date.now() });
  return v;
}

/* 演示模式（?mock=1）：不调用 AI，只用来预览界面 */
function mockAI(kind, pl = {}) {
  const words = (s) => (s.match(/[A-Za-z]{7,}/g) || []).slice(0, 3);
  if (kind === 'para') return { s: pl.sents.slice(pl.a, pl.b).map((s, k) => ({
    i: pl.a + k, zh: `（演示翻译）第 ${pl.a + k + 1} 句的中文意思会显示在这里。`,
    v: words(s).map((w) => ({ w, l: w.toLowerCase(), ipa: '/ˈdemoʊ/', pos: 'adj.', en: 'a short English definition', zh: '中文释义', ctx: '在本句中的意思' })),
    st: wordCount(s) > 18 ? { main: s.split(',')[0], parts: [{ t: '状语', x: s.split(',')[1] || '', n: '补充说明动作方式' }] } : null,
    e: (s.match(/\b[A-Z][a-z]{3,}\b/g) || []).slice(1, 2).map((n) => ({ n, k: '人物', d: '演示：人物说明' })),
  })) };
  if (kind === 'word') return { w: pl.word.toLowerCase(), ipa_us: '/ˈwɜːrd/', ipa_uk: '/ˈwɜːd/', pos: 'n.', en: 'a short English definition', zh: '中文释义', ctx: '在这句话里的意思', ex: `This is a new example with ${pl.word}.`, ex_zh: '这是一个新例句。', img: pl.word.length % 2 === 0, cmp: '与近义词的区别（演示）' };
  if (kind === 'note') return { title: pl.lit ? '演示：本段的文学分析' : '演示：本段在讲什么', points: ['要点一：写作手法。', '要点二：反讽与言外之意。', '要点三：这段在全书中的作用。'] };
  if (kind === 'struct') return { main: pl.sentence.split(',')[0], parts: [{ t: '主语', x: pl.sentence.split(' ')[0], n: '动作发出者' }] };
  if (kind === 'marks') return '## 演示：划线整理\n- **主题一**：……\n- **主题二**：……';
  if (kind === 'test') return { ok: true };
  return {};
}

/* ======================= 状态 ======================= */
const R = {
  book: null, content: null, ch: 0, active: null, marks: new Map(), gloss: new Map(), _s: new Map(),
  sents(ch, p) { const k = ch + ':' + p; if (!this._s.has(k)) { const para = this.content.chapters[ch].paras[p]; this._s.set(k, para.h ? [para.t] : splitSentences(para.t)); } return this._s.get(k); },
  loc(ch, p, s) { return `${this.book.id}|${ch}|${p}|${s}`; },
};
let WORDS = new Map(); // 生词本（全局）
async function loadWords() { WORDS = new Map((await idb.all('words')).map((w) => [w.id, w])); }
function findWord(w) { for (const v of lemmaVariants(w)) if (WORDS.has(v)) return WORDS.get(v); return null; }

/* ======================= 书架 ======================= */
const COVER_COLORS = ['#1f5c57', '#6b3f5e', '#3d4f7c', '#7a5a2b', '#40613a', '#8a3b2f', '#2f5f7a', '#5a4a78'];
async function renderLibrary() {
  const books = (await idb.all('books')).sort((a, b) => (b.lastRead || b.added) - (a.lastRead || a.added));
  const progs = new Map((await idb.all('progress')).map((p) => [p.bookId, p]));
  const ul = $('#book-list');
  if (!books.length) {
    ul.innerHTML = `<li class="empty">书架是空的。<br>导入一本英文电子书，或者 <a href="#" id="load-sample">打开示例：Pride and Prejudice 第一章</a>。</li>`;
    $('#load-sample').onclick = (e) => { e.preventDefault(); importSample(); };
    return;
  }
  ul.innerHTML = books.map((b) => {
    const pr = progs.get(b.id); const pct = Math.round((pr?.pct || 0) * 100);
    const initial = (b.title.match(/[A-Za-z一-龥]/) || ['B'])[0].toUpperCase();
    return `<li class="book" data-id="${b.id}">
      <div class="cover" style="background:${b.color}">${esc(initial)}</div>
      <div class="book-meta">
        <div class="book-title">${esc(b.title)}</div>
        <div class="book-sub">${esc(b.author || '')}${b.author ? ' · ' : ''}${b.chapters.length} 章 · ${b.type === 'thought' ? '思想' : '文学'}</div>
        <div class="book-sub">${pr ? `读到 ${esc(b.chapters[pr.ch]?.title || '')} · ${pct}%` : '未开始'}</div>
        <div class="bar"><i style="width:${pct}%"></i></div>
      </div>
      <button class="icon-btn book-del" data-del="${b.id}" title="删除这本书" aria-label="删除"><svg><use href="#i-trash"/></svg></button>
    </li>`;
  }).join('');
}
$('#book-list').addEventListener('click', (e) => {
  const del = e.target.closest('[data-del]');
  if (del) { e.stopPropagation(); confirmDelete(del.dataset.del); return; }
  const li = e.target.closest('.book'); if (li) openBook(li.dataset.id);
});
async function confirmDelete(id) {
  const b = await idb.get('books', id); if (!b) return;
  openSheet('删除书籍', `<p>确定从书架删除《${esc(b.title)}》吗？</p>
    <label class="check"><input type="checkbox" id="del-marks"> 同时删除这本书的划线、人物概念和解析缓存</label>
    <p class="hint">生词本里的单词会保留。</p>
    <div class="row"><button class="btn danger" id="del-yes"><svg><use href="#i-trash"/></svg> 删除</button><button class="btn" id="del-no">取消</button></div>`);
  $('#del-no').onclick = closeSheet;
  $('#del-yes').onclick = async () => {
    await idb.del('books', id); await idb.del('content', id); await idb.del('progress', id);
    if ($('#del-marks').checked) { await idb.delPrefix('marks', id + '|'); await idb.delPrefix('gloss', id + '|'); await idb.delPrefix('cache', `a|${id}|`); await idb.delPrefix('cache', `n|${id}|`); }
    closeSheet(); toast('已删除'); renderLibrary();
  };
}

/* ---- 导入流程 ---- */
$('#file-input').addEventListener('change', async (e) => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  if (f.size > MAX_FILE) { toast('文件超过 1000 MB'); return; }
  openSheet('导入中', `<div class="progress-box"><div class="loading" id="imp-msg">正在读取 ${esc(f.name)}（${(f.size / 1048576).toFixed(1)} MB）…</div></div>`);
  try {
    const book = await parseFile(f, (m) => { const el = $('#imp-msg'); if (el) el.textContent = m; });
    confirmImport(book);
  } catch (err) {
    console.error(err);
    $('#sheet-body').innerHTML = `<p class="err">导入失败：${esc(err.message || err)}</p><button class="btn" onclick="closeSheet()">关闭</button>`;
  }
});
$('#btn-paste').onclick = () => {
  openSheet('粘贴文本', `<label class="field"><span>标题</span><input id="paste-title" placeholder="例如：Brave New World 第五章"></label>
    <label class="field"><span>英文正文（空行分段；以 “Chapter …” 开头的行会自动识别为章节）</span><textarea id="paste-text" placeholder="把英文原文粘贴到这里"></textarea></label>
    <div class="row"><button class="btn primary" id="paste-ok">下一步</button></div>`);
  $('#paste-ok').onclick = () => {
    const t = $('#paste-text').value.trim(); if (!t) { toast('请先粘贴文本'); return; }
    try { confirmImport(parsePlain(t, $('#paste-title').value.trim() || t.slice(0, 40))); } catch (e) { toast(e.message); }
  };
};
function confirmImport(book) {
  const total = book.chapters.reduce((n, c) => n + c.paras.length, 0);
  openSheet('确认导入', `
    <label class="field"><span>书名</span><input id="imp-title" value="${esc(book.title)}"></label>
    <label class="field"><span>作者</span><input id="imp-author" value="${esc(book.author || '')}"></label>
    <div class="field"><span>书的类型（决定段尾“解读”的方式）</span>
      <div class="seg" id="imp-type"><button data-v="literary" class="on">文学 · 小说</button><button data-v="thought">思想 · 非虚构</button></div></div>
    <div class="note-box">识别到 <b>${book.chapters.length}</b> 个章节，共 ${total} 段。</div>
    <ul class="list">${book.chapters.slice(0, 60).map((c, i) => `<li class="toc-item"><span>${esc(c.title || '第 ' + (i + 1) + ' 部分')}</span><small>${c.paras.length} 段</small></li>`).join('')}${book.chapters.length > 60 ? `<li>…还有 ${book.chapters.length - 60} 章</li>` : ''}</ul>
    <div class="row"><button class="btn primary" id="imp-ok">加入书架并开始阅读</button><button class="btn" id="imp-cancel">取消</button></div>`);
  let type = 'literary';
  $('#imp-type').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; type = b.dataset.v; $$('#imp-type button').forEach((x) => x.classList.toggle('on', x === b)); };
  $('#imp-cancel').onclick = closeSheet;
  $('#imp-ok').onclick = async () => {
    const id = 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const meta = { id, title: $('#imp-title').value.trim() || book.title, author: $('#imp-author').value.trim(), type, added: Date.now(), color: COVER_COLORS[Math.floor(Math.random() * COVER_COLORS.length)], chapters: book.chapters.map((c) => ({ title: c.title, n: c.paras.length })), total };
    await idb.put('content', { id, chapters: book.chapters.map((c) => ({ title: c.title, paras: c.paras })) });
    await idb.put('books', meta);
    try { await navigator.storage?.persist?.(); } catch {}
    closeSheet(); openBook(id);
  };
}
async function importSample() {
  const book = parsePlain(SAMPLE, 'Pride and Prejudice'); book.author = 'Jane Austen'; confirmImport(book);
}

/* ======================= 阅读器 ======================= */
async function openBook(id, at) {
  const [meta, content, prog] = await Promise.all([idb.get('books', id), idb.get('content', id), idb.get('progress', id)]);
  if (!meta || !content) { toast('找不到这本书'); showLibrary(); return; }
  tts.stop();
  R.book = meta; R.content = content; R._s = new Map(); R.active = null;
  R.marks = new Map((await idb.prefix('marks', id + '|')).map((m) => [m.id, m]));
  R.gloss = new Map((await idb.prefix('gloss', id + '|')).map((g) => [g.id, g]));
  meta.lastRead = Date.now(); idb.put('books', meta);
  $('#view-library').hidden = true; $('#view-reader').hidden = false;
  if (location.hash !== '#b-' + id) history.replaceState(null, '', '#b-' + id);
  const pos = at || prog || { ch: 0, p: 0 };
  renderChapter(Math.min(pos.ch, content.chapters.length - 1), { p: pos.p, ap: pos.ap ?? pos.p, s: pos.s ?? pos.as ?? null, restore: true });
}
function showLibrary() {
  tts.stop(); closePanel(true);
  $('#view-reader').hidden = true; $('#view-library').hidden = false;
  history.replaceState(null, '', location.pathname + location.search);
  R.book = null; renderLibrary();
}
function renderChapter(ch, { p = 0, ap = p, s = null, restore = false, flash = false } = {}) {
  R.ch = ch; R.active = null;
  const chap = R.content.chapters[ch];
  const html = [`<h2 class="ch-title">${esc(chap.title)}</h2>`];
  chap.paras.forEach((para, pi) => {
    if (para.h) { html.push(`<div class="para heading" data-p="${pi}">${esc(para.t)}</div>`); return; }
    const sents = R.sents(ch, pi);
    const inner = sents.map((t, si) => {
      const m = R.marks.get(R.loc(ch, pi, si));
      const cls = 'sent' + (m?.hl ? ' hl' : '') + (m?.ul ? ' ul' : '');
      return `<span class="${cls}" data-s="${si}">${esc(t)}</span>${spkBtn(t, { id: `s:${ch}:${pi}:${si}`, cls: 'sent-spk', title: '朗读这句（再点停止）' })}`;
    }).join(' ');
    const tools = para.t.length > 40 ? `<div class="para-tools">
        ${spkBtn(() => R.sents(ch, pi), { id: `p:${ch}:${pi}`, label: '<svg><use href="#i-speak"/></svg>朗读本段', cls: 'pt' }).replace('class="spk pt"', 'class="pt"')}
        <button data-note="${pi}"><svg><use href="#i-bulb"/></svg>${R.book.type === 'thought' ? '这段在讲什么' : '文学分析'}</button>
        <span class="ready" data-ready="${pi}" hidden title="解析已就绪"></span>
      </div>` : '';
    html.push(`<div class="para" data-p="${pi}"><p style="margin:0">${inner}</p>${tools}</div>`);
  });
  $('#reader').innerHTML = html.join('');
  $('#reader').classList.toggle('hide-sent-spk', S.sentSpk !== 'always');
  $('#tb-title').textContent = R.book.title;
  $('#ch-indicator').textContent = `${ch + 1} / ${R.content.chapters.length}`;
  $('#btn-prev-ch').disabled = ch === 0; $('#btn-next-ch').disabled = ch >= R.content.chapters.length - 1;
  // 已经解析过的段落打个小绿点
  idb.prefix('cache', `a|${R.book.id}|${ch}|`).then((rows) => rows.forEach((r) => { const pi = r.id.split('|')[3]; memAna.set(r.id, r.v); const d = $(`[data-ready="${pi}"]`); if (d) d.hidden = false; }));
  const sc = $('#reader-scroll');
  const target = $(`.para[data-p="${p}"]`);
  if (target && (p > 0 || restore)) scrollToEl(target); else sc.scrollTop = 0;
  const aTarget = $(`.para[data-p="${ap}"]`);
  if (s != null && aTarget) {
    const el = $(`.sent[data-s="${s}"]`, aTarget);
    if (el) { if (flash) { el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); } if (!isMobile() || !restore) activate(ap, +s, { noScroll: true }); else { el.classList.add('active'); R.active = { p: ap, s: +s }; } }
    else if (!isMobile()) showPanelEmpty();
  } else if (!isMobile()) showPanelEmpty();
  saveProgress();
  if (hasAI() && S.prefetch > 0) prefetchFrom(p);
}
$('#btn-prev-ch').onclick = () => R.ch > 0 && renderChapter(R.ch - 1);
$('#btn-next-ch').onclick = () => R.ch < R.content.chapters.length - 1 && renderChapter(R.ch + 1);
$('#btn-back').onclick = showLibrary;

function goTo(ch, p, s) { closeSheet(); if (ch !== R.ch) renderChapter(ch, { p, s, flash: true }); else { const t = $(`.para[data-p="${p}"]`); scrollToEl(t, 'center'); if (s != null) { const el = $(`.sent[data-s="${s}"]`, t); if (el) { el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); activate(p, +s, { noScroll: true }); } } } }

/* ---- 进度：每次点句子、滚动都保存 ---- */
const saveProgress = debounce(async () => {
  if (!R.book) return;
  const sc = $('#reader-scroll'); const top = sc.getBoundingClientRect().top;
  let p = 0;
  for (const el of $$('.para', $('#reader'))) { if (el.getBoundingClientRect().bottom > top + 40) { p = +el.dataset.p; break; } }
  const ap = R.active ? R.active.p : null, as = R.active ? R.active.s : null;
  const before = R.book.chapters.slice(0, R.ch).reduce((n, c) => n + c.n, 0);
  const pct = Math.min(1, (before + p + 1) / Math.max(1, R.book.total));
  $('#progress-fill').style.width = (pct * 100).toFixed(1) + '%';
  await idb.put('progress', { bookId: R.book.id, ch: R.ch, p, ap, as, pct, at: Date.now() });
}, 400);
$('#reader-scroll').addEventListener('scroll', saveProgress, { passive: true });
window.addEventListener('pagehide', () => saveProgress());

/* ---- 点句子 / 点单词 ---- */
$('#reader').addEventListener('click', (e) => {
  const nb = e.target.closest('[data-note]'); if (nb) { toggleParaNote(+nb.dataset.note, nb); return; }
  const sent = e.target.closest('.sent'); if (!sent) return;
  const p = +sent.closest('.para').dataset.p, s = +sent.dataset.s;
  if (sent.classList.contains('active')) {
    const w = wordAtPoint(e.clientX, e.clientY, sent);
    if (w) { openWord(w, p, s); return; }
  }
  activate(p, s);
});
function wordAtPoint(x, y, within) {
  let node, off;
  if (document.caretRangeFromPoint) { const r = document.caretRangeFromPoint(x, y); if (!r) return null; node = r.startContainer; off = r.startOffset; }
  else if (document.caretPositionFromPoint) { const r = document.caretPositionFromPoint(x, y); if (!r) return null; node = r.offsetNode; off = r.offset; }
  if (!node || node.nodeType !== 3 || !within.contains(node)) return null;
  const t = node.textContent; const isW = (c) => /[A-Za-zÀ-ɏ’'-]/.test(c);
  let a = off, b = off;
  while (a > 0 && isW(t[a - 1])) a--;
  while (b < t.length && isW(t[b])) b++;
  const w = t.slice(a, b).replace(/^[’'-]+|[’'-]+$/g, '').replace(/[’']s$/, '');
  return w.length >= 2 ? w : null;
}
function activate(p, s, { noScroll } = {}) {
  $$('.sent.active').forEach((e) => e.classList.remove('active'));
  const el = $(`.para[data-p="${p}"] .sent[data-s="${s}"]`); if (!el) return;
  el.classList.add('active'); R.active = { p, s };
  openPanel();
  renderSentencePanel(p, s);
  saveProgress();
  if (!noScroll && isMobile()) {
    const sc = $('#reader-scroll'); const r = el.getBoundingClientRect(); const top = sc.getBoundingClientRect().top;
    const visibleBottom = window.innerHeight * 0.36;
    if (r.bottom > visibleBottom || r.top < top) sc.scrollBy({ top: r.top - top - 16, behavior: 'smooth' });
  }
  if (hasAI() && S.prefetch > 0) prefetchFrom(p);
}
function prefetchFrom(p) {
  const paras = R.content.chapters[R.ch].paras; let n = 0;
  for (let i = p; i < paras.length && n <= S.prefetch; i++) {
    if (paras[i].h || paras[i].t.length < 25) continue;
    const ch = R.ch, pi = i, first = n === 0; n++;
    getParaAnalysis(ch, pi, first).then(() => { const d = $(`[data-ready="${pi}"]`); if (d && R.ch === ch) d.hidden = false; }).catch(() => {});
  }
}

/* ======================= 解析栏 ======================= */
function openPanel() {
  $('#panel').hidden = false;
  if (isMobile()) $('#reader-scroll').classList.add('panel-open');
}
function closePanel(force) {
  tts.stop();
  if (isMobile() || force) { $('#panel').hidden = true; $('#panel').classList.remove('tall'); $('#reader-scroll').classList.remove('panel-open'); }
  $$('.sent.active').forEach((e) => e.classList.remove('active')); R.active = null;
  if (!isMobile() && !force) showPanelEmpty();
}
function showPanelEmpty() {
  $('#panel').hidden = false;
  $('#panel-scroll').innerHTML = `<div class="p-empty"><b>先自己读。</b><br>点击任意一句，这里会出现这句的结构、翻译和重点词汇。<br>在已选中的句子里再点某个单词，可以打开词汇卡。<br><br>段尾有“朗读本段”和“${R.book?.type === 'thought' ? '这段在讲什么' : '文学分析'}”。<br>顶栏左边是全文搜索和目录，右边可以从当前句开始连续朗读。</div>`;
}
let panelToken = 0;
async function renderSentencePanel(p, s) {
  const tok = ++panelToken; const ch = R.ch;
  const sents = R.sents(ch, p); const text = sents[s]; const loc = R.loc(ch, p, s);
  const m = R.marks.get(loc) || {};
  const ps = $('#panel-scroll');
  ps.innerHTML = `
    <div class="p-sticky">
      <p class="p-orig">${esc(text)}</p>
      <div class="p-row">
        ${spkBtn(text, { id: `s:${ch}:${p}:${s}`, title: '朗读（再点停止）' })}
        ${spkBtn(text, { id: `slow:${ch}:${p}:${s}`, rate: S.slowRate, label: '<span style="font-size:11px;font-weight:600">慢</span>', title: '慢速朗读' })}
        <button class="chip-btn" id="rec-sent" title="跟读录音"><svg><use href="#i-mic"/></svg>跟读</button>
        <span class="grow"></span>
        <button class="chip-btn ${m.hl ? 'hl-on' : ''}" id="mk-hl" title="再点一次取消">${m.hl ? '取消高亮' : '高亮'}</button>
        <button class="chip-btn ${m.ul ? 'ul-on' : ''}" id="mk-ul" title="再点一次取消">${m.ul ? '取消划线' : '划线'}</button>
        <button class="icon-btn" id="p-close" aria-label="关闭" title="关闭"><svg><use href="#i-x"/></svg></button>
      </div>
      <div class="rec-res" id="rec-res-sent"></div>
    </div>
    <div id="p-body"><div class="loading">正在解析这一句…</div></div>`;
  $('#p-close').onclick = () => closePanel();
  $('#mk-hl').onclick = () => toggleMark(p, s, 'hl');
  $('#mk-ul').onclick = () => toggleMark(p, s, 'ul');
  $('#rec-sent').onclick = (e) => recordCompare(e.currentTarget, text, $('#rec-res-sent'));
  ps.scrollTop = 0;
  const body = $('#p-body');
  if (!hasAI()) { body.innerHTML = noAIHtml(); bindNoAI(); renderReviewChips(body, text, null); return; }
  let ana;
  try { ana = await getParaAnalysis(ch, p, true); }
  catch (err) {
    if (tok !== panelToken) return;
    body.innerHTML = `<div class="p-sec err">${esc(err.message)}<br><button class="btn small" id="retry">重试</button></div>`;
    $('#retry').onclick = () => renderSentencePanel(p, s); return;
  }
  if (tok !== panelToken) return;
  const a = ana.s[s] || { zh: '', v: [] };
  const vocab = (a.v || []).filter((v) => v && v.w);
  const revealed = S.autoReveal || R.revealed?.has(loc);
  body.innerHTML = `
    ${a.st ? structHtml(a.st) : (wordCount(text) > 12 ? `<div class="p-sec"><button class="chip-btn" id="ask-st">分析句子结构</button><div id="st-box"></div></div>` : '')}
    <div class="p-sec" id="zh-sec">
      <h3>翻译与重点词汇</h3>
      ${revealed ? zhVocabHtml(a, vocab, loc) : `<button class="reveal" id="reveal">先试着自己理解，再点这里显示翻译和重点词汇</button>`}
    </div>
    <div id="review-box"></div>
    <div id="ent-box"></div>`;
  if (!revealed) $('#reveal').onclick = () => { (R.revealed ||= new Set()).add(loc); $('#zh-sec').innerHTML = '<h3>翻译与重点词汇</h3>' + zhVocabHtml(a, vocab, loc); bindVocab(p, s, vocab); markSeen(vocab, loc, text); };
  else { bindVocab(p, s, vocab); markSeen(vocab, loc, text); }
  $('#ask-st')?.addEventListener('click', async (e) => {
    e.currentTarget.remove(); $('#st-box').innerHTML = '<div class="loading">分析中…</div>';
    try { const st = await getStructure(text, loc); if (tok === panelToken) $('#st-box').outerHTML = structHtml(st, true); }
    catch (err) { $('#st-box').innerHTML = `<p class="err">${esc(err.message)}</p>`; }
  });
  renderReviewChips($('#review-box'), text, vocab);
  renderEntities($('#ent-box'), a.e || [], ch, p, s);
}
function noAIHtml() {
  return `<div class="p-sec note-box"><b>还没有设置 AI。</b><br>朗读、跟读、高亮、划线现在就能用。要看翻译、句子结构和重点词汇，请先填一个免费的 AI Key。<br><br><button class="btn small primary" id="go-ai">设置 AI</button></div>`;
}
function bindNoAI() { $('#go-ai')?.addEventListener('click', openSettings); }
function structHtml(st, bare) {
  if (!st || !st.main) return '';
  const rows = [`<li><span class="k">主干</span><span class="x">${esc(st.main)}</span></li>`].concat((st.parts || []).map((x) => `<li><span class="k">${esc(x.t)}</span><span><span class="x">${esc(x.x)}</span><span class="n">${esc(x.n)}</span></span></li>`));
  return `<div class="p-sec">${bare ? '' : ''}<h3>句子结构</h3><ul class="struct">${rows.join('')}</ul></div>`;
}
function zhVocabHtml(a, vocab, loc) {
  const rows = vocab.map((v, i) => {
    const rec = findWord(v.l || v.w); const seen = rec ? (rec.seen || []).filter((x) => x !== loc).length : 0;
    const fam = rec?.fam || 0;
    const recall = seen >= 2 || fam >= 4; const hint = seen === 1 && !recall;
    return `<tr>
      <td><button class="vt-word" data-vi="${i}">${esc(v.w)}</button>${spkBtn(v.l || v.w, { title: '朗读单词' })}<div class="ipa">${esc(v.ipa || '')} ${esc(v.pos || '')}</div>
        ${recall ? '<span class="tag warn">试着回忆</span>' : hint ? '<span class="tag">第 2 次见</span>' : ''}</td>
      <td><div class="vt-en">${esc(v.en || '')} ${v.en ? spkBtn(v.en, { title: '朗读英文释义' }) : ''}</div><div class="vt-zh ${recall ? 'recall' : ''}">${esc(v.zh || '')}</div></td>
      <td><div class="vt-ctx ${recall ? 'recall' : ''}">${esc(v.ctx || '')}</div>
        <div class="vt-ops">${starHtml(rec?.fav, i)}${famHtml(fam, i)}</div></td>
    </tr>`;
  }).join('');
  return `<p class="p-zh">${esc(a.zh || '（没有拿到翻译，可以点“重试”）')}</p>
    ${vocab.length ? `<table class="vtable"><colgroup><col class="c-w"><col class="c-d"><col class="c-x"></colgroup>
      <thead><tr><th>单词</th><th>释义</th><th>本句中</th></tr></thead><tbody>${rows}</tbody></table>` : '<p class="hint" style="margin-top:8px">这句没有需要特别注意的生词。点句子里任意单词也可以查。</p>'}`;
}
const starHtml = (on, i) => `<button class="star ${on ? 'on' : ''}" data-star="${i}" title="收藏" aria-label="收藏"><svg><use href="#i-star"/></svg></button>`;
const FAM_LABEL = ['', '陌生', '模糊', '认识', '熟悉', '掌握'];
const famHtml = (f, i) => `<span class="fam" title="熟悉度：${FAM_LABEL[f] || '未评'}">${[1, 2, 3, 4, 5].map((n) => `<button class="${n <= f ? 'on' : ''}" data-fam="${i}" data-n="${n}" aria-label="熟悉度 ${n}：${FAM_LABEL[n]}" title="${FAM_LABEL[n]}"></button>`).join('')}</span>`;
function bindVocab(p, s, vocab) {
  const sec = $('#zh-sec'); if (!sec) return;
  sec.onclick = async (e) => {
    const r = e.target.closest('.recall'); if (r) { r.classList.add('open'); return; }
    const w = e.target.closest('[data-vi]'); if (w) { const v = vocab[+w.dataset.vi]; openWord(v.w, p, s, v); return; }
    const st = e.target.closest('[data-star]'); if (st) { const v = vocab[+st.dataset.star]; const rec = await upsertWord(v, R.loc(R.ch, p, s), R.sents(R.ch, p)[s]); rec.fav = !rec.fav; await saveWord(rec); st.classList.toggle('on', rec.fav); toast(rec.fav ? '已收藏到生词本' : '已取消收藏'); return; }
    const fm = e.target.closest('[data-fam]'); if (fm) { const v = vocab[+fm.dataset.fam]; const rec = await upsertWord(v, R.loc(R.ch, p, s), R.sents(R.ch, p)[s]); rec.fam = +fm.dataset.n; await saveWord(rec); $$('button', fm.parentElement).forEach((b) => b.classList.toggle('on', +b.dataset.n <= rec.fam)); fm.parentElement.title = '熟悉度：' + FAM_LABEL[rec.fam]; }
  };
}
/* 生词本：同一个词再出现时识别出来 */
async function upsertWord(v, loc, sentence) {
  const id = (v.l || v.w).toLowerCase();
  let rec = WORDS.get(id) || findWord(id);
  if (!rec) rec = { id, word: v.l || v.w, ipa: v.ipa || v.ipa_us || '', pos: v.pos || '', en: v.en || '', zh: v.zh || '', fav: false, fam: 0, seen: [], ctx: {}, ex: {}, added: Date.now() };
  for (const k of ['ipa', 'pos', 'en', 'zh']) if (!rec[k] && v[k]) rec[k] = v[k];
  if (!rec.ipa && v.ipa_us) rec.ipa = v.ipa_us;
  if (loc && !rec.seen.includes(loc)) { rec.seen.push(loc); rec.ctx[loc] = v.ctx || ''; rec.ex[loc] = sentence || ''; rec.books = [...new Set([...(rec.books || []), R.book?.id])]; }
  rec.last = Date.now(); WORDS.set(rec.id, rec);
  return rec;
}
async function saveWord(rec) { WORDS.set(rec.id, rec); await idb.put('words', rec); }
async function markSeen(vocab, loc, sentence) { for (const v of vocab) { const rec = await upsertWord(v, loc, sentence); await saveWord(rec); } }
function renderReviewChips(box, text, vocab) {
  if (!box) return;
  const picked = new Set((vocab || []).map((v) => (v.l || v.w).toLowerCase()));
  const hits = []; const seenIds = new Set();
  for (const tok of text.match(/[A-Za-z’']{3,}/g) || []) {
    const rec = findWord(tok); if (!rec || picked.has(rec.id) || seenIds.has(rec.id)) continue;
    seenIds.add(rec.id); hits.push({ tok, rec });
  }
  if (!hits.length) { box.innerHTML = ''; return; }
  box.innerHTML = `<div class="p-sec"><h3>学过的词 · 试着回忆</h3><div class="ent">${hits.map(({ tok, rec }) =>
    `<div class="ent-item"><b>${esc(tok)}</b> ${spkBtn(rec.word)} <span class="ipa">${esc(rec.ipa || '')}</span> · <span class="recall" title="点击显示">${esc(rec.zh || rec.en || '')}</span> <span class="tag">${FAM_LABEL[rec.fam] || '未评'}</span></div>`).join('')}</div></div>`;
  box.onclick = (e) => { const r = e.target.closest('.recall'); if (r) r.classList.add('open'); };
}
/* 书中记忆：人物和概念第一次出现的位置 */
function locLess(a, b) { return a.ch !== b.ch ? a.ch < b.ch : a.p !== b.p ? a.p < b.p : a.s < b.s; }
async function registerEntities(ch, p, ana) {
  if (!R.book) return;
  for (let s = 0; s < ana.s.length; s++) for (const e of ana.s[s]?.e || []) {
    if (!e?.n) continue;
    const id = `${R.book.id}|${e.n.toLowerCase()}`; const here = { ch, p, s };
    let g = R.gloss.get(id);
    if (!g) g = { id, name: e.n, kind: e.k || '', desc: e.d || '', first: here, count: 0 };
    else if (locLess(here, g.first)) g.first = here;
    if (!g.desc && e.d) g.desc = e.d; g.count = (g.count || 0) + 1;
    R.gloss.set(id, g); await idb.put('gloss', g);
  }
}
function renderEntities(box, ents, ch, p, s) {
  if (!box || !ents.length) return;
  const items = ents.filter((e) => e?.n).map((e) => {
    const g = R.gloss.get(`${R.book.id}|${e.n.toLowerCase()}`);
    const first = g?.first; const isFirst = !first || (first.ch === ch && first.p === p && first.s === s);
    const desc = g?.desc || e.d || '';
    return `<div class="ent-item"><b>${esc(e.n)}</b> <span class="tag">${esc(g?.kind || e.k || '')}</span> ${esc(desc)}
      ${isFirst ? '<div class="hint">第一次出现，已记入“书中记忆”。</div>' : `<div><a data-jump="${first.ch},${first.p},${first.s}">↩ 第一次出现：${esc(R.content.chapters[first.ch]?.title || '')}</a></div>`}</div>`;
  });
  box.innerHTML = `<div class="p-sec"><h3>人物与概念</h3><div class="ent">${items.join('')}</div></div>`;
  box.onclick = (e) => { const j = e.target.closest('[data-jump]'); if (j) { const [c, pp, ss] = j.dataset.jump.split(',').map(Number); goTo(c, pp, ss); } };
}
/* 高亮 / 划线：再点一次取消 */
async function toggleMark(p, s, kind) {
  const loc = R.loc(R.ch, p, s);
  const m = R.marks.get(loc) || { id: loc, ch: R.ch, p, s, text: R.sents(R.ch, p)[s], at: Date.now() };
  m[kind] = !m[kind];
  const el = $(`.para[data-p="${p}"] .sent[data-s="${s}"]`); el?.classList.toggle(kind, m[kind]);
  if (!m.hl && !m.ul && !m.note) { R.marks.delete(loc); await idb.del('marks', loc); }
  else { R.marks.set(loc, m); await idb.put('marks', m); }
  const btn = $(kind === 'hl' ? '#mk-hl' : '#mk-ul');
  if (btn) { btn.classList.toggle(kind + '-on', m[kind]); btn.textContent = (m[kind] ? '取消' : '') + (kind === 'hl' ? '高亮' : '划线'); }
  toast(m[kind] ? (kind === 'hl' ? '已高亮，已存入书中记忆' : '已划线，已存入书中记忆') : '已取消');
}
/* 段尾：文学分析 / 这段在讲什么 */
async function toggleParaNote(p, btn) {
  const para = $(`.para[data-p="${p}"]`); const ex = $('.para-note', para);
  if (ex) { ex.remove(); return; }
  const box = document.createElement('div'); box.className = 'para-note'; box.innerHTML = '<div class="loading">AI 正在解读这一段…</div>';
  para.appendChild(box);
  if (!hasAI()) { box.innerHTML = noAIHtml(); bindNoAI(); return; }
  try {
    const v = await getParaNote(R.ch, p);
    box.innerHTML = `<h4>${R.book.type === 'thought' ? '这段在讲什么' : '文学分析'}</h4><div class="md"><p><b>${esc(v.title || '')}</b></p><ul>${(v.points || []).map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>`;
  } catch (err) { box.innerHTML = `<p class="err">${esc(err.message)}</p>`; }
}

/* ======================= 词汇卡 ======================= */
async function openWord(word, p, s, fromTable) {
  const ch = R.ch; const sentence = R.sents(ch, p)[s]; const loc = R.loc(ch, p, s);
  openPanel();
  const ps = $('#panel-scroll'); const tok = ++panelToken;
  let base = fromTable;
  if (!base) { const ana = memAna.get(anaKey(ch, p)); const lw = word.toLowerCase(); base = (ana?.s[s]?.v || []).find((v) => v.w?.toLowerCase().includes(lw) || (v.l || '').toLowerCase() === lw) || null; }
  const rec = findWord(base?.l || word);
  const render = (d) => {
    const w = d.w || base?.l || word;
    const recNow = findWord(w) || rec;
    const hit = sentence.replace(new RegExp(`\\b(${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})\\b`, 'i'), '\u0001$1\u0002');
    const hitHtml = esc(hit).replace('\u0001', '<span class="w-hit">').replace('\u0002', '</span>');
    ps.innerHTML = `
      <div class="p-sticky">
        <div class="p-row" style="margin-top:0"><button class="chip-btn" id="wc-back">← 回到句子</button><span class="grow"></span><button class="icon-btn" id="p-close" aria-label="关闭"><svg><use href="#i-x"/></svg></button></div>
        <div class="wc-head" style="margin-top:8px"><span class="wc-word">${esc(w)}</span><span class="ipa">${esc(d.pos || '')}</span>
          ${recNow ? `<span class="tag">${recNow.seen?.length > 1 ? `第 ${recNow.seen.length} 次见` : '新词'}</span>` : '<span class="tag">新词</span>'}</div>
      </div>
      <div class="wcard" style="padding-top:12px">
        <div class="wc-pron">
          ${spkBtn(w, { id: 'w-us:' + w, accent: 'en-US', label: '<span style="font-size:11px">美</span>', title: '美音' })}<span class="ipa">${esc(d.ipa_us || d.ipa || '')}</span>
          ${spkBtn(w, { id: 'w-uk:' + w, accent: 'en-GB', label: '<span style="font-size:11px">英</span>', title: '英音' })}<span class="ipa">${esc(d.ipa_uk || '')}</span>
          ${spkBtn(w, { id: 'w-slow:' + w, rate: S.slowRate, label: '<span style="font-size:11px">慢</span>', title: '慢速' })}
          <button class="chip-btn" id="rec-word"><svg><use href="#i-mic"/></svg>跟读</button>
        </div>
        <div class="rec-res" id="rec-res-word"></div>
        <div class="wc-row"><span class="lab">英文释义</span><span>${esc(d.en || '…')} ${d.en ? spkBtn(d.en) : ''}</span></div>
        <div class="wc-row"><span class="lab">中文</span><span>${esc(d.zh || '…')}</span></div>
        <div class="wc-row"><span class="lab">本句中</span><span>${esc(d.ctx || '…')}</span></div>
        <div class="wc-row"><span class="lab">原文例句</span><span class="wc-ex">${hitHtml} ${spkBtn(sentence)}</span></div>
        <div class="wc-row"><span class="lab">新例句</span><span class="wc-ex">${d.ex ? esc(d.ex) + ' ' + spkBtn(d.ex) + `<span class="zh">${esc(d.ex_zh || '')}</span>` : '<span class="loading">生成中…</span>'}</span></div>
        ${d.cmp ? `<div class="wc-row"><span class="lab">概念对比</span><span>${esc(d.cmp)}</span></div>` : ''}
        ${d.img ? `<div class="wc-row"><span class="lab">看图记忆</span><span><a href="https://cn.bing.com/images/search?q=${encodeURIComponent(w)}" target="_blank" rel="noopener">在必应图片里看看 “${esc(w)}” →</a></span></div>` : ''}
        ${(recNow?.seen?.length > 1) ? `<div class="wc-row"><span class="lab">之前见过</span><span class="hint">${recNow.seen.filter((x) => x !== loc).slice(-3).map((x) => esc((recNow.ex?.[x] || '').slice(0, 90))).join('<br>')}</span></div>` : ''}
        <div class="wc-row"><span class="lab">我的标记</span><span class="vt-ops" id="wc-ops">${starHtml(recNow?.fav, 0)} 熟悉度 ${famHtml(recNow?.fam || 0, 0)}</span></div>
        <div id="wc-err"></div>
      </div>`;
    $('#wc-back').onclick = () => { if (R.active) renderSentencePanel(R.active.p, R.active.s); };
    $('#p-close').onclick = () => closePanel();
    $('#rec-word').onclick = (e) => recordCompare(e.currentTarget, w, $('#rec-res-word'));
    $('#wc-ops').onclick = async (e) => {
      const r = await upsertWord({ ...d, w, l: w, ipa: d.ipa_us || d.ipa }, loc, sentence);
      if (e.target.closest('[data-star]')) { r.fav = !r.fav; e.target.closest('[data-star]').classList.toggle('on', r.fav); toast(r.fav ? '已收藏' : '已取消收藏'); }
      const fm = e.target.closest('[data-fam]'); if (fm) { r.fam = +fm.dataset.n; $$('[data-fam]', $('#wc-ops')).forEach((b) => b.classList.toggle('on', +b.dataset.n <= r.fam)); }
      await saveWord(r);
    };
  };
  render({ pos: base?.pos || rec?.pos, en: base?.en || rec?.en, zh: base?.zh || rec?.zh, w: base?.l || rec?.word, ipa_us: base?.ipa || rec?.ipa, ctx: base?.ctx || '' });
  ps.scrollTop = 0;
  if (!hasAI()) { $('#wc-err').innerHTML = noAIHtml(); bindNoAI(); return; }
  try {
    const d = await getWordDetail(base?.l || word, sentence, loc);
    if (tok !== panelToken) return;
    const merged = { ...d, ctx: base?.ctx || d.ctx, zh: d.zh || base?.zh, en: d.en || base?.en };
    render(merged);
    const r = await upsertWord({ ...merged, w: merged.w || word, l: merged.w || word, ipa: merged.ipa_us }, loc, sentence); await saveWord(r);
  } catch (err) { if (tok === panelToken) $('#wc-err').innerHTML = `<p class="err">${esc(err.message)}</p>`; }
}

/* ======================= 跟读：录音回放 + 语音识别对比（免费） ======================= */
let recState = null;
async function recordCompare(btn, target, out) {
  if (recState) { recState.stop(); return; }
  if (!navigator.mediaDevices?.getUserMedia) { out.textContent = '这个浏览器不支持录音。'; return; }
  let stream; try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch { out.textContent = '没有麦克风权限。'; return; }
  const chunks = []; const mr = new MediaRecorder(stream); let heard = '';
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition; let sr = null;
  if (SR) { try { sr = new SR(); sr.lang = S.accent; sr.interimResults = false; sr.maxAlternatives = 1; sr.onresult = (e) => { heard = [...e.results].map((r) => r[0].transcript).join(' '); }; sr.start(); } catch { sr = null; } }
  mr.ondataavailable = (e) => chunks.push(e.data);
  mr.onstop = () => {
    stream.getTracks().forEach((t) => t.stop());
    const url = URL.createObjectURL(new Blob(chunks, { type: mr.mimeType }));
    setTimeout(() => {
      let html = `<audio controls src="${url}" style="width:100%;height:34px;margin-top:6px"></audio>`;
      if (heard) {
        const norm = (x) => x.toLowerCase().match(/[a-z']+/g) || [];
        const want = norm(target), got = new Set(norm(heard));
        const miss = want.filter((w) => !got.has(w)); const score = want.length ? Math.round(100 * (want.length - miss.length) / want.length) : 0;
        html += `<div>识别结果：“${esc(heard)}” · 吻合 ${score}%${miss.length ? `；可能没读清：<b>${esc([...new Set(miss)].slice(0, 8).join(', '))}</b>` : '，很好！'}</div>`;
      } else if (sr) html += '<div>没识别到语音，可以对比回放和原音。</div>';
      else html += '<div>这个浏览器不支持语音识别，可以回放自己的录音和原音对比。</div>';
      out.innerHTML = html;
    }, 400);
    btn.classList.remove('on'); btn.innerHTML = '<svg><use href="#i-mic"/></svg>跟读'; recState = null;
  };
  mr.start(); btn.classList.add('on'); btn.innerHTML = '<svg><use href="#i-stop"/></svg>停止'; out.textContent = '正在录音，读完再点一次“停止”。';
  recState = { stop: () => { try { sr?.stop(); } catch {} mr.state !== 'inactive' && mr.stop(); } };
}

/* ======================= 连续朗读 ======================= */
$('#btn-readall').onclick = () => {
  if (tts.id === 'readall') { tts.stop(); return; }
  const paras = R.content.chapters[R.ch].paras; const list = [];
  let startP = R.active?.p ?? firstVisiblePara(), startS = R.active?.s ?? 0;
  for (let p = startP; p < paras.length; p++) { if (paras[p].h) continue; R.sents(R.ch, p).forEach((t, s) => { if (p > startP || s >= startS) list.push({ p, s, t }); }); }
  if (!list.length) return;
  $('#btn-readall').classList.add('on');
  tts.toggle('readall', list.map((x) => x.t), {
    onItem: (i) => {
      $$('.sent.reading').forEach((e) => e.classList.remove('reading'));
      const el = $(`.para[data-p="${list[i].p}"] .sent[data-s="${list[i].s}"]`);
      if (el) { el.classList.add('reading'); const sc = $('#reader-scroll'); const r = el.getBoundingClientRect(); const top = sc.getBoundingClientRect().top; const lim = isMobile() && !$('#panel').hidden ? window.innerHeight * 0.36 : window.innerHeight - 80; if (r.bottom > lim || r.top < top) sc.scrollBy({ top: r.top - top - 60, behavior: 'smooth' }); }
    },
    onEnd: () => { $('#btn-readall').classList.remove('on'); $$('.sent.reading').forEach((e) => e.classList.remove('reading')); },
  });
};
function firstVisiblePara() { const top = $('#reader-scroll').getBoundingClientRect().top; for (const el of $$('.para', $('#reader'))) if (el.getBoundingClientRect().bottom > top + 20) return +el.dataset.p; return 0; }

/* ======================= 弹层：目录、搜索、书中记忆、生词本、设置 ======================= */
function openSheet(title, html) { $('#sheet-title').textContent = title; $('#sheet-body').innerHTML = html; $('#sheet').hidden = false; $('#sheet-backdrop').hidden = false; $('#sheet-body').scrollTop = 0; }
function closeSheet() { $('#sheet').hidden = true; $('#sheet-backdrop').hidden = true; }
window.closeSheet = closeSheet;
$('#sheet-close').onclick = closeSheet; $('#sheet-backdrop').onclick = closeSheet;
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { if (!$('#sheet').hidden) closeSheet(); else if (R.active) closePanel(); }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f' && R.book && !$('#view-reader').hidden) { e.preventDefault(); openSearch(); }
});

$('#btn-toc').onclick = () => {
  openSheet('目录', `<ul class="list">${R.content.chapters.map((c, i) => `<li class="clk toc-item ${i === R.ch ? 'cur' : ''}" data-ch="${i}"><span>${esc(c.title)}</span><small>${c.paras.length} 段</small></li>`).join('')}</ul>`);
  $('#sheet-body').onclick = (e) => { const li = e.target.closest('[data-ch]'); if (li) { closeSheet(); renderChapter(+li.dataset.ch); } };
  const cur = $('.list .cur'); if (cur) $('#sheet-body').scrollTop = cur.offsetTop - 120;
};

/* 全文搜索（顶栏固定，任何位置都能点） */
$('#btn-search').onclick = () => openSearch();
let lastQuery = '';
function openSearch() {
  openSheet('全文搜索', `<label class="field"><input id="q" type="search" placeholder="搜索整本书：单词、短语、人名…" value="${esc(lastQuery)}" autocomplete="off"></label><div id="sr"></div>`);
  const q = $('#q'); setTimeout(() => q.focus(), 50);
  const run = debounce(() => doSearch(q.value.trim()), 220); q.oninput = run; if (lastQuery) doSearch(lastQuery);
  $('#sr').onclick = (e) => { const it = e.target.closest('[data-go]'); if (it) { const [c, p, s] = it.dataset.go.split(',').map(Number); goTo(c, p, s); } };
}
function doSearch(q) {
  lastQuery = q; const box = $('#sr'); if (!box) return;
  if (q.length < 2) { box.innerHTML = '<p class="hint">输入至少 2 个字符。</p>'; return; }
  const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'); const res = []; let total = 0;
  R.content.chapters.forEach((c, ci) => c.paras.forEach((para, pi) => {
    re.lastIndex = 0; if (!re.test(para.t)) return;
    const sents = R.sents(ci, pi);
    sents.forEach((t, si) => { re.lastIndex = 0; if (re.test(t)) { total++; if (res.length < 300) res.push({ ci, pi, si, t }); } });
  }));
  const gl = [...R.gloss.values()].filter((g) => g.name.toLowerCase().includes(q.toLowerCase()));
  const hl = (t) => { const i = t.toLowerCase().indexOf(q.toLowerCase()); const a = Math.max(0, i - 60); const snip = (a ? '…' : '') + t.slice(a, i + q.length + 90) + (t.length > i + q.length + 90 ? '…' : ''); return esc(snip).replace(new RegExp(esc(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), (m) => `<mark>${m}</mark>`); };
  box.innerHTML = (gl.length ? `<div class="note-box">${gl.map((g) => `<div class="sr-item" data-go="${g.first.ch},${g.first.p},${g.first.s}"><b>${esc(g.name)}</b> ${esc(g.desc || '')} <a>第一次出现 →</a></div>`).join('')}</div>` : '') +
    `<p class="hint">找到 ${total} 处${total > 300 ? '（显示前 300 处）' : ''}</p><ul class="list">${res.map((r) => `<li class="sr-item" data-go="${r.ci},${r.pi},${r.si}"><div class="sr-ch">${esc(R.content.chapters[r.ci].title)}</div><div class="sr-snip">${hl(r.t)}</div></li>`).join('')}</ul>`;
}

/* 书中记忆：人物概念 / 划线高亮（导出、AI 整理）/ 本书生词 */
$('#btn-memory').onclick = () => openMemory('gloss');
function openMemory(tab) {
  openSheet('书中记忆', `<div class="tabs"><button class="chip-btn" data-tab="gloss">人物与概念</button><button class="chip-btn" data-tab="marks">划线与高亮</button><button class="chip-btn" data-tab="words">本书生词</button></div><div id="mem-body"></div>`);
  $$('[data-tab]').forEach((b) => (b.onclick = () => openMemory(b.dataset.tab)));
  $(`[data-tab="${tab}"]`).classList.add('on');
  const body = $('#mem-body');
  if (tab === 'gloss') {
    const gs = [...R.gloss.values()].sort((a, b) => (locLess(a.first, b.first) ? -1 : 1));
    body.innerHTML = gs.length ? `<ul class="list">${gs.map((g) => `<li><b style="font-family:var(--serif)">${esc(g.name)}</b> <span class="tag">${esc(g.kind || '')}</span> ${esc(g.desc || '')}<br><a class="clk" data-go="${g.first.ch},${g.first.p},${g.first.s}">第一次出现：${esc(R.content.chapters[g.first.ch]?.title || '')} →</a></li>`).join('')}</ul>`
      : '<p class="hint">还没有记录。逐句解析时，AI 会自动记下书中的人物、地点和世界观概念，以及它们第一次出现的位置。</p>';
  } else if (tab === 'marks') {
    const ms = [...R.marks.values()].sort((a, b) => (locLess(a, b) ? -1 : 1));
    body.innerHTML = ms.length ? `<div class="row"><button class="btn small" id="mk-export">导出 Markdown</button><button class="btn small" id="mk-copy">复制全部</button><button class="btn small primary" id="mk-ai">AI 整理与解析划线</button></div><div id="mk-ai-out"></div>
      <ul class="list">${ms.map((m) => `<li><span class="tag ${m.ul ? 'warn' : ''}">${m.hl && m.ul ? '高亮+划线' : m.hl ? '高亮' : '划线'}</span> <span class="sr-ch">${esc(R.content.chapters[m.ch]?.title || '')}</span><div class="clk sr-snip" data-go="${m.ch},${m.p},${m.s}">${esc(m.text)}</div><button class="btn small ghost" data-unmark="${esc(m.id)}">删除</button></li>`).join('')}</ul>`
      : '<p class="hint">还没有划线或高亮。点一句话，在解析栏顶部点“高亮”或“划线”；再点一次即可取消。</p>';
    $('#mk-export')?.addEventListener('click', () => download(`${R.book.title}-划线.md`, marksMarkdown(ms), 'text/markdown'));
    $('#mk-copy')?.addEventListener('click', () => copyText(marksMarkdown(ms)));
    $('#mk-ai')?.addEventListener('click', () => aiOrganizeMarks(ms));
  } else {
    const ws = [...WORDS.values()].filter((w) => (w.books || []).includes(R.book.id)).sort((a, b) => b.last - a.last);
    body.innerHTML = wordListHtml(ws, '这本书里还没有查过的词。');
  }
  body.onclick = async (e) => {
    const g = e.target.closest('[data-go]'); if (g) { const [c, p, s] = g.dataset.go.split(',').map(Number); goTo(c, p, s); return; }
    const um = e.target.closest('[data-unmark]'); if (um) { const m = R.marks.get(um.dataset.unmark); if (m) { m.hl = m.ul = false; R.marks.delete(m.id); await idb.del('marks', m.id); if (m.ch === R.ch) $(`.para[data-p="${m.p}"] .sent[data-s="${m.s}"]`)?.classList.remove('hl', 'ul'); } openMemory('marks'); return; }
    wordListClick(e);
  };
}
function marksMarkdown(ms) {
  let out = `# ${R.book.title} — 划线与高亮\n\n`; let lastCh = -1;
  for (const m of ms) { if (m.ch !== lastCh) { out += `\n## ${R.content.chapters[m.ch]?.title || ''}\n\n`; lastCh = m.ch; } out += `> ${m.text}\n\n`; }
  const out2 = R.aiMarks ? `\n---\n\n# AI 整理\n\n${R.aiMarks}\n` : '';
  return out + out2;
}
async function aiOrganizeMarks(ms) {
  const box = $('#mk-ai-out'); box.innerHTML = '<div class="loading">AI 正在整理你的划线…</div>';
  if (!hasAI()) { box.innerHTML = noAIHtml(); bindNoAI(); return; }
  const list = ms.slice(0, 120).map((m) => `[${R.content.chapters[m.ch]?.title || ''}] ${m.text}`).join('\n');
  try {
    const md = await aiChat('marks', [{ role: 'system', content: '你是一位文学与人文社科的读书笔记导师，用中文写作，简洁有条理。' }, { role: 'user', content: `这是我读《${R.book.title}》（${typeLabel(R.book)}）时划的句子：\n${list}\n\n请帮我整理成读书笔记：按主题归类（每类一个小标题），每类下说明这些句子共同揭示了什么、为什么重要；最后用 3–5 句话总结我关注的重点。使用 Markdown，标题用 ##，要点用 -。` }], { json: false, maxTokens: 2500 });
    R.aiMarks = md;
    box.innerHTML = `<div class="note-box md">${mdToHtml(md)}</div><div class="row"><button class="btn small" id="ai-copy">复制整理结果</button></div>`;
    $('#ai-copy').onclick = () => copyText(md);
  } catch (err) { box.innerHTML = `<p class="err">${esc(err.message)}</p>`; }
}

/* 生词本（全局） */
function wordListHtml(ws, empty) {
  if (!ws.length) return `<p class="hint">${empty}</p>`;
  return `<ul class="list">${ws.map((w) => `<li data-wid="${esc(w.id)}"><div class="row" style="gap:6px"><b style="font-family:var(--serif);font-size:16px">${esc(w.word)}</b>${spkBtn(w.word)}<span class="ipa">${esc(w.ipa || '')}</span><span class="grow" style="flex:1"></span>${starHtml(w.fav, 0)}${famHtml(w.fam || 0, 0)}</div>
    <div>${esc(w.zh || '')} <span class="hint">${esc(w.en || '')}</span></div>${w.seen?.length ? `<div class="hint">见过 ${w.seen.length} 次 · ${esc(Object.values(w.ex || {}).slice(-1)[0]?.slice(0, 100) || '')}</div>` : ''}</li>`).join('')}</ul>`;
}
async function wordListClick(e) {
  const li = e.target.closest('[data-wid]'); if (!li) return; const rec = WORDS.get(li.dataset.wid); if (!rec) return;
  if (e.target.closest('[data-star]')) { rec.fav = !rec.fav; e.target.closest('[data-star]').classList.toggle('on', rec.fav); await saveWord(rec); }
  const fm = e.target.closest('[data-fam]'); if (fm) { rec.fam = +fm.dataset.n; $$('[data-fam]', li).forEach((b) => b.classList.toggle('on', +b.dataset.n <= rec.fam)); await saveWord(rec); }
}
$('#btn-vocab').onclick = () => openVocab('all');
function openVocab(filter) {
  const all = [...WORDS.values()].sort((a, b) => b.last - a.last);
  const ws = filter === 'fav' ? all.filter((w) => w.fav) : filter === 'review' ? all.filter((w) => (w.fam || 0) <= 2) : all;
  openSheet('生词本', `<div class="tabs"><button class="chip-btn" data-f="all">全部 ${all.length}</button><button class="chip-btn" data-f="fav">收藏</button><button class="chip-btn" data-f="review">需复习</button><span style="flex:1"></span><button class="btn small" id="v-flash">卡片复习</button><button class="btn small" id="v-csv">导出 CSV</button></div><div id="v-body">${wordListHtml(ws, '还没有生词。阅读时点开词汇卡或显示重点词汇，单词会自动记到这里。')}</div>`);
  $(`[data-f="${filter}"]`).classList.add('on');
  $$('[data-f]').forEach((b) => (b.onclick = () => openVocab(b.dataset.f)));
  $('#v-body').onclick = wordListClick;
  $('#v-csv').onclick = () => download('DeepReader-生词本.csv', '﻿单词,音标,词性,英文释义,中文,熟悉度,收藏,例句\n' + all.map((w) => [w.word, w.ipa, w.pos, w.en, w.zh, w.fam || 0, w.fav ? '是' : '', Object.values(w.ex || {})[0] || ''].map((x) => `"${String(x ?? '').replace(/"/g, '""')}"`).join(',')).join('\n'), 'text/csv');
  $('#v-flash').onclick = () => flashcards(ws.length ? ws : all);
}
function flashcards(list) {
  const deck = [...list].sort((a, b) => (a.fam || 0) - (b.fam || 0)).slice(0, 30); let i = 0;
  if (!deck.length) { toast('生词本是空的'); return; }
  const show = () => {
    if (i >= deck.length) { $('#sheet-body').innerHTML = '<p>这一轮复习完了。</p><button class="btn" onclick="closeSheet()">关闭</button>'; return; }
    const w = deck[i]; const ex = Object.values(w.ex || {})[0] || '';
    $('#sheet-title').textContent = `卡片复习 ${i + 1} / ${deck.length}`;
    $('#sheet-body').innerHTML = `<div class="wcard"><div class="wc-head"><span class="wc-word">${esc(w.word)}</span>${spkBtn(w.word)}<span class="ipa">${esc(w.ipa || '')}</span></div>
      ${ex ? `<p class="wc-ex">${esc(ex)}</p>` : ''}
      <div id="fc-ans" hidden><div class="wc-row"><span class="lab">英文释义</span><span>${esc(w.en || '')}</span></div><div class="wc-row"><span class="lab">中文</span><span>${esc(w.zh || '')}</span></div></div>
      <button class="btn primary" id="fc-show">想好了，看答案</button>
      <div id="fc-rate" hidden><p class="hint">你对它有多熟？</p><div class="row">${[1, 2, 3, 4, 5].map((n) => `<button class="btn small" data-r="${n}">${FAM_LABEL[n]}</button>`).join('')}</div></div></div>`;
    $('#fc-show').onclick = () => { $('#fc-ans').hidden = false; $('#fc-rate').hidden = false; $('#fc-show').hidden = true; };
    $('#fc-rate').onclick = async (e) => { const b = e.target.closest('[data-r]'); if (!b) return; w.fam = +b.dataset.r; w.last = Date.now(); await saveWord(w); i++; show(); };
  };
  show();
}

/* 设置 */
$('#btn-settings').onclick = openSettings; $('#btn-settings2').onclick = openSettings; $('#btn-banner-ai').onclick = openSettings;
function openSettings() {
  const c = aiCfg(); const p = PROVIDERS[S.provider];
  const voices = tts.voices();
  const vopts = (lang, cur) => `<option value="">自动选择</option>` + voices.filter((v) => v.lang.replace('_', '-').startsWith(lang)).map((v) => `<option ${v.name === cur ? 'selected' : ''}>${esc(v.name)}</option>`).join('');
  openSheet('设置', `
    <h3 style="margin:0;font-size:13px;color:var(--muted);letter-spacing:.06em">AI 服务（解析用，Key 只保存在你自己的浏览器里）</h3>
    <label class="field"><span>服务商</span><select id="s-prov">${Object.entries(PROVIDERS).map(([k, v]) => `<option value="${k}" ${k === S.provider ? 'selected' : ''}>${esc(v.name)}</option>`).join('')}</select>
      <small id="s-note">${esc(p.note)}${p.keyUrl ? ` <a href="${p.keyUrl}" target="_blank" rel="noopener">去申请 Key →</a>` : ''}</small></label>
    <label class="field"><span>API Key</span><input id="s-key" type="password" autocomplete="off" value="${esc(c.key)}" placeholder="粘贴你的 API Key"></label>
    <div class="row"><label class="field"><span>模型</span><input id="s-model" value="${esc(c.model)}"></label><label class="field"><span>接口地址</span><input id="s-base" value="${esc(c.base)}"></label></div>
    <div class="row"><button class="btn primary" id="s-test">保存并测试连接</button><span id="s-test-res" class="hint"></span></div>
    <hr style="border:0;border-top:1px solid var(--line);width:100%">
    <h3 style="margin:0;font-size:13px;color:var(--muted);letter-spacing:.06em">阅读</h3>
    <label class="field"><span>字号：<b id="s-fs-v">${S.fontSize}</b> px</span><input id="s-fs" type="range" min="15" max="26" value="${S.fontSize}"></label>
    <div class="field"><span>外观</span><div class="seg" id="s-theme">${[['auto', '跟随系统'], ['light', '浅色'], ['dark', '深色']].map(([v, l]) => `<button data-v="${v}" class="${S.theme === v ? 'on' : ''}">${l}</button>`).join('')}</div></div>
    <label class="check"><input type="checkbox" id="s-reveal" ${S.autoReveal ? 'checked' : ''}> 点句子后直接显示翻译（默认先自己理解）</label>
    <label class="check"><input type="checkbox" id="s-sspk" ${S.sentSpk === 'always' ? 'checked' : ''}> 每句句尾显示朗读键</label>
    <label class="field"><span>提前解析后面几段（点击后秒开；越多越耗免费额度）</span><select id="s-pre">${[0, 1, 2, 3, 4].map((n) => `<option value="${n}" ${+S.prefetch === n ? 'selected' : ''}>${n === 0 ? '不提前' : '当前段 + 后面 ' + n + ' 段'}</option>`).join('')}</select></label>
    <hr style="border:0;border-top:1px solid var(--line);width:100%">
    <h3 style="margin:0;font-size:13px;color:var(--muted);letter-spacing:.06em">发音</h3>
    <div class="field"><span>默认口音</span><div class="seg" id="s-acc"><button data-v="en-US" class="${S.accent === 'en-US' ? 'on' : ''}">美音</button><button data-v="en-GB" class="${S.accent === 'en-GB' ? 'on' : ''}">英音</button></div></div>
    <div class="row"><label class="field"><span>美音声音</span><select id="s-vus">${vopts('en-US', S.voiceUS)}</select></label><label class="field"><span>英音声音</span><select id="s-vgb">${vopts('en-GB', S.voiceGB)}</select></label></div>
    <div class="row"><label class="field"><span>正常语速 <b id="s-rate-v">${S.rate}</b></span><input id="s-rate" type="range" min="0.6" max="1.3" step="0.05" value="${S.rate}"></label><label class="field"><span>慢速跟读 <b id="s-slow-v">${S.slowRate}</b></span><input id="s-slow" type="range" min="0.4" max="0.9" step="0.05" value="${S.slowRate}"></label></div>
    <small class="hint">${voices.length ? `本机有 ${voices.length} 个英语声音。` : '没检测到英语声音：请在手机系统设置里下载英语语音。'}iPhone 可在“设置 → 辅助功能 → 朗读内容 → 声音”下载更自然的声音。</small>
    <hr style="border:0;border-top:1px solid var(--line);width:100%">
    <h3 style="margin:0;font-size:13px;color:var(--muted);letter-spacing:.06em">数据（都在这台设备上）</h3>
    <div class="row"><button class="btn small" id="s-backup">备份生词、划线、进度</button><label class="btn small">恢复备份<input type="file" id="s-restore" accept=".json" hidden></label><button class="btn small" id="s-clear">清除 AI 解析缓存</button></div>
    <small class="hint" id="s-usage"></small>`);
  const prov = $('#s-prov');
  prov.onchange = () => {
    const k = prov.value; const pp = PROVIDERS[k];
    $('#s-note').innerHTML = esc(pp.note) + (pp.keyUrl ? ` <a href="${pp.keyUrl}" target="_blank" rel="noopener">去申请 Key →</a>` : '');
    $('#s-key').value = S.keys[k] || ''; $('#s-model').value = S.models[k] || pp.model; $('#s-base').value = S.bases[k] || pp.base;
  };
  const saveAI = () => {
    const k = prov.value; S.provider = k; S.keys[k] = $('#s-key').value.trim();
    const m = $('#s-model').value.trim(), b = $('#s-base').value.trim();
    if (m && m !== PROVIDERS[k].model) S.models[k] = m; else delete S.models[k];
    if (b && b !== PROVIDERS[k].base) S.bases[k] = b; else delete S.bases[k];
    saveSettings();
  };
  ['#s-key', '#s-model', '#s-base'].forEach((s) => ($(s).onchange = saveAI)); prov.addEventListener('change', saveAI);
  $('#s-test').onclick = async () => {
    saveAI(); const r = $('#s-test-res'); r.textContent = '测试中…';
    try { const v = await aiChat('test', [{ role: 'user', content: '只返回 JSON：{"ok":true}' }], { maxTokens: 30 }); r.textContent = v?.ok ? '✓ 连接成功，可以开始用了' : '✓ 已连接'; r.style.color = 'var(--ok)'; }
    catch (e) { r.textContent = e.message; r.style.color = 'var(--ul)'; }
  };
  $('#s-fs').oninput = (e) => { S.fontSize = +e.target.value; $('#s-fs-v').textContent = S.fontSize; saveSettings(); };
  $('#s-theme').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; S.theme = b.dataset.v; $$('#s-theme button').forEach((x) => x.classList.toggle('on', x === b)); saveSettings(); };
  $('#s-acc').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; S.accent = b.dataset.v; $$('#s-acc button').forEach((x) => x.classList.toggle('on', x === b)); saveSettings(); };
  $('#s-reveal').onchange = (e) => { S.autoReveal = e.target.checked; saveSettings(); };
  $('#s-sspk').onchange = (e) => { S.sentSpk = e.target.checked ? 'always' : 'active'; saveSettings(); };
  $('#s-pre').onchange = (e) => { S.prefetch = +e.target.value; saveSettings(); };
  $('#s-vus').onchange = (e) => { S.voiceUS = e.target.value; saveSettings(); };
  $('#s-vgb').onchange = (e) => { S.voiceGB = e.target.value; saveSettings(); };
  $('#s-rate').oninput = (e) => { S.rate = +e.target.value; $('#s-rate-v').textContent = S.rate; saveSettings(); };
  $('#s-slow').oninput = (e) => { S.slowRate = +e.target.value; $('#s-slow-v').textContent = S.slowRate; saveSettings(); };
  $('#s-backup').onclick = async () => {
    const data = { app: 'DeepReader', v: 1, at: new Date().toISOString(), words: await idb.all('words'), marks: await idb.all('marks'), gloss: await idb.all('gloss'), progress: await idb.all('progress') };
    download(`DeepReader-备份-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data), 'application/json');
  };
  $('#s-restore').onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try { const d = JSON.parse(await f.text()); for (const s of ['words', 'marks', 'gloss', 'progress']) for (const r of d[s] || []) await idb.put(s, r); await loadWords(); toast('已恢复备份'); } catch { toast('备份文件无法读取'); }
  };
  $('#s-clear').onclick = async () => { await tx('cache', 'readwrite', (st) => st.clear()); memAna.clear(); toast('已清除解析缓存'); };
  navigator.storage?.estimate?.().then((est) => { const el = $('#s-usage'); if (el) el.textContent = `已用存储约 ${(est.usage / 1048576).toFixed(1)} MB。书籍只存在这台设备的浏览器里，换手机或清除浏览器数据前请先备份。`; });
}

/* ======================= 手机端：解析抽屉拖拽 ======================= */
(() => {
  const grip = $('#panel-grip'); let y0 = null;
  grip.addEventListener('pointerdown', (e) => { y0 = e.clientY; grip.setPointerCapture(e.pointerId); });
  grip.addEventListener('pointerup', (e) => {
    if (y0 == null) return; const dy = e.clientY - y0; y0 = null; const panel = $('#panel');
    if (Math.abs(dy) < 6) panel.classList.toggle('tall');
    else if (dy < -30) panel.classList.add('tall');
    else if (dy > 30) { if (panel.classList.contains('tall')) panel.classList.remove('tall'); else closePanel(); }
  });
})();

/* ======================= 启动 ======================= */
const SAMPLE = `Chapter 1

It is a truth universally acknowledged, that a single man in possession of a good fortune, must be in want of a wife.

However little known the feelings or views of such a man may be on his first entering a neighbourhood, this truth is so well fixed in the minds of the surrounding families, that he is considered the rightful property of some one or other of their daughters.

"My dear Mr. Bennet," said his lady to him one day, "have you heard that Netherfield Park is let at last?"

Mr. Bennet replied that he had not.

"But it is," returned she; "for Mrs. Long has just been here, and she told me all about it."

Mr. Bennet made no answer.

"Do you not want to know who has taken it?" cried his wife impatiently.

"You want to tell me, and I have no objection to hearing it."

This was invitation enough.

"Why, my dear, you must know, Mrs. Long says that Netherfield is taken by a young man of large fortune from the north of England; that he came down on Monday in a chaise and four to see the place, and was so much delighted with it, that he agreed with Mr. Morris immediately; that he is to take possession before Michaelmas, and some of his servants are to be in the house by the end of next week."

"What is his name?"

"Bingley."

"Is he married or single?"

"Oh! Single, my dear, to be sure! A single man of large fortune; four or five thousand a year. What a fine thing for our girls!"

"How so? How can it affect them?"

"My dear Mr. Bennet," replied his wife, "how can you be so tiresome! You must know that I am thinking of his marrying one of them."

"Is that his design in settling here?"

"Design! Nonsense, how can you talk so! But it is very likely that he may fall in love with one of them, and therefore you must visit him as soon as he comes."

Mr. Bennet was so odd a mixture of quick parts, sarcastic humour, reserve, and caprice, that the experience of three-and-twenty years had been insufficient to make his wife understand his character. Her mind was less difficult to develop. She was a woman of mean understanding, little information, and uncertain temper. When she was discontented, she fancied herself nervous. The business of her life was to get her daughters married; its solace was visiting and news.`;

async function boot() {
  applySettings();
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
  try { await db(); await loadWords(); } catch (e) { toast('浏览器不允许本地存储（可能是无痕模式），书籍无法保存。'); }
  const m = location.hash.match(/^#b-(\w+)/);
  if (m) openBook(m[1]); else renderLibrary();
  window.addEventListener('hashchange', () => { const mm = location.hash.match(/^#b-(\w+)/); if (mm && mm[1] !== R.book?.id) openBook(mm[1]); });
  window.addEventListener('resize', debounce(() => { if (!R.book) return; if (!isMobile()) { $('#panel').hidden = false; $('#reader-scroll').classList.remove('panel-open'); if (!R.active) showPanelEmpty(); } else if (!R.active) $('#panel').hidden = true; }, 200));
}
boot();
