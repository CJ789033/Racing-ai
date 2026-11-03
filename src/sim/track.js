// Track = road network. Each edge is a road centerline between two nodes
// (junction points). The lap starts and ends at the start line, which splits
// the start road into an "ahead" edge (from the line) and a "behind" edge (to
// the line). For every sample point we store the shortest distance still to
// drive to the finish (D); a car's lap progress is lapLength - D, so it works
// whichever route the car takes. A top-down raster of the road surface (one
// per height level) is used for the distance sensors.
import { prepareObstacles } from './obstacles.js';

const SAMPLE_STEP = 2;  // metres between centerline samples
const RASTER = 0.5;     // metres per raster cell
const LEVEL_HEIGHT = 3; // road higher than this counts as the upper level
const SEARCH_HOPS = 10; // how far (in samples) to look for the nearest road
// height levels: 0 = ground, 1 = up on a bridge, 2 = down in a tunnel
const levelOf = h => (h >= LEVEL_HEIGHT ? 1 : h <= -LEVEL_HEIGHT ? 2 : 0);

function catmullRom(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  return {
    x: 0.5 * (2 * p1.x + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
    z: 0.5 * (2 * p1.z + (-p0.z + p2.z) * t + (2 * p0.z - 5 * p1.z + 4 * p2.z - p3.z) * t2 + (-p0.z + 3 * p1.z - 3 * p2.z + p3.z) * t3),
    h: 0,
  };
}

function resample(pts, step) {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
  const total = cum[cum.length - 1];
  const n = Math.max(1, Math.round(total / step));
  const out = [];
  let j = 0;
  for (let i = 0; i <= n; i++) {
    const d = total * i / n;
    while (j < pts.length - 2 && cum[j + 1] < d) j++;
    const a = pts[j], b = pts[j + 1] || a;
    const t = (d - cum[j]) / Math.max(1e-6, cum[j + 1] - cum[j]);
    out.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, h: (a.h || 0) + ((b.h || 0) - (a.h || 0)) * t });
  }
  return { pts: out, length: total };
}

export class Track {
  /**
   * @param net {{ edges: {a,b,points:{x,z,h}[],tunnel?,junction?}[], nodeCount, aheadEdge, behindEdge, obstacles?, islands? }}
   */
  constructor(net, width = 12) {
    this.net = net;
    this.width = width;
    this.halfWidth = width / 2;
    this.build();
  }

  /** A simple closed loop (freehand editor): control points -> spline -> network. */
  static fromLoop(points, width = 12, { spline = true } = {}) {
    if (points.length < 3) throw new Error('A track needs at least 3 points');
    const P = points, n = P.length, dense = [];
    if (spline) {
      for (let i = 0; i < n; i++) {
        const p0 = P[(i - 1 + n) % n], p1 = P[i], p2 = P[(i + 1) % n], p3 = P[(i + 2) % n];
        const steps = Math.max(8, Math.ceil(Math.hypot(p2.x - p1.x, p2.z - p1.z) / 0.5));
        for (let s = 0; s < steps; s++) dense.push(catmullRom(p0, p1, p2, p3, s / steps));
      }
    } else dense.push(...P.map(p => ({ x: p.x, z: p.z, h: p.h || 0 })));
    const mid = Math.floor(dense.length / 2);
    const t = new Track({
      nodeCount: 3, aheadEdge: 0, behindEdge: 1, obstacles: [],
      edges: [
        { a: 0, b: 1, points: dense.slice(0, mid + 1) },
        { a: 1, b: 2, points: [...dense.slice(mid), dense[0]] },
      ],
    }, width);
    t.points = points.map(p => ({ x: p.x, z: p.z }));
    return t;
  }

  build() {
    const net = this.net, hw = this.halfWidth;
    // ---- sample every edge uniformly and lay all samples out in flat arrays
    const E = net.edges.length;
    this.edgeStart = new Int32Array(E); this.edgeCount = new Int32Array(E);
    this.edgeLen = new Float32Array(E); this.edgeA = new Int32Array(E); this.edgeB = new Int32Array(E);
    const all = [];
    net.edges.forEach((e, i) => {
      const r = resample(e.points, SAMPLE_STEP);
      this.edgeStart[i] = all.length; this.edgeCount[i] = r.pts.length; this.edgeLen[i] = r.length;
      this.edgeA[i] = e.a; this.edgeB[i] = e.b;
      for (const p of r.pts) all.push({ ...p, e: i, tunnel: !!e.tunnel, junction: !!e.junction });
    });
    const N = this.N = all.length;
    this.step = SAMPLE_STEP;
    const F = () => new Float32Array(N);
    this.cx = F(); this.cz = F(); this.ch = F();
    this.tx = F(); this.tz = F(); this.nx = F(); this.nz = F();
    this.lx = F(); this.lz = F(); this.rx = F(); this.rz = F();
    this.edgeOf = new Int32Array(N);
    this.tunnel = new Uint8Array(N); this.junction = new Uint8Array(N); this.level = new Uint8Array(N);
    all.forEach((p, i) => {
      this.cx[i] = p.x; this.cz[i] = p.z; this.ch[i] = p.h; this.edgeOf[i] = p.e;
      this.tunnel[i] = p.tunnel ? 1 : 0; this.junction[i] = p.junction ? 1 : 0;
      this.level[i] = levelOf(p.h);
    });
    for (let e = 0; e < E; e++) {
      const s = this.edgeStart[e], n = this.edgeCount[e];
      for (let k = 0; k < n; k++) {
        const i = s + k, a = s + Math.max(0, k - 1), b = s + Math.min(n - 1, k + 1);
        let dx = this.cx[b] - this.cx[a], dz = this.cz[b] - this.cz[a];
        const L = Math.hypot(dx, dz) || 1; dx /= L; dz /= L;
        this.tx[i] = dx; this.tz[i] = dz; this.nx[i] = -dz; this.nz[i] = dx;
        this.lx[i] = this.cx[i] + this.nx[i] * hw; this.lz[i] = this.cz[i] + this.nz[i] * hw;
        this.rx[i] = this.cx[i] - this.nx[i] * hw; this.rz[i] = this.cz[i] - this.nz[i] * hw;
      }
    }

    // ---- neighbours of each sample (along its edge, and across nodes)
    const nodeEnds = Array.from({ length: net.nodeCount }, () => []);
    for (let e = 0; e < E; e++) {
      nodeEnds[this.edgeA[e]].push(this.edgeStart[e]);
      nodeEnds[this.edgeB[e]].push(this.edgeStart[e] + this.edgeCount[e] - 1);
    }
    const nb = Array.from({ length: N }, () => []);
    for (let e = 0; e < E; e++) {
      const s = this.edgeStart[e], n = this.edgeCount[e];
      for (let k = 0; k < n; k++) { if (k > 0) nb[s + k].push(s + k - 1); if (k < n - 1) nb[s + k].push(s + k + 1); }
    }
    for (const ends of nodeEnds) for (const i of ends) for (const j of ends) if (i !== j) nb[i].push(j);
    // the road is continuous over the start line (only the distance field is cut there)
    const sI = this.edgeStart[net.aheadEdge], fI = this.edgeStart[net.behindEdge] + this.edgeCount[net.behindEdge] - 1;
    nb[sI].push(fI); nb[fI].push(sI);
    this.nbStart = new Int32Array(N + 1);
    for (let i = 0; i < N; i++) this.nbStart[i + 1] = this.nbStart[i] + nb[i].length;
    this.nbList = new Int32Array(this.nbStart[N]);
    nb.forEach((l, i) => this.nbList.set(l, this.nbStart[i]));
    this._stamp = new Int32Array(N); this._gen = 0; this._queue = new Int32Array(N);

    // ---- shortest distance to the finish from every node, then every sample
    const ahead = net.aheadEdge, behind = net.behindEdge;
    const L_AHEAD = this.edgeA[ahead], L_BEHIND = this.edgeB[behind];
    const Dn = new Float64Array(net.nodeCount).fill(Infinity);
    Dn[L_BEHIND] = 0;
    const done = new Uint8Array(net.nodeCount);
    const nodeAdj = Array.from({ length: net.nodeCount }, () => []);
    for (let e = 0; e < E; e++) { nodeAdj[this.edgeA[e]].push([this.edgeB[e], this.edgeLen[e]]); nodeAdj[this.edgeB[e]].push([this.edgeA[e], this.edgeLen[e]]); }
    for (;;) { // Dijkstra (networks are small)
      let v = -1;
      for (let i = 0; i < net.nodeCount; i++) if (!done[i] && Dn[i] < Infinity && (v < 0 || Dn[i] < Dn[v])) v = i;
      if (v < 0) break;
      done[v] = 1;
      if (v === L_AHEAD) continue; // can't drive backwards over the start line
      for (const [w, l] of nodeAdj[v]) if (w !== L_AHEAD && Dn[v] + l < Dn[w]) Dn[w] = Dn[v] + l;
    }
    this.nodeD = Dn;
    this.D = new Float32Array(N);
    for (let e = 0; e < E; e++) {
      const s = this.edgeStart[e], n = this.edgeCount[e], len = this.edgeLen[e];
      for (let k = 0; k < n; k++) {
        const arc = len * k / Math.max(1, n - 1);
        this.D[s + k] = Math.min(arc + Dn[this.edgeA[e]], len - arc + Dn[this.edgeB[e]]);
      }
    }
    this.startIndex = this.edgeStart[ahead];
    this.finishIndex = this.edgeStart[behind] + this.edgeCount[behind] - 1;
    this.lapLength = this.D[this.startIndex];
    if (!isFinite(this.lapLength)) throw new Error('Track never returns to the start');
    this.length = this.lapLength;

    // ---- "next" sample along the best route, and the driving direction there
    this.next = new Int32Array(N);
    for (let i = 0; i < N; i++) {
      let best = i, bd = this.D[i] - 1e-4;
      for (let k = this.nbStart[i]; k < this.nbStart[i + 1]; k++) {
        const j = this.nbList[k];
        if (this.D[j] < bd) { bd = this.D[j]; best = j; }
      }
      this.next[i] = best;
    }
    this.next[this.finishIndex] = this.startIndex; // look ahead over the line
    this.dx = F(); this.dz = F();
    for (let i = 0; i < N; i++) {
      let j = i, guard = 0;
      do { j = this.next[j]; } while (guard++ < 4 && (this.cx[j] - this.cx[i]) ** 2 + (this.cz[j] - this.cz[i]) ** 2 < 0.25);
      let dx = this.cx[j] - this.cx[i], dz = this.cz[j] - this.cz[i];
      const L = Math.hypot(dx, dz);
      if (L < 1e-3) { dx = this.tx[i]; dz = this.tz[i]; } else { dx /= L; dz /= L; }
      this.dx[i] = dx; this.dz[i] = dz;
    }
    // Is each edge driven in its point order? (for obstacles / lanes / arrows)
    this.edgeForward = new Uint8Array(E);
    for (let e = 0; e < E; e++) {
      const s = this.edgeStart[e], n = this.edgeCount[e];
      this.edgeForward[e] = this.D[s] >= this.D[s + n - 1] ? 1 : 0;
    }

    // ---- bounds + road rasters (one per level) for the distance sensors
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < N; i++) {
      minX = Math.min(minX, this.cx[i]); maxX = Math.max(maxX, this.cx[i]);
      minZ = Math.min(minZ, this.cz[i]); maxZ = Math.max(maxZ, this.cz[i]);
    }
    this.bounds = { minX, maxX, minZ, maxZ };
    const pad = hw + 4;
    this.gx0 = minX - pad; this.gz0 = minZ - pad;
    this.gw = Math.ceil((maxX - minX + 2 * pad) / RASTER); this.gh = Math.ceil((maxZ - minZ + 2 * pad) / RASTER);
    this.grids = [0, 1, 2].map(() => new Uint8Array(this.gw * this.gh));
    for (let e = 0; e < E; e++) {
      const s = this.edgeStart[e], n = this.edgeCount[e];
      for (let k = 0; k < n - 1; k++) this.rasterSegment(s + k, s + k + 1);
    }

    this.islands = net.islands || [];
    this.obstacles = prepareObstacles(this, net.obstacles || []);
  }

  rasterSegment(i, j) {
    const hw = this.halfWidth, grid = this.grids[levelOf((this.ch[i] + this.ch[j]) / 2)];
    const ax = this.cx[i], az = this.cz[i], bx = this.cx[j], bz = this.cz[j];
    const sx = bx - ax, sz = bz - az, L2 = sx * sx + sz * sz || 1e-6;
    const c0 = Math.max(0, Math.floor((Math.min(ax, bx) - hw - this.gx0) / RASTER));
    const c1 = Math.min(this.gw - 1, Math.ceil((Math.max(ax, bx) + hw - this.gx0) / RASTER));
    const r0 = Math.max(0, Math.floor((Math.min(az, bz) - hw - this.gz0) / RASTER));
    const r1 = Math.min(this.gh - 1, Math.ceil((Math.max(az, bz) + hw - this.gz0) / RASTER));
    const hw2 = hw * hw;
    for (let r = r0; r <= r1; r++) {
      const z = this.gz0 + (r + 0.5) * RASTER;
      for (let c = c0; c <= c1; c++) {
        const x = this.gx0 + (c + 0.5) * RASTER;
        let t = ((x - ax) * sx + (z - az) * sz) / L2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const dx = x - ax - sx * t, dz = z - az - sz * t;
        if (dx * dx + dz * dz <= hw2) grid[r * this.gw + c] = 1;
      }
    }
  }

  onRoad(level, x, z) {
    const c = Math.floor((x - this.gx0) / RASTER), r = Math.floor((z - this.gz0) / RASTER);
    if (c < 0 || r < 0 || c >= this.gw || r >= this.gh) return false;
    return this.grids[level][r * this.gw + c] === 1;
  }

  /** Distance along a ray until it leaves the road (on the given level). */
  raycast(ox, oz, dx, dz, level, maxDist) {
    const step = 0.75;
    let t = step;
    for (; t < maxDist; t += step) {
      if (!this.onRoad(level, ox + dx * t, oz + dz * t)) {
        let lo = t - step, hi = t; // refine the edge
        for (let k = 0; k < 3; k++) { const m = (lo + hi) / 2; if (this.onRoad(level, ox + dx * m, oz + dz * m)) lo = m; else hi = m; }
        return lo;
      }
    }
    return maxDist;
  }

  /**
   * Nearest road segment to (x,z), searching the network around sample `hint`.
   * Returns { index, t, dist, lateral, D } (D = distance left to the finish).
   */
  nearest(x, z, hint) {
    const gen = ++this._gen, stamp = this._stamp, q = this._queue;
    let head = 0, tail = 0;
    q[tail++] = hint; stamp[hint] = gen;
    const depth = this._depth || (this._depth = new Int32Array(this.N));
    depth[hint] = 0;
    let best = -1, bt = 0, bd = Infinity, bpx = 0, bpz = 0;
    while (head < tail) {
      const i = q[head++];
      // segment i -> i+1 (same edge)
      const j = i + 1;
      if (j < this.N && this.edgeOf[j] === this.edgeOf[i]) {
        const ax = this.cx[i], az = this.cz[i];
        const sx = this.cx[j] - ax, sz = this.cz[j] - az;
        const L2 = sx * sx + sz * sz || 1e-6;
        let t = ((x - ax) * sx + (z - az) * sz) / L2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const px = ax + sx * t, pz = az + sz * t;
        const d = (x - px) ** 2 + (z - pz) ** 2;
        if (d < bd) { bd = d; best = i; bt = t; bpx = px; bpz = pz; }
      }
      if (depth[i] >= SEARCH_HOPS) continue;
      for (let k = this.nbStart[i]; k < this.nbStart[i + 1]; k++) {
        const n = this.nbList[k];
        if (stamp[n] !== gen) { stamp[n] = gen; depth[n] = depth[i] + 1; q[tail++] = n; }
      }
    }
    if (best < 0) { best = hint; bpx = this.cx[hint]; bpz = this.cz[hint]; bd = (x - bpx) ** 2 + (z - bpz) ** 2; }
    const j = Math.min(this.N - 1, best + 1);
    const D = this.D[best] + (this.D[j] - this.D[best]) * bt;
    // lateral offset relative to the driving direction (+ = driver's right)
    const lateral = (x - bpx) * -this.dz[best] + (z - bpz) * this.dx[best];
    return { index: best, t: bt, dist: Math.sqrt(bd), lateral, D };
  }

  /** Road height at sample i (+t towards i+1). */
  heightAt(i, t = 0) {
    const j = Math.min(this.N - 1, i + 1);
    return this.edgeOf[j] === this.edgeOf[i] ? this.ch[i] + (this.ch[j] - this.ch[i]) * t : this.ch[i];
  }

  /** Sample index `pos` (0..1) of the way along an edge, in its driving direction. */
  pointOnEdge(e, pos) {
    const n = this.edgeCount[e];
    const k = Math.round((this.edgeForward[e] ? pos : 1 - pos) * (n - 1));
    return this.edgeStart[e] + Math.max(0, Math.min(n - 1, k));
  }

  /** Smallest turning radius along the roads (metres) and where it occurs. */
  tightestCorner() {
    let minR = Infinity, at = 0;
    for (let e = 0; e < this.edgeCount.length; e++) {
      const s = this.edgeStart[e], n = this.edgeCount[e];
      for (let k = 2; k < n - 2; k++) {
        const a = s + k - 2, b = s + k + 2;
        let d = Math.atan2(this.tz[b], this.tx[b]) - Math.atan2(this.tz[a], this.tx[a]);
        while (d > Math.PI) d -= 2 * Math.PI;
        while (d < -Math.PI) d += 2 * Math.PI;
        const r = (4 * this.step) / Math.max(Math.abs(d), 1e-6);
        if (r < minR) { minR = r; at = s + k; }
      }
    }
    return { radius: minR, index: at, x: this.cx[at], z: this.cz[at] };
  }
}

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
