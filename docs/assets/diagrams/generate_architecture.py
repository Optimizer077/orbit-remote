"""Draw the Orbit Remote architecture block diagram in Orbit's palette.

Run from the repository root: python docs/assets/diagrams/generate_architecture.py
Writes architecture{,-narrow}{,-light}.svg: a viewer | network | host view (1200 wide) and a
stacked viewer -> network -> host view (600 wide). Primitives come from generate_figures.py,
which is import-safe, so both scripts share one palette and type scale.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from generate_figures import (FONT, MONO, THEMES, Type, arrow, badge, caps, chip, document, est, fit,  # noqa: E402
                              esc, heading, icon, lock, mark, pill, rect, t, wrap)

OUT = Path(__file__).resolve().parent

# Line styles: (size, weight, mono, colour key)
STYLES = {"m": (12.5, 400, False, "muted"), "t": (12.5, 600, False, "text"), "c": (12.5, 600, True, "text"),
          "cm": (12.5, 400, True, "muted")}
BUMP = {"size": 0.0}  # narrow figures are shown at ~60% on phones, so their detail text is set 1px larger

MAIN_ROWS = [
    ("transport.cjs", [("PinnedAgent: SHA-256 pin and TLS policy checked before any byte is sent", "m")], "mint"),
    ("controller.cjs", [("Pairing, sessions, frame polling, input queue, renewal and resume epochs", "m")], "line"),
    ("main.cjs", [("Windows, tray, host supervision, owner pipe", "m")], "line"),
    ("connections.json", [("Local store of paired hosts", "m")], "line"),
]
VIEWS = ["Overview", "Devices", "Connections", "Activity", "Settings", "Session HUD", "Command palette Ctrl/⌘K"]
REQUESTS = ["pair", "sessions", "frame", "input", "clipboard", "files", "power"]
GATES = [
    ("Link policy", "TLS 1.3, or 1.2 ECDHE + AEAD", "Security.IsStrongTls"),
    ("Tailscale source check", "whois on the source address", "TailscaleNetwork"),
    ("Client-certificate pin", "must match a pairing record", "HostState"),
    ("Grants", "view · control · clipboard · files · power", ""),
    ("Session", "One controller; resume epochs; 410 after host stop", ""),
]
SERVICES = [
    ("monitor", "Frame pipeline", [("capture → raw BGRA → ETag/304 + scale → PngEncoder", "m"), ("FrameQuality", "cm")]),
    ("mouse", "Input", [("Bounded queue; InputLeases auto-release", "m")]),
    ("clipboard", "Clipboard", [("Text", "m")]),
    ("folder", "Files", [("One shared folder, no overwrite", "m")]),
    ("power", "Power", [("PowerActions: lock, restart", "m")]),
]
STORES = [
    ("host.json", "Pairings, settings, resume epochs"),
    ("identity.dpapi", "Windows: protected by DPAPI"),
    ("identity.pfx", "macOS, Linux: user-only file"),
    ("audit.jsonl", "Bounded; no secrets or screen data"),
]
PLATFORMS = [
    ("Windows", ["GDI capture", "SendInput", "Win32 clipboard"]),
    ("macOS", ["CoreGraphics", "Accessibility", "Screen Recording consent"]),
    ("Linux (X11)", ["ffmpeg", "xdotool", "xclip"]),
]
FOOTNOTE = "Every installation runs both stacks; each computer is both viewer and host."


# ---------------------------------------------------------------- local primitives

def group(x, y, w, h, p, kind):
    """Column background: viewer = blue tint, host = mint tint, network = neutral dashed."""
    if kind == "network":
        return rect(x, y, w, h, p["card"], p["line"], 20, dash="3 6", width=1.6)
    fill, stroke = (p["blue_bg"], p["blue"]) if kind == "viewer" else (p["mint_bg"], p["mint"])
    return (f'<rect x="{x:g}" y="{y:g}" width="{w:g}" height="{h:g}" rx="20" fill="{fill}" fill-opacity="0.5" '
            f'stroke="{stroke}" stroke-opacity="0.45" stroke-width="1.5"/>')


def head(x, y, p, role, name, sub, color, mono=True):
    """Column header; returns (elements, height)."""
    return [mark(x + 18, y + 20, 30, p[color]), caps(x + 60, y + 30, role, p[color]),
            t(x + 60, y + 53, name, p["text"], 18, 700), t(x + 60, y + 73, sub, p["muted"], 12.5, 400,
                                                             font=MONO if mono else FONT)], 88


def dashed_arrow(x1, y1, x2, y2, p, color="muted", both=True):
    ends = f' marker-end="url(#h-{color})"' + (f' marker-start="url(#t-{color})"' if both else "")
    return (f'<line x1="{x1:g}" y1="{y1:g}" x2="{x2:g}" y2="{y2:g}" stroke="{p[color]}" stroke-width="2" '
            f'stroke-dasharray="5 5" stroke-linecap="round"{ends}/>')


def text_lines(x, y, width, lines, p, lh):
    """Render (text, style) rows from baseline y downward; returns (elements, last baseline)."""
    out, cy = [], y - lh
    for text, style in lines:
        size, weight, mono, colour = STYLES[style]
        size += BUMP["size"]
        for part in wrap(text, size, width, weight, mono):
            cy += lh
            out.append(t(x, cy, part, p[colour], size, weight, font=MONO if mono else None) if mono
                       else t(x, cy, part, p[colour], size, weight))
    return out, cy


def block(x, y, w, p, ty, glyph, title, lines=(), color="line", dash=None, fill="box", tag=None, min_h=0, strong=False):
    """Icon + title box with wrapped detail rows; returns (elements, height)."""
    tx, right = x + 46, x + w - 14
    out = []
    tag_w = 0
    if tag:
        tw = est(tag, 12, 600) + 24
        els, _ = chip(right - tw, y + 12, tag, p, p["muted"], p["card"], p["line"], 12, h=22)
        out += els
        tag_w = tw + 8
    fit(title, ty.title, right - tx - tag_w, 600)
    tint = p["muted"] if color == "line" else p[color]
    out += [icon(glyph, x + 14, y + 13, 22, tint), t(tx, y + 30, title, p["text"], ty.title, 600)]
    last = y + 30
    if lines:
        els, last = text_lines(tx, y + 30 + ty.lh + 1, right - tx, lines, p, ty.lh - 1)
        out += els
    h = max(min_h, last - y + 16)
    width = 2 if strong else 1.5
    return [rect(x, y, w, h, p[fill], p[color], 12, dash=dash, width=width)] + out, h


def flow(x, y, w, items, p, mono=False, size=12.5, h=24, gap=8):
    """Chips wrapped into rows; returns (elements, height)."""
    out, cx, cy = [], x, y
    for s in items:
        cw = 24 + est(s, size, 600, mono)
        if cx > x and cx + cw > x + w:
            cx, cy = x, cy + h + gap
        assert cx + cw <= x + w, f"chip {s!r} overflows"
        els, _ = chip(cx, cy, s, p, p["text"], p["card"], p["line"], size, mono=mono, h=h)
        out += els
        cx += cw + gap
    return out, cy + h - y


# ---------------------------------------------------------------- viewer components

def daemon(x, y, w, p, ty):
    return block(x, y, w, p, ty, "network", "Tailscale daemon", [("WireGuard tunnel ends here", "m")], "blue",
                 min_h=72)


def main_process(x, y, w, p, ty):
    """Electron main process with one row per file and the local admin link."""
    out = [icon("chip", x + 14, y + 13, 22, p["blue"]), t(x + 46, y + 30, "Main process", p["text"], ty.title, 600)]
    els, _ = chip(x + w - 14 - (est("Node.js", 12, 600) + 24), y + 12, "Node.js", p, p["muted"], p["card"], p["line"],
                  12, h=22)
    out += els
    ry, ix, iw = y + 46, x + 12, w - 24
    for name, lines, color in MAIN_ROWS:
        els, last = text_lines(ix + 14, ry + 41, iw - 28, lines, p, ty.lh - 2)
        h = last - ry + 13
        out += [rect(ix, ry, iw, h, p["card"], p[color], 10, width=1.6 if color != "line" else 1.2),
                t(ix + 14, ry + 22, name, p["text"], 13, 600, font=MONO)] + els
        if color == "mint":
            out.append(lock(ix + iw - 26, ry + 6, p["mint"]))
        ry += h + 8
    # Local admin link to this computer's own host (dashed = local only).
    els, last = text_lines(ix + 44, ry + 43, iw - 58, [("http 127.0.0.1:47831", "cm"),
                                                      ("Bearer control token, to its own Orbit host", "m")], p, ty.lh - 2)
    h = last - ry + 13
    out += [rect(ix, ry, iw, h, "none", p["muted"], 10, dash="4 4", width=1.2), icon("plug", ix + 12, ry + 10, 20, p["muted"]),
            caps(ix + 44, ry + 24, "Local admin API", p["muted"])] + els
    ry += h + 12
    return [rect(x, y, w, ry - y, p["box"], p["blue"], 12, width=2)] + out, ry - y


def renderer(x, y, w, p, ty):
    els, h = block(x, y, w, p, ty, "window", "Renderer", [("Sandboxed, no Node.js access.", "m"),
                                                          ("Never holds keys.", "t")], tag="React")
    chips, ch = flow(x + 46, y + h - 2, w - 60, VIEWS, p)
    h += ch + 14
    els[0] = rect(x, y, w, h, p["box"], p["line"], 12)
    return els + chips, h


def viewer_stack(x, y, w, p, ty, narrow):
    """Viewer column contents. Wide: network side on top. Narrow: renderer on top, daemon last."""
    bx, bw = x + 16, w - 32
    out, hh = head(bx, y + 4, p, "Viewer computer", "Electron desktop app", "apps/desktop", "blue")
    cy, cx, anchors = y + 4 + hh + 8, bx + bw / 2, {}
    order = ("renderer", "main", "daemon") if narrow else ("daemon", "main", "renderer")
    prev = None
    for name in order:
        if prev:
            gap = 64 if {prev, name} == {"main", "renderer"} else 30
            if {prev, name} == {"main", "renderer"}:
                out += [arrow(cx, cy + 4, cx, cy + gap - 4, p, both=True),
                        *pill(cx, cy + gap / 2, "preload.cjs · allow-listed IPC", p, ty)]
            else:
                start, end = (cy + gap - 3, cy + 3) if not narrow else (cy + 3, cy + gap - 3)
                out.append(arrow(cx, start, cx, end, p, "mint", width=2.5))
                out.append(t(cx + 12, cy + gap / 2 + 4, "TLS client", p["muted"], 12.5))
            cy += gap
        fn = {"daemon": daemon, "main": main_process, "renderer": renderer}[name]
        els, h = fn(bx, cy, bw, p, ty)
        out += els
        anchors[name] = (cy, h)
        cy += h
        prev = name
    return out, cy + 16 - y, anchors


# ---------------------------------------------------------------- host components

def listener(x, y, w, p, ty):
    """Remote listener and its ordered gates; rows reflow to the box width."""
    out = [icon("server", x + 14, y + 13, 22, p["mint"]), t(x + 46, y + 30, "Remote listener", p["text"], ty.title, 600)]
    els, cw = chip(x + 46, y + 42, "100.100.100.100:47832", p, p["blue"], p["blue_bg"], p["blue"], 12.5, mono=True, h=24)
    note = "Tailscale IP only · Kestrel"
    if 46 + cw + 10 + est(note, 12.5) <= w - 14:
        out += els + [t(x + 46 + cw + 10, y + 59, note, p["muted"], 12.5)]
        gy = y + 90
    else:
        out += els + [t(x + 46, y + 86, note, p["muted"], 12.5)]
        gy = y + 112
    tx, tw, lh = x + 52, w - 66, ty.lh - 2
    rows, centres = [], []
    for i, (title, detail, code) in enumerate(GATES):
        top = gy
        one_line = est(title + "  ", 14, 600) + est(detail, 12.5) <= tw
        if one_line:
            rows.append(f'<text x="{tx:g}" y="{gy + 14:g}" font-family="{FONT}"><tspan fill="{p["text"]}" font-size="14" '
                        f'font-weight="600">{esc(title)}</tspan><tspan dx="8" fill="{p["muted"]}" font-size="12.5">'
                        f'{esc(detail)}</tspan></text>')
            last = gy + 14
        else:
            fit(title, 14, tw, 600)
            rows.append(t(tx, gy + 14, title, p["text"], 14, 600))
            els, last = text_lines(tx, gy + 14 + lh, tw, [(detail, "m")], p, lh)
            rows += els
        if code:
            fit(code, 12, tw, mono=True)
            last += lh
            rows.append(t(tx, last, code, p["muted"], 12, font=MONO))
        centres.append(top + 9)
        rows += badge(x + 28, top + 9, i + 1, p, "mint", r=12)
        gy = last + 16
    rows.insert(0, f'<line x1="{x + 28:g}" y1="{centres[0]:g}" x2="{x + 28:g}" y2="{centres[-1]:g}" '
                   f'stroke="{p["mint"]}" stroke-width="2"/>')
    msg = "Fail any gate: refused."
    fit(msg, 12.5, w - 56, 600)
    rows += [icon("revoke", x + 16, gy, 18, p["rose"]), t(x + 42, gy + 14, msg, p["text"], 12.5, 600)]
    h = gy + 32 - y
    return [rect(x, y, w, h, p["box"], p["mint"], 12, width=2)] + out + rows, h


def entries(x, y, w, p, ty, glyph, title, items, gutter, dash=None, fill="box", color="line"):
    """Box with a title and a list of (icon or mono name, lines) entries."""
    tint = p["muted"] if color == "line" else p[color]
    out = [icon(glyph, x + 14, y + 13, 22, tint), t(x + 46, y + 30, title, p["text"], ty.title, 600)]
    ey = y + 48
    for item in items:
        if len(item) == 3:
            g, name, lines = item
            out += [icon(g, x + 16, ey + 2, 18, p["muted"]), t(x + 46, ey + 15, name, p["text"], 13.5, 600)]
            tx = x + 46
        else:
            name, desc = item
            lines = [(desc, "m")]
            out.append(t(x + 16, ey + 15, name, p["text"], 13, 600, font=MONO))
            fit(name, 13, w - 30, 600, True)
            tx = x + 16
        els, last = text_lines(tx, ey + 15 + ty.lh - 1, x + w - 14 - tx, lines, p, ty.lh - 2)
        out += els
        ey = last + gutter
    h = ey - gutter + 18 - y
    return [rect(x, y, w, h, p[fill], p[color], 12, dash=dash, width=1.5)] + out, h


def admin_api(x, y, w, p, ty):
    return block(x, y, w, p, ty, "plug", "Local admin API",
                 [("127.0.0.1:47831", "cm"), ("Bearer token, for its own app", "m"),
                  ("Invites · peers · settings · status · audit", "m")],
                 "muted", dash="5 5", fill="card")


def platforms(x, y, w, p, ty):
    out = [icon("chip", x + 14, y + 13, 22, p["muted"]), t(x + 46, y + 30, "Platform adapters", p["text"], ty.title, 600),
           t(x + w - 14, y + 30, "IPlatformBackend", p["muted"], 12.5, 400, "end", MONO)]
    fit("Platform adapters" + "IPlatformBackend", ty.title, w - 80, 600)
    gap = 10
    cw = (w - 28 - 2 * gap) / 3
    cards, ch = [], 0
    for i, (name, items) in enumerate(PLATFORMS):
        cx = x + 14 + i * (cw + gap)
        els, last = text_lines(cx + 12, y + 46 + 46, cw - 24, [(s, "m") for s in items], p, ty.lh - 2)
        cards.append((cx, name, els))
        ch = max(ch, last - (y + 46) + 14)
    for cx, name, els in cards:
        out += [rect(cx, y + 46, cw, ch, p["card"], p["line"], 10, width=1.2), t(cx + 12, y + 46 + 24, name, p["text"], 13.5, 600)]
        fit(name, 13.5, cw - 24, 600)
        out += els
    dy = y + 46 + ch + 12
    out += [arrow(x + w / 2, dy, x + w / 2, dy + 22, p),
            rect(x + 14, dy + 26, w - 28, 44, p["mint_bg"], p["mint"], 10, width=1.5), icon("monitor", x + 28, dy + 37, 22, p["mint"]),
            t(x + 60, dy + 53, "Existing signed-in desktop", p["text"], 14.5, 600)]
    h = dy + 26 + 44 + 14 - y
    return [rect(x, y, w, h, p["box"], p["line"], 12)] + out, h


# ---------------------------------------------------------------- network components

def pipe_h(x1, x2, cy, p):
    """Horizontal WireGuard pipe holding the mutual-TLS stream."""
    return [rect(x1, cy - 26, x2 - x1, 52, p["blue_bg"], p["blue"], 26, dash="7 5", width=2),
            rect(x1 + 6, cy - 12, x2 - x1 - 12, 24, p["mint_bg"], p["mint"], 12, width=1.5),
            arrow(x1 + 10, cy, x2 - 8, cy, p, "mint", width=2.5)]


def pipe_v(cx, y1, y2, p):
    return [rect(cx - 26, y1, 52, y2 - y1, p["blue_bg"], p["blue"], 26, dash="7 5", width=2),
            rect(cx - 12, y1 + 6, 24, y2 - y1 - 12, p["mint_bg"], p["mint"], 12, width=1.5),
            arrow(cx, y1 + 10, cx, y2 - 8, p, "mint", width=2.5)]


def lock_badge(cx, cy, p):
    return [f'<circle cx="{cx:g}" cy="{cy:g}" r="15" fill="{p["card"]}" stroke="{p["mint"]}" stroke-width="1.5"/>',
            lock(cx - 7, cy - 10.5, p["mint"])]


def layer_key(x, y, w, p, ty):
    """Two encryption layers; returns (elements, height)."""
    out, cy = [], y
    for colour, title, lines in (("blue", "WireGuard", [("Curve25519 · ChaCha20-Poly1305", "m")]),
                                 ("mint", "Orbit mutual TLS", [("TLS 1.3, or TLS 1.2 with ECDHE + AEAD", "m"),
                                                               ("Pinned certificates on both sides", "m")])):
        fit(title, 13.5, w - 26, 600)
        out += [lock(x, cy, p[colour]), t(x + 26, cy + 15, title, p["text"], 13.5, 600)]
        els, last = text_lines(x + 26, cy + 15 + ty.lh - 1, w - 26, lines, p, ty.lh - 2)
        out += els
        cy = last + 18
    return out, cy - 18 - y + 4


def requests(x, y, w, p, ty):
    out = [caps(x, y + 12, "Requests carried", p["muted"])]
    els, h = flow(x, y + 24, w, REQUESTS, p, mono=True)
    out += els
    els, last = text_lines(x, y + 24 + h + 22, w, [("frame returns a PNG; ETag 304 and scaling are optional.", "m")], p,
                           ty.lh - 2)
    return out + els, last - y + 4


def legend(x, y, w, p, horizontal=False):
    items = [("solid", "Data and requests"), ("dashed", "Local only"), ("lock", "Encrypted")]
    out = [caps(x, y + 12, "Legend", p["muted"])]
    cx, cy = x, y + 38
    for kind, label in items:
        if kind == "solid":
            out.append(arrow(cx, cy, cx + 28, cy, p))
        elif kind == "dashed":
            out.append(dashed_arrow(cx, cy, cx + 28, cy, p, both=False))
        else:
            out.append(lock(cx + 6, cy - 10, p["mint"]))
        out.append(t(cx + 40, cy + 4.5, label, p["muted"], 12.5))
        if horizontal:
            cx += 40 + est(label, 12.5) + 28
            assert cx <= x + w + 28, "legend overflows"
        else:
            cy += 26
    return out, (cy - y + 14) if not horizontal else 56


def footnote(x, y, w, p):
    fit(FOOTNOTE, 14, w - 70, 600)
    return [rect(x, y, w, 48, p["gold_bg"], p["gold"], 14, width=1.5), icon("refresh", x + 18, y + 12, 24, p["gold"]),
            t(x + 54, y + 30, FOOTNOTE, p["text"], 14, 600)], 48


def footnote_stacked(x, y, w, p):
    lines = wrap(FOOTNOTE, 14, w - 70, 600)
    h = 30 + 20 * len(lines)
    out = [rect(x, y, w, h, p["gold_bg"], p["gold"], 14, width=1.5), icon("refresh", x + 18, y + h / 2 - 12, 24, p["gold"])]
    out += [t(x + 54, y + 30 + 20 * i, ln, p["text"], 14, 600) for i, ln in enumerate(lines)]
    return out, h


# ---------------------------------------------------------------- layouts

TITLE = "Orbit Remote architecture"
SUBTITLE = "The viewer's desktop app reaches the other computer's .NET host through two encryption layers and five gates."


def wide(p, ty):
    BUMP["size"] = 0.0
    body, _ = heading(36, TITLE, [SUBTITLE], p, ty)
    top = 100
    vx, vw, nx, nw, hx, hw = 36, 312, 364, 204, 584, 580
    hb, hbw, gut = hx + 16, hw - 32, 16
    half = (hbw - gut) / 2
    rx = hb + half + gut

    viewer, vh, va = viewer_stack(vx, top, vw, p, ty, narrow=False)
    d_y, d_h = va["daemon"]
    pipe_y = d_y + d_h / 2

    # host: left = daemon, listener, admin API; right = stores, services; then platform adapters
    host, hh_ = head(hb, top + 4, p, "Host computer", "Orbit host", ".NET 10 · src/Orbit.Host", "mint")
    ya = top + 4 + hh_ + 8
    assert ya == d_y, "host daemon must line up with the viewer daemon"
    els, dh = daemon(hb, ya, half, p, ty)
    host += els
    yl = ya + dh + 30
    host.append(arrow(hb + half / 2, ya + dh + 3, hb + half / 2, yl - 3, p, "mint", width=2.5))
    els, lh = listener(hb, yl, half, p, ty)
    host += els
    # right: admin API beside the column header, then stores and services
    assert rx > hb + 60 + est("Orbit host", 18, 700) + 16, "admin API collides with the header"
    els, ah = admin_api(rx, top + 12, half, p, ty)
    host += els
    yst = top + 12 + ah + 16
    els, sth = entries(rx, yst, half, p, ty, "key", "Stores", STORES, 10, fill="card")
    host += els
    ys = yst + sth + 30
    els, sh = entries(rx, ys, half, p, ty, "server", "Services", SERVICES, 12)
    host += els
    ay = max(yl + 60, ys + 40)
    assert ay < yl + lh - 20, "listener and services do not overlap vertically"
    host.append(arrow(hb + half + 3, ay, rx - 3, ay, p))
    yd = max(yl + lh, ys + sh) + 30
    host.append(arrow(rx + half / 2, ys + sh + 3, rx + half / 2, yd - 3, p))
    els, ph = platforms(hb, yd, hbw, p, ty)
    host += els
    bottom = max(top + vh, yd + ph + 16)

    # network column
    net, _ = head(nx + 12, top + 4, p, "Network", "Your tailnet", "Tailscale peers only", "muted", mono=False)
    ky = pipe_y + 26 + 26
    els, kh = layer_key(nx + 16, ky, nw - 32, p, ty)
    net += els
    ry = ky + kh + 24
    els, rh = requests(nx + 16, ry, nw - 32, p, ty)
    net += els
    els, lgh = legend(nx + 16, ry + rh + 22, nw - 32, p)
    net += els
    bottom = max(bottom, ry + rh + 22 + lgh + 12)

    body += [group(vx, top, vw, bottom - top, p, "viewer"), group(nx, top, nw, bottom - top, p, "network"),
             group(hx, top, hw, bottom - top, p, "host")]
    body += pipe_h(vx + vw - 16 - 20, hb + 20, pipe_y, p)
    body += viewer + host + net + lock_badge(nx + nw / 2, pipe_y, p)
    label = "pinned mTLS in WireGuard"
    fit(label, 12.5, nw - 16, 600)
    body.append(t(nx + nw / 2, pipe_y - 34, label, p["text"], 12.5, 600, "middle"))
    els, fh = footnote(36, bottom + 20, 1128, p)
    return 1200, bottom + 20 + fh + 28, body + els


def narrow(p, ty):
    BUMP["size"] = 1.0
    body, yb = heading(24, TITLE, ["The viewer's desktop app reaches the other", "computer's .NET host through two encryption",
                                   "layers and five gates."], p, ty)
    x, w = 24, 552
    bx, bw = x + 16, w - 32
    vy = yb + 26
    viewer, vh, va = viewer_stack(x, vy, w, p, ty, narrow=True)
    body.append(group(x, vy, w, vh, p, "viewer"))
    d_y, d_h = va["daemon"]

    ny = vy + vh + 20
    net, _ = head(x + 16, ny + 4, p, "Network path", "Your tailnet", "Tailscale peers only", "muted", mono=False)
    ky = ny + 112
    nw_ = w - 140
    els, kh = layer_key(x + 20, ky, nw_, p, ty)
    net += els
    els, rh = requests(x + 20, ky + kh + 24, nw_, p, ty)
    net += els
    els, lgh = legend(x + 20, ky + kh + 24 + rh + 22, nw_, p)
    net += els
    nh = ky + kh + 24 + rh + 22 + lgh + 10 - ny
    body.append(group(x, ny, w, nh, p, "network"))

    hy = ny + nh + 20
    host, hh_ = head(bx, hy + 4, p, "Host computer", "Orbit host", ".NET 10 · src/Orbit.Host", "mint")
    cy = hy + 4 + hh_ + 8
    host_d = cy
    els, dh = daemon(bx, cy, bw, p, ty)
    host += els
    cy += dh + 30
    host.append(arrow(bx + 60, cy - 27, bx + 60, cy - 3, p, "mint", width=2.5))
    seq = [(listener, ()), (entries, ("server", "Services", SERVICES, 12)),
           (platforms, ()), (entries, ("key", "Stores", STORES, 10)), (admin_api, ())]
    for i, (fn, args) in enumerate(seq):
        kw = {"fill": "card"} if args and args[1] == "Stores" else {}
        els, h = fn(bx, cy, bw, p, ty, *args, **kw)
        host += els
        cy += h
        if i < 2:
            host.append(arrow(bx + 60, cy + 3, bx + 60, cy + 27, p))
            cy += 30
        elif i < len(seq) - 1:
            cy += 16
    hh = cy + 16 - hy
    body.append(group(x, hy, w, hh, p, "host"))

    pcx = x + w - 64
    body += pipe_v(pcx, d_y + d_h - 20, host_d + 20, p)
    body += viewer + net + host + lock_badge(pcx, ny + nh / 2, p)
    els, fh = footnote_stacked(x, hy + hh + 20, w, p)
    body += els
    return 600, hy + hh + 20 + fh + 28, body


DESC = ("Two computers side by side. Left, the viewer computer runs the Electron desktop app: a sandboxed React renderer "
        "(Overview, Devices, Connections, Activity, Settings, Session HUD, command palette) that never holds keys, an "
        "allow-listed preload.cjs IPC bridge, and the main process with transport.cjs (PinnedAgent checks the SHA-256 pin "
        "and TLS policy before any byte), controller.cjs, main.cjs, the connections.json store and a local admin link to "
        "its own host on 127.0.0.1:47831 with a bearer token. Middle, requests (pair, sessions, frame, input, clipboard, "
        "files, power) travel as pinned mutual TLS inside a Tailscale WireGuard tunnel between the two Tailscale daemons. "
        "Right, the host computer's .NET 10 Orbit host receives them on its Tailscale IP at port 47832 and passes five "
        "gates in order: link policy, Tailscale whois source check, client certificate pin against the pairing record, "
        "grants, and session. Then services: frame pipeline, input, clipboard, files, power; stores host.json, "
        "identity.dpapi or identity.pfx and audit.jsonl; a local admin API for its own desktop app; and platform adapters "
        "for Windows, macOS and Linux X11 driving the existing signed-in desktop. " + FOOTNOTE)


def main():
    for theme, palette in THEMES.items():
        suffix = "" if theme == "dark" else "-light"
        for layout, draw in (("", wide), ("-narrow", narrow)):
            width, height, body = draw(palette, Type(layout == "-narrow"))
            svg = document(width, height, body, palette, TITLE, DESC)
            (OUT / f"architecture{layout}{suffix}.svg").write_text(svg, encoding="utf-8", newline="\n")
    print(f"Wrote 4 architecture figures to {OUT}")


if __name__ == "__main__":
    main()
