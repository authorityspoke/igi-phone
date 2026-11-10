# IGI Phone — Mission 1: Trainyard (REAL Trainyard v2)

A lightweight Three.js / WebGL2 version of real Project IGI Mission 1,
built to be as smooth as playigi.com on a phone — the OpenIGI
(.NET WASM + WebGPU, ~40 MB runtime, uncompressed on GitHub Pages) build
was too laggy on the user's vivo V2424.

Live: https://authorityspoke.github.io/igi-phone/

Phone: left stick to move, drag the right side to look, FIRE / RELOAD / JUMP
buttons. Desktop: WASD + mouse, click to shoot, R reload, Space jump.

## What it is — v2 (REAL Trainyard)

- **Engine:** Three.js r160 (MIT, local file) + WebGL2. No .NET runtime,
  no WebGPU, no shadows, no post-processing, devicePixelRatio capped at 1,
  fog cuts the draw distance.
- **Download:** 4.43 MB raw / 1.24 MB gzipped — Three.js 671 KB +
  texture atlas 684 KB + models 2.2 MB + placements 920 KB + level data
  107 KB + game code 27 KB + page 5 KB.
- **Real IGI data, nothing invented:** the v1 build used seeded-scatter
  boxes and cylinders — the user rejected it ("this is not igi"). v2
  decodes the real formats from the user's own game files:
  - **MEF meshes: 169/169 LOD1 models decoded** (31,564 verts / 19,149
    tris, 976 draw groups) — real train/building/crate geometry.
  - **Exact placements: 440 statics** (63 distinct models) + **29 real
    guards** (21 patrol, 34 waypoints) at decoded positions from
    `objects.qvm`, with decoded orientations. Player spawn and the
    SmallGarage objective are decoded too.
  - Terrain heights from `terrain.hmp`, 393 decoded textures from
    `level1.res`, mission strings from `mission.qvm`.
  See `REPORT.md` for exactly what is real vs what is still missing.

## IMPORTANT — what data/ contains

`data/atlas.png`, `data/level1.json`, `data/level1_models.json` and
`data/level1_placements.json` are **derived from the user's own copy of
Project IGI (Innerloop Studios / Eidos, 2000)**: real textures downsampled
to 32x32 each, real terrain heights, real model geometry, and real
model/guard placements. They are published here at the user's explicit
instruction ("Host v2 on my GitHub Pages so I can play it") after being
told the sibling public repo `authorityspoke/igi-browser` stays code-only.

**This is a copyright/DMCA risk, stated plainly:** the user owns a copy of
the game, but owning a copy does not give a right to redistribute Eidos
game assets — even downsampled/converted ones — on a public repo. This
site may be taken down on a DMCA complaint, and if it is, the data files
must be removed. No full game files are included here: no `IGI.exe`,
no `.res`, no `.qvm`, no `.wav`, no full game folder. Not affiliated with
Innerloop / Eidos.

## Files

- `index.html` — title screen, HUD, touch controls
- `game.js` — Three.js engine, touch + desktop controls, guard AI
- `three.module.min.js` — Three.js r160 (MIT)
- `data/level1.json` — converted Trainyard data (107 KB)
- `data/atlas.png` — 393 real textures, 32x32 each, 640x640 (684 KB)
- `data/level1_models.json` — decoded MEF LOD1 meshes (2.2 MB)
- `data/level1_placements.json` — decoded placements, guards, objective (920 KB)
- `REPORT.md` — full build report, what is real vs still missing

## Limits (honest)

- Mission 1 only. Other missions are not converted yet.
- **No trains, no rails** — the train models have 0 placements in the
  data, and no extraction point exists in `objects.qvm`, so none is
  rendered. Nothing train-shaped was invented to fill the gap.
- **Soldier meshes render small (0.64–0.84 m tall)** — bone transforms
  were not decoded and no scale factor was invented.
- `terrain.cmd` main terrain shape is not decoded (flat + hmp detail
  only). No collision with buildings/props. Sounds are synthesised.
- No FPS number is claimed — there is no phone GPU on this VM to measure
  it. Gameplay/smoothness on the user's phone has NOT been verified by a
  live browser test yet.
