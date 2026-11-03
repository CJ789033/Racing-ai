// Grid-based track pieces. A piece covers a rectangle of grid cells (its
// footprint) and contains a little road network: ports (where it joins its
// neighbours, on a cell edge), optional internal nodes (junction points) and
// edges (road centerlines between nodes). Junction pieces (crossing, T, Y,
// roundabout) have more than two ports, so a layout becomes a road network in
// which the AI can choose its route.

export const CELL = 30;          // metres per grid cell
// Grid size is adjustable in the editor (live bindings: importers always see the current size)
export let COLS = 12, ROWS = 9;
export const DEFAULT_GRID = { cols: 12, rows: 9 };
export const GRID_SIZES = [
  { cols: 8, rows: 6, label: 'Small' }, { cols: 10, rows: 8, label: 'Compact' }, { cols: 12, rows: 9, label: 'Medium' },
  { cols: 16, rows: 12, label: 'Large' }, { cols: 20, rows: 15, label: 'Huge' }, { cols: 26, rows: 19, label: 'Giant' },
];
export function setGridSize(cols, rows) { COLS = cols; ROWS = rows; }

/** Move pieces by (dc, dr) cells. */
export function shiftTiles(tiles, dc, dr) {
  return tiles.map(t => ({ ...t, c: t.c + dc, r: t.r + dr, obstacle: t.obstacle ? { ...t.obstacle } : undefined }))
    .map(t => { if (!t.obstacle) delete t.obstacle; return t; });
}

// Edges / headings: 0 = N (-z), 1 = E (+x), 2 = S (+z), 3 = W (-x)
export const DIR = [[0, -1], [1, 0], [0, 1], [-1, 0]];
export const opp = e => (e + 2) % 4;

const LEN = (options, def = 1) => ({ label: 'Length', options, default: def, names: options.map(v => `${v * CELL}m`) });
const TUNNEL = { label: 'Tunnel', options: [0, 1], default: 0, names: ['Off', 'On'] };
export const TUNNEL_DEPTH = 7; // metres below ground

export const PIECES = {
  start:      { label: 'Start',      params: { len: LEN([1, 2, 3]) } },
  straight:   { label: 'Straight',   params: { len: LEN([1, 2, 3, 4]), tunnel: TUNNEL },
                desc: 'Tip: a tunnel 3+ long is deep enough for other roads to cross over its middle' },
  corner:     { label: 'Corner',     params: { size: { label: 'Curve', options: [1, 2, 3], default: 1, names: ['Tight', 'Medium', 'Wide'] }, tunnel: TUNNEL } },
  chicane:    { label: 'Chicane',    params: { len: LEN([1, 2]), amp: { label: 'Wiggle', options: [2, 4, 6], default: 4, names: ['Gentle', 'Normal', 'Sharp'] }, tunnel: TUNNEL } },
  bridge:     { label: 'Bridge',     params: { len: LEN([3, 4, 5], 3), height: { label: 'Height', options: [5, 8, 12], default: 8, names: ['Low', 'Medium', 'High'] } },
                desc: 'Climbs over whatever is under its middle – build roads underneath to make an overpass' },
  cross:      { label: 'Crossing',   params: {}, junction: true, desc: 'Two roads cross – cars go straight over' },
  tee:        { label: 'T junction', params: {}, junction: true, desc: 'Three-way junction – the AI picks a route' },
  yfork:      { label: 'Y fork',     params: {}, junction: true, desc: 'Road splits in two – the AI picks a route' },
  roundabout: { label: 'Roundabout', params: {}, junction: true, desc: 'Four exits around a ring – the AI picks a route' },
};

/** Palette entries (Tunnel is a straight with the tunnel switched on). */
export const PALETTE = {
  road: [
    { type: 'start' }, { type: 'straight' }, { type: 'corner' }, { type: 'chicane' },
    { type: 'bridge' }, { type: 'straight', label: 'Tunnel', extra: { tunnel: 1 } },
  ],
  junctions: [{ type: 'cross' }, { type: 'tee' }, { type: 'yfork' }, { type: 'roundabout' }],
};

const WIDTH = { label: 'Width', options: ['narrow', 'normal', 'wide', 'full'], default: 'normal', names: ['Narrow', 'Normal', 'Wide', 'Full'] };
const STRENGTH = { label: 'Strength', options: [1, 2, 3, 4], default: 1 };
export const OBSTACLE_TYPES = {
  hammer: { label: 'Hammer', icon: '🔨', desc: 'Swings across the road – bad timing is fatal', noLane: true,
            params: { speed: { label: 'Swing speed', options: ['slow', 'normal', 'fast'], default: 'normal', names: ['Slow', 'Normal', 'Fast'] } } },
  spikes: { label: 'Spikes', icon: '🔺', desc: 'Strip of spikes – fatal', params: { width: WIDTH } },
  crates: { label: 'Crates', icon: '📦', desc: 'Solid wall of crates – you stop dead if you hit them', params: {} },
  oil:    { label: 'Oil',    icon: '🛢️', desc: 'Slippery – cars slide and can spin out', params: {} },
  ramp:   { label: 'Ramp',   icon: '⤴️', desc: 'Launches cars into the air – steeper and faster means further. No steering while flying!',
            params: { angle: { label: 'Steepness', options: ['low', 'normal', 'steep'], default: 'normal', names: ['Low', 'Normal', 'Steep'] }, width: WIDTH } },
  boost:  { label: 'Speed pad', icon: '⏩', desc: 'Raises the car\'s speed level by its strength (max +4). Resets every generation.',
            params: { strength: STRENGTH, width: { ...WIDTH, default: 'full' } } },
  slow:   { label: 'Slow pad',  icon: '🐢', desc: 'Lowers the car\'s speed level by its strength (min −4). Resets every generation.',
            params: { strength: STRENGTH, width: { ...WIDTH, default: 'full' } } },
};
export const OBSTACLE_ORDER = ['hammer', 'spikes', 'crates', 'oil', 'ramp', 'boost', 'slow'];
export const LANES = ['left', 'center', 'right'];

export function paramValue(tile, name) {
  const def = PIECES[tile.type].params[name];
  if (!def) return undefined;
  return def.options.includes(tile[name]) ? tile[name] : def.default;
}
export function obstacleParam(o, name) {
  const def = OBSTACLE_TYPES[o.type] && OBSTACLE_TYPES[o.type].params[name];
  if (!def) return undefined;
  return def.options.includes(o[name]) ? o[name] : def.default;
}

// ---------------------------------------------------------------------------
// Piece shapes at rotation 0. Coordinates are local metres (x right, z down,
// origin = footprint top-left); h = road height. Each edge has f(u) for u in [0,1].

const line = (a, b, h0 = 0, h1 = h0) => u => ({ x: a.x + (b.x - a.x) * u, z: a.z + (b.z - a.z) * u, h: h0 + (h1 - h0) * u });
const arc = (cx, cz, R, a0, a1) => u => { const a = a0 + (a1 - a0) * u; return { x: cx + Math.cos(a) * R, z: cz + Math.sin(a) * R, h: 0 }; };
const RING_R = 22;

function baseShape(tile) {
  const C = CELL, H2 = C / 2;
  switch (tile.type) {
    case 'corner': {
      const n = paramValue(tile, 'size'), R = (n - 0.5) * C;
      return {
        w: n, h: n, ports: [{ x: 0, y: n - 1, e: 3 }, { x: n - 1, y: 0, e: 0 }], nodes: 2,
        edges: [{ a: 0, b: 1, f: arc(0, 0, R, Math.PI / 2, 0), len: Math.PI / 2 * R, tunnel: !!paramValue(tile, 'tunnel') }],
      };
    }
    case 'bridge': {
      const n = paramValue(tile, 'len'), L = n * C, H = paramValue(tile, 'height');
      // smooth climb over the first cell, level in the middle, smooth descent over the last
      const height = x => x < C ? H * (1 - Math.cos(Math.PI * x / C)) / 2 : x > L - C ? H * (1 - Math.cos(Math.PI * (L - x) / C)) / 2 : H;
      const cells = [];
      for (let i = 0; i < n; i++) cells.push({ x: i, y: 0, layer: i > 0 && i < n - 1 ? 1 : 0 });
      return {
        w: n, h: 1, ports: [{ x: 0, y: 0, e: 3 }, { x: n - 1, y: 0, e: 1 }], nodes: 2, cells,
        edges: [{ a: 0, b: 1, f: u => ({ x: u * L, z: H2, h: height(u * L) }), len: L }],
      };
    }
    case 'cross':
      return {
        w: 1, h: 1, nodes: 4, junction: true,
        ports: [{ x: 0, y: 0, e: 3 }, { x: 0, y: 0, e: 1 }, { x: 0, y: 0, e: 0 }, { x: 0, y: 0, e: 2 }],
        edges: [
          { a: 0, b: 1, f: line({ x: 0, z: H2 }, { x: C, z: H2 }), len: C },
          { a: 2, b: 3, f: line({ x: H2, z: 0 }, { x: H2, z: C }), len: C },
        ],
      };
    case 'tee': {
      const m = { x: H2, z: H2 };
      return {
        w: 1, h: 1, nodes: 4, junction: true,
        ports: [{ x: 0, y: 0, e: 3 }, { x: 0, y: 0, e: 1 }, { x: 0, y: 0, e: 2 }],
        edges: [
          { a: 0, b: 3, f: line({ x: 0, z: H2 }, m), len: H2 },
          { a: 3, b: 1, f: line(m, { x: C, z: H2 }), len: H2 },
          { a: 3, b: 2, f: line(m, { x: H2, z: C }), len: H2 },
        ],
      };
    }
    case 'yfork': {
      // stem enters from the bottom-left cell; one branch goes straight on,
      // the other swings across into the right-hand column
      const F = { x: H2, z: 2 * C - 10 };
      const L = F.z;
      return {
        w: 2, h: 2, nodes: 4, junction: true,
        ports: [{ x: 0, y: 1, e: 2 }, { x: 0, y: 0, e: 0 }, { x: 1, y: 0, e: 0 }],
        edges: [
          { a: 0, b: 3, f: line({ x: H2, z: 2 * C }, F), len: 10 },
          { a: 3, b: 1, f: line(F, { x: H2, z: 0 }), len: L },
          { a: 3, b: 2, f: u => ({ x: H2 + C * (1 - Math.cos(Math.PI * u)) / 2, z: F.z - L * u, h: 0 }), len: L * 1.15 },
        ],
      };
    }
    case 'roundabout': {
      const c = 1.5 * C, R = RING_R, P = Math.PI;
      const ports = [{ x: 1, y: 0, e: 0 }, { x: 2, y: 1, e: 1 }, { x: 1, y: 2, e: 2 }, { x: 0, y: 1, e: 3 }];
      const portPt = [{ x: c, z: 0 }, { x: 3 * C, z: c }, { x: c, z: 3 * C }, { x: 0, z: c }];
      const ang = [-P / 2, 0, P / 2, P]; // where each arm meets the ring
      const edges = [];
      for (let i = 0; i < 4; i++) {
        const j = { x: c + Math.cos(ang[i]) * R, z: c + Math.sin(ang[i]) * R };
        edges.push({ a: i, b: 4 + i, f: line(portPt[i], j), len: c - R });
        edges.push({ a: 4 + i, b: 4 + (i + 1) % 4, f: arc(c, c, R, ang[i], ang[i] + P / 2), len: R * P / 2 });
      }
      return { w: 3, h: 3, nodes: 8, junction: true, ports, edges, island: { x: c, z: c, r: R } };
    }
    default: { // start, straight, chicane
      const n = paramValue(tile, 'len'), L = n * C;
      const amp = tile.type === 'chicane' ? paramValue(tile, 'amp') : 0;
      // a long straight tunnel is deep enough in its middle cells for roads to cross over it
      const deep = tile.type === 'straight' && paramValue(tile, 'tunnel') && n >= 3;
      const cells = [];
      for (let i = 0; i < n; i++) cells.push({ x: i, y: 0, layer: deep && i > 0 && i < n - 1 ? -1 : 0 });
      return {
        w: n, h: 1, ports: [{ x: 0, y: 0, e: 3 }, { x: n - 1, y: 0, e: 1 }], nodes: 2, cells,
        edges: [{
          a: 0, b: 1, len: L * (amp ? 1.05 : 1), tunnel: !!paramValue(tile, 'tunnel'),
          // chicane: sideways jink and back, with zero slope at both ends
          f: u => ({ x: u * L, z: H2 - amp * (1 - Math.cos(2 * Math.PI * u)) / 2, h: 0 }),
        }],
      };
    }
  }
}

const geoCache = new WeakMap();

/**
 * Geometry of a placed piece in world metres: footprint, ports, edges (with
 * sampled points) and the layer of each footprint cell (1 = bridge deck,
 * -1 = deep tunnel, 0 = ground).
 */
export function pieceGeometry(tile) {
  const sig = JSON.stringify([tile.type, tile.rot, tile.c, tile.r, tile.len, tile.size, tile.amp, tile.height, tile.tunnel, COLS, ROWS]);
  const cached = geoCache.get(tile);
  if (cached && cached.sig === sig) return cached.geo;

  const base = baseShape(tile);
  let w = base.w, h = base.h;
  let ports = base.ports.map(p => ({ ...p }));
  let cells = (base.cells || (() => { const a = []; for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) a.push({ x, y, layer: 0 }); return a; })()).map(c => ({ ...c }));
  let tf = p => p;
  const rot = ((tile.rot % 4) + 4) % 4;
  for (let k = 0; k < rot; k++) {
    // rotate 90° clockwise inside a w x h box -> h x w box
    const hh = h, prev = tf, Hm = hh * CELL;
    ports = ports.map(p => ({ x: hh - 1 - p.y, y: p.x, e: (p.e + 1) % 4 }));
    cells = cells.map(c => ({ x: hh - 1 - c.y, y: c.x, layer: c.layer }));
    tf = p => { const q = prev(p); return { x: Hm - q.z, z: q.x, h: q.h }; };
    [w, h] = [h, w];
  }
  const ox = (tile.c - COLS / 2) * CELL, oz = (tile.r - ROWS / 2) * CELL;
  const toWorld = p => { const q = tf(p); return { x: ox + q.x, z: oz + q.z, h: q.h || 0 }; };
  const edges = base.edges.map(e => {
    const steps = Math.max(4, Math.ceil(e.len / 2));
    const points = [];
    for (let i = 0; i <= steps; i++) points.push(toWorld(e.f(i / steps)));
    return { a: e.a, b: e.b, points, len: e.len, tunnel: !!e.tunnel, junction: !!base.junction };
  });
  const geo = {
    w, h, nodes: base.nodes, junction: !!base.junction,
    ports: ports.map(p => ({ c: tile.c + p.x, r: tile.r + p.y, e: p.e })),
    cells: cells.map(c => ({ c: tile.c + c.x, r: tile.r + c.y, layer: c.layer, over: c.layer === 1 })),
    edges,
    island: base.island ? { ...toWorld(base.island), r: base.island.r } : null,
    length: base.edges.reduce((s, e) => s + e.len, 0),
  };
  geoCache.set(tile, { sig, geo });
  return geo;
}

export function footprint(tile) { return pieceGeometry(tile).cells; }

export function fitsGrid(tile) {
  const g = pieceGeometry(tile);
  return tile.c >= 0 && tile.r >= 0 && tile.c + g.w <= COLS && tile.r + g.h <= ROWS;
}

const key = (c, r) => c + ',' + r;

/** Do two pieces clash? They may share a cell only at different layers (bridge deck / ground / deep tunnel). */
export function clashes(a, b) {
  const cells = new Map(footprint(a).map(f => [key(f.c, f.r), f.layer]));
  return footprint(b).some(f => cells.has(key(f.c, f.r)) && cells.get(key(f.c, f.r)) === f.layer);
}

/** Can this piece carry an obstacle? (single plain road, not the start) */
export function canHoldObstacle(tile) {
  return tile.type !== 'start' && !PIECES[tile.type].junction;
}

// ---------------------------------------------------------------------------
/**
 * Join the pieces into a road network, starting from the Start piece.
 * Returns { ok, net, error, order, unused } where `net` can be handed to Track.
 */
export function traceLayout(tiles) {
  const starts = tiles.filter(t => t.type === 'start');
  if (!starts.length) return { ok: false, order: [], error: { msg: 'Place a Start piece' } };
  if (starts.length > 1) return { ok: false, order: [], error: { c: starts[1].c, r: starts[1].r, msg: 'Only one Start piece allowed' } };

  const geos = tiles.map(pieceGeometry);
  const base = []; let n = 0;
  for (const g of geos) { base.push(n); n += g.nodes; }
  const parent = Array.from({ length: n + 2 }, (_, i) => i);
  const find = i => { while (parent[i] !== i) i = parent[i] = parent[parent[i]]; return i; };

  const portMap = new Map(); // "c,r,e" -> [tileIndex, portIndex]
  geos.forEach((g, ti) => g.ports.forEach((p, pi) => portMap.set(`${p.c},${p.r},${p.e}`, [ti, pi])));

  // flood from the start piece through matching ports
  const si = tiles.indexOf(starts[0]);
  const inNet = new Set([si]), queue = [si];
  let error = null;
  while (queue.length) {
    const ti = queue.shift();
    geos[ti].ports.forEach((p, pi) => {
      const nc = p.c + DIR[p.e][0], nr = p.r + DIR[p.e][1];
      const m = portMap.get(`${nc},${nr},${opp(p.e)}`);
      if (!m) {
        if (!error) {
          const blocked = tiles.some((t, k) => k !== ti && footprint(t).some(f => f.c === nc && f.r === nr && f.layer === 0));
          error = { c: nc, r: nr, msg: blocked ? 'This piece doesn\'t connect – rotate it or change its size' : 'The track has a gap here' };
        }
        return;
      }
      parent[find(base[ti] + pi)] = find(base[m[0]] + m[1]);
      if (!inNet.has(m[0])) { inNet.add(m[0]); queue.push(m[0]); }
    });
  }
  const order = [...inNet].map(i => tiles[i]);
  if (error) return { ok: false, order, error };

  // Does the road continue as a tunnel beyond this end of the piece? (then stay deep)
  const tunnelAt = (ti, localNode) => {
    const p = geos[ti].ports[localNode];
    if (!p) return false;
    const m = portMap.get(`${p.c + DIR[p.e][0]},${p.r + DIR[p.e][1]},${opp(p.e)}`);
    return !!m && geos[m[0]].edges.some(e => e.tunnel);
  };

  // edges; the Start piece's road is cut at the start line into two halves
  const L_AHEAD = n, L_BEHIND = n + 1;
  const edges = [];
  const tileEdge = new Map(); // tile -> index of its (single) edge
  let aheadEdge = -1, behindEdge = -1;
  for (const ti of inNet) {
    const g = geos[ti], t = tiles[ti];
    g.edges.forEach(e => {
      const a = find(base[ti] + e.a), b = find(base[ti] + e.b);
      if (t.type === 'start') {
        const mid = Math.floor(e.points.length / 2);
        behindEdge = edges.length;
        edges.push({ a, b: L_BEHIND, points: e.points.slice(0, mid + 1), tunnel: false, junction: false });
        aheadEdge = edges.length;
        edges.push({ a: L_AHEAD, b, points: e.points.slice(mid), tunnel: false, junction: false });
        return;
      }
      if (g.edges.length === 1) tileEdge.set(t, edges.length);
      edges.push({ a, b, points: e.tunnel ? sinkTunnel(e.points, tunnelAt(ti, e.a), tunnelAt(ti, e.b)) : e.points, tunnel: e.tunnel, junction: e.junction });
    });
  }
  // compact node ids
  const ids = new Map();
  const id = v => { if (!ids.has(v)) ids.set(v, ids.size); return ids.get(v); };
  for (const e of edges) { e.a = id(e.a); e.b = id(e.b); }

  // Can we get from just past the start line back round to it?
  const adj = Array.from({ length: ids.size }, () => []);
  edges.forEach((e, i) => { adj[e.a].push([e.b, i]); adj[e.b].push([e.a, i]); });
  const target = id(L_BEHIND), from = edges[aheadEdge].b, blocked = id(L_AHEAD);
  const seen = new Set([from]), q = [from];
  while (q.length) { const v = q.pop(); for (const [w] of adj[v]) if (w !== blocked && !seen.has(w)) { seen.add(w); q.push(w); } }
  if (!seen.has(target)) return { ok: false, order, error: { c: starts[0].c, r: starts[0].r, msg: 'Cars can\'t get back round to the start line' } };

  const obstacles = [];
  for (const t of order) {
    const o = t.obstacle;
    if (!o || !OBSTACLE_TYPES[o.type] || !tileEdge.has(t)) continue;
    obstacles.push({ ...o, edge: tileEdge.get(t), pos: clamp(o.pos ?? 0.5, 0.05, 0.95), lane: LANES.includes(o.lane) ? o.lane : 'center' });
  }
  const islands = order.map(t => pieceGeometry(t).island).filter(Boolean);
  return {
    ok: true, order, unused: tiles.length - order.length, tileEdge,
    net: { edges, nodeCount: ids.size, aheadEdge, behindEdge, obstacles, islands },
  };
}

function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

/** Lower a tunnel road underground, sloping down/up at ends that open to the surface. */
function sinkTunnel(points, deepA, deepB) {
  const cum = [0];
  for (let i = 1; i < points.length; i++) cum.push(cum[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z));
  const L = cum[cum.length - 1], R = Math.min(CELL, L / 2);
  const ease = d => (d >= R ? 1 : (1 - Math.cos(Math.PI * d / R)) / 2);
  return points.map((p, i) => {
    const fa = deepA ? 1 : ease(cum[i]), fb = deepB ? 1 : ease(L - cum[i]);
    return { ...p, h: -TUNNEL_DEPTH * Math.min(fa, fb) };
  });
}

// ---------------------------------------------------------------------------
// "Turtle" builder: describe a loop as a sequence of two-ended pieces from a
// starting cell and heading, and get placed tiles back. Used for presets.
//   ops: [type, params?, turn?('L'|'R'), obstacle?]
export function buildFromTurtle(startCell, heading, ops) {
  const tiles = [];
  let cell = { c: startCell[0], r: startCell[1] }, h = heading;
  for (const [type, params = {}, turn, obstacle] of ops) {
    let placed = null;
    for (let rot = 0; rot < 4 && !placed; rot++) {
      for (const dirFwd of [true, false]) {
        const t = { type, rot, c: 0, r: 0, ...params };
        const g = pieceGeometry(t);
        const [inP, outP] = dirFwd ? g.ports : [g.ports[1], g.ports[0]];
        if (inP.e !== opp(h)) continue;
        if (type === 'corner' && outP.e !== (turn === 'R' ? (h + 1) % 4 : (h + 3) % 4)) continue;
        if (type !== 'corner' && outP.e !== h) continue;
        if (type === 'start' && !dirFwd) continue;
        t.c = cell.c - inP.c; t.r = cell.r - inP.r;
        if (obstacle) t.obstacle = { ...obstacle };
        placed = { t, outP: { c: outP.c + t.c, r: outP.r + t.r, e: outP.e } };
        break;
      }
    }
    if (!placed) throw new Error('turtle: cannot place ' + type);
    tiles.push(placed.t);
    h = placed.outP.e;
    cell = { c: placed.outP.c + DIR[h][0], r: placed.outP.r + DIR[h][1] };
  }
  return tiles;
}

const E = 1;
export const TILE_PRESETS = {
  'Rectangle': {
    width: 12,
    tiles: () => buildFromTurtle([3, 7], E, [
      ['start', { len: 2 }], ['straight', { len: 2 }], ['corner', { size: 1 }, 'L'],
      ['straight', { len: 4 }], ['straight', { len: 1 }], ['corner', { size: 1 }, 'L'],
      ['straight', { len: 4 }], ['straight', { len: 2 }], ['corner', { size: 1 }, 'L'],
      ['straight', { len: 4 }], ['straight', { len: 1 }], ['corner', { size: 1 }, 'L'],
      ['straight', { len: 2 }],
    ]),
  },
  'Grand Prix': {
    width: 13,
    tiles: () => buildFromTurtle([4, 8], E, [
      ['start', { len: 3 }], ['corner', { size: 3 }, 'L'], ['straight', { len: 1 }],
      ['corner', { size: 2 }, 'L'], ['chicane', { len: 2, amp: 4 }], ['corner', { size: 1 }, 'R'],
      ['corner', { size: 1 }, 'L'], ['straight', { len: 1 }], ['corner', { size: 2 }, 'L'],
      ['straight', { len: 3 }], ['corner', { size: 2 }, 'L'],
    ]),
  },
  'Obstacle course': {
    width: 13,
    tiles: () => buildFromTurtle([4, 8], E, [
      ['start', { len: 2 }], ['straight', { len: 2 }, null, { type: 'spikes', lane: 'left', pos: 0.5 }],
      ['straight', { len: 1 }, null, { type: 'hammer', lane: 'center', pos: 0.5 }], ['corner', { size: 2 }, 'L'],
      ['straight', { len: 3 }, null, { type: 'oil', lane: 'center', pos: 0.4 }], ['corner', { size: 2 }, 'L'],
      ['straight', { len: 3 }, null, { type: 'crates', lane: 'right', pos: 0.75 }],
      ['straight', { len: 2 }, null, { type: 'spikes', lane: 'right', pos: 0.5 }], ['corner', { size: 2 }, 'L'],
      ['straight', { len: 3 }], ['corner', { size: 2 }, 'L'],
    ]),
  },
  'Ramp jump': {
    width: 13,
    tiles: () => buildFromTurtle([4, 8], E, [
      ['start', { len: 2 }], ['straight', { len: 2 }, null, { type: 'ramp', lane: 'center', pos: 0.75 }],
      ['straight', { len: 1 }, null, { type: 'spikes', lane: 'center', pos: 0.5 }], ['corner', { size: 2 }, 'L'],
      ['straight', { len: 3 }], ['corner', { size: 2 }, 'L'],
      ['straight', { len: 3 }, null, { type: 'ramp', lane: 'right', pos: 0.5 }],
      ['straight', { len: 2 }], ['corner', { size: 2 }, 'L'],
      ['straight', { len: 3 }], ['corner', { size: 2 }, 'L'],
    ]),
  },
  'Figure 8 bridge': {
    width: 14,
    tiles: () => buildFromTurtle([3, 4], E, [
      ['start', { len: 1 }], ['straight', { len: 1 }], ['bridge', { len: 3, height: 8 }],
      ['corner', { size: 1 }, 'R'], ['straight', { len: 1 }], ['corner', { size: 1 }, 'R'],
      ['straight', { len: 1 }], ['corner', { size: 1 }, 'R'], ['straight', { len: 1 }],
      ['straight', { len: 1 }], // passes under the bridge
      ['straight', { len: 1 }], ['corner', { size: 1 }, 'L'], ['straight', { len: 3, tunnel: 1 }],
      ['corner', { size: 1 }, 'L'], ['straight', { len: 1 }], ['corner', { size: 1 }, 'L'],
    ]),
  },
  'Figure 8 tunnel': {
    width: 14,
    tiles: () => buildFromTurtle([3, 4], E, [
      ['start', { len: 1 }], ['straight', { len: 1 }], ['straight', { len: 3, tunnel: 1 }],
      ['corner', { size: 1 }, 'R'], ['straight', { len: 1 }], ['corner', { size: 1 }, 'R'],
      ['straight', { len: 1 }], ['corner', { size: 1 }, 'R'], ['straight', { len: 1 }],
      ['straight', { len: 1 }], // crosses over the tunnel
      ['straight', { len: 1 }], ['corner', { size: 1 }, 'L'], ['straight', { len: 3 }],
      ['corner', { size: 1 }, 'L'], ['straight', { len: 1 }], ['corner', { size: 1 }, 'L'],
    ]),
  },
  'T shortcut': {
    width: 12,
    tiles: () => [
      { type: 'tee', rot: 2, c: 5, r: 7 }, { type: 'tee', rot: 0, c: 5, r: 2 },
      { type: 'straight', rot: 1, c: 5, r: 3, len: 4, obstacle: { type: 'hammer', pos: 0.5, speed: 'normal' } },
      ...buildFromTurtle([6, 7], E, [['straight', { len: 2 }], ['corner', { size: 1 }, 'L'], ['straight', { len: 4 }], ['corner', { size: 1 }, 'L'], ['straight', { len: 2 }]]),
      ...buildFromTurtle([4, 2], 3, [['straight', { len: 1 }], ['corner', { size: 1 }, 'L'], ['straight', { len: 4 }], ['corner', { size: 1 }, 'L'], ['start', { len: 1 }]]),
    ],
  },
  'Y split': {
    width: 12,
    tiles: () => [
      { type: 'yfork', rot: 1, c: 4, r: 6 }, { type: 'yfork', rot: 3, c: 9, r: 6 },
      { type: 'straight', rot: 0, c: 6, r: 6, len: 3, obstacle: { type: 'hammer', pos: 0.5, speed: 'fast' } },
      { type: 'straight', rot: 0, c: 6, r: 7, len: 3, obstacle: { type: 'boost', pos: 0.3, strength: 2, width: 'full' } },
      ...buildFromTurtle([11, 7], E, [
        ['corner', { size: 1 }, 'L'], ['straight', { len: 4 }], ['corner', { size: 1 }, 'L'],
        ['straight', { len: 4 }], ['straight', { len: 4 }], ['straight', { len: 1 }], ['corner', { size: 1 }, 'L'],
        ['straight', { len: 3 }], ['corner', { size: 1 }, 'L'], ['start', { len: 1 }], ['straight', { len: 1 }],
      ]),
    ],
  },
  'Roundabout': {
    width: 12,
    tiles: () => [
      { type: 'roundabout', rot: 0, c: 4, r: 3 },
      ...buildFromTurtle([7, 4], E, [['straight', { len: 2 }], ['corner', { size: 1 }, 'L'], ['straight', { len: 1 }], ['corner', { size: 1 }, 'L'], ['straight', { len: 3 }], ['corner', { size: 1 }, 'L']]),
      ...buildFromTurtle([5, 6], 2, [['straight', { len: 1 }], ['corner', { size: 1 }, 'R'], ['straight', { len: 2 }], ['corner', { size: 1 }, 'R'], ['straight', { len: 2 }], ['corner', { size: 1 }, 'R'], ['start', { len: 1 }]]),
    ],
  },
};
