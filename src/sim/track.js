// Track geometry: turns a closed loop of player-placed control points into a
// smooth, uniformly sampled centerline with left/right borders, and provides
// fast local queries (nearest segment, raycasts against the borders).

const SAMPLE_STEP = 2; // metres between centerline samples

function catmullRom(p0, p1, p2, p3, t) {
  // Centripetal-ish uniform Catmull-Rom (good enough for hand-drawn tracks)
  const t2 = t * t, t3 = t2 * t;
  return {
    x: 0.5 * (2 * p1.x + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
    z: 0.5 * (2 * p1.z + (-p0.z + p2.z) * t + (2 * p0.z - 5 * p1.z + 4 * p2.z - p3.z) * t2 + (-p0.z + 3 * p1.z - 3 * p2.z + p3.z) * t3),
  };
}

export class Track {
  /**
   * @param {{x:number,z:number}[]} points closed loop of control points (metres)
   * @param {number} width track width in metres
   */
  constructor(points, width = 12) {
    if (points.length < 3) throw new Error('A track needs at least 3 points');
    this.points = points.map(p => ({ x: p.x, z: p.z }));
    this.width = width;
    this.halfWidth = width / 2;
    this.build();
  }

  build() {
    const P = this.points, n = P.length;
    // 1. Dense spline sampling
    const dense = [];
    for (let i = 0; i < n; i++) {
      const p0 = P[(i - 1 + n) % n], p1 = P[i], p2 = P[(i + 1) % n], p3 = P[(i + 2) % n];
      const span = Math.hypot(p2.x - p1.x, p2.z - p1.z);
      const steps = Math.max(8, Math.ceil(span / 0.5));
      for (let s = 0; s < steps; s++) dense.push(catmullRom(p0, p1, p2, p3, s / steps));
    }
    // 2. Cumulative length
    const cum = [0];
    for (let i = 1; i <= dense.length; i++) {
      const a = dense[i - 1], b = dense[i % dense.length];
      cum.push(cum[i - 1] + Math.hypot(b.x - a.x, b.z - a.z));
    }
    const total = cum[cum.length - 1];
    // 3. Uniform resample
    const N = Math.max(16, Math.round(total / SAMPLE_STEP));
    const step = total / N;
    this.N = N;
    this.length = total;
    this.step = step;
    this.cx = new Float32Array(N); this.cz = new Float32Array(N);
    let j = 0;
    for (let i = 0; i < N; i++) {
      const d = i * step;
      while (cum[j + 1] < d) j++;
      const a = dense[j], b = dense[(j + 1) % dense.length];
      const t = (d - cum[j]) / Math.max(1e-6, cum[j + 1] - cum[j]);
      this.cx[i] = a.x + (b.x - a.x) * t;
      this.cz[i] = a.z + (b.z - a.z) * t;
    }
    // 4. Tangents, normals, borders
    this.tx = new Float32Array(N); this.tz = new Float32Array(N);
    this.nx = new Float32Array(N); this.nz = new Float32Array(N);
    this.lx = new Float32Array(N); this.lz = new Float32Array(N);
    this.rx = new Float32Array(N); this.rz = new Float32Array(N);
    const h = this.halfWidth;
    for (let i = 0; i < N; i++) {
      const a = (i - 1 + N) % N, b = (i + 1) % N;
      let dx = this.cx[b] - this.cx[a], dz = this.cz[b] - this.cz[a];
      const len = Math.hypot(dx, dz) || 1;
      dx /= len; dz /= len;
      this.tx[i] = dx; this.tz[i] = dz;
      // left normal (rotate tangent +90deg in XZ plane)
      this.nx[i] = -dz; this.nz[i] = dx;
      this.lx[i] = this.cx[i] + this.nx[i] * h; this.lz[i] = this.cz[i] + this.nz[i] * h;
      this.rx[i] = this.cx[i] - this.nx[i] * h; this.rz[i] = this.cz[i] - this.nz[i] * h;
    }
    // Bounds (for camera framing)
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < N; i++) {
      minX = Math.min(minX, this.cx[i]); maxX = Math.max(maxX, this.cx[i]);
      minZ = Math.min(minZ, this.cz[i]); maxZ = Math.max(maxZ, this.cz[i]);
    }
    this.bounds = { minX, maxX, minZ, maxZ };
  }

  wrap(i) { const N = this.N; return ((i % N) + N) % N; }

  /** Signed heading-change per metre around index i (for lookahead inputs). */
  headingAt(i) { i = this.wrap(i); return Math.atan2(this.tz[i], this.tx[i]); }

  /**
   * Nearest centerline segment to (x,z), searching only near `hint`.
   * Returns { index, t, dist, lateral } where lateral>0 means left of center.
   */
  nearest(x, z, hint, back = 6, fwd = 14) {
    let best = null, bestD = Infinity;
    for (let k = -back; k <= fwd; k++) {
      const i = this.wrap(hint + k), j = this.wrap(i + 1);
      const ax = this.cx[i], az = this.cz[i];
      const sx = this.cx[j] - ax, sz = this.cz[j] - az;
      const L2 = sx * sx + sz * sz || 1e-6;
      let t = ((x - ax) * sx + (z - az) * sz) / L2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const px = ax + sx * t, pz = az + sz * t;
      const d = (x - px) ** 2 + (z - pz) ** 2;
      if (d < bestD) {
        bestD = d;
        best = { index: i, t, px, pz };
      }
    }
    const i = best.index;
    const lateral = (x - best.px) * this.nx[i] + (z - best.pz) * this.nz[i];
    return { index: i, t: best.t, dist: Math.sqrt(bestD), lateral };
  }

  /**
   * Distance along a ray until it hits a track border, testing only borders
   * near `hint`. Returns maxDist if nothing is hit.
   */
  raycast(ox, oz, dx, dz, hint, maxDist, back = 8, fwd = 45) {
    let best = maxDist;
    for (let k = -back; k < fwd; k++) {
      const i = this.wrap(hint + k), j = this.wrap(i + 1);
      best = Math.min(best,
        raySeg(ox, oz, dx, dz, this.lx[i], this.lz[i], this.lx[j], this.lz[j], best),
        raySeg(ox, oz, dx, dz, this.rx[i], this.rz[i], this.rx[j], this.rz[j], best));
    }
    return best;
  }

  /** Smallest turning radius on the centerline (metres) and where it occurs. */
  tightestCorner() {
    let minR = Infinity, at = 0;
    const w = 2; // smooth over a few samples
    for (let i = 0; i < this.N; i++) {
      let d = this.headingAt(i + w) - this.headingAt(i - w);
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      const r = (2 * w * this.step) / Math.max(Math.abs(d), 1e-6);
      if (r < minR) { minR = r; at = i; }
    }
    return { radius: minR, index: at, x: this.cx[at], z: this.cz[at] };
  }

  toJSON() { return { points: this.points, width: this.width }; }
}

function raySeg(ox, oz, dx, dz, ax, az, bx, bz, maxT) {
  const ex = bx - ax, ez = bz - az;
  const den = dx * ez - dz * ex;
  if (den > -1e-9 && den < 1e-9) return maxT;
  const fx = ax - ox, fz = az - oz;
  const t = (fx * ez - fz * ex) / den;   // along ray
  if (t < 0 || t >= maxT) return maxT;
  const u = (fx * dz - fz * dx) / den;   // along segment
  if (u < 0 || u > 1) return maxT;
  return t;
}

// ---------------------------------------------------------------------------
// Preset tracks (control points in metres)
export const PRESETS = {
  'Oval': {
    width: 14,
    points: [
      { x: -80, z: -35 }, { x: 0, z: -40 }, { x: 80, z: -35 }, { x: 105, z: 0 },
      { x: 80, z: 35 }, { x: 0, z: 40 }, { x: -80, z: 35 }, { x: -105, z: 0 },
    ],
  },
  'Kidney': {
    width: 12,
    points: [
      { x: -90, z: -50 }, { x: 0, z: -70 }, { x: 90, z: -50 }, { x: 110, z: 10 },
      { x: 70, z: 60 }, { x: 25, z: 30 }, { x: -25, z: 30 }, { x: -70, z: 60 }, { x: -110, z: 10 },
    ],
  },
  'Technical': {
    width: 11,
    points: [
      { x: -110, z: -80 }, { x: -20, z: -95 }, { x: 60, z: -90 }, { x: 115, z: -55 },
      { x: 110, z: 0 }, { x: 55, z: 0 }, { x: 25, z: 35 }, { x: 60, z: 65 },
      { x: 105, z: 80 }, { x: 95, z: 120 }, { x: 25, z: 130 }, { x: -55, z: 75 },
      { x: -70, z: 30 }, { x: -115, z: 15 }, { x: -130, z: -40 },
    ],
  },
};

/** A random but well-behaved closed track (star-shaped around the origin). */
export function randomTrackPoints(rng = Math.random) {
  const n = 9 + Math.floor(rng() * 6);
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const r = 60 + rng() * 70;
    pts.push({ x: Math.cos(a) * r * 1.25, z: Math.sin(a) * r });
  }
  return pts;
}
