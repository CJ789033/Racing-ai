// Grid-based track pieces. A piece covers a rectangle of grid cells (its
// footprint) and has two ports (cell + edge) where the road enters/leaves.
// A valid track is a closed chain of pieces that starts and ends at the Start
// piece. The chain is turned into a smooth centerline polyline + obstacles.

export const CELL = 30;          // metres per grid cell
export const COLS = 12, ROWS = 9;

// Edges / headings: 0 = N (-z), 1 = E (+x), 2 = S (+z), 3 = W (-x)
export const DIR = [[0, -1], [1, 0], [0, 1], [-1, 0]];
export const opp = e => (e + 2) % 4;

export const PIECES = {
  start:    { label: 'Start',    params: { len: { label: 'Length', options: [1, 2, 3], default: 1 } } },
  straight: { label: 'Straight', params: { len: { label: 'Length', options: [1, 2, 3, 4], default: 1 } } },
  corner:   { label: 'Corner',   params: { size: { label: 'Curve', options: [1, 2, 3], default: 1, names: ['Tight', 'Medium', 'Wide'] } } },
  chicane:  { label: 'Chicane',  params: { len: { label: 'Length', options: [1, 2], default: 1 }, amp: { label: 'Wiggle', options: [2, 4, 6], default: 4, names: ['Gentle', 'Normal', 'Sharp'] } } },
};
export const PIECE_ORDER = ['start', 'straight', 'corner', 'chicane'];

export const OBSTACLE_TYPES = {
  hammer: { label: 'Hammer', icon: '🔨', desc: 'Swings across the road – bad timing is fatal' },
  spikes: { label: 'Spikes', icon: '🔺', desc: 'Strip of spikes covering part of the road – fatal' },
  crates: { label: 'Crates', icon: '📦', desc: 'Solid wall of crates – you stop dead if you hit them' },
  oil:    { label: 'Oil',    icon: '🛢️', desc: 'Slippery patch – almost no grip' },
  ramp:   { label: 'Ramp',   icon: '⤴️', desc: 'Launches cars into the air – faster means further. No steering while flying, and land on the road!' },
};
export const OBSTACLE_ORDER = ['hammer', 'spikes', 'crates', 'oil', 'ramp'];
export const LANES = ['left', 'center', 'right'];

export function paramValue(tile, name) {
  const def = PIECES[tile.type].params[name];
  if (!def) return undefined;
  return def.options.includes(tile[name]) ? tile[name] : def.default;
}

/** Shape at rotation 0, in local cells / metres (origin = footprint top-left). */
function baseShape(tile) {
  if (tile.type === 'corner') {
    const n = paramValue(tile, 'size');
    const R = (n - 0.5) * CELL;
    return {
      w: n, h: n,
      // enters through the W edge of the bottom-left cell, leaves through the N edge of the top-right cell
      ports: [{ x: 0, y: n - 1, e: 3 }, { x: n - 1, y: 0, e: 0 }],
      path: steps => {
        const pts = [];
        for (let i = 0; i <= steps; i++) {
          const a = Math.PI / 2 * (1 - i / steps); // arc around the footprint's top-left corner
          pts.push({ x: Math.cos(a) * R, z: Math.sin(a) * R });
        }
        return pts;
      },
    };
  }
  const n = paramValue(tile, 'len');
  const L = n * CELL, amp = tile.type === 'chicane' ? paramValue(tile, 'amp') : 0;
  return {
    w: n, h: 1,
    ports: [{ x: 0, y: 0, e: 3 }, { x: n - 1, y: 0, e: 1 }],
    path: steps => {
      const pts = [];
      for (let i = 0; i <= steps; i++) {
        const u = i / steps;
        // chicane: sideways jink and back, with zero slope at both ends
        pts.push({ x: u * L, z: CELL / 2 - amp * (1 - Math.cos(2 * Math.PI * u)) / 2 });
      }
      return pts;
    },
  };
}

/**
 * Full geometry of a placed piece: footprint size, absolute ports, and a
 * function giving its centerline (world metres) from port 0 to port 1.
 */
export function pieceGeometry(tile) {
  const base = baseShape(tile);
  let w = base.w, h = base.h;
  let ports = base.ports.map(p => ({ ...p }));
  let tf = p => p;
  const rot = ((tile.rot % 4) + 4) % 4;
  for (let k = 0; k < rot; k++) {
    // rotate 90° clockwise inside a w x h box -> h x w box
    const hh = h, prev = tf, Hm = hh * CELL;
    ports = ports.map(p => ({ x: hh - 1 - p.y, y: p.x, e: (p.e + 1) % 4 }));
    tf = p => { const q = prev(p); return { x: Hm - q.z, z: q.x }; };
    [w, h] = [h, w];
  }
  const ox = (tile.c - COLS / 2) * CELL, oz = (tile.r - ROWS / 2) * CELL;
  return {
    w, h,
    ports: ports.map(p => ({ c: tile.c + p.x, r: tile.r + p.y, e: p.e })),
    path: (steps) => base.path(steps).map(p => { const q = tf(p); return { x: ox + q.x, z: oz + q.z }; }),
    length: tile.type === 'corner' ? Math.PI / 2 * (paramValue(tile, 'size') - 0.5) * CELL : paramValue(tile, 'len') * CELL,
  };
}

export function footprint(tile) {
  const g = pieceGeometry(tile), cells = [];
  for (let y = 0; y < g.h; y++) for (let x = 0; x < g.w; x++) cells.push({ c: tile.c + x, r: tile.r + y });
  return cells;
}

export function fitsGrid(tile) {
  const g = pieceGeometry(tile);
  return tile.c >= 0 && tile.r >= 0 && tile.c + g.w <= COLS && tile.r + g.h <= ROWS;
}

const key = (c, r) => c + ',' + r;

export function occupancy(tiles) {
  const m = new Map();
  for (const t of tiles) for (const f of footprint(t)) m.set(key(f.c, f.r), t);
  return m;
}

/**
 * Follow the chain of pieces from the Start piece.
 * Returns { ok, points, obstacles, order, error }.
 */
export function traceLayout(tiles) {
  const occ = occupancy(tiles);
  const starts = tiles.filter(t => t.type === 'start');
  if (!starts.length) return { ok: false, order: [], error: { msg: 'Place a Start piece' } };
  if (starts.length > 1) return { ok: false, order: [], error: { c: starts[1].c, r: starts[1].r, msg: 'Only one Start piece allowed' } };
  const start = starts[0];
  const order = [{ tile: start, rev: false }];
  const visited = new Set([start]);
  let exit = pieceGeometry(start).ports[1];
  const startEntry = pieceGeometry(start).ports[0];
  for (let guard = 0; guard < COLS * ROWS + 2; guard++) {
    const nc = exit.c + DIR[exit.e][0], nr = exit.r + DIR[exit.e][1];
    const t = occ.get(key(nc, nr));
    if (!t) return { ok: false, order, error: { c: nc, r: nr, msg: 'The track has a gap here' } };
    const ports = pieceGeometry(t).ports;
    const pi = ports.findIndex(p => p.c === nc && p.r === nr && p.e === opp(exit.e));
    if (pi < 0) return { ok: false, order, error: { c: nc, r: nr, msg: 'This piece doesn\'t connect – rotate it or change its size' } };
    if (t === start) {
      if (pi !== 0) return { ok: false, order, error: { c: nc, r: nr, msg: 'Track reaches the start from the wrong side' } };
      const { points, obstacles } = buildPoints(order);
      return { ok: true, order, points, obstacles, unused: tiles.length - order.length };
    }
    if (visited.has(t)) return { ok: false, order, error: { c: nc, r: nr, msg: 'Track runs into itself' } };
    visited.add(t);
    order.push({ tile: t, rev: pi === 1 });
    exit = ports[1 - pi];
  }
  return { ok: false, order, error: { msg: 'Track never closes' } };
}

function piecePoints(tile, rev) {
  const g = pieceGeometry(tile);
  const steps = Math.max(8, Math.ceil(g.length / 2.5));
  const pts = g.path(steps);
  if (rev) pts.reverse();
  pts.pop(); // the next piece starts here
  return pts;
}

function buildPoints(order) {
  const pts = [], ranges = [];
  // The lap begins in the middle of the Start piece, so the start line is there
  const startPts = piecePoints(order[0].tile, false);
  const half = Math.floor(startPts.length / 2);
  pts.push(...startPts.slice(half));
  for (let i = 1; i < order.length; i++) {
    const p = piecePoints(order[i].tile, order[i].rev);
    ranges.push([order[i].tile, pts.length, pts.length + p.length]); // [first, one-past-last]
    pts.push(...p);
  }
  pts.push(...startPts.slice(0, half));
  // arc length at each point
  const cum = [0];
  for (let i = 1; i <= pts.length; i++) {
    const a = pts[i - 1], b = pts[i % pts.length];
    cum.push(cum[i - 1] + Math.hypot(b.x - a.x, b.z - a.z));
  }
  const obstacles = [];
  for (const [tile, i0, i1] of ranges) {
    const o = tile.obstacle;
    if (!o || !OBSTACLE_TYPES[o.type]) continue;
    const pos = clamp(o.pos ?? 0.5, 0.05, 0.95);
    obstacles.push({ type: o.type, lane: LANES.includes(o.lane) ? o.lane : 'center', s: cum[i0] + (cum[i1] - cum[i0]) * pos });
  }
  return { points: pts, obstacles };
}

function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

// ---------------------------------------------------------------------------
// "Turtle" builder: describe a track as a sequence of pieces from a starting
// cell and heading, and get placed tiles back. Used for presets and tests.
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
      ['straight', { len: 3 }, null, { type: 'crates', lane: 'right', pos: 0.5 }],
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
};
