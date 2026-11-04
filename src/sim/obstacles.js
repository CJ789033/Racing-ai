// Obstacles placed on the track: geometry, collision and sensor raycasts.
// Each obstacle sits on one road edge at a fraction of its length, in a lane
// relative to the driving direction.
import { obstacleParam } from './tiles.js';

export const CAR_RADIUS = 1.1;

const WIDTH_FRAC = { narrow: 0.25, wide: 0.7, full: 1 };
export const HAMMER_PERIOD = { slow: 3.6, normal: 2.4, fast: 1.5 };
export const SPIN_PERIOD = { slow: 4.5, normal: 3, fast: 1.8 };    // seconds per turn
export const LASER_PERIOD = { slow: 4, normal: 2.6, fast: 1.6 };   // seconds per on/off cycle
export const RAMP = { // vertical launch speed per m/s of speed, cap, visual height
  low: { lift: 0.15, maxVy: 6, h: 0.9 },
  normal: { lift: 0.25, maxVy: 9, h: 1.5 },
  steep: { lift: 0.38, maxVy: 13, h: 2.6 },
};

/** Size/placement of an obstacle for a given road half-width (metres). */
export function obstacleLayout(o, hw) {
  const type = o.type;
  const side = o.lane === 'left' ? -1 : o.lane === 'right' ? 1 : 0; // +1 = driver's right
  const width = obstacleParam(o, 'width');
  // half-width across the road: explicit width option, else the type's normal size
  const across = (normalCentre, normalSide) =>
    width && width !== 'normal' ? hw * WIDTH_FRAC[width] : side ? hw * normalSide : hw * normalCentre;
  const place = b => (width === 'full' || !side ? 0 : side * (hw - b)); // keep side obstacles against the edge
  switch (type) {
    case 'spikes': { const b = across(0.4, 0.5); return { lat: place(b), a: 1.3, b }; }
    case 'crates': { const b = side ? hw * 0.5 : hw * 0.35; return { lat: side * hw * 0.5, a: 1.6, b }; }
    case 'oil':    return { lat: side * hw * 0.45, r: hw * 0.7 };
    case 'hammer': return { lat: 0, amp: hw * 0.85, headR: 1.6, period: HAMMER_PERIOD[obstacleParam(o, 'speed')] };
    case 'ramp':   { const b = across(0.45, 0.5); const R = RAMP[obstacleParam(o, 'angle')]; return { lat: place(b), a: 3, b, ...R }; }
    case 'boost':
    case 'slow':   { const b = across(0.45, 0.5); return { lat: place(b), a: 2.5, b, strength: obstacleParam(o, 'strength') }; }
    case 'spinner': return { lat: 0, arm: hw * 0.8, period: SPIN_PERIOD[obstacleParam(o, 'speed')] };
    case 'laser':  return { lat: 0, a: 0.35, b: hw, period: LASER_PERIOD[obstacleParam(o, 'speed')] };
    case 'mud':    { const b = across(0.5, 0.5); return { lat: place(b), a: 7, b }; }
    case 'bumper': return { lat: side * hw * 0.45, r: 1.4 };
    default: return { lat: 0 };
  }
}

/** Resolve obstacle definitions ({type, edge, pos, lane, ...}) into world geometry. */
export function prepareObstacles(track, defs) {
  return (defs || []).map((d, i) => {
    const seg = track.pointOnEdge(d.edge, d.pos);
    const L = obstacleLayout(d, track.halfWidth);
    const tx = track.dx[seg], tz = track.dz[seg];
    const o = {
      ...d, ...L, seg, index: i,
      tx, tz, nx: -tz, nz: tx,           // along the driving direction / to the driver's right
      cx: track.cx[seg], cz: track.cz[seg], y: track.ch[seg],
      phase: (i * 2.1) % (Math.PI * 2),
    };
    o.x = o.cx + o.nx * L.lat;
    o.z = o.cz + o.nz * L.lat;
    return o;
  });
}

/** Spinner bar end points at time t: [x1, z1, x2, z2] */
export function spinnerBar(o, t) {
  const a = (2 * Math.PI * t) / o.period + o.phase, c = Math.cos(a) * o.arm, s = Math.sin(a) * o.arm;
  return [o.x + c, o.z + s, o.x - c, o.z - s];
}
/** Is the laser switched on at time t? (on for 55 % of each cycle) */
export function laserOn(o, t) { return (((t + o.phase) / o.period) % 1) < 0.55; }

function segDist2(px, pz, ax, az, bx, bz) {
  const sx = bx - ax, sz = bz - az, L2 = sx * sx + sz * sz || 1e-6;
  let t = ((px - ax) * sx + (pz - az) * sz) / L2; t = t < 0 ? 0 : t > 1 ? 1 : t;
  return (px - ax - sx * t) ** 2 + (pz - az - sz * t) ** 2;
}

/** Lateral offset of a hammer's head at time t. */
export function hammerLat(o, t) { return o.amp * Math.sin((2 * Math.PI * t) / o.period + o.phase); }

function inRect(o, x, z, pad) {
  const dx = x - o.x, dz = z - o.z;
  const u = dx * o.tx + dz * o.tz, v = dx * o.nx + dz * o.nz;
  return Math.abs(u) < o.a + pad && Math.abs(v) < o.b + pad ? u : null;
}

/**
 * What happens to a car at (x, z) at time t?
 * Returns 'dead', 'solid', 'oil', 'ramp', 'boost', 'slow' or null.
 */
export function obstacleContact(o, x, z, t) {
  switch (o.type) {
    case 'spikes': return inRect(o, x, z, CAR_RADIUS) !== null ? 'dead' : null;
    // crates: the first car to hit them is wrecked and smashes them; later cars drive through the debris
    case 'crates': return !o.broken && inRect(o, x, z, CAR_RADIUS) !== null ? 'smash' : null;
    case 'mud':    return inRect(o, x, z, 0) !== null ? 'mud' : null;
    case 'laser':  return laserOn(o, t) && inRect(o, x, z, CAR_RADIUS * 0.6) !== null ? 'dead' : null;
    case 'bumper': return (x - o.x) ** 2 + (z - o.z) ** 2 < (o.r + CAR_RADIUS) ** 2 ? 'bump' : null;
    case 'spinner': {
      const [ax, az, bx, bz] = spinnerBar(o, t);
      return segDist2(x, z, ax, az, bx, bz) < (CAR_RADIUS + 0.35) ** 2 || (x - o.x) ** 2 + (z - o.z) ** 2 < 1.6 ** 2 ? 'dead' : null;
    }
    case 'boost':
    case 'slow':   return inRect(o, x, z, 0) !== null ? o.type : null;
    case 'oil':    return (x - o.x) ** 2 + (z - o.z) ** 2 < o.r * o.r ? 'oil' : null;
    case 'ramp': {
      // launches the car once its centre reaches the top half of the ramp
      const u = inRect(o, x, z, 0);
      return u !== null && u > 0 ? 'ramp' : null;
    }
    case 'hammer': {
      const lat = hammerLat(o, t);
      const hx = o.cx + o.nx * lat, hz = o.cz + o.nz * lat;
      return (x - hx) ** 2 + (z - hz) ** 2 < (o.headR + CAR_RADIUS) ** 2 ? 'dead' : null;
    }
  }
  return null;
}

/** Distance along a ray to the obstacle (maxT if missed). Flat things (oil, ramps, pads) can't be "seen". */
export function obstacleRay(o, ox, oz, dx, dz, t, maxT) {
  if (o.type === 'crates' && o.broken) return maxT;
  if (o.type === 'laser' && !laserOn(o, t)) return maxT;
  if (o.type === 'bumper') return rayCircle(o.x - ox, o.z - oz, dx, dz, o.r, maxT);
  if (o.type === 'spinner') {
    const [ax, az, bx, bz] = spinnerBar(o, t);
    return Math.min(raySeg(ox, oz, dx, dz, ax, az, bx, bz, maxT), rayCircle(o.x - ox, o.z - oz, dx, dz, 1.2, maxT));
  }
  if (o.type === 'spikes' || o.type === 'crates' || o.type === 'laser') {
    // ray vs oriented rectangle (slab method in the obstacle's frame)
    const rx = ox - o.x, rz = oz - o.z;
    const pu = rx * o.tx + rz * o.tz, pv = rx * o.nx + rz * o.nz;
    const du = dx * o.tx + dz * o.tz, dv = dx * o.nx + dz * o.nz;
    let t0 = 0, t1 = maxT;
    for (const [p, d, h] of [[pu, du, o.a], [pv, dv, o.b]]) {
      if (Math.abs(d) < 1e-9) { if (Math.abs(p) > h) return maxT; continue; }
      let ta = (-h - p) / d, tb = (h - p) / d;
      if (ta > tb) [ta, tb] = [tb, ta];
      t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
      if (t0 > t1) return maxT;
    }
    return t0;
  }
  if (o.type === 'hammer') {
    const lat = hammerLat(o, t);
    const hx = o.cx + o.nx * lat - ox, hz = o.cz + o.nz * lat - oz;
    const b = hx * dx + hz * dz;
    const c = hx * hx + hz * hz - o.headR * o.headR;
    const disc = b * b - c;
    if (disc < 0) return maxT;
    const tt = b - Math.sqrt(disc);
    return tt >= 0 && tt < maxT ? tt : maxT;
  }
  return maxT;
}

function rayCircle(hx, hz, dx, dz, r, maxT) {
  const b = hx * dx + hz * dz, c = hx * hx + hz * hz - r * r, disc = b * b - c;
  if (disc < 0) return maxT;
  const tt = b - Math.sqrt(disc);
  return tt >= 0 && tt < maxT ? tt : maxT;
}

function raySeg(ox, oz, dx, dz, ax, az, bx, bz, maxT) {
  const ex = bx - ax, ez = bz - az, den = dx * ez - dz * ex;
  if (Math.abs(den) < 1e-9) return maxT;
  const fx = ax - ox, fz = az - oz;
  const t = (fx * ez - fz * ex) / den, u = (fx * dz - fz * dx) / den;
  return t >= 0 && t < maxT && u >= 0 && u <= 1 ? t : maxT;
}

/** Put every breakable obstacle back together (start of a generation). */
export function resetObstacles(obstacles) { for (const o of obstacles) o.broken = false; }
