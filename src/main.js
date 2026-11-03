import { Track, PRESETS, randomTrackPoints } from './sim/track.js';
import { Evolution, DEFAULT_SETTINGS, DT } from './sim/evolution.js';
import { Scene3D } from './render/scene3d.js';
import { TrackEditor } from './ui/editor.js';
import { drawNetwork, drawChart } from './ui/panels.js';

const $ = id => document.getElementById(id);
const SAVE_KEY = 'racing-ai-save-v1';
const SPEEDS = [1, 2, 5, 10, 25, 'MAX'];

// ---------------------------------------------------------------- state
const state = {
  mode: 'editor',
  track: null,
  evo: null,
  settings: { ...DEFAULT_SETTINGS },
  paused: false,
  speedIdx: 0,
  shadows: true,
};

const scene = new Scene3D($('view3d'));
const editor = new TrackEditor($('editorCanvas'), { onChange: updateEditorInfo });

// ---------------------------------------------------------------- persistence
function save() {
  if (!state.track) return;
  const evo = state.evo;
  const data = {
    track: state.track.toJSON(),
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
  try { return JSON.parse(localStorage.getItem(SAVE_KEY)); } catch { return null; }
}

// ---------------------------------------------------------------- modes
function enterEditor() {
  state.mode = 'editor';
  $('raceHud').classList.add('hidden');
  $('editor').classList.remove('hidden');
  editor.resize();
}

function sameTrack(a, b) {
  return a && b && a.width === b.width && a.points.length === b.points.length &&
    a.points.every((p, i) => Math.abs(p.x - b.points[i].x) < 1e-6 && Math.abs(p.z - b.points[i].z) < 1e-6);
}

function startRace({ fromSave = null, reset = false } = {}) {
  if (!editor.valid) return;
  const newTrack = new Track(editor.points, editor.width);
  const trackChanged = !state.track || !sameTrack(newTrack, state.track);

  if (fromSave) {
    state.track = newTrack;
    state.evo = new Evolution(newTrack, state.settings, fromSave.bestGenome);
    Object.assign(state.evo, {
      generation: fromSave.generation || 1,
      bestLap: fromSave.bestLap ?? null,
      bestFitness: fromSave.bestFitness ?? -Infinity,
      bestGenome: fromSave.bestGenome ? Float32Array.from(fromSave.bestGenome) : null,
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
  $('eGo').disabled = !ed.valid;
  $('eGo').style.opacity = ed.valid ? 1 : 0.5;
  $('editorInfo').textContent = ed.preview
    ? `Length ${ed.preview.length.toFixed(0)} m · ${ed.points.length} points · width ${ed.width} m`
    : '';
  const issue = $('editorIssue');
  issue.classList.toggle('hidden', !ed.issue);
  if (ed.issue) issue.textContent = '⚠ ' + ed.issue.text;
  $('eWidthLbl').textContent = ed.width;
  $('eWidth').value = ed.width;
}

const presetSel = $('ePreset');
for (const name of [...Object.keys(PRESETS), 'Random']) {
  const o = document.createElement('option'); o.value = name; o.textContent = name; presetSel.appendChild(o);
}
presetSel.onchange = () => {
  const v = presetSel.value;
  if (v === 'Random') editor.setPoints(randomTrackPoints(), editor.width);
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
$('eWidth').oninput = e => editor.setWidth(Number(e.target.value));
$('eGo').onclick = () => startRace();

// ---------------------------------------------------------------- race UI
$('bEdit').onclick = () => { editor.setPoints(state.track.points, state.track.width); enterEditor(); };
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
  scene.updateCars(evo.cars, leader, dt);

  hudTimer -= dt;
  if (hudTimer <= 0) {
    hudTimer = 0.1;
    $('sGen').textContent = evo.generation;
    $('sAlive').textContent = `${evo.aliveCount} / ${evo.cars.length}`;
    $('sTime').textContent = `${evo.time.toFixed(1)} / ${evo.timeLimit.toFixed(0)} s`;
    $('sSpeed').textContent = leader ? `${(leader.speed * 3.6).toFixed(0)} km/h · ${Math.min(100, Math.max(0, leader.progress / state.track.N * 100)).toFixed(0)}%` : '-';
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
if (saved && saved.track) {
  state.settings = { ...DEFAULT_SETTINGS, ...saved.settings };
  state.shadows = saved.shadows ?? true;
  editor.setPoints(saved.track.points, saved.track.width);
  editor.resize();
  try { startRace({ fromSave: saved.evo }); } catch (e) { console.error(e); enterEditor(); }
} else {
  // Phones get no shadows by default
  state.shadows = !/Android|iPhone|iPad/i.test(navigator.userAgent);
  editor.setPoints(PRESETS.Kidney.points, PRESETS.Kidney.width);
  enterEditor();
}
requestAnimationFrame(frame);
