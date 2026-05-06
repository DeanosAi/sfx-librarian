"""Whisper transcription. Model is loaded lazily and cached for the process."""
from __future__ import annotations

from pathlib import Path
from typing import Optional

_model = None
_loaded_name: Optional[str] = None
_has_cuda: Optional[bool] = None


def _cuda_available() -> bool:
    """Cache the result of torch.cuda.is_available() so we don't pay the import on every call."""
    global _has_cuda
    if _has_cuda is None:
        try:
            import torch
            _has_cuda = bool(torch.cuda.is_available())
        except ImportError:
            _has_cuda = False
    return _has_cuda


def get_model(name: str = "base"):
    global _model, _loaded_name
    if _model is None or _loaded_name != name:
        import whisper
        # whisper auto-detects CUDA; passing device explicitly is belt-and-braces.
        device = "cuda" if _cuda_available() else "cpu"
        _model = whisper.load_model(name, device=device)
        _loaded_name = name
    return _model


def transcribe_file(path: Path, model_name: str = "base") -> Optional[str]:
    """Run Whisper on a file. Returns transcript text (possibly empty for non-speech).
    Returns None only if Whisper raises — in which case the caller should log + skip."""
    try:
        model = get_model(model_name)
        result = model.transcribe(
            str(path),
            fp16=_cuda_available(),  # fp16 is faster on GPU, must be False on CPU
            verbose=False,
            language="en",
            no_speech_threshold=0.6,
            condition_on_previous_text=False,
        )
    except Exception:
        return None

    text = (result.get("text") or "").strip()
    return text
