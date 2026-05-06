"""Summarize failed.log: which step failed, file extensions, common path patterns.
Usage: python inspect_failures.py
"""
from collections import Counter
from pathlib import Path

LOG = Path("failed.log")
if not LOG.exists():
    print("No failed.log found.")
    raise SystemExit

lines = LOG.read_text(encoding="utf-8", errors="replace").splitlines()
print(f"Total log entries: {len(lines)}")
print()

stages = Counter()
extensions = Counter()
samples_by_stage: dict[str, list[str]] = {}

for line in lines:
    parts = line.split("\t", 2)
    if len(parts) < 3:
        continue
    _, stage, path = parts
    stages[stage] += 1
    ext = Path(path).suffix.lower()
    extensions[ext] += 1
    samples_by_stage.setdefault(stage, []).append(path)

print("By stage:")
for stage, n in stages.most_common():
    print(f"  {stage:10s} {n}")

print()
print("By extension:")
for ext, n in extensions.most_common(15):
    print(f"  {ext or '(none)':10s} {n}")

print()
print("First 10 sample paths per stage:")
for stage, paths in samples_by_stage.items():
    print(f"\n  --- {stage} ---")
    for p in paths[:10]:
        print(f"    {p}")
