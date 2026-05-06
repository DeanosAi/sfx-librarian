"""ffprobe wrapper for basic audio metadata."""
from __future__ import annotations

from pathlib import Path
from typing import Optional, TypedDict

import ffmpeg


class ProbeResult(TypedDict):
    duration_seconds: float
    sample_rate: int
    channels: int
    format: str


def probe_file(path: Path) -> Optional[ProbeResult]:
    """Run ffprobe on a file. Return None if probe fails or no audio stream found."""
    try:
        info = ffmpeg.probe(str(path))
    except ffmpeg.Error:
        return None
    except Exception:
        return None

    audio = next(
        (s for s in info.get("streams", []) if s.get("codec_type") == "audio"),
        None,
    )
    if audio is None:
        return None

    fmt = info.get("format", {})
    duration_raw = fmt.get("duration") or audio.get("duration") or 0
    try:
        duration = float(duration_raw)
    except (TypeError, ValueError):
        duration = 0.0

    try:
        sample_rate = int(audio.get("sample_rate") or 0)
    except (TypeError, ValueError):
        sample_rate = 0

    try:
        channels = int(audio.get("channels") or 0)
    except (TypeError, ValueError):
        channels = 0

    return {
        "duration_seconds": duration,
        "sample_rate": sample_rate,
        "channels": channels,
        "format": fmt.get("format_name", "unknown"),
    }
