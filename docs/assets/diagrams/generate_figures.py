"""Draw the README technical figures in Orbit's palette.

Run from the repository root: python docs/assets/diagrams/generate_figures.py
Writes pairing, layers, lifecycle, permissions and processes figures, each as
dark/light x wide (1200) / narrow (600) SVGs. Visual language matches
generate_how_it_works.py. Text uses the system UI font; no web fonts.
"""

import math
from pathlib import Path

OUT = Path(__file__).resolve().parent
FONT = "Segoe UI, -apple-system, BlinkMacSystemFont, Helvetica, Arial, sans-serif"
MONO = "Consolas, SFMono-Regular, Menlo, monospace"

THEMES = {
    "dark": dict(bg="#101616", card="#16211c", box="#1d2b23", line="#33463a", text="#eceee7", muted="#a3b398",
                 mint="#b2e6c5", mint_bg="#1e3a2b", blue="#aecaff", blue_bg="#16233a", gold="#e3cd8f", gold_bg="#3a321b",
                 rose="#f2b0a6", rose_bg="#3a2321", ink="#101616"),
    "light": dict(bg="#ffffff", card="#f6f6f1", box="#ffffff", line="#d5ddcd", text="#1f2d23", muted="#4f6349",
                  mint="#22603f", mint_bg="#dff0e4", blue="#2b5aa6", blue_bg="#e3ecfb", gold="#86651a", gold_bg="#f6ecd2",
                  rose="#a2392b", rose_bg="#fbe8e4", ink="#ffffff"),
}
ACCENTS = ("muted", "mint", "blue", "gold", "rose")


class Type:
    """Type scale for one layout. Narrow figures are shown at ~60% on phones, so their text is larger."""

    def __init__(self, narrow):
        self.narrow = narrow
        self.h1 = 23 if narrow else 24
        self.title = 16.5 if narrow else 16
        self.body = 14 if narrow else 13
        self.small = 13 if narrow else 12.5
        self.lh = 21 if narrow else 20


# ---------------------------------------------------------------- primitives

def esc(text):
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def est(text, size, weight=400, mono=False, spacing=0.0):
    """Conservative width estimate; real system fonts render narrower."""
    factor = 0.61 if mono else 0.6 if weight >= 700 else 0.58 if weight >= 600 else 0.55
    return len(text) * (size * factor + spacing)


def _greedy(text, size, width, weight, mono):
    lines, cur = [], ""
    for word in text.split(" "):  # only plain spaces break; U+00A0 keeps "16 MiB" together
        cand = f"{cur} {word}".strip()
        if cur and est(cand, size, weight, mono) > width:
            lines.append(cur)
            cur = word
        else:
            cur = cand
    lines.append(cur)
    return lines


def wrap(text, size, width, weight=400, mono=False, balance=True):
    """Wrap to width; with balance, use the narrowest width giving the same line count (no orphans)."""
    lines = _greedy(text, size, width, weight, mono)
    if balance and len(lines) > 1:
        lo, hi = 0.0, float(width)
        for _ in range(24):
            mid = (lo + hi) / 2
            if len(_greedy(text, size, mid, weight, mono)) <= len(lines):
                hi = mid
            else:
                lo = mid
        lines = _greedy(text, size, hi, weight, mono)
    for line in lines:
        assert est(line, size, weight, mono) <= width, f"cannot fit {line!r} in {width}px"
    return lines


def fit(text, size, width, weight=400, mono=False, spacing=0.0):
    assert est(text, size, weight, mono, spacing) <= width, f"{text!r} overflows {width}px"


def t(x, y, text, c, size=14, weight=400, anchor="start", font=FONT, spacing=0):
    extra = f' letter-spacing="{spacing}"' if spacing else ""
    return (f'<text x="{x:g}" y="{y:g}" fill="{c}" font-family="{font}" font-size="{size}" font-weight="{weight}" '
            f'text-anchor="{anchor}"{extra}>{esc(text)}</text>')


def rich(x, y, parts, size, anchor="start"):
    """One line with differently styled runs: parts = [(text, colour, weight), ...]."""
    spans = "".join(f'<tspan fill="{c}" font-weight="{w}">{esc(s)}</tspan>' for s, c, w in parts)
    return f'<text x="{x:g}" y="{y:g}" font-family="{FONT}" font-size="{size}" text-anchor="{anchor}">{spans}</text>'


def caps(x, y, text, c, anchor="start", size=12):
    return t(x, y, text.upper(), c, size, 700, anchor, spacing=1.3)


def para(x, y, text, c, size, width, lh, weight=400, anchor="start"):
    lines = wrap(text, size, width, weight)
    return [t(x, y + i * lh, line, c, size, weight, anchor) for i, line in enumerate(lines)], len(lines)


def rect(x, y, w, h, fill, stroke, r=14, dash=None, width=1.5):
    d = f' stroke-dasharray="{dash}"' if dash else ""
    return (f'<rect x="{x:g}" y="{y:g}" width="{w:g}" height="{h:g}" rx="{r}" fill="{fill}" stroke="{stroke}" '
            f'stroke-width="{width}"{d}/>')


def line(x1, y1, x2, y2, c, width=1.5, dash=None):
    d = f' stroke-dasharray="{dash}"' if dash else ""
    return f'<line x1="{x1:g}" y1="{y1:g}" x2="{x2:g}" y2="{y2:g}" stroke="{c}" stroke-width="{width}"{d}/>'


def arrow(x1, y1, x2, y2, p, color="muted", both=False, width=2):
    ends = f' marker-end="url(#h-{color})"' + (f' marker-start="url(#t-{color})"' if both else "")
    return (f'<line x1="{x1:g}" y1="{y1:g}" x2="{x2:g}" y2="{y2:g}" stroke="{p[color]}" stroke-width="{width}" '
            f'stroke-linecap="round"{ends}/>')


def route(points, p, color="muted", r=14, width=2, both=False):
    """Orthogonal arrow through points with rounded corners."""
    d = f"M{points[0][0]:g} {points[0][1]:g}"
    for (x0, y0), (x1, y1), (x2, y2) in zip(points, points[1:], points[2:]):
        d1, d2 = math.hypot(x1 - x0, y1 - y0), math.hypot(x2 - x1, y2 - y1)
        rr = min(r, d1 / 2, d2 / 2)
        ax, ay = x1 - (x1 - x0) / d1 * rr, y1 - (y1 - y0) / d1 * rr
        bx, by = x1 + (x2 - x1) / d2 * rr, y1 + (y2 - y1) / d2 * rr
        d += f" L{ax:.1f} {ay:.1f} Q{x1:g} {y1:g} {bx:.1f} {by:.1f}"
    d += f" L{points[-1][0]:g} {points[-1][1]:g}"
    ends = f' marker-end="url(#h-{color})"' + (f' marker-start="url(#t-{color})"' if both else "")
    return f'<path d="{d}" fill="none" stroke="{p[color]}" stroke-width="{width}" stroke-linejoin="round"{ends}/>'


def lock(x, y, c):
    return (f'<g fill="none" stroke="{c}" stroke-width="2" stroke-linecap="round"><rect x="{x}" y="{y + 7}" width="14" height="11" rx="2.5"/>'
            f'<path d="M{x + 3.5} {y + 7}V{y + 4.5}a3.5 3.5 0 0 1 7 0V{y + 7}"/></g>')


def mark(x, y, s, c):
    k = s / 744
    return (f'<g transform="translate({x - 140 * k:.2f} {y - 140 * k:.2f}) scale({k:.5f})"><g fill="none" stroke="{c}" stroke-width="34">'
            f'<circle cx="512" cy="512" r="220"/><ellipse cx="512" cy="512" rx="330" ry="122" transform="rotate(-32 512 512)"/></g>'
            f'<circle cx="512" cy="512" r="70" fill="{c}"/><circle cx="791.86" cy="337.13" r="40" fill="{c}"/></g>')


ICONS = {
    "eye": '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
    "mouse": '<rect x="6.5" y="2.5" width="11" height="19" rx="5.5"/><path d="M12 6.5v3.5"/>',
    "clipboard": '<rect x="5" y="4.5" width="14" height="17" rx="2.5"/><rect x="8.5" y="2.5" width="7" height="4" rx="1.5"/>'
                 '<path d="M8.5 11.5h7M8.5 15.5h4.5"/>',
    "folder": '<path d="M3 7.5a2 2 0 0 1 2-2h4l2 2.2h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    "power": '<path d="M12 3v8.5"/><path d="M7.2 6.4a7.6 7.6 0 1 0 9.6 0"/>',
    "monitor": '<rect x="2.5" y="4" width="19" height="12.5" rx="2"/><path d="M8.5 20.5h7M12 16.5v4"/>',
    "warning": '<path d="M12 3.5L2.5 20h19z"/><path d="M12 10v4.5M12 17.4v.01"/>',
    "key": '<circle cx="7.5" cy="15.5" r="4.5"/><path d="M10.8 12.2L20 3M16.5 6.5l3 3"/>',
    "refresh": '<path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20.2 3.8v4.7h-4.7"/>',
    "window": '<rect x="2.5" y="4" width="19" height="16" rx="2.5"/><path d="M2.5 8.5h19M5.8 6.3h.01M8.4 6.3h.01"/>',
    "chip": '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9.5 3v3M14.5 3v3M9.5 18v3M14.5 18v3M3 9.5h3M3 14.5h3M18 9.5h3M18 14.5h3"/>',
    "server": '<rect x="3" y="3.5" width="18" height="7.5" rx="2"/><rect x="3" y="13" width="18" height="7.5" rx="2"/>'
              '<path d="M7 7.2h.01M7 16.7h.01"/>',
    "network": '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.4 2.6 3.6 5.6 3.6 9s-1.2 6.4-3.6 9c-2.4-2.6-3.6-5.6-3.6-9S9.6 5.6 12 3z"/>',
    "link": '<path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1"/>',
    "revoke": '<circle cx="12" cy="12" r="8.5"/><path d="M6 6l12 12"/>',
    "stop": '<circle cx="12" cy="12" r="8.5"/><rect x="9" y="9" width="6" height="6" rx="1"/>',
    "clock": '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
    "check": '<circle cx="12" cy="12" r="8.5"/><path d="M8 12.3l2.7 2.7L16 9.6"/>',
    "shield": '<path d="M12 3l7.5 3v5.5c0 4.6-3.2 8.4-7.5 9.5-4.3-1.1-7.5-4.9-7.5-9.5V6z"/>',
    "lock": '<rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8.5 10.5V7.5a3.5 3.5 0 0 1 7 0v3"/>',
    "plug": '<path d="M9 3v5M15 3v5M6.5 8h11v3a5.5 5.5 0 0 1-11 0zM12 16.5V21"/>',
}


def icon(name, x, y, size, c, width=1.8):
    k = size / 24
    return (f'<g transform="translate({x:g} {y:g}) scale({k:.4f})" fill="none" stroke="{c}" stroke-width="{width / k:.2f}" '
            f'stroke-linecap="round" stroke-linejoin="round">{ICONS[name]}</g>')


def badge(cx, cy, n, p, color="mint", r=14):
    return [f'<circle cx="{cx:g}" cy="{cy:g}" r="{r}" fill="{p[color]}"/>', t(cx, cy + 5, str(n), p["ink"], 14, 700, "middle")]


def chip(x, y, text, p, fg, fill, stroke, size=12.5, mono=False, glyph=None, h=26, weight=600, dash=None):
    """Rounded label; returns (elements, width)."""
    gw = 22 if glyph else 0
    w = 12 + gw + est(text, size, weight, mono) + 12
    out = [rect(x, y, w, h, fill, stroke, h / 2, dash=dash, width=1.2)]
    if glyph:
        out.append(icon(glyph, x + 10, y + h / 2 - 8, 16, fg))
    out.append(t(x + 12 + gw, y + h / 2 + size * 0.36, text, fg, size, weight, font=MONO if mono else FONT))
    return out, w


def pill(cx, cy, text, p, ty, n=None, n_color="muted", glyph=None, color="line", fg="text"):
    """Label sitting on an arrow, centred on (cx, cy)."""
    lead = (30 if n else 0) + (24 if glyph else 0)
    w = 16 + lead + est(text, ty.small + 0.5, 600) + 16
    x = cx - w / 2
    out = [rect(x, cy - 17, w, 34, p["card"], p[color], 17, width=1.5)]
    if n:
        out += badge(x + 26, cy, n, p, n_color, r=12)
    if glyph:
        out.append(icon(glyph, x + 14 + (30 if n else 0), cy - 9, 18, p[color if color != "line" else "muted"]))
    out.append(t(x + 16 + lead, cy + 5, text, p[fg], ty.small + 0.5, 600))
    return out


def keycap(cx, cy, label, p):
    w = est(label, 12.5, 700, True) + 18
    return [rect(cx - w / 2, cy - 12, w, 24, p["box"], p["muted"], 6, width=1.3),
            f'<line x1="{cx - w / 2 + 3:g}" y1="{cy + 12:g}" x2="{cx + w / 2 - 3:g}" y2="{cy + 12:g}" stroke="{p["muted"]}" stroke-width="2.5" stroke-linecap="round"/>',
            t(cx, cy + 4.5, label, p["text"], 12.5, 700, "middle", MONO)]


def heading(x, title, lines, p, ty):
    top = 44 if ty.narrow else 48
    out = [t(x, top, title, p["text"], ty.h1, 700)]
    for i, text in enumerate(lines):
        out.append(t(x, top + 26 + i * 20, text, p["muted"], 14.5))
    return out, top + 26 + 20 * (len(lines) - 1)


def document(width, height, body, p, title, desc):
    defs = []
    for name in ACCENTS:
        c = p[name]
        defs.append(f'<marker id="h-{name}" markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto" markerUnits="userSpaceOnUse">'
                    f'<path d="M1 1L8 5L1 9" fill="none" stroke="{c}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></marker>')
        defs.append(f'<marker id="t-{name}" markerWidth="10" markerHeight="10" refX="2" refY="5" orient="auto" markerUnits="userSpaceOnUse">'
                    f'<path d="M9 1L2 5L9 9" fill="none" stroke="{c}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></marker>')
    joined = "\n    ".join(defs)
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height:g}" viewBox="0 0 {width} {height:g}" role="img" aria-labelledby="t d">
  <title id="t">{esc(title)}</title>
  <desc id="d">{esc(desc)}</desc>
  <defs>
    {joined}
  </defs>
  <rect width="{width}" height="{height:g}" rx="22" fill="{p["bg"]}"/>
  {"".join(body)}
</svg>
'''


# ---------------------------------------------------------------- 1. pairing

CODE = "551F 68EA 65A3 120A …"


def step_box(x, y, w, n, title, detail, p, ty, color, tag=None, emphasis=None, extra=None, strong=False):
    """Numbered step card; returns (elements, height). `extra(x, y)` returns (elements, height)."""
    tx, right = x + 58, x + w - 20
    tag_w = est(tag, 12, 700, spacing=1.3) + 16 if tag else 0
    fit(title, ty.title, right - tx - tag_w, 600)
    body = [t(tx, y + 33, title, p["text"], ty.title, 600)]
    if tag:
        body.append(caps(right, y + 32, tag, p[color], "end"))
    first = y + 33 + ty.lh + 4
    texts, count = para(tx, first, detail, p["muted"], ty.body, right - tx, ty.lh)
    body += texts
    last = first + ty.lh * (count - 1)
    if emphasis:
        texts, count = para(tx, last + ty.lh, emphasis, p["text"], ty.body, right - tx, ty.lh, 600)
        body += texts
        last += ty.lh * count
    bottom = last + 18
    if extra:
        els, eh = extra(tx, last + 14)
        body += els
        bottom = last + 14 + eh + 18
    h = bottom - y
    out = [rect(x, y, w, h, p["box"], p[color] if strong else p["line"], 14, width=2 if strong else 1.5)]
    return out + badge(x + 30, y + 28, n, p, color) + body, h


def expiry(p):
    def draw(x, y):
        els, _ = chip(x, y, "Expires in 5 minutes · works once", p, p["gold"], p["gold_bg"], p["gold"], glyph="clock")
        return els, 26
    return draw


def callout(x, y, w, p, ty, stacked=False):
    lead, rest = "Swapped invite?", "If its host details were changed, the codes won't match."
    size = 14.5 if not stacked else 14
    h = 72 if stacked else 54
    out = [rect(x, y, w, h, p["rose_bg"], p["rose"], 14), icon("warning", x + 18, y + (16 if stacked else 15), 24, p["rose"])]
    if stacked:
        out += [t(x + 54, y + 31, lead, p["text"], size, 700), t(x + 54, y + 53, rest, p["text"], size)]
    else:
        fit(lead + " " + rest, size, w - 74)
        out.append(rich(x + 54, y + 32, [(lead + " ", p["text"], 700), (rest, p["text"], 400)], size))
    return out, h


def code_chip(x, y, w, label, p, size):
    fit(CODE, size, w - 36 - est(label, 12, 700, spacing=1.3), 600, True)
    return [rect(x, y, w, 48, p["box"], p["gold"], 12, width=1.2), caps(x + 18, y + 29, label, p["muted"]),
            t(x + w - 18, y + 30, CODE, p["text"], size, 600, "end", MONO)]


def pairing_wide(p, ty):
    body, _ = heading(36, "Pairing: once per direction",
                      ["Do this once for each computer you want to view. Viewing the other way needs its own invitation."], p, ty)
    hx, vx, cw = 36, 744, 420
    mid = (hx + cw + vx) / 2
    steps = []
    y1 = 188
    els, h1 = step_box(hx, y1, cw, 1, "Add a device", "Pick its grants. View only is the default.", p, ty, "mint")
    steps += els
    y2 = y1 + h1 + 16
    els, h2 = step_box(hx, y2, cw, 2, "Create an invitation",
                       "Holds the host address, certificate fingerprint and a one-time secret.", p, ty, "mint", extra=expiry(p))
    steps += els
    # Staircase: step 4 sits between 2 and 5 so both hand-offs are straight horizontal arrows.
    y5 = y2 + h2 + 16
    a5 = y5 + 28
    _, h4 = step_box(vx, 0, cw, 4, "Paste and connect",
                     "Connects and checks the host certificate against the fingerprint.", p, ty, "blue",
                     emphasis="The secret is sent only after they match.", strong=True)
    y4 = a5 + 18 - h4
    a3 = y4 + 28
    assert y2 + 24 <= a3 <= y2 + h2 - 16, "step 4 does not overlap step 2"
    els, h4 = step_box(vx, y4, cw, 4, "Paste and connect",
                       "Connects and checks the host certificate against the fingerprint.", p, ty, "blue",
                       emphasis="The secret is sent only after they match.", strong=True)
    steps += els
    els, h5 = step_box(hx, y5, cw, 5, "Verify and remember",
                       "Checks the secret, then stores the viewer's certificate pin and its grants.", p, ty, "mint")
    steps += els
    steps += [arrow(hx + cw, a3, vx, a3, p), *pill(mid, a3, "You send it privately", p, ty, n=3),
              arrow(vx, a5, hx + cw, a5, p, "mint"), *pill(mid, a5, "Secret, over pinned TLS", p, ty, glyph="lock", color="mint")]
    y6 = max(y4 + h4, y5 + h5) + 24
    for x, color, role, name in ((hx, "mint", "Host", "The computer you will view"), (vx, "blue", "Viewer", "The computer you sit at")):
        body += [line(x + cw / 2, 166, x + cw / 2, y6, p["line"], 2, "2 7"), rect(x, 100, cw, 66, p["card"], p["line"], 16),
                 mark(x + 20, 118, 30, p[color]), caps(x + 62, 128, role, p[color]), t(x + 62, 151, name, p["text"], 17, 700)]
    body += steps
    body += [rect(hx, y6, vx + cw - hx, 146, p["gold_bg"], p["gold"], 16), *badge(hx + 30, y6 + 30, 6, p, "gold"),
             t(hx + 58, y6 + 35, "Compare the security code once", p["text"], 16, 600),
             t(hx + 58, y6 + 57, "Both screens show the same code.", p["muted"], 13),
             *code_chip(hx + 20, y6 + 78, cw - 40, "Host shows", p, 16),
             *code_chip(vx + 20, y6 + 78, cw - 40, "Viewer shows", p, 16),
             t(mid, y6 + 111, "=", p["gold"], 28, 700, "middle")]
    els, ch = callout(hx, y6 + 146 + 16, vx + cw - hx, p, ty)
    body += els
    return 1200, y6 + 146 + 16 + ch + 32, body


def pairing_narrow(p, ty):
    x, w, cx = 24, 552, 300
    body, yb = heading(x, "Pairing: once per direction",
                       ["Once for each computer you want to view.", "Viewing the other way needs its own invitation."], p, ty)
    y = yb + 24
    els, cw1 = chip(x, y, "Host = the computer you view", p, p["mint"], p["mint_bg"], p["mint"])
    body += els
    els, _ = chip(x + cw1 + 12, y, "Viewer = the one you sit at", p, p["blue"], p["blue_bg"], p["blue"])
    body += els
    y += 26 + 22
    flow = [
        (1, "Add a device", "Pick its grants. View only is the default.", "mint", "Host", {}),
        (2, "Create an invitation", "Holds the host address, certificate fingerprint and a one-time secret.", "mint", "Host",
         dict(extra=expiry(p))),
        (4, "Paste and connect", "Connects and checks the host certificate against the fingerprint.", "blue", "Viewer",
         dict(emphasis="The secret is sent only after they match.", strong=True)),
        (5, "Verify and remember", "Checks the secret, then stores the viewer's certificate pin and its grants.", "mint", "Host", {}),
    ]
    links = {2: ("You send it privately", dict(n=3)), 4: ("Secret, over pinned TLS", dict(glyph="lock", color="mint"))}
    for n, title, detail, color, tag, kw in flow:
        els, h = step_box(x, y, w, n, title, detail, p, ty, color, tag=tag, **kw)
        body += els
        y += h
        if n in links:
            text, opts = links[n]
            body += [arrow(cx, y + 2, cx, y + 70, p, opts.get("color", "muted")), *pill(cx, y + 36, text, p, ty, **opts)]
            y += 72
        else:
            body.append(arrow(cx, y + 2, cx, y + 28, p))
            y += 30
    half = (w - 40 - 16) / 2
    body += [rect(x, y, w, 154, p["gold_bg"], p["gold"], 16), *badge(x + 30, y + 28, 6, p, "gold"),
             t(x + 58, y + 33, "Compare the security code once", p["text"], ty.title, 600),
             t(x + 58, y + 58, "Both screens show the same code.", p["muted"], ty.body)]
    for i, label in enumerate(("Host shows", "Viewer shows")):
        bx = x + 20 + i * (half + 16)
        body += [rect(bx, y + 76, half, 58, p["box"], p["gold"], 12, width=1.2), caps(bx + 16, y + 98, label, p["muted"]),
                 t(bx + 16, y + 121, CODE, p["text"], 14.5, 600, font=MONO)]
        fit(CODE, 14.5, half - 32, 600, True)
    y += 154 + 16
    els, ch = callout(x, y, w, p, ty, stacked=True)
    return 600, y + ch + 28, body + els


# ---------------------------------------------------------------- 2. layers

def layer_specs(ty):
    b = ty.body
    return [
        dict(fill="card", stroke="line", dash="2 6", accent="muted", glyph="network", label="Tailscale network boundary",
             lines=[("Only your tailnet devices can reach port 47832.", "muted", b, 400)]),
        dict(fill="blue_bg", stroke="blue", dash="7 6", accent="blue", glyph="lock", label="Layer 1 · WireGuard",
             lines=[("Curve25519 · ChaCha20-Poly1305", "text", 15, 600)]),
        dict(fill="mint_bg", stroke="mint", accent="mint", glyph="lock", label="Layer 2 · Orbit mutual TLS",
             lines=[("TLS 1.3 · AES-256-GCM · X25519", "text", 15, 600),
                    ("Or TLS 1.2 with ECDHE + AEAD. Anything weaker is refused by both sides.", "muted", b, 400),
                    ("Forward secrecy protects past sessions.", "muted", b, 400)]),
        dict(fill="gold_bg", stroke="gold", accent="gold", glyph="key", label="Identity",
             lines=[("Pinned RSA-3072 certificates · SHA-256 pin", "text", 15, 600),
                    ("Both screens show the same security code at pairing.", "muted", b, 400)]),
    ]


def nested(x, y, w, p, ty, inset, pad):
    """Concentric layers, outermost first; returns (elements, height)."""
    specs, frames, cy = layer_specs(ty), [], y
    for i, spec in enumerate(specs):
        lx, lw = x + i * inset, w - 2 * i * inset
        rows, base = [], cy + 58
        for text, color, size, weight in spec["lines"]:
            for part in wrap(text, size, lw - 36, weight):
                rows.append(t(lx + 18, base, part, p[color], size, weight))
                base += 22 if size >= 15 else ty.lh
        frames.append((spec, lx, lw, cy, rows))
        cy = base - (22 if spec["lines"][-1][2] >= 15 else ty.lh) + 22
    n = len(specs)
    ix, iw = x + n * inset, w - 2 * n * inset
    core = 66
    bottom = cy + core
    out = []
    for i, (spec, lx, lw, ly, rows) in enumerate(frames):
        lb = bottom + (n - i) * pad
        out += [rect(lx, ly, lw, lb - ly, p[spec["fill"]], p[spec["stroke"]], 26 - i * 3, dash=spec.get("dash"),
                     width=2 if i else 1.8),
                icon(spec["glyph"], lx + 18, ly + 15, 20, p[spec["accent"]]),
                caps(lx + 46, ly + 31, spec["label"], p[spec["accent"]])]
        out += rows
    label = "Your screen, keystrokes, clipboard, files"
    size = 16 if est(label, 16, 600) <= iw - 70 else 15
    fit(label, size, iw - 70, 600)
    out += [rect(ix, cy, iw, core, p["box"], p["text"], 14, width=1.5), icon("monitor", ix + 20, cy + 21, 24, p["text"]),
            t(ix + 56, cy + 39, label, p["text"], size, 600)]
    return out, bottom + n * pad - y


def at_rest(x, y, w, h, p, ty):
    out = [rect(x, y, w, h, p["card"], p["line"], 18), icon("key", x + 22, y + 22, 24, p["gold"]),
           caps(x + 58, y + 34, "At rest", p["gold"]), t(x + 58, y + 56, "Identity keys on disk", p["text"], 18, 700)]
    fit("Identity keys on disk", 18, w - 78, 700)
    by, bw = y + 84, w - 40
    for title, detail, planned in (("Windows", "Protected by Windows DPAPI.", False),
                                   ("macOS · Linux", "Stored in user-only files.", True)):
        texts, count = para(x + 38, by + 52, detail, p["muted"], ty.body, bw - 36, ty.lh)
        bh = 52 + ty.lh * (count - 1) + (52 if planned else 20)
        out += [rect(x + 20, by, bw, bh, p["box"], p["line"], 12), t(x + 38, by + 30, title, p["text"], 15, 600), *texts]
        if planned:
            els, _ = chip(x + 38, by + bh - 40, "Keychain support planned", p, p["muted"], p["card"], p["muted"], dash="3 3")
            out += els
        by += bh + 14
    return out, by - 14 + 18 - y


LIMITS = ["Not post-quantum in practice", "Doesn't protect a compromised computer", "No independent audit yet"]


def limits(x, y, w, p, ty, stacked=False):
    if stacked:
        h = 54 + 26 * len(LIMITS)
        out = [rect(x, y, w, h, p["card"], p["line"], 16), icon("warning", x + 18, y + 15, 22, p["gold"]),
               caps(x + 50, y + 32, "Honest limits", p["gold"])]
        for i, item in enumerate(LIMITS):
            out += [f'<circle cx="{x + 30}" cy="{y + 60 + i * 26}" r="3" fill="{p["muted"]}"/>',
                    t(x + 50, y + 65 + i * 26, item, p["text"], ty.body)]
        return out, h
    out = [rect(x, y, w, 56, p["card"], p["line"], 16), icon("warning", x + 20, y + 16, 22, p["gold"]),
           caps(x + 52, y + 33, "Honest limits", p["gold"])]
    start = x + 52 + est("HONEST LIMITS", 12, 700, spacing=1.3) + 36
    widths = [12 + est(item, 13.5) for item in LIMITS]
    gap = (x + w - 24 - start - sum(widths)) / (len(LIMITS) - 1)
    assert gap >= 24, "limits strip overflows"
    cx = start
    for item, iw in zip(LIMITS, widths):
        out += [f'<circle cx="{cx:g}" cy="{y + 28}" r="3" fill="{p["muted"]}"/>', t(cx + 12, y + 33, item, p["text"], 13.5)]
        cx += iw + gap
    return out, 56


GATES = [
    ("revoke", "rose", "Outside your tailnet", "Cannot reach port 47832."),
    ("revoke", "rose", "In your tailnet, not paired", "Refused: no pinned certificate."),
    ("check", "mint", "Paired device", "Only what its grants allow."),
]


def gates(x, y, w, h, p, ty):
    """Who gets through the layers; draws a card of at least the needed height, returns (elements, height)."""
    rows, ry = [], y + 62
    for glyph, color, title, detail in GATES:
        fit(title, 14, w - 76, 600)
        texts, count = para(x + 54, ry + 33, detail, p["muted"], ty.body, w - 76, ty.lh)
        rows += [icon(glyph, x + 22, ry, 20, p[color]), t(x + 54, ry + 14, title, p["text"], 14, 600), *texts]
        ry += 33 + ty.lh * (count - 1) + 16
    h = max(h, ry - y + 4)
    return [rect(x, y, w, h, p["card"], p["line"], 18), icon("shield", x + 22, y + 21, 24, p["mint"]),
            caps(x + 58, y + 39, "Who gets through", p["mint"])] + rows, h


def layers_wide(p, ty):
    body, _ = heading(36, "Encryption in layers",
                      ["Your session is wrapped twice, and each side proves who it is with a pinned certificate."], p, ty)
    els, h = nested(36, 100, 784, p, ty, 20, 18)
    body += els
    _, rh = at_rest(852, 100, 312, 0, p, ty)
    side, _ = at_rest(852, 100, 312, rh, p, ty)
    gate, gh = gates(852, 100 + rh + 16, 312, h - rh - 16, p, ty)
    assert gh == h - rh - 16, "side column taller than the layers"
    body += side + gate
    els, lh = limits(36, 100 + h + 20, 1128, p, ty)
    return 1200, 100 + h + 20 + lh + 32, body + els


def layers_narrow(p, ty):
    body, yb = heading(24, "Encryption in layers", ["Wrapped twice; each side proves who it is", "with a pinned certificate."], p, ty)
    y = yb + 26
    els, h = nested(24, y, 552, p, ty, 14, 14)
    body += els
    y += h + 20
    _, ph = at_rest(24, y, 552, 0, p, ty)
    els, ph = at_rest(24, y, 552, ph, p, ty)
    body += els
    y += ph + 20
    els, gh = gates(24, y, 552, 0, p, ty)
    body += els
    y += gh + 20
    els, lh = limits(24, y, 552, p, ty, stacked=True)
    return 600, y + lh + 28, body + els


# ---------------------------------------------------------------- 3. lifecycle

def state(x, y, w, h, title, p, ty, color="line", glyph=None, chip_text=None, detail=None, final=False, center=False,
          sub=None):
    stroke = p[color]
    tint = p["muted"] if color == "line" else p[color]
    out = [rect(x, y, w, h, p["box"], stroke, 16, width=1.5 if color == "line" else 2)]
    if final:
        out.append(rect(x + 5, y + 5, w - 10, h - 10, "none", stroke, 12, width=1.2))
    if center:
        cx = x + w / 2
        paras = [detail] if isinstance(detail, str) else list(detail or [])
        lines = [ln for text in paras for ln in wrap(text, ty.body, w - 36)]
        content = 34 + 30 + (20 if sub else 0) + (10 + ty.lh * len(lines) if lines else 0)
        top = y + (h - content) / 2
        out += [icon(glyph, cx - 17, top, 34, tint), t(cx, top + 34 + 30, title, p["text"], 18, 700, "middle")]
        base = top + 64
        if sub:
            base += 20
            out.append(t(cx, base, sub, tint, ty.small, 600, "middle"))
        for i, text in enumerate(lines):
            out.append(t(cx, base + 26 + i * ty.lh, text, p["muted"], ty.body, 400, "middle"))
        return out
    tx = x + (50 if glyph else 20)
    fit(title, 17, x + w - 18 - tx, 700)
    if glyph:
        out.append(icon(glyph, x + 18, y + 17, 22, tint))
    out.append(t(tx, y + 36, title, p["text"], 17, 700))
    base = y + 36
    if chip_text:
        els, _ = chip(x + 20, y + 50, chip_text, p, tint, p["card"], tint, size=12.5, mono=True, h=24)
        out += els
        base = y + 74
    if detail:
        lines = [ln for text in ([detail] if isinstance(detail, str) else detail) for ln in wrap(text, ty.body, w - 40)]
        out += [t(x + 20, base + 24 + i * ty.lh, ln, p["muted"], ty.body) for i, ln in enumerate(lines)]
        assert base + 24 + ty.lh * (len(lines) - 1) + 12 <= y + h, f"{title} content overflows"
    return out


def labels(cx, y, rows, p, anchor="middle"):
    """Arrow label rows: (text, strong) pairs stacked 15px apart from baseline y."""
    return [t(cx, y + i * 15, text, p["text"] if strong else p["muted"], 12.5 if strong else 12, 600 if strong else 400, anchor)
            for i, (text, strong) in enumerate(rows)]


def legend(x, y, p, rows):
    out = []
    for row, items in enumerate(rows):
        cx = x
        for kind, text in items:
            yy = y + row * 26
            if kind == "state":
                out.append(rect(cx, yy - 9, 26, 18, p["box"], p["line"], 5, width=1.3))
            elif kind == "final":
                out += [rect(cx, yy - 9, 26, 18, p["box"], p["muted"], 5, width=1.3),
                        rect(cx + 3, yy - 6, 20, 12, "none", p["muted"], 3, width=1)]
            else:
                out.append(arrow(cx, yy, cx + 26, yy, p))
            out.append(t(cx + 36, yy + 4.5, text, p["muted"], 12.5))
            cx += 36 + est(text, 12.5) + 30
    return out


def lifecycle_wide(p, ty):
    body, _ = heading(36, "Session lifecycle", ["What a connection goes through, and what ends it for good."], p, ty)
    ax, aw, cx0, cw, n1, n2, nw, ex, ew = 36, 204, 352, 508, 374, 662, 176, 972, 192
    body += [rect(cx0, 104, cw, 342, p["card"], p["line"], 22), caps(cx0 + 22, 134, "Active session", p["muted"]),
             t(cx0 + cw - 22, 134, "Exits apply to both states", p["muted"], 12.5, anchor="end")]
    body += state(n1, 150, nw, 274, "Live", p, ty, "mint", "monitor", center=True, sub="viewing",
                  detail="You watch the host's screen.")
    body += state(n2, 150, nw, 274, "Controlling", p, ty, "blue", "mouse", center=True,
                  detail=["Your mouse and keyboard drive the host.", "One controller at a time."])
    body += state(ax, 150, aw, 112, "Paired", p, ty, glyph="link", detail="Pin and grants stored on the host.")
    body += state(ax, 300, aw, 124, "Reconnecting", p, ty, "gold", "refresh",
                  detail="Keeps the last frame dimmed and retries with backoff.")
    body += state(ex, 150, ew, 120, "Ended", p, ty, "muted", "stop", "HTTP 410", "Never auto-resumed.", final=True)
    body += state(ex, 304, ew, 120, "Revoked", p, ty, "rose", "revoke", "HTTP 401", "Access removed.", final=True)
    g1, g2, g3 = (ax + aw + cx0) / 2, (n1 + nw + n2) / 2, (cx0 + cw + ex) / 2
    body += [arrow(ax + aw, 206, n1, 206, p), *labels(g1, 184, [("Connect or", True), ("View only", True)], p),
             arrow(n1, 340, ax + aw, 340, p, "gold"), *labels(g1, 314, [("network drop", True), ("either state", False)], p),
             arrow(ax + aw, 392, n1, 392, p, "mint"), *labels(g1, 413, [("reconnected", True), ("back to Live", False)], p),
             arrow(n1 + nw, 236, n2, 236, p, "blue"), t(g2, 224, "Take control", p["text"], 13, 600, "middle"),
             *labels(g2, 257, [("if the host", False), ("granted Control", False)], p),
             arrow(n2, 352, n1 + nw, 352, p), *keycap(g2, 328, "Esc", p), *labels(g2, 374, [("back to Live", False)], p),
             arrow(cx0 + cw, 210, ex, 210, p), *labels(g3, 184, [("Disconnect,", True), ("Disconnect all", True)], p),
             *labels(g3, 229, [("or host stop", True)], p),
             arrow(cx0 + cw, 364, ex, 364, p, "rose"), *labels(g3, 352, [("owner revokes", True)], p),
             *labels(g3, 382, [("any time", False)], p)]
    body += legend(36, 482, p, [[("state", "State"), ("final", "Final state: not resumed automatically"),
                                 ("event", "Event that changes the state")]])
    return 1200, 516, body


def lifecycle_narrow(p, ty):
    body, yb = heading(24, "Session lifecycle", ["What a connection goes through, and what", "ends it for good."], p, ty)
    y = yb + 26
    body += state(24, y, 264, 116, "Paired", p, ty, glyph="link", detail="Pin and grants stored on the host.")
    body += state(312, y, 264, 116, "Reconnecting", p, ty, "gold", "refresh",
                  detail="Keeps the last frame dimmed and retries with backoff.")
    top = y + 116
    yc = top + 74
    live_y, live_h = yc + 46, 96
    ctrl_y, ctrl_h = live_y + live_h + 92, 118
    bottom = ctrl_y + ctrl_h + 44
    body += [rect(24, yc, 552, bottom - yc, p["card"], p["line"], 22), caps(44, yc + 30, "Active session", p["muted"]),
             t(44, bottom - 18, "Exits apply to both states", p["muted"], 13)]
    body += state(44, live_y, 512, live_h, "Live (viewing)", p, ty, "mint", "monitor", detail="You watch the host's screen.")
    body += state(44, ctrl_y, 512, ctrl_h, "Controlling", p, ty, "blue", "mouse",
                  detail=["Your mouse and keyboard drive the host.", "One controller at a time."])
    mid = live_y + live_h + 46
    body += [arrow(200, top, 200, live_y, p), *labels(190, top + 32, [("Connect or", True), ("View only", True)], p, "end"),
             arrow(400, live_y, 400, top, p, "gold"), *labels(390, top + 32, [("network drop", True), ("either state", False)], p, "end"),
             arrow(476, top, 476, live_y, p, "mint"), *labels(488, top + 32, [("reconnected", True), ("back to Live", False)], p, "start"),
             arrow(300, live_y + live_h, 300, ctrl_y, p, "blue"), t(314, mid - 4, "Take control", p["text"], 13, 600),
             t(314, mid + 14, "if the host granted Control", p["muted"], 12.5),
             arrow(240, ctrl_y, 240, live_y + live_h, p), *keycap(206, mid - 8, "Esc", p),
             t(228, mid + 22, "back to Live", p["muted"], 12, anchor="end")]
    ye = bottom + 80
    body += [arrow(150, bottom, 150, ye, p), *labels(162, bottom + 22, [("Disconnect,", True), ("Disconnect all", True),
                                                                        ("or host stop", True)], p, "start"),
             arrow(438, bottom, 438, ye, p, "rose"), *labels(450, bottom + 30, [("owner revokes", True), ("any time", False)], p, "start")]
    body += state(24, ye, 264, 122, "Ended", p, ty, "muted", "stop", "HTTP 410", "Never auto-resumed.", final=True)
    body += state(312, ye, 264, 122, "Revoked", p, ty, "rose", "revoke", "HTTP 401", "Access removed.", final=True)
    y = ye + 122 + 32
    body += legend(24, y, p, [[("state", "State"), ("event", "Event that changes the state")],
                              [("final", "Final state: not resumed automatically")]])
    return 600, y + 26 + 26, body


# ---------------------------------------------------------------- 4. permissions

GRANTS = [
    ("eye", "View", "See the host's screen live.", True),
    ("mouse", "Control", "Use the host's mouse and keyboard.", False),
    ("clipboard", "Clipboard", "Copy and paste between the two computers.", False),
    ("folder", "Files", "Move files through one shared folder.", False),
    ("power", "Power", "Lock or restart the host.", False),
]
RULES = [
    ("link", "Control also needs Take control on the viewer."),
    ("power", "Power requires Control."),
    ("folder", "Files: one shared folder, 16 MiB limit, no overwrite."),
    ("revoke", "The host owner can revoke access at any time."),
]


def tile(x, y, glyph, default, p, s=52):
    fill, stroke, c = (p["mint_bg"], p["mint"], p["mint"]) if default else (p["card"], p["line"], p["text"])
    return [rect(x, y, s, s, fill, stroke, 14, width=1.5), icon(glyph, x + (s - 28) / 2, y + (s - 28) / 2, 28, c, 1.9)]


def default_chip(right, y, p):
    w = est("DEFAULT", 12, 700, spacing=1.2) + 20
    return [rect(right - w, y, w, 24, p["mint"], p["mint"], 12, width=1), t(right - w / 2, y + 16.5, "DEFAULT", p["ink"], 12, 700,
                                                                             "middle", spacing=1.2)]


def permissions_wide(p, ty):
    body, _ = heading(36, "What a paired device can do",
                      ["The host owner chooses grants for each device. New invitations start view-only."], p, ty)
    cw, gap = (1128 - 4 * 16) / 5, 16
    for i, (glyph, title, meaning, default) in enumerate(GRANTS):
        x = 36 + i * (cw + gap)
        body += [rect(x, 104, cw, 180, p["card"], p["mint"] if default else p["line"], 18, width=2 if default else 1.5),
                 *tile(x + 20, 124, glyph, default, p), t(x + 20, 206, title, p["text"], 17, 700)]
        texts, _ = para(x + 20, 230, meaning, p["muted"], ty.body, cw - 40, ty.lh)
        body += texts
        if default:
            body += default_chip(x + cw - 20, 124, p)
    body.append(caps(36, 326, "Rules", p["muted"]))
    rw = (1128 - 3 * 16) / 4
    for i, (glyph, text) in enumerate(RULES):
        x = 36 + i * (rw + 16)
        texts, _ = para(x + 50, 368, text, p["text"], ty.body, rw - 66, ty.lh)
        body += [rect(x, 340, rw, 76, p["box"], p["line"], 14), icon(glyph, x + 16, 355, 20, p["muted"]), *texts]
    return 1200, 448, body


def permissions_narrow(p, ty):
    body, yb = heading(24, "What a paired device can do",
                       ["The host owner chooses grants for each device.", "New invitations start view-only."], p, ty)
    y = yb + 26
    for glyph, title, meaning, default in GRANTS:
        fit(meaning, ty.body, 552 - 86 - 20)
        body += [rect(24, y, 552, 80, p["card"], p["mint"] if default else p["line"], 16, width=2 if default else 1.5),
                 *tile(40, y + 14, glyph, default, p), t(110, y + 35, title, p["text"], 17, 700),
                 t(110, y + 58, meaning, p["muted"], ty.body)]
        if default:
            body += default_chip(556, y + 18, p)
        y += 80 + 12
    y += 18
    body.append(caps(24, y, "Rules", p["muted"]))
    y += 14
    rows, ry = [], y + 22
    for glyph, text in RULES:
        texts, count = para(72, ry + 16, text, p["text"], ty.body, 552 - 68, ty.lh)
        rows += [icon(glyph, 40, ry + 1, 20, p["muted"]), *texts]
        ry += 16 + ty.lh * (count - 1) + 26
    body += [rect(24, y, 552, ry - y, p["box"], p["line"], 16), *rows]
    return 600, ry + 28, body


# ---------------------------------------------------------------- 5. processes

def comp(x, y, w, glyph, title, detail, p, ty, strong=False, badge_text=None, port=False):
    tx = x + 48
    fit(title, ty.title, x + w - 16 - tx - (60 if badge_text else 0), 600)
    body = [icon(glyph, x + 16, y + 15, 22, p["mint"] if strong else p["muted"]), t(tx, y + 32, title, p["text"], ty.title, 600)]
    if badge_text:
        els, _ = chip(tx + est(title, ty.title, 600) + 10, y + 15, badge_text, p, p["muted"], p["card"], p["line"], 12, h=22)
        body += els
    texts, count = para(tx, y + 56, detail, p["muted"], ty.body, x + w - 16 - tx, ty.lh)
    body += texts
    last = y + 56 + ty.lh * (count - 1)
    if port:
        els, cw = chip(x + 16, last + 14, "100.100.100.100:47832", p, p["blue"], p["blue_bg"], p["blue"], 12, mono=True)
        fit("Tailscale IP only", 12.5, x + w - 16 - (x + 16 + cw + 10))
        body += els + [t(x + 16 + cw + 10, last + 31, "Tailscale IP only", p["muted"], 12.5)]
        last += 40
    h = last - y + 18
    return [rect(x, y, w, h, p["box"], p["mint"] if strong else p["line"], 12, width=2 if strong else 1.5)] + body, h


def machine(x, y, w, p, ty, role, name, viewing, gutter=0):
    bx, bw = x + 20, w - 40 - gutter
    out = [mark(x + 24, y + 24, 30, p["mint"]), caps(x + 66, y + 36, role, p["muted"]), t(x + 66, y + 56, name, p["text"], 19, 700)]
    cx, by, anchors = bx + bw / 2, y + 84, {}
    els, h = comp(bx, by, bw, "window", "Orbit window", "Sandboxed renderer. No Node.js, no keys.", p, ty)
    out += els
    by += h
    out += [arrow(cx, by + 6, cx, by + 40, p, both=True), t(cx + 12, by + 28, "allow-listed IPC", p["muted"], 12.5)]
    by += 46
    els, h = comp(bx, by, bw, "chip", "Orbit main process",
                  "TLS client. Checks the pin and link policy, and supervises the host.", p, ty, strong=viewing)
    out += els
    anchors["main"] = by + h / 2
    by += h
    out.append(arrow(cx, by + 5, cx, by + 25, p, both=True))
    by += 30
    out += [rect(bx, by, bw, 60, p["card"], p["line"], 12, dash="4 4"), icon("plug", bx + 16, by + 18, 22, p["muted"]),
            caps(bx + 48, by + 26, "Local admin API", p["muted"]),
            t(bx + 48, by + 46, "127.0.0.1:47831 · bearer token", p["text"], 12.5, 600, font=MONO)]
    fit("127.0.0.1:47831 · bearer token", 12.5, bw - 64, 600, True)
    by += 60
    out.append(arrow(cx, by + 5, cx, by + 25, p, both=True))
    by += 30
    els, h = comp(bx, by, bw, "server", "Orbit host", "Capture, input, clipboard, files, permissions and audit.", p, ty,
                  strong=not viewing, badge_text=".NET", port=True)
    out += els
    anchors["host"] = by + h / 2
    height = by + h + 20 - y
    return [rect(x, y, w, height, p["card"], p["line"], 18)] + out, height, anchors, bx + bw


def tunnel(x, y, w, p, captions, h=None):
    """WireGuard band holding the mutual-TLS band. With h, captions sit at the bottom of the inner band."""
    ix, iw = x + 16, w - 32
    if h is None:
        h = 72 + 52 + 20 * len(captions) + 22 + 16
    inner_bottom = y + h - 16
    first = inner_bottom - 18 - 20 * (len(captions) - 1)
    out = [rect(x, y, w, h, p["blue_bg"], p["blue"], 24, dash="7 6", width=2), lock(x + 18, y + 16, p["blue"]),
           caps(x + 42, y + 31, "Layer 1 · WireGuard", p["blue"]),
           t(x + 18, y + 54, "Curve25519 · ChaCha20-Poly1305", p["muted"], 12.5),
           rect(ix, y + 72, iw, inner_bottom - y - 72, p["mint_bg"], p["mint"], 18, width=2), lock(ix + 16, y + 88, p["mint"]),
           caps(ix + 40, y + 103, "Layer 2 · mutual TLS", p["mint"]),
           t(ix + 16, y + 124, "TLS 1.3 · both sides pinned", p["muted"], 12.5)]
    for i, (text, strong) in enumerate(captions):
        fit(text, 12.5, iw - 32, 600 if strong else 400)
        out.append(t(ix + 16, first + 20 * i, text, p["text"] if strong else p["muted"], 12.5, 600 if strong else 400))
    return out, h


def chips_row(x, y, w, items, p, stacked=False):
    out, gap = [], 14
    widths = [est(s, 13.5, 600) + 52 for s in items]
    extra = 0 if stacked else (w - sum(widths) - gap * (len(items) - 1)) / len(items)
    assert extra >= 0, "chips overflow"
    cx = x
    for i, (label, cw) in enumerate(zip(items, widths)):
        cw = w if stacked else cw + extra
        cy = y + i * 52 if stacked else y
        out += [rect(cx, cy, cw, 40, p["card"], p["line"], 20), f'<circle cx="{cx + 22:g}" cy="{cy + 20}" r="5" fill="{p["mint"]}"/>',
                t(cx + 36, cy + 25, label, p["text"], 13.5, 600)]
        if not stacked:
            cx += cw + gap
    return out


NOTES = ["Every installation is both a viewer and a host", "Admin API stays on 127.0.0.1", "The window never holds keys"]


def processes_wide(p, ty):
    body, _ = heading(36, "What runs on each computer",
                      ["Here computer A views computer B. Every installation runs the same parts, so either can do both."], p, ty)
    a, ah, aa, a_right = machine(36, 100, 380, p, ty, "Computer A", "Viewing", True)
    b, bh, ba, _ = machine(784, 100, 380, p, ty, "Computer B", "Being viewed", False)
    ym, yh = aa["main"], ba["host"]
    top = ym - 140
    tun, _ = tunnel(456, top, 288, p, [("Mutual TLS inside WireGuard", True), ("to B's host port 47832", False)],
                    h=yh + 84 - top)
    curve = (f'<path d="M{a_right:g} {ym:g} C600 {ym:g} 600 {yh:g} 804 {yh:g}" fill="none" stroke="{p["mint"]}" '
             f'stroke-width="2.5" marker-end="url(#h-mint)"/>')
    body += a + b + tun + [curve]
    height = 100 + max(ah, bh)
    body += chips_row(36, height + 24, 1128, NOTES, p)
    return 1200, height + 24 + 40 + 32, body


def processes_narrow(p, ty):
    body, yb = heading(24, "What runs on each computer", ["Here A views B. Every installation runs", "the same parts, so either can do both."],
                       p, ty)
    y = yb + 26
    a, ah, aa, a_right = machine(24, y, 552, p, ty, "Computer A", "Viewing", True, gutter=36)
    ty_ = y + ah + 24
    tun, th = tunnel(24, ty_, 552, p, [("Mutual TLS inside WireGuard", True),
                                       ("A's main process → B's host port 47832", False)])
    yb2 = ty_ + th + 24
    b, bh, ba, b_right = machine(24, yb2, 552, p, ty, "Computer B", "Being viewed", False, gutter=36)
    link = route([(a_right, aa["main"]), (548, aa["main"]), (548, ba["host"]), (b_right, ba["host"])], p, "mint", 14, 2.5)
    body += a + tun + b + [link]
    y = yb2 + bh + 24
    body += chips_row(24, y, 552, NOTES, p, stacked=True)
    return 600, y + 3 * 52 - 12 + 28, body


# ---------------------------------------------------------------- output

FIGURES = {
    "pairing": (pairing_wide, pairing_narrow, "Pairing two Orbit Remote computers",
                "Pairing happens once per direction. 1: on the host, Add a device and choose its grants; view only is the "
                "default. 2: the host creates an invitation with its address, certificate fingerprint and a one-time "
                "secret; it expires in 5 minutes and works once. 3: you send it privately to the viewer. 4: the viewer "
                "pastes it, connects, and checks that the host certificate matches the fingerprint before sending the "
                "secret. 5: the host verifies the secret and stores the viewer's certificate pin and grants. 6: both "
                "screens show the same security code, compared once. If an invitation leaks and someone else pairs "
                "first, the codes will not match."),
    "layers": (layers_wide, layers_narrow, "Orbit Remote encryption layers",
               "Nested layers from outside in: the Tailscale network boundary, where only your tailnet devices reach "
               "port 47832; layer 1, WireGuard with Curve25519 and ChaCha20-Poly1305; layer 2, Orbit mutual TLS with TLS "
               "1.3, AES-256-GCM and X25519, or TLS 1.2 with ECDHE and AEAD, weaker settings refused by both sides, with "
               "forward secrecy; identity, pinned RSA-3072 certificates with a SHA-256 pin and a security code; and at "
               "the centre your screen, keystrokes, clipboard and files. At rest, identity keys are protected by Windows "
               "DPAPI or by user-only files on macOS and Linux, with keychain support planned. Limits: not post-quantum "
               "in practice, does not protect a compromised computer, no independent audit yet."),
    "lifecycle": (lifecycle_wide, lifecycle_narrow, "Orbit Remote session lifecycle",
                  "A paired device moves to Live viewing with Connect or View only. Take control, if the host granted "
                  "Control, moves to Controlling; Esc returns to Live. A network drop from either state moves to "
                  "Reconnecting, which keeps the last frame dimmed and retries with backoff, then returns to Live. "
                  "Disconnect, Disconnect all or a host stop ends the session with HTTP 410 and it is never resumed "
                  "automatically. If the owner revokes the device, the session ends with HTTP 401 and access is removed."),
    "permissions": (permissions_wide, permissions_narrow, "Orbit Remote device permissions",
                    "Five grants a host owner can give a paired device: View, the default for new invitations; Control "
                    "of mouse and keyboard; Clipboard; Files; and Power to lock or restart. Rules: Control also needs "
                    "Take control on the viewer; Power requires Control; Files are limited to one shared folder, 16 MiB "
                    "and no overwrite; the host owner can revoke access at any time."),
    "processes": (processes_wide, processes_narrow, "Orbit Remote processes on each computer",
                  "Each computer runs the same parts: the sandboxed Orbit window with no Node.js and no keys, connected "
                  "by allow-listed IPC to the Orbit main process, which is the TLS client, checks the pin and policy and "
                  "supervises the host; the local admin API on 127.0.0.1:47831 with a bearer token; and the .NET Orbit "
                  "host for capture, input, clipboard, files, permissions and audit, listening only on the Tailscale IP "
                  "at port 47832. Computer A's main process reaches computer B's host through mutual TLS inside "
                  "WireGuard. Every installation is both a viewer and a host."),
}


def main():
    for name, (wide, narrow, title, desc) in FIGURES.items():
        for theme, palette in THEMES.items():
            suffix = "" if theme == "dark" else "-light"
            for layout, draw in (("", wide), ("-narrow", narrow)):
                width, height, body = draw(palette, Type(layout == "-narrow"))
                svg = document(width, height, body, palette, title, desc)
                (OUT / f"{name}{layout}{suffix}.svg").write_text(svg, encoding="utf-8", newline="\n")
    print(f"Wrote {len(FIGURES) * 4} figures to {OUT}")


if __name__ == "__main__":
    main()
