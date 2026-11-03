// Grid-based track pieces. Each piece sits in one grid cell and connects two of
// its edges. A valid track is a closed chain of pieces that starts and ends at
// the Start piece. The chain is turned into a smooth centerline polyline.

export const CELL = 30;          // metres per grid cell
export const COLS = 10, ROWS = 8;

// Edges: 0 = N (-z), 1 = E (+x), 2 = S (+z), 3 = W (-x)
const DIR = [[0, -1], [1, 0], [0, 1], [-1, 0]];
const opp = e => (e + 2) % 4;

export const PIECES = {
  start:    { label: 'Start',    conns: [3, 1] },  // drives W -> E at rot 0
  straight: { label: 'Straight', conns: [3, 1] },
  corner:   { label: 'Corner',   conns: [3, 0] },  // W <-> N at rot 0
  chicane:  { label: 'Chicane',  conns: [3, 1] },
};
export const PIECE_ORDER = ['start', 'straight', 'corner', 'chicane'];
const CHICANE_AMP = 4; // metres of sideways jink

export function connections(type, rot) {
  return PIECES[type].conns.map(e => (e + rot) % 4);
}

/** World position of the centre of cell (c, r). */
export function cellCenter(c, r) {
  return { x: (c - COLS / 2 + 0.5) * CELL, z: (r - ROWS / 2 + 0.5) * CELL };
}

/**
 * Centerline of a piece from edge `from` to edge `to`, relative to the cell
 * centre, in metres. Includes the start point, excludes the end point.
 */
export function localPath(type, rot, from, to, steps = 10) {
  const h = CELL / 2, pts = [];
  const a = { x: DIR[from][0] * h, z: DIR[from][1] * h };
  const b = { x: DIR[to][0] * h, z: DIR[to][1] * h };
  if (type === 'corner') {
    const cx = a.x + b.x, cz = a.z + b.z; // the cell corner shared by both edges
    const a0 = Math.atan2(a.z - cz, a.x - cx);
    let d = Math.atan2(b.z - cz, b.x - cx) - a0;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    for (let i = 0; i < steps; i++) {
      const t = a0 + d * (i / steps);
      pts.push({ x: cx + Math.cos(t) * h, z: cz + Math.sin(t) * h });
    }
  } else {
    const off = type === 'chicane' ? DIR[rot % 4] : null; // fixed side, independent of travel direction
    for (let i = 0; i < steps; i++) {
      const u = i / steps;
      let x = a.x + (b.x - a.x) * u, z = a.z + (b.z - a.z) * u;
      if (off) {
        const s = CHICANE_AMP * (1 - Math.cos(2 * Math.PI * u)) / 2;
        x += off[0] * s; z += off[1] * s;
      }
      pts.push({ x, z });
    }
  }
  return pts;
}

const key = (c, r) => c + ',' + r;

/**
 * Follow the chain of pieces from the Start piece.
 * @param {{type:string,rot:number,c:number,r:number}[]} tiles
 * @returns {{ok:boolean, points?:{x,z}[], order?:object[], error?:{c,r,msg}}}
 */
export function traceLayout(tiles) {
  const grid = new Map(tiles.map(t => [key(t.c, t.r), t]));
  const starts = tiles.filter(t => t.type === 'start');
  if (!starts.length) return { ok: false, error: { msg: 'Place a Start piece' } };
  if (starts.length > 1) return { ok: false, error: { ...starts[1], msg: 'Only one Start piece allowed' } };
  const start = starts[0];
  const [startIn, startOut] = connections('start', start.rot);

  const order = [{ tile: start, from: startIn, to: startOut }];
  const visited = new Set([start]);
  let cur = start, out = startOut;
  for (let guard = 0; guard < COLS * ROWS + 2; guard++) {
    const nc = cur.c + DIR[out][0], nr = cur.r + DIR[out][1];
    const t = grid.get(key(nc, nr));
    if (!t) return { ok: false, order, error: { c: nc, r: nr, msg: 'The track has a gap here' } };
    const inEdge = opp(out);
    const conns = connections(t.type, t.rot);
    if (!conns.includes(inEdge)) return { ok: false, order, error: { c: nc, r: nr, msg: 'This piece doesn\'t connect – tap it to rotate' } };
    if (t === start) {
      if (inEdge !== startIn) return { ok: false, order, error: { c: nc, r: nr, msg: 'Track reaches the start from the wrong side' } };
      return { ok: true, order, points: buildPoints(order), unused: tiles.length - order.length };
    }
    if (visited.has(t)) return { ok: false, order, error: { c: nc, r: nr, msg: 'Track loops back on itself' } };
    const exit = conns[0] === inEdge ? conns[1] : conns[0];
    visited.add(t);
    order.push({ tile: t, from: inEdge, to: exit });
    cur = t; out = exit;
  }
  return { ok: false, order, error: { msg: 'Track never closes' } };
}

function buildPoints(order) {
  const pts = [];
  order.forEach(({ tile, from, to }, i) => {
    const c = cellCenter(tile.c, tile.r);
    let local = localPath(tile.type, tile.rot, from, to, tile.type === 'corner' ? 12 : 8);
    // Begin the lap in the middle of the Start piece, so the start line is there
    if (i === 0) local = local.slice(local.length / 2);
    for (const p of local) pts.push({ x: c.x + p.x, z: c.z + p.z });
  });
  const s = order[0];
  const c = cellCenter(s.tile.c, s.tile.r);
  const first = localPath(s.tile.type, s.tile.rot, s.from, s.to, 8);
  for (const p of first.slice(0, first.length / 2)) pts.push({ x: c.x + p.x, z: c.z + p.z });
  return pts;
}

/** Turn a closed sequence of grid cells into pieces (used for presets). */
export function tilesFromCellPath(cells) {
  const n = cells.length;
  const edgeTo = (a, b) => DIR.findIndex(([dx, dz]) => a[0] + dx === b[0] && a[1] + dz === b[1]);
  return cells.map((cell, i) => {
    const inE = edgeTo(cell, cells[(i - 1 + n) % n]), outE = edgeTo(cell, cells[(i + 1) % n]);
    if (i === 0) {
      if (opp(inE) !== outE) throw new Error('preset must begin on a straight');
      return { type: 'start', rot: (inE - 3 + 4) % 4, c: cell[0], r: cell[1] };
    }
    const type = opp(inE) === outE ? 'straight' : 'corner';
    for (let rot = 0; rot < 4; rot++) {
      const cs = connections(type, rot);
      if (cs.includes(inE) && cs.includes(outE)) return { type, rot, c: cell[0], r: cell[1] };
    }
    throw new Error('bad cell path');
  });
}

/** Build a closed cell path from a list of moves like "E3 S2 W3 N2". */
function walk(start, moves) {
  const d = { N: [0, -1], E: [1, 0], S: [0, 1], W: [-1, 0] };
  const cells = [start.slice()];
  for (const m of moves.split(' ')) {
    const [dx, dz] = d[m[0]];
    for (let i = 0; i < Number(m.slice(1)); i++) {
      const l = cells[cells.length - 1];
      cells.push([l[0] + dx, l[1] + dz]);
    }
  }
  cells.pop(); // last move returns to the start cell
  return cells;
}

export const TILE_PRESETS = {
  'Rectangle': { width: 12, tiles: () => tilesFromCellPath(walk([3, 6], 'E4 N5 W6 S5 E2')) },
  'Serpent': { width: 11, tiles: () => tilesFromCellPath(walk([2, 7], 'E6 N2 W2 N2 E2 N2 W7 S3 E2 S1 W2 S2 E1')) },
  'Hairpins': { width: 11, tiles: () => tilesFromCellPath(walk([2, 7], 'E7 N6 W2 S4 W2 N4 W2 S4 W2 S2 E1')) },
};
