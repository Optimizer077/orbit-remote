"""Draw the hardware streaming pipeline figure (decision D11) in Orbit's palette.

Run from the repository root: python docs/assets/diagrams/generate_pipeline.py
Writes pipeline{,-narrow}{,-light}.svg with the helpers of generate_figures.py.
The numbers are per-stage measurements from 2026-10-26 (docs/PERFORMANCE.md);
change both together.
"""

from generate_figures import (OUT, THEMES, Type, arrow, badge, caps, chip, document, est, fit, heading, icon, para,
                              rect, rich, t, wrap)

TITLE_TEXT = "From screen to screen: the hardware path"
SUBTITLE = ["Measured per stage at 3024×1898 on one Windows PC (RTX 5060 Ti);",
            "decode also measured on an Apple-silicon Mac. Synthetic content."]

# (title, how, value, note, accent, status, glyph)
STAGES = [
    ("Capture", "DXGI Desktop Duplication on the GPU; an unchanged screen costs nothing", "4.4 ms",
     "per changed frame", "mint", "In the app · beta", "monitor"),
    ("Encode", "Hardware H.264 through Windows Media Foundation", "5.8–7.6 ms",
     "1080p: 2.5–2.9 ms", "mint", "In the app · beta", "chip"),
    ("Send", "One stream inside the pinned mutual-TLS link, inside WireGuard", "2–26 KB",
     "per update, not ~1 MB", "blue", "In the app · beta", "lock"),
    ("Decode", "WebCodecs hardware decoder; VideoToolbox on a Mac", "0.5–0.7 ms",
     "Mac: 2.4–3.3 ms", "gold", "In the app · beta", "chip"),
    ("Draw", "Canvas; each decoded frame is released right after drawing", "0.2 ms",
     "per frame", "gold", "In the app", "window"),
]
# (label, value used for the bar width, accent); encode uses the middle of its measured range.
BUDGET = [("Capture 4.4 ms", 4.4, "mint"), ("Encode 5.8–7.6 ms", 6.7, "mint"), ("Decode 0.5–0.7 ms", 0.6, "gold"),
          ("Draw 0.2 ms", 0.2, "gold")]
TOTAL = "≈ 11–13 ms per frame, plus the network"
TODAY_LEAD = "Live, end to end:"
TODAY = "59.3 frames/s at native 2560×1440 with 0.6 ms decode and ~300 KB/s, against about 20 frames/s at 12.5 MB/s for preview.4's picture path (loopback, one PC)."
FOOT = "Stage timings are separate measurements; the live run is a loopback test on one PC. Cross-device results follow."


def card(x, y, w, n, stage, p, ty, height=None):
    """One pipeline stage; returns (elements, natural height)."""
    title, how, value, note, accent, status, glyph = stage
    inner = w - 36
    fit(title, ty.title, inner - 64, 600)
    body = badge(x + 30, y + 30, n, p, accent) + [
        t(x + 54, y + 36, title, p["text"], ty.title, 600),
        icon(glyph, x + w - 38, y + 19, 20, p[accent]),
    ]
    texts, count = para(x + 18, y + 72, how, p["muted"], ty.small, inner, ty.lh - 1)
    body += texts
    vy = y + 72 + (ty.lh - 1) * (count - 1) + 40
    fit(value, 25, inner, 700)
    fit(note, ty.small, inner)
    body += [t(x + 18, vy, value, p[accent], 25, 700), t(x + 18, vy + 23, note, p["muted"], ty.small)]
    natural = vy + 23 + 22 + 26 + 18 - y
    h = height or natural
    els, cw = chip(x + 18, y + h - 44, status, p, p[accent], p[accent + "_bg"], p[accent], size=12)
    assert cw <= inner, f"status chip {status!r} overflows"
    return [rect(x, y, w, h, p["box"], p["line"], 14)] + body + els, natural


def budget(x, y, w, p, ty):
    """Proportional bar of the per-frame budget with a total; returns (elements, height)."""
    out = [caps(x, y + 14, "Per-frame budget at 3024×1898", p["muted"])]
    total = sum(v for _, v, _ in BUDGET)
    bx, by, bh = x, y + 30, 22
    unlabeled = []
    for i, (name, value, accent) in enumerate(BUDGET):
        seg = max(6.0, w * value / total) if i < len(BUDGET) - 1 else x + w - bx
        out.append(rect(bx, by, seg, bh, p[accent + "_bg"], p[accent], 6, width=1.2))
        label = name
        if est(label, 12, 600) + 16 <= seg:
            out.append(t(bx + 10, by + 15.5, label, p["text"], 12, 600))
        else:
            unlabeled.append(label)
        bx += seg
    fit(TOTAL, ty.body + 1, w, 700)
    out.append(t(x, by + bh + 28, TOTAL, p["text"], ty.body + 1, 700))
    # Segments too thin to label are named after the total, right-aligned when there is room.
    rest = " · ".join(unlabeled)
    if rest and est(TOTAL, ty.body + 1, 700) + 24 + est(rest, ty.small, 600) <= w:
        out.append(t(x + w, by + bh + 28, rest, p["gold"], ty.small, 600, "end"))
    elif rest:
        out.append(t(x, by + bh + 50, rest, p["gold"], ty.small, 600))
        return out, by + bh + 50 - y
    return out, by + bh + 28 - y


def today(x, y, w, p, ty):
    """The current per-frame path, for contrast, plus the honesty note; returns (elements, height)."""
    lines = wrap(TODAY_LEAD + " " + TODAY, ty.body, w - 74)
    h = 30 + ty.lh * (len(lines) - 1) + 20
    out = [rect(x, y, w, h, p["mint_bg"], p["mint"], 14), icon("check", x + 18, y + 14, 22, p["mint"])]
    for i, text in enumerate(lines):
        if i == 0:  # The lead is bold; wrap() keeps it on the first line because it is short.
            out.append(rich(x + 54, y + 30, [(TODAY_LEAD + " ", p["text"], 700), (text[len(TODAY_LEAD) + 1:], p["text"], 400)], ty.body))
        else:
            out.append(t(x + 54, y + 30 + i * ty.lh, text, p["text"], ty.body))
    notes, ncount = para(x, y + h + 26, FOOT, p["muted"], ty.small, w, ty.lh - 1)
    return out + notes, h + 26 + (ty.lh - 1) * (ncount - 1)


def pipeline_wide(p, ty):
    width, x0, gap = 1200, 48, 34
    out, top = heading(x0, TITLE_TEXT, SUBTITLE, p, ty)
    y = top + 34
    w = (width - 2 * x0 - gap * (len(STAGES) - 1)) / len(STAGES)
    h = max(card(0, 0, w, i + 1, s, p, ty)[1] for i, s in enumerate(STAGES))
    for i, stage in enumerate(STAGES):
        x = x0 + i * (w + gap)
        out += card(x, y, w, i + 1, stage, p, ty, h)[0]
        if i < len(STAGES) - 1:
            out.append(arrow(x + w + 5, y + h / 2, x + w + gap - 5, y + h / 2, p, "muted"))
    y += h + 34
    els, bh = budget(x0, y, width - 2 * x0, p, ty)
    out += els
    y += bh + 30
    els, th = today(x0, y, width - 2 * x0, p, ty)
    out += els
    return width, y + th + 36, out


def pipeline_narrow(p, ty):
    width, x0 = 600, 32
    out, top = heading(x0, "Screen to screen, in hardware", ["Per-stage measurements at 3024×1898;",
                                                              "synthetic content."], p, ty)
    y = top + 30
    w = width - 2 * x0
    for i, stage in enumerate(STAGES):
        els, h = card(x0, y, w, i + 1, stage, p, ty)
        out += els
        y += h
        if i < len(STAGES) - 1:
            out.append(arrow(width / 2, y + 4, width / 2, y + 26, p, "muted"))
            y += 30
    y += 30
    els, bh = budget(x0, y, w, p, ty)
    out += els
    y += bh + 28
    els, th = today(x0, y, w, p, ty)
    out += els
    return width, y + th + 32, out


DESC = ("The hardware streaming pipeline in development, with per-stage measurements at 3024×1898: capture with DXGI "
        "Desktop Duplication on the GPU, 4.4 ms per changed frame and nothing for an unchanged screen; hardware H.264 "
        "encoding through Windows Media Foundation, 5.8 to 7.6 ms, or 2.5 to 2.9 ms at 1080p; sending one stream inside "
        "the pinned mutual-TLS link within WireGuard, 2 to 26 KB per update instead of about 1 MB; WebCodecs hardware "
        "decoding, 0.5 to 0.7 ms on Windows and 2.4 to 3.3 ms on an Apple-silicon Mac; and drawing to a canvas in 0.2 ms. "
        "The per-frame budget is about 11 to 13 ms plus the network. Measured live end to end on one PC: 59.3 frames per second "
        "at native 2560 by 1440 with 0.6 ms decode and about 300 KB/s, against about 20 frames per second at 12.5 MB/s for the "
        "preview.4 picture path. Cross-device results follow.")


def main():
    count = 0
    for theme, palette in THEMES.items():
        suffix = "" if theme == "dark" else "-light"
        for layout, draw in (("", pipeline_wide), ("-narrow", pipeline_narrow)):
            width, height, body = draw(palette, Type(layout == "-narrow"))
            svg = document(width, height, body, palette, "Orbit Remote hardware streaming pipeline", DESC)
            (OUT / f"pipeline{layout}{suffix}.svg").write_text(svg, encoding="utf-8", newline="\n")
            count += 1
    print(f"Wrote {count} pipeline figures to {OUT}")


if __name__ == "__main__":
    main()
