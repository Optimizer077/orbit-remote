"""Draw the README "How it works" diagram in Orbit's palette.

Run from the repository root: python docs/assets/diagrams/generate_how_it_works.py
Writes dark/light x wide/narrow SVGs. Text uses the system UI font; no web fonts.
"""

from pathlib import Path

OUT = Path(__file__).resolve().parent
FONT = "Segoe UI, -apple-system, BlinkMacSystemFont, Helvetica, Arial, sans-serif"
MONO = "Consolas, SFMono-Regular, Menlo, monospace"

THEMES = {
    "dark": dict(bg="#101616", card="#16211c", box="#1d2b23", line="#33463a", text="#eceee7", muted="#a3b398",
                 mint="#b2e6c5", mint_bg="#1e3a2b", blue="#aecaff", blue_bg="#16233a", gold="#e3cd8f", gold_bg="#3a321b",
                 ink="#101616"),
    "light": dict(bg="#ffffff", card="#f6f6f1", box="#ffffff", line="#d5ddcd", text="#1f2d23", muted="#4f6349",
                  mint="#22603f", mint_bg="#dff0e4", blue="#2b5aa6", blue_bg="#e3ecfb", gold="#86651a", gold_bg="#f6ecd2",
                  ink="#ffffff"),
}

GATES = [
    ("1", "Link policy", "Weak TLS dropped first"),
    ("2", "Identity", "Pinned certificate + tailnet source"),
    ("3", "Permissions", "Only what the owner granted"),
    ("4", "Session", "One controller · revocable"),
]


def esc(text):
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def t(x, y, text, c, size=14, weight=400, anchor="start", font=FONT, spacing=0):
    extra = f' letter-spacing="{spacing}"' if spacing else ""
    return (f'<text x="{x}" y="{y}" fill="{c}" font-family="{font}" font-size="{size}" font-weight="{weight}" '
            f'text-anchor="{anchor}"{extra}>{esc(text)}</text>')


def rect(x, y, w, h, fill, stroke, r=14, dash=None, width=1.5):
    d = f' stroke-dasharray="{dash}"' if dash else ""
    return f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{r}" fill="{fill}" stroke="{stroke}" stroke-width="{width}"{d}/>'


def arrow(x1, y1, x2, y2, c, both=False):
    head = ' marker-end="url(#head)"' + (' marker-start="url(#tail)"' if both else "")
    return f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="{c}" stroke-width="2"{head}/>'


def lock(x, y, c):
    return (f'<g fill="none" stroke="{c}" stroke-width="2" stroke-linecap="round"><rect x="{x}" y="{y + 7}" width="14" height="11" rx="2.5"/>'
            f'<path d="M{x + 3.5} {y + 7}V{y + 4.5}a3.5 3.5 0 0 1 7 0V{y + 7}"/></g>')


def mark(x, y, s, c):
    k = s / 744
    return (f'<g transform="translate({x - 140 * k} {y - 140 * k}) scale({k})"><g fill="none" stroke="{c}" stroke-width="34">'
            f'<circle cx="512" cy="512" r="220"/><ellipse cx="512" cy="512" rx="330" ry="122" transform="rotate(-32 512 512)"/></g>'
            f'<circle cx="512" cy="512" r="70" fill="{c}"/><circle cx="791.86" cy="337.13" r="40" fill="{c}"/></g>')


def viewer(x, y, w, p):
    out = [rect(x, y, w, 470, p["card"], p["line"], 18)]
    out += [mark(x + 24, y + 24, 30, p["mint"]), t(x + 66, y + 36, "YOUR COMPUTER", p["muted"], 12, 700, spacing=1.4),
            t(x + 66, y + 56, "Viewer", p["text"], 19, 700)]
    out += [rect(x + 20, y + 84, w - 40, 92, p["box"], p["line"], 12), t(x + 38, y + 116, "Orbit window", p["text"], 16, 600),
            t(x + 38, y + 140, "Sandboxed. Never holds keys", p["muted"], 13), t(x + 38, y + 160, "or sockets.", p["muted"], 13)]
    out += [arrow(x + w / 2, y + 180, x + w / 2, y + 222, p["muted"]), t(x + w / 2 + 10, y + 206, "allow-listed actions", p["muted"], 12)]
    out += [rect(x + 20, y + 226, w - 40, 112, p["box"], p["mint"], 12, width=2), t(x + 38, y + 258, "Orbit main process", p["text"], 16, 600),
            t(x + 38, y + 282, "Holds this computer's key", p["muted"], 13), t(x + 38, y + 302, "Checks the host's pin + cipher", p["muted"], 13),
            t(x + 38, y + 322, "before sending one byte", p["muted"], 13)]
    out += [rect(x + 20, y + 360, w - 40, 88, p["gold_bg"], p["gold"], 12, width=1.5),
            t(x + 38, y + 388, "SECURITY CODE", p["gold"], 11, 700, spacing=1.3),
            t(x + 38, y + 412, "551F 68EA 65A3 120A …", p["text"], 15, 600, font=MONO),
            t(x + 38, y + 434, "Matches on both computers", p["muted"], 12)]
    return out


def host(x, y, w, p):
    out = [rect(x, y, w, 470, p["card"], p["line"], 18)]
    out += [mark(x + 24, y + 24, 30, p["mint"]), t(x + 66, y + 36, "REMOTE COMPUTER", p["muted"], 12, 700, spacing=1.4),
            t(x + 66, y + 56, "Host", p["text"], 19, 700)]
    gy = y + 82
    for number, title, detail in GATES:
        out += [rect(x + 20, gy, w - 40, 60, p["box"], p["line"], 12),
                f'<circle cx="{x + 46}" cy="{gy + 30}" r="14" fill="{p["mint"]}"/>',
                t(x + 46, gy + 35, number, p["ink"], 14, 700, "middle"),
                t(x + 72, gy + 26, title, p["text"], 15, 600), t(x + 72, gy + 46, detail, p["muted"], 12.5)]
        gy += 70
    out += [arrow(x + w / 2, gy - 6, x + w / 2, gy + 14, p["muted"]),
            rect(x + 20, gy + 18, w - 40, 72, p["mint_bg"], p["mint"], 12, width=1.5),
            t(x + 38, gy + 46, "Your existing desktop", p["text"], 15, 600),
            t(x + 38, gy + 68, "Screen · input · clipboard · files", p["muted"], 13)]
    return out


def tunnel(x, y, w, h, p, vertical=False):
    out = [rect(x, y, w, h, p["blue_bg"], p["blue"], 26, dash="7 6", width=2),
           lock(x + 22, y + 18, p["blue"]),
           t(x + 46, y + 34, "LAYER 1 · TAILSCALE WIREGUARD", p["blue"], 12.5, 700, spacing=1.2),
           t(x + 22, y + 58, "Only your tailnet devices can reach the host.", p["muted"], 13),
           t(x + 22, y + 77, "Curve25519 · ChaCha20-Poly1305 · relays see ciphertext", p["muted"], 12.5)]
    ix, iy, iw, ih = x + 18, y + 98, w - 36, h - 116
    out += [rect(ix, iy, iw, ih, p["mint_bg"], p["mint"], 20, width=2), lock(ix + 18, iy + 16, p["mint"]),
            t(ix + 42, iy + 32, "LAYER 2 · ORBIT MUTUAL TLS", p["mint"], 12.5, 700, spacing=1.2),
            t(ix + 18, iy + 58, "TLS 1.3 · AES-256-GCM · X25519", p["text"], 15, 600),
            t(ix + 18, iy + 80, "Forward secrecy. Weaker links refused", p["muted"], 13),
            t(ix + 18, iy + 99, "by both sides. Certificates pinned.", p["muted"], 13)]
    return out


def chips(x, y, w, p, stacked=False):
    items = ["No Orbit server or account", "Encrypted twice, end to end", "Your grants, your revocation"]
    out, gap = [], 14
    cw = w if stacked else (w - 2 * gap) / 3
    for i, label in enumerate(items):
        cx, cy = (x, y + i * 52) if stacked else (x + i * (cw + gap), y)
        out += [rect(cx, cy, cw, 40, p["card"], p["line"], 20), f'<circle cx="{cx + 22}" cy="{cy + 20}" r="5" fill="{p["mint"]}"/>',
                t(cx + 36, cy + 25, label, p["text"], 13.5, 600)]
    return out


def document(width, height, body, p, title):
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}" role="img" aria-labelledby="t d">
  <title id="t">{esc(title)}</title>
  <desc id="d">Your computer's Orbit app talks to the remote computer through two encryption layers: Tailscale WireGuard and, inside it, Orbit mutual TLS. The host checks link policy, identity, permissions, and session before reaching the desktop.</desc>
  <defs>
    <marker id="head" markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto" markerUnits="userSpaceOnUse"><path d="M1 1L8 5L1 9" fill="none" stroke="{p["muted"]}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></marker>
    <marker id="tail" markerWidth="10" markerHeight="10" refX="2" refY="5" orient="auto" markerUnits="userSpaceOnUse"><path d="M9 1L2 5L9 9" fill="none" stroke="{p["muted"]}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></marker>
  </defs>
  <rect width="{width}" height="{height}" rx="22" fill="{p["bg"]}"/>
  {"".join(body)}
</svg>
'''


def wide(p):
    body = [t(36, 48, "How a connection works", p["text"], 24, 700),
            t(36, 74, "Every request crosses two encryption layers and four checks on the host.", p["muted"], 14.5)]
    body += viewer(36, 100, 300, p) + tunnel(372, 214, 456, 252, p) + host(864, 100, 300, p)
    body += [arrow(338, 335, 386, 335, p["muted"], both=True), arrow(814, 335, 862, 335, p["muted"], both=True)]
    body += chips(36, 592, 1128, p)
    return document(1200, 656, body, p, "How Orbit Remote connects your computers")


def narrow(p):
    body = [t(24, 44, "How a connection works", p["text"], 23, 700),
            t(24, 68, "Two encryption layers, four host checks.", p["muted"], 14.5)]
    body += viewer(24, 92, 552, p)
    body += [arrow(300, 566, 300, 600, p["muted"], both=True)]
    body += tunnel(24, 606, 552, 252, p, vertical=True)
    body += [arrow(300, 862, 300, 896, p["muted"], both=True)]
    body += host(24, 902, 552, p) + chips(24, 1396, 552, p, stacked=True)
    return document(600, 1560, body, p, "How Orbit Remote connects your computers")


for name, palette in THEMES.items():
    suffix = "" if name == "dark" else "-light"
    (OUT / f"how-it-works{suffix}.svg").write_text(wide(palette), encoding="utf-8", newline="\n")
    (OUT / f"how-it-works-narrow{suffix}.svg").write_text(narrow(palette), encoding="utf-8", newline="\n")
print(f"Wrote how-it-works diagrams to {OUT}")
