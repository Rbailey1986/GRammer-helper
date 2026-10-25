"""Finds sentences in the big sentence collection that contain the wording our
weak-spot mistakes need (have + past participle, "n't ... anything", "X and I",
"could have", ...), so the generator can plant those mistakes far more often.

Usage: python mine_weak.py <work dir> [per-pattern limit]
Reads  <work>/data/raw/sentences_train.parquet
Writes <work>/data/raw/weak.txt
"""
import os
import re
import sys

import pandas as pd

WORK = sys.argv[1]
LIMIT = int(sys.argv[2]) if len(sys.argv) > 2 else 4000

PARTICIPLES = "gone|done|seen|come|taken|eaten|written|given|begun|drunk|broken|spoken|chosen|forgotten|known|grown|thrown|flown|driven|ridden|fallen|sung|swum|worn|stolen"
PATTERNS = {
    "participle": rf"\b(have|has|had|'ve)\s+(just |already |never |ever |not |always |recently |finally )?({PARTICIPLES})\b",
    "double_negative": r"\b(n't|not|never)(\s+\w+)?\s+(anything|anyone|anywhere|any)\b",
    "pronoun_case": r"\b(\w+) and I (am|was|were|have|had|went|will|are|did|do|got|made|took|met)\b|\bbetween you and me\b|\b(with|for|to|from|about) (him|her|them) and me\b",
    "of_have": r"\b(could|would|should|must|might) have\b|\b(could|would|should|must|might)'ve\b",
    "regularise": r"\b(bought|taught|caught|thought|brought|drank|swam|ran|told|sold|fought|slept|felt)\b",
    "agreement": r"\b(we|they|you) were\b|\b(he|she|it) doesn't\b|\b(he|she|it) has\b|\b(we|they) have\b",
    "contractions": r"\b(I'm|I've|that's|doesn't|didn't|isn't|can't|won't|they're|you're|it's)\b",
}

df = pd.read_parquet(os.path.join(WORK, "data", "raw", "sentences_train.parquet"))
texts = df["text"].sample(frac=1, random_state=11).str.replace("\n", " ")
found = {k: [] for k in PATTERNS}
compiled = {k: re.compile(p, re.I) for k, p in PATTERNS.items()}
for t in texts:
    if not (40 <= len(t) <= 220):
        continue
    for k, rx in compiled.items():
        if len(found[k]) < LIMIT and rx.search(t):
            found[k].append(t)
            break
    if all(len(v) >= LIMIT for v in found.values()):
        break

with open(os.path.join(WORK, "data", "raw", "weak.txt"), "w", encoding="utf8") as f:
    for k, v in found.items():
        print(f"{k:16s} {len(v)}")
        f.write("\n".join(v) + "\n")
