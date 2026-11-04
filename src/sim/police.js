// Police cars: a second population that evolves *against* the racers.
// They drive with the same physics and sensors, but instead of chasing a lap
// time they hunt racers – touching one "busts" it out of the race.
// Only the very best police brains are kept each generation, so as the racers
// learn to dodge them, the police keep getting sharper (an arms race).
import { Car, RAY_ANGLES, RAY_LENGTH, angleDiff } from './car.js';
import { NeuralNet, gaussian } from './nn.js';
import { random } from './rng.js';

export const POLICE_LEVELS = [
  { label: 'Off', n: 0 },
  { label: 'Few', n: 3 },
  { label: 'Some', n: 6 },
  { label: 'Many', n: 10 },
];
export const BUST_DIST = 2.8;        // metres between car centres
export const POLICE_RADIUS = 1.6;    // how big a police car looks to the racers' sensors
export const BUST_SPEED = 8;         // m/s – a cop must be driving at least this fast to bust anyone
const IDLE_SPEED = 5;                // slower than this counts as sitting still
const PATROL_SPEED = 12;             // m/s – cops never slow below this (no parking as a roadblock)
const TUNE = globalThis.__policeTune || {}; // (benchmarks only)
export const HOLD_TIME = TUNE.hold ?? 3;          // s – the racers' head start before the police set off
const CATCH_UP = TUNE.catchUp ?? 0.3;           // extra speed (fraction) when far behind the target
export const ARREST_TIME = TUNE.arrest ?? 4;     // s a cop stops for after a bust (one racer at a time)
const SEE_RACER = 160;               // how far police can "radio" the nearest racer
const P_LOOK = [12, 35];
// Inputs: rays + speed + lateral + road-ahead directions + nearest racer (angle, closeness, closing speed)
export const POLICE_INPUTS = RAY_ANGLES.length + 2 + P_LOOK.length + 5;
const POLICE_LAYERS = [POLICE_INPUTS, 12, 8, 3]; // outputs: lane, throttle, chase
const KEEP_BEST = 2;                 // only the best of the best survive & breed

export class PoliceCar extends Car {
  /** spawn: { index, lat } – a sample on the road and a sideways offset (+ = right) */
  constructor(brain, track, spawn) {
    super(brain, track);
    this.isPolice = true;
    this.inputs = new Float32Array(POLICE_INPUTS);
    this.spawn = spawn;
    this.racers = [];
    this.reset();
  }

  reset() {
    super.reset();
    const tr = this.track, sp = this.spawn;
    if (!sp) return;
    const s = sp.index, lat = sp.lat || 0;
    this.x = tr.cx[s] - tr.dz[s] * lat; this.z = tr.cz[s] + tr.dx[s] * lat;
    this.seg = s; this.roadH = tr.ch[s]; this.lateral = lat;
    this.heading = Math.atan2(tr.dz[s], tr.dx[s]);
    this.busts = 0;
    this.caught = new Set(); // trainees: racers already counted
    this.closest = Infinity;
    this.pursuit = 0;     // time spent close to a racer (weighted by how close)
    this.wallTime = 0;    // time spent scraping the barriers
    this.idleTime = 0;    // time spent (nearly) standing still
    this.arrestUntil = 0; // stopped making an arrest until this time
  }

  // pursuit-tuned engine: 10 % faster than the racers close up, and up to 40 %
  // when far behind its target (catch-up), so a racer can't simply outrun them
  get speedFactor() {
    const d = this.targetDist ?? 1e9;
    const catchUp = d > 1e8 ? CATCH_UP / 2 : Math.max(0, Math.min(1, (d - 25) / 100)) * CATCH_UP;
    return super.speedFactor * (1.1 + catchUp);
  }

  get racing() { return false; } // never counts towards "cars still racing"

  sense() {
    const tr = this.track, inp = this.inputs, h = this.heading;
    for (let r = 0; r < RAY_ANGLES.length; r++) {
      const a = h + RAY_ANGLES[r];
      const d = tr.raycast(this.x, this.z, Math.cos(a), Math.sin(a), this.roadH, RAY_LENGTH);
      this.rays[r] = d; inp[r] = d / RAY_LENGTH;
    }
    let k = RAY_ANGLES.length;
    inp[k++] = this.speed / 48;
    inp[k++] = Math.max(-1.5, Math.min(1.5, this.lateral / tr.halfWidth));
    let idx = this.seg, walked = 0;
    for (const ahead of P_LOOK) {
      while (walked < ahead) { const n = this.routeNext(idx, null); if (n === idx) break; idx = n; walked += tr.step; }
      inp[k++] = Math.max(-1, Math.min(1, angleDiff(Math.atan2(tr.cz[idx] - this.z, tr.cx[idx] - this.x), h) / (Math.PI / 2)));
    }
    // the nearest racer still in the race
    let best = null, bd = SEE_RACER * SEE_RACER;
    for (const c of this.racers) {
      if (!c.racing || Math.abs(c.roadH - this.roadH) > 3) continue;
      const d = (c.x - this.x) ** 2 + (c.z - this.z) ** 2;
      if (d < bd) { bd = d; best = c; }
    }
    this.target = best;
    this.targetDist = best ? Math.sqrt(bd) : null;
    if (best) {
      const d = Math.sqrt(bd), ux = (best.x - this.x) / (d || 1), uz = (best.z - this.z) / (d || 1);
      inp[k++] = angleDiff(Math.atan2(uz, ux), h) / Math.PI;
      inp[k++] = 1 - d / SEE_RACER;
      inp[k++] = Math.max(-1, Math.min(1, -((best.vx - this.vx) * ux + (best.vz - this.vz) * uz) / 40)); // + = getting closer
      inp[k++] = Math.max(-1.5, Math.min(1.5, best.lateral / tr.halfWidth));                          // racer's lane
      inp[k++] = Math.max(-1, Math.min(1, ((best.x - this.x) * tr.dx[this.seg] + (best.z - this.z) * tr.dz[this.seg]) / 60)); // + = ahead along the road
      if (d < this.closest) this.closest = d;
      // chasing = moving and closing in on a racer (parked cops don't earn this)
      const closing = -((best.vx - this.vx) * ux + (best.vz - this.vz) * uz);
      if (d < 40 && this.speed > 6 && closing > 0 && this.time > HOLD_TIME) this.pursuit += (1 - d / 40) * Math.min(1, closing / 15) * (this.dt || 1 / 60);
    } else { inp[k++] = 0; inp[k++] = 0; inp[k++] = 0; inp[k++] = 0; inp[k++] = 0; }
    return inp;
  }

  /**
   * Police have a built-in driving instinct (follow the road), so evolution can
   * work on tactics: the brain picks where across the road to drive (block a
   * lane, cut in on a racer) and how hard to accelerate or brake (wait, pounce).
   */
  think() {
    const out = this.brain.forward(this.sense());
    const tr = this.track;
    // waiting on the grid behind the start line while the racers get their head start,
    // or pulled over making an arrest
    if (this.time < HOLD_TIME || this.time < this.arrestUntil) { this.steer = 0; this.throttle = -1; return; }
    const look = 10 + this.speed * 0.45;
    const r0 = this.target;
    let idx = this.seg, walked = 0;
    while (walked < look) { const n = this.routeNext(idx, r0); if (n === idx) break; idx = n; walked += tr.step; }
    const off = out[0] * (tr.halfWidth - 1.2); // + = right of the road
    let tx = tr.cx[idx] - tr.dz[idx] * off, tz = tr.cz[idx] + tr.dx[idx] * off;
    // chase: blend the aim point towards where the nearest racer is heading
    const chase = (out[2] + 1) / 2, r = this.target;
    this.chasing = !!r && chase > 0.5;
    if (r && chase > 0.05) {
      const d = Math.hypot(r.x - this.x, r.z - this.z), lead = Math.min(1.2, d / (this.speed + 10));
      const px = r.x + r.vx * lead, pz = r.z + r.vz * lead;
      // only chase what's in front: no reverse gear, so a racer behind means patrol and pounce as it passes
      const front = Math.cos(angleDiff(Math.atan2(pz - this.z, px - this.x), this.heading));
      const w = chase * Math.max(0, Math.min(1, front * 2));
      tx += (px - tx) * w; tz += (pz - tz) * w;
    }
    this.aimX = tx; this.aimZ = tz; // (shown by the F3 debug overlay)
    const err = angleDiff(Math.atan2(tz - this.z, tx - this.x), this.heading);
    this.steer = Math.max(-1, Math.min(1, err * 2.2));
    // always on patrol: below patrol speed the engine is kept pulling
    this.throttle = this.speed < PATROL_SPEED ? Math.max(out[1], 0.6) : out[1];
  }

  /**
   * Next sample on the cop's own route: like the racers' route, except at a
   * junction the cop takes the branch that heads towards its target racer
   * (where that racer is going to be), so racers can't escape just by turning off.
   */
  routeNext(idx, r) {
    const tr = this.track, step = tr.next;
    const alts = tr.junctionAlts && tr.junctionAlts.get(idx);
    if (!alts || !r) return step[idx];
    const d = Math.hypot(r.x - this.x, r.z - this.z), lead = Math.min(2, d / (this.speed + 10));
    const px = r.x + r.vx * lead, pz = r.z + r.vz * lead;
    let best = step[idx], bd = Infinity;
    for (const a of alts) {
      // look 25 m down each branch
      let j = a, w = 0;
      while (w < 25) { const n = step[j]; if (n === j) break; j = n; w += tr.step; }
      const dd = (tr.cx[j] - px) ** 2 + (tr.cz[j] - pz) ** 2;
      if (dd < bd) { bd = dd; best = a; }
    }
    return best;
  }

  // police don't do laps – they just need to stay on the road
  updateTrackPosition() {
    if (this.speed < IDLE_SPEED && this.time > HOLD_TIME && this.time > this.arrestUntil) this.idleTime += this.dt || 1 / 60;
    const tr = this.track;
    const nr = tr.nearest(this.x, this.z, this.seg);
    this._nr = nr;
    this.seg = nr.index; this.lateral = nr.lateral;
    this.roadH = tr.heightAt(nr.index, nr.t);
    this.inTunnel = tr.tunnel[nr.index] === 1;
    return nr;
  }
  checkEnd() { /* parking as a roadblock is allowed */ }

  // police can't drive off the road: they bounce along the barrier instead (losing speed)
  die(reason) {
    if ((reason !== 'offroad' && reason !== 'landing') || !this._nr) { super.die(reason); return; }
    const nr = this._nr, tr = this.track;
    let ox = this.x - nr.px, oz = this.z - nr.pz; const L = Math.hypot(ox, oz) || 1; ox /= L; oz /= L;
    const keep = tr.halfWidth - 0.3;
    this.x = nr.px + ox * keep; this.z = nr.pz + oz * keep;
    const vn = this.vx * ox + this.vz * oz;
    if (vn > 0) { this.vx -= vn * ox; this.vz -= vn * oz; }
    this.vx *= 0.85; this.vz *= 0.85;
    const fx = Math.cos(this.heading), fz = Math.sin(this.heading);
    this.speed = Math.max(0, this.vx * fx + this.vz * fz);
    this.lateral = Math.sign(this.lateral) * keep;
    // glance off: turn to run along the barrier rather than stay pinned nose-first against it
    let ax = tr.dx[nr.index], az = tr.dz[nr.index];
    if (ax * fx + az * fz < 0) { ax = -ax; az = -az; }
    this.heading = Math.atan2(fz + (az - fz) * 0.5, fx + (ax - fx) * 0.5);
    this.wallTime += this.dt || 1 / 60;
  }

  computeFitness() {
    // busts count most; staying close to racers (chasing them) guides learning
    // until the busts come; scraping the barriers and crashing cost a little
    const near = Number.isFinite(this.closest) ? Math.max(0, 1 - this.closest / 40) : 0;
    // sitting still is penalised: parked cops can't bust anyone anyway
    this.fitness = this.busts * 10 + this.pursuit * 2 + near - this.wallTime * 0.05 - this.idleTime * 0.4 - (this.alive ? 0 : 3);
    return this.fitness;
  }
}

/**
 * The police grid: two abreast in rows behind the start line, so the police
 * set off after the racers and have to hunt them down.
 */
function spawnPoints(track, n) {
  const pts = [];
  const lat = Math.min(3.2, track.halfWidth - 1.6);
  let idx = track.finishIndex, walked = 0;            // just behind the start line, walking backwards
  for (let k = 0; k < n; k++) {
    const behind = 22 + Math.floor(k / 2) * 9;          // first row 22 m back, rows 9 m apart
    while (walked < behind) { const p = track.prev[idx]; if (p === idx) break; idx = p; walked += track.step; }
    pts.push({ index: idx, lat: k % 2 ? lat : -lat });
  }
  return pts;
}

export class PoliceForce {
  constructor(track, n, genomes = null) {
    this.track = track;
    this.generation = 1;
    this.totalBusts = 0;
    this.lastBusts = 0;
    this.cars = [];     // the real (visible) police – always the best brains found so far
    this.ghosts = [];   // hidden trainees: drive the same track but don't touch the racers
    this.resize(n, genomes);
  }

  resize(n, genomes = null) {
    const size = NeuralNet.genomeSize(POLICE_LAYERS);
    const old = (genomes || [...this.cars, ...this.ghosts].map(c => c.brain.genome)).filter(g => g && g.length === size);
    const make = (spawns, offset) => spawns.map((s, i) => {
      let g;
      const k = i + offset;
      if (old.length) { g = Float32Array.from(old[k % old.length]); if (k >= old.length) mutate(g, 0.1, 0.4); }
      else g = NeuralNet.randomGenome(POLICE_LAYERS, 1);
      return new PoliceCar(new NeuralNet(POLICE_LAYERS, g), this.track, s);
    });
    this.cars = make(spawnPoints(this.track, n), 0);
    // trainees line up on the same grid slots as the real police (they don't collide)
    const grid = spawnPoints(this.track, n);
    this.ghosts = n ? make(Array.from({ length: ghostCount(n) }, (_, i) => grid[i % n]), n) : [];
    for (const gh of this.ghosts) gh.ghost = true;
    this.eliteCount = Math.min(KEEP_BEST, n);
    if (this.racers) this.setRacers(this.racers);
  }

  /** Take every cop off the track (waiting for the racers to finish a first lap). */
  park() {
    for (const c of [...this.cars, ...this.ghosts]) { c.alive = false; c.crashed = false; c.diedAt = -1e9; c.parked = true; }
  }
  resetAll() { for (const c of [...this.cars, ...this.ghosts]) { c.parked = false; c.reset(); } }
  /** Only the first k real police drive this generation (the best brains); the rest wait off the track. */
  applyDuty(k) {
    this.onDuty = Math.max(0, Math.min(this.cars.length, k));
    this.cars.forEach((c, i) => { if (i >= this.onDuty) { c.alive = false; c.crashed = false; c.diedAt = -1e9; c.parked = true; } });
  }

  setRacers(racers) { this.racers = racers; for (const p of this.cars) p.racers = racers; for (const p of this.ghosts) p.racers = racers; }

  step(dt, racers) {
    for (const p of this.cars) p.step(dt);
    for (const p of this.ghosts) p.step(dt);
    // busts: a live police car touching a racer on the same level
    for (const p of this.cars) {
      if (!p.alive || p.airborne) continue;
      for (const c of racers) {
        if (!c.racing || c.airborne || Math.abs(c.roadH - p.roadH) > 2) continue;
        const dx = c.x - p.x, dz = c.z - p.z;
        const d2 = dx * dx + dz * dz;
        if (d2 >= BUST_DIST * BUST_DIST) continue;
        if (p.time < p.arrestUntil) continue; // busy with an arrest
        if (p.speed >= BUST_SPEED) { c.die('busted'); p.busts++; this.totalBusts++; p.arrestUntil = p.time + ARREST_TIME; continue; }
        // a crawling cop is just in the way: the racer bounces off it and loses speed
        const L = Math.sqrt(d2) || 1, nx = dx / L, nz = dz / L;
        const vn = (c.vx - p.vx) * nx + (c.vz - p.vz) * nz;
        if (vn < 0) { c.vx -= 1.6 * vn * nx; c.vz -= 1.6 * vn * nz; }
        c.vx *= 0.8; c.vz *= 0.8;
        const fx = Math.cos(c.heading), fz = Math.sin(c.heading);
        c.speed = Math.max(0, c.vx * fx + c.vz * fz);
        const push = BUST_DIST - L; c.x += nx * push; c.z += nz * push;
      }
    }
    // trainees only score "would have busted" (each racer once)
    for (const p of this.ghosts) {
      if (!p.alive || p.airborne || p.speed < BUST_SPEED || p.time < p.arrestUntil) continue;
      for (let i = 0; i < racers.length; i++) {
        const c = racers[i];
        if (!c.racing || c.airborne || Math.abs(c.roadH - p.roadH) > 2) continue;
        const dx = c.x - p.x, dz = c.z - p.z;
        if (dx * dx + dz * dz < BUST_DIST * BUST_DIST && !p.caught.has(i)) { p.caught.add(i); p.busts++; p.arrestUntil = p.time + ARREST_TIME; break; }
      }
    }
  }

  /**
   * "Best of the best": real cops and trainees are ranked together; only the
   * top brains become next generation's real police, and the new trainees are
   * all mutants of the top two.
   */
  nextGeneration() {
    if (!this.cars.length) return;
    const all = [...this.cars, ...this.ghosts];
    for (const p of all) p.computeFitness();
    const sorted = all.slice().sort((a, b) => b.fitness - a.fitness);
    this.lastBusts = this.cars.reduce((s, p) => s + p.busts, 0);
    const best = sorted.map(p => Float32Array.from(p.brain.genome));
    const parents = best.slice(0, KEEP_BEST);
    const anyBusts = sorted[0].busts > 0;
    const bold = anyBusts ? 1 : 1.6; // nobody caught anyone: shake things up more
    this.cars.forEach((p, i) => { p.brain.genome = best[i]; p.isElite = i < this.eliteCount; p.reset(); });
    this.ghosts.forEach((p, i) => {
      let g;
      if (random() < 0.25 && parents.length > 1) g = crossover(parents[0], parents[1]);
      else g = Float32Array.from(parents[i % parents.length]);
      if (i % 3 === 0) mutate(g, 0.04 * bold, 0.12 * bold);
      else if (i % 3 === 1) mutate(g, 0.1 * bold, 0.35 * bold);
      else mutate(g, 0.2 * bold, 0.7 * bold);
      p.brain.genome = g; p.reset();
    });
    this.generation++;
  }

  get genomes() { return this.cars.map(c => Array.from(c.brain.genome)); }
}

/** How many hidden trainee cops are tried each generation. */
function ghostCount(n) { return Math.max(8, n); }

function crossover(a, b) {
  const n = a.length, out = new Float32Array(n);
  let p1 = Math.floor(random() * n), p2 = Math.floor(random() * n);
  if (p1 > p2) [p1, p2] = [p2, p1];
  for (let i = 0; i < n; i++) out[i] = i >= p1 && i < p2 ? b[i] : a[i];
  return out;
}

function mutate(g, rate, strength) {
  for (let i = 0; i < g.length; i++) if (random() < rate) g[i] += gaussian() * strength;
}
