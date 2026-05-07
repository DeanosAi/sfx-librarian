"""Diagnostic: run the vision model on the first available thumbnail using
the EXACT same options + parser the real indexer uses, so we know whether
fixes have actually landed.

Usage:  .\\.venv\\Scripts\\python.exe diagnose_vision.py [model_name]
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import ollama
from sfx_index.video import (
    DEFAULT_VISION_MODEL,
    VIDEO_TAG_SYSTEM_PROMPT,
    parse_json_lenient,
)

THUMBS_DIR = Path("data/thumbnails")
MODEL = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_VISION_MODEL

thumbs = sorted(THUMBS_DIR.glob("*.jpg"))
if not thumbs:
    print(f"No thumbnails in {THUMBS_DIR.resolve()}")
    sys.exit(1)

thumb = thumbs[0]
print(f"Probing model: {MODEL}")
print(f"Thumbnail:     {thumb}")
print()

# Match the real pipeline's options exactly.
options = {
    "num_ctx": 4096,
    "num_gpu": 999,
    "temperature": 0.2,
    "repeat_penalty": 1.25,
    "repeat_last_n": 256,
    "num_predict": 500,
    "stop": ["}\n", "}\r", "}}"],
}

user_prompt = (
    "INPUT METADATA:\n"
    "  Filename: diagnostic.mp4\n"
    "  Folder: (root)\n"
    "  Duration: 1.0s\n"
    "  Resolution: unknown, unknown fps\n"
    "\nTag the attached frame.\n\nOUTPUT:"
)

client = ollama.Client()
try:
    resp = client.chat(
        model=MODEL,
        messages=[
            {"role": "system", "content": VIDEO_TAG_SYSTEM_PROMPT},
            {"role": "user", "content": user_prompt, "images": [str(thumb)]},
        ],
        format="json",
        options=options,
    )
except Exception as e:
    print(f"Ollama call failed: {e}")
    sys.exit(2)

content = resp.get("message", {}).get("content", "")
print("=" * 70)
print("RAW MODEL RESPONSE:")
print("=" * 70)
print(content)
print("=" * 70)
print(f"length = {len(content)} chars")
print()

data = parse_json_lenient(content)
if data is None:
    print("✗ parse_json_lenient FAILED — even the truncation-repair couldn't salvage it.")
    print("  → switch model to qwen2.5-vl:7b (much better at structured output)")
else:
    print("✓ parse_json_lenient succeeded.")
    print()
    print(json.dumps(data, indent=2)[:800])
    n_tags = len(data.get("tags") or []) if isinstance(data.get("tags"), list) else 0
    n_uses = len(data.get("use_cases") or []) if isinstance(data.get("use_cases"), list) else 0
    print()
    print(f"  tags: {n_tags}  use_cases: {n_uses}  category: {data.get('category')}")
