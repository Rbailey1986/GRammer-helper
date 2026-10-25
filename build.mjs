// Copies the shared checker and the Harper engine into the extension and the app,
// and generates the icons. Run with:  node build.mjs   (after `npm install` in app/)
import { cpSync, mkdirSync, existsSync } from 'node:fs';

const harper = new URL('app/node_modules/harper.js/dist/', import.meta.url);
if (!existsSync(harper)) {
  console.error('Run "npm install" inside the app folder first.');
  process.exit(1);
}

const ext = new URL('extension/lib/', import.meta.url);
mkdirSync(new URL('harper/', ext), { recursive: true });
for (const f of ['index.js', 'binary.js', 'harper_wasm_bg.wasm']) {
  cpSync(new URL(f, harper), new URL('harper/' + f, ext));
}
// binary.js imports a hashed chunk; copy whichever one ships with this version.
const { readdirSync } = await import('node:fs');
for (const f of readdirSync(harper)) {
  if (/^BinaryModule-.*\.js$/.test(f)) cpSync(new URL(f, harper), new URL('harper/' + f, ext));
}

cpSync(new URL('shared/checker.js', import.meta.url), new URL('checker.js', ext));
mkdirSync(new URL('app/lib/', import.meta.url), { recursive: true });
cpSync(new URL('shared/checker.js', import.meta.url), new URL('app/lib/checker.js', import.meta.url));

// transformers.js + the ONNX Runtime WebAssembly files for the rewriter window.
const vendor = new URL('app/vendor/', import.meta.url);
mkdirSync(vendor, { recursive: true });
cpSync(new URL('app/node_modules/@huggingface/transformers/dist/transformers.js', import.meta.url), new URL('transformers.js', vendor));
for (const f of ['ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm']) {
  cpSync(new URL('app/node_modules/onnxruntime-web/dist/' + f, import.meta.url), new URL(f, vendor));
}
if (!existsSync(new URL('app/models/coedit-large/onnx/', import.meta.url))) {
  console.warn('Note: app/models/coedit-large is missing, so rewrites are disabled. See README.');
}

await import('./shared/make-icons.mjs');
console.log('Build complete. Extension is ready in ./extension');
