const GOOGLE_FONTS_API_KEY = 'AIzaSyBQNUok2LtX8sO8H1zcoYuBngfTKZcPfV8';
let _fontsCache = null;
let _fontsFetchPromise = null;

function fetchGoogleFonts() {
  if (_fontsCache) return Promise.resolve(_fontsCache);
  if (_fontsFetchPromise) return _fontsFetchPromise;
  _fontsFetchPromise = fetch(
    `https://www.googleapis.com/webfonts/v1/webfonts?key=${GOOGLE_FONTS_API_KEY}&sort=popularity`
  )
    .then(r => r.json())
    .then(data => {
      _fontsCache = data.items.map(f => f.family);
      _fontsFetchPromise = null;
      return _fontsCache;
    });
  return _fontsFetchPromise;
}

// Build the config UI for a selected effect entry.
// container: DOM element to populate
// entry: EffectEntry
// onChange: callback() called whenever a value changes
export function buildConfigPanel(container, entry, onChange) {
  container.innerHTML = '';

  const effect = entry.effect;
  const desc = effect.getDescriptor();
  const cfg = effect.getConfig();

  const title = document.createElement('h3');
  title.className = 'cfg-title';
  title.textContent = desc.name;
  container.appendChild(title);

  // ── Enabled toggle ──────────────────────────────────
  addBool(container, 'Enabled', entry.enabled, v => { entry.enabled = v; onChange(); });

  // ── Effect-specific params ───────────────────────────
  for (const param of desc.params) {
    if (param.visibleWhen && cfg[param.visibleWhen.param] !== param.visibleWhen.value) continue;
    const val = cfg[param.name];

    if (param.type === 'color') {
      // Colors can be a single [r,g,b] or an array of colors (Simple uses array)
      const singleColor = Array.isArray(val) && typeof val[0] === 'number';
      const colorVal = singleColor ? val : (val && val[0]) || [255,255,255];
      addColor(container, param.label, colorVal, newColor => {
        if (singleColor) {
          const c = effect.getConfig();
          c[param.name] = newColor;
          effect.setConfig(c);
        } else {
          const c = effect.getConfig();
          if (!c[param.name]) c[param.name] = [];
          c[param.name][0] = newColor;
          effect.setConfig(c);
        }
        onChange();
      });

    } else if (param.type === 'range') {
      const g = addRange(container, param.label, val ?? param.default, param.min, param.max, param.step, newVal => {
        const c = effect.getConfig();
        c[param.name] = newVal;
        effect.setConfig(c);
        onChange();
      });
      if (param.disabledWhen && cfg[param.disabledWhen.param] === param.disabledWhen.value) {
        for (const input of g.querySelectorAll('input')) input.disabled = true;
      }

    } else if (param.type === 'bool') {
      addBool(container, param.label, val ?? param.default, newVal => {
        const c = effect.getConfig();
        c[param.name] = newVal;
        effect.setConfig(c);
        onChange();
        if (desc.params.some(p => p.visibleWhen || p.disabledWhen)) buildConfigPanel(container, entry, onChange);
      });

    } else if (param.type === 'select') {
      addSelect(container, param.label, param.options, val ?? param.default, newVal => {
        const c = effect.getConfig();
        c[param.name] = typeof param.options[0].value === 'number' ? Number(newVal) : newVal;
        effect.setConfig(c);
        onChange();
        if (desc.params.some(p => p.visibleWhen)) buildConfigPanel(container, entry, onChange);
      });

    } else if (param.type === 'glsl') {
      const g = addGLSL(container, param.label, val ?? param.default, newCode => {
        if (typeof effect.setPixelCode === 'function') {
          effect.setPixelCode(newCode);
        } else if (typeof effect.setStub === 'function') {
          effect.setStub(newCode);
        } else {
          const c = effect.getConfig();
          c[param.name] = newCode;
          effect.setConfig(c);
        }
        g.querySelector('.glsl-error').textContent = effect.getCompileError?.() ?? '';
        onChange();
      });
      g.querySelector('.glsl-error').textContent = effect.getCompileError?.() ?? '';

    } else if (param.type === 'js') {
      const g = addJS(container, param.label, param.name, val ?? param.default, newVal => {
        const c = effect.getConfig();
        c[param.name] = newVal;
        effect.setConfig(c);
        for (const el of container.querySelectorAll('.glsl-error[data-param]'))
          el.textContent = effect.getJsError?.(el.dataset.param) ?? '';
        onChange();
      });
      g.querySelector('.glsl-error').textContent = effect.getJsError?.(param.name) ?? '';

    } else if (param.type === 'text') {
      addText(container, param.label, val ?? param.default, newVal => {
        const c = effect.getConfig();
        c[param.name] = newVal;
        effect.setConfig(c);
        onChange();
      });

    } else if (param.type === 'int') {
      addInt(container, param.label, val ?? param.default, newVal => {
        const c = effect.getConfig();
        c[param.name] = newVal;
        effect.setConfig(c);
        onChange();
      }, param.min, param.max);

    } else if (param.type === 'kernel') {
      addKernel(container, param.label, val ?? Array(param.size * param.size).fill(0), param.size, (idx, newVal) => {
        const c = effect.getConfig();
        c[param.name] = [...(c[param.name] ?? val)];
        c[param.name][idx] = newVal;
        effect.setConfig(c);
        onChange();
      });

    } else if (param.type === 'action') {
      addAction(container, param.label, () => {
        if (typeof effect[param.name] === 'function') effect[param.name]();
        onChange();
        buildConfigPanel(container, entry, onChange);
      });

    } else if (param.type === 'file-action') {
      addAction(container, param.label, () => {
        if (typeof effect[param.name] === 'function') {
          effect[param.name](() => { onChange(); buildConfigPanel(container, entry, onChange); });
        }
      });

    } else if (param.type === 'image-upload') {
      addImageUpload(container, param.label, val ?? param.default, newVal => {
        const c = effect.getConfig();
        c[param.name] = newVal;
        effect.setConfig(c);
        onChange();
      });

    } else if (param.type === 'beat-meter') {
      addBeatMeter(container, param.label, param.liveKey, effect);

    } else if (param.type === 'buffer-slot') {
      const bufOpts = Array.from({ length: 8 }, (_, i) => ({ value: i, label: `Buffer ${i + 1}` }));
      addSelect(container, param.label, bufOpts, val ?? param.default, newVal => {
        const c = effect.getConfig();
        c[param.name] = Number(newVal);
        effect.setConfig(c);
        onChange();
        if (desc.params.some(p => p.visibleWhen)) buildConfigPanel(container, entry, onChange);
      });

    } else if (param.type === 'font-select') {
      addFontSelect(container, param.label, val ?? param.default, newVal => {
        const c = effect.getConfig();
        c[param.name] = newVal;
        effect.setConfig(c);
        onChange();
      });

    } else if (param.type === 'colors') {
      addColorCycler(container, param.label, val ?? param.default, newColors => {
        const c = effect.getConfig();
        c[param.name] = newColors;
        effect.setConfig(c);
        onChange();
      });

    } else if (param.type === 'colormap-editor') {
      addColormapEditor(container, effect, onChange);
    }
  }
}

// ── Widget helpers ───────────────────────────────────────────────────────────

function group(container, labelText) {
  const div = document.createElement('div');
  div.className = 'cfg-group';
  const lbl = document.createElement('label');
  lbl.textContent = labelText;
  div.appendChild(lbl);
  container.appendChild(div);
  return div;
}

function addBeatMeter(container, label, liveKey, effect) {
  const g = group(container, label);
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:3px;margin-top:4px;';
  const segs = Array.from({ length: 8 }, () => {
    const seg = document.createElement('div');
    seg.style.cssText = 'flex:1;height:10px;border-radius:2px;background:#222;border:1px solid #3a3a3a;';
    row.appendChild(seg);
    return seg;
  });
  g.appendChild(row);

  function tick() {
    if (!row.isConnected) return;
    const state  = effect.getLiveState?.() ?? {};
    const active = Math.min(7, Math.max(0, (state[liveKey] ?? 0) | 0));
    for (let i = 0; i < 8; i++) {
      segs[i].style.background = i === active ? '#55aaff' : '#222';
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
  return g;
}

function addFontSelect(container, label, value, onChange) {
  const g = group(container, label);
  const sel = document.createElement('select');
  sel.style.cssText = 'width:100%;background:var(--bg);color:var(--text);border:1px solid var(--border);padding:3px;font-size:12px;';
  g.appendChild(sel);

  function populate(fonts) {
    const current = sel.value || value;
    sel.innerHTML = '';
    if (value && !fonts.includes(value)) {
      const opt = document.createElement('option');
      opt.value = value; opt.textContent = value; opt.selected = true;
      sel.appendChild(opt);
    }
    for (const family of fonts) {
      const opt = document.createElement('option');
      opt.value = family; opt.textContent = family;
      if (family === current) opt.selected = true;
      sel.appendChild(opt);
    }
    if (!sel.value && fonts.length > 0) sel.value = fonts[0];
  }

  if (_fontsCache) {
    populate(_fontsCache);
  } else {
    const placeholder = document.createElement('option');
    placeholder.value = value || '';
    placeholder.textContent = value ? value : 'Loading fonts...';
    sel.appendChild(placeholder);
    fetchGoogleFonts().then(fonts => { if (sel.isConnected) populate(fonts); });
  }

  sel.addEventListener('change', () => onChange(sel.value));
  return g;
}

function addRange(container, label, value, min, max, step, onChange) {
  const g = group(container, label);
  const row = document.createElement('div');
  row.style.display = 'flex'; row.style.gap = '6px'; row.style.alignItems = 'center';
  const input = document.createElement('input');
  input.type = 'range'; input.min = min; input.max = max; input.step = step; input.value = value;
  const num = document.createElement('input');
  num.type = 'number'; num.min = min; num.max = max; num.step = step; num.value = value;
  num.style.width = '55px';
  input.addEventListener('input', () => { num.value = input.value; onChange(parseFloat(input.value)); });
  num.addEventListener('change', () => { input.value = num.value; onChange(parseFloat(num.value)); });
  row.appendChild(input); row.appendChild(num);
  g.appendChild(row);
  return g;
}

function addBool(container, label, value, onChange) {
  const g = group(container, '');
  const lbl = document.createElement('label');
  lbl.style.display = 'flex'; lbl.style.alignItems = 'center';
  const cb = document.createElement('input');
  cb.type = 'checkbox'; cb.checked = value;
  cb.addEventListener('change', () => onChange(cb.checked));
  lbl.appendChild(cb);
  lbl.appendChild(document.createTextNode(label));
  g.appendChild(lbl);
  return g;
}

function addColor(container, label, value, onChange) {
  const g = group(container, label);
  const input = document.createElement('input');
  input.type = 'color';
  input.value = rgbToHex(value);
  input.addEventListener('input', () => onChange(hexToRgb(input.value)));
  g.appendChild(input);
  return g;
}

// Segmented color-cycle picker. colors: number[] of 0xRRGGBB integers (1-16 entries).
function addColorCycler(container, label, colors, onChange) {
  const g = group(container, label);

  // Count row
  const countRow = document.createElement('div');
  countRow.className = 'cfg-color-cycle-count';
  const countLabel = document.createElement('span');
  countLabel.textContent = 'Count:';
  const countInput = document.createElement('input');
  countInput.type = 'number';
  countInput.min = 1;
  countInput.max = 16;
  countInput.value = colors.length;
  countRow.appendChild(countLabel);
  countRow.appendChild(countInput);
  g.appendChild(countRow);

  // Segmented bar
  const bar = document.createElement('div');
  bar.className = 'cfg-color-cycle-bar';
  g.appendChild(bar);

  let current = [...colors];

  function intToHex(n) {
    return '#' + (n >>> 0).toString(16).padStart(6, '0');
  }

  function rebuild() {
    bar.innerHTML = '';
    for (let i = 0; i < current.length; i++) {
      const hex = intToHex(current[i]);
      const seg = document.createElement('div');
      seg.className = 'cfg-color-cycle-seg';
      seg.style.background = hex;
      seg.title = `Color ${i + 1}`;

      const picker = document.createElement('input');
      picker.type = 'color';
      picker.value = hex;
      picker.style.cssText = 'position:absolute;opacity:0;width:0;height:0;pointer-events:none';
      picker.addEventListener('input', () => {
        current[i] = parseInt(picker.value.slice(1), 16);
        seg.style.background = picker.value;
        onChange([...current]);
      });

      seg.appendChild(picker);
      seg.addEventListener('click', () => picker.click());
      bar.appendChild(seg);
    }
  }

  countInput.addEventListener('change', () => {
    const n = Math.max(1, Math.min(16, parseInt(countInput.value, 10) || 1));
    countInput.value = n;
    while (current.length < n) current.push(current[current.length - 1] ?? 0xffffff);
    current = current.slice(0, n);
    rebuild();
    onChange([...current]);
  });

  rebuild();
  return g;
}

function addSelect(container, label, options, value, onChange) {
  const g = group(container, label);
  const sel = document.createElement('select');
  for (const opt of options) {
    const el = document.createElement('option');
    el.value = opt.value;
    el.textContent = opt.label;
    if (String(opt.value) === String(value)) el.selected = true;
    sel.appendChild(el);
  }
  sel.addEventListener('change', () => onChange(sel.value));
  g.appendChild(sel);
  return g;
}

function addGLSL(container, label, value, onChange) {
  const g = group(container, label);
  const ta = document.createElement('textarea');
  ta.value = value;
  ta.spellcheck = false;
  ta.addEventListener('input', () => onChange(ta.value));
  g.appendChild(ta);
  const errEl = document.createElement('div');
  errEl.className = 'glsl-error';
  g.appendChild(errEl);
  return g;
}

function addJS(container, label, paramName, value, onChange) {
  const g = group(container, label);
  const ta = document.createElement('textarea');
  ta.value = value ?? '';
  ta.spellcheck = false;
  ta.style.fontFamily = "'Consolas', monospace";
  ta.style.fontSize = '11px';
  ta.addEventListener('input', () => onChange(ta.value));
  g.appendChild(ta);
  const errEl = document.createElement('div');
  errEl.className = 'glsl-error';
  errEl.dataset.param = paramName;
  g.appendChild(errEl);
  return g;
}

function addText(container, label, value, onChange) {
  const g = group(container, label);
  const ta = document.createElement('textarea');
  ta.value = value ?? '';
  ta.spellcheck = false;
  ta.style.fontFamily = "'Consolas', monospace";
  ta.style.fontSize = '11px';
  ta.addEventListener('input', () => onChange(ta.value));
  g.appendChild(ta);
  return g;
}

// ── Colormap gradient editor ─────────────────────────────────────────────────

function addColormapEditor(container, effect, onChange) {
  // Which map is being edited (persists on the effect across panel rebuilds)
  if (effect._uiMapIdx === undefined) effect._uiMapIdx = 0;

  // ── Map selector row ──
  const selRow = document.createElement('div');
  selRow.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:6px;';

  const mapSel = document.createElement('select');
  mapSel.style.cssText = 'flex:1;background:var(--bg);color:var(--text);border:1px solid var(--border);padding:3px;';
  for (let i = 0; i < 8; i++) {
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = `Map ${i + 1}`;
    mapSel.appendChild(opt);
  }
  mapSel.value = effect._uiMapIdx;

  const enableChk = document.createElement('input');
  enableChk.type = 'checkbox';
  enableChk.title = 'Enable this map';
  enableChk.checked = effect.maps[effect._uiMapIdx].enabled;

  const enableLbl = document.createElement('label');
  enableLbl.style.cssText = 'display:flex;align-items:center;gap:4px;white-space:nowrap;font-size:11px;color:var(--text-dim);';
  enableLbl.appendChild(enableChk);
  enableLbl.appendChild(document.createTextNode('Enabled'));

  selRow.appendChild(mapSel);
  selRow.appendChild(enableLbl);
  container.appendChild(selRow);

  // ── Gradient canvas ──
  const canvasWrap = document.createElement('div');
  canvasWrap.style.cssText = 'margin-bottom:6px;border:1px solid var(--border);';
  const canvas = document.createElement('canvas');
  canvas.height = 65;
  canvas.style.cssText = 'display:block;width:100%;cursor:crosshair;';
  canvasWrap.appendChild(canvas);
  container.appendChild(canvasWrap);

  // ── Action buttons ──
  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'display:flex;gap:6px;margin-bottom:8px;';
  const flipBtn  = makeBtn('Flip Map');
  const clearBtn = makeBtn('Clear Map');
  const saveBtn  = makeBtn('Save .clm');
  const loadBtn  = makeBtn('Load .clm');
  btnRow.appendChild(flipBtn);
  btnRow.appendChild(clearBtn);
  btnRow.appendChild(saveBtn);
  btnRow.appendChild(loadBtn);
  container.appendChild(btnRow);

  // ── Canvas sizing (wait for layout) ──
  let selectedIdx = -1;
  let dragging    = false;
  const GRAD_H    = 45;

  function getMapIdx() { return effect._uiMapIdx; }

  function redraw() {
    const map = effect.maps[getMapIdx()];
    const W = canvas.offsetWidth || 200;
    if (canvas.width !== W) canvas.width = W;
    const H = canvas.height;
    const ctx2 = canvas.getContext('2d');
    ctx2.clearRect(0, 0, W, H);

    // Gradient strip via ImageData
    const imgData = ctx2.createImageData(W, GRAD_H);
    const baked   = map.baked;
    for (let x = 0; x < W; x++) {
      const k = Math.round(x * 255 / Math.max(W - 1, 1));
      const r = baked[k*4], g = baked[k*4+1], b = baked[k*4+2];
      for (let y = 0; y < GRAD_H; y++) {
        const p = (y * W + x) * 4;
        imgData.data[p]   = r; imgData.data[p+1] = g;
        imgData.data[p+2] = b; imgData.data[p+3] = 255;
      }
    }
    ctx2.putImageData(imgData, 0, 0);

    // Border around gradient
    ctx2.strokeStyle = '#555';
    ctx2.strokeRect(0, 0, W, GRAD_H);

    // Triangle handles
    const colors = map.colors;
    for (let i = 0; i < colors.length; i++) {
      const x  = Math.round(colors[i].position * (W - 1) / 255);
      const [r, g, b] = colors[i].color;
      ctx2.fillStyle   = `rgb(${r},${g},${b})`;
      ctx2.strokeStyle = selectedIdx === i ? '#ffffff' : '#000000';
      ctx2.lineWidth   = 1.5;
      ctx2.beginPath();
      ctx2.moveTo(x,     GRAD_H + 3);
      ctx2.lineTo(x + 7, H - 1);
      ctx2.lineTo(x - 7, H - 1);
      ctx2.closePath();
      ctx2.fill();
      ctx2.stroke();
    }
  }

  function hitTest(x) {
    const map = effect.maps[getMapIdx()];
    const W   = canvas.width;
    for (let i = 0; i < map.colors.length; i++) {
      const hx = map.colors[i].position * (W - 1) / 255;
      if (Math.abs(x - hx) < 8) return i;
    }
    return -1;
  }

  function xToPos(x) {
    const W = canvas.width;
    return Math.max(0, Math.min(255, Math.round(x * 255 / (W - 1))));
  }

  canvas.addEventListener('mousedown', e => {
    const rect = canvas.getBoundingClientRect();
    const x    = (e.clientX - rect.left) * (canvas.width  / rect.width);
    const y    = (e.clientY - rect.top)  * (canvas.height / rect.height);
    if (y >= GRAD_H) selectedIdx = hitTest(x);
    dragging = true;
    redraw();
  });

  canvas.addEventListener('mousemove', e => {
    if (!dragging || selectedIdx < 0) return;
    const rect = canvas.getBoundingClientRect();
    const x    = (e.clientX - rect.left) * (canvas.width / rect.width);
    const map  = effect.maps[getMapIdx()];
    map.colors[selectedIdx].position = xToPos(Math.max(0, Math.min(canvas.width, x)));
    effect.bakeMap(getMapIdx());
    onChange();
    redraw();
  });

  canvas.addEventListener('mouseup', () => { dragging = false; });
  canvas.addEventListener('mouseleave', () => { dragging = false; });

  canvas.addEventListener('dblclick', e => {
    const rect = canvas.getBoundingClientRect();
    const x    = (e.clientX - rect.left) * (canvas.width  / rect.width);
    const y    = (e.clientY - rect.top)  * (canvas.height / rect.height);
    if (y < GRAD_H) return;

    const hit = hitTest(x);
    const map = effect.maps[getMapIdx()];

    if (hit >= 0) {
      // Edit existing stop
      cmOpenPicker(map.colors[hit].color, newColor => {
        map.colors[hit].color = newColor;
        effect.bakeMap(getMapIdx());
        onChange();
        redraw();
      });
    } else {
      // Add new stop at this position
      const pos     = xToPos(x);
      const baked   = map.baked;
      const initClr = [baked[pos*4], baked[pos*4+1], baked[pos*4+2]];
      cmOpenPicker(initClr, newColor => {
        map.colors.push({ position: pos, color: newColor });
        effect.bakeMap(getMapIdx());
        selectedIdx = map.colors.length - 1;
        onChange();
        redraw();
      });
    }
  });

  canvas.addEventListener('contextmenu', e => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const x    = (e.clientX - rect.left) * (canvas.width  / rect.width);
    const y    = (e.clientY - rect.top)  * (canvas.height / rect.height);
    if (y < GRAD_H) return;

    const hit = hitTest(x);
    const map = effect.maps[getMapIdx()];
    selectedIdx = hit;
    redraw();

    const pos = xToPos(x);
    const items = [
      { label: 'Add Color', action: () => {
        const baked   = map.baked;
        const initClr = [baked[pos*4], baked[pos*4+1], baked[pos*4+2]];
        cmOpenPicker(initClr, newColor => {
          map.colors.push({ position: pos, color: newColor });
          effect.bakeMap(getMapIdx()); selectedIdx = map.colors.length - 1;
          onChange(); redraw();
        });
      }},
    ];
    if (hit >= 0) {
      items.push({ label: 'Edit Color', action: () => {
        cmOpenPicker(map.colors[hit].color, newColor => {
          map.colors[hit].color = newColor;
          effect.bakeMap(getMapIdx()); onChange(); redraw();
        });
      }});
      if (map.colors.length > 1) {
        items.push({ label: 'Delete Color', action: () => {
          map.colors.splice(hit, 1);
          selectedIdx = -1;
          effect.bakeMap(getMapIdx()); onChange(); redraw();
        }});
      }
      items.push({ label: `Set Position (${map.colors[hit].position})`, action: () => {
        const newPos = parseInt(prompt('Position (0-255):', map.colors[hit].position), 10);
        if (!isNaN(newPos)) {
          map.colors[hit].position = Math.max(0, Math.min(255, newPos));
          effect.bakeMap(getMapIdx()); onChange(); redraw();
        }
      }});
    }
    showContextMenu(e.clientX, e.clientY, items);
  });

  // ── Map selector events ──
  mapSel.addEventListener('change', () => {
    effect._uiMapIdx = parseInt(mapSel.value, 10);
    selectedIdx      = -1;
    enableChk.checked = effect.maps[effect._uiMapIdx].enabled;
    redraw();
  });

  enableChk.addEventListener('change', () => {
    effect.maps[getMapIdx()].enabled = enableChk.checked;
    onChange();
  });

  flipBtn.addEventListener('click', () => {
    effect.flipMap(getMapIdx());
    onChange(); redraw();
  });

  clearBtn.addEventListener('click', () => {
    if (!confirm('Clear this map?')) return;
    effect.clearMap(getMapIdx());
    selectedIdx = -1;
    onChange(); redraw();
  });

  saveBtn.addEventListener('click', () => {
    effect.saveMap(getMapIdx());
  });

  loadBtn.addEventListener('click', () => {
    effect.loadMap(getMapIdx(), () => { selectedIdx = -1; onChange(); redraw(); });
  });

  // Draw after layout
  requestAnimationFrame(redraw);
}

function makeBtn(text) {
  const btn = document.createElement('button');
  btn.textContent = text;
  btn.style.flex = '1';
  return btn;
}

function cmOpenPicker(initialColor, callback) {
  const input     = document.createElement('input');
  input.type      = 'color';
  input.value     = rgbArrToHex(initialColor);
  input.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0;';
  document.body.appendChild(input);

  let removed = false;
  const remove = () => {
    if (!removed && document.body.contains(input)) {
      removed = true;
      document.body.removeChild(input);
    }
  };

  input.addEventListener('input',  e => callback(hexToRgbArr(e.target.value)));
  input.addEventListener('change', remove);
  input.addEventListener('blur',   () => setTimeout(remove, 150));
  input.click();
}

function showContextMenu(screenX, screenY, items) {
  // Remove any existing context menu
  document.querySelector('.avs-ctx-menu')?.remove();

  const menu = document.createElement('div');
  menu.className = 'avs-ctx-menu';
  menu.style.cssText = [
    'position:fixed', `left:${screenX}px`, `top:${screenY}px`,
    'background:#2a2a2a', 'border:1px solid #555', 'border-radius:3px',
    'z-index:9999', 'box-shadow:2px 2px 6px rgba(0,0,0,0.6)', 'min-width:160px',
  ].join(';');

  for (const item of items) {
    if (item.separator) {
      const sep = document.createElement('div');
      sep.style.cssText = 'height:1px;background:#444;margin:2px 0;';
      menu.appendChild(sep);
      continue;
    }
    const btn = document.createElement('div');
    btn.textContent = item.label;
    btn.style.cssText = 'padding:5px 12px;cursor:pointer;color:#e0e0e0;font-size:12px;';
    btn.addEventListener('mouseenter', () => btn.style.background = '#3a3a3a');
    btn.addEventListener('mouseleave', () => btn.style.background = '');
    btn.addEventListener('mousedown', e => {
      e.preventDefault();
      menu.remove();
      item.action();
    });
    menu.appendChild(btn);
  }

  document.body.appendChild(menu);

  // Close on outside click
  const close = e => {
    if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('mousedown', close); }
  };
  setTimeout(() => document.addEventListener('mousedown', close), 0);
}

function rgbArrToHex([r, g, b]) {
  return '#' + [r, g, b].map(v => (v & 255).toString(16).padStart(2, '0')).join('');
}
function hexToRgbArr(hex) {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

function addInt(container, label, value, onChange, min, max) {
  const g = group(container, label);
  const input = document.createElement('input');
  input.type = 'number'; input.step = '1'; input.value = value;
  if (min !== undefined) input.min = min;
  if (max !== undefined) input.max = max;
  input.style.width = '100%';
  input.style.background = 'var(--bg)'; input.style.color = 'var(--text)';
  input.style.border = '1px solid var(--border)'; input.style.padding = '4px';
  input.addEventListener('change', () => {
    let v = parseInt(input.value, 10);
    if (isNaN(v)) return;
    if (min !== undefined) v = Math.max(min, v);
    if (max !== undefined) v = Math.min(max, v);
    input.value = v;
    onChange(v);
  });
  input.addEventListener('blur', () => {
    let v = parseInt(input.value, 10);
    if (isNaN(v)) v = min ?? 0;
    if (min !== undefined) v = Math.max(min, v);
    if (max !== undefined) v = Math.min(max, v);
    input.value = v;
  });
  g.appendChild(input);
  return g;
}

function addKernel(container, label, values, dim, onChange) {
  const g = group(container, label);
  const grid = document.createElement('div');
  grid.style.display = 'grid';
  grid.style.gridTemplateColumns = `repeat(${dim}, 1fr)`;
  grid.style.gap = '2px';
  grid.style.marginTop = '4px';

  for (let i = 0; i < dim * dim; i++) {
    const input = document.createElement('input');
    input.type = 'number'; input.step = '1'; input.value = values[i] ?? 0;
    input.className = 'kernel-cell';
    input.style.width = '100%'; input.style.minWidth = '0';
    input.style.background = 'var(--bg)'; input.style.color = 'var(--text)';
    input.style.border = '1px solid var(--border)';
    const idx = i;
    input.addEventListener('change', () => {
      const v = parseInt(input.value, 10);
      if (!isNaN(v)) onChange(idx, v);
    });
    input.addEventListener('blur', () => { input.value = parseInt(input.value, 10) || 0; });
    grid.appendChild(input);
  }
  g.appendChild(grid);
  return g;
}

function addImageUpload(container, label, currentDataUrl, onChange) {
  const g = group(container, label);

  const preview = document.createElement('img');
  preview.style.cssText = 'width:100%;max-height:80px;object-fit:contain;background:#111;display:block;margin-bottom:4px;border:1px solid var(--border);';
  if (currentDataUrl) { preview.src = currentDataUrl; } else { preview.style.display = 'none'; }
  g.appendChild(preview);

  const row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:4px;';

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'image/*';
  fileInput.style.display = 'none';

  const chooseBtn = document.createElement('button');
  chooseBtn.textContent = 'Choose Image';
  chooseBtn.style.flex = '1';
  chooseBtn.addEventListener('click', () => fileInput.click());

  const clearBtn = document.createElement('button');
  clearBtn.textContent = 'Clear';
  clearBtn.addEventListener('click', () => {
    preview.src = '';
    preview.style.display = 'none';
    fileInput.value = '';
    onChange('');
  });

  fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = e => {
      const dataUrl = e.target.result;
      preview.src = dataUrl;
      preview.style.display = 'block';
      onChange(dataUrl);
    };
    reader.readAsDataURL(file);
    fileInput.value = '';
  });

  g.appendChild(fileInput);
  row.appendChild(chooseBtn);
  row.appendChild(clearBtn);
  g.appendChild(row);
  return g;
}

function addAction(container, label, onClick) {
  const g = group(container, '');
  const btn = document.createElement('button');
  btn.textContent = label;
  btn.style.width = '100%';
  btn.addEventListener('click', onClick);
  g.appendChild(btn);
  return g;
}

function rgbToHex([r, g, b]) {
  return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
}

function hexToRgb(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return [r, g, b];
}
