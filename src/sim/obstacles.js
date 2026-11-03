// Obstacles placed on the track: geometry, collision and sensor raycasts.
// Positions are given as distance along the lap (s) + lane; lanes are relative
// to the driving direction.

export const CAR_RADIUS = 1.1;

/** Size/placement of an obstacle type for a given track half-width (metres). */
export function obstacleLayout(type, lane, hw) {
  const side = lane === 'left' ? -1 : lane === 'right' ? 1 : 0; // +1 = along the track's +normal (driver's right)
  switch (type) {
    case 'spikes': return { lat: side * hw * 0.5, a: 1.3, b: side ? hw * 0.5 : hw * 0.4 };
    case 'crates': return { lat: side * hw * 0.5, a: 1.6, b: side ? hw * 0.5 : hw * 0.35 };
    case 'oil':    return { lat: side * hw * 0.45, r: hw * 0.6 };
    case 'hammer': return { lat: 0, amp: hw * 0.85, headR: 1.6, period: 2.4 };
    case 'ramp':   return { lat: side * hw * 0.5, a: 3, b: side ? hw * 0.5 : hw * 0.45, h: 1.5 };
    default: return { lat: 0 };
  }
}

/** Resolve obstacle definitions into world geometry for a built Track. */
export function prepareObstacles(track, defs) {
  return (defs || []).map((d, i) => {
    const seg = track.wrap(Math.round(d.s / track.step));
    const L = obstacleLayout(d.type, d.lane, track.halfWidth);
    const o = {
      type: d.type, lane: d.lane, seg, ...L,
      tx: track.tx[seg], tz: track.tz[seg], nx: track.nx[seg], nz: track.nz[seg],
      cx: track.cx[seg], cz: track.cz[seg],
      phase: (i * 2.1) % (Math.PI * 2),
    };
    o.x = o.cx + o.nx * L.lat;
    o.z = o.cz + o.nz * L.lat;
    return o;
  });
}

/** Lateral offset of a hammer's head at time t. */
export function hammerLat(o, t) { return o.amp * Math.sin((2 * Math.PI * t) / o.period + o.phase); }

/**
 * What happens to a car at (x, z) at time t?
 * Returns 'dead' (lethal), 'solid' (blocked), 'oil' (slippery) or null.
 */
export function obstacleContact(o, x, z, t) {
  switch (o.type) {
    case 'spikes':
    case 'crates': {
      const dx = x - o.x, dz = z - o.z;
      const u = dx * o.tx + dz * o.tz, v = dx * o.nx + dz * o.nz;
      if (Math.abs(u) < o.a + CAR_RADIUS && Math.abs(v) < o.b + CAR_RADIUS) return o.type === 'spikes' ? 'dead' : 'solid';
      return null;
    }
    case 'oil':
      return (x - o.x) ** 2 + (z - o.z) ** 2 < o.r * o.r ? 'oil' : null;
    case 'ramp': {
      // launches the car once its centre reaches the top half of the ramp
      const dx = x - o.x, dz = z - o.z;
      const u = dx * o.tx + dz * o.tz, v = dx * o.nx + dz * o.nz;
      return u > 0 && u < o.a && Math.abs(v) < o.b ? 'ramp' : null;
    }
    case 'hammer': {
      const lat = hammerLat(o, t);
      const hx = o.cx + o.nx * lat, hz = o.cz + o.nz * lat;
      return (x - hx) ** 2 + (z - hz) ** 2 < (o.headR + CAR_RADIUS) ** 2 ? 'dead' : null;
    }
  }
  return null;
}

/** Distance along a ray to the obstacle (maxT if missed). Oil and ramps are too low to be "seen". */
export function obstacleRay(o, ox, oz, dx, dz, t, maxT) {
  if (o.type === 'spikes' || o.type === 'crates') {
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
