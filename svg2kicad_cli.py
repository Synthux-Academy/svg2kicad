#!/usr/bin/env python3
"""
svg2kicad_cli.py — Convert SVG artwork to KiCad PCB format

Usage:
    python svg2kicad_cli.py input.svg [output.kicad_pcb] [--scale FACTOR]

    --scale FACTOR   Uniformly scale all output coordinates. Defaults to
                      1.0 (1:1, no scaling).

Rules:
    shape whose id contains "EdgeCuts", or carries the legacy cls-2 class
                 → Edge.Cuts  (board outline)
    all others   → F.Mask     (solder-mask openings)

svgpathtools converts <polygon>, <polyline>, <rect>, <circle>, and <ellipse>
elements to paths automatically, so they're handled the same way as <path>.

Compound paths (letter counters: O, B, P, D…) are bridged into ring polygons
so holes render correctly in KiCad instead of as solid disks.

Install deps:
    pip install svgpathtools
"""

import uuid, re, sys, os, xml.etree.ElementTree as ET
from pathlib import Path
from svgpathtools import svg2paths2, parse_path, Path as SvgPath

SCALE = 25.4 / 72   # SVG points → mm
MIN_DIM_MM = 0.02


def split_subpaths_raw(raw_d):
    parts = re.split(r'(?<=[Zz])\s*(?=[Mm])', raw_d)
    result = []
    for part in parts:
        part = part.strip()
        if not part:
            continue
        try:
            sp = parse_path(part)
            if sp:
                result.append(sp)
        except Exception:
            pass
    return result


def path_to_pts(path, mm_per_sample=0.05):
    pts = []
    for seg in path:
        try:
            length_pts = seg.length()
        except Exception:
            length_pts = 0
        length_mm = length_pts * SCALE
        n = max(4, min(512, int(length_mm / mm_per_sample)))
        for j in range(n):
            pt = seg.point(j / n)
            pts.append((round(pt.real * SCALE, 4), round(pt.imag * SCALE, 4)))
    deduped = [pts[0]] if pts else []
    for p in pts[1:]:
        if p != deduped[-1]:
            deduped.append(p)
    return deduped


def signed_area(pts):
    n = len(pts)
    a = 0.0
    for i in range(n):
        j = (i + 1) % n
        a += pts[i][0] * pts[j][1] - pts[j][0] * pts[i][1]
    return a / 2.0


def scale_pts(pts, scale):
    if scale == 1:
        return pts
    return [(round(x * scale, 4), round(y * scale, 4)) for x, y in pts]


def make_ring_polygon(outer_pts, inner_pts):
    if not outer_pts or not inner_pts:
        return outer_pts or inner_pts
    best_sq = float('inf')
    best_oi = best_ii = 0
    for oi, op in enumerate(outer_pts):
        for ii, ip in enumerate(inner_pts):
            sq = (op[0] - ip[0]) ** 2 + (op[1] - ip[1]) ** 2
            if sq < best_sq:
                best_sq, best_oi, best_ii = sq, oi, ii
    outer_rot = outer_pts[best_oi:] + outer_pts[:best_oi]
    inner_rot = inner_pts[best_ii:] + inner_pts[:best_ii]
    # Close each loop back to its start so the bridge is a true zero-width
    # keyhole (same edge out and back) — lets several holes join cleanly.
    return outer_rot + [outer_rot[0]] + inner_rot + [inner_rot[0]]


def is_edge_path(id_, cls):
    """A shape is the board outline if its id names it EdgeCuts (current
    Illustrator "Object IDs -> Layer Names" export), or — for backward
    compatibility with older files — still carries the old cls-2 class."""
    norm_id = re.sub(r'[^a-z0-9]', '', (id_ or '').lower())
    if 'edgecuts' in norm_id:
        return True
    return 'cls-2' in (cls or '')


def gr_poly(pts, layer, fill_solid=False, width=0.05):
    uid = str(uuid.uuid4())
    xy = '\n'.join(f'      (xy {x} {y})' for x, y in pts)
    fill = 'yes' if fill_solid else 'no'
    return (
        f'  (gr_poly\n'
        f'    (pts\n{xy}\n    )\n'
        f'    (stroke (width {width}) (type solid))\n'
        f'    (fill {fill})\n'
        f'    (layer "{layer}")\n'
        f'    (uuid "{uid}")\n'
        f'  )'
    )


HEADER = '''(kicad_pcb
  (version 20260206)
  (generator "pcbnew")
  (generator_version "10.0")
  (general
    (thickness 1.6)
    (legacy_teardrops no)
  )
  (paper "A4")
  (layers
    (0 "F.Cu" signal)
    (2 "B.Cu" signal)
    (9 "F.Adhes" user "F.Adhesive")
    (11 "B.Adhes" user "B.Adhesive")
    (13 "F.Paste" user)
    (15 "B.Paste" user)
    (5 "F.SilkS" user "F.Silkscreen")
    (7 "B.SilkS" user "B.Silkscreen")
    (1 "F.Mask" user)
    (3 "B.Mask" user)
    (17 "Dwgs.User" user "User.Drawings")
    (19 "Cmts.User" user "User.Comments")
    (21 "Eco1.User" user "User.Eco1")
    (23 "Eco2.User" user "User.Eco2")
    (25 "Edge.Cuts" user)
    (27 "Margin" user)
    (31 "F.CrtYd" user "F.Courtyard")
    (29 "B.CrtYd" user "B.Courtyard")
    (35 "F.Fab" user)
    (33 "B.Fab" user)
    (39 "User.1" user)
    (41 "User.2" user)
    (43 "User.3" user)
    (45 "User.4" user)
    (47 "User.5" user)
    (49 "User.6" user)
    (51 "User.7" user)
    (53 "User.8" user)
    (55 "User.9" user)
  )
'''


def convert(svg_path, out_path, scale=1.0):
    paths, attrs, _ = svg2paths2(svg_path)

    # Pre-parse raw d attributes for reliable compound-path detection (handles ZM with no space)
    _ET_paths = list(ET.parse(svg_path).getroot().iter('{http://www.w3.org/2000/svg}path'))
    _raw_d = [p.get('d', '') for p in _ET_paths]

    edge_segs, mask_segs = [], []
    skipped = ring_count = 0

    for path_idx, (path, attr) in enumerate(zip(paths, attrs)):
        cls = attr.get('class', '')
        id_ = attr.get('id', '')
        if not path:
            skipped += 1
            continue

        if is_edge_path(id_, cls):
            pts = path_to_pts(path)
            if len(pts) >= 2:
                edge_segs.append(pts)
            else:
                skipped += 1
        else:
            raw = _raw_d[path_idx] if path_idx < len(_raw_d) else ''
            subpaths = split_subpaths_raw(raw) if raw else [path]

            if len(subpaths) <= 1:
                pts = path_to_pts(path)
                if len(pts) >= 3:
                    xs = [p[0] for p in pts]; ys = [p[1] for p in pts]
                    if (max(xs) - min(xs)) >= MIN_DIM_MM or (max(ys) - min(ys)) >= MIN_DIM_MM:
                        mask_segs.append(pts)
                    else:
                        skipped += 1
                else:
                    skipped += 1
            else:
                candidates = []
                for sp in subpaths:
                    pts = path_to_pts(sp)
                    if len(pts) < 3:
                        continue
                    xs = [p[0] for p in pts]; ys = [p[1] for p in pts]
                    if (max(xs) - min(xs)) < MIN_DIM_MM and (max(ys) - min(ys)) < MIN_DIM_MM:
                        continue
                    candidates.append((signed_area(pts), pts))

                if not candidates:
                    skipped += 1
                elif len(candidates) == 1:
                    mask_segs.append(candidates[0][1])
                else:
                    # Outer = largest |area|; join every other subpath into it
                    # (same-winding islands first, then holes) so letters with
                    # several counters (B, 8, %) keep all their holes.
                    sign = 1 if max(candidates, key=lambda x: abs(x[0]))[0] >= 0 else -1
                    candidates.sort(key=lambda x: x[0] * sign, reverse=True)
                    ring_pts = candidates[0][1]
                    for _, pts in candidates[1:]:
                        ring_pts = make_ring_polygon(ring_pts, pts)
                    mask_segs.append(ring_pts)
                    ring_count += 1

    chunks = [HEADER]
    for pts in edge_segs:
        chunks.append(gr_poly(scale_pts(pts, scale), 'Edge.Cuts', fill_solid=False, width=0.05))
    for pts in mask_segs:
        chunks.append(gr_poly(scale_pts(pts, scale), 'F.Mask', fill_solid=True, width=0))
    chunks.append(')')

    with open(out_path, 'w') as f:
        f.write('\n'.join(chunks))

    print(f"Edge.Cuts  : {len(edge_segs)}")
    print(f"F.Mask     : {len(mask_segs)}")
    print(f"Ring polys : {ring_count}")
    print(f"Skipped    : {skipped}")
    print(f"Scale      : {scale}x")
    print(f"Written    : {out_path}  ({os.path.getsize(out_path) / 1024:.1f} KB)")


def parse_args(argv):
    """Splits argv into positional args and a --scale/--scale=N option."""
    scale = 1.0
    positional = []
    i = 0
    while i < len(argv):
        arg = argv[i]
        if arg == '--scale':
            if i + 1 >= len(argv):
                print("Error: --scale requires a value")
                sys.exit(1)
            value = argv[i + 1]
            i += 2
        elif arg.startswith('--scale='):
            value = arg.split('=', 1)[1]
            i += 1
        else:
            positional.append(arg)
            i += 1
            continue
        try:
            scale = float(value)
        except ValueError:
            print(f"Error: invalid --scale value: {value}")
            sys.exit(1)
    return positional, scale


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    positional, scale = parse_args(sys.argv[1:])
    if not positional:
        print(__doc__)
        sys.exit(1)

    svg_in = positional[0]
    if not os.path.exists(svg_in):
        print(f"Error: file not found: {svg_in}")
        sys.exit(1)

    if len(positional) >= 2:
        kicad_out = positional[1]
    else:
        kicad_out = str(Path(svg_in).with_suffix('.kicad_pcb'))

    convert(svg_in, kicad_out, scale=scale)
