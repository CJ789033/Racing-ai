// Drag-and-drop grid editor for preset track pieces.
//  - drag a piece from the palette onto the grid (or tap a palette piece, then tap cells)
//  - tap a placed piece to rotate it, drag it to move it, drag it off the grid to remove it
import { Track } from '../sim/track.js';
import { CELL, COLS, ROWS, PIECES, PIECE_ORDER, connections, localPath, traceLayout } from '../sim/tiles.js';

const DRAG_THRESHOLD = 8; // px before a press on a placed piece becomes a drag

export class TileEditor {
  constructor(canvas, palette, { onChange, getReserved } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.palette = palette;
    this.tiles = [];
    this.width = 12;
    this.mode = 'place'; // place | delete
    this.selected = 'straight';
    this.drag = null;    // { tile, x, y, fromGrid }
    this.press = null;
    this.onChange = onChange || (() => {});
    this.getReserved = getReserved || (() => ({ top: 0, bottom: 0, left: 0, right: 0 }));
    this.result = { ok: false };
    this.preview = null;

    canvas.addEventListener('pointerdown', e => this.canvasDown(e));
    window.addEventListener('pointermove', e => this.pointerMove(e));
    window.addEventListener('pointerup', e => this.pointerUp(e));
    window.addEventListener('pointercancel', () => { this.drag = null; this.press = null; this.draw(); });
    window.addEventListener('resize', () => this.resize());
    this.buildPalette();
  }

  // ------------------------------------------------------------ palette
  buildPalette() {
    this.palette.innerHTML = '';
    this.paletteItems = {};
    for (const type of PIECE_ORDER) {
      const item = document.createElement('div');
      item.className = 'paletteItem';
      const cv = document.createElement('canvas');
      cv.width = cv.height = 96;
      item.appendChild(cv);
      const lbl = document.createElement('small'); lbl.textContent = PIECES[type].label; item.appendChild(lbl);
      const tctx = cv.getContext('2d');
      tctx.fillStyle = '#5f9e3f'; tctx.fillRect(0, 0, 96, 96);
      drawPiece(tctx, { type, rot: 0 }, 48, 48, 96 / CELL, this.width);
      item.addEventListener('pointerdown', e => {
        e.preventDefault();
        this.select(type);
        this.startDrag({ type, rot: 0 }, e, false);
      });
      this.palette.appendChild(item);
      this.paletteItems[type] = item;
    }
    this.select(this.selected);
  }

  select(type) {
    this.selected = type;
    for (const [t, el] of Object.entries(this.paletteItems)) el.classList.toggle('active', t === type);
  }

  // ------------------------------------------------------------ layout
  resize() {
    const r = this.canvas.getBoundingClientRect();
    if (!r.width) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.dpr = dpr;
    this.canvas.width = r.width * dpr; this.canvas.height = r.height * dpr;
    const res = this.getReserved();
    const pad = 8;
    const availW = r.width - res.left - res.right - 2 * pad;
    const availH = r.height - res.top - res.bottom - 2 * pad;
    const cellPx = Math.max(12, Math.min(availW / COLS, availH / ROWS));
    this.cellPx = cellPx * dpr;
    this.originX = (res.left + pad + (availW - cellPx * COLS) / 2) * dpr;
    this.originY = (res.top + pad + (availH - cellPx * ROWS) / 2) * dpr;
    this.draw();
  }

  /** Grid cell under a client (screen) position, or null if outside the grid. */
  cellAt(clientX, clientY) {
    const r = this.canvas.getBoundingClientRect();
    const x = ((clientX - r.left) * this.dpr - this.originX) / this.cellPx;
    const y = ((clientY - r.top) * this.dpr - this.originY) / this.cellPx;
    const c = Math.floor(x), row = Math.floor(y);
    if (c < 0 || row < 0 || c >= COLS || row >= ROWS) return null;
    return { c, r: row };
  }

  tileAt(c, r) { return this.tiles.find(t => t.c === c && t.r === r); }

  // ------------------------------------------------------------ input
  startDrag(tile, e, fromGrid) {
    this.drag = { tile, x: e.clientX, y: e.clientY, fromGrid };
    this.draw();
  }

  canvasDown(e) {
    e.preventDefault();
    const cell = this.cellAt(e.clientX, e.clientY);
    if (!cell) return;
    const t = this.tileAt(cell.c, cell.r);
    if (this.mode === 'delete') {
      if (t) { this.remove(t); this.changed(); }
      return;
    }
    if (t) this.press = { tile: t, x: e.clientX, y: e.clientY };
    else this.place({ type: this.selected, rot: this.lastRot(this.selected) }, cell);
  }

  pointerMove(e) {
    if (this.press && !this.drag) {
      if (Math.hypot(e.clientX - this.press.x, e.clientY - this.press.y) > DRAG_THRESHOLD) {
        const t = this.press.tile;
        this.remove(t);
        this.press = null;
        this.startDrag(t, e, true);
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
      // Tap on a placed piece: rotate it
      const t = this.press.tile;
      t.rot = (t.rot + 1) % 4;
      this._rot = { ...this._rot, [t.type]: t.rot };
      this.press = null;
      this.changed();
      return;
    }
    if (!this.drag) return;
    const cell = this.cellAt(e.clientX, e.clientY);
    const d = this.drag;
    this.drag = null;
    if (cell) this.place({ type: d.tile.type, rot: d.tile.rot }, cell);
    else this.draw(); // dropped outside the grid: piece is removed
  }

  lastRot(type) { return (this._rot && this._rot[type]) || 0; }

  place(piece, cell) {
    const old = this.tileAt(cell.c, cell.r);
    if (old) this.remove(old);
    if (piece.type === 'start') this.tiles = this.tiles.filter(t => t.type !== 'start'); // only one start
    this.tiles.push({ ...piece, c: cell.c, r: cell.r });
    this.changed();
  }

  remove(t) { this.tiles = this.tiles.filter(x => x !== t); }

  setTiles(tiles, width) {
    this.tiles = tiles.map(t => ({ ...t }));
    if (width) this.width = width;
    this.changed();
  }

  setWidth(w) { this.width = w; this.buildPalette(); this.changed(); }

  changed() {
    this.result = traceLayout(this.tiles);
    this.preview = null;
    if (this.result.ok) {
      try { this.preview = new Track(this.result.points, this.width, { polyline: true }); } catch { this.preview = null; }
    }
    this.draw();
    this.onChange(this);
  }

  get valid() { return !!this.preview; }

  // ------------------------------------------------------------ drawing
  draw() {
    const ctx = this.ctx, W = this.canvas.width, H = this.canvas.height, s = this.cellPx;
    if (!s) return;
    ctx.fillStyle = '#4f8a33'; ctx.fillRect(0, 0, W, H);
    const ox = this.originX, oy = this.originY;
    ctx.fillStyle = '#5f9e3f'; ctx.fillRect(ox, oy, s * COLS, s * ROWS);
    ctx.strokeStyle = 'rgba(255,255,255,0.13)'; ctx.lineWidth = 1;
    for (let c = 0; c <= COLS; c++) { ctx.beginPath(); ctx.moveTo(ox + c * s, oy); ctx.lineTo(ox + c * s, oy + ROWS * s); ctx.stroke(); }
    for (let r = 0; r <= ROWS; r++) { ctx.beginPath(); ctx.moveTo(ox, oy + r * s); ctx.lineTo(ox + COLS * s, oy + r * s); ctx.stroke(); }

    const scale = s / CELL;
    const inLoop = new Set((this.result.order || []).map(o => o.tile));
    for (const t of this.tiles) {
      const cx = ox + (t.c + 0.5) * s, cy = oy + (t.r + 0.5) * s;
      if (this.result.ok && inLoop.has(t)) { ctx.fillStyle = 'rgba(56,224,123,0.12)'; ctx.fillRect(cx - s / 2, cy - s / 2, s, s); }
      drawPiece(ctx, t, cx, cy, scale, this.width, !this.result.ok || inLoop.has(t) ? 1 : 0.5);
      if (this.mode === 'delete') {
        ctx.strokeStyle = 'rgba(255,59,92,0.8)'; ctx.lineWidth = 2 * this.dpr;
        ctx.strokeRect(cx - s / 2 + 2, cy - s / 2 + 2, s - 4, s - 4);
      }
    }

    // Driving direction arrows along a valid loop
    if (this.result.ok) {
      ctx.fillStyle = 'rgba(255,192,46,0.9)';
      for (const { tile, from, to } of this.result.order) {
        const p = localPath(tile.type, tile.rot, from, to, 8);
        const a = p[3], b = p[5];
        const cx = ox + (tile.c + 0.5) * s, cy = oy + (tile.r + 0.5) * s;
        const ax = cx + a.x * scale, ay = cy + a.z * scale, bx = cx + b.x * scale, by = cy + b.z * scale;
        const ang = Math.atan2(by - ay, bx - ax), L = s * 0.12;
        const mx = (ax + bx) / 2, my = (ay + by) / 2;
        ctx.beginPath();
        ctx.moveTo(mx + Math.cos(ang) * L, my + Math.sin(ang) * L);
        ctx.lineTo(mx + Math.cos(ang + 2.5) * L, my + Math.sin(ang + 2.5) * L);
        ctx.lineTo(mx + Math.cos(ang - 2.5) * L, my + Math.sin(ang - 2.5) * L);
        ctx.fill();
      }
    }

    // Error marker
    const err = this.result.error;
    if (err && err.c !== undefined) {
      const ex = ox + err.c * s, ey = oy + err.r * s;
      ctx.strokeStyle = '#ff3b5c'; ctx.lineWidth = 3 * this.dpr;
      ctx.setLineDash([6 * this.dpr, 4 * this.dpr]);
      ctx.strokeRect(ex + 3, ey + 3, s - 6, s - 6);
      ctx.setLineDash([]);
    }

    // Piece being dragged (snapped preview + floating ghost)
    if (this.drag) {
      const cell = this.cellAt(this.drag.x, this.drag.y);
      if (cell) {
        ctx.fillStyle = 'rgba(255,255,255,0.18)';
        ctx.fillRect(ox + cell.c * s, oy + cell.r * s, s, s);
        drawPiece(ctx, this.drag.tile, ox + (cell.c + 0.5) * s, oy + (cell.r + 0.5) * s, scale, this.width, 0.55);
      }
      const r = this.canvas.getBoundingClientRect();
      const gx = (this.drag.x - r.left) * this.dpr, gy = (this.drag.y - r.top) * this.dpr;
      drawPiece(ctx, this.drag.tile, gx, gy - s * 0.4, scale, this.width, cell ? 0.35 : 0.9);
      if (!cell && this.drag.fromGrid) {
        ctx.fillStyle = '#ff3b5c'; ctx.font = `${13 * this.dpr}px system-ui`; ctx.textAlign = 'center';
        ctx.fillText('release to remove', gx, gy + s * 0.35);
      }
    }
  }
}

/** Draw one piece centred at (cx, cy) in canvas pixels; `scale` is px per metre. */
export function drawPiece(ctx, tile, cx, cy, scale, width, alpha = 1) {
  const [a, b] = connections(tile.type, tile.rot);
  const pts = localPath(tile.type, tile.rot, a, b, 16);
  const end = localPath(tile.type, tile.rot, b, a, 16)[0];
  pts.push(end);
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.lineCap = 'butt'; ctx.lineJoin = 'round';
  const path = () => { ctx.beginPath(); pts.forEach((p, i) => { const x = cx + p.x * scale, y = cy + p.z * scale; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); };
  path(); ctx.strokeStyle = '#e8e8e8'; ctx.lineWidth = (width + 2.4) * scale; ctx.stroke();
  path(); ctx.strokeStyle = '#3b3f45'; ctx.lineWidth = width * scale; ctx.stroke();
  path(); ctx.strokeStyle = 'rgba(255,255,255,0.45)'; ctx.lineWidth = Math.max(1, 0.4 * scale); ctx.setLineDash([3 * scale, 3 * scale]); ctx.stroke(); ctx.setLineDash([]);
  if (tile.type === 'start') {
    // checkered start line across the middle of the piece
    const m = pts[8], n = pts[9];
    const dx = n.x - m.x, dz = n.z - m.z, L = Math.hypot(dx, dz) || 1;
    const nx = -dz / L, nz = dx / L, hw = width / 2, sq = width / 6;
    for (let i = 0; i < 6; i++) for (let j = 0; j < 2; j++) {
      ctx.fillStyle = (i + j) % 2 ? '#111' : '#fff';
      const ox = m.x + nx * (-hw + i * sq) + (dx / L) * (j * sq * 0.6 - sq * 0.6);
      const oz = m.z + nz * (-hw + i * sq) + (dz / L) * (j * sq * 0.6 - sq * 0.6);
      ctx.save();
      ctx.translate(cx + ox * scale, cy + oz * scale);
      ctx.rotate(Math.atan2(nz, nx));
      ctx.fillRect(0, 0, sq * scale, sq * 0.6 * scale);
      ctx.restore();
    }
    // direction arrow
    const tip = pts[13], base = pts[11];
    const ang = Math.atan2(tip.z - base.z, tip.x - base.x), L2 = width * 0.35 * scale;
    const tx = cx + tip.x * scale, ty = cy + tip.z * scale;
    ctx.fillStyle = '#ffc02e';
    ctx.beginPath();
    ctx.moveTo(tx + Math.cos(ang) * L2, ty + Math.sin(ang) * L2);
    ctx.lineTo(tx + Math.cos(ang + 2.4) * L2, ty + Math.sin(ang + 2.4) * L2);
    ctx.lineTo(tx + Math.cos(ang - 2.4) * L2, ty + Math.sin(ang - 2.4) * L2);
    ctx.fill();
  }
  ctx.restore();
}
