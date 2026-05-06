"""Quick inspection of the tagged rows. Run: python inspect_tags.py [LIMIT]"""
import json
import sqlite3
import sys
from pathlib import Path

DB = Path("data/sfx_library.db")
limit = int(sys.argv[1]) if len(sys.argv) > 1 else 5

conn = sqlite3.connect(DB)
conn.row_factory = sqlite3.Row
rows = conn.execute(
    "SELECT id, filename, ai_category, ai_mood, ai_tags, ai_use_cases "
    "FROM sfx_files WHERE ai_tags IS NOT NULL ORDER BY id LIMIT ?",
    (limit,),
).fetchall()

if not rows:
    print("(no tagged rows yet)")
else:
    for r in rows:
        tags = json.loads(r["ai_tags"])
        use_cases = json.loads(r["ai_use_cases"])
        print("-" * 70)
        print(f"#{r['id']}  {r['filename']}")
        print(f"  category : {r['ai_category']}")
        print(f"  mood     : {r['ai_mood']}")
        print(f"  tags ({len(tags)}): {tags}")
        print(f"  use_cases: {use_cases}")
