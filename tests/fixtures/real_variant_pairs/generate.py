#!/usr/bin/env python3
"""Deterministically render the distributable real-variant regression images."""

from __future__ import annotations

import argparse
import hashlib
import json
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw


SIZE = 512
IMAGE_NAMES = (
    "recolored-sketch-a.png",
    "recolored-sketch-b.png",
    "structure-color.png",
    "structure-gray.png",
)

_BASE_PALETTE = {
    "bg": "#fff8e7",
    "ink": "#18212d",
    "sun": "#f5b642",
    "cloud": "#dbeeff",
    "mount1": "#779b6b",
    "mount2": "#657c9b",
    "snow": "#f7f3eb",
    "ground": "#9bc36b",
    "river": "#5bb9d4",
    "house": "#ef8b65",
    "roof": "#7e3b3b",
    "door": "#765035",
    "window": "#ffe178",
    "trunk": "#68452f",
    "tree": "#2d7048",
}
_RECOLORED_PALETTE = {
    **_BASE_PALETTE,
    "sun": "#00ffff",
    "cloud": "#ff66cc",
    "mount1": "#ff3333",
    "mount2": "#3344ff",
    "ground": "#bb22dd",
    "river": "#00ff66",
    "house": "#ff0066",
    "roof": "#00aaff",
    "door": "#ffdd00",
    "window": "#00ffff",
    "trunk": "#ff8800",
    "tree": "#6633ff",
}
_DARK_PALETTE = {
    "bg": "#18212d",
    "ink": "#f5f1e8",
    "sun": "#845ec2",
    "cloud": "#ff9671",
    "mount1": "#d65db1",
    "mount2": "#008f7a",
    "snow": "#ffc75f",
    "ground": "#4b4453",
    "river": "#00c9a7",
    "house": "#c34a36",
    "roof": "#2c73d2",
    "door": "#f9f871",
    "window": "#ff6f91",
    "trunk": "#b0a8b9",
    "tree": "#00896f",
}


def _render(palette: dict[str, str], *, grayscale: bool, landmarks: bool) -> Image.Image:
    scale = 2
    image = Image.new("RGB", (SIZE * scale, SIZE * scale), palette["bg"])
    draw = ImageDraw.Draw(image)

    def polygon(points, fill, *, width=8):
        draw.polygon(
            [(x * scale, y * scale) for x, y in points],
            fill=fill,
            outline=palette["ink"],
            width=width * scale,
        )

    def ellipse(box, fill, *, width=8):
        draw.ellipse(
            tuple(value * scale for value in box),
            fill=fill,
            outline=palette["ink"],
            width=width * scale,
        )

    def rectangle(box, fill, *, width=8, radius=0):
        draw.rounded_rectangle(
            tuple(value * scale for value in box),
            radius=radius * scale,
            fill=fill,
            outline=palette["ink"],
            width=width * scale,
        )

    draw.rectangle(
        (20 * scale, 20 * scale, 492 * scale, 492 * scale),
        outline=palette["ink"],
        width=10 * scale,
    )
    ellipse((55, 55, 165, 165), palette["sun"])
    for box in ((275, 72, 370, 130), (330, 58, 438, 132), (245, 94, 420, 150)):
        ellipse(box, palette["cloud"], width=5)

    polygon(((25, 340), (150, 175), (260, 340)), palette["mount1"])
    polygon(((170, 340), (315, 145), (487, 340)), palette["mount2"])
    polygon(
        ((258, 221), (315, 145), (370, 211), (340, 205), (315, 230), (291, 205)),
        palette["snow"],
        width=4,
    )
    polygon(((24, 335), (488, 335), (488, 488), (24, 488)), palette["ground"], width=6)
    polygon(
        ((235, 488), (287, 488), (310, 420), (292, 363), (263, 340), (239, 371), (258, 420)),
        palette["river"],
        width=5,
    )

    rectangle((70, 322, 190, 432), palette["house"], radius=5)
    polygon(((55, 325), (130, 260), (207, 325)), palette["roof"])
    rectangle((116, 365, 151, 432), palette["door"], width=5)
    rectangle((82, 345, 110, 375), palette["window"], width=4)
    rectangle((156, 345, 183, 375), palette["window"], width=4)

    for x, y, height in ((365, 326, 120), (425, 347, 95), (42, 365, 80)):
        rectangle((x - 8, y, x + 8, y + height), palette["trunk"], width=3)
        polygon(((x - 45, y + 25), (x, y - 58), (x + 45, y + 25)), palette["tree"], width=5)
        polygon(((x - 38, y + 2), (x, y - 75), (x + 38, y + 2)), palette["tree"], width=5)

    for x, y in ((205, 90), (220, 105), (190, 120)):
        draw.arc(
            ((x - 16) * scale, (y - 8) * scale, x * scale, (y + 8) * scale),
            190,
            350,
            fill=palette["ink"],
            width=4 * scale,
        )
        draw.arc(
            (x * scale, (y - 8) * scale, (x + 16) * scale, (y + 8) * scale),
            190,
            350,
            fill=palette["ink"],
            width=4 * scale,
        )

    if landmarks:
        positions = (
            (45, 45),
            (205, 45),
            (455, 45),
            (45, 210),
            (455, 210),
            (45, 455),
            (205, 455),
            (455, 455),
            (250, 255),
            (400, 255),
        )
        for index, (x, y) in enumerate(positions):
            draw.rectangle(
                ((x - 13) * scale, (y - 13) * scale, (x + 13) * scale, (y + 13) * scale),
                fill="#ffffff",
                outline="#000000",
                width=3 * scale,
            )
            if index % 3 == 0:
                draw.line(
                    ((x - 8) * scale, (y - 8) * scale, (x + 8) * scale, (y + 8) * scale),
                    fill="#000000",
                    width=3 * scale,
                )
            elif index % 3 == 1:
                draw.ellipse(
                    ((x - 7) * scale, (y - 7) * scale, (x + 7) * scale, (y + 7) * scale),
                    outline="#000000",
                    width=3 * scale,
                )
            else:
                draw.line(
                    ((x - 8) * scale, y * scale, (x + 8) * scale, y * scale),
                    fill="#000000",
                    width=3 * scale,
                )
                draw.line(
                    (x * scale, (y - 8) * scale, x * scale, (y + 8) * scale),
                    fill="#000000",
                    width=3 * scale,
                )

        # An asymmetric, exact black/white registration target gives the
        # structural pair a platform-stable SIFT geometry signal without
        # making the surrounding color and luminance variants identical.
        target_left, target_top, cell = 206, 196, 9
        draw.rectangle(
            (
                (target_left - 5) * scale,
                (target_top - 5) * scale,
                (target_left + 9 * cell + 5) * scale,
                (target_top + 9 * cell + 5) * scale,
            ),
            fill="#ffffff",
            outline="#000000",
            width=3 * scale,
        )
        for row in range(9):
            for column in range(9):
                if (row * 17 + column * 31 + row * column * 7) % 11 < 5:
                    x0 = (target_left + column * cell) * scale
                    y0 = (target_top + row * cell) * scale
                    draw.rectangle(
                        (x0, y0, x0 + cell * scale, y0 + cell * scale),
                        fill="#000000",
                    )

    image = image.resize((SIZE, SIZE), Image.Resampling.LANCZOS)
    if grayscale:
        image = image.convert("L").convert("RGB")
    return image


def render_fixtures(output: Path) -> None:
    output.mkdir(parents=True, exist_ok=True)
    specifications = {
        "recolored-sketch-a.png": (_BASE_PALETTE, False, False),
        "recolored-sketch-b.png": (_RECOLORED_PALETTE, False, False),
        "structure-color.png": (_DARK_PALETTE, False, True),
        "structure-gray.png": (_BASE_PALETTE, True, True),
    }
    for name, (palette, grayscale, landmarks) in specifications.items():
        _render(palette, grayscale=grayscale, landmarks=landmarks).save(
            output / name,
            format="PNG",
            optimize=True,
        )


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def check_fixtures(destination: Path) -> None:
    manifest = json.loads((destination / "manifest.json").read_text(encoding="utf-8"))
    expected = manifest["files"]
    with tempfile.TemporaryDirectory() as temporary:
        generated = Path(temporary)
        render_fixtures(generated)
        for name in IMAGE_NAMES:
            actual_hash = sha256(generated / name)
            if actual_hash != expected[name]["sha256"]:
                raise SystemExit(
                    f"fixture regeneration mismatch for {name}: "
                    f"expected {expected[name]['sha256']}, got {actual_hash}"
                )
    print("real-variant fixture generation is reproducible")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parent)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    if args.check:
        check_fixtures(args.output)
    else:
        render_fixtures(args.output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
