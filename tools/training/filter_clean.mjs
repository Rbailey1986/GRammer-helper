// Keeps only sentences Harper (British English) finds no spelling or grammar
// problems in, so the "correct" side of each training pair really is correct.
// Usage: node filter_clean.mjs <in.txt> <out.txt> [max]
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';

const [input, output, maxArg] = process.argv.slice(2);
const max = Number(maxArg || 60000);

// harper.js lives in the desktop app's node_modules.
const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../app');
const harperDir = path.join(appDir, 'node_modules', 'harper.js');
const { LocalLinter, Dialect } = await import(pathToFileURL(path.join(harperDir, 'dist/index.js')));
const { binaryInlined } = await import(pathToFileURL(path.join(harperDir, 'dist/binaryInlined.js')));
const { categoryOf } = await import(pathToFileURL(path.join(appDir, 'lib/checker.js')));

const linter = new LocalLinter({ binary: binaryInlined, dialect: Dialect.British });
await linter.setup();

const looksOk = (s) => {
  const words = s.split(/\s+/).length;
  return (
    words >= 6 && words <= 30 &&
    /^[A-Z]/.test(s) && /[.!?]$/.test(s) &&
    !/https?:|www\.|@|#|\||\[|\]|\{|\}|\s{2,}|[^\x20-\x7E’‘“”–—]/.test(s) &&
    !/\b[A-Z]{4,}\b/.test(s) && (s.match(/\d/g) || []).length < 4
  );
};

const lines = readFileSync(input, 'utf8').split('\n').map((l) => l.trim().replace(/[’‘]/g, "'").replace(/[“”]/g, '"'));
const kept = [];
let seen = 0;
for (const s of lines) {
  if (!looksOk(s)) continue;
  seen++;
  const lints = await linter.lint(s, { language: 'plaintext' });
  if (lints.every((l) => categoryOf(l.lint_kind()) === 'style')) kept.push(s);
  if (kept.length >= max) break;
  if (seen % 5000 === 0) console.log(`checked ${seen}, kept ${kept.length}`);
}
writeFileSync(output, kept.join('\n') + '\n');
console.log(`Kept ${kept.length} clean sentences out of ${seen} candidates.`);
