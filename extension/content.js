// Content script: watches the text box you're typing in, sends its text to the
// background worker for checking, underlines mistakes and shows a suggestion card.
//
// - <textarea>/<input>: a transparent "mirror" overlay draws the underlines.
// - contenteditable (Gmail, chat apps, etc.): the CSS Custom Highlight API marks
//   ranges directly in the page without touching its DOM.
(() => {
  if (window.__grammarHelper) return;
  window.__grammarHelper = true;

  const MAX_LEN = 20000;
  const DEBOUNCE_MS = 500;
  const CATEGORIES = ['spelling', 'grammar', 'style'];
  const REWRITE_LABELS = { fix: 'Fix', simpler: 'Simpler', clearer: 'Clearer', formal: 'Formal', paraphrase: 'Paraphrase' };
  const TEXT_INPUT_TYPES =new Set(['text', 'search', 'email', 'url', '']);

  let settings = { enabled: true, disabledSites: [] };
  let alive = true;
  let current = null; // the focused Session
  const sessions = new WeakMap();

  // ---------- settings ----------

  const isActive = () =>
    alive && settings.enabled && !settings.disabledSites.includes(location.hostname);

  chrome.storage.sync.get(['enabled', 'disabledSites']).then((s) => {
    if (s.enabled !== undefined) settings.enabled = s.enabled;
    if (s.disabledSites) settings.disabledSites = s.disabledSites;
  });

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.enabled) settings.enabled = changes.enabled.newValue;
    if (changes.disabledSites) settings.disabledSites = changes.disabledSites.newValue || [];
    if (!isActive()) {
      current?.deactivate(true);
      current = null;
    } else if (document.activeElement) {
      onFocusIn({ target: document.activeElement });
    }
  });

  function send(msg) {
    try {
      return chrome.runtime.sendMessage(msg).catch(() => null);
    } catch {
      alive = false; // extension was reloaded; this old script is orphaned
      return Promise.resolve(null);
    }
  }

  // ---------- field detection ----------

  function editableRoot(el) {
    if (!(el instanceof HTMLElement)) return null;
    if (el instanceof HTMLTextAreaElement) return el.readOnly || el.disabled ? null : el;
    if (el instanceof HTMLInputElement) {
      return TEXT_INPUT_TYPES.has(el.type) && !el.readOnly && !el.disabled ? el : null;
    }
    if (!el.isContentEditable) return null;
    let root = el;
    while (root.parentElement?.isContentEditable) root = root.parentElement;
    return root;
  }

  function shouldSkip(field) {
    // Code editors and similar fields opt out of spell checking; respect that.
    return field.getAttribute('spellcheck') === 'false' || field.closest('[data-gramm="false"]');
  }

  function onFocusIn(e) {
    if (!isActive()) return;
    const field = editableRoot(e.target);
    if (!field || shouldSkip(field)) return;
    if (current && current.field !== field) current.deactivate();
    let s = sessions.get(field);
    if (!s) sessions.set(field, (s = new Session(field)));
    current = s;
    s.activate();
  }

  document.addEventListener('focusin', onFocusIn, true);
  document.addEventListener('focusout', (e) => {
    const s = current;
    if (!s || !s.field.contains(e.target)) return;
    // Wait a tick: focus may just be moving within the field.
    setTimeout(() => {
      const inOurUI = document.activeElement?.tagName === 'GRAMMAR-HELPER';
      if (current === s && !s.field.contains(document.activeElement) && !inOurUI) {
        s.deactivate();
        current = null;
      }
    }, 150);
  }, true);

  // ---------- contenteditable text model ----------

  const BLOCK = /^(ADDRESS|ARTICLE|ASIDE|BLOCKQUOTE|DD|DIV|DL|DT|FIELDSET|FIGCAPTION|FIGURE|FOOTER|FORM|H[1-6]|HEADER|HR|LI|MAIN|NAV|OL|P|PRE|SECTION|TABLE|TBODY|TD|TH|TR|UL)$/;

  // Flattens an editable element into plain text plus a map back to its text nodes.
  function buildModel(root) {
    let text = '';
    const nodes = [];
    const breakLine = () => { if (text && !text.endsWith('\n')) text += '\n'; };
    (function walk(el) {
      for (let n = el.firstChild; n; n = n.nextSibling) {
        if (n.nodeType === Node.TEXT_NODE) {
          nodes.push({ node: n, start: text.length });
          text += n.data;
        } else if (n.nodeType === Node.ELEMENT_NODE) {
          if (n.tagName === 'BR') { text += '\n'; continue; }
          if (n.tagName === 'SCRIPT' || n.tagName === 'STYLE') continue;
          if (!n.isContentEditable) { text += ' '; continue; } // mention chips etc.
          const block = BLOCK.test(n.tagName);
          if (block) breakLine();
          walk(n);
          if (block) breakLine();
        }
      }
    })(root);
    return { text, nodes };
  }

  function pointAt(model, offset, isEnd) {
    for (const { node, start } of model.nodes) {
      const end = start + node.data.length;
      if (isEnd ? offset > start && offset <= end : offset >= start && offset < end) {
        return [node, offset - start];
      }
    }
    return null;
  }

  function rangeFor(model, start, end) {
    const a = pointAt(model, start, false);
    const b = pointAt(model, end, true);
    if (!a || !b) return null;
    const r = document.createRange();
    r.setStart(a[0], a[1]);
    r.setEnd(b[0], b[1]);
    return r;
  }

  function offsetOfPoint(model, container, offset) {
    if (container.nodeType === Node.TEXT_NODE) {
      const m = model.nodes.find((x) => x.node === container);
      return m ? m.start + offset : -1;
    }
    const probe = document.createRange();
    probe.setStart(container, offset);
    for (const m of model.nodes) {
      if (probe.comparePoint(m.node, 0) >= 0) return m.start;
    }
    return model.text.length;
  }

  // ---------- highlights (contenteditable) ----------

  const highlights = {};
  if (window.CSS?.highlights) {
    for (const c of [...CATEGORIES, 'active']) {
      highlights[c] = new Highlight();
      CSS.highlights.set('gh-' + c, highlights[c]);
    }
  }

  // ---------- keep lints aligned while typing ----------

  // Shifts existing lints to match an edit so underlines don't jump around while
  // the next check is pending. Lints touching the edited region are dropped.
  function shiftLints(oldText, newText, lints) {
    let pre = 0;
    const max = Math.min(oldText.length, newText.length);
    while (pre < max && oldText[pre] === newText[pre]) pre++;
    let suf = 0;
    while (
      suf < max - pre &&
      oldText[oldText.length - 1 - suf] === newText[newText.length - 1 - suf]
    ) suf++;
    const oldEnd = oldText.length - suf;
    const delta = newText.length - oldText.length;
    const out = [];
    for (const l of lints) {
      if (l.end < pre) out.push(l);
      else if (l.start > oldEnd) out.push(shift(l, delta));
    }
    return out;
  }

  function shift(l, d) {
    return {
      ...l,
      start: l.start + d,
      end: l.end + d,
      fixes: l.fixes.map((f) => ({ ...f, start: f.start + d, end: f.end + d })),
    };
  }

  // ---------- session: one per text box ----------

  class Session {
    constructor(field) {
      this.field = field;
      this.isCE = !(field instanceof HTMLTextAreaElement || field instanceof HTMLInputElement);
      this.text = '';
      this.lints = [];
      this.ranges = [];
      this.seq = 0;
      this.checkedText = null; // text of the last completed check
      this.timer = 0;
      this.raf = 0;
      this.active = false;
      this.mirror = null;
      field.addEventListener('input', () => this.onInput());
      field.addEventListener('scroll', () => this.position(), { passive: true });
      field.addEventListener('mouseup', () => setTimeout(() => this.onPointerUp(), 0));
      field.addEventListener('keyup', (e) => {
        if (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End') this.onPointerUp();
      });
      field.addEventListener('mousemove', (e) => this.onHover(e.clientX, e.clientY));
      field.addEventListener('mouseleave', () => ui.hoverLint(this, null));
    }

    // Selected text shows the rewrite toolbar; a plain click on a mistake opens its card.
    onPointerUp() {
      if (!this.active) return;
      const [start, end] = this.selectionRange();
      const picked = this.text.slice(start, end).trim();
      if (end > start && picked.length >= 8 && /\s/.test(picked)) {
        ui.closeCard();
        ui.showSelBar(this, start, end);
      } else {
        ui.hideSelBar();
        if (end === start) this.onCaret();
      }
    }

    selectionRange() {
      if (!this.isCE) return [this.field.selectionStart ?? 0, this.field.selectionEnd ?? 0];
      const sel = getSelection();
      if (!sel.rangeCount || !this.field.contains(sel.anchorNode)) return [0, 0];
      const model = (this.model = buildModel(this.field));
      const a = offsetOfPoint(model, sel.anchorNode, sel.anchorOffset);
      const b = offsetOfPoint(model, sel.focusNode, sel.focusOffset);
      return a <= b ? [a, b] : [b, a];
    }

    // Hovering an underlined word opens its card after a short pause.
    onHover(x, y) {
      if (!this.active || this.hoverRaf) return;
      this.hoverRaf = requestAnimationFrame(() => {
        this.hoverRaf = 0;
        ui.hoverLint(this, this.lintAtPoint(x, y));
      });
    }

    lintAtPoint(x, y) {
      const inside = (r) => x >= r.left && x <= r.right && y >= r.top - 2 && y <= r.bottom + 3;
      if (this.isCE) {
        for (const { range, lint } of this.ranges) {
          for (const r of range.getClientRects()) if (inside(r)) return lint;
        }
        return null;
      }
      if (!this.inner) return null;
      for (const m of this.inner.querySelectorAll('.mark')) {
        for (const r of m.getClientRects()) {
          if (inside(r)) return this.lints.find((l) => l.id === m.dataset.id) || null;
        }
      }
      return null;
    }

    readText() {
      if (!this.isCE) return this.field.value;
      this.model = buildModel(this.field);
      return this.model.text;
    }

    activate() {
      this.active = true;
      const text = this.readText();
      if (text !== this.text) {
        this.lints = shiftLints(this.text, text, this.lints);
        this.text = text;
        this.schedule(50);
      }
      this.render();
      const loop = () => {
        if (!this.active) return;
        this.position();
        this.raf = requestAnimationFrame(loop);
      };
      loop();
    }

    deactivate(clearMarks = false) {
      this.active = false;
      cancelAnimationFrame(this.raf);
      ui.hideBadge();
      ui.closeCard();
      ui.hideSelBar();
      ui.closePanel();
      this.mirror?.remove();
      this.mirror = null;
      if (clearMarks) {
        this.lints = [];
        this.clearRanges();
      }
    }

    onInput() {
      if (!this.active) return;
      ui.closeCard();
      ui.hideSelBar();
      const text = this.readText();
      this.lints = shiftLints(this.text, text, this.lints);
      this.text = text;
      this.render();
      this.schedule(DEBOUNCE_MS);
    }

    schedule(ms) {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.check(), ms);
    }

    async check() {
      const text = this.text;
      const seq = ++this.seq;
      if (text.length > MAX_LEN) {
        this.lints = [];
        this.render();
        return;
      }
      ui.setBadgeBusy(true);
      const res = await send({ type: 'check', text });
      if (seq !== this.seq || text !== this.text) return; // stale
      ui.setBadgeBusy(false);
      if (!res?.lints) return;
      this.lints = res.lints;
      this.checkedText = text;
      this.render();
    }

    // ----- drawing -----

    render() {
      if (this.isCE) this.renderRanges();
      else if (this.active) this.renderMirror();
      if (this.active) ui.showBadge(this);
    }

    clearRanges() {
      for (const { range, category } of this.ranges) {
        highlights[category]?.delete(range);
        highlights.active?.delete(range);
      }
      this.ranges = [];
    }

    renderRanges() {
      this.clearRanges();
      if (!window.CSS?.highlights) return;
      const model = this.model || buildModel(this.field);
      for (const lint of this.lints) {
        const range = rangeFor(model, lint.start, lint.end);
        if (!range) continue;
        highlights[lint.category].add(range);
        this.ranges.push({ range, category: lint.category, lint });
      }
    }

    renderMirror() {
      if (!this.mirror) {
        this.mirror = document.createElement('div');
        this.mirror.className = 'mirror';
        this.inner = document.createElement('div');
        this.inner.className = 'mirror-inner';
        this.mirror.append(this.inner);
        ui.root.append(this.mirror);
        this.copyStyles();
      }
      const frag = document.createDocumentFragment();
      let at = 0;
      for (const lint of this.lints) {
        if (lint.start < at) continue;
        frag.append(this.text.slice(at, lint.start));
        const mark = document.createElement('span');
        mark.className = 'mark ' + lint.category;
        mark.dataset.id = lint.id;
        mark.textContent = this.text.slice(lint.start, lint.end);
        frag.append(mark);
        at = lint.end;
      }
      frag.append(this.text.slice(at) + '​');
      this.inner.replaceChildren(frag);
      this.lastPos = '';
      this.position();
    }

    copyStyles() {
      const cs = getComputedStyle(this.field);
      const s = this.mirror.style;
      for (const p of MIRROR_PROPS) s[p] = cs[p];
      s.borderStyle = 'solid';
      s.borderColor = 'transparent';
      const isInput = this.field instanceof HTMLInputElement;
      s.whiteSpace = isInput ? 'pre' : 'pre-wrap';
      if (isInput) {
        const h =
          this.field.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
        this.inner.style.lineHeight = h + 'px';
        this.inner.style.width = 'max-content';
      }
    }

    position() {
      if (!this.mirror) {
        // contenteditable: highlights move with the text by themselves.
        ui.positionBadge(this);
        ui.positionCard();
        ui.positionSelBar();
        return;
      }
      const f = this.field;
      const r = f.getBoundingClientRect();
      const key = [r.left, r.top, r.width, r.height, f.scrollLeft, f.scrollTop, f.clientWidth].join();
      if (key === this.lastPos) return;
      this.lastPos = key;
      const s = this.mirror.style;
      s.left = r.left + 'px';
      s.top = r.top + 'px';
      s.width = r.width + 'px';
      s.height = r.height + 'px';
      if (!(f instanceof HTMLInputElement)) {
        const cs = getComputedStyle(f);
        this.inner.style.width =
          f.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) + 'px';
      }
      this.inner.style.transform = `translate(${-f.scrollLeft}px, ${-f.scrollTop}px)`;
      ui.positionBadge(this);
      ui.positionCard();
      ui.positionSelBar();
    }

    rectOf(lint) {
      if (this.isCE) {
        const entry = this.ranges.find((x) => x.lint.id === lint.id);
        return entry?.range.getBoundingClientRect();
      }
      return this.inner?.querySelector(`[data-id="${CSS.escape(lint.id)}"]`)?.getBoundingClientRect();
    }

    // Screen rect of the first line of text[start..end).
    rectOfRange(start, end) {
      let range = null;
      if (this.isCE) {
        range = rangeFor(this.model || buildModel(this.field), start, end);
      } else if (this.inner) {
        const model = { nodes: [] };
        const walker = document.createTreeWalker(this.inner, NodeFilter.SHOW_TEXT);
        for (let at = 0, n; (n = walker.nextNode()); at += n.data.length) model.nodes.push({ node: n, start: at });
        range = rangeFor(model, start, end);
      }
      const rects = range?.getClientRects();
      return rects?.length ? rects[0] : this.field.getBoundingClientRect();
    }

    // Asks the desktop app's CoEdIT model to rewrite a sentence. With no range,
    // uses the selection, or the sentence around the caret.
    async rewrite(mode, start, end) {
      if (start === undefined) {
        if (this.isCE) {
          const sel = getSelection();
          this.model = buildModel(this.field);
          start = sel.rangeCount ? offsetOfPoint(this.model, sel.anchorNode, sel.anchorOffset) : 0;
          end = sel.rangeCount ? offsetOfPoint(this.model, sel.focusNode, sel.focusOffset) : 0;
          if (start > end) [start, end] = [end, start];
        } else {
          start = this.field.selectionStart;
          end = this.field.selectionEnd;
        }
      }
      const text = this.readText();
      this.text = text;
      if (!text.trim()) return;
      const job = { mode, anchor: [start, end], state: 'loading' };
      ui.openRewrite(this, job);
      const res = await send({ type: 'rewrite', request: { text, start, end, mode } });
      if (ui.currentJob() !== job) return; // card was closed or replaced
      if (!res || res.error) {
        job.state = 'error';
        job.error = res?.error === 'offline' || !res
          ? 'Open the Grammar Helper desktop app to use rewrites. The writing model runs there.'
          : res.error;
      } else {
        Object.assign(job, res, { state: 'done', anchor: [res.start, res.end], sourceText: text });
      }
      ui.openRewrite(this, job);
    }

    applyRewrite(job) {
      if (this.readText() !== job.sourceText) return;
      this.replace(job.start, job.end, job.rewritten);
      this.text = this.readText();
      this.lints = [];
      this.render();
      this.schedule(50);
    }

    setActiveMark(lint) {
      if (this.isCE) {
        highlights.active?.clear();
        const entry = lint && this.ranges.find((x) => x.lint.id === lint.id);
        if (entry) highlights.active?.add(entry.range);
      } else if (this.inner) {
        for (const m of this.inner.querySelectorAll('.mark.active')) m.classList.remove('active');
        if (lint) this.inner.querySelector(`[data-id="${CSS.escape(lint.id)}"]`)?.classList.add('active');
      }
    }

    // ----- caret & card -----

    caretOffset() {
      if (!this.isCE) return this.field.selectionStart ?? -1;
      const sel = getSelection();
      if (!sel.rangeCount) return -1;
      const model = (this.model = buildModel(this.field));
      return offsetOfPoint(model, sel.focusNode, sel.focusOffset);
    }

    onCaret() {
      if (!this.active) return;
      const at = this.caretOffset();
      const lint = this.lints.find((l) => at >= l.start && at <= l.end);
      if (lint) ui.openCard(this, lint);
      else ui.closeCard();
    }

    nextIssue() {
      if (!this.lints.length) return;
      const at = this.caretOffset();
      const lint = this.lints.find((l) => l.start > at) || this.lints[0];
      this.select(lint.start, lint.end);
      requestAnimationFrame(() => ui.openCard(this, lint));
    }

    select(start, end) {
      this.field.focus();
      if (!this.isCE) {
        this.field.setSelectionRange(start, end);
        return true;
      }
      const range = rangeFor((this.model = buildModel(this.field)), start, end);
      if (!range) return false;
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      return true;
    }

    // Replaces text through the browser's editing pipeline so undo works and
    // frameworks like React see the change.
    replace(start, end, text) {
      if (!this.select(start, end)) return false;
      const ok = text
        ? document.execCommand('insertText', false, text)
        : document.execCommand('delete');
      if (!ok && !this.isCE) {
        this.field.setRangeText(text, start, end, 'end');
        this.field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      }
      return true;
    }

    applyFix(lint, fix) {
      if (this.readText().slice(lint.start, lint.end) !== lint.problem) {
        this.text = this.readText();
        this.schedule(0);
        return;
      }
      this.replace(fix.start, fix.end, fix.text);
      this.text = this.readText();
      this.lints = this.lints.filter((l) => l !== lint);
      this.schedule(50);
    }

    fixAll() {
      const fixes = this.lints
        .filter((l) => l.fixes.length)
        .map((l) => l.fixes[0])
        .sort((a, b) => b.start - a.start);
      let lastStart = Infinity;
      for (const f of fixes) {
        if (f.end > lastStart) continue;
        this.replace(f.start, f.end, f.text);
        lastStart = f.start;
      }
      this.text = this.readText();
      this.lints = [];
      this.render();
      this.schedule(50);
    }

    dropWhere(pred) {
      this.lints = this.lints.filter((l) => !pred(l));
      this.render();
    }
  }

  const MIRROR_PROPS = [
    'boxSizing', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
    'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontVariant', 'fontStretch',
    'fontFeatureSettings', 'fontKerning', 'letterSpacing', 'wordSpacing', 'lineHeight',
    'textTransform', 'textIndent', 'textAlign', 'tabSize', 'direction',
    'overflowWrap', 'wordBreak',
  ];

  // ---------- UI: badge + suggestion card (inside a shadow root) ----------

  const UI_CSS = `
    :host { all: initial; }
    [hidden] { display: none !important; }
    .badge, .card, .selbar, .panel { z-index: 1; color-scheme: light dark; }
    .mirror {
      z-index: 0;
      position: fixed; pointer-events: none; overflow: hidden; color: transparent;
      margin: 0; background: transparent;
    }
    .mirror-inner { white-space: inherit; }
    .mark { text-decoration: underline 2px; text-underline-offset: 3px; text-decoration-skip-ink: none; }
    .mark.spelling { text-decoration-color: #e5484d; }
    .mark.grammar { text-decoration-color: #3b82f6; }
    .mark.style { text-decoration-color: #a855f7; }
    .mark.active.spelling { background: rgba(229, 72, 77, .16); }
    .mark.active.grammar { background: rgba(59, 130, 246, .16); }
    .mark.active.style { background: rgba(168, 85, 247, .16); }

    .badge {
      position: fixed; width: 22px; height: 22px; border-radius: 11px; box-sizing: border-box;
      display: flex; align-items: center; justify-content: center; cursor: pointer;
      font: 600 11px/1 system-ui, -apple-system, "Segoe UI", sans-serif; color: #fff;
      box-shadow: 0 1px 3px rgba(0,0,0,.25); transition: transform .15s, opacity .2s;
    }
    .badge:hover { transform: scale(1.12); }
    .badge.ok { background: #16a34a; }
    .badge.spelling { background: #e5484d; }
    .badge.grammar { background: #3b82f6; }
    .badge.style { background: #a855f7; }
    .badge.busy { opacity: .6; }

    .card {
      position: fixed; width: 320px; max-width: calc(100vw - 16px); box-sizing: border-box;
      background: #fff; color: #1f2328; border-radius: 10px; padding: 12px 14px;
      box-shadow: 0 8px 28px rgba(0,0,0,.18), 0 1px 3px rgba(0,0,0,.12);
      font: 14px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
    }
    .head { display: flex; align-items: center; gap: 8px; color: #59636e; font-size: 12px; }
    .dot { width: 8px; height: 8px; border-radius: 4px; }
    .spelling .dot { background: #e5484d; }
    .grammar .dot { background: #3b82f6; }
    .style .dot { background: #a855f7; }
    .fixes { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin: 10px 0 6px; }
    .problem { text-decoration: line-through; color: #8a939c; }
    .arrow { color: #8a939c; }
    .fix {
      font-family: inherit; font-size: 14px; font-weight: 600; line-height: 1; color: #fff; background: #16a34a;
      border: 0; border-radius: 6px; padding: 7px 10px; cursor: pointer;
    }
    .fix:hover { background: #15803d; }
    .msg { color: #3d444d; font-size: 13px; margin-top: 6px; }
    .actions { display: flex; gap: 14px; margin-top: 10px; border-top: 1px solid #eef0f2; padding-top: 8px; }
    .link {
      font-family: inherit; font-size: 12px; line-height: 1; background: none; border: 0; padding: 2px 0;
      color: #59636e; cursor: pointer;
    }
    .link:hover { color: #1f2328; text-decoration: underline; }

    .rewrite .dot { background: #16a34a; }
    .rw-row { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; margin-top: 8px; padding-top: 8px; border-top: 1px solid #eef0f2; }
    .rw-label { font-size: 12px; color: #59636e; margin-right: 2px; }
    .chip {
      font-family: inherit; font-size: 12px; line-height: 1; padding: 5px 8px; cursor: pointer;
      background: transparent; color: inherit; border: 1px solid #d0d7de; border-radius: 999px;
    }
    .chip:hover { border-color: #16a34a; color: #16a34a; }
    .chip.on { background: #16a34a; border-color: #16a34a; color: #fff; }
    .rw-text { font-size: 14px; line-height: 1.5; margin: 10px 0 4px; }
    .rw-text .del { color: #e5484d; text-decoration: line-through; }
    .rw-text .add { color: #15803d; background: rgba(22, 163, 74, .14); border-radius: 3px; }
    .rw-actions { display: flex; align-items: center; gap: 12px; margin-top: 8px; }
    .selbar {
      position: fixed; display: flex; align-items: center; gap: 4px; padding: 5px 6px;
      background: #fff; color: #1f2328; border-radius: 999px;
      box-shadow: 0 6px 20px rgba(0,0,0,.18), 0 1px 3px rgba(0,0,0,.12);
      font: 13px/1 system-ui, -apple-system, "Segoe UI", sans-serif;
    }
    .sel-icon { color: #16a34a; font-size: 14px; padding: 0 4px 0 6px; }
    .selbar .chip { border-color: transparent; }
    .selbar .chip:hover { border-color: #16a34a; }

    .panel {
      position: fixed; top: 16px; right: 16px; bottom: 16px; width: 340px; max-width: calc(100vw - 32px);
      box-sizing: border-box; display: flex; flex-direction: column; overflow: hidden;
      background: #fff; color: #1f2328; border-radius: 14px;
      box-shadow: 0 12px 40px rgba(0,0,0,.22), 0 1px 3px rgba(0,0,0,.12);
      font: 14px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
    }
    .p-head { display: flex; align-items: center; justify-content: space-between; padding: 14px 16px 10px; }
    .p-title { font-weight: 700; font-size: 15px; }
    .p-close { background: none; border: 0; font-size: 22px; line-height: 1; color: #59636e; cursor: pointer; padding: 0 4px; }
    .p-close:hover { color: #1f2328; }
    .p-score { display: flex; align-items: center; gap: 14px; padding: 4px 16px 12px; }
    .ring {
      --c: #16a34a; width: 56px; height: 56px; border-radius: 50%; flex: none;
      display: grid; place-items: center; font-weight: 700; font-size: 17px; position: relative;
      background: conic-gradient(var(--c) calc(var(--pct) * 1%), #e6e9ec 0);
    }
    .ring::before { content: ""; position: absolute; inset: 5px; border-radius: 50%; background: #fff; }
    .ring { isolation: isolate; }
    .ring::before { z-index: -1; }
    .ring.ok { --c: #f59e0b; }
    .ring.low { --c: #e5484d; }
    .p-big { font-weight: 600; }
    .p-sub { color: #59636e; font-size: 12px; margin-top: 2px; }
    .p-counts { display: flex; gap: 12px; padding: 0 16px 12px; font-size: 12px; color: #59636e; border-bottom: 1px solid #eef0f2; }
    .p-pill { display: inline-flex; align-items: center; gap: 5px; text-transform: capitalize; }
    .p-pill .sw { width: 8px; height: 8px; border-radius: 4px; }
    .p-pill.spelling .sw { background: #e5484d; }
    .p-pill.grammar .sw { background: #3b82f6; }
    .p-pill.style .sw { background: #a855f7; }
    .p-all { margin: 12px 16px 0; align-self: flex-start; }
    .p-list { flex: 1; overflow-y: auto; padding: 12px 16px 16px; display: flex; flex-direction: column; gap: 10px; }
    .p-item {
      border: 1px solid #eef0f2; border-left: 3px solid var(--c); border-radius: 10px; padding: 10px 12px; cursor: pointer;
    }
    .p-item:hover { box-shadow: 0 2px 10px rgba(0,0,0,.08); }
    .p-item.spelling { --c: #e5484d; }
    .p-item.grammar { --c: #3b82f6; }
    .p-item.style { --c: #a855f7; }
    .p-item .fixes { margin: 8px 0 4px; }
    .p-item .link { margin-top: 6px; }
    .p-empty { color: #59636e; text-align: center; padding: 30px 0; }

    .rw-warn { margin-top: 8px; padding: 6px 8px; border-radius: 6px; font-size: 12px; background: rgba(245, 158, 11, .16); }
    .rw-edit {
      display: block; width: 100%; box-sizing: border-box; min-height: 64px; margin: 10px 0 4px; padding: 7px 8px;
      font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; color: inherit; background: transparent;
      border: 1px solid #d0d7de; border-radius: 6px; resize: vertical; outline: none;
    }
    .rw-edit:focus { border-color: #16a34a; }
    .spinner {
      display: inline-block; width: 11px; height: 11px; margin-right: 7px; vertical-align: -1px;
      border: 2px solid #d0d7de; border-top-color: #16a34a; border-radius: 50%;
      animation: gh-spin .8s linear infinite;
    }
    @keyframes gh-spin { to { transform: rotate(360deg); } }

    @media (prefers-color-scheme: dark) {
      .card { background: #22272e; color: #e6edf3; box-shadow: 0 8px 28px rgba(0,0,0,.5); }
      .head, .link { color: #9da7b3; }
      .msg { color: #c9d1d9; }
      .actions { border-top-color: #30363d; }
      .link:hover { color: #e6edf3; }
      .rw-row { border-top-color: #30363d; }
      .rw-label { color: #9da7b3; }
      .chip { border-color: #444c56; }
      .rw-text .add { color: #4ade80; }
      .selbar, .panel { background: #22272e; color: #e6edf3; }
      .ring::before { background: #22272e; }
      .ring { background: conic-gradient(var(--c) calc(var(--pct) * 1%), #30363d 0); }
      .p-sub, .p-counts, .p-empty, .p-close { color: #9da7b3; }
      .p-close:hover { color: #e6edf3; }
      .p-counts { border-bottom-color: #30363d; }
      .p-item { border-color: #30363d; border-left-color: var(--c); }
    }
  `;

  const ui = (() => {
    const host = document.createElement('grammar-helper');
    host.style.cssText = 'all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483646;';
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `<style>${UI_CSS}</style>
      <div class="badge" hidden><span class="count"></span></div>
      <div class="card" hidden></div>
      <div class="selbar" hidden></div>
      <div class="panel" hidden></div>`;
    const badge = root.querySelector('.badge');
    const card = root.querySelector('.card');
    const selbar = root.querySelector('.selbar');
    const panel = root.querySelector('.panel');
    let cardFor = null; // { session, lint, hover } or { session, job }
    let selFor = null; // { session, start, end }
    let panelOpen = false;
    let hoverTimer = 0;
    let overCard = false;

    const mount = () => {
      if (!host.isConnected) (document.body || document.documentElement).append(host);
    };

    // Keep focus in the text box while clicking our UI.
    // (The rewrite edit box is the exception: it needs focus to be typed in.)
    for (const el of [badge, card, selbar, panel]) {
      el.addEventListener('mousedown', (e) => {
        if (!(e.target instanceof HTMLTextAreaElement)) e.preventDefault();
      });
    }

    // The badge opens the suggestions panel.
    badge.addEventListener('click', () => {
      if (panelOpen) return closePanel();
      panelOpen = true;
      renderPanel(current);
    });

    // Cards opened by hovering close again when the mouse moves away.
    const closeHoverSoon = () => {
      clearTimeout(hoverTimer);
      hoverTimer = setTimeout(() => {
        if (!overCard && cardFor?.hover) closeCard();
      }, 400);
    };
    card.addEventListener('mouseenter', () => {
      overCard = true;
      clearTimeout(hoverTimer);
    });
    card.addEventListener('mouseleave', () => {
      overCard = false;
      if (cardFor?.hover) closeHoverSoon();
    });

    function hoverLint(session, lint) {
      clearTimeout(hoverTimer);
      if (cardFor?.job || selFor) return; // don't replace a rewrite in progress
      if (lint) {
        if (cardFor?.lint?.id === lint.id) return;
        hoverTimer = setTimeout(() => openCard(session, lint, { hover: true }), 250);
      } else if (cardFor?.hover) {
        closeHoverSoon();
      }
    }

    document.addEventListener('mousedown', (e) => {
      if (cardFor && !e.composedPath().includes(host) && !cardFor.session.field.contains(e.target)) closeCard();
    }, true);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && cardFor) closeCard();
    }, true);

    function showBadge(s) {
      mount();
      const n = s.lints.length;
      badge.hidden = s.text.trim().length === 0 && n === 0;
      const worst = CATEGORIES.find((c) => s.lints.some((l) => l.category === c));
      badge.className = 'badge ' + (worst || 'ok');
      const pending = !n && s.checkedText !== s.text;
      if (pending) badge.className = 'badge ok busy';
      badge.querySelector('.count').textContent = n ? String(n) : pending ? '…' : '✓';
      badge.title = n ? `${n} suggestion${n > 1 ? 's' : ''} — click to see them all` : 'Looks good';
      positionBadge(s);
      renderPanel(s);
    }

    function setBadgeBusy(busy) {
      badge.classList.toggle('busy', busy);
    }

    function positionBadge(s) {
      if (badge.hidden || s !== current) return;
      const r = s.field.getBoundingClientRect();
      const size = 22;
      const inset = r.height < 44 ? Math.max(2, (r.height - size) / 2) : 6;
      badge.style.left = r.right - size - 6 + 'px';
      badge.style.top = r.bottom - size - inset + 'px';
    }

    function hideBadge() {
      badge.hidden = true;
    }

    function openCard(session, lint, { hover = false } = {}) {
      mount();
      if (cardFor?.lint && cardFor.session !== session) cardFor.session.setActiveMark(null);
      cardFor = { session, lint, hover };
      session.setActiveMark(lint);
      card.className = 'card ' + lint.category;
      card.replaceChildren();

      const head = el('div', 'head');
      head.append(el('span', 'dot'), el('span', 'kind', lint.label));
      card.append(head);

      if (lint.fixes.length) {
        const fixes = el('div', 'fixes');
        const problem = el('span', 'problem', lint.problem);
        fixes.append(problem, el('span', 'arrow', '→'));
        for (const fix of lint.fixes.slice(0, 4)) {
          const b = el('button', 'fix', fix.label);
          b.addEventListener('click', () => {
            closeCard();
            session.applyFix(lint, fix);
          });
          fixes.append(b);
        }
        card.append(fixes);
      }

      card.append(el('div', 'msg', lint.message));

      const actions = el('div', 'actions');
      const ignore = el('button', 'link', 'Ignore');
      ignore.addEventListener('click', () => {
        send({ type: 'ignore', problem: lint.problem, message: lint.message });
        closeCard();
        session.dropWhere((l) => l.problem.toLowerCase() === lint.problem.toLowerCase() && l.message === lint.message);
      });
      actions.append(ignore);
      if (lint.category === 'spelling') {
        const add = el('button', 'link', 'Add to dictionary');
        add.addEventListener('click', () => {
          send({ type: 'addWord', word: lint.problem });
          closeCard();
          session.dropWhere((l) => l.category === 'spelling' && l.problem === lint.problem);
        });
        actions.append(add);
      }
      if (session.lints.length > 1) {
        const all = el('button', 'link', `Fix all (${session.lints.length})`);
        all.addEventListener('click', () => {
          closeCard();
          session.fixAll();
        });
        actions.append(all);
      }
      card.append(actions, rewriteRow(session, lint.start));

      card.hidden = false;
      positionCard();
    }

    // "Rewrite sentence: Fix · Simpler · …" chips.
    function rewriteRow(session, at, current) {
      const row = el('div', 'rw-row');
      row.append(el('span', 'rw-label', 'Rewrite sentence:'));
      for (const [mode, label] of Object.entries(REWRITE_LABELS)) {
        const b = el('button', 'chip' + (mode === current ? ' on' : ''), label);
        b.addEventListener('click', () => session.rewrite(mode, at, at));
        row.append(b);
      }
      return row;
    }

    function openRewrite(session, job) {
      mount();
      hideSelBar();
      if (cardFor?.lint) cardFor.session.setActiveMark(null);
      cardFor = { session, job };
      card.className = 'card rewrite';
      card.replaceChildren();

      const head = el('div', 'head');
      head.append(el('span', 'dot'), el('span', 'kind', 'Rewrite · ' + REWRITE_LABELS[job.mode]));
      card.append(head);

      if (job.state === 'loading') {
        const msg = el('div', 'msg');
        msg.append(el('span', 'spinner'), 'Rewriting…');
        card.append(msg);
      } else if (job.state === 'error') {
        card.append(el('div', 'msg', job.error));
      } else if (job.rewritten === job.original) {
        card.append(el('div', 'msg', 'No changes suggested. This sentence already reads well.'));
      } else {
        const text = el('div', 'rw-text');
        for (const part of job.diff) text.append(part.type === 'same' ? part.text : el('span', part.type, part.text));
        let editBox = null;
        const log = (action, final) => send({
          type: 'feedback',
          entry: { mode: job.mode, original: job.original, suggestion: job.rewritten, final, action },
        });
        const actions = el('div', 'rw-actions');
        const accept = el('button', 'fix', 'Accept');
        accept.addEventListener('click', () => {
          const final = editBox ? editBox.value.trim() : job.rewritten;
          log(final === job.rewritten ? 'accepted' : 'edited', final);
          closeCard();
          session.applyRewrite({ ...job, rewritten: final });
        });
        const edit = el('button', 'link', 'Edit');
        edit.addEventListener('click', () => {
          editBox = el('textarea', 'rw-edit');
          editBox.value = job.rewritten;
          text.replaceWith(editBox);
          edit.remove();
          editBox.focus();
        });
        const dismiss = el('button', 'link', 'Dismiss');
        dismiss.addEventListener('click', () => {
          log('dismissed', null);
          closeCard();
        });
        actions.append(accept, edit, dismiss);
        card.append(text);
        if (job.warning) card.append(el('div', 'rw-warn', job.warning));
        card.append(actions);
      }
      if (job.state !== 'loading') card.append(rewriteRow(session, job.anchor[0], job.mode));

      card.hidden = false;
      positionCard();
    }

    function positionCard() {
      if (!cardFor || card.hidden) return;
      const r = cardFor.lint
        ? cardFor.session.rectOf(cardFor.lint)
        : cardFor.session.rectOfRange(...cardFor.job.anchor);
      if (!r || (!r.width && !r.height)) return;
      const w = card.offsetWidth;
      const h = card.offsetHeight;
      let top = r.bottom + 6;
      if (top + h > innerHeight - 8) top = Math.max(8, r.top - h - 6);
      const left = Math.min(Math.max(8, r.left), innerWidth - w - 8);
      card.style.left = left + 'px';
      card.style.top = top + 'px';
    }

    function closeCard() {
      overCard = false;
      if (!cardFor) return;
      cardFor.session.setActiveMark(null);
      cardFor = null;
      card.hidden = true;
    }

    const currentJob = () => cardFor?.job;

    // ----- toolbar shown over selected text -----

    function showSelBar(session, start, end) {
      mount();
      selFor = { session, start, end };
      selbar.replaceChildren(el('span', 'sel-icon', '✦'));
      for (const [mode, label] of Object.entries(REWRITE_LABELS)) {
        const b = el('button', 'chip', label);
        b.addEventListener('click', () => {
          hideSelBar();
          session.rewrite(mode, start, end);
        });
        selbar.append(b);
      }
      selbar.hidden = false;
      positionSelBar();
    }

    function positionSelBar() {
      if (!selFor || selbar.hidden) return;
      const r = selFor.session.rectOfRange(selFor.start, selFor.end);
      const w = selbar.offsetWidth;
      const h = selbar.offsetHeight;
      let top = r.top - h - 8;
      if (top < 8) top = r.bottom + 8;
      selbar.style.left = Math.min(Math.max(8, r.left), innerWidth - w - 8) + 'px';
      selbar.style.top = top + 'px';
    }

    function hideSelBar() {
      selFor = null;
      selbar.hidden = true;
    }

    // ----- suggestions panel -----

    // 100 = no issues. Mistakes cost more than style suggestions, scaled by length.
    function writingScore(lints, words) {
      const weight = { spelling: 4, grammar: 4, style: 1.5 };
      const penalty = lints.reduce((p, l) => p + weight[l.category], 0);
      return Math.max(0, Math.round(100 - (penalty * 120) / Math.max(words, 40)));
    }

    function renderPanel(s) {
      if (!panelOpen || !s) return;
      mount();
      panel.replaceChildren();

      const head = el('div', 'p-head');
      const close = el('button', 'p-close', '×');
      close.title = 'Close';
      close.addEventListener('click', closePanel);
      head.append(el('span', 'p-title', 'Grammar Helper'), close);
      panel.append(head);

      const words = (s.text.match(/\S+/g) || []).length;
      const score = writingScore(s.lints, words);
      const scoreRow = el('div', 'p-score');
      const ring = el('div', 'ring', String(score));
      ring.style.setProperty('--pct', score);
      ring.classList.add(score >= 85 ? 'good' : score >= 60 ? 'ok' : 'low');
      const info = el('div', 'p-info');
      info.append(
        el('div', 'p-big', 'Writing score'),
        el('div', 'p-sub', `${words} word${words === 1 ? '' : 's'} · ${s.lints.length} suggestion${s.lints.length === 1 ? '' : 's'}`),
      );
      scoreRow.append(ring, info);
      panel.append(scoreRow);

      const counts = el('div', 'p-counts');
      for (const c of CATEGORIES) {
        const pill = el('span', 'p-pill ' + c);
        pill.append(el('i', 'sw'), `${s.lints.filter((l) => l.category === c).length} ${c}`);
        counts.append(pill);
      }
      panel.append(counts);

      const fixable = s.lints.filter((l) => l.fixes.length).length;
      if (fixable > 1) {
        const all = el('button', 'fix p-all', `Fix all (${fixable})`);
        all.addEventListener('click', () => s.fixAll());
        panel.append(all);
      }

      const list = el('div', 'p-list');
      if (!s.lints.length) {
        list.append(el('div', 'p-empty', s.checkedText === s.text ? '✓ No issues found. Nice work!' : 'Checking…'));
      }
      for (const lint of s.lints) {
        const item = el('div', 'p-item ' + lint.category);
        const ih = el('div', 'head');
        ih.append(el('span', 'dot'), el('span', 'kind', lint.label));
        item.append(ih);
        if (lint.fixes.length) {
          const fixes = el('div', 'fixes');
          fixes.append(el('span', 'problem', lint.problem), el('span', 'arrow', '→'));
          for (const fix of lint.fixes.slice(0, 3)) {
            const b = el('button', 'fix', fix.label);
            b.addEventListener('click', (e) => {
              e.stopPropagation();
              s.applyFix(lint, fix);
            });
            fixes.append(b);
          }
          item.append(fixes);
        } else {
          item.append(el('div', 'fixes', lint.problem));
        }
        item.append(el('div', 'msg', lint.message));
        const ignore = el('button', 'link', 'Ignore');
        ignore.addEventListener('click', (e) => {
          e.stopPropagation();
          send({ type: 'ignore', problem: lint.problem, message: lint.message });
          s.dropWhere((l) => l.problem.toLowerCase() === lint.problem.toLowerCase() && l.message === lint.message);
        });
        item.append(ignore);
        item.addEventListener('mouseenter', () => s.setActiveMark(lint));
        item.addEventListener('mouseleave', () => s.setActiveMark(null));
        item.addEventListener('click', () => s.select(lint.start, lint.end));
        list.append(item);
      }
      panel.append(list);
      panel.hidden = false;
    }

    function closePanel() {
      panelOpen = false;
      panel.hidden = true;
    }

    return {
      root, showBadge, hideBadge, positionBadge, setBadgeBusy,
      openCard, openRewrite, currentJob, positionCard, closeCard, hoverLint,
      showSelBar, positionSelBar, hideSelBar, closePanel,
    };
  })();

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  window.addEventListener('scroll', () => current?.position(), { capture: true, passive: true });

  // ---------- keyboard shortcuts (forwarded from background) ----------

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type !== 'command' || !current?.active) return;
    if (msg.command === 'next-issue') current.nextIssue();
    if (msg.command === 'fix-all') current.fixAll();
    if (msg.command === 'rewrite') current.rewrite('fix');
  });
})();
