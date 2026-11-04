// Hidden developer menu: ↑ ↑ ↓ ← → on a keyboard, or the same swipes on a touch screen.
// Shows what's useful when debugging (build, device, track, AI, police, storage, errors)
// and copies it all as one report to paste into a bug report.

import { RAY_ANGLES, LOOKAHEAD, RADAR_ZONES, INPUT_SIZE } from '../sim/car.js';
import { LATEST_ID } from '../changelog.js';

const SEQUENCE = ['up', 'up', 'down', 'left', 'right'];
const KEYS = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
const BUILD = {
  commit: typeof __BUILD_COMMIT__ !== 'undefined' ? __BUILD_COMMIT__ : 'dev',
  time: typeof __BUILD_TIME__ !== 'undefined' ? __BUILD_TIME__ : 'dev server',
};

// names for the racers' brain inputs, in order
const INPUT_NAMES = [
  ...RAY_ANGLES.map(a => `ray ${Math.round(a * 180 / Math.PI)}°`),
  'speed', 'lateral',
  ...LOOKAHEAD.map(d => `road ahead ${d} m`),
  'speed level', 'slide',
  ...['front', 'front-right', 'back-right', 'behind', 'back-left', 'front-left'].slice(0, RADAR_ZONES).map(z => `police ${z}`),
  'police closing',
];

const errors = [];
function logError(kind, msg) {
  errors.push({ t: new Date().toISOString().slice(11, 19), kind, msg: String(msg).slice(0, 400) });
  if (errors.length > 30) errors.shift();
}
window.addEventListener('error', e => logError('error', `${e.message} (${(e.filename || '').split('/').pop()}:${e.lineno})`));
window.addEventListener('unhandledrejection', e => logError('promise', e.reason && (e.reason.stack || e.reason.message) || e.reason));
const origConsoleError = console.error.bind(console);
console.error = (...a) => { logError('console', a.map(x => (x && x.stack) || String(x)).join(' ')); origConsoleError(...a); };

const r1 = v => (v == null || !Number.isFinite(v) ? v : Math.round(v * 10) / 10);
const r2 = v => (v == null || !Number.isFinite(v) ? v : Math.round(v * 100) / 100);

export class DevMenu {
  /** ctx(): { state, scene, tileEditor, speed, saveKey } – read fresh each refresh */
  constructor(ctx) {
    this.ctx = ctx;
    this.seq = [];
    this.fps = 0; this._frames = 0; this._t0 = performance.now();
    this.simRate = 0;
    const root = this.root = document.createElement('div');
    root.className = 'devMenu hidden';
    root.innerHTML = `
      <div class="devHead">
        <b>🛠️ Developer menu</b>
        <span class="devGap"></span>
        <button class="devCopy">Copy debug report</button>
        <button class="devClose" title="Close (Esc)">✕</button>
      </div>
      <div class="devBody"></div>
      <div class="devFoot muted small">Open / close: ↑ ↑ ↓ ← → (or swipe up, up, down, left, right). The report is copied as text – paste it into a message.</div>`;
    document.body.appendChild(root);
    this.body = root.querySelector('.devBody');
    root.querySelector('.devClose').onclick = () => this.toggle(false);
    root.querySelector('.devCopy').onclick = () => this.copy();

    window.addEventListener('keydown', e => {
      if (e.key === 'Escape' && this.open) { this.toggle(false); return; }
      const k = KEYS[e.key];
      if (k) this.push(k);
    });
    // swipes (touch screens): read passively, so they still pan / orbit as usual
    let sx = 0, sy = 0, st = 0;
    window.addEventListener('touchstart', e => { if (e.touches.length === 1) { sx = e.touches[0].clientX; sy = e.touches[0].clientY; st = performance.now(); } }, { passive: true });
    window.addEventListener('touchend', e => {
      const t = e.changedTouches[0]; if (!t || performance.now() - st > 600) return;
      const dx = t.clientX - sx, dy = t.clientY - sy;
      if (Math.max(Math.abs(dx), Math.abs(dy)) < 40) return;
      this.push(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up'));
    }, { passive: true });
  }

  push(dir) {
    this.seq.push(dir);
    if (this.seq.length > SEQUENCE.length) this.seq.shift();
    if (this.seq.join() === SEQUENCE.join()) { this.seq = []; this.toggle(); }
  }

  toggle(on = !this.open) {
    this.open = on;
    this.root.classList.toggle('hidden', !on);
    clearInterval(this.timer);
    if (on) { this.render(); this.timer = setInterval(() => this.render(), 500); }
  }

  /** call once per animation frame with the simulated seconds advanced in it */
  tick(simSeconds = 0) {
    this._frames++; this._sim = (this._sim || 0) + simSeconds;
    const now = performance.now();
    if (now - this._t0 >= 1000) {
      const secs = (now - this._t0) / 1000;
      this.fps = this._frames / secs;
      this.simRate = this._sim / secs;
      this._frames = 0; this._sim = 0; this._t0 = now;
    }
  }

  /** Everything, as plain data. */
  collect() {
    const { state, scene, tileEditor, speed, saveKey } = this.ctx();
    const evo = state.evo, tr = state.track;
    const gl = scene.renderer.getContext();
    let gpu = null;
    try { const ext = gl.getExtension('WEBGL_debug_renderer_info'); gpu = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER); } catch { /* blocked */ }
    const info = scene.renderer.info;
    const out = {
      build: { commit: BUILD.commit, built: BUILD.time, changelogLatest: LATEST_ID, url: location.href.split('#')[0] },
      device: {
        userAgent: navigator.userAgent, screen: `${innerWidth}×${innerHeight} @${devicePixelRatio}x`,
        touch: matchMedia('(pointer: coarse)').matches, gpu,
        fps: r1(this.fps), simSecondsPerSecond: r1(this.simRate), speedSetting: speed,
        draws: info.render.calls, triangles: info.render.triangles, geometries: info.memory.geometries, textures: info.memory.textures,
        memoryMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1e6) : undefined,
      },
      app: { mode: state.mode, editor: state.editorKind, paused: !!state.paused, shadows: state.shadows, seeThrough: state.seeThrough, camera: scene.cameraMode },
    };
    if (tileEditor) {
      const res = tileEditor.result || {};
      out.editor = {
        pieces: tileEditor.tiles.length, width: tileEditor.width, valid: tileEditor.valid,
        error: res.error ? res.error.msg : tileEditor.previewError || null, unused: res.unused || 0,
        selected: tileEditor.selected ? JSON.stringify(stripTile(tileEditor.selected)) : null,
      };
    }
    if (tr) {
      const E = tr.edgeStart.length;
      let twoWay = 0, noWay = 0, junctionSamples = 0, tunnelSamples = 0;
      for (let e = 0; e < E; e++) {
        if (!tr.edgeDir[e]) noWay++;
        const s = tr.edgeStart[e], n = tr.edgeCount[e]; let up = 0, down = 0;
        for (let k = 1; k < n; k++) { const d = tr.D[s + k] - tr.D[s + k - 1]; if (d > 1e-3) up++; else if (d < -1e-3) down++; }
        if (up && down) twoWay++;
      }
      for (let i = 0; i < tr.N; i++) { junctionSamples += tr.junction[i]; tunnelSamples += tr.tunnel[i]; }
      out.track = {
        lapLength: r1(tr.lapLength), laps: tr.laps, raceLength: r1(tr.raceLength), halfWidth: tr.halfWidth,
        samples: tr.N, edges: E, roadsWithNoWayThrough: noWay, roadsPointingBothWays: twoWay,
        junctionForks: tr.junctionAlts ? tr.junctionAlts.size : 0, junctionSamples, tunnelSamples,
        obstacles: tr.obstacles.map(o => o.type).join(', ') || 'none',
        tightestCorner: tr.tightestCorner ? r1(tr.tightestCorner().radius) : undefined,
      };
    }
    if (evo) {
      const S = evo.settings;
      let racing = 0, finished = 0; const now = {};
      for (const c of evo.cars) { if (c.racing) racing++; if (c.finished) finished++; if (!c.alive) now[c.killedBy || 'out'] = (now[c.killedBy || 'out'] || 0) + 1; }
      out.ai = {
        generation: evo.generation, time: `${r1(evo.time)} / ${r1(evo.timeLimit)} s`,
        population: evo.cars.length, racing, finished, outThisGeneration: now,
        lastGeneration: evo.lastStats && { bestProgress: r2(evo.lastStats.bestProgress), bestLap: r2(evo.lastStats.bestLap), finishers: evo.lastStats.finishers, busted: evo.lastStats.busted, outcomes: evo.lastStats.outcomes },
        bestLap: r2(evo.bestLap), bestFitness: r2(evo.bestFitness), stagnation: evo.stagnation, eliteCount: evo.eliteCount,
        brain: evo.layers.join('-'), genomeSize: evo.cars[0] && evo.cars[0].brain.size,
        settings: { pop: S.populationSize, hidden: S.hidden.join('-'), mutationRate: S.mutationRate, mutationStrength: S.mutationStrength, roadAhead: S.roadAhead, police: S.police },
        recentGenerations: evo.history.slice(-8).map(h => `g${h.generation}: ${h.bestLap ? r2(h.bestLap) + ' s' : Math.round(h.bestProgress * 100) + '%'} fin ${h.finishers}${h.busted ? ' bust ' + h.busted : ''}`),
      };
      const leader = evo.leader();
      if (leader) {
        out.leader = {
          speedKmh: r1(leader.speed * 3.6), progress: r1(leader.maxProgress), lap: leader.lap, seg: leader.seg, lateral: r2(leader.lateral),
          distanceToFinish: tr ? r1(tr.D[leader.seg]) : undefined, speedLevel: leader.speedLevel, onOil: leader.onOil, inTunnel: leader.inTunnel, airborne: leader.airborne,
          outputs: { steer: r2(leader.steer), throttle: r2(leader.throttle) },
          inputs: Object.fromEntries(Array.from(leader.inputs).map((v, i) => [INPUT_NAMES[i] || `input ${i}`, r2(v)])),
        };
        if (leader.inputs.length !== INPUT_SIZE) out.leader.warning = `brain has ${leader.inputs.length} inputs, expected ${INPUT_SIZE}`;
      }
      const P = evo.police;
      if (P && (P.cars.length || S.police)) {
        out.police = {
          active: evo.policeActive, count: P.cars.length, trainees: P.ghosts.length, generation: P.generation,
          totalBusts: P.totalBusts, lastGenerationBusts: P.lastBusts,
          cars: P.cars.map((c, i) => ({
            n: i + 1, alive: c.alive, parked: !!c.parked, busts: c.busts, speedKmh: r1(c.speed * 3.6), targetDist: r1(c.targetDist),
            chasing: !!c.chasing, idleS: r1(c.idleTime), wallS: r1(c.wallTime), pursuit: r2(c.pursuit), fitness: r2(c.fitness),
          })),
        };
      }
    }
    // storage
    const store = {};
    try {
      for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); store[k] = `${(localStorage.getItem(k) || '').length} chars`; }
    } catch { store.error = 'storage blocked'; }
    out.storage = { saveKey, keys: store };
    out.errors = errors.length ? errors.slice() : 'none';
    return out;
  }

  render() {
    let data;
    try { data = this.collect(); } catch (e) { data = { error: 'developer menu failed: ' + (e.stack || e.message) }; }
    this.last = data;
    const b = this.body;
    const keepScroll = b.scrollTop;
    b.innerHTML = '';
    for (const [section, val] of Object.entries(data)) {
      const sec = document.createElement('section');
      const h = document.createElement('div'); h.className = 'devSec'; h.textContent = section; sec.appendChild(h);
      if (val && typeof val === 'object' && !Array.isArray(val)) {
        const dl = document.createElement('dl');
        for (const [k, v] of Object.entries(val)) {
          if (v === undefined) continue;
          const dt = document.createElement('dt'); dt.textContent = k;
          const dd = document.createElement('dd'); dd.textContent = fmt(v);
          dl.append(dt, dd);
        }
        sec.appendChild(dl);
      } else {
        const pre = document.createElement('pre'); pre.textContent = fmt(val); sec.appendChild(pre);
      }
      b.appendChild(sec);
    }
    b.scrollTop = keepScroll;
  }

  async copy() {
    const text = 'Racing AI debug report\n' + JSON.stringify(this.collect(), null, 2);
    const btn = this.root.querySelector('.devCopy');
    try { await navigator.clipboard.writeText(text); btn.textContent = 'Copied ✓'; }
    catch {
      // clipboard blocked: show the text selected so it can be copied by hand
      const ta = document.createElement('textarea'); ta.value = text; ta.className = 'devText';
      this.body.prepend(ta); ta.focus(); ta.select();
      btn.textContent = 'Select all & copy below';
    }
    setTimeout(() => { btn.textContent = 'Copy debug report'; }, 2500);
  }
}

function stripTile(t) { const o = { ...t }; delete o._painted; return o; }
function fmt(v) {
  if (v == null) return String(v);
  if (Array.isArray(v)) return v.map(x => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join('\n');
  if (typeof v === 'object') return Object.entries(v).map(([k, x]) => `${k}: ${typeof x === 'object' ? JSON.stringify(x) : x}`).join('\n');
  return String(v);
}
