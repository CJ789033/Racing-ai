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
  start:      { label: 'Start',      params: { len: LEN([1, 2, 3]), laps: { label: 'Laps to race', options: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], default: 1 } },
                desc: 'Start / finish line. Choose how many laps the cars must complete.' },
  straight:   { label: 'Straight',   params: { len: LEN([1, 2, 3, 4]), tunnel: TUNNEL },
                desc: 'Tip: other roads can cross over a tunnel – just not right at its entrance' },
  corner:     { label: 'Corner',     params: { size: { label: 'Curve', options: [1, 2, 3], default: 1, names: ['Tight', 'Medium', 'Wide'] }, tunnel: TUNNEL } },
  chicane:    { label: 'Chicane',    params: { len: LEN([1, 2]), amp: { label: 'Wiggle', options: [2, 4, 6], default: 4, names: ['Gentle', 'Normal', 'Sharp'] }, tunnel: TUNNEL } },
  bridge:     { label: 'Bridge',     params: { len: LEN([3, 4, 5], 3), height: { label: 'Height', options: [5, 8, 12], default: 8, names: ['Low', 'Medium', 'High'] } },
                desc: 'Climbs over whatever is under its middle – build roads underneath to make an overpass' },
  deadend:    { label: 'Dead end',   params: {}, desc: 'The road just stops at a barrier – a trap for cars that take the wrong turn' },
  cross:      { label: 'Crossing',   params: {}, junction: true, desc: 'Two roads cross – cars go straight over' },
  tee:        { label: 'T junction', params: {}, junction: true, desc: 'Three-way junction – the AI picks a route' },
  yfork:      { label: 'Y fork',     params: { flip: { label: 'Branch goes', options: [0, 1], default: 0, names: ['Right', 'Left'] } }, junction: true, desc: 'Road splits in two – the AI picks a route' },
  roundabout: { label: 'Roundabout', params: {}, junction: true, desc: 'Four exits around a ring – the AI picks a route' },
  bigRoundabout: { label: 'Big roundabout', params: {}, junction: true, desc: 'A wide, fast ring with four exits (5×5 cells)' },
  crossroads: { label: 'Crossroads', params: {}, junction: true, desc: 'Four-way junction – cars can go straight or turn' },
  trident:    { label: '3-way fork', params: {}, junction: true, desc: 'The road splits three ways – left, straight on and right' },
};

/** Palette entries (Tunnel is a straight with the tunnel switched on). */
export const PALETTE = {
  road: [
    { type: 'start' }, { type: 'straight' }, { type: 'corner' }, { type: 'chicane' },
    { type: 'bridge' }, { type: 'straight', label: 'Tunnel', extra: { tunnel: 1 } }, { type: 'deadend' },
  ],
  junctions: [{ type: 'cross' }, { type: 'crossroads' }, { type: 'tee' }, { type: 'yfork' }, { type: 'trident' }, { type: 'roundabout' }, { type: 'bigRoundabout' }],
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
  spinner: { label: 'Spinner', icon: '🌀', desc: 'A bar spinning across the road – fatal. Time it or squeeze past the ends.', noLane: true,
             params: { speed: { label: 'Spin speed', options: ['slow', 'normal', 'fast'], default: 'normal', names: ['Slow', 'Normal', 'Fast'] } } },
  laser:  { label: 'Laser gate', icon: '⚡', desc: 'A laser across the road that switches on and off – fatal while on.', noLane: true,
            params: { speed: { label: 'Switching', options: ['slow', 'normal', 'fast'], default: 'normal', names: ['Slow', 'Normal', 'Fast'] } } },
  mud:    { label: 'Mud', icon: '🟫', desc: 'Thick mud – cars slow right down while driving through it.', params: { width: WIDTH } },
  bumper: { label: 'Bumper', icon: '🔴', desc: 'A springy post that bounces cars sideways (not fatal).', params: {} },
};
export const OBSTACLE_ORDER = ['hammer', 'spikes', 'crates', 'oil', 'ramp', 'boost', 'slow', 'spinner', 'laser', 'mud', 'bumper'];
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
      const under = !!paramValue(tile, 'tunnel'), cells = [];
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) cells.push({ x, y, layer: under ? -1 : 0 });
      return {
        w: n, h: n, ports: [{ x: 0, y: n - 1, e: 3 }, { x: n - 1, y: 0, e: 0 }], nodes: 2, cells,
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
    case 'deadend':
      // one way in; the road stops at a barrier near the far edge of the cell
      return {
        w: 1, h: 1, nodes: 2, ports: [{ x: 0, y: 0, e: 3 }],
        edges: [{ a: 0, b: 1, f: line({ x: 0, z: H2 }, { x: C - 5, z: H2 }), len: C - 5 }],
        barrier: { x: C - 4, z: H2, ax: 1, az: 0 },
      };
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
        w: 2, h: 2, nodes: 4, junction: true, flip: !!paramValue(tile, 'flip'),
        ports: [{ x: 0, y: 1, e: 2 }, { x: 0, y: 0, e: 0 }, { x: 1, y: 0, e: 0 }],
        edges: [
          { a: 0, b: 3, f: line({ x: H2, z: 2 * C }, F), len: 10 },
          { a: 3, b: 1, f: line(F, { x: H2, z: 0 }), len: L },
          { a: 3, b: 2, f: u => ({ x: H2 + C * (1 - Math.cos(Math.PI * u)) / 2, z: F.z - L * u, h: 0 }), len: L * 1.15 },
        ],
      };
    }
    case 'crossroads': {
      const m = { x: H2, z: H2 };
      return {
        w: 1, h: 1, nodes: 5, junction: true,
        ports: [{ x: 0, y: 0, e: 3 }, { x: 0, y: 0, e: 1 }, { x: 0, y: 0, e: 0 }, { x: 0, y: 0, e: 2 }],
        edges: [
          { a: 0, b: 4, f: line({ x: 0, z: H2 }, m), len: H2 },
          { a: 4, b: 1, f: line(m, { x: C, z: H2 }), len: H2 },
          { a: 2, b: 4, f: line({ x: H2, z: 0 }, m), len: H2 },
          { a: 4, b: 3, f: line(m, { x: H2, z: C }), len: H2 },
        ],
      };
    }
    case 'trident': {
      // stem enters the middle bottom cell; branches leave through the top of all three columns
      const F = { x: 1.5 * C, z: 2 * C - 10 }, L = F.z;
      const sway = dx => u => ({ x: F.x + dx * (1 - Math.cos(Math.PI * u)) / 2, z: F.z - L * u, h: 0 });
      return {
        w: 3, h: 2, nodes: 5, junction: true,
        ports: [{ x: 1, y: 1, e: 2 }, { x: 0, y: 0, e: 0 }, { x: 1, y: 0, e: 0 }, { x: 2, y: 0, e: 0 }],
        edges: [
          { a: 0, b: 4, f: line({ x: F.x, z: 2 * C }, F), len: 10 },
          { a: 4, b: 1, f: sway(-C), len: L * 1.15 },
          { a: 4, b: 2, f: line(F, { x: F.x, z: 0 }), len: L },
          { a: 4, b: 3, f: sway(C), len: L * 1.15 },
        ],
      };
    }
    case 'bigRoundabout':
    case 'roundabout': {
      const big = tile.type === 'bigRoundabout', n = big ? 5 : 3, mid = (n - 1) / 2;
      const c = n / 2 * C, R = big ? 48 : RING_R, P = Math.PI;
      const ports = [{ x: mid, y: 0, e: 0 }, { x: n - 1, y: mid, e: 1 }, { x: mid, y: n - 1, e: 2 }, { x: 0, y: mid, e: 3 }];
      const portPt = [{ x: c, z: 0 }, { x: n * C, z: c }, { x: c, z: n * C }, { x: 0, z: c }];
      const ang = [-P / 2, 0, P / 2, P]; // where each arm meets the ring
      const edges = [];
      for (let i = 0; i < 4; i++) {
        const j = { x: c + Math.cos(ang[i]) * R, z: c + Math.sin(ang[i]) * R };
        edges.push({ a: i, b: 4 + i, f: line(portPt[i], j), len: c - R });
        edges.push({ a: 4 + i, b: 4 + (i + 1) % 4, f: arc(c, c, R, ang[i], ang[i] + P / 2), len: R * P / 2 });
      }
      return { w: n, h: n, nodes: 8, junction: true, ports, edges, island: { x: c, z: c, r: R } };
    }
    default: { // start, straight, chicane
      const n = paramValue(tile, 'len'), L = n * C;
      const amp = tile.type === 'chicane' ? paramValue(tile, 'amp') : 0;
      // tunnels are underground: other roads may cross over any of their cells
      const under = !!paramValue(tile, 'tunnel');
      const cells = [];
      for (let i = 0; i < n; i++) cells.push({ x: i, y: 0, layer: under ? -1 : 0 });
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
  const sig = JSON.stringify([tile.type, tile.rot, tile.c, tile.r, tile.len, tile.size, tile.amp, tile.height, tile.tunnel, tile.flip, COLS, ROWS]);
  const cached = geoCache.get(tile);
  if (cached && cached.sig === sig) return cached.geo;

  const base = baseShape(tile);
  let w = base.w, h = base.h;
  let ports = base.ports.map(p => ({ ...p }));
  let cells = (base.cells || (() => { const a = []; for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) a.push({ x, y, layer: 0 }); return a; })()).map(c => ({ ...c }));
  let tf = p => p;
  if (base.flip) {
    // mirrored piece (left/right swapped) before rotating
    const Wm = w * CELL;
    ports = ports.map(p => ({ x: w - 1 - p.x, y: p.y, e: p.e === 1 ? 3 : p.e === 3 ? 1 : p.e }));
    cells = cells.map(c => ({ ...c, x: w - 1 - c.x }));
    tf = p => ({ x: Wm - p.x, z: p.z, h: p.h });
  }
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
    // dense sampling so a curve's end segments point along the true tangent (no wedge gaps at joins)
    const steps = Math.max(4, Math.ceil(e.len / 0.5));
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
    barrier: base.barrier ? (() => {
      const p = toWorld(base.barrier), q = toWorld({ x: base.barrier.x + base.barrier.ax, z: base.barrier.z + base.barrier.az });
      return { x: p.x, z: p.z, dx: q.x - p.x, dz: q.z - p.z }; // position + direction the road was heading
    })() : null,
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
      edges.push({ a, b, points: e.points, tunnel: e.tunnel, junction: e.junction });
    });
  }
  // compact node ids
  const ids = new Map();
  const id = v => { if (!ids.has(v)) ids.set(v, ids.size); return ids.get(v); };
  for (const e of edges) { e.a = id(e.a); e.b = id(e.b); }
  // where does a road cross over a tunnel? (a surface piece sharing a cell with a tunnel piece)
  const crossings = [];
  for (const t of order) for (const f of footprint(t)) {
    if (f.layer !== -1) continue;
    if (order.some(o => o !== t && footprint(o).some(g => g.c === f.c && g.r === f.r && g.layer >= 0))) {
      const x0 = (f.c - COLS / 2) * CELL, z0 = (f.r - ROWS / 2) * CELL;
      crossings.push({ x0: x0 - 3, x1: x0 + CELL + 3, z0: z0 - 3, z1: z0 + CELL + 3, c: f.c, r: f.r });
    }
  }
  const tErr = shapeTunnels(edges, crossings);
  if (tErr) return { ok: false, order, error: tErr };

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
  const barriers = order.map(t => pieceGeometry(t).barrier).filter(Boolean);
  return {
    ok: true, order, unused: tiles.length - order.length, tileEdge,
    net: { edges, nodeCount: ids.size, aheadEdge, behindEdge, obstacles, islands, barriers, laps: paramValue(starts[0], 'laps') },
  };
}

function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

const MIN_DEEP_TUNNEL = 89; // shorter tunnels stay at ground level under a hill

/**
 * Shape every tunnel: joined tunnel pieces form one run. A long run dips
 * underground (sloping down/up at its open ends); a short run (e.g. a single
 * tunnel corner) can't dig down that fast, so it stays at ground level and is
 * built as a tunnel through a hill instead.
 */
function shapeTunnels(edges, crossings = []) {
  let error = null;
  const underRoad = p => crossings.find(q => p.x > q.x0 && p.x < q.x1 && p.z > q.z0 && p.z < q.z1);
  const byNode = new Map();
  edges.forEach((e, i) => { for (const n of [e.a, e.b]) { if (!byNode.has(n)) byNode.set(n, []); byNode.get(n).push(i); } });
  // two tunnel edges meeting at a plain join continue the same run
  const nextAt = (n, from) => {
    const l = byNode.get(n);
    if (l.length !== 2) return -1;
    const o = l[0] === from ? l[1] : l[0];
    return edges[o].tunnel ? o : -1;
  };
  const done = new Set();
  edges.forEach((e0, i0) => {
    if (!e0.tunnel || done.has(i0)) return;
    // walk back to one end of the run
    let cur = i0, node = e0.a, guard = 0;
    for (;;) { const p = nextAt(node, cur); if (p < 0 || p === i0 || guard++ > edges.length) break; node = edges[p].a === node ? edges[p].b : edges[p].a; cur = p; }
    // walk forward collecting edges in order (and whether each is reversed)
    const run = [];
    let at = node, e = cur;
    while (e >= 0 && !done.has(e)) {
      done.add(e);
      const rev = edges[e].b === at;
      run.push({ e, rev });
      at = rev ? edges[e].a : edges[e].b;
      e = nextAt(at, e);
    }
    const closed = e >= 0; // the run loops back on itself: tunnel all the way round
    // distance along the run at every point
    let total = 0;
    const along = run.map(({ e, rev }) => {
      const pts = rev ? [...edges[e].points].reverse() : edges[e].points;
      const d = [total];
      for (let k = 1; k < pts.length; k++) d.push(d[k - 1] + Math.hypot(pts[k].x - pts[k - 1].x, pts[k].z - pts[k - 1].z));
      total = d[d.length - 1];
      return rev ? d.reverse() : d;
    });
    // stretches that have a road crossing over them must be fully deep
    let first = Infinity, last = -Infinity, cross = null;
    run.forEach(({ e }, k) => edges[e].points.forEach((p, j) => {
      const q = underRoad(p);
      if (q) { cross = cross || q; first = Math.min(first, along[k][j]); last = Math.max(last, along[k][j]); }
    }));
    const hill = !closed && !cross && total < MIN_DEEP_TUNNEL;
    // ramp lengths at each end: normally up to a cell, shorter if a crossing comes sooner
    const Ra = Math.min(CELL, cross ? first - 4 : total / 2), Rb = Math.min(CELL, cross ? total - last - 4 : total / 2);
    if (cross && !closed && Math.min(Ra, Rb) < 9 && !error) {
      error = { c: cross.c, r: cross.r, msg: 'A road crosses this tunnel too close to its entrance – the tunnel can\'t get deep enough. Make the tunnel longer.' };
    }
    const ease = (x, R) => (x >= R ? 1 : x <= 0 ? 0 : (1 - Math.cos(Math.PI * x / R)) / 2);
    run.forEach(({ e }, k) => {
      edges[e].hill = hill;
      edges[e].points = edges[e].points.map((p, j) => ({
        ...p, h: hill ? 0 : closed ? -TUNNEL_DEPTH : -TUNNEL_DEPTH * Math.min(ease(along[k][j], Ra), ease(total - along[k][j], Rb)),
      }));
    });
  });
  return error;
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
      { type: 'straight', rot: 1, c: 5, r: 3, len: 4, obstacle: { type: 'hammer', pos: 0.5, speed: 'slow' } },
      ...buildFromTurtle([6, 7], E, [['straight', { len: 2 }], ['corner', { size: 1 }, 'L'], ['straight', { len: 4 }], ['corner', { size: 1 }, 'L'], ['straight', { len: 2 }]]),
      // start line on the left side, so cars get going before the junction
      ...buildFromTurtle([4, 2], 3, [['straight', { len: 1 }], ['corner', { size: 1 }, 'L'], ['start', { len: 1 }], ['straight', { len: 3 }], ['corner', { size: 1 }, 'L'], ['straight', { len: 1 }]]),
    ],
  },
  'Y split': {
    width: 12,
    tiles: () => [
      { type: 'yfork', rot: 1, c: 4, r: 6 }, { type: 'yfork', rot: 3, c: 9, r: 6 },
      { type: 'straight', rot: 0, c: 6, r: 6, len: 3, obstacle: { type: 'hammer', pos: 0.5, speed: 'fast' } },
      { type: 'straight', rot: 0, c: 6, r: 7, len: 3, obstacle: { type: 'boost', pos: 0.3, strength: 1, width: 'full' } },
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
  'Gauntlet': {
    width: 13,
    tiles: () => buildFromTurtle([4, 8], E, [
      ['start', { len: 2 }], ['straight', { len: 2 }, null, { type: 'spinner', pos: 0.5, speed: 'slow' }],
      ['straight', { len: 1 }, null, { type: 'laser', pos: 0.5, speed: 'normal' }], ['corner', { size: 2 }, 'L'],
      ['straight', { len: 3 }, null, { type: 'mud', lane: 'center', pos: 0.5, width: 'wide' }], ['corner', { size: 2 }, 'L'],
      ['straight', { len: 3 }, null, { type: 'bumper', lane: 'right', pos: 0.5 }],
      ['straight', { len: 2 }, null, { type: 'crates', lane: 'left', pos: 0.5 }], ['corner', { size: 2 }, 'L'],
      ['straight', { len: 3 }], ['corner', { size: 2 }, 'L'],
    ]),
  },
  'Big roundabout': {
    width: 12,
    tiles: () => [
      { type: 'bigRoundabout', rot: 0, c: 2, r: 2 },
      ...buildFromTurtle([7, 4], E, [['start', { len: 1 }], ['straight', { len: 1 }], ['corner', { size: 1 }, 'L'], ['straight', { len: 2 }], ['corner', { size: 1 }, 'L'], ['straight', { len: 4 }], ['corner', { size: 1 }, 'L']]),
      ...buildFromTurtle([4, 7], 2, [['corner', { size: 1 }, 'R'], ['straight', { len: 2 }], ['corner', { size: 1 }, 'R'], ['straight', { len: 2 }], ['corner', { size: 1 }, 'R']]),
    ],
  },
  'Wrong turn': {
    width: 12,
    tiles: () => {
      // the Rectangle, with a T junction on the right-hand side whose third arm is a dead end
      const t = TILE_PRESETS.Rectangle.tiles();
      const k = t.findIndex(x => x.type === 'straight' && x.c === 7 && x.r === 2);
      t.splice(k, 1, { type: 'tee', rot: 3, c: 7, r: 2 }, { type: 'deadend', rot: 0, c: 8, r: 2 });
      t.find(x => x.type === 'corner' && x.c === 0 && x.r === 1).tunnel = 1; // a short tunnel through a hill
      return t;
    },
  },
};
