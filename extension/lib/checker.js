// Shared grammar-checking core used by both the Chrome extension and the desktop app.
// Wraps a Harper LocalLinter and returns plain JSON-safe objects, so results can be
// passed over chrome.runtime messaging or Electron IPC.
//
// Each lint looks like:
//   { id, start, end, kind, category, message, problem,
//     fixes: [{ label, start, end, text }] }
// where every fix is a plain "replace text[start..end) with text" edit.

const SPELLING_KINDS = new Set(['Spelling', 'Typo']);
const GRAMMAR_KINDS = new Set([
  'Agreement', 'BoundaryError', 'Capitalization', 'Eggcorn', 'Grammar',
  'Malapropism', 'Punctuation', 'Usage', 'WordOrder', 'Nonstandard',
]);

// Groups Harper's many lint kinds into the three colours the UI shows.
export function categoryOf(kind) {
  if (SPELLING_KINDS.has(kind)) return 'spelling';
  if (GRAMMAR_KINDS.has(kind)) return 'grammar';
  return 'style';
}

// `dialect` is a Harper Dialect value (American = 0, British = 1, ...).
export function createChecker({ LocalLinter, binary, dialect }) {
  const linter = new LocalLinter({ binary, dialect });
  let ready = null;
  const ignored = new Set();

  function setup() {
    if (!ready) ready = linter.setup();
    return ready;
  }

  async function check(text) {
    await setup();
    if (!text || !text.trim()) return [];
    const lints = await linter.lint(text, { language: 'plaintext' });
    const out = [];
    for (const lint of lints) {
      const span = lint.span();
      const start = span.start;
      const end = span.end;
      const problem = text.slice(start, end);
      const kind = lint.lint_kind();
      const message = lint.message();
      const key = ignoreKey(problem, message);
      if (ignored.has(key)) continue;

      const fixes = [];
      for (const s of lint.suggestions()) {
        const replacement = s.get_replacement_text();
        switch (s.kind()) {
          case 0: // Replace
            fixes.push({ label: replacement || '(remove)', start, end, text: replacement });
            break;
          case 1: // Remove
            fixes.push({ label: '(remove)', start, end, text: '' });
            break;
          case 2: // InsertAfter
            fixes.push({ label: problem + replacement, start, end, text: problem + replacement });
            break;
        }
      }

      const category = categoryOf(kind);
      out.push({
        id: `${start}:${end}:${kind}`,
        start, end, kind, category,
        label: labelOf(category, kind),
        message: stripMarkdown(message),
        problem,
        fixes,
      });
      lint.free?.();
    }
    return out;
  }

  function ignore(problem, message) {
    ignored.add(ignoreKey(problem, message));
  }

  async function addWords(words) {
    await setup();
    await linter.importWords(words);
  }

  return { setup, check, ignore, addWords };
}

// Applies one fix to a string.
export function applyFix(text, fix) {
  return text.slice(0, fix.start) + fix.text + text.slice(fix.end);
}

// Applies the first fix of every lint, back to front so earlier offsets stay valid.
export function applyAll(text, lints) {
  const fixes = lints
    .filter((l) => l.fixes.length)
    .map((l) => l.fixes[0])
    .sort((a, b) => b.start - a.start);
  let lastStart = Infinity;
  for (const fix of fixes) {
    if (fix.end > lastStart) continue; // skip overlapping fixes
    text = applyFix(text, fix);
    lastStart = fix.start;
  }
  return text;
}

// ---------- rewriting helpers (used with the CoEdIT model) ----------

// The CoEdIT instructions for each rewrite mode. Modes with several prompts try
// them in order to get alternative candidates; `guard` modes reject candidates
// that bring in new words (a sign the model changed the meaning).
export const REWRITE_MODES = {
  fix: {
    label: 'Fix',
    prompts: ['Fix grammatical errors in this sentence: ', 'Fix the grammar: ', 'Fix grammar: '],
    guard: true,
  },
  simpler: { label: 'Simpler', prompts: ['Make this simpler: '] },
  clearer: { label: 'Clearer', prompts: ['Clarify this sentence: ', 'Fix the grammar: '], guard: true },
  formal: { label: 'Formal', prompts: ['Write this more formally: '] },
  paraphrase: { label: 'Paraphrase', prompts: ['Paraphrase this: '] },
};

// Small words a grammar fix may legitimately add.
const FILLER_WORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'am', 'have', 'has', 'had',
  'do', 'does', 'did', 'to', 'of', 'not', "n't", "'s", "'re", "'ve", "'m", "'ll", "'d",
]);

const wordsOf = (s) => s.toLowerCase().match(/[a-z0-9]+(?:'[a-z]+)?/g) || [];

function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

// Words in `candidate` that don't come from `original`: not present there, not a
// spelling/form variant of an original word (buyed -> bought, its -> it's), and
// not a small filler word. Several of these mean the meaning probably changed.
export function novelWords(original, candidate) {
  const orig = wordsOf(original);
  const origSet = new Set(orig);
  const close = (w) =>
    orig.some((o) => {
      const limit = Math.max(1, Math.floor(Math.min(o.length, w.length) / 3));
      return editDistance(o, w) <= limit || (o.length >= 4 && w.startsWith(o.slice(0, 3)) && o[0] === w[0]);
    });
  return wordsOf(candidate).filter((w) => !origSet.has(w) && !FILLER_WORDS.has(w) && !close(w));
}

// How many novel words a guarded rewrite may introduce.
export function novelAllowance(original) {
  return Math.max(1, Math.round(wordsOf(original).length * 0.15));
}

// Finds the sentence around `offset`: from the previous ., ! or ? (or line break)
// to the next one, trimmed of surrounding whitespace.
export function sentenceAt(text, offset) {
  let start = offset;
  while (start > 0) {
    const ch = text[start - 1];
    if (ch === '\n' || (/\s/.test(ch) && /[.!?]["')\]]*$/.test(text.slice(Math.max(0, start - 4), start - 1)))) break;
    start--;
  }
  let end = offset;
  while (end < text.length && text[end] !== '\n') {
    if (/[.!?]/.test(text[end]) && (end + 1 >= text.length || /\s/.test(text[end + 1]))) {
      end++;
      break;
    }
    end++;
  }
  while (start < end && /\s/.test(text[start])) start++;
  while (end > start && /\s/.test(text[end - 1])) end--;
  return { start, end };
}

// Word-level diff for showing what a rewrite changed.
// Returns [{ type: 'same' | 'del' | 'add', text }].
export function diffWords(a, b) {
  const A = a.match(/\s+|[^\s]+/g) || [];
  const B = b.match(/\s+|[^\s]+/g) || [];
  const n = A.length;
  const m = B.length;
  const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = [];
  const push = (type, text) => {
    const last = out[out.length - 1];
    if (last && last.type === type) last.text += text;
    else out.push({ type, text });
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { push('same', A[i]); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) push('del', A[i++]);
    else push('add', B[j++]);
  }
  while (i < n) push('del', A[i++]);
  while (j < m) push('add', B[j++]);
  return out;
}

// "Grammar · Word Order", or just "Spelling" when the kind adds nothing.
function labelOf(category, kind) {
  const cat = category[0].toUpperCase() + category.slice(1);
  const pretty = kind.replace(/([a-z])([A-Z])/g, '$1 $2');
  return pretty.toLowerCase() === category || kind === 'Typo' ? cat : `${cat} · ${pretty}`;
}

function ignoreKey(problem, message) {
  return problem.toLowerCase() + '\u0000' + message;
}

function stripMarkdown(s) {
  return s.replace(/`([^`]*)`/g, '“$1”');
}
