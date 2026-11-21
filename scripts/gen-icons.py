"""Rebuild every extension icon from the brand mark artwork.

`assets/logo/source.png` is the supplied artwork (the three-blade mark on a
white background, ~957x1643). The background is keyed out — edge pixels are
un-premultiplied against white so no light fringe survives — and the mark is
centred on a square canvas, then resampled straight down to each icon size.

Usage:
    python scripts/gen-icons.py            # rewrite all icons
    python scripts/gen-icons.py --preview  # also write a PNG preview sheet to /tmp
"""
from __future__ import annotations

import sys
import tempfile
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "assets/logo/source.png"
SIZES = (16, 24, 32, 48, 96, 128)
MARGIN = 0.055          # padding around the mark inside the square canvas
WORK = 2048             # canvas size before downsampling to the icon sizes
KEY_LO = 244.0          # min-channel below this is definitely mark (opaque)
KEY_HI = 252.0          # min-channel above this is definitely background
MIN_ALPHA = 0.05        # kill haze below this


def keyed(source: Image.Image) -> Image.Image:
    """Cut the white background out, keeping clean edge colours."""
    im = source.convert("RGB")
    w, h = im.size
    px = im.load()
    out = Image.new("RGBA", (w, h))
    dst = out.load()
    for y in range(h):
        for x in range(w):
            r, g, b = px[x, y]
            m = min(r, g, b)
            if m >= KEY_HI:
                continue
            if m <= KEY_LO:
                dst[x, y] = (r, g, b, 255)
                continue
            a = (KEY_HI - m) / (KEY_HI - KEY_LO)
            if a < MIN_ALPHA:
                continue
            # un-premultiply against white so AA edges keep their true colour
            dst[x, y] = (
                int(round(min(255.0, max(0.0, (r - 255.0 * (1 - a)) / a)))),
                int(round(min(255.0, max(0.0, (g - 255.0 * (1 - a)) / a)))),
                int(round(min(255.0, max(0.0, (b - 255.0 * (1 - a)) / a)))),
                int(round(a * 255)),
            )
    return out


def squared(mark: Image.Image) -> Image.Image:
    bbox = mark.getchannel("A").point(lambda v: 255 if v > 24 else 0).getbbox()
    mark = mark.crop(bbox)
    span = max(mark.size) * (1 + 2 * MARGIN)
    scale = WORK / span
    w, h = int(round(mark.width * scale)), int(round(mark.height * scale))
    resized = mark.resize((w, h), Image.LANCZOS)
    canvas = Image.new("RGBA", (WORK, WORK), (0, 0, 0, 0))
    canvas.paste(resized, ((WORK - w) // 2, (WORK - h) // 2), resized)
    return canvas


def greyed(im: Image.Image) -> Image.Image:
    """Inactive artwork: luminance mapped into the 88-210 grey ramp."""
    out = im.copy()
    px = out.load()
    for y in range(out.height):
        for x in range(out.width):
            r, g, b, a = px[x, y]
            if a == 0:
                continue
            lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
            v = int(round(88 + (lum / 255.0) * (210 - 88)))
            px[x, y] = (v, v, v, a)
    return out


def main() -> None:
    mark = keyed(Image.open(SRC))
    canvas = squared(mark)
    grey = greyed(canvas)

    canvas.resize((512, 512), Image.LANCZOS).save(
        ROOT / "assets/logo/mark.png", optimize=True
    )
    for size in SIZES:
        canvas.resize((size, size), Image.LANCZOS).save(
            ROOT / f"public/icon/{size}.png", optimize=True
        )
        grey.resize((size, size), Image.LANCZOS).save(
            ROOT / f"public/icon/inactive/{size}.png", optimize=True
        )
    print(f"wrote {len(SIZES) * 2} icons + assets/logo/mark.png")

    if "--preview" in sys.argv:
        sheet = Image.new("RGB", (760, 320), (30, 32, 36))
        x = 24
        for size in SIZES:
            for row, sub in enumerate(("public/icon", "public/icon/inactive")):
                icon = Image.open(ROOT / sub / f"{size}.png").convert("RGBA")
                sheet.paste(icon, (x, 40 + row * 140), icon)
            x += size + 44
        path = Path(tempfile.gettempdir()) / "suxie-icons-preview.png"
        sheet.save(path)
        print("preview:", path)


if __name__ == "__main__":
    main()
