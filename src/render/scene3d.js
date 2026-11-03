// Three.js rendering of the track and the population of AI cars.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { CAR, RAY_ANGLES } from '../sim/car.js';

const COL_ALIVE = new THREE.Color('#3fa7ff');
const COL_ELITE = new THREE.Color('#b26bff');
const COL_LEADER = new THREE.Color('#ffc02e');
const COL_DEAD = new THREE.Color('#5a5f66');
const COL_DONE = new THREE.Color('#38e07b');

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
    const N = track.N;

    // Asphalt ribbon
    const ribbon = (lx, lz, rx, rz, y) => {
      const pos = new Float32Array((N + 1) * 6), idx = [];
      for (let i = 0; i <= N; i++) {
        const k = i % N;
        pos.set([lx(k), y, lz(k), rx(k), y, rz(k)], i * 6);
        if (i < N) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setIndex(idx);
      geo.computeVertexNormals();
      return geo;
    };
    const asphalt = new THREE.Mesh(
      ribbon(i => track.lx[i], i => track.lz[i], i => track.rx[i], i => track.rz[i], 0.05),
      new THREE.MeshLambertMaterial({ color: '#3b3f45', side: THREE.DoubleSide }));
    asphalt.receiveShadow = true;
    g.add(asphalt);

    // Kerbs (red/white stripes) on both sides
    const kerbW = 1.2;
    for (const side of [1, -1]) {
      const edge = (arrX, arrZ, nOff) => [i => arrX[i] + track.nx[i] * nOff * side, i => arrZ[i] + track.nz[i] * nOff * side];
      const inner = side > 0 ? [track.lx, track.lz] : [track.rx, track.rz];
      const [ax, az] = edge(inner[0], inner[1], 0);
      const [bx, bz] = edge(inner[0], inner[1], kerbW);
      const geo = ribbon(ax, az, bx, bz, 0.08);
      const col = new Float32Array((N + 1) * 6);
      for (let i = 0; i <= N; i++) {
        const c = Math.floor(i / 2) % 2 ? [0.9, 0.12, 0.12] : [0.95, 0.95, 0.95];
        col.set([...c, ...c], i * 6);
      }
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
      g.add(new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide })));
    }

    // Center dashed line
    const dashGeo = [];
    for (let i = 0; i < N; i += 4) {
      const p = new THREE.PlaneGeometry(0.3, track.step * 1.6);
      p.rotateX(-Math.PI / 2);
      p.rotateY(-Math.atan2(track.tz[i], track.tx[i]) + Math.PI / 2);
      p.translate(track.cx[i], 0.07, track.cz[i]);
      dashGeo.push(p);
    }
    g.add(new THREE.Mesh(mergeGeometries(dashGeo), new THREE.MeshBasicMaterial({ color: '#d8d8d8' })));

    // Start/finish checkered line
    const cv = document.createElement('canvas'); cv.width = 64; cv.height = 16;
    const cx = cv.getContext('2d');
    for (let y = 0; y < 2; y++) for (let x = 0; x < 8; x++) { cx.fillStyle = (x + y) % 2 ? '#111' : '#fff'; cx.fillRect(x * 8, y * 8, 8, 8); }
    const tex = new THREE.CanvasTexture(cv); tex.magFilter = THREE.NearestFilter;
    const line = new THREE.Mesh(new THREE.PlaneGeometry(track.width, 2), new THREE.MeshBasicMaterial({ map: tex }));
    // orient the plane's X axis along the track normal
    line.rotation.set(-Math.PI / 2, 0, Math.atan2(track.nz[0], track.nx[0]) * -1);
    line.position.set(track.cx[0], 0.1, track.cz[0]);
    g.add(line);
    // Gantry over the start line
    const postGeo = new THREE.BoxGeometry(0.6, 7, 0.6);
    const postMat = new THREE.MeshLambertMaterial({ color: '#ddd' });
    for (const s of [1, -1]) {
      const post = new THREE.Mesh(postGeo, postMat);
      post.position.set(track.cx[0] + track.nx[0] * (track.halfWidth + 2) * s, 3.5, track.cz[0] + track.nz[0] * (track.halfWidth + 2) * s);
      post.castShadow = true;
      g.add(post);
    }
    const beam = new THREE.Mesh(new THREE.BoxGeometry(track.width + 4.6, 1.2, 0.8), new THREE.MeshLambertMaterial({ color: '#e0312f' }));
    beam.position.set(track.cx[0], 7, track.cz[0]);
    beam.rotation.y = -Math.atan2(track.nz[0], track.nx[0]);
    beam.castShadow = true;
    g.add(beam);

    this.addScenery(track);
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
      for (let i = 0; i < track.N; i += 2) {
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
  }

  updateCars(cars, leader, dt) {
    const m = this._m, q = this._q, v = this._v;
    cars.forEach((c, i) => {
      // Dead cars sink slightly into the ground and turn grey
      v.set(c.x, c.alive || c.finished ? 0 : -0.25, c.z);
      q.setFromAxisAngle(this._up, -c.heading);
      m.compose(v, q, this._s);
      this.bodies.setMatrixAt(i, m);
      this.darks.setMatrixAt(i, m);
      const col = c === leader ? COL_LEADER : c.finished ? COL_DONE : !c.alive ? COL_DEAD : c.isElite ? COL_ELITE : COL_ALIVE;
      this.bodies.setColorAt(i, col);
    });
    this.bodies.instanceMatrix.needsUpdate = true;
    this.darks.instanceMatrix.needsUpdate = true;
    this.bodies.instanceColor.needsUpdate = true;

    // Sensors of the leader
    const pos = this.rayLines.geometry.attributes.position;
    this.rayLines.visible = this.showSensors && !!leader && leader.alive;
    if (leader) {
      for (let r = 0; r < RAY_ANGLES.length; r++) {
        const a = leader.heading + RAY_ANGLES[r], d = leader.rays[r];
        pos.setXYZ(r * 2, leader.x, 0.8, leader.z);
        pos.setXYZ(r * 2 + 1, leader.x + Math.cos(a) * d, 0.8, leader.z + Math.sin(a) * d);
      }
      pos.needsUpdate = true;
      this.marker.position.set(leader.x, 4 + Math.sin(performance.now() / 200) * 0.4, leader.z);
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
      const back = 14, up = 6;
      const tx = leader.x - Math.cos(leader.heading) * back, tz = leader.z - Math.sin(leader.heading) * back;
      this.followPos.lerp(this._v.set(tx, up, tz), k);
      this.followLook.lerp(this._v.set(leader.x + Math.cos(leader.heading) * 8, 1, leader.z + Math.sin(leader.heading) * 8), k);
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
