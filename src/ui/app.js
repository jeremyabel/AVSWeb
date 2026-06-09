import '../effects/register.js';
import { AVSEngine } from '../core/engine.js';
import { EffectEntry } from '../core/effect-chain.js';
import { EffectRegistry } from '../core/registry.js';
import { Preset } from '../core/preset.js';
import { buildConfigPanel } from './config-panels.js';
import { EffectListEffect } from '../effects/effect-list.js';

let engine;

// Selection state: which EffectEntry is selected, and its parent if inside a list.
let selectedEntry  = null;  // EffectEntry
let selectedParent = null;  // EffectListEffect | null

// Which EffectListEffect entries are currently expanded in the UI.
const expandedLists = new WeakSet();

// Active drag — set on dragstart, cleared on dragend/drop.
// Stored at module level so cross-level drops don't need serialization.
let dragState = null; // { entry: EffectEntry, parent: EffectListEffect | null }

// Filename used for the last save/load; null means the preset has never been named.
let currentPresetName = null;

// Move an entry from one chain/list to another (or reorder within the same one).
// dstIdx is the insertion index in the destination array BEFORE removal.
function moveEntry(movedEntry, srcParent, dstParent, dstIdx) {
  const srcArr = srcParent instanceof EffectListEffect ? srcParent.entries : engine.chain.entries;
  const dstArr = dstParent instanceof EffectListEffect ? dstParent.entries : engine.chain.entries;
  const srcIdx = srcArr.indexOf(movedEntry);
  if (srcIdx === -1) return;
  srcArr.splice(srcIdx, 1);
  // If removing from the same array, the destination index shifts left by one when srcIdx < dstIdx.
  const insertAt = (srcArr === dstArr && srcIdx < dstIdx) ? dstIdx - 1 : dstIdx;
  dstArr.splice(Math.max(0, Math.min(insertAt, dstArr.length)), 0, movedEntry);
}

// ── Init ──────────────────────────────────────────────────────────────────────

function init() {
  const canvas = document.getElementById('avs-canvas');
  engine = new AVSEngine(canvas);
  engine.start();

  buildEffectSelect(document.getElementById('effect-select'));
  loadDefaultPreset();
  hookToolbar();
  hookResizers();
  hookInspector();
  startFPSCounter();
}

// ── Effect select ─────────────────────────────────────────────────────────────

function buildEffectSelect(sel) {
  for (const name of EffectRegistry.names()) {
    const opt = document.createElement('option');
    opt.value = name; opt.textContent = name;
    sel.appendChild(opt);
  }
}

// ── Preset ────────────────────────────────────────────────────────────────────

async function loadDefaultPreset() {
  try {
    const res = await fetch('/presets/default.json');
    if (!res.ok) throw new Error('not found');
    const json = await res.json();
    Preset.fromJSON(engine.gl, engine.chain, json);
  } catch {
    addEffect(engine.chain, 'Fadeout');
    addEffect(engine.chain, 'Simple');
  }
  renderChainUI();
}

// ── Toolbar ───────────────────────────────────────────────────────────────────

function hookToolbar() {
  const addBtn = document.getElementById('btn-add-effect');
  const sel    = document.getElementById('effect-select');

  addBtn.addEventListener('click', () => {
    if (sel.value) { addEffect(engine.chain, sel.value); renderChainUI(); }
  });

  document.getElementById('btn-dup-effect').addEventListener('click', () => {
    if (!selectedEntry) return;
    const name = selectedEntry.effect.getDescriptor().name;
    const Cls = EffectRegistry.get(name);
    if (!Cls) return;
    const effect = new Cls(engine.gl);
    effect.setConfig(selectedEntry.effect.getConfig());
    const clone = new EffectEntry(effect);
    clone.enabled = selectedEntry.enabled;
    const arr = selectedParent instanceof EffectListEffect
      ? selectedParent.entries
      : engine.chain.entries;
    arr.splice(arr.indexOf(selectedEntry) + 1, 0, clone);
    renderChainUI();
  });

  function promptSaveAs() {
    const input = prompt('Save preset as:', currentPresetName?.replace(/\.json$/, '') ?? 'preset');
    if (!input) return;
    currentPresetName = input.endsWith('.json') ? input : input + '.json';
    Preset.download(engine.chain, currentPresetName);
  }

  document.getElementById('btn-save-preset').addEventListener('click', () => {
    if (!currentPresetName) { promptSaveAs(); return; }
    Preset.download(engine.chain, currentPresetName);
  });

  document.getElementById('btn-saveas-preset').addEventListener('click', promptSaveAs);

  const fileInput = document.getElementById('preset-file-input');
  document.getElementById('btn-load-preset').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0]; if (!file) return;
    try {
      const json = JSON.parse(await file.text());
      Preset.fromJSON(engine.gl, engine.chain, json);
      currentPresetName = file.name;
      selectedEntry = null; selectedParent = null;
      renderChainUI(); renderConfigPanel();
    } catch (e) { alert('Failed to load preset: ' + e.message); }
    fileInput.value = '';
  });

  const micBtn   = document.getElementById('btn-toggle-mic');
  const mp3Btn   = document.getElementById('btn-load-mp3');
  const mp3Input = document.getElementById('mp3-file-input');

  // Tracks the active <audio> element when MP3 is the source (null = mic or off).
  let audioEl = null;

  function setMicBtn(on) {
    micBtn.textContent = on ? '⏸ Mic' : '▶ Mic';
    micBtn.className   = on ? 'audio-on' : '';
  }
  function setMp3Btn(on, paused = false) {
    mp3Btn.textContent = (on && !paused) ? '⏸ MP3' : '▶ MP3';
    mp3Btn.className   = on ? 'audio-on' : '';
  }

  micBtn.addEventListener('click', async () => {
    const micActive = engine.audio.active && !audioEl;
    if (micActive) {
      engine.audio.disconnect();
      setMicBtn(false);
    } else {
      if (audioEl) { audioEl.pause(); audioEl = null; }
      try {
        engine.audio.resume();
        await engine.audio.connectMicrophone();
        setMicBtn(true);
        setMp3Btn(false);
      } catch (e) { alert('Microphone access denied: ' + e.message); }
    }
  });

  mp3Btn.addEventListener('click', () => {
    if (audioEl) {
      if (audioEl.paused) { audioEl.play().catch(() => {}); setMp3Btn(true, false); }
      else                { audioEl.pause();                setMp3Btn(true, true);  }
    } else {
      mp3Input.click();
    }
  });

  mp3Input.addEventListener('change', () => {
    const file = mp3Input.files[0];
    if (!file) return;

    const url = URL.createObjectURL(file);
    if (audioEl && audioEl._objectUrl) URL.revokeObjectURL(audioEl._objectUrl);

    const el = new Audio();
    el._objectUrl = url;
    el.src        = url;
    el.loop       = true;
    audioEl       = el;

    engine.audio.resume();
    engine.audio.connectAudioElement(el);
    el.play().catch(() => {});

    setMicBtn(false);
    setMp3Btn(true, false);
    mp3Btn.title = file.name;
    mp3Input.value = '';
  });
}

// ── Effect creation ───────────────────────────────────────────────────────────

function addEffect(targetChainOrList, name) {
  const Cls = EffectRegistry.get(name); if (!Cls) return;
  const effect = new Cls(engine.gl);
  const entry  = new EffectEntry(effect);
  if (targetChainOrList instanceof EffectListEffect) {
    targetChainOrList.entries.push(entry);
  } else {
    targetChainOrList.add(entry);
  }
  return entry;
}

function removeEffectEntry(entry, parent) {
  if (parent instanceof EffectListEffect) {
    const idx = parent.entries.indexOf(entry);
    if (idx !== -1) parent.removeEntry(idx);
  } else {
    engine.chain.remove(entry);
    entry.effect.destroy();
  }
  if (selectedEntry === entry) { selectedEntry = null; selectedParent = null; }
}

// ── Chain UI ──────────────────────────────────────────────────────────────────

function renderChainUI() {
  const list = document.getElementById('chain-list');
  list.innerHTML = '';
  engine.chain.entries.forEach((entry, idx) => {
    list.appendChild(makeChainItem(entry, idx, null, engine.chain));
  });
}

function makeChainItem(entry, idx, parentList, ownerChain) {
  const isEffectList = entry.effect instanceof EffectListEffect;
  const isSelected   = (entry === selectedEntry);

  const item = document.createElement('div');
  item.className = 'chain-item' +
    (isSelected     ? ' selected' : '') +
    (!entry.enabled ? ' disabled' : '') +
    (isEffectList   ? ' is-list'  : '');

  const header = document.createElement('div');
  header.className = 'chain-item-header';

  // ── Enabled toggle ────────────────────────────────────────────────────
  const toggle = document.createElement('div');
  toggle.className = 'enabled-toggle' + (entry.enabled ? ' on' : '');
  toggle.textContent = entry.enabled ? '✓' : '';
  toggle.title = 'Toggle enabled';
  toggle.addEventListener('click', e => {
    e.stopPropagation();
    entry.enabled = !entry.enabled;
    renderChainUI();
  });

  // ── Expand button (Effect List only) ──────────────────────────────────
  // Also acts as a drop target: dragging onto it appends to this list.
  let expandBtn = null;
  if (isEffectList) {
    expandBtn = document.createElement('button');
    expandBtn.className = 'expand-btn';
    const expanded = expandedLists.has(entry.effect);
    expandBtn.textContent = expanded ? '▾' : '▸';
    expandBtn.title = 'Expand/collapse — or drag an effect here to add it to this list';

    expandBtn.addEventListener('click', e => {
      e.stopPropagation();
      if (expandedLists.has(entry.effect)) expandedLists.delete(entry.effect);
      else expandedLists.add(entry.effect);
      renderChainUI();
    });

    // Drop onto expand button → append to this Effect List
    expandBtn.addEventListener('dragover', e => {
      if (!dragState || dragState.entry === entry) return;
      e.preventDefault(); e.stopPropagation();
      expandBtn.classList.add('drag-over');
    });
    expandBtn.addEventListener('dragleave', () => expandBtn.classList.remove('drag-over'));
    expandBtn.addEventListener('drop', e => {
      e.preventDefault(); e.stopPropagation();
      expandBtn.classList.remove('drag-over');
      if (!dragState || dragState.entry === entry) return;
      const targetList = entry.effect;
      moveEntry(dragState.entry, dragState.parent, targetList, targetList.entries.length);
      expandedLists.add(targetList); // reveal where the item landed
      dragState = null;
      renderChainUI();
    });
  }

  // ── Name label ────────────────────────────────────────────────────────
  const nameEl = document.createElement('span');
  nameEl.className = 'name';
  nameEl.textContent = entry.effect.getDescriptor().name +
    (isEffectList ? ` (${entry.effect.entries.length})` : '');

  // ── Remove button ─────────────────────────────────────────────────────
  const removeBtn = document.createElement('button');
  removeBtn.className = 'remove-btn';
  removeBtn.textContent = '×';
  removeBtn.title = 'Remove';
  removeBtn.addEventListener('click', e => {
    e.stopPropagation();
    removeEffectEntry(entry, parentList);
    renderChainUI();
    renderConfigPanel();
  });

  // ── Drag-to-reorder / cross-list drag ─────────────────────────────────
  // dragstart is on the whole item so the grab handle is the full row.
  item.draggable = true;
  item.addEventListener('dragstart', e => {
    e.stopPropagation();
    dragState = { entry, parent: parentList };
    e.dataTransfer.setData('text/plain', 'avs-effect');
    e.dataTransfer.effectAllowed = 'move';
  });
  item.addEventListener('dragend', () => { dragState = null; });

  // Drop target is the HEADER only (not the whole item) so that the sub-chain
  // area and its own drop zone don't fight with "insert before" semantics.
  header.addEventListener('dragover', e => {
    if (!dragState || dragState.entry === entry) return;
    e.preventDefault(); e.stopPropagation();
    header.classList.add('drag-over');
  });
  header.addEventListener('dragleave', () => header.classList.remove('drag-over'));
  header.addEventListener('drop', e => {
    e.preventDefault(); e.stopPropagation();
    header.classList.remove('drag-over');
    if (!dragState || dragState.entry === entry) return;
    // Insert before this item in its parent (parentList = containing EffectList or null for root).
    moveEntry(dragState.entry, dragState.parent, parentList, idx);
    dragState = null;
    renderChainUI();
  });

  // ── Assemble header ───────────────────────────────────────────────────
  header.appendChild(toggle);
  if (expandBtn) header.appendChild(expandBtn);
  header.appendChild(nameEl);
  header.appendChild(removeBtn);

  header.addEventListener('click', () => {
    selectedEntry  = entry;
    selectedParent = parentList;
    renderChainUI();
    renderConfigPanel();
  });

  item.appendChild(header);

  // ── Sub-chain (expanded Effect List only) ─────────────────────────────
  if (isEffectList && expandedLists.has(entry.effect)) {
    const subChain = document.createElement('div');
    subChain.className = 'sub-chain';

    const listEffect = entry.effect;
    listEffect.entries.forEach((subEntry, subIdx) => {
      subChain.appendChild(makeChainItem(subEntry, subIdx, listEffect, null));
    });

    // ── Drop zone at bottom of sub-chain (append to list) ──────────────
    const dropZone = document.createElement('div');
    dropZone.className = 'sub-drop-zone';
    dropZone.textContent = '↓ drop here to append';
    dropZone.addEventListener('dragover', e => {
      if (!dragState) return;
      e.preventDefault(); e.stopPropagation();
      dropZone.classList.add('active');
    });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('active'));
    dropZone.addEventListener('drop', e => {
      e.preventDefault(); e.stopPropagation();
      dropZone.classList.remove('active');
      if (!dragState) return;
      moveEntry(dragState.entry, dragState.parent, listEffect, listEffect.entries.length);
      dragState = null;
      renderChainUI();
    });
    subChain.appendChild(dropZone);

    // ── "Add to list" row ──────────────────────────────────────────────
    const addRow = document.createElement('div');
    addRow.className = 'sub-add-row';
    const subSel = document.createElement('select');
    subSel.className = 'sub-effect-select';
    buildEffectSelect(subSel);
    const addSubBtn = document.createElement('button');
    addSubBtn.textContent = '+ Add';
    addSubBtn.addEventListener('click', e => {
      e.stopPropagation();
      if (subSel.value) { addEffect(listEffect, subSel.value); renderChainUI(); }
    });
    addRow.appendChild(subSel);
    addRow.appendChild(addSubBtn);
    subChain.appendChild(addRow);

    item.appendChild(subChain);
  }

  return item;
}

// ── Config panel ──────────────────────────────────────────────────────────────

function renderConfigPanel() {
  const container = document.getElementById('config-content');
  if (!selectedEntry) {
    container.innerHTML = '<p class="placeholder">Select an effect to configure it.</p>';
    return;
  }
  buildConfigPanel(container, selectedEntry, () => { renderChainUI(); });
}

// ── Panel resizers ────────────────────────────────────────────────────────────

function hookResizers() {
  hookPanelResizer('resizer-left',  'chain-panel',  +1);
  hookPanelResizer('resizer-right', 'config-panel', -1);
}

function hookPanelResizer(resizerId, panelId, sign) {
  const resizer = document.getElementById(resizerId);
  const panel   = document.getElementById(panelId);

  resizer.addEventListener('mousedown', e => {
    const startX = e.clientX;
    const startW = panel.offsetWidth;
    resizer.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMove = e => {
      const w = Math.max(120, startW + sign * (e.clientX - startX));
      panel.style.width = w + 'px';
    };
    const onUp = () => {
      resizer.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

// ── Pixel Inspector ───────────────────────────────────────────────────────────

function hookInspector() {
  const btn    = document.getElementById('btn-inspector');
  const panel  = document.getElementById('inspector-panel');
  const xInput = document.getElementById('inspector-x');
  const yInput = document.getElementById('inspector-y');
  const swatch = document.getElementById('inspector-swatch');
  const rgbEl  = document.getElementById('inspector-rgb');
  const canvas = document.getElementById('avs-canvas');
  const gl     = engine.gl;

  let active = false;

  function readPixel() {
    const x = parseInt(xInput.value, 10) || 0;
    const y = parseInt(yInput.value, 10) || 0;
    if (x < 0 || x >= canvas.width || y < 0 || y >= canvas.height) {
      swatch.style.background = '#000';
      rgbEl.textContent = 'out of bounds';
      return;
    }
    const buf = new Uint8Array(4);
    // WebGL origin is bottom-left, so flip Y
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(x, canvas.height - 1 - y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    const [r, g, b] = buf;
    swatch.style.background = `rgb(${r},${g},${b})`;
    rgbEl.textContent = `${r}, ${g}, ${b}`;
  }

  btn.addEventListener('click', () => {
    active = !active;
    btn.classList.toggle('active', active);
    panel.hidden = !active;
    engine.afterRender = active ? readPixel : null;
  });

  // Click canvas to pick a coordinate when inspector is open.
  canvas.addEventListener('click', e => {
    if (!active) return;
    const rect   = canvas.getBoundingClientRect();
    const scaleX = canvas.width  / rect.width;
    const scaleY = canvas.height / rect.height;
    xInput.value = Math.round((e.clientX - rect.left) * scaleX);
    yInput.value = Math.round((e.clientY - rect.top)  * scaleY);
  });
}

// ── FPS counter ───────────────────────────────────────────────────────────────

function startFPSCounter() {
  const el = document.getElementById('fps-counter');
  setInterval(() => { el.textContent = engine.fps + ' fps'; }, 500);
}

window.addEventListener('DOMContentLoaded', init);
