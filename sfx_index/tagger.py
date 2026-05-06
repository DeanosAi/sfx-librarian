"""Local LLM tagging via Ollama (qwen2.5:14b by default).

Generates wide-coverage tags (20-40 per file) so the FTS5 index supports queries
across literal sound names, onomatopoeia, source objects, mood/vibe, and use-cases.
"""
from __future__ import annotations

import json
from typing import Optional, TypedDict

import ollama

DEFAULT_MODEL = "qwen2.5:14b"
DEFAULT_HOST = "http://localhost:11434"


SYSTEM_PROMPT = """You are an expert audio tagger for a video editor's sound effects library. Your tags become a searchable FTS5 index. Editors will search using these query types:

1. LITERAL sound names — "bull whip", "ding", "crash", "thud", "whoosh"
2. ONOMATOPOEIA — "swoosh", "fwip", "kaboom", "splat", "boing"
3. SOURCE OBJECTS — "glass break", "wooden door", "metal scrape", "elevator chime"
4. VIBE / MOOD — "tense build", "ethereal pad", "comedic stinger", "dramatic impact"
5. USE CASES — "scene transition", "logo reveal", "tension cue", "punctuation hit"

Your tag list MUST include matches for ALL FIVE query types where relevant.

CRITICAL RULES:
- Folder names and filename are HINTS, not ground truth. The audio features tell the truth. If filename says "whoosh" but the features (sharp transient, dry decay, mid-bright centroid) say "impact", trust the features.
- Generate 20-40 tags per file. Breadth matters more than concision.
- Include both space-separated AND concatenated forms when applicable ("bull whip" AND "bullwhip", "fly by" AND "flyby").
- Include common synonyms, onomatopoeia, alternate spellings, and adjacent concepts.
- ALL tags lowercase. NO duplicates.
- ALWAYS reply with valid JSON only. No prose, no preamble.

CATEGORY DECISION RULES — apply IN ORDER, first match wins:
1. Continuous motion, sweep, pass-by, doppler, fly-by, whip-pan, fly-through → "whoosh" (EVEN IF the source is a vehicle, jet, engine, animal, or magic — motion dominates source)
2. Spoken word, dialogue, vocalization → "voice"
3. Animal sound (bark, roar, chirp, etc., not moving) → "animal"
4. Recognizable music, melody, chord, drum loop → "musical"
5. UI / interface / notification / button / system tone → "ui"
6. Single transient hit, strike, slam, collision, punch, explosion, gunshot → "impact"
7. Weapon-specific sustained (e.g. blade hum, energy weapon charge) → "weapon"
8. Long sustained background, room tone, atmosphere, nature bed (no clear single source) → "ambient"
9. Object-being-handled, footsteps, cloth, props, body — naturalistic foley → "foley"
10. Stationary mechanical operation, engine idle, machinery in place → "mechanical"
11. Vehicle stationary (ONLY if not moving; if moving see rule 1) → "vehicle"
12. Nature element — water, fire, weather, wind without movement focus → "nature"
13. Synthesized / processed / designed sound with no obvious natural source → "designed"
14. None of the above → "other"

Important: a "jet doppler" or "car pass-by" is rule 1 (whoosh), NOT rule 10/11. The motion is the searchable concept.

OUTPUT SCHEMA (return JSON exactly matching this shape):
{
  "tags": [array of 20-40 lowercase strings],
  "category": "one of: whoosh, impact, ambient, foley, ui, musical, voice, designed, animal, weapon, vehicle, nature, mechanical, other",
  "mood": "5-10 mood/energy/texture words, space separated, e.g. 'tense dark heavy industrial gritty'",
  "use_cases": [array of 5-15 editing use-cases]
}

EXAMPLES:

INPUT:
  Filename: WhipCrack_Leather_03.wav
  Folder: SFX/Foley/Whips
  Duration: 0.6s
  Loudness: -10.2 LUFS (loud)
  Brightness: 4200 Hz centroid (very bright/airy)
  Punchiness: very punchy / sharp transient
  Transcript: (no speech detected)

OUTPUT:
{"tags":["whip","bull whip","bullwhip","whip crack","crack","snap","lash","leather","rope","fwap","thwack","crack snap","leather crack","sharp","punchy","percussive","western","cowboy","indiana jones","stinger","punctuation","transient hit","slap","one-shot"],"category":"impact","mood":"sharp aggressive sudden bright punchy","use_cases":["impact accent","comedic punctuation","western sting","transition hit","logo reveal","violent emphasis","sharp cut accent"]}

INPUT:
  Filename: AMB_Forest_Night_01.wav
  Folder: SFX/Ambience/Nature
  Duration: 124.3s
  Loudness: -28.4 LUFS (quiet)
  Brightness: 2100 Hz centroid (mid)
  Punchiness: smooth / sustained
  Transcript: (no speech detected)

OUTPUT:
{"tags":["forest","night","ambient","ambience","atmosphere","atmos","background","nature","outdoor","wilderness","crickets","insects","leaves","rustling","wind","evening","dusk","drone","pad","bed","loop","calm","peaceful","still","quiet","rural","woods"],"category":"ambient","mood":"calm peaceful organic spacious quiet contemplative natural","use_cases":["scene background","atmosphere bed","establishing shot","location ambience","dialogue underbed","documentary nature scene","transition fade"]}

INPUT:
  Filename: Doppler_JetPass_Slow_03.wav
  Folder: SFX/Vehicles/Jets
  Duration: 4.2s
  Loudness: -16.0 LUFS (loud (mastered))
  Brightness: 1500 Hz centroid (mid)
  Punchiness: smooth / sustained
  Transcript: (no speech detected)

OUTPUT:
{"tags":["whoosh","doppler","jet","jet pass","fly by","flyby","pass by","passby","sweep","airplane","aircraft","engine pass","approach","recede","wind","rush","speed","fast","movement","motion","kinetic","vehicle pass","aerial","sci fi","cinematic","whoosh by"],"category":"whoosh","mood":"fast moving sweeping aerial cinematic","use_cases":["scene transition","jet flyover accent","speed cue","action accent","kinetic transition","whip pan accent","title reveal"]}

INPUT:
  Filename: UI_Notification_Ding_Bright.wav
  Folder: SFX/UI/Alerts
  Duration: 0.9s
  Loudness: -14.0 LUFS (loud)
  Brightness: 5400 Hz centroid (very bright/airy)
  Punchiness: punchy / clear transients
  Transcript: (no speech detected)

OUTPUT:
{"tags":["ding","bell","chime","ping","notification","alert","ui","interface","tone","beep","blip","ting","ringle","tinkle","bright","crystalline","positive","success","glockenspiel","triangle","email tone","message tone","mobile","app","short bell","one-shot ding"],"category":"ui","mood":"bright crisp positive cheerful clean digital","use_cases":["notification sound","ui feedback","success cue","message alert","logo accent","positive confirmation","email pop"]}

Reply ONLY with the JSON object. No markdown fences, no commentary."""


class TagResult(TypedDict):
    tags: list[str]
    category: str
    mood: str
    use_cases: list[str]


# ---- feature → descriptor helpers ----

def _bucket_centroid(hz: Optional[float]) -> str:
    if hz is None:
        return "unknown"
    if hz < 500:
        return "very dark/boomy"
    if hz < 1200:
        return "dark/low"
    if hz < 2200:
        return "mid"
    if hz < 4000:
        return "bright/treble"
    return "very bright/airy"


def _bucket_lufs(lufs: Optional[float]) -> str:
    if lufs is None:
        return "unknown"
    if lufs > -12:
        return "very loud"
    if lufs > -18:
        return "loud (mastered)"
    if lufs > -24:
        return "medium"
    if lufs > -36:
        return "quiet"
    return "very quiet"


def _punchiness_from_peaks(peaks_json: Optional[str]) -> str:
    if not peaks_json:
        return "unknown"
    try:
        peaks = json.loads(peaks_json)
    except json.JSONDecodeError:
        return "unknown"
    if not peaks:
        return "unknown"
    peak_max = max(peaks)
    mean = sum(peaks) / len(peaks)
    if mean == 0:
        return "silent"
    ratio = peak_max / mean
    strong = sum(1 for p in peaks if p > 0.7)
    if ratio > 4 and strong < 20:
        return "very punchy / sharp transient"
    if ratio > 2.5:
        return "punchy / clear transients"
    if strong > 80:
        return "dense transients / busy"
    return "smooth / sustained"


def _build_user_prompt(row) -> str:
    try:
        folder_tags = json.loads(row["folder_tags"] or "[]")
    except (json.JSONDecodeError, TypeError):
        folder_tags = []
    folder_str = "/".join(folder_tags[-3:]) if folder_tags else "(library root)"

    transcript = (row["transcript"] or "").strip()
    transcript_str = transcript if transcript else "(no speech detected)"

    duration = row["duration_seconds"] or 0.0
    lufs = row["loudness_lufs"]
    centroid = row["spectral_centroid_mean"]

    return (
        f"INPUT:\n"
        f"  Filename: {row['filename']}\n"
        f"  Folder: {folder_str}\n"
        f"  Duration: {duration:.1f}s\n"
        f"  Loudness: {lufs:.1f} LUFS ({_bucket_lufs(lufs)})\n"
        f"  Brightness: {centroid:.0f} Hz centroid ({_bucket_centroid(centroid)})\n"
        f"  Punchiness: {_punchiness_from_peaks(row['waveform_peaks'])}\n"
        f"  Transcript: {transcript_str}\n"
        f"\nOUTPUT:"
    )


# ---- Ollama call ----

def check_ollama_available(model: str = DEFAULT_MODEL, host: str = DEFAULT_HOST) -> tuple[bool, str]:
    """Return (ok, message). Verifies host is reachable and model is pulled."""
    try:
        client = ollama.Client(host=host)
        models = client.list()
    except Exception as e:
        return False, f"Cannot reach Ollama at {host}: {e}"

    names = []
    for m in models.get("models", []):
        # ollama lib has changed shape over versions; handle both
        name = m.get("model") or m.get("name") or ""
        names.append(name)
    if model not in names and not any(n.startswith(model.split(":")[0]) for n in names):
        return False, f"Model '{model}' not found in Ollama. Run: ollama pull {model}"
    return True, "ok"


def tag_row(row, model: str = DEFAULT_MODEL, host: str = DEFAULT_HOST) -> Optional[TagResult]:
    """Send one row to the LLM and parse the JSON result. Return None on failure."""
    user_prompt = _build_user_prompt(row)
    try:
        client = ollama.Client(host=host)
        resp = client.chat(
            model=model,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": user_prompt},
            ],
            format="json",
            options={"temperature": 0.3, "num_ctx": 4096, "num_predict": 512},
        )
    except Exception:
        return None

    content = resp.get("message", {}).get("content", "")
    try:
        data = json.loads(content)
    except json.JSONDecodeError:
        return None

    raw_tags = data.get("tags") or []
    raw_use_cases = data.get("use_cases") or []
    if not isinstance(raw_tags, list) or not isinstance(raw_use_cases, list):
        return None

    tags = []
    seen = set()
    for t in raw_tags:
        s = str(t).strip().lower()
        if s and s not in seen:
            seen.add(s)
            tags.append(s)

    use_cases = []
    seen_uc = set()
    for u in raw_use_cases:
        s = str(u).strip().lower()
        if s and s not in seen_uc:
            seen_uc.add(s)
            use_cases.append(s)

    return {
        "tags": tags,
        "category": str(data.get("category") or "other").strip().lower(),
        "mood": str(data.get("mood") or "").strip().lower(),
        "use_cases": use_cases,
    }
