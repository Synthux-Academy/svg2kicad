// ui.js — drag/drop (SVG or PNG), layer selection, size, clipboard wiring

(function () {
  const COMMON_LAYERS = ['F.Mask', 'F.Cu', 'B.Cu', 'F.SilkS', 'B.SilkS', 'B.Mask'];
  const MORE_LAYERS = [
    'F.Adhes', 'B.Adhes', 'F.Paste', 'B.Paste',
    'Dwgs.User', 'Cmts.User', 'Eco1.User', 'Eco2.User',
    'Edge.Cuts', 'Margin', 'F.CrtYd', 'B.CrtYd', 'F.Fab', 'B.Fab',
    'User.1', 'User.2', 'User.3', 'User.4', 'User.5',
    'User.6', 'User.7', 'User.8', 'User.9',
  ];

  const state = {
    edgeSegs: [],
    maskSegs: [],
    keepoutSegs: [],
    layerSegs: {},
    stats: null,
    kicadText: '',
    svgPreviewUrl: null,
    scale: 1,
    box: null, // Converter.referenceBox of the loaded file
  };

  const fileInput = document.getElementById('fileInput');
  const fileNameEl = document.getElementById('fileName');
  const statsPanel = document.getElementById('statsPanel');
  const statEdge = document.getElementById('statEdge');
  const statMask = document.getElementById('statMask');
  const statMaskLabel = document.getElementById('statMaskLabel');
  const statRing = document.getElementById('statRing');
  const statSkipped = document.getElementById('statSkipped');
  const controls = document.getElementById('controls');
  const layerSelect = document.getElementById('layerSelect');
  const scaleInput = document.getElementById('scaleInput');
  const widthInput = document.getElementById('widthInput');
  const heightInput = document.getElementById('heightInput');
  const ledWindowCheck = document.getElementById('ledWindowCheck');
  const ledWindowSelect = document.getElementById('ledWindowSelect');
  const anchorSelect = document.getElementById('anchorSelect');
  const commonLayersGroup = document.getElementById('commonLayers');
  const moreLayersGroup = document.getElementById('moreLayers');
  const moreLayersToggle = document.getElementById('moreLayersToggle');
  const copyBtn = document.getElementById('copyBtn');
  const copyStatus = document.getElementById('copyStatus');
  const clipboardStaging = document.getElementById('clipboardStaging');
  const svgPreviewBox = document.getElementById('svgPreview');
  const kicadPreviewBox = document.getElementById('kicadPreview');
  const SVG_PREVIEW_PLACEHOLDER = '<p class="preview-placeholder">Drag an SVG or PNG here, or click to browse</p>';
  const KICAD_PREVIEW_PLACEHOLDER = '<p class="preview-placeholder">Converted shapes will appear here.</p>';

  function populateLayerSelect() {
    for (const layer of COMMON_LAYERS) {
      const opt = document.createElement('option');
      opt.value = layer;
      opt.textContent = layer;
      commonLayersGroup.appendChild(opt);
    }
    for (const layer of MORE_LAYERS) {
      const opt = document.createElement('option');
      opt.value = layer;
      opt.textContent = layer;
      moreLayersGroup.appendChild(opt);
    }
    layerSelect.value = 'F.Mask';
  }

  function setCopyStatus(msg, isError) {
    copyStatus.textContent = msg;
    copyStatus.classList.toggle('error', !!isError);
  }

  function resetForNewFile() {
    statsPanel.hidden = true;
    controls.hidden = true;
    copyBtn.disabled = true;
    clipboardStaging.classList.remove('visible');
    setCopyStatus('', false);
    scaleInput.value = '1';
    state.scale = 1;
    state.box = null;
    widthInput.value = '';
    heightInput.value = '';
    // Anchor point is intentionally left alone — it's a paste-alignment
    // preference that should carry over to the next SVG, not per-file state.

    if (state.svgPreviewUrl) {
      URL.revokeObjectURL(state.svgPreviewUrl);
      state.svgPreviewUrl = null;
    }
    svgPreviewBox.classList.add('empty');
    svgPreviewBox.innerHTML = SVG_PREVIEW_PLACEHOLDER;
    kicadPreviewBox.classList.add('empty');
    kicadPreviewBox.innerHTML = KICAD_PREVIEW_PLACEHOLDER;
  }

  // blob: the SVG text or the PNG, shown via <img> — never innerHTML, so an
  // untrusted SVG's scripts never run.
  function showSourcePreview(blob) {
    const url = URL.createObjectURL(blob);
    state.svgPreviewUrl = url;

    const img = document.createElement('img');
    img.alt = 'Source preview';
    img.src = url;

    svgPreviewBox.innerHTML = '';
    svgPreviewBox.appendChild(img);
    svgPreviewBox.classList.remove('empty');
  }

  // One stats row per TouchCopper / TouchBlack / LEDWindow layer that has
  // shapes, above the artwork row — which then only counts the rest, so it's
  // relabelled "Other artwork".
  function showLayerStats(layerCounts) {
    for (const row of statsPanel.querySelectorAll('.stat-layer')) row.remove();
    const artworkRow = statMask.parentElement;
    let any = false;
    for (const name in layerCounts) {
      if (!layerCounts[name]) continue;
      any = true;
      const row = document.createElement('div');
      row.className = 'stat stat-layer';
      const label = document.createElement('span');
      label.className = 'stat-label';
      label.textContent = name;
      const value = document.createElement('span');
      value.className = 'stat-value';
      value.textContent = layerCounts[name];
      row.append(label, value);
      statsPanel.insertBefore(row, artworkRow);
    }
    statMaskLabel.textContent = any ? 'Other artwork' : 'Artwork shapes';
  }

  // Preview look per LED-window mode, so each part reads as what it is on
  // the board: touch (TouchCopper) = exposed copper, covered (TouchBlack) =
  // copper under solder mask, black with gray hatch, front/back/both
  // (LEDWindow) = LED window, light yellow. Artwork with no mode keeps the
  // solder-mask teal (.kicad-mask-shape).
  const MODE_STYLES = {
    touch: { cls: 'kicad-copper-shape', hatch: 'copper' },
    covered: { cls: 'kicad-covered-shape', hatch: 'covered' },
    front: { cls: 'kicad-led-window-shape' },
    back: { cls: 'kicad-led-window-shape' },
    both: { cls: 'kicad-led-window-shape' },
  };

  // groups: [{ mode, maskSegs }] — the other artwork (mode = the LED-window
  // setting) plus each named layer, each drawn in its MODE_STYLES look.
  // Keep-outs aren't drawn: each keep-out mode already has its own look,
  // and a hatch overlay would cover it.
  function showKicadPreview(edgeSegs, groups) {
    const svgNS = 'http://www.w3.org/2000/svg';
    const artworkSegs = [].concat(...groups.map((g) => g.maskSegs));
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const pts of edgeSegs.concat(artworkSegs)) {
      for (const [x, y] of pts) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }

    if (!isFinite(minX)) {
      kicadPreviewBox.innerHTML = KICAD_PREVIEW_PLACEHOLDER;
      kicadPreviewBox.classList.add('empty');
      return;
    }

    const w = maxX - minX || 1;
    const h = maxY - minY || 1;
    const pad = Math.max(w, h) * 0.06;
    const vbX = minX - pad, vbY = minY - pad, vbW = w + pad * 2, vbH = h + pad * 2;

    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('class', 'kicad-preview-svg');
    svg.setAttribute('viewBox', `${vbX} ${vbY} ${vbW} ${vbH}`);
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

    const unit = Math.max(vbW, vbH);
    const defs = document.createElementNS(svgNS, 'defs');
    svg.appendChild(defs);
    // Diagonal hatch sized to the view so it reads the same at any board
    // size, echoing KiCad's own hatched rendering of copper fills: a solid
    // background plus one line, colored by CSS (.kicad-<name>-hatch-bg/-line).
    const hatchIds = new Set();
    const hatchFill = (name) => {
      const id = name + 'Hatch';
      if (!hatchIds.has(id)) {
        hatchIds.add(id);
        const gap = unit * 0.012;
        const pattern = document.createElementNS(svgNS, 'pattern');
        pattern.setAttribute('id', id);
        pattern.setAttribute('patternUnits', 'userSpaceOnUse');
        pattern.setAttribute('width', gap);
        pattern.setAttribute('height', gap);
        const bg = document.createElementNS(svgNS, 'rect');
        bg.setAttribute('width', gap);
        bg.setAttribute('height', gap);
        bg.setAttribute('class', `kicad-${name}-hatch-bg`);
        pattern.appendChild(bg);
        const line = document.createElementNS(svgNS, 'path');
        line.setAttribute('d', `M0,${gap} L${gap},0`);
        line.setAttribute('class', `kicad-${name}-hatch-line`);
        line.setAttribute('stroke-width', unit * 0.0025);
        pattern.appendChild(line);
        defs.appendChild(pattern);
      }
      return `url(#${id})`;
    };

    // Covered copper (under solder mask) goes underneath, since on the board
    // any exposed copper or window over it is what shows.
    const drawOrder = groups.filter((g) => g.mode === 'covered')
      .concat(groups.filter((g) => g.mode !== 'covered'));
    for (const g of drawOrder) {
      const style = MODE_STYLES[g.mode] || { cls: 'kicad-mask-shape' };
      for (const pts of g.maskSegs) {
        const poly = document.createElementNS(svgNS, 'polygon');
        poly.setAttribute('points', pts.map(([x, y]) => `${x},${y}`).join(' '));
        poly.setAttribute('class', style.cls);
        if (style.hatch) poly.setAttribute('fill', hatchFill(style.hatch));
        svg.appendChild(poly);
      }
    }

    for (const pts of edgeSegs) {
      const poly = document.createElementNS(svgNS, 'polygon');
      poly.setAttribute('points', pts.map(([x, y]) => `${x},${y}`).join(' '));
      poly.setAttribute('class', 'kicad-edge-shape');
      poly.setAttribute('stroke-width', Math.max(vbW, vbH) * 0.003);
      svg.appendChild(poly);
    }

    kicadPreviewBox.innerHTML = '';
    kicadPreviewBox.appendChild(svg);
    kicadPreviewBox.classList.remove('empty');
  }

  function getScale() {
    const v = parseFloat(scaleInput.value);
    return isFinite(v) && v > 0 ? v : 1;
  }

  // Output size: the reference box (the board outline, else all artwork —
  // the box the anchor uses too) times the scale. Typing a width or height
  // sets the scale so that side comes out that size, keeping the proportions;
  // the other two fields follow whichever one is being typed in.
  function boxSize() {
    const b = state.box;
    return b ? [b.maxX - b.minX, b.maxY - b.minY] : [0, 0];
  }

  function formatNumber(v, decimals) {
    return String(Number(v.toFixed(decimals)));
  }

  function showSize(typedIn) {
    const [w, h] = boxSize();
    if (typedIn !== widthInput) widthInput.value = w ? formatNumber(w * state.scale, 3) : '';
    if (typedIn !== heightInput) heightInput.value = h ? formatNumber(h * state.scale, 3) : '';
    if (typedIn !== scaleInput) scaleInput.value = formatNumber(state.scale, 6);
  }

  function onSizeInput(input, natural) {
    const v = parseFloat(input.value);
    if (!(v > 0 && natural > 0)) return;
    state.scale = v / natural;
    showSize(input);
    updateOutput();
  }

  // Bumped per file, so a slow load (a large PNG) can't overwrite a newer one.
  let loadCount = 0;

  function handleFile(file) {
    if (!file) return;
    const load = ++loadCount;
    resetForNewFile();
    fileNameEl.hidden = false;
    fileNameEl.textContent = file.name;

    file.arrayBuffer().then((buffer) => {
      if (load !== loadCount) return;
      const bytes = new Uint8Array(buffer);
      if (window.Converter.isPng(bytes)) return loadPng(file, bytes, load);
      const text = new TextDecoder().decode(bytes);
      let result;
      try {
        result = window.Converter.parseSvg(text);
      } catch (err) {
        setCopyStatus('Could not read that SVG: ' + err.message, true);
        return;
      }
      showResult(result, new Blob([text], { type: 'image/svg+xml' }));
    }).catch((err) => {
      if (load === loadCount) setCopyStatus('Could not read that file: ' + err.message, true);
    });
  }

  // The browser decodes the PNG, without color management, so the gray
  // levels are the file's own (as Pillow reads them in the CLI).
  function loadPng(file, bytes, load) {
    const blob = new Blob([bytes], { type: 'image/png' });
    const options = { colorSpaceConversion: 'none', premultiplyAlpha: 'none' };
    return createImageBitmap(blob, options).then((bitmap) => {
      if (load !== loadCount) return;
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(bitmap, 0, 0);
      const { data, width, height } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
      const result = window.Converter.parsePng(data, width, height, window.Converter.pngDpi(bytes));
      const [dx, dy] = result.image.dpi.map(Math.round);
      const dpiNote = !result.image.dpiFromFile
        ? `no DPI in the file, using ${dx}`
        : dx === dy ? `${dx} DPI` : `${dx} × ${dy} DPI`;
      fileNameEl.textContent = `${file.name} — ${width} × ${height} px, ${dpiNote}`;
      showResult(result, blob);
    });
  }

  function showResult(result, sourceBlob) {
    state.edgeSegs = result.edgeSegs;
    state.maskSegs = result.maskSegs;
    state.keepoutSegs = result.keepoutSegs;
    state.layerSegs = result.layerSegs;
    state.stats = result.stats;
    state.box = window.Converter.referenceBox(result.edgeSegs, result.maskSegs, result.layerSegs);

    statEdge.textContent = result.stats.edgeCount;
    statMask.textContent = result.stats.maskCount;
    showLayerStats(result.stats.layerCounts);
    statRing.textContent = result.stats.ringCount;
    statSkipped.textContent = result.stats.skipped;
    statsPanel.hidden = false;
    controls.hidden = false;
    copyBtn.disabled = false;

    showSourcePreview(sourceBlob);
    showSize();

    updateOutput();
    updatePreview();
  }

  // Rebuilt on file load and LED-window changes — not on layer/scale changes.
  function updatePreview() {
    const ledWindow = ledWindowCheck.checked ? ledWindowSelect.value : null;
    const other = { mode: ledWindow, maskSegs: state.maskSegs };
    showKicadPreview(state.edgeSegs, [other].concat(Object.values(state.layerSegs)));
  }

  function updateOutput() {
    // LED window replaces the artwork layer with its own mask layers.
    const ledWindow = ledWindowCheck.checked ? ledWindowSelect.value : null;
    ledWindowSelect.hidden = !ledWindow;
    layerSelect.disabled = !!ledWindow;
    state.kicadText = window.Converter.renderKicadText(
      state.edgeSegs,
      state.maskSegs,
      layerSelect.value,
      state.scale,
      ledWindow,
      state.keepoutSegs,
      anchorSelect.value,
      state.layerSegs
    );
  }

  // The source panel is the only file target: drop an SVG or PNG on it, or
  // click it (Enter/Space when focused) to browse.
  svgPreviewBox.addEventListener('click', () => fileInput.click());
  svgPreviewBox.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fileInput.click();
    }
  });
  svgPreviewBox.addEventListener('dragover', (e) => {
    e.preventDefault();
    svgPreviewBox.classList.add('drag-over');
  });
  svgPreviewBox.addEventListener('dragleave', () => {
    svgPreviewBox.classList.remove('drag-over');
  });
  svgPreviewBox.addEventListener('drop', (e) => {
    e.preventDefault();
    svgPreviewBox.classList.remove('drag-over');
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    handleFile(file);
  });

  fileInput.addEventListener('change', () => {
    handleFile(fileInput.files && fileInput.files[0]);
  });

  layerSelect.addEventListener('change', updateOutput);
  scaleInput.addEventListener('input', () => {
    state.scale = getScale();
    showSize(scaleInput);
    updateOutput();
  });
  widthInput.addEventListener('input', () => onSizeInput(widthInput, boxSize()[0]));
  heightInput.addEventListener('input', () => onSizeInput(heightInput, boxSize()[1]));
  anchorSelect.addEventListener('change', updateOutput);
  ledWindowCheck.addEventListener('change', () => {
    updateOutput();
    updatePreview();
  });
  ledWindowSelect.addEventListener('change', () => {
    updateOutput();
    updatePreview();
  });

  let moreLayersShown = false;
  moreLayersToggle.addEventListener('click', () => {
    moreLayersShown = !moreLayersShown;
    moreLayersGroup.hidden = !moreLayersShown;
    moreLayersToggle.textContent = moreLayersShown ? 'Hide more layers' : 'Show more layers';
  });

  function fallbackCopy(text) {
    clipboardStaging.classList.remove('visible');
    clipboardStaging.value = text;
    clipboardStaging.focus();
    clipboardStaging.select();

    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch (e) {
      ok = false;
    }

    if (ok) {
      setCopyStatus('Copied to clipboard.', false);
    } else {
      clipboardStaging.classList.add('visible');
      clipboardStaging.focus();
      clipboardStaging.select();
      setCopyStatus('Clipboard blocked — press Cmd/Ctrl+C to copy the text below.', true);
    }
  }

  function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        () => setCopyStatus('Copied to clipboard.', false),
        () => fallbackCopy(text)
      );
    } else {
      fallbackCopy(text);
    }
  }

  copyBtn.addEventListener('click', () => {
    if (!state.kicadText) return;
    copyToClipboard(state.kicadText);
  });

  populateLayerSelect();
})();
