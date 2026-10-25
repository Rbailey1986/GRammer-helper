# Fine-tuning the rewrite model

These scripts fine-tune Grammarly's CoEdIT model on your PC's GPU (an RTX 5060 Ti with 16 GB is plenty).
Large files (Python environment, data, checkpoints) live in `C:\Users\rober\grammar-helper-training`,
outside the project, so they don't get copied to the Mac.

## What the model learns from

| Source | What it is |
|---|---|
| Synthetic | ~60k clean sentences (Harper-checked) with realistic mistakes planted in them, aimed at known weak spots: *have went*, double negatives, their/there, *could of*, *we was*, *buyed*, … |
| Templates | ~4k generated sentences for mistakes that real text rarely contains (*me and him was…*, *didn't say nothing*) |
| Identity | ~8k correct sentences that must come back unchanged, so the model doesn't "fix" good text |
| Hand-written | `handwritten.jsonl`: tricky cases, including keeping casual/UK slang (*innit*, *bare*, *gassed*) while fixing the grammar |
| Your corrections | Rewrites you accepted or edited in the app (`%APPDATA%\Grammar Helper\training\corrections.jsonl`), weighted ×5 |
| Replay | 20k examples from Grammarly's original training data, so the model keeps its other skills |

`handwritten_test.jsonl` is never trained on; it's used to check the result.

## Steps (from the training folder)

```sh
W=/c/Users/rober/grammar-helper-training
T="C:/Users/rober/Desktop/grammer helper/tools/training"
cd $W
# 1. clean sentences (once): see filter_clean.mjs / mine_weak.py for how data/clean*.txt were made
# 2. build the data (re-run whenever you have new corrections)
.venv/Scripts/python "$T/make_data.py" $W
# 3. train (~45 min per epoch on the RTX 5060 Ti); move the old model-finetuned/checkpoints aside first
.venv/Scripts/python "$T/train.py" $W 1.5
# 4. compare with the original model (PYTHONIOENCODING avoids a Windows console error on ✓/✗)
PYTHONIOENCODING=utf-8 .venv/Scripts/python "$T/evaluate.py" $W
# 5. convert for the app, then copy into app/models/coedit-large
#    (convert-tuned must not exist yet, or the old export is reused)
.venv/Scripts/python "C:/Users/rober/Desktop/grammer helper/tools/convert_coedit.py" $W/convert-tuned $W/coedit-large-tuned $W/model-finetuned
```

The original converted model is backed up in `C:\Users\rober\grammar-helper-training\coedit-large-original`;
copy it back over `app/models/coedit-large` to undo. Earlier fine-tunes are kept as `coedit-large-tuned-v1` (converted) and `model-finetuned-v1`.
