"""SQLite schema, connection helpers, FTS5 triggers."""
from __future__ import annotations

import sqlite3
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS sfx_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filepath_relative TEXT NOT NULL UNIQUE,
    filename TEXT NOT NULL,
    file_size_bytes INTEGER,
    file_modified_time INTEGER,
    duration_seconds REAL,
    sample_rate INTEGER,
    channels INTEGER,
    format TEXT,
    transcript TEXT,
    folder_tags TEXT,
    ai_tags TEXT,
    ai_category TEXT,
    ai_mood TEXT,
    ai_use_cases TEXT,
    waveform_peaks TEXT,
    loudness_lufs REAL,
    spectral_centroid_mean REAL,
    tagged_at TEXT,
    tagging_model TEXT,
    -- Video-only fields (NULL for audio entries)
    media_type TEXT DEFAULT 'audio',
    width INTEGER,
    height INTEGER,
    fps REAL,
    video_codec TEXT,
    thumbnail_path TEXT
);

CREATE INDEX IF NOT EXISTS idx_sfx_filepath ON sfx_files(filepath_relative);
CREATE INDEX IF NOT EXISTS idx_sfx_tagged_at ON sfx_files(tagged_at);

CREATE TABLE IF NOT EXISTS library_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS sfx_search USING fts5(
    filename, transcript, folder_tags, ai_tags, ai_category, ai_mood, ai_use_cases,
    content='sfx_files',
    content_rowid='id'
);

-- Keep FTS5 in sync with sfx_files
CREATE TRIGGER IF NOT EXISTS sfx_files_ai AFTER INSERT ON sfx_files BEGIN
    INSERT INTO sfx_search(rowid, filename, transcript, folder_tags, ai_tags, ai_category, ai_mood, ai_use_cases)
    VALUES (new.id, new.filename, new.transcript, new.folder_tags, new.ai_tags, new.ai_category, new.ai_mood, new.ai_use_cases);
END;

CREATE TRIGGER IF NOT EXISTS sfx_files_ad AFTER DELETE ON sfx_files BEGIN
    INSERT INTO sfx_search(sfx_search, rowid, filename, transcript, folder_tags, ai_tags, ai_category, ai_mood, ai_use_cases)
    VALUES ('delete', old.id, old.filename, old.transcript, old.folder_tags, old.ai_tags, old.ai_category, old.ai_mood, old.ai_use_cases);
END;

CREATE TRIGGER IF NOT EXISTS sfx_files_au AFTER UPDATE ON sfx_files BEGIN
    INSERT INTO sfx_search(sfx_search, rowid, filename, transcript, folder_tags, ai_tags, ai_category, ai_mood, ai_use_cases)
    VALUES ('delete', old.id, old.filename, old.transcript, old.folder_tags, old.ai_tags, old.ai_category, old.ai_mood, old.ai_use_cases);
    INSERT INTO sfx_search(rowid, filename, transcript, folder_tags, ai_tags, ai_category, ai_mood, ai_use_cases)
    VALUES (new.id, new.filename, new.transcript, new.folder_tags, new.ai_tags, new.ai_category, new.ai_mood, new.ai_use_cases);
END;
"""

DEFAULT_DB_PATH = Path("data/sfx_library.db")


# Columns we may need to add to pre-existing audio DBs that were built before
# video support landed. SQLite ignores `ADD COLUMN` if the column exists, so
# we check first and add only what's missing. Tuple = (column_name, sql_type).
_NEW_COLUMNS = [
    ("media_type", "TEXT DEFAULT 'audio'"),
    ("width", "INTEGER"),
    ("height", "INTEGER"),
    ("fps", "REAL"),
    ("video_codec", "TEXT"),
    ("thumbnail_path", "TEXT"),
]


def _migrate(conn: sqlite3.Connection) -> None:
    """Add video-related columns to old audio-only DBs in place."""
    cols = {row["name"] for row in conn.execute("PRAGMA table_info(sfx_files)")}
    for col_name, col_def in _NEW_COLUMNS:
        if col_name not in cols:
            conn.execute(f"ALTER TABLE sfx_files ADD COLUMN {col_name} {col_def}")
    conn.commit()


def connect(db_path: Path = DEFAULT_DB_PATH) -> sqlite3.Connection:
    """Open (or create) the SQLite DB and ensure the schema is applied."""
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    _migrate(conn)
    return conn


def set_config(conn: sqlite3.Connection, key: str, value: str) -> None:
    conn.execute(
        "INSERT INTO library_config(key, value) VALUES(?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (key, value),
    )
    conn.commit()


def get_config(conn: sqlite3.Connection, key: str) -> str | None:
    row = conn.execute("SELECT value FROM library_config WHERE key=?", (key,)).fetchone()
    return row["value"] if row else None
