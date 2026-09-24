// converter.js — SVG / PNG → KiCad conversion logic (port of svg2kicad_cli.py)
// Exposes window.Converter = { parseSvg, isPng, pngDpi, parsePng, referenceBox, renderKicadText }

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

  // Parses an SVG `transform` attribute (translate/rotate/scale/skewX/skewY/
  // matrix, in any combination) into a single 2x3 affine matrix [a,b,c,d,e,f]
  // where x' = a*x + c*y + e, y' = b*x + d*y + f. Illustrator emits this on
  // <rect>/<circle>/<ellipse> (and occasionally <path>) whenever a shape was
  // rotated/moved as a group and the rotation can't be baked into the
  // element's own x/y/width/height attributes.
  function multiplyMatrices(m1, m2) {
    const [a1, b1, c1, d1, e1, f1] = m1;
    const [a2, b2, c2, d2, e2, f2] = m2;
    return [
      a1 * a2 + c1 * b2,
      b1 * a2 + d1 * b2,
      a1 * c2 + c1 * d2,
      b1 * c2 + d1 * d2,
      a1 * e2 + c1 * f2 + e1,
      b1 * e2 + d1 * f2 + f1,
    ];
  }

  function parseTransform(str) {
    let m = [1, 0, 0, 1, 0, 0];
    if (!str) return m;
    const re = /(\w+)\s*\(([^)]*)\)/g;
    let match;
    while ((match = re.exec(str))) {
      const name = match[1];
      const args = match[2].trim().split(/[\s,]+/).filter(Boolean).map(Number);
      let fm;
      switch (name) {
        case 'matrix':
          fm = args.length === 6 ? args : [1, 0, 0, 1, 0, 0];
          break;
        case 'translate':
          fm = [1, 0, 0, 1, args[0] || 0, args[1] || 0];
          break;
        case 'scale': {
          const sx = args[0] || 1;
          const sy = args.length > 1 ? args[1] : sx;
          fm = [sx, 0, 0, sy, 0, 0];
          break;
        }
        case 'rotate': {
          const rad = ((args[0] || 0) * Math.PI) / 180;
          const cos = Math.cos(rad), sin = Math.sin(rad);
          const rm = [cos, sin, -sin, cos, 0, 0];
          const cx = args[1] || 0, cy = args[2] || 0;
          fm = (cx || cy)
            ? multiplyMatrices(multiplyMatrices([1, 0, 0, 1, cx, cy], rm), [1, 0, 0, 1, -cx, -cy])
            : rm;
          break;
        }
        case 'skewX':
          fm = [1, 0, Math.tan(((args[0] || 0) * Math.PI) / 180), 1, 0, 0];
          break;
        case 'skewY':
          fm = [1, Math.tan(((args[0] || 0) * Math.PI) / 180), 0, 1, 0, 0];
          break;
        default:
          fm = [1, 0, 0, 1, 0, 0];
      }
      m = multiplyMatrices(m, fm);
    }
    return m;
  }

  function isIdentityMatrix(m) {
    return m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0;
  }

  // pts are already in mm (SCALE applied by the caller); a matrix's e/f
  // translation components are in raw SVG units, so they're scaled to mm
  // here to match, while a/b/c/d (rotation/scale ratios) apply unchanged.
  function applyTransform(pts, m) {
    const [a, b, c, d, e, f] = m;
    const te = e * SCALE, tf = f * SCALE;
    return pts.map(([x, y]) => [roundMm(a * x + c * y + te), roundMm(b * x + d * y + tf)]);
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

  // Anchor: shifts every output coordinate so a named point of the board
  // outline's bounding box (or, with no outline, all artwork's) lands at
  // (0, 0) — KiCad pastes clipboard content anchored at its own (0, 0), so
  // this puts that point under the cursor on paste, for lining up with the
  // rest of a footprint.
  const ANCHOR_POINTS = {
    'top-left': ['left', 'top'],
    'top-center': ['center', 'top'],
    'top-right': ['right', 'top'],
    'middle-left': ['left', 'middle'],
    center: ['center', 'middle'],
    'middle-right': ['right', 'middle'],
    'bottom-left': ['left', 'bottom'],
    'bottom-center': ['center', 'bottom'],
    'bottom-right': ['right', 'bottom'],
  };

  // Combined (minX, minY, maxX, maxY) across several point-lists, or null
  // if there are no points at all.
  function combinedBBox(segLists) {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const pts of segLists) {
      for (const [x, y] of pts) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    return isFinite(minX) ? { minX, minY, maxX, maxY } : null;
  }

  // KiCad's Y axis increases downward, same as the SVG/mm space used
  // throughout this file, so 'top' is the min-Y edge — no flip needed.
  function anchorXY(box, anchor) {
    const [xpos, ypos] = ANCHOR_POINTS[anchor];
    const x = { left: box.minX, center: (box.minX + box.maxX) / 2, right: box.maxX }[xpos];
    const y = { top: box.minY, middle: (box.minY + box.maxY) / 2, bottom: box.maxY }[ypos];
    return [x, y];
  }

  function shiftPts(pts, dx, dy) {
    return pts.map(([x, y]) => [roundMm(x + dx), roundMm(y + dy)]);
  }

  // LED window: artwork on these mask layers plus a copper keep-out zone
  // with the same outline, so an LED can shine through the board.
  const LED_WINDOW_MASKS = {
    front: ['F.Mask'],
    back: ['B.Mask'],
    both: ['F.Mask', 'B.Mask'],
    touch: ['F.Cu', 'F.Mask'], // touch pad: exposed copper, no other copper
    covered: ['F.Cu'], // covered touch pad: copper stays under solder mask
  };

  // Modes a named layer can have: the LED-window ones, plus 'mask', a plain
  // F.Mask opening with no keep-out (not an LED-window setting).
  const MODE_MASKS = Object.assign({ mask: ['F.Mask'] }, LED_WINDOW_MASKS);
  const NO_KEEPOUT_MODES = new Set(['mask']);

  // Illustrator layer names that fix a shape's layers whatever the global
  // layer / LED-window settings say, each mapped to a MODE_MASKS mode
  // (see shapeRole).
  const LAYER_MODES = {
    TouchCopper: 'touch', // exposed touch pad
    TouchBlack: 'covered', // touch pad under solder mask
    LEDWindow: 'both', // LED window: no mask either side, so light gets through
    FMask: 'mask', // F.Mask only, whatever the global settings say
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

  // Lowercased, non-alphanumerics stripped, so Illustrator's variants of a
  // layer name all match: "LED Window" -> id "LED_Window", and uniqueness
  // suffixes like "EdgeCuts_1_" -> "edgecuts1".
  function normId(id) {
    return (id || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  // 'EdgeCuts' (board outline), a LAYER_MODES name, or null (other artwork,
  // which follows the global settings). Illustrator's "Object IDs -> Layer
  // Names" export puts a layer's name on its <g> (on the root <svg> for a
  // one-layer file), or on the object itself when it's the layer's only
  // object, so the shape's own id is checked first, then each ancestor's,
  // and the nearest match wins. The legacy cls-2 class is checked last, so a
  // named layer beats an Internal CSS class that happens to be cls-2.
  function shapeRole(el) {
    for (let node = el; node && node.nodeType === 1; node = node.parentNode) {
      const n = normId(node.getAttribute('id'));
      if (n.includes('edgecuts')) return 'EdgeCuts';
      for (const name in LAYER_MODES) {
        if (n.includes(name.toLowerCase())) return name;
      }
    }
    if ((el.getAttribute('class') || '').includes('cls-2')) return 'EdgeCuts';
    return null;
  }

  // display/visibility from a CSS declaration list ("a: b; c: d").
  function styleDecls(text) {
    const out = {};
    for (const part of (text || '').split(';')) {
      const i = part.indexOf(':');
      if (i < 0) continue;
      const prop = part.slice(0, i).trim().toLowerCase();
      if (prop === 'display' || prop === 'visibility') {
        out[prop] = part.slice(i + 1).toLowerCase().replace('!important', '').trim();
      }
    }
    return out;
  }

  // Class -> { prop: [value, rule order] } for the display/visibility rules
  // in the SVG's <style> blocks — Illustrator's Internal CSS export hides a
  // layer with a class rule like `.st19 { display: none; }`. Only simple
  // .class selectors are read; a later rule beats an earlier one, as in CSS.
  // (The parsed document is never rendered, so getComputedStyle can't help,
  // and putting untrusted SVG into the live page isn't an option.)
  function styleRules(doc) {
    const css = Array.from(doc.querySelectorAll('style'), (s) => s.textContent)
      .join('')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    const rules = new Map();
    const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
    let m;
    for (let order = 0; (m = ruleRe.exec(css)); order++) {
      const decls = styleDecls(m[2]);
      for (const sel of m[1].split(',')) {
        const s = sel.trim();
        if (!/^\.[\w-]+$/.test(s)) continue;
        if (!rules.has(s.slice(1))) rules.set(s.slice(1), {});
        for (const prop in decls) rules.get(s.slice(1))[prop] = [decls[prop], order];
      }
    }
    return rules;
  }

  // A node's own display/visibility, CSS-style: inline style beats a class
  // rule, which beats the presentation attribute. null if it sets neither.
  function declared(node, prop, rules) {
    const inline = styleDecls(node.getAttribute('style'))[prop];
    if (inline) return inline;
    let best = null;
    for (const cls of (node.getAttribute('class') || '').split(/\s+/)) {
      const rule = rules.has(cls) ? rules.get(cls)[prop] : null;
      if (rule && (!best || rule[1] > best[1])) best = rule;
    }
    if (best) return best[0];
    return (node.getAttribute(prop) || '').trim().toLowerCase() || null;
  }

  // True if the shape isn't rendered: display:none on it or any ancestor
  // (how Illustrator exports a hidden layer), or an inherited visibility of
  // hidden/collapse (the nearest explicit value wins, as in CSS). Hidden
  // shapes are dropped entirely, before any layer name is looked at.
  function isHidden(el, rules) {
    for (let node = el; node && node.nodeType === 1; node = node.parentNode) {
      if (declared(node, 'display', rules) === 'none') return true;
    }
    for (let node = el; node && node.nodeType === 1; node = node.parentNode) {
      const value = declared(node, 'visibility', rules);
      if (value && value !== 'inherit') return value === 'hidden' || value === 'collapse';
    }
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
    // Shapes on a LAYER_MODES layer, kept apart since their layers are fixed.
    const layerSegs = {};
    for (const name in LAYER_MODES) {
      layerSegs[name] = { mode: LAYER_MODES[name], maskSegs: [], keepoutSegs: [] };
    }
    const otherSegs = { maskSegs, keepoutSegs };
    const hidingRules = styleRules(doc);
    let skipped = 0;
    let ringCount = 0;

    for (const el of pathEls) {
      if (isHidden(el, hidingRules)) continue;
      const role = shapeRole(el);
      const d = el.getAttribute('d') || '';
      const tMatrix = parseTransform(el.getAttribute('transform'));
      const hasTransform = !isIdentityMatrix(tMatrix);

      if (!d) {
        skipped++;
        continue;
      }

      if (role === 'EdgeCuts') {
        let pts = sampleSubpath(d);
        if (hasTransform) pts = applyTransform(pts, tMatrix);
        if (pts.length >= 2) {
          edgeSegs.push(pts);
        } else {
          skipped++;
        }
        continue;
      }

      const out = role ? layerSegs[role] : otherSegs;
      const subpaths = splitSubpathsRaw(d);

      if (subpaths.length <= 1) {
        let pts = sampleSubpath(d);
        if (hasTransform) pts = applyTransform(pts, tMatrix);
        if (pts.length >= 3) {
          const { w, h } = bbox(pts);
          if (w >= MIN_DIM_MM || h >= MIN_DIM_MM) {
            out.maskSegs.push(pts);
            out.keepoutSegs.push(pts);
          } else {
            skipped++;
          }
        } else {
          skipped++;
        }
      } else {
        const candidates = [];
        for (const sp of subpaths) {
          let pts = sampleSubpath(sp);
          if (hasTransform) pts = applyTransform(pts, tMatrix);
          if (pts.length < 3) continue;
          const { w, h } = bbox(pts);
          if (w < MIN_DIM_MM && h < MIN_DIM_MM) continue;
          candidates.push([signedArea(pts), pts]);
        }

        if (candidates.length === 0) {
          skipped++;
        } else if (candidates.length === 1) {
          out.maskSegs.push(candidates[0][1]);
          out.keepoutSegs.push(candidates[0][1]);
        } else {
          // Outer = largest |area|; join every other subpath into it
          // (same-winding islands first, then holes) so letters with
          // several counters (B, 8, %) keep all their holes.
          const outer = candidates.reduce((m, c) => (Math.abs(c[0]) > Math.abs(m[0]) ? c : m));
          const sign = outer[0] >= 0 ? 1 : -1;
          candidates.sort((a, b) => b[0] * sign - a[0] * sign);
          // Keep-out = outer + same-winding islands, holes filled.
          for (const c of candidates) {
            if (c[0] * sign > 0) out.keepoutSegs.push(c[1]);
          }
          let ringPts = candidates[0][1];
          for (let i = 1; i < candidates.length; i++) {
            ringPts = makeRingPolygon(ringPts, candidates[i][1]);
          }
          out.maskSegs.push(ringPts);
          ringCount++;
        }
      }
    }

    // Basic SVG shape elements: Illustrator emits these instead of <path> for
    // artwork made only of straight lines, or for native rects/ellipses. They
    // never have compound subpaths, so there's no ring-bridging to consider.
    const basicShapeEls = Array.from(doc.querySelectorAll('rect, circle, ellipse, polygon, polyline'));

    for (const el of basicShapeEls) {
      if (isHidden(el, hidingRules)) continue;
      const role = shapeRole(el);
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

      const tMatrix = parseTransform(el.getAttribute('transform'));
      if (!isIdentityMatrix(tMatrix)) pts = applyTransform(pts, tMatrix);

      if (role === 'EdgeCuts') {
        if (pts.length >= 2) {
          edgeSegs.push(pts);
        } else {
          skipped++;
        }
        continue;
      }

      const out = role ? layerSegs[role] : otherSegs;
      if (pts.length >= 3) {
        const { w, h } = bbox(pts);
        if (w >= MIN_DIM_MM || h >= MIN_DIM_MM) {
          out.maskSegs.push(pts);
          out.keepoutSegs.push(pts);
        } else {
          skipped++;
        }
      } else {
        skipped++;
      }
    }

    const layerCounts = {};
    for (const name in layerSegs) layerCounts[name] = layerSegs[name].maskSegs.length;

    return {
      edgeSegs,
      maskSegs,
      keepoutSegs,
      layerSegs,
      stats: {
        edgeCount: edgeSegs.length,
        maskCount: maskSegs.length,
        layerCounts,
        ringCount,
        skipped,
      },
    };
  }

  // PNG input: every dark area becomes one artwork shape, with the light
  // areas inside it bridged in as holes. Outlines are traced with marching
  // squares over the pixel centers, interpolating the anti-aliased gray
  // levels for sub-pixel accuracy. svg2kicad_cli.py does the same, step for
  // step (png_shapes and the functions it calls).
  const PNG_THRESHOLD = 127.5; // luminance 0-255: darker is artwork
  const PNG_DEFAULT_DPI = 72; // a PNG with no DPI: 1 px = 1 pt, the same unit as SVG
  const PNG_MIN_AREA_PX = 2; // dark or light specks under this many px² are noise
  const PNG_TOLERANCE_PX = 0.25; // traced outlines are simplified to within this
  const TOP = 0, RIGHT = 1, BOTTOM = 2, LEFT = 3;

  function isPng(bytes) {
    const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    return bytes.length >= 8 && signature.every((b, i) => bytes[i] === b);
  }

  // [dpiX, dpiY] from the PNG's pHYs chunk, or null if it has none (or one
  // that gives only an aspect ratio). Computed as Pillow does in the CLI.
  function pngDpi(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let at = 8; at + 8 <= bytes.length; ) {
      const length = view.getUint32(at);
      const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
      if (type === 'IDAT' || type === 'IEND') break;
      if (type === 'pHYs' && length >= 9 && at + 17 <= bytes.length) {
        const px = view.getUint32(at + 8), py = view.getUint32(at + 12);
        return bytes[at + 16] === 1 && px > 0 && py > 0 ? [px * 0.0254, py * 0.0254] : null;
      }
      at += 12 + length;
    }
    return null;
  }

  // Luminance (0-255) of RGBA pixels, transparency composited over white, on
  // a grid with a 1 px white border added so every contour closes.
  function paddedLuminance(rgba, width, height) {
    const W = width + 2;
    const grid = new Float64Array(W * (height + 2)).fill(255);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const o = (y * width + x) * 4;
        let v = (rgba[o] * 299 + rgba[o + 1] * 587 + rgba[o + 2] * 114) / 1000;
        const a = rgba[o + 3];
        if (a < 255) v = 255 - ((255 - v) * a) / 255;
        grid[(y + 1) * W + x + 1] = v;
      }
    }
    return grid;
  }

  // Marching squares on the padded grid (W x H points). Returns the crossing
  // points (xs, ys, in px of that grid, where grid point (x, y) is the center
  // of image pixel (x - 1, y - 1)), the pixel row of each crossing on a
  // horizontal edge (those come first, in row-major order), the contours as
  // arrays of crossing ids and the contour of each crossing. Contours keep
  // the dark side on their left and start at their topmost-leftmost
  // crossing. A saddle cell joins its two dark corners when the mean of its
  // corners is dark.
  function traceContours(grid, W, H) {
    const dark = new Uint8Array(W * H);
    for (let p = 0; p < W * H; p++) dark[p] = grid[p] < PNG_THRESHOLD ? 1 : 0;
    // Horizontal edges (grid point p to p + 1) get crossing ids 0..nh-1,
    // then vertical edges (p to p + W); hid / vid map an edge to its id.
    const hid = new Int32Array(H * (W - 1)).fill(-1);
    const vid = new Int32Array((H - 1) * W).fill(-1);
    const xs = [], ys = [], rows = [];
    for (let i = 0; i < H; i++) {
      for (let j = 0; j < W - 1; j++) {
        const p = i * W + j;
        if (dark[p] !== dark[p + 1]) {
          hid[i * (W - 1) + j] = xs.length;
          xs.push(j + (PNG_THRESHOLD - grid[p]) / (grid[p + 1] - grid[p]));
          ys.push(i);
          rows.push(i);
        }
      }
    }
    for (let i = 0; i < H - 1; i++) {
      for (let j = 0; j < W; j++) {
        const p = i * W + j;
        if (dark[p] !== dark[p + W]) {
          vid[p] = xs.length;
          xs.push(j);
          ys.push(i + (PNG_THRESHOLD - grid[p]) / (grid[p + W] - grid[p]));
        }
      }
    }

    // The crossing a contour leaves cell (i, j) by (grid point (i, j) is its
    // top-left), having entered it from `side`: its one exit, unless it's a
    // saddle (two dark corners diagonally).
    function cellExit(i, j, side) {
      const p = i * W + j;
      const tl = dark[p], tr = dark[p + 1], br = dark[p + W + 1], bl = dark[p + W];
      const top = hid[i * (W - 1) + j], bottom = hid[(i + 1) * (W - 1) + j];
      const left = vid[p], right = vid[p + 1];
      const centerDark = () => (grid[p] + grid[p + 1] + grid[p + W + 1] + grid[p + W]) / 4 < PNG_THRESHOLD;
      if (tl && br && !tr && !bl) return (side === RIGHT) === centerDark() ? top : bottom; // entered left/right
      if (tr && bl && !tl && !br) return (side === TOP) === centerDark() ? left : right; // entered top/bottom
      if (tl && !tr) return top;
      if (!bl && br) return bottom;
      if (!tl && bl) return left;
      return right;
    }

    // Each crossing leads into the cell on its dark-left side: up (dark on
    // the left) or down across a horizontal edge, right (dark on top) or left
    // across a vertical one.
    const succ = new Int32Array(xs.length);
    for (let i = 0; i < H; i++) {
      for (let j = 0; j < W - 1; j++) {
        const c = hid[i * (W - 1) + j];
        if (c >= 0) succ[c] = dark[i * W + j] ? cellExit(i - 1, j, BOTTOM) : cellExit(i, j, TOP);
      }
    }
    for (let i = 0; i < H - 1; i++) {
      for (let j = 0; j < W; j++) {
        const c = vid[i * W + j];
        if (c >= 0) succ[c] = dark[i * W + j] ? cellExit(i, j, LEFT) : cellExit(i, j - 1, RIGHT);
      }
    }

    const cid = new Int32Array(xs.length).fill(-1);
    const contours = [];
    for (let start = 0; start < xs.length; start++) {
      if (cid[start] >= 0) continue;
      const loop = [];
      for (let c = start; cid[c] < 0; c = succ[c]) {
        cid[c] = contours.length;
        loop.push(c);
      }
      contours.push(loop);
    }
    return { xs, ys, rows, contours, cid };
  }

  // The contour directly enclosing each contour (-1 for none), from one pass
  // along each pixel row: contours never cross, so their crossings along a
  // row nest like brackets. A parent is always numbered before its child.
  function contourParents(rows, cid, count) {
    const parent = new Array(count).fill(null);
    let stack = [], row = -1;
    for (let c = 0; c < rows.length; c++) {
      if (rows[c] !== row) {
        stack = [];
        row = rows[c];
      }
      const k = cid[c];
      if (stack.length && stack[stack.length - 1] === k) {
        stack.pop();
      } else {
        if (parent[k] === null) parent[k] = stack.length ? stack[stack.length - 1] : -1;
        stack.push(k);
      }
    }
    return parent;
  }

  // Douglas-Peucker on a closed loop: the sorted positions kept, always
  // including 0 and the point farthest from it.
  function simplifyLoop(xs, ys) {
    const n = xs.length;
    let far = 0, farD = -1;
    for (let i = 0; i < n; i++) {
      const dx = xs[i] - xs[0], dy = ys[i] - ys[0];
      const d = dx * dx + dy * dy;
      if (d > farD) {
        farD = d;
        far = i;
      }
    }
    if (far === 0) return [0];
    const keep = [0, far];
    const tol2 = PNG_TOLERANCE_PX * PNG_TOLERANCE_PX;
    const stack = [[0, far], [far, n]];
    while (stack.length) {
      const [a, b] = stack.pop();
      if (b - a < 2) continue;
      const ax = xs[a], ay = ys[a], ex = xs[b % n] - ax, ey = ys[b % n] - ay;
      const len2 = ex * ex + ey * ey;
      let m = -1, md = -1;
      for (let i = a + 1; i < b; i++) {
        let qx = ax, qy = ay;
        if (len2 > 0) {
          const t = Math.min(1, Math.max(0, ((xs[i] - ax) * ex + (ys[i] - ay) * ey) / len2));
          qx = ax + t * ex;
          qy = ay + t * ey;
        }
        const d = (xs[i] - qx) * (xs[i] - qx) + (ys[i] - qy) * (ys[i] - qy);
        if (d > md) {
          md = d;
          m = i;
        }
      }
      if (md > tol2) {
        keep.push(m);
        stack.push([a, m], [m, b]);
      }
    }
    return keep.sort((p, q) => p - q);
  }

  // The PNG's dark areas as artwork, in mm: { rings, outlines, ringCount,
  // skipped }. Each dark area is one ring (its outline with the light areas
  // inside it bridged in as holes) and one outline without the holes (for
  // keep-out zones); a dark area inside one of those holes is a shape of its
  // own. Specks are dropped, along with anything inside them.
  function pngShapes(grid, W, H, mmx, mmy) {
    const { xs, ys, rows, contours, cid } = traceContours(grid, W, H);
    const parent = contourParents(rows, cid, contours.length);
    // Crossings interpolated along rows and along columns err slightly
    // differently, so a traced edge zigzags by about 0.1 px from one crossing
    // to the next. One (1, 2, 1) / 4 pass along each contour cancels that.
    const sx = xs.slice(), sy = ys.slice();
    for (const loop of contours) {
      const m = loop.length;
      for (let i = 0; i < m; i++) {
        const a = loop[(i + m - 1) % m], c = loop[i], b = loop[(i + 1) % m];
        sx[c] = (xs[a] + 2 * xs[c] + xs[b]) / 4;
        sy[c] = (ys[a] + 2 * ys[c] + ys[b]) / 4;
      }
    }
    // Nesting depth: even = a dark area's outline, odd = a hole in its parent.
    const depth = [], dropped = [], kept = [];
    let skipped = 0;
    contours.forEach((loop, k) => {
      const up = parent[k];
      depth.push(up >= 0 ? depth[up] + 1 : 0);
      if (up >= 0 && dropped[up]) {
        dropped.push(true);
        kept.push(null);
        return;
      }
      const keep = simplifyLoop(loop.map((c) => sx[c]), loop.map((c) => sy[c]));
      let area = 0, minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      loop.forEach((c, i) => {
        const d = loop[(i + 1) % loop.length];
        area += xs[c] * ys[d] - xs[d] * ys[c];
        minX = Math.min(minX, xs[c]);
        maxX = Math.max(maxX, xs[c]);
        minY = Math.min(minY, ys[c]);
        maxY = Math.max(maxY, ys[c]);
      });
      const tiny = Math.abs(area / 2) < PNG_MIN_AREA_PX || keep.length < 3 ||
        ((maxX - minX) * mmx < MIN_DIM_MM && (maxY - minY) * mmy < MIN_DIM_MM);
      dropped.push(tiny);
      kept.push(keep);
      if (tiny && depth[k] % 2 === 0) skipped++;
    });

    // Each hole is bridged along its top pixel row, from its leftmost crossing
    // there to the nearest kept crossing on its left. That crossing is on the
    // dark area's outline or on another of its holes, so the bridge runs over
    // dark only and crosses nothing, and following holes bridged to holes
    // always ends at the outline (each bridges to one found before it).
    const attach = new Map(), bridge = new Map(); // crossing -> hole bridged to it, and back
    let last = -1, row = -1;
    for (let c = 0; c < rows.length; c++) {
      if (rows[c] !== row) {
        last = -1;
        row = rows[c];
      }
      const k = cid[c];
      if (dropped[k]) continue;
      if (depth[k] % 2 && contours[k][0] === c) {
        attach.set(last, k);
        bridge.set(k, last);
      }
      last = c;
    }

    // Simplified contours as crossing ids, keeping every bridge end.
    const pos = new Int32Array(xs.length);
    for (const loop of contours) loop.forEach((c, i) => { pos[c] = i; });
    const ends = new Map();
    for (const c of attach.keys()) {
      if (!ends.has(cid[c])) ends.set(cid[c], []);
      ends.get(cid[c]).push(pos[c]);
    }
    const verts = new Map();
    contours.forEach((loop, k) => {
      if (dropped[k]) return;
      const idx = Array.from(new Set(kept[k].concat(ends.get(k) || []))).sort((a, b) => a - b);
      verts.set(k, idx.map((i) => loop[i]));
    });

    const toMm = (ids) => dedupePts(ids.map((c) => [roundMm((sx[c] - 0.5) * mmx), roundMm((sy[c] - 0.5) * mmy)]));
    const rings = [], outlines = [];
    let ringCount = 0;
    for (const [k, v] of verts) {
      if (depth[k] % 2) continue;
      // Walk the outline, detouring round each hole bridged from a point on
      // the way: bridge in, round the hole back to its start, bridge out —
      // the same zero-width keyhole as makeRingPolygon.
      const ring = [], stack = [[k, 0]];
      while (stack.length) {
        const [j, i] = stack.pop();
        const vj = verts.get(j);
        if (i === vj.length) {
          if (j !== k) ring.push(vj[0], bridge.get(j));
          continue;
        }
        ring.push(vj[i]);
        stack.push([j, i + 1]);
        if (attach.has(vj[i])) stack.push([attach.get(vj[i]), 0]);
      }
      if (ring.length > v.length) ringCount++;
      rings.push(toMm(ring));
      outlines.push(toMm(v));
    }
    return { rings, outlines, ringCount, skipped };
  }

  // A PNG's dark areas as artwork (see pngShapes), in parseSvg's form, with
  // no board outline. rgba: the decoded pixels (e.g. ImageData.data); dpi:
  // pngDpi's result, or null to use PNG_DEFAULT_DPI.
  function parsePng(rgba, width, height, dpi) {
    const fromFile = !!(dpi && dpi[0] > 0 && dpi[1] > 0);
    const d = fromFile ? dpi : [PNG_DEFAULT_DPI, PNG_DEFAULT_DPI];
    const grid = paddedLuminance(rgba, width, height);
    const shapes = pngShapes(grid, width + 2, height + 2, 25.4 / d[0], 25.4 / d[1]);
    return {
      edgeSegs: [],
      maskSegs: shapes.rings,
      keepoutSegs: shapes.outlines,
      layerSegs: {},
      stats: {
        edgeCount: 0,
        maskCount: shapes.rings.length,
        layerCounts: {},
        ringCount: shapes.ringCount,
        skipped: shapes.skipped,
      },
      image: { width, height, dpi: d, dpiFromFile: fromFile },
    };
  }

  // The box the anchor point and the output size refer to: the board
  // outline's bounding box, or, with no outline (e.g. a PNG), all artwork's.
  function referenceBox(edgeSegs, maskSegs, layerSegs) {
    const artwork = maskSegs.concat(...Object.values(layerSegs || {}).map((p) => p.maskSegs));
    return combinedBBox(edgeSegs.length ? edgeSegs : artwork);
  }

  // ledWindow: null/undefined (off), 'front', 'back', 'both', 'touch' or 'covered'. When set,
  // it overrides artworkLayer and adds one keep-out zone per keepoutSegs entry.
  // anchor: null/undefined/'none' (off) or one of ANCHOR_POINTS's keys — see
  // anchorXY's doc comment above. Applied at the original size, before
  // scaling, so the chosen point lands exactly at (0, 0) at any scale.
  // layerSegs: parseSvg's layerSegs (shapes on a LAYER_MODES layer), each
  // written in its own fixed mode — artworkLayer / ledWindow only apply to
  // maskSegs, the other artwork.
  function renderKicadText(edgeSegs, maskSegs, artworkLayer, scale, ledWindow, keepoutSegs, anchor, layerSegs) {
    scale = scale || 1;
    keepoutSegs = keepoutSegs || [];
    let parts = Object.values(layerSegs || {});
    if (anchor && anchor !== 'none') {
      const box = referenceBox(edgeSegs, maskSegs, layerSegs);
      if (box) {
        const [ax, ay] = anchorXY(box, anchor);
        const shift = (segs) => segs.map((pts) => shiftPts(pts, -ax, -ay));
        edgeSegs = shift(edgeSegs);
        maskSegs = shift(maskSegs);
        keepoutSegs = shift(keepoutSegs);
        parts = parts.map((p) => ({
          mode: p.mode,
          maskSegs: shift(p.maskSegs),
          keepoutSegs: shift(p.keepoutSegs),
        }));
      }
    }
    const chunks = [HEADER];
    for (const pts of edgeSegs) {
      chunks.push(grPoly(scalePts(pts, scale), 'Edge.Cuts', false, 0.05));
    }
    const groups = [{ mode: ledWindow, maskSegs, keepoutSegs }].concat(parts);
    for (const g of groups) {
      const masks = g.mode ? MODE_MASKS[g.mode] : [artworkLayer];
      for (const layer of masks) {
        for (const pts of g.maskSegs) {
          chunks.push(grPoly(scalePts(pts, scale), layer, true, 0));
        }
      }
      if (g.mode && !NO_KEEPOUT_MODES.has(g.mode)) {
        const zoneLayers = ledWindowZoneLayers(masks);
        for (const pts of g.keepoutSegs) {
          chunks.push(keepoutZone(scalePts(pts, scale), zoneLayers));
        }
      }
    }
    chunks.push(')');
    return chunks.join('\n');
  }

  return { parseSvg, isPng, pngDpi, parsePng, referenceBox, renderKicadText };
})();
