from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[1]
BRAND_ASSETS = ROOT / "assets" / "brand"
SITE_PUBLIC = ROOT / "site" / "public"
WORKSPACE_APP = ROOT / "workspace-cloud" / "app"
TAURI_ICONS = ROOT / "src-tauri" / "icons"
SOURCE_SIZE = 2048

ICON_BACKGROUND = "#151a16"
ICON_FOREGROUND = "#ccf36b"

ICON_SVG = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28" role="img" aria-label="DopeDB">
  <rect width="28" height="28" rx="6.125" fill="{ICON_BACKGROUND}"/>
  <path d="M4 6.5h11.25c5.1 0 8.75 3.28 8.75 7.5s-3.65 7.5-8.75 7.5H4V6.5Z" fill="none" stroke="{ICON_FOREGROUND}" stroke-width="1.5"/>
  <path d="M4 11h12M4 16h9" fill="none" stroke="{ICON_FOREGROUND}" stroke-width="1.5"/>
  <circle cx="20.5" cy="18.5" r="2.25" fill="{ICON_FOREGROUND}"/>
</svg>
"""


def rounded_mask(size: int, radius: int) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size, size), radius=radius, fill=255)
    return mask


def cubic_points(
    start: tuple[float, float],
    control_a: tuple[float, float],
    control_b: tuple[float, float],
    end: tuple[float, float],
    steps: int = 96,
) -> list[tuple[float, float]]:
    points: list[tuple[float, float]] = []
    for index in range(steps + 1):
        t = index / steps
        inverse = 1 - t
        x = (
            inverse**3 * start[0]
            + 3 * inverse**2 * t * control_a[0]
            + 3 * inverse * t**2 * control_b[0]
            + t**3 * end[0]
        )
        y = (
            inverse**3 * start[1]
            + 3 * inverse**2 * t * control_a[1]
            + 3 * inverse * t**2 * control_b[1]
            + t**3 * end[1]
        )
        points.append((x, y))
    return points


def render_icon() -> Image.Image:
    scale = SOURCE_SIZE / 28
    tile = Image.new("RGBA", (SOURCE_SIZE, SOURCE_SIZE), ICON_BACKGROUND)
    draw = ImageDraw.Draw(tile)
    stroke = round(1.5 * scale)

    def point(value: tuple[float, float]) -> tuple[float, float]:
        return value[0] * scale, value[1] * scale

    outline = [point((4, 6.5)), point((15.25, 6.5))]
    outline.extend(
        point(value)
        for value in cubic_points((15.25, 6.5), (20.35, 6.5), (24, 9.78), (24, 14))[1:]
    )
    outline.extend(
        point(value)
        for value in cubic_points((24, 14), (24, 18.22), (20.35, 21.5), (15.25, 21.5))[1:]
    )
    outline.extend([point((4, 21.5)), point((4, 6.5))])
    draw.line(outline, fill=ICON_FOREGROUND, width=stroke)
    stroke_radius = stroke / 2
    for x, y in outline:
        draw.ellipse(
            (x - stroke_radius, y - stroke_radius, x + stroke_radius, y + stroke_radius),
            fill=ICON_FOREGROUND,
        )
    draw.line([point((4, 11)), point((16, 11))], fill=ICON_FOREGROUND, width=stroke)
    draw.line([point((4, 16)), point((13, 16))], fill=ICON_FOREGROUND, width=stroke)

    dot_x, dot_y = point((20.5, 18.5))
    dot_radius = 2.25 * scale
    draw.ellipse(
        (
            dot_x - dot_radius,
            dot_y - dot_radius,
            dot_x + dot_radius,
            dot_y + dot_radius,
        ),
        fill=ICON_FOREGROUND,
    )

    tile.putalpha(rounded_mask(SOURCE_SIZE, round(6.125 * scale)))
    return tile.resize((1024, 1024), Image.Resampling.LANCZOS)


def save_png(source: Image.Image, path: Path, size: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    source.resize((size, size), Image.Resampling.LANCZOS).save(path)


def save_ico(source: Image.Image, path: Path, sizes: list[tuple[int, int]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    source.save(path, sizes=sizes)


def generate_icns(source: Image.Image) -> None:
    iconset = TAURI_ICONS / "icon.iconset"
    if iconset.exists():
        shutil.rmtree(iconset)
    iconset.mkdir(parents=True)
    specs = {
        "icon_16x16.png": 16,
        "icon_16x16@2x.png": 32,
        "icon_32x32.png": 32,
        "icon_32x32@2x.png": 64,
        "icon_128x128.png": 128,
        "icon_128x128@2x.png": 256,
        "icon_256x256.png": 256,
        "icon_256x256@2x.png": 512,
        "icon_512x512.png": 512,
        "icon_512x512@2x.png": 1024,
    }
    for name, size in specs.items():
        save_png(source, iconset / name, size)
    subprocess.run(
        ["iconutil", "-c", "icns", str(iconset), "-o", str(TAURI_ICONS / "icon.icns")],
        check=True,
    )
    shutil.rmtree(iconset)


def write_svg_assets() -> None:
    for path in (
        BRAND_ASSETS / "dopedb-icon.svg",
        SITE_PUBLIC / "favicon.svg",
        WORKSPACE_APP / "icon.svg",
    ):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(ICON_SVG, encoding="utf-8")


def main() -> None:
    source = render_icon()
    write_svg_assets()

    save_png(source, TAURI_ICONS / "icon.png", 1024)
    save_png(source, TAURI_ICONS / "32x32.png", 32)
    save_png(source, TAURI_ICONS / "128x128.png", 128)
    save_png(source, TAURI_ICONS / "128x128@2x.png", 256)
    save_ico(
        source,
        TAURI_ICONS / "icon.ico",
        [(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )
    generate_icns(source)

    save_png(source, SITE_PUBLIC / "favicon-48x48.png", 48)
    save_png(source, SITE_PUBLIC / "apple-touch-icon.png", 180)
    save_png(source, SITE_PUBLIC / "icon-192.png", 192)
    save_png(source, SITE_PUBLIC / "icon-512.png", 512)
    save_png(source, SITE_PUBLIC / "oauth-logo-120.png", 120)
    save_ico(
        source,
        SITE_PUBLIC / "favicon.ico",
        [(16, 16), (32, 32), (48, 48), (64, 64)],
    )

    save_png(source, WORKSPACE_APP / "apple-icon.png", 180)
    save_ico(
        source,
        WORKSPACE_APP / "favicon.ico",
        [(16, 16), (32, 32), (48, 48), (64, 64)],
    )

    print("generated DopeDB D-mark app and web icons")


if __name__ == "__main__":
    main()
