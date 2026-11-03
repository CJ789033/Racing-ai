// 2D top-down track editor (touch + mouse). The player places control points
// of a closed loop; the track is a smooth spline through them.
import { Track } from '../sim/track.js';

const WORLD = 320; // visible world size in metres (fits the shorter screen side)
const MIN_RADIUS = 10;

export class TrackEditor {
  constructor(canvas, { onChange } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.points = [];
    this.width = 12;
    this.mode = 'add'; // add | delete
    this.drag = null;
    this.onChange = onChange || (() => {});
    this.preview = null;
    this.issue = null;

    canvas.addEventListener('pointerdown', e => this.down(e));
    canvas.addEventListener('pointermove', e => this.move(e));
    canvas.addEventListener('pointerup', e => this.up(e));
    canvas.addEventListener('pointercancel', e => this.up(e));
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = r.width * dpr; this.canvas.height = r.height * dpr;
    this.dpr = dpr;
    this.scale = Math.min(r.width, r.height) * dpr / WORLD;
    this.draw();
  }

  toWorld(e) {
    const r = this.canvas.getBoundingClientRect();
    const px = (e.clientX - r.left) * this.dpr, py = (e.clientY - r.top) * this.dpr;
    return { x: (px - this.canvas.width / 2) / this.scale, z: (py - this.canvas.height / 2) / this.scale };
  }
  toScreen(p) { return [this.canvas.width / 2 + p.x * this.scale, this.canvas.height / 2 + p.z * this.scale]; }

  hit(p) {
    const r = 22 * this.dpr / this.scale;
    let best = -1, bd = r * r;
    this.points.forEach((q, i) => { const d = (q.x - p.x) ** 2 + (q.z - p.z) ** 2; if (d < bd) { bd = d; best = i; } });
    return best;
  }

  down(e) {
    e.preventDefault();
    this.canvas.setPointerCapture(e.pointerId);
    const p = this.toWorld(e);
    const i = this.hit(p);
    if (this.mode === 'delete') {
      if (i >= 0) { this.points.splice(i, 1); this.changed(); }
      return;
    }
    if (i >= 0) { this.drag = { i, moved: false }; return; }
    // Insert a new point into the closest edge of the loop (or append)
    if (this.points.length < 3) this.points.push(p);
    else {
      let best = 0, bd = Infinity;
      for (let k = 0; k < this.points.length; k++) {
        const a = this.points[k], b = this.points[(k + 1) % this.points.length];
        const d = distToSeg(p, a, b);
        if (d < bd) { bd = d; best = k; }
      }
      this.points.splice(best + 1, 0, p);
      this.drag = { i: best + 1, moved: false };
    }
    this.changed();
  }

  move(e) {
    if (!this.drag) return;
    const p = this.toWorld(e);
    const lim = WORLD * 0.75;
    this.points[this.drag.i] = { x: clamp(p.x, -lim, lim), z: clamp(p.z, -lim, lim) };
    this.drag.moved = true;
    this.changed();
  }

  up() { this.drag = null; }

  setPoints(points, width) {
    this.points = points.map(p => ({ ...p }));
    if (width) this.width = width;
    this.changed();
  }

  setWidth(w) { this.width = w; this.changed(); }

  /** Reverse driving direction. */
  reverse() { this.points.reverse(); this.changed(); }

  /** Move the start line to the next control point. */
  rotateStart() { if (this.points.length) { this.points.push(this.points.shift()); this.changed(); } }

  changed() {
    this.preview = null; this.issue = null;
    if (this.points.length >= 3) {
      try {
        this.preview = new Track(this.points, this.width);
        const c = this.preview.tightestCorner();
        if (c.radius < MIN_RADIUS) this.issue = { ...c, text: `Very tight corner (r≈${c.radius.toFixed(0)} m) – cars may never get round it` };
      } catch { this.preview = null; }
    }
    this.draw();
    this.onChange(this);
  }

  get valid() { return !!this.preview; }

  draw() {
    const ctx = this.ctx, W = this.canvas.width, H = this.canvas.height, s = this.scale;
    if (!s) return;
    ctx.fillStyle = '#5f9e3f'; ctx.fillRect(0, 0, W, H);
    // grid every 20 m
    ctx.strokeStyle = 'rgba(255,255,255,0.08)'; ctx.lineWidth = 1;
    const step = 20 * s;
    for (let x = (W / 2) % step; x < W; x += step) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
    for (let y = (H / 2) % step; y < H; y += step) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }

    const t = this.preview;
    if (t) {
      const path = () => {
        ctx.beginPath();
        for (let i = 0; i <= t.N; i++) { const [x, y] = this.toScreen({ x: t.cx[i % t.N], z: t.cz[i % t.N] }); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
      };
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      path(); ctx.strokeStyle = '#e8e8e8'; ctx.lineWidth = (t.width + 2.4) * s; ctx.stroke();
      path(); ctx.strokeStyle = '#3b3f45'; ctx.lineWidth = t.width * s; ctx.stroke();
      path(); ctx.setLineDash([6 * this.dpr, 8 * this.dpr]); ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.lineWidth = 1.5 * this.dpr; ctx.stroke(); ctx.setLineDash([]);
      // start line + direction arrow
      const [sx, sy] = this.toScreen({ x: t.cx[0], z: t.cz[0] });
      const nx = t.nx[0], nz = t.nz[0], tx = t.tx[0], tz = t.tz[0];
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 3 * this.dpr;
      ctx.beginPath(); ctx.moveTo(sx + nx * t.halfWidth * s, sy + nz * t.halfWidth * s); ctx.lineTo(sx - nx * t.halfWidth * s, sy - nz * t.halfWidth * s); ctx.stroke();
      const al = 16 * this.dpr;
      ctx.fillStyle = '#ffc02e';
      ctx.beginPath();
      ctx.moveTo(sx + tx * al * 1.6, sy + tz * al * 1.6);
      ctx.lineTo(sx + nx * al * 0.6, sy + nz * al * 0.6);
      ctx.lineTo(sx - nx * al * 0.6, sy - nz * al * 0.6);
      ctx.fill();
      if (this.issue) {
        const [ix, iy] = this.toScreen(this.issue);
        ctx.strokeStyle = '#ff3b5c'; ctx.lineWidth = 3 * this.dpr;
        ctx.beginPath(); ctx.arc(ix, iy, 20 * this.dpr, 0, Math.PI * 2); ctx.stroke();
      }
    } else if (this.points.length > 1) {
      ctx.strokeStyle = '#ddd'; ctx.lineWidth = 2 * this.dpr;
      ctx.beginPath(); this.points.forEach((p, i) => { const [x, y] = this.toScreen(p); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.stroke();
    }

    // control points
    this.points.forEach((p, i) => {
      const [x, y] = this.toScreen(p);
      ctx.beginPath(); ctx.arc(x, y, 9 * this.dpr, 0, Math.PI * 2);
      ctx.fillStyle = i === 0 ? '#ffc02e' : this.mode === 'delete' ? '#ff3b5c' : '#3fa7ff';
      ctx.fill(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 2 * this.dpr; ctx.stroke();
    });

    if (this.points.length < 3) {
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.font = `${16 * this.dpr}px system-ui, sans-serif`; ctx.textAlign = 'center';
      ctx.fillText(`Tap to place track points (${this.points.length}/3 minimum)`, W / 2, H / 2);
    }
  }
}

function distToSeg(p, a, b) {
  const sx = b.x - a.x, sz = b.z - a.z, L2 = sx * sx + sz * sz || 1;
  const t = clamp(((p.x - a.x) * sx + (p.z - a.z) * sz) / L2, 0, 1);
  return Math.hypot(p.x - a.x - sx * t, p.z - a.z - sz * t);
}
function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
