// Hidden developer menu: ↑ ↑ ↓ ← → on a keyboard, or the same swipes on a touch screen.
// Shows what's useful when debugging (build, device, track, AI, police, storage, errors)
// and copies it all as one report to paste into a bug report.

import { RAY_ANGLES, LOOKAHEAD, RADAR_ZONES, INPUT_SIZE } from '../sim/car.js';
import { LATEST_ID } from '../changelog.js';
import { BUILD } from '../build.js';
import { OVERLAYS } from '../render/debugViz.js';
import { encodeTrack, encodeTrackSync, cleanDef } from './trackCode.js';
import { rngState } from '../sim/rng.js';

const SEQUENCE = ['up', 'up', 'down', 'left', 'right'];
const KEYS = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };


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
let onError = null; // the crash alert (set by the DevMenu)
function logError(kind, msg) {
  errors.push({ t: new Date().toISOString().slice(11, 19), kind, msg: String(msg).slice(0, 400) });
  if (errors.length > 30) errors.shift();
  if (onError) try { onError(kind, msg); } catch { /* never let the alert itself crash */ }
}
window.addEventListener('error', e => logError('error', `${e.message} (${(e.filename || '').split('/').pop()}:${e.lineno})`));
window.addEventListener('unhandledrejection', e => logError('promise', e.reason && (e.reason.stack || e.reason.message) || e.reason));
const origConsoleError = console.error.bind(console);
console.error = (...a) => { logError('console', a.map(x => (x && x.stack) || String(x)).join(' ')); origConsoleError(...a); };

const r1 = v => (v == null || !Number.isFinite(v) ? v : Math.round(v * 10) / 10);
const r2 = v => (v == null || !Number.isFinite(v) ? v : Math.round(v * 100) / 100);

export class DevMenu {
  /** ctx(): { state, scene, tileEditor, speed, saveKey } – read fresh each refresh */
  constructor(ctx, viz = null) {
    this.ctx = ctx;
    this.viz = viz;
    this.unlocked = false; // F1–F6 only work once the menu has been opened in this tab
    this._stepMs = 0; this._steps = 0; this.stepMs = 0;
    this.focus = 0;          // F8: 0 = follow the leader, 1… = racer #n, then police
    this.slowmo = false;     // F9
    this.stepRequests = 0;   // F10
    this.seq = [];
    this.fps = 0; this._frames = 0; this._t0 = performance.now();
    this.simRate = 0;
    const root = this.root = document.createElement('div');
    root.className = 'devMenu hidden';
    root.innerHTML = `<div class="devHead">DEV  <button class="devCopy">[copy]</button> <button class="devClose">[close]</button></div><pre class="devBody"></pre>`;
    document.body.appendChild(root);
    this.body = root.querySelector('.devBody');
    root.querySelector('.devClose').onclick = () => this.toggle(false);
    root.querySelector('.devCopy').onclick = () => this.copy();

    // crash alert: when the game hits an error, offer to copy the debug report
    const banner = this.banner = document.createElement('div');
    banner.className = 'crashBanner hidden';
    banner.innerHTML = `<span>⚠️ Something went wrong in the game. Copy the report and send it so it can be fixed.</span>
      <button class="crashCopy">Copy report</button><button class="crashClose">Dismiss</button>`;
    document.body.appendChild(banner);
    banner.querySelector('.crashClose').onclick = () => { banner.classList.add('hidden'); this.crashDismissed = Date.now(); };
    banner.querySelector('.crashCopy').onclick = async () => {
      const b = banner.querySelector('.crashCopy'), text = this.report();
      try { await navigator.clipboard.writeText(text); b.textContent = 'Copied ✓'; }
      catch { this.toggle(true); this.copy(); b.textContent = 'Copy from the menu'; }
      setTimeout(() => { b.textContent = 'Copy report'; }, 2500);
    };
    onError = () => {
      // don't nag: at most once a minute after being dismissed
      if (this.crashDismissed && Date.now() - this.crashDismissed < 60000) return;
      banner.classList.remove('hidden');
    };

    // F1–F10 visual debugging (after the menu has been unlocked)
    this.help = document.createElement('pre');
    this.help.className = 'devHelp hidden';
    document.body.appendChild(this.help);
    window.addEventListener('keydown', e => {
      if (/^F([1-9]|10)$/.test(e.key) && this.unlocked) { e.preventDefault(); this.key(e.key, e.shiftKey); return; }
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

  unlock() { this.unlocked = true; }

  /** F1 = key help; F2–F7 = overlays; F8 = follow car (Shift = back); F9 = slow motion; F10 = step */
  key(k, shift = false) {
    this.unlock();
    if (k === 'F1') this.helpOn = !this.helpOn;
    else if (k === 'F8') this.cycleFocus(shift ? -1 : 1);
    else if (k === 'F9') this.slowmo = !this.slowmo;
    else if (k === 'F10') this.stepRequests++;
    else if (this.viz) this.viz.toggle(k);
    this.renderHelp();
  }

  cycleFocus(d) {
    const { state } = this.ctx(), evo = state.evo;
    const n = evo ? evo.cars.length + evo.police.cars.length : 0;
    this.focus = n ? (this.focus + d + n + 1) % (n + 1) : 0;
  }

  /** The car F8 is following (null = the leader). */
  focusCar(evo) {
    if (!this.focus || !evo) return null;
    const i = this.focus - 1;
    return i < evo.cars.length ? evo.cars[i] : evo.police.cars[i - evo.cars.length] || null;
  }

  focusName(evo) {
    if (!this.focus || !evo) return 'leader';
    const i = this.focus - 1;
    return i < evo.cars.length ? `racer #${i + 1}` : `police ${i - evo.cars.length + 1}`;
  }

  renderHelp() {
    const on = this.viz ? this.viz.on : {};
    const lines = ['DEBUG KEYS  (↑ ↑ ↓ ← → = report)', 'F1  this help'];
    for (const [k, desc] of Object.entries(OVERLAYS)) lines.push(`${k.padEnd(3)} [${on[k] ? 'x' : ' '}] ${desc}`);
    const { state } = this.ctx();
    lines.push(`F8  follow: ${this.focusName(state.evo)}  (Shift+F8 = back; camera, sensors, brain panel and report follow it)`);
    lines.push(`F9  [${this.slowmo ? 'x' : ' '}] slow motion (¼ speed)`);
    lines.push(`F10 step: pause, then one physics step (1/60 s) per press`);
    this.help.textContent = lines.join('\n');
    this.help.classList.toggle('hidden', !this.helpOn);
  }

  toggle(on = !this.open) {
    if (on) this.unlock();
    this.open = on;
    this.root.classList.toggle('hidden', !on);
    clearInterval(this.timer);
    if (on) { this.render(); this.timer = setInterval(() => this.render(), 500); }
  }

  /** call once per animation frame with the simulated seconds advanced in it */
  tick(simSeconds = 0, simMs = 0, steps = 0) {
    this._frames++; this._sim = (this._sim || 0) + simSeconds; this._stepMs += simMs; this._steps += steps;
    const now = performance.now();
    if (now - this._t0 >= 1000) {
      const secs = (now - this._t0) / 1000;
      this.fps = this._frames / secs;
      this.simRate = this._sim / secs;
      this.stepMs = this._steps ? this._stepMs / this._steps : 0;
      this.frameSimMs = this._stepMs / Math.max(1, this._frames);
      this._frames = 0; this._sim = 0; this._t0 = now; this._stepMs = 0; this._steps = 0;
    }
  }

  /** Everything, as plain data. */
  collect() {
    const { state, scene, tileEditor, speed, saveKey, currentDef } = this.ctx();
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
        msPerSimStep: r2(this.stepMs), simMsPerFrame: r1(this.frameSimMs),
        draws: info.render.calls, triangles: info.render.triangles, geometries: info.memory.geometries, textures: info.memory.textures,
        memoryMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1e6) : undefined,
      },
      app: { mode: state.mode, editor: state.editorKind, paused: !!state.paused, shadows: state.shadows, seeThrough: state.seeThrough, camera: scene.cameraMode,
        overlays: this.viz ? Object.entries(this.viz.on).filter(([, v]) => v).map(([k]) => k).join(' ') || 'none' : undefined,
        following: this.focusName(state.evo), slowMotion: this.slowmo },
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
        seed: S.seeded !== false ? S.seed : 'off (truly random)', rngState: rngState(),
        recentGenerations: evo.history.slice(-8).map(h => `g${h.generation}: ${h.bestLap ? r2(h.bestLap) + ' s' : Math.round(h.bestProgress * 100) + '%'} fin ${h.finishers}${h.busted ? ' bust ' + h.busted : ''}`),
      };
      const leader = this.focusCar(evo) || evo.leader();
      if (leader) {
        out.leader = {
          car: this.focusName(evo) + (leader.isPolice ? ' (police)' : ''),
          alive: leader.alive, killedBy: leader.killedBy || undefined,
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
          active: evo.policeActive, count: P.cars.length, onDuty: P.onDuty, droughtGens: evo.policeDrought, trainees: P.ghosts.length, generation: P.generation,
          totalBusts: P.totalBusts, lastGenerationBusts: P.lastBusts,
          cars: P.cars.map((c, i) => ({
            n: i + 1, alive: c.alive, parked: !!c.parked, busts: c.busts, speedKmh: r1(c.speed * 3.6), targetDist: r1(c.targetDist),
            chasing: !!c.chasing, arresting: c.time < c.arrestUntil, idleS: r1(c.idleTime), wallS: r1(c.wallTime), pursuit: r2(c.pursuit), fitness: r2(c.fitness),
          })),
        };
      }
    }
    if (evo) {
      // one line per racer: # state progress speed lap
      out.racers = evo.cars.map((c, i) => {
        const st = c.finished ? 'finished' : c.alive ? 'racing' : c.killedBy || 'out';
        return `#${String(i + 1).padStart(2)} ${st.padEnd(8)} ${String(Math.round(c.maxProgress / (tr ? tr.raceLength : 1) * 100)).padStart(3)}%  ${String(Math.round(c.speed * 3.6)).padStart(3)} km/h  lap ${c.lap}${c.isElite ? '  elite' : ''}${c === evo.leader() ? '  LEADER' : ''}`;
      });
    }
    // the exact track as a track code (paste into 🔗 Code → Load to reproduce it)
    try {
      const def = currentDef ? currentDef() : state.def, key = JSON.stringify(cleanDef(def));
      if (key !== this._codeKey) { this._codeKey = key; this._code = encodeTrackSync(def); encodeTrack(def).then(c => { if (this._codeKey === key) this._code = c; }); }
      out.trackCode = this._code;
    } catch (e) { out.trackCode = 'unavailable: ' + e.message; }
    // storage
    const store = {};
    try {
      for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); store[k] = `${(localStorage.getItem(k) || '').length} chars`; }
    } catch { store.error = 'storage blocked'; }
    out.storage = { saveKey, keys: store };
    if (this.viz && this.viz.deaths) {
      // where cars went out (F7), grouped by reason and position along the lap
      const byGen = {};
      for (const d of this.viz.deaths) {
        const key = `g${d.gen}`; (byGen[key] = byGen[key] || {});
        const k = `${d.reason}@${d.pct}%`; byGen[key][k] = (byGen[key][k] || 0) + 1;
      }
      out.crashMap = byGen;
    }
    out.errors = errors.length ? errors.slice() : 'none';
    return out;
  }

  render() {
    let text;
    try { this.last = this.collect(); text = this.report(this.last); } catch (e) { text = 'developer menu failed: ' + (e.stack || e.message); }
    const b = this.body, keep = b.scrollTop;
    b.textContent = text;
    b.scrollTop = keep;
  }

  /** The whole report as plain text, one "key: value" per line. */
  report(data = this.collect()) {
    const lines = ['racing-ai debug report  ' + new Date().toISOString()];
    const walk = (v, pad) => {
      for (const [k, x] of Object.entries(v)) {
        if (x === undefined) continue;
        if (x && typeof x === 'object' && !Array.isArray(x)) { lines.push(pad + k + ':'); walk(x, pad + '  '); }
        else if (Array.isArray(x)) { lines.push(pad + k + ':'); for (const y of x) lines.push(pad + '  ' + (typeof y === 'object' ? JSON.stringify(y) : y)); }
        else lines.push(pad + k + ': ' + x);
      }
    };
    for (const [sec, v] of Object.entries(data)) {
      lines.push('', '== ' + sec);
      if (v && typeof v === 'object') walk(v, '  '); else lines.push('  ' + v);
    }
    return lines.join('\n');
  }

  async copy() {
    const text = this.report();
    const btn = this.root.querySelector('.devCopy');
    try { await navigator.clipboard.writeText(text); btn.textContent = '[copied]'; }
    catch {
      // clipboard blocked: show the text selected so it can be copied by hand
      const ta = document.createElement('textarea'); ta.value = text; ta.className = 'devText';
      this.root.insertBefore(ta, this.body); ta.focus(); ta.select();
      btn.textContent = '[select & copy]';
    }
    setTimeout(() => { btn.textContent = '[copy]'; }, 2500);
  }
}

function stripTile(t) { const o = { ...t }; delete o._painted; return o; }
function stripDef(d) { return d && d.tiles ? { ...d, tiles: d.tiles.map(stripTile) } : d; }
