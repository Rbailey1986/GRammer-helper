"""Fine-tunes grammarly/coedit-large on the data from make_data.py.

Full fine-tune in bf16 with Adafactor (low memory, the standard optimiser for T5),
which fits comfortably in 16 GB of GPU memory.

Usage: python train.py <work dir> [epochs]
Writes the best checkpoint to <work>/model-finetuned
"""
import json
import os
import sys

import torch
from torch.utils.data import Dataset
from transformers import (
    AutoModelForSeq2SeqLM,
    AutoTokenizer,
    DataCollatorForSeq2Seq,
    Seq2SeqTrainer,
    Seq2SeqTrainingArguments,
)
from transformers.optimization import Adafactor

WORK = sys.argv[1]
EPOCHS = float(sys.argv[2]) if len(sys.argv) > 2 else 1.0
BASE = "grammarly/coedit-large"
OUT = os.path.join(WORK, "model-finetuned")
MAX_LEN = 128


class JsonlDataset(Dataset):
    def __init__(self, path, tok):
        self.items = [json.loads(l) for l in open(path, encoding="utf8") if l.strip()]
        self.tok = tok

    def __len__(self):
        return len(self.items)

    def __getitem__(self, i):
        it = self.items[i]
        enc = self.tok(it["src"], max_length=MAX_LEN, truncation=True)
        enc["labels"] = self.tok(text_target=it["tgt"], max_length=MAX_LEN, truncation=True)["input_ids"]
        return enc


def main():
    assert torch.cuda.is_available(), "No CUDA GPU found."
    tok = AutoTokenizer.from_pretrained(BASE)
    model = AutoModelForSeq2SeqLM.from_pretrained(BASE)  # fp32 weights, bf16 compute

    train = JsonlDataset(os.path.join(WORK, "data", "train.jsonl"), tok)
    val = JsonlDataset(os.path.join(WORK, "data", "val.jsonl"), tok)

    # A gentle learning rate: we're nudging an already-good model, not teaching it from scratch.
    optimizer = Adafactor(model.parameters(), lr=5e-5, scale_parameter=False, relative_step=False, warmup_init=False)

    args = Seq2SeqTrainingArguments(
        output_dir=os.path.join(WORK, "checkpoints"),
        per_device_train_batch_size=16,
        per_device_eval_batch_size=32,
        num_train_epochs=EPOCHS,
        lr_scheduler_type="linear",
        warmup_ratio=0.03,
        bf16=True,
        logging_steps=50,
        eval_strategy="steps",
        eval_steps=500,
        save_strategy="steps",
        save_steps=500,
        save_total_limit=2,
        load_best_model_at_end=True,
        metric_for_best_model="eval_loss",
        greater_is_better=False,
        group_by_length=True,
        gradient_checkpointing=True,  # trades a little speed for a lot less GPU memory
        dataloader_num_workers=0,
        report_to=[],
    )

    trainer = Seq2SeqTrainer(
        model=model,
        args=args,
        train_dataset=train,
        eval_dataset=val,
        data_collator=DataCollatorForSeq2Seq(tok, model=model),
        optimizers=(optimizer, None),
    )
    trainer.train()
    trainer.save_model(OUT)
    tok.save_pretrained(OUT)
    print("Saved fine-tuned model to", OUT)


if __name__ == "__main__":
    main()
