"""Compares the original CoEdIT model with the fine-tuned one on held-out data.

  * hand-written test set (never trained on): exact matches, side by side
  * synthetic test set: exact matches, and how often correct sentences are left alone
  * replay test set (Grammarly's validation data, all tasks): similarity to the
    reference, per task, to make sure the other skills didn't get worse

Usage: python evaluate.py <work dir> [model path]
"""
import difflib
import json
import os
import sys
from collections import defaultdict

import torch
from transformers import AutoModelForSeq2SeqLM, AutoTokenizer

WORK = sys.argv[1]
TUNED = sys.argv[2] if len(sys.argv) > 2 else os.path.join(WORK, "model-finetuned")
HERE = os.path.dirname(os.path.abspath(__file__))
FIX = "Fix grammatical errors in this sentence: "


def load(path):
    tok = AutoTokenizer.from_pretrained(path)
    model = AutoModelForSeq2SeqLM.from_pretrained(path, torch_dtype=torch.bfloat16).cuda().eval()
    return tok, model


@torch.no_grad()
def generate(tok, model, prompts, bs=32):
    out = []
    for i in range(0, len(prompts), bs):
        enc = tok(prompts[i:i + bs], return_tensors="pt", padding=True, truncation=True, max_length=128).to("cuda")
        ids = model.generate(**enc, max_new_tokens=128, num_beams=1, do_sample=False)
        out += [t.strip() for t in tok.batch_decode(ids, skip_special_tokens=True)]
    return out


norm = lambda s: " ".join(s.split())
sim = lambda a, b: difflib.SequenceMatcher(None, a, b).ratio()


def read(path):
    return [json.loads(l) for l in open(path, encoding="utf8") if l.strip()]


def main():
    hand = read(os.path.join(HERE, "handwritten_test.jsonl"))
    syn = read(os.path.join(WORK, "data", "test_synthetic.jsonl"))
    rep = read(os.path.join(WORK, "data", "test_replay.jsonl"))

    results = {}
    for name, path in [("original", "grammarly/coedit-large"), ("fine-tuned", TUNED)]:
        tok, model = load(path)
        results[name] = {
            "hand": generate(tok, model, [FIX + h["src"] for h in hand]),
            "syn": generate(tok, model, [s["src"] for s in syn]),
            "rep": generate(tok, model, [r["src"] for r in rep]),
        }
        del model
        torch.cuda.empty_cache()

    print("\n=== Hand-written test sentences (never trained on) ===")
    for i, h in enumerate(hand):
        o, t = results["original"]["hand"][i], results["fine-tuned"]["hand"][i]
        mark = lambda x: "✓" if norm(x) == norm(h["tgt"]) else "✗"
        print(f"\n  input:      {h['src']}\n  original {mark(o)} {o}\n  tuned    {mark(t)} {t}")

    print("\n=== Scores ===")
    for name in results:
        r = results[name]
        hand_ok = sum(norm(a) == norm(h["tgt"]) for a, h in zip(r["hand"], hand))
        syn_err = [(a, s) for a, s in zip(r["syn"], syn) if s["origin"] == "synthetic"]
        syn_id = [(a, s) for a, s in zip(r["syn"], syn) if s["origin"] == "identity"]
        syn_ok = sum(norm(a) == norm(s["tgt"]) for a, s in syn_err)
        id_ok = sum(norm(a) == norm(s["tgt"]) for a, s in syn_id)
        by_task = defaultdict(list)
        for a, x in zip(r["rep"], rep):
            by_task[x["origin"].split(":")[1]].append(sim(a, x["tgt"]))
        print(f"\n  {name}:")
        print(f"    hand-written exact:        {hand_ok}/{len(hand)} ({hand_ok / len(hand):.0%})")
        print(f"    synthetic errors fixed:    {syn_ok}/{len(syn_err)} ({syn_ok / max(1, len(syn_err)):.0%})")
        print(f"    correct text left alone:   {id_ok}/{len(syn_id)} ({id_ok / max(1, len(syn_id)):.0%})")
        print("    other skills (similarity to reference):")
        for task, v in sorted(by_task.items()):
            print(f"      {task:12s} {sum(v) / len(v):.3f}  (n={len(v)})")


if __name__ == "__main__":
    main()
