"""Local web server backing the prototype panel.

Run:  .\.venv\Scripts\python.exe panel_server.py
Open: http://127.0.0.1:5173 in your browser.

This server is the WINDOWS-ONLY prototype host. The HTML/CSS/JS in panel/ is
written so it can later be packaged as a Premiere UXP panel on Mac, where the
data access layer is replaced by sql.js + UXP filesystem APIs. The browser-side
code only knows about /api/* endpoints; for UXP we'll provide a thin shim that
implements the same interface against sql.js.
"""
from __future__ import annotations

import difflib
import json
import os
import re
import sqlite3
import subprocess
import tempfile
import threading
from pathlib import Path

from flask import Flask, abort, after_this_request, jsonify, request, send_file, send_from_directory

DB_PATH = Path("data/sfx_library.db")
PANEL_DIR = Path("panel")

app = Flask(__name__, static_folder=None)


def get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def get_library_root() -> Path | None:
    conn = get_conn()
    row = conn.execute("SELECT value FROM library_config WHERE key='library_root'").fetchone()
    conn.close()
    if not row:
        return None
    return Path(row["value"])


def build_fts_query(q: str) -> str:
    """Same as cli.py: split on whitespace, wrap each token as a phrase."""
    tokens = [t.strip() for t in q.split() if t.strip()]
    return " ".join(f'"{t}"' for t in tokens)


# ---- vocabulary cache for autocomplete + typo-tolerance ----

_vocab_lock = threading.Lock()
_vocab: list[str] = []
_vocab_set: set[str] = set()


def load_vocabulary() -> None:
    """Build a sorted list of unique searchable terms: tags, use_cases,
    mood words, and filename word fragments. Cached for the process lifetime."""
    global _vocab, _vocab_set
    with _vocab_lock:
        if _vocab:
            return
        conn = get_conn()
        words: set[str] = set()
        for row in conn.execute(
            "SELECT ai_tags, ai_use_cases, ai_mood, filename FROM sfx_files "
            "WHERE ai_tags IS NOT NULL"
        ):
            for field_idx in (0, 1):
                if row[field_idx]:
                    try:
                        for item in json.loads(row[field_idx]):
                            s = str(item).strip().lower()
                            if s:
                                words.add(s)
                                # Also add individual words from multi-word tags
                                # so "bull whip" -> {"bull whip", "bull", "whip"}.
                                for w in s.split():
                                    if len(w) >= 2:
                                        words.add(w)
                    except json.JSONDecodeError:
                        pass
            if row[2]:
                for m in re.findall(r"[a-z][a-z]+", str(row[2]).lower()):
                    words.add(m)
            if row[3]:
                stem = Path(row[3]).stem.lower()
                for w in re.findall(r"[a-z][a-z]{2,}", stem):
                    words.add(w)
        conn.close()
        _vocab = sorted(words)
        _vocab_set = set(_vocab)


def suggest_terms(last_token: str, limit: int = 8) -> list[str]:
    """Return up to `limit` suggested terms for a partial token.
    Prefix matches first, then fuzzy/typo matches via difflib."""
    if not _vocab:
        load_vocabulary()
    last = last_token.lower()
    if len(last) < 2:
        return []
    # Prefix matches (cheap, common case)
    prefix_hits = [w for w in _vocab if w.startswith(last)]
    prefix_hits.sort(key=len)
    out = prefix_hits[:limit]
    if len(out) < limit:
        # Fuzzy fill — typo tolerance
        seen = set(out)
        close = difflib.get_close_matches(last, _vocab, n=limit, cutoff=0.65)
        for w in close:
            if w not in seen:
                out.append(w)
                if len(out) >= limit:
                    break
    return out


# ---- static panel files ----

@app.get("/")
def index():
    return send_from_directory(PANEL_DIR, "index.html")


@app.get("/<path:filename>")
def panel_static(filename: str):
    """Serve everything in panel/ at the URL root so the same relative paths
    in index.html work in both Flask dev mode and UXP."""
    full = PANEL_DIR / filename
    if not full.is_file():
        abort(404)
    return send_from_directory(PANEL_DIR, filename)


# ---- API ----

@app.get("/api/stats")
def api_stats():
    conn = get_conn()
    total = conn.execute("SELECT COUNT(*) FROM sfx_files").fetchone()[0]
    analyzed = conn.execute(
        "SELECT COUNT(*) FROM sfx_files WHERE transcript IS NOT NULL"
    ).fetchone()[0]
    tagged = conn.execute(
        "SELECT COUNT(*) FROM sfx_files WHERE ai_tags IS NOT NULL"
    ).fetchone()[0]
    library_root = get_library_root()
    conn.close()
    return jsonify({
        "total": total,
        "analyzed": analyzed,
        "tagged": tagged,
        "library_root": str(library_root) if library_root else None,
    })


@app.get("/api/search")
def api_search():
    q = request.args.get("q", "").strip()
    cats_raw = request.args.get("categories", "").strip()
    selected_cats = [c.strip().lower() for c in cats_raw.split(",") if c.strip()]
    try:
        limit = max(1, min(100, int(request.args.get("limit", "20"))))
    except ValueError:
        limit = 20

    if not q and not selected_cats:
        return jsonify({
            "results": [], "count": 0, "query": q, "suggestions": [],
        })

    cols = """f.id, f.filepath_relative, f.filename, f.duration_seconds,
              f.loudness_lufs, f.spectral_centroid_mean, f.sample_rate, f.channels,
              f.ai_category, f.ai_mood, f.ai_tags, f.ai_use_cases,
              f.waveform_peaks, f.transcript"""

    conn = get_conn()
    try:
        if q:
            fts = build_fts_query(q)
            sql = (
                f"SELECT {cols} FROM sfx_search s "
                "JOIN sfx_files f ON f.id = s.rowid "
                "WHERE sfx_search MATCH ?"
            )
            params: list = [fts]
            if selected_cats:
                ph = ",".join("?" * len(selected_cats))
                sql += f" AND LOWER(f.ai_category) IN ({ph})"
                params.extend(selected_cats)
            sql += " ORDER BY rank LIMIT ?"
            params.append(limit)
            rows = conn.execute(sql, params).fetchall()
        else:
            # Browse-by-category — no text query
            ph = ",".join("?" * len(selected_cats))
            sql = (
                f"SELECT {cols} FROM sfx_files f "
                f"WHERE LOWER(f.ai_category) IN ({ph}) "
                "AND f.ai_tags IS NOT NULL "
                "ORDER BY f.id LIMIT ?"
            )
            rows = conn.execute(sql, (*selected_cats, limit)).fetchall()
    except sqlite3.OperationalError as e:
        conn.close()
        return jsonify({"error": str(e), "results": [], "count": 0, "query": q}), 400
    conn.close()

    def parse_json_field(v):
        if not v:
            return []
        try:
            return json.loads(v)
        except json.JSONDecodeError:
            return []

    results = [{
        "id": r["id"],
        "filepath_relative": r["filepath_relative"],
        "filename": r["filename"],
        "duration": r["duration_seconds"],
        "lufs": r["loudness_lufs"],
        "centroid": r["spectral_centroid_mean"],
        "sample_rate": r["sample_rate"],
        "channels": r["channels"],
        "category": r["ai_category"],
        "mood": r["ai_mood"],
        "tags": parse_json_field(r["ai_tags"]),
        "use_cases": parse_json_field(r["ai_use_cases"]),
        "peaks": parse_json_field(r["waveform_peaks"]),
        "transcript": (r["transcript"] or "").strip(),
    } for r in rows]

    # If 0 results, build "did you mean" suggestions per query token.
    suggestions: list[str] = []
    if not results and q:
        if not _vocab:
            load_vocabulary()
        for token in q.lower().split():
            if len(token) < 2:
                continue
            if token in _vocab_set:
                # Real word, not a typo — don't suggest a substitute.
                continue
            for s in difflib.get_close_matches(token, _vocab, n=3, cutoff=0.65):
                if s not in suggestions:
                    suggestions.append(s)
            if len(suggestions) >= 6:
                break

    return jsonify({
        "results": results,
        "count": len(results),
        "query": q,
        "suggestions": suggestions,
    })


@app.get("/api/categories")
def api_categories():
    """Return all categories present in the DB with their counts."""
    conn = get_conn()
    rows = conn.execute(
        "SELECT ai_category AS name, COUNT(*) AS n FROM sfx_files "
        "WHERE ai_category IS NOT NULL "
        "GROUP BY ai_category ORDER BY n DESC"
    ).fetchall()
    conn.close()
    return jsonify({"categories": [{"name": r["name"], "count": r["n"]} for r in rows]})


@app.get("/api/suggest")
def api_suggest():
    """Autocomplete-as-you-type. Suggests completions for the LAST word in q."""
    q = request.args.get("q", "")
    try:
        limit = max(1, min(20, int(request.args.get("limit", "8"))))
    except ValueError:
        limit = 8

    parts = q.split()
    if not parts:
        return jsonify({"suggestions": []})

    last = parts[-1]
    prefix = " ".join(parts[:-1])
    sugs = suggest_terms(last, limit=limit)
    full = [(prefix + " " + s).strip() if prefix else s for s in sugs]
    return jsonify({"suggestions": full})


@app.get("/api/trim/<int:file_id>")
def api_trim(file_id: int):
    """Use ffmpeg to extract [in, out] from the source and return as a downloadable WAV."""
    try:
        in_sec = float(request.args.get("in", ""))
        out_sec = float(request.args.get("out", ""))
    except ValueError:
        abort(400, "in and out (seconds) are required")
    if out_sec <= in_sec or in_sec < 0:
        abort(400, "out must be greater than in, and in must be >= 0")

    conn = get_conn()
    row = conn.execute(
        "SELECT filepath_relative, filename FROM sfx_files WHERE id=?", (file_id,)
    ).fetchone()
    conn.close()
    if not row:
        abort(404)
    root = get_library_root()
    if root is None:
        abort(500, "library_root not set in library_config")
    src = root / row["filepath_relative"]
    if not src.exists():
        abort(404, f"file missing on disk: {src}")

    stem = Path(row["filename"]).stem
    download_name = f"{stem}__trim_{in_sec:.2f}-{out_sec:.2f}.wav"

    tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    tmp.close()
    tmp_path = tmp.name

    # -ss / -to AFTER -i for accurate, sample-precise seeking. Putting them
    # before -i triggers fast-seek which snaps to compressed-codec packet
    # boundaries and drops audio. SFX files are short, the decode cost is fine.
    cmd = [
        "ffmpeg", "-y", "-loglevel", "error",
        "-i", str(src),
        "-ss", f"{in_sec:.3f}",
        "-to", f"{out_sec:.3f}",
        "-c:a", "pcm_s16le",
        "-map", "0:a:0",
        tmp_path,
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, timeout=120)
    except subprocess.TimeoutExpired:
        try: os.unlink(tmp_path)
        except OSError: pass
        return jsonify({"error": "ffmpeg timeout"}), 500
    if proc.returncode != 0:
        try: os.unlink(tmp_path)
        except OSError: pass
        return jsonify({"error": proc.stderr.decode("utf-8", errors="replace")}), 500

    @after_this_request
    def cleanup(response):
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        return response

    return send_file(tmp_path, as_attachment=True, download_name=download_name, mimetype="audio/wav")


@app.get("/api/audio/<int:file_id>")
def api_audio(file_id: int):
    conn = get_conn()
    row = conn.execute(
        "SELECT filepath_relative FROM sfx_files WHERE id=?", (file_id,)
    ).fetchone()
    conn.close()
    if not row:
        abort(404)
    root = get_library_root()
    if root is None:
        abort(500, "library_root not set in library_config")
    full = root / row["filepath_relative"]
    if not full.exists():
        abort(404, f"file missing on disk: {full}")
    return send_file(str(full), conditional=True)


if __name__ == "__main__":
    if not DB_PATH.exists():
        raise SystemExit(f"DB not found at {DB_PATH.resolve()}. Run init/probe first.")
    print(f"\n  SFX Librarian panel server")
    print(f"  DB:    {DB_PATH.resolve()}")
    print(f"  Panel: http://127.0.0.1:5173\n")
    app.run(host="127.0.0.1", port=5173, debug=False, threaded=True)
