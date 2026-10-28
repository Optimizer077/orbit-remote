"""Rebuild Orbit's original vector and native app icons using Pillow.

Run from the repository root: python docs/assets/brand/generate_brand.py
The mark and wordmark are drawn from original geometry; no font or stock asset
is embedded. SVG is canonical; this raster implementation mirrors its geometry.
"""

from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[3]
BRAND = Path(__file__).resolve().parent
ICONS = ROOT / "apps" / "desktop" / "build" / "icons"
ICONS.mkdir(parents=True, exist_ok=True)

# Colours come from the Daylight and Graphite theme tokens in apps/desktop/renderer/src/styles.css.
TEAL = "#2dd4bf"       # Daylight sidebar accent: the mark on dark and navy surfaces
TEAL_DEEP = "#008577"  # Daylight accent: the mark on light surfaces
NAVY = "#0b1d3a"       # Daylight sidebar: app tile top, wordmark ink on light surfaces
NAVY_DEEP = "#070b14"  # Graphite sidebar: app tile bottom
PAPER = "#f4f7fb"      # Graphite text: wordmark ink on dark surfaces
INK = NAVY
BLUE = "#aecaff"       # Midnight variant


def motif(color=TEAL, stroke=25):
    return f'''<g fill="none" stroke="{color}" stroke-width="{stroke}">
    <circle cx="512" cy="512" r="220"/>
    <ellipse cx="512" cy="512" rx="330" ry="122" transform="rotate(-32 512 512)"/>
  </g>
  <circle cx="512" cy="512" r="65" fill="{color}"/>
  <circle cx="791.86" cy="337.13" r="34" fill="{color}"/>'''


def svg(content, viewbox, title):
    text = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="{viewbox}" role="img" aria-labelledby="title">
  <title id="title">{title}</title>
  {content}
</svg>
'''
    return "\n".join(line.rstrip() for line in text.split("\n"))


def write(path, text):
    # LF on every platform, matching .gitattributes.
    path.write_text(text, encoding="utf-8", newline="\n")


app_svg = svg(f'''<defs>
    <linearGradient id="surface" x1="0" y1="0" x2="0" y2="1">
      <stop stop-color="{NAVY}"/><stop offset="1" stop-color="{NAVY_DEEP}"/>
    </linearGradient>
  </defs>
  <rect x="48" y="48" width="928" height="928" rx="222" fill="url(#surface)"/>
  ''' + motif(), "0 0 1024 1024", "Orbit Remote app icon")
write(ICONS / "icon.svg", app_svg)
write(BRAND / "icon.svg", app_svg)

# Original geometric lowercase wordmark: orbit. No font is redistributed.
word_paths = '''<circle cx="220" cy="70" r="29"/>
    <path d="M278 100V42M278 66C278 48 292 40 310 42"/>
    <path d="M335 17V100M335 70C335 31 394 31 394 70C394 109 335 109 335 70Z"/>
    <path d="M423 43V100M461 22V82Q461 101 480 101H491M445 43H492"/>'''
remote_paths = '''M190 141V124H197Q202 124 202 129Q202 133 197 133H190M197 133L203 141
    M218 141H208V124H218M208 132H216
    M224 141V124L232 135L240 124V141
    M255 124C245 124 245 141 255 141C265 141 265 124 255 124Z
    M268 124H282M275 124V141
    M298 141H288V124H298M288 132H296'''


def logo(ink, accent):
    return svg(f'''<g transform="translate(-6 -6) scale(.167)">{motif(accent, 23)}</g>
  <g fill="none" stroke="{ink}" stroke-width="8" stroke-linecap="round" stroke-linejoin="round">
    {word_paths}
  </g>
  <circle cx="423" cy="21" r="5" fill="{ink}"/>
  <circle cx="518" cy="96" r="6" fill="{accent}"/>
  <path d="{remote_paths}" fill="none" stroke="{ink}" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>
  ''', "0 0 550 160", "Orbit Remote")


for filename, ink, accent in [("logo.svg", PAPER, TEAL), ("logo-dark.svg", PAPER, TEAL), ("logo-light.svg", INK, TEAL_DEEP), ("logo-midnight.svg", PAPER, BLUE)]:
    write(BRAND / filename, logo(ink, accent))
for filename, color in [("mark.svg", TEAL), ("mark-light.svg", TEAL_DEEP), ("mark-midnight.svg", BLUE)]:
    write(BRAND / filename, svg(motif(color), "140 140 744 744", "Orbit Remote orbital mark"))


def rgb(value):
    return tuple(int(value[i:i + 2], 16) for i in (1, 3, 5))


def surface(image, scale, rim=0):
    length = image.width
    mask = Image.new("L", (length, length))
    ImageDraw.Draw(mask).rounded_rectangle([48 * scale, 48 * scale, 976 * scale, 976 * scale], radius=222 * scale, fill=255)
    gradient = Image.new("RGBA", (length, length))
    rows = []
    start, end = rgb(NAVY), rgb(NAVY_DEEP)
    for y in range(length):
        t = y / max(1, length - 1)
        rows.extend([tuple(round(a + (b - a) * t) for a, b in zip(start, end)) + (255,)] * length)
    gradient.putdata(rows)
    image.paste(gradient, (0, 0), mask)
    if rim:
        # A faint teal edge keeps the dark tile visible on dark taskbars.
        ImageDraw.Draw(image).rounded_rectangle([48 * scale, 48 * scale, 976 * scale, 976 * scale], radius=222 * scale,
                                                outline=rgb(TEAL) + (70,), width=max(1, round(rim)))


def raster(size=1024, background=True, color=TEAL):
    # Supersampling keeps the geometric strokes and round corners crisp; optical() handles <= 48px.
    factor = 3 if size >= 512 else 4
    length = size * factor
    scale = length / 1024
    image = Image.new("RGBA", (length, length))
    if background:
        surface(image, scale)
    draw = ImageDraw.Draw(image)
    c = rgb(color) + (255,)
    width = max(1, round(25 * scale))
    draw.ellipse([279.5 * scale, 279.5 * scale, 744.5 * scale, 744.5 * scale], outline=c, width=width)
    ring = Image.new("RGBA", (length, length))
    ImageDraw.Draw(ring).ellipse([169.5 * scale, 377.5 * scale, 854.5 * scale, 646.5 * scale], outline=c, width=width)
    ring = ring.rotate(32, resample=Image.Resampling.BICUBIC)
    image.alpha_composite(ring)
    draw = ImageDraw.Draw(image)
    draw.ellipse([447 * scale, 447 * scale, 577 * scale, 577 * scale], fill=c)
    draw.ellipse([(791.86 - 34) * scale, (337.13 - 34) * scale, (791.86 + 34) * scale, (337.13 + 34) * scale], fill=c)
    return image.resize((size, size), Image.Resampling.LANCZOS)


# Downscaling the 1024px master turns the 25-unit stroke into 0.39px at 16px. Small sizes
# are drawn for their pixel grid instead: stroke in target pixels, centre-node radius, inner
# circle, satellite. 16px keeps only the orbit and node, the shapes that survive at that size.
OPTICAL = {16: (1.3, 85, False, False), 24: (1.45, 55, True, False), 32: (1.7, 55, True, True), 48: (2.1, 65, True, True)}


def optical(size, background=True, color=TEAL):
    stroke, node, circle, satellite = OPTICAL[size]
    factor = 8
    length = size * factor
    scale = length / 1024
    grow = (1.12 if size <= 16 else 1.08 if size <= 32 else 1.04) + (0 if background else 0.1)
    image = Image.new("RGBA", (length, length))
    if background:
        surface(image, scale, rim=factor if size <= 32 else 0)

    def at(v):
        return (512 + (v - 512) * grow) * scale

    c = rgb(color) + (255,)
    width = round(stroke * factor)
    draw = ImageDraw.Draw(image)
    if circle:
        draw.ellipse([at(292), at(292), at(732), at(732)], outline=c, width=width)
    ring = Image.new("RGBA", (length, length))
    ImageDraw.Draw(ring).ellipse([at(182), at(390), at(842), at(634)], outline=c, width=width)
    image.alpha_composite(ring.rotate(32, resample=Image.Resampling.BICUBIC))
    draw = ImageDraw.Draw(image)
    draw.ellipse([at(512 - node), at(512 - node), at(512 + node), at(512 + node)], fill=c)
    if satellite:
        r = max(34, 1.3 * 1024 / size / grow)
        draw.ellipse([at(791.86 - r), at(337.13 - r), at(791.86 + r), at(337.13 + r)], fill=c)
    return image.resize((size, size), Image.Resampling.LANCZOS)


app = raster()
app.save(ICONS / "icon.png")
app.save(BRAND / "icon-1024.png")
app.resize((256, 256), Image.Resampling.LANCZOS).save(ICONS / "icon-256.png")
small = [optical(size) for size in OPTICAL]
# Pass every frame explicitly: with append_images, Pillow 12 reuses the largest appended
# frame for bigger sizes instead of downscaling the master.
frames = small + [app.resize((size, size), Image.Resampling.LANCZOS) for size in (64, 128, 256)]
app.save(ICONS / "icon.ico", sizes=[(f.width, f.height) for f in frames], append_images=frames)
app.save(ICONS / "icon.icns", append_images=[image for image in small if image.width in (16, 32)])
# Electron tray images are 16px at 1x. Windows/Linux use the tiled icon, which reads on light
# and dark taskbars; macOS uses a black template glyph that the menu bar recolours.
for size, name in [(16, "tray.png"), (24, "tray@1.5x.png"), (32, "tray@2x.png")]:
    optical(size).save(ICONS / name)
for size, name in [(16, "trayTemplate.png"), (32, "trayTemplate@2x.png")]:
    optical(size, background=False, color="#000000").save(ICONS / name)

# A compact contact sheet makes native icon sizes easy to review.
sheet = Image.new("RGB", (1000, 420), "#0f1522")
sheet.paste(app.resize((320, 320), Image.Resampling.LANCZOS), (45, 50), app.resize((320, 320), Image.Resampling.LANCZOS))
draw = ImageDraw.Draw(sheet)
draw.text((413, 59), "ORBIT REMOTE / NATIVE ICON SYSTEM", fill=TEAL)
for x, size in zip([420, 578, 690, 783, 854, 915], [128, 64, 48, 32, 24, 16]):
    tile = optical(size) if size in OPTICAL else raster(size)
    sheet.paste(tile, (x, 140 + (128 - size) // 2), tile)
    draw.text((x, 294), str(size) + "px", fill="#d2d9e5")
draw.text((413, 355), "Teal on navy / orbital ring / connected node / optical sizes at 48px and below", fill="#aab4c6")
sheet.save(BRAND / "icon-preview.png")
print(f"Created vector marks and app/tray icons in {ICONS}")
