# svg2kicad — SVG Artwork to KiCad PCB Converter

**[Open the web app →](https://synthux-academy.github.io/svg2kicad/)**

Converts an SVG artwork file into a KiCad PCB file (`.kicad_pcb`).

- The **board outline** becomes the **Edge.Cuts** layer — either an object/layer named `EdgeCuts` in Illustrator (exported with Object IDs → Layer Names), or the older `cls-2` CSS class convention
- **Named layers** let one SVG mix parts: shapes on an Illustrator layer named `TouchCopper` (exposed touch pad), `TouchBlack` (touch pad under solder mask) or `LEDWindow` get those layers plus a copper keep-out, whatever the settings below say — see [Named layers](#named-layers)
- All **other paths** become openings on your chosen KiCad layer (defaults to **F.Mask**)
- **Letter shapes** with counter-holes (O, B, P, D…) are handled correctly — holes render as holes in KiCad, not solid disks
- Optional **LED window** mode: each artwork shape is placed on F.Mask, B.Mask or both, plus a copper **keep-out zone** with the same outline, so an LED behind the board can shine through — or as a **touch pad**, exposed (F.Cu + F.Mask + keep-out) or **covered** under solder mask (F.Cu + keep-out)
- Optional **anchor point**: shift the whole output so a chosen point of the board outline lands at (0, 0), which is where KiCad anchors pasted content — so pasting drops that point under your cursor, for lining up with the rest of a footprint

Designed for artwork exported from Adobe Illustrator, but works with any SVG that follows the same conventions.

There are two ways to use it: a **command-line script** (below) and a **drag-and-drop web app**.

---

## Web App

No install needed — just open [`index.html`](index.html) in a browser (double-click it, or `open index.html`).

1. Drag an SVG onto the **SVG source** panel (or click it to browse). It shows your source artwork, and the **KiCad shapes** panel shows the converted result: outline in yellow, holes rendered as holes, and each part in its own look — `TouchCopper` as copper, `TouchBlack` black with gray diagonal lines, `LEDWindow` light yellow, other artwork teal. The stats list a count for each [named layer](#named-layers) found, with everything else as "Other artwork". A short "How it works" note with the layer names sits under the Copy button.
2. Pick the KiCad layer the artwork should land on (defaults to F.Mask; click "Show more layers" for the full list). This, and step 3, only apply to artwork that isn't on a named layer.
3. Optionally tick **LED window / touch pad** and pick F.Mask + keep-out, B.Mask + keep-out, F.Mask + B.Mask + keep-out, Touch pad (F.Cu + F.Mask + keep-out), or Covered touch pad (F.Cu + keep-out) (this replaces the artwork layer — see [LED window](#led-window) below). The KiCad preview then shows that artwork in the same look as the matching named layer: LED windows light yellow, touch pad as copper, covered touch pad black with gray diagonal lines. Keep-out zones aren't drawn separately — each one follows its shape's outer outline (see [LED window](#led-window)).
4. Optionally pick an **Anchor point** (defaults to Top-center; your choice carries over across SVG uploads until you change it — pick None for the SVG's own coordinate origin). Picking one of the nine board-outline positions shifts every output coordinate so that point lands at (0, 0) — see [Anchor point](#anchor-point) below.
5. Optionally set a **Scale** factor (defaults to `1`, i.e. 1:1 — no scaling).
6. Click **Copy to Clipboard**.
7. In KiCad's PCB Editor, click the canvas and paste (Ctrl/Cmd+V) — the outline and artwork appear on the layers you picked, scaled as specified, with your chosen anchor point under the cursor.

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

To scale the output (defaults to `1`, i.e. 1:1 — no scaling):

```bash
python svg2kicad_cli.py input.svg --scale 2
```

To export LED windows (`front` = F.Mask, `back` = B.Mask, `both` = F.Mask + B.Mask, each plus a copper keep-out) or touch pads (`touch` = F.Cu + F.Mask + keep-out, exposed copper; `covered` = F.Cu + keep-out, copper stays under solder mask):

```bash
python svg2kicad_cli.py input.svg --led-window both
```

(`--led-window` only applies to artwork that isn't on a [named layer](#named-layers); named layers need no flag.)

To anchor the output so a point of the board outline lands at (0, 0) — see [Anchor point](#anchor-point):

```bash
python svg2kicad_cli.py input.svg --anchor bottom-right
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

SVG shapes — `<path>`, `<polygon>`, `<polyline>`, `<rect>` (including rounded corners), `<circle>`, and `<ellipse>` — are tessellated into polygons and written as `gr_poly` shapes in the KiCad file:

| SVG shape (its own name, or its Illustrator layer's) | KiCad layers | Purpose |
|---|---|---|
| `EdgeCuts`, or (legacy) `class` contains `cls-2` | Edge.Cuts | Board outline |
| `TouchCopper` | F.Cu + F.Mask + keep-out | Exposed touch pad |
| `TouchBlack` | F.Cu + keep-out | Touch pad under solder mask |
| `LEDWindow` | F.Mask + B.Mask + keep-out | LED window — no mask or copper on either side, so light from behind the board gets through |
| anything else | F.Mask (or your chosen layer / LED window mode) | Solder-mask opening |

**Compound paths** (a single SVG path that contains an outer boundary and one or more inner counter-holes, separated by `Z M` in the path data) are detected automatically. Every hole is joined to the outer contour by a zero-width bridge, producing a single polygon, so KiCad renders all the holes correctly — including letters with more than one counter, like B or 8.

### LED window

With LED window on, every artwork shape (except those on a [named layer](#named-layers), which keep their own mode) is written:

- as a filled `gr_poly` on the chosen layer(s) — F.Mask, B.Mask, both, F.Cu + F.Mask for a touch pad, or F.Cu alone for a covered touch pad, and
- as a keep-out rule area (`zone` with `keepout`) on **F.Cu + B.Cu** (plus the chosen mask layers), with tracks, vias, pads and copper pour not allowed and footprints allowed — so no copper blocks the light. For a touch pad (exposed or covered), the keep-out stops tracks and ground pour from running through or under the copper pad, isolating it from the rest of the board's copper (the pad's own F.Cu shape is a graphic, not a track or pour, so it passes DRC); connect the pad to its sense trace yourself in KiCad. A covered touch pad leaves out the F.Mask opening, so solder mask still covers the copper — the pad senses through the mask instead of exposing bare copper.

Letter counters (the inside of an O, B…) keep their holes in the mask, but are filled in the keep-out: an isolated copper island inside a letter would be removed by KiCad's pour anyway. Separate same-path islands (like the dot of an i) each get their own keep-out zone.

### Named layers

To mix touch pads, LED windows and plain mask artwork in one SVG, put each kind on its own Illustrator layer named `TouchCopper`, `TouchBlack` or `LEDWindow` (see the table above) and export with **Object IDs → Layer Names**, the same as for `EdgeCuts`. Everything else can sit on any other layer and follows the artwork layer / LED window settings as usual.

- Case, spaces and punctuation don't matter (`LED Window` works), and neither do the `_1_`-style suffixes Illustrator adds to repeated names.
- A shape belongs to the nearest layer with one of these names, so sublayers work. It also means every object on the `EdgeCuts` layer is outline, including a second object such as a cutout.
- The named layers' keep-outs work exactly as described under [LED window](#led-window). They are always written, whatever the LED window setting.
- The web app's stats show a count per named layer, and the CLI prints one line per named layer it finds — a quick check for a misspelled layer name, whose shapes would count as other artwork instead.

### Anchor point

KiCad pastes clipboard content anchored at its own coordinate (0, 0) — whatever point of the pasted geometry sits at (0, 0) is the point that tracks your cursor and gets dropped where you click. By default, that's wherever (0, 0) happened to fall in your SVG's own coordinate space, which is rarely useful for lining artwork up against an existing footprint.

Setting an anchor point shifts every output coordinate (outline, artwork, and any LED-window keep-out zones) by the same amount, so a chosen point of the **board outline's** bounding box — or, if there's no Edge.Cuts shape in the file, of all the artwork's combined bounding box — lands exactly at (0, 0) instead. Pick one of the nine points (the four corners, the four edge midpoints, or the center); CLI: `--anchor top-left` / `--anchor center` / etc. (or `--anchor none`, the default, for no shift); web app: the Anchor point dropdown. The shift is computed before scaling, so the anchor point lands at (0, 0) regardless of the Scale factor.

---

## Notes

- SVG units are assumed to be **points** (1 pt = 1/72 inch), which is the default for Illustrator. Scale factor: `25.4 / 72` points → mm.
- An optional **output scale factor** (CLI: `--scale`; web app: the Scale field, defaults to `1` / 1:1) is applied uniformly to every output coordinate *after* the points→mm conversion above — it resizes the whole board, it isn't a unit correction.
- Output targets **KiCad format version 20260206** (KiCad 10). KiCad 8/9 will open it with a version warning but work fine.
- Shapes smaller than 0.02 mm in both dimensions are skipped as degenerate (this check happens before scaling, at the original SVG size).
