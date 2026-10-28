"""Draw the security-review figures in Orbit's palette.

Run from the repository root: python docs/assets/diagrams/generate_security_figures.py
Writes security-boundaries, security-attackers and security-request-path, each as
dark/light x wide (1200) / narrow (600) SVGs, for docs/SECURITY-REVIEW.md.

The palette, type scale and drawing primitives come from generate_figures.py, so
these figures match the README diagrams. Every text and symbol here is drawn
through helpers that record its colour pair; after drawing, the script computes
WCAG 2.x contrast for every recorded pair in both themes and fails unless text
reaches 4.5:1 and symbols 3:1. It also fails if any text is smaller than 12 px.
"""

import re

from generate_figures import (FONT, ICONS, MONO, OUT, THEMES, Type, arrow, document, est, fit, icon, line, mark, rect,
                              route, t, wrap)

ICONS.update({
    "user": '<circle cx="12" cy="8" r="4"/><path d="M4 20.5c1.2-3.8 4.3-5.8 8-5.8s6.8 2 8 5.8"/>',
    "bug": '<rect x="7" y="7" width="10" height="13" rx="5"/><path d="M12 7V4.5M9.5 4.5l1.2 2.2M14.5 4.5l-1.2 2.2'
           'M7 11H3.5M7 15.5H3.5M17 11h3.5M17 15.5h3.5"/>',
    "package": '<path d="M12 2.8l8.5 4.6v9.2L12 21.2l-8.5-4.6V7.4z"/><path d="M3.5 7.4L12 12l8.5-4.6M12 12v9.2"/>',
})

TEXT_PAIRS = set()  # (foreground, background) palette keys of every text drawn
MARK_PAIRS = set()  # (foreground, background) palette keys of every non-text symbol


# ---------------------------------------------------------------- recorded primitives

def tx(x, y, text, fg, bg, p, size, weight=400, anchor="start", mono=False, spacing=0):
    TEXT_PAIRS.add((fg, bg))
    return t(x, y, text, p[fg], size, weight, anchor, MONO if mono else FONT, spacing)


def cap(x, y, text, fg, bg, p, anchor="start"):
    return tx(x, y, text.upper(), fg, bg, p, 12, 700, anchor, spacing=1.3)


def lines(x, y, text, fg, bg, p, size, width, lh, weight=400, mono=False):
    rows = wrap(text, size, width, weight, mono)
    return [tx(x, y + i * lh, row, fg, bg, p, size, weight, mono=mono) for i, row in enumerate(rows)], len(rows)


def num(cx, cy, n, color, p, r=12):
    TEXT_PAIRS.add(("ink", color))
    return [f'<circle cx="{cx:g}" cy="{cy:g}" r="{r}" fill="{p[color]}"/>', t(cx, cy + 4.5, str(n), p["ink"], 13, 700, "middle")]


def glyph(name, x, y, size, color, bg, p):
    MARK_PAIRS.add((color, bg))
    return icon(name, x, y, size, p[color])


def heading(x, title, sub, p, ty):
    top = 44 if ty.narrow else 48
    out = [tx(x, top, title, "text", "bg", p, ty.h1, 700)]
    out += [tx(x, top + 26 + i * 20, s, "muted", "bg", p, 14.5) for i, s in enumerate(sub)]
    return out, top + 26 + 20 * (len(sub) - 1)


def box(x, y, w, title, detail, p, ty, name=None, accent="muted", strong=False, fill="box"):
    """Titled component card; returns (elements, height)."""
    left, right = x + (48 if name else 18), x + w - 16
    fit(title, ty.title, right - left, 600)
    out = [glyph(name, x + 16, y + 14, 22, accent, fill, p)] if name else []
    out.append(tx(left, y + 32, title, "text", fill, p, ty.title, 600))
    rows, count = lines(left, y + 56, detail, "muted", fill, p, ty.body, right - left, ty.lh)
    h = 56 + ty.lh * (count - 1) + 18
    if strong:
        MARK_PAIRS.add((accent, "card"))
    return [rect(x, y, w, h, p[fill], p[accent if strong else "line"], 12, width=2 if strong else 1.5)] + out + rows, h


def boundary(x, y, w, n, label, p, bg="card"):
    """A trust boundary: dashed rose line with its number and name."""
    MARK_PAIRS.add(("rose", bg))
    lw = est(label.upper(), 12, 700, spacing=1.3)
    return [line(x, y, x + w, y, p["rose"], 2, "6 5"), *num(x + 22, y, n, "rose", p),
            rect(x + 40, y - 11, lw + 16, 22, p[bg], "none", 4, width=0), cap(x + 48, y + 4.5, label, "rose", bg, p)]


# ---------------------------------------------------------------- 1. boundaries

VIEWER = [
    ("window", "Orbit windows", "Sandboxed renderer with context isolation, no Node.js and a strict CSP. "
                                "It holds no keys, tokens or URLs."),
    ("chip", "Main process", "TLS client. Pins the host before sending a byte, re-checks the TLS suite and "
                             "checks every field the host sends."),
    ("server", "Local Orbit host", "Holds this computer's identity and gives its key to main only. "
                                   "Listens on 127.0.0.1:47831."),
]
HOST = [
    ("server", "Remote listener", "Tailscale IPv4 only, port 47832. HTTP/1.1 inside mutual TLS."),
    ("shield", "Session services", "Frames, stream, input, clipboard, files and power. Each needs its own grant."),
    ("clock", "Audit log", "Pairings, refusals, sessions, clipboard and power events. Local and bounded."),
    ("monitor", "Signed-in desktop", "Orbit runs as the user. UAC, the lock screen and macOS privacy consent still apply."),
]
CHECKS = [
    (1, "IPC bridge", "Renderer to main. Named actions only, from the exact bundled page and its main frame; "
                      "screen windows are bound to one session and monitor.", "main.cjs · preload.cjs"),
    (2, "Main-process checks", "Certificate pin before the first byte, TLS suite re-checked, and every name, grant, "
                               "monitor, file name and error text from the host checked.", "transport.cjs · peer-data.cjs"),
    (3, "Local control channel", "Loopback only. Fresh bearer token per launch; browser and DNS-rebinding requests "
                                 "refused; main checks a child proof before sending the token.", "Program.cs · local-control.cjs"),
    (4, "Tailscale", "Only nodes your tailnet lets through can reach port 47832, over WireGuard. "
                     "This identifies a node, not a person.", "TailscaleNetwork.cs"),
    (5, "Remote listener", "Before any route: connection cap, mutual TLS and link policy, per-address rate limit, "
                           "source check, then the certificate pin and revocation.", "Program.cs · RemoteAdmission.cs"),
    (6, "Per-request authority", "Owner block, device and session grants, session ownership and resume epoch, "
                                 "re-checked after every wait and native step.", "SessionAccess.cs · HostState.cs"),
    (7, "Operating system", "Runs as the signed-in user, with no shell and no elevation. Fixed key list; "
                            "files stay in one folder.", "Platform/ · Security.cs"),
]


def column(x, y, w, role, name, items, p, ty, marks, strong, gutter=0, min_h=0):
    """A computer card with three stacked components separated by boundaries.

    marks: {index: (number, label)} draws a boundary above component `index`.
    Returns (elements, height, component boxes as (top, height))."""
    bx, bw = x + 20, w - 40 - gutter
    out = [mark(x + 24, y + 24, 30, p["mint"]), cap(x + 66, y + 36, role, "muted", "card", p),
           tx(x + 66, y + 56, name, "text", "card", p, 19, 700)]
    MARK_PAIRS.add(("mint", "card"))
    by, boxes = y + 80, []
    for i, (glyph_name, title, detail) in enumerate(items):
        if i in marks:
            n, label = marks[i]
            out += boundary(x, by + 28, w, n, label, p)
            by += 56
        elif i:
            by += 24
        els, h = box(bx, by, bw, title, detail, p, ty, glyph_name, "mint", strong=(i == strong))
        out += els
        boxes.append((by, h))
        by += h
    height = max(by + 20 - y, min_h)
    return [rect(x, y, w, height, p["card"], p["line"], 18)] + out, height, boxes


def network_band(x, y, w, h, p, ty, narrow=False, captions=()):
    """Tailscale band holding the mutual-TLS band, labels at the top left."""
    out = [rect(x, y, w, h, p["blue_bg"], p["blue"], 22, dash="7 6", width=2), *num(x + 28, y + 28, 4, "rose", p),
           cap(x + 50, y + 33, "Tailscale · WireGuard", "blue", "blue_bg", p)]
    MARK_PAIRS.update({("blue", "bg"), ("mint", "blue_bg")})
    rows, count = lines(x + 20, y + 58, "Only tailnet nodes reach port 47832.", "muted", "blue_bg", p, ty.small,
                        w - 40 if narrow else 220, 19)
    out += rows
    iy = y + 58 + 19 * (count - 1) + 22
    out += [rect(x + 14, iy, w - 28, y + h - 14 - iy, p["mint_bg"], p["mint"], 16, width=2),
            cap(x + 30, iy + 29, "Orbit mutual TLS", "mint", "mint_bg", p)]
    rows, _ = lines(x + 30, iy + 51, "TLS 1.3, or 1.2 with ECDHE + AEAD.", "text", "mint_bg", p, ty.small,
                    w - 60 if narrow else 200, 19)
    base = y + h - 14 - 22 - 19 * (len(captions) - 1)
    for i, caption in enumerate(captions):
        fit(caption, ty.small, w - 60)
        rows.append(tx(x + 30, base + 19 * i, caption, "muted", "mint_bg", p, ty.small))
    return out + rows


def legend_item(x, y, w, item, p, ty):
    n, title, detail, files = item
    out = [*num(x + 14, y + 14, n, "rose", p), tx(x + 38, y + 19, title, "text", "bg", p, ty.title, 600)]
    rows, count = lines(x + 38, y + 19 + ty.lh + 2, detail, "muted", "bg", p, ty.body, w - 38, ty.lh)
    base = y + 19 + ty.lh + 2 + ty.lh * (count - 1)
    fit(files, 12.5, w - 38, mono=True)
    out += rows + [tx(x + 38, base + ty.lh + 2, files, "muted", "bg", p, 12.5, mono=True)]
    return out, base + ty.lh + 2 - y + 6


def boundaries_wide(p, ty):
    body, _ = heading(36, "Trust boundaries and where each check runs",
                      ["Computer A views computer B. Red dashed lines are trust boundaries; each number marks a check."],
                      p, ty)
    marks_a, marks_b = {1: (1, "IPC bridge"), 2: (3, "Local control")}, {3: (7, "Operating system")}
    _, ah, _ = column(36, 100, 372, "Computer A", "Viewer", VIEWER, p, ty, marks_a, 1)
    _, bh, _ = column(792, 100, 372, "Computer B", "Being viewed", HOST, p, ty, marks_b, 0)
    height = max(ah, bh)
    a, ah, abox = column(36, 100, 372, "Computer A", "Viewer", VIEWER, p, ty, marks_a, 1, min_h=height)
    b, bh, bbox = column(792, 100, 372, "Computer B", "Being viewed", HOST, p, ty, marks_b, 0, min_h=height)
    band = network_band(428, 100, 344, height, p, ty, captions=["Requests go out; frames and stream",
                                                                "records come back. Relays see only",
                                                                "WireGuard ciphertext, with Orbit's",
                                                                "TLS inside it."])
    main_top, main_h = abox[1]
    lst_top, lst_h = bbox[0]
    ym, yl = main_top + main_h / 2, lst_top + lst_h / 2
    MARK_PAIRS.add(("mint", "mint_bg"))
    curve = (f'<path d="M388 {ym:g} C600 {ym:g} 600 {yl:g} 812 {yl:g}" fill="none" stroke="{p["mint"]}" '
             f'stroke-width="2.5" marker-end="url(#h-mint)" marker-start="url(#t-mint)"/>')
    body += band + a + b + [curve]
    body += num(388 - 6, main_top - 2, 2, "rose", p) + num(812 + 6, lst_top - 2, 5, "rose", p)
    sy, sh = bbox[1]
    body += num(812 + 6, sy - 2, 6, "rose", p)
    y = 100 + height + 34
    body.append(cap(36, y, "Checks", "muted", "bg", p))
    y += 18
    cw, out_h = 548, []
    for col, items in enumerate((CHECKS[:4], CHECKS[4:])):
        cy = y
        for item in items:
            els, h = legend_item(36 + col * (cw + 32), cy, cw, item, p, ty)
            body += els
            cy += h + 14
        out_h.append(cy)
    return 1200, max(out_h) + 16, body


def boundaries_narrow(p, ty):
    body, yb = heading(24, "Trust boundaries", ["Computer A views computer B. Red dashed lines", "are trust boundaries; each number marks a check."],
                       p, ty)
    y = yb + 26
    a, ah, abox = column(24, y, 552, "Computer A", "Viewer", VIEWER, p, ty, {1: (1, "IPC bridge"), 2: (3, "Local control")},
                         1, gutter=36)
    by = y + ah + 24
    band_h = 160
    band = network_band(24, by, 552, band_h, p, ty, narrow=True)
    hy = by + band_h + 24
    b, bh, bbox = column(24, hy, 552, "Computer B", "Being viewed", HOST, p, ty, {3: (7, "Operating system")}, 0, gutter=36)
    right = 24 + 20 + 552 - 40 - 36
    main_top, main_h = abox[1]
    lst_top, lst_h = bbox[0]
    ym, yl = main_top + main_h / 2, lst_top + lst_h / 2
    link = route([(right, ym), (552, ym), (552, yl), (right, yl)], p, "mint", 14, 2.5, both=True)
    body += a + band + b + [link]
    body += num(right - 6, main_top - 2, 2, "rose", p) + num(right - 6, lst_top - 2, 5, "rose", p)
    sy, _ = bbox[1]
    body += num(right - 6, sy - 2, 6, "rose", p)
    y = hy + bh + 34
    body.append(cap(24, y, "Checks", "muted", "bg", p))
    y += 18
    for item in CHECKS:
        els, h = legend_item(24, y, 552, item, p, ty)
        body += els
        y += h + 14
    return 600, y + 14, body


# ---------------------------------------------------------------- 2. attackers

DEFENCES = [("Tailscale reach", "Tailscale reach"), ("Pre-auth limits", "pre-auth limits"), ("mTLS + pin", "mTLS + pin"),
            ("Invite", "invite"), ("Grants per request", "grants"), ("Local control channel", "local control channel"),
            ("Key storage", "key storage"), ("Electron sandbox, IPC", "Electron sandbox and IPC"),
            ("Launch policy, fuses", "launch policy and fuses"), ("Peer-data checks", "peer-data checks"),
            ("Supply chain controls", "supply-chain controls")]
# S stops it, L limits it, P does not stop it, N not relevant. Columns follow DEFENCES.
ATTACKERS = [
    ("network", "Tailnet peer, no invite", "Reaches the port; cannot pair", "PLSSNNNNNNN"),
    ("link", "Paired peer, limited grants", "Uses only what it was granted", "PLPNSNNNNNN"),
    ("monitor", "Malicious paired host", "Controls what you see, not your PC", "PNPSNNNSNSN"),
    ("user", "Another local user", "Needs a token or a paired key", "PLSSNSSNNNN"),
    ("bug", "Malware running as you", "Outside the boundary: acts as you", "PNPPNPPPLNN"),
    ("window", "A website you visit", "Refused by every Orbit listener", "PNSNNSNSNNN"),
    ("package", "A compromised dependency", "Runs with the app's own rights", "NNNNNNPLNNL"),
]
KINDS = {"S": ("Stops it", "mint"), "L": ("Limits it", "gold"), "P": ("Does not stop it", "rose"), "N": ("Not relevant", "muted")}


def symbol(cx, cy, kind, p, bg):
    color = KINDS[kind][1]
    MARK_PAIRS.add((color, bg))
    c = p[color]
    if kind == "S":
        return [f'<circle cx="{cx:g}" cy="{cy:g}" r="8.5" fill="{c}"/>']
    if kind == "L":
        return [f'<circle cx="{cx:g}" cy="{cy:g}" r="7.5" fill="none" stroke="{c}" stroke-width="2"/>',
                f'<path d="M{cx:g} {cy - 7.5:g}A7.5 7.5 0 0 0 {cx:g} {cy + 7.5:g}Z" fill="{c}"/>']
    if kind == "P":
        return [f'<circle cx="{cx:g}" cy="{cy:g}" r="7.5" fill="none" stroke="{c}" stroke-width="2"/>']
    return [line(cx - 6, cy, cx + 6, cy, c, 2)]


def kinds_legend(x, y, p, rows):
    out = []
    for r, keys in enumerate(rows):
        cx = x
        for key in keys:
            label = KINDS[key][0]
            out += symbol(cx + 9, y + r * 26 - 4.5, key, p, "bg") + [tx(cx + 26, y + r * 26, label, "text", "bg", p, 13)]
            cx += 26 + est(label, 13) + 30
    return out


def attackers_wide(p, ty):
    body, _ = heading(36, "Who is stopped where",
                      ["Seven attacker positions against Orbit's defences. Rows read left to right, outside in."], p, ty)
    body += kinds_legend(36, 112, p, [["S", "L", "P", "N"]])
    x0, label_w = 36, 300
    cw = (1128 - label_w) / len(DEFENCES)
    hy = 146
    header_rows = [wrap(name, 12, cw - 8, 600) for name, _ in DEFENCES]
    depth = max(len(r) for r in header_rows)
    for i, rows in enumerate(header_rows):
        cx = x0 + label_w + cw * (i + 0.5)
        top = hy + 16 * (depth - len(rows))
        body += [tx(cx, top + 14 + 16 * j, row, "text", "bg", p, 12, 600, "middle") for j, row in enumerate(rows)]
    y = hy + 16 * depth + 12
    body.append(line(x0, y, x0 + 1128, y, p["line"], 1.5))
    rh = 62
    for r, (name, title, sub, cells) in enumerate(ATTACKERS):
        ry = y + r * rh
        bg = "card" if r % 2 == 0 else "bg"
        if bg == "card":
            body.append(rect(x0, ry + 2, 1128, rh - 4, p["card"], "none", 10, width=0))
        fit(title, 14, label_w - 60, 600)
        fit(sub, 12.5, label_w - 60)
        body += [glyph(name, x0 + 14, ry + 19, 22, "muted", bg, p), tx(x0 + 48, ry + 27, title, "text", bg, p, 14, 600),
                 tx(x0 + 48, ry + 46, sub, "muted", bg, p, 12.5)]
        for i, kind in enumerate(cells):
            body += symbol(x0 + label_w + cw * (i + 0.5), ry + rh / 2, kind, p, bg)
    for i in range(1, len(DEFENCES)):
        cx = x0 + label_w + cw * i
        body.append(line(cx, hy, cx, y + rh * len(ATTACKERS), p["line"], 1, "2 5"))
    y += rh * len(ATTACKERS) + 26
    note = ("Pre-auth limits bound denial of service; they never grant or deny access. Same-user malware is outside "
            "Orbit's boundary; the launch policy only raises its cost.")
    rows, count = lines(36, y, note, "muted", "bg", p, 13, 1128, 20)
    return 1200, y + 20 * (count - 1) + 30, body + rows


def attackers_narrow(p, ty):
    body, yb = heading(24, "Who is stopped where", ["Seven attacker positions against", "Orbit's defences."], p, ty)
    y = yb + 24
    body += kinds_legend(24, y + 4, p, [["S", "L"], ["P", "N"]])
    y += 26 + 26
    for name, title, sub, cells in ATTACKERS:
        top = y
        inner = [glyph(name, 40, y + 16, 24, "muted", "card", p), tx(76, y + 34, title, "text", "card", p, ty.title, 600),
                 tx(76, y + 56, sub, "muted", "card", p, ty.body)]
        fit(title, ty.title, 480, 600)
        fit(sub, ty.body, 480)
        cy = y + 72
        for key, lead in (("S", "Stopped by"), ("L", "Limited by"), ("P", "Not stopped by")):
            names = [DEFENCES[i][1] for i, k in enumerate(cells) if k == key]
            if not names:
                continue
            text = f"{lead}: " + ", ".join(names)
            rows, count = lines(76, cy + 18, text, "text", "card", p, ty.body, 480, ty.lh)
            inner += symbol(52, cy + 13, key, p, "card") + rows
            cy += 18 + ty.lh * (count - 1) + 12
        y = cy + 8
        body += [rect(24, top, 552, y - top, p["card"], p["line"], 16)] + inner
        y += 14
    note = ("Pre-auth limits bound denial of service; they never grant or deny access. Same-user malware is outside "
            "Orbit's boundary; the launch policy only raises its cost.")
    rows, count = lines(24, y + 12, note, "muted", "bg", p, ty.body, 552, ty.lh)
    return 600, y + 12 + ty.lh * (count - 1) + 30, body + rows


# ---------------------------------------------------------------- 3. request path

PHASES = [
    ("Before TLS", [
        ("Connection budget", "At most 128 open remote connections, and 32 from one source address.", "Socket closed"),
    ]),
    ("TLS handshake", [
        ("Client certificate", "Required on every connection, even pairing; must be valid for client use.",
         "Handshake refused · audited"),
        ("Link policy", "TLS 1.3, or TLS 1.2 with ECDHE and AEAD; checked before HTTP is parsed.", "Dropped · audited"),
    ]),
    ("Every request", [
        ("Browser check", "Origin or Sec-Fetch-Site headers are refused; body size capped per route.", "403"),
        ("Rate limit per address", "120 a second (burst 160); pairing 6 a minute. Unpaired requests count too.", "429"),
        ("Source check", "tailscale whois on the socket address; one lookup per address, cached.", "403 · audited"),
        ("Certificate pin", "SHA-256 must match an unrevoked pairing; /api/pair needs a valid invite.", "401 · audited"),
    ]),
    ("Route and session", [
        ("Owner decision", "Re-read on every route: revoked since, or blocked by the owner.", "401 · 403 ended_by_owner"),
        ("Grants and session", "Both device and session grant; own session; current resume epoch.", "404 · 410 if stale"),
        ("Per-device limits", "Clipboard 5 then 2/s; sessions 4 then 1/s; one controller, one slot kept.", "429 · 409"),
    ]),
]
FINAL = ("Handler runs", "Authority re-checked after each wait and native step; streams every 250 ms.")


def reject_chip(x, y, w, text, p, ty):
    MARK_PAIRS.add(("rose", "bg"))
    size = ty.small
    fit(text, size, w - 24, 600)
    return [rect(x, y, w, 30, p["rose_bg"], p["rose"], 15, width=1.3),
            tx(x + w / 2, y + 20, text, "rose", "rose_bg", p, size, 600, "middle")]


def step(x, y, w, n, title, detail, p, ty, color="mint", fill="box", strong=False):
    fit(title, ty.title, w - 76, 600)
    out = [*num(x + 28, y + 27, n, color, p), tx(x + 56, y + 32, title, "text", fill, p, ty.title, 600)]
    rows, count = lines(x + 56, y + 32 + ty.lh + 2, detail, "muted", fill, p, ty.body, w - 76, ty.lh)
    h = 32 + ty.lh + 2 + ty.lh * (count - 1) + 18
    if strong:
        MARK_PAIRS.add((color, "bg"))
    return [rect(x, y, w, h, p[fill], p[color] if strong else p["line"], 12, width=2 if strong else 1.5)] + out + rows, h


def path_wide(p, ty):
    body, _ = heading(36, "How the host authorises a remote request",
                      ["Steps run in this order. The first one that fails answers the request, and nothing after it runs."],
                      p, ty)
    sx, sw, rx, rw = 228, 640, 916, 248
    body.append(cap(rx + rw / 2, 100, "If the step fails", "rose", "bg", p, "middle"))
    y, n = 112, 1
    for phase, steps in PHASES:
        top = y
        for title, detail, reject in steps:
            els, h = step(sx, y, sw, n, title, detail, p, ty)
            body += els + [arrow(sx + sw + 6, y + h / 2, rx - 6, y + h / 2, p, "rose")]
            body += reject_chip(rx, y + h / 2 - 15, rw, reject, p, ty)
            y += h
            body.append(arrow(sx + 28, y + 3, sx + 28, y + 23, p, "mint"))
            y += 26
            n += 1
        bottom = y - 26
        MARK_PAIRS.add(("muted", "bg"))
        body += [line(204, top + 6, 204, bottom - 6, p["muted"], 2), line(196, top + 6, 204, top + 6, p["muted"], 2),
                 line(196, bottom - 6, 204, bottom - 6, p["muted"], 2)]
        rows = wrap(phase.upper(), 12, 150, 700)
        body += [cap(186, top + 22 + 18 * i, row, "muted", "bg", p, "end") for i, row in enumerate(rows)]
        y += 8
    y -= 8
    els, h = step(sx, y, sw, "✓", FINAL[0], FINAL[1], p, ty, "mint", "mint_bg", strong=True)
    body += els
    return 1200, y + h + 36, body


def path_narrow(p, ty):
    body, yb = heading(24, "Authorising a request", ["Steps run in order. The first failed step", "answers; nothing after it runs."], p, ty)
    y, n = yb + 22, 1
    for phase, steps in PHASES:
        y += 22
        body.append(cap(24, y + 4, phase, "muted", "bg", p))
        y += 18
        for title, detail, reject in steps:
            els, h = step(24, y, 552, n, title, detail, p, ty)
            text = "If it fails: " + reject
            body += els + reject_chip(80, y + h + 10, 24 + est(text, ty.small, 600) + 4, text, p, ty)
            body.append(arrow(52, y + h + 3, 52, y + h + 43, p, "mint"))
            y += h + 46
            n += 1
    els, h = step(24, y, 552, "✓", FINAL[0], FINAL[1], p, ty, "mint", "mint_bg", strong=True)
    return 600, y + h + 28, body + els


# ---------------------------------------------------------------- output and checks

FIGURES = {
    "security-boundaries": (boundaries_wide, boundaries_narrow, "Orbit Remote trust boundaries",
                            "Computer A, the viewer, runs sandboxed Orbit windows, a main process and its own local Orbit "
                            "host; computer B runs a remote listener, session services and the signed-in desktop. "
                            "Numbered checks: 1, the IPC bridge between windows and the main process; 2, the main process "
                            "pins the host certificate before the first byte, re-checks the TLS suite and checks every field "
                            "the host sends; 3, the loopback local control channel with a per-launch bearer token, browser "
                            "and DNS-rebinding refusal and a child proof; 4, Tailscale, which lets only tailnet nodes reach "
                            "port 47832 over WireGuard, inside which Orbit runs mutual TLS; 5, the remote listener applies "
                            "a connection cap, mutual TLS and link policy, a rate limit, the source check and the "
                            "certificate pin; 6, per-request authority: owner block, grants, session ownership and resume "
                            "epoch; 7, the operating system boundary: Orbit runs as the signed-in user with no shell or "
                            "elevation."),
    "security-attackers": (attackers_wide, attackers_narrow, "Orbit Remote attacker positions and defences",
                           "A matrix of seven attacker positions against eleven defences. A tailnet peer without an "
                           "invite is stopped by mutual TLS with the certificate pin and by the invite, and limited by "
                           "pre-authentication limits. A paired peer with limited grants is stopped by per-request "
                           "grants. A malicious paired host is stopped by the invite (it cannot view you back), the "
                           "Electron sandbox and IPC, and peer-data checks. Another local user is stopped by mutual TLS, "
                           "the invite, the local control channel token and key storage. Malware running as the user is "
                           "outside the boundary; the launch policy only limits it. A website is stopped by mutual TLS, "
                           "the local control channel's browser refusal and the Electron app, which registers no protocol "
                           "handler. A compromised dependency runs with the app's rights; the Electron sandbox and "
                           "supply-chain controls only limit it. Pre-auth limits bound denial of service only."),
    "security-request-path": (path_wide, path_narrow, "Orbit Remote request authorisation path",
                              "Ten checks in order. Before TLS: a connection budget of 128 connections, 32 per source; "
                              "otherwise the socket is closed. During the TLS handshake: a usable client certificate, or "
                              "the handshake fails and is audited; the link policy, or the connection is dropped. On "
                              "every request: browser headers refused with 403; a per-address rate limit of 120 a second "
                              "and 6 pairing requests a minute, 429; the Tailscale source check, 403 and audited; the "
                              "certificate pin against an unrevoked pairing, 401 and audited. On the route: the owner "
                              "decision, 401 if revoked or 403 ended_by_owner if blocked; device and session grants, "
                              "session ownership and resume epoch, 404 or 410; per-device limits, 429 or 409. Then the "
                              "handler runs and re-checks authority after every wait and native step; streams re-check "
                              "every 250 ms."),
}


def luminance(hex_colour):
    channels = [int(hex_colour[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    lin = [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in channels]
    return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]


def contrast(a, b):
    la, lb = sorted((luminance(a), luminance(b)), reverse=True)
    return (la + 0.05) / (lb + 0.05)


def check_contrast():
    """Every recorded pair in both themes: text >= 4.5:1, symbols >= 3:1. Returns the weakest of each."""
    weakest = {}
    for kind, pairs, minimum in (("text", TEXT_PAIRS, 4.5), ("symbol", MARK_PAIRS, 3.0)):
        worst = None
        for theme, p in THEMES.items():
            for fg, bg in sorted(pairs):
                ratio = contrast(p[fg], p[bg])
                assert ratio >= minimum, f"{theme}: {kind} {fg} on {bg} is {ratio:.2f}:1, below {minimum}:1"
                if worst is None or ratio < worst[0]:
                    worst = (ratio, theme, fg, bg)
        weakest[kind] = worst
    return weakest


def main():
    written = []
    for name, (wide, narrow, title, desc) in FIGURES.items():
        for theme, palette in THEMES.items():
            suffix = "" if theme == "dark" else "-light"
            for layout, draw in (("", wide), ("-narrow", narrow)):
                width, height, body = draw(palette, Type(layout == "-narrow"))
                svg = document(width, height, body, palette, title, desc)
                sizes = [float(s) for s in re.findall(r'font-size="([\d.]+)"', svg)]
                assert min(sizes) >= 12, f"{name}{layout}{suffix}: text below 12 px"
                path = OUT / f"{name}{layout}{suffix}.svg"
                path.write_text(svg, encoding="utf-8", newline="\n")
                written.append(path.name)
    weakest = check_contrast()
    print(f"Wrote {len(written)} figures to {OUT}")
    for kind, (ratio, theme, fg, bg) in weakest.items():
        print(f"Lowest {kind} contrast: {ratio:.2f}:1 ({theme}, {fg} on {bg}); "
              f"{len(TEXT_PAIRS if kind == 'text' else MARK_PAIRS)} colour pairs checked in both themes")


if __name__ == "__main__":
    main()
