# IGI Phone — lightweight build report

Date: 2026-11-11. Task: build a lightweight phone version of real IGI as
smooth as **playigi.com** on a phone (correction from the user: the
benchmark is playigi, NOT OpenIGI — OpenIGI on their vivo V2424 was
"too much laggy", playigi on the same phone is "not laggy at all").

## Why OpenIGI is laggy, and why this is lighter (verified)

| | OpenIGI web v0.6.7 | playigi.com (REA report) | This build |
|---|---|---|---|
| Engine | .NET 10 WASM AOT + WebGPU | Vite JS + Three.js + WebGL2 | Three.js r160 + WebGL2 only |
| Runtime | ~40 MB dotnet runtime | none | none |
| GPU API | WebGPU (required) | WebGL2 | WebGL2 |
| Loader | ~66 MB raw on GitHub Pages | 23 files / 17 MB | **~1.5 MB initial** |
| Shadows / post | vanilla preset | (not verified) | none |

Quick-win check (measured, not deployed): the OpenIGI `_framework/`
is **61.1 MB raw vs 13.0 MB Brotli — 4.7×**. GitHub Pages serves the raw
files (it does not serve the `.br`/`.gz` precompressed variants with
Content-Encoding, unlike OpenIGI's own dev server), so the first load on
a phone downloads ~61 MB of framework uncompressed. Serving the same
build from a host that serves `.br` (Cloudflare Pages / Netlify, or the
local `serve.py` here, which gzips text assets) would cut that to ~13 MB.
That helps load lag a lot, but it does **not** fix the runtime cost:
the .NET WASM + WebGPU engine is still heavy on a phone GPU. That is
why this build drops .NET/WebGPU entirely. **No public deployment was
made** — no Cloudflare/Netlify deploy, no GitHub push, no game data
published. That needs a separate instruction.

## Architecture

```
real IGI data (local only)
  PC/missions/location0/level1/terrain/terrain.hmp
  PC/missions/location0/level1/textures/level1.res  (ILFF IRES, 393 .tex)
  PC/missions/location0/level1/level1.dat (415 model groups)
  PC/missions/location0/level1/mission.qvm, objects.qvm, ai/*.qvm
        │  tools/convert_level1.py (offline, Python + Pillow)
        ▼
data/level1.json (107 KB) + data/atlas.png (684 KB, 640×640)
        │  fetched on Play
        ▼
game.js + three.module.min.js (r160, MIT, local)
  → WebGLRenderer, DPR=1, antialias off, no shadows, fog 60–240 m
  → terrain mesh 64×64, instanced props, 8 guards, touch controls
```

Phone optimisations (all in `game.js` / `index.html`):
- `renderer.setPixelRatio(1)` — the single biggest phone win.
- No shadows, no post-processing, `MeshLambertMaterial` only.
- Fog 60–240 m (short draw distance); camera far plane 260 m.
- Props grouped into ~8 `InstancedMesh`es (not 415 draw calls);
  terrain is 1 draw call; 8 enemies; train cars + rails are a few meshes.
- Textures are a single 640×640 atlas (one texture upload).
- Level data streams on demand: terrain + atlas + JSON only at Play.
- Touch: left virtual joystick, right-side drag to look, FIRE / RELOAD /
  JUMP buttons; desktop WASD + mouse fallback.

## What is REAL IGI data (verified by the converter)

Converter: `tools/convert_level1.py`. All numbers below are its output,
re-checked after the run.

- **Terrain — real.** `terrain.hmp`: 3 grids, all 128×128, exact walk
  (consumed 52,995 = file length). Grid 0 downsampled 128→64 (65×65
  samples). Samples are *signed* bytes, Bias 64, UnitsPerSample 256,
  UnitsPerMetre 4096 (OpenIGI `TerrainHeightGrid`: metres =
  (signed−64)×256/4096 = (signed−64)/16). Heights −3.27 m to +2.70 m
  (grid 0 signed min 11, max 113; grids 1–2: min 7, max 110/121).
  The heightmap is fine detail only — the main terrain shape lives in
  `terrain.cmd` (chunk geometry), which is **not** decoded here.
- **Textures — real, 393/393 decoded, 0 failed.** `level1.res` is an
  ILFF `IRES` archive: 786 chunks (393 NAME + 393 BODY). `.tex` v11
  headers (format u32 @+8, width @+22, height @+24, pitch =
  allocWidth×bytesPerPixel, payload @+32) decoded per OpenIGI
  `TextureDecoder.cs`: **365× A1R5G5B5, 28× BGRA32** (Palette8: 0 in
  this archive). Each downsampled to 32×32 into `atlas.png` (640×640,
  20 per row). Cross-check: all 393 unique texture names used by the
  415 model groups exist in the atlas — 0 missing.
- **Models — real list.** `level1.dat`: 415 groups (first group
  `210_01_1` → textures `207_01_1`, `316_04_1`; last group ends at
  line 2592), then a second section: count 393 + 393 texture names +
  terminator `0`. `level1.mtp` (IFF `FORM … MTP`, `MODS` chunk):
  1,193 model references. The `level1.json` keeps all 415 groups with
  their real texture names.
- **Mission — real strings.** `mission.qvm` (LOOP bytecode) contains
  `DefineMission`, `Mission 1 Name`, `Mission 1 Desc`,
  `missions/location0/level1`, `missions/location0/common`,
  `location0`, `level1`, `mission1.spr`.
- **AI — real ids.** 37 scripts in `level1/ai/` (`1205`, `1506`,
  `1512`, `1566`, `1667`, `1768`, `1898`, `1989`, …). The game spawns
  the first 8 as guards (phone cap).
- **Sounds — real filenames only.** 29 files in `level1/sounds/`
  (`_cut01_01.wav`, `m01_ing_01.wav`, … `m1_trainby01.wav`, …).
  The game synthesises gunshots with WebAudio; the real `.wav`
  files are listed in `level1.json` but not shipped/played.

## What is APPROXIMATED (honest limits)

- **Model placements are NOT the retail positions.** `level1.dat`
  lists models + textures, not world coordinates. Positions live in
  QVM bytecode (`objects.qvm`, 1,656 strings, `ObjectPos` /
  `Orientation` tasks) and `terrain.cmd` chunk geometry, neither of
  which is decoded in this session. Props are therefore placed by a
  deterministic seeded scatter (`mulberry32(1205)`, same yard every
  load), kept off the rail corridor, on the real terrain height.
- **MEF meshes are NOT decoded.** Props are low-poly boxes/cylinders
  coloured by the average colour of the group's first real texture.
  Train cars are long boxes on the rails (models `210_01_*`).
- **Enemy positions / behaviour are simplified.** Guards patrol
  seeded waypoints, chase within 55 m, shoot within 45 m. Real AI
  behaviour lives in the 37 `.qvm` scripts (not executed).
- **Mission 1 only.** Levels 2–14 are not converted (their bundles
  exist in `~/workspace/igi-wasm-full/data/`, same pipeline would
  apply — re-run the converter per level).
- **Sounds are synthesised**, not the real `.wav` files.
- **No FPS is claimed.** This VM has no phone GPU; FPS cannot be
  measured here. The lightness claims are about download size and
  draw-call count, which *were* measured (below).
- **Gameplay was NOT verified in a live browser.** A generic subagent
  cannot drive a live browser; the parent must open the URL on a
  phone / PC and play Trainyard. Do not claim it is smooth on the
  vivo V2424 until the user plays it there.

## Verification (all done this session)

- Converter: `python3 tools/convert_level1.py` — exit 0. Textures
  393/393, 0 failed; atlas 640×640; model groups 415; MTP refs 1,193;
  terrain 65×65 samples, min −3.266 m, max +2.703 m.
- `node --check game.js` (as .mjs) — syntax OK.
- Node headless check of the terrain sampler (same code as `game.js`):
  441 samples, min −2.17 m, max +1.91 m, no NaN; 8 enemy ids;
  29 sounds listed.
- Atlas: PIL opens it, 640×640 RGBA.
- Local server (port 8782, PID 2123, left running): curl all 200 —
  `index.html` 5,192 B; `game.js` 19,879 B (7,034 B gzipped);
  `three.module.min.js` 670,681 B; `data/level1.json` 109,121 B;
  `data/atlas.png` 684,472 B. `serve.py` gzips text assets on the fly.
- Initial download total: **~1,487 KB raw** (index + three + game +
  atlas + JSON), ~1.1 MB with gzip — vs playigi's 17 MB loader and
  OpenIGI's ~66 MB raw / ~13 MB Brotli framework alone.

## How to run

```sh
cd ~/workspace/igi-phone && ./start.sh
# http://127.0.0.1:8782/  (same machine only; server PID 2123, port 8782)
```

## What remains to match playigi smoothness on the phone

1. **Play-test on the vivo V2424** (parent/user step) — confirm the
   touch controls, frame rate and load time in a real phone browser.
2. **Decode real placements** — parse `objects.qvm` positions and/or
   `terrain.cmd` chunk geometry, so props/trains sit where retail put
   them instead of a seeded scatter.
3. **Decode MEF meshes** — use OpenIGI's `MefModel`/`MefMeshFormat`
   docs to render real train/building geometry instead of boxes.
4. **Real sounds** — stream the 29 level-1 `.wav` files on demand
   (they are small; the ambience/gunshot files are the ones that matter).
5. **Levels 2–14** — re-run the converter per level (same pipeline).
6. **Public hosting (needs a separate instruction)** — the converted
   `data/` is Eidos game data; do not publish it. A public version
   would need either the folder-picker route (OpenIGI's design) or
   OpenIGI's hosted data, as the current `igi-browser` link does.

## MEF mesh decode (2026-11-11, ~00:30 PKT)
Decoder: `tools/decode_mef.py` (pure Python, follows OpenIGI `MefModel.cs` IGI1
profile; no playigi code). Output: `data/level1_models.json` (2,226,251 bytes).
- Source: `models/level1.res` holds 415 `.mef` entries (ILFF/OCEM containers),
  NOT loose files. 169 distinct base models; suffix `_1`..`_5` = LOD levels
  (file size falls with N). Only LOD1 decoded; 246 lower LODs dropped.
- Format: MESH header 156B (version float32 0.1 = bits 0x3DCCCCCD, format u32
  @32: 0 Diffuse / 1 Skinned / 3 Lightmapped, tris @96, verts @100). RD3D
  header offsets per format; vertices 32B (Diffuse: pos/normal/UV) or 40B
  (Lightmapped: +lightmap UV; Skinned: bytes 32..39 are bone binding, not UV).
  REND records: 28B/32B header + inline u16 indices RELATIVE to baseVertex.
  Positions converted IGI units -> metres (/4096), rounded 4dp.
- Texture per draw group resolved through the real chain: level1.mtp
  INST slot -> GTT material -> TEXF name; cross-checked against level1.dat
  texture lists — 0 mismatches, 0 conflicts between instances.
- Results: 169/169 LOD1 models decoded, 0 blocked, 31,564 verts, 19,149 tris,
  976 draw groups. Formats: Lightmapped 151, Diffuse 13, Skinned 5 (base
  vertices only; 231–377 extra bone influences per skinned model dropped as
  non-geometry). 336 groups flagged transparent, 0 additive. 2 groups have no
  material (slot 0xFFFF): `waypoint` (marker, 58 verts) and `605_01_1` (4 tris).
  4 models are genuinely empty in the original (MESH header 0 verts/0 tris):
  `610_03_1`, `610_04_1`, `700_08_1`, `700_19_1` — decoded, not failures.
- Validation: JSON loads in Python and Node; no NaN/Inf; all indices in
  bounds; every REND chunk walk consumed byte-exactly and triangle totals
  match MESH headers; all 31,564 normals are unit length (0.999–1.001).
  Model-space bounds x[-25.5,130] y[-29.1,24] z[-9.1,23.2] m. UVs range
  -123.9..133.9 (tiled/repeating — renderer needs RepeatWrapping).
- Dropped, not substituted: lightmap UVs (diffuse shading only on phone),
  lower LODs, skinned extra influences, collision/portal/magic-vertex chunks.
  Placements still approximated (world coords live in terrain.cmd / QVM, not
  in .mef) — next step is decoding those, not the meshes.

## v2 — REAL Trainyard rebuild (2026-11-11, ~00:35 PKT)

The v1 seeded-scatter boxes are GONE. `game.js` was rewritten in place;
`index.html` text updated (objective, 29 guards, download size). No new
large assets added; nothing re-hosted to GitHub Pages (local only, port 8782).

### What the scene now contains (all decoded, nothing invented)

- **Statics — 440 placements, 63 distinct models, 26,600 instanced tris.**
  One `InstancedMesh` per model (63 draw calls), each instance matrix built
  from the decoded `position_local_m` + decoded orientation
  (`R = Rz(gamma).Ry(beta).Rx(alpha)`, matrix supplied per placement).
  Geometry = the real MEF LOD1 meshes (31,564 verts / 19,149 tris total),
  merged per model, UVs remapped per draw group into the model's real
  atlas cell. **0 model textures missing from the atlas** (380 distinct
  names, all 393 atlas cells mapped). Transparent groups (336, 1-bit alpha)
  render via `alphaTest: 0.5`; `DoubleSide` (MEF winding is D3D clockwise).
  Top model: `905_01_1` x78, `303_02_1` x43, `306_01_1` x43.
- **Guards — all 29 real soldiers** at real positions/yaw, models
  `000_01_1` x5, `001_01_1` x1, `003_01_1` x10, `015_01_1` x1,
  `019_01_1` x12. **21 patrol** (34 waypoints, all resolved to real graph
  nodes); 8 stand at their spawn (guard/sniper posts). Patrol / chase /
  shoot is game logic only; positions and patrols are the decoded ones.
  Sniper (task 2000, Dragunov) shoots from 90 m, others 45 m.
- **Player spawn** = decoded HumanPlayer `TheGoodGuy`, local (0,0,0),
  gamma 177.387 deg (camera yaw = -gamma per the decoder's
  RetailOrientation note; the +gamma/-gamma ambiguity is only ~5 deg here
  because gamma is ~177 deg). Eye 1.7 m above ground.
- **Objective 1** = reach the SmallGarage (model `410_01_1`, task 1120) at
  local (86.4, -51.3, -2.1) m; win radius 10 m. HUD shows live distance.
  The objective's retail trigger (`EditVariable_105.nValue == 1`) was not
  decoded, so reaching the garage stands in as the objective — stated
  in-game and here. The 6 `ExplodeObject` "Computer" tasks
  (model `203_01_1`) are rendered as normal placements.
- **Ground** = flat plane + real `terrain.hmp` grid-0 detail (65x65) over a
  400 m patch centred on the spawn (v1 convention; the hmp extent is not
  recorded anywhere in the data — no tested extent 400–2600 m made
  placement Z correlate tightly with hmp height, IQR ~1.7–2.1 m at all of
  them, so the hmp is detail only). **Flat level is -1.77 m local, not 0:**
  the task brief said Z=0, but the data says otherwise — median Z of the
  389 near-spawn placements is -1.77 m (p25 -2.09, p75 -1.05) and every
  model origin sits at its base (median model min-Z -0.04 m), so a plane
  at 0 would bury the whole yard ~1.8 m deep. Ground = hmp inside the
  patch, -1.77 m outside, smoothstep-blended over 180–220 m. Ground mesh
  1400x1600 m, 1 draw call; player clamped to the yard
  (Three x -650..620, z -120..1300).
- **No trains, no rails, no invented extraction zone.** The v1 green
  extraction cylinder and train boxes are deleted. 23 Train tasks are
  scalar rail positions only; no train model (`608_01_1`, `609_01_1`,
  `607_01_1`, `210_01_1`) appears as a normal placement (0 placements
  each), so nothing train-shaped is rendered. No extraction point exists
  in `objects.qvm` — none is shown or used.
- **Sounds** still synthesised WebAudio (real `.wav` not shipped).
- **Controls/HUD** unchanged from v1 (touch joystick + look drag +
  FIRE/RELOAD/JUMP, WASD/mouse fallback); HUD objective line now reads
  the real objective + live distance; guards pill starts at 29.

### Left out / still missing (all listed, nothing substituted)

- `waypoint` model x4 placements (`SCameraControl`/`AlarmControl` markers
  at local z -44.7/-75.5 m) — engine markers, invisible in retail; skipped.
- `472_01_1` x1 placement (Building, local (-122.4, 41.3, -3238.1) m) —
  unknown model, no geometry decoded; skipped.
- 4 genuinely empty models (`610_03_1`, `610_04_1`, `700_08_1`,
  `700_19_1`) — 0 placements, nothing to render.
- 2 placements ~3.2 km below the yard (a Building and a Heli at local
  z ≈ -3236/-3238 m) ARE rendered (instanced, far below the ground plane,
  invisible from the yard) — they are real placements, left as decoded.
  4 guards are far from the yard (1505 at (-463,-1254,+126), 2021 at
  (-535,-339,+22), 1666 at (-579,-441,+26), one at (-116,+42,-3236));
  they are rendered and patrol/chase in place but do NOT block the win
  (win = reach the garage), since the far ones are unreachable.
- **Soldier meshes render small (0.64–0.84 m tall).** The 5 skinned
  character models decode to base bind-pose vertices only; bone transforms
  (which pose/scale the character in the retail engine) were not decoded,
  and the stored mesh spans only 0.64–0.84 m in Z with its origin at body
  centre. No scale factor was invented: the geometry is rendered as
  decoded, shifted so its feet sit at the decoded placement point (the
  origin-at-base convention of every other model). If the user says the
  guards look too small, the fix is decoding the skeleton/bone transforms,
  not guessing a scale.
- `terrain.cmd` main terrain shape — not decoded (same as v1); ground is
  flat + hmp detail only. MEF lightmaps, lower LODs, skinned bone
  influences, collision/portal data — dropped, not substituted.
  Levels 2–14 — not converted. No collision with buildings/props (not
  decoded); the player walks on ground height only.
- UV mapping assumption (documented, not verified in a live browser):
  MEF UVs are Direct3D (v=0 at texture top, tiling) and `.tex` pixel rows
  are top-down, so model v maps to atlas v = 1 - (cellTop + frac(v)/20)
  with flipY on. If textures look vertically flipped in play, this is the
  place to flip.
- 491 positioned tasks without a model (graph nodes, spline waypoints,
  triggers, etc.) have no geometry and are not rendered.

### Verification (this session)

- `node --check game.js` (as .mjs) — syntax OK.
- Python `json.load` — `level1_models.json`, `level1_placements.json`,
  `level1.json` all valid.
- New headless smoke test `tools/smoke_test.mjs` — imports the SHIPPED
  `game.js` builder functions and runs them against the real data files:
  **26/26 PASS**, including: atlas 393 cells, 0 missing model textures,
  merged geometry 19,117 tris (19,149 − 32 null-tex tris from `waypoint`
  + `605_01_1`, neither placed), all remapped UVs in [0,1], no NaN/bad
  normals, 440 static placements / 63 models / 26,600 instanced tris,
  all 440 instance matrices valid (translation = decoded local position,
  rotation determinant = 1), 29 guards / 21 patrols / 34 waypoints,
  ground height finite across the whole yard clamp, objective at Three
  (86.44, -2.09, 51.29), spawn gamma 177.387 deg, extraction null.
- Local server (port 8782, PID 2123, still running from v1 — no restart
  needed): curl 200 for `index.html`, `game.js`, `three.module.min.js`,
  `data/level1.json`, `data/level1_models.json`,
  `data/level1_placements.json`, `data/atlas.png`.
- Download: **4.43 MB raw, 1.24 MB over the wire with gzip**
  (index 2.1 KB, game.js 10.0 KB, three r160 167 KB, level1.json 18 KB,
  models JSON 322 KB gzipped from 2.2 MB, placements 92 KB gzipped from
  920 KB, atlas.png 684 KB). Draw calls ≈ 63 statics + 29 guards +
  terrain + lights ≈ 95. No FPS claimed.
- **Gameplay / smoothness NOT verified in a live browser** — a generic
  subagent cannot drive a live browser. Parent/user must play it on the
  vivo V2424 (or a PC) at http://127.0.0.1:8782/ (same machine only) and
  confirm the yard looks like real Trainyard, the controls work, and the
  frame rate holds. Do not claim it is smooth until the user plays it.

### How to run

```sh
cd ~/workspace/igi-phone && ./start.sh
# http://127.0.0.1:8782/  (same machine only; server PID 2123, port 8782)
# node tools/smoke_test.mjs  (headless re-check of the scene builders)
```
