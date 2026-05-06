"""Clear Whisper transcript + audio features on the first N rows.
Usage: python clear_some_analysis.py 10
"""
import sqlite3
import sys
from pathlib import Path

DB = Path("data/sfx_library.db")
n = int(sys.argv[1]) if len(sys.argv) > 1 else 10

conn = sqlite3.connect(DB)
conn.execute(
    """
    UPDATE sfx_files SET transcript=NULL, loudness_lufs=NULL,
        spectral_centroid_mean=NULL, waveform_peaks=NULL
    WHERE id IN (SELECT id FROM sfx_files WHERE transcript IS NOT NULL ORDER BY id LIMIT ?)
    """,
    (n,),
)
print(f"Cleared analysis on {conn.total_changes} row(s).")
conn.commit()
conn.close()
