// Desktop app main process: window, tray, global hotkey and the grammar engine.
import { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, clipboard, nativeImage, systemPreferences, protocol, net, shell } from 'electron';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { LocalLinter, Dialect } from 'harper.js';
import { binaryInlined } from 'harper.js/binaryInlined';
import { createChecker, sentenceAt, diffWords, novelWords, novelAllowance, REWRITE_MODES } from './lib/checker.js';

const HOTKEY = 'CommandOrControl+Alt+G';
const HOTKEY_LABEL = process.platform === 'darwin' ? '⌘⌥G' : 'Ctrl+Alt+G';
const dir = path.dirname(fileURLToPath(import.meta.url));
const isMac = process.platform === 'darwin';

let win = null;
let tray = null;
let rebuildTrayMenu = null;
let quitting = false;

if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => showWindow());

// ---------- grammar engine ----------

const checker = createChecker({ LocalLinter, binary: binaryInlined, dialect: Dialect.British });
const wordsFile = () => path.join(app.getPath('userData'), 'words.json');

function loadWords() {
  try {
    return JSON.parse(readFileSync(wordsFile(), 'utf8'));
  } catch {
    return [];
  }
}

const ready = checker.setup().then(() => {
  const words = loadWords();
  if (words.length) return checker.addWords(words);
});

ipcMain.handle('check', async (_e, text) => {
  await ready;
  return checker.check(text);
});
ipcMain.handle('ignore', (_e, problem, message) => checker.ignore(problem, message));
ipcMain.handle('addWord', async (_e, word) => {
  const words = loadWords();
  if (!words.includes(word)) words.push(word);
  writeFileSync(wordsFile(), JSON.stringify(words));
  await checker.addWords([word]);
});
ipcMain.handle('copy', (_e, text) => clipboard.writeText(text));
ipcMain.handle('readClipboard', () => clipboard.readText());
ipcMain.handle('pasteBack', (_e, text) => pasteBack(text));
ipcMain.handle('info', () => ({ hotkey: HOTKEY_LABEL, platform: process.platform }));
ipcMain.handle('rewrite', (_e, req) => rewrite(req));
ipcMain.handle('rewriterStatus', () => rewriterStatus());
ipcMain.handle('feedback', (_e, entry) => recordCorrection({ ...entry, source: 'app' }));

// ---------- CoEdIT rewriter (runs in a hidden window) ----------

const REWRITE_PORT = 47321;
// Packaged: models ship as extra resources. Development: app/models.
const modelsDir = app.isPackaged ? path.join(process.resourcesPath, 'models') : path.join(dir, 'models');
const hasModel = () => existsSync(path.join(modelsDir, 'coedit-large', 'onnx', 'encoder_model_quantized.onnx'));

protocol.registerSchemesAsPrivileged([
  { scheme: 'gh', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

// gh://app/models/... -> model files, gh://app/... -> app files.
function serveAppProtocol() {
  protocol.handle('gh', async (req) => {
    const { pathname } = new URL(req.url);
    const rel = decodeURIComponent(pathname).replace(/^\/+/, '');
    const base = rel.startsWith('models/') ? modelsDir : dir;
    const file = path.resolve(base, rel.startsWith('models/') ? rel.slice(7) : rel);
    if (!file.startsWith(base)) return new Response('Forbidden', { status: 403 });
    const res = await net.fetch(pathToFileURL(file).toString());
    const headers = new Headers(res.headers);
    // Cross-origin isolation lets WebAssembly use multiple threads.
    headers.set('Cross-Origin-Opener-Policy', 'same-origin');
    headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
    headers.set('Cross-Origin-Resource-Policy', 'same-origin');
    if (file.endsWith('.mjs') || file.endsWith('.js')) headers.set('Content-Type', 'text/javascript');
    if (file.endsWith('.wasm')) headers.set('Content-Type', 'application/wasm');
    return new Response(res.body, { status: res.status, headers });
  });
}

let workerWin = null;
let workerReady = null;
let modelState = 'idle'; // idle | loading | ready | missing | error
let queue = Promise.resolve();

function getWorker() {
  if (!workerReady) {
    workerWin = new BrowserWindow({
      show: false,
      webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false },
    });
    workerReady = new Promise((resolve, reject) => {
      workerWin.webContents.once('did-finish-load', resolve);
      workerWin.webContents.once('did-fail-load', (_e, code, desc) => reject(new Error(desc)));
    });
    workerWin.loadURL('gh://app/rewriter/worker.html');
    workerWin.on('closed', () => {
      workerWin = null;
      workerReady = null;
      modelState = 'idle';
    });
  }
  return workerReady.then(() => workerWin);
}

function rewriterStatus() {
  if (!hasModel()) return 'missing';
  return modelState;
}

async function loadModel() {
  if (!hasModel()) {
    modelState = 'missing';
    throw new Error('The rewriting model is not installed.');
  }
  if (modelState === 'ready') return getWorker();
  modelState = 'loading';
  try {
    const w = await getWorker();
    await w.webContents.executeJavaScript('rewriter.load()');
    modelState = 'ready';
    return w;
  } catch (err) {
    modelState = 'error';
    throw err;
  }
}

// Rewrites text[start..end) (or the sentence around `start` when the range is
// empty) using one of the REWRITE_MODES. Requests run one at a time.
function rewrite({ text, start, end, mode }) {
  const job = queue.then(async () => {
    const spec = REWRITE_MODES[mode] || REWRITE_MODES.fix;
    if (start === end) ({ start, end } = sentenceAt(text, start));
    const original = text.slice(start, end);
    if (!original.trim()) throw new Error('Nothing to rewrite here.');
    if (original.length > 1500) throw new Error('That passage is too long. Select a sentence or two.');
    const w = await loadModel();
    const t0 = Date.now();
    const best = await bestCandidate(w, spec, original);
    return {
      start, end, mode, original,
      rewritten: best.text,
      diff: diffWords(original, best.text),
      warning: best.safe ? null : 'This rewrite adds new words. Check it still means what you meant.',
      ms: Date.now() - t0,
    };
  });
  queue = job.catch(() => {});
  return job;
}

// Runs the mode's prompts one by one and keeps the best candidate: one that
// passes the meaning check and leaves the fewest problems Harper can find.
// Stops early as soon as a candidate is safe and clean.
async function bestCandidate(w, spec, original) {
  const allowance = novelAllowance(original);
  const candidates = [];
  for (const prompt of spec.prompts) {
    const text = (await w.webContents.executeJavaScript(`rewriter.run(${JSON.stringify(prompt + original)})`)).trim();
    if (!text || candidates.some((c) => c.text === text)) continue;
    const novel = novelWords(original, text).length;
    const issues = (await checker.check(text)).filter((l) => l.category !== 'style').length;
    const c = { text, novel, issues, safe: !spec.guard || novel <= allowance };
    candidates.push(c);
    if (c.safe && issues === 0) return c;
  }
  if (!candidates.length) return { text: original, safe: true };
  const safe = candidates.filter((c) => c.safe);
  const pool = safe.length ? safe : candidates;
  return pool.reduce((a, b) => (b.issues * 2 + b.novel < a.issues * 2 + a.novel ? b : a));
}

// ---------- saved corrections (training data for a future fine-tune) ----------

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
const trainingDir = () => path.join(app.getPath('userData'), 'training');
const correctionsFile = () => path.join(trainingDir(), 'corrections.jsonl');

function loadSettings() {
  try {
    return { saveCorrections: true, ...JSON.parse(readFileSync(settingsFile(), 'utf8')) };
  } catch {
    return { saveCorrections: true };
  }
}

function saveSettings(s) {
  writeFileSync(settingsFile(), JSON.stringify(s, null, 2));
}

function countCorrections() {
  try {
    return readFileSync(correctionsFile(), 'utf8').split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}

// One JSON line per rewrite you accepted, edited or dismissed. Stays on this computer.
function recordCorrection(entry) {
  if (!loadSettings().saveCorrections) return;
  const { mode, original, suggestion, final, action, source } = entry;
  if (typeof original !== 'string' || typeof suggestion !== 'string') return;
  if (!['accepted', 'edited', 'dismissed'].includes(action)) return;
  mkdirSync(trainingDir(), { recursive: true });
  const line = { time: new Date().toISOString(), source, mode, original, suggestion, final: final ?? null, action };
  appendFileSync(correctionsFile(), JSON.stringify(line) + '\n');
  rebuildTrayMenu?.();
}

// Local-only HTTP endpoint the Chrome extension uses for rewrites. Requests from
// web pages are refused: browsers always attach an Origin header to those.
function startRewriteServer() {
  const server = createServer((req, res) => {
    const origin = req.headers.origin || '';
    if (origin && !origin.startsWith('chrome-extension://')) {
      res.writeHead(403).end();
      return;
    }
    const send = (code, body) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'GET' && req.url === '/status') return send(200, { status: rewriterStatus() });
    if (req.method !== 'POST' || !['/rewrite', '/feedback'].includes(req.url)) return send(404, { error: 'Not found' });
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 100000) req.destroy();
    });
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        if (req.url === '/feedback') {
          recordCorrection({ ...data, source: 'chrome' });
          return send(200, { ok: true });
        }
        send(200, await rewrite(data));
      } catch (err) {
        send(500, { error: err.message });
      }
    });
  });
  server.on('error', (err) => console.warn('Rewrite server not started:', err.message));
  server.listen(REWRITE_PORT, '127.0.0.1');
}

// ---------- simulated copy / paste in the app you were using ----------

// Windows: a long-lived PowerShell helper so each keystroke is fast. It waits for
// you to let go of the hotkey's modifier keys first, otherwise Ctrl+C would be
// sent as Ctrl+Alt+C.
let psHelper = null;
const psQueue = [];

function startPsHelper() {
  const script = `
Add-Type -AssemblyName System.Windows.Forms
while ($true) {
  $cmd = [Console]::In.ReadLine()
  if ($cmd -eq $null) { break }
  $i = 0
  while ([System.Windows.Forms.Control]::ModifierKeys -ne 'None' -and $i -lt 100) { Start-Sleep -Milliseconds 15; $i++ }
  if ($cmd -eq 'copy') { [System.Windows.Forms.SendKeys]::SendWait('^c') }
  if ($cmd -eq 'paste') { [System.Windows.Forms.SendKeys]::SendWait('^v') }
  [Console]::Out.WriteLine('done')
}`;
  psHelper = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true,
  });
  psHelper.stdout.setEncoding('utf8');
  psHelper.stdout.on('data', (chunk) => {
    for (const _ of chunk.split('\n').filter((l) => l.trim() === 'done')) psQueue.shift()?.();
  });
  psHelper.on('exit', () => {
    psHelper = null;
    while (psQueue.length) psQueue.shift()();
  });
}

function sendKeys(action) {
  if (isMac) {
    const key = action === 'copy' ? 'c' : 'v';
    // Small delay so the hotkey's ⌥ key is released before ⌘C is sent.
    const script = `delay 0.25\ntell application "System Events" to keystroke "${key}" using command down`;
    return new Promise((resolve) => spawn('osascript', ['-e', script]).on('exit', resolve));
  }
  if (!psHelper) startPsHelper();
  return new Promise((resolve) => {
    psQueue.push(resolve);
    psHelper.stdin.write(action + '\n');
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Copies whatever is selected in the frontmost app and opens it here for checking.
async function grabSelection() {
  if (isMac && !systemPreferences.isTrustedAccessibilityClient(true)) {
    showWindow();
    win.webContents.send('notice',
      'To check text in other apps, allow Grammar Helper in System Settings → Privacy & Security → Accessibility, then try again.');
    return;
  }
  const before = clipboard.readText();
  clipboard.writeText('');
  await sendKeys('copy');
  let text = '';
  for (let i = 0; i < 20 && !text; i++) {
    await sleep(25);
    text = clipboard.readText();
  }
  clipboard.writeText(before);
  showWindow();
  if (text) win.webContents.send('load-text', { text, fromHotkey: true });
  else win.webContents.send('notice', `Nothing was selected. Select some text in any app, then press ${HOTKEY_LABEL}.`);
}

// Puts the corrected text back into the app the user came from.
async function pasteBack(text) {
  clipboard.writeText(text);
  win.hide();
  if (isMac) app.hide();
  await sleep(150);
  await sendKeys('paste');
}

// ---------- window & tray ----------

function createWindow() {
  win = new BrowserWindow({
    width: 980,
    height: 680,
    minWidth: 640,
    minHeight: 420,
    show: false,
    title: 'Grammar Helper',
    icon: path.join(dir, 'build', 'icon.png'),
    backgroundColor: '#f6f7f9',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(dir, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
    },
  });
  win.loadFile(path.join(dir, 'renderer', 'index.html'));
  win.once('ready-to-show', () => {
    if (!process.argv.includes('--hidden')) win.show();
  });
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });
}

function showWindow() {
  if (!win) createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  if (isMac) app.focus({ steal: true });
}

function createTray() {
  const icon = isMac
    ? nativeImage.createFromPath(path.join(dir, 'assets', 'trayTemplate.png'))
    : nativeImage.createFromPath(path.join(dir, 'assets', 'tray.png'));
  if (isMac) icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip(`Grammar Helper — select text and press ${HOTKEY_LABEL}`);
  const rebuild = (rebuildTrayMenu = () =>
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Open Grammar Helper', click: showWindow },
        { label: `Check selected text (${HOTKEY_LABEL})`, click: grabSelection },
        { type: 'separator' },
        {
          label: 'Save my corrections for training',
          type: 'checkbox',
          checked: loadSettings().saveCorrections,
          click: (item) => {
            saveSettings({ ...loadSettings(), saveCorrections: item.checked });
            rebuild();
          },
        },
        { label: `Saved corrections: ${countCorrections()}`, enabled: false },
        {
          label: 'Open corrections folder',
          click: () => {
            mkdirSync(trainingDir(), { recursive: true });
            shell.openPath(trainingDir());
          },
        },
        { type: 'separator' },
        {
          label: 'Start when I log in',
          type: 'checkbox',
          checked: app.getLoginItemSettings().openAtLogin,
          click: (item) => {
            app.setLoginItemSettings({ openAtLogin: item.checked, args: ['--hidden'] });
            rebuild();
          },
        },
        { type: 'separator' },
        { label: 'Quit', click: () => { quitting = true; app.quit(); } },
      ]),
    ));
  rebuild();
  tray.on('click', showWindow);
}

app.whenReady().then(() => {
  serveAppProtocol();
  startRewriteServer();
  createWindow();
  createTray();
  if (!globalShortcut.register(HOTKEY, grabSelection)) {
    console.warn(`Could not register ${HOTKEY}; another app is using it.`);
  }
});

app.on('activate', showWindow);
app.on('before-quit', () => { quitting = true; });
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  psHelper?.kill();
});
app.on('window-all-closed', () => {}); // stay running in the tray
