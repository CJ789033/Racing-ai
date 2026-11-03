import { Track, PRESETS, randomTrackPoints } from './sim/track.js';
import { Evolution, DEFAULT_SETTINGS, DT } from './sim/evolution.js';
import { Scene3D } from './render/scene3d.js';
import { TrackEditor } from './ui/editor.js';
import { TileEditor } from './ui/tileEditor.js';
import { TILE_PRESETS, traceLayout, COLS, ROWS, PIECES, GRID_SIZES, DEFAULT_GRID, fitsGrid, shiftTiles, setGridSize } from './sim/tiles.js';
import { drawNetwork, drawChart } from './ui/panels.js';

const $ = id => document.getElementById(id);
const SAVE_KEY = 'racing-ai-save-v3';
const OLD_SAVE_KEYS = ['racing-ai-save-v2']; // tracks are kept, brains (different inputs) are not
const SPEEDS = [1, 2, 5, 10, 25, 'MAX'];

// ---------------------------------------------------------------- state
const state = {
  mode: 'editor',
  editorKind: 'tiles', // tiles | spline
  def: null,           // what the player built: { kind, width, tiles | points }
  track: null,
  evo: null,
  settings: { ...DEFAULT_SETTINGS },
  paused: false,
  speedIdx: 0,
  shadows: true,
};

const scene = new Scene3D($('view3d'));
const editor = new TrackEditor($('editorCanvas'), { onChange: updateEditorInfo });
const tileEditor = new TileEditor($('tileCanvas'), $('palette'), $('props'), {
  onChange: ed => { updateEditorInfo(ed); layoutTileUI(); },
  onMessage: msg => toast(msg),
  getReserved: () => layoutTileUI(),
});

/**
 * Position the palette and the properties panel around the grid.
 * Landscape: palette on the left, properties on the right.
 * Portrait: palette above the bottom bar; while a piece is selected, its
 * properties replace the palette there.
 */
let lastPanelOpen = null;
function layoutTileUI() {
  const palEl = $('palette'), propsEl = $('props');
  const top = $('editorTop').getBoundingClientRect(), bar = $('editorBar').getBoundingClientRect();
  const H = window.innerHeight;
  const portrait = H > window.innerWidth;
  const open = tileEditor.panelOpen;
  palEl.classList.toggle('horizontal', portrait);
  propsEl.classList.toggle('horizontal', portrait);
  if (portrait) {
    palEl.style.top = 'auto'; palEl.style.maxHeight = '';
    palEl.style.bottom = (H - bar.top + 6) + 'px';
    palEl.style.visibility = open ? 'hidden' : 'visible';
    propsEl.style.display = open ? '' : 'none';
    propsEl.style.top = 'auto';
    propsEl.style.bottom = (H - bar.top + 6) + 'px';
    propsEl.style.maxHeight = Math.max(150, (bar.top - top.bottom) * 0.55) + 'px';
  } else {
    palEl.style.visibility = 'visible';
    palEl.style.bottom = 'auto';
    palEl.style.top = (top.bottom + 6) + 'px';
    palEl.style.maxHeight = Math.max(120, bar.top - top.bottom - 12) + 'px';
    propsEl.style.display = '';
    propsEl.style.bottom = 'auto';
    propsEl.style.top = '10px';
    propsEl.style.maxHeight = (bar.top - 20) + 'px';
  }
  const pal = palEl.getBoundingClientRect(), props = propsEl.getBoundingClientRect();
  let reserved;
  if (portrait) reserved = { top: top.bottom, bottom: H - Math.min(pal.top, H - 1), left: 0, right: 0 };
  else {
    // grid either below the info card, or beside it – whichever gives bigger cells
    const W = window.innerWidth, right = W - props.left, bottom = H - bar.top;
    const below = { top: top.bottom, bottom, left: pal.right, right };
    const beside = { top: 0, bottom, left: Math.max(pal.right, top.right), right };
    const cell = r => Math.min((W - r.left - r.right) / COLS, (H - r.top - r.bottom) / ROWS);
    reserved = cell(below) >= cell(beside) ? below : beside;
  }
  // In portrait the grid keeps its size when the panel opens/closes (no jumping)
  if (lastPanelOpen !== null && lastPanelOpen !== open && !portrait) requestAnimationFrame(() => tileEditor.resize());
  lastPanelOpen = open;
  return reserved;
}
window.__tileEditor = tileEditor; // handy for automated UI tests
const activeEditor = () => (state.editorKind === 'tiles' ? tileEditor : editor);

/** Build the simulation track from a saved/edited definition. */
function buildTrack(def) {
  if (def.kind === 'tiles') {
    setGridSize(def.cols || DEFAULT_GRID.cols, def.rows || DEFAULT_GRID.rows);
    const res = traceLayout(def.tiles);
    if (!res.ok) throw new Error(res.error.msg);
    return new Track(res.net, def.width);
  }
  return Track.fromLoop(def.points, def.width);
}

function currentDef() {
  return state.editorKind === 'tiles'
    ? { kind: 'tiles', width: tileEditor.width, cols: COLS, rows: ROWS, tiles: tileEditor.tiles.map(t => JSON.parse(JSON.stringify(t))) }
    : { kind: 'spline', width: editor.width, points: editor.points.map(({ x, z }) => ({ x, z })) };
}

function loadDefIntoEditor(def) {
  setEditorKind(def.kind === 'tiles' ? 'tiles' : 'spline');
  if (def.kind === 'tiles') {
    // older saves have no grid size: they were made on the default grid
    tileEditor.setGridSize(def.cols || DEFAULT_GRID.cols, def.rows || DEFAULT_GRID.rows, { recenter: false, force: true });
    syncGridSelect();
    tileEditor.setTiles(def.tiles, def.width);
  }
  else editor.setPoints(def.points, def.width);
}

function setEditorKind(kind) {
  state.editorKind = kind;
  const el = $('editor');
  el.classList.toggle('mode-tiles', kind === 'tiles');
  el.classList.toggle('mode-free', kind !== 'tiles');
  $('tabTiles').classList.toggle('active', kind === 'tiles');
  $('tabFree').classList.toggle('active', kind !== 'tiles');
  // presets for this mode
  const sel = $('ePreset');
  sel.innerHTML = '<option value="">Presets…</option>';
  const names = kind === 'tiles' ? Object.keys(TILE_PRESETS) : [...Object.keys(PRESETS), 'Random'];
  for (const name of names) { const o = document.createElement('option'); o.value = name; o.textContent = name; sel.appendChild(o); }
  if (state.mode === 'editor') requestAnimationFrame(() => { activeEditor().resize(); updateEditorInfo(activeEditor()); });
}

// ---------------------------------------------------------------- persistence
function save() {
  if (!state.track) return;
  const evo = state.evo;
  const data = {
    track: state.def,
    settings: state.settings,
    shadows: state.shadows,
    evo: evo && {
      generation: evo.generation,
      bestLap: evo.bestLap,
      bestFitness: evo.bestFitness,
      bestGenome: evo.bestGenome && Array.from(evo.bestGenome),
      history: evo.history.slice(-300),
    },
  };
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(data)); } catch { /* storage full/blocked */ }
}

function load() {
  try {
    const cur = JSON.parse(localStorage.getItem(SAVE_KEY));
    if (cur) return cur;
    for (const k of OLD_SAVE_KEYS) {
      const old = JSON.parse(localStorage.getItem(k));
      if (old && old.track) return { track: old.track, settings: old.settings, shadows: old.shadows };
    }
  } catch { /* ignore */ }
  return null;
}

// ---------------------------------------------------------------- modes
function enterEditor() {
  state.mode = 'editor';
  $('raceHud').classList.add('hidden');
  $('editor').classList.remove('hidden');
  activeEditor().resize();
  updateEditorInfo(activeEditor());
}

const sameDef = (a, b) => !!a && !!b && JSON.stringify(a) === JSON.stringify(b);

function startRace({ fromSave = null, reset = false } = {}) {
  if (!activeEditor().valid) return;
  const def = currentDef();
  const newTrack = buildTrack(def);
  const trackChanged = !state.track || !sameDef(def, state.def);
  state.def = def;

  if (fromSave) {
    state.track = newTrack;
    state.evo = new Evolution(newTrack, state.settings, fromSave.bestGenome);
    Object.assign(state.evo, {
      generation: fromSave.generation || 1,
      bestLap: fromSave.bestLap ?? null,
      bestFitness: fromSave.bestFitness ?? -Infinity,
      bestGenome: fromSave.bestGenome && fromSave.bestGenome.length === state.evo.cars[0].brain.size ? Float32Array.from(fromSave.bestGenome) : null,
      history: fromSave.history || [],
    });
  } else if (reset || !state.evo || trackChanged) {
    // A new track keeps the best brain so far as a starting point (transfer learning)
    const seed = !reset && state.evo ? state.evo.bestGenome : null;
    state.track = newTrack;
    state.evo = new Evolution(newTrack, state.settings, seed);
    if (seed && !reset) toast('New track – starting from the best brain so far');
  }

  scene.setTrack(state.track);
  scene.setPopulation(state.evo.cars.length);
  scene.renderer.shadowMap.enabled = state.shadows;
  state.mode = 'race';
  $('editor').classList.add('hidden');
  $('raceHud').classList.remove('hidden');
  scene.resize();
  save();
}

// ---------------------------------------------------------------- editor UI
function updateEditorInfo(ed) {
  if (ed !== activeEditor()) return;
  $('eGo').disabled = !ed.valid;
  $('eGo').style.opacity = ed.valid ? 1 : 0.5;
  let info = '', issue = null;
  if (ed === tileEditor) {
    const res = ed.result;
    if (ed.preview) info = `✅ Ready · ${res.order.some(t => PIECES[t.type].junction) ? 'shortest lap' : 'lap'} ${ed.preview.lapLength.toFixed(0)} m · ${res.order.length} pieces` + (res.unused ? ` · ${res.unused} unused` : '');
    else if (ed.tiles.length) issue = res.error ? res.error.msg : null;
    else info = 'Start by dragging the Start piece onto the grid';
  } else {
    if (ed.preview) info = `Length ${ed.preview.length.toFixed(0)} m · ${ed.points.length} points · width ${ed.width} m`;
    issue = ed.issue && ed.issue.text;
  }
  $('editorInfo').textContent = info;
  const box = $('editorIssue');
  box.classList.toggle('hidden', !issue);
  if (issue) box.textContent = '⚠ ' + issue;
  $('eWidthLbl').textContent = ed.width;
  $('eWidth').value = ed.width;
}

const presetSel = $('ePreset');
presetSel.onchange = () => {
  const v = presetSel.value;
  if (state.editorKind === 'tiles') { if (TILE_PRESETS[v]) loadTilePreset(TILE_PRESETS[v]); }
  else if (v === 'Random') editor.setPoints(randomTrackPoints(), editor.width);
  else if (PRESETS[v]) editor.setPoints(PRESETS[v].points, PRESETS[v].width);
  presetSel.value = '';
};
const setEditMode = m => {
  editor.mode = m;
  $('eAdd').classList.toggle('active', m === 'add');
  $('eDel').classList.toggle('active', m === 'delete');
  editor.draw();
};
$('eAdd').onclick = () => setEditMode('add');
$('eDel').onclick = () => setEditMode('delete');
$('eReverse').onclick = () => editor.reverse();
$('eStart').onclick = () => editor.rotateStart();
$('eClear').onclick = () => editor.setPoints([]);
$('eWidth').oninput = e => activeEditor().setWidth(Number(e.target.value));
$('tabTiles').onclick = () => setEditorKind('tiles');
$('tabFree').onclick = () => setEditorKind('spline');
function setTileMode(mode) {
  tileEditor.setMode(mode);
  $('tDel').classList.toggle('active', mode === 'delete');
  $('tSel').classList.toggle('active', mode === 'select');
  layoutTileUI();
  tileEditor.resize();
}
$('tDel').onclick = () => setTileMode(tileEditor.mode === 'delete' ? 'place' : 'delete');
$('tSel').onclick = () => setTileMode(tileEditor.mode === 'select' ? 'place' : 'select');
tileEditor.onExitSelect = () => setTileMode('place');
$('tClear').onclick = () => tileEditor.setTiles([]);

// Grid size
const gridSel = $('tGrid');
for (const g of GRID_SIZES) {
  const o = document.createElement('option');
  o.value = `${g.cols}x${g.rows}`; o.textContent = `${g.label} ${g.cols}×${g.rows}`;
  gridSel.appendChild(o);
}
function syncGridSelect() {
  if (![...gridSel.options].some(o => o.value === `${COLS}x${ROWS}`)) {
    const o = document.createElement('option'); o.value = `${COLS}x${ROWS}`; o.textContent = `${COLS}×${ROWS}`; gridSel.appendChild(o);
  }
  gridSel.value = `${COLS}x${ROWS}`;
}
gridSel.onchange = () => {
  const [c, r] = gridSel.value.split('x').map(Number);
  tileEditor.setGridSize(c, r);
  syncGridSelect(); // reverts the menu if the change was cancelled
};

/** Presets are designed on the default grid: centre them on the current one (or switch back if too small). */
function loadTilePreset(p) {
  const tiles = (() => { const prev = { c: COLS, r: ROWS }; setGridSize(DEFAULT_GRID.cols, DEFAULT_GRID.rows); const t = p.tiles(); setGridSize(prev.c, prev.r); return t; })();
  const moved = shiftTiles(tiles, Math.floor((COLS - DEFAULT_GRID.cols) / 2), Math.floor((ROWS - DEFAULT_GRID.rows) / 2));
  if (moved.every(fitsGrid)) { tileEditor.setTiles(moved, p.width); return; }
  tileEditor.setGridSize(DEFAULT_GRID.cols, DEFAULT_GRID.rows, { recenter: false, force: true });
  syncGridSelect();
  tileEditor.setTiles(tiles, p.width);
  toast('Grid set back to Medium so the preset fits');
}
$('eGo').onclick = () => startRace();

// ---------------------------------------------------------------- race UI
$('bEdit').onclick = () => { loadDefIntoEditor(state.def); enterEditor(); };
$('bPause').onclick = () => {
  state.paused = !state.paused;
  $('bPause').innerHTML = state.paused ? '▶️<small>Play</small>' : '⏸<small>Pause</small>';
};
$('bSpeed').onclick = () => {
  state.speedIdx = (state.speedIdx + 1) % SPEEDS.length;
  const s = SPEEDS[state.speedIdx];
  $('speedLbl').textContent = s === 'MAX' ? 'MAX' : s + '×';
};
$('bCam').onclick = () => {
  const m = scene.cycleCamera();
  $('camLbl').textContent = m[0].toUpperCase() + m.slice(1);
};
$('bSensors').onclick = () => {
  scene.showSensors = !scene.showSensors;
  $('bSensors').classList.toggle('active', scene.showSensors);
};
$('bSensors').classList.add('active');
$('bPanels').onclick = () => $('panels').classList.toggle('hidden');
$('bPanels').classList.add('active');

// Settings dialog
function syncSettingsUI() {
  const s = state.evo ? state.evo.settings : state.settings;
  $('iPop').value = state.settings.populationSize; $('vPop').textContent = state.settings.populationSize;
  $('iRate').value = s.mutationRate; $('vRate').textContent = s.mutationRate.toFixed(2);
  $('iStr').value = s.mutationStrength; $('vStr').textContent = s.mutationStrength.toFixed(2);
  $('iHidden').value = state.settings.hidden.join(',');
  $('iShadows').checked = state.shadows;
}
$('bSettings').onclick = () => { syncSettingsUI(); $('settings').classList.remove('hidden'); };
$('iPop').oninput = e => { state.settings.populationSize = Number(e.target.value); syncSettingsUI(); };
$('iRate').oninput = e => {
  state.settings.mutationRate = Number(e.target.value);
  if (state.evo) state.evo.settings.mutationRate = state.settings.mutationRate;
  syncSettingsUI();
};
$('iStr').oninput = e => {
  state.settings.mutationStrength = Number(e.target.value);
  if (state.evo) state.evo.settings.mutationStrength = state.settings.mutationStrength;
  syncSettingsUI();
};
$('iHidden').onchange = e => {
  const layers = e.target.value.split(/[,\s]+/).map(Number).filter(n => n > 0 && n <= 64).slice(0, 4);
  if (layers.length) state.settings.hidden = layers;
  syncSettingsUI();
};
$('iShadows').onchange = e => {
  state.shadows = e.target.checked;
  scene.renderer.shadowMap.enabled = state.shadows;
  scene.scene.traverse(o => { if (o.material) o.material.needsUpdate = true; });
  save();
};
$('sReset').onclick = () => {
  if (!confirm('Reset the AI? All learning will be lost.')) return;
  $('settings').classList.add('hidden');
  startRace({ reset: true });
};
$('sClose').onclick = () => {
  $('settings').classList.add('hidden');
  // Structural changes need a reset; offer it
  const evo = state.evo;
  const structural = evo && (evo.settings.populationSize !== state.settings.populationSize ||
    evo.settings.hidden.join() !== state.settings.hidden.join());
  if (structural && confirm('Population / network size changed. Restart evolution with the new settings?')) {
    const keepBrain = evo.settings.hidden.join() === state.settings.hidden.join();
    const seed = keepBrain ? evo.bestGenome : null;
    state.evo = new Evolution(state.track, state.settings, seed);
    scene.setPopulation(state.evo.cars.length);
  }
  save();
};

let toastTimer = null;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg; t.classList.remove('hidden'); t.style.opacity = 1;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.style.opacity = 0; setTimeout(() => t.classList.add('hidden'), 400); }, 2200);
}

// ---------------------------------------------------------------- main loop
let last = performance.now(), acc = 0, hudTimer = 0;
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (state.mode !== 'race' || !state.evo) return;
  const evo = state.evo;

  if (!state.paused) {
    const speed = SPEEDS[state.speedIdx];
    const prevGen = evo.generation, prevBest = evo.bestLap;
    if (speed === 'MAX') {
      const t0 = performance.now();
      while (performance.now() - t0 < 28) evo.step();
    } else {
      acc += dt * speed;
      let steps = 0;
      const t0 = performance.now();
      while (acc >= DT && steps < 2000) {
        evo.step(); acc -= DT; steps++;
        if ((steps & 31) === 0 && performance.now() - t0 > 30) { acc = 0; break; } // device can't keep up
      }
    }
    if (evo.generation !== prevGen) {
      save();
      if (evo.bestLap && evo.bestLap !== prevBest) toast(`🏆 New best lap: ${evo.bestLap.toFixed(2)} s`);
      drawChart($('chartCanvas'), evo.history);
    }
  }

  const leader = evo.leader();
  scene.updateCars(evo.cars, leader, dt, evo.time);

  hudTimer -= dt;
  if (hudTimer <= 0) {
    hudTimer = 0.1;
    $('sGen').textContent = evo.generation;
    $('sAlive').textContent = `${evo.aliveCount} / ${evo.cars.length}`;
    $('sTime').textContent = `${evo.time.toFixed(1)} / ${evo.timeLimit.toFixed(0)} s`;
    const lvl = leader && leader.speedLevel ? ` · ${leader.speedLevel > 0 ? '⏩+' : '🐢'}${leader.speedLevel}` : '';
    $('sSpeed').textContent = leader ? `${(leader.speed * 3.6).toFixed(0)} km/h · ${Math.min(100, Math.max(0, (leader.finished ? 1 : leader.progress / state.track.lapLength) * 100)).toFixed(0)}%${lvl}` : '-';
    $('sBest').textContent = evo.bestLap ? evo.bestLap.toFixed(2) + ' s' : '–';
    const ls = evo.lastStats;
    $('sLast').textContent = ls ? (ls.bestLap ? `${ls.bestLap.toFixed(2)} s (${ls.finishers}🏁)` : `${(ls.bestProgress * 100).toFixed(0)}%`) : '–';
    if (!$('panels').classList.contains('hidden')) {
      drawNetwork($('netCanvas'), leader && leader.brain);
      if (!evo._chartDrawn) { drawChart($('chartCanvas'), evo.history); evo._chartDrawn = true; }
    }
  }
}

// ---------------------------------------------------------------- boot
const saved = load();
editor.setPoints(PRESETS.Kidney.points, PRESETS.Kidney.width);
tileEditor.setTiles(TILE_PRESETS.Rectangle.tiles(), TILE_PRESETS.Rectangle.width);
syncGridSelect();
if (saved && saved.track) {
  state.settings = { ...DEFAULT_SETTINGS, ...saved.settings };
  state.shadows = saved.shadows ?? true;
  const def = saved.track.kind ? saved.track : { kind: 'spline', ...saved.track }; // older saves
  try {
    loadDefIntoEditor(def);
    startRace({ fromSave: saved.evo });
  } catch (e) { console.error(e); enterEditor(); }
} else {
  // Phones get no shadows by default
  state.shadows = !/Android|iPhone|iPad/i.test(navigator.userAgent);
  setEditorKind('tiles');
  enterEditor();
}
requestAnimationFrame(frame);
