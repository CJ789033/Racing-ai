// Simple top-down car physics + sensors. Everything happens on the XZ plane.
import { obstacleContact, obstacleRay } from './obstacles.js';

export const CAR = {
  maxSpeed: 48,      // m/s (~170 km/h)
  engine: 11,        // m/s^2 at full throttle (falls off towards top speed)
  brake: 26,         // m/s^2 at full brake
  drag: 0.012,       // aero drag coefficient (per m/s)
  rolling: 0.6,      // m/s^2 rolling resistance
  wheelBase: 2.6,    // metres
  maxSteer: 0.55,    // radians at standstill
  grip: 17,          // max lateral acceleration (m/s^2) before understeer
  length: 4.2, width: 1.9,
};

// Sensor ray angles relative to heading (radians)
export const RAY_ANGLES = [-80, -45, -22, -8, 0, 8, 22, 45, 80].map(d => d * Math.PI / 180);
export const RAY_LENGTH = 70;
// Distances (m) to the look-ahead points on the centerline
export const LOOKAHEAD = [10, 25, 45, 70];
// Inputs: rays + speed + lateral offset + direction to each look-ahead point
export const INPUT_SIZE = RAY_ANGLES.length + 2 + LOOKAHEAD.length;
export const OUTPUT_SIZE = 2; // steer, throttle/brake

const STALL_TIME = 3;   // seconds without progress -> eliminated

export class Car {
  constructor(brain, track) {
    this.brain = brain;
    this.track = track;
    this.inputs = new Float32Array(INPUT_SIZE);
    this.rays = new Float32Array(RAY_ANGLES.length);
    this.reset();
  }

  reset() {
    const tr = this.track;
    this.x = tr.cx[0]; this.z = tr.cz[0];
    this.heading = Math.atan2(tr.tz[0], tr.tx[0]);
    this.speed = 0;
    this.steer = 0; this.throttle = 0;
    this.seg = 0; this.segT = 0; this.lateral = 0;
    this.laps = 0;
    this.progress = 0;        // in segments, continuous
    this.maxProgress = 0;
    this.lastProgressTime = 0;
    this.time = 0;
    this.distance = 0;
    this.alive = true;
    this.finished = false;
    this.lapTime = null;
    this.crashed = false;
    this.onOil = false;
    this.killedBy = null;
    this.fitness = 0;
  }

  sense() {
    const tr = this.track, inp = this.inputs;
    const h = this.heading;
    for (let r = 0; r < RAY_ANGLES.length; r++) {
      const a = h + RAY_ANGLES[r];
      const dx = Math.cos(a), dz = Math.sin(a);
      let d = tr.raycast(this.x, this.z, dx, dz, this.seg, RAY_LENGTH);
      // obstacles ahead are "seen" by the same rays (oil isn't visible)
      for (const o of tr.obstacles) {
        const sd = tr.segDiff(this.seg, o.seg);
        if (sd < -6 || sd > 40) continue;
        d = Math.min(d, obstacleRay(o, this.x, this.z, dx, dz, this.time, d));
      }
      this.rays[r] = d;
      inp[r] = d / RAY_LENGTH;
    }
    let k = RAY_ANGLES.length;
    inp[k++] = this.speed / CAR.maxSpeed;
    inp[k++] = this.lateral / tr.halfWidth;
    // Where is the road going? Angle from the car's heading to centerline
    // points further ahead (like a driver looking through the corner).
    for (const ahead of LOOKAHEAD) {
      const idx = tr.wrap(this.seg + Math.round(ahead / tr.step));
      const ang = Math.atan2(tr.cz[idx] - this.z, tr.cx[idx] - this.x);
      inp[k++] = clamp(angleDiff(ang, h) / (Math.PI / 2), -1, 1);
    }
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
    this.think();
    const c = CAR;
    // Longitudinal
    let accel;
    if (this.throttle >= 0) accel = this.throttle * c.engine * (1 - 0.6 * this.speed / c.maxSpeed);
    else accel = this.throttle * c.brake;
    accel -= c.drag * this.speed * this.speed / 10 + (this.speed > 0 ? c.rolling : 0);
    this.speed = clamp(this.speed + accel * dt, 0, c.maxSpeed);

    // Lateral: kinematic bicycle, limited by tyre grip (understeer)
    const steerAngle = this.steer * c.maxSteer / (1 + this.speed / 30);
    let yawRate = this.speed * Math.tan(steerAngle) / c.wheelBase;
    const latAcc = Math.abs(yawRate * this.speed);
    const grip = this.onOil ? c.grip * 0.25 : c.grip;
    if (latAcc > grip) {
      yawRate *= grip / latAcc;
      // scrubbing tyres costs speed
      this.speed = Math.max(0, this.speed - (latAcc - grip) * 0.15 * dt);
    }
    this.heading += yawRate * dt;
    const vx = Math.cos(this.heading) * this.speed, vz = Math.sin(this.heading) * this.speed;
    const px = this.x, pz = this.z;
    this.x += vx * dt; this.z += vz * dt;
    this.distance += this.speed * dt;
    this.time += dt;

    // Track position & progress
    const tr = this.track;
    const prevSeg = this.seg;
    const nr = tr.nearest(this.x, this.z, this.seg);
    this.seg = nr.index; this.segT = nr.t; this.lateral = nr.lateral;
    if (prevSeg > tr.N * 0.75 && this.seg < tr.N * 0.25) this.laps++;
    else if (prevSeg < tr.N * 0.25 && this.seg > tr.N * 0.75) this.laps--;
    this.progress = this.laps * tr.N + this.seg + this.segT;

    if (this.progress > this.maxProgress + 0.5) {
      this.maxProgress = this.progress;
      this.lastProgressTime = this.time;
    }

    // Obstacles
    this.onOil = false;
    let dead = null;
    for (const o of tr.obstacles) {
      const sd = tr.segDiff(this.seg, o.seg);
      if (sd < -4 || sd > 4) continue;
      const hit = obstacleContact(o, this.x, this.z, this.time);
      if (hit === 'dead') dead = o.type;
      else if (hit === 'solid') { this.x = px; this.z = pz; this.speed = 0; }
      else if (hit === 'oil') this.onOil = true;
    }

    // Termination conditions
    if (dead) { this.alive = false; this.crashed = true; this.killedBy = dead; }
    else if (nr.dist > tr.halfWidth) { this.alive = false; this.crashed = true; }
    else if (this.time - this.lastProgressTime > STALL_TIME) this.alive = false;
    else if (this.progress < -3) this.alive = false;
    else if (this.progress >= tr.N) {
      this.alive = false;
      this.finished = true;
      this.lapTime = this.time;
    }
  }

  computeFitness() {
    const tr = this.track;
    const frac = Math.max(0, this.maxProgress) / tr.N;
    if (this.finished) {
      // Every finisher beats every non-finisher; faster lap = higher fitness
      const avgSpeed = tr.length / this.lapTime;
      this.fitness = 2 + 3 * avgSpeed / CAR.maxSpeed;
    } else {
      const avgSpeed = (frac * tr.length) / Math.max(1, this.time);
      this.fitness = frac + 0.15 * frac * (avgSpeed / CAR.maxSpeed) - (this.crashed ? 0.002 : 0);
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
