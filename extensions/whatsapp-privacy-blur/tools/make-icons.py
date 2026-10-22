"""Draws the extension icons (a green chat bubble with a crossed-out eye).

Run from this folder:  python3 make-icons.py   (needs Pillow)
"""
from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "extension" / "icons"
GREEN = (37, 211, 102, 255)
WHITE = (255, 255, 255, 255)
S = 512  # draw large, then scale down


def draw() -> Image.Image:
    im = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    # bubble + tail
    d.ellipse((32, 32, 480, 480), fill=GREEN)
    d.polygon([(70, 470), (60, 340), (180, 430)], fill=GREEN)
    # eye outline (two arcs)
    w = 30
    d.arc((110, 150, 402, 420), 200, 340, fill=WHITE, width=w)
    d.arc((110, 92, 402, 362), 20, 160, fill=WHITE, width=w)
    # pupil
    d.ellipse((206, 206, 306, 306), fill=WHITE)
    # slash, with a green gap on each side so it reads at 16px
    d.line((140, 140, 372, 372), fill=GREEN, width=w + 28)
    d.line((140, 140, 372, 372), fill=WHITE, width=w)
    return im


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    big = draw()
    for size in (16, 32, 48, 128):
        big.resize((size, size), Image.LANCZOS).save(OUT / f"icon-{size}.png", optimize=True)


if __name__ == "__main__":
    main()
