# Indexing B-roll, Transitions, or any video library

This is the same idea as the SFX indexer, but for video. It uses a vision
LLM (looks at a frame from each clip) to generate rich tags so you can
search your footage by what's in it — *"wide aerial city night"*,
*"interior office close up hands"*, *"slow motion person running golden
hour"*, etc.

## What you'll do

1. Pull a vision-capable model into Ollama (one-time, ~5 GB)
2. Run `python -m sfx_index video-index <folder> --db <output.db>` against your video library
3. Copy the resulting `.db` to your Mac
4. In the desktop app: open the **B-Roll** (or **Transitions**) tab → ⚙ Settings → point at the new `.db` file and the local folder where the videos live

You can index the same way for any video collection — B-roll, transitions, stock footage, music videos. Each gets its own DB.

## Prerequisites

- Indexer environment from earlier setup (Python, ffmpeg, ffprobe, Ollama)
- `Ollama` running on the AI machine
- Roughly 6 GB free disk space for the vision model
- Roughly 24 GB VRAM (you have 24 — fits comfortably)

## Step 1 — pull the vision model

In any PowerShell, with Ollama running:

```powershell
ollama pull qwen2-vl:7b
```

This is ~4.7 GB. Other vision models that work with the same API:

| Model | Size | Quality | Speed on 3090 |
|---|---|---|---|
| `qwen2-vl:7b` | 4.7 GB | very good | fast |
| `llama3.2-vision:11b` | 7.5 GB | very good | medium |
| `llava:13b` | 7.5 GB | good | medium |

`qwen2-vl:7b` is the default — solid tag quality, fast iteration.

Verify:

```powershell
ollama list
```

You should see `qwen2-vl:7b` in the list.

## Step 2 — pick your video library and run the indexer

In PowerShell:

```powershell
cd A:\Desktop\sfx-librarian
.\.venv\Scripts\Activate.ps1
```

For B-roll:

```powershell
python -m sfx_index video-index "E:\path\to\BRoll" --db data\broll_library.db
```

For transitions:

```powershell
python -m sfx_index video-index "E:\path\to\Transitions" --db data\transitions_library.db
```

You can also do dry runs first with `--limit 10 --skip-tag` to test the
pipeline before committing to the full run.

### What the command does (per file)

1. **Probe** — ffprobe → duration, resolution, fps, codec, format
2. **Thumbnail** — ffmpeg extracts a single 480-px-wide JPEG at 50 % through the clip, stored in `data/thumbnails/`
3. **Tag** — sends the thumbnail + filename + folder context to `qwen2-vl:7b` and gets back JSON with 20–40 tags, a category (aerial, lifestyle, interior, etc.), mood words, and use-cases

Each stage is **idempotent** — re-running picks up new files only. You can
Ctrl-C and re-run safely.

### Speed expectations

| File count | Probe + thumb | Vision tag | Total |
|---|---|---|---|
| 100 | ~1 min | ~5 min | ~6 min |
| 1,000 | ~5–10 min | ~50 min | ~1 hr |
| 10,000 | ~1 hr | ~8 hrs | ~9 hrs |

Vision tagging is the bottleneck. Each clip = ~3 seconds on a 3090
running qwen2-vl:7b. This is per-image, so very long clips don't take longer
than short ones (we sample one frame).

## Step 3 — flags and options

```powershell
python -m sfx_index video-index --help
```

| Flag | Default | Meaning |
|---|---|---|
| `--db PATH` | `data/broll_library.db` | Where to save the DB. Use a separate path per media kind. |
| `--thumbnails DIR` | `<db parent>/thumbnails/` | Where JPEG thumbnails go. |
| `--limit N` | none | Stop after N files (useful for `--skip-tag` test runs). |
| `--model NAME` | `qwen2-vl:7b` | Ollama vision model. |
| `--skip-tag` | off | Probe + thumbnail only. Useful to verify discovery before tagging. |

### Quality check before the long run

Run on the first 30 files with full pipeline, inspect tag quality:

```powershell
python -m sfx_index video-index "E:\path\to\BRoll" --db data\broll_test.db --limit 30
```

Then peek at what got tagged:

```powershell
python -c "import sqlite3, json; c=sqlite3.connect('data/broll_test.db'); c.row_factory=sqlite3.Row; rows=c.execute('SELECT filename,ai_category,ai_mood,ai_tags FROM sfx_files WHERE ai_tags IS NOT NULL LIMIT 5').fetchall(); [print(f\"{r['filename']}\\n  {r['ai_category']} | {r['ai_mood']}\\n  {json.loads(r['ai_tags'])[:10]}\\n\") for r in rows]"
```

If tags look good, kill the test, delete `data/broll_test.db`, and run on the
full library against the real DB.

## Step 4 — copy to the Mac

After the index finishes:

1. Copy `data/broll_library.db` (and the `data/thumbnails/` folder if you
   want thumbnail previews on the Mac) onto your SSD or wherever you transfer files.
2. Open the **Editor's Librarian** app on the Mac, click the **🎬 B-Roll** tab in the sidebar.
3. Click **⚙ Settings** at the bottom.
4. **Database (B-ROLL)** → Choose → pick `broll_library.db` from your SSD.
5. **Media folder** → Choose → pick the folder on the Mac that has all your video files.
6. Close Settings. Search.

The thumbnails appear automatically next to each result. Click ▶ to play
the video right inside the panel.

## Re-indexing after adding more video

Same as SFX — just rerun the same command. Existing rows are skipped on
mtime check; new files run the full pipeline.

```powershell
python -m sfx_index video-index "E:\path\to\BRoll" --db data\broll_library.db
```

## Multiple libraries (transitions, music videos, etc.)

Each gets its own DB, so the categories don't pollute each other:

```powershell
python -m sfx_index video-index "E:\path\to\Transitions" --db data\transitions_library.db
python -m sfx_index video-index "E:\path\to\Stock" --db data\stock_library.db
```

In the desktop app, the **Transitions** tab can be pointed at
`transitions_library.db`. Future tabs (Stock, Music Video, etc.) will work
the same way once they're added to the sidebar.

## Troubleshooting

- **"Ollama vision check failed: Model 'qwen2-vl:7b' not found"** — `ollama pull qwen2-vl:7b` first.
- **Thumbnails extraction failing** — check that `ffmpeg` is on PATH; corrupt videos will silently skip and log to `failed.log`.
- **Tag quality looks weak** — try `--model llama3.2-vision:11b` for a slightly stronger vision model.
- **Out of VRAM** — close other apps using the GPU, or pull `qwen2-vl:2b` (smaller, lower quality).
- **Re-tag a specific file** — open the DB, set `ai_tags=NULL` for that row's id, rerun the same command.
