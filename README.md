# IGI Phone — Mission 1: Trainyard (lightweight)

A lightweight Three.js / WebGL2 version of real Project IGI Mission 1,
built to be as smooth as playigi.com on a phone — the OpenIGI
(.NET WASM + WebGPU, ~40 MB runtime, uncompressed on GitHub Pages) build
was too laggy on the user's vivo V2424.

Live: https://authorityspoke.github.io/igi-phone/

Phone: left stick to move, drag the right side to look, FIRE / RELOAD / JUMP
buttons. Desktop: WASD + mouse, click to shoot, R reload, Space jump.

## What it is

- **Engine:** Three.js r160 (MIT, local file) + WebGL2. No .NET runtime,
  no WebGPU, no shadows, no post-processing, devicePixelRatio capped at 1,
  fog cuts the draw distance to ~240 m.
- **Initial download:** ~1.5 MB raw — Three.js 671 KB + texture atlas
  684 KB + level data 107 KB + game code 20 KB + page 5 KB.
- **Real IGI data** (converted offline by `tools/convert_level1.py` in the
  local build folder): terrain heights from `terrain.hmp`, 393 decoded
  textures from `level1.res`, 415 model groups from `level1.dat`, 37 AI
  scripts, mission strings from `mission.qvm`. See `REPORT.md` for exactly
  what is real vs approximated.

## IMPORTANT — what data/ contains

`data/atlas.png` and `data/level1.json` are **derived from the user's own
copy of Project IGI (Innerloop Studios / Eidos, 2000)**: real textures
downsampled to 32x32 each, real terrain heights, real model-group and
mission data. They are published here at the user's explicit instruction
("Host it on my GitHub Pages so I can play on my phone") after being told
the sibling public repo `authorityspoke/igi-browser` stays code-only.

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
- `REPORT.md` — full build report, what is real vs approximated

## Limits (honest)

- Mission 1 only. Other missions are not converted yet.
- Model placements are a deterministic seeded scatter, not the retail
  positions (those live in QVM bytecode / terrain.cmd, not decoded).
- MEF meshes are not decoded — props are low-poly boxes/cylinders
  coloured by the real texture averages.
- Sounds are synthesised; the real `.wav` filenames are listed in the data.
- No FPS number is claimed — there is no phone GPU on this VM to measure it.
  Gameplay/smoothness on the user's phone has NOT been verified by a live
  browser test yet.
