/* Shepherd Markdown | MD Reader - client */
(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const svg = (id, cls) => '<svg class="' + (cls || 'icon') + '"><use href="#' + id + '"/></svg>';
  const basename = (p) => (p || '').split(/[\\/]/).pop();
  const stripExt = (n) => (n || '').replace(/\.(md|markdown|mdown|mkd|txt)$/i, '');

  const THEMES = [
    { id: 'auto', name: 'Auto', family: '', sw: 'linear-gradient(135deg,#ffffff 0 50%,#262624 50% 100%)', dot: '#888' },
    { id: 'light', name: 'Light', family: 'light', sw: '#ffffff', dot: '#c05f33' },
    { id: 'sepia', name: 'Sepia', family: 'light', sw: '#f9f5ec', dot: '#9b7a4b' },
    { id: 'silver', name: 'Silver', family: 'light', sw: '#e9ebee', dot: '#b25c38' },
    { id: 'true-dark', name: 'True dark', family: 'dark', sw: '#000000', dot: '#e0865e' },
    { id: 'claude', name: 'Claude', family: 'dark', sw: '#262624', dot: '#d97757' },
  ];

  const el = {
    body: document.body, sidebar: $('#sidebar'), tree: $('#tree'), searchResults: $('#search-results'),
    search: $('#search'), searchWrap: $('#search-wrap'), crumb: $('#crumb'), content: $('#content'),
    contentScroll: $('#content-scroll'), toc: $('#toc'), welcome: $('#welcome'), splitter: $('#splitter'),
    zoomLabel: $('#zoom-label'), progress: $('#progress'), toast: $('#toast'), splash: $('#splash'),
    statusbar: $('#statusbar'), tabs: $('#tabs'), tabstrip: $('#tabstrip'),
    panelStarred: $('#panel-starred'), panelRecent: $('#panel-recent'), panelSessions: $('#panel-sessions'),
    themeMenu: $('#theme-menu'), themeName: $('#theme-name'), saveMenu: $('#save-menu'), shotMenu: $('#shot-menu'),
    btnStar: $('#btn-star'), btnBack: $('#btn-back'), btnFwd: $('#btn-fwd'),
    hlLight: $('#hljs-light'), hlDark: $('#hljs-dark'), modal: $('#modal'), findbar: $('#findbar'),
    winTitle: $('#win-title'),
  };
  function setDocTitle(t) { document.title = t; if (el.winTitle) el.winTitle.textContent = t; }

  // ---- app state ----
  let tabs = [], activeTabId = null, tabSeq = 1;
  const seenTabs = new Set();
  let stars = new Set(), historyList = [], sessions = [], groups = [];
  const GROUP_COLORS = ['#77726a', '#d97757', '#d24b48', '#c8891f', '#4a9e4a', '#2f9c8f', '#8a63c9', '#cc5e93'];
  const NEWTAB = document.getElementById('btn-newtab');
  const nav = { back: [], fwd: [] };
  const prefs = { theme: 'auto', zoom: 1, wide: true, tocOn: true, sideW: 300, view: 'files', expanded: [] };
  let hydrating = true;

  // per-render context (from active tab)
  let currentPath = null, currentBaseDir = null, currentSections = [], currentMtime = 0, currentSource = '', currentWords = 0;

  marked.setOptions({ gfm: true, breaks: false, headerIds: false, mangle: false });

  /* ================= helpers ================= */
  function escapeHtml(s) { return (s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
  function slugify(s) { return s.toLowerCase().trim().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-'); }
  function resolvePath(baseDir, rel) {
    if (!baseDir) return null; rel = rel.replace(/\//g, '\\');
    if (/^[a-zA-Z]:\\/.test(rel) || rel.startsWith('\\\\')) return rel;
    const parts = (baseDir + '\\' + rel).split('\\'); const out = [];
    for (const p of parts) { if (p === '') { if (out.length === 0) out.push(''); continue; } if (p === '.') continue; if (p === '..') { if (out.length > 1) out.pop(); continue; } out.push(p); }
    return out.join('\\');
  }
  let toastTimer = null;
  function toast(msg, iconId) { el.toast.innerHTML = (iconId ? svg(iconId) : '') + '<span>' + escapeHtml(msg) + '</span>'; el.toast.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => el.toast.classList.remove('show'), 1900); }
  function progressStart() { el.progress.classList.add('active'); el.progress.style.width = '35%'; requestAnimationFrame(() => { el.progress.style.width = '72%'; }); }
  function progressDone() { el.progress.style.width = '100%'; setTimeout(() => { el.progress.classList.remove('active'); el.progress.style.width = '0'; }, 250); }
  async function copyText(t) {
    try { if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(t); return true; } } catch (_) {}
    try { const ta = document.createElement('textarea'); ta.value = t; ta.style.cssText = 'position:fixed;top:-1000px;opacity:0'; document.body.appendChild(ta); ta.focus(); ta.select(); const ok = document.execCommand('copy'); ta.remove(); return ok; } catch (_) { return false; }
  }
  function fmtDate(ms) { try { return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }); } catch (_) { return ''; } }
  function fmtAgo(ms) { const s = (Date.now() - ms) / 1000; if (s < 60) return 'just now'; if (s < 3600) return Math.floor(s / 60) + 'm ago'; if (s < 86400) return Math.floor(s / 3600) + 'h ago'; if (s < 604800) return Math.floor(s / 86400) + 'd ago'; return fmtDate(ms); }

  /* ================= persistence ================= */
  let saveTimer = null;
  function saveState() {
    if (hydrating) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const cur = currentTab(); if (cur) cur.scrollTop = el.contentScroll.scrollTop;
      const data = {
        tabs: tabs.filter((t) => t.path).map((t) => ({ path: t.path, hash: t.hash || null, groupId: t.groupId || null })),
        activePath: cur && cur.path ? cur.path : null,
        stars: Array.from(stars), history: historyList.slice(0, 300), sessions, groups,
        prefs: { theme: prefs.theme, zoom: prefs.zoom, wide: prefs.wide, tocOn: prefs.tocOn, sideW: prefs.sideW, view: prefs.view, expanded: Array.from(expanded), collapsedRoots: Array.from(collapsedRoots) },
      };
      fetch('/api/state', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }).catch(() => {});
    }, 350);
  }
  function beaconSave() {
    try {
      const cur = currentTab(); if (cur) cur.scrollTop = el.contentScroll.scrollTop;
      const data = { tabs: tabs.filter((t) => t.path).map((t) => ({ path: t.path, hash: t.hash || null, groupId: t.groupId || null })), activePath: cur && cur.path ? cur.path : null, stars: Array.from(stars), history: historyList.slice(0, 300), sessions, groups, prefs: { theme: prefs.theme, zoom: prefs.zoom, wide: prefs.wide, tocOn: prefs.tocOn, sideW: prefs.sideW, view: prefs.view, expanded: Array.from(expanded), collapsedRoots: Array.from(collapsedRoots) } };
      navigator.sendBeacon('/api/state', new Blob([JSON.stringify(data)], { type: 'application/json' }));
    } catch (_) {}
  }

  /* ================= front matter + sections ================= */
  function extractFrontMatter(md) {
    const m = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(md);
    if (!m) return { fm: null, body: md };
    const rows = [];
    m[1].split(/\r?\n/).forEach((line) => { if (!line.trim() || /^\s*#/.test(line)) return; const i = line.indexOf(':'); if (i < 0) { rows.push([line.trim(), '']); return; } rows.push([line.slice(0, i).trim(), line.slice(i + 1).trim().replace(/^["']|["']$/g, '')]); });
    return { fm: rows, body: md.slice(m[0].length) };
  }
  function frontMatterHtml(rows) { if (!rows || !rows.length) return ''; const cells = rows.map((r) => '<tr><td style="font-weight:500;white-space:nowrap;color:var(--fg-2)">' + escapeHtml(r[0]) + '</td><td>' + escapeHtml(r[1]) + '</td></tr>').join(''); return '<details class="frontmatter" open><summary>Front matter</summary><table>' + cells + '</table></details>'; }
  function computeSections(md) {
    const lines = md.split('\n'); const heads = []; let fence = null;
    for (let i = 0; i < lines.length; i++) { const f = lines[i].match(/^\s*(```|~~~)/); if (f) { const mk = f[1][0]; if (!fence) fence = mk; else if (lines[i].trim().startsWith(fence)) fence = null; continue; } if (fence) continue; const m = lines[i].match(/^(#{1,6})\s+/); if (m) heads.push({ level: m[1].length, line: i }); }
    return heads.map((h, idx) => { let end = lines.length; for (let j = idx + 1; j < heads.length; j++) { if (heads[j].level <= h.level) { end = heads[j].line; break; } } return lines.slice(h.line, end).join('\n').trim(); });
  }

  /* ================= render ================= */
  const purifyCfg = { ADD_ATTR: ['target', 'align', 'valign', 'colspan', 'rowspan', 'start', 'id', 'class', 'style'], ADD_TAGS: ['details', 'summary', 'mark', 'kbd', 'sub', 'sup', 'ins', 'abbr'] };
  const ALERTS = { note: { icon: 'i-info', label: 'Note' }, tip: { icon: 'i-check', label: 'Tip' }, important: { icon: 'i-spark', label: 'Important' }, warning: { icon: 'i-info', label: 'Warning' }, caution: { icon: 'i-info', label: 'Caution' } };

  function renderMarkdown(md) {
    md = md || '';
    currentSource = md;
    const { fm, body } = extractFrontMatter(md);
    currentSections = computeSections(body);
    const clean = DOMPurify.sanitize(marked.parse(body), purifyCfg);
    el.content.innerHTML = frontMatterHtml(fm) + clean;
    postProcess();
    el.content.classList.remove('anim'); void el.content.offsetWidth; el.content.classList.add('anim');
  }
  function transformAlerts() {
    $$('blockquote', el.content).forEach((bq) => {
      const first = bq.querySelector('p'); if (!first) return;
      const m = (first.textContent || '').match(/^\s*\[!(note|tip|important|warning|caution)\]/i); if (!m) return;
      const type = m[1].toLowerCase(); const meta = ALERTS[type];
      first.innerHTML = first.innerHTML.replace(/^\s*\[!\w+\]\s*(<br\s*\/?>)?\s*/i, '');
      if (!first.textContent.trim() && !first.querySelector('img')) first.remove();
      const box = document.createElement('div'); box.className = 'callout cal-' + type;
      const title = document.createElement('div'); title.className = 'cal-title'; title.innerHTML = svg(meta.icon) + '<span>' + meta.label + '</span>'; box.appendChild(title);
      while (bq.firstChild) box.appendChild(bq.firstChild); bq.replaceWith(box);
    });
  }
  function postProcess() {
    transformAlerts();
    const used = {}; const heads = $$('h1,h2,h3,h4,h5,h6', el.content);
    heads.forEach((h, idx) => {
      let id = slugify(h.textContent || '') || 'section'; if (used[id] != null) { used[id]++; id = id + '-' + used[id]; } else used[id] = 0; h.id = id;
      if (h.tagName <= 'H4' && idx < currentSections.length) {
        const anchor = document.createElement('span'); anchor.className = 'sec-anchor';
        const b = document.createElement('button'); b.className = 'sec-btn'; b.title = 'Copy this section as Markdown'; b.dataset.sec = idx; b.innerHTML = svg('i-copy');
        anchor.appendChild(b); h.appendChild(anchor);
      }
    });
    const mermaidBlocks = [];
    $$('pre > code', el.content).forEach((code) => {
      const m = (code.className || '').match(/language-([\w-]+)/); const lang = m ? m[1].toLowerCase() : '';
      if (lang === 'mermaid') { const div = document.createElement('div'); div.className = 'mermaid'; div.textContent = code.textContent; div.dataset.src = code.textContent; code.parentElement.replaceWith(div); mermaidBlocks.push(div); return; }
      try { window.hljs.highlightElement(code); } catch (_) {} addCopyButton(code.parentElement);
    });
    $$('img', el.content).forEach((img) => { const src = img.getAttribute('src') || ''; if (/^(https?:|data:|blob:|\/api\/)/i.test(src)) return; const abs = resolvePath(currentBaseDir, src); if (abs) img.src = '/api/raw?path=' + encodeURIComponent(abs); });
    bindContent();
    buildToc(); renderMermaid(mermaidBlocks);
    currentWords = (el.content.innerText.trim().match(/\S+/g) || []).length;
    updateStatus();
  }
  // (re)attach interactive handlers - runs on fresh render AND on instant cache-restore
  function bindContent() {
    $$('.sec-btn', el.content).forEach((b) => { b.onclick = async (e) => { e.preventDefault(); e.stopPropagation(); const i = +b.dataset.sec; if (currentSections[i] != null && await copyText(currentSections[i])) toast('Section copied', 'i-check'); }; });
    $$('.copy-code', el.content).forEach((btn) => { btn.onclick = async () => { const pre = btn.closest('pre'); const code = pre && pre.querySelector('code'); if (await copyText(code ? code.innerText : (pre ? pre.innerText : ''))) { btn.innerHTML = svg('i-check') + '<span>Copied</span>'; btn.classList.add('done'); setTimeout(() => { btn.innerHTML = svg('i-copy') + '<span>Copy</span>'; btn.classList.remove('done'); }, 1400); } }; });
    $$('a', el.content).forEach((a) => {
      const href = a.getAttribute('href') || '';
      if (href.startsWith('#')) a.onclick = (e) => { e.preventDefault(); scrollToId(href.slice(1)); };
      else if (/^https?:/i.test(href)) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
      else if (/\.(md|markdown|mdown|mkd|txt|pdf)(#.*)?$/i.test(href)) a.onclick = (e) => { e.preventDefault(); const [rel, hash] = href.split('#'); const abs = resolvePath(currentBaseDir, rel); if (abs) openFile(abs, { hash }); };
    });
  }
  function addCopyButton(pre) { const btn = document.createElement('button'); btn.className = 'copy-code'; btn.innerHTML = svg('i-copy') + '<span>Copy</span>'; pre.appendChild(btn); }
  function renderMermaid(blocks) { if (!blocks.length || !window.mermaid) return; const dark = currentFamily() === 'dark'; try { window.mermaid.initialize({ startOnLoad: false, theme: dark ? 'dark' : 'default', securityLevel: 'loose' }); window.mermaid.run({ nodes: blocks }).catch((err) => flagMermaid(blocks, err)); } catch (err) { flagMermaid(blocks, err); } }
  function flagMermaid(blocks, err) { blocks.forEach((b) => { if (!b.querySelector('svg')) { b.className = 'mermaid-error'; b.textContent = 'Diagram could not render: ' + (err && err.message ? err.message : err); } }); }
  function reRenderMermaid() { const nodes = $$('.mermaid, .mermaid-error', el.content).filter((n) => n.dataset.src); if (!nodes.length) return; const fresh = nodes.map((n) => { const d = document.createElement('div'); d.className = 'mermaid'; d.textContent = n.dataset.src; d.dataset.src = n.dataset.src; n.replaceWith(d); return d; }); renderMermaid(fresh); }

  /* ---- TOC ---- */
  function buildToc() {
    const heads = $$('h2,h3,h4', el.content).filter((h) => h.id);
    if (!heads.length || !prefs.tocOn) { el.toc.hidden = true; return; }
    el.toc.hidden = false; el.toc.innerHTML = '<div class="toc-title">On this page</div>';
    heads.forEach((h) => { const a = document.createElement('a'); a.href = '#' + h.id; a.textContent = (h.textContent || '').replace(/\s+$/, ''); a.className = 'lvl-' + h.tagName[1]; a.addEventListener('click', (e) => { e.preventDefault(); scrollToId(h.id); }); el.toc.appendChild(a); });
  }
  function scrollToId(id) { const t = document.getElementById(id); if (t) el.contentScroll.scrollTo({ top: t.offsetTop - 12, behavior: 'smooth' }); }
  let spyTimer = null;
  el.contentScroll.addEventListener('scroll', () => { if (spyTimer) return; spyTimer = setTimeout(() => { spyTimer = null; const heads = $$('h2,h3,h4', el.content).filter((h) => h.id); const top = el.contentScroll.scrollTop + 70; let cur = null; for (const h of heads) { if (h.offsetTop <= top) cur = h.id; else break; } $$('a', el.toc).forEach((a) => a.classList.toggle('active', a.getAttribute('href') === '#' + cur)); }, 70); });

  function updateStatus() {
    if (!currentPath && !currentSource) { el.statusbar.hidden = true; return; }
    el.statusbar.hidden = false;
    const words = currentWords || 0; const mins = Math.max(1, Math.round(words / 220));
    $('#st-words span').textContent = words.toLocaleString() + ' words';
    $('#st-read span').textContent = '~' + mins + ' min read';
    $('#st-mod').style.display = currentMtime ? '' : 'none';
    if (currentMtime) $('#st-mod span').textContent = 'Modified ' + fmtDate(currentMtime);
  }

  /* ================= tabs ================= */
  function currentTab() { return tabs.find((t) => t.id === activeTabId) || null; }
  function createTab(props) { const t = Object.assign({ id: tabSeq++, path: null, name: 'New tab', kind: 'md', source: null, mtime: 0, baseDir: null, hash: null, scrollTop: 0, ephemeral: false, cacheHTML: null, sections: null, words: 0, groupId: null }, props); tabs.push(t); return t; }
  // stash the outgoing tab's fully-rendered DOM so returning to it is instant (no re-parse)
  function cacheOutgoing(cur) { if (!cur) return; cur.scrollTop = el.contentScroll.scrollTop; clearFindHighlights(); if (cur.path || cur.source) { cur.cacheHTML = el.content.innerHTML; cur.sections = currentSections.slice(); cur.words = currentWords; } }

  async function openFile(path, opts = {}) {
    closeSidebarOverlay(); // picking a file dismisses the drawer on narrow windows
    const existing = tabs.find((t) => t.path === path);
    if (existing) { if (opts.hash) existing.hash = opts.hash; await activateTab(existing.id, opts.hash); return; }
    const cur = currentTab();
    let tab;
    if (!opts.newTab && cur && !cur.path && !cur.ephemeral) { tab = cur; tab.path = path; tab.name = basename(path); }
    else tab = createTab({ path, name: basename(path) });
    tab.hash = opts.hash || null;
    pushHistory(path, tab.name);
    if (opts.pushNav !== false && cur && cur.path && cur.path !== path) { nav.back.push(cur.path); nav.fwd = []; updateNav(); }
    await activateTab(tab.id, opts.hash);
    renderTabs(); saveState();
  }
  function newBlankTab() { cacheOutgoing(currentTab()); const t = createTab({}); activeTabId = t.id; renderTab(t); renderTabs(); saveState(); }

  async function activateTab(id, hash) {
    const cur = currentTab(); if (cur && cur.id !== id) cacheOutgoing(cur);
    const tab = tabs.find((t) => t.id === id); if (!tab) return;
    activeTabId = id;
    if (tab.path && tab.source == null) {
      progressStart();
      try { const r = await fetch('/api/file?path=' + encodeURIComponent(tab.path)); if (!r.ok) throw new Error('HTTP ' + r.status); const d = await r.json(); tab.source = d.content; tab.mtime = d.mtime || 0; tab.baseDir = d.path.replace(/[\\/][^\\/]*$/, ''); tab.name = d.name; }
      catch (e) { tab.source = '> [!CAUTION]\n> Could not open `' + tab.path + '`\n>\n> ' + e.message; tab.baseDir = null; }
      finally { progressDone(); }
    }
    renderTab(tab, hash); markActiveTab();
  }
  function renderTab(tab, hash) {
    if (!tab || (!tab.path && !tab.source)) {
      el.content.innerHTML = ''; el.welcome.classList.remove('hidden');
      el.toc.hidden = true; el.toc.innerHTML = '';
      currentPath = null; currentBaseDir = null; currentSections = []; currentMtime = 0; currentSource = ''; currentWords = 0;
      el.crumb.innerHTML = '<b>New tab</b>'; setDocTitle('Shepherd Markdown | MD Reader'); el.statusbar.hidden = true; updateStarBtn(); el.contentScroll.scrollTop = 0; return;
    }
    el.welcome.classList.add('hidden');
    currentPath = tab.path; currentBaseDir = tab.baseDir; currentMtime = tab.mtime || 0;
    if (tab.cacheHTML != null) {
      el.content.innerHTML = tab.cacheHTML; currentSource = tab.source || ''; currentSections = tab.sections || []; currentWords = tab.words || 0;
      bindContent(); buildToc(); updateStatus();
      el.content.classList.remove('anim'); void el.content.offsetWidth; el.content.classList.add('anim');
    } else {
      renderMarkdown(tab.source);
    }
    el.crumb.innerHTML = crumbHtml(tab.path, tab.name); setDocTitle(stripExt(tab.name));
    updateStarBtn(); markTreeActive(tab.path);
    hash = hash || tab.hash;
    if (hash) setTimeout(() => scrollToId(hash), 70); else el.contentScroll.scrollTop = tab.scrollTop || 0;
    if (el.findbar && !el.findbar.hidden && !findAll && findQuery) setTimeout(() => findInPage(findQuery), 50);
  }
  function closeTab(id, ev) {
    if (ev) ev.stopPropagation();
    const idx = tabs.findIndex((t) => t.id === id); if (idx < 0) return;
    const wasActive = tabs[idx].id === activeTabId;
    tabs.splice(idx, 1);
    normalizeGroups();
    renderTabs(); saveState();
    if (wasActive) { const next = tabs[idx] || tabs[idx - 1]; if (next) activateTab(next.id); else { activeTabId = null; renderTab(null); } }
  }
  function scrollActiveTabIntoView() { const a = el.tabs.querySelector('.tab.active'); if (a) a.scrollIntoView({ inline: 'nearest', block: 'nearest' }); }
  function markActiveTab() { $$('.tab', el.tabs).forEach((t) => t.classList.toggle('active', +t.dataset.id === activeTabId)); scrollActiveTabIntoView(); }
  el.tabs.addEventListener('wheel', (e) => { if (e.deltaY && !e.shiftKey) { el.tabs.scrollLeft += e.deltaY; e.preventDefault(); } }, { passive: false });

  function makeTab(t) {
    const d = document.createElement('div'); d.className = 'tab' + (t.id === activeTabId ? ' active' : ''); d.draggable = true; d.dataset.id = t.id;
    if (!seenTabs.has(t.id)) { d.classList.add('enter'); seenTabs.add(t.id); }
    const starred = t.path && stars.has(t.path);
    d.innerHTML = '<span class="t-ico">' + svg(starred ? 'i-star-fill' : 'i-file') + '</span><span class="t-name"></span><span class="t-close">' + svg('i-x') + '</span>';
    d.querySelector('.t-name').textContent = stripExt(t.name); d.title = t.path || t.name;
    d.addEventListener('click', () => activateTab(t.id));
    d.addEventListener('auxclick', (e) => { if (e.button === 1) { e.preventDefault(); closeTab(t.id); } });
    d.querySelector('.t-close').addEventListener('click', (e) => closeTab(t.id, e));
    d.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); openTabMenu(t, e.clientX, e.clientY); });
    d.addEventListener('dragstart', (e) => { d.classList.add('dragging'); e.dataTransfer.setData('text/tab', String(t.id)); e.dataTransfer.effectAllowed = 'move'; });
    d.addEventListener('dragend', () => { d.classList.remove('dragging'); $$('.tab, .group-chip', el.tabs).forEach((x) => x.classList.remove('dragover')); });
    d.addEventListener('dragover', (e) => { e.preventDefault(); d.classList.add('dragover'); });
    d.addEventListener('dragleave', () => d.classList.remove('dragover'));
    d.addEventListener('drop', (e) => { e.preventDefault(); e.stopPropagation(); d.classList.remove('dragover'); onTabDrop(parseInt(e.dataTransfer.getData('text/tab')), t.id); });
    return d;
  }
  function makeChip(g, count) {
    const chip = document.createElement('div'); chip.className = 'group-chip'; chip.style.setProperty('--grp', g.color); chip.dataset.group = g.id;
    chip.innerHTML = (g.name ? '<span class="grp-name"></span>' : '') + (g.collapsed ? '<span class="grp-count">' + count + '</span>' : '');
    if (g.name) chip.querySelector('.grp-name').textContent = g.name;
    chip.title = (g.name || 'Tab group') + ' - click to ' + (g.collapsed ? 'expand' : 'collapse') + ', right-click for options';
    chip.addEventListener('click', (e) => { e.stopPropagation(); g.collapsed = !g.collapsed; renderTabs(); saveState(); });
    chip.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); openGroupMenu(g, e.clientX, e.clientY); });
    chip.addEventListener('dragover', (e) => { e.preventDefault(); chip.classList.add('dragover'); });
    chip.addEventListener('dragleave', () => chip.classList.remove('dragover'));
    chip.addEventListener('drop', (e) => { e.preventDefault(); e.stopPropagation(); chip.classList.remove('dragover'); addTabToGroup(parseInt(e.dataTransfer.getData('text/tab')), g.id); });
    return chip;
  }
  function renderTabs() {
    el.tabs.innerHTML = '';
    seenTabs.forEach((id) => { if (!tabs.some((t) => t.id === id)) seenTabs.delete(id); });
    let i = 0;
    while (i < tabs.length) {
      const t = tabs[i]; const g = t.groupId ? groups.find((x) => x.id === t.groupId) : null;
      if (g) {
        const gt = []; let j = i; while (j < tabs.length && tabs[j].groupId === g.id) { gt.push(tabs[j]); j++; }
        const wrap = document.createElement('div'); wrap.className = 'tab-group' + (g.collapsed ? ' collapsed' : ''); wrap.style.setProperty('--grp', g.color);
        wrap.appendChild(makeChip(g, gt.length));
        if (!g.collapsed) gt.forEach((x) => wrap.appendChild(makeTab(x)));
        el.tabs.appendChild(wrap); i = j;
      } else { el.tabs.appendChild(makeTab(t)); i++; }
    }
    if (NEWTAB) el.tabs.appendChild(NEWTAB);
    scrollActiveTabIntoView();
    if (prefs.view === 'sessions') renderSessions();
  }
  function onTabDrop(fromId, toId) {
    const fi = tabs.findIndex((t) => t.id === fromId), ti0 = tabs.findIndex((t) => t.id === toId);
    if (fi < 0 || ti0 < 0 || fromId === toId) return;
    const target = tabs[ti0]; const [m] = tabs.splice(fi, 1);
    const ni = tabs.findIndex((t) => t.id === toId); tabs.splice(ni, 0, m);
    m.groupId = target.groupId || null;
    normalizeGroups(); renderTabs(); saveState();
  }
  function normalizeGroups() {
    groups = groups.filter((g) => tabs.some((t) => t.groupId === g.id));
    const out = [], placed = new Set();
    for (const t of tabs) {
      if (placed.has(t.id)) continue;
      if (t.groupId) { for (const gt of tabs) if (gt.groupId === t.groupId && !placed.has(gt.id)) { out.push(gt); placed.add(gt.id); } }
      else { out.push(t); placed.add(t.id); }
    }
    tabs = out;
  }
  /* ---- group operations ---- */
  function nextGroupColor() { const used = groups.map((g) => g.color); return GROUP_COLORS.find((c) => !used.includes(c)) || GROUP_COLORS[groups.length % GROUP_COLORS.length]; }
  function newGroupWith(tabId) { const id = 'g' + tabSeq++; groups.push({ id, name: '', color: nextGroupColor(), collapsed: false }); const t = tabs.find((x) => x.id === tabId); if (t) t.groupId = id; normalizeGroups(); renderTabs(); saveState(); }
  function newTabInGroup(groupId) { const t = createTab({ groupId }); normalizeGroups(); activeTabId = t.id; renderTab(t); renderTabs(); saveState(); }
  function addTabToGroup(tabId, groupId) { const t = tabs.find((x) => x.id === tabId); if (t) t.groupId = groupId; normalizeGroups(); renderTabs(); saveState(); }
  function removeFromGroup(tabId) { const t = tabs.find((x) => x.id === tabId); if (t) t.groupId = null; normalizeGroups(); renderTabs(); saveState(); }
  function ungroup(groupId) { tabs.forEach((t) => { if (t.groupId === groupId) t.groupId = null; }); groups = groups.filter((g) => g.id !== groupId); normalizeGroups(); renderTabs(); saveState(); }
  function closeGroup(groupId) { const wasActive = tabs.some((t) => t.groupId === groupId && t.id === activeTabId); tabs = tabs.filter((t) => t.groupId !== groupId); groups = groups.filter((g) => g.id !== groupId); normalizeGroups(); if (wasActive) { const n = tabs[0]; if (n) { activeTabId = n.id; activateTab(n.id); } else { activeTabId = null; renderTab(null); } } renderTabs(); saveState(); }
  function closeOtherTabs(keepId) { tabs = tabs.filter((t) => t.id === keepId); normalizeGroups(); if (activeTabId !== keepId) { activeTabId = keepId; activateTab(keepId); } renderTabs(); saveState(); }
  function closeTabsToRight(fromId) { const idx = tabs.findIndex((t) => t.id === fromId); if (idx < 0) return; const removed = tabs.slice(idx + 1); tabs = tabs.slice(0, idx + 1); normalizeGroups(); if (removed.some((t) => t.id === activeTabId)) { activeTabId = fromId; activateTab(fromId); } renderTabs(); saveState(); }
  /* ---- context menus ---- */
  let ctxMenuEl = null;
  function closeContextMenu() { if (ctxMenuEl) { ctxMenuEl.remove(); ctxMenuEl = null; } }
  function showContextMenu(items, x, y) {
    closeContextMenu();
    const m = document.createElement('div'); m.className = 'ctx-menu';
    items.forEach((it) => {
      if (it.sep) { const s = document.createElement('div'); s.className = 'ctx-sep'; m.appendChild(s); return; }
      if (it.custom) { m.appendChild(it.custom); return; }
      const r = document.createElement('div'); r.className = 'ctx-item' + (it.danger ? ' danger' : '');
      r.innerHTML = (it.dot ? '<span class="dot" style="background:' + it.dot + '"></span>' : (it.icon ? svg(it.icon) : '<span style="width:15px"></span>')) + '<span class="lbl"></span>';
      r.querySelector('.lbl').textContent = it.label;
      r.addEventListener('click', () => { closeContextMenu(); if (it.fn) it.fn(); });
      m.appendChild(r);
    });
    document.body.appendChild(m);
    const rc = m.getBoundingClientRect();
    m.style.left = Math.max(6, Math.min(x, window.innerWidth - rc.width - 8)) + 'px';
    m.style.top = Math.max(6, Math.min(y, window.innerHeight - rc.height - 8)) + 'px';
    ctxMenuEl = m;
  }
  document.addEventListener('click', closeContextMenu);
  window.addEventListener('blur', closeContextMenu);
  function openTabMenu(t, x, y) {
    const items = [{ label: 'Close tab', icon: 'i-x', fn: () => closeTab(t.id) }, { label: 'Close other tabs', fn: () => closeOtherTabs(t.id) }, { label: 'Close tabs to the right', fn: () => closeTabsToRight(t.id) }, { sep: true }];
    if (t.groupId) items.push({ label: 'Remove from group', fn: () => removeFromGroup(t.id) });
    else {
      items.push({ label: 'Add tab to new group', icon: 'i-plus', fn: () => newGroupWith(t.id) });
      groups.forEach((g) => items.push({ label: 'Add to ' + (g.name || 'group'), dot: g.color, fn: () => addTabToGroup(t.id, g.id) }));
    }
    showContextMenu(items, x, y);
  }
  function openGroupMenu(g, x, y) {
    const palette = document.createElement('div'); palette.className = 'ctx-colors';
    GROUP_COLORS.forEach((c) => { const s = document.createElement('button'); s.className = 'ctx-color' + (c === g.color ? ' on' : ''); s.style.background = c; s.addEventListener('click', () => { g.color = c; closeContextMenu(); renderTabs(); saveState(); }); palette.appendChild(s); });
    const items = [{ custom: palette }, { sep: true },
      { label: 'Rename group', fn: async () => { const n = await promptModal('Name this group', g.name || '', 'Save'); if (n != null) { g.name = n.trim(); renderTabs(); saveState(); } } },
      { label: g.collapsed ? 'Expand group' : 'Collapse group', fn: () => { g.collapsed = !g.collapsed; renderTabs(); saveState(); } },
      { label: 'New tab in group', icon: 'i-plus', fn: () => newTabInGroup(g.id) },
      { sep: true },
      { label: 'Ungroup', fn: () => ungroup(g.id) },
      { label: 'Close group', icon: 'i-x', danger: true, fn: () => closeGroup(g.id) }];
    showContextMenu(items, x, y);
  }

  function crumbHtml(path, name) { if (!path) return '<b>' + escapeHtml(name || 'Untitled') + '</b>'; const parts = path.split(/[\\/]/); const file = parts.pop(); const tail = parts.slice(-2).join(' / '); return (tail ? escapeHtml(tail) + ' / ' : '') + '<b>' + escapeHtml(file) + '</b>'; }

  /* ---- nav history (back/forward within tab) ---- */
  function updateNav() { el.btnBack.disabled = !nav.back.length; el.btnFwd.disabled = !nav.fwd.length; }
  function navBack() { if (!nav.back.length) return; if (currentPath) nav.fwd.push(currentPath); const p = nav.back.pop(); openFile(p, { pushNav: false }); updateNav(); }
  function navFwd() { if (!nav.fwd.length) return; if (currentPath) nav.back.push(currentPath); const p = nav.fwd.pop(); openFile(p, { pushNav: false }); updateNav(); }

  /* ================= stars / history / sessions ================= */
  function updateStarBtn() { const on = currentPath && stars.has(currentPath); el.btnStar.classList.toggle('on', !!on); el.btnStar.querySelector('use').setAttribute('href', on ? '#i-star-fill' : '#i-star'); el.btnStar.disabled = !currentPath; el.btnStar.style.opacity = currentPath ? '' : '.4'; }
  function toggleStar(path) { if (!path) return; const adding = !stars.has(path); if (adding) stars.add(path); else stars.delete(path); updateStarBtn(); if (adding) popEl($('#btn-star svg')); renderTabs(); if (prefs.view === 'starred') renderStarred(); saveState(); }
  function pushHistory(path, name) { if (!path) return; historyList = historyList.filter((h) => h.path !== path); historyList.unshift({ path, name: name || basename(path), t: Date.now() }); if (historyList.length > 300) historyList.length = 300; if (prefs.view === 'recent') renderRecent(); saveState(); }

  function fileRow(item, opts = {}) {
    const d = document.createElement('div'); d.className = 'li-item' + (item.path === currentPath ? ' active' : '');
    d.innerHTML = '<span class="li-ico">' + svg('i-file') + '</span><div class="li-body"><div class="li-name"></div>' + (opts.meta ? '<div class="li-meta"></div>' : '') + '</div><div class="li-act"></div>';
    d.querySelector('.li-name').textContent = stripExt(item.name || basename(item.path)); d.title = item.path;
    if (opts.meta) d.querySelector('.li-meta').textContent = opts.meta;
    const act = d.querySelector('.li-act');
    (opts.actions || []).forEach((a) => { const b = document.createElement('button'); b.className = 'li-btn' + (a.cls ? ' ' + a.cls : ''); b.title = a.title; b.innerHTML = svg(a.icon); b.addEventListener('click', (e) => { e.stopPropagation(); a.fn(); }); act.appendChild(b); });
    d.addEventListener('click', () => openFile(item.path));
    return d;
  }
  function emptyPanel(iconId, text) { return '<div class="panel-empty">' + svg(iconId) + '<div>' + text + '</div></div>'; }

  function renderStarred() {
    el.panelStarred.innerHTML = '<div class="panel-head"><span class="ph-title">Starred library</span></div>';
    const list = Array.from(stars);
    if (!list.length) { el.panelStarred.insertAdjacentHTML('beforeend', emptyPanel('i-star', 'Star a file to keep it here.<br>Use the star in the toolbar.')); return; }
    list.forEach((p) => el.panelStarred.appendChild(fileRow({ path: p }, { actions: [{ icon: 'i-star-fill', cls: 'star', title: 'Unstar', fn: () => toggleStar(p) }] })));
  }
  function renderRecent() {
    el.panelRecent.innerHTML = '<div class="panel-head"><span class="ph-title">Recent history</span>' + (historyList.length ? '<span class="ph-act" id="clear-recent">' + svg('i-x') + 'Clear</span>' : '') + '</div>';
    if (!historyList.length) { el.panelRecent.insertAdjacentHTML('beforeend', emptyPanel('i-clock', 'Files you open show up here.')); return; }
    historyList.forEach((h) => el.panelRecent.appendChild(fileRow({ path: h.path, name: h.name }, { meta: fmtAgo(h.t), actions: [{ icon: stars.has(h.path) ? 'i-star-fill' : 'i-star', cls: stars.has(h.path) ? 'star' : '', title: 'Star', fn: () => { toggleStar(h.path); renderRecent(); } }] })));
    const clr = $('#clear-recent'); if (clr) clr.addEventListener('click', () => { historyList = []; renderRecent(); saveState(); });
  }
  function renderSessions() {
    el.panelSessions.innerHTML = '<div class="panel-head"><span class="ph-title">Sessions</span><span class="ph-act" id="save-session">' + svg('i-plus') + 'Save tabs</span></div>';
    if (groups.length) {
      el.panelSessions.insertAdjacentHTML('beforeend', '<div class="panel-sub">Tab groups</div>');
      groups.forEach((g) => {
        const count = tabs.filter((t) => t.groupId === g.id).length;
        const d = document.createElement('div'); d.className = 'li-item';
        d.innerHTML = '<span class="grp-dot2" style="background:' + g.color + '"></span><div class="li-body"><div class="li-name"></div><div class="li-meta"></div></div><div class="li-act"></div>';
        d.querySelector('.li-name').textContent = g.name || 'Group';
        d.querySelector('.li-meta').textContent = count + ' tab' + (count === 1 ? '' : 's') + (g.collapsed ? ' · collapsed' : '');
        const cl = document.createElement('button'); cl.className = 'li-btn'; cl.title = 'Close group and all its tabs'; cl.innerHTML = svg('i-x'); cl.addEventListener('click', (e) => { e.stopPropagation(); closeGroup(g.id); }); d.querySelector('.li-act').appendChild(cl);
        d.addEventListener('click', () => { g.collapsed = false; const first = tabs.find((t) => t.groupId === g.id); if (first) activateTab(first.id); renderTabs(); saveState(); });
        el.panelSessions.appendChild(d);
      });
      el.panelSessions.insertAdjacentHTML('beforeend', '<div class="panel-sub">Saved sessions</div>');
    }
    if (!sessions.length) { el.panelSessions.insertAdjacentHTML('beforeend', emptyPanel('i-layers', 'Save your open tabs as a session,<br>then reopen them any time.')); }
    sessions.forEach((s) => {
      const d = document.createElement('div'); d.className = 'li-item';
      d.innerHTML = '<span class="li-ico">' + svg('i-layers') + '</span><div class="li-body"><div class="li-name"></div><div class="li-meta"></div></div><div class="li-act"></div>';
      d.querySelector('.li-name').textContent = s.name; d.querySelector('.li-meta').textContent = s.paths.length + ' tab' + (s.paths.length === 1 ? '' : 's') + ' · ' + fmtAgo(s.created);
      const act = d.querySelector('.li-act');
      const del = document.createElement('button'); del.className = 'li-btn'; del.title = 'Delete session'; del.innerHTML = svg('i-x'); del.addEventListener('click', (e) => { e.stopPropagation(); sessions = sessions.filter((x) => x.id !== s.id); renderSessions(); saveState(); }); act.appendChild(del);
      d.addEventListener('click', () => openSession(s));
      el.panelSessions.appendChild(d);
    });
    const save = $('#save-session'); if (save) save.addEventListener('click', doSaveSession);
  }
  async function doSaveSession() {
    const paths = tabs.filter((t) => t.path).map((t) => t.path);
    if (!paths.length) { toast('No file tabs to save', 'i-info'); return; }
    const name = await promptModal('Name this session', 'Session ' + (sessions.length + 1), 'Save');
    if (name == null) return;
    sessions.unshift({ id: tabSeq++ + '-' + paths.length, name: name.trim() || ('Session ' + (sessions.length + 1)), paths, created: Date.now() });
    renderSessions(); saveState(); toast('Session saved', 'i-check');
  }
  async function openSession(s) { for (const p of s.paths) { if (!tabs.find((t) => t.path === p)) createTab({ path: p, name: basename(p) }); } const first = tabs.find((t) => t.path === s.paths[0]); if (first) await activateTab(first.id); renderTabs(); saveState(); toast('Opened "' + s.name + '"', 'i-layers'); }

  /* ================= views ================= */
  const expanded = new Set();
  const collapsedRoots = new Set();
  function showPanel(view) {
    prefs.view = view;
    $$('.vsw').forEach((b) => b.classList.toggle('on', b.dataset.view === view));
    const searching = el.search.value.trim().length >= 2;
    el.tree.hidden = !(view === 'files' && !searching);
    el.searchResults.hidden = !(view === 'files' && searching);
    el.panelStarred.hidden = view !== 'starred'; el.panelRecent.hidden = view !== 'recent'; el.panelSessions.hidden = view !== 'sessions';
    if (view === 'starred') renderStarred(); else if (view === 'recent') renderRecent(); else if (view === 'sessions') renderSessions();
    const active = view === 'files' ? (searching ? el.searchResults : el.tree) : (view === 'starred' ? el.panelStarred : view === 'recent' ? el.panelRecent : el.panelSessions);
    retrigger(active, 'pin');
    saveState();
  }
  $$('.vsw').forEach((b) => b.addEventListener('click', () => showPanel(b.dataset.view)));

  /* ================= tree ================= */
  let treeData = null;
  async function loadTree() { const r = await fetch('/api/tree'); const data = await r.json(); treeData = data.roots; renderTree(); }
  function renderTree() {
    el.tree.innerHTML = '';
    if (!treeData || !treeData.length) { el.tree.innerHTML = emptyPanel('i-folder', 'No folders open.<br>Use Open folder below.'); return; }
    treeData.forEach((root) => {
      const section = document.createElement('div'); section.className = 'root-section';
      const collapsed = collapsedRoots.has(root.path);
      const header = document.createElement('div'); header.className = 'root-header' + (collapsed ? '' : ' open'); header.title = root.path;
      header.innerHTML = '<span class="twist">' + svg('i-chevron', 'icon') + '</span><span class="ico">' + svg('i-folder') + '</span><span class="label"></span><span class="root-act"><button class="li-btn root-remove" title="Remove this folder">' + svg('i-x') + '</button></span>';
      header.querySelector('.twist svg').style.cssText = 'width:12px;height:12px';
      header.querySelector('.label').textContent = root.name;
      const body = document.createElement('div'); body.className = 'root-body' + (collapsed ? ' collapsed' : '');
      if (root.children.length) root.children.forEach((c) => body.appendChild(nodeEl(c)));
      else { const em = document.createElement('div'); em.className = 'root-empty'; em.textContent = 'No markdown files here'; body.appendChild(em); }
      header.addEventListener('click', () => { const nc = !collapsedRoots.has(root.path); if (nc) collapsedRoots.add(root.path); else collapsedRoots.delete(root.path); body.classList.toggle('collapsed', nc); header.classList.toggle('open', !nc); saveState(); });
      header.querySelector('.root-remove').addEventListener('click', (e) => { e.stopPropagation(); removeRoot(root.path); });
      section.appendChild(header); section.appendChild(body); el.tree.appendChild(section);
    });
    markTreeActive(currentPath);
  }
  async function removeRoot(path) {
    try { await fetch('/api/removeroot?path=' + encodeURIComponent(path), { method: 'POST' }); collapsedRoots.delete(path); await loadTree(); toast('Folder removed', 'i-check'); saveState(); } catch (_) {}
  }
  function nodeEl(node) {
    const wrap = document.createElement('div'); wrap.className = 'tree-item';
    const row = document.createElement('div'); row.className = 'row'; row.dataset.path = node.path;
    if (node.type === 'dir') {
      const isOpen = expanded.has(node.path); row.classList.toggle('open', isOpen);
      row.innerHTML = '<span class="twist">' + svg('i-chevron', 'icon') + '</span><span class="ico">' + svg('i-folder') + '</span><span class="label"></span>';
      row.querySelector('.twist svg').style.cssText = 'width:12px;height:12px'; row.querySelector('.label').textContent = node.name;
      const kids = document.createElement('div'); kids.className = 'children' + (isOpen ? '' : ' collapsed'); node.children.forEach((c) => kids.appendChild(nodeEl(c)));
      row.addEventListener('click', () => { const open = kids.classList.toggle('collapsed'); row.classList.toggle('open', !open); if (open) expanded.delete(node.path); else expanded.add(node.path); saveState(); });
      wrap.appendChild(row); wrap.appendChild(kids);
    } else {
      row.classList.add('file');
      row.innerHTML = '<span class="twist"></span><span class="ico">' + svg('i-file') + '</span><span class="label"></span>';
      row.querySelector('.label').textContent = stripExt(node.name); row.title = node.name;
      row.addEventListener('click', (e) => openFile(node.path, { newTab: e.ctrlKey || e.metaKey }));
      row.addEventListener('auxclick', (e) => { if (e.button === 1) { e.preventDefault(); openFile(node.path, { newTab: true }); } });
      wrap.appendChild(row);
    }
    return wrap;
  }
  function markTreeActive(path) {
    $$('.row', el.tree).forEach((r) => r.classList.toggle('active', r.dataset.path === path));
    if (path) { let node = $$('.row', el.tree).find((r) => r.dataset.path === path); while (node) { const kids = node.closest('.children'); if (!kids) break; kids.classList.remove('collapsed'); const parentRow = kids.previousElementSibling; if (parentRow && parentRow.classList.contains('row')) { parentRow.classList.add('open'); node = parentRow; } else break; } }
  }

  /* ================= search ================= */
  let searchTimer = null;
  el.search.addEventListener('input', () => { clearTimeout(searchTimer); const q = el.search.value.trim(); if (prefs.view !== 'files') showPanel('files'); if (q.length < 2) { el.searchResults.hidden = true; el.tree.hidden = false; return; } searchTimer = setTimeout(() => runSearch(q), 170); });
  async function runSearch(q) {
    const r = await fetch('/api/search?q=' + encodeURIComponent(q)); const data = await r.json();
    el.tree.hidden = true; el.searchResults.hidden = false;
    if (!data.results.length) { el.searchResults.innerHTML = emptyPanel('i-search', 'No matches for "' + escapeHtml(q) + '"'); return; }
    el.searchResults.innerHTML = '';
    data.results.forEach((res) => { const d = document.createElement('div'); d.className = 'sr-item'; d.innerHTML = '<div class="sr-name"></div>' + (res.snippet ? '<div class="sr-snip"></div>' : ''); d.querySelector('.sr-name').textContent = stripExt(res.name); if (res.snippet) d.querySelector('.sr-snip').textContent = res.snippet; d.addEventListener('click', () => openFile(res.path)); el.searchResults.appendChild(d); });
  }
  el.search.addEventListener('keydown', (e) => { if (e.key === 'Escape') { el.search.value = ''; el.searchResults.hidden = true; el.tree.hidden = false; } });

  /* ================= theme ================= */
  function themeById(id) { return THEMES.find((t) => t.id === id) || THEMES[1]; }
  function resolveTheme(id) { if (id === 'auto') return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'claude' : 'light'; return id; }
  function currentFamily() { return themeById(resolveTheme(prefs.theme)).family; }
  function applyTheme() {
    const resolved = resolveTheme(prefs.theme); const fam = themeById(resolved).family;
    el.body.setAttribute('data-theme', resolved); localStorage.setItem('smd-theme-boot', prefs.theme);
    el.hlDark.disabled = fam !== 'dark'; el.hlLight.disabled = fam === 'dark';
    el.themeName.textContent = themeById(prefs.theme).name;
    $$('.menu-item', el.themeMenu).forEach((mi) => mi.classList.toggle('sel', mi.dataset.id === prefs.theme));
    reRenderMermaid();
    tabs.forEach((t) => { t.cacheHTML = null; }); // stale mermaid colors; re-render on next visit
    sendTitleTheme();
  }
  function buildThemeMenu() {
    THEMES.forEach((t) => {
      const item = document.createElement('div'); item.className = 'menu-item'; item.dataset.id = t.id;
      item.innerHTML = '<span class="swatch" style="background:' + t.sw + '"></span><span class="mlabel">' + t.name + '</span>' + svg('i-check', 'icon check');
      item.querySelector('.swatch').insertAdjacentHTML('beforeend', '<i style="position:absolute;right:3px;bottom:3px;width:7px;height:7px;border-radius:50%;background:' + t.dot + '"></i>');
      item.addEventListener('click', () => { prefs.theme = t.id; applyTheme(); closeAllMenus(); saveState(); });
      el.themeMenu.appendChild(item);
    });
  }
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (prefs.theme === 'auto') applyTheme(); });

  /* ================= menus ================= */
  function closeAllMenus() { [el.themeMenu, el.saveMenu, el.shotMenu].forEach((m) => { m.hidden = true; }); }
  function toggleMenu(m) { const wasHidden = m.hidden; closeAllMenus(); m.hidden = !wasHidden; }
  $('#btn-theme').addEventListener('click', (e) => { e.stopPropagation(); toggleMenu(el.themeMenu); });
  $('#btn-save').addEventListener('click', (e) => { e.stopPropagation(); toggleMenu(el.saveMenu); });
  $('#btn-shot').addEventListener('click', (e) => { e.stopPropagation(); toggleMenu(el.shotMenu); });
  document.addEventListener('click', (e) => { if (!e.target.closest('.menu-wrap')) closeAllMenus(); });

  /* ================= zoom / width / layout ================= */
  function applyZoom() { document.documentElement.style.setProperty('--zoom', prefs.zoom); el.zoomLabel.textContent = Math.round(prefs.zoom * 100) + '%'; }
  function applyWidth() { document.documentElement.style.setProperty('--read-w', prefs.wide ? '1080px' : '760px'); $('#btn-width').classList.toggle('on', !prefs.wide); }
  function applySideW() { document.documentElement.style.setProperty('--side-w', prefs.sideW + 'px'); }
  function updateTocFit() { var row = document.getElementById('content-row'); el.body.classList.toggle('toc-hide', !row || row.clientWidth < 700); }
  $('#btn-zoom-in').addEventListener('click', () => { prefs.zoom = Math.min(2.2, +(prefs.zoom + 0.1).toFixed(2)); applyZoom(); saveState(); });
  $('#btn-zoom-out').addEventListener('click', () => { prefs.zoom = Math.max(0.6, +(prefs.zoom - 0.1).toFixed(2)); applyZoom(); saveState(); });
  el.zoomLabel.addEventListener('click', () => { prefs.zoom = 1; applyZoom(); saveState(); });
  $('#btn-width').addEventListener('click', () => { prefs.wide = !prefs.wide; applyWidth(); updateTocFit(); saveState(); });
  $('#btn-sidebar').addEventListener('click', () => { el.sidebar.classList.toggle('hidden'); requestAnimationFrame(updateTocFit); });
  // In narrow/overlay mode the sidebar covers the toggle button, so give it its own ways to close.
  function sidebarIsOverlay() { return window.matchMedia('(max-width: 860px)').matches; }
  function closeSidebarOverlay() { if (sidebarIsOverlay() && !el.sidebar.classList.contains('hidden')) { el.sidebar.classList.add('hidden'); requestAnimationFrame(updateTocFit); } }
  $('#sidebar-scrim').addEventListener('click', closeSidebarOverlay);
  $('#btn-toc').addEventListener('click', () => { prefs.tocOn = !prefs.tocOn; $('#btn-toc').classList.toggle('on', prefs.tocOn); buildToc(); saveState(); });
  $('#btn-print').addEventListener('click', () => window.print());
  $('#btn-back').addEventListener('click', navBack); $('#btn-fwd').addEventListener('click', navFwd);
  $('#btn-newtab').addEventListener('click', newBlankTab);
  $('#btn-star').addEventListener('click', () => toggleStar(currentPath));
  $('#btn-refresh').addEventListener('click', () => { retrigger($('#btn-refresh svg'), 'spin'); loadTree(); const t = currentTab(); if (t && t.path) { t.source = null; t.cacheHTML = null; activateTab(t.id); } });
  $('#btn-copy').addEventListener('click', async () => { if (!currentSource) return; if (await copyText(currentSource)) toast('Document copied', 'i-check'); });

  (() => { let dragging = false; el.splitter.addEventListener('mousedown', (e) => { dragging = true; e.preventDefault(); document.body.style.cursor = 'col-resize'; }); window.addEventListener('mousemove', (e) => { if (!dragging) return; prefs.sideW = Math.max(180, Math.min(560, e.clientX)); applySideW(); }); window.addEventListener('mouseup', () => { if (dragging) { dragging = false; document.body.style.cursor = ''; saveState(); } }); })();

  /* ================= save as ================= */
  async function saveFile(suggested, mime, content) {
    try {
      if (window.showSaveFilePicker) { const h = await window.showSaveFilePicker({ suggestedName: suggested, types: [{ description: mime, accept: { [mime]: ['.' + suggested.split('.').pop()] } }] }); const w = await h.createWritable(); await w.write(content); await w.close(); return true; }
    } catch (e) { if (e && e.name === 'AbortError') return false; }
    try { const blob = content instanceof Blob ? content : new Blob([content], { type: mime }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = suggested; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); return true; } catch (_) { return false; }
  }
  async function buildStandaloneHtml() {
    let css = '';
    try { css += await (await fetch('/lib/github-markdown-light.min.css')).text(); } catch (_) {}
    try { css += await (await fetch('/lib/' + (currentFamily() === 'dark' ? 'github-hl-dark.min.css' : 'github-hl-light.min.css'))).text(); } catch (_) {}
    const clone = el.content.cloneNode(true);
    $$('.sec-anchor, .copy-code', clone).forEach((n) => n.remove());
    $$('img', clone).forEach((img) => { const s = img.getAttribute('src') || ''; const m = s.match(/\/api\/raw\?path=(.+)$/); if (m) img.src = 'file:///' + decodeURIComponent(m[1]).replace(/\\/g, '/'); });
    const name = (currentTab() && currentTab().name) || 'document';
    return '<!doctype html><html><head><meta charset="utf-8"><title>' + escapeHtml(stripExt(name)) + '</title><style>' + css + '\nbody{background:#fff}.markdown-body{box-sizing:border-box;max-width:900px;margin:0 auto;padding:44px}</style></head><body class="markdown-body">' + clone.innerHTML + '</body></html>';
  }
  el.saveMenu.addEventListener('click', async (e) => {
    const item = e.target.closest('.menu-item'); if (!item) return; closeAllMenus();
    const kind = item.dataset.save; const base = stripExt((currentTab() && currentTab().name) || 'document');
    if (kind === 'pdf') { toast('Choose "Save as PDF" in the print dialog', 'i-pdf'); setTimeout(() => window.print(), 300); return; }
    if (!currentSource) { toast('Open a document first', 'i-info'); return; }
    if (kind === 'md') { if (await saveFile(base + '.md', 'text/markdown', currentSource)) toast('Saved Markdown', 'i-check'); }
    else if (kind === 'html') { const html = await buildStandaloneHtml(); if (await saveFile(base + '.html', 'text/html', html)) toast('Saved HTML', 'i-check'); }
  });

  /* ================= screenshot ================= */
  function themeBg() { return getComputedStyle(el.body).backgroundColor; }
  async function shotCanvas(target, opts) {
    const w = (opts && opts.width) || target.scrollWidth || target.clientWidth;
    const h = (opts && opts.height) || target.scrollHeight || target.clientHeight;
    const MAX = 16000; // stay well under Chromium's canvas dimension limit so the PNG is valid
    let scale = Math.min(2, (window.devicePixelRatio || 1) + 0.5);
    if (w * scale > MAX) scale = MAX / w;
    if (h * scale > MAX) scale = MAX / h;
    scale = Math.max(0.4, Math.min(2.5, scale));
    return window.html2canvas(target, Object.assign({ backgroundColor: themeBg(), scale: scale, useCORS: true, logging: false }, opts || {}));
  }
  el.shotMenu.addEventListener('click', async (e) => {
    const item = e.target.closest('.menu-item'); if (!item) return; closeAllMenus();
    if (!currentSource) { toast('Open a document first', 'i-info'); return; }
    const kind = item.dataset.shot; const base = stripExt((currentTab() && currentTab().name) || 'document');
    toast('Rendering screenshot...', 'i-camera');
    try {
      let canvas;
      if (kind === 'copy-view') canvas = await shotCanvas(el.content, { y: el.contentScroll.scrollTop - el.content.offsetTop, height: el.contentScroll.clientHeight, windowHeight: el.contentScroll.clientHeight });
      else canvas = await shotCanvas(el.content);
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
      if (!blob) { toast('Document too large to capture', 'i-info'); return; }
      if (kind === 'save-doc') { if (await saveFile(base + '.png', 'image/png', blob)) toast('Screenshot saved', 'i-check'); }
      else { try { await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]); toast('Screenshot copied', 'i-check'); } catch (_) { if (await saveFile(base + '.png', 'image/png', blob)) toast('Clipboard blocked - saved instead', 'i-check'); } }
    } catch (err) { toast('Screenshot failed', 'i-info'); }
  });

  /* ================= modal prompt ================= */
  function promptModal(title, def, okLabel) {
    return new Promise((resolve) => {
      const t = el.modal.querySelector('.modal-title'); const inp = el.modal.querySelector('.modal-input'); const ok = $('#modal-ok'); const cancel = $('#modal-cancel');
      t.textContent = title; inp.value = def || ''; ok.textContent = okLabel || 'Save'; el.modal.hidden = false; setTimeout(() => { inp.focus(); inp.select(); }, 30);
      function done(v) { el.modal.hidden = true; ok.removeEventListener('click', okH); cancel.removeEventListener('click', caH); inp.removeEventListener('keydown', keyH); el.modal.removeEventListener('click', bgH); resolve(v); }
      function okH() { done(inp.value); } function caH() { done(null); }
      function keyH(e) { if (e.key === 'Enter') done(inp.value); else if (e.key === 'Escape') done(null); }
      function bgH(e) { if (e.target === el.modal) done(null); }
      ok.addEventListener('click', okH); cancel.addEventListener('click', caH); inp.addEventListener('keydown', keyH); el.modal.addEventListener('click', bgH);
    });
  }

  /* ================= find (in-page + all-files) ================= */
  let findHits = [], findIndex = -1, findAll = false, findCase = false, findQuery = '', findTimer = null;
  function escapeRegExp(s) { return (s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  function clearFindHighlights() {
    $$('mark.find-hit', el.content).forEach((m) => { const p = m.parentNode; if (!p) return; p.replaceChild(document.createTextNode(m.textContent), m); p.normalize(); });
    findHits = []; findIndex = -1;
  }
  function findInPage(q) {
    clearFindHighlights(); findQuery = q;
    if (!q) { updateFindCount(); return; }
    let re; try { re = new RegExp(escapeRegExp(q), findCase ? 'g' : 'gi'); } catch (_) { return; }
    const walker = document.createTreeWalker(el.content, NodeFilter.SHOW_TEXT, { acceptNode: (n) => { if (!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT; if (n.parentNode && n.parentNode.closest && n.parentNode.closest('.sec-anchor, .copy-code, .frontmatter > summary')) return NodeFilter.FILTER_REJECT; return NodeFilter.FILTER_ACCEPT; } });
    const nodes = []; let node; while ((node = walker.nextNode())) nodes.push(node);
    nodes.forEach((n) => {
      const text = n.nodeValue; re.lastIndex = 0; const ranges = []; let m;
      while ((m = re.exec(text)) !== null) { ranges.push([m.index, m.index + m[0].length]); if (m.index === re.lastIndex) re.lastIndex++; }
      if (!ranges.length) return;
      const frag = document.createDocumentFragment(); let last = 0;
      ranges.forEach(([s, e]) => { if (s > last) frag.appendChild(document.createTextNode(text.slice(last, s))); const mk = document.createElement('mark'); mk.className = 'find-hit'; mk.textContent = text.slice(s, e); frag.appendChild(mk); last = e; });
      if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
      n.parentNode.replaceChild(frag, n);
    });
    findHits = $$('mark.find-hit', el.content); findIndex = findHits.length ? 0 : -1; setCurrentHit(true); updateFindCount();
  }
  function setCurrentHit(scroll) {
    findHits.forEach((h, i) => h.classList.toggle('find-current', i === findIndex));
    if (scroll && findIndex >= 0 && findHits[findIndex]) {
      const hit = findHits[findIndex]; const cr = el.contentScroll.getBoundingClientRect(); const hr = hit.getBoundingClientRect();
      const target = Math.max(0, el.contentScroll.scrollTop + (hr.top - cr.top) - (cr.height / 2) + (hr.height / 2));
      const prev = el.contentScroll.style.scrollBehavior; el.contentScroll.style.scrollBehavior = 'auto';
      el.contentScroll.scrollTop = target;
      el.contentScroll.style.scrollBehavior = prev;
    }
  }
  function findNav(dir) { if (!findHits.length) return; findIndex = (findIndex + dir + findHits.length) % findHits.length; setCurrentHit(true); updateFindCount(); }
  function updateFindCount() { const c = $('#find-count'); if (!c) return; c.textContent = !findQuery ? '' : (findHits.length ? (findIndex + 1) + ' / ' + findHits.length : 'No results'); }
  async function findAllFiles(q) {
    const box = $('#find-results');
    if (!q || q.length < 2) { box.hidden = true; box.innerHTML = ''; return; }
    try {
      const data = await (await fetch('/api/search?q=' + encodeURIComponent(q))).json();
      box.hidden = false;
      if (!data.results.length) { box.innerHTML = '<div class="fr-empty">No matches in connected files</div>'; return; }
      box.innerHTML = '';
      data.results.forEach((res) => {
        const d = document.createElement('div'); d.className = 'fr-file'; d.title = res.path;
        d.innerHTML = '<div class="fr-name"><span class="fr-nm"></span>' + (res.count ? '<span class="fr-count">' + res.count + '</span>' : '') + '</div>' + (res.snippet ? '<div class="fr-snip"></div>' : '');
        d.querySelector('.fr-nm').textContent = stripExt(res.name); if (res.snippet) d.querySelector('.fr-snip').textContent = res.snippet;
        d.addEventListener('click', async () => { await openFile(res.path); findAll = false; $('#find-all').classList.remove('on'); box.hidden = true; $('#find-input').placeholder = 'Find in page'; setTimeout(() => findInPage(q), 160); });
        box.appendChild(d);
      });
    } catch (_) {}
  }
  function runFind() { const q = $('#find-input').value; if (findAll) { clearFindHighlights(); findAllFiles(q); } else { $('#find-results').hidden = true; findInPage(q); } }
  function openFind(allMode) {
    el.findbar.hidden = false; findAll = !!allMode; $('#find-all').classList.toggle('on', findAll);
    $('#find-input').placeholder = findAll ? 'Search all connected files' : 'Find in page';
    const sel = window.getSelection ? String(window.getSelection()).trim() : ''; const inp = $('#find-input');
    if (sel && sel.length && sel.length < 100 && !/\n/.test(sel)) inp.value = sel;
    inp.focus(); inp.select(); runFind();
  }
  function closeFind() { el.findbar.hidden = true; clearFindHighlights(); $('#find-results').hidden = true; findQuery = ''; }
  $('#find-input').addEventListener('input', () => { clearTimeout(findTimer); findTimer = setTimeout(runFind, 160); });
  $('#find-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); if (!findAll) findNav(e.shiftKey ? -1 : 1); } else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeFind(); } });
  $('#find-next').addEventListener('click', () => findNav(1));
  $('#find-prev').addEventListener('click', () => findNav(-1));
  $('#find-case').addEventListener('click', () => { findCase = !findCase; $('#find-case').classList.toggle('on', findCase); runFind(); $('#find-input').focus(); });
  $('#find-all').addEventListener('click', () => { findAll = !findAll; $('#find-all').classList.toggle('on', findAll); $('#find-input').placeholder = findAll ? 'Search all connected files' : 'Find in page'; runFind(); $('#find-input').focus(); });
  $('#find-close').addEventListener('click', closeFind);

  /* ================= keyboard ================= */
  window.addEventListener('keydown', (e) => {
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.key === 'b') { e.preventDefault(); el.sidebar.classList.toggle('hidden'); }
    else if (ctrl && e.key === 't') { e.preventDefault(); newBlankTab(); }
    else if (ctrl && e.key === 'w') { e.preventDefault(); if (activeTabId) closeTab(activeTabId); }
    else if (ctrl && e.shiftKey && (e.key === 'o' || e.key === 'O')) { e.preventDefault(); $('#btn-toc').click(); }
    else if (ctrl && (e.key === '=' || e.key === '+')) { e.preventDefault(); $('#btn-zoom-in').click(); }
    else if (ctrl && e.key === '-') { e.preventDefault(); $('#btn-zoom-out').click(); }
    else if (ctrl && e.key === '0') { e.preventDefault(); prefs.zoom = 1; applyZoom(); saveState(); }
    else if (ctrl && e.key === 's') { e.preventDefault(); toggleMenu(el.saveMenu); }
    else if (ctrl && e.key === 'd') { e.preventDefault(); toggleStar(currentPath); }
    else if (ctrl && (e.key === 'f' || e.key === 'F')) { e.preventDefault(); openFind(e.shiftKey); }
    else if (ctrl && (e.key === 'g' || e.key === 'G')) { e.preventDefault(); if (!el.findbar.hidden) findNav(e.shiftKey ? -1 : 1); }
    else if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); navBack(); }
    else if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); navFwd(); }
    else if (ctrl && e.key === 'Tab') { e.preventDefault(); const i = tabs.findIndex((t) => t.id === activeTabId); if (tabs.length) activateTab(tabs[(i + (e.shiftKey ? -1 : 1) + tabs.length) % tabs.length].id); }
    else if (e.key === 'Escape') { closeAllMenus(); if (!el.findbar.hidden) closeFind(); else closeSidebarOverlay(); }
  });

  /* ================= drag & drop files ================= */
  ['dragenter', 'dragover'].forEach((ev) => window.addEventListener(ev, (e) => { if (e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')) { e.preventDefault(); el.body.classList.add('dragging'); } }));
  ['dragleave', 'drop'].forEach((ev) => window.addEventListener(ev, (e) => { if (ev === 'dragleave' && e.relatedTarget) return; el.body.classList.remove('dragging'); }));
  window.addEventListener('drop', (e) => {
    if (!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return; e.preventDefault();
    const f = e.dataTransfer.files[0]; const reader = new FileReader();
    reader.onload = () => {
      const cur = currentTab();
      let t;
      if (cur && !cur.path && !cur.source && !cur.ephemeral) { t = cur; t.name = f.name; t.source = String(reader.result); t.ephemeral = true; t.mtime = f.lastModified || 0; } // reuse an empty "New tab"
      else t = createTab({ name: f.name, source: String(reader.result), ephemeral: true, mtime: f.lastModified || 0 });
      activeTabId = t.id; renderTab(t); renderTabs();
    };
    reader.readAsText(f);
  });

  /* ================= open folder ================= */
  function popEl(node) { if (!node) return; node.classList.remove('pop'); void node.offsetWidth; node.classList.add('pop'); }
  function retrigger(node, cls) { if (!node) return; node.classList.remove(cls); void node.offsetWidth; node.classList.add(cls); }
  // primary: native folder picker via the host (no browser permission prompt); the host adds it as a root
  async function openFolder() {
    if (window.chrome && window.chrome.webview) { hostPost({ cmd: 'pickFolder' }); return; }        // Windows native host
    if (window.__electron && window.__electron.pickFolder) {                                          // macOS Electron host
      try { const added = await window.__electron.pickFolder(); if (added) { showPanel('files'); await loadTree(); toast('Folder added', 'i-check'); saveState(); } } catch (_) {}
      return;
    }
    if (window.__android && window.__android.pickFolder) { window.__android.pickFolder(); return; }    // Android (system folder picker -> __folderAdded)
    if (!window.showDirectoryPicker) { toast('Folder picking needs the app window', 'i-info'); return; }
    try {
      const dir = await window.showDirectoryPicker(); const files = []; await walkDir(dir, '', files); files.sort((a, b) => a.name.localeCompare(b.name));
      showPanel('files'); el.tree.innerHTML = ''; const lbl = document.createElement('div'); lbl.className = 'root-label'; lbl.textContent = dir.name + ' (picked)'; el.tree.appendChild(lbl);
      files.forEach((it) => { const wrap = document.createElement('div'); wrap.className = 'tree-item'; const row = document.createElement('div'); row.className = 'row'; row.innerHTML = '<span class="twist"></span><span class="ico">' + svg('i-file') + '</span><span class="label"></span>'; row.querySelector('.label').textContent = stripExt(it.name); row.title = it.rel; row.addEventListener('click', async () => { const file = await it.handle.getFile(); const text = await file.text(); const t = createTab({ name: it.name, source: text, ephemeral: true, mtime: file.lastModified || 0 }); activeTabId = t.id; renderTab(t); renderTabs(); }); wrap.appendChild(row); el.tree.appendChild(wrap); });
    } catch (_) {}
  }
  // Open a single .md file (without adding its whole folder to the sidebar).
  async function openSingleFile() {
    if (window.chrome && window.chrome.webview) { hostPost({ cmd: 'pickFile' }); return; }            // Windows: host shows a file dialog, then calls __externalOpen
    if (window.__electron && window.__electron.pickFile) {                                             // macOS Electron host
      try { const p = await window.__electron.pickFile(); if (p) await openFile(p); } catch (_) {}
      return;
    }
    if (window.__android && window.__android.pickFile) { window.__android.pickFile(); return; }        // Android (system file picker -> __externalOpen)
    if (window.showOpenFilePicker) {                                                                   // browser fallback
      try {
        const [h] = await window.showOpenFilePicker({ types: [{ description: 'Markdown', accept: { 'text/markdown': ['.md', '.markdown', '.mdown', '.mkd', '.txt'] } }] });
        const file = await h.getFile(); const text = await file.text();
        const t = createTab({ name: file.name, source: text, ephemeral: true, mtime: file.lastModified || 0 }); activeTabId = t.id; renderTab(t); renderTabs();
      } catch (_) {}
      return;
    }
    toast('Opening a file needs the app window', 'i-info');
  }
  $('#btn-openfolder').addEventListener('click', openFolder);
  $('#btn-welcome-open').addEventListener('click', openFolder);
  $('#btn-openfile').addEventListener('click', openSingleFile);
  $('#btn-welcome-openfile').addEventListener('click', openSingleFile);
  $('#btn-welcome-search').addEventListener('click', () => { el.sidebar.classList.remove('hidden'); showPanel('files'); setTimeout(() => { el.search.focus(); el.search.select(); }, 40); });
  // called by the native host after it adds a folder as a root
  window.__folderAdded = function () { showPanel('files'); loadTree().then(() => toast('Folder added', 'i-check')); };
  async function walkDir(dir, prefix, out, depth = 0) { if (depth > 8 || out.length > 2000) return; for await (const [name, handle] of dir.entries()) { if (name.startsWith('.')) continue; if (handle.kind === 'file') { if (/\.(md|markdown|txt)$/i.test(name)) out.push({ name, rel: prefix + name, handle }); } else await walkDir(handle, prefix + name + '/', out, depth + 1); } }

  /* ================= heartbeat + SSE ================= */
  let pingFails = 0;
  function showLost(show) { let b = document.getElementById('lost-banner'); if (show) { if (!b) { b = document.createElement('div'); b.id = 'lost-banner'; b.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:var(--cal-caution);color:#fff;font-size:13px;text-align:center;padding:8px'; b.textContent = 'The viewer engine stopped. Close this window and reopen Shepherd Markdown.'; document.body.appendChild(b); } } else if (b) b.remove(); }
  function ping() { fetch('/api/ping').then(() => { pingFails = 0; showLost(false); }).catch(() => { if (++pingFails >= 3) showLost(true); }); }
  setInterval(ping, 20000); ping();
  document.addEventListener('visibilitychange', () => { if (!document.hidden) ping(); });
  window.addEventListener('pagehide', () => { beaconSave(); });
  window.addEventListener('beforeunload', () => { beaconSave(); });
  function hostPost(obj) { try { if (window.chrome && window.chrome.webview) window.chrome.webview.postMessage(obj); } catch (_) {} }
  function focusHost() { hostPost({ cmd: 'focus' }); }
  function cssColorVar(name) { const p = document.createElement('span'); p.style.cssText = 'color:var(' + name + ');display:none'; document.body.appendChild(p); const c = getComputedStyle(p).color; p.remove(); const m = (c || '').match(/\d+/g); return m ? [+m[0], +m[1], +m[2]] : [0, 0, 0]; }
  function sendTitleTheme() { hostPost({ cmd: 'theme', bg: cssColorVar('--bg-2'), fg: cssColorVar('--fg') }); }

  /* ---- custom window frame: buttons always work; drag/resize drive the native loop in the host ---- */
  (function initWinFrame() {
    const isHosted = () => !!(window.chrome && window.chrome.webview);
    const winCmd = (action, extra) => hostPost(Object.assign({ cmd: 'win', action: action }, extra || {}));
    const bind = (id, action) => { const b = $('#' + id); if (b) b.addEventListener('click', (e) => { e.preventDefault(); winCmd(action); }); };
    bind('win-min', 'min'); bind('win-max', 'max'); bind('win-close', 'close');

    const tb = $('#titlebar');
    let lastDown = 0;
    if (tb) tb.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || e.target.closest('.winbtn')) return;
      const now = e.timeStamp || Date.now();
      if (now - lastDown < 420) { lastDown = 0; winCmd('max'); return; } // double-click title = maximize/restore
      lastDown = now;
      const sx = e.screenX, sy = e.screenY; let started = false;
      const move = (m) => { if (!started && (Math.abs(m.screenX - sx) > 4 || Math.abs(m.screenY - sy) > 4)) { started = true; done(); winCmd('drag'); } };
      const done = () => { document.removeEventListener('mousemove', move, true); document.removeEventListener('mouseup', done, true); };
      document.addEventListener('mousemove', move, true);
      document.addEventListener('mouseup', done, true);
    });

    $$('#winresize .rz').forEach((h) => h.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return; e.preventDefault(); winCmd('resize', { edge: h.dataset.edge });
    }));

    // host pushes the maximize state so we can swap the glyph and disable edge-resize
    window.__winState = function (state) {
      const max = state === 'max';
      document.body.classList.toggle('win-max', max);
      const b = $('#win-max'); if (!b) return;
      b.title = max ? 'Restore' : 'Maximize';
      const u = b.querySelector('use'); if (u) u.setAttribute('href', max ? '#i-win-restore' : '#i-win-max');
    };

    // if not running inside the native host (e.g. plain browser), hide the custom frame
    if (!isHosted()) { const t = $('#titlebar'); if (t) t.style.display = 'none'; const r = $('#winresize'); if (r) r.style.display = 'none'; }
  })();
  // The in-process host delivers "open this file" / "focus" from other launches by calling this directly.
  function connectSSE() { window.__externalOpen = function (p) { try { if (p) openFile(p); } catch (_) {} }; } // no forced newTab: reuses an empty current tab, else opens a new one

  /* ================= boot ================= */
  function hideSplash() { el.splash.classList.add('gone'); setTimeout(() => el.splash.remove(), 500); }
  async function boot() {
    buildThemeMenu();
    let st = {};
    try { st = await (await fetch('/api/state')).json(); } catch (_) {}
    if (st.prefs) Object.assign(prefs, st.prefs);
    stars = new Set(st.stars || []); historyList = st.history || []; sessions = st.sessions || []; groups = st.groups || [];
    (prefs.expanded || []).forEach((p) => expanded.add(p));
    (prefs.collapsedRoots || []).forEach((p) => collapsedRoots.add(p));
    applyTheme(); applyZoom(); applyWidth(); applySideW();
    try { new ResizeObserver(updateTocFit).observe(el.contentScroll); } catch (_) {} window.addEventListener('resize', updateTocFit); updateTocFit(); setTimeout(updateTocFit, 400);
    $('#btn-toc').classList.toggle('on', prefs.tocOn);
    const started = performance.now();
    await loadTree();
    showPanel(prefs.view || 'files');

    // restore tabs
    (st.tabs || []).forEach((t) => { if (t.path) createTab({ path: t.path, name: basename(t.path), hash: t.hash || null, groupId: t.groupId || null }); });
    normalizeGroups();
    let cfg = {}; try { cfg = await (await fetch('/api/config')).json(); } catch (_) {}
    if (cfg.initialFile) { await openFile(cfg.initialFile, { newTab: true }); }
    else if (tabs.length) { const active = tabs.find((t) => t.path === st.activePath) || tabs[0]; await activateTab(active.id); }
    else { renderTab(null); }
    renderTabs();
    hydrating = false;
    connectSSE();
    const wait = Math.max(0, 550 - (performance.now() - started));
    setTimeout(hideSplash, wait);
  }
  boot();
})();
