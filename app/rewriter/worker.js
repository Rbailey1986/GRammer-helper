// Runs the CoEdIT rewriting model inside a hidden window using WebAssembly, so the
// same code works on Windows and Intel Macs. Served from gh://app/ by main.js.
import { pipeline, env } from '../vendor/transformers.js';

env.allowRemoteModels = false; // never download anything
env.allowLocalModels = true;
env.useBrowserCache = false;
env.localModelPath = 'gh://app/models/';
env.backends.onnx.wasm.wasmPaths = 'gh://app/vendor/';
env.backends.onnx.wasm.numThreads = Math.max(1, Math.min(8, navigator.hardwareConcurrency - 1));

let generator = null;

function load() {
  generator ??= pipeline('text2text-generation', 'coedit-large', { dtype: 'q8', device: 'wasm' });
  return generator;
}

window.rewriter = {
  load: () => load().then(() => true),
  async run(prompt) {
    const gen = await load();
    const [out] = await gen(prompt, { max_new_tokens: 256, do_sample: false, num_beams: 1 });
    return out.generated_text;
  },
};
