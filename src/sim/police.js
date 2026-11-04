// Police cars: a second population that evolves *against* the racers.
// They drive with the same physics and sensors, but instead of chasing a lap
// time they hunt racers – touching one "busts" it out of the race.
// Only the very best police brains are kept each generation, so as the racers
// learn to dodge them, the police keep getting sharper (an arms race).
import { Car, RAY_ANGLES, RAY_LENGTH, angleDiff } from './car.js';
import { NeuralNet, gaussian } from './nn.js';

export const POLICE_LEVELS = [
  { label: 'Off', n: 0 },
  { label: 'Few', n: 3 },
  { label: 'Some', n: 6 },
  { label: 'Many', n: 10 },
];
export const BUST_DIST = 2.8;        // metres between car centres
export const POLICE_RADIUS = 1.6;    // how big a police car looks to the racers' sensors
const SEE_RACER = 120;               // how far police can "radio" the nearest racer
const P_LOOK = [12, 35];
// Inputs: rays + speed + lateral + road-ahead directions + nearest racer (angle, closeness, closing speed)
export const POLICE_INPUTS = RAY_ANGLES.length + 2 + P_LOOK.length + 5;
const POLICE_LAYERS = [POLICE_INPUTS, 12, 8, 2];
const KEEP_BEST = 2;                 // only the best of the best survive & breed

export class PoliceCar extends Car {
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
    const tr = this.track, s = this.spawn;
    if (s === undefined) return;
    this.x = tr.cx[s]; this.z = tr.cz[s]; this.seg = s; this.roadH = tr.ch[s];
    this.heading = Math.atan2(tr.dz[s], tr.dx[s]);
    this.busts = 0;
    this.closest = Infinity;
    this.pursuit = 0;     // time spent close to a racer (weighted by how close)
    this.wallTime = 0;    // time spent scraping the barriers
  }

  // pursuit-tuned engine: 10 % more power and top speed than the racers
  get speedFactor() { return super.speedFactor * 1.1; }

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
      while (walked < ahead) { const n = tr.next[idx]; if (n === idx) break; idx = n; walked += tr.step; }
      inp[k++] = Math.max(-1, Math.min(1, angleDiff(Math.atan2(tr.cz[idx] - this.z, tr.cx[idx] - this.x), h) / (Math.PI / 2)));
    }
    // the nearest racer still in the race
    let best = null, bd = SEE_RACER * SEE_RACER;
    for (const c of this.racers) {
      if (!c.racing || Math.abs(c.roadH - this.roadH) > 3) continue;
      const d = (c.x - this.x) ** 2 + (c.z - this.z) ** 2;
      if (d < bd) { bd = d; best = c; }
    }
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
      if (d < 40 && this.speed > 6 && closing > 0) this.pursuit += (1 - d / 40) * Math.min(1, closing / 15) * (this.dt || 1 / 60);
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
    const look = 10 + this.speed * 0.45;
    let idx = this.seg, walked = 0;
    while (walked < look) { const n = tr.next[idx]; if (n === idx) break; idx = n; walked += tr.step; }
    const off = out[0] * (tr.halfWidth - 1.2);
    const tx = tr.cx[idx] - tr.dz[idx] * off, tz = tr.cz[idx] + tr.dx[idx] * off;
    const err = angleDiff(Math.atan2(tz - this.z, tx - this.x), this.heading);
    this.steer = Math.max(-1, Math.min(1, err * 2.2));
    this.throttle = out[1];
  }

  // police don't do laps – they just need to stay on the road
  updateTrackPosition() {
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
    this.wallTime += this.dt || 1 / 60;
  }

  computeFitness() {
    // busts count most; staying close to racers (chasing them) guides learning
    // until the busts come; scraping the barriers and crashing cost a little
    const near = Number.isFinite(this.closest) ? Math.max(0, 1 - this.closest / 40) : 0;
    this.fitness = this.busts * 10 + this.pursuit * 2 + near - this.wallTime * 0.05 - (this.alive ? 0 : 3);
    return this.fitness;
  }
}

/** Points spread along the lap where police wait (never right at the start). */
function spawnPoints(track, n) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const target = track.lapLength * (0.22 + 0.68 * (i + 0.5) / n);
    let idx = track.startIndex, walked = 0;
    while (walked < target) { const nx = track.next[idx]; if (nx === idx) break; idx = nx; walked += track.step; }
    pts.push(idx);
  }
  return pts;
}

export class PoliceForce {
  constructor(track, n, genomes = null) {
    this.track = track;
    this.generation = 1;
    this.totalBusts = 0;
    this.lastBusts = 0;
    this.cars = [];
    this.resize(n, genomes);
  }

  resize(n, genomes = null) {
    const size = NeuralNet.genomeSize(POLICE_LAYERS);
    const old = (genomes || this.cars.map(c => c.brain.genome)).filter(g => g && g.length === size);
    const spawns = spawnPoints(this.track, n);
    this.cars = spawns.map((s, i) => {
      let g;
      if (old.length) { g = Float32Array.from(old[i % old.length]); if (i >= old.length) mutate(g, 0.1, 0.4); }
      else g = NeuralNet.randomGenome(POLICE_LAYERS, 1);
      return new PoliceCar(new NeuralNet(POLICE_LAYERS, g), this.track, s);
    });
    this.eliteCount = Math.min(KEEP_BEST, n);
  }

  setRacers(racers) { for (const p of this.cars) p.racers = racers; }

  step(dt, racers) {
    for (const p of this.cars) p.step(dt);
    // busts: a live police car touching a racer on the same level
    for (const p of this.cars) {
      if (!p.alive || p.airborne) continue;
      for (const c of racers) {
        if (!c.racing || c.airborne || Math.abs(c.roadH - p.roadH) > 2) continue;
        const dx = c.x - p.x, dz = c.z - p.z;
        if (dx * dx + dz * dz < BUST_DIST * BUST_DIST) { c.die('busted'); p.busts++; this.totalBusts++; }
      }
    }
  }

  /** Only the best few police survive; everyone else is a mutant of them. */
  nextGeneration() {
    if (!this.cars.length) return;
    for (const p of this.cars) p.computeFitness();
    const sorted = this.cars.slice().sort((a, b) => b.fitness - a.fitness);
    this.lastBusts = this.cars.reduce((s, p) => s + p.busts, 0);
    const keep = sorted.slice(0, this.eliteCount).map(p => Float32Array.from(p.brain.genome));
    const next = keep.slice();
    // no busts at all: shake things up more
    const bold = this.lastBusts ? 1 : 1.6;
    while (next.length < this.cars.length) {
      const g = Float32Array.from(keep[next.length % keep.length]);
      if (Math.random() < 0.5) mutate(g, 0.05 * bold, 0.15 * bold); else mutate(g, 0.12 * bold, 0.5 * bold);
      next.push(g);
    }
    this.cars.forEach((p, i) => { p.brain.genome = next[i]; p.isElite = i < this.eliteCount; p.reset(); });
    this.generation++;
  }

  get genomes() { return this.cars.map(c => Array.from(c.brain.genome)); }
}

function mutate(g, rate, strength) {
  for (let i = 0; i < g.length; i++) if (Math.random() < rate) g[i] += gaussian() * strength;
}
