# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

Converts Illustrator SVG artwork into KiCad PCB `gr_poly` shapes — an outline path becomes `Edge.Cuts`, everything else becomes openings on a chosen KiCad layer (default `F.Mask`), and compound letter paths (O, B, P, D…) get their counter-holes bridged into ring polygons so KiCad renders them as holes, not solid disks.

There are **two independent implementations of the same conversion algorithm**, not a shared library used by both:

- `svg2kicad_cli.py` — a Python CLI using `svgpathtools`, writes a `.kicad_pcb` file to disk.
- `converter.js` + `ui.js` + `index.html` + `styles.css` — a static, dependency-free web app (no server, no build step) that does the same conversion in the browser and copies the result to the clipboard for pasting directly into KiCad's PCB editor.

**Any change to the conversion algorithm (sampling, ring-bridging, layer/outline detection, degenerate-shape filtering, output format) must be made in both `svg2kicad_cli.py` and `converter.js` by hand.** They are not required to byte-match, but should stay behaviorally equivalent — see "Sampling differs by design" below for the one intentional divergence.

## Commands

Run the CLI (requires `pip install svgpathtools`):
```bash
python svg2kicad_cli.py input.svg [output.kicad_pcb]
```

Run the web app — no build/install step, it's plain static files:
```bash
open index.html
```

There is no test suite, linter, or build tooling in this repo. To sanity-check a change to `converter.js`, load `index.html` in a browser and drive `window.Converter` from devtools:
```js
const result = window.Converter.parseSvg(svgText);
console.log(result.stats); // { edgeCount, maskCount, ringCount, skipped }
```
Compare those counts against the CLI's four printed lines (`Edge.Cuts:`, `F.Mask:`, `Ring polys:`, `Skipped:`) for the same input file — they should match. For anything more thorough, a real browser session (e.g. via Playwright) can call `window.Converter.parseSvg`/`renderKicadText` directly against a real `index.html` page loaded over `file://`, since `getTotalLength()`/`getPointAtLength()` need a real rendering engine (jsdom doesn't implement them).

## Architecture

### Shared domain logic (implemented twice)

- **Outline detection**: a path is the board outline if its `id` (lowercased, non-alphanumeric characters stripped, so `EdgeCuts_1_` → `edgecuts1`) contains `"edgecuts"`, or — for backward compatibility with older files — its `class` contains `cls-2` (Illustrator's old auto-generated style class, not something the user names directly). Everything else is "artwork" and goes to the user-selected layer. The `EdgeCuts` convention is produced by naming the outline object's layer in Illustrator and exporting with **Object IDs → Layer Names**.
- **Compound-path / ring bridging**: a raw `d` string is split into subpaths on the `Z...M` boundary (regex: `(?<=[Zz])\s*(?=[Mm])`, handles `ZM` with no space). Each subpath is sampled into points, filtered by a minimum size (`MIN_DIM_MM = 0.02`), then the surviving candidates are sorted by signed area; the largest and most-negative (outer boundary + innermost hole) are bridged into one ring polygon via nearest-point rotation (`make_ring_polygon` / `makeRingPolygon`). **Intentional, preserved quirk**: if 3+ candidates survive (e.g. a shape with two separate holes), only the two extremes are bridged — any middle candidate is silently dropped, not counted as skipped. Don't "fix" this without discussing it — it's parity with the original CLI, not a bug.
- **Units**: `SCALE = 25.4 / 72` converts raw SVG `d`-attribute units (assumed to be points, Illustrator's default) to mm. Neither implementation applies `viewBox` or `transform` scaling — both operate directly on raw path coordinates.
- **Output**: a full `(kicad_pcb (version...) (generator...) (general...) (paper...) (layers...) <gr_poly items>)` document (see `HEADER` in each file for the exact layer table). Outline shapes render unfilled with `width 0.05` on `Edge.Cuts`; artwork shapes render filled with `width 0` on whatever layer was selected.

### Sampling differs by design

- Python (`path_to_pts`) samples **per Bezier/Line segment** from `svgpathtools`, each with its own point count (`clamp(length_mm/0.05, 4, 512)`).
- JS (`sampleSubpath` in `converter.js`) samples **per whole subpath** using a single hidden, persistent `<svg><path></path></svg>` and `getTotalLength()`/`getPointAtLength()` — no bezier-math library needed, but no per-segment breakdown either. Constants: `mmPerSample = 0.05`, `minPoints = 8`, `maxPoints = 2000`.

This means the two implementations won't produce byte-identical polygons for the same input, but should be visually/functionally equivalent for PCB artwork. If you need to change sampling density, the JS constants live at the top of `converter.js`; the Python ones are `path_to_pts`'s default args and the `max(4, min(512, ...))` clamp.

### converter.js / ui.js split

- `converter.js` is pure conversion logic with zero DOM-UI coupling (aside from the one hidden sampling `<path>`), exposed as `window.Converter = { parseSvg, renderKicadText }`.
  - `parseSvg(svgText)` is the expensive step — parses and samples every path once, returns `{ edgeSegs, maskSegs, stats }`.
  - `renderKicadText(edgeSegs, maskSegs, artworkLayer)` is cheap and pure — re-run this on every layer-dropdown change, never re-parse.
- `ui.js` owns all DOM wiring: drag-and-drop + file input, the layer `<select>` (a "common layers" `<optgroup>` always visible, a "more layers" `<optgroup>` behind a disclosure toggle — the full list mirrors `HEADER`'s layer table), stats display, and the copy button.
- **Clipboard copy is three-tiered** (in `ui.js`), because `file://` pages have inconsistent Clipboard API support: try `navigator.clipboard.writeText()` first, fall back to a hidden off-screen `<textarea>` + `document.execCommand('copy')`, and as a last resort make that same textarea visible so the user can manually Cmd/Ctrl+C. Don't replace `execCommand` without keeping an equivalent last-resort tier — it's deprecated but still the only thing that reliably works with zero permissions.
- Plain `<script defer>` tags, no ES modules — `type="module"` has stricter `file://` restrictions in some browsers and this app needs to double-click-and-open cleanly.

### Deployment

The web app is published via GitHub Pages at `https://synthux-academy.github.io/svg2kicad/`, served straight from the `main` branch root — any push to `main` redeploys automatically, no build step. The repo is public (required for Pages on this org's free plan).

## Keeping docs in sync

When you add a feature or change behavior (new layer options, a different outline-detection rule, a new clipboard fallback, etc.), update `README.md` (user-facing usage) and this file (architecture/behavior notes) in the same change — don't leave them describing the old behavior.
