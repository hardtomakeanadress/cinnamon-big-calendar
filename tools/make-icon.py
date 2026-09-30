#!/usr/bin/env python3
"""Draw the desklet's icon.

Kept as a script rather than a binary so the image can be regenerated and
reviewed instead of being an opaque blob in the repository. Colours match the
desklet's defaults: the #303036 surface, the #1f9ede accent and #e1e1e1 text.

Usage: make-icon.py [output.png]   (default: icon.png, 48x48)
"""
import sys

from PIL import Image, ImageDraw

SIZE = 48
SCALE = 8          # supersample, then shrink, so the rounded corners are smooth

SURFACE = (48, 48, 54, 255)
ACCENT = (31, 158, 222, 255)
TEXT = (225, 225, 225, 255)
RING = (195, 195, 195, 255)


def draw(size):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    u = size / 48.0

    def box(x0, y0, x1, y1):
        return [x0 * u, y0 * u, x1 * u, y1 * u]

    radius = 7 * u

    # Body, then the header band over it with the top corners left round.
    d.rounded_rectangle(box(3, 9, 45, 45), radius=radius, fill=SURFACE)
    d.rounded_rectangle(box(3, 9, 45, 20), radius=radius, fill=ACCENT)
    d.rectangle(box(3, 15, 45, 20), fill=ACCENT)

    # Binder rings.
    d.rounded_rectangle(box(13, 5, 17, 13), radius=1.5 * u, fill=RING)
    d.rounded_rectangle(box(31, 5, 35, 13), radius=1.5 * u, fill=RING)

    # Six day cells, with one filled to read as today.
    for row in range(2):
        for col in range(3):
            x0 = 10 + col * 10.5
            y0 = 25 + row * 10.5
            filled = (row == 0 and col == 2)
            d.rounded_rectangle(
                box(x0, y0, x0 + 7, y0 + 7),
                radius=1.6 * u,
                fill=ACCENT if filled else TEXT,
            )
    return img


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else "icon.png"
    big = draw(SIZE * SCALE)
    big.resize((SIZE, SIZE), Image.LANCZOS).save(out)
    print("wrote " + out)


if __name__ == "__main__":
    main()
