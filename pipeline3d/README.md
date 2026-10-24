# 3D street pipeline: from a phone video to a textured street model

How to turn a walk-through video of a street into a textured 3D mesh, placed on the map in the app's
frame. This is the *how* for Steps 2–5 of [SPEC-3D-STREETS.md](../SPEC-3D-STREETS.md) (Step 1, capture,
is described there). Everything runs on a laptop without an NVIDIA GPU; with one, use the CUDA builds
and it is much faster.

**Status legend:** ✅ run on the pilot zone (24 Oct 2026, one street in Caracas, 97 s video) ·
🧪 option verified against the installed tool, not yet run on real data.

| Step | What | Tool | Status |
|---|---|---|---|
| 0 | Install the tools | — | ✅ |
| 1 | Check the input | ffprobe | ✅ |
| 2 | Pick sharp frames | `select_frames.py` | ✅ |
| 3 | Camera poses | COLMAP (`run_colmap.sh`) | ✅ (loop detection 🧪) |
| 4 | Masks for cars and people (optional) | any segmenter | 🧪 |
| 5 | Dense cloud, mesh, texture | OpenMVS (`run_openmvs.sh`) | ✅ (cleanup flags, gray holes 🧪) |
| 6 | Place it on the map | `georef.py` | 🧪 (synthetic test ✅) |
| 7 | Export for the app | gltf-transform | 🧪 |
| 8 | Look at it | Street View–style viewer | ✅ |

---

## 0. Setup ✅

| Tool | Where | Size |
|---|---|---|
| COLMAP 4.2.1, no CUDA | `colmap-x64-windows-nocuda.zip` from the [colmap/colmap 4.2.1 release](https://github.com/colmap/colmap/releases/tag/4.2.1) (`colmap-x64-windows-cuda.zip` with an NVIDIA GPU) | 121 MB |
| OpenMVS 2.4.0 | `OpenMVS_Windows_x64.zip` from the [cdcseacave/openMVS v2.4.0 release](https://github.com/cdcseacave/openMVS/releases/tag/v2.4.0) | 21 MB |
| Python 3 | `pip install opencv-python numpy` | — |
| ffmpeg / ffprobe | any recent build | — |

Unzip the two tools anywhere and point the scripts at them (`COLMAP=.../bin/colmap.exe`,
`OPENMVS=.../vc17/x64/Release`). On Windows run the shell scripts from Git Bash.

Folder layout, one folder per zone (as in the spec):

```
zones/<id>/
  raw/      videos, the GPS track (.json from the app's ● recorder), refpoints.json
  frames/   selected frames + frames.csv            (step 2)
  colmap/   database.db, sparse/0, sparse/1 …        (step 3)
  mvs/      undistorted images, depth maps, street.glb + street_0.png   (step 5)
  out/      georef.json, georeferenced .glb          (step 6)
```

**Time it takes** on an i7-1355U laptop, CPU only, 290 frames at 820×457 (the pilot):

| Stage | Time |
|---|---|
| Frame selection | < 1 min |
| COLMAP (features, matching, mapper) | 14 min |
| OpenMVS densify | ~55 min (≈ 8 s per frame) |
| Mesh | ~5 min |
| Texture | ~4 min |

4K input is ~20× the pixels: cap it (`RES=1` in step 5, or `--max-resolution 1920`) or expect hours.

---

## 1. Check the input ✅

```bash
ffprobe -v error -show_entries stream=codec_name,width,height,r_frame_rate:format=duration -of default=nw=1 raw/walk.mp4
```

- **Reject copies sent through WhatsApp** (or any chat app): ≤ 1024 px wide, no metadata. The pilot
  video was 832×464 and that is the main reason the model is blotchy. Use the original file from the
  phone (cable, AirDrop, Google Drive).
- 1080p or 4K, 30 or 60 fps, landscape.
- The GPS track recorded alongside (`recorrido-*.json` from the app's ● button) is needed for step 6.

---

## 2. Pick sharp frames ✅

```bash
python -I pipeline3d/select_frames.py raw/walk.mp4 frames 3 a
```

Reads the whole video, scores every frame with the variance of the Laplacian, keeps the sharpest
one per 1/3 s window (`3` = frames per second kept) and drops windows that are still blurred.
Writes `frames/a_00001.jpg …` and `frames/frames.csv` (name, time in the video, sharpness), which
step 6 uses to match frames to GPS by time. Use a different prefix (`a`, `b`, …) per video.

On the pilot, for the same 290 frames: median sharpness **518 → 670 (+29 %)**, 10th percentile
344 → 411, compared with a plain `ffmpeg -vf fps=3`.

- 2–3 frames per second when walking at ~1 m/s; 300–1500 frames per zone (spec).
- Flick through `frames/` and delete runs that are only sky or only ground.

---

## 3. Camera poses (COLMAP) ✅

```bash
ZONE_DIR=zones/piloto COLMAP=/c/tools/colmap/bin/colmap.exe bash pipeline3d/run_colmap.sh
```

What it runs:

1. `feature_extractor` — one camera for all frames, `SIMPLE_RADIAL`, CPU, up to 8192 SIFT features per frame.
2. `sequential_matcher` — each frame against its 15 neighbours in walking order.
   🧪 **Loop detection** (when the walk passes the same spot again, e.g. coming back on the other
   sidewalk): download `vocab_tree_faiss_flickr100K_words32K.bin` (9 MB) from the assets of the
   [COLMAP 3.11.1 release](https://github.com/colmap/colmap/releases/tag/3.11.1) and add
   `VOCAB=/path/vocab_tree_faiss_flickr100K_words32K.bin`.
3. `mapper` — writes one or more sub-models to `colmap/sparse/0`, `1`, …

**Quality gates** (the script prints them per sub-model):

| | Good | Pilot |
|---|---|---|
| Registered frames | ≥ 90 % of the frames | 290 / 290 after merging |
| Mean reprojection error | < 1 px | 0.71 px |

### If the model splits ✅

The pilot came out as three sub-models: 2, 182 and 126 frames. The larger two **shared 18 frames**
(165–182), so they could be joined:

```bash
# which frames each sub-model has (first and last name)
colmap model_converter --input_path colmap/sparse/1 --output_path /tmp/m1 --output_type TXT
awk 'NR>4 && NR%2==1 {print $10}' /tmp/m1/images.txt | sort | sed -n '1p;$p'

mkdir -p colmap/merged colmap/merged_ba
colmap model_merger   --input_path1 colmap/sparse/1 --input_path2 colmap/sparse/2 --output_path colmap/merged
colmap bundle_adjuster --input_path colmap/merged --output_path colmap/merged_ba
colmap model_analyzer  --path colmap/merged_ba     # pilot: 290 frames, 17,418 points, 0.71 px
```

Then use `MODEL=$ZONE_DIR/colmap/merged_ba` in step 5. Sub-models with no shared frames cannot be
merged this way: turn on loop detection, add frames from the gap, or re-record that stretch.

---

## 4. Masks for cars and people 🧪 (optional)

Moving cars and pedestrians leave smears. OpenMVS can ignore masked pixels:

- After the undistortion in step 5 (`run_openmvs.sh` step 1), write for each image in `mvs/images/`
  a file `<image name>.mask.png` next to it: same size, **0 where to ignore** (car, person, sky),
  255 elsewhere. Any segmentation model that labels cars/people works (e.g. a YOLO segmentation
  model); not scripted yet.
- Add `--ignore-mask-label 0` to `DensifyPointCloud` and `TextureMesh` (OpenMVS also accepts
  `--mask-path <folder>`).

---

## 5. Dense cloud, mesh and texture (OpenMVS) ✅

```bash
ZONE_DIR=zones/piloto MODEL=zones/piloto/colmap/merged_ba \
COLMAP=/c/tools/colmap/bin/colmap.exe OPENMVS=/c/tools/openmvs/vc17/x64/Release \
bash pipeline3d/run_openmvs.sh
```

What it runs, in `zones/<id>/mvs/`:

1. `colmap image_undistorter … --output_type COLMAP` — OpenMVS needs PINHOLE cameras.
2. `InterfaceCOLMAP -i . -o scene.mvs --image-folder images/`
3. `DensifyPointCloud scene.mvs --resolution-level 0 --number-views 6` — the slow step.
   `RES=1` halves the images (use it for 4K).
4. `ReconstructMesh scene_dense.mvs` 🧪 with `CLEAN=1` (default): `--remove-spurious 30 --close-holes 50 --smooth 2`.
   Optional `RefineMesh` (≈ 1 h on CPU) sharpens geometry; not in the script.
5. `TextureMesh … --decimate 0.5 --global-seam-leveling 0 --local-seam-leveling 0 --empty-color 8421504 --export-type glb`
   → `street.glb` + `street_0.png`.

OpenMVS writes its console output to `<Tool>-*.log` files in the working folder, not to the terminal:
read those when something fails.

### Pitfalls found on the pilot

| What you see | Cause | Fix |
|---|---|---|
| Mesh almost all **black** with photo only at patch edges | Seam leveling in this OpenMVS build blacked out every textured face: only **2 %** of faces sampled photo | `--global-seam-leveling 0 --local-seam-leveling 0` (already in the script): **98 %** photo |
| Big **orange** areas | Default `--empty-color` 16744231 = orange, for faces no photo saw | `--empty-color 8421504` (gray) 🧪; better coverage at capture |
| Mesh has no texture in a viewer | `street_0.png` is a separate file referenced by the `.glb` | Copy both together |
| Texture looks scrambled | Tempting to flip UVs — **don't**: they are correct as exported. A first check counted the orange fill as "texture" and suggested a flip | Check by sampling the texture at triangle centres and classifying orange / black / photo |
| Model offset from the photos | Assumed a glTF axis flip | The mesh stays in COLMAP coordinates; verified by the cameras sitting ~1.5 m above the ground |

---

## 6. Place it on the map 🧪 (synthetic test ✅)

```bash
python -I pipeline3d/georef.py colmap_txt/ frames/frames.csv raw/recorrido.json out/ \
  --origin 10.4846,-66.8529 [--sync 0.0] --glb mvs/street.glb
```

`colmap_txt/` is the model from step 3 in TXT form (`colmap model_converter … --output_type TXT`).

How it works:

1. **Up** = average of the cameras' up direction; the model is levelled with it (GPS altitude is not
   used).
2. Each frame gets a GPS position by interpolating the track at its time (`frames.csv`), plus
   `--sync` seconds if the video and the track did not start together.
3. A 2D similarity (scale, heading, offset; Umeyama) maps the camera centres onto the GPS points.
4. The ground under the cameras goes to y = 0 (where the app draws the road).

Output: `out/georef.json` (origin, 4×4 model→ENU matrix in Three.js axes — +X east, +Y up, −Z north,
metres — residuals, camera height) and `out/street.glb` with that matrix on its root node (copy
`street_0.png` next to it). It uses the same flat-earth formula as `src/core/geo.ts` (`toLocal`), so the
model and the route line up; `colmap model_aligner --alignment_type enu` was not used because its ENU
frame differs from the app's.

**Gate (spec Z5):** GPS residual median ≤ 3 m, and each reference point from `refpoints.json` ≤ 2 m
(check them in the viewer). If a reference point is off, fit on the reference points instead of GPS.

**Test:** `python -I pipeline3d/test_georef.py [colmap_txt]` moves a real model by a known transform,
makes a GPS track with 3 m of noise and checks the fit: scale 2.609 vs 2.61, **0.27 m** median error.

---

## 7. Export for the app 🧪

```bash
npx @gltf-transform/cli simplify out/street.glb out/s.glb --ratio 0.5
npx @gltf-transform/cli resize   out/s.glb out/s.glb --width 2048 --height 2048
npx @gltf-transform/cli webp     out/s.glb out/s.glb
npx @gltf-transform/cli draco    out/s.glb out/chunk.glb
```

Spec targets: ≤ 100 k triangles and ≤ 10 MB per chunk, textures ≤ 2048 px. KTX2 textures (the spec's
choice) need KTX-Software installed (`gltf-transform uastc` / `etc1s`); WebP works without it.
**Chunking** into ~50 m slices along the zone's centreline, with ~2 m overlap, and writing
`manifest.json` from `georef.json` is the next script to write (spec Step 5).

---

## 8. Look at it ✅

The pilot's Street View–style viewer lives outside the repo on the laptop that built it
(`C:\Platanus\Proyecto\street3d\viewer`, served with `python -m http.server`): stops along the walk
with the real photo at each one and the 3D model around it (`export_nodes.py` builds `nodes.json`
from the COLMAP model). Check that the model lines up with the photo at a stop with *Foto real* on
and off, and how much of the street the holes cover.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Several sub-models in `colmap/sparse/` | The walk had gaps, fast turns, or blurred stretches | Merge (step 3), loop detection, sharper frames, slower walk |
| Few frames registered | Video too compressed, motion blur, pure rotation | Original file, `select_frames.py`, walk instead of panning in place |
| Black texture | Seam leveling | Step 5 flags |
| Orange or gray holes | Nobody filmed those faces | Capture both sidewalks facing across + the middle facing along |
| Smeared cars | Moving objects | Masks (step 4), record with less traffic |
| `only N frames overlap the GPS track` | Video and track clocks differ | `--sync` seconds |
| Residual > 3 m | Bad GPS stretch, wrong sync | Check `--sync`; fit on reference points |
| Model floats or sinks in the app | Camera height measured wrong (few ground points) | `--eye` fallback, or more frames looking at the ground |
