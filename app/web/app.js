'use strict';

/* ================================================================ utils */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const api = () => window.pywebview.api;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtN = (n) => (n == null ? '' : Number(n).toLocaleString());
const fmtMs = (ms) => (ms == null ? '' : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`);
const fmtBytes = (b) => (b == null ? '' : b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(0)} KB` : `${(b / 1048576).toFixed(1)} MB`);
const basename = (p) => String(p || '').split(/[\\/]/).pop();
const el = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

function timeAgo(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(ts).toLocaleString();
}

function quoteIdent(name) {
  if (/^[a-z_][a-z0-9_]*$/.test(name) && !S.reserved.has(name.toUpperCase())) return name;
  return '"' + String(name).replace(/"/g, '""') + '"';
}

function safeFileName(s) {
  return String(s || 'results').replace(/[\\/:*?"<>|]+/g, '_').trim() || 'results';
}

/** Split SQL on top-level semicolons; mirrors engine.split_statements. */
function splitStatements(sql) {
  const pieces = [];
  let start = 0, i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i];
    if (ch === '-' && sql[i + 1] === '-') { const j = sql.indexOf('\n', i); i = j < 0 ? n : j + 1; continue; }
    if (ch === '/' && sql[i + 1] === '*') { const j = sql.indexOf('*/', i + 2); i = j < 0 ? n : j + 2; continue; }
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < n) { if (sql[j] === ch) { if (sql[j + 1] === ch) { j += 2; continue; } break; } j++; }
      i = j + 1; continue;
    }
    if (ch === ';') { pieces.push({ start, end: i }); start = i + 1; }
    i++;
  }
  pieces.push({ start, end: n });
  return pieces
    .map((p) => ({ ...p, text: sql.slice(p.start, p.end) }))
    .filter((p) => p.text.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, '').trim());
}

/* ================================================================ state */

const S = {
  tabs: [],
  activeId: null,
  seq: 1,
  history: [],
  saved: [],
  settings: { theme: null, sideWidth: 280, editorHeight: null, sidePanel: 'tables', importOptions: null },
  projectPath: null,
  schema: [],
  functions: [],
  keywords: [],
  reserved: new Set(),
  expanded: new Set(),
  changed: new Set(),
};

let editor = null;
let grid = null;
let runTimer = null;

const activeTab = () => S.tabs.find((t) => t.id === S.activeId);

const saveState = debounce(() => {
  const state = {
    version: 1,
    tabs: S.tabs.map((t) => ({ id: t.id, title: t.title, sql: t.model ? t.model.getValue() : t.sql })),
    activeId: S.activeId,
    seq: S.seq,
    history: S.history.slice(0, 300),
    saved: S.saved,
    settings: S.settings,
    projectPath: S.projectPath,
    expanded: [...S.expanded],
  };
  api().save_state(state);
}, 600);

/* ================================================================ UI helpers */

function toast(message, type = 'info', { actions = [], timeout } = {}) {
  const t = el(`<div class="toast ${type}"><div class="msg"></div></div>`);
  $('.msg', t).textContent = message;
  for (const a of actions) {
    const b = el(`<button class="btn small"></button>`);
    b.textContent = a.label;
    b.onclick = () => { a.fn(); t.remove(); };
    t.appendChild(b);
  }
  const x = el(`<button class="btn small icon" title="Dismiss">✕</button>`);
  x.onclick = () => t.remove();
  t.appendChild(x);
  $('#toasts').appendChild(t);
  const ms = timeout ?? (type === 'error' ? 12000 : actions.length ? 10000 : 4000);
  if (ms) setTimeout(() => t.remove(), ms);
  return t;
}

function showBusy(text) {
  $('#busy-text').textContent = text || 'Working…';
  $('#busy').hidden = false;
}
function hideBusy() { $('#busy').hidden = true; }

function modal({ title, body, buttons = [], narrow = false, onOpen }) {
  return new Promise((resolve) => {
    const back = el(`<div class="modal-back"><div class="modal ${narrow ? 'narrow' : ''}">
      <header><span></span><button class="x" title="Close">✕</button></header>
      <div class="body"></div><footer></footer></div></div>`);
    $('header span', back).textContent = title;
    const bodyEl = $('.body', back);
    if (typeof body === 'string') bodyEl.innerHTML = body; else if (body) bodyEl.appendChild(body);
    const close = (value) => { back.remove(); document.removeEventListener('keydown', onKey, true); resolve(value); };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(null); }
      if (e.key === 'Enter' && !e.shiftKey && e.target.tagName !== 'TEXTAREA' && e.target.tagName !== 'BUTTON') {
        const primary = buttons.find((b) => b.primary);
        if (primary) { e.preventDefault(); e.stopPropagation(); run(primary); }
      }
    };
    const run = async (b) => {
      const v = b.action ? await b.action(bodyEl) : b.value;
      if (v !== false) close(v === undefined ? true : v);
    };
    $('header .x', back).onclick = () => close(null);
    back.addEventListener('mousedown', (e) => { if (e.target === back) close(null); });
    for (const b of buttons) {
      const btn = el(`<button class="btn ${b.primary ? 'primary' : ''}"></button>`);
      btn.textContent = b.label;
      btn.onclick = () => run(b);
      $('footer', back).appendChild(btn);
    }
    if (!buttons.length) $('footer', back).remove();
    document.addEventListener('keydown', onKey, true);
    $('#modal-root').appendChild(back);
    if (onOpen) onOpen(bodyEl);
    else { const inp = $('input, select', bodyEl); if (inp) inp.focus(); }
  });
}

async function promptText(title, label, value = '') {
  const body = el(`<div><label>${esc(label)}<input type="text" spellcheck="false"></label></div>`);
  const input = $('input', body);
  input.value = value;
  return modal({
    title, body, narrow: true,
    buttons: [{ label: 'Cancel', value: null }, { label: 'OK', primary: true, action: () => input.value.trim() || false }],
    onOpen: () => { input.focus(); input.select(); },
  });
}

const confirmBox = (title, text, okLabel = 'OK') =>
  modal({ title, body: `<p>${esc(text)}</p>`, narrow: true, buttons: [{ label: 'Cancel', value: false }, { label: okLabel, primary: true, value: true }] })
    .then((v) => v === true);

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('Copied to clipboard', 'ok', { timeout: 1500 }); }
  catch { toast('Could not access the clipboard', 'error'); }
}

/* ================================================================ theme & layout */

function isDark() {
  const t = S.settings.theme;
  return t ? t === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
}
function applyTheme() {
  document.documentElement.dataset.theme = isDark() ? 'dark' : 'light';
  if (window.monaco) monaco.editor.setTheme(isDark() ? 'vs-dark' : 'vs');
}

function setupResizers() {
  const side = $('#sidebar');
  side.style.width = S.settings.sideWidth + 'px';
  if (S.settings.editorHeight) $('#editor').style.height = S.settings.editorHeight + 'px';

  const drag = (handle, onMove, onDone) => {
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      handle.classList.add('drag');
      const move = (ev) => onMove(ev);
      const up = () => { handle.classList.remove('drag'); document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); onDone(); };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
  };
  drag($('#side-resizer'), (e) => {
    side.style.width = Math.min(Math.max(e.clientX, 180), 600) + 'px';
  }, () => { S.settings.sideWidth = side.offsetWidth; saveState(); });
  drag($('#work-resizer'), (e) => {
    const top = $('#editor').getBoundingClientRect().top;
    const max = $('#work').getBoundingClientRect().bottom - 120;
    $('#editor').style.height = Math.min(Math.max(e.clientY - top, 80), max - top) + 'px';
  }, () => { S.settings.editorHeight = $('#editor').offsetHeight; saveState(); if (grid) grid.redraw(); });
}

/* ================================================================ monaco */

function loadMonaco() {
  return new Promise((resolve) => {
    require.config({ paths: { vs: 'vendor/monaco/vs' } });
    require(['vs/editor/editor.main'], () => resolve());
  });
}

function setupEditor() {
  editor = monaco.editor.create($('#editor'), {
    model: null,
    theme: isDark() ? 'vs-dark' : 'vs',
    automaticLayout: true,
    minimap: { enabled: false },
    fontFamily: 'Cascadia Mono, Consolas, monospace',
    fontSize: 13,
    tabSize: 2,
    scrollBeyondLastLine: false,
    fixedOverflowWidgets: true,
    wordBasedSuggestions: 'off',
    quickSuggestions: { other: true, comments: false, strings: false },
    suggest: { showWords: false },
    renderLineHighlight: 'line',
    padding: { top: 6 },
  });
  editor.onDidChangeCursorPosition((e) => {
    $('#status-right').textContent = `Ln ${e.position.lineNumber}, Col ${e.position.column} · DuckDB SQL`;
  });

  monaco.languages.registerCompletionItemProvider('sql', { triggerCharacters: ['.'], provideCompletionItems: provideCompletions });
  monaco.languages.registerDocumentFormattingEditProvider('sql', {
    provideDocumentFormattingEdits: (model) => formatEdits(model, model.getFullModelRange()),
  });
  monaco.languages.registerDocumentRangeFormattingEditProvider('sql', {
    provideDocumentRangeFormattingEdits: (model, range) => formatEdits(model, range),
  });
}

function formatEdits(model, range) {
  try {
    const text = sqlFormatter.format(model.getValueInRange(range), { language: 'duckdb', keywordCase: 'upper', tabWidth: 2 });
    return [{ range, text }];
  } catch (e) {
    toast('Could not format: ' + e.message, 'error');
    return [];
  }
}

/** Teach Monaco's SQL highlighter DuckDB's keywords and functions. */
async function extendSqlHighlighting() {
  try {
    const lang = monaco.languages.getLanguages().find((l) => l.id === 'sql');
    const mod = await lang.loader();
    const def = mod.language;
    const kw = new Set(def.keywords.map((k) => k.toUpperCase()));
    S.keywords.forEach((k) => kw.add(k));
    def.keywords = [...kw];
    const fn = new Set(def.builtinFunctions.map((f) => f.toUpperCase()));
    S.functions.forEach((f) => fn.add(f.toUpperCase()));
    def.builtinFunctions = [...fn];
    monaco.languages.setMonarchTokensProvider('sql', def);
  } catch (e) {
    console.warn('highlighting extension failed', e);
  }
}

const NOT_ALIAS = new Set(['where', 'on', 'join', 'left', 'right', 'inner', 'outer', 'full', 'cross', 'natural', 'group', 'order',
  'limit', 'qualify', 'having', 'window', 'union', 'except', 'intersect', 'using', 'as', 'positional', 'asof', 'anti', 'semi',
  'lateral', 'pivot', 'unpivot', 'offset', 'set', 'values', 'select', 'returning']);

function unquote(s) { return s.startsWith('"') ? s.slice(1, -1).replace(/""/g, '"') : s; }

function findTable(name) {
  if (!name) return null;
  const n = name.toLowerCase();
  return S.schema.find((t) => t.name.toLowerCase() === n) || null;
}

function referencedTables(text) {
  const aliases = {};
  const re = /\b(?:from|join)\s+("(?:[^"]|"")+"|[A-Za-z_][\w]*)(?:\s+(?:as\s+)?("(?:[^"]|"")+"|[A-Za-z_]\w*))?/gi;
  let m;
  while ((m = re.exec(text))) {
    const table = findTable(unquote(m[1]));
    if (!table) continue;
    aliases[table.name.toLowerCase()] = table;
    if (m[2] && !NOT_ALIAS.has(m[2].toLowerCase())) aliases[unquote(m[2]).toLowerCase()] = table;
  }
  return aliases;
}

function provideCompletions(model, position) {
  const word = model.getWordUntilPosition(position);
  const range = { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber, startColumn: word.startColumn, endColumn: word.endColumn };
  const before = model.getLineContent(position.lineNumber).slice(0, word.startColumn - 1);
  const K = monaco.languages.CompletionItemKind;
  const aliases = referencedTables(model.getValue());

  const dot = before.match(/("(?:[^"]|"")+"|[A-Za-z_]\w*)\.$/);
  if (dot) {
    const table = aliases[unquote(dot[1]).toLowerCase()] || findTable(unquote(dot[1]));
    if (!table) return { suggestions: [] };
    return {
      suggestions: table.columns.map((c, i) => ({
        label: c.name, kind: K.Field, detail: c.type, insertText: quoteIdent(c.name), range, sortText: String(i).padStart(4, '0'),
      })),
    };
  }

  const out = [];
  const inQuery = new Set(Object.values(aliases).map((t) => t.name));
  for (const t of S.schema) {
    out.push({ label: t.name, kind: K.Class, detail: `${t.type} · ${fmtN(t.rows)} rows`, insertText: quoteIdent(t.name), range, sortText: '1' + t.name });
    for (const c of t.columns) {
      out.push({
        label: { label: c.name, description: t.name },
        kind: K.Field, detail: `${c.type} (${t.name})`, insertText: quoteIdent(c.name), range,
        sortText: (inQuery.has(t.name) ? '0' : '3') + c.name,
      });
    }
  }
  for (const k of S.keywords) out.push({ label: k, kind: K.Keyword, insertText: k, range, sortText: '4' + k });
  for (const f of S.functions) {
    out.push({
      label: f, kind: K.Function, insertText: f + '($0)', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
      range, sortText: '5' + f,
    });
  }
  return { suggestions: out };
}

function insertAtCursor(text) {
  editor.focus();
  const sel = editor.getSelection();
  editor.executeEdits('insert', [{ range: sel, text, forceMoveMarkers: true }]);
}

/* ================================================================ tabs */

function newTab({ title, sql = '', activate = true } = {}) {
  const id = 't' + S.seq++;
  const tab = { id, title: title || `Query ${id.slice(1)}`, sql, model: monaco.editor.createModel(sql, 'sql'), result: null, error: null, message: null, running: false };
  tab.model.onDidChangeContent(() => saveState());
  S.tabs.push(tab);
  if (activate) activateTab(id);
  renderTabs();
  saveState();
  return tab;
}

function activateTab(id) {
  const prev = activeTab();
  if (prev && editor) prev.viewState = editor.saveViewState();
  S.activeId = id;
  const tab = activeTab();
  editor.setModel(tab.model);
  if (tab.viewState) editor.restoreViewState(tab.viewState);
  editor.focus();
  renderTabs();
  renderResults();
  updateToolbar();
  saveState();
}

async function closeTab(id) {
  const idx = S.tabs.findIndex((t) => t.id === id);
  if (idx < 0) return;
  const tab = S.tabs[idx];
  if (tab.running) api().cancel_query(tab.id);
  if (tab.result) api().discard_result(tab.result.rid);
  S.tabs.splice(idx, 1);
  if (!S.tabs.length) newTab({ activate: false });
  if (S.activeId === id) activateTab(S.tabs[Math.min(idx, S.tabs.length - 1)].id);
  tab.model.dispose();
  renderTabs();
  saveState();
}

function renderTabs() {
  const list = $('#tab-list');
  list.innerHTML = '';
  for (const t of S.tabs) {
    const node = el(`<div class="tab ${t.id === S.activeId ? 'active' : ''} ${t.running ? 'running' : ''}" title="Double-click to rename">
      <span class="dot"></span><span class="t"></span><button class="close" title="Close (Ctrl+W)">✕</button></div>`);
    $('.t', node).textContent = t.title;
    node.onclick = (e) => { if (!e.target.closest('.close') && t.id !== S.activeId) activateTab(t.id); };
    node.onauxclick = (e) => { if (e.button === 1) closeTab(t.id); };
    $('.close', node).onclick = () => closeTab(t.id);
    $('.t', node).ondblclick = () => renameTabInline(t, node);
    list.appendChild(node);
  }
  const active = $('.tab.active', list);
  if (active) active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function renameTabInline(tab, node) {
  const input = el('<input type="text" spellcheck="false">');
  input.value = tab.title;
  $('.t', node).replaceWith(input);
  input.focus();
  input.select();
  const done = (save) => {
    if (save && input.value.trim()) tab.title = input.value.trim();
    renderTabs();
    saveState();
  };
  input.onkeydown = (e) => { if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); e.stopPropagation(); };
  input.onblur = () => done(true);
}

function openInTab(title, sql, run = false) {
  const cur = activeTab();
  const reuse = cur && !cur.model.getValue().trim() && !cur.result && !cur.running;
  const tab = reuse ? cur : newTab({ title, sql });
  if (reuse) { tab.title = title; tab.model.setValue(sql); renderTabs(); }
  if (run) runQuery('all');
  return tab;
}

/* ================================================================ running queries */

function updateToolbar() {
  const tab = activeTab();
  $('#btn-run').disabled = !tab || tab.running;
  $('#btn-run-stmt').disabled = !tab || tab.running;
  $('#btn-stop').disabled = !tab || !tab.running;
  const hasResult = !!(tab && tab.result);
  $$('#menu-export [data-action^="export-"]').forEach((b) => {
    if (b.dataset.action !== 'export-all') b.disabled = !hasResult;
  });
  $('[data-action="export-all"]').disabled = !S.tabs.some((t) => t.result);
}

function statementAtCursor(model, position) {
  const text = model.getValue();
  const offset = model.getOffsetAt(position);
  const parts = splitStatements(text);
  if (!parts.length) return null;
  let found = parts.find((p) => offset >= p.start && offset <= p.end + 1);
  if (!found) found = [...parts].reverse().find((p) => p.end < offset) || parts[0];
  return found;
}

function flashRange(model, startOffset, endOffset) {
  const s = model.getPositionAt(startOffset);
  const e = model.getPositionAt(endOffset);
  const ids = editor.deltaDecorations([], [{
    range: new monaco.Range(s.lineNumber, s.column, e.lineNumber, e.column),
    options: { className: 'run-flash', isWholeLine: false },
  }]);
  setTimeout(() => editor.deltaDecorations(ids, []), 450);
}

async function runQuery(mode = 'auto') {
  const tab = activeTab();
  if (!tab || tab.running) return;
  const model = tab.model;
  let sql;
  let startOffset = 0;
  const sel = editor.getSelection();
  if (mode === 'statement') {
    const st = statementAtCursor(model, editor.getPosition());
    if (!st) return toast('Nothing to run', 'warn');
    sql = st.text;
    startOffset = st.start;
    flashRange(model, st.start, st.end);
  } else if (mode === 'auto' && sel && !sel.isEmpty()) {
    sql = model.getValueInRange(sel);
    startOffset = model.getOffsetAt(sel.getStartPosition());
  } else {
    sql = model.getValue();
  }
  if (!splitStatements(sql).length) return toast('Nothing to run — write a query first', 'warn');

  monaco.editor.setModelMarkers(model, 'duckdb', []);
  tab.running = true;
  tab.runStarted = Date.now();
  tab.error = null;
  tab.message = null;
  renderTabs();
  updateToolbar();
  if (tab.id === S.activeId) renderResults();
  clearInterval(runTimer);
  runTimer = setInterval(() => { const t = activeTab(); if (t && t.running) renderResultStatus(); }, 250);

  const res = await api().run_query(tab.id, sql);

  tab.running = false;
  if (!S.tabs.some((t) => t.running)) clearInterval(runTimer);
  const entry = { sql: sql.trim(), ts: Date.now(), ms: res.elapsed_ms, ok: res.ok, tab: tab.title };
  if (res.ok) {
    if (tab.result) api().discard_result(tab.result.rid);
    tab.result = res.result_id
      ? { rid: res.result_id, columns: res.columns, total: res.total_rows, filtered: null, elapsed: res.elapsed_ms, statements: res.statements, sort: [], filters: [] }
      : null;
    tab.message = res.result_id ? null : `✓ ${res.message || 'Done'} · ${res.statements} statement(s) · ${fmtMs(res.elapsed_ms)}`;
    entry.rows = res.total_rows;
    if (res.schema_changed) refreshSchema();
  } else {
    tab.error = { message: res.error, line: null, column: null };
    entry.error = res.error.split('\n')[0];
    if (res.line) {
      const base = model.getPositionAt(startOffset);
      const line = base.lineNumber + res.line - 1;
      const column = res.line === 1 ? base.column + (res.column || 1) - 1 : res.column || 1;
      tab.error.line = line;
      tab.error.column = column;
      const word = model.getWordAtPosition({ lineNumber: line, column });
      monaco.editor.setModelMarkers(model, 'duckdb', [{
        startLineNumber: line, startColumn: column, endLineNumber: line,
        endColumn: word ? word.endColumn : column + 1,
        message: res.error, severity: monaco.MarkerSeverity.Error,
      }]);
    }
  }
  addHistory(entry);
  renderTabs();
  updateToolbar();
  if (tab.id === S.activeId) renderResults();
  else if (!res.ok || res.result_id) toast(`"${tab.title}" finished${res.ok ? '' : ' with an error'}`, res.ok ? 'ok' : 'error');
}

function cancelQuery() {
  const tab = activeTab();
  if (tab && tab.running) api().cancel_query(tab.id);
}

/* ================================================================ results grid */

function renderResultStatus() {
  const tab = activeTab();
  const st = $('#result-status');
  if (!tab) { st.textContent = ''; return; }
  if (tab.running) {
    st.innerHTML = `<span class="spinner" style="display:inline-block;vertical-align:-3px;width:13px;height:13px"></span>&nbsp; Running… ${fmtMs(Date.now() - tab.runStarted)}`;
    return;
  }
  const r = tab.result;
  if (r) {
    const filtered = r.filtered != null && r.filtered !== r.total && r.filters.length;
    st.innerHTML = `<b>${fmtN(r.total)}</b> row${r.total === 1 ? '' : 's'} · ${r.columns.length} columns · ${fmtMs(r.elapsed)}`
      + (r.statements > 1 ? ` · ${r.statements} statements` : '')
      + (filtered ? ` · <b>${fmtN(r.filtered)}</b> match filters` : '');
  } else if (tab.error) {
    st.innerHTML = '<span class="error-text">Query failed</span>';
  } else {
    st.textContent = '';
  }
  const hasView = r && (r.filters.length || r.sort.length);
  $('#btn-clear-filters').classList.toggle('hidden', !hasView);
  $('#btn-quick-csv').classList.toggle('hidden', !r);
  $('#btn-quick-xlsx').classList.toggle('hidden', !r);
}

function destroyGrid() {
  if (grid) { try { grid.destroy(); } catch { /* ignore */ } grid = null; }
  $('#grid').innerHTML = '';
}

function renderResults() {
  const tab = activeTab();
  destroyGrid();
  const errBox = $('#result-error');
  const msgBox = $('#result-message');
  const empty = $('#empty-state');
  errBox.hidden = true;
  msgBox.hidden = true;
  empty.hidden = true;
  renderResultStatus();
  if (!tab) return;

  if (tab.error) {
    errBox.hidden = false;
    errBox.textContent = tab.error.message;
    if (tab.error.line) {
      const b = el(`<div><button class="btn small goto">Go to line ${tab.error.line}</button></div>`);
      $('button', b).onclick = () => {
        editor.revealLineInCenter(tab.error.line);
        editor.setPosition({ lineNumber: tab.error.line, column: tab.error.column || 1 });
        editor.focus();
      };
      errBox.appendChild(b);
    }
  }
  if (tab.message) { msgBox.hidden = false; msgBox.textContent = tab.message; }
  if (tab.result && !tab.running) { buildGrid(tab); return; }
  if (!tab.error && !tab.message && !tab.running) {
    empty.hidden = false;
    empty.innerHTML = S.schema.length
      ? `<div>Write a query and press <b>Ctrl+Enter</b> to run it.<br>Try <code>SELECT * FROM ${esc(quoteIdent(S.schema[0].name))} LIMIT 100</code></div>`
      : `<div><img class="logo" src="logo.png" alt=""><br><b>Quack!</b> No tables yet. <b>Open files…</b> or drag CSV / Excel files onto this window.<br>Each file (and each Excel sheet) becomes a table you can query.</div>`;
  }
}

function cellFormatter(cell) {
  const v = cell.getValue();
  if (v === null || v === undefined) return '<span class="cell-null">NULL</span>';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return esc(v);
}

function buildGrid(tab) {
  const r = tab.result;
  const rid = r.rid;
  const columns = r.columns.map((c, i) => ({
    title: c.name,
    field: 'c' + i,
    titleFormatter: () => `${esc(c.name)}<span class="col-type">${esc(c.type)}</span>`,
    hozAlign: c.numeric ? 'right' : 'left',
    formatter: cellFormatter,
    headerFilter: 'input',
    headerFilterPlaceholder: c.numeric ? '> 10, = 5…' : 'contains…',
    headerFilterFunc: () => true,
    headerContextMenu: [
      { label: 'Profile this column', action: () => profileColumn({ result_id: rid }, c.name) },
      { label: 'Copy column name', action: () => copyText(c.name) },
      { separator: true },
      { label: 'Hide column', action: (e, col) => col.hide() },
      { label: 'Show all columns', action: () => grid.getColumns().forEach((col) => col.show()) },
    ],
    contextMenu: [
      { label: 'Copy value', action: (e, cell) => copyText(cell.getValue() == null ? '' : String(cell.getValue())) },
      { label: 'Filter to this value', action: (e, cell) => cell.getColumn().setHeaderFilterValue(cell.getValue() == null ? 'null' : '=' + cell.getValue()) },
      { label: 'Exclude this value', action: (e, cell) => cell.getColumn().setHeaderFilterValue(cell.getValue() == null ? 'not null' : '!=' + cell.getValue()) },
    ],
  }));

  grid = new Tabulator('#grid', {
    height: '100%',
    layout: 'fitData',
    renderHorizontal: columns.length > 40 ? 'virtual' : 'basic',
    placeholder: 'No rows',
    columns,
    columnDefaults: { maxWidth: 420, minWidth: 60, headerSortTristate: true, resizable: true },
    headerSortClickElement: 'icon',
    rowHeader: { resizable: false, frozen: true, width: 56, hozAlign: 'right', headerSort: false, formatter: 'rownum', headerHozAlign: 'center' },
    selectableRange: 1,
    selectableRangeColumns: true,
    selectableRangeRows: true,
    clipboard: 'copy',
    clipboardCopyStyled: false,
    clipboardCopyRowRange: 'range',
    clipboardCopyConfig: { columnHeaders: false, rowHeaders: false },
    ajaxURL: 'result://' + rid,
    progressiveLoad: 'scroll',
    progressiveLoadScrollMargin: 600,
    paginationSize: 500,
    sortMode: 'remote',
    filterMode: 'remote',
    headerFilterLiveFilterDelay: 450,
    initialSort: r.sort.map((s) => ({ column: s.field, dir: s.dir })),
    initialHeaderFilter: r.filters.map((f) => ({ field: f.field, value: f.value })),
    ajaxRequestFunc: (url, config, params) => {
      const sort = (params.sort || []).map((s) => ({ field: s.field, dir: s.dir }));
      const filters = (params.filter || []).filter((f) => String(f.value ?? '').trim()).map((f) => ({ field: f.field, value: String(f.value) }));
      r.sort = sort;
      r.filters = filters;
      return api().fetch_page(rid, params.page, params.size, sort, filters).then((res) => {
        if (!res.ok) {
          toast(res.error, 'error');
          return { last_page: 1, data: [] };
        }
        r.filtered = res.total;
        renderResultStatus();
        return { last_page: res.last_page, data: res.data };
      });
    },
  });
}

async function profileColumn(relation, column) {
  showBusy(`Profiling ${column}…`);
  const res = await api().profile_column(relation, column);
  hideBusy();
  if (!res.ok) return toast(res.error, 'error');
  const p = res.profile;
  const stat = (k, v) => `<div class="stat"><div class="k">${esc(k)}</div><div class="v" title="${esc(v)}">${esc(v ?? '—')}</div></div>`;
  const num = (v) => (typeof v === 'number' ? Number(v.toFixed(4)).toLocaleString() : v);
  const maxCount = Math.max(1, ...p.top.map((t) => t.count));
  const stats = [
    stat('Rows', fmtN(p.rows)), stat('Distinct (approx.)', fmtN(p.distinct)),
    stat('Nulls', `${fmtN(p.nulls)} (${p.rows ? ((p.nulls / p.rows) * 100).toFixed(1) : 0}%)`), stat('Type', p.type),
    stat('Min', p.min), stat('Max', p.max),
  ];
  if ('avg' in p) stats.push(stat('Average', num(p.avg)), stat('Median', num(p.median)), stat('Std dev', num(p.stddev)), stat('Sum', num(p.sum)));
  else stats.push(stat('Min length', p.min_length), stat('Max length', p.max_length));
  const bars = p.top.map((t) => `<div class="bar-row"><div class="bar" title="${esc(t.value)}"><div class="fill" style="width:${(t.count / maxCount) * 100}%"></div>
    <span>${t.value === null ? '<i class="muted">NULL</i>' : esc(t.value)}</span></div><div class="n">${fmtN(t.count)}</div></div>`).join('');
  modal({
    title: `Column profile: ${column}`,
    body: `<div class="prof-grid">${stats.join('')}</div><div class="opt-section">Most frequent values</div><div class="bars">${bars}</div>`,
    buttons: [{ label: 'Close', primary: true }],
  });
}

/* ================================================================ export */

function exportArgs(tab) {
  const r = tab.result;
  return [r.rid, r.sort, r.filters];
}

async function exportResult(fmt) {
  const tab = activeTab();
  if (!tab || !tab.result) return toast('Run a query first — there are no results to export', 'warn');
  const [rid, sort, filters] = exportArgs(tab);
  const res = await api().export_result(rid, fmt, `${safeFileName(tab.title)}.${fmt}`, sort, filters);
  hideBusy();
  exportDone(res, sort.length || filters.length);
}

function exportDone(res, viewApplied) {
  if (res.cancelled) return;
  if (!res.ok) return toast('Export failed: ' + res.error, 'error');
  toast(`Saved ${basename(res.path)}${viewApplied ? ' (with the grid’s current sort/filters)' : ''}`, 'ok', {
    actions: [
      { label: 'Open', fn: () => api().open_path(res.path) },
      { label: 'Show in folder', fn: () => api().reveal_path(res.path) },
    ],
  });
}

async function exportAllTabs() {
  const tabs = S.tabs.filter((t) => t.result);
  if (!tabs.length) return toast('No tabs have results to export', 'warn');
  const body = el(`<div><p class="muted">Each selected tab becomes a sheet. Results larger than Excel’s 1,048,576-row limit continue on extra sheets.</p>
    <table class="imp-table"><thead><tr><th></th><th>Tab</th><th>Rows</th><th>Sheet name</th></tr></thead><tbody></tbody></table></div>`);
  for (const t of tabs) {
    const row = el(`<tr><td><input type="checkbox" checked></td><td></td><td class="muted"></td><td><input type="text" maxlength="31"></td></tr>`);
    row.children[1].textContent = t.title;
    row.children[2].textContent = fmtN(t.result.total);
    $('input[type=text]', row).value = t.title.slice(0, 31);
    row.dataset.id = t.id;
    $('tbody', body).appendChild(row);
  }
  const items = await modal({
    title: 'Export tabs to one Excel workbook', body,
    buttons: [
      { label: 'Cancel', value: null },
      {
        label: 'Export…', primary: true,
        action: (b) => {
          const out = $$('tbody tr', b).filter((tr) => $('input[type=checkbox]', tr).checked).map((tr) => {
            const t = S.tabs.find((x) => x.id === tr.dataset.id);
            return { result_id: t.result.rid, sheet: $('input[type=text]', tr).value || t.title, sort: t.result.sort, filters: t.result.filters };
          });
          return out.length ? out : false;
        },
      },
    ],
  });
  if (!items) return;
  const res = await api().export_workbook(items, 'results.xlsx');
  hideBusy();
  exportDone(res, false);
}

/* ================================================================ schema sidebar */

async function refreshSchema() {
  const res = await api().get_schema();
  if (!res.ok) return toast(res.error, 'error');
  S.schema = res.tables;
  S.changed = new Set(res.tables.filter((t) => t.changed).map((t) => t.name));
  renderSidebar();
  updateStatus();
  const tab = activeTab();
  if (tab && !tab.result && !tab.error && !tab.message && !tab.running) renderResults();
}

function updateStatus() {
  const n = S.schema.length;
  const rows = S.schema.reduce((a, t) => a + (t.rows || 0), 0);
  $('#status-left').textContent = (n ? `${n} table${n === 1 ? '' : 's'} · ${fmtN(rows)} rows loaded` : 'No tables loaded')
    + (S.projectPath ? ` · Project: ${basename(S.projectPath)}` : '');
}

function renderSidebar() {
  const panel = S.settings.sidePanel;
  $$('#side-seg button').forEach((b) => b.classList.toggle('active', b.dataset.panel === panel));
  ['tables', 'saved', 'history'].forEach((p) => $('#panel-' + p).classList.toggle('hidden', p !== panel));
  $('#side-filter').placeholder = { tables: 'Filter tables & columns…', saved: 'Filter saved queries…', history: 'Search history…' }[panel];
  if (panel === 'tables') renderTables();
  if (panel === 'saved') renderSaved();
  if (panel === 'history') renderHistory();
}

function renderTables() {
  const host = $('#panel-tables');
  const q = $('#side-filter').value.trim().toLowerCase();
  host.innerHTML = '';
  if (!S.schema.length) {
    host.appendChild(el(`<div class="empty-hint">No tables loaded.<br>Drop CSV, Excel, Parquet or JSON files here, or
      <br><button class="btn primary">Open files…</button></div>`));
    $('button', host).onclick = openFiles;
    return;
  }
  for (const t of S.schema) {
    const colMatch = q && t.columns.some((c) => c.name.toLowerCase().includes(q));
    if (q && !t.name.toLowerCase().includes(q) && !colMatch) continue;
    const open = S.expanded.has(t.name) || colMatch;
    const changed = S.changed.has(t.name);
    const node = el(`<div class="tbl">
      <div class="tbl-head" draggable="true">
        <span class="caret">${open ? '▼' : '▶'}</span>
        <span class="name"></span>
        ${t.type === 'view' ? '<span class="badge view">view</span>' : ''}
        ${changed ? '<span class="badge" title="The source file changed on disk">changed</span>' : ''}
        <span class="meta">${t.rows == null ? '' : fmtN(t.rows)}</span>
        <span class="actions">
          <button data-a="preview" title="Preview first 1,000 rows">▶</button>
          <button data-a="summarize" title="Summarize every column">Σ</button>
          ${t.source ? '<button data-a="reload" title="Reload from file">⟳</button>' : ''}
          <button data-a="rename" title="Rename">✎</button>
          <button data-a="drop" title="Remove">✕</button>
        </span>
      </div></div>`);
    $('.name', node).textContent = t.name;
    const head = $('.tbl-head', node);
    head.title = t.source ? `${t.source.path}${t.source.sheet ? ' › ' + t.source.sheet : ''}\nDouble-click to insert name` : 'Double-click to insert name';
    head.onclick = (e) => {
      const a = e.target.closest('[data-a]');
      if (a) return tableAction(a.dataset.a, t);
      if (S.expanded.has(t.name)) S.expanded.delete(t.name); else S.expanded.add(t.name);
      saveState();
      renderTables();
    };
    head.ondblclick = (e) => { if (!e.target.closest('[data-a]')) insertAtCursor(quoteIdent(t.name)); };
    head.ondragstart = (e) => e.dataTransfer.setData('text/plain', quoteIdent(t.name));
    if (open) {
      if (t.source) {
        const src = el('<div class="tbl-src"></div>');
        src.textContent = basename(t.source.path) + (t.source.sheet ? ` › ${t.source.sheet}` : '');
        src.title = t.source.path;
        node.appendChild(src);
      }
      const cols = el('<div class="cols"></div>');
      for (const c of t.columns) {
        const hit = q && c.name.toLowerCase().includes(q);
        const cn = el(`<div class="col" draggable="true" title="Click to insert · drag into the editor">
          <span class="cname"></span><span class="ctype"></span><button class="cprof" title="Profile column">📊</button></div>`);
        $('.cname', cn).textContent = c.name;
        if (hit) $('.cname', cn).style.fontWeight = '600';
        $('.ctype', cn).textContent = c.type;
        cn.onclick = (e) => {
          if (e.target.closest('.cprof')) return profileColumn({ table: t.name }, c.name);
          insertAtCursor(quoteIdent(c.name));
        };
        cn.ondragstart = (e) => e.dataTransfer.setData('text/plain', quoteIdent(c.name));
        cols.appendChild(cn);
      }
      node.appendChild(cols);
    }
    host.appendChild(node);
  }
}

async function tableAction(action, t) {
  const name = quoteIdent(t.name);
  if (action === 'preview') openInTab(t.name, `SELECT *\nFROM ${name}\nLIMIT 1000;\n`, true);
  if (action === 'summarize') openInTab(`Σ ${t.name}`, `SUMMARIZE ${name};\n`, true);
  if (action === 'reload') reloadTable(t.name);
  if (action === 'rename') {
    const nn = await promptText('Rename table', 'New table name', t.name);
    if (!nn || nn === t.name) return;
    const res = await api().rename_table(t.name, nn);
    if (!res.ok) return toast(res.error, 'error');
    if (S.expanded.delete(t.name)) S.expanded.add(res.table);
    refreshSchema();
  }
  if (action === 'drop') {
    if (!(await confirmBox('Remove table', `Remove "${t.name}" from this session? The source file is not touched.`, 'Remove'))) return;
    const res = await api().drop_table(t.name);
    if (!res.ok) return toast(res.error, 'error');
    S.expanded.delete(t.name);
    refreshSchema();
  }
}

async function reloadTable(name) {
  showBusy(`Reloading ${name}…`);
  const res = await api().reload_table(name);
  hideBusy();
  if (!res.ok) return toast(`Reload failed: ${res.error}`, 'error');
  toast(`Reloaded ${name} · ${fmtN(res.rows)} rows`, 'ok');
  refreshSchema();
}

async function checkChanges() {
  let changed;
  try { changed = await api().check_changes(); } catch { return; }
  const fresh = changed.filter((n) => !S.changed.has(n));
  if (!fresh.length && changed.length === S.changed.size) return;
  S.changed = new Set(changed);
  if (S.settings.sidePanel === 'tables') renderTables();
  for (const n of fresh) {
    toast(`The file behind "${n}" changed on disk.`, 'warn', { actions: [{ label: 'Reload', fn: () => reloadTable(n) }], timeout: 20000 });
  }
}

/* ================================================================ saved queries & history */

function addHistory(entry) {
  const last = S.history[0];
  if (last && last.sql === entry.sql) S.history.shift();
  S.history.unshift(entry);
  S.history.length = Math.min(S.history.length, 300);
  saveState();
  if (S.settings.sidePanel === 'history') renderHistory();
}

function renderHistory() {
  const host = $('#panel-history');
  const q = $('#side-filter').value.trim().toLowerCase();
  host.innerHTML = '';
  const items = S.history.filter((h) => !q || h.sql.toLowerCase().includes(q));
  if (!items.length) { host.innerHTML = '<div class="empty-hint">Queries you run appear here.</div>'; return; }
  for (const h of items.slice(0, 200)) {
    const node = el(`<div class="item" title="Click to open in a new tab">
      <div class="sub"><span>${esc(timeAgo(h.ts))}</span><span>${esc(fmtMs(h.ms))}</span>
      ${h.ok ? `<span class="okc">${h.rows != null ? fmtN(h.rows) + ' rows' : '✓'}</span>`
        : `<span class="err">${h.error === 'Query cancelled' ? 'cancelled' : 'error'}</span>`}</div>
      <div class="sql"></div></div>`);
    $('.sql', node).textContent = h.sql;
    if (!h.ok) node.title = h.error;
    node.onclick = () => newTab({ title: 'From history', sql: h.sql + '\n' });
    host.appendChild(node);
  }
}

function renderSaved() {
  const host = $('#panel-saved');
  const q = $('#side-filter').value.trim().toLowerCase();
  host.innerHTML = '';
  const items = S.saved.filter((s) => !q || s.name.toLowerCase().includes(q) || s.sql.toLowerCase().includes(q));
  if (!items.length) {
    host.innerHTML = '<div class="empty-hint">No saved queries yet.<br>Use <b>☆ Save query</b> (Ctrl+S) to keep queries you reuse.</div>';
    return;
  }
  for (const s of items) {
    const node = el(`<div class="item" title="Click to open in a new tab"><div class="title"><span></span>
      <button class="x" data-a="rename" title="Rename">✎</button><button class="x" data-a="del" title="Delete">✕</button></div><div class="sql"></div></div>`);
    $('.title span', node).textContent = s.name;
    $('.sql', node).textContent = s.sql;
    $$('.x', node).forEach((x) => x.style.marginLeft = x.dataset.a === 'rename' ? 'auto' : '0');
    node.onclick = async (e) => {
      const a = e.target.closest('[data-a]');
      if (a && a.dataset.a === 'del') {
        if (await confirmBox('Delete saved query', `Delete "${s.name}"?`, 'Delete')) {
          S.saved = S.saved.filter((x) => x !== s); saveState(); renderSaved();
        }
        return;
      }
      if (a && a.dataset.a === 'rename') {
        const nn = await promptText('Rename saved query', 'Name', s.name);
        if (nn) { s.name = nn; saveState(); renderSaved(); }
        return;
      }
      const existing = S.tabs.find((t) => t.savedName === s.name);
      if (existing) return activateTab(existing.id);
      const tab = newTab({ title: s.name, sql: s.sql });
      tab.savedName = s.name;
    };
    host.appendChild(node);
  }
}

async function saveQuery() {
  const tab = activeTab();
  const sql = tab.model.getValue().trim();
  if (!sql) return toast('The editor is empty', 'warn');
  const name = await promptText('Save query', 'Name', tab.savedName || tab.title);
  if (!name) return;
  const existing = S.saved.find((s) => s.name.toLowerCase() === name.toLowerCase());
  if (existing) {
    if (!(await confirmBox('Replace saved query', `A saved query named "${existing.name}" exists. Replace it?`, 'Replace'))) return;
    existing.sql = sql;
    existing.updated = Date.now();
  } else {
    S.saved.unshift({ name, sql, created: Date.now() });
  }
  tab.savedName = name;
  tab.title = name;
  renderTabs();
  saveState();
  toast(`Saved "${name}"`, 'ok');
  if (S.settings.sidePanel === 'saved') renderSaved();
}

/* ================================================================ importing files */

async function openFiles() {
  const paths = await api().pick_files();
  if (paths && paths.length) importFiles(paths);
}

const DEFAULT_IMPORT = { delimiter: 'auto', header: true, skip: 0, encoding: 'utf-8', all_text: false };

async function importFiles(paths) {
  showBusy('Reading files…');
  const res = await api().inspect_files(paths);
  hideBusy();
  if (!res.ok) return toast(res.error, 'error');
  const files = res.files;
  const o = { ...DEFAULT_IMPORT, ...(S.settings.importOptions || {}) };
  const hasCsv = files.some((f) => f.kind === 'csv');
  const hasExcel = files.some((f) => f.kind === 'excel');
  const existing = new Set(S.schema.map((t) => t.name.toLowerCase()));

  const body = el(`<div>
    ${hasCsv ? `<div class="opt-section">CSV / text files</div>
    <div class="opt-grid">
      <label>Delimiter<select data-o="delimiter">
        <option value="auto">Auto-detect</option><option value=",">Comma ,</option><option value=";">Semicolon ;</option>
        <option value="tab">Tab</option><option value="|">Pipe |</option></select></label>
      <label>Encoding<select data-o="encoding"><option value="utf-8">UTF-8</option><option value="utf-16">UTF-16</option><option value="latin-1">Latin-1 / Windows-1252</option></select></label>
      <label>Skip lines at top<input type="number" min="0" data-o="skip"></label>
      <label class="check" style="margin-top:16px"><input type="checkbox" data-o="header"> First row is header</label>
    </div>` : ''}
    <div class="opt-section">Types</div>
    <label class="check"><input type="checkbox" data-o="all_text"> Load every column as text — keeps IDs, NDCs and ZIP codes exactly as written (no type guessing)</label>
    <p class="muted" style="margin:4px 0 12px">Without this, types are detected automatically; values with leading zeros are kept as text.</p>
    <div class="opt-section">Tables to create</div>
    <table class="imp-table"><thead><tr><th></th><th>File</th><th>Sheet</th>
      ${hasExcel ? '<th title="Rows above the header (titles, notes) are skipped">Header row</th>' : ''}<th>Size</th><th>Table name</th></tr></thead><tbody></tbody></table>
    ${hasExcel ? '<p class="muted" style="margin-top:8px">Header rows for Excel sheets are guessed; rows above the header (titles, notes) are skipped.</p>' : ''}
  </div>`);

  $$('[data-o]', body).forEach((inp) => {
    const v = o[inp.dataset.o];
    if (inp.type === 'checkbox') inp.checked = !!v; else inp.value = v;
  });

  const tbody = $('tbody', body);
  for (const f of files) {
    if (f.error) {
      const row = el(`<tr><td></td><td class="file"></td><td colspan="${hasExcel ? 4 : 3}" class="error-text"></td></tr>`);
      row.children[1].textContent = f.name;
      row.children[2].textContent = f.error;
      tbody.appendChild(row);
      continue;
    }
    for (const t of f.tables) {
      const row = el(`<tr><td><input type="checkbox" checked></td><td class="file"></td><td></td>
        ${hasExcel ? `<td>${f.kind === 'excel' ? '<input type="number" min="1" class="hdr" style="width:64px">' : '<span class="muted">—</span>'}</td>` : ''}
        <td class="muted size"></td>
        <td><input type="text" spellcheck="false"><div class="muted replace-note" style="font-size:11px"></div></td></tr>`);
      row.children[1].textContent = f.name;
      row.children[1].title = f.path;
      row.children[2].textContent = t.sheet || '—';
      $('.size', row).textContent = fmtBytes(f.size);
      if ($('.hdr', row)) $('.hdr', row).value = t.header_row || 1;
      const inp = $('input[type=text]', row);
      inp.value = t.table;
      const note = () => { $('.replace-note', row).textContent = existing.has(inp.value.trim().toLowerCase()) ? 'Replaces the existing table' : ''; };
      inp.oninput = note;
      note();
      row._item = { path: f.path, kind: f.kind, sheet: t.sheet };
      tbody.appendChild(row);
    }
  }

  const plan = await modal({
    title: `Load ${files.length} file${files.length === 1 ? '' : 's'}`,
    body,
    buttons: [
      { label: 'Cancel', value: null },
      {
        label: 'Load', primary: true,
        action: (b) => {
          const opts = {};
          $$('[data-o]', b).forEach((inp) => {
            opts[inp.dataset.o] = inp.type === 'checkbox' ? inp.checked : inp.type === 'number' ? Number(inp.value || 0) : inp.value;
          });
          const items = $$('tbody tr', b).filter((tr) => tr._item && $('input[type=checkbox]', tr).checked).map((tr) => ({
            ...tr._item, table: $('input[type=text]', tr).value.trim(),
            header_row: $('.hdr', tr) ? Math.max(1, Number($('.hdr', tr).value) || 1) : undefined,
          }));
          if (!items.length) { toast('Select at least one table to load', 'warn'); return false; }
          const names = items.map((i) => i.table.toLowerCase());
          if (names.some((n) => !n)) { toast('Every table needs a name', 'warn'); return false; }
          if (new Set(names).size !== names.length) { toast('Table names must be unique', 'warn'); return false; }
          return { opts, items };
        },
      },
    ],
  });
  if (!plan) return;
  S.settings.importOptions = { ...o, ...plan.opts };
  saveState();

  const items = plan.items.map(({ header_row, ...it }) => {
    const opts = it.kind === 'excel'
      ? { header_row, all_text: plan.opts.all_text }
      : it.kind === 'csv'
        ? { delimiter: plan.opts.delimiter ?? 'auto', header: plan.opts.header ?? true, skip: plan.opts.skip || 0, encoding: plan.opts.encoding || 'utf-8', all_text: plan.opts.all_text }
        : {};
    return { ...it, options: opts };
  });
  await runLoads(items);
}

async function runLoads(items) {
  showBusy('Loading…');
  const results = await api().load_tables(items);
  hideBusy();
  const ok = results.filter((r) => r.ok);
  const bad = results.filter((r) => !r.ok);
  if (ok.length) {
    toast(`Loaded ${ok.map((r) => `${r.table} (${fmtN(r.rows)} rows)`).join(', ')}`, 'ok');
    ok.forEach((r) => S.expanded.add(r.table));
  }
  for (const r of bad) toast(`Could not load ${basename(r.path)}${r.table ? ' → ' + r.table : ''}:\n${r.error}`, 'error');
  S.settings.sidePanel = 'tables';
  await refreshSchema();
  return results;
}

/* ================================================================ projects & sql files */

function projectTabs() {
  return S.tabs.map((t) => ({ title: t.title, sql: t.model.getValue() }));
}

async function saveProject(saveAs) {
  const res = await api().save_project(projectTabs(), saveAs ? null : S.projectPath);
  if (res.cancelled) return;
  if (!res.ok) return toast(res.error, 'error');
  S.projectPath = res.path;
  updateStatus();
  saveState();
  toast(`Project saved: ${basename(res.path)}`, 'ok');
}

async function openProject() {
  if (S.schema.length && !(await confirmBox('Open project', 'Opening a project replaces the loaded tables and open tabs. Continue?', 'Open'))) return;
  showBusy('Opening project…');
  const res = await api().open_project();
  hideBusy();
  if (res.cancelled) return;
  if (!res.ok) return toast(res.error, 'error');
  for (const t of S.tabs) { if (t.result) api().discard_result(t.result.rid); t.model.dispose(); }
  S.tabs = [];
  S.activeId = null;
  for (const t of res.tabs.length ? res.tabs : [{ title: 'Query 1', sql: '' }]) newTab({ title: t.title, sql: t.sql, activate: false });
  activateTab(S.tabs[0].id);
  S.projectPath = res.path;
  const bad = res.loads.filter((r) => !r.ok);
  for (const r of bad) toast(`Could not load ${basename(r.path)} → ${r.table}:\n${r.error}`, 'error');
  toast(`Opened ${basename(res.path)} · ${res.loads.length - bad.length} table(s) loaded`, bad.length ? 'warn' : 'ok');
  refreshSchema();
  saveState();
}

async function openSqlFile() {
  const res = await api().open_sql_file();
  if (res.cancelled) return;
  if (!res.ok) return toast(res.error, 'error');
  newTab({ title: res.name.replace(/\.sql$/i, ''), sql: res.sql });
}

async function saveSqlFile() {
  const tab = activeTab();
  const res = await api().save_sql_file(tab.model.getValue(), `${safeFileName(tab.title)}.sql`);
  if (res.cancelled) return;
  if (!res.ok) return toast(res.error, 'error');
  toast(`Saved ${basename(res.path)}`, 'ok');
}

async function clearSession() {
  if (!S.schema.length) return toast('No tables loaded', 'info');
  if (!(await confirmBox('Remove all tables', 'Remove every loaded table from this session? Source files are not touched.', 'Remove all'))) return;
  for (const t of S.schema) await api().drop_table(t.name);
  S.projectPath = null;
  refreshSchema();
  saveState();
}

function showShortcuts() {
  const rows = [
    ['Ctrl+Enter / F5', 'Run selection, or the whole editor'],
    ['Ctrl+Shift+Enter', 'Run the statement under the cursor'],
    ['Esc (while running)', 'Cancel the running query'],
    ['Ctrl+Space', 'Autocomplete tables, columns, functions'],
    ['Shift+Alt+F', 'Format SQL (selection or whole editor)'],
    ['Ctrl+/', 'Toggle line comment'],
    ['Ctrl+S', 'Save query to the Saved list'],
    ['Ctrl+Shift+S', 'Save project'],
    ['Ctrl+O', 'Open files'],
    ['Ctrl+T / Ctrl+W', 'New tab / close tab'],
    ['Ctrl+Tab', 'Next tab'],
    ['Ctrl+C in grid', 'Copy selected cells (drag to select a range)'],
    ['Right-click grid', 'Copy value, filter to / exclude a value, profile column'],
    ['Header filter', 'Text = contains · =x, !=x, >5, <=10 · null / not null'],
  ];
  modal({
    title: 'Keyboard shortcuts & tips',
    body: `<table class="imp-table">${rows.map(([k, v]) => `<tr><td style="white-space:nowrap"><b>${esc(k)}</b></td><td>${esc(v)}</td></tr>`).join('')}</table>`,
    buttons: [{ label: 'Close', primary: true }],
  });
}

/* ================================================================ wiring */

function bindUi() {
  $('#btn-open').onclick = openFiles;
  $('#btn-run').onclick = () => runQuery('auto');
  $('#btn-run-stmt').onclick = () => runQuery('statement');
  $('#btn-stop').onclick = cancelQuery;
  $('#btn-save-query').onclick = saveQuery;
  $('#tab-add').onclick = () => newTab();
  $('#btn-theme').onclick = () => { S.settings.theme = isDark() ? 'light' : 'dark'; applyTheme(); saveState(); };
  $('#btn-quick-csv').onclick = () => exportResult('csv');
  $('#btn-quick-xlsx').onclick = () => exportResult('xlsx');
  $('#btn-clear-filters').onclick = () => {
    if (!grid) return;
    const r = activeTab().result;
    r.sort = []; r.filters = [];
    renderResults();
  };

  // menus
  $$('.menu').forEach((m) => {
    $('[data-menu]', m).onclick = (e) => {
      e.stopPropagation();
      const wasOpen = m.classList.contains('open');
      $$('.menu').forEach((x) => x.classList.remove('open'));
      if (!wasOpen) { updateToolbar(); m.classList.add('open'); }
    };
  });
  document.addEventListener('click', () => $$('.menu').forEach((x) => x.classList.remove('open')));
  const actions = {
    'export-csv': () => exportResult('csv'),
    'export-xlsx': () => exportResult('xlsx'),
    'export-parquet': () => exportResult('parquet'),
    'export-all': exportAllTabs,
    'project-open': openProject,
    'project-save': () => saveProject(false),
    'project-save-as': () => saveProject(true),
    'sql-open': openSqlFile,
    'sql-save': saveSqlFile,
    'format-sql': () => editor.getAction('editor.action.formatDocument').run(),
    'clear-history': async () => {
      if (await confirmBox('Clear history', 'Delete all query history?', 'Clear')) { S.history = []; saveState(); renderSidebar(); }
    },
    'clear-session': clearSession,
    shortcuts: showShortcuts,
  };
  $$('.menu-list [data-action]').forEach((b) => {
    b.onclick = () => { $$('.menu').forEach((x) => x.classList.remove('open')); actions[b.dataset.action](); };
  });

  // sidebar
  $$('#side-seg button').forEach((b) => {
    b.onclick = () => { S.settings.sidePanel = b.dataset.panel; $('#side-filter').value = ''; renderSidebar(); saveState(); };
  });
  $('#side-filter').oninput = debounce(renderSidebar, 120);

  // keyboard (capture phase so Monaco doesn't also handle these)
  document.addEventListener('keydown', (e) => {
    if ($('#modal-root').children.length) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    let handled = true;
    if (ctrl && e.shiftKey && k === 'enter') runQuery('statement');
    else if ((ctrl && k === 'enter') || e.key === 'F5') runQuery('auto');
    else if (ctrl && e.shiftKey && k === 's') saveProject(false);
    else if (ctrl && k === 's') saveQuery();
    else if (ctrl && k === 'o') openFiles();
    else if (ctrl && k === 't') newTab();
    else if (ctrl && k === 'w') closeTab(S.activeId);
    else if (ctrl && k === 'tab') {
      const i = S.tabs.findIndex((t) => t.id === S.activeId);
      const n = S.tabs.length;
      activateTab(S.tabs[(i + (e.shiftKey ? n - 1 : 1)) % n].id);
    } else if (e.key === 'Escape' && activeTab()?.running) cancelQuery();
    else handled = false;
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  }, true);

  // drag & drop overlay (Python receives the actual file paths)
  let dragDepth = 0;
  const hasFiles = (e) => e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files');
  document.addEventListener('dragenter', (e) => { if (hasFiles(e)) { dragDepth++; $('#drop-overlay').hidden = false; } });
  document.addEventListener('dragleave', (e) => { if (hasFiles(e) && --dragDepth <= 0) { dragDepth = 0; $('#drop-overlay').hidden = true; } });
  document.addEventListener('drop', () => { dragDepth = 0; $('#drop-overlay').hidden = true; });

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (!S.settings.theme) applyTheme(); });
  window.addEventListener('resize', debounce(() => grid && grid.redraw(), 150));
}

window.App = {
  onProgress(message) { if (message) showBusy(message); else hideBusy(); },
  onFilesDropped(paths) { $('#drop-overlay').hidden = true; importFiles(paths); },
};

async function init() {
  if (init.done) return;
  init.done = true;
  const saved = await api().load_state();
  if (saved) {
    Object.assign(S.settings, saved.settings || {});
    S.history = saved.history || [];
    S.saved = saved.saved || [];
    S.seq = saved.seq || 1;
    S.projectPath = null; // tables are not restored between sessions; reopen the project to reload them
    (saved.expanded || []).forEach((n) => S.expanded.add(n));
  }
  applyTheme();
  setupResizers();
  await loadMonaco();
  applyTheme();
  setupEditor();
  bindUi();

  if (saved && saved.tabs && saved.tabs.length) {
    for (const t of saved.tabs) newTab({ title: t.title, sql: t.sql, activate: false });
    const idx = Math.max(0, saved.tabs.findIndex((t) => t.id === saved.activeId));
    activateTab(S.tabs[idx].id);
  } else {
    newTab({
      title: 'Query 1',
      sql: '-- Open or drop CSV / Excel files, then query them as tables.\n-- Ctrl+Enter runs the selection (or everything); Ctrl+Shift+Enter runs the statement under the cursor.\n\n',
    });
  }

  const comp = await api().get_completions();
  if (comp.ok) {
    S.functions = comp.functions;
    S.keywords = comp.keywords;
    S.reserved = new Set(comp.reserved);
    extendSqlHighlighting();
  }
  renderSidebar();
  await refreshSchema();
  updateToolbar();
  setInterval(checkChanges, 3000);
}

if (window.pywebview && window.pywebview.api && window.pywebview.api.load_state) init();
else window.addEventListener('pywebviewready', init);
