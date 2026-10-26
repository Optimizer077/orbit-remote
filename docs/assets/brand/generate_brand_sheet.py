"""Rebuild the brand review sheet from the current checked-in native assets.

Requirements: python -m pip install Pillow PyMuPDF
Run from any directory: python docs/assets/brand/generate_brand_sheet.py
This script writes only brand-sheet.png. It never rebuilds application icons.
"""

from io import BytesIO
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont
import pymupdf

BRAND = Path(__file__).resolve().parent
ROOT = BRAND.parents[2]
ICONS = ROOT / "apps/desktop/build/icons"


def font(size, bold=False):
    candidates = [
        "C:/Windows/Fonts/segoeuib.ttf" if bold else "C:/Windows/Fonts/segoeui.ttf",
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf" if bold else "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ]
    for candidate in candidates:
        if Path(candidate).is_file():
            return ImageFont.truetype(candidate, size)
    return ImageFont.load_default(size=size)


canvas = Image.new("RGB", (1600, 1140), "#0b1113")
draw = ImageDraw.Draw(canvas)
body, small, heading, sub = font(19), font(16), font(32, True), font(20, True)


def text(x, y, value, fill="#c7d5bd", face=body):
    draw.text((x, y), value, font=face, fill=fill)


def vector_image(name, width):
    with pymupdf.open(BRAND / name) as document:
        page = document[0]
        scale = width / page.rect.width
        pixmap = page.get_pixmap(matrix=pymupdf.Matrix(scale, scale), alpha=True)
        return Image.open(BytesIO(pixmap.tobytes("png"))).convert("RGBA")


def paste(image, xy):
    canvas.paste(image, xy, image)


text(54, 36, "ORBIT REMOTE", "#eef2fb", heading)
text(56, 86, "Original identity / native asset review", "#9aa98f")
app = Image.open(ICONS / "icon.png").convert("RGBA")
paste(app.resize((240, 240), Image.Resampling.LANCZOS), (58, 144))
paste(vector_image("logo.svg", 650), (366, 151))
text(371, 350, "Geometric vector wordmark. No embedded fonts or stock art.", "#9aa98f")
text(1130, 160, "NATIVE APPLICATION", face=sub)
for y, label in [(203, "PNG / Windows ICO / macOS ICNS"), (239, "1024px master with alpha"),
                 (275, "Fixed mint + deep navy app tile"), (311, "OS adapts the monochrome tray")]:
    text(1130, y, label)

themes = [
    ("ORBIT", "logo.svg", "#101616", "#eceee7", "#b2e6c5"),
    ("MIDNIGHT", "logo-midnight.svg", "#101521", "#eef2fb", "#aecaff"),
    ("PAPER", "logo-light.svg", "#f4f3ee", "#243329", "#286647"),
]
for index, (name, logo, background, foreground, accent) in enumerate(themes):
    x = 54 + index * 506
    draw.rounded_rectangle((x, 415, x + 480, 695), radius=18, fill=background, outline="#33433c")
    text(x + 24, 433, name, foreground, sub)
    paste(vector_image(logo, 415), (x + 20, 477))
    for position, (color, label) in enumerate([(background, "Background"), (foreground, "Text"), (accent, "Accent")]):
        xx = x + 25 + position * 148
        draw.rounded_rectangle((xx, 625, xx + 23, 648), radius=5, fill=color, outline=accent)
        text(xx + 32, 625, label, foreground, small)
        text(xx, 662, color, foreground, small)

text(56, 727, "ACTUAL ICO REPRESENTATIONS", "#eef2fb", sub)
ico = Image.open(ICONS / "icon.ico")
x = 69
for size, step in [(128, 185), (64, 125), (48, 110), (32, 100), (24, 90), (16, 85)]:
    paste(ico.ico.getimage((size, size)).convert("RGBA"), (x, 792 + (128 - size) // 2))
    text(x, 939, f"{size}px", face=small)
    x += step
text(935, 727, "NATIVE TRAY ASSETS", "#eef2fb", sub)
paste(Image.open(ICONS / "tray.png").convert("RGBA"), (960, 821))
paste(Image.open(ICONS / "tray@2x.png").convert("RGBA"), (1056, 805))
text(947, 895, "32px", face=small)
text(1061, 895, "64px", face=small)
draw.rounded_rectangle((1170, 789, 1282, 872), radius=12, fill="#f4f3ee")
paste(Image.open(ICONS / "trayTemplate@2x.png").convert("RGBA"), (1194, 799))
text(1160, 895, "macOS template", face=small)
text(55, 1000, "Review: one recognisable orbital motif across native formats and all three theme palettes.", "#eef2fb")
text(55, 1037, "Renderer and native assets share the canonical circle, ellipse, core, and satellite geometry.", "#9aa98f", small)
text(55, 1070, "Security comes from identity, permissions, encryption, and release checks; the logo does not certify security.", "#9aa98f", small)
output = BRAND / "brand-sheet.png"
canvas.save(output)
print(f"Updated {output}")
