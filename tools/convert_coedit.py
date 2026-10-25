# Converts grammarly/coedit-large (or a fine-tuned copy) to ONNX and quantizes it to int8 in the layout transformers.js expects.
import os, shutil, subprocess, sys, glob
from onnxruntime.quantization import quantize_dynamic, QuantType

work = sys.argv[1]
dest = sys.argv[2]
model = sys.argv[3] if len(sys.argv) > 3 else "grammarly/coedit-large"  # or a fine-tuned folder
exp = os.path.join(work, "export")
if not os.path.exists(os.path.join(exp, "decoder_model_merged.onnx")):
    subprocess.check_call([os.path.join(os.path.dirname(sys.executable), "optimum-cli"), "export", "onnx",
        "--model", model, "--task", "text2text-generation-with-past", exp])
print("exported:", sorted(os.listdir(exp)), flush=True)

onnx_dir = os.path.join(dest, "onnx")
os.makedirs(onnx_dir, exist_ok=True)
for name in ["encoder_model", "decoder_model_merged"]:
    out = os.path.join(onnx_dir, name + "_quantized.onnx")
    print("quantizing", name, flush=True)
    quantize_dynamic(os.path.join(exp, name + ".onnx"), out, weight_type=QuantType.QInt8,
                     extra_options={"EnableSubgraph": True})
    print(name, os.path.getsize(out) // 1_000_000, "MB", flush=True)

for f in ["config.json", "generation_config.json", "tokenizer.json", "tokenizer_config.json", "special_tokens_map.json", "spiece.model"]:
    src = os.path.join(exp, f)
    if os.path.exists(src):
        shutil.copy(src, dest)
print("done:", sorted(os.listdir(dest)), flush=True)
