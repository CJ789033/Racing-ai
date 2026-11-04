// Drag-and-drop grid editor for track pieces and obstacles.
//  - drag a piece from the palette onto the grid (or select it, then tap empty cells)
//  - tap a placed piece to select it and edit its properties
//  - tap the selected piece again to rotate it; drag a piece to move it,
//    drag it off the grid to remove it
//  - drag an obstacle from the palette onto a piece
//  - bridge decks can pass over other pieces (tap twice to pick the one underneath)
import { Track } from '../sim/track.js';
import {
  CELL, COLS, ROWS, DIR, opp, PIECES, PALETTE, OBSTACLE_TYPES, OBSTACLE_ORDER, LANES,
  pieceGeometry, footprint, fitsGrid, traceLayout, paramValue, obstacleParam, clashes, canHoldObstacle,
  setGridSize, shiftTiles,
} from '../sim/tiles.js';
import { obstacleLayout } from '../sim/obstacles.js';

const DRAG_THRESHOLD = 8;
const TABS = [['road', 'Road'], ['junctions', 'Junctions'], ['obstacles', 'Obstacles']];

export class TileEditor {
  constructor(canvas, palette, panel, { onChange, getReserved, onMessage } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.palette = palette;
    this.panel = panel;
    this.tiles = [];
    this.width = 12;
    this.mode = 'place'; // place | delete | select
    this.multi = new Set(); // bulk selection (select mode)
    this.box = null;        // selection rectangle being dragged
    this.tab = 'road';
    this.paletteSel = { kind: 'piece', type: 'straight', key: 'piece:Straight', tile: { type: 'straight' } };
    this.selected = null;
    this.drag = null;
    this.press = null;
    this.onChange = onChange || (() => {});
    this.onMessage = onMessage || (() => {});
    this.getReserved = getReserved || (() => ({ top: 0, bottom: 0, left: 0, right: 0 }));
    this.result = { ok: false, order: [] };
    this.preview = null;

    canvas.addEventListener('pointerdown', e => this.canvasDown(e));
    // mouse wheel over a piece rotates it (phones have no wheel, so scrolling never rotates there)
    canvas.addEventListener('wheel', e => this.wheel(e), { passive: false });
    this._wheelAcc = 0;
    // view: zoom (1 = whole grid fits) and pan offset in canvas px
    this.zoom = 1; this.panX = 0; this.panY = 0;
    this.pointers = new Map(); // active touches/pointers on the canvas (for pinch)
    this.pinch = null; this.panDrag = null; this.emptyPress = null;
    canvas.addEventListener('contextmenu', e => e.preventDefault()); // right-drag pans
    window.addEventListener('pointermove', e => this.pointerMove(e));
    window.addEventListener('pointerup', e => this.pointerUp(e));
    window.addEventListener('pointercancel', e => {
      this.pointers.delete(e.pointerId);
      this.drag = null; this.press = null; this.panDrag = null; this.emptyPress = null;
      if (this.pointers.size < 2) this.pinch = null;
      this.draw();
    });
    window.addEventListener('resize', () => this.resize());
    window.addEventListener('keydown', e => this.keyDown(e));
    this.buildPalette();
    this.renderPanel();
  }

  // ------------------------------------------------------------ palette
  buildPalette() {
    this.palette.innerHTML = '';
    const tabs = document.createElement('div'); tabs.className = 'paletteTabs';
    for (const [id, label] of TABS) {
      const b = document.createElement('button');
      b.textContent = label;
      b.classList.toggle('active', this.tab === id);
      b.onclick = () => { this.tab = id; this.buildPalette(); this.getReserved(); this.resize(); };
      tabs.appendChild(b);
    }
    this.palette.appendChild(tabs);
    const grid = document.createElement('div'); grid.className = 'paletteGrid' + (this.tab === 'road' ? '' : ' many');
    this.palette.appendChild(grid);
    this.paletteItems = [];
    const add = (kind, key, label, start, drawIcon) => {
      const item = document.createElement('div');
      item.className = 'paletteItem';
      const cv = document.createElement('canvas');
      cv.width = cv.height = 96;
      item.appendChild(cv);
      const lbl = document.createElement('small'); lbl.textContent = label; item.appendChild(lbl);
      const ctx = cv.getContext('2d');
      ctx.fillStyle = '#5f9e3f'; ctx.fillRect(0, 0, 96, 96);
      drawIcon(ctx);
      item.addEventListener('pointerdown', e => {
        e.preventDefault();
        this.paletteSel = { kind, key, ...start };
        this.syncPalette();
        if (kind === 'piece') this.startDrag({ kind, tile: { ...start.tile, rot: 0, c: 0, r: 0 }, grab: { dc: 0, dr: 0 } }, e);
        else this.startDrag({ kind, type: start.type }, e);
      });
      item.dataset.key = key;
      grid.appendChild(item);
      this.paletteItems.push(item);
    };
    if (this.tab === 'obstacles') {
      for (const type of OBSTACLE_ORDER) {
        add('obstacle', 'obstacle:' + type, OBSTACLE_TYPES[type].label, { type }, ctx => {
          const t = { type: 'straight', rot: 0, c: 0, r: 0 };
          drawTile(ctx, t, iconMap(t), 96 / CELL, this.width, 1);
          ctx.font = '50px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.fillText(OBSTACLE_TYPES[type].icon, 48, 52);
        });
      }
    } else {
      for (const entry of PALETTE[this.tab]) {
        const label = entry.label || PIECES[entry.type].label;
        const tile = { type: entry.type, ...(entry.extra || {}) };
        add('piece', 'piece:' + label, label, { type: entry.type, tile }, ctx => {
          const t = { ...tile, rot: 0, c: 0, r: 0 };
          const g = pieceGeometry(t);
          const k = 96 / CELL / Math.max(g.w, g.h);
          drawTile(ctx, t, iconMap(t), k, this.width, 1);
        });
      }
    }
    this.syncPalette();
  }

  syncPalette() {
    for (const el of this.paletteItems) el.classList.toggle('active', el.dataset.key === this.paletteSel.key);
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
    this.fitCell = Math.max(10, Math.min(availW / COLS, availH / ROWS)) * dpr;
    this.viewCenter = { x: (res.left + pad + availW / 2) * dpr, y: (res.top + pad + availH / 2) * dpr };
    this.viewArea = { x0: (res.left + pad) * dpr, y0: (res.top + pad) * dpr, x1: (res.left + pad + availW) * dpr, y1: (res.top + pad + availH) * dpr };
    this.applyView();
  }

  // ------------------------------------------------------------ camera (zoom + pan)
  applyView() {
    this.cellPx = this.fitCell * this.zoom;
    const gw = COLS * this.cellPx, gh = ROWS * this.cellPx, A = this.viewArea, m = 60 * this.dpr;
    // keep at least a strip of the grid on screen
    const minX = A.x0 + m - gw, maxX = A.x1 - m, minY = A.y0 + m - gh, maxY = A.y1 - m;
    let ox = this.viewCenter.x - gw / 2 + this.panX, oy = this.viewCenter.y - gh / 2 + this.panY;
    ox = Math.max(minX, Math.min(maxX, ox)); oy = Math.max(minY, Math.min(maxY, oy));
    this.panX = ox - (this.viewCenter.x - gw / 2); this.panY = oy - (this.viewCenter.y - gh / 2);
    this.originX = ox; this.originY = oy;
    this.draw();
  }

  /** Zoom by factor f around canvas point (px, py). */
  zoomAt(px, py, f) {
    const z = Math.max(0.6, Math.min(6, this.zoom * f));
    const k = z / this.zoom;
    if (k === 1) return;
    const ox = px - (px - this.originX) * k, oy = py - (py - this.originY) * k;
    this.zoom = z;
    const cell = this.fitCell * z;
    this.panX = ox - (this.viewCenter.x - COLS * cell / 2);
    this.panY = oy - (this.viewCenter.y - ROWS * cell / 2);
    this.applyView();
  }

  zoomBy(f) { if (this.viewCenter) this.zoomAt(this.viewCenter.x, this.viewCenter.y, f); }
  fitView() { this.zoom = 1; this.panX = 0; this.panY = 0; if (this.viewCenter) this.applyView(); }
  panBy(dx, dy) { this.panX += dx; this.panY += dy; this.applyView(); }

  canvasPoint(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) * this.dpr, y: (e.clientY - r.top) * this.dpr };
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

  tilesAt(c, r) { return this.tiles.filter(t => footprint(t).some(f => f.c === c && f.r === r)); }

  /** The piece a tap on (c,r) means: the bridge on top first, the one underneath on the next tap. */
  tileAt(c, r) {
    const list = this.tilesAt(c, r);
    if (list.length < 2) return list[0] || null;
    if (this.selected && list.includes(this.selected)) return list.find(t => t !== this.selected);
    const layerOf = t => footprint(t).find(f => f.c === c && f.r === r).layer;
    return list.reduce((a, b) => (layerOf(b) > layerOf(a) ? b : a)); // top-most first
  }

  overlapping(tile, ignore = null) {
    return this.tiles.filter(t => t !== tile && t !== ignore && clashes(t, tile));
  }

  /** Is there a road end of another piece facing this port? */
  portLinked(t, p) {
    const nc = p.c + DIR[p.e][0], nr = p.r + DIR[p.e][1];
    return this.tiles.some(o => o !== t && pieceGeometry(o).ports.some(q => q.c === nc && q.r === nr && q.e === opp(p.e)));
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

  // ------------------------------------------------------------ rotation (handle + wheel)
  /** Canvas-px position of the selected piece's centre and its rotation handle. */
  rotationHandle(t = this.selected) {
    if (!t || this.mode !== 'place') return null;
    const g = pieceGeometry(t), s = this.cellPx;
    const cx = this.originX + (t.c + g.w / 2) * s, cy = this.originY + (t.r + g.h / 2) * s;
    const a = (t.rot % 4) * Math.PI / 2; // 0 = up, clockwise
    const L = Math.max(g.w, g.h) * s / 2 + Math.max(0.55 * s, 22 * this.dpr);
    return { cx, cy, hx: cx + Math.sin(a) * L, hy: cy - Math.cos(a) * L, L };
  }

  /** Snap the pointer's direction around the piece centre to a quarter turn. */
  rotFromPointer(e) {
    const h = this.rotationHandle(this.rotDrag.tile);
    const r = this.canvas.getBoundingClientRect();
    const px = (e.clientX - r.left) * this.dpr, py = (e.clientY - r.top) * this.dpr;
    const a = Math.atan2(px - h.cx, -(py - h.cy));
    return { k: ((Math.round(a / (Math.PI / 2)) % 4) + 4) % 4, px, py };
  }

  wheel(e) {
    e.preventDefault(); // never scroll the page
    const cell = this.cellAt(e.clientX, e.clientY);
    const t = this.selected;
    const overSelected = t && cell && footprint(t).some(f => f.c === cell.c && f.r === cell.r);
    // wheel over the selected piece rotates it; anywhere else (or pinch/ctrl+wheel) zooms
    if (!overSelected || this.mode !== 'place' || e.ctrlKey) {
      const p = this.canvasPoint(e);
      const dy = e.deltaMode === 1 ? e.deltaY * 30 : e.deltaY;
      this.zoomAt(p.x, p.y, Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0015)));
      return;
    }
    this._wheelAcc += e.deltaY;
    if (Math.abs(this._wheelAcc) < 40) return; // one turn per wheel notch
    const dir = this._wheelAcc > 0 ? 1 : 3;
    this._wheelAcc = 0;
    this.modify(t, { rot: (t.rot + dir) % 4 });
  }

  canvasDown(e) {
    e.preventDefault();
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pointers.size === 2) {
      // second finger: pinch to zoom / two-finger pan; cancel whatever the first finger started
      this.press = null; this.drag = null; this.box = null; this.rotDrag = null; this.emptyPress = null; this.panDrag = null;
      const [a, b] = [...this.pointers.values()];
      this.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
      this.draw();
      return;
    }
    if (this.pointers.size > 2) return;
    if (e.button === 1 || e.button === 2) { this.panDrag = { x: e.clientX, y: e.clientY }; return; } // middle / right drag pans
    // grab the rotation handle of the selected piece?
    const h = this.rotationHandle();
    if (h) {
      const r = this.canvas.getBoundingClientRect();
      const px = (e.clientX - r.left) * this.dpr, py = (e.clientY - r.top) * this.dpr;
      if (Math.hypot(px - h.hx, py - h.hy) < 24 * this.dpr) {
        this.rotDrag = { tile: this.selected, x: px, y: py };
        this.canvas.setPointerCapture?.(e.pointerId);
        this.draw();
        return;
      }
    }
    const cell = this.cellAt(e.clientX, e.clientY);
    if (!cell) { this.emptyPress = { x: e.clientX, y: e.clientY, cell: null }; return; } // tap = deselect, drag = pan
    const t = this.tileAt(cell.c, cell.r);
    if (this.mode === 'delete') {
      if (t) { this.remove(t); this.changed(); }
      else this.emptyPress = { x: e.clientX, y: e.clientY, cell: null, noop: true };
      return;
    }
    if (this.mode === 'paint') { this.startPaint(cell); return; }
    if (this.mode === 'select') {
      // press on a selected piece: tap = deselect, drag = move the group;
      // anywhere else: tap = toggle that piece, drag = selection box
      const hit = this.tilesAt(cell.c, cell.r).find(x => this.multi.has(x));
      this.press = { tile: hit || t, x: e.clientX, y: e.clientY, cell, group: !!hit };
      return;
    }
    if (t) { this.press = { tile: t, x: e.clientX, y: e.clientY, cell }; return; }
    // empty grass: a tap places the selected piece (or closes the panel), a drag moves the view
    this.emptyPress = { x: e.clientX, y: e.clientY, cell };
  }

  /** What a plain tap on empty grass does. */
  emptyTap(p) {
    if (p.noop) return;
    if (!p.cell || this.selected) { this.select(null); return; }
    if (this.paletteSel.kind === 'piece') {
      const tile = this.clampToGrid({ ...(this.paletteSel.tile || { type: this.paletteSel.type }), rot: 0, c: p.cell.c, r: p.cell.r });
      this.place(tile);
    } else this.onMessage('Drag obstacles onto a track piece');
  }

  pointerMove(e) {
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pinch) {
      if (this.pointers.size < 2) return;
      const [a, b] = [...this.pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const r = this.canvas.getBoundingClientRect();
      this.panBy((mx - this.pinch.mx) * this.dpr, (my - this.pinch.my) * this.dpr);
      if (this.pinch.d > 10) this.zoomAt((mx - r.left) * this.dpr, (my - r.top) * this.dpr, d / this.pinch.d);
      this.pinch = { d, mx, my };
      return;
    }
    if (this.emptyPress && !this.panDrag && Math.hypot(e.clientX - this.emptyPress.x, e.clientY - this.emptyPress.y) > DRAG_THRESHOLD) {
      this.panDrag = { x: this.emptyPress.x, y: this.emptyPress.y };
      this.emptyPress = null;
    }
    if (this.panDrag) {
      this.panBy((e.clientX - this.panDrag.x) * this.dpr, (e.clientY - this.panDrag.y) * this.dpr);
      this.panDrag.x = e.clientX; this.panDrag.y = e.clientY;
      return;
    }
    if (this.paint) {
      const cell = this.cellAt(e.clientX, e.clientY);
      if (cell) this.paintTo(cell);
      return;
    }
    if (this.rotDrag) {
      const { k, px, py } = this.rotFromPointer(e);
      this.rotDrag.x = px; this.rotDrag.y = py;
      if (k !== this.rotDrag.tile.rot && this.rotDrag.failed !== k) {
        if (!this.modify(this.rotDrag.tile, { rot: k })) this.rotDrag.failed = k;
      }
      this.draw();
      return;
    }
    if (this.press && this.mode === 'select' && !this.drag && !this.box) {
      if (Math.hypot(e.clientX - this.press.x, e.clientY - this.press.y) > DRAG_THRESHOLD) {
        if (this.press.group) this.startDrag({ kind: 'group', tiles: [...this.multi], from: this.press.cell }, e);
        else this.box = { x0: this.press.x, y0: this.press.y, x1: e.clientX, y1: e.clientY };
        this.press = null;
      }
      return;
    }
    if (this.box) { this.box.x1 = e.clientX; this.box.y1 = e.clientY; this.draw(); return; }
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
    this.pointers.delete(e.pointerId);
    if (this.pinch) { if (this.pointers.size === 0) this.pinch = null; return; } // ignore the rest of a pinch
    if (this.panDrag) { this.panDrag = null; return; }
    if (this.paint) { this.paint = null; for (const t of this.tiles) delete t._painted; this.changed(); return; }
    if (this.emptyPress) { const p = this.emptyPress; this.emptyPress = null; this.emptyTap(p); return; }
    if (this.rotDrag) { this.rotDrag = null; this.draw(); return; }
    if (this.box) {
      const a = this.cellAtClamped(this.box.x0, this.box.y0), b = this.cellAtClamped(this.box.x1, this.box.y1);
      const c0 = Math.min(a.c, b.c), c1 = Math.max(a.c, b.c), r0 = Math.min(a.r, b.r), r1 = Math.max(a.r, b.r);
      for (const t of this.tiles) if (footprint(t).some(f => f.c >= c0 && f.c <= c1 && f.r >= r0 && f.r <= r1)) this.multi.add(t);
      this.box = null;
      this.bulkChanged();
      return;
    }
    if (this.press && this.mode === 'select') {
      const t = this.press.tile;
      this.press = null;
      if (t) { if (this.multi.has(t)) this.multi.delete(t); else this.multi.add(t); }
      else this.multi.clear(); // tap on empty grass
      this.bulkChanged();
      return;
    }
    if (this.drag && this.drag.kind === 'group') {
      const d = this.drag, cell = this.cellAt(e.clientX, e.clientY);
      this.drag = null;
      if (!cell) { this.onMessage('Drop the selection on the grid (use 🗑️ to delete it)'); this.draw(); return; }
      this.moveGroup(d.tiles, cell.c - d.from.c, cell.r - d.from.r, true);
      return;
    }
    if (this.press) {
      const t = this.press.tile, stacked = this.tilesAt(this.press.cell.c, this.press.cell.r).length > 1;
      this.press = null;
      if (this.selected === t && !stacked) this.rotate(t);
      else this.select(t);
      return;
    }
    if (!this.drag) return;
    const d = this.drag;
    this.drag = null;
    const cell = this.cellAt(e.clientX, e.clientY);
    if (d.kind === 'obstacle') {
      const list = cell ? this.tilesAt(cell.c, cell.r) : [];
      const t = list.find(canHoldObstacle);
      if (!t) {
        this.draw();
        if (cell) this.onMessage(list.length ? 'Obstacles go on plain road pieces (not the Start or junctions)' : 'Drop obstacles onto a track piece');
        return;
      }
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

  place(tile, { quiet = false } = {}) {
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
   * doesn't fit, try shifting the piece, preferring positions that keep its
   * connected ends where they were.
   */
  modify(t, changes) {
    const old = { ...t };
    const linked = pieceGeometry(t).ports.filter(p => this.portLinked(t, p));
    Object.assign(t, changes);
    const g = pieceGeometry(t);
    const candidates = [];
    const span = Math.max(g.w, g.h) + 1;
    for (let dy = -span; dy <= span; dy++) for (let dx = -span; dx <= span; dx++) candidates.push({ c: old.c + dx, r: old.r + dy });
    const score = p => {
      const probe = { ...t, ...p };
      const ports = pieceGeometry(probe).ports;
      const kept = linked.filter(l => ports.some(q => q.c === l.c && q.r === l.r && q.e === l.e)).length;
      const cover = footprint(probe).some(f => f.c === old.c && f.r === old.r);
      return -kept * 100 + (cover ? 0 : 50) + Math.abs(p.c - old.c) + Math.abs(p.r - old.r);
    };
    candidates.sort((a, b) => score(a) - score(b));
    for (const p of candidates) {
      Object.assign(t, p);
      if (fitsGrid(t) && this.overlapping(t).length === 0) { this.changed(); return true; }
    }
    for (const k of Object.keys(changes)) if (!(k in old)) delete t[k];
    Object.assign(t, old);
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

  // ------------------------------------------------------------ drag place (paint)
  /**
   * Paint mode: drag across the grid to place pieces. With a Straight / Tunnel /
   * Corner selected it lays a connected road (straights and corners chosen
   * automatically from the drag direction); other pieces are stamped into every
   * free spot the drag passes over.
   */
  startPaint(cell) {
    if (this.paletteSel.kind !== 'piece') { this.onMessage('Pick a road piece to paint with'); return; }
    const base = this.paletteSel.tile || { type: this.paletteSel.type };
    const road = base.type === 'straight' || base.type === 'corner';
    this.paint = { base, road, cells: [cell], dirs: [null], stamped: new Set() };
    if (road) {
      // starting right next to the open end of a road? line the first piece up with it
      for (const t of this.tiles) for (const pt of pieceGeometry(t).ports) {
        if (pt.c + DIR[pt.e][0] === cell.c && pt.r + DIR[pt.e][1] === cell.r) this.paint.dirs[0] = pt.e;
      }
    }
    if (road) this.placeRoadCell(0);
    else this.stampAt(cell);
    this.changed({ panel: false });
  }

  paintTo(cell) {
    const P = this.paint;
    if (P.stopped) return;
    let last = P.cells[P.cells.length - 1];
    if (cell.c === last.c && cell.r === last.r) return;
    // walk cell by cell (no diagonal jumps) towards the pointer
    let guard = 0;
    while ((cell.c !== last.c || cell.r !== last.r) && guard++ < 50) {
      const dc = Math.sign(cell.c - last.c), dr = Math.sign(cell.r - last.r);
      const next = Math.abs(cell.c - last.c) >= Math.abs(cell.r - last.r) ? { c: last.c + dc, r: last.r } : { c: last.c, r: last.r + dr };
      const prev = P.cells[P.cells.length - 2];
      if (prev && prev.c === next.c && prev.r === next.r) { // dragged back: undo the last cell
        P.cells.pop(); P.dirs.pop();
        if (P.road) { const t = this.tilesAt(last.c, last.r).find(x => x._painted); if (t) this.remove(t); this.placeRoadCell(P.cells.length - 1); }
        last = next; continue;
      }
      const heading = DIR.findIndex(([x, z]) => x === next.c - last.c && z === next.r - last.r); // heading into `next`
      if (P.road && this.tilesAt(next.c, next.r).some(x => !x._painted)) {
        // ran into an existing piece (e.g. the Start): join the road to it and stop painting
        P.dirs.push(heading); P.cells.push(next);
        this.placeRoadCell(P.cells.length - 2);
        P.cells.pop(); P.dirs.pop();
        P.stopped = true;
        break;
      }
      P.cells.push(next);
      P.dirs.push(heading);
      if (P.road) { this.placeRoadCell(P.cells.length - 2); this.placeRoadCell(P.cells.length - 1); }
      else this.stampAt(next);
      last = next;
    }
    this.changed({ panel: false });
  }

  /** (Re)place the road piece for path cell i from the directions in and out of it. */
  placeRoadCell(i) {
    const P = this.paint, cell = P.cells[i];
    const inDir = P.dirs[i], outDir = P.dirs[i + 1] ?? null;
    const edges = [];
    if (inDir !== null) edges.push(opp(inDir));   // edge back towards the previous cell
    if (outDir !== null) edges.push(outDir);      // edge towards the next cell
    const type = edges.length === 2 && opp(edges[0]) !== edges[1] ? 'corner' : 'straight';
    const extra = P.base.tunnel ? { tunnel: 1 } : {};
    let tile = null;
    for (let rot = 0; rot < 4 && !tile; rot++) {
      const t = { type, rot, c: cell.c, r: cell.r, ...extra };
      const pe = pieceGeometry(t).ports.map(p => p.e);
      if (edges.every(e => pe.includes(e)) && (edges.length || rot === 0)) tile = t;
    }
    if (!tile) return;
    tile._painted = true;
    const old = this.tilesAt(cell.c, cell.r).find(x => x._painted);
    if (old) this.remove(old);
    this.place(tile, { quiet: true });
  }

  stampAt(cell) {
    const P = this.paint;
    if (this.tilesAt(cell.c, cell.r).length) return; // stamp only into free space
    const t = this.clampToGrid({ ...P.base, rot: 0, c: cell.c, r: cell.r });
    if (this.overlapping(t).length) return;
    this.place(t, { quiet: true });
  }

  // ------------------------------------------------------------ copy / paste
  copySelection() {
    const src = this.mode === 'select' ? [...this.multi] : this.selected ? [this.selected] : [];
    if (!src.length) { this.onMessage('Select something to copy first'); return; }
    this.clipboard = src.map(t => JSON.parse(JSON.stringify(t, (k, v) => (k === '_painted' ? undefined : v))));
    this.onMessage(`Copied ${src.length} piece${src.length > 1 ? 's' : ''}`);
    this.renderPanel();
  }

  /** Paste the clipboard in the nearest free spot and select the copies so they can be dragged into place. */
  paste() {
    if (!this.clipboard || !this.clipboard.length) { this.onMessage('Nothing copied yet'); return; }
    let items = this.clipboard.map(t => ({ ...t, obstacle: t.obstacle ? { ...t.obstacle } : undefined }));
    items.forEach(t => { if (!t.obstacle) delete t.obstacle; });
    if (this.tiles.some(t => t.type === 'start')) {
      const n = items.length; items = items.filter(t => t.type !== 'start');
      if (items.length < n) this.onMessage('Start piece skipped – a track can only have one');
      if (!items.length) return;
    }
    const tries = [];
    for (let rad = 1; rad <= Math.max(COLS, ROWS); rad++) for (let dy = -rad; dy <= rad; dy++) for (let dx = -rad; dx <= rad; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) === rad) tries.push([dx, dy]);
    }
    tries.sort((a, b) => Math.hypot(a[0] - 1, a[1] - 1) - Math.hypot(b[0] - 1, b[1] - 1)); // prefer just down-right
    for (const [dx, dy] of tries) {
      const moved = items.map(t => ({ ...t, c: t.c + dx, r: t.r + dy }));
      if (!moved.every(fitsGrid)) continue;
      if (this.tiles.some(o => moved.some(m => clashes(o, m)))) continue;
      if (moved.some((m, i) => moved.some((n, j) => j > i && clashes(m, n)))) continue;
      this.tiles.push(...moved);
      this.setMode('select');
      this.multi = new Set(moved);
      this.changed();
      this.onMessage(`Pasted ${moved.length} piece${moved.length > 1 ? 's' : ''} – drag them into place`);
      return;
    }
    this.onMessage('No free space to paste into');
  }

  // ------------------------------------------------------------ bulk selection
  setMode(mode) {
    this.mode = mode;
    this.paint = null;
    if (this.onModeChange) this.onModeChange(mode);
    if (mode !== 'select') this.multi.clear();
    this.selected = null;
    this.bulkChanged();
  }

  bulkChanged() {
    for (const t of [...this.multi]) if (!this.tiles.includes(t)) this.multi.delete(t);
    this.renderPanel();
    this.onChange(this);
    this.draw();
  }

  cellAtClamped(x, y) {
    const r = this.canvas.getBoundingClientRect();
    const c = Math.floor(((x - r.left) * this.dpr - this.originX) / this.cellPx);
    const row = Math.floor(((y - r.top) * this.dpr - this.originY) / this.cellPx);
    return { c: Math.max(0, Math.min(COLS - 1, c)), r: Math.max(0, Math.min(ROWS - 1, row)) };
  }

  /** Can the group be shifted by (dc, dr)? Returns the pieces it would land on. */
  groupClashes(group, dc, dr) {
    const moved = group.map(t => ({ ...t, c: t.c + dc, r: t.r + dr }));
    if (!moved.every(fitsGrid)) return null;
    const others = this.tiles.filter(t => !this.multi.has(t));
    return others.filter(o => moved.some(m => clashes(o, m)));
  }

  /** Move all selected pieces; dropping onto other pieces replaces them (drag) or is refused (nudge). */
  moveGroup(group, dc, dr, replace = false) {
    if (!dc && !dr) { this.draw(); return; }
    const hit = this.groupClashes(group, dc, dr);
    if (!hit) { this.onMessage('The selection would go off the grid'); this.draw(); return; }
    if (hit.length && !replace) { this.onMessage('Something is in the way'); this.draw(); return; }
    this.tiles = this.tiles.filter(t => !hit.includes(t));
    for (const t of group) { t.c += dc; t.r += dr; }
    if (hit.length) this.onMessage(`Replaced ${hit.length} piece${hit.length > 1 ? 's' : ''}`);
    this.changed();
  }

  deleteSelection() {
    const n = this.multi.size;
    if (!n) return;
    this.tiles = this.tiles.filter(t => !this.multi.has(t));
    this.multi.clear();
    this.onMessage(`Deleted ${n} piece${n > 1 ? 's' : ''}`);
    this.changed();
  }

  keyDown(e) {
    if (!this.canvas.offsetParent) return; // editor not on screen
    if (e.target && /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
    if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C')) { e.preventDefault(); this.copySelection(); return; }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'v' || e.key === 'V')) { e.preventDefault(); this.paste(); return; }
    if (this.mode !== 'select' || !this.multi.size) return;
    const k = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (k) { e.preventDefault(); this.moveGroup([...this.multi], k[0], k[1]); }
    else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); this.deleteSelection(); }
  }

  get panelOpen() { return !!this.selected || this.mode === 'select'; }

  setTiles(tiles, width) {
    this.tiles = tiles.map(t => ({ ...t, obstacle: t.obstacle ? { ...t.obstacle } : undefined }));
    this.tiles.forEach(t => { if (!t.obstacle) delete t.obstacle; });
    if (width) this.width = width;
    this.selected = null;
    this.multi.clear();
    this.changed();
  }

  setWidth(w) { this.width = w; this.buildPalette(); this.changed(); }

  /**
   * Change the grid size, keeping the layout centred. Pieces that would end
   * up off the grid are removed (after asking, unless `force`).
   * Returns false if the player cancelled.
   */
  /** How many pieces would fall off if the grid changed to cols x rows? */
  countLost(cols, rows) {
    const prev = { cols: COLS, rows: ROWS };
    const dc = Math.floor((cols - COLS) / 2), dr = Math.floor((rows - ROWS) / 2);
    setGridSize(cols, rows);
    const lost = shiftTiles(this.tiles, dc, dr).filter(t => !fitsGrid(t)).length;
    setGridSize(prev.cols, prev.rows);
    return lost;
  }

  setGridSize(cols, rows, { recenter = true, force = false } = {}) {
    if (cols === COLS && rows === ROWS) return true;
    const dc = recenter ? Math.floor((cols - COLS) / 2) : 0, dr = recenter ? Math.floor((rows - ROWS) / 2) : 0;
    const prev = { cols: COLS, rows: ROWS };
    setGridSize(cols, rows);
    const moved = shiftTiles(this.tiles, dc, dr);
    const keep = moved.filter(fitsGrid);
    const lost = moved.length - keep.length;
    if (lost && !force) { setGridSize(prev.cols, prev.rows); return false; } // caller asks the player first
    this.tiles = keep;
    this.selected = null;
    this.zoom = 1; this.panX = 0; this.panY = 0;
    this.resize();
    this.changed();
    if (lost) this.onMessage(`${lost} piece${lost > 1 ? 's' : ''} removed`);
    return true;
  }

  changed({ panel = true } = {}) {
    this.result = traceLayout(this.tiles);
    this.preview = null;
    if (this.result.ok) {
      try { this.preview = new Track(this.result.net, this.width); } catch { this.preview = null; }
    }
    if (panel) this.renderPanel();
    this.draw();
    this.onChange(this);
  }

  get valid() { return !!this.preview; }

  /** Is this piece driven backwards (port 1 -> port 0) in the current network? */
  isReversed(t) {
    const idx = this.result.tileEdge && this.result.tileEdge.get(t);
    return idx !== undefined && this.preview ? !this.preview.edgeForward[idx] : false;
  }

  // ------------------------------------------------------------ properties panel
  renderPanel() {
    const P = this.panel, t = this.selected;
    if (!P) return;
    if (this.mode === 'select') { this.renderBulkPanel(); return; }
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
    const note = text => { const d = document.createElement('div'); d.className = 'muted small'; d.textContent = text; P.appendChild(d); };
    P.innerHTML = '';
    const head = document.createElement('div'); head.className = 'propHead';
    head.innerHTML = `<b>${t.type === 'straight' && paramValue(t, 'tunnel') ? 'Tunnel' : def.label}</b>`;
    const close = document.createElement('button'); close.className = 'iconBtn'; close.textContent = '✕';
    close.onclick = () => this.select(null);
    head.appendChild(close);
    P.appendChild(head);
    if (def.desc) note(def.desc);

    for (const [name, pd] of Object.entries(def.params)) {
      P.appendChild(seg(pd.label, pd.options, paramValue(t, name), pd.names, v => this.modify(t, { [name]: v })));
    }
    if (t.type === 'corner') note(`Radius ${(paramValue(t, 'size') - 0.5) * CELL} m`);

    if (canHoldObstacle(t)) {
      const obsOpts = ['none', ...OBSTACLE_ORDER];
      const cur = t.obstacle ? t.obstacle.type : 'none';
      P.appendChild(seg('Obstacle', obsOpts, cur, obsOpts.map(o => o === 'none' ? '–' : OBSTACLE_TYPES[o].icon), v => {
        if (v === 'none') delete t.obstacle;
        else t.obstacle = { lane: 'center', pos: 0.5, ...(t.obstacle || {}), type: v };
        this.changed();
      }));
      if (t.obstacle) {
        const o = t.obstacle, ot = OBSTACLE_TYPES[o.type];
        note(ot.desc);
        for (const [name, pd] of Object.entries(ot.params)) {
          P.appendChild(seg(pd.label, pd.options, obstacleParam(o, name), pd.names, v => { o[name] = v; this.changed(); }));
        }
        if (!ot.noLane && obstacleParam(o, 'width') !== 'full') {
          P.appendChild(seg('Lane', LANES, o.lane, ['Left', 'Middle', 'Right'], v => { o.lane = v; this.changed(); }));
        }
        const row = document.createElement('label'); row.className = 'propRow';
        row.innerHTML = '<div class="propLabel">Position</div>';
        const inp = document.createElement('input');
        inp.type = 'range'; inp.min = 0.1; inp.max = 0.9; inp.step = 0.05; inp.value = o.pos;
        // update live while dragging, without rebuilding the panel (that would drop the drag)
        inp.oninput = () => { o.pos = Number(inp.value); this.changed({ panel: false }); };
        row.appendChild(inp);
        P.appendChild(row);
      }
    }

    const btns = document.createElement('div'); btns.className = 'propButtons';
    const rot = document.createElement('button'); rot.innerHTML = '⟳<small>Rotate</small>'; rot.onclick = () => this.rotate(t);
    const del = document.createElement('button'); del.innerHTML = '🗑️<small>Delete</small>';
    del.onclick = () => { this.remove(t); this.changed(); };
    const cp = document.createElement('button'); cp.innerHTML = '📋<small>Copy</small>'; cp.onclick = () => this.copySelection();
    btns.append(rot, cp, del);
    P.appendChild(btns);
    if (this.clipboard) {
      const ps = document.createElement('button'); ps.innerHTML = `📥<small>Paste (${this.clipboard.length})</small>`; ps.onclick = () => this.paste();
      const row = document.createElement('div'); row.className = 'propButtons'; row.appendChild(ps); P.appendChild(row);
    }
  }

  renderBulkPanel() {
    const P = this.panel, n = this.multi.size;
    P.classList.remove('empty');
    P.innerHTML = '';
    const head = document.createElement('div'); head.className = 'propHead';
    head.innerHTML = `<b>${n ? `${n} piece${n > 1 ? 's' : ''} selected` : 'Select pieces'}</b>`;
    const close = document.createElement('button'); close.className = 'iconBtn'; close.textContent = '✕';
    close.onclick = () => this.onExitSelect && this.onExitSelect();
    head.appendChild(close);
    P.appendChild(head);
    const note = document.createElement('div'); note.className = 'muted small';
    note.textContent = n ? 'Drag a selected piece to move them all, or nudge them with the arrows.' : 'Drag a box over pieces, or tap pieces to add/remove them.';
    P.appendChild(note);
    const btn = (html, fn, disabled) => { const b = document.createElement('button'); b.innerHTML = html; b.onclick = fn; b.disabled = !!disabled; if (disabled) b.style.opacity = 0.4; return b; };
    if (n) {
      const pad = document.createElement('div'); pad.className = 'nudge';
      const g = [...this.multi];
      pad.append(
        document.createElement('span'), btn('⬆️', () => this.moveGroup(g, 0, -1)), document.createElement('span'),
        btn('⬅️', () => this.moveGroup(g, -1, 0)), btn('⬇️', () => this.moveGroup(g, 0, 1)), btn('➡️', () => this.moveGroup(g, 1, 0)),
      );
      P.appendChild(pad);
    }
    const row = document.createElement('div'); row.className = 'propButtons';
    row.append(
      btn('☑️<small>Select all</small>', () => { this.tiles.forEach(t => this.multi.add(t)); this.bulkChanged(); }, !this.tiles.length),
      btn('⬚<small>None</small>', () => { this.multi.clear(); this.bulkChanged(); }, !n),
      btn('🗑️<small>Delete</small>', () => this.deleteSelection(), !n),
    );
    P.appendChild(row);
    const row2 = document.createElement('div'); row2.className = 'propButtons';
    row2.append(
      btn('📋<small>Copy</small>', () => this.copySelection(), !n),
      btn(`📥<small>Paste${this.clipboard ? ` (${this.clipboard.length})` : ''}</small>`, () => this.paste(), !this.clipboard),
    );
    P.appendChild(row2);
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

    const inNet = new Set(this.result.order || []);
    const alphaOf = t => (!this.result.ok || inNet.has(t) ? 1 : 0.5);
    for (const t of this.tiles) {
      const g = pieceGeometry(t);
      if (this.result.ok && inNet.has(t) && t.type !== 'bridge') { ctx.fillStyle = 'rgba(56,224,123,0.10)'; ctx.fillRect(ox + t.c * s, oy + t.r * s, g.w * s, g.h * s); }
    }
    // ground pieces first, bridges on top; within each layer all borders, then all tarmac, then details
    for (const group of [this.tiles.filter(t => t.type !== 'bridge'), this.tiles.filter(t => t.type === 'bridge')]) {
      for (const pass of ['shadow', 'border', 'asphalt', 'detail']) {
        for (const t of group) drawTile(ctx, t, map, k, this.width, alphaOf(t), this.isReversed(t), pass);
      }
      for (const t of group) {
        drawObstacle(ctx, t, map, k, this.width, this.isReversed(t), alphaOf(t), Math.max(16 * this.dpr, s * 0.38));
        if (this.mode === 'delete') {
          const g = pieceGeometry(t);
          ctx.strokeStyle = 'rgba(255,59,92,0.8)'; ctx.lineWidth = 2 * this.dpr;
          ctx.strokeRect(ox + t.c * s + 2, oy + t.r * s + 2, g.w * s - 4, g.h * s - 4);
        }
      }
    }
    if (this.selected) {
      const t = this.selected, g = pieceGeometry(t);
      ctx.strokeStyle = '#ff8a1f'; ctx.lineWidth = 3 * this.dpr;
      ctx.strokeRect(ox + t.c * s + 1.5, oy + t.r * s + 1.5, g.w * s - 3, g.h * s - 3);
      // rotation handle: a line from the centre to a dot you can drag around
      const h = this.rotationHandle();
      if (h) {
        const d = this.dpr, dragging = !!this.rotDrag;
        const ex = dragging ? this.rotDrag.x : h.hx, ey = dragging ? this.rotDrag.y : h.hy;
        if (dragging) { // faint guide circle with the four snap points
          ctx.strokeStyle = 'rgba(255,138,31,0.35)'; ctx.lineWidth = 1.5 * d; ctx.setLineDash([4 * d, 4 * d]);
          ctx.beginPath(); ctx.arc(h.cx, h.cy, h.L, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
          for (let q = 0; q < 4; q++) {
            const a = q * Math.PI / 2;
            ctx.fillStyle = q === t.rot ? '#ff8a1f' : 'rgba(255,138,31,0.45)';
            ctx.beginPath(); ctx.arc(h.cx + Math.sin(a) * h.L, h.cy - Math.cos(a) * h.L, 4 * d, 0, Math.PI * 2); ctx.fill();
          }
        }
        ctx.strokeStyle = '#ff8a1f'; ctx.lineWidth = 2.5 * d;
        ctx.beginPath(); ctx.moveTo(h.cx, h.cy); ctx.lineTo(ex, ey); ctx.stroke();
        ctx.fillStyle = '#ff8a1f'; ctx.beginPath(); ctx.arc(h.cx, h.cy, 3.5 * d, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#fff'; ctx.strokeStyle = '#ff8a1f'; ctx.lineWidth = 3 * d;
        ctx.beginPath(); ctx.arc(ex, ey, 10 * d, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        ctx.fillStyle = '#ff8a1f'; ctx.font = `bold ${12 * d}px system-ui`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('⟳', ex, ey + 0.5 * d); ctx.textBaseline = 'alphabetic';
      }
    }
    const moving = this.drag && this.drag.kind === 'group';
    for (const t of this.multi) {
      const g = pieceGeometry(t);
      ctx.fillStyle = moving ? 'rgba(34,211,238,0.08)' : 'rgba(34,211,238,0.22)';
      ctx.fillRect(ox + t.c * s, oy + t.r * s, g.w * s, g.h * s);
      ctx.strokeStyle = '#22d3ee'; ctx.lineWidth = 2.5 * this.dpr;
      ctx.strokeRect(ox + t.c * s + 1.5, oy + t.r * s + 1.5, g.w * s - 3, g.h * s - 3);
    }
    if (this.box) {
      const r = this.canvas.getBoundingClientRect();
      const x0 = (this.box.x0 - r.left) * this.dpr, y0 = (this.box.y0 - r.top) * this.dpr;
      const x1 = (this.box.x1 - r.left) * this.dpr, y1 = (this.box.y1 - r.top) * this.dpr;
      ctx.fillStyle = 'rgba(34,211,238,0.12)'; ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
      ctx.strokeStyle = '#22d3ee'; ctx.lineWidth = 1.5 * this.dpr; ctx.setLineDash([6 * this.dpr, 4 * this.dpr]);
      ctx.strokeRect(x0, y0, x1 - x0, y1 - y0); ctx.setLineDash([]);
    }
    if (moving) {
      const d = this.drag, cell = this.cellAtClamped(d.x, d.y);
      const dc = cell.c - d.from.c, dr = cell.r - d.from.r;
      const hit = this.groupClashes(d.tiles, dc, dr);
      for (const t of d.tiles) {
        const m = { ...t, c: t.c + dc, r: t.r + dr }, g = pieceGeometry(m);
        ctx.fillStyle = !hit ? 'rgba(255,59,92,0.3)' : hit.length ? 'rgba(255,170,59,0.25)' : 'rgba(255,255,255,0.18)';
        ctx.fillRect(ox + m.c * s, oy + m.r * s, g.w * s, g.h * s);
        drawTile(ctx, m, map, k, this.width, 0.65);
      }
      if (!hit) label(ctx, 'off the grid', (d.x - this.canvas.getBoundingClientRect().left) * this.dpr, (d.y - this.canvas.getBoundingClientRect().top) * this.dpr - s * 0.6, this.dpr, '#ff3b5c');
      else if (hit.length) label(ctx, `replaces ${hit.length}`, (d.x - this.canvas.getBoundingClientRect().left) * this.dpr, (d.y - this.canvas.getBoundingClientRect().top) * this.dpr - s * 0.6, this.dpr, '#ffaa3b');
    }

    // Driving-direction arrows (best route) along every road of a valid network
    if (this.preview) {
      const tr = this.preview;
      ctx.fillStyle = 'rgba(255,192,46,0.9)';
      for (let e = 0; e < tr.edgeCount.length; e++) {
        const n = tr.edgeCount[e], len = tr.edgeLen[e];
        const count = Math.max(1, Math.round(len / CELL));
        for (let j = 0; j < count; j++) {
          const i = tr.edgeStart[e] + Math.floor((j + 0.5) / count * (n - 1));
          const [x, y] = map({ x: tr.cx[i], z: tr.cz[i] });
          arrow(ctx, x, y, Math.atan2(tr.dz[i], tr.dx[i]), s * 0.1);
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
    if (this.drag && this.drag.kind !== 'group') {
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
          drawTile(ctx, t, map, k, this.width, 0.6);
          if (replaces) label(ctx, `replaces ${replaces}`, ox + (t.c + g.w / 2) * s, oy + t.r * s - 6 * this.dpr, this.dpr, '#ff3b5c');
        } else {
          const t = { ...d.tile, c: 0, r: 0 };
          const m = p => { const [x, y] = map(p); return [x - ox + gx - (d.grab.dc + 0.5) * s, y - oy + gy - (d.grab.dr + 0.5) * s - s * 0.3]; };
          drawTile(ctx, t, m, k, this.width, 0.85);
          if (d.fromGrid) label(ctx, 'release to remove', gx, gy + s * 0.45, this.dpr, '#ff3b5c');
        }
      } else {
        const t = cell && this.tilesAt(cell.c, cell.r).find(canHoldObstacle);
        if (cell) {
          const g = t && pieceGeometry(t);
          ctx.strokeStyle = t ? '#38e07b' : '#ff3b5c'; ctx.lineWidth = 3 * this.dpr;
          if (t) ctx.strokeRect(ox + t.c * s, oy + t.r * s, g.w * s, g.h * s);
          else ctx.strokeRect(ox + cell.c * s, oy + cell.r * s, s, s);
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
  const offX = (Math.max(g.w, g.h) - g.w) * CELL * k / 2, offZ = (Math.max(g.w, g.h) - g.h) * CELL * k / 2;
  return p => [(p.x - ox) * k + offX, (p.z - oz) * k + offZ];
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

/** Draw a piece's roads. `map` turns world metres into canvas px; k = px per metre. */
/**
 * Draw a piece's roads. `map` turns world metres into canvas px; k = px per metre.
 * `pass` lets the grid draw all borders first and all tarmac on top, so joins
 * between pieces are seamless: 'shadow' | 'border' | 'asphalt' | 'detail' | 'all'.
 */
export function drawTile(ctx, tile, map, k, width, alpha = 1, rev = false, pass = 'all') {
  if (pass === 'all') { for (const p of ['shadow', 'border', 'asphalt', 'detail']) drawTile(ctx, tile, map, k, width, alpha, rev, p); return; }
  const g = pieceGeometry(tile);
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.lineCap = 'butt'; ctx.lineJoin = 'round';
  const path = (pts, shift = 0, overlap = 0) => {
    ctx.beginPath();
    const ext = (a, b) => { const L = Math.hypot(a.x - b.x, a.z - b.z) || 1; return { x: a.x + (a.x - b.x) / L * overlap, z: a.z + (a.z - b.z) / L * overlap }; };
    const list = overlap && pts.length > 1 ? [ext(pts[0], pts[1]), ...pts.slice(1, -1), ext(pts[pts.length - 1], pts[pts.length - 2])] : pts;
    list.forEach((p, i) => { const [x, y] = map(p); i ? ctx.lineTo(x + shift, y + shift) : ctx.moveTo(x + shift, y + shift); });
  };
  const bridge = tile.type === 'bridge';
  if (pass === 'shadow' && bridge) {
    // drop shadow under the raised deck
    for (const e of g.edges) {
      const raised = e.points.filter(p => p.h > 1);
      if (raised.length > 1) { path(raised, 0.5 * k * 4); ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = (width + 3) * k; ctx.stroke(); }
    }
  }
  // tiny overlap past each end hides the anti-aliasing hairline between neighbouring pieces
  if (pass === 'border') for (const e of g.edges) { path(e.points, 0, 0.15); ctx.strokeStyle = bridge ? '#cbd5e1' : '#e8e8e8'; ctx.lineWidth = (width + (bridge ? 3.4 : 2.4)) * k; ctx.stroke(); }
  if (pass === 'asphalt') for (const e of g.edges) { path(e.points, 0, 0.15); ctx.strokeStyle = bridge ? '#4b5058' : '#3b3f45'; ctx.lineWidth = width * k; ctx.stroke(); }
  if (pass !== 'detail') { ctx.restore(); return; }
  ctx.lineCap = 'butt';
  if (!g.junction) {
    for (const e of g.edges) {
      path(e.points); ctx.strokeStyle = 'rgba(255,255,255,0.45)'; ctx.lineWidth = Math.max(1, 0.4 * k);
      ctx.setLineDash([3 * k, 3 * k]); ctx.stroke(); ctx.setLineDash([]);
    }
  }
  if (bridge) {
    // rails along the deck
    for (const e of g.edges) {
      for (const side of [-1, 1]) {
        const pts = e.points.map((p, i, arr) => {
          const a = arr[Math.max(0, i - 1)], b = arr[Math.min(arr.length - 1, i + 1)];
          const L = Math.hypot(b.x - a.x, b.z - a.z) || 1;
          return { x: p.x - (b.z - a.z) / L * side * (width / 2 + 1.2), z: p.z + (b.x - a.x) / L * side * (width / 2 + 1.2) };
        });
        path(pts); ctx.strokeStyle = '#f8fafc'; ctx.lineWidth = Math.max(1, 0.5 * k); ctx.stroke();
      }
    }
  }
  if (g.edges.some(e => e.tunnel)) {
    // tunnel roof: translucent grass with a hatched outline
    for (const e of g.edges) {
      path(e.points); ctx.strokeStyle = 'rgba(44,92,30,0.6)'; ctx.lineWidth = (width + 4) * k; ctx.stroke();
      path(e.points); ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.lineWidth = Math.max(1, 0.35 * k);
      ctx.setLineDash([1.5 * k, 2.5 * k]); ctx.stroke(); ctx.setLineDash([]);
    }
  }
  if (g.barrier) {
    // red/white barrier where the road stops
    const b = g.barrier, L = Math.hypot(b.dx, b.dz) || 1, nx = -b.dz / L, nz = b.dx / L, hw = width / 2 + 1;
    const [x1, y1] = map({ x: b.x + nx * hw, z: b.z + nz * hw }), [x2, y2] = map({ x: b.x - nx * hw, z: b.z - nz * hw });
    ctx.lineCap = 'butt'; ctx.lineWidth = Math.max(3, 1.4 * k);
    ctx.strokeStyle = '#f8fafc'; ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    ctx.strokeStyle = '#dc2626'; ctx.setLineDash([1.6 * k, 1.6 * k]); ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); ctx.setLineDash([]);
  }
  if (g.island) {
    const [x, y] = map(g.island);
    ctx.fillStyle = '#5aa13a'; ctx.beginPath(); ctx.arc(x, y, (g.island.r - width / 2) * k, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#e5e7eb'; ctx.lineWidth = Math.max(1, 0.6 * k); ctx.stroke();
  }
  if (tile.type === 'start') {
    const pts = g.edges[0].points;
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
  void rev;
  ctx.restore();
}

/** Draw the obstacle attached to a piece (if any). */
export function drawObstacle(ctx, tile, map, k, width, rev, alpha = 1, badge = 0) {
  const o = tile.obstacle;
  if (!o || !OBSTACLE_TYPES[o.type]) return;
  const pts = pieceGeometry(tile).edges[0].points.slice();
  if (rev) pts.reverse();
  const steps = pts.length - 1;
  const i = Math.min(steps - 1, Math.round((o.pos ?? 0.5) * steps));
  const p = pts[i], q = pts[i + 1];
  const tl = Math.hypot(q.x - p.x, q.z - p.z) || 1;
  const tx = (q.x - p.x) / tl, tz = (q.z - p.z) / tl, nx = -tz, nz = tx;
  const L = obstacleLayout(o, width / 2);
  const c = { x: p.x + nx * L.lat, z: p.z + nz * L.lat };
  const [cx, cy] = map(c);
  const ang = Math.atan2(tz, tx);
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(cx, cy); ctx.rotate(ang);
  const rect = (fill) => { ctx.fillStyle = fill; ctx.fillRect(-L.a * k, -L.b * k, 2 * L.a * k, 2 * L.b * k); };
  if (o.type === 'spikes') {
    rect('#6b7280');
    ctx.fillStyle = '#e5e7eb';
    const n = Math.max(2, Math.round(L.b * 2 / 1.2));
    for (let j = 0; j < n; j++) {
      const y = -L.b * k + (j + 0.5) * (2 * L.b * k / n), r = Math.min(L.a, L.b * 2 / n) * k * 0.8;
      ctx.beginPath(); ctx.moveTo(-r, y + r * 0.6); ctx.lineTo(r, y + r * 0.6); ctx.lineTo(0, y - r * 0.8); ctx.fill();
    }
  } else if (o.type === 'crates') {
    rect('#a0662f');
    ctx.strokeStyle = '#5c3616'; ctx.lineWidth = Math.max(1, 0.3 * k);
    ctx.strokeRect(-L.a * k, -L.b * k, 2 * L.a * k, 2 * L.b * k);
  } else if (o.type === 'oil') {
    ctx.fillStyle = 'rgba(10,10,14,0.85)';
    ctx.beginPath(); ctx.ellipse(0, 0, L.r * k * 0.9, L.r * k, 0, 0, Math.PI * 2); ctx.fill();
  } else if (o.type === 'ramp') {
    rect('#facc15');
    ctx.fillStyle = '#1f2937';
    const n = Math.max(2, Math.round(L.b * 2 / 2));
    for (let j = 0; j < n; j++) {
      const y = -L.b * k + (j + 0.5) * (2 * L.b * k / n), r = Math.min(L.a * 0.8, L.b / n) * k;
      ctx.beginPath(); ctx.moveTo(-r, y - r); ctx.lineTo(r * 0.6, y); ctx.lineTo(-r, y + r); ctx.lineTo(-r * 0.4, y); ctx.fill();
    }
  } else if (o.type === 'boost' || o.type === 'slow') {
    const boost = o.type === 'boost';
    rect(boost ? 'rgba(8,47,73,0.9)' : 'rgba(67,20,7,0.9)');
    ctx.fillStyle = boost ? '#22d3ee' : '#fb923c';
    const n = L.strength, d = boost ? 1 : -1;
    for (let j = 0; j < n; j++) {
      const x = (-L.a + (j + 0.5) * 2 * L.a / n) * k, r = Math.min(L.b, 2 * L.a / n) * k * 0.45;
      ctx.beginPath(); ctx.moveTo(x - d * r, -L.b * k * 0.8); ctx.lineTo(x + d * r, 0); ctx.lineTo(x - d * r, L.b * k * 0.8); ctx.lineTo(x - d * r * 0.2, 0); ctx.fill();
    }
  } else if (o.type === 'spinner') {
    ctx.strokeStyle = 'rgba(255,255,255,0.45)'; ctx.lineWidth = Math.max(1, 0.25 * k); ctx.setLineDash([2 * k, 2 * k]);
    ctx.beginPath(); ctx.arc(0, 0, L.arm * k, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = '#f97316'; ctx.save(); ctx.rotate(0.6); ctx.fillRect(-L.arm * k, -0.35 * k, 2 * L.arm * k, 0.7 * k); ctx.restore();
    ctx.fillStyle = '#374151'; ctx.beginPath(); ctx.arc(0, 0, 1 * k, 0, Math.PI * 2); ctx.fill();
  } else if (o.type === 'laser') {
    ctx.strokeStyle = '#ff1f3d'; ctx.lineWidth = Math.max(1.5, 0.5 * k); ctx.setLineDash([1.5 * k, 1 * k]);
    ctx.beginPath(); ctx.moveTo(0, -L.b * k); ctx.lineTo(0, L.b * k); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = '#4b5563'; for (const sy of [-1, 1]) ctx.fillRect(-0.4 * k, sy * (L.b + 0.6) * k - 0.4 * k, 0.8 * k, 0.8 * k);
  } else if (o.type === 'mud') {
    ctx.fillStyle = 'rgba(94,62,32,0.9)';
    ctx.beginPath(); ctx.ellipse(0, 0, L.a * k, L.b * k, 0, 0, Math.PI * 2); ctx.fill();
  } else if (o.type === 'bumper') {
    ctx.fillStyle = '#dc2626'; ctx.beginPath(); ctx.arc(0, 0, L.r * k, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = Math.max(1, 0.3 * k); ctx.stroke();
  } else if (o.type === 'hammer') {
    ctx.strokeStyle = 'rgba(255,255,255,0.6)'; ctx.setLineDash([2 * k, 2 * k]); ctx.lineWidth = Math.max(1, 0.3 * k);
    ctx.beginPath(); ctx.moveTo(0, -L.amp * k); ctx.lineTo(0, L.amp * k); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = '#b91c1c';
    ctx.fillRect(-1.5 * k, -L.headR * k * 0.6, 3 * k, L.headR * k * 1.2);
  }
  ctx.restore();
  if (badge) {
    // readable marker on top of the (to-scale, often tiny) obstacle
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = 'rgba(20,23,28,0.75)';
    ctx.beginPath(); ctx.arc(cx, cy, badge * 0.62, 0, Math.PI * 2); ctx.fill();
    ctx.font = `${Math.round(badge * 0.8)}px system-ui`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(OBSTACLE_TYPES[o.type].icon, cx, cy + badge * 0.04);
    const lvl = o.type === 'boost' || o.type === 'slow' ? (o.type === 'boost' ? '+' : '−') + L.strength : '';
    if (lvl) { ctx.font = `bold ${Math.round(badge * 0.5)}px system-ui`; ctx.fillStyle = '#fff'; ctx.fillText(lvl, cx + badge * 0.6, cy - badge * 0.55); }
    ctx.restore();
  }
}
