// IGI Phone v3 — Mission 1: Trainyard, REAL IGI data, WebGL2 + Three.js r186.
// Plain JavaScript, no WASM, no WebGPU, no shadows, no runtime download.
//
// What is REAL here (decoded from the user's retail game files, see REPORT.md):
//  - Models: 169/169 LOD1 MEF models (data/level1_models.json): 31,564 verts /
//    19,149 tris / 976 draw groups, real diffuse UVs + textures.
//  - Soldiers: the 5 skinned soldier models are POSED at load time from the
//    real retail skeletons in common/anims/*.iff (BOBH hierarchy + rest pose,
//    data/level1_soldiers.json, tools/skin_soldiers.py). A soldier is ~1.8 m
//    tall in the posed data — the v2 0.64–0.84 m bind-pose dwarfs are gone.
//    If the posed file is missing, guards fall back to the v2 bind-pose
//    geometry and the game says so on screen (never silently).
//  - Placements: 475 placements from objects.qvm (data/level1_placements.json),
//    real positions (1 m = 4096 units, Z up) + real orientations.
//    Rendered: 440 static placements (63 distinct models, one InstancedMesh
//    per model). Skipped, listed in REPORT.md: 4x `waypoint` markers, 1x
//    unknown model 472_01_1.
//  - Guards: 29 real soldiers at real positions/yaw; 25 in the yard fight,
//    4 far away (633–1337 m, one 3.2 km below the yard) are rendered but
//    never chase or shoot and are not counted in "guards left".
//  - Textures: 393 real .tex decoded into data/atlas.webp (WebP, 108 KB;
//    PNG fallback data/atlas.png, 684 KB). Every model texture maps to a cell.
//  - Terrain: real terrain.hmp grid-0 detail over a 400 m patch centred on
//    the player spawn; outside the patch the ground is a flat plane at the
//    measured yard floor (median placement Z, -1.77 m local). terrain.cmd
//    (main terrain shape) is NOT decoded — no tested extent made placement
//    Z correlate with hmp height, so the hmp is detail only.
//  - Lighting: baked-lightmap pages exist in the data (lightmaps.res) but
//    are NOT applied in v3 — the MEF lightmap UVs + pages were assessed
//    (see REPORT.md) and a lightmap atlas is a follow-up, not a guess.
//    v3 shades with a hemisphere + directional light on the diffuse atlas
//    (no real-time shadows, like playigi's baked look, but not playigi's
//    lightmaps — do not claim baked lighting).
//  - Objective: Objective 1 (M1_OBJ1) links to the SmallGarage Building
//    (model 410_01_1) at local (86.4, -51.3, -2.1) m. Win = reach it.
//    No extraction point exists in objects.qvm — none is invented.
//  - Sounds: synthesised WebAudio only (real .wav files not shipped).
//  - Trains: the 23 Train tasks carry only a scalar rail position and a
//    model name (608_01_1 etc.) — no world placement — so no trains or
//    rails are rendered. The one placed Car (622_01_1) IS rendered.
//
// v3 changes vs v2 (the fixes the user asked for):
//  1. Spawn yaw: v2 used yaw = -gamma (wrong by ~90 deg — the player
//     spawned facing away from the yard, which is why the first view was
//     empty ground). Correct mapping is yaw = gamma - PI/2: camera forward
//     (-sin yaw, -cos yaw) in Three maps to IGI (cos gamma, sin gamma).
//  2. Guards can no longer kill the player in 5–10 s from behind walls.
//     They start UNALERTED and patrol; they only engage when they can
//     actually see the player (range + front cone + line of sight past
//     the real Building footprints), when the player fires nearby, or
//     when shot. No line of sight = no shooting through walls.
//  3. Playigi's performance lessons (technique, NOT its code):
//     auto quality detection (deviceMemory / hardwareConcurrency / GPU
//     string), DPR cap (touch <= 1.5, x0.5–0.85 detail multiplier),
//     antialias off on phones, fog + draw-distance culling per preset,
//     and a 30 fps draw cap on touch (sim still runs at 60 Hz).
//  4. Three.js r186 (was r160), WebP atlas, player/building collision
//     from the real Building footprints, an objective compass, and a
//     live FPS readout so the user can report a real number.
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

// Camera yaw for an IGI gamma (facing angle in the IGI XY plane, rad).
// Three camera forward (yaw, YXZ) is (-sin yaw, 0, -cos yaw) in Three XZ,
// which maps to IGI (x = -sin yaw, y = cos yaw). Setting that equal to
// (cos gamma, sin gamma) gives yaw = gamma - PI/2. (v2 used yaw = -gamma,
// which faces ~90 deg away from the retail facing direction.)
export function yawForGamma(gammaRad) { return gammaRad - Math.PI / 2; }

// Atlas: 20 columns x 20 rows of 32 px cells in a 640x640 image. level1.json
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
// Auto quality — playigi's technique (device measurement -> preset),
// applied to this engine. Presets: potato / low / medium / high.
// pixelRatio = min(DPR, cap) * detailMul, antialias off on phones,
// fog + far plane and draw cap per preset. URL overrides: ?preset=,
// ?scale= (extra multiplier), ?dpr= (DPR cap), ?fps=30|60.
// ---------------------------------------------------------------------------
export function detectQuality(env = {}) {
  const isTouch = env.isTouch ?? (typeof matchMedia !== 'undefined'
    ? matchMedia('(pointer: coarse)').matches : false);
  const ram = env.deviceMemory ?? (typeof navigator !== 'undefined' ? (navigator.deviceMemory ?? 8) : 8);
  const cores = env.hardwareConcurrency ?? (typeof navigator !== 'undefined' ? (navigator.hardwareConcurrency || 4) : 4);
  const gpu = env.gpuString ?? '';
  const lowEnd = ram <= 3 || cores <= 4;
  const weakGpu = /adreno|mali|powervr|intel/i.test(gpu);
  let preset;
  if (isTouch) preset = lowEnd ? 'potato' : 'low';
  else if (lowEnd && weakGpu) preset = 'low';
  else if (lowEnd || weakGpu) preset = 'medium';
  else preset = 'high';
  return { isTouch, ram, cores, gpu, lowEnd, weakGpu, preset };
}

export const QUALITY = {
  potato: { dprCap: 1.2, detailMul: 0.5, fogNear: 60, fogFar: 150, far: 170, drawMs: 31, antialias: false },
  low:    { dprCap: 1.5, detailMul: 0.67, fogNear: 60, fogFar: 200, far: 220, drawMs: 31, antialias: false },
  medium: { dprCap: 1.5, detailMul: 0.85, fogNear: 60, fogFar: 260, far: 280, drawMs: 16, antialias: false },
  high:   { dprCap: 2, detailMul: 1, fogNear: 60, fogFar: 320, far: 340, drawMs: 16, antialias: true },
};

// Line of sight in IGI space (x, y horizontal, z up), against Building
// footprints. Each occluder is {x, y, r, zMin, zMax} — a bounding circle
// from the real model bounds + placement (rotation approximated away by
// the circle, which is conservative). Returns true when a building stands
// between the two eye points. This is game logic, not content: the
// footprints come from the real placements + real model bounds.
export function losBlocked(x1, y1, z1, x2, y2, z2, occluders) {
  const dx = x2 - x1, dy = y2 - y1, len2 = dx * dx + dy * dy;
  if (len2 === 0) return false;
  for (const o of occluders) {
    // Closest approach of the segment to the occluder centre (2D).
    let t = ((o.x - x1) * dx + (o.y - y1) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const cx = x1 + dx * t, cy = y1 + dy * t;
    const d2 = (cx - o.x) * (cx - o.x) + (cy - o.y) * (cy - o.y);
    if (d2 >= o.r * o.r) continue;
    const zAt = z1 + (z2 - z1) * t;
    // Blocked only if the sight line passes through the building's height.
    if (zAt > o.zMin && zAt < o.zMax) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Game state
// ---------------------------------------------------------------------------
const state = {
  hp: 100, ammo: 30, mag: 30, guardsLeft: 25, started: false, won: false, dead: false,
  yaw: 0, pitch: 0, pos: new THREE.Vector3(0, 0, 0),
  velY: 0, onGround: true, keys: {}, joy: { x: 0, y: 0 },
  firing: false, lastShot: 0, reloadUntil: 0, startTime: 0,
};

let renderer, scene, camera, level, models, placements, soldiers, atlasTex, enemies = [], tracers = [], clock;
let igiGroup; // converts IGI Z-up space to Three.js Y-up space
let objectiveThree = null; // [x, y, z] in Three space (SmallGarage)
let quality = null, occluders = [], soldierHeight = 1.8;
let lastDraw = 0, framesDrawn = 0, fpsCount = 0, fpsShown = 0, fpsLast = 0;

async function loadLevel() {
  loadEl.textContent = 'Loading Trainyard models… (169 real MEF models, 2.2 MB)';
  models = await (await fetch('data/level1_models.json?v=3')).json();
  loadEl.textContent = 'Loading Trainyard placements… (475 real objects.qvm placements)';
  placements = await (await fetch('data/level1_placements.json?v=3')).json();
  loadEl.textContent = 'Loading soldier poses… (real retail skeletons, common/anims/*.iff)';
  try {
    soldiers = await (await fetch('data/level1_soldiers.json?v=3')).json();
    soldierHeight = soldiers.meta?.heights_m
      ? Math.max(...Object.values(soldiers.meta.heights_m)) : 1.8;
  } catch (e) {
    soldiers = null; // fallback to v2 bind-pose geometry, flagged on screen
    console.warn('[v3] level1_soldiers.json missing — guards render at bind-pose size', e);
  }
  loadEl.textContent = 'Loading terrain + textures… (real hmp heights, 393-texture atlas)';
  level = await (await fetch('data/level1.json?v=3')).json();
  // WebP atlas (108 KB) first, PNG (684 KB) fallback.
  const loader = new THREE.TextureLoader();
  try {
    atlasTex = await loader.loadAsync('data/atlas.webp?v=3');
  } catch (e) {
    console.warn('[v3] atlas.webp failed, falling back to atlas.png', e);
    atlasTex = await loader.loadAsync('data/atlas.png?v=3');
  }
  atlasTex.colorSpace = THREE.SRGBColorSpace;
  atlasTex.magFilter = THREE.NearestFilter; // cheap on a phone GPU
  atlasTex.minFilter = THREE.NearestMipmapLinearFilter;
  atlasTex.generateMipmaps = true;
}

function buildOccluders() {
  // Real Building placements -> bounding circles from the real model bounds.
  const modelByName = new Map(models.models.map((m) => [m.name, m]));
  occluders = [];
  for (const p of placements.placements) {
    if (p.task_type !== 'Building') continue;
    const model = modelByName.get(p.model);
    if (!model || !model.verts.length) continue;
    let r = 0, zMin = Infinity, zMax = -Infinity;
    for (let i = 0; i < model.verts.length; i += 3) {
      const x = model.verts[i], y = model.verts[i + 1], z = model.verts[i + 2];
      r = Math.max(r, Math.hypot(x, y));
      if (z < zMin) zMin = z;
      if (z > zMax) zMax = z;
    }
    occluders.push({
      x: p.position_local_m[0], y: p.position_local_m[1], r: r * 0.95,
      zMin: p.position_local_m[2] + zMin, zMax: p.position_local_m[2] + zMax,
    });
  }
  console.log(`[v3] occluders: ${occluders.length} real Building footprints`);
  return occluders;
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
  console.log(`[v3] statics: ${rendered} placements, ${byModel.size} models, ${totalTris.toLocaleString()} instanced tris, ${skipped} skipped, ${skippedTris} tris skipped (null-tex groups)`);
  return { rendered, models: byModel.size, totalTris, skipped };
}

function buildGuards() {
  // All 29 real soldiers, at real positions/yaw. Geometry: the POSED
  // soldier models from level1_soldiers.json (real retail skeletons,
  // ~1.8 m tall, feet at local z = 0 after the min-Z shift). Fallback:
  // the v2 bind-pose geometry (0.64–0.84 m) if the posed file is missing.
  // 25 yard guards fight; 4 far guards (633–1337 m away, one 3.2 km
  // below the yard) are rendered and patrol in place but never chase,
  // never shoot, and are not counted in "guards left".
  const atlasMap = buildAtlasMap(level);
  const geoByModel = new Map();
  const soldierModels = soldiers ? soldiers.models : null;
  for (const name of ['000_01_1', '001_01_1', '003_01_1', '015_01_1', '019_01_1']) {
    const src = soldierModels
      ? soldierModels.find((m) => m.name === name)
      : models.models.find((m) => m.name === name);
    const { geometry } = buildModelGeometry(src, atlasMap);
    const zs = src.verts.filter((_, i) => i % 3 === 2);
    geometry.translate(0, 0, -Math.min(...zs)); // feet at local z = 0
    geoByModel.set(name, geometry);
  }
  const mat = new THREE.MeshLambertMaterial({
    map: atlasTex, alphaTest: 0.5, side: THREE.DoubleSide,
  });
  let withPatrol = 0, waypoints = 0, yard = 0, far = 0;
  for (const g of placements.guards) {
    const mesh = new THREE.Mesh(geoByModel.get(g.model), mat);
    mesh.position.set(g.position_local_m[0], g.position_local_m[1], g.position_local_m[2]);
    mesh.rotation.z = g.gamma_rad || 0;
    mesh.name = 'guard-' + g.task_id;
    igiGroup.add(mesh);
    const wps = (g.patrol && g.patrol.waypoints) ? g.patrol.waypoints.map((w) => w.position_local_m) : [];
    if (wps.length) { withPatrol++; waypoints += wps.length; }
    const distSpawn = Math.hypot(g.position_local_m[0], g.position_local_m[1]);
    const inYard = distSpawn < 200 && g.position_local_m[2] > -100;
    if (inYard) yard++; else far++;
    enemies.push({
      id: g.task_id, aiType: g.ai_type, mesh, hp: 50,
      igi: { x: g.position_local_m[0], y: g.position_local_m[1], z: g.position_local_m[2] },
      wps, wpIndex: 0, shootAt: 0, facing: g.gamma_rad || 0,
      sniper: g.ai_type === 'AITYPE_SNIPER',
      inYard, alerted: false, alertUntil: 0, aimSince: 0, canSee: false,
      lastSeen: null, perceiveAt: Math.random() * 250,
    });
  }
  state.guardsLeft = yard;
  $('left').textContent = state.guardsLeft;
  console.log(`[v3] guards: ${enemies.length} total, ${yard} yard / ${far} far, with patrol: ${withPatrol}, waypoints: ${waypoints}, posed: ${!!soldiers}`);
  return { total: enemies.length, yard, far, withPatrol, waypoints, posed: !!soldiers };
}

// Guard perception (IGI coords): can this guard see the player?
// Range + front cone (or very close) + line of sight past real buildings.
function guardCanSee(e, px, py, pzEye) {
  const dx = px - e.igi.x, dy = py - e.igi.y;
  const d = Math.hypot(dx, dy);
  const range = e.sniper ? 90 : 55;
  if (d > range) return false;
  if (d > 12) {
    // Front cone: 130 deg total around the guard's facing.
    const ang = Math.atan2(dy, dx);
    let diff = Math.abs(ang - e.facing);
    if (diff > Math.PI) diff = 2 * Math.PI - diff;
    if (diff > 1.14) return false; // ~65 deg each side
  }
  const eyeZ = e.igi.z + soldierHeight * 0.85;
  return !losBlocked(e.igi.x, e.igi.y, eyeZ, px, py, pzEye, occluders);
}

function alertGuardsNear(px, py, radius) {
  const now = performance.now();
  for (const e of enemies) {
    if (!e.inYard || e.hp <= 0) continue;
    if (Math.hypot(px - e.igi.x, py - e.igi.y) <= radius) {
      e.alerted = true; e.alertUntil = now + 8000;
      e.lastSeen = { x: px, y: py };
    }
  }
}

function shoot() {
  if (!state.started || state.dead || state.won) return;
  const now = performance.now();
  if (now - state.lastShot < 180 || now < state.reloadUntil) return;
  if (state.ammo <= 0) { reload(); return; }
  state.lastShot = now; state.ammo--;
  $('ammo').textContent = state.ammo;
  blip(880, 0.06, 0.15);
  // Firing alerts every yard guard within 70 m (they hear the shot).
  alertGuardsNear(state.pos.x, -state.pos.z, 70);
  // Hitscan: nearest living guard within a small cone of the camera direction.
  const dir = new THREE.Vector3(); camera.getWorldDirection(dir);
  let best = null, bestD = 1e9, bestPos = null;
  for (const e of enemies) {
    if (e.hp <= 0) continue;
    const gp = guardThreePos(e); // guard centre, ~half the posed height
    const to = gp.clone().sub(camera.position);
    const d = to.length();
    if (d > 100) continue;
    const ang = to.normalize().angleTo(dir);
    if (ang < 0.06 && d < bestD) { best = e; bestD = d; bestPos = gp; }
  }
  const end = bestPos || camera.position.clone().add(dir.multiplyScalar(60));
  const tg = new THREE.BufferGeometry().setFromPoints([camera.position.clone(), end]);
  const line = new THREE.Line(tg, new THREE.LineBasicMaterial({ color: 0xffe27a, transparent: true, opacity: 0.9 }));
  scene.add(line); tracers.push({ line, until: now + 70 });
  if (best) {
    best.hp -= 34;
    best.alerted = true; best.alertUntil = now + 8000;
    best.lastSeen = { x: state.pos.x, y: -state.pos.z };
    const hit = $('hit'); hit.style.opacity = 1; setTimeout(() => hit.style.opacity = 0, 120);
    if (best.hp <= 0) {
      best.mesh.visible = false;
      if (best.inYard) { state.guardsLeft--; $('left').textContent = state.guardsLeft; }
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
  return new THREE.Vector3(e.igi.x, e.igi.z + soldierHeight * 0.5, -e.igi.y);
}

function init() {
  // Auto quality (measured device -> preset), with URL overrides.
  const params = new URLSearchParams(location.search);
  let gpuStr = '';
  try {
    const gl = document.createElement('canvas').getContext('webgl2') || document.createElement('canvas').getContext('webgl');
    const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
    gpuStr = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : '';
  } catch (e) { /* GPU string is best-effort */ }
  const detected = detectQuality({ gpuString: gpuStr });
  const presetName = params.get('preset') || detected.preset;
  quality = QUALITY[presetName] || QUALITY[detected.preset];
  quality.presetName = presetName in QUALITY ? presetName : detected.preset;
  const dprCap = parseFloat(params.get('dpr') || '') || quality.dprCap;
  const scaleMul = parseFloat(params.get('scale') || '') || 1;
  const pixelRatio = Math.min(window.devicePixelRatio || 1, dprCap) * quality.detailMul * scaleMul;
  const fpsCap = parseInt(params.get('fps') || '', 10);
  quality.drawMs = fpsCap === 60 ? 16 : fpsCap === 30 ? 31 : quality.drawMs;

  renderer = new THREE.WebGLRenderer({ antialias: quality.antialias, powerPreference: 'low-power' });
  renderer.setPixelRatio(pixelRatio);
  renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = false;
  $('app').appendChild(renderer.domElement);
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x9db8d6);
  scene.fog = new THREE.Fog(0x9db8d6, quality.fogNear, quality.fogFar);
  camera = new THREE.PerspectiveCamera(68, innerWidth / innerHeight, 0.1, quality.far + 60);
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
  console.log(`[v3] quality: preset=${quality.presetName} (detected ${detected.preset}, RAM ${detected.ram} GB, ${detected.cores} cores, GPU "${gpuStr}"), pixelRatio=${pixelRatio.toFixed(2)}, draw cap ${quality.drawMs} ms, fog ${quality.fogNear}-${quality.fogFar} m`);
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

// Push the player out of real Building footprints (2D circles, IGI coords).
// Only when the building is tall enough to block the player at this height.
function collideBuildings() {
  const px = state.pos.x, py = -state.pos.z; // Three -> IGI
  const pz = state.pos.y - 1.7; // player feet (Three y is eye height +1.7)
  for (const o of occluders) {
    if (pz + 1.7 > o.zMax - 0.5) continue; // building too low to block here
    const dx = px - o.x, dy = py - o.y, d = Math.hypot(dx, dy);
    if (d < o.r && d > 0.001) {
      const push = o.r - d;
      state.pos.x += (dx / d) * push;
      state.pos.z -= (dy / d) * push;
    }
  }
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
  collideBuildings();
  // Gravity / ground follow
  const ground = groundHeightAt(state.pos.x, state.pos.z, level.terrain) + 1.7;
  state.velY -= 22 * dt;
  state.pos.y += state.velY * dt;
  if (state.pos.y <= ground) { state.pos.y = ground; state.velY = 0; state.onGround = true; }
  camera.position.copy(state.pos);
  if (state.firing) shoot();
  // Enemies — v3 fairness rules (game logic only; positions and patrols
  // are the decoded ones). Perception runs at 4 Hz per guard, staggered.
  const now = performance.now();
  const px = state.pos.x, py = -state.pos.z, pzEye = state.pos.y; // IGI coords, eye height
  const grace = now < state.startTime + 3000;
  for (const e of enemies) {
    if (e.hp <= 0) continue;
    if (now >= e.perceiveAt) {
      e.perceiveAt = now + 250;
      const wasAlerted = e.alerted;
      e.canSee = e.inYard ? guardCanSee(e, px, py, pzEye) : false;
      if (e.canSee) {
        e.alerted = true; e.alertUntil = now + 8000;
        e.lastSeen = { x: px, y: py };
        if (!e.aimSince) e.aimSince = now;
      } else {
        e.aimSince = 0;
        if (e.alerted && now > e.alertUntil) e.alerted = false;
      }
      if (e.alerted && !wasAlerted) { /* newly alerted: keeps lastSeen from perception */ }
    }
    if (!e.inYard) continue; // far guards patrol in place, never fight
    const gp = guardThreePos(e);
    const d = gp.distanceTo(state.pos);
    if (e.alerted && e.lastSeen) {
      // Chase the last seen position; shoot only with line of sight,
      // after an aim delay, with distance-based hit chance.
      const tx = e.lastSeen.x, ty = e.lastSeen.y;
      const dx = tx - e.igi.x, dy = ty - e.igi.y;
      const dl = Math.hypot(dx, dy);
      const shootRange = e.sniper ? 90 : 45;
      if (dl > 2) {
        const sp = 3.0;
        e.igi.x += (dx / dl) * sp * dt;
        e.igi.y += (dy / dl) * sp * dt;
        e.facing = Math.atan2(dy, dx);
        e.mesh.position.set(e.igi.x, e.igi.y, e.igi.z);
        e.mesh.rotation.z = e.facing;
      }
      const aimDelay = e.sniper ? 1200 : 400;
      if (e.canSee && d < shootRange && now - e.aimSince > aimDelay && now - e.shootAt > (e.sniper ? 2600 : 1600) && !grace) {
        e.shootAt = now;
        const hitChance = e.sniper ? 0.8 : Math.max(0.35, 1 - d / 90);
        if (Math.random() < hitChance) {
          state.hp -= e.sniper ? 10 + Math.random() * 6 : 4 + Math.random() * 3;
          $('hp').textContent = Math.max(0, Math.round(state.hp));
          const dmg = $('dmg'); dmg.style.opacity = 1; setTimeout(() => dmg.style.opacity = 0, 180);
          blip(180, 0.12, 0.12);
          if (state.hp <= 0) { state.dead = true; endScreen(false); }
        }
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
        e.facing = Math.atan2(wy, wx);
        e.mesh.position.set(e.igi.x, e.igi.y, e.igi.z);
        e.mesh.rotation.z = e.facing;
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
  // Compass arrow: rotate so up = the garage direction from the camera.
  const dxo = objectiveThree[0] - state.pos.x, dzo = objectiveThree[2] - state.pos.z;
  const fwdX = -Math.sin(state.yaw), fwdZ = -Math.cos(state.yaw);
  const rightX = Math.cos(state.yaw), rightZ = -Math.sin(state.yaw);
  const relX = dxo * rightX + dzo * rightZ, relZ = dxo * fwdX + dzo * fwdZ;
  $('compass').style.transform = `rotate(${Math.atan2(relX, relZ)}rad)`;
  const t = Math.floor((now - state.startTime) / 1000);
  $('time').textContent = Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0');
  if (od < 10) { state.won = true; endScreen(true); }
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
  const now = performance.now();
  if (state.started) update(dt);
  // Draw cap (playigi's trick): on touch the draw is capped at ~30 fps
  // while the sim keeps running at 60 Hz — a steady frame instead of
  // chasing 60 and stuttering.
  if (now - lastDraw >= (quality?.drawMs ?? 16) || !framesDrawn) {
    renderer.render(scene, camera);
    lastDraw = now;
    framesDrawn++;
    fpsCount++;
  }
  if (now - fpsLast >= 1000) {
    fpsShown = fpsCount;
    fpsCount = 0; fpsLast = now;
    const el = $('fps');
    if (el) el.textContent = fpsShown + ' fps';
  }
}

$('play').addEventListener('click', async () => {
  if (state.started) return;
  $('play').disabled = true;
  try {
    init();
    await loadLevel();
    loadEl.textContent = 'Building Trainyard… (real models at real positions)';
    buildTerrain();
    buildOccluders();
    const st = buildStatics();
    const gd = buildGuards();
    // Player spawn = decoded HumanPlayer position/yaw. Spawn local is (0,0,0)
    // in Three coords (IGI local origin = spawn). Camera yaw = gamma - PI/2
    // (v3 fix: v2's -gamma faced ~90 deg away from the retail direction),
    // eye 1.7 m above the ground.
    const spawn = placements.player_spawn;
    state.yaw = yawForGamma(spawn.gamma_rad);
    state.pos.set(0, groundHeightAt(0, 0, level.terrain) + 1.7, 0);
    camera.position.copy(state.pos);
    // Objective 1: SmallGarage, local (86.4, -51.3, -2.1) m IGI -> Three.
    objectiveThree = igiToThree(...placements.objective_location.position_local_m);
    state.startTime = performance.now();
    state.started = true;
    screenEl.style.display = 'none';
    hudEl.classList.add('on');
    toast(`Trainyard loaded — ${st.rendered} real objects, ${gd.yard} guards. Reach the Small Garage.`);
    if (!gd.posed) toast('Note: soldier pose data missing — guards render small (known limit).', 5000);
    loop();
  } catch (err) {
    loadEl.textContent = 'Load failed: ' + err.message + ' — serve with ./start.sh and open http://127.0.0.1:8782/';
    $('play').disabled = false;
    console.error(err);
  }
});
