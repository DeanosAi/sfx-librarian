# SFX Librarian — Premiere UXP panel

This folder is the panel itself. It runs in two environments:

1. **Browser dev mode** (Windows, while building) — loads `app.js` over HTTP from
   `panel_server.py`, which provides a thin Flask backend hitting the SQLite DB.
   This is what you've been using during development.

2. **Premiere Pro UXP** (Mac, production) — loaded via Adobe UXP Developer Tool.
   `app.js` detects the UXP environment automatically (`require('uxp')` works)
   and switches to the sql.js backend in `data.js`. No Python server involved.

The presentation code in `app.js` is identical between modes. All env-specific
logic is isolated to `data.js`.

## Files

| File              | Role                                                                |
|-------------------|---------------------------------------------------------------------|
| `index.html`      | Panel structure + script entry point                                |
| `style.css`       | Dark theme, tuned to roughly match Premiere's UI palette            |
| `app.js`          | Presentation logic — search, results, audio, in/out, filters, etc. |
| `data.js`         | Backend abstraction (browser/Flask vs UXP/sql.js)                   |
| `manifest.json`   | UXP plugin manifest (only used in Premiere)                         |
| `lib/`            | Vendored libs (sql.js — added on Mac during Phase B)                |

## On Mac: install via Adobe UXP Developer Tool (UDT)

1. Install **UDT** from Creative Cloud's apps tab (if not already there).
2. Copy this `panel/` folder + the `data/sfx_library.db` file to the Mac.
3. Open UDT, click **Add Plugin**, point it at `panel/manifest.json`.
4. Click **Load** to inject the panel into the running Premiere Pro.
5. The panel appears under `Window > Extensions > SFX Librarian`.
6. Click **📁 set library…** in the top-right. Type the path to your SFX folder
   on this Mac (e.g. `/Volumes/LiSTNE SSD/SFX`). Save.

Each machine stores its own library path locally — the .db never changes.

## Sharing with another editor

Send them three things:

- This `panel/` folder (zipped — ~2 MB once sql.js is vendored)
- `sfx_library.db` (~70 MB)
- The actual audio files (their copy of the same SFX library)

They install via UDT and set their library path on first launch. Everything else
just works.
