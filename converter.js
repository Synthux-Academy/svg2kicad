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

    const deduped = pts.length ? [pts[0]] : [];
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i];
      const last = deduped[deduped.length - 1];
      if (p[0] !== last[0] || p[1] !== last[1]) deduped.push(p);
    }
    return deduped;
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
    return outerRot.concat(innerRot);
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
        } else {
          candidates.sort((a, b) => b[0] - a[0]);
          const ringPts = makeRingPolygon(candidates[0][1], candidates[candidates.length - 1][1]);
          maskSegs.push(ringPts);
          ringCount++;
        }
      }
    }

    return {
      edgeSegs,
      maskSegs,
      stats: {
        edgeCount: edgeSegs.length,
        maskCount: maskSegs.length,
        ringCount,
        skipped,
      },
    };
  }

  function renderKicadText(edgeSegs, maskSegs, artworkLayer) {
    const chunks = [HEADER];
    for (const pts of edgeSegs) {
      chunks.push(grPoly(pts, 'Edge.Cuts', false, 0.05));
    }
    for (const pts of maskSegs) {
      chunks.push(grPoly(pts, artworkLayer, true, 0));
    }
    chunks.push(')');
    return chunks.join('\n');
  }

  return { parseSvg, renderKicadText };
})();
