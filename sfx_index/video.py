"""Video indexing pipeline.

Parallels the audio pipeline (probe → analyze → tag) but for video files.
The big differences:
  - probe captures resolution/fps/codec instead of sample-rate/channels
  - "analyze" extracts a JPEG thumbnail at 50 % through the clip
  - tagger uses a vision-capable LLM (qwen2-vl by default) and feeds it
    the thumbnail + filename context, rather than text features

All stages are idempotent — re-running skips rows already done.

Output goes into a separate SQLite DB by default (data/broll_library.db) so
your video index doesn't mix with your SFX index. The schema is shared with
the audio table, with video columns (width/height/fps/video_codec/
thumbnail_path) added; audio-specific columns stay NULL.
"""
from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Iterator, Optional, TypedDict

import ffmpeg
import ollama


VIDEO_EXTENSIONS = {
    ".mp4", ".mov", ".m4v", ".mkv", ".avi", ".mxf",
    ".mpg", ".mpeg", ".webm", ".wmv", ".flv", ".ts", ".mts",
    ".prores", ".dnxhd", ".braw", ".r3d",  # rare, may not all probe
}


# --------------------------------------------------------------------------
# Walker
# --------------------------------------------------------------------------

def iter_video_files(root: Path) -> Iterator[Path]:
    """Yield every video file under root, sorted; skips macOS resource forks."""
    for path in sorted(root.rglob("*")):
        if not path.is_file():
            continue
        if path.name.startswith("._"):
            continue
        if path.suffix.lower() in VIDEO_EXTENSIONS:
            yield path


# --------------------------------------------------------------------------
# Probe
# --------------------------------------------------------------------------

class VideoProbeResult(TypedDict):
    duration_seconds: float
    width: int
    height: int
    fps: float
    video_codec: str
    format: str


def probe_video(path: Path) -> Optional[VideoProbeResult]:
    """ffprobe a video file. Returns None if the file isn't a valid video."""
    try:
        info = ffmpeg.probe(str(path))
    except ffmpeg.Error:
        return None
    except Exception:
        return None

    video_stream = next(
        (s for s in info.get("streams", []) if s.get("codec_type") == "video"),
        None,
    )
    if video_stream is None:
        return None

    fmt = info.get("format", {})

    duration_raw = fmt.get("duration") or video_stream.get("duration") or 0
    try:
        duration = float(duration_raw)
    except (TypeError, ValueError):
        duration = 0.0

    try:
        width = int(video_stream.get("width") or 0)
        height = int(video_stream.get("height") or 0)
    except (TypeError, ValueError):
        width = height = 0

    fps_str = video_stream.get("avg_frame_rate") or video_stream.get("r_frame_rate") or "0/1"
    try:
        num, den = fps_str.split("/")
        n = float(num); d = float(den)
        fps = n / d if d else 0.0
    except (ValueError, ZeroDivisionError):
        fps = 0.0

    return {
        "duration_seconds": duration,
        "width": width,
        "height": height,
        "fps": fps,
        "video_codec": video_stream.get("codec_name", "unknown"),
        "format": fmt.get("format_name", "unknown"),
    }


# --------------------------------------------------------------------------
# Thumbnail extraction
# --------------------------------------------------------------------------

def extract_thumbnail(video_path: Path, output_path: Path,
                       at_fraction: float = 0.5, width_px: int = 480) -> bool:
    """Extract a single JPEG thumbnail from `at_fraction` of the way through
    the video. Returns True on success.
    """
    output_path.parent.mkdir(parents=True, exist_ok=True)

    # We don't know the duration here, but ffmpeg accepts a fractional
    # seek with `-ss`. To seek-by-fraction we have to know duration; do a
    # cheap probe inline. (Most callers already have the probe result so
    # this is rarely hit, but it's nice as a self-contained helper.)
    try:
        info = ffmpeg.probe(str(video_path))
        duration = float(info.get("format", {}).get("duration") or 0)
    except Exception:
        duration = 0.0
    seek = max(0.0, duration * at_fraction)

    cmd = [
        "ffmpeg", "-y", "-loglevel", "error",
        "-ss", f"{seek:.3f}",
        "-i", str(video_path),
        "-frames:v", "1",
        "-q:v", "3",
        "-vf", f"scale={width_px}:-2",
        str(output_path),
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, timeout=30)
    except (subprocess.TimeoutExpired, OSError):
        return False
    return proc.returncode == 0 and output_path.exists() and output_path.stat().st_size > 0


# --------------------------------------------------------------------------
# Vision tagger (Ollama)
# --------------------------------------------------------------------------

DEFAULT_VISION_MODEL = "llama3.2-vision:11b"


VIDEO_TAG_SYSTEM_PROMPT = """You are an expert video tagger for an editor's footage library. Your tags become a searchable FTS5 index. Editors will type queries like:

  - "wide aerial city" — shot type + subject + setting
  - "golden hour beach" — time of day + location
  - "person walking slow motion" — subject + action + style
  - "cinematic mountains drone" — vibe + subject + technique
  - "establishing shot interior office" — use case + setting

Generate 20-40 tags per clip. The breadth matters — editors search loosely.
ALWAYS include, where applicable:

  1. SHOT TYPE — wide, medium, close up, extreme close up, aerial, overhead, top-down, pov, handheld, static, dolly, pan, tilt, zoom
  2. SUBJECT — person, woman, man, child, group, crowd, animal, vehicle, building, nature, water, sky, food, hands, etc.
  3. SETTING — interior, exterior, urban, rural, ocean, forest, mountain, street, office, kitchen, etc.
  4. TIME OF DAY / LIGHT — morning, golden hour, midday, sunset, blue hour, night, overcast, sunny, backlit
  5. MOOD / AESTHETIC — cinematic, gritty, warm, cold, moody, vibrant, minimal, lifestyle, documentary
  6. ACTION / MOTION — static, walking, running, panning, gentle, frenetic, slow motion, time-lapse

CATEGORY DECISION (one primary):
  - aerial — drone / overhead / bird's eye
  - establishing — wide setting shot, no specific subject focus
  - lifestyle — people doing everyday things
  - interior — inside a space
  - exterior — outside, location-focused
  - nature — landscape / animals / weather
  - urban — city / street / architecture
  - person — subject-focused on a human
  - abstract — patterns / textures / non-literal
  - action — movement, sports, dramatic motion
  - slow_motion — explicitly slow-mo style
  - transition — sweep / whip pan / blur / something designed to bridge
  - other — when nothing else fits

OUTPUT exactly this JSON, nothing else:
{
  "tags": [array of 20-40 lowercase strings],
  "category": "single value from the list above",
  "mood": "5-10 mood/aesthetic words space-separated",
  "use_cases": [5-15 editing use-cases — e.g. 'documentary intro', 'travel vlog b-roll', 'corporate interior', 'establishing wide']
}

Reply with ONLY the JSON object. Lowercase tags. No duplicates. No prose."""


class TagResult(TypedDict):
    tags: list[str]
    category: str
    mood: str
    use_cases: list[str]


def _build_user_prompt(filename: str, folder_hint: str,
                       duration_s: float, width: int, height: int,
                       fps: float) -> str:
    res = f"{width}x{height}" if width and height else "unknown"
    fps_str = f"{fps:.2f} fps" if fps else "unknown fps"
    return (
        f"INPUT METADATA:\n"
        f"  Filename: {filename}\n"
        f"  Folder: {folder_hint or '(root)'}\n"
        f"  Duration: {duration_s:.1f}s\n"
        f"  Resolution: {res}, {fps_str}\n"
        f"\nTag the attached frame from the video.\n\nOUTPUT:"
    )


def tag_video(thumbnail_path: Path, filename: str, folder_hint: str,
              duration_s: float, width: int, height: int, fps: float,
              model: str = DEFAULT_VISION_MODEL,
              host: str = "http://localhost:11434") -> Optional[TagResult]:
    """Send the thumbnail + metadata context to Ollama, parse JSON.
    Returns None on any failure (unreachable server, JSON parse error, etc.).
    """
    user_prompt = _build_user_prompt(
        filename, folder_hint, duration_s, width, height, fps
    )
    try:
        client = ollama.Client(host=host)
        resp = client.chat(
            model=model,
            messages=[
                {"role": "system", "content": VIDEO_TAG_SYSTEM_PROMPT},
                {"role": "user", "content": user_prompt, "images": [str(thumbnail_path)]},
            ],
            format="json",
            options={
                # Smaller context so the KV cache fits in VRAM. Vision models
                # default to 32k+ which forces Ollama into CPU mode on most
                # consumer GPUs. 4096 is more than we need for the prompt + JSON.
                "num_ctx": 4096,
                # Force as many transformer layers as possible onto the GPU.
                # 999 is a sentinel — Ollama clamps to the actual layer count.
                "num_gpu": 999,
                "temperature": 0.3,
                "num_predict": 700,
            },
        )
    except Exception:
        return None

    content = resp.get("message", {}).get("content", "")
    try:
        data = json.loads(content)
    except json.JSONDecodeError:
        return None

    raw_tags = data.get("tags") or []
    raw_uses = data.get("use_cases") or []
    if not isinstance(raw_tags, list) or not isinstance(raw_uses, list):
        return None

    def dedupe(arr):
        seen, out = set(), []
        for x in arr:
            s = str(x).strip().lower()
            if s and s not in seen:
                seen.add(s)
                out.append(s)
        return out

    return {
        "tags": dedupe(raw_tags),
        "category": str(data.get("category") or "other").strip().lower(),
        "mood": str(data.get("mood") or "").strip().lower(),
        "use_cases": dedupe(raw_uses),
    }


def check_ollama_vision(model: str = DEFAULT_VISION_MODEL,
                       host: str = "http://localhost:11434") -> tuple[bool, str]:
    """Return (ok, message). Verifies host is reachable and the vision model
    is pulled."""
    try:
        client = ollama.Client(host=host)
        models = client.list()
    except Exception as e:
        return False, f"Cannot reach Ollama at {host}: {e}"

    names = []
    for m in models.get("models", []):
        names.append(m.get("model") or m.get("name") or "")
    if model not in names and not any(n.startswith(model.split(":")[0]) for n in names):
        return False, (
            f"Model '{model}' not found in Ollama. Pull it with: "
            f"ollama pull {model}"
        )
    return True, "ok"
