"""Diagnostic: run the vision model on the first available thumbnail and print
the raw response so we can see why JSON parsing is failing.

Usage:  .\\.venv\\Scripts\\python.exe diagnose_vision.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import ollama

THUMBS_DIR = Path("data/thumbnails")
MODEL = "llama3.2-vision:11b"

thumbs = sorted(THUMBS_DIR.glob("*.jpg"))
if not thumbs:
    print(f"No thumbnails found in {THUMBS_DIR.resolve()}")
    sys.exit(1)

thumb = thumbs[0]
print(f"Probing model: {MODEL}")
print(f"Thumbnail:     {thumb}")
print()

# Simplified prompt — same shape we use in the real pipeline, minus the long examples.
sys_prompt = (
    "Tag the attached frame. Reply with ONLY this JSON, no prose:\n"
    '{"tags":[...10-30 strings...],"category":"...","mood":"...","use_cases":[...]}'
)

client = ollama.Client()
try:
    resp = client.chat(
        model=MODEL,
        messages=[
            {"role": "system", "content": sys_prompt},
            {"role": "user", "content": "Tag the image.", "images": [str(thumb)]},
        ],
        format="json",
        options={"num_ctx": 4096, "num_gpu": 999, "temperature": 0.3, "num_predict": 500},
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
print(f"length={len(content)} chars")
print()

# Try strict JSON parse
try:
    data = json.loads(content)
    print("✓ Strict json.loads worked.")
    print(json.dumps(data, indent=2)[:500])
except json.JSONDecodeError as e:
    print(f"✗ Strict json.loads failed: {e}")
    # Try grabbing first {...}
    import re
    m = re.search(r"\{[\s\S]*\}", content)
    if m:
        try:
            data = json.loads(m.group(0))
            print("✓ Lenient (first {...} block) worked.")
            print(json.dumps(data, indent=2)[:500])
        except json.JSONDecodeError as e2:
            print(f"✗ Lenient parse also failed: {e2}")
    else:
        print("✗ No {...} block found in response.")
