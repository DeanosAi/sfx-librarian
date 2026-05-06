"""Generate a small PNG icon for the SFX Librarian UXP panel manifest.

Run: .venv\\Scripts\\python.exe make_icon.py
Output: panel/icons/icon-48.png and panel/icons/icon-48@2x.png
"""
import struct
import zlib
from pathlib import Path


def png(width: int, height: int, pixels: list[tuple[int, int, int, int]]) -> bytes:
    """Build a PNG from a flat list of (R,G,B,A) tuples, length = w*h."""
    assert len(pixels) == width * height
    raw = bytearray()
    for y in range(height):
        raw.append(0)  # filter type none
        for x in range(width):
            r, g, b, a = pixels[y * width + x]
            raw.extend((r, g, b, a))

    def chunk(typ: bytes, data: bytes) -> bytes:
        crc = zlib.crc32(typ + data) & 0xFFFFFFFF
        return struct.pack(">I", len(data)) + typ + data + struct.pack(">I", crc)

    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    idat = zlib.compress(bytes(raw), 9)
    return sig + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b"")


def make(size: int) -> bytes:
    """Blue rounded-square icon with three white waveform bars on it."""
    pixels: list[tuple[int, int, int, int]] = []
    for y in range(size):
        for x in range(size):
            # Rounded square: alpha decays at the corners
            margin = max(0, size - 2 * max(abs(x - size / 2), abs(y - size / 2)))
            corner_softness = size * 0.18
            corner_dx = max(0, abs(x - size / 2) - (size / 2 - corner_softness))
            corner_dy = max(0, abs(y - size / 2) - (size / 2 - corner_softness))
            corner_dist = (corner_dx ** 2 + corner_dy ** 2) ** 0.5
            if corner_dist > corner_softness:
                pixels.append((0, 0, 0, 0))
                continue
            alpha = 255 if corner_dist < corner_softness * 0.85 else int(
                255 * (1 - (corner_dist - corner_softness * 0.85) / (corner_softness * 0.15))
            )

            # Background gradient (Adobe-ish blue)
            t = y / size
            r = int(30 + t * 10)
            g = int(110 + t * 20)
            b = int(220 - t * 30)

            # Three vertical "waveform" bars in white
            bar_w = size * 0.10
            cx = size / 2
            mid_y = size / 2
            for i, h_frac in enumerate([0.45, 0.65, 0.40]):
                bar_cx = cx + (i - 1) * size * 0.18
                if abs(x - bar_cx) < bar_w / 2:
                    half_h = (size * h_frac) / 2
                    if abs(y - mid_y) < half_h:
                        r, g, b = 255, 255, 255

            pixels.append((r, g, b, alpha))
    return png(size, size, pixels)


def main() -> None:
    out = Path(__file__).parent / "panel" / "icons"
    out.mkdir(parents=True, exist_ok=True)

    (out / "icon-48.png").write_bytes(make(48))
    (out / "icon-48@2x.png").write_bytes(make(96))
    print(f"Wrote: {out / 'icon-48.png'}")
    print(f"Wrote: {out / 'icon-48@2x.png'}")


if __name__ == "__main__":
    main()
