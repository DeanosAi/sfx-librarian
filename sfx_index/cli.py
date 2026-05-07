"""CLI entry point — all commands live here."""
from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

import click
from tqdm import tqdm

from sfx_index import db as db_mod
from sfx_index.features import extract_features
from sfx_index.probe import probe_file
from sfx_index.tagger import DEFAULT_MODEL, check_ollama_available, tag_row
from sfx_index.transcribe import transcribe_file
from sfx_index.walker import iter_audio_files
from sfx_index.video import (
    DEFAULT_VISION_MODEL,
    check_ollama_vision,
    extract_thumbnail,
    iter_video_files,
    probe_video,
    tag_video,
)


@click.group()
def cli() -> None:
    """SFX Librarian — index a sound effects library into a searchable SQLite DB."""


@cli.command()
@click.argument("library_root", type=click.Path(exists=True, file_okay=False, path_type=Path))
def init(library_root: Path) -> None:
    """Create the DB and store the absolute library root path."""
    abs_root = library_root.resolve()
    conn = db_mod.connect()
    db_mod.set_config(conn, "library_root", str(abs_root))
    db_mod.set_config(conn, "initialized_at", datetime.now().isoformat())
    conn.close()
    click.echo(f"DB created at: {db_mod.DEFAULT_DB_PATH.resolve()}")
    click.echo(f"Library root recorded: {abs_root}")


@cli.command()
@click.argument("library_root", type=click.Path(exists=True, file_okay=False, path_type=Path))
def probe(library_root: Path) -> None:
    """Dry run: walk the library, probe metadata only. No Whisper, no AI."""
    abs_root = library_root.resolve()
    conn = db_mod.connect()

    stored = db_mod.get_config(conn, "library_root")
    if stored is None:
        db_mod.set_config(conn, "library_root", str(abs_root))
    elif Path(stored) != abs_root:
        click.echo(
            f"Note: stored library_root ({stored}) differs from the path you passed "
            f"({abs_root}). Using the path you passed for this run."
        )

    failed_log = Path("failed.log")
    new_count = 0
    updated_count = 0
    skipped_count = 0
    failed_count = 0

    click.echo(f"Scanning {abs_root} ...")
    files = list(iter_audio_files(abs_root))
    click.echo(f"Found {len(files)} audio files.")
    if not files:
        conn.close()
        return

    with failed_log.open("a", encoding="utf-8") as fail_fp:
        for path in tqdm(files, unit="file"):
            try:
                rel = path.relative_to(abs_root)
            except ValueError:
                fail_fp.write(f"{datetime.now().isoformat()}\tRELPATH\t{path}\n")
                failed_count += 1
                continue
            rel_str = str(rel).replace("\\", "/")  # portable Win <-> Mac

            try:
                stat = path.stat()
            except OSError:
                fail_fp.write(f"{datetime.now().isoformat()}\tSTAT\t{path}\n")
                failed_count += 1
                continue
            mtime = int(stat.st_mtime)
            size = stat.st_size

            existing = conn.execute(
                "SELECT id, file_modified_time FROM sfx_files WHERE filepath_relative=?",
                (rel_str,),
            ).fetchone()

            if existing is not None and existing["file_modified_time"] == mtime:
                skipped_count += 1
                continue

            result = probe_file(path)
            if result is None:
                fail_fp.write(f"{datetime.now().isoformat()}\tPROBE\t{path}\n")
                failed_count += 1
                continue

            folder_tags = json.dumps(list(rel.parent.parts))

            if existing is None:
                conn.execute(
                    """
                    INSERT INTO sfx_files (
                        filepath_relative, filename, file_size_bytes, file_modified_time,
                        duration_seconds, sample_rate, channels, format, folder_tags
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        rel_str, path.name, size, mtime,
                        result["duration_seconds"], result["sample_rate"],
                        result["channels"], result["format"], folder_tags,
                    ),
                )
                new_count += 1
            else:
                conn.execute(
                    """
                    UPDATE sfx_files SET
                        filename=?, file_size_bytes=?, file_modified_time=?,
                        duration_seconds=?, sample_rate=?, channels=?, format=?, folder_tags=?
                    WHERE id=?
                    """,
                    (
                        path.name, size, mtime,
                        result["duration_seconds"], result["sample_rate"],
                        result["channels"], result["format"], folder_tags,
                        existing["id"],
                    ),
                )
                updated_count += 1

            if (new_count + updated_count) % 100 == 0:
                conn.commit()

    conn.commit()
    conn.close()

    click.echo("")
    click.echo(f"  New:       {new_count}")
    click.echo(f"  Updated:   {updated_count}")
    click.echo(f"  Unchanged: {skipped_count}")
    click.echo(f"  Failed:    {failed_count}")
    if failed_count > 0:
        click.echo(f"  Failure log: {failed_log.resolve()}")


@cli.command()
@click.option("--limit", type=int, default=None, help="Only analyze the first N pending files.")
@click.option("--whisper-model", type=str, default="base", help="Whisper model: tiny, base, small, medium, large.")
def analyze(limit: int | None, whisper_model: str) -> None:
    """Run Whisper transcription and audio feature extraction on probed files.

    Idempotent: skips rows that already have a transcript and loudness value.
    """
    conn = db_mod.connect()
    library_root = db_mod.get_config(conn, "library_root")
    if library_root is None:
        click.echo("Library root not set. Run `init` or `probe` first.")
        conn.close()
        return
    abs_root = Path(library_root)

    pending = conn.execute(
        """
        SELECT id, filepath_relative
        FROM sfx_files
        WHERE transcript IS NULL OR loudness_lufs IS NULL
        ORDER BY id
        """
    ).fetchall()

    if limit is not None:
        pending = pending[:limit]

    click.echo(f"Pending analysis: {len(pending)} file(s).")
    if not pending:
        conn.close()
        return

    click.echo(f"Loading Whisper model: {whisper_model} (first run downloads ~140 MB for 'base') ...")

    failed_log = Path("failed.log")
    done = 0
    failed = 0

    with failed_log.open("a", encoding="utf-8") as fail_fp:
        for row in tqdm(pending, unit="file"):
            path = abs_root / row["filepath_relative"]
            if not path.exists():
                fail_fp.write(f"{datetime.now().isoformat()}\tMISSING\t{path}\n")
                failed += 1
                continue

            transcript = transcribe_file(path, model_name=whisper_model)
            if transcript is None:
                fail_fp.write(f"{datetime.now().isoformat()}\tWHISPER\t{path}\n")
                failed += 1
                continue

            feats = extract_features(path)
            if feats is None:
                fail_fp.write(f"{datetime.now().isoformat()}\tFEATURES\t{path}\n")
                failed += 1
                continue

            conn.execute(
                """
                UPDATE sfx_files SET
                    transcript=?, loudness_lufs=?, spectral_centroid_mean=?, waveform_peaks=?
                WHERE id=?
                """,
                (
                    transcript,
                    feats["loudness_lufs"],
                    feats["spectral_centroid_mean"],
                    json.dumps(feats["waveform_peaks"]),
                    row["id"],
                ),
            )
            done += 1
            if done % 10 == 0:
                conn.commit()

    conn.commit()
    conn.close()

    click.echo("")
    click.echo(f"  Analyzed: {done}")
    click.echo(f"  Failed:   {failed}")
    if failed > 0:
        click.echo(f"  Failure log: {failed_log.resolve()}")


@cli.command()
@click.option("--limit", type=int, default=None, help="Only tag the first N pending files.")
@click.option("--model", type=str, default=DEFAULT_MODEL, help="Ollama model name.")
@click.option("--workers", type=int, default=1, help="Concurrent Ollama requests. Set OLLAMA_NUM_PARALLEL on server to match.")
def tag(limit: int | None, model: str, workers: int) -> None:
    """Run LLM tagging on rows that have probe + analyze data but no tags yet."""
    from concurrent.futures import ThreadPoolExecutor, as_completed

    ok, msg = check_ollama_available(model=model)
    if not ok:
        click.echo(f"Ollama check failed: {msg}")
        return

    conn = db_mod.connect()
    pending = conn.execute(
        """
        SELECT id, filepath_relative, filename, folder_tags, duration_seconds,
               sample_rate, channels, format, transcript, loudness_lufs,
               spectral_centroid_mean, waveform_peaks
        FROM sfx_files
        WHERE ai_tags IS NULL
          AND transcript IS NOT NULL
          AND loudness_lufs IS NOT NULL
        ORDER BY id
        """
    ).fetchall()

    if limit is not None:
        pending = pending[:limit]

    click.echo(f"Pending tagging: {len(pending)} file(s) using model '{model}', {workers} worker(s).")
    if not pending:
        conn.close()
        return

    per_file_lo = 3 if workers > 1 else 5
    per_file_hi = 6 if workers > 1 else 10
    est_lo = len(pending) * per_file_lo / workers / 60
    est_hi = len(pending) * per_file_hi / workers / 60
    click.echo(f"Estimated time: {est_lo:.1f}–{est_hi:.1f} minutes.")

    failed_log = Path("failed.log")
    done = 0
    failed = 0

    def write_result(row, result):
        nonlocal done, failed
        if result is None:
            fail_fp.write(f"{datetime.now().isoformat()}\tTAG\t{row['filepath_relative']}\n")
            failed += 1
            return
        conn.execute(
            """
            UPDATE sfx_files SET
                ai_tags=?, ai_category=?, ai_mood=?, ai_use_cases=?,
                tagged_at=?, tagging_model=?
            WHERE id=?
            """,
            (
                json.dumps(result["tags"]),
                result["category"],
                result["mood"],
                json.dumps(result["use_cases"]),
                datetime.now().isoformat(),
                model,
                row["id"],
            ),
        )
        done += 1
        if done % 5 == 0:
            conn.commit()

    with failed_log.open("a", encoding="utf-8") as fail_fp:
        if workers <= 1:
            # Sequential path — keeps lowest overhead when workers=1
            for row in tqdm(pending, unit="file"):
                result = tag_row(row, model=model)
                write_result(row, result)
        else:
            # Concurrent path — workers send requests; main thread writes DB
            with ThreadPoolExecutor(max_workers=workers) as ex:
                futures = {ex.submit(tag_row, row, model): row for row in pending}
                for fut in tqdm(as_completed(futures), total=len(futures), unit="file"):
                    row = futures[fut]
                    try:
                        result = fut.result()
                    except Exception:
                        result = None
                    write_result(row, result)

    conn.commit()
    conn.close()

    click.echo("")
    click.echo(f"  Tagged: {done}")
    click.echo(f"  Failed: {failed}")
    if failed > 0:
        click.echo(f"  Failure log: {failed_log.resolve()}")


@cli.command(name="dry-run")
@click.argument("library_root", type=click.Path(exists=True, file_okay=False, path_type=Path))
@click.option("--limit", type=int, default=100, help="Number of files to process.")
def dry_run(library_root: Path, limit: int) -> None:
    """Full pipeline (probe + Whisper + features + AI) on the first N files."""
    click.echo("[dry-run] not yet implemented (Step 4)")


@cli.command()
@click.argument("library_root", type=click.Path(exists=True, file_okay=False, path_type=Path))
def run(library_root: Path) -> None:
    """Full pipeline on every file in the library."""
    click.echo("[run] not yet implemented (Step 4)")


@cli.command()
def resume() -> None:
    """Continue an interrupted run.

    All stages (probe, analyze, tag) are idempotent and skip already-done rows,
    so you can simply re-run any of them after Ctrl-C. This command runs all
    three in order using the stored library_root.
    """
    conn = db_mod.connect()
    library_root = db_mod.get_config(conn, "library_root")
    conn.close()
    if not library_root:
        click.echo("Library root not set. Run `init` first.")
        return

    ctx = click.get_current_context()
    click.echo(f"Resuming pipeline against: {library_root}")
    ctx.invoke(probe, library_root=Path(library_root))
    ctx.invoke(analyze, limit=None, whisper_model="base")
    ctx.invoke(tag, limit=None, model=DEFAULT_MODEL)


@cli.command()
def stats() -> None:
    """Show how many files are indexed, analyzed, tagged."""
    conn = db_mod.connect()
    library_root = db_mod.get_config(conn, "library_root")

    total = conn.execute("SELECT COUNT(*) FROM sfx_files").fetchone()[0]
    analyzed = conn.execute(
        "SELECT COUNT(*) FROM sfx_files WHERE transcript IS NOT NULL AND loudness_lufs IS NOT NULL"
    ).fetchone()[0]
    tagged = conn.execute("SELECT COUNT(*) FROM sfx_files WHERE ai_tags IS NOT NULL").fetchone()[0]
    pending_analyze = total - analyzed
    pending_tag = analyzed - tagged

    db_size = db_mod.DEFAULT_DB_PATH.stat().st_size if db_mod.DEFAULT_DB_PATH.exists() else 0

    click.echo("")
    click.echo(f"  Library root : {library_root or '(not set)'}")
    click.echo(f"  DB file      : {db_mod.DEFAULT_DB_PATH.resolve()} ({db_size / 1024 / 1024:.2f} MB)")
    click.echo("")
    click.echo(f"  Files probed : {total}")
    click.echo(f"  Analyzed     : {analyzed}  (pending: {pending_analyze})")
    click.echo(f"  Tagged       : {tagged}  (pending: {pending_tag})")

    # Rough remaining time. Files still to analyze will also need tagging.
    if pending_analyze + pending_tag > 0:
        try:
            import torch
            has_cuda = bool(torch.cuda.is_available())
        except ImportError:
            has_cuda = False
        analyze_rate = 1.2 if has_cuda else 5.5  # seconds/file
        tag_rate = 8.0  # seconds/file with workers=2 on 14B
        will_tag = pending_analyze + pending_tag
        est_sec = pending_analyze * analyze_rate + will_tag * tag_rate
        est_hr = est_sec / 3600
        click.echo(
            f"  Est. remaining: ~{est_hr:.1f} hr "
            f"(analyze: {pending_analyze * analyze_rate / 3600:.1f}h, "
            f"tag: {will_tag * tag_rate / 3600:.1f}h)"
        )

    by_cat = conn.execute(
        "SELECT ai_category, COUNT(*) c FROM sfx_files WHERE ai_category IS NOT NULL "
        "GROUP BY ai_category ORDER BY c DESC"
    ).fetchall()
    if by_cat:
        click.echo("")
        click.echo("  Tag distribution by category:")
        for r in by_cat:
            click.echo(f"    {r[0]:14s} {r[1]}")

    conn.close()


def _build_fts_query(user_input: str) -> str:
    """Turn user-entered query into an FTS5 expression.

    Splits on whitespace, wraps each token as a phrase, joins with implicit AND.
    "bull whip" -> '"bull" "whip"'.
    """
    tokens = [t.strip() for t in user_input.split() if t.strip()]
    if not tokens:
        return ""
    return " ".join(f'"{t}"' for t in tokens)


@cli.command()
@click.argument("query")
@click.option("--limit", type=int, default=10, help="Max results to show.")
def search(query: str, limit: int) -> None:
    """Run an FTS5 search against the indexed library."""
    fts = _build_fts_query(query)
    if not fts:
        click.echo("Empty query.")
        return

    conn = db_mod.connect()
    rows = conn.execute(
        """
        SELECT
            f.id, f.filepath_relative, f.filename, f.duration_seconds,
            f.loudness_lufs, f.ai_category, f.ai_mood, f.ai_tags
        FROM sfx_search s
        JOIN sfx_files f ON f.id = s.rowid
        WHERE sfx_search MATCH ?
        ORDER BY rank
        LIMIT ?
        """,
        (fts, limit),
    ).fetchall()
    conn.close()

    if not rows:
        click.echo(f"No results for: {query}")
        return

    click.echo(f"Top {len(rows)} result(s) for: {query}")
    click.echo("")
    for r in rows:
        try:
            tags = json.loads(r["ai_tags"]) if r["ai_tags"] else []
        except json.JSONDecodeError:
            tags = []
        top_tags = ", ".join(tags[:8])
        click.echo(f"  #{r['id']}  {r['filename']}")
        click.echo(f"     {r['duration_seconds']:.1f}s | {r['ai_category']} | mood: {r['ai_mood']}")
        click.echo(f"     tags: {top_tags}{'...' if len(tags) > 8 else ''}")
        click.echo("")


# =====================================================================
# Video pipeline (B-roll / transitions / any video library)
# =====================================================================

@cli.command(name="video-index")
@click.argument("library_root", type=click.Path(exists=True, file_okay=False, path_type=Path))
@click.option("--db", "db_path_str", type=str, default="data/broll_library.db",
              help="Output DB file. Use a different path per media kind, "
                   "e.g. data/broll_library.db, data/transitions_library.db.")
@click.option("--thumbnails", "thumbs_str", type=str, default=None,
              help="Folder for extracted thumbnails. Default: <db parent>/thumbnails/.")
@click.option("--limit", type=int, default=None, help="Stop after N files (for testing).")
@click.option("--model", type=str, default=DEFAULT_VISION_MODEL,
              help="Ollama vision model (e.g. qwen2-vl:7b, llama3.2-vision:11b).")
@click.option("--skip-tag", is_flag=True, help="Probe + thumbnail only; skip vision tagging.")
def video_index(library_root: Path, db_path_str: str, thumbs_str: str | None,
                limit: int | None, model: str, skip_tag: bool) -> None:
    """Index a video library: probe → thumbnail → vision-LLM tag.

    Each stage is idempotent — re-running picks up new files only. The output
    DB is the same shape as the SFX one, with extra video columns populated.
    """
    abs_root = library_root.resolve()
    db_path = Path(db_path_str)
    thumbs_dir = Path(thumbs_str) if thumbs_str else (db_path.parent / "thumbnails")
    thumbs_dir.mkdir(parents=True, exist_ok=True)

    if not skip_tag:
        ok, msg = check_ollama_vision(model=model)
        if not ok:
            click.echo(f"Ollama vision check failed: {msg}")
            return

    conn = db_mod.connect(db_path)
    db_mod.set_config(conn, "library_root", str(abs_root))
    db_mod.set_config(conn, "media_type", "video")

    # ---- discovery ----
    click.echo(f"Scanning {abs_root} ...")
    files = list(iter_video_files(abs_root))
    click.echo(f"Found {len(files)} video files.")
    if limit is not None:
        files = files[:limit]
    if not files:
        conn.close()
        return

    failed_log = Path("failed.log")
    new_count = updated_count = skipped_count = failed_count = 0
    thumbed_count = tagged_count = 0

    # ---- pipeline ----
    with failed_log.open("a", encoding="utf-8") as fail_fp:
        for path in tqdm(files, unit="file"):
            try:
                rel = path.relative_to(abs_root)
            except ValueError:
                fail_fp.write(f"{datetime.now().isoformat()}\tRELPATH\t{path}\n")
                failed_count += 1
                continue
            rel_str = str(rel).replace("\\", "/")

            try:
                stat = path.stat()
            except OSError:
                fail_fp.write(f"{datetime.now().isoformat()}\tSTAT\t{path}\n")
                failed_count += 1
                continue
            mtime = int(stat.st_mtime)
            size = stat.st_size

            existing = conn.execute(
                "SELECT id, file_modified_time, thumbnail_path, ai_tags "
                "FROM sfx_files WHERE filepath_relative=?",
                (rel_str,),
            ).fetchone()

            # Stage 1: probe (skip if mtime unchanged AND already probed)
            if existing is not None and existing["file_modified_time"] == mtime \
                    and existing["thumbnail_path"]:
                # Already fully probed + thumbed; skip to tag check
                row_id = existing["id"]
                width = height = fps = duration = 0
                vcodec = ""
                fmt = ""
            else:
                result = probe_video(path)
                if result is None:
                    fail_fp.write(f"{datetime.now().isoformat()}\tVPROBE\t{path}\n")
                    failed_count += 1
                    continue
                width, height = result["width"], result["height"]
                fps = result["fps"]
                duration = result["duration_seconds"]
                vcodec = result["video_codec"]
                fmt = result["format"]
                folder_tags = json.dumps(list(rel.parent.parts))

                if existing is None:
                    cur = conn.execute(
                        """
                        INSERT INTO sfx_files (
                            filepath_relative, filename, file_size_bytes, file_modified_time,
                            duration_seconds, format, folder_tags,
                            media_type, width, height, fps, video_codec
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'video', ?, ?, ?, ?)
                        """,
                        (rel_str, path.name, size, mtime,
                         duration, fmt, folder_tags,
                         width, height, fps, vcodec),
                    )
                    row_id = cur.lastrowid
                    new_count += 1
                else:
                    row_id = existing["id"]
                    conn.execute(
                        """
                        UPDATE sfx_files SET
                            filename=?, file_size_bytes=?, file_modified_time=?,
                            duration_seconds=?, format=?,
                            media_type='video', width=?, height=?, fps=?, video_codec=?
                        WHERE id=?
                        """,
                        (path.name, size, mtime,
                         duration, fmt, width, height, fps, vcodec, row_id),
                    )
                    updated_count += 1

            # Stage 2: thumbnail
            existing_thumb = conn.execute(
                "SELECT thumbnail_path FROM sfx_files WHERE id=?", (row_id,)
            ).fetchone()
            need_thumb = not existing_thumb or not existing_thumb["thumbnail_path"] \
                or not Path(existing_thumb["thumbnail_path"]).exists()
            if need_thumb:
                thumb_filename = f"{row_id}.jpg"
                thumb_path = thumbs_dir / thumb_filename
                ok = extract_thumbnail(path, thumb_path)
                if ok:
                    conn.execute(
                        "UPDATE sfx_files SET thumbnail_path=? WHERE id=?",
                        (str(thumb_path.resolve()), row_id),
                    )
                    thumbed_count += 1
                else:
                    fail_fp.write(f"{datetime.now().isoformat()}\tTHUMB\t{path}\n")
                    # Don't bail — we can still tag via metadata only

            # Stage 3: vision tag
            if skip_tag:
                continue
            tag_status = conn.execute(
                "SELECT ai_tags, thumbnail_path FROM sfx_files WHERE id=?", (row_id,)
            ).fetchone()
            if tag_status["ai_tags"] is not None:
                skipped_count += 1
                continue
            if not tag_status["thumbnail_path"]:
                # No thumbnail = vision LLM can't tag. Skip; we'll log it.
                fail_fp.write(f"{datetime.now().isoformat()}\tNOTHUMB\t{path}\n")
                failed_count += 1
                continue

            folder_hint = "/".join(list(rel.parent.parts)[-3:]) if rel.parent.parts else "(root)"
            tag_result = tag_video(
                Path(tag_status["thumbnail_path"]),
                path.name, folder_hint,
                duration, width, height, fps,
                model=model,
            )
            if tag_result is None:
                fail_fp.write(f"{datetime.now().isoformat()}\tVTAG\t{path}\n")
                failed_count += 1
                continue

            conn.execute(
                """
                UPDATE sfx_files SET
                    ai_tags=?, ai_category=?, ai_mood=?, ai_use_cases=?,
                    tagged_at=?, tagging_model=?
                WHERE id=?
                """,
                (
                    json.dumps(tag_result["tags"]),
                    tag_result["category"],
                    tag_result["mood"],
                    json.dumps(tag_result["use_cases"]),
                    datetime.now().isoformat(),
                    model,
                    row_id,
                ),
            )
            tagged_count += 1
            if tagged_count % 5 == 0:
                conn.commit()

    conn.commit()
    conn.close()

    click.echo("")
    click.echo(f"  DB:           {db_path.resolve()}")
    click.echo(f"  Thumbs dir:   {thumbs_dir.resolve()}")
    click.echo(f"  New rows:     {new_count}")
    click.echo(f"  Updated:      {updated_count}")
    click.echo(f"  Already done: {skipped_count}")
    click.echo(f"  Thumbnails:   {thumbed_count} extracted")
    click.echo(f"  Tagged:       {tagged_count}")
    click.echo(f"  Failed:       {failed_count}")
    if failed_count > 0:
        click.echo(f"  Failure log:  {failed_log.resolve()}")


if __name__ == "__main__":
    cli()
