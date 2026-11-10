// IGI Phone v2 — Mission 1: Trainyard, REAL geometry.
// Three.js r160 + WebGL2 only. No .NET, no WebGPU, no shadows, DPR capped at 1.
//
// What is REAL here (decoded from the user's retail game files, see REPORT.md):
//  - Models: 169/169 LOD1 MEF models decoded (data/level1_models.json):
//    31,564 verts / 19,149 tris / 976 draw groups, real diffuse UVs + textures.
//  - Placements: 475 placements from objects.qvm (data/level1_placements.json),
//    real positions (1 m = 4096 units, Z up) + real orientations
//    R = Rz(gamma).Ry(beta).Rx(alpha). Rendered: 440 static placements
//    (63 distinct models, one InstancedMesh per model). Skipped, listed in
//    REPORT.md: 4x `waypoint` markers, 1x unknown model 472_01_1.
//  - Guards: all 29 real soldiers at real positions/yaw, 21 with real patrol
//    waypoints (34 waypoints, resolved to real graph nodes).
//  - Textures: 393 real .tex decoded into data/atlas.png (20x20 cells of 32px).
//    Every model texture name maps to an atlas cell (0 missing).
//  - Terrain: real terrain.hmp grid-0 detail (65x65, -3.27..+2.70 m) over a
//    400 m patch centred on the player spawn. The main terrain shape lives in
//    terrain.cmd, which is NOT decoded, so outside the patch the ground is a
//    flat plane at the measured yard floor (median placement Z, -1.77 m local).
//  - Objective: Objective 1 (M1_OBJ1) links to the SmallGarage Building
//    (model 410_01_1) at local (86.4, -51.3, -2.1) m. Win = reach it.
//    No extraction point exists in objects.qvm — none is invented.
//  - Sounds: synthesised WebAudio only (real .wav files not shipped).
//
// Known limits (see REPORT.md): soldier meshes are base bind-pose vertices
// only (bone transforms not decoded) so they render 0.64-0.84 m tall, feet at
// the decoded placement point. Trains exist only as scalar rail positions in
// objects.qvm (23 Train tasks) and no train model is placed as a normal
// placement, so no trains/rails are rendered. Levels 2-14 not converted.
// Collision with buildings/props is not decoded (terrain.cmd / MEF collision
// chunks dropped) — the player walks on the ground height only.
import * as THREE from 'three';

const $ = (id) => document.getElementById(id);
const loadEl = $('load'), screenEl = $('screen'), hudEl = $('hud');
const toast = (t, ms = 2200) => { const e = $('toast'); e.textContent = t; e.style.display = 'block'; setTimeout(() => e.style.display = 'none', ms); };

// ---------------------------------------------------------------------------
// Pure helpers (exported so tools/smoke_test.mjs can verify the shipped code
// headlessly against the real data files).
// ---------------------------------------------------------------------------

// IGI world: Z is UP, 1 m = 4096 units. Local coords = absolute minus the
// player spawn (6000.614, -13635.941, 42583.418) m, so float32 stays safe.
// Three.js world: Y is UP. IGI (x, y, z) -> Three (x, z, -y); the scene
// holds all IGI-space objects under a group rotated -90 deg about X, which
// performs exactly that mapping (a rotation, so winding order is preserved).
export function igiToThree(x, y, z) { return [x, z, -y]; }

// Atlas: 20 columns x 20 rows of 32 px cells in a 640x640 PNG. level1.json
// `textures.index[i]` gives the cell's top-left corner as fractions
// (u = left, v = top). Map a texture name to its cell fractions.
export function buildAtlasMap(levelJson) {
  const map = new Map();
  levelJson.textures.index.forEach((e) => {
    const base = e.name.replace(/^LOCAL:textures\//, '').replace(/\.tex$/, '');
    map.set(base, { u: e.u, v: e.v });
  });
  return map;
}

// Merge one MEF model's draw groups into a single non-indexed BufferGeometry
// with UVs remapped into the model's texture atlas cells.
//
// Why non-indexed: groups index a shared vertex array, and a vertex can be
// referenced by groups with different textures, so per-group UV remapping
// needs per-group vertex copies. Cost is small (19,149 tris total).
//
// UV convention: MEF UVs are Direct3D (v = 0 at the top of the texture,
// v grows downward, values tile: -123..133). With Three.js flipY (default),
// texture v = 1 is the top row of the image, so a model v maps to
// vAtlas = 1 - (cellTop + frac(v) * cellSize). A half-texel inset keeps
// mipmaps from bleeding into neighbouring atlas cells.
export function buildModelGeometry(model, atlasMap) {
  const CELL = 1 / 20, INSET = 0.5 / 640;
  const pos = [], nrm = [], uv = [];
  let skippedTris = 0, skippedGroups = 0;
  for (const g of model.groups) {
    const tris = g.idx.length / 3;
    if (!g.tex || !atlasMap.has(g.tex)) { skippedTris += tris; skippedGroups++; continue; }
    const cell = atlasMap.get(g.tex);
    for (let k = 0; k < g.idx.length; k++) {
      const vi = g.idx[k];
      pos.push(model.verts[vi * 3], model.verts[vi * 3 + 1], model.verts[vi * 3 + 2]);
      nrm.push(model.normals[vi * 3], model.normals[vi * 3 + 1], model.normals[vi * 3 + 2]);
      const u = model.uv[vi * 2], v = model.uv[vi * 2 + 1];
      const fu = u - Math.floor(u), fv = v - Math.floor(v);
      uv.push(cell.u + INSET + fu * (CELL - 2 * INSET),
              1 - cell.v - INSET - fv * (CELL - 2 * INSET));
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return { geometry: geo, tris: pos.length / 9, skippedTris, skippedGroups }; // pos holds 3 verts per tri
}

// Instance matrix for one placement, in IGI space (Z up). euler3 placements
// carry the decoded 3x3 rotation matrix (row-major, R = Rz.Ry.Rx); characters
// carry gamma_only (yaw about Z, R = Rz(gamma)).
export function instanceMatrixFor(p) {
  const m = new THREE.Matrix4();
  const [x, y, z] = p.position_local_m;
  if (p.orientation_kind === 'euler3' && p.orientation_matrix_3x3) {
    const R = p.orientation_matrix_3x3;
    m.set(R[0][0], R[0][1], R[0][2], x,
          R[1][0], R[1][1], R[1][2], y,
          R[2][0], R[2][1], R[2][2], z,
          0, 0, 0, 1);
  } else {
    const g = p.gamma_rad || 0, c = Math.cos(g), s = Math.sin(g);
    m.set(c, -s, 0, x, s, c, 0, y, 0, 0, 1, z, 0, 0, 0, 1);
  }
  return m;
}

// Ground height in Three.js coords (x right, z toward viewer = -IGI y).
// Inside the 400 m hmp patch: bilinear sample of the real height grid
// (heights are indexed [row*(n+1)+col], col = IGI x, row = -three z, because
// the patch is centred on the spawn). Outside: flat at FLAT_Z, the measured
// yard floor (median Z of near-spawn placements, -1.77 m local), blended
// over a 40 m band so there is no step at the patch edge.
export const PATCH_HALF = 200, FLAT_Z = -1.77, BLEND_IN = 180, BLEND_OUT = 220;
export function groundHeightAt(x, z, terrain) {
  const n = terrain.size, h = terrain.heights;
  const d = Math.max(Math.abs(x), Math.abs(z));
  let hm = null;
  if (d <= BLEND_OUT) {
    const gx = THREE.MathUtils.clamp((x + PATCH_HALF) / (PATCH_HALF * 2) * n, 0, n - 0.001);
    const gz = THREE.MathUtils.clamp((-z + PATCH_HALF) / (PATCH_HALF * 2) * n, 0, n - 0.001);
    const x0 = Math.floor(gx), z0 = Math.floor(gz), fx = gx - x0, fz = gz - z0;
    const at = (a, b) => h[b * (n + 1) + a];
    const lo = at(x0, z0) + (at(x0 + 1, z0) - at(x0, z0)) * fx;
    const hi = at(x0, z0 + 1) + (at(x0 + 1, z0 + 1) - at(x0, z0 + 1)) * fx;
    hm = lo + (hi - lo) * fz;
  }
  if (d <= BLEND_IN) return hm;
  if (d >= BLEND_OUT) return FLAT_Z;
  const k = (d - BLEND_IN) / (BLEND_OUT - BLEND_IN), s = k * k * (3 - 2 * k);
  return hm * (1 - s) + FLAT_Z * s;
}

// ---------------------------------------------------------------------------
// Game state
// ---------------------------------------------------------------------------
const state = {
  hp: 100, ammo: 30, mag: 30, guardsLeft: 29, started: false, won: false, dead: false,
  yaw: 0, pitch: 0, pos: new THREE.Vector3(0, 0, 0),
  velY: 0, onGround: true, keys: {}, joy: { x: 0, y: 0 },
  firing: false, lastShot: 0, reloadUntil: 0, startTime: 0,
};

let renderer, scene, camera, level, models, placements, atlasTex, enemies = [], tracers = [], clock;
let igiGroup; // converts IGI Z-up space to Three.js Y-up space
let objectiveThree = null; // [x, y, z] in Three space (SmallGarage)

async function loadLevel() {
  loadEl.textContent = 'Loading Trainyard models… (169 real MEF models, 2.2 MB)';
  models = await (await fetch('data/level1_models.json')).json();
  loadEl.textContent = 'Loading Trainyard placements… (475 real objects.qvm placements)';
  placements = await (await fetch('data/level1_placements.json')).json();
  loadEl.textContent = 'Loading terrain + textures… (real hmp heights, 393-texture atlas)';
  level = await (await fetch('data/level1.json')).json();
  atlasTex = await new THREE.TextureLoader().loadAsync('data/atlas.png');
  atlasTex.colorSpace = THREE.SRGBColorSpace;
  atlasTex.magFilter = THREE.NearestFilter; // cheap on a phone GPU
  atlasTex.minFilter = THREE.NearestMipmapLinearFilter;
  atlasTex.generateMipmaps = true;
}

function buildTerrain() {
  // One ground mesh, 1400 x 1600 m, centred on the yard (Three x -700..700,
  // z -210..1390 — covers every yard placement), heights from groundHeightAt.
  // Vertex colours by height (ballast/dirt/grass) — the ground has no decoded
  // texture (terrain.cmd not decoded), so this is a plain base colour only.
  const W = 1400, D = 1600, SX = 140, SZ = 160, CZ = 590;
  const geo = new THREE.PlaneGeometry(W, D, SX, SZ);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  const colours = new Float32Array(pos.count * 3);
  const cGrass = new THREE.Color(0x5a6b3a), cDirt = new THREE.Color(0x8a6f4d),
        cBallast = new THREE.Color(0x6f6f6f), c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i) + CZ;
    const hgt = groundHeightAt(x, z, level.terrain);
    pos.setY(i, hgt);
    const k = THREE.MathUtils.clamp((hgt + 3.3) / 6, 0, 1);
    c.copy(cBallast).lerp(cDirt, Math.min(1, k * 2)).lerp(cGrass, Math.max(0, k - 0.45) * 1.2);
    colours[i * 3] = c.r; colours[i * 3 + 1] = c.g; colours[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colours, 3));
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true }));
  mesh.position.set(0, 0, CZ);
  mesh.name = 'ground-flat-plus-hmp-detail';
  scene.add(mesh);
}

function buildStatics() {
  // 440 static placements -> one InstancedMesh per distinct model (63).
  // Everything is placed in IGI space under igiGroup; the group rotation
  // converts Z-up to Three.js Y-up. No invented positions, no scatter.
  const atlasMap = buildAtlasMap(level);
  const byModel = new Map();
  let rendered = 0, skipped = 0;
  for (const p of placements.placements) {
    if (p.task_type === 'HumanPlayer' || p.task_type === 'HumanSoldier') continue; // player / guards handled separately
    const model = models.models.find((m) => m.name === p.model);
    if (!model || !model.verts.length || p.model === 'waypoint') { skipped++; continue; } // empty model / unknown model / engine marker
    if (!byModel.has(p.model)) byModel.set(p.model, []);
    byModel.get(p.model).push(p);
    rendered++;
  }
  const mat = new THREE.MeshLambertMaterial({
    map: atlasTex, alphaTest: 0.5, // 1-bit alpha cutouts (336 transparent groups)
    side: THREE.DoubleSide, // MEF winding follows D3D (clockwise front); double-sided is safe
  });
  let totalTris = 0, skippedTris = 0;
  for (const [name, list] of byModel) {
    const model = models.models.find((m) => m.name === name);
    const { geometry, tris, skippedTris: st } = buildModelGeometry(model, atlasMap);
    totalTris += tris * list.length; skippedTris += st;
    const mesh = new THREE.InstancedMesh(geometry, mat, list.length);
    list.forEach((p, i) => mesh.setMatrixAt(i, instanceMatrixFor(p)));
    mesh.instanceMatrix.needsUpdate = true;
    mesh.name = 'static-' + name;
    mesh.frustumCulled = false; // instances span the whole yard; per-mesh culling would need real bounds
    igiGroup.add(mesh);
  }
  console.log(`[v2] statics: ${rendered} placements, ${byModel.size} models, ${totalTris.toLocaleString()} instanced tris, ${skipped} skipped, ${skippedTris} tris skipped (null-tex groups)`);
  return { rendered, models: byModel.size, totalTris, skipped };
}

function buildGuards() {
  // All 29 real soldiers. Shared merged geometry per soldier model (5),
  // individual meshes so each can patrol. Soldier meshes are base bind-pose
  // vertices only (bone transforms not decoded): 0.64-0.84 m tall, origin at
  // body centre — so the geometry is shifted up by -minZ and the mesh is put
  // at the decoded placement point with its FEET on that point (same
  // origin-at-base convention as every other model). Positions, yaw and
  // patrol waypoints are the decoded ones, nothing invented.
  const atlasMap = buildAtlasMap(level);
  const geoByModel = new Map();
  for (const name of ['000_01_1', '001_01_1', '003_01_1', '015_01_1', '019_01_1']) {
    const model = models.models.find((m) => m.name === name);
    const { geometry } = buildModelGeometry(model, atlasMap);
    const zs = model.verts.filter((_, i) => i % 3 === 2);
    geometry.translate(0, 0, -Math.min(...zs)); // feet at local z = 0
    geoByModel.set(name, geometry);
  }
  const mat = new THREE.MeshLambertMaterial({
    map: atlasTex, alphaTest: 0.5, side: THREE.DoubleSide,
  });
  let withPatrol = 0, waypoints = 0;
  for (const g of placements.guards) {
    const mesh = new THREE.Mesh(geoByModel.get(g.model), mat);
    mesh.position.set(g.position_local_m[0], g.position_local_m[1], g.position_local_m[2]);
    mesh.rotation.z = g.gamma_rad || 0;
    mesh.name = 'guard-' + g.task_id;
    igiGroup.add(mesh);
    const wps = (g.patrol && g.patrol.waypoints) ? g.patrol.waypoints.map((w) => w.position_local_m) : [];
    if (wps.length) { withPatrol++; waypoints += wps.length; }
    enemies.push({
      id: g.task_id, aiType: g.ai_type, mesh, hp: 50,
      igi: { x: g.position_local_m[0], y: g.position_local_m[1], z: g.position_local_m[2] },
      wps, wpIndex: 0, shootAt: 0,
      sniper: g.ai_type === 'AITYPE_SNIPER',
    });
  }
  state.guardsLeft = enemies.length;
  $('left').textContent = state.guardsLeft;
  console.log(`[v2] guards: ${enemies.length}, with patrol: ${withPatrol}, waypoints: ${waypoints}`);
  return { total: enemies.length, withPatrol, waypoints };
}

function shoot() {
  if (!state.started || state.dead || state.won) return;
  const now = performance.now();
  if (now - state.lastShot < 180 || now < state.reloadUntil) return;
  if (state.ammo <= 0) { reload(); return; }
  state.lastShot = now; state.ammo--;
  $('ammo').textContent = state.ammo;
  blip(880, 0.06, 0.15);
  // Hitscan: nearest living guard within a small cone of the camera direction.
  const dir = new THREE.Vector3(); camera.getWorldDirection(dir);
  let best = null, bestD = 1e9, bestPos = null;
  for (const e of enemies) {
    if (e.hp <= 0) continue;
    const gp = guardThreePos(e); // guard centre, ~0.4 m above its feet
    const to = gp.clone().sub(camera.position);
    const d = to.length();
    if (d > 90) continue;
    const ang = to.normalize().angleTo(dir);
    if (ang < 0.09 && d < bestD) { best = e; bestD = d; bestPos = gp; }
  }
  const end = bestPos || camera.position.clone().add(dir.multiplyScalar(60));
  const tg = new THREE.BufferGeometry().setFromPoints([camera.position.clone(), end]);
  const line = new THREE.Line(tg, new THREE.LineBasicMaterial({ color: 0xffe27a, transparent: true, opacity: 0.9 }));
  scene.add(line); tracers.push({ line, until: now + 70 });
  if (best) {
    best.hp -= 34;
    const hit = $('hit'); hit.style.opacity = 1; setTimeout(() => hit.style.opacity = 0, 120);
    if (best.hp <= 0) {
      best.mesh.visible = false;
      state.guardsLeft--;
      $('left').textContent = state.guardsLeft;
      toast('Guard down — ' + state.guardsLeft + ' left');
    }
  }
  if (state.ammo === 0) reload();
}
function reload() {
  if (state.ammo === state.mag || performance.now() < state.reloadUntil) return;
  state.reloadUntil = performance.now() + 1200;
  toast('Reloading…');
  setTimeout(() => { state.ammo = state.mag; $('ammo').textContent = state.ammo; }, 1200);
}
// Tiny WebAudio synth (real .wav files are listed in level1.json; the phone
// build synthesises shots so it stays under the size budget).
let audioCtx = null;
function blip(freq, dur, vol) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type = 'square'; o.frequency.value = freq;
    g.gain.setValueAtTime(vol, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + dur);
    o.connect(g).connect(audioCtx.destination); o.start(); o.stop(audioCtx.currentTime + dur);
  } catch (e) { /* audio is optional */ }
}

// Guard's Three.js position (centre of the body): IGI (x, y, z) -> (x, z, -y).
function guardThreePos(e) {
  return new THREE.Vector3(e.igi.x, e.igi.z + 0.4, -e.igi.y);
}

function init() {
  renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'low-power' });
  renderer.setPixelRatio(1); // phone: cap DPR at 1 — the single biggest win
  renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = false;
  $('app').appendChild(renderer.domElement);
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x9db8d6);
  scene.fog = new THREE.Fog(0x9db8d6, 60, 240); // short draw distance
  camera = new THREE.PerspectiveCamera(68, innerWidth / innerHeight, 0.1, 300);
  igiGroup = new THREE.Group();
  igiGroup.rotation.x = -Math.PI / 2; // IGI Z-up -> Three.js Y-up
  scene.add(igiGroup);
  scene.add(new THREE.HemisphereLight(0xcfe5ff, 0x5a4a33, 1.1));
  const sun = new THREE.DirectionalLight(0xfff2d0, 1.2);
  sun.position.set(60, 100, 40);
  scene.add(sun);
  clock = new THREE.Clock();
  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });
  bindControls();
}

function bindControls() {
  // Touch joystick (left) + look drag (right) + buttons.
  const stick = $('stick'), knob = $('knob');
  let stickId = null, lookId = null, lookLast = null;
  const setKnob = (dx, dy) => { knob.style.left = (40 + dx) + 'px'; knob.style.top = (40 + dy) + 'px'; };
  addEventListener('touchstart', (e) => {
    for (const t of e.changedTouches) {
      if (t.clientX < innerWidth / 2 && stickId === null && t.target === stick || t.clientX < innerWidth * 0.45 && stickId === null) {
        stickId = t.identifier;
      } else if (lookId === null) { lookId = t.identifier; lookLast = { x: t.clientX, y: t.clientY }; }
    }
  }, { passive: true });
  addEventListener('touchmove', (e) => {
    for (const t of e.changedTouches) {
      if (t.identifier === stickId) {
        const r = stick.getBoundingClientRect();
        let dx = (t.clientX - (r.left + 60)) / 45, dy = (t.clientY - (r.top + 60)) / 45;
        const len = Math.hypot(dx, dy); if (len > 1) { dx /= len; dy /= len; }
        state.joy = { x: dx, y: dy }; setKnob(dx * 32, dy * 32);
      } else if (t.identifier === lookId && lookLast) {
        state.yaw -= (t.clientX - lookLast.x) * 0.0045;
        state.pitch = THREE.MathUtils.clamp(state.pitch - (t.clientY - lookLast.y) * 0.0045, -1.2, 1.2);
        lookLast = { x: t.clientX, y: t.clientY };
      }
    }
    if (state.started) e.preventDefault();
  }, { passive: false });
  addEventListener('touchend', (e) => {
    for (const t of e.changedTouches) {
      if (t.identifier === stickId) { stickId = null; state.joy = { x: 0, y: 0 }; setKnob(0, 0); }
      if (t.identifier === lookId) { lookId = null; }
    }
  }, { passive: true });
  $('fire').addEventListener('touchstart', (e) => { e.preventDefault(); state.firing = true; shoot(); }, { passive: false });
  $('fire').addEventListener('touchend', () => state.firing = false);
  $('reload').addEventListener('touchstart', (e) => { e.preventDefault(); reload(); }, { passive: false });
  $('jump').addEventListener('touchstart', (e) => { e.preventDefault(); if (state.onGround) { state.velY = 7; state.onGround = false; } }, { passive: false });
  // Desktop fallback
  addEventListener('keydown', (e) => { state.keys[e.code] = true; if (e.code === 'KeyR') reload(); if (e.code === 'Space' && state.onGround) { state.velY = 7; state.onGround = false; } });
  addEventListener('keyup', (e) => state.keys[e.code] = false);
  addEventListener('mousemove', (e) => {
    if (document.pointerLockElement) {
      state.yaw -= e.movementX * 0.0022;
      state.pitch = THREE.MathUtils.clamp(state.pitch - e.movementY * 0.0022, -1.2, 1.2);
    }
  });
  renderer.domElement.addEventListener('click', () => {
    if (state.started && !document.pointerLockElement && matchMedia('(pointer:fine)').matches) renderer.domElement.requestPointerLock();
    shoot();
  });
}

function update(dt) {
  if (!state.started || state.dead || state.won) return;
  // Look
  camera.rotation.order = 'YXZ';
  camera.rotation.y = state.yaw; camera.rotation.x = state.pitch;
  // Move: joystick + WASD
  let mx = state.joy.x, mz = state.joy.y;
  if (state.keys['KeyW']) mz -= 1; if (state.keys['KeyS']) mz += 1;
  if (state.keys['KeyA']) mx -= 1; if (state.keys['KeyD']) mx += 1;
  const len = Math.hypot(mx, mz); if (len > 1) { mx /= len; mz /= len; }
  const speed = 11;
  const fwd = new THREE.Vector3(-Math.sin(state.yaw), 0, -Math.cos(state.yaw));
  const right = new THREE.Vector3(Math.cos(state.yaw), 0, -Math.sin(state.yaw));
  state.pos.addScaledVector(fwd, -mz * speed * dt);
  state.pos.addScaledVector(right, mx * speed * dt);
  // Stay inside the yard (Three x -650..620, z -120..1300 covers all yard placements)
  state.pos.x = THREE.MathUtils.clamp(state.pos.x, -650, 620);
  state.pos.z = THREE.MathUtils.clamp(state.pos.z, -120, 1300);
  // Gravity / ground follow
  const ground = groundHeightAt(state.pos.x, state.pos.z, level.terrain) + 1.7;
  state.velY -= 22 * dt;
  state.pos.y += state.velY * dt;
  if (state.pos.y <= ground) { state.pos.y = ground; state.velY = 0; state.onGround = true; }
  camera.position.copy(state.pos);
  if (state.firing) shoot();
  // Enemies: real patrol routes, chase + shoot when close (game logic only;
  // positions and patrols are the decoded ones).
  const now = performance.now();
  for (const e of enemies) {
    if (e.hp <= 0) continue;
    const gp = guardThreePos(e);
    const d = gp.distanceTo(state.pos);
    const dx = state.pos.x - gp.x, dz = state.pos.z - gp.z; // Three XZ
    const chaseRange = e.sniper ? 90 : 55, shootRange = e.sniper ? 90 : 45;
    if (d < chaseRange) {
      // Chase in IGI XY (Three x = IGI x, Three z = -IGI y)
      const il = Math.hypot(dx, dz) || 1;
      e.igi.x += (dx / il) * 3.2 * dt;
      e.igi.y += (-dz / il) * 3.2 * dt;
      e.mesh.position.set(e.igi.x, e.igi.y, e.igi.z);
      e.mesh.rotation.z = Math.atan2(-dx, -dz); // face the player (model forward +Y)
      if (d < shootRange && now - e.shootAt > (e.sniper ? 2200 : 1400)) {
        e.shootAt = now;
        state.hp -= e.sniper ? 15 + Math.random() * 10 : 6 + Math.random() * 6;
        $('hp').textContent = Math.max(0, Math.round(state.hp));
        const dmg = $('dmg'); dmg.style.opacity = 1; setTimeout(() => dmg.style.opacity = 0, 180);
        blip(180, 0.12, 0.12);
        if (state.hp <= 0) { state.dead = true; endScreen(false); }
      }
    } else if (e.wps.length) {
      // Patrol the decoded waypoints (IGI coords), loop.
      const wp = e.wps[e.wpIndex];
      const wx = wp[0] - e.igi.x, wy = wp[1] - e.igi.y;
      const wl = Math.hypot(wx, wy);
      if (wl < 2) { e.wpIndex = (e.wpIndex + 1) % e.wps.length; }
      else {
        e.igi.x += (wx / wl) * 2.2 * dt;
        e.igi.y += (wy / wl) * 2.2 * dt;
        e.mesh.position.set(e.igi.x, e.igi.y, e.igi.z);
        e.mesh.rotation.z = Math.atan2(-wx, wy); // face along the patrol leg
      }
    }
    // Guards stand at their decoded Z (their own ground); no terrain snap.
  }
  // Tracers fade
  tracers = tracers.filter((t) => { if (now > t.until) { scene.remove(t.line); return false; } return true; });
  // Win: reach the SmallGarage (Objective 1's linked position).
  const od = Math.hypot(state.pos.x - objectiveThree[0], state.pos.z - objectiveThree[2]);
  const objEl = $('obj');
  objEl.textContent = `Objective 1 — Reach the Small Garage · ${Math.round(od)} m away · ${state.guardsLeft} guards left. No extraction point exists in the mission data.`;
  if (od < 10) { state.won = true; endScreen(true); }
  const t = Math.floor((now - state.startTime) / 1000);
  $('time').textContent = Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0');
}

function endScreen(won) {
  hudEl.classList.remove('on');
  screenEl.style.display = 'flex';
  screenEl.innerHTML = won
    ? '<h1>MISSION COMPLETE</h1><h2>Objective 1 — Small Garage reached.</h2><p>That was the real Trainyard: real MEF building/prop geometry at the real objects.qvm positions, real guard patrols, real textures. No extraction point exists in the mission data, so the level ends at the garage.</p><button id="play" onclick="location.reload()">↻ PLAY AGAIN</button>'
    : '<h1>YOU DIED</h1><h2>The guards got you.</h2><p>Tap below to retry Trainyard.</p><button id="play" onclick="location.reload()">↻ RETRY</button>';
}

function loop() {
  requestAnimationFrame(loop);
  const dt = Math.min(clock.getDelta(), 0.05);
  if (state.started) update(dt);
  renderer.render(scene, camera);
}

$('play').addEventListener('click', async () => {
  if (state.started) return;
  $('play').disabled = true;
  try {
    init();
    await loadLevel();
    loadEl.textContent = 'Building Trainyard… (real models at real positions)';
    buildTerrain();
    const st = buildStatics();
    const gd = buildGuards();
    // Player spawn = decoded HumanPlayer position/yaw. Spawn local is (0,0,0)
    // in Three coords (IGI local origin = spawn), camera yaw = -gamma per the
    // decoder (OpenIGI RetailOrientation); eye 1.7 m above the ground.
    const spawn = placements.player_spawn;
    state.yaw = -spawn.gamma_rad;
    state.pos.set(0, groundHeightAt(0, 0, level.terrain) + 1.7, 0);
    camera.position.copy(state.pos);
    // Objective 1: SmallGarage, local (86.4, -51.3, -2.1) m IGI -> Three.
    objectiveThree = igiToThree(...placements.objective_location.position_local_m);
    state.startTime = performance.now();
    state.started = true;
    screenEl.style.display = 'none';
    hudEl.classList.add('on');
    toast(`Trainyard loaded — ${st.rendered} real objects, ${gd.total} guards. Reach the Small Garage.`);
    loop();
  } catch (err) {
    loadEl.textContent = 'Load failed: ' + err.message + ' — serve with ./start.sh and open http://127.0.0.1:8782/';
    $('play').disabled = false;
    console.error(err);
  }
});
