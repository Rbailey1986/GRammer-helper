"""Builds the fine-tuning data for CoEdIT.

Mix:
  * synthetic: clean sentences with realistic mistakes planted in them
    (the model learns to fix just those, keeping everything else the same)
  * identity: clean sentences that must come back unchanged
  * handwritten: tricky hand-made pairs (handwritten.jsonl), weighted up
  * your corrections: rewrites you accepted or edited in the app, weighted up
  * replay: a slice of Grammarly's original CoEdIT data, so the model keeps its
    other skills (simplify, formal, paraphrase, ...)

Usage: python make_data.py <work dir>
Reads  <work>/data/clean.txt, <work>/data/raw/coedit_*.parquet
Writes <work>/data/train.jsonl, val.jsonl, test_synthetic.jsonl, test_replay.jsonl
"""
import json
import os
import random
import re
import sys

import pandas as pd

random.seed(1234)
WORK = sys.argv[1]
HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(WORK, "data")

GEC_PROMPTS = [
    "Fix grammatical errors in this sentence: ",
    "Fix the grammar: ",
    "Fix grammar: ",
    "Fix grammar in this sentence: ",
    "Fix errors in this text: ",
    "Remove all grammatical errors from this text: ",
    "Improve the grammaticality: ",
]

# ---------------------------------------------------------------- corruptions


def keep_case(src, repl):
    if src[:1].isupper():
        return repl[:1].upper() + repl[1:]
    return repl


def sub_once(pattern, repl, s, flags=re.I):
    """Replaces one random match of pattern; repl may be a function(match)."""
    matches = list(re.finditer(pattern, s, flags))
    if not matches:
        return None
    m = random.choice(matches)
    new = repl(m) if callable(repl) else m.expand(repl)
    if m.group(0)[:1].isupper() and not callable(repl):
        new = new[:1].upper() + new[1:]
    return s[: m.start()] + new + s[m.end():]


CONFUSIONS = [
    (r"\bthere\b", "their"), (r"\btheir\b", "there"), (r"\bthey're\b", "their"),
    (r"\bthey're\b", "there"), (r"\bthere\b", "they're"), (r"\byour\b", "you're"),
    (r"\byou're\b", "your"), (r"\bits\b", "it's"), (r"\bit's\b", "its"),
    (r"\bthan\b", "then"), (r"\btoo\b", "to"), (r"\blose\b", "loose"),
    (r"\bwhose\b", "who's"), (r"\bwho's\b", "whose"), (r"\baffect\b", "effect"),
    (r"\beffect\b", "affect"), (r"\bwere\b", "where"), (r"\bwhere\b", "were"),
    (r"\bwe're\b", "were"), (r"\ba lot\b", "alot"), (r"\baccept\b", "except"),
    (r"\bquite\b", "quiet"), (r"\bpassed\b", "past"), (r"\bweather\b", "whether"),
    (r"\bwhether\b", "weather"), (r"\bbreath\b", "breathe"), (r"\bfewer\b", "less"),
]


def confusion(s):
    random.shuffle(CONFUSIONS)
    for pat, wrong in CONFUSIONS:
        out = sub_once(pat, lambda m, w=wrong: keep_case(m.group(0), w), s)
        if out:
            return out
    return None


PARTICIPLES = {
    "gone": "went", "done": "did", "seen": "saw", "come": "came", "taken": "took",
    "eaten": "ate", "written": "wrote", "given": "gave", "begun": "began",
    "drunk": "drank", "run": "ran", "broken": "broke", "spoken": "spoke",
    "chosen": "chose", "forgotten": "forgot", "known": "knew", "grown": "grew",
    "thrown": "threw", "flown": "flew", "driven": "drove", "ridden": "rode",
    "fallen": "fell", "sung": "sang", "rung": "rang", "shrunk": "shrank", "swum": "swam", "worn": "wore", "stolen": "stole",
}


def participle(s):
    pat = r"\b(have|has|had|'ve|'d|having|(?:he|she|who|that)'s)(\s+(?:just|already|never|ever|not|always|recently|finally)?\s*)(" + "|".join(PARTICIPLES) + r")\b"
    return sub_once(pat, lambda m: m.group(1) + m.group(2) + PARTICIPLES[m.group(3).lower()], s)


def them_those(s):
    return sub_once(r"\bthose (?=[a-z]+s\b)", lambda m: keep_case(m.group(0), "them "), s)


def fewer_less(s):
    return sub_once(r"\bfewer\b", lambda m: keep_case(m.group(0), "less"), s)


def of_have(s):
    out = sub_once(r"\b(could|would|should|must|might) have\b", lambda m: m.group(1) + " of", s)
    return out or sub_once(r"\b(could|would|should|must|might)'ve\b", lambda m: m.group(1) + " of", s)


AGREEMENT = [
    (r"\b(we|they|you) were\b", lambda m: m.group(1) + " was"),
    (r"\b(he|she|it) was\b", lambda m: m.group(1) + " were"),
    (r"\b(he|she|it) doesn't\b", lambda m: m.group(1) + " don't"),
    (r"\b(he|she|it) does\b", lambda m: m.group(1) + " do"),
    (r"\b(he|she|it) has\b", lambda m: m.group(1) + " have"),
    (r"\b(we|they|you|I) have\b", lambda m: m.group(1) + " has"),
    (r"\b(he|she|it) is\b", lambda m: m.group(1) + " are"),
    (r"\b(we|they|you) are\b", lambda m: m.group(1) + " is"),
    (r"\bthere are\b", lambda m: keep_case(m.group(0), "there is")),
    (r"\b(people|children|they|we) (\w+s) ", None),
]


def agreement(s):
    rules = AGREEMENT[:-1]
    random.shuffle(rules)
    for pat, fn in rules:
        out = sub_once(pat, fn, s)
        if out:
            return out
    return None


def double_negative(s):
    out = sub_once(r"\b(n't|not|never)(\s+\w+)?\s+anything\b", lambda m: m.group(1) + (m.group(2) or "") + " nothing", s)
    out = out or sub_once(r"\b(n't|not)(\s+\w+)\s+any\b", lambda m: m.group(1) + m.group(2) + " no", s)
    out = out or sub_once(r"\b(n't|not)(\s+\w+)?\s+anyone\b", lambda m: m.group(1) + (m.group(2) or "") + " nobody", s)
    out = out or sub_once(r"\b(n't|not)(\s+\w+)?\s+anywhere\b", lambda m: m.group(1) + (m.group(2) or "") + " nowhere", s)
    return out


def apostrophe(s):
    out = sub_once(r"\b(do|does|did|is|are|was|were|has|have|had|could|would|should|ca|wo|need)n't\b", lambda m: m.group(1) + "nt", s)
    out = out or sub_once(r"\b(I'm|I've|I'll|that's|what's|let's|there's|he's|she's)\b",
                          lambda m: m.group(0).replace("'", "").replace("I", "i" if random.random() < 0.5 else "I"), s)
    return out


def lowercase_i(s):
    return re.sub(r"\bI\b", "i", s) if re.search(r"\bI\b", s) else None


def lowercase_start(s):
    return s[0].lower() + s[1:] if s[:1].isupper() and not s.startswith("I ") else None


REGULARISED = {
    "bought": "buyed", "taught": "teached", "caught": "catched", "thought": "thinked",
    "brought": "bringed", "drank": "drinked", "swam": "swimmed", "ran": "runned",
    "told": "telled", "sold": "selled", "fought": "fighted", "slept": "sleeped", "felt": "feeled",
}


def regularise(s):
    return sub_once(r"\b(" + "|".join(REGULARISED) + r")\b", lambda m: keep_case(m.group(0), REGULARISED[m.group(0).lower()]), s)


def pronoun_case(s):
    out = sub_once(r"^(He|She|They|We) and I\b", lambda m: "Me and " + {"He": "him", "She": "her", "They": "them", "We": "us"}[m.group(1)], s, 0)
    out = out or sub_once(r"^(\w+) and I\b", lambda m: "Me and " + m.group(1), s, 0)
    out = out or sub_once(r"\b(my \w+|\w+) and I (am|was|were|have|had|went|will|are|did|do|got|made|took|met)\b",
                          lambda m: f"{m.group(1)} and me {m.group(2)}" if random.random() < 0.5 else f"me and {m.group(1)} {m.group(2)}", s, 0)
    out = out or sub_once(r"\bbetween you and me\b", "between you and I", s)
    out = out or sub_once(r"\b(with|for|to|from|about) (him|her|them) and me\b", lambda m: f"{m.group(1)} {m.group(2)} and I", s)
    return out


def article(s):
    out = sub_once(r"\ban ([aeiou]\w+)", lambda m: "a " + m.group(1), s)
    return out or sub_once(r"\ba ([bcdfgjklmnpqrstvwxyz]\w+)", lambda m: "an " + m.group(1), s)


def duplicate_word(s):
    words = s.split(" ")
    if len(words) < 5:
        return None
    i = random.randrange(1, len(words) - 1)
    if not re.fullmatch(r"[a-z]+", words[i]):
        return None
    return " ".join(words[: i + 1] + [words[i]] + words[i + 1:])


def typo(s):
    words = s.split(" ")
    idx = [i for i, w in enumerate(words) if re.fullmatch(r"[a-z]{5,}", w)]
    if not idx:
        return None
    i = random.choice(idx)
    w = list(words[i])
    j = random.randrange(1, len(w) - 1)
    op = random.random()
    if op < 0.4:
        w[j], w[j + 1 if j + 1 < len(w) else j - 1] = w[j + 1 if j + 1 < len(w) else j - 1], w[j]
    elif op < 0.7:
        del w[j]
    else:
        w.insert(j, w[j])
    words[i] = "".join(w)
    return " ".join(words)


# The model's known weak spots: always used when a sentence allows it.
WEAK_RULES = [participle, double_negative, agreement, pronoun_case, of_have, regularise, confusion, them_those, fewer_less]
# Everyday slips, mixed in on top for variety.
OTHER_RULES = [apostrophe, article, lowercase_i, lowercase_start, duplicate_word, typo]
STATS = {}


def corrupt(s):
    out, used = s, []
    weak = WEAK_RULES[:]
    random.shuffle(weak)
    for f in weak:
        if len(used) >= random.choice([1, 1, 2]):
            break
        new = f(out)
        if new and new != out:
            out, used = new, used + [f.__name__]
    if not used or random.random() < 0.3:
        others = OTHER_RULES[:]
        random.shuffle(others)
        for f in others:
            new = f(out)
            if new and new != out:
                out, used = new, used + [f.__name__]
                break
    for name in used:
        STATS[name] = STATS.get(name, 0) + 1
    return out if out != s else None


# ----------------------------------------------------------------- templates
# Real text rarely says "X and I" or uses double negatives, so these pairs are
# generated from templates to give the model enough examples.

PARTNERS = [("he", "him"), ("she", "her")]
NAMED = ["my brother", "my sister", "my mate", "my cousin", "my friend", "Jordan", "Aisha", "Tom", "Priya",
         "my manager", "the producer", "my partner", "the DJ", "my dad", "my mum"]
PAST = ["went to the studio", "were at the show", "made the beat together", "met the artist backstage",
        "recorded the intro", "had a long chat about it", "were running late", "finished the edit last night",
        "got stuck in traffic", "did the interview", "booked the venue", "were watching the stream",
        "saw the whole thing", "wrote the first verse", "planned the whole episode", "were invited to the launch"]
PRESENT = ["are going to the festival", "are working on a new mix", "have been friends for years",
           "are hosting the next episode", "have finished the playlist", "are heading out now"]
OBJ_PHRASES = ["The tickets are for {o} and me.", "She sent the files to {o} and me.", "It was a big night for {o} and me.",
               "The label called {o} and me in for a meeting.", "Between you and me, the second half was better.",
               "They asked {o} and me to play a set.", "The DJ gave {o} and me a shout-out."]
NEG_SUBJ = [("I", "don't", "didn't"), ("We", "don't", "didn't"), ("They", "don't", "didn't"),
            ("He", "doesn't", "didn't"), ("She", "doesn't", "didn't"), ("My mate", "doesn't", "didn't")]
NEG_VERBS = [("know", "about the change"), ("say", "to the crowd"), ("hear", "from the label"),
             ("see", "on the night"), ("want", "from them"), ("need", "else for the show"),
             ("get", "for their trouble"), ("buy", "at the merch stand"), ("play", "from the old album"),
             ("tell", "us about the line-up")]


def cap(s):
    return s[:1].upper() + s[1:]


def template_pairs(n_pron=2500, n_neg=1500):
    pairs = []
    for _ in range(n_pron):
        r = random.random()
        if r < 0.75:
            if random.random() < 0.5:
                subj, obj = random.choice(PARTNERS)
                good_subj = f"{subj} and I"
                bad_subj = random.choice([f"me and {obj}", f"{obj} and me", f"{obj} and I"])
            else:
                who = random.choice(NAMED)
                good_subj = f"{who} and I"
                bad_subj = random.choice([f"me and {who}", f"{who} and me"])
            pred = random.choice(PAST + PRESENT)
            tail = random.choice(["", " yesterday", " last week", " on Friday", " this morning", ""]) if pred in PAST else ""
            good = cap(good_subj) + " " + pred + tail + "."
            bad = cap(bad_subj) + " " + pred + tail + "."
            if random.random() < 0.3:  # plus an agreement slip
                bad = bad.replace(" were ", " was ", 1).replace(" are ", " is ", 1).replace(" have ", " has ", 1)
        else:
            o = random.choice(["him", "her", "them", "my brother", "Tom", "the crew"])
            good = random.choice(OBJ_PHRASES).format(o=o)
            bad = good.replace("you and me", "you and I").replace(f"{o} and me", f"{o} and I")
        if bad != good:
            pairs.append((bad, good))
    for _ in range(n_neg):
        subj, present, past = random.choice(NEG_SUBJ)
        verb, tail = random.choice(NEG_VERBS)
        aux = random.choice([present, past])
        pick = random.random()
        if pick < 0.6:
            good, bad = f"{subj} {aux} {verb} anything {tail}.", f"{subj} {aux} {verb} nothing {tail}."
        elif pick < 0.8:
            good, bad = f"{subj} {aux} {verb} anyone {tail}.", f"{subj} {aux} {verb} nobody {tail}."
        else:
            good, bad = f"Nobody ever {verb}s anything {tail}.", f"Nobody never {verb}s nothing {tail}."
        if random.random() < 0.3 and aux == "doesn't":
            bad = bad.replace("doesn't", "don't", 1)
        pairs.append((bad, good))
    return pairs


PLURALS = ["tracks", "tickets", "people", "speakers", "records", "shows", "fans", "songs", "artists", "mixes",
           "episodes", "beats", "venues", "DJs", "headphones", "lyrics", "samples", "trainers", "mates", "lads"]
PLURAL_PREDS = ["didn't make the album", "were sold out by Friday", "sound much better live", "are still in my bag",
                "came from the old label", "got played on the radio", "were the best part of the night",
                "need a proper mix", "are going on the next episode", "never got released"]
SUBJECTS_3RD = ["She", "He", "My cousin", "The producer", "Who", "That DJ", "My sister"]
PERFECT = [("sung", "sang", "on a couple of his records"), ("drunk", "drank", "way too much coffee today"),
           ("rung", "rang", "the label twice already"), ("written", "wrote", "a verse for the remix"),
           ("taken", "took", "the train to every show"), ("given", "gave", "us a shout-out before"),
           ("done", "did", "three interviews this week"), ("seen", "saw", "them live loads of times"),
           ("broken", "broke", "the record again"), ("spoken", "spoke", "to the promoter"),
           ("swum", "swam", "in the sea before"), ("eaten", "ate", "at that place before"),
           ("begun", "began", "working on the album"), ("shrunk", "shrank", "in the wash")]
BEEN_PLACES = ["there", "to that club", "to Manchester", "to the festival", "to his studio", "abroad", "to that venue"]
BEEN_TAILS = ["more times than I can count", "before", "twice", "a few times", "since I was a kid", "every summer"]
FEWER_START = ["Fewer", "Far fewer", "A lot fewer", "Even fewer"]
FEWER_TAILS = ["were sold on the door", "turned up than last year", "came out to the launch", "made it onto the album",
               "got played on the night", "were left at the end"]


def template_pairs_v2(n=3000):
    pairs = []
    for _ in range(n):
        r = random.random()
        if r < 0.3:
            noun, pred = random.choice(PLURALS), random.choice(PLURAL_PREDS)
            det = "Those"  # "them tracks" means "those tracks"
            good = f"{det} {noun} {pred}."
            if random.random() < 0.3:
                good = f"I don't rate {det.lower()} {noun}." if random.random() < 0.5 else f"Pass me {det.lower()} {noun}."
                bad = good.replace(det.lower() + " ", "them ", 1)
            else:
                bad = good.replace(det, "Them", 1)
        elif r < 0.55:
            start, noun, tail = random.choice(FEWER_START), random.choice(PLURALS), random.choice(FEWER_TAILS)
            good = f"{start} {noun} {tail}."
            if random.random() < 0.3:
                good = f"There were {start.lower()} {noun} than we expected."
                bad = good.replace("fewer", "less", 1)
            else:
                bad = good.replace("Fewer", "Less", 1).replace("fewer", "less", 1)
        elif r < 0.8:
            subj = random.choice(SUBJECTS_3RD)
            pp, past, tail = random.choice(PERFECT)
            aux = random.choice(["'s", " has", "'s never", " has already"]) if subj != "Who" else "'s"
            good = f"{subj}{aux} {pp} {tail}" + ("?" if subj == "Who" else ".")
            bad = good.replace(f" {pp} ", f" {past} ", 1)
        else:
            subj = random.choice(["I", "We", "They", "You"])
            aux = random.choice([" have", "'ve", " have never", "'ve never"])
            place, tail = random.choice(BEEN_PLACES), random.choice(BEEN_TAILS)
            if "never" in aux:
                tail = random.choice(["before", "in my life", "yet"])
            good = f"{subj}{aux} been {place} {tail}."
            bad = good.replace(" been ", " went ", 1)
        if bad != good:
            pairs.append((bad, good))
    return pairs


# --------------------------------------------------------------------- build


def rows(src_prefix, src, tgt, origin):
    return {"src": src_prefix + src, "tgt": tgt, "origin": origin}


def main():
    clean = [l.strip() for l in open(os.path.join(DATA, "clean.txt"), encoding="utf8") if l.strip()]
    weak_path = os.path.join(DATA, "clean_weak.txt")  # sentences picked by mine_weak.py
    if os.path.exists(weak_path):
        clean += [l.strip() for l in open(weak_path, encoding="utf8") if l.strip()]
    clean = list(dict.fromkeys(clean))
    random.shuffle(clean)
    test_clean, val_clean, train_clean = clean[:600], clean[600:1600], clean[1600:]

    def synth(sentences, identity_rate):
        out = []
        for s in sentences:
            if random.random() < identity_rate:
                out.append(rows(random.choice(GEC_PROMPTS), s, s, "identity"))
                continue
            bad = corrupt(s)
            if bad:
                out.append(rows(random.choice(GEC_PROMPTS), bad, s, "synthetic"))
        return out

    train = synth(train_clean, 0.12)
    val = synth(val_clean, 0.12)
    test_syn = synth(test_clean, 0.15)

    # Never train on the hand-written test sentences.
    held_out = set()
    for l in open(os.path.join(HERE, "handwritten_test.jsonl"), encoding="utf8"):
        if l.strip():
            t = json.loads(l)
            held_out |= {t["src"].lower(), t["tgt"].lower()}
    tpl = [p for p in template_pairs() + template_pairs_v2() if p[0].lower() not in held_out and p[1].lower() not in held_out]
    random.shuffle(tpl)
    for bad, good in tpl[100:]:
        train.append(rows(random.choice(GEC_PROMPTS), bad, good, "template"))
    for bad, good in tpl[:100]:
        test_syn.append(rows(random.choice(GEC_PROMPTS), bad, good, "synthetic"))

    # Hand-written hard cases (training half only; the test half is never trained on).
    hand = [json.loads(l) for l in open(os.path.join(HERE, "handwritten.jsonl"), encoding="utf8") if l.strip()]
    for h in hand:
        for _ in range(5):
            prefix = random.choice(GEC_PROMPTS) if h.get("mode", "fix") == "fix" else h["prompt"]
            train.append(rows(prefix, h["src"], h["tgt"], "handwritten"))

    # Your own accepted/edited rewrites from the app.
    appdata = os.environ.get("APPDATA") or os.path.expanduser("~/Library/Application Support")
    corrections = os.path.join(appdata, "Grammar Helper", "training", "corrections.jsonl")
    n_user = 0
    prompts = {
        "fix": "Fix grammatical errors in this sentence: ", "simpler": "Make this simpler: ",
        "clearer": "Clarify this sentence: ", "formal": "Write this more formally: ", "paraphrase": "Paraphrase this: ",
    }
    if os.path.exists(corrections):
        for l in open(corrections, encoding="utf8"):
            c = json.loads(l)
            if c.get("action") in ("accepted", "edited") and c.get("final"):
                for _ in range(5):
                    train.append(rows(prompts.get(c["mode"], prompts["fix"]), c["original"], c["final"], "user"))
                n_user += 1

    # Replay of Grammarly's own data so other skills aren't forgotten.
    coedit = pd.read_parquet(os.path.join(DATA, "raw", "coedit_train.parquet")).sample(frac=1, random_state=7)
    for r in coedit.head(20000).itertuples():
        train.append({"src": r.src, "tgt": r.tgt, "origin": "replay:" + r.task})
    coedit_val = pd.read_parquet(os.path.join(DATA, "raw", "coedit_val.parquet")).sample(frac=1, random_state=7)
    replay_val = [{"src": r.src, "tgt": r.tgt, "origin": "replay:" + r.task} for r in coedit_val.head(300).itertuples()]
    replay_test = [{"src": r.src, "tgt": r.tgt, "origin": "replay:" + r.task} for r in coedit_val.iloc[300:700].itertuples()]
    val += replay_val

    random.shuffle(train)

    def dump(name, items):
        with open(os.path.join(DATA, name), "w", encoding="utf8") as f:
            for it in items:
                f.write(json.dumps(it, ensure_ascii=False) + "\n")

    dump("train.jsonl", train)
    dump("val.jsonl", val)
    dump("test_synthetic.jsonl", test_syn)
    dump("test_replay.jsonl", replay_test)

    from collections import Counter
    print("train:", len(train), dict(Counter(x["origin"].split(":")[0] for x in train)))
    print("val:", len(val), "test_synthetic:", len(test_syn), "test_replay:", len(replay_test), "your corrections:", n_user)
    print("mistake types planted:", dict(sorted(STATS.items(), key=lambda kv: -kv[1])))
    for ex in [x for x in train if x["origin"] == "synthetic"][:12]:
        print("  ", ex["src"], " => ", ex["tgt"])


if __name__ == "__main__":
    main()
