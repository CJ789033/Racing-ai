// Top-down car physics + sensors on the road network.
// The car keeps a velocity vector separate from its heading, so when grip is
// low (oil) it slides sideways and can spin; on normal tarmac the tyres kill
// the sideways motion almost instantly.
import { obstacleContact, obstacleRay } from './obstacles.js';

export const CAR = {
  maxSpeed: 48,      // m/s (~170 km/h) at speed level 0
  engine: 11,        // m/s^2 at full throttle (falls off towards top speed)
  brake: 26,         // m/s^2 at full brake
  drag: 0.012,       // aero drag coefficient (per m/s)
  rolling: 0.6,      // m/s^2 rolling resistance
  wheelBase: 2.6,    // metres
  maxSteer: 0.55,    // radians at standstill
  grip: 17,          // max lateral acceleration (m/s^2)
  oilGrip: 0.1,      // fraction of grip left on oil
  length: 4.2, width: 1.9,
};

// Sensor ray angles relative to heading (radians)
export const RAY_ANGLES = [-80, -45, -22, -8, 0, 8, 22, 45, 80].map(d => d * Math.PI / 180);
export const RAY_LENGTH = 70;
// Distances (m) to the look-ahead points on the road (along the shortest route)
export const LOOKAHEAD = [10, 25, 45, 70];
// Inputs: rays + speed + lateral offset + look-ahead directions + speed level + sideways slide
// + police radar (how close the nearest police car is in each of 6 zones around
// the car, and how fast the nearest one is closing in)
export const BASE_INPUT_SIZE = RAY_ANGLES.length + 2 + LOOKAHEAD.length + 2;
export const RADAR_ZONES = 6;           // 60° each: front, front-right, back-right, behind, back-left, front-left
export const INPUT_SIZE = BASE_INPUT_SIZE + RADAR_ZONES + 1;
export const OLD_INPUT_SIZES = [BASE_INPUT_SIZE, BASE_INPUT_SIZE + 2]; // brains saved before police / before the radar
const POLICE_SEE = 70;     // metres – how far racers notice police cars
const POLICE_R = 1.6;      // police cars look like a circle this big to the distance sensors
export const OUTPUT_SIZE = 2; // steer, throttle/brake

const GRAVITY = 9.81;
const STOP_SPEED = 2;      // m/s – slower than this counts as "stopped"
const STOP_TIME = 1.2;     // seconds stopped -> eliminated
const NO_PROGRESS_TIME = 10; // seconds without a new best distance -> eliminated
// Speed levels from pads: each level up = +25 % top speed & power, each level down = −18 %
export const SPEED_UP_STEP = 0.25, SPEED_DOWN_STEP = 0.18;
const PAD_KICK = 3;        // m/s instant push per strength point of a speed pad
const PAD_BRAKE = 0.12;    // instant speed loss per strength point of a slow pad

export class Car {
  /** opts.roadAhead: give the car the "road ahead" sense (directions to points further along the route) */
  constructor(brain, track, opts = {}) {
    this.brain = brain;
    this.track = track;
    this.roadAhead = opts.roadAhead !== false;
    this.inputs = new Float32Array(INPUT_SIZE);
    this.rays = new Float32Array(RAY_ANGLES.length);
    this.police = null;        // police cars on track (set by the evolution)
    this.reset();
  }

  reset() {
    const tr = this.track;
    const s = tr.startIndex;
    this.x = tr.cx[s]; this.z = tr.cz[s];
    this.heading = Math.atan2(tr.dz[s], tr.dx[s]);
    this.vx = 0; this.vz = 0;
    this.speed = 0;            // forward speed
    this.slip = 0;             // sideways speed
    this.steer = 0; this.throttle = 0;
    this.seg = s; this.lateral = 0; this.roadH = tr.ch[s];
    this.progress = 0;         // metres of the current lap done (lapLength - distance left)
    this.maxProgress = 0;      // best total distance (all laps) reached so far
    this.lap = 0;              // laps completed
    this.lapMax = 0;           // best distance reached in the current lap
    this.lapStart = 0;
    this.lapTimes = [];
    this.awaitCross = false;   // just counted a lap, waiting to roll over the line
    this.padFlash = 0;
    this.lastProgressTime = 0;
    this.stoppedTime = 0;
    this.everMoved = false;
    this.time = 0;
    this.distance = 0;
    this.alive = true;
    this.finished = false;     // finished cars keep driving a victory lap
    this.lapTime = null;
    this.crashed = false;
    this.stalled = false;
    this.busted = false;
    this.diedAt = 0;
    this.onOil = false;
    this.inTunnel = false;
    this.killedBy = null;
    this.y = 0; this.vy = 0;   // height above the road (jumps)
    this.airborne = false;
    this.jumps = 0;
    this.speedLevel = 0;       // -4 … +4 from speed / slow pads
    this.padInside = new Uint8Array(tr.obstacles.length);
    this.fitness = 0;
  }

  get racing() { return this.alive && !this.finished; }
  get speedFactor() {
    const l = this.speedLevel;
    return l >= 0 ? 1 + SPEED_UP_STEP * l : Math.max(0.25, 1 + SPEED_DOWN_STEP * l);
  }

  sense() {
    const tr = this.track, inp = this.inputs;
    const h = this.heading;

    for (let r = 0; r < RAY_ANGLES.length; r++) {
      const a = h + RAY_ANGLES[r];
      const dx = Math.cos(a), dz = Math.sin(a);
      let d = tr.raycast(this.x, this.z, dx, dz, this.roadH, RAY_LENGTH);
      // hammers, spikes and crates are "seen" by the same rays
      for (const o of tr.obstacles) {
        if ((o.x - this.x) ** 2 + (o.z - this.z) ** 2 > (RAY_LENGTH + 10) ** 2 || Math.abs(o.y - this.roadH) > 2.5) continue;
        d = Math.min(d, obstacleRay(o, this.x, this.z, dx, dz, this.time, d));
      }
      // ...and so are police cars
      if (this.police) for (const p of this.police) {
        if (!p.alive || Math.abs(p.roadH - this.roadH) > 2.5) continue;
        const ox = p.x - this.x, oz = p.z - this.z, along = ox * dx + oz * dz;
        if (along <= 0 || along - POLICE_R > d) continue;
        const off2 = ox * ox + oz * oz - along * along;
        if (off2 < POLICE_R * POLICE_R) d = Math.min(d, Math.max(0, along - Math.sqrt(POLICE_R * POLICE_R - off2)));
      }
      this.rays[r] = d;
      inp[r] = d / RAY_LENGTH;
    }
    let k = RAY_ANGLES.length;
    inp[k++] = this.speed / CAR.maxSpeed;
    inp[k++] = clamp(this.lateral / tr.halfWidth, -1.5, 1.5);
    // Where is the road going? Angle from the car's heading to road points
    // further along the best route (like a driver looking through the corner).
    // (Off = the car only has its distance sensors, like a real "learn from nothing" driver.)
    let idx = this.seg, walked = 0;
    for (const ahead of LOOKAHEAD) {
      if (!this.roadAhead) { inp[k++] = 0; continue; }
      while (walked < ahead) { const n = tr.next[idx]; if (n === idx) break; idx = n; walked += tr.step; }
      const ang = Math.atan2(tr.cz[idx] - this.z, tr.cx[idx] - this.x);
      inp[k++] = clamp(angleDiff(ang, h) / (Math.PI / 2), -1, 1);
    }
    inp[k++] = this.speedLevel / 4;
    inp[k++] = clamp(this.slip / 10, -1, 1);
    // police radar: for each zone around the car, how close the nearest police car there is
    // (0 = none within range, 1 = right next to us), plus how fast the nearest one closes in
    const radar = this.radar || (this.radar = new Float32Array(RADAR_ZONES));
    radar.fill(0);
    let nd = POLICE_SEE, closing = 0;
    if (this.police) for (const p of this.police) {
      if (!p.alive || Math.abs(p.roadH - this.roadH) > 3) continue;
      const dx = p.x - this.x, dz = p.z - this.z, d = Math.hypot(dx, dz);
      if (d >= POLICE_SEE) continue;
      const rel = angleDiff(Math.atan2(dz, dx), h);               // 0 = dead ahead, + = to the right
      const zone = ((Math.round(rel / (Math.PI / 3)) % RADAR_ZONES) + RADAR_ZONES) % RADAR_ZONES;
      radar[zone] = Math.max(radar[zone], 1 - d / POLICE_SEE);
      if (d < nd) { nd = d; closing = -((p.vx - this.vx) * dx + (p.vz - this.vz) * dz) / (d || 1); }
    }
    for (let z = 0; z < RADAR_ZONES; z++) inp[k++] = radar[z];
    inp[k++] = clamp(closing / 30, -1, 1);
    return inp;
  }

  think() {
    const out = this.brain.forward(this.sense());
    this.steer = out[0];
    this.throttle = out[1];
  }

  /** Advance physics by dt seconds. */
  step(dt) {
    if (!this.alive) return;
    const c = CAR, tr = this.track;
    const px = this.x, pz = this.z;
    this.time += dt;
    this.dt = dt;

    if (this.airborne) {
      // Flying: no grip, so no steering, throttle or brakes – just a ballistic arc
      this.vy -= GRAVITY * dt;
      this.y += this.vy * dt;
      this.x += this.vx * dt; this.z += this.vz * dt;
      this.distance += Math.hypot(this.vx, this.vz) * dt;
      const nr = this.updateTrackPosition();
      if (!this.alive) return;
      if (this.y > 0) { this.checkEnd(); return; }
      this.y = 0; this.vy = 0; this.airborne = false;
      this.vx *= 0.93; this.vz *= 0.93; // landing costs a little speed
      if (nr.dist > tr.halfWidth) { this.die('landing'); return; }
      this.checkEnd();
      return;
    }

    this.think();
    const fx = Math.cos(this.heading), fz = Math.sin(this.heading);
    let vf = this.vx * fx + this.vz * fz;          // forward speed
    let vl = -this.vx * fz + this.vz * fx;         // sideways speed (+ = right)
    const grip = c.grip * (this.onOil ? c.oilGrip : 1);
    const traction = this.onOil ? 0.25 : 1;
    const maxS = c.maxSpeed * this.speedFactor;

    // Longitudinal
    let accel;
    if (this.throttle >= 0) accel = this.throttle * c.engine * this.speedFactor * (1 - 0.6 * vf / maxS);
    else accel = this.throttle * c.brake;
    accel = accel * traction - (c.drag * vf * vf / 10 + (vf > 0 ? c.rolling : 0));
    vf = clamp(vf + accel * dt, 0, maxS);
    if (this.inMud) vf *= Math.max(0, 1 - 1.6 * dt); // thick mud: heavy drag

    // Steering: kinematic bicycle, yaw limited by tyre grip (understeer)
    const steerAngle = this.steer * c.maxSteer / (1 + vf / 30);
    let yawRate = vf * Math.tan(steerAngle) / c.wheelBase;
    const latAcc = Math.abs(yawRate * vf);
    if (this.onOil) {
      // On oil the car still rotates when steered, but its momentum carries it
      // on in the old direction – it slides sideways, and a slide turns into a spin
      yawRate = yawRate * 0.8 + vl * 0.06;
    } else if (latAcc > grip) {
      yawRate *= grip / latAcc;
      vf = Math.max(0, vf - (latAcc - grip) * 0.15 * dt); // scrubbing tyres costs speed
    }

    // Tyres fight sideways sliding (almost not at all on oil)
    const fric = grip * dt;
    vl = Math.abs(vl) <= fric ? 0 : vl - Math.sign(vl) * fric;

    this.vx = vf * fx - vl * fz;
    this.vz = vf * fz + vl * fx;
    this.speed = vf; this.slip = vl;
    this.heading += yawRate * dt;
    this.x += this.vx * dt; this.z += this.vz * dt;
    this.distance += Math.hypot(this.vx, this.vz) * dt;

    const nr = this.updateTrackPosition();
    if (!this.alive) return;

    // Obstacles
    this.onOil = false;
    this.inMud = false;
    let dead = null;
    for (const o of tr.obstacles) {
      if ((o.x - this.x) ** 2 + (o.z - this.z) ** 2 > 225 || Math.abs(o.y - this.roadH) > 2.5) { this.padInside[o.index] = 0; continue; }
      const hit = obstacleContact(o, this.x, this.z, this.time);
      if (hit === 'dead') dead = o.type;
      else if (hit === 'smash') { o.broken = true; o.brokenAt = this.time; dead = 'crates'; }
      else if (hit === 'mud') this.inMud = true;
      else if (hit === 'bump') {
        // bounce away from the post: reflect the velocity and push the car out
        let nx = this.x - o.x, nz = this.z - o.z; const L = Math.hypot(nx, nz) || 1; nx /= L; nz /= L;
        const vn = this.vx * nx + this.vz * nz;
        if (vn < 0) { this.vx -= 1.8 * vn * nx; this.vz -= 1.8 * vn * nz; }
        this.vx += nx * 4; this.vz += nz * 4;
        const push = o.r + 1.15 - L; if (push > 0) { this.x += nx * push; this.z += nz * push; }
      }
      else if (hit === 'oil') this.onOil = true;
      else if (hit === 'ramp' && !dead) {
        // Launch! Faster cars and steeper ramps fly higher and further
        this.airborne = true;
        this.vy = Math.min(o.maxVy, Math.max(0, vf) * o.lift);
        this.y = 0.01;
        this.jumps++;
      } else if (hit === 'boost' || hit === 'slow') {
        if (!this.padInside[o.index]) {
          // each pass over a pad shifts the speed level; stacks, capped at ±4
          const before = this.speedFactor;
          this.speedLevel = clamp(this.speedLevel + (hit === 'boost' ? o.strength : -o.strength), -4, 4);
          // instant effect: a kick forward (speed pad) or a sharp brake (slow pad), plus the new level
          let k = this.speedFactor / before;
          const fwd = Math.max(1, this.speed);
          if (hit === 'boost') k *= (fwd + PAD_KICK * o.strength) / fwd;
          else k *= Math.max(0.3, 1 - PAD_BRAKE * o.strength);
          k = Math.min(k, (CAR.maxSpeed * this.speedFactor) / fwd);
          this.vx *= k; this.vz *= k; this.speed *= k;
          this.padFlash = 1;
        }
      }
      this.padInside[o.index] = hit === 'boost' || hit === 'slow' ? 1 : 0;
    }

    if (dead) { this.die(dead); return; }
    if (nr.dist > tr.halfWidth) { this.die('offroad'); return; }
    this.checkEnd();
  }

  die(reason) {
    this.alive = false;
    this.crashed = reason !== 'stopped';
    this.busted = reason === 'busted';
    this.stalled = reason === 'stopped';
    this.killedBy = reason;
    this.diedAt = this.time;
  }

  /** Find where the car is on the network and update lap progress. */
  updateTrackPosition() {
    const tr = this.track;
    const nr = tr.nearest(this.x, this.z, this.seg);
    this.seg = nr.index; this.lateral = nr.lateral;
    this.roadH = tr.heightAt(nr.index, nr.t);
    this.inTunnel = tr.tunnel[nr.index] === 1;
    if (this.finished) return nr; // victory lap: just keep driving
    const prev = this.progress;
    const prog = tr.lapLength - nr.D;
    if (prog - prev > 25 && !this.awaitCross) { this.die('wrongway'); return nr; } // reversed over the start line
    this.progress = prog;
    if (this.awaitCross) { if (prog < tr.lapLength * 0.5) this.awaitCross = false; return nr; }
    if (prog > this.lapMax + 1) {
      this.lapMax = prog;
      this.maxProgress = this.lap * tr.lapLength + prog;
      this.lastProgressTime = this.time;
    }
    return nr;
  }

  /** Stopped, stuck, or finished? */
  checkEnd() {
    const tr = this.track;
    if (!this.finished && !this.awaitCross && this.lapMax > tr.lapLength * 0.5 && tr.lapLength - this.progress < 1.5) {
      // crossed the line: one more lap done
      this.lap++;
      this.lapTimes.push(this.time - this.lapStart);
      this.lapStart = this.time;
      this.lapMax = 0;
      this.awaitCross = true;
      this.maxProgress = this.lap * tr.lapLength;
      this.lastProgressTime = this.time;
      if (this.lap >= tr.laps) {
        this.finished = true;
        this.lapTime = this.time;  // total race time
        return;
      }
    }
    // cars that just sit there are removed quickly (and score lower than crashing)
    if (this.speed > 2 * STOP_SPEED) this.everMoved = true;
    // a car that has been driving and stops is removed quickly; one that never
    // pulls away gets a few seconds at the start (new brains are timid)
    if (!this.airborne && Math.abs(this.speed) < STOP_SPEED && (this.everMoved || this.time > 3)) this.stoppedTime += this.dt;
    else this.stoppedTime = 0;
    if (this.finished) { if (this.stoppedTime > STOP_TIME) this.die('parked'); return; }
    if (this.stoppedTime > STOP_TIME) this.die('stopped');
    else if (this.time - this.lastProgressTime > NO_PROGRESS_TIME) this.die('stopped');
  }

  computeFitness() {
    const tr = this.track;
    const frac = Math.max(0, this.maxProgress) / tr.raceLength;
    if (this.finished) {
      // Every finisher beats every non-finisher; faster race = higher fitness
      const avgSpeed = tr.raceLength / this.lapTime;
      this.fitness = 2 + 3 * avgSpeed / CAR.maxSpeed;
    } else {
      const avgSpeed = (frac * tr.raceLength) / Math.max(1, this.time);
      this.fitness = frac + 0.15 * frac * (avgSpeed / CAR.maxSpeed) - (this.crashed ? 0.002 : 0) - (this.stalled ? 0.02 : 0);
    }
    return this.fitness;
  }
}

export function angleDiff(a, b) {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}
function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
