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
    stats: null,
    kicadText: '',
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
  const commonLayersGroup = document.getElementById('commonLayers');
  const moreLayersGroup = document.getElementById('moreLayers');
  const moreLayersToggle = document.getElementById('moreLayersToggle');
  const copyBtn = document.getElementById('copyBtn');
  const copyStatus = document.getElementById('copyStatus');
  const clipboardStaging = document.getElementById('clipboardStaging');

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
      state.stats = result.stats;

      statEdge.textContent = result.stats.edgeCount;
      statMask.textContent = result.stats.maskCount;
      statRing.textContent = result.stats.ringCount;
      statSkipped.textContent = result.stats.skipped;
      statsPanel.hidden = false;
      controls.hidden = false;
      copyBtn.disabled = false;

      updateOutput();
    }).catch((err) => {
      setCopyStatus('Could not read that file: ' + err.message, true);
    });
  }

  function updateOutput() {
    state.kicadText = window.Converter.renderKicadText(
      state.edgeSegs,
      state.maskSegs,
      layerSelect.value,
      getScale()
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

  fileInput.addEventListener('change', () => {
    handleFile(fileInput.files && fileInput.files[0]);
  });

  layerSelect.addEventListener('change', updateOutput);
  scaleInput.addEventListener('input', updateOutput);

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
