// Three.js rendering of the track and the population of AI cars.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { CAR, RAY_ANGLES } from '../sim/car.js';
import { hammerLat } from '../sim/obstacles.js';

const COL_ALIVE = new THREE.Color('#3fa7ff');
const COL_ELITE = new THREE.Color('#b26bff');
const COL_LEADER = new THREE.Color('#ffc02e');
const COL_DEAD = new THREE.Color('#5a5f66');
const COL_DONE = new THREE.Color('#38e07b');

const padTex = {};
/** Glowing chevrons: cyan pointing forward (speed pad) or orange pointing back (slow pad). */
function padTexture(type, strength) {
  const k = type + strength;
  if (padTex[k]) return padTex[k];
  const cv = document.createElement('canvas'); cv.width = 64; cv.height = 128;
  const x = cv.getContext('2d');
  const boost = type === 'boost';
  x.fillStyle = boost ? 'rgba(8,47,73,0.85)' : 'rgba(67,20,7,0.85)'; x.fillRect(0, 0, 64, 128);
  x.fillStyle = boost ? '#22d3ee' : '#fb923c';
  const n = strength, gap = 128 / (n + 1);
  for (let i = 0; i < n; i++) {
    const y = gap * (i + 1);
    x.beginPath();
    if (boost) { x.moveTo(8, y + 14); x.lineTo(32, y - 10); x.lineTo(56, y + 14); x.lineTo(46, y + 18); x.lineTo(32, y + 4); x.lineTo(18, y + 18); }
    else { x.moveTo(8, y - 14); x.lineTo(32, y + 10); x.lineTo(56, y - 14); x.lineTo(46, y - 18); x.lineTo(32, y - 4); x.lineTo(18, y - 18); }
    x.fill();
  }
  return (padTex[k] = new THREE.CanvasTexture(cv));
}

let glowTex = null;
function glowTexture() {
  if (glowTex) return glowTex;
  const cv = document.createElement('canvas'); cv.width = cv.height = 64;
  const x = cv.getContext('2d');
  const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.25, 'rgba(255,255,255,0.8)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g; x.fillRect(0, 0, 64, 64);
  return (glowTex = new THREE.CanvasTexture(cv));
}

let stripeTex = null;
function stripes() {
  if (stripeTex) return stripeTex;
  const cv = document.createElement('canvas'); cv.width = cv.height = 64;
  const x = cv.getContext('2d');
  x.fillStyle = '#facc15'; x.fillRect(0, 0, 64, 64);
  x.fillStyle = '#1f2937';
  for (let i = -64; i < 128; i += 32) { x.beginPath(); x.moveTo(i, 0); x.lineTo(i + 16, 0); x.lineTo(i + 80, 64); x.lineTo(i + 64, 64); x.fill(); }
  stripeTex = new THREE.CanvasTexture(cv);
  stripeTex.wrapS = stripeTex.wrapT = THREE.RepeatWrapping;
  stripeTex.repeat.set(0.25, 0.25);
  return stripeTex;
}

export class Scene3D {
  constructor(container) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#9fd3f5');
    this.scene.fog = new THREE.Fog('#9fd3f5', 350, 900);

    this.camera = new THREE.PerspectiveCamera(55, 1, 0.5, 2000);
    this.camera.position.set(0, 220, 220);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = Math.PI * 0.47;
    this.controls.minDistance = 15;
    this.controls.maxDistance = 700;
    this.cameraMode = 'orbit'; // orbit | follow | top

    const hemi = new THREE.HemisphereLight('#ffffff', '#5b8a3c', 1.4);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight('#fff4e0', 2.2);
    sun.position.set(120, 200, 80);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera; sc.left = -250; sc.right = 250; sc.top = 250; sc.bottom = -250; sc.far = 600;
    this.sun = sun;
    this.scene.add(sun, sun.target);

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(3000, 3000),
      new THREE.MeshLambertMaterial({ color: '#6fb24a' }));
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.scene.add(ground);

    this.trackGroup = new THREE.Group();
    this.scene.add(this.trackGroup);

    this.showSensors = true;
    const rayGeo = new THREE.BufferGeometry();
    rayGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(RAY_ANGLES.length * 6), 3));
    this.rayLines = new THREE.LineSegments(rayGeo, new THREE.LineBasicMaterial({ color: '#ff3b5c', transparent: true, opacity: 0.85 }));
    this.rayLines.frustumCulled = false;
    this.scene.add(this.rayLines);

    // Leader marker (floating arrow)
    this.marker = new THREE.Mesh(new THREE.ConeGeometry(1.2, 2.5, 4), new THREE.MeshBasicMaterial({ color: '#ffc02e' }));
    this.marker.rotation.x = Math.PI;
    this.scene.add(this.marker);

    this.followPos = new THREE.Vector3();
    this.followLook = new THREE.Vector3();
    this._m = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._v = new THREE.Vector3();
    this._s = new THREE.Vector3(1, 1, 1); this._up = new THREE.Vector3(0, 1, 0);

    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.track && this.cameraMode === 'orbit' && Math.abs((this._lastAspect || 0) - this.camera.aspect) > 0.3) this.frameTrack();
    this._lastAspect = this.camera.aspect;
  }

  setTrack(track) {
    this.track = track;
    const g = this.trackGroup;
    g.traverse(o => { if (o.geometry) o.geometry.dispose(); });
    g.clear();
    const hw = track.halfWidth;
    const asphaltMat = new THREE.MeshLambertMaterial({ color: '#3b3f45', side: THREE.DoubleSide });
    const kerbMat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
    const deckMat = new THREE.MeshLambertMaterial({ color: '#9aa0a8', side: THREE.DoubleSide });
    const railMat = new THREE.MeshLambertMaterial({ color: '#e5e7eb', side: THREE.DoubleSide });
    const pillarMat = new THREE.MeshLambertMaterial({ color: '#8b9097' });
    const asphalt = [], kerbs = [], decks = [], rails = [], pillars = [], dashes = [], tunnelWalls = [], tunnelRoofs = [];

    // A strip along samples i0..i1 between lateral offsets off0..off1 (+ = driver's right… along +n)
    const strip = (i0, i1, off0, off1, y0, y1, colours) => {
      const n = i1 - i0 + 1, pos = new Float32Array(n * 6), idx = [];
      const col = colours ? new Float32Array(n * 6) : null;
      for (let k = 0; k < n; k++) {
        const i = i0 + k, h = track.ch[i];
        pos.set([track.cx[i] + track.nx[i] * off0, h + y0, track.cz[i] + track.nz[i] * off0,
                 track.cx[i] + track.nx[i] * off1, h + y1, track.cz[i] + track.nz[i] * off1], k * 6);
        if (col) { const c = colours(k); col.set([...c, ...c], k * 6); }
        if (k < n - 1) { const a = k * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      if (col) geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
      geo.setIndex(idx);
      geo.computeVertexNormals();
      return geo;
    };
    const stripes = k => (Math.floor(k / 2) % 2 ? [0.9, 0.12, 0.12] : [0.95, 0.95, 0.95]);

    for (let e = 0; e < track.edgeCount.length; e++) {
      const s = track.edgeStart[e], n = track.edgeCount[e], end = s + n - 1;
      const junction = track.junction[s] === 1;
      asphalt.push(strip(s, end, -hw, hw, 0.05, 0.05));
      if (!junction) {
        kerbs.push(strip(s, end, hw, hw + 1.2, 0.08, 0.08, stripes));
        kerbs.push(strip(s, end, -hw - 1.2, -hw, 0.08, 0.08, stripes));
        for (let i = s; i < end; i += 4) {
          const p = new THREE.PlaneGeometry(0.3, track.step * 1.6);
          p.rotateX(-Math.PI / 2);
          p.rotateY(-Math.atan2(track.tz[i], track.tx[i]) + Math.PI / 2);
          p.translate(track.cx[i], track.ch[i] + 0.07, track.cz[i]);
          dashes.push(p);
        }
      }
      // Bridges: deck underside, side walls, rails and pillars wherever the road is raised
      let raised = false;
      for (let i = s; i <= end; i++) if (track.ch[i] > 0.4) { raised = true; break; }
      if (raised) {
        decks.push(strip(s, end, -hw - 1.2, hw + 1.2, -0.9, -0.9));
        decks.push(strip(s, end, hw + 1.2, hw + 1.2, -0.9, 0.08));
        decks.push(strip(s, end, -hw - 1.2, -hw - 1.2, -0.9, 0.08));
        rails.push(strip(s, end, hw + 1.3, hw + 1.3, 0.08, 1.0));
        rails.push(strip(s, end, -hw - 1.3, -hw - 1.3, 0.08, 1.0));
        for (let i = s; i <= end; i += 6) {
          const h = track.ch[i];
          if (h < 2.5) continue;
          for (const side of [-1, 1]) {
            const px = track.cx[i] + track.nx[i] * side * (hw - 1), pz = track.cz[i] + track.nz[i] * side * (hw - 1);
            if (track.onRoad(0, px, pz) && track.ch[i] > 3) continue; // never stand a pillar on the road underneath
            const p = new THREE.BoxGeometry(1.2, h - 0.9, 1.2);
            p.translate(px, (h - 0.9) / 2, pz);
            pillars.push(p);
          }
        }
      }
      // Tunnels: see-through roof and walls
      if (track.tunnel[s]) {
        tunnelWalls.push(strip(s, end, hw + 1.3, hw + 1.3, 0, 6));
        tunnelWalls.push(strip(s, end, -hw - 1.3, -hw - 1.3, 0, 6));
        tunnelRoofs.push(strip(s, end, -hw - 1.8, hw + 1.8, 6, 6));
      }
    }
    const add = (geos, mat, opts = {}) => {
      if (!geos.length) return null;
      const m = new THREE.Mesh(mergeGeometries(geos), mat);
      if (opts.receive) m.receiveShadow = true;
      if (opts.cast) m.castShadow = true;
      if (opts.order) m.renderOrder = opts.order;
      g.add(m);
      return m;
    };
    add(asphalt, asphaltMat, { receive: true });
    add(kerbs, kerbMat);
    add(dashes, new THREE.MeshBasicMaterial({ color: '#d8d8d8' }));
    add(decks, deckMat, { cast: true });
    add(rails, railMat, { cast: true });
    add(pillars, pillarMat, { cast: true });
    add(tunnelWalls, new THREE.MeshLambertMaterial({ color: '#57534e', transparent: true, opacity: 0.45, side: THREE.DoubleSide, depthWrite: false }), { order: 2 });
    add(tunnelRoofs, new THREE.MeshLambertMaterial({ color: '#4d8a35', transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false }), { order: 3 });

    // Roundabout islands
    for (const isl of track.islands) {
      const r = isl.r - hw;
      const grass = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 0.35, 40), new THREE.MeshLambertMaterial({ color: '#5aa13a' }));
      grass.position.set(isl.x, 0.17, isl.z);
      const curb = new THREE.Mesh(new THREE.TorusGeometry(r, 0.35, 6, 48), new THREE.MeshLambertMaterial({ color: '#e5e7eb' }));
      curb.rotation.x = Math.PI / 2; curb.position.set(isl.x, 0.3, isl.z);
      const statue = new THREE.Mesh(new THREE.ConeGeometry(2.2, 7, 8), new THREE.MeshLambertMaterial({ color: '#f59e0b' }));
      statue.position.set(isl.x, 3.8, isl.z); statue.castShadow = true;
      g.add(grass, curb, statue);
    }

    // Start/finish checkered line + gantry
    const si = track.startIndex;
    const sdx = track.dx[si], sdz = track.dz[si], snx = -sdz, snz = sdx;
    const cv = document.createElement('canvas'); cv.width = 64; cv.height = 16;
    const cx = cv.getContext('2d');
    for (let y = 0; y < 2; y++) for (let x = 0; x < 8; x++) { cx.fillStyle = (x + y) % 2 ? '#111' : '#fff'; cx.fillRect(x * 8, y * 8, 8, 8); }
    const tex = new THREE.CanvasTexture(cv); tex.magFilter = THREE.NearestFilter;
    const line = new THREE.Mesh(new THREE.PlaneGeometry(track.width, 2), new THREE.MeshBasicMaterial({ map: tex }));
    line.rotation.set(-Math.PI / 2, 0, -Math.atan2(snz, snx)); // plane's X axis across the road
    line.position.set(track.cx[si], track.ch[si] + 0.1, track.cz[si]);
    g.add(line);
    const postGeo = new THREE.BoxGeometry(0.6, 7, 0.6);
    const postMat = new THREE.MeshLambertMaterial({ color: '#ddd' });
    for (const s of [1, -1]) {
      const post = new THREE.Mesh(postGeo, postMat);
      post.position.set(track.cx[si] + snx * (hw + 2) * s, 3.5, track.cz[si] + snz * (hw + 2) * s);
      post.castShadow = true;
      g.add(post);
    }
    const beam = new THREE.Mesh(new THREE.BoxGeometry(track.width + 4.6, 1.2, 0.8), new THREE.MeshLambertMaterial({ color: '#e0312f' }));
    beam.position.set(track.cx[si], 7, track.cz[si]);
    beam.rotation.y = -Math.atan2(snz, snx);
    beam.castShadow = true;
    g.add(beam);

    this.addScenery(track);
    this.addObstacles(track);
    this.frameTrack();
  }

  addScenery(track) {
    // Scatter low-poly trees, keeping them off the track
    const { minX, maxX, minZ, maxZ } = track.bounds;
    const pad = 80, trees = [];
    let rnd = 1234567;
    const rand = () => (rnd = (rnd * 16807) % 2147483647) / 2147483647;
    for (let tries = 0; tries < 2500 && trees.length < 260; tries++) {
      const x = minX - pad + rand() * (maxX - minX + 2 * pad);
      const z = minZ - pad + rand() * (maxZ - minZ + 2 * pad);
      let ok = true;
      for (let i = 0; i < track.N; i += 3) {
        if ((track.cx[i] - x) ** 2 + (track.cz[i] - z) ** 2 < (track.halfWidth + 9) ** 2) { ok = false; break; }
      }
      if (ok) trees.push([x, z, 0.7 + rand() * 0.8]);
    }
    const trunk = new THREE.CylinderGeometry(0.35, 0.5, 2.5, 6); trunk.translate(0, 1.25, 0);
    const leaves = new THREE.ConeGeometry(2.4, 6, 7); leaves.translate(0, 5, 0);
    const tm = new THREE.InstancedMesh(trunk, new THREE.MeshLambertMaterial({ color: '#7a5233' }), trees.length);
    const lm = new THREE.InstancedMesh(leaves, new THREE.MeshLambertMaterial({ color: '#2f7d32' }), trees.length);
    const m = new THREE.Matrix4();
    trees.forEach(([x, z, s], i) => {
      m.makeScale(s, s, s).setPosition(x, 0, z);
      tm.setMatrixAt(i, m); lm.setMatrixAt(i, m);
    });
    tm.castShadow = lm.castShadow = true;
    this.trackGroup.add(tm, lm);
  }

  addObstacles(track) {
    this.hammers = [];
    const metal = new THREE.MeshLambertMaterial({ color: '#9ca3af' });
    for (const o of track.obstacles) {
      const g = new THREE.Group();
      g.position.set(o.x, o.y, o.z);
      g.rotation.y = -Math.atan2(o.nz, o.nx); // local +X = across the road, local Z = along it
      if (o.type === 'spikes') {
        const plate = new THREE.Mesh(new THREE.BoxGeometry(2 * o.b, 0.15, 2 * o.a), new THREE.MeshLambertMaterial({ color: '#4b5563' }));
        plate.position.y = 0.1; g.add(plate);
        const cones = [];
        for (let x = -o.b + 0.4; x <= o.b - 0.3; x += 0.75) for (let z = -o.a + 0.4; z <= o.a - 0.3; z += 0.75) {
          const c = new THREE.ConeGeometry(0.28, 0.9, 6); c.translate(x, 0.6, z); cones.push(c);
        }
        const sp = new THREE.Mesh(mergeGeometries(cones), new THREE.MeshPhongMaterial({ color: '#e5e7eb', shininess: 80 }));
        sp.castShadow = true; g.add(sp);
      } else if (o.type === 'crates') {
        const n = Math.max(1, Math.round((2 * o.b) / (2 * o.a)));
        const size = (2 * o.b) / n;
        const mat = new THREE.MeshLambertMaterial({ color: '#b7793b' });
        const edge = new THREE.MeshLambertMaterial({ color: '#6b4220' });
        for (let i = 0; i < n; i++) for (let layer = 0; layer < (i % 2 ? 2 : 1); layer++) {
          const s2 = Math.min(size, 2 * o.a) * 0.95;
          const box = new THREE.Mesh(new THREE.BoxGeometry(s2, s2, s2), mat);
          box.position.set(-o.b + size * (i + 0.5), s2 / 2 + layer * s2, 0);
          box.rotation.y = (i * 0.37) % 0.3;
          box.castShadow = true;
          const frame = new THREE.Mesh(new THREE.BoxGeometry(s2 * 1.02, s2 * 0.15, s2 * 1.02), edge);
          frame.position.copy(box.position); frame.position.y += s2 * 0.42; frame.rotation.y = box.rotation.y;
          g.add(box, frame);
        }
      } else if (o.type === 'ramp') {
        // wedge rising in the driving direction (local -Z here)
        const shape = new THREE.Shape();
        shape.moveTo(-o.a, 0); shape.lineTo(o.a, 0); shape.lineTo(o.a, o.h); shape.closePath(); // tall end ahead
        const geo = new THREE.ExtrudeGeometry(shape, { depth: 2 * o.b, bevelEnabled: false });
        geo.translate(0, 0, -o.b);
        geo.rotateY(Math.PI / 2); // shape's X axis -> along the road, extrusion -> across it
        const tex = stripes();
        const ramp = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ map: tex }));
        ramp.castShadow = true; ramp.receiveShadow = true;
        g.add(ramp);
      } else if (o.type === 'boost' || o.type === 'slow') {
        const pad = new THREE.Mesh(new THREE.PlaneGeometry(2 * o.b, 2 * o.a), new THREE.MeshBasicMaterial({ map: padTexture(o.type, o.strength), transparent: true }));
        pad.geometry.rotateX(-Math.PI / 2); // texture "up" points along the driving direction
        pad.position.y = 0.1;
        g.add(pad);
      } else if (o.type === 'oil') {
        const slick = new THREE.Mesh(new THREE.CircleGeometry(o.r, 24), new THREE.MeshPhongMaterial({ color: '#0b0b10', shininess: 120, specular: '#6655aa' }));
        slick.rotation.x = -Math.PI / 2; slick.scale.set(1, 0.85, 1); slick.position.y = 0.09;
        g.add(slick);
      } else if (o.type === 'hammer') {
        // gantry with a pendulum hammer swinging across the road
        const span = track.halfWidth + 1.8;
        const arm = Math.max(8.8, o.amp / 0.9);
        const pivotY = arm + 1.3;
        for (const sx of [-1, 1]) {
          const post = new THREE.Mesh(new THREE.BoxGeometry(0.6, pivotY + 0.5, 0.6), metal);
          post.position.set(sx * span, (pivotY + 0.5) / 2, 0); post.castShadow = true; g.add(post);
        }
        const beam = new THREE.Mesh(new THREE.BoxGeometry(2 * span + 0.6, 0.6, 0.6), new THREE.MeshLambertMaterial({ color: '#f59e0b' }));
        beam.position.y = pivotY + 0.3; g.add(beam);
        const swing = new THREE.Group(); swing.position.y = pivotY;
        const rod = new THREE.Mesh(new THREE.BoxGeometry(0.25, arm, 0.25), metal);
        rod.position.y = -arm / 2; swing.add(rod);
        const headGeo = new THREE.CylinderGeometry(o.headR * 0.75, o.headR * 0.75, 3.2, 14); headGeo.rotateX(Math.PI / 2);
        const head = new THREE.Mesh(headGeo, new THREE.MeshLambertMaterial({ color: '#b91c1c' }));
        head.position.y = -arm; head.castShadow = true; swing.add(head);
        g.add(swing);
        // hammer swings in the local X/Y plane, centred on the road
        g.position.set(o.cx, o.y, o.cz);
        this.hammers.push({ o, swing, arm });
      }
      this.trackGroup.add(g);
    }
  }

  frameTrack() {
    const { minX, maxX, minZ, maxZ } = this.track.bounds;
    const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
    // Fit the track on screen; narrow (portrait) screens need to pull back further
    const size = Math.max(maxX - minX, (maxZ - minZ) * 0.8) * Math.max(1, 1.1 / this.camera.aspect);
    this.controls.target.set(cx, 0, cz);
    this.camera.position.set(cx, size * 0.85, cz + size * 0.75);
    const dist = size * 1.13;
    this.scene.fog.near = Math.max(350, dist * 1.3);
    this.scene.fog.far = Math.max(900, dist * 3);
    this.controls.maxDistance = Math.max(700, dist * 1.5);
    this.sun.position.set(cx + 120, 200, cz + 80);
    this.sun.target.position.set(cx, 0, cz);
    this.controls.update();
  }

  /** (Re)create instanced car meshes for a population size. */
  setPopulation(n) {
    if (this.bodies) { this.scene.remove(this.bodies, this.darks); this.bodies.dispose(); this.darks.dispose(); }
    const L = CAR.length, W = CAR.width;
    // Body: lower chassis + nose + cabin, oriented along +X
    const chassis = new THREE.BoxGeometry(L, 0.6, W); chassis.translate(0, 0.55, 0);
    const cabin = new THREE.BoxGeometry(L * 0.45, 0.55, W * 0.8); cabin.translate(-0.25, 1.1, 0);
    const spoiler = new THREE.BoxGeometry(0.35, 0.12, W * 1.05); spoiler.translate(-L / 2 + 0.2, 1.15, 0);
    const bodyGeo = mergeGeometries([chassis, cabin, spoiler]);
    // Dark parts: wheels + windscreen
    const parts = [];
    for (const [x, z] of [[1.3, 0.95], [1.3, -0.95], [-1.3, 0.95], [-1.3, -0.95]]) {
      const w = new THREE.CylinderGeometry(0.42, 0.42, 0.35, 10); w.rotateX(Math.PI / 2); w.translate(x, 0.42, z);
      parts.push(w);
    }
    const glass = new THREE.BoxGeometry(0.05, 0.42, W * 0.72); glass.translate(0.7, 1.1, 0);
    parts.push(glass);
    for (const s of [1, -1]) { const st = new THREE.BoxGeometry(0.1, 0.4, 0.1); st.translate(-L / 2 + 0.2, 0.9, s * W * 0.4); parts.push(st); }
    const darkGeo = mergeGeometries(parts);

    this.bodies = new THREE.InstancedMesh(bodyGeo, new THREE.MeshLambertMaterial({ color: '#ffffff' }), n);
    this.darks = new THREE.InstancedMesh(darkGeo, new THREE.MeshLambertMaterial({ color: '#16181c' }), n);
    this.bodies.castShadow = this.darks.castShadow = true;
    this.bodies.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.darks.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (let i = 0; i < n; i++) this.bodies.setColorAt(i, COL_ALIVE);
    this.bodies.frustumCulled = this.darks.frustumCulled = false;
    this.scene.add(this.bodies, this.darks);
    // Glow for cars inside tunnels – drawn on top of everything so you can always spot them
    if (this.glow) { this.scene.remove(this.glow); this.glow.geometry.dispose(); }
    const gg = new THREE.BufferGeometry();
    gg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    gg.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    this.glow = new THREE.Points(gg, new THREE.PointsMaterial({
      size: 30 * Math.min(window.devicePixelRatio || 1, 2), sizeAttenuation: false, // same size on screen near or far
      map: glowTexture(), vertexColors: true, transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    this.glow.frustumCulled = false; this.glow.renderOrder = 10;
    this.scene.add(this.glow);
  }

  updateCars(cars, leader, dt, simTime = 0) {
    for (const h of this.hammers || []) {
      const lat = hammerLat(h.o, simTime);
      h.swing.rotation.z = Math.asin(Math.max(-1, Math.min(1, lat / h.arm)));
    }
    const m = this._m, q = this._q, v = this._v;
    const gp = this.glow.geometry.attributes.position, gc = this.glow.geometry.attributes.color;
    cars.forEach((c, i) => {
      // Dead cars sink, turn grey and vanish after a moment; jumping cars fly
      const gone = !c.alive && simTime - c.diedAt > 1.5;
      v.set(c.x, c.alive ? c.roadH + c.y : c.roadH - 0.25, c.z);
      q.setFromAxisAngle(this._up, -c.heading);
      this._s.setScalar(gone ? 0 : 1);
      if (c.airborne) {
        // nose follows the flight path
        this._q2 = this._q2 || new THREE.Quaternion(); this._ax = this._ax || new THREE.Vector3(0, 0, 1);
        this._q2.setFromAxisAngle(this._ax, Math.atan2(c.vy, Math.max(1, c.speed)) * 0.8);
        q.multiply(this._q2);
      }
      m.compose(v, q, this._s);
      this.bodies.setMatrixAt(i, m);
      this.darks.setMatrixAt(i, m);
      const col = c === leader ? COL_LEADER : c.finished ? COL_DONE : !c.alive ? COL_DEAD : c.isElite ? COL_ELITE : COL_ALIVE;
      this.bodies.setColorAt(i, col);
      if (c.alive && c.inTunnel) { gp.setXYZ(i, c.x, c.roadH + 1, c.z); gc.setXYZ(i, col.r, col.g, col.b); }
      else gp.setXYZ(i, 0, -1000, 0);
    });
    this._s.setScalar(1);
    gp.needsUpdate = true; gc.needsUpdate = true;
    this.bodies.instanceMatrix.needsUpdate = true;
    this.darks.instanceMatrix.needsUpdate = true;
    this.bodies.instanceColor.needsUpdate = true;

    // Sensors of the leader
    const pos = this.rayLines.geometry.attributes.position;
    this.rayLines.visible = this.showSensors && !!leader && leader.alive;
    if (leader) {
      for (let r = 0; r < RAY_ANGLES.length; r++) {
        const a = leader.heading + RAY_ANGLES[r], d = leader.rays[r];
        const ry = leader.roadH + leader.y + 0.8;
        pos.setXYZ(r * 2, leader.x, ry, leader.z);
        pos.setXYZ(r * 2 + 1, leader.x + Math.cos(a) * d, ry, leader.z + Math.sin(a) * d);
      }
      pos.needsUpdate = true;
      this.marker.position.set(leader.x, leader.roadH + leader.y + 4 + Math.sin(performance.now() / 200) * 0.4, leader.z);
      this.marker.visible = this.cameraMode !== 'follow';
    }

    this.updateCamera(leader, dt);
    this.controls.enabled = this.cameraMode === 'orbit';
    if (this.cameraMode === 'orbit') this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  updateCamera(leader, dt) {
    if (!leader) return;
    const k = 1 - Math.exp(-dt * 4);
    if (this.cameraMode === 'follow') {
      const back = 14, base = leader.roadH + leader.y;
      // inside a tunnel the camera ducks under the roof
      const up = leader.inTunnel ? 4 : 6;
      const tx = leader.x - Math.cos(leader.heading) * back, tz = leader.z - Math.sin(leader.heading) * back;
      this.followPos.lerp(this._v.set(tx, base + up, tz), k);
      this.followLook.lerp(this._v.set(leader.x + Math.cos(leader.heading) * 8, base + 1, leader.z + Math.sin(leader.heading) * 8), k);
      this.camera.position.copy(this.followPos);
      this.camera.lookAt(this.followLook);
    } else if (this.cameraMode === 'top') {
      this.followLook.lerp(this._v.set(leader.x, 0, leader.z), k);
      this.camera.position.set(this.followLook.x, 90, this.followLook.z + 0.01);
      this.camera.lookAt(this.followLook);
    }
  }

  cycleCamera() {
    const modes = ['orbit', 'follow', 'top'];
    this.cameraMode = modes[(modes.indexOf(this.cameraMode) + 1) % modes.length];
    if (this.cameraMode === 'orbit') this.frameTrack();
    else { this.followPos.copy(this.camera.position); this.followLook.copy(this.controls.target); }
    return this.cameraMode;
  }
}
