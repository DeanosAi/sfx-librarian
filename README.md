# SFX Librarian — Indexer (Phase 1)

Walks a directory of sound effect files, extracts metadata, audio features,
Whisper transcripts, and locally-generated semantic tags via Ollama, and
writes everything to a portable SQLite database with FTS5 full-text search.

**100% local.** Indexing uses a local LLM (Ollama). Search uses local SQLite.
No internet, no API keys, no per-token costs.

## Prerequisites

- Python 3.11+
- ffmpeg + ffprobe on PATH
- [Ollama](https://ollama.com) installed and running
- A pulled model — default is `qwen2.5:14b`:
  ```powershell
  ollama pull qwen2.5:14b
  ```

## Setup (Windows)

Open PowerShell in this folder:

```powershell
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

If activation fails with an execution policy error, run this once first:
```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```

## Usage

```
python -m sfx_index init <library_root>          # create DB, store library root
python -m sfx_index probe <library_root>         # dry run: metadata only, no AI/Whisper
python -m sfx_index dry-run <library_root> --limit 100   # full pipeline on N files
python -m sfx_index run <library_root>           # full pipeline on everything
python -m sfx_index resume                       # continue an interrupted run
python -m sfx_index stats                        # progress + estimated time remaining
python -m sfx_index search "<query>"             # quick CLI search to test the DB
```
