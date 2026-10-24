# Vía AR — 3D Streets Spec

Status: draft v0.1 · Companion to [SPEC.md](SPEC.md) · Audience: the team building and shipping the first 3D zones

Module names below (`render/zone.ts`, `ArScene`, `NavFrame`, `FrameInput`) follow SPEC.md §3. Check them against the code before you start; fix this doc if they differ.

## 1. Goal

Show a **3D model of real streets**, built from photos we take of chosen zones, inside the existing navigation. The model is placed in the same local ENU frame as the route, so the current navigation (position, yaw, next maneuver) drives it with no new camera logic.

Three uses, built in this order:

| Use | What the user sees | Milestone |
|---|---|---|
| **Preview** (`street3d` display) | The model instead of the camera video, with ribbon, arrow and hazards on top | Z2 |
| **Occluder** | In camera AR the ribbon hides behind curbs and buildings | Z3 |
| **Ground snap** | The ribbon follows slopes instead of staying flat | Z3 |

Out of scope: city-wide coverage, live reconstruction on the phone, visual localization (correcting GPS from the camera), moving objects, interiors, any capture that uses someone else's imagery.

## 2. Terms

- **Zone**: one captured stretch of street (target 100–300 m) with one manifest.
- **Chunk**: a ~50 m slice of a zone's model, loaded and unloaded as the user moves.
- **Manifest**: JSON describing a zone's origin, rotation, polygon and chunks.
- **ENU**: the local east-north-up frame from `core/geo.ts`. One metre is one unit.
- **Registration error**: distance between a known real-world point and the same point in the model, in ENU metres.

## 3. Roles

| Role | Owns |
|---|---|
| Capture | Steps 1–2 (photos, GPS tracks) |
| Pipeline | Steps 3–5 (reconstruction, georeference, export) |
| App | Steps 6–10 (`render/zone.ts`, `main.ts` wiring, display mode, cache) |

One person can hold several roles. Hand off through the files named at the end of each step.

## 4. Step by step

### Step 0 — Pick the first zone
- Choose a straight street of 100–200 m with a footpath, little traffic, and at least one junction.
- Write the name, a start and end point, and a route that passes through it in `zones/README.md`.
- **Done when**: the zone is listed and the team agrees on it.

### Step 1 — Capture
1. Use a phone with a good camera, landscape, 4K video at 30 fps, stabilization on, auto-exposure locked if the phone allows it.
2. Record at overcast or evenly lit times. Avoid low sun and heavy shadows.
3. Walk slowly (about 1 m/s). Cover each side of the street once, camera facing across the street. Then walk the middle once, facing along the street. At junctions, turn in place slowly.
4. Record the GPS track at the same time with the existing recorder (`drive/recorder.ts`). If you use another app, export a GPX with 1 Hz points.
5. Avoid moving cars and crowds where you can. Never film private interiors or people's faces up close.
6. Write down 3 reference points (corners, poles, junction centres) and their coordinates, read from OSM or satellite imagery. You need them in Step 4.

**Output**: `zones/<id>/raw/` containing videos, the GPS track, and `refpoints.json`.

**Done when**: the walk covers the whole zone and every reference point is visible in the footage.

### Step 2 — Extract frames
1. Extract 2–3 frames per second with ffmpeg: `ffmpeg -i in.mp4 -vf fps=2 frames/%05d.jpg`.
2. Delete blurred frames (a Laplacian-variance filter works) and frames that are mostly sky or ground.
3. Keep 300–1500 frames per zone.

**Output**: `zones/<id>/frames/`.

**Done when**: a manual flick-through shows no long runs of blurred or repeated frames.

### Step 3 — Reconstruct
1. Run structure from motion and multi-view stereo. Tools: Polycam, RealityCapture, Metashape, or COLMAP.
2. Export a textured mesh. Keep the camera poses (COLMAP `images.txt`, or the tool's equivalent), because Step 4 needs them.
3. Clean the mesh: remove floating fragments, cars and sky. Close obvious holes on the ground.
4. Keep the mesh under 500k triangles per 50 m chunk before simplification (see Step 5).

**Output**: `zones/<id>/recon/mesh.*` and `cameras.*`.

**Done when**: the mesh looks recognisable from street level in a viewer and the ground is one continuous surface.

### Step 4 — Georeference
This puts the model in the ENU frame.

1. Take the reconstructed camera positions and the GPS track timestamps. Fit a similarity transform (scale, rotation, translation) from model coordinates to ENU (Umeyama's method is enough). Use the GPS points matched to frames by time.
2. Check the result with the reference points from Step 1. Report the error for each point.
3. If a reference point is off by more than 2 m, refine: fit using the reference points as ground control instead of GPS alone.
4. Set the zone origin to the lat/lon of the first reference point. Save the 4×4 transform from model space to ENU.

**Output**: `zones/<id>/georef.json` (origin, transform, per-point error).

**Done when**: all reference points have registration error ≤ 2 m (requirement Z5).

### Step 5 — Export chunks and manifest
1. Rotate and translate the mesh with the transform from Step 4 so that +X is east, +Y is up, −Z is north (Three.js convention; ENU axes are mapped in `render/zone.ts`, not in the files).
2. Cut the mesh along the street into ~50 m chunks, with ~2 m overlap so there is no visible seam.
3. Simplify each chunk to 100k triangles or fewer. Compress with Draco and compress textures to KTX2 (max 2048 px). Target 10 MB or less per chunk.
4. Write `zones/<id>/manifest.json`:

```json
{
  "id": "zona-01",
  "name": "Av. Ejemplo",
  "version": 1,
  "origin": { "lat": 10.4806, "lon": -66.9036 },
  "polygon": [[-66.9040, 10.4800], [-66.9030, 10.4800], [-66.9030, 10.4812], [-66.9040, 10.4812]],
  "chunks": [
    { "url": "chunks/c00.glb", "alongRange": [0, 50], "bytes": 8400000 },
    { "url": "chunks/c01.glb", "alongRange": [50, 100], "bytes": 7900000 }
  ],
  "refpoints": [{ "lat": 10.4806, "lon": -66.9036, "errorM": 1.1 }]
}
```

`alongRange` is distance in metres along the zone's centreline, not the route. Polygon is `[lon, lat]`, same as the rest of the app.

5. Add the zone to `public/zones/index.json`: `[{ "id": "zona-01", "manifest": "zona-01/manifest.json" }]`.

**Output**: `public/zones/<id>/…` and the index entry.

**Done when**: every chunk loads in a plain Three.js test page and lines up with a flat OSM tile of the same area.

### Step 6 — Zone loader (App)
1. Add `core/zones.ts`: fetch `index.json`, fetch manifests lazily, and validate their shape (reject a manifest with a missing field instead of crashing).
2. Add `zonesAlongRoute(route)`: use the polyline projection in `core/geo.ts` to return `{ zoneId, fromAlong, toAlong }` spans where the route is inside a zone polygon.
3. Call it once at route start and again after a re-route.
4. Add unit tests in `tests/run.ts` for: shape validation, a route that crosses one zone, a route that misses all zones, a route that crosses two.

**Done when**: `npm test` passes and a route with no zone returns an empty list (Z7).

### Step 7 — `ZoneLayer` (App)
1. Create `render/zone.ts` with `ZoneLayer`, added to the `ArScene` scene graph.
2. API: `ZoneLayer.setSpans(spans)` and `ZoneLayer.update(along: number, pose)`; the layer knows nothing about sensors, same as the rest of `render/`.
3. Load chunks within 150 m ahead of the user and 50 m behind. Unload chunks outside that, and dispose their geometries, materials and textures. Keep at most 3 chunks in memory (Z3).
4. Use `GLTFLoader` with `DRACOLoader` and `KTX2Loader`; host the decoders locally under `public/` (no CDN at runtime, so it works offline).
5. Apply the georeference transform once, when a chunk finishes loading, not each frame.
6. Never block the frame loop: load asynchronously and show nothing until a chunk is ready.

**Done when**: driving `RouteSim` through the zone shows chunks appearing ahead and disappearing behind, with a stable frame rate and no growth in memory after 5 laps.

### Step 8 — `street3d` display mode (App)
1. Extend `Display` from `'camera' | 'hud'` to `'camera' | 'hud' | 'street3d'`.
2. In `street3d`, skip `startCamera`, hide `<video>`, and render the model plus the existing ribbon, chevrons, turn arrow and hazards.
3. The camera pose is the same as camera AR (`calib.height`, route yaw, `calib.pitch`). No new calibration.
4. Add "Vista 3D" to the setup screen. Show it only when the planned route crosses a zone.
5. Outside the zone, show the normal black background with the ribbon (same as the HUD) and a small "sin modelo 3D" note.

**Done when**: Z4 passes in sim mode and nothing changes in `camera` or `hud` mode.

### Step 9 — Occluder and ground snap (App)
1. Occluder: render the zone mesh with `colorWrite: false, depthWrite: true` before the overlay, so the ribbon is hidden behind it. Toggle in the calibration dock, default off.
2. Ground snap: build a simple height lookup from the mesh (raycast down at each ribbon sample, cache results per chunk). Use it only for the ribbon and chevrons, not the hazards.
3. If the raycast misses (hole in the model), fall back to the previous height.
4. Keep the existing preallocated ribbon buffers. Do not allocate per frame.

**Done when**: Z6 passes, and turning both toggles off gives exactly today's result.

### Step 10 — Offline cache and size limits (App)
1. In `public/sw.js`, cache `index.json`, the manifest, and the chunks of the zones the user chose to download. Offer a "Descargar zona" button on the setup screen with a progress bar.
2. Show the download size before starting. Refuse to start on mobile data without a confirmation.
3. Version the cache by manifest `version`, and drop old versions.

**Done when**: with airplane mode on, a downloaded zone still loads (Z8).

### Step 11 — Field test
1. Walk or drive through the zone with a passenger holding the phone.
2. Log: how far the ribbon was from the real road in each case (use the reference points), the frame rate, battery use, any chunk pop-in, and anything confusing.
3. Fix the top 3 issues and write the rest into `TODO.md`.

**Done when**: one run of 10 minutes or more, with the log committed.

## 5. Requirements and acceptance

| ID | Requirement | Acceptance |
|---|---|---|
| Z1 | Zone manifest format and loader | A zone listed in `zones/index.json` loads with no code change |
| Z2 | Offline pipeline documented in `zones/README.md` | A teammate who wasn't involved reproduces a zone from video and a GPS track |
| Z3 | `ZoneLayer` streams chunks along the route | At most 3 chunks in memory; 30 fps or better on a mid-range Android phone |
| Z4 | `street3d` display mode | `RouteSim` through a zone shows the model with ribbon and arrow on the road |
| Z5 | Registration | ≤ 2 m error on 3 reference points per zone |
| Z6 | Occluder and ground snap | Ribbon hidden behind curbs and follows slopes when on; identical to today when off |
| Z7 | No zone, no change | Routes outside every zone behave exactly as today |
| Z8 | Size and offline | A zone is ≤ 50 MB in total and works offline once downloaded |

## 6. Testing

- Unit (`npm test`): manifest validation, `zonesAlongRoute`, chunk load/unload order given a sequence of `along` values.
- Visual: screenshot `street3d` at 1080p landscape in `RouteSim`, at the start, middle and end of the zone.
- Regression: with no zones installed, run an existing recorded drive in Repetición mode and confirm the output is unchanged.
- Field: Step 11 checklist.

## 7. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Phone GPS error (3–10 m), mostly as yaw error | Model sits beside the route | Reference points in Step 4; add a fine-tune offset and rotation slider per zone in the calibration dock |
| Poor reconstruction on long narrow streets | Holes, melted facades | More overlap, shoot facing across the street, use junction footage |
| Mobile memory and download size | Crashes, slow start | Chunks ≤ 10 MB, max 3 in memory, KTX2 textures, explicit download step |
| Moving objects in the footage | Ghost cars in the model | Capture at quiet times, mask or remove in Step 3 |
| Lighting baked into the textures | Model looks wrong at night | Capture on overcast days; accept it in v1 |
| Privacy and legal | Complaints, takedowns | Do not publish close-ups of people or plates; check local rules on capturing and publishing street imagery before distribution |

## 8. Open questions

1. Is the first goal the preview (`street3d`), or replacing the camera feed in HUD mode? This spec builds the preview first.
2. Which zone is first, and who captures it?
3. Reconstruct in the cloud (faster, costs money) or on a laptop (free, slower)?
4. Should a model update replace the old one automatically, or only when the user taps update?
