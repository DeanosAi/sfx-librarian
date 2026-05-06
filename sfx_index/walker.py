"""File discovery for audio files."""
from __future__ import annotations

from pathlib import Path
from typing import Iterator

# Generous catch-all. Anything ffprobe can read should be in here; if a user's
# library uses something exotic, we can add to this set.
AUDIO_EXTENSIONS = {
    ".wav", ".mp3", ".aiff", ".aif", ".aifc",
    ".flac", ".ogg", ".oga", ".m4a", ".aac",
    ".wma", ".opus", ".mp4", ".m4b", ".m4r",
    ".webm", ".ac3", ".dts", ".amr", ".au",
    ".caf", ".w64", ".rf64", ".mka",
}


def iter_audio_files(root: Path) -> Iterator[Path]:
    """Yield audio files under root, sorted for deterministic ordering.

    Skips macOS AppleDouble resource-fork files (names starting with '._') that
    are created when Mac-originated files land on non-Mac filesystems. They look
    like audio files by extension but are metadata blobs ffmpeg can't read.
    """
    for path in sorted(root.rglob("*")):
        if not path.is_file():
            continue
        if path.name.startswith("._"):
            continue
        if path.suffix.lower() in AUDIO_EXTENSIONS:
            yield path
