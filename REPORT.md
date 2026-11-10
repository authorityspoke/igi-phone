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
