import { applyAll, REWRITE_MODES } from '../lib/checker.js';

const $ = (id) => document.getElementById(id);
const editor = $('editor');
const backdrop = $('backdrop');
const list = $('list');
const stats = $('stats');
const notice = $('notice');
const fixAllBtn = $('fixAll');
const replaceBtn = $('replace');

const LABELS = { spelling: 'Spelling', grammar: 'Grammar', style: 'Style' };
let lints = [];
let activeId = null;
let seq = 0;
let timer = 0;
let checkedText = '';

// ---------- checking ----------

function schedule(ms = 350) {
  clearTimeout(timer);
  timer = setTimeout(check, ms);
}

async function check() {
  const text = editor.value;
  const mySeq = ++seq;
  const result = await window.grammar.check(text);
  if (mySeq !== seq || text !== editor.value) return;
  lints = result;
  checkedText = text;
  render();
}

// ---------- rendering ----------

function render() {
  const text = editor.value;
  const usable = text === checkedText ? lints : [];

  const frag = document.createDocumentFragment();
  let at = 0;
  for (const l of usable) {
    if (l.start < at) continue;
    frag.append(text.slice(at, l.start));
    const mark = document.createElement('span');
    mark.className = `mark ${l.category}` + (l.id === activeId ? ' active' : '');
    mark.dataset.id = l.id;
    mark.textContent = text.slice(l.start, l.end);
    frag.append(mark);
    at = l.end;
  }
  frag.append(text.slice(at) + '\n');
  backdrop.replaceChildren(frag);
  syncScroll();

  renderList(usable);
  renderStats(text, usable);
  fixAllBtn.disabled = !usable.some((l) => l.fixes.length);
}

function renderStats(text, shown) {
  const words = (text.match(/\S+/g) || []).length;
  stats.replaceChildren();
  stats.append(pill(null, `${words} word${words === 1 ? '' : 's'}`));
  for (const c of ['spelling', 'grammar', 'style']) {
    const n = shown.filter((l) => l.category === c).length;
    if (n) stats.append(pill(c, `${n} ${LABELS[c].toLowerCase()}`));
  }
}

function pill(category, label) {
  const s = document.createElement('span');
  s.className = 'pill';
  if (category) {
    const i = document.createElement('i');
    i.style.background = `var(--${category})`;
    s.append(i);
  }
  s.append(label);
  return s;
}

function renderList(shown) {
  $('sideHead').textContent = shown.length
    ? `${shown.length} suggestion${shown.length === 1 ? '' : 's'}`
    : 'Suggestions';
  list.replaceChildren();
  if (!shown.length) {
    const e = el('div', 'empty');
    if (editor.value.trim()) e.append(el('b', '', 'Looking good!'), 'No mistakes found.');
    else e.append(el('b', '', 'Nothing to check yet'), 'Type or paste text on the left.');
    list.append(e);
    return;
  }
  for (const l of shown) list.append(card(l));
}

function card(l) {
  const c = el('div', `card ${l.category}` + (l.id === activeId ? ' active' : ''));
  c.dataset.id = l.id;
  c.append(el('div', 'kind', l.label));

  if (l.fixes.length) {
    const fixes = el('div', 'fixes');
    fixes.append(el('span', 'problem', l.problem), el('span', 'arrow', '→'));
    for (const f of l.fixes.slice(0, 4)) {
      const b = el('button', 'fix', f.label);
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        replaceRange(f.start, f.end, f.text);
      });
      fixes.append(b);
    }
    c.append(fixes);
  }
  c.append(el('div', 'msg', l.message));

  const links = el('div', 'links');
  const ignore = el('button', 'link', 'Ignore');
  ignore.addEventListener('click', async (e) => {
    e.stopPropagation();
    await window.grammar.ignore(l.problem, l.message);
    check();
  });
  links.append(ignore);
  if (l.category === 'spelling') {
    const add = el('button', 'link', 'Add to dictionary');
    add.addEventListener('click', async (e) => {
      e.stopPropagation();
      await window.grammar.addWord(l.problem);
      check();
    });
    links.append(add);
  }
  c.append(links);

  c.addEventListener('click', () => {
    setActive(l.id, false);
    editor.focus();
    editor.setSelectionRange(l.start, l.end);
    scrollMarkIntoView(l.id);
  });
  return c;
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function setActive(id, scrollCard = true) {
  activeId = id;
  for (const m of backdrop.querySelectorAll('.mark')) m.classList.toggle('active', m.dataset.id === id);
  for (const c of list.querySelectorAll('.card')) {
    const on = c.dataset.id === id;
    c.classList.toggle('active', on);
    if (on && scrollCard) c.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}

function scrollMarkIntoView(id) {
  const m = backdrop.querySelector(`[data-id="${CSS.escape(id)}"]`);
  if (!m) return;
  const top = m.offsetTop - editor.clientHeight / 3;
  editor.scrollTop = Math.max(0, top);
  syncScroll();
}

function syncScroll() {
  backdrop.scrollTop = editor.scrollTop;
  backdrop.scrollLeft = editor.scrollLeft;
}

// ---------- editing ----------

// Goes through the browser's editing pipeline so Ctrl+Z / ⌘Z undoes fixes.
function replaceRange(start, end, text) {
  editor.focus();
  editor.setSelectionRange(start, end);
  if (!document.execCommand('insertText', false, text)) {
    editor.setRangeText(text, start, end, 'end');
    editor.dispatchEvent(new Event('input'));
  }
}

function setText(text) {
  editor.focus();
  editor.select();
  if (!document.execCommand('insertText', false, text)) {
    editor.value = text;
    editor.dispatchEvent(new Event('input'));
  }
  editor.setSelectionRange(0, 0);
  editor.scrollTop = 0;
}

editor.addEventListener('input', () => {
  render();
  schedule();
});
editor.addEventListener('scroll', syncScroll);

// Clicking into a marked word highlights its card.
function onCaret() {
  const at = editor.selectionStart;
  const hit = checkedText === editor.value && lints.find((l) => at >= l.start && at <= l.end);
  setActive(hit ? hit.id : null);
}
editor.addEventListener('mouseup', onCaret);
editor.addEventListener('keyup', (e) => {
  if (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End') onCaret();
});

fixAllBtn.addEventListener('click', () => {
  if (checkedText !== editor.value) return;
  setText(applyAll(editor.value, lints));
});

$('paste').addEventListener('click', async () => setText(await window.grammar.readClipboard()));
$('clear').addEventListener('click', () => setText(''));
$('copy').addEventListener('click', async () => {
  await window.grammar.copy(editor.value);
  flash($('copy'), 'Copied!');
});
replaceBtn.addEventListener('click', () => {
  replaceBtn.hidden = true;
  window.grammar.pasteBack(editor.value);
});

function flash(btn, label) {
  const old = btn.textContent;
  btn.textContent = label;
  setTimeout(() => (btn.textContent = old), 1200);
}

function showNotice(msg) {
  notice.textContent = msg;
  notice.hidden = !msg;
}

// ---------- CoEdIT rewrites ----------

const rwModes = $('rwModes');
const rwResult = $('rwResult');
const rwStatus = $('rwStatus');
let rwBusy = false;

for (const [mode, spec] of Object.entries(REWRITE_MODES)) {
  const b = el('button', '', spec.label);
  b.addEventListener('click', () => rewrite(mode));
  rwModes.append(b);
}

async function refreshRewriterStatus() {
  const status = await window.grammar.rewriterStatus();
  const labels = { idle: '', loading: 'Loading model…', ready: 'Ready', missing: 'Model not installed', error: 'Model failed to load' };
  rwStatus.textContent = labels[status] ?? '';
  for (const b of rwModes.children) b.disabled = status === 'missing' || rwBusy;
}

async function rewrite(mode) {
  if (rwBusy) return;
  const text = editor.value;
  const start = editor.selectionStart;
  const end = editor.selectionEnd;
  if (!text.trim()) return;
  rwBusy = true;
  refreshRewriterStatus();
  rwResult.hidden = false;
  rwResult.replaceChildren(el('div', 'rw-msg'));
  rwResult.firstChild.append(el('span', 'spinner'), 'Rewriting… the first one takes a little longer while the model loads.');
  setTimeout(refreshRewriterStatus, 300);
  try {
    const r = await window.grammar.rewrite({ text, start, end, mode });
    showRewrite(r, text);
  } catch (err) {
    rwResult.replaceChildren(el('div', 'rw-msg', cleanError(err)));
  } finally {
    rwBusy = false;
    refreshRewriterStatus();
  }
}

function showRewrite(r, sourceText) {
  editor.focus();
  editor.setSelectionRange(r.start, r.end);
  rwResult.replaceChildren();
  if (r.rewritten === r.original) {
    rwResult.append(el('div', 'rw-msg', `No changes suggested for “${REWRITE_MODES[r.mode].label}”. This sentence already reads well.`));
    return;
  }
  const textEl = el('div', 'rw-text');
  for (const part of r.diff) textEl.append(part.type === 'same' ? part.text : el('span', part.type, part.text));
  let editBox = null;

  const log = (action, final) =>
    window.grammar.feedback({ mode: r.mode, original: r.original, suggestion: r.rewritten, final, action });

  const actions = el('div', 'rw-actions');
  const accept = el('button', 'primary', 'Accept');
  accept.addEventListener('click', () => {
    rwResult.hidden = true;
    if (editor.value !== sourceText) return; // text changed meanwhile
    const final = editBox ? editBox.value.trim() : r.rewritten;
    log(final === r.rewritten ? 'accepted' : 'edited', final);
    replaceRange(r.start, r.end, final);
  });
  const edit = el('button', '', 'Edit');
  edit.addEventListener('click', () => {
    editBox = el('textarea', 'rw-edit');
    editBox.value = r.rewritten;
    textEl.replaceWith(editBox);
    edit.remove();
    editBox.focus();
  });
  const dismiss = el('button', '', 'Dismiss');
  dismiss.addEventListener('click', () => {
    rwResult.hidden = true;
    log('dismissed', null);
  });
  actions.append(accept, edit, dismiss, el('span', 'rw-meta', `${(r.ms / 1000).toFixed(1)} s`));
  rwResult.append(textEl);
  if (r.warning) rwResult.append(el('div', 'rw-warn', r.warning));
  rwResult.append(actions);
}

function cleanError(err) {
  return String(err.message || err).replace(/^Error invoking remote method '\w+': (Error: )?/, '');
}

refreshRewriterStatus();

// ---------- hotkey hand-off from the main process ----------

window.grammar.onLoadText(({ text, fromHotkey }) => {
  showNotice('');
  setText(text);
  replaceBtn.hidden = !fromHotkey;
});
window.grammar.onNotice(showNotice);

window.grammar.info().then(({ hotkey }) => {
  const foot = $('foot');
  foot.append('Tip: select text in any app and press ');
  foot.append(el('kbd', '', hotkey));
  foot.append(' to check it here. Everything runs on this computer — nothing is uploaded.');
});

render();
editor.focus();
