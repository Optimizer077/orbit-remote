# Orbit Remote identity

Orbit is a calm place to reach your own computers. The voice is direct, warm,
and precise about what is connected, who has access, and what a command does.
The line **Your world. Within reach.** describes the product; **Private. By
design.** describes its intent, not a security certification.

## Logo and application icon

![Orbit Remote wordmark](assets/brand/logo.svg)

The original orbital mark combines a circle, a tilted ellipse, a central device,
and a connected satellite. The lowercase `orbit.` wordmark is original vector
geometry; the dot and satellite share the theme accent. No stock icon, font
outline, or third-party logo is embedded.

- [Default wordmark, for dark surfaces](assets/brand/logo.svg)
- [Light-surface wordmark](assets/brand/logo-light.svg)
- [Midnight wordmark](assets/brand/logo-midnight.svg)
- [Standalone teal mark](assets/brand/mark.svg)
- [Canonical app icon](../apps/desktop/build/icons/icon.svg)
- [Native icon size preview](assets/brand/icon-preview.png)
- [Complete identity sheet](assets/brand/brand-sheet.png)

**Logo colours.** The mark is vivid teal and the wordmark ink is deep navy or
near-white, taken from the Daylight and Graphite theme tokens. The geometry is
unchanged from the original mint mark; only the colours moved.

| Use | Mark and dot | Wordmark ink | Contrast of mark (WCAG non-text, 3:1) |
|---|---|---|---|
| Light surfaces (`logo-light.svg`, `mark-light.svg`) | `#008577` (Daylight accent) | `#0b1d3a` | 4.54:1 on `#ffffff`, 4.01:1 on `#edf1f7` |
| Dark and navy surfaces (`logo.svg`, `logo-dark.svg`, `mark.svg`) | `#2dd4bf` (sidebar accent) | `#f4f7fb` | 9.02:1 on navy `#0b1d3a`, 9.80:1 on Graphite `#0f1522`, 10.57:1 on `#070b14` |
| App icon and Windows/Linux tray tile | `#2dd4bf` on a `#0b1d3a` → `#070b14` navy tile | none | 9.02:1 at the top of the tile, 10.57:1 at the bottom |
| Midnight (`logo-midnight.svg`, `mark-midnight.svg`) | `#aecaff` | `#f4f7fb` | unchanged |

In the app, `BrandMark` and `BrandWordmark` take their colour from the theme's
`--accent` and `--text` tokens, so the sidebar mark is `#2dd4bf` on Daylight's
navy sidebar and `#1fd6b9` on Graphite (10.66:1 on `#070b14`).

Keep the original proportions and at least one central-dot diameter of clear
space around the mark. Use the complete wordmark at 165px wide or larger; use
the standalone mark at smaller sizes. The native app icon has its own rounded
surface and transparent corner margins. Do not put a second rounded container
behind it. Do not put glow, gradients, or motion into status-bearing glyphs.

Windows `.ico` includes 16, 24, 32, 48, 64, 128, and 256px representations.
macOS `.icns` includes Retina representations up to 1024px. The shared app PNG
is 1024px with alpha.

**Optical sizes.** At 48px and below, icons are drawn for their pixel grid
instead of being shrunk from the 1024px master, which would turn the stroke
into a 0.4px smear at 16px. Strokes are set in target pixels (1.3px at 16,
2.1px at 48), the mark grows slightly, and a faint teal edge keeps the tile
visible on dark taskbars up to 32px. At 24px the satellite is dropped. At
16px only the orbit and centre node remain.

Tray images follow Electron's 16px-at-1x convention. Windows/Linux use the
small tiled icon (`tray.png` 16px, `@1.5x` 24px, `@2x` 32px), which stays
visible on both light and dark taskbars; a bare teal glyph disappears on a
light taskbar. macOS uses black template glyphs (`trayTemplate.png` 16px,
`@2x` 32px) that the native application marks as templates so the menu bar
chooses the contrast.

## Palette and type

The two default themes are bold: vivid teal from the eclipse mark on solid
deep-navy chrome, solid primary buttons, crisp borders, and saturated status
fills instead of tints and glows.

| Role | Daylight (light) | Graphite (dark) |
|---|---|---|
| Background | `#edf1f7` | `#0f1522` |
| Sidebar | `#0b1d3a` (navy, light text) | `#070b14` |
| Surface | `#ffffff` | `#1a2233` |
| Primary text | `#0a1428` | `#f4f7fb` |
| Accent / accent ink | `#008577` / `#ffffff` | `#1fd6b9` / `#03221d` |
| Sidebar accent / ink | `#2dd4bf` / `#03201c` | same as accent |
| Success fill / ink | `#037a4b` / `#ffffff` | `#3ddc84` / `#03230f` |
| Warning fill / ink | `#f5a30a` / `#2a1700` | `#ffcb3d` / `#2b1b00` |
| Danger fill / ink | `#d0261e` / `#ffffff` | `#f04438` / `#2b0604` |

Midnight (`#0a1120` background, `#6ea9ff` accent), Paper (`#f5f1e9`,
`#22744b`) and Ember (`#141010`, `#f0a04b`) keep their softer palettes.

These are the renderer's theme tokens. Additional foreground, border,
status-text, and viewer colors live in `renderer/src/styles.css`; preserve
their semantic roles when extending themes. Every text pair meets WCAG AA 4.5:1
and every component or focus colour 3:1; `node tests/theme-contrast.cjs` (from
`apps/desktop`) checks the Daylight and Graphite pairs and the colour-blind
separation of success, warning and danger. Accent does not imply a successful
connection: status must have a text label and an icon, use the real connection
state, and never rely on colour alone.

Use the operating system's UI typeface: Segoe UI Variable / Segoe UI on Windows,
the system font on macOS, and the desktop sans-serif fallback on Linux.
Addresses, diagnostic identifiers, and protocol snippets use the system
monospace stack. Avoid downloadable fonts in the privileged desktop app.

## Motion

Motion should explain a change or make waiting understandable. Hover and focus
responses should finish in roughly 120–180ms; opening panels should finish in
180–260ms. Slow orbital decoration may move only outside the remote desktop
surface. Avoid bouncing controls, flashing indicators, and layout shifts.

Respect `prefers-reduced-motion: reduce`: remove decorative orbiting, pulsing,
and entrance transforms. Loading and connection states must remain readable as
static text; animation must never be the only indication of a connection or
failure. Stop decorative work in hidden views. Never animate captured remote
pixels or obscure control-release actions.

## Rebuild assets

```sh
uv run --no-project --with pillow python docs/assets/brand/generate_brand.py
uv run --no-project --with pillow --with pymupdf python docs/assets/brand/generate_brand_sheet.py
```

The first generator draws matching SVG, PNG, ICO, and ICNS files from original
geometry; the colours are the named constants at its top. The second rebuilds
`brand-sheet.png` and `logo-preview.png` from those files. The README diagrams
in `docs/assets/diagrams/` draw the mark in the same teal family (`mint` in
their `THEMES`: `#2dd4bf` on `#0c463f` dark, `#00756a` on `#ccf2eb` light);
rerun their generators after a palette change. SVG stays editable as source.
Review `icon-preview.png` after any change, especially at 16px and 32px, and
review template contrast in the real macOS menu bar.
