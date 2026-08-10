#!/usr/bin/env python3
"""
Kozum Cowork — icon pipeline.

Source art is a glowing blue emblem rendered on a solid black field. We key the
black to alpha using luminance (the glow falls off to black, so luminance *is*
the coverage signal), trim to content, pad to a square with breathing room, and
emit the full PNG ladder plus a multi-resolution Windows .ico.

Also emits a flat monochrome mark for the sidebar / composer, where a full
glow would fight the surrounding UI.
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

SRC = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("assets/logo-source.png")
OUT = Path(sys.argv[2]) if len(sys.argv) > 2 else Path("build")
RES = Path(sys.argv[3]) if len(sys.argv) > 3 else Path("resources/icons")

ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]
PNG_SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024]

ACCENT_PRIMARY = (0x3D, 0x7F, 0xFF)
ACCENT_SECONDARY = (0x00, 0xC8, 0xFF)


def key_black_to_alpha(im: Image.Image) -> Image.Image:
    """Convert a black-backed glow render to straight RGBA.

    Alpha comes from per-pixel max channel (luminance proxy). Colour is
    unpremultiplied against that alpha so the emblem keeps its saturation
    instead of washing grey where the glow is faint.
    """
    rgb = np.asarray(im.convert("RGB")).astype(np.float32) / 255.0
    alpha = rgb.max(axis=2)

    # Toe the ramp: crush sensor noise near black, keep the glow's soft falloff.
    alpha = np.clip((alpha - 0.045) / (1.0 - 0.045), 0.0, 1.0)
    # Slight gamma lift so the outer glow stays visible at small sizes.
    alpha = np.power(alpha, 0.85)

    safe = np.maximum(alpha, 1e-5)[..., None]
    colour = np.clip(rgb / safe, 0.0, 1.0)

    out = np.concatenate([colour, alpha[..., None]], axis=2)
    return Image.fromarray((out * 255.0 + 0.5).astype(np.uint8))


def trim_and_square(im: Image.Image, pad_ratio: float = 0.06) -> Image.Image:
    """Crop to visible content, then pad to a centred square."""
    alpha = np.asarray(im.split()[-1])
    ys, xs = np.where(alpha > 6)
    if len(xs) == 0:
        return im
    box = (int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1)
    im = im.crop(box)

    w, h = im.size
    side = int(max(w, h) * (1.0 + pad_ratio * 2))
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.paste(im, ((side - w) // 2, (side - h) // 2), im)
    return canvas


def _gradient(size: int) -> np.ndarray:
    """135deg accent gradient, matching --accent-gradient in the design system."""
    yy = np.linspace(0.0, 1.0, size)[:, None]
    xx = np.linspace(0.0, 1.0, size)[None, :]
    t = np.clip((xx + yy) / 2.0, 0.0, 1.0)
    grad = np.zeros((size, size, 3), dtype=np.float32)
    for c in range(3):
        grad[..., c] = (ACCENT_PRIMARY[c] * (1 - t) + ACCENT_SECONDARY[c] * t) / 255.0
    return grad


def flat_mark(size: int = 512) -> Image.Image:
    """Geometric redraw of the emblem for dense UI chrome.

    Deriving this from the raster does not work: the emblem body is dark navy
    and the halo is bright, so any luminance threshold traces the glow and
    yields a wireframe. Instead we reconstruct the two primitives that actually
    carry the identity -- the ring and the spear that pierces it -- so the mark
    stays legible down to 16px in the sidebar and composer.
    """
    ss = 8  # supersample factor; PIL has no analytic AA
    n = size * ss
    mask = Image.new("L", (n, n), 0)
    d = ImageDraw.Draw(mask)

    cx = cy = n / 2.0
    r_out = n * 0.365
    stroke = n * 0.105

    # Ring.
    d.ellipse(
        [cx - r_out, cy - r_out, cx + r_out, cy + r_out],
        outline=255,
        width=int(round(stroke)),
    )

    ang = np.deg2rad(45.0)
    ux, uy = np.cos(ang), np.sin(ang)      # along the shaft
    px, py = -uy, ux                       # perpendicular

    # Notch the ring where the spear enters, giving the "Q" its opening.
    # Must happen BEFORE the spear is laid down, otherwise it punches a hole
    # through the shaft and strands the tip as a floating fragment.
    gap = n * 0.085
    gx, gy = cx - ux * r_out, cy - uy * r_out
    d.ellipse([gx - gap, gy - gap, gx + gap, gy + gap], fill=0)

    # Spear: a slender needle, widest a third of the way down, piercing well
    # past the ring at both ends. The overshoot and the taper are what stop the
    # mark from reading as a "no entry" sign at 16px.
    half = n * 0.570
    waist = n * 0.044
    hx, hy = cx - ux * half, cy - uy * half   # upper-left point
    tx, ty = cx + ux * half, cy + uy * half   # lower-right point
    bx, by = cx - ux * (half * 0.22), cy - uy * (half * 0.22)  # widest station

    d.polygon(
        [
            (hx, hy),
            (bx + px * waist, by + py * waist),
            (tx, ty),
            (bx - px * waist, by - py * waist),
        ],
        fill=255,
    )

    # Fine companion edge, echoing the double blade in the source art.
    off = n * 0.060
    d.polygon(
        [
            (hx + px * off * 0.55, hy + py * off * 0.55),
            (bx + px * (off + n * 0.010), by + py * (off + n * 0.010)),
            (tx + px * off * 0.30, ty + py * off * 0.30),
            (bx + px * (off - n * 0.010), by + py * (off - n * 0.010)),
        ],
        fill=255,
    )

    alpha = np.asarray(mask.resize((size, size), Image.LANCZOS)).astype(np.float32) / 255.0
    out = np.concatenate([_gradient(size), alpha[..., None]], axis=2)
    return Image.fromarray((out * 255.0 + 0.5).astype(np.uint8))


def main() -> int:
    if not SRC.exists():
        print(f"error: source art not found at {SRC}", file=sys.stderr)
        return 1

    OUT.mkdir(parents=True, exist_ok=True)
    RES.mkdir(parents=True, exist_ok=True)

    src = Image.open(SRC)
    keyed = trim_and_square(key_black_to_alpha(src))
    master = keyed.resize((1024, 1024), Image.LANCZOS)

    master.save(OUT / "icon.png")
    master.save(RES / "logo-1024.png")

    for s in PNG_SIZES:
        master.resize((s, s), Image.LANCZOS).save(RES / f"logo-{s}.png")

    # Windows multi-resolution icon, consumed by electron-builder + NSIS.
    master.save(
        OUT / "icon.ico",
        format="ICO",
        sizes=[(s, s) for s in ICO_SIZES],
    )

    mark = flat_mark()
    mark.save(RES / "mark-512.png")
    for s in (16, 20, 24, 32, 64):
        mark.resize((s, s), Image.LANCZOS).save(RES / f"mark-{s}.png")

    # macOS/Linux courtesy output; harmless on a Windows-only build.
    master.resize((512, 512), Image.LANCZOS).save(OUT / "icon-512.png")

    print(f"master        {master.size}  -> {OUT/'icon.png'}")
    print(f"ico sizes     {ICO_SIZES} -> {OUT/'icon.ico'}")
    print(f"png ladder    {PNG_SIZES}")
    print(f"flat mark     -> {RES/'mark-512.png'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
