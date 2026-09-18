# svg2kicad — SVG Artwork to KiCad PCB Converter

Converts an SVG artwork file into a KiCad PCB file (`.kicad_pcb`).

- The **board outline** becomes the **Edge.Cuts** layer — either an object/layer named `EdgeCuts` in Illustrator (exported with Object IDs → Layer Names), or the older `cls-2` CSS class convention
- All **other paths** become openings on your chosen KiCad layer (defaults to **F.Mask**)
- **Letter shapes** with counter-holes (O, B, P, D…) are handled correctly — holes render as holes in KiCad, not solid disks

Designed for artwork exported from Adobe Illustrator, but works with any SVG that follows the same conventions.

There are two ways to use it: a **command-line script** (below) and a **drag-and-drop web app**.

---

## Web App

No install needed — just open [`index.html`](index.html) in a browser (double-click it, or `open index.html`).

1. Drag an SVG onto the drop zone (or click it to browse).
2. Pick the KiCad layer the artwork should land on (defaults to F.Mask; click "Show more layers" for the full list).
3. Click **Copy to Clipboard**.
4. In KiCad's PCB Editor, click the canvas and paste (Ctrl/Cmd+V) — the outline and artwork appear on the layers you picked.

It's a static page (`index.html` / `styles.css` / `converter.js` / `ui.js`) with no server or build step — the conversion logic runs entirely in the browser.

---

## Requirements

- Python 3.8 or later
- [svgpathtools](https://github.com/mathandy/svgpathtools)

Install the dependency once:

```bash
pip install svgpathtools
```

---

## Usage

```bash
python svg2kicad_cli.py input.svg
```

This creates `input.kicad_pcb` in the same folder as your SVG.

To specify a custom output path:

```bash
python svg2kicad_cli.py input.svg output.kicad_pcb
```

---

## Example

```bash
cd ~/Desktop
python ~/svg2kicad.py "Touch Bloop.svg"
# → Touch Bloop.kicad_pcb created on your Desktop
```

Open the resulting `.kicad_pcb` file directly in KiCad (File → Open).

---

## How it works

SVG paths are tessellated into polygons and written as `gr_poly` shapes in the KiCad file:

| SVG path class | KiCad layer | Purpose |
|---|---|---|
| `cls-2` | Edge.Cuts | Board outline |
| anything else | F.Mask | Solder-mask opening |

**Compound paths** (a single SVG path that contains both an outer boundary and an inner counter-hole, separated by `Z M` in the path data) are detected automatically. The outer and inner contours are bridged into a single ring polygon so KiCad's fill algorithm renders the annular region correctly.

---

## Notes

- SVG units are assumed to be **points** (1 pt = 1/72 inch), which is the default for Illustrator. Scale factor: `25.4 / 72` points → mm.
- Output targets **KiCad format version 20260206** (KiCad 10). KiCad 8/9 will open it with a version warning but work fine.
- Shapes smaller than 0.02 mm in both dimensions are skipped as degenerate.
