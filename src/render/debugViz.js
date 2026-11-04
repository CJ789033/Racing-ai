// Visual debugging overlays for the 3D view (F1–F6, unlocked with the developer menu).
// Everything is drawn as plain coloured lines on top of the scene (no depth test), so
// it shows through tunnels and bridges.
import * as THREE from 'three';
import { RAY_ANGLES, RAY_LENGTH, LOOKAHEAD } from '../sim/car.js';
import { hammerLat, spinnerBar, laserOn } from '../sim/obstacles.js';

export const OVERLAYS = {
  F2: 'movement: heading (white), velocity (cyan = racer, blue = police), slide (orange)',
  F3: 'police: line to target racer (red), steering aim (yellow +), arrest ring, racer → nearest police (orange), radar range around the leader',
  F4: 'track: route arrows by distance to finish (green → red), junction branches (magenta), no-way roads (grey), start / finish, police grid, tunnels (purple)',
  F5: 'sensors: every racer\'s distance rays (red = something close), leader\'s road-ahead points (yellow)',
  F6: 'hidden: trainee police (purple), obstacle hit areas (white)',
};
const MAX_SEGS = 40000;
const C = {
  white: [1, 1, 1], cyan: [0.2, 0.9, 1], blue: [0.35, 0.5, 1], orange: [1, 0.6, 0.1], red: [1, 0.2, 0.25],
  yellow: [1, 0.9, 0.2], magenta: [1, 0.2, 0.9], grey: [0.55, 0.55, 0.6], green: [0.2, 1, 0.4], purple: [0.7, 0.4, 1],
};

export class DebugViz {
  constructor(scene3d) {
    this.s3 = scene3d;
    this.on = { F2: false, F3: false, F4: false, F5: false, F6: false };
    const mk = (n, opacity) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 6), 3).setUsage(THREE.DynamicDrawUsage));
      g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 6), 3).setUsage(THREE.DynamicDrawUsage));
      g.setDrawRange(0, 0);
      const l = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity, depthTest: false, depthWrite: false }));
      l.frustumCulled = false; l.renderOrder = 20; l.visible = false;
      scene3d.scene.add(l);
      return l;
    };
    this.dyn = mk(MAX_SEGS, 0.95);   // rebuilt every frame
    this.stat = mk(MAX_SEGS, 0.8);   // track layer (F4), rebuilt when the track changes
    this.labels = [];
  }

  get any() { return Object.values(this.on).some(Boolean); }
  toggle(key) { if (key in this.on) this.on[key] = !this.on[key]; this.dirtyTrack = true; return this.on[key]; }

  // ---- line buffer helpers
  begin(l) { this._l = l; this._n = 0; this._p = l.geometry.attributes.position.array; this._c = l.geometry.attributes.color.array; }
  seg(x0, y0, z0, x1, y1, z1, c) {
    if (this._n >= MAX_SEGS) return;
    const i = this._n++ * 6, p = this._p, q = this._c;
    p[i] = x0; p[i + 1] = y0; p[i + 2] = z0; p[i + 3] = x1; p[i + 4] = y1; p[i + 5] = z1;
    q[i] = q[i + 3] = c[0]; q[i + 1] = q[i + 4] = c[1]; q[i + 2] = q[i + 5] = c[2];
  }
  cross(x, y, z, r, c) { this.seg(x - r, y, z, x + r, y, z, c); this.seg(x, y, z - r, x, y, z + r, c); }
  circle(x, y, z, r, c, n = 24) {
    for (let k = 0; k < n; k++) {
      const a = k / n * Math.PI * 2, b = (k + 1) / n * Math.PI * 2;
      this.seg(x + Math.cos(a) * r, y, z + Math.sin(a) * r, x + Math.cos(b) * r, y, z + Math.sin(b) * r, c);
    }
  }
  arrow(x0, y, z0, x1, z1, c) {
    this.seg(x0, y, z0, x1, y, z1, c);
    const dx = x1 - x0, dz = z1 - z0, L = Math.hypot(dx, dz); if (L < 0.5) return;
    const ux = dx / L, uz = dz / L, h = Math.min(1.5, L * 0.35);
    this.seg(x1, y, z1, x1 - ux * h - uz * h * 0.6, y, z1 - uz * h + ux * h * 0.6, c);
    this.seg(x1, y, z1, x1 - ux * h + uz * h * 0.6, y, z1 - uz * h - ux * h * 0.6, c);
  }
  rect(cx, y, cz, tx, tz, a, b, c) { // half-length a along (tx,tz), half-width b across
    const nx = -tz, nz = tx, P = [[a, b], [a, -b], [-a, -b], [-a, b]].map(([u, v]) => [cx + tx * u + nx * v, cz + tz * u + nz * v]);
    for (let k = 0; k < 4; k++) { const p = P[k], q = P[(k + 1) % 4]; this.seg(p[0], y, p[1], q[0], y, q[1], c); }
  }
  end() { const g = this._l.geometry; g.setDrawRange(0, this._n * 2); g.attributes.position.needsUpdate = true; g.attributes.color.needsUpdate = true; this._l.visible = this._n > 0; }

  // ---- the track layer (F4)
  buildTrack(tr, police) {
    this.begin(this.stat);
    if (tr && this.on.F4) {
      const Y = i => tr.ch[i] + 1.2, Dmax = Math.max(1, tr.lapLength);
      for (let i = 0; i < tr.N; i += 3) {
        const j = tr.next[i]; if (j === i) continue;
        const f = Math.max(0, Math.min(1, tr.D[i] / Dmax));          // 1 = just after the start, 0 = at the finish
        const col = tr.edgeDir[tr.edgeOf[i]] ? [1 - f, 0.25 + 0.75 * f, 0.3] : C.grey;
        // short arrow along the route
        const L = Math.hypot(tr.cx[j] - tr.cx[i], tr.cz[j] - tr.cz[i]) || 1;
        this.arrow(tr.cx[i], Y(i), tr.cz[i], tr.cx[i] + (tr.cx[j] - tr.cx[i]) / L * 3, tr.cz[i] + (tr.cz[j] - tr.cz[i]) / L * 3, col);
        if (tr.tunnel[i]) this.cross(tr.cx[i], Y(i), tr.cz[i], 0.6, C.purple);
      }
      if (tr.junctionAlts) for (const [i, alts] of tr.junctionAlts) for (const a of alts) {
        let j = a; for (let k = 0; k < 6; k++) j = tr.next[j];
        this.arrow(tr.cx[i], Y(i) + 0.3, tr.cz[i], tr.cx[j], tr.cz[j], C.magenta);
      }
      const s = tr.startIndex, e = tr.finishIndex;
      this.cross(tr.cx[s], Y(s) + 0.5, tr.cz[s], 4, C.green); this.circle(tr.cx[s], Y(s) + 0.5, tr.cz[s], 2.5, C.green);
      this.cross(tr.cx[e], Y(e) + 0.5, tr.cz[e], 3, C.red);
      if (police) for (const p of police.cars) if (p.spawn) {
        const i = p.spawn.index, x = tr.cx[i] - tr.dz[i] * p.spawn.lat, z = tr.cz[i] + tr.dx[i] * p.spawn.lat;
        this.rect(x, Y(i), z, tr.dx[i], tr.dz[i], 2.1, 1, C.blue);
      }
    }
    this.end();
    this.builtFor = tr; this.dirtyTrack = false;
  }

  update(evo, simTime) {
    const tr = evo && evo.track;
    if (this.dirtyTrack || this.builtFor !== tr) this.buildTrack(tr, evo && evo.police);
    this.begin(this.dyn);
    if (evo && tr && this.any) {
      const racers = evo.cars, police = evo.police ? evo.police.cars : [], ghosts = evo.police ? evo.police.ghosts : [];
      const leader = evo.leader();
      const y = c => c.roadH + (c.y || 0) + 1.4;
      if (this.on.F2) for (const c of [...racers, ...police]) {
        if (!c.alive) continue;
        const Y = y(c), hx = Math.cos(c.heading), hz = Math.sin(c.heading);
        this.arrow(c.x, Y, c.z, c.x + hx * 4, c.z + hz * 4, C.white);
        this.seg(c.x, Y + 0.1, c.z, c.x + c.vx * 0.5, Y + 0.1, c.z + c.vz * 0.5, c.isPolice ? C.blue : C.cyan);
        if (Math.abs(c.slip) > 1) this.seg(c.x, Y + 0.2, c.z, c.x - hz * c.slip * 0.5, Y + 0.2, c.z + hx * c.slip * 0.5, C.orange);
      }
      if (this.on.F3) {
        for (const p of police) {
          if (!p.alive) continue;
          const Y = y(p);
          if (p.target && p.target.racing) this.seg(p.x, Y, p.z, p.target.x, y(p.target), p.target.z, C.red);
          if (p.aimX !== undefined) this.cross(p.aimX, Y, p.aimZ, 1.2, C.yellow);
          if (p.time < p.arrestUntil) this.circle(p.x, Y, p.z, 3.5, C.red, 16);
        }
        for (const c of racers) {
          if (!c.racing) continue;
          let best = null, bd = 70 * 70;
          for (const p of police) { if (!p.alive) continue; const d = (p.x - c.x) ** 2 + (p.z - c.z) ** 2; if (d < bd) { bd = d; best = p; } }
          if (best) this.seg(c.x, y(c), c.z, best.x, y(best), best.z, C.orange);
        }
        if (leader && leader.alive) this.circle(leader.x, y(leader), leader.z, 70, C.orange, 48);
      }
      if (this.on.F5) for (const c of racers) {
        if (!c.alive || !c.rays) continue;
        const Y = y(c) - 0.4;
        for (let r = 0; r < RAY_ANGLES.length; r++) {
          const a = c.heading + RAY_ANGLES[r], d = c.rays[r], t = d / RAY_LENGTH;
          this.seg(c.x, Y, c.z, c.x + Math.cos(a) * d, Y, c.z + Math.sin(a) * d, t < 0.25 ? C.red : t < 0.6 ? C.orange : [0.4, 0.8, 0.4]);
        }
        if (c === leader) {
          let idx = c.seg, walked = 0;
          for (const ahead of LOOKAHEAD) {
            while (walked < ahead) { const n = tr.next[idx]; if (n === idx) break; idx = n; walked += tr.step; }
            this.cross(tr.cx[idx], tr.ch[idx] + 1.2, tr.cz[idx], 1.5, C.yellow);
            this.seg(c.x, Y, c.z, tr.cx[idx], tr.ch[idx] + 1.2, tr.cz[idx], C.yellow);
          }
        }
      }
      if (this.on.F6) {
        for (const g of ghosts) {
          if (!g.alive) continue;
          const Y = y(g);
          this.rect(g.x, Y, g.z, Math.cos(g.heading), Math.sin(g.heading), 2.1, 1, C.purple);
          if (g.target && g.target.racing) this.seg(g.x, Y, g.z, g.target.x, y(g.target), g.target.z, [0.5, 0.3, 0.7]);
        }
        for (const o of tr.obstacles) {
          const Y = o.y + 1;
          if (o.type === 'hammer') { const lat = hammerLat(o, simTime); this.circle(o.cx + o.nx * lat, Y, o.cz + o.nz * lat, o.headR, C.white, 16); }
          else if (o.type === 'spinner') { const [ax, az, bx, bz] = spinnerBar(o, simTime); this.seg(ax, Y, az, bx, Y, bz, C.white); this.circle(o.x, Y, o.z, 1.6, C.white, 12); }
          else if (o.r) this.circle(o.x, Y, o.z, o.r, C.white, 20);
          else if (o.a) this.rect(o.x, Y, o.z, o.tx, o.tz, o.a, o.b, o.type === 'laser' && !laserOn(o, simTime) ? C.grey : o.broken ? C.grey : C.white);
        }
      }
    }
    this.end();
    this.updateLabels(evo);
  }

  /** Numbers above the police cars (match "cars n" in the developer menu). */
  updateLabels(evo) {
    const police = evo && evo.police ? evo.police.cars : [];
    const show = this.on.F3;
    while (this.labels.length < police.length) {
      const cv = document.createElement('canvas'); cv.width = 64; cv.height = 64;
      const x = cv.getContext('2d'); x.fillStyle = '#000'; x.fillRect(8, 8, 48, 48); x.fillStyle = '#fff'; x.font = 'bold 36px monospace'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(String(this.labels.length + 1), 32, 34);
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(cv), depthTest: false }));
      sp.scale.set(2.5, 2.5, 1); sp.renderOrder = 21; this.s3.scene.add(sp); this.labels.push(sp);
    }
    this.labels.forEach((sp, i) => {
      const p = police[i];
      sp.visible = show && !!p && p.alive;
      if (sp.visible) sp.position.set(p.x, p.roadH + 4.5, p.z);
    });
  }
}
