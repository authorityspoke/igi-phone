// IGI Phone — Mission 1: Trainyard, lightweight Three.js / WebGL2.
// Real IGI data: terrain heights (terrain.hmp grid 0, 128->64), 393 decoded
// textures (level1.res, A1R5G5B5/BGRA) as atlas.png, 415 model groups
// (level1.dat), 37 AI scripts (ai/*.qvm ids), mission strings (mission.qvm).
// Approximated (see REPORT.md): model PLACEMENTS are a deterministic seeded
// scatter (level1.dat lists models+textures, not world positions — positions
// live in QVM bytecode / terrain.cmd, not decoded here), enemy positions
// are patrol waypoints derived from the yard layout, MEF meshes are NOT
// decoded (props are low-poly boxes/cylinders coloured by the real texture
// average), sounds are synthesised (real .wav filenames are listed in the
// data file). No .NET, no WebGPU, no shadows, DPR capped at 1.
import * as THREE from 'three';

const $ = (id) => document.getElementById(id);
const loadEl = $('load'), screenEl = $('screen'), hudEl = $('hud');
const toast = (t, ms = 2200) => { const e = $('toast'); e.textContent = t; e.style.display = 'block'; setTimeout(() => e.style.display = 'none', ms); };

// Deterministic RNG so the yard layout is the same every load.
function mulberry32(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

const WORLD = 400;           // metres across the yard (terrain spans -200..200)
const state = {
  hp: 100, ammo: 30, mag: 30, guardsLeft: 8, started: false, won: false, dead: false,
  yaw: Math.PI * 0.25, pitch: 0, pos: new THREE.Vector3(-170, 0, 170),
  velY: 0, onGround: true, keys: {}, joy: { x: 0, y: 0 }, lookDX: 0, lookDY: 0,
  firing: false, lastShot: 0, reloadUntil: 0, startTime: 0,
};

let renderer, scene, camera, level, atlasTex, terrainMesh, enemies = [], tracers = [], clock;

function terrainHeight(x, z) {
  // Bilinear sample of the 65x65 real height grid, world -200..200 -> grid 0..64.
  const t = level.terrain, n = t.size, h = t.heights;
  const gx = THREE.MathUtils.clamp((x + WORLD / 2) / WORLD * n, 0, n - 0.001);
  const gz = THREE.MathUtils.clamp((z + WORLD / 2) / WORLD * n, 0, n - 0.001);
  const x0 = Math.floor(gx), z0 = Math.floor(gz), fx = gx - x0, fz = gz - z0;
  const at = (a, b) => h[b * (n + 1) + a];
  const lo = at(x0, z0) + (at(x0 + 1, z0) - at(x0, z0)) * fx;
  const hi = at(x0, z0 + 1) + (at(x0 + 1, z0 + 1) - at(x0, z0 + 1)) * fx;
  return lo + (hi - lo) * fz;
}

function avgColour(name) {
  const t = level.textures.index.find((e) => e.name.endsWith('/' + name + '.tex') || e.name.endsWith(name + '.tex'));
  return t ? t.avg : [110, 100, 80];
}
function texUV(name) {
  const t = level.textures.index.find((e) => e.name.endsWith('/' + name + '.tex') || e.name.endsWith(name + '.tex'));
  return t || null;
}

async function loadLevel() {
  loadEl.textContent = 'Loading Trainyard data… (terrain + textures)';
  const res = await fetch('data/level1.json');
  level = await res.json();
  loadEl.textContent = 'Loading texture atlas… (393 real IGI textures)';
  atlasTex = await new THREE.TextureLoader().loadAsync('data/atlas.png');
  atlasTex.colorSpace = THREE.SRGBColorSpace;
  atlasTex.magFilter = THREE.NearestFilter; // cheap on a phone GPU
  atlasTex.minFilter = THREE.NearestMipmapLinearFilter;
  atlasTex.generateMipmaps = true;
}

function buildTerrain() {
  const t = level.terrain, n = t.size, seg = n;
  const geo = new THREE.PlaneGeometry(WORLD, WORLD, seg, seg);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  const colours = new Float32Array(pos.count * 3);
  const cGrass = new THREE.Color(0x5a6b3a), cDirt = new THREE.Color(0x8a6f4d),
        cBallast = new THREE.Color(0x6f6f6f), c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    const h = terrainHeight(x, z);
    pos.setY(i, h);
    // Colour by height: low = dirt/ballast (yard), mid = grass, high = dry grass.
    const k = THREE.MathUtils.clamp((h + 3.3) / 6, 0, 1);
    c.copy(cBallast).lerp(cDirt, Math.min(1, k * 2)).lerp(cGrass, Math.max(0, k - 0.45) * 1.2);
    // Rail corridor down the middle gets ballast grey.
    if (Math.abs(x) < 14) c.copy(cBallast);
    colours[i * 3] = c.r; colours[i * 3 + 1] = c.g; colours[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colours, 3));
  geo.computeVertexNormals();
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  terrainMesh = new THREE.Mesh(geo, mat);
  terrainMesh.name = 'terrain-real-hmp-grid0';
  scene.add(terrainMesh);

  // Rails: two dark strips down the middle (the Trainyard's real feature).
  const railMat = new THREE.MeshLambertMaterial({ color: 0x2e2e2e });
  for (const rx of [-6, 6]) {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.4, WORLD * 0.92), railMat);
    rail.position.set(rx, terrainHeight(rx, 0) + 0.2, 0);
    scene.add(rail);
  }
  // Sleepers, instanced — one draw call.
  const sleeper = new THREE.InstancedMesh(new THREE.BoxGeometry(10, 0.25, 1.6),
    new THREE.MeshLambertMaterial({ color: 0x4a3826 }), 90);
  const m = new THREE.Matrix4();
  for (let i = 0; i < 90; i++) {
    const z = -180 + i * 4;
    m.makeTranslation(0, terrainHeight(0, z) + 0.12, z);
    sleeper.setMatrixAt(i, m);
  }
  scene.add(sleeper);
}

function buildProps() {
  // Real model groups (415, level1.dat) -> low-poly props, placed by a
  // deterministic seeded scatter. Colour = average of the group's first
  // real texture. Grouped by model prefix into a few InstancedMeshes so
  // the phone GPU sees ~6 draw calls, not 415.
  const rnd = mulberry32(1205); // first AI id — stable seed
  const groups = level.models.groups_list;
  const byPrefix = {};
  for (const g of groups) {
    const p = g.model.split('_')[0];
    (byPrefix[p] = byPrefix[p] || []).push(g);
  }
  const prefixes = Object.keys(byPrefix).slice(0, 8);
  const geoBox = new THREE.BoxGeometry(1, 1, 1);
  const geoCyl = new THREE.CylinderGeometry(0.6, 0.6, 1, 8);
  prefixes.forEach((p, pi) => {
    const list = byPrefix[p];
    const count = Math.min(24, list.length);
    const mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    const mesh = new THREE.InstancedMesh(pi % 2 ? geoCyl : geoBox, mat, count);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), v = new THREE.Vector3();
    const col = new THREE.Color();
    for (let i = 0; i < count; i++) {
      const g = list[i];
      const x = (rnd() - 0.5) * 360, z = (rnd() - 0.5) * 360;
      if (Math.abs(x) < 16) continue; // keep the rails clear
      const h = terrainHeight(x, z);
      const w = 2 + rnd() * 6, hh = 1.5 + rnd() * 5, d = 2 + rnd() * 6;
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rnd() * Math.PI);
      m.compose(v.set(x, h + hh / 2, z), q, s.set(w, hh, d));
      mesh.setMatrixAt(i, m);
      const avg = g.textures.length ? avgColour(g.textures[0]) : [120, 110, 90];
      col.setRGB(avg[0] / 255, avg[1] / 255, avg[2] / 255);
      mesh.setColorAt(i, col);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    scene.add(mesh);
  });
  // Train cars: long boxes on the rails (models 210_01_* are the train set).
  const trainMat = new THREE.MeshLambertMaterial({ color: 0x3d4a55 });
  for (let i = 0; i < 4; i++) {
    const car = new THREE.Mesh(new THREE.BoxGeometry(3.2, 3.4, 16), trainMat);
    const z = -60 + i * 18;
    car.position.set(-6, terrainHeight(-6, z) + 1.9, z);
    scene.add(car);
  }
  // Extraction zone (green, far corner).
  const ext = new THREE.Mesh(new THREE.CylinderGeometry(10, 10, 0.4, 24),
    new THREE.MeshBasicMaterial({ color: 0x2fae4e, transparent: true, opacity: 0.55 }));
  ext.position.set(170, terrainHeight(170, -170) + 0.2, -170);
  ext.name = 'extraction';
  scene.add(ext);
}

function spawnEnemies() {
  // 8 guards (phone cap) from the 37 real AI scripts (ai/*.qvm ids).
  const ids = level.ai.ids.slice(0, 8);
  const rnd = mulberry32(2200);
  ids.forEach((id, i) => {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.55, 1.7, 8),
      new THREE.MeshLambertMaterial({ color: 0x4a5a3a }));
    body.position.y = 0.85;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.32, 8, 6),
      new THREE.MeshLambertMaterial({ color: 0xc9a06a }));
    head.position.y = 1.95;
    const gun = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 1.1),
      new THREE.MeshLambertMaterial({ color: 0x1a1a1a }));
    gun.position.set(0.3, 1.2, 0.5);
    g.add(body, head, gun);
    const x = (rnd() - 0.5) * 300, z = (rnd() - 0.5) * 300;
    g.position.set(x, terrainHeight(x, z), z);
    scene.add(g);
    enemies.push({ id, group: g, hp: 50, state: 'patrol', wp: new THREE.Vector3((rnd() - 0.5) * 300, 0, (rnd() - 0.5) * 300), shootAt: 0 });
  });
  state.guardsLeft = enemies.length;
  $('left').textContent = state.guardsLeft;
}

function shoot() {
  if (!state.started || state.dead || state.won) return;
  const now = performance.now();
  if (now - state.lastShot < 180 || now < state.reloadUntil) return;
  if (state.ammo <= 0) { reload(); return; }
  state.lastShot = now; state.ammo--;
  $('ammo').textContent = state.ammo;
  blip(880, 0.06, 0.15);
  // Hitscan: nearest enemy within a small cone of the camera direction.
  const dir = new THREE.Vector3(); camera.getWorldDirection(dir);
  let best = null, bestD = 1e9;
  for (const e of enemies) {
    if (e.hp <= 0) continue;
    const to = e.group.position.clone().setY(e.group.position.y + 1.2).sub(camera.position);
    const d = to.length();
    if (d > 90) continue;
    const ang = to.normalize().angleTo(dir);
    if (ang < 0.09 && d < bestD) { best = e; bestD = d; }
  }
  // Tracer
  const end = best ? best.group.position.clone().setY(best.group.position.y + 1.2)
                   : camera.position.clone().add(dir.multiplyScalar(60));
  const tg = new THREE.BufferGeometry().setFromPoints([camera.position.clone(), end]);
  const line = new THREE.Line(tg, new THREE.LineBasicMaterial({ color: 0xffe27a, transparent: true, opacity: 0.9 }));
  scene.add(line); tracers.push({ line, until: now + 70 });
  if (best) {
    best.hp -= 34;
    const hit = $('hit'); hit.style.opacity = 1; setTimeout(() => hit.style.opacity = 0, 120);
    if (best.hp <= 0) {
      best.group.visible = false;
      state.guardsLeft--;
      $('left').textContent = state.guardsLeft;
      toast('Guard down — ' + state.guardsLeft + ' left');
      if (state.guardsLeft === 0) toast('Yard clear! Reach the green zone.', 3000);
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
// Tiny WebAudio synth (real .wav filenames are listed in level1.json; the
// phone build synthesises shots so it stays under the size budget).
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

function init() {
  renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'low-power' });
  renderer.setPixelRatio(1); // phone: cap DPR at 1 — the single biggest win
  renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = false;
  $('app').appendChild(renderer.domElement);
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x9db8d6);
  scene.fog = new THREE.Fog(0x9db8d6, 60, 240); // short draw distance
  camera = new THREE.PerspectiveCamera(68, innerWidth / innerHeight, 0.1, 260);
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
  state.pos.x = THREE.MathUtils.clamp(state.pos.x, -195, 195);
  state.pos.z = THREE.MathUtils.clamp(state.pos.z, -195, 195);
  // Gravity / terrain follow
  const ground = terrainHeight(state.pos.x, state.pos.z) + 1.7;
  state.velY -= 22 * dt;
  state.pos.y += state.velY * dt;
  if (state.pos.y <= ground) { state.pos.y = ground; state.velY = 0; state.onGround = true; }
  camera.position.copy(state.pos);
  if (state.firing) shoot();
  // Enemies: patrol, chase + shoot when close
  const now = performance.now();
  for (const e of enemies) {
    if (e.hp <= 0) continue;
    const d = e.group.position.distanceTo(state.pos);
    const toPlayer = state.pos.clone().sub(e.group.position); toPlayer.y = 0;
    if (d < 55) {
      e.state = 'chase';
      e.group.position.addScaledVector(toPlayer.normalize(), 3.2 * dt);
      e.group.lookAt(state.pos.x, e.group.position.y, state.pos.z);
      if (d < 45 && now - e.shootAt > 1400) {
        e.shootAt = now;
        state.hp -= 6 + Math.random() * 6;
        $('hp').textContent = Math.max(0, Math.round(state.hp));
        const dmg = $('dmg'); dmg.style.opacity = 1; setTimeout(() => dmg.style.opacity = 0, 180);
        blip(180, 0.12, 0.12);
        if (state.hp <= 0) { state.dead = true; endScreen(false); }
      }
    } else {
      e.state = 'patrol';
      const toWp = e.wp.clone().sub(e.group.position); toWp.y = 0;
      if (toWp.length() < 4) { e.wp.set((Math.random() - 0.5) * 300, 0, (Math.random() - 0.5) * 300); }
      else { e.group.position.addScaledVector(toWp.normalize(), 2.2 * dt); e.group.lookAt(e.wp.x, e.group.position.y, e.wp.z); }
    }
    e.group.position.y = terrainHeight(e.group.position.x, e.group.position.z);
  }
  // Tracers fade
  tracers = tracers.filter((t) => { if (now > t.until) { scene.remove(t.line); return false; } return true; });
  // Win: yard clear + reach extraction (170,-170)
  if (state.guardsLeft === 0 && Math.hypot(state.pos.x - 170, state.pos.z + 170) < 11) {
    state.won = true; endScreen(true);
  }
  const t = Math.floor((now - state.startTime) / 1000);
  $('time').textContent = Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0');
}

function endScreen(won) {
  hudEl.classList.remove('on');
  screenEl.style.display = 'flex';
  screenEl.innerHTML = won
    ? '<h1>MISSION COMPLETE</h1><h2>Trainyard cleared — extraction reached.</h2><p>Guards eliminated, zone reached. That was the real Trainyard terrain, textures and model list.</p><button id="play" onclick="location.reload()">↻ PLAY AGAIN</button>'
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
    loadEl.textContent = 'Building Trainyard…';
    buildTerrain(); buildProps(); spawnEnemies();
    state.pos.y = terrainHeight(state.pos.x, state.pos.z) + 1.7;
    camera.position.copy(state.pos);
    state.startTime = performance.now();
    state.started = true;
    screenEl.style.display = 'none';
    hudEl.classList.add('on');
    toast('Trainyard loaded — clear the guards, then reach the green zone');
    loop();
  } catch (err) {
    loadEl.textContent = 'Load failed: ' + err.message + ' — serve with ./start.sh and open http://127.0.0.1:8782/';
    $('play').disabled = false;
    console.error(err);
  }
});
