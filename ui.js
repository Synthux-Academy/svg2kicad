// ui.js — drag/drop, layer selection, clipboard wiring

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
    stats: null,
    kicadText: '',
    svgPreviewUrl: null,
  };

  const dropZone = document.getElementById('dropZone');
  const fileInput = document.getElementById('fileInput');
  const fileNameEl = document.getElementById('fileName');
  const statsPanel = document.getElementById('statsPanel');
  const statEdge = document.getElementById('statEdge');
  const statMask = document.getElementById('statMask');
  const statRing = document.getElementById('statRing');
  const statSkipped = document.getElementById('statSkipped');
  const controls = document.getElementById('controls');
  const layerSelect = document.getElementById('layerSelect');
  const scaleInput = document.getElementById('scaleInput');
  const ledWindowCheck = document.getElementById('ledWindowCheck');
  const ledWindowSelect = document.getElementById('ledWindowSelect');
  const commonLayersGroup = document.getElementById('commonLayers');
  const moreLayersGroup = document.getElementById('moreLayers');
  const moreLayersToggle = document.getElementById('moreLayersToggle');
  const copyBtn = document.getElementById('copyBtn');
  const copyStatus = document.getElementById('copyStatus');
  const clipboardStaging = document.getElementById('clipboardStaging');
  const svgPreviewBox = document.getElementById('svgPreview');
  const kicadPreviewBox = document.getElementById('kicadPreview');
  const SVG_PREVIEW_PLACEHOLDER = '<p class="preview-placeholder">Drop an SVG to preview it here.</p>';
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

    if (state.svgPreviewUrl) {
      URL.revokeObjectURL(state.svgPreviewUrl);
      state.svgPreviewUrl = null;
    }
    svgPreviewBox.classList.add('empty');
    svgPreviewBox.innerHTML = SVG_PREVIEW_PLACEHOLDER;
    kicadPreviewBox.classList.add('empty');
    kicadPreviewBox.innerHTML = KICAD_PREVIEW_PLACEHOLDER;
  }

  function showSourcePreview(svgText) {
    const blob = new Blob([svgText], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    state.svgPreviewUrl = url;

    const img = document.createElement('img');
    img.alt = 'SVG preview';
    img.src = url;

    svgPreviewBox.innerHTML = '';
    svgPreviewBox.appendChild(img);
    svgPreviewBox.classList.remove('empty');
  }

  // keepoutSegs is drawn (hatched, like KiCad's rule areas) only when
  // non-empty — i.e. only while LED window is on.
  function showKicadPreview(edgeSegs, maskSegs, keepoutSegs) {
    const svgNS = 'http://www.w3.org/2000/svg';
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const pts of edgeSegs.concat(maskSegs)) {
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

    for (const pts of maskSegs) {
      const poly = document.createElementNS(svgNS, 'polygon');
      poly.setAttribute('points', pts.map(([x, y]) => `${x},${y}`).join(' '));
      poly.setAttribute('class', 'kicad-mask-shape');
      svg.appendChild(poly);
    }
    if (keepoutSegs.length) {
      // Diagonal hatch sized to the view so it reads the same at any board size.
      const unit = Math.max(vbW, vbH);
      const gap = unit * 0.012;
      const defs = document.createElementNS(svgNS, 'defs');
      const pattern = document.createElementNS(svgNS, 'pattern');
      pattern.setAttribute('id', 'keepoutHatch');
      pattern.setAttribute('patternUnits', 'userSpaceOnUse');
      pattern.setAttribute('width', gap);
      pattern.setAttribute('height', gap);
      const line = document.createElementNS(svgNS, 'path');
      line.setAttribute('d', `M0,${gap} L${gap},0`);
      line.setAttribute('class', 'kicad-keepout-hatch');
      line.setAttribute('stroke-width', unit * 0.0025);
      pattern.appendChild(line);
      defs.appendChild(pattern);
      svg.appendChild(defs);

      for (const pts of keepoutSegs) {
        const poly = document.createElementNS(svgNS, 'polygon');
        poly.setAttribute('points', pts.map(([x, y]) => `${x},${y}`).join(' '));
        poly.setAttribute('class', 'kicad-keepout-shape');
        poly.setAttribute('fill', 'url(#keepoutHatch)');
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

  function handleFile(file) {
    if (!file) return;
    resetForNewFile();
    fileNameEl.hidden = false;
    fileNameEl.textContent = file.name;

    file.text().then((text) => {
      let result;
      try {
        result = window.Converter.parseSvg(text);
      } catch (err) {
        setCopyStatus('Could not read that SVG: ' + err.message, true);
        return;
      }

      state.edgeSegs = result.edgeSegs;
      state.maskSegs = result.maskSegs;
      state.keepoutSegs = result.keepoutSegs;
      state.stats = result.stats;

      statEdge.textContent = result.stats.edgeCount;
      statMask.textContent = result.stats.maskCount;
      statRing.textContent = result.stats.ringCount;
      statSkipped.textContent = result.stats.skipped;
      statsPanel.hidden = false;
      controls.hidden = false;
      copyBtn.disabled = false;

      showSourcePreview(text);

      updateOutput();
      updatePreview();
    }).catch((err) => {
      setCopyStatus('Could not read that file: ' + err.message, true);
    });
  }

  // Rebuilt on file load and LED-window changes — not on layer/scale changes.
  function updatePreview() {
    showKicadPreview(
      state.edgeSegs,
      state.maskSegs,
      ledWindowCheck.checked ? state.keepoutSegs : []
    );
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
      getScale(),
      ledWindow,
      state.keepoutSegs
    );
  }

  dropZone.addEventListener('click', () => fileInput.click());
  dropZone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fileInput.click();
    }
  });
  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
  });
  dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('drag-over');
  });
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    handleFile(file);
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
  scaleInput.addEventListener('input', updateOutput);
  ledWindowCheck.addEventListener('change', () => {
    updateOutput();
    updatePreview();
  });
  ledWindowSelect.addEventListener('change', updateOutput);

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
