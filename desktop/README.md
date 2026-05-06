# Editor's Librarian — desktop app

Cross-platform Electron app for searching the SFX library you indexed in
Phase 1. Reuses the same SQLite DB (`data/sfx_library.db`) — no rebuild
needed when going from indexer → app.

## Status

- ✅ SFX search, filters, autocomplete, did-you-mean
- ✅ Audio preview with in/out region selection
- ✅ Reveal in Finder
- ✅ Music tab (filters DB by `ai_category = 'musical'`)
- ⏳ B-Roll, Transitions tabs — placeholders, will hook into separate DBs
- ⏳ "Send to Premiere" — coming via tiny UXP companion plugin

## Build & run locally

You need Node 20+. On Windows you can develop the UI but the final build
target is macOS — the included GitHub Actions workflow builds the .dmg.

```bash
cd desktop
npm install
npm start          # dev — opens the app pointed at ../data/sfx_library.db
npm run build:mac  # produces desktop/dist/*.dmg (Mac only)
```

## Build for Mac via GitHub Actions

1. Push this repo to GitHub.
2. The workflow at `.github/workflows/build-mac.yml` runs on every push to
   `main` that touches `desktop/`, on a `macos-latest` runner.
3. Download the `.dmg` from the workflow's **Artifacts** section, or tag
   a release (`git tag v0.1.0 && git push --tags`) to publish it.

## What ships in the .dmg

- The Electron app (~150 MB)
- Bundled `sfx_library.db` (~100 MB) — from `../data/sfx_library.db` at build time
- No audio files — too big to bundle. The app asks for your audio folder
  on first launch and stores the path in `~/Library/Application Support/Editors Librarian/settings.json`.

## On first launch

1. Open **Settings** (sidebar bottom-left)
2. **Library database** — already set to the bundled DB; pick a different one
   if you've rebuilt the index
3. **Audio folder** — point at where the SFX library actually lives on this
   Mac (e.g. `/Volumes/LiSTNE SSD/SFX`)
4. Close settings, search, click play

## Adding more media types

Each tab queries the active database with a media-kind filter. Today:

| Tab | Filter |
|---|---|
| SFX | `ai_category != 'musical'` |
| Music | `ai_category = 'musical'` |

To add B-Roll: build a separate index DB with the same schema (the
`sfx_index` Python pipeline can be repointed at any media folder, you just
tune the AI prompt for the media type), then either:

- swap the active DB based on tab (most flexible — each tab = its own DB), or
- add a `media_type` column to the existing schema and filter by that.

The renderer's `tabs.js` and main process's `MEDIA_KIND_FILTERS` map are the
two places to wire a new tab.
