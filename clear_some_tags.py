"""Clear AI tag fields on the first N rows so they can be re-tagged.
Usage: python clear_some_tags.py 10
"""
import sqlite3
import sys
from pathlib import Path

DB = Path("data/sfx_library.db")
n = int(sys.argv[1]) if len(sys.argv) > 1 else 10

conn = sqlite3.connect(DB)
conn.execute(
    """
    UPDATE sfx_files SET ai_tags=NULL, ai_category=NULL, ai_mood=NULL,
        ai_use_cases=NULL, tagged_at=NULL, tagging_model=NULL
    WHERE id IN (SELECT id FROM sfx_files WHERE ai_tags IS NOT NULL ORDER BY id LIMIT ?)
    """,
    (n,),
)
print(f"Cleared {conn.total_changes} row(s).")
conn.commit()
conn.close()
