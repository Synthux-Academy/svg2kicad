// converter.js — SVG → KiCad conversion logic (port of svg2kicad_cli.py)
// Exposes window.Converter = { parseSvg, renderKicadText }

window.Converter = (function () {
  const SCALE = 25.4 / 72; // SVG points -> mm
  const MIN_DIM_MM = 0.02;
  const MM_PER_SAMPLE = 0.05;
  const MIN_POINTS = 8;
  const MAX_POINTS = 2000;

  const HEADER = `(kicad_pcb
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
`;

  function uuidv4() {
    const bytes = new Uint8Array(16);
    if (window.crypto && window.crypto.getRandomValues) {
      window.crypto.getRandomValues(bytes);
    } else {
      for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0'));
    return (
      hex[0] + hex[1] + hex[2] + hex[3] + '-' +
      hex[4] + hex[5] + '-' +
      hex[6] + hex[7] + '-' +
      hex[8] + hex[9] + '-' +
      hex[10] + hex[11] + hex[12] + hex[13] + hex[14] + hex[15]
    );
  }

  function roundMm(v) {
    return Math.round(v * 10000) / 10000;
  }

  function dedupePts(pts) {
    if (!pts.length) return [];
    const out = [pts[0]];
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i];
      const last = out[out.length - 1];
      if (p[0] !== last[0] || p[1] !== last[1]) out.push(p);
    }
    return out;
  }

  // Single persistent hidden <path>, reused for every sample call.
  // No viewBox/width/height/transform on the wrapper, so getPointAtLength
  // returns the raw `d` coordinates un-rescaled (same assumption the
  // Python script makes by operating directly on raw d values).
  let _samplePathEl = null;
  function getSamplePathEl() {
    if (_samplePathEl) return _samplePathEl;
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute(
      'style',
      'position:absolute; left:0; top:0; width:0; height:0; overflow:hidden; visibility:hidden;'
    );
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(svgNS, 'path');
    svg.appendChild(path);
    document.body.appendChild(svg);
    _samplePathEl = path;
    return path;
  }

  function sampleSubpath(d) {
    if (!d) return [];
    const pathEl = getSamplePathEl();
    try {
      pathEl.setAttribute('d', d);
    } catch (e) {
      return [];
    }
    let totalLen;
    try {
      totalLen = pathEl.getTotalLength();
    } catch (e) {
      return [];
    }
    if (!totalLen || !isFinite(totalLen) || totalLen <= 0) return [];

    const lengthMm = totalLen * SCALE;
    let n = Math.round(lengthMm / MM_PER_SAMPLE);
    n = Math.max(MIN_POINTS, Math.min(MAX_POINTS, n));

    const pts = [];
    for (let j = 0; j < n; j++) {
      const pt = pathEl.getPointAtLength((j / n) * totalLen);
      pts.push([roundMm(pt.x * SCALE), roundMm(pt.y * SCALE)]);
    }

    return dedupePts(pts);
  }

  function bbox(pts) {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const [x, y] of pts) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    return { w: maxX - minX, h: maxY - minY };
  }

  function signedArea(pts) {
    const n = pts.length;
    let a = 0;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      a += pts[i][0] * pts[j][1] - pts[j][0] * pts[i][1];
    }
    return a / 2;
  }

  function makeRingPolygon(outerPts, innerPts) {
    if (!outerPts.length || !innerPts.length) {
      return outerPts.length ? outerPts : innerPts;
    }
    let bestSq = Infinity, bestOi = 0, bestIi = 0;
    for (let oi = 0; oi < outerPts.length; oi++) {
      for (let ii = 0; ii < innerPts.length; ii++) {
        const dx = outerPts[oi][0] - innerPts[ii][0];
        const dy = outerPts[oi][1] - innerPts[ii][1];
        const sq = dx * dx + dy * dy;
        if (sq < bestSq) {
          bestSq = sq;
          bestOi = oi;
          bestIi = ii;
        }
      }
    }
    const outerRot = outerPts.slice(bestOi).concat(outerPts.slice(0, bestOi));
    const innerRot = innerPts.slice(bestIi).concat(innerPts.slice(0, bestIi));
    // Close each loop back to its start so the bridge is a true zero-width
    // keyhole (same edge out and back) — lets several holes join cleanly.
    return outerRot.concat([outerRot[0]], innerRot, [innerRot[0]]);
  }

  function scalePts(pts, scale) {
    if (scale === 1) return pts;
    return pts.map(([x, y]) => [roundMm(x * scale), roundMm(y * scale)]);
  }

  // LED window: artwork on these mask layers plus a copper keep-out zone
  // with the same outline, so an LED can shine through the board.
  const LED_WINDOW_MASKS = {
    front: ['F.Mask'],
    back: ['B.Mask'],
    both: ['F.Mask', 'B.Mask'],
    touch: ['F.Cu', 'F.Mask'], // touch pad: exposed copper, no other copper
  };

  // Keep-out always covers both copper layers (light passes through the
  // whole board); the chosen mask layers are listed too, as KiCad does.
  function ledWindowZoneLayers(masks) {
    return ['F.Cu']
      .concat(masks.filter((m) => m.startsWith('F.') && m !== 'F.Cu'))
      .concat(['B.Cu'], masks.filter((m) => m.startsWith('B.') && m !== 'B.Cu'));
  }

  function keepoutZone(pts, layers) {
    const uid = uuidv4();
    const xy = pts.map(([x, y]) => `        (xy ${x} ${y})`).join('\n');
    const layerList = layers.map((l) => '"' + l + '"').join(' ');
    return (
      '  (zone\n' +
      '    (layers ' + layerList + ')\n' +
      '    (uuid "' + uid + '")\n' +
      '    (hatch edge 0.5)\n' +
      '    (connect_pads (clearance 0))\n' +
      '    (min_thickness 0.25)\n' +
      '    (keepout (tracks not_allowed) (vias not_allowed) (pads not_allowed)' +
      ' (copperpour not_allowed) (footprints allowed))\n' +
      '    (placement (enabled no) (sheetname ""))\n' +
      '    (fill (thermal_gap 0.5) (thermal_bridge_width 0.5) (island_removal_mode 1))\n' +
      '    (polygon\n      (pts\n' + xy + '\n      )\n    )\n' +
      '  )'
    );
  }

  function grPoly(pts, layer, fillSolid, width) {
    const uid = uuidv4();
    const xy = pts.map(([x, y]) => `      (xy ${x} ${y})`).join('\n');
    const fill = fillSolid ? 'yes' : 'no';
    return (
      '  (gr_poly\n' +
      '    (pts\n' + xy + '\n    )\n' +
      '    (stroke (width ' + width + ') (type solid))\n' +
      '    (fill ' + fill + ')\n' +
      '    (layer "' + layer + '")\n' +
      '    (uuid "' + uid + '")\n' +
      '  )'
    );
  }

  // Splits on the Z...M boundary between subpaths (handles "ZM" with no space).
  function splitSubpathsRaw(rawD) {
    if (!rawD) return [];
    return rawD
      .split(/(?<=[Zz])\s*(?=[Mm])/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  const POINTS_NUM_RE = /-?\d*\.?\d+(?:[eE][-+]?\d+)?/g;

  // Parses a <polygon>/<polyline> `points` attribute into mm [x, y] pairs.
  function parsePointsAttr(pointsStr) {
    const nums = (pointsStr || '').match(POINTS_NUM_RE);
    if (!nums) return [];
    const pts = [];
    for (let i = 0; i + 1 < nums.length; i += 2) {
      pts.push([roundMm(Number(nums[i]) * SCALE), roundMm(Number(nums[i + 1]) * SCALE)]);
    }
    return dedupePts(pts);
  }

  function rectToPts(x, y, w, h, rx, ry) {
    if (w <= 0 || h <= 0) return [];
    if (rx == null) rx = ry;
    if (ry == null) ry = rx;
    if (!rx || !ry) {
      const corners = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
      return dedupePts(corners.map(([px, py]) => [roundMm(px * SCALE), roundMm(py * SCALE)]));
    }
    rx = Math.max(0, Math.min(rx, w / 2));
    ry = Math.max(0, Math.min(ry, h / 2));
    const corners = [
      [x + w - rx, y + ry, 270, 360],
      [x + w - rx, y + h - ry, 0, 90],
      [x + rx, y + h - ry, 90, 180],
      [x + rx, y + ry, 180, 270],
    ];
    const nArc = 8;
    const pts = [];
    for (const [cx, cy, a0, a1] of corners) {
      for (let i = 0; i <= nArc; i++) {
        const t = ((a0 + ((a1 - a0) * i) / nArc) * Math.PI) / 180;
        pts.push([
          roundMm((cx + rx * Math.cos(t)) * SCALE),
          roundMm((cy + ry * Math.sin(t)) * SCALE),
        ]);
      }
    }
    return dedupePts(pts);
  }

  function ellipseToPts(cx, cy, rx, ry) {
    if (rx <= 0 || ry <= 0) return [];
    const h = (rx - ry) ** 2 / (rx + ry) ** 2;
    const circumference = Math.PI * (rx + ry) * (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h)));
    const lengthMm = circumference * SCALE;
    let n = Math.round(lengthMm / MM_PER_SAMPLE);
    n = Math.max(MIN_POINTS, Math.min(MAX_POINTS, n));
    const pts = [];
    for (let i = 0; i < n; i++) {
      const t = (2 * Math.PI * i) / n;
      pts.push([
        roundMm((cx + rx * Math.cos(t)) * SCALE),
        roundMm((cy + ry * Math.sin(t)) * SCALE),
      ]);
    }
    return dedupePts(pts);
  }

  // A path is the board outline if its id names it "EdgeCuts" (Illustrator
  // "Object IDs -> Layer Names" export, case-insensitive, ignoring any
  // Illustrator-appended uniqueness suffix like "_1_"), or — for backward
  // compatibility with older files — if it still carries the old cls-2 class.
  function isEdgePath(id, cls) {
    const normId = (id || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (normId.includes('edgecuts')) return true;
    if ((cls || '').includes('cls-2')) return true;
    return false;
  }

  function parseSvg(svgText) {
    const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
    if (doc.querySelector('parsererror')) {
      throw new Error('Could not parse SVG file (invalid XML).');
    }

    const pathEls = Array.from(doc.querySelectorAll('path'));

    const edgeSegs = [];
    const maskSegs = [];
    const keepoutSegs = []; // hole-free contours for LED-window keep-out zones
    let skipped = 0;
    let ringCount = 0;

    for (const el of pathEls) {
      const id = el.getAttribute('id') || '';
      const cls = el.getAttribute('class') || '';
      const d = el.getAttribute('d') || '';

      if (!d) {
        skipped++;
        continue;
      }

      if (isEdgePath(id, cls)) {
        const pts = sampleSubpath(d);
        if (pts.length >= 2) {
          edgeSegs.push(pts);
        } else {
          skipped++;
        }
        continue;
      }

      const subpaths = splitSubpathsRaw(d);

      if (subpaths.length <= 1) {
        const pts = sampleSubpath(d);
        if (pts.length >= 3) {
          const { w, h } = bbox(pts);
          if (w >= MIN_DIM_MM || h >= MIN_DIM_MM) {
            maskSegs.push(pts);
            keepoutSegs.push(pts);
          } else {
            skipped++;
          }
        } else {
          skipped++;
        }
      } else {
        const candidates = [];
        for (const sp of subpaths) {
          const pts = sampleSubpath(sp);
          if (pts.length < 3) continue;
          const { w, h } = bbox(pts);
          if (w < MIN_DIM_MM && h < MIN_DIM_MM) continue;
          candidates.push([signedArea(pts), pts]);
        }

        if (candidates.length === 0) {
          skipped++;
        } else if (candidates.length === 1) {
          maskSegs.push(candidates[0][1]);
          keepoutSegs.push(candidates[0][1]);
        } else {
          // Outer = largest |area|; join every other subpath into it
          // (same-winding islands first, then holes) so letters with
          // several counters (B, 8, %) keep all their holes.
          const outer = candidates.reduce((m, c) => (Math.abs(c[0]) > Math.abs(m[0]) ? c : m));
          const sign = outer[0] >= 0 ? 1 : -1;
          candidates.sort((a, b) => b[0] * sign - a[0] * sign);
          // Keep-out = outer + same-winding islands, holes filled.
          for (const c of candidates) {
            if (c[0] * sign > 0) keepoutSegs.push(c[1]);
          }
          let ringPts = candidates[0][1];
          for (let i = 1; i < candidates.length; i++) {
            ringPts = makeRingPolygon(ringPts, candidates[i][1]);
          }
          maskSegs.push(ringPts);
          ringCount++;
        }
      }
    }

    // Basic SVG shape elements: Illustrator emits these instead of <path> for
    // artwork made only of straight lines, or for native rects/ellipses. They
    // never have compound subpaths, so there's no ring-bridging to consider.
    const basicShapeEls = Array.from(doc.querySelectorAll('rect, circle, ellipse, polygon, polyline'));

    for (const el of basicShapeEls) {
      const id = el.getAttribute('id') || '';
      const cls = el.getAttribute('class') || '';
      const tag = el.tagName.toLowerCase();
      const num = (name) => {
        const v = el.getAttribute(name);
        return v ? parseFloat(v) || 0 : 0;
      };

      let pts;
      if (tag === 'polygon' || tag === 'polyline') {
        pts = parsePointsAttr(el.getAttribute('points') || '');
      } else if (tag === 'rect') {
        const rxAttr = el.getAttribute('rx');
        const ryAttr = el.getAttribute('ry');
        const rx = rxAttr !== null && rxAttr !== '' ? parseFloat(rxAttr) : null;
        const ry = ryAttr !== null && ryAttr !== '' ? parseFloat(ryAttr) : null;
        pts = rectToPts(num('x'), num('y'), num('width'), num('height'), rx, ry);
      } else if (tag === 'circle') {
        const r = num('r');
        pts = ellipseToPts(num('cx'), num('cy'), r, r);
      } else {
        pts = ellipseToPts(num('cx'), num('cy'), num('rx'), num('ry'));
      }

      if (isEdgePath(id, cls)) {
        if (pts.length >= 2) {
          edgeSegs.push(pts);
        } else {
          skipped++;
        }
        continue;
      }

      if (pts.length >= 3) {
        const { w, h } = bbox(pts);
        if (w >= MIN_DIM_MM || h >= MIN_DIM_MM) {
          maskSegs.push(pts);
          keepoutSegs.push(pts);
        } else {
          skipped++;
        }
      } else {
        skipped++;
      }
    }

    return {
      edgeSegs,
      maskSegs,
      keepoutSegs,
      stats: {
        edgeCount: edgeSegs.length,
        maskCount: maskSegs.length,
        ringCount,
        skipped,
      },
    };
  }

  // ledWindow: null/undefined (off), 'front', 'back', 'both' or 'touch'. When set,
  // it overrides artworkLayer and adds one keep-out zone per keepoutSegs entry.
  function renderKicadText(edgeSegs, maskSegs, artworkLayer, scale, ledWindow, keepoutSegs) {
    scale = scale || 1;
    const chunks = [HEADER];
    for (const pts of edgeSegs) {
      chunks.push(grPoly(scalePts(pts, scale), 'Edge.Cuts', false, 0.05));
    }
    const masks = ledWindow ? LED_WINDOW_MASKS[ledWindow] : [artworkLayer];
    for (const layer of masks) {
      for (const pts of maskSegs) {
        chunks.push(grPoly(scalePts(pts, scale), layer, true, 0));
      }
    }
    if (ledWindow) {
      const zoneLayers = ledWindowZoneLayers(masks);
      for (const pts of keepoutSegs || []) {
        chunks.push(keepoutZone(scalePts(pts, scale), zoneLayers));
      }
    }
    chunks.push(')');
    return chunks.join('\n');
  }

  return { parseSvg, renderKicadText };
})();
