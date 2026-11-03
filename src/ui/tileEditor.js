// Drag-and-drop grid editor for track pieces and obstacles.
//  - drag a piece from the palette onto the grid (or select it, then tap empty cells)
//  - tap a placed piece to select it and edit its properties (length, curve, obstacle…)
//  - tap the selected piece again to rotate it; drag a piece to move it,
//    drag it off the grid to remove it
//  - drag an obstacle from the palette onto a piece
import { Track } from '../sim/track.js';
import {
  CELL, COLS, ROWS, DIR, PIECES, PIECE_ORDER, OBSTACLE_TYPES, OBSTACLE_ORDER, LANES,
  pieceGeometry, footprint, fitsGrid, traceLayout, paramValue,
} from '../sim/tiles.js';
import { obstacleLayout } from '../sim/obstacles.js';

const DRAG_THRESHOLD = 8;

export class TileEditor {
  constructor(canvas, palette, panel, { onChange, getReserved, onMessage } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.palette = palette;
    this.panel = panel;
    this.tiles = [];
    this.width = 12;
    this.mode = 'place'; // place | delete
    this.paletteSel = { kind: 'piece', type: 'straight' };
    this.selected = null;
    this.drag = null;
    this.press = null;
    this.onChange = onChange || (() => {});
    this.onMessage = onMessage || (() => {});
    this.getReserved = getReserved || (() => ({ top: 0, bottom: 0, left: 0, right: 0 }));
    this.result = { ok: false, order: [] };
    this.preview = null;

    canvas.addEventListener('pointerdown', e => this.canvasDown(e));
    window.addEventListener('pointermove', e => this.pointerMove(e));
    window.addEventListener('pointerup', e => this.pointerUp(e));
    window.addEventListener('pointercancel', () => { this.drag = null; this.press = null; this.draw(); });
    window.addEventListener('resize', () => this.resize());
    this.buildPalette();
    this.renderPanel();
  }

  // ------------------------------------------------------------ palette
  buildPalette() {
    this.palette.innerHTML = '';
    this.paletteItems = [];
    const add = (kind, type, label, drawIcon) => {
      const item = document.createElement('div');
      item.className = 'paletteItem' + (kind === 'obstacle' ? ' obstacle' : '');
      const cv = document.createElement('canvas');
      cv.width = cv.height = 96;
      item.appendChild(cv);
      const lbl = document.createElement('small'); lbl.textContent = label; item.appendChild(lbl);
      const ctx = cv.getContext('2d');
      ctx.fillStyle = '#5f9e3f'; ctx.fillRect(0, 0, 96, 96);
      drawIcon(ctx);
      item.addEventListener('pointerdown', e => {
        e.preventDefault();
        this.paletteSel = { kind, type };
        this.syncPalette();
        if (kind === 'piece') this.startDrag({ kind, tile: { type, rot: 0, c: 0, r: 0 }, grab: { dc: 0, dr: 0 } }, e);
        else this.startDrag({ kind, type }, e);
      });
      item.dataset.key = kind + ':' + type;
      this.palette.appendChild(item);
      this.paletteItems.push(item);
    };
    for (const type of PIECE_ORDER) {
      add('piece', type, PIECES[type].label, ctx => {
        const t = { type, rot: 0, c: 0, r: 0 };
        drawTile(ctx, t, iconMap(t), 96 / CELL, this.width, 1, false);
      });
    }
    for (const type of OBSTACLE_ORDER) {
      add('obstacle', type, OBSTACLE_TYPES[type].label, ctx => {
        const t = { type: 'straight', rot: 0, c: 0, r: 0, obstacle: { type, lane: 'center', pos: 0.5 } };
        drawTile(ctx, t, iconMap(t), 96 / CELL, this.width, 1, false);
        ctx.font = '52px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(OBSTACLE_TYPES[type].icon, 48, 52);
      });
    }
    this.syncPalette();
  }

  syncPalette() {
    const k = this.paletteSel.kind + ':' + this.paletteSel.type;
    for (const el of this.paletteItems) el.classList.toggle('active', el.dataset.key === k);
  }

  // ------------------------------------------------------------ layout
  resize() {
    const r = this.canvas.getBoundingClientRect();
    if (!r.width) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.dpr = dpr;
    this.canvas.width = r.width * dpr; this.canvas.height = r.height * dpr;
    const res = this.getReserved();
    const pad = 6;
    const availW = r.width - res.left - res.right - 2 * pad;
    const availH = r.height - res.top - res.bottom - 2 * pad;
    const cellPx = Math.max(10, Math.min(availW / COLS, availH / ROWS));
    this.cellPx = cellPx * dpr;
    this.originX = (res.left + pad + (availW - cellPx * COLS) / 2) * dpr;
    this.originY = (res.top + pad + (availH - cellPx * ROWS) / 2) * dpr;
    this.draw();
  }

  /** canvas px for a world point (metres) */
  get map() {
    const k = this.cellPx / CELL, ox = this.originX, oy = this.originY;
    return p => [ox + (p.x + COLS * CELL / 2) * k, oy + (p.z + ROWS * CELL / 2) * k];
  }

  cellAt(clientX, clientY) {
    const r = this.canvas.getBoundingClientRect();
    const x = ((clientX - r.left) * this.dpr - this.originX) / this.cellPx;
    const y = ((clientY - r.top) * this.dpr - this.originY) / this.cellPx;
    const c = Math.floor(x), row = Math.floor(y);
    if (c < 0 || row < 0 || c >= COLS || row >= ROWS) return null;
    return { c, r: row };
  }

  tileAt(c, r) {
    return this.tiles.find(t => footprint(t).some(f => f.c === c && f.r === r));
  }

  overlapping(tile, ignore = null) {
    const cells = new Set(footprint(tile).map(f => f.c + ',' + f.r));
    return this.tiles.filter(t => t !== tile && t !== ignore && footprint(t).some(f => cells.has(f.c + ',' + f.r)));
  }

  /** Shift a tile's anchor so its footprint lies inside the grid. */
  clampToGrid(tile) {
    const g = pieceGeometry(tile);
    tile.c = Math.max(0, Math.min(COLS - g.w, tile.c));
    tile.r = Math.max(0, Math.min(ROWS - g.h, tile.r));
    return tile;
  }

  // ------------------------------------------------------------ input
  startDrag(d, e) {
    this.drag = { ...d, x: e.clientX, y: e.clientY };
    this.draw();
  }

  canvasDown(e) {
    e.preventDefault();
    const cell = this.cellAt(e.clientX, e.clientY);
    if (!cell) { this.select(null); return; }
    const t = this.tileAt(cell.c, cell.r);
    if (this.mode === 'delete') {
      if (t) { this.remove(t); this.changed(); }
      return;
    }
    if (t) { this.press = { tile: t, x: e.clientX, y: e.clientY, cell }; return; }
    if (this.selected) { this.select(null); return; } // tap on empty grass closes the panel
    if (this.paletteSel.kind === 'piece') {
      const tile = this.clampToGrid({ type: this.paletteSel.type, rot: 0, c: cell.c, r: cell.r });
      this.place(tile);
    } else this.onMessage('Drag obstacles onto a track piece');
  }

  pointerMove(e) {
    if (this.press && !this.drag) {
      if (Math.hypot(e.clientX - this.press.x, e.clientY - this.press.y) > DRAG_THRESHOLD) {
        const t = this.press.tile;
        const grab = { dc: this.press.cell.c - t.c, dr: this.press.cell.r - t.r };
        this.remove(t);
        this.press = null;
        this.startDrag({ kind: 'piece', tile: t, grab, fromGrid: true }, e);
        this.changed();
      }
      return;
    }
    if (!this.drag) return;
    this.drag.x = e.clientX; this.drag.y = e.clientY;
    this.draw();
  }

  pointerUp(e) {
    if (this.press) {
      const t = this.press.tile;
      this.press = null;
      if (this.selected === t) this.rotate(t);
      else this.select(t);
      return;
    }
    if (!this.drag) return;
    const d = this.drag;
    this.drag = null;
    const cell = this.cellAt(e.clientX, e.clientY);
    if (d.kind === 'obstacle') {
      const t = cell && this.tileAt(cell.c, cell.r);
      if (!t) { this.draw(); if (cell) this.onMessage('Drop obstacles onto a track piece'); return; }
      if (t.type === 'start') { this.onMessage('Obstacles can\'t go on the Start piece'); this.draw(); return; }
      t.obstacle = { type: d.type, lane: 'center', pos: 0.5 };
      this.select(t);
      this.changed();
      return;
    }
    if (!cell) {
      if (d.fromGrid) { if (this.selected === d.tile) this.select(null); this.onMessage('Piece removed'); }
      this.draw();
      return;
    }
    const tile = this.clampToGrid({ ...d.tile, c: cell.c - d.grab.dc, r: cell.r - d.grab.dr });
    if (d.fromGrid) Object.assign(d.tile, { c: tile.c, r: tile.r }); // keep identity (selection, obstacle)
    this.place(d.fromGrid ? d.tile : tile);
  }

  place(tile) {
    const over = this.overlapping(tile);
    this.tiles = this.tiles.filter(t => !over.includes(t));
    if (tile.type === 'start') this.tiles = this.tiles.filter(t => t.type !== 'start');
    this.tiles.push(tile);
    if (this.selected && !this.tiles.includes(this.selected)) this.select(null);
    this.changed();
  }

  remove(t) {
    this.tiles = this.tiles.filter(x => x !== t);
    if (this.selected === t) this.select(null);
  }

  /**
   * Apply a change to a placed piece (rotation / size). If the new footprint
   * doesn't fit, try shifting the piece so it still covers its old anchor cell.
   */
  modify(t, changes) {
    const old = { ...t };
    // ends of the piece that currently join a neighbour – try to keep them in place
    const linked = pieceGeometry(t).ports.filter(p => {
      const n = this.tileAt(p.c + DIR[p.e][0], p.r + DIR[p.e][1]);
      return n && n !== t;
    });
    Object.assign(t, changes);
    const g = pieceGeometry(t);
    const candidates = [];
    const span = Math.max(g.w, g.h) + 1;
    for (let dy = -span; dy <= span; dy++) for (let dx = -span; dx <= span; dx++) candidates.push({ c: old.c + dx, r: old.r + dy });
    const score = p => {
      const ports = pieceGeometry({ ...t, ...p }).ports;
      const kept = linked.filter(l => ports.some(q => q.c === l.c && q.r === l.r && q.e === l.e)).length;
      const cover = footprint({ ...t, ...p }).some(f => f.c === old.c && f.r === old.r);
      return -kept * 100 + (cover ? 0 : 50) + Math.abs(p.c - old.c) + Math.abs(p.r - old.r);
    };
    candidates.sort((a, b) => score(a) - score(b));
    for (const p of candidates) {
      Object.assign(t, p);
      if (fitsGrid(t) && this.overlapping(t).length === 0) { this.changed(); return true; }
    }
    Object.assign(t, old);
    for (const k of Object.keys(changes)) if (!(k in old)) delete t[k];
    this.onMessage('Not enough room – move nearby pieces first');
    this.draw();
    return false;
  }

  rotate(t) { this.modify(t, { rot: (t.rot + 1) % 4 }); }

  select(t) {
    this.selected = t;
    this.renderPanel();
    this.onChange(this);
    this.draw();
  }

  setTiles(tiles, width) {
    this.tiles = tiles.map(t => ({ ...t, obstacle: t.obstacle ? { ...t.obstacle } : undefined }));
    this.tiles.forEach(t => { if (!t.obstacle) delete t.obstacle; });
    if (width) this.width = width;
    this.selected = null;
    this.changed();
  }

  setWidth(w) { this.width = w; this.buildPalette(); this.changed(); }

  changed() {
    this.result = traceLayout(this.tiles);
    this.preview = null;
    if (this.result.ok) {
      try {
        this.preview = new Track(this.result.points, this.width, { polyline: true, obstacles: this.result.obstacles });
      } catch { this.preview = null; }
    }
    this.renderPanel();
    this.draw();
    this.onChange(this);
  }

  get valid() { return !!this.preview; }

  /** Is this piece driven backwards (port 1 -> port 0) in the current loop? */
  isReversed(t) {
    const o = (this.result.order || []).find(o => o.tile === t);
    return o ? o.rev : false;
  }

  // ------------------------------------------------------------ properties panel
  renderPanel() {
    const P = this.panel, t = this.selected;
    if (!P) return;
    P.classList.toggle('empty', !t);
    if (!t) {
      P.innerHTML = '<div class="muted small">Tap a piece on the grid to change its properties.</div>';
      return;
    }
    const def = PIECES[t.type];
    const seg = (label, options, current, names, onPick) => {
      const row = document.createElement('div'); row.className = 'propRow';
      const l = document.createElement('div'); l.className = 'propLabel'; l.textContent = label; row.appendChild(l);
      const g = document.createElement('div'); g.className = 'seg';
      options.forEach((v, i) => {
        const b = document.createElement('button');
        b.textContent = names ? names[i] : v;
        if (v === current) b.classList.add('active');
        b.onclick = () => onPick(v);
        g.appendChild(b);
      });
      row.appendChild(g);
      return row;
    };
    P.innerHTML = '';
    const head = document.createElement('div'); head.className = 'propHead';
    head.innerHTML = `<b>${def.label}</b>`;
    const close = document.createElement('button'); close.className = 'iconBtn'; close.textContent = '✕';
    close.onclick = () => this.select(null);
    head.appendChild(close);
    P.appendChild(head);

    for (const [name, pd] of Object.entries(def.params)) {
      const names = pd.names || pd.options.map(v => name === 'len' ? `${v * CELL}m` : v);
      P.appendChild(seg(pd.label, pd.options, paramValue(t, name), names, v => this.modify(t, { [name]: v })));
    }
    if (t.type === 'corner') {
      const r = (paramValue(t, 'size') - 0.5) * CELL;
      const info = document.createElement('div'); info.className = 'muted small'; info.textContent = `Radius ${r} m`;
      P.appendChild(info);
    }

    if (t.type !== 'start') {
      const obsOpts = ['none', ...OBSTACLE_ORDER];
      const cur = t.obstacle ? t.obstacle.type : 'none';
      P.appendChild(seg('Obstacle', obsOpts, cur, obsOpts.map(o => o === 'none' ? '–' : OBSTACLE_TYPES[o].icon), v => {
        if (v === 'none') delete t.obstacle;
        else t.obstacle = { lane: 'center', pos: 0.5, ...(t.obstacle || {}), type: v };
        this.changed();
      }));
      if (t.obstacle) {
        const ot = OBSTACLE_TYPES[t.obstacle.type];
        const d = document.createElement('div'); d.className = 'muted small'; d.textContent = ot.desc; P.appendChild(d);
        if (t.obstacle.type !== 'hammer') {
          P.appendChild(seg('Lane', LANES, t.obstacle.lane, ['Left', 'Middle', 'Right'], v => { t.obstacle.lane = v; this.changed(); }));
        }
        const row = document.createElement('label'); row.className = 'propRow';
        row.innerHTML = '<div class="propLabel">Position</div>';
        const inp = document.createElement('input');
        inp.type = 'range'; inp.min = 0.1; inp.max = 0.9; inp.step = 0.05; inp.value = t.obstacle.pos;
        inp.oninput = () => { t.obstacle.pos = Number(inp.value); this.changed(); };
        row.appendChild(inp);
        P.appendChild(row);
      }
    }

    const btns = document.createElement('div'); btns.className = 'propButtons';
    const rot = document.createElement('button'); rot.innerHTML = '⟳<small>Rotate</small>'; rot.onclick = () => this.rotate(t);
    const del = document.createElement('button'); del.innerHTML = '🗑️<small>Delete</small>';
    del.onclick = () => { this.remove(t); this.changed(); };
    btns.append(rot, del);
    P.appendChild(btns);
  }

  // ------------------------------------------------------------ drawing
  draw() {
    const ctx = this.ctx, W = this.canvas.width, H = this.canvas.height, s = this.cellPx;
    if (!s) return;
    ctx.fillStyle = '#4f8a33'; ctx.fillRect(0, 0, W, H);
    const ox = this.originX, oy = this.originY, k = s / CELL, map = this.map;
    ctx.fillStyle = '#5f9e3f'; ctx.fillRect(ox, oy, s * COLS, s * ROWS);
    ctx.strokeStyle = 'rgba(255,255,255,0.13)'; ctx.lineWidth = 1;
    for (let c = 0; c <= COLS; c++) { ctx.beginPath(); ctx.moveTo(ox + c * s, oy); ctx.lineTo(ox + c * s, oy + ROWS * s); ctx.stroke(); }
    for (let r = 0; r <= ROWS; r++) { ctx.beginPath(); ctx.moveTo(ox, oy + r * s); ctx.lineTo(ox + COLS * s, oy + r * s); ctx.stroke(); }

    const inLoop = new Set((this.result.order || []).map(o => o.tile));
    for (const t of this.tiles) {
      const g = pieceGeometry(t);
      if (this.result.ok && inLoop.has(t)) { ctx.fillStyle = 'rgba(56,224,123,0.10)'; ctx.fillRect(ox + t.c * s, oy + t.r * s, g.w * s, g.h * s); }
      const a = !this.result.ok || inLoop.has(t) ? 1 : 0.5;
      drawTile(ctx, t, map, k, this.width, a, this.isReversed(t));
      drawObstacle(ctx, t, map, k, this.width, this.isReversed(t), 0, a, Math.max(16 * this.dpr, s * 0.38));
      if (this.mode === 'delete') {
        ctx.strokeStyle = 'rgba(255,59,92,0.8)'; ctx.lineWidth = 2 * this.dpr;
        ctx.strokeRect(ox + t.c * s + 2, oy + t.r * s + 2, g.w * s - 4, g.h * s - 4);
      }
    }
    if (this.selected) {
      const t = this.selected, g = pieceGeometry(t);
      ctx.strokeStyle = '#ff8a1f'; ctx.lineWidth = 3 * this.dpr;
      ctx.strokeRect(ox + t.c * s + 1.5, oy + t.r * s + 1.5, g.w * s - 3, g.h * s - 3);
    }

    // Driving direction arrows along a valid loop
    if (this.result.ok) {
      ctx.fillStyle = 'rgba(255,192,46,0.9)';
      for (const { tile, rev } of this.result.order) {
        const p = pieceGeometry(tile).path(10);
        if (rev) p.reverse();
        const n = Math.max(1, Math.round(pieceGeometry(tile).length / CELL));
        for (let j = 0; j < n; j++) {
          const i = Math.floor(((j + 0.5) / n) * 10);
          const [ax, ay] = map(p[i]), [bx, by] = map(p[Math.min(10, i + 1)]);
          arrow(ctx, (ax + bx) / 2, (ay + by) / 2, Math.atan2(by - ay, bx - ax), s * 0.1);
        }
      }
    }

    const err = this.result.error;
    if (err && err.c !== undefined && this.tiles.length) {
      ctx.strokeStyle = '#ff3b5c'; ctx.lineWidth = 3 * this.dpr;
      ctx.setLineDash([6 * this.dpr, 4 * this.dpr]);
      ctx.strokeRect(ox + err.c * s + 3, oy + err.r * s + 3, s - 6, s - 6);
      ctx.setLineDash([]);
    }

    // Item being dragged
    if (this.drag) {
      const d = this.drag;
      const cell = this.cellAt(d.x, d.y);
      const r = this.canvas.getBoundingClientRect();
      const gx = (d.x - r.left) * this.dpr, gy = (d.y - r.top) * this.dpr;
      if (d.kind === 'piece') {
        if (cell) {
          const t = this.clampToGrid({ ...d.tile, c: cell.c - d.grab.dc, r: cell.r - d.grab.dr });
          const g = pieceGeometry(t);
          const replaces = this.overlapping(t, d.tile).length;
          ctx.fillStyle = replaces ? 'rgba(255,59,92,0.25)' : 'rgba(255,255,255,0.18)';
          ctx.fillRect(ox + t.c * s, oy + t.r * s, g.w * s, g.h * s);
          drawTile(ctx, t, map, k, this.width, 0.6, false);
          if (replaces) label(ctx, `replaces ${replaces}`, ox + (t.c + g.w / 2) * s, oy + t.r * s - 6 * this.dpr, this.dpr, '#ff3b5c');
        } else {
          const t = { ...d.tile, c: 0, r: 0 };
          const g = pieceGeometry(t);
          const m = p => { const [x, y] = map(p); return [x - ox + gx - (d.grab.dc + 0.5) * s, y - oy + gy - (d.grab.dr + 0.5) * s - s * 0.3]; };
          drawTile(ctx, t, m, k, this.width, 0.85, false);
          if (d.fromGrid) label(ctx, 'release to remove', gx, gy + s * 0.45, this.dpr, '#ff3b5c');
          void g;
        }
      } else {
        const t = cell && this.tileAt(cell.c, cell.r);
        if (t) {
          const g = pieceGeometry(t);
          ctx.strokeStyle = t.type === 'start' ? '#ff3b5c' : '#38e07b'; ctx.lineWidth = 3 * this.dpr;
          ctx.strokeRect(ox + t.c * s, oy + t.r * s, g.w * s, g.h * s);
        }
        ctx.font = `${Math.round(s * 0.55)}px system-ui`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(OBSTACLE_TYPES[d.type].icon, gx, gy - s * 0.35);
        ctx.textBaseline = 'alphabetic';
      }
    }
  }
}

// ---------------------------------------------------------------- drawing helpers

/** Map for palette icons: fit the piece's footprint into a 96px canvas. */
function iconMap(t) {
  const g = pieceGeometry(t), k = 96 / CELL / Math.max(g.w, g.h);
  const ox = (t.c - COLS / 2) * CELL, oz = (t.r - ROWS / 2) * CELL;
  return p => [(p.x - ox) * k * Math.max(g.w, g.h) / Math.max(g.w, g.h), (p.z - oz) * k];
}

function arrow(ctx, x, y, ang, L) {
  ctx.beginPath();
  ctx.moveTo(x + Math.cos(ang) * L, y + Math.sin(ang) * L);
  ctx.lineTo(x + Math.cos(ang + 2.5) * L, y + Math.sin(ang + 2.5) * L);
  ctx.lineTo(x + Math.cos(ang - 2.5) * L, y + Math.sin(ang - 2.5) * L);
  ctx.fill();
}

function label(ctx, text, x, y, dpr, color) {
  ctx.font = `${12 * dpr}px system-ui`; ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  const w = ctx.measureText(text).width + 10 * dpr;
  ctx.fillRect(x - w / 2, y - 13 * dpr, w, 18 * dpr);
  ctx.fillStyle = color; ctx.fillText(text, x, y);
}

/** Draw a piece's road. `map` turns world metres into canvas px; k = px per metre. */
export function drawTile(ctx, tile, map, k, width, alpha = 1, rev = false) {
  const g = pieceGeometry(tile);
  const pts = g.path(Math.max(16, Math.ceil(g.length / 2)));
  if (rev) pts.reverse();
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.lineCap = 'butt'; ctx.lineJoin = 'round';
  const path = () => { ctx.beginPath(); pts.forEach((p, i) => { const [x, y] = map(p); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); };
  path(); ctx.strokeStyle = '#e8e8e8'; ctx.lineWidth = (width + 2.4) * k; ctx.stroke();
  path(); ctx.strokeStyle = '#3b3f45'; ctx.lineWidth = width * k; ctx.stroke();
  path(); ctx.strokeStyle = 'rgba(255,255,255,0.45)'; ctx.lineWidth = Math.max(1, 0.4 * k); ctx.setLineDash([3 * k, 3 * k]); ctx.stroke(); ctx.setLineDash([]);
  if (tile.type === 'start') {
    const i = Math.floor(pts.length / 2);
    const [mx, my] = map(pts[i]), [nx2, ny2] = map(pts[i + 1]);
    const ang = Math.atan2(ny2 - my, nx2 - mx);
    const hw = width / 2 * k, sq = width / 6 * k;
    ctx.save();
    ctx.translate(mx, my); ctx.rotate(ang);
    for (let a = 0; a < 6; a++) for (let b = 0; b < 2; b++) {
      ctx.fillStyle = (a + b) % 2 ? '#111' : '#fff';
      ctx.fillRect(b * sq * 0.6 - sq * 0.6, -hw + a * sq, sq * 0.6, sq);
    }
    ctx.restore();
    const [tx, ty] = map(pts[Math.min(pts.length - 1, i + Math.max(2, Math.round(pts.length / 5)))]);
    ctx.fillStyle = '#ffc02e';
    arrow(ctx, tx, ty, ang, width * 0.35 * k);
  }
  ctx.restore();
}

/** Draw the obstacle attached to a piece (if any). */
export function drawObstacle(ctx, tile, map, k, width, rev, swing = 0, alpha = 1, badge = 0) {
  const o = tile.obstacle;
  if (!o) return;
  const g = pieceGeometry(tile);
  const steps = 40;
  const pts = g.path(steps);
  if (rev) pts.reverse();
  const i = Math.min(steps - 1, Math.round((o.pos ?? 0.5) * steps));
  const p = pts[i], q = pts[i + 1];
  const tl = Math.hypot(q.x - p.x, q.z - p.z) || 1;
  const tx = (q.x - p.x) / tl, tz = (q.z - p.z) / tl, nx = -tz, nz = tx;
  const L = obstacleLayout(o.type, o.lane, width / 2);
  const c = { x: p.x + nx * L.lat, z: p.z + nz * L.lat };
  const [cx, cy] = map(c);
  const ang = Math.atan2(tz, tx);
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(cx, cy); ctx.rotate(ang);
  if (o.type === 'spikes') {
    ctx.fillStyle = '#6b7280'; ctx.fillRect(-L.a * k, -L.b * k, 2 * L.a * k, 2 * L.b * k);
    ctx.fillStyle = '#e5e7eb';
    const n = Math.max(2, Math.round(L.b * 2 / 1.2));
    for (let j = 0; j < n; j++) {
      const y = -L.b * k + (j + 0.5) * (2 * L.b * k / n), r = Math.min(L.a, L.b * 2 / n) * k * 0.8;
      ctx.beginPath(); ctx.moveTo(-r, y + r * 0.6); ctx.lineTo(r, y + r * 0.6); ctx.lineTo(0, y - r * 0.8); ctx.fill();
    }
  } else if (o.type === 'crates') {
    ctx.fillStyle = '#a0662f'; ctx.fillRect(-L.a * k, -L.b * k, 2 * L.a * k, 2 * L.b * k);
    ctx.strokeStyle = '#5c3616'; ctx.lineWidth = Math.max(1, 0.3 * k);
    ctx.strokeRect(-L.a * k, -L.b * k, 2 * L.a * k, 2 * L.b * k);
    const n = Math.max(1, Math.round(L.b * 2 / (2 * L.a)));
    for (let j = 1; j < n; j++) { const y = -L.b * k + j * (2 * L.b * k / n); ctx.beginPath(); ctx.moveTo(-L.a * k, y); ctx.lineTo(L.a * k, y); ctx.stroke(); }
  } else if (o.type === 'oil') {
    ctx.fillStyle = 'rgba(10,10,14,0.85)';
    ctx.beginPath(); ctx.ellipse(0, 0, L.r * k * 0.9, L.r * k, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(120,90,200,0.35)';
    ctx.beginPath(); ctx.ellipse(-L.r * k * 0.2, -L.r * k * 0.25, L.r * k * 0.35, L.r * k * 0.2, 0.4, 0, Math.PI * 2); ctx.fill();
  } else if (o.type === 'ramp') {
    // yellow/black wedge, chevrons point the way the cars jump
    ctx.fillStyle = '#facc15'; ctx.fillRect(-L.a * k, -L.b * k, 2 * L.a * k, 2 * L.b * k);
    ctx.fillStyle = '#1f2937';
    const n = Math.max(2, Math.round(L.b * 2 / 2));
    for (let j = 0; j < n; j++) {
      const y = -L.b * k + (j + 0.5) * (2 * L.b * k / n), r = Math.min(L.a * 0.8, L.b / n) * k;
      ctx.beginPath(); ctx.moveTo(-r, y - r); ctx.lineTo(r * 0.6, y); ctx.lineTo(-r, y + r); ctx.lineTo(-r * 0.4, y); ctx.fill();
    }
  } else if (o.type === 'hammer') {
    ctx.strokeStyle = 'rgba(255,255,255,0.6)'; ctx.setLineDash([2 * k, 2 * k]); ctx.lineWidth = Math.max(1, 0.3 * k);
    ctx.beginPath(); ctx.moveTo(0, -L.amp * k); ctx.lineTo(0, L.amp * k); ctx.stroke(); ctx.setLineDash([]);
    const hy = Math.sin(swing) * L.amp * k;
    ctx.fillStyle = '#9ca3af'; ctx.fillRect(-0.3 * k, -L.amp * k - 1.5 * k, 0.6 * k, 1.5 * k);
    ctx.fillStyle = '#b91c1c';
    ctx.fillRect(-1.5 * k, hy - L.headR * k * 0.6, 3 * k, L.headR * k * 1.2);
  }
  ctx.restore();
  if (badge) {
    // readable marker next to the (to-scale, often tiny) obstacle
    const bx = cx, by = cy;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = 'rgba(20,23,28,0.75)';
    ctx.beginPath(); ctx.arc(bx, by, badge * 0.62, 0, Math.PI * 2); ctx.fill();
    ctx.font = `${Math.round(badge * 0.8)}px system-ui`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(OBSTACLE_TYPES[o.type].icon, bx, by + badge * 0.04);
    ctx.restore();
  }
}
