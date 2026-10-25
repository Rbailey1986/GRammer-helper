// Service worker: owns the Harper grammar engine and answers lint requests from tabs.
import { LocalLinter, Dialect } from './lib/harper/index.js';
import { binary } from './lib/harper/binary.js';
import { createChecker } from './lib/checker.js';

const checker = createChecker({ LocalLinter, binary, dialect: Dialect.British });

// Load the user's dictionary once the engine is up.
const ready = checker.setup().then(async () => {
  const { words = [] } = await chrome.storage.sync.get('words');
  if (words.length) await checker.addWords(words);
}).catch((err) => console.warn('Could not load dictionary:', err));

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  handle(msg).then(reply, (err) => reply({ error: String(err) }));
  return true; // async reply
});

async function handle(msg) {
  await ready;
  switch (msg.type) {
    case 'check':
      return { lints: await checker.check(msg.text) };
    case 'ignore':
      checker.ignore(msg.problem, msg.message);
      return { ok: true };
    case 'rewrite':
      return callApp('/rewrite', msg.request);
    case 'feedback':
      return callApp('/feedback', msg.entry);
    case 'addWord': {
      const { words = [] } = await chrome.storage.sync.get('words');
      if (!words.includes(msg.word)) words.push(msg.word);
      await chrome.storage.sync.set({ words });
      await checker.addWords([msg.word]);
      return { ok: true };
    }
  }
}

// Sentence rewrites come from the CoEdIT model inside the desktop app, which
// listens only on this computer.
async function callApp(path, body) {
  try {
    const res = await fetch('http://127.0.0.1:47321' + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return await res.json();
  } catch {
    return { error: 'offline' };
  }
}

// Keyboard shortcuts are forwarded to the active tab's content script.
chrome.commands?.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: 'command', command }).catch(() => {});
});
