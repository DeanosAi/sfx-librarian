"""Audio feature extraction via librosa + pyloudnorm."""
from __future__ import annotations

from pathlib import Path
from typing import Optional, TypedDict

import numpy as np


class FeatureResult(TypedDict):
    loudness_lufs: Optional[float]
    spectral_centroid_mean: Optional[float]
    waveform_peaks: list[float]


# Load audio at this rate. 22050 is plenty for SFX feature extraction
# and roughly 2x faster than loading at native rates.
TARGET_SR = 22050
N_PEAK_BUCKETS = 200


def extract_features(path: Path) -> Optional[FeatureResult]:
    """Load audio and compute LUFS, spectral centroid, normalized peaks.
    Returns None if the audio cannot be loaded."""
    import librosa
    import pyloudnorm as pyln

    try:
        y, sr = librosa.load(str(path), sr=TARGET_SR, mono=True)
    except Exception:
        return None

    if y.size == 0:
        return None

    # Integrated LUFS. For files shorter than ~400 ms, pyloudnorm's gating
    # may fail — fall back to peak dBFS in that case.
    lufs: Optional[float]
    try:
        meter = pyln.Meter(sr)
        lufs_val = float(meter.integrated_loudness(y))
        if not np.isfinite(lufs_val):
            raise ValueError("non-finite LUFS")
        lufs = lufs_val
    except Exception:
        peak = float(np.max(np.abs(y))) if y.size else 0.0
        lufs = float(20.0 * np.log10(peak)) if peak > 0 else -70.0

    # Spectral centroid — rough proxy for "bright vs dark"
    try:
        sc = librosa.feature.spectral_centroid(y=y, sr=sr)
        spectral_centroid_mean: Optional[float] = float(np.mean(sc))
    except Exception:
        spectral_centroid_mean = None

    # Waveform peaks: 200 buckets, normalized 0–1
    try:
        abs_y = np.abs(y)
        if abs_y.size >= N_PEAK_BUCKETS:
            chunks = np.array_split(abs_y, N_PEAK_BUCKETS)
            peaks = np.array([float(np.max(c)) if c.size else 0.0 for c in chunks])
        else:
            peaks = np.zeros(N_PEAK_BUCKETS)
            peaks[: abs_y.size] = abs_y
        peak_max = float(np.max(peaks))
        if peak_max > 0:
            peaks = peaks / peak_max
        waveform_peaks = [round(float(p), 4) for p in peaks]
    except Exception:
        waveform_peaks = [0.0] * N_PEAK_BUCKETS

    return {
        "loudness_lufs": lufs,
        "spectral_centroid_mean": spectral_centroid_mean,
        "waveform_peaks": waveform_peaks,
    }
