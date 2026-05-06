"""Clear AI tag fields so rows can be re-tagged. Run: python clear_tags.py"""
import sqlite3
from pathlib import Path

DB = Path("data/sfx_library.db")

conn = sqlite3.connect(DB)
n = conn.execute("SELECT COUNT(*) FROM sfx_files WHERE ai_tags IS NOT NULL").fetchone()[0]
print(f"Clearing AI fields on {n} row(s)...")
conn.execute(
    "UPDATE sfx_files SET ai_tags=NULL, ai_category=NULL, ai_mood=NULL, "
    "ai_use_cases=NULL, tagged_at=NULL, tagging_model=NULL WHERE ai_tags IS NOT NULL"
)
conn.commit()
conn.close()
print("Done.")
