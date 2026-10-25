# Vía AR — Product Spec

Status: draft v0.2 (2026-10-24: automatic calibration §6.1 and remote camera §6.2 built) · Baseline: current `ar-nav` codebase (v0.1.0, Vite + TypeScript + Three.js PWA)

## 1. Goal

Show turn-by-turn navigation as **3D graphics anchored to the road ahead**, in two display modes that share one engine:

| Mode | Surface | Status |
|---|---|---|
| **Camera AR** | Phone screen: live camera video with the 3D overlay on top | Built (demo-grade) |
| **Windshield HUD** | Phone lying on the dashboard; its image reflects off the bare windshield. No camera video, overlay only | New |
| **Walking AR** | Phone held up, camera pointed at the street; same camera overlay, foot routing, heading from device sensors | New (variant of Camera AR) |
| **Remote camera** | Phone mounted horizontally is only the camera (plus GPS and tilt); a laptop or iPad shows the Camera AR view, e.g. on a projector. Paired by QR code (§6.2) | Built (demo-grade) |

Out of scope for now: native apps, dedicated HUD hardware, combiner film, lane detection / computer vision, voice guidance, offline maps, multi-stop routes. A phone + screen pair is supported as the remote camera (§6.2) but single-phone use stays the default: iOS needs no second device, geolocation works in iOS Safari.

## 2. Users and key scenarios

Primary user: a driver in a city with poor road data and poor road surface (the current hazard set — *huecos*, *policías acostados*, *alcabalas* — is Venezuelan; UI copy is Spanish).

1. **Set destination before driving.** Paste/share a Google Maps or Waze link, type an address, or enter coordinates.
2. **Drive with camera AR.** Phone mounted on the windshield, landscape, pointing at the road. Guide ribbon + chevrons on the asphalt, a standing 3D arrow at the next turn, red markers on hazards.
3. **Walk with camera AR.** Hold the phone up toward the street; the ribbon and turn arrow follow a walking route. Heading comes from the compass/gyro, not the route.
4. **Drive with the windshield HUD.** Phone lies flat on the dashboard, screen up. Driver sees the arrow, distance and speed floating over the road, with no video competing for attention.
5. **Report a hazard** with one tap while driving.
6. **Demo / develop without driving**: simulation and recorded-drive replay (already built; keep).
7. **Show it on a big screen.** iPhone mounted horizontally on the windshield as the camera; a laptop or iPad (or a projector behind it) shows the guide over the live video, for demos and for a passenger. No GPS needed on the big screen.
8. **Mount and go.** No calibration step: the field of view is set when the camera starts, tilt and roll are measured at the first stop. Sliders remain for fine-tuning.

## 3. What exists today (reuse as-is)

| Module | Role | Reuse in HUD mode |
|---|---|---|
| [src/render/ar.ts](src/render/ar.ts) | Three.js scene: ribbon, chevrons, turn arrow/ring, destination pin, hazard markers. Transparent canvas (`alpha: true`) | Same scene; add a HUD render style (§5.2) |
| [src/main.ts](src/main.ts), [src/setup.ts](src/setup.ts) | Composition root: wires modules, start/stop, per-frame loop; setup screen | Add mode switch + HUD layout |
| [src/drive/navigation.ts](src/drive/navigation.ts), [src/drive/start.ts](src/drive/start.ts) | Route following (progress along route, yaw, next maneuver, rerouting); per-mode source startup | Unchanged |
| [src/walk/view.ts](src/walk/view.ts), [src/walk/orientation.ts](src/walk/orientation.ts) | Sensor-driven camera view (compass/tilt/roll, smoothing, "Alinear") | Not used in HUD mode |
| [src/render/hud.ts](src/render/hud.ts), [src/render/calibDock.ts](src/render/calibDock.ts) | Flat HUD text/glyph; calibration dock | HUD layout and per-display profiles live here (§5.2, §5.3) |
| [src/hazards/ahead.ts](src/hazards/ahead.ts), [src/hazards/ui.ts](src/hazards/ui.ts), [src/hazards/bump.ts](src/hazards/bump.ts), [src/hazards/cloud.ts](src/hazards/cloud.ts) | Hazards along the route, reporting UI, bump detection, upload queue | Unchanged |
| [src/core/geo.ts](src/core/geo.ts) | Local ENU projection, bearings, polyline projection | Unchanged |
| [src/core/route.ts](src/core/route.ts) | OSRM routing, Spanish instructions | Unchanged (see §8) |
| [src/drive/sources.ts](src/drive/sources.ts) | `GpsSource`, `RouteSim`, `TrackReplay` | Unchanged |
| [src/render/calib.ts](src/render/calib.ts) | `pitch, fov, height, yawOffset, lateral, ribbonWidth` in localStorage | One calibration profile per display mode (§5.3) |
| [src/render/autocalib.ts](src/render/autocalib.ts) | Automatic calibration math: visible FOV from lens + video + screen, steady-tilt window, hand-set flags, mount roll (§6.1) | FOV auto still applies; tilt measures the phone, but in HUD mode `pitch` means something else (§5.3), so auto tilt stays off there |
| [src/remote/](src/remote/) | Remote camera: `protocol.ts` messages + URLs, `display.ts` QR and receiving side, `phone.ts` the phone's camera page, `orient.ts` upright picture (§6.2) | Not used in HUD mode |
| [src/hazards/store.ts](src/hazards/store.ts), [src/core/links.ts](src/core/links.ts), [api/expand.ts](api/expand.ts) | Hazards, destination parsing, short-link expansion | Unchanged |

### Module ownership

The source is split so teammates can work in parallel with few merge conflicts (full file list in [SETUP.md](SETUP.md)).

| Folder | Scope | Talks to the rest through |
|---|---|---|
| `core/` | Shared: geometry, routing, link parsing, types, DOM helpers | Everyone imports it. Changes need a heads-up to the team |
| `drive/` | Navigation for driving, no orientation sensors: GPS/sim/replay sources, route following, rerouting | `advance(fix, route, …)` returns a `NavFrame` |
| `walk/` | Navigation for walking, with sensors: compass/tilt/roll steer the camera | `updateView(now, dt)` returns a `View` or `null` (fall back to route bearing) |
| `render/` | 3D overlay (Three.js), HUD, calibration | `ArScene.update(FrameInput)` and `renderHud(HudInput)`; knows nothing about sensors |
| `hazards/` | Hazard store, cloud sync, bump detection, reporting UI | `reindexHazards()`, `aheadOf(along)`, `trackPosition(now, p)` |
| `remote/` | Phone as remote camera: pairing QR, WebRTC video, GPS/tilt/FOV over a data channel | `remoteStream()`, `remoteGps`, `remoteTilt(now)`, `remoteHfov()`; `isPhoneCamPage()` + `initPhoneCam()` on the phone |

Driving and walking differ only in where the camera pose comes from. Both feed the same renderer. `bump.ts` uses the accelerometer but belongs to hazards, so "no sensors" for driving means no orientation sensors.

### How the current rendering works (the part that matters for HUD)

- A **virtual camera** sits at `calib.height` above the road, yawed to the route bearing, pitched by `calib.pitch`, with FOV `calib.fov`. Road geometry from the route polyline is drawn in this camera, so it lines up with the real road *if* the calibration matches the phone's real camera.
- Heading is **not read from the compass or gyro**. Yaw = bearing of the route at the car's position (snapped), eased at ~4 Hz; off-route it falls back to GPS heading. Pitch and roll are constants of the mount, **measured automatically** from gravity while the car is stopped, and FOV is computed from the camera video and the screen (§6.1); hand-set slider values override them.
- Position is GPS (1 Hz) smoothed by dead-reckoning between fixes and snapped to the route when within 25 m.

This is a cheap, robust trick for a rigidly mounted phone. It is also why the HUD mode is feasible: **a windshield HUD is the same virtual camera, with the "physical camera" replaced by the driver's eye.**

## 4. Windshield HUD mode — requirements

### 4.1 Physical setup (assumptions to validate with a prototype)

- Phone on the dash, screen facing up, landscape, reflecting off the **bare windshield** (decided: no combiner). A laminated windshield gives a **double image** (front and back glass surface); mitigate with large, thick, high-contrast shapes and a thin-outline-free style, and test at M0 whether the second image is tolerable.
- The driver's eye position is roughly fixed (an "eyebox" of ±5 cm lateral, ±5 cm vertical). Registration only holds inside it.
- Reflected image distance is ~1–2 m from the eye, not at the road. Far-field graphics will show parallax when the head moves. Accepted limitation; see risks.

### 4.2 Functional requirements

| ID | Requirement | Acceptance |
|---|---|---|
| H1 | **HUD display mode** selectable in setup, alongside Manejar / Simulación / Repetición (HUD is a *display* option on top of gps/sim) | Selecting it starts GPS navigation with no camera permission prompt and no `<video>` visible |
| H2 | **Black background, additive-style graphics.** Every pixel that isn't a graphic is pure `#000` (a dark screen reflects nothing) | No gray panels, cards, or blurs on screen; HUD cards from camera mode are replaced by HUD-specific layout |
| H3 | **Mirror toggle** (horizontal flip) and **vertical flip** toggle, persisted | With the phone flat under a windshield, text reads correctly in the reflection after one toggle (horizontal flip is the usual case; vertical depends on which edge faces the driver) |
| H4 | **Maximum-legibility palette**: saturated cyan/green/white/amber at full luminance; ≥ 3 px lines at 1080p; no semi-transparent thin elements (the current ribbon alpha of 0.45 is too faint) | Readable in direct daylight at max brightness from the driver's seat (field test) |
| H5 | **Reduced element set**: wide ribbon edge-lines or solid chevrons, turn arrow, distance-to-turn, speed, hazard warning. Drop the remaining-time card, setup UI, toasts | Max 4 text items on screen at once |
| H6 | **HUD calibration** (§5.3): shift/scale the whole projected scene to the driver's eyebox, not the camera's view | A driver can align the ribbon to a straight road ahead in < 2 min using sliders |
| H7 | **Auto-brightness hint**: request wake lock, show a one-time prompt to set brightness to max; optional night palette (dimmer, lower saturation) switched by `prefers-color-scheme` or manual toggle | Screen never sleeps during navigation (existing `wakeLock`, keep) |
| H8 | **Glance-safe**: no interactive controls during motion except a large *Report hazard* tap target and *Exit*; HUD itself is non-interactive | No element requires reading text smaller than 32 px equivalent |
| H9 | **Safe fallback**: if GPS accuracy > 30 m or fix age > 3 s, fade the world-anchored ribbon and show only the turn glyph + distance | Test with `RouteSim` and injected bad fixes |

### 4.3 Non-goals for HUD v1

- True optical accuracy (collimated virtual image), head tracking, eye tracking.
- Augmenting other vehicles or pedestrians.
- Using the phone as both HUD and camera at once (a second phone as remote camera, §6.2, could feed the HUD later).

## 5. Design

### 5.1 Architecture changes

```
 Source (gps/sim/replay) ─▶ drive/navigation advance() ─▶ NavFrame ─┐
 walk/view updateView() ───────────────────────────────▶ View|null ─┼─▶ main.ts frame() ─▶ ArScene.update(FrameInput)
 hazards/ui aheadOf() ─────────────────────────────────▶ ahead[] ───┘                    └▶ renderHud(HudInput)
                                                                              │
                                                                              ├─ render style: 'camera' | 'hud'
                                                                              └─ view transform: mirrorX, flipY (CSS on canvas)
```

- Introduce a `Display = 'camera' | 'hud'` value, orthogonal to `Mode`. `Mode` still decides where position comes from.
- `main.ts` and `drive/start.ts`: when `display === 'hud'`, skip `startCamera`, hide `<video>`, set body class `hud` (black background, HUD layout, no cards).
- `ArScene` takes a `style` option: materials (opacity/colors), ribbon rendering (edge lines instead of a translucent fill), arrow scale. The scene graph, pooling and update logic stay as they are.
- Mirror/flip implemented as a CSS transform on `#ar` and the HUD text container (`transform: scale(-1, 1)`), not in Three.js, so text and 3D flip together.
- Extract the HUD text block (glyph, distance, street, speed; see `render/hud.ts`) into one container so the same flip applies to it.

### 5.2 HUD render style (differences from camera style)

| Element | Camera style | HUD style |
|---|---|---|
| Background | Video | `#000` |
| Ribbon | 3 m wide, cyan, α ≤ 0.45 fading | Two solid edge lines (or outline) + chevrons, α ≥ 0.85, shorter range (~100 m) to cut clutter |
| Turn arrow | Standing arrow at maneuver point, scales to 2.2× when far | Same, plus a fixed screen-space glyph and distance, so the cue survives a bad registration |
| Hazards | Red cone + ring + sprite label | Larger, amber/red, label always facing the driver, only the nearest 2 within 150 m |
| Text | HUD cards with backdrops | Large type directly on black, no card backdrops |

### 5.3 HUD calibration

The camera-mode sliders map to a phone camera. In HUD mode the "camera" is the driver's eye as seen through the reflection, so the sliders change meaning and need new ranges:

| Setting | Meaning in HUD mode |
|---|---|
| `height` | Driver eye height above road (≈ 1.1–1.5 m), keep |
| `pitch` | Vertical offset of the graphics (where on the windshield the road "starts"), wider range |
| `fov` | Scale of the whole scene, wider range |
| `yawOffset` | Horizontal shift to centre the ribbon on the driver's lane |
| `lateral` | Same as camera mode: car offset from route centreline |
| **new:** `mirrorX`, `flipY` | Display flips (H3) |
| **new:** `scale` / `offsetX` / `offsetY` | Screen-space framing inside the phone's rectangle |

Store as two profiles in localStorage (`ar-nav.calib.camera`, `ar-nav.calib.hud`), migrating the existing `ar-nav.calib` key to the camera profile. Add a **calibration pattern**: a static straight ribbon + horizon line shown in calibration so the driver can align it without a route.

### 5.4 Exact windshield optics — built (iPad on the dash, iPhone as sensor)

Replaces the slider guesses of §5.3 and the fixed CSS mirror with the geometry of the reflection. Code: [src/render/optics.ts](src/render/optics.ts) (pure, unit-tested), [src/render/hudSetup.ts](src/render/hudSetup.ts) (measurements sheet, text warp), `ArScene` (`optics` in `FrameInput`).

- **Model.** Car frame with the origin on the road under the driver's eye. Inputs: eye height, dashboard height, eye → windshield base distance, windshield rake (measurable by laying the device on the glass, *Medir*), iPad centre position, which edge of the iPad faces the driver, CSS px per inch (132 for iPads). Glass = plane through the windshield base with that rake; reflection `Refl(p) = p − 2((p − G)·n) n`.
- **Projection.** The driver at `E` sees the reflected screen; equivalently a camera at `E' = Refl(E)` looking at the real iPad rectangle sees the reflected world. The scene root gets `Refl · worldToCar` (heading + body pitch/roll) and the camera Kooima's off-axis frustum on the iPad's corners. **Mirror, perspective and keystone all come from this**; the result: iPad top edge toward the driver ⇒ a horizontal mirror (what ⇄ approximated), toward the glass ⇒ a vertical flip (⇅), plus the keystone a CSS flip can't give.
- **Text** (speed, distance, next turn) keeps its CSS layout and gets a `matrix3d` homography so it reads upright and undistorted in the glass, fitted inside the reflected picture.
- **Setup sheet** (📐): Toyota Fortuner 2015 preset (estimates: eye 1.50 m, dash 1.12 m, windshield base 1.05 m ahead, rake 33°, hood line 9.9° below the horizon), live readout (picture distance, width, road covered), **placement advice** (where to put the iPad so the picture centres ~4° below the horizon, above the hood: 34 cm back from the windshield base for the preset), warnings (behind the hood, short of the horizon, weak in daylight), two fine sliders (eye up/down, left/right), and *Óptica calculada* on/off (off = the simple ⇄ ⇅ mirror).
- **iPhone as sensor** (`?cam=<id>&role=sensor`, QR shown in HUD display): no camera, no video; GPS fixes, tilt at 20 Hz, ping. The car's body pitch/roll = phone tilt − its tilt at rest (auto calibration while stopped), low-passed ~3 Hz. In HUD mode the iPad's own tilt is never used for calibration (it lies flat on the dash).
- **Numbers for the Fortuner preset** (tests): picture 0.91 m from the eye, ~14° wide, −8.4° … +0.6° from the horizon = road from ~10 m to the horizon, tilted 2 × rake, incidence ~70° at the glass (past Brewster's 56°). Daylight contrast remains the limiting factor (§8): first drives at dusk or night.
- **Not done:** hazard text labels are hidden in this mode (sprites don't mirror; the HUD banner shows the hazard), no alignment pattern yet, ribbon width is still the HUD profile's 3.2 m (a lane-wide band fills most of a 14° picture at 10–20 m; narrower edges are `PLAN-HUD-AR.md` Hito 1 work).

## 6. Camera AR mode — gaps to close (carried over from the baseline)

The camera mode works for a demo. To be dependable on the road:

| ID | Gap | Proposed fix |
|---|---|---|
| C1 | **Built for gps and sim modes (opt-in checkbox + ⌖ align button):** pitch, roll and compass yaw drive the camera; see `src/walk/orientation.ts`. Not yet: automatic yaw correction toward the route, tuning on real phones. Original gap: yaw comes from the route, so the overlay can't react to the car's actual heading change during a turn or lane change | Fuse `DeviceOrientationEvent` (gyro/compass) for short-term yaw/pitch/roll; keep route bearing as the long-term reference when driving |
| C2 | **Partly built:** the mount's static pitch and roll are now measured automatically (§6.1). Still open: dynamic compensation, so bumps and slopes still shift the ribbon off the road while driving | Same fusion for pitch and roll (high-pass the gyro, low-pass toward the auto-calibrated value) |
| C6 | **Walking** (phone in hand): route-derived yaw and fixed pitch are wrong because the phone points wherever the hand does | New `walk` profile: yaw, pitch and roll come from device orientation (iOS needs `DeviceOrientationEvent.requestPermission()` from a tap); camera height ~1.5 m; ribbon narrower (~1.2 m); route requested with a foot profile; no speed-based dead-reckoning assumptions above ~2 m/s; re-route threshold smaller (~20 m). C1/C2 are a prerequisite |
| C7 | Public OSRM demo server only serves the `driving` profile | Walking needs a foot profile: self-host OSRM with `foot.lua` or use a router that supports pedestrian routing. Until then, walking mode snaps to driving routes and is demo-only |
| C3 | Re-routing only in GPS mode and never when the OSRM request fails repeatedly | Surface a persistent "sin conexión" state; keep last route; retry with backoff |
| C4 | Hazard pool is 10 markers; hazards are filtered to 20 m from the route | Keep; document. Raise only if a field test shows pop-in |
| C5 | Public OSRM/Nominatim are rate-limited demo servers | Self-host or use a paid router before real users (§8) |

### 6.1 Automatic calibration — built

The phone calibrates itself; there is no button. Code: [src/render/autocalib.ts](src/render/autocalib.ts) (pure, tested) and [src/render/calibDock.ts](src/render/calibDock.ts) (wiring).

| ID | Requirement | Acceptance | Status |
|---|---|---|---|
| A1 | **Field of view from the camera.** `fov` = vertical FOV actually visible on screen, from the lens's horizontal FOV across the video's long side, the video size and the `object-fit: cover` crop to the screen. Recomputed when the camera starts, when the video size changes and when the screen rotates | 63° lens, 1080p video on a 16:9 landscape screen → 38°; on a portrait screen with portrait video → 63°; a taller 20:9 screen gives a smaller value (crop) | Built, unit-tested |
| A2 | **Lens FOV.** Default `DEFAULT_LENS_HFOV` = 63° (typical phone main camera, 16:9 video). Overridable per device with `localStorage['ar-nav.lens'] = {"hfov": …}`. With a remote camera, the phone's own value is used (R6) | COLMAP measured 56° on one iPhone video (WhatsApp-compressed, likely stabilised); measure per phone model before relying on it (§8) | Built; per-model values open |
| A3 | **Pitch and roll of the mount from gravity**, via `DeviceOrientationEvent` beta/gamma → `poseFromEuler`. Readings are trusted only when the last 2.5 s were steady (std dev ≤ 0.8°) **and the car is stopped** (GPS speed ≤ 1 m/s), since braking and accelerating tilt apparent gravity by several degrees. First steady window applies at once; later ones blend in at 50 % so a nudged mount is followed smoothly | Still phone at 9° → `pitch` 9; readings while moving are ignored; a toast says "Calibrado solo…" once per drive | Built, unit-tested, verified with simulated sensors; not yet on a real drive |
| A4 | **Roll** has no slider: stored per layout (`ar-nav.mount.<layout>`) and applied to the 3D camera (`FrameInput.mountRoll`). Before this, a fixed mount's roll was never corrected | Overlay horizon matches a phone mounted 3° off level | Built |
| A5 | **Hand-set values win.** Moving *Inclinación* or *Campo de visión* marks that value as manual for that orientation (`ar-nav.manual.<layout>`); automatic calibration then never changes it. *Restablecer* clears the flags, resets roll, re-measures and recomputes FOV | Slider to 3° and 45° → auto leaves them; Restablecer → back to 38° / measured pitch | Built, verified in browser |
| A6 | **Where it runs.** Permission is asked in the *Iniciar* tap (iOS); without it calibration stays manual, silently. Not used in Repetición (the phone isn't in the mount) nor with *Usar sensores* (tilt is already live). With a remote camera, tilt comes from the phone, not the screen device (R5) | — | Built |

Known limits: on a slope the measured pitch includes the slope (calibrate on flat ground or let later stops average it in); yaw offset, height and lane position are still manual (yaw from the optical-flow focus of expansion is the next step, see TODO.md).

### 6.2 Phone runs the app and is the camera; the iPad is only the HUD — built

The phone has the whole UI (MapZ design, see 6.3), its own GPS and sensors, and stays mounted on the dash as the camera: while driving it shows the camera AR view. The iPad lies under the windshield and only draws the reflected HUD. They are linked by a 6-digit code over a WebRTC data channel (no video). Code: [src/remote/](src/remote/).

```
 iPhone (UI + camera, on the dash)                 iPad (windshield HUD)
 ─────────────────────────────────                 ─────────────────────────────
 Dispositivos → types "616 081"                    "Esta pantalla es el HUD" → shows a code
 PeerJS peer (random) ──── broker ────▶            PeerJS peer "viaar-hud-616081"
 DataConnection ─── route {pts, steps, duration, arrival} ──▶  runs navigation itself
                ─── fix (GPS, ≤10/s) · tilt (20 Hz) · ping (1 Hz) ──▶
                ─── stop ──▶                       back to the code screen
```

| ID | Requirement | Acceptance | Status |
|---|---|---|---|
| L1 | **Roles.** `?role=hud` or "Usar esta pantalla como HUD" (remembered) makes a device the HUD: black screen with a big code and 📐 measurements, nothing else | — | Built |
| L2 | **Pair by code.** The iPad registers `viaar-hud-<6 digits>` (kept across reloads, a new one if taken); the phone types it in Dispositivos (spaces and dashes ignored). Status chip: Conectando / Conectado / Reintentando; Conducir shows "iPad conectado" | Code typed → "Conectado" in ~2 s | Built, unit-tested |
| L3 | **Route message.** When a drive starts, and on every reroute, the phone sends the route and the exact arrival point (entrance, building outline and height). Reconnecting mid-drive resends it | iPad switches to the HUD with the same instruction as the phone | Built, unit-tested round trip |
| L4 | **The iPad navigates by itself** from route + phone fixes (`RemoteGpsSource`, `advance()`, maqueta elevation and signs), so a late message doesn't freeze the HUD. Car body pitch/roll for the optics come from the phone's tilt minus its resting tilt | — | Built |
| L5 | **Lost link.** 1 s pings; after 5 s of silence the iPad keeps the last picture, and after 15 s without the phone goes back to the code screen. The phone retries by itself | — | Built |
| L6 | **Cost.** PeerJS (~117 KB) loads only when linking | — | Built |

Network: both devices need internet for the PeerJS broker; data then goes directly over WebRTC with Google STUN and no TURN relay. Same Wi-Fi or the iPhone's hotspot works; Wi-Fi that isolates clients blocks it. The older "phone streams its video to a laptop by QR" path is retired.

### 6.3 Official phone UI (MapZ design) — built

From the "MapZ App UI" canvas: blue `#2563EB` / `#1A56C4`, Manrope, dark and light themes following the system, no login. Code: [src/ui/](src/ui/), [index.html](index.html), [src/style.css](src/style.css).

| Screen | What it does | Status |
|---|---|---|
| **Destino** | Real map (MapLibre + OpenFreeMap tiles in the app palette, loaded only here, ~800 KB). Origin "Mi ubicación actual", or any other origin, typed in Desde or placed on the map by tapping Desde and then the map (a draggable pin); either switches the mode to Simulación, since a real drive starts where the phone is, destination by search, pasted Maps/Waze link or tap on the map (street name by reverse geocoding). Caminar/Manejar, recenter, layers Huecos / Reductores, route preview with minutes and km. The maqueta zone is the dashed blue frame; a destination inside it turns the button into **Elegir punto exacto** | Built |
| **Maqueta** | Isometric 3D of the zone (Three.js, orthographic): buildings from footprints, streets from the tiles. Letters A–E on the buildings around the destination, tap to select, entrance chips or "Frente al edificio". Moves like a maps app, anchored under the fingers or cursor: drag; two fingers pinch, twist and drag together; Mac trackpad pinch and twist (Safari) or a sideways two-finger swipe (other browsers); Ctrl/⌘/⌥/⇧ + drag or right-drag turns it. Buttons: turn 90° (animated) and a compass that puts north back up. **Confirmar punto y conducir** sets the exact arrival point and starts | Built |
| **Conducir** | Phone camera AR. Chips "iPad conectado" / "Cámara fija", maneuver card, speed and limit, ⚠ Hueco / Policía acostado, the bump prompt, ● record, ETA card (min · Llegada: hh:mm · Edif. C · Entrada · km) with Pausar / Terminar. Portrait and landscape (phone on the dash) | Built |
| **Dispositivos** | iPad code and status, phone row, CALIBRAR LA VISTA preview with the horizon line, sliders *Altura de vista* (`calib.height`) and *Horizonte* (`calib.pitch`; a hand-set value wins over auto calibration), Modo (Real / Simulación / Repetición), Detectar huecos, Avanzado | Built |
| Registrar lugar, Perfil | In the canvas; the ⊕ button is shown disabled | Later |

### 6.4 Exact arrival point — built

The chosen entrance travels as `app.arrival` `{lat, lon, label, outline, height}`. The route goes to it (OSRM snaps to the street); in the AR scene the green pin and beam stand on the entrance itself, at the maqueta's elevation, and the building's edges (ground, roof, corners) light up in green when less than 300 m of route are left. The iPad gets the same through the route message, so the HUD optics draw it in the glass. Code: `updateOutline` in [src/render/ar.ts](src/render/ar.ts).

In **Simulación** (camera display), wherever the car is inside a maqueta tile, the overlay is drawn over the street in 3D instead of the camera picture: terrain from the tiles' elevation grids, streets from their ways (tilted with the slope) and the buildings extruded from their footprints, seen from the same camera pose as the AR. Outside the tiles the camera picture comes back. Tiles are blended near their shared edges (`elevationIn` in [src/core/maqueta.ts](src/core/maqueta.ts)), since each tile's grid is smoothed on its own and neighbours can differ by metres; the route profile uses the same ground. Code: [src/render/scenery.ts](src/render/scenery.ts).

## 7. Shared requirements

### 7.1 Navigation

- Destination: Google Maps/Waze link (including `maps.app.goo.gl` via `/api/expand`), coordinates, or address (Nominatim). Unchanged.
- Route steps → Spanish text and glyphs. Unchanged. Add distance-triggered **phrasing** ("En 200 m, gira a la derecha") for HUD text.
- Re-route after 5 s off-route and > 45 m away, at most every 10 s. Unchanged.

### 7.2 Data and privacy

- Hazard reports are shared through the Supabase database (anonymous, public anon key: anyone with the app can read and add, nobody can edit or delete from the app); file export kept.
- GPS track recording is local only, user-initiated.
- Remote camera (§6.2): video, GPS and tilt go directly between the two paired devices over WebRTC (encrypted). The PeerJS public broker only sees the peer ids and network addresses needed to connect them; the peer id is random per page load and the QR is only shown on the screen device.
- Calibration values stay in the device's localStorage.
- No accounts, no analytics in v1.

### 7.3 Performance and platform

- 60 fps target on a mid-range Android phone; the per-frame loop already avoids allocations in the ribbon (preallocated buffers) — keep it that way.
- Requires HTTPS (camera/GPS), landscape, wake lock. **Android + iOS PWA** are both v1 targets. Android Chrome gets fullscreen, orientation lock and the share-sheet entry. iOS Safari: GPS, camera and wake lock (16.4+) work; **no orientation lock** (show a "rotate your phone" overlay in portrait), **no fullscreen on iPhone** unless installed to the home screen (use `display: standalone`), **no Web Share Target** (paste-only destination), and `DeviceOrientationEvent` needs a user-gesture permission prompt. Test every milestone on one iPhone and one Android phone.
- Fullscreen and wake lock are best-effort and never block *Iniciar* (some browsers never settle those promises); bump detection is optional, so a denied motion permission doesn't stop a drive.
- Remote camera: the phone page needs https for the camera (dev: `npm run dev` with its self-signed certificate, accepted once on the phone; or the deployed site). It works with iPhone rotation lock on (R4). Test on a real iPhone + iPad pair before demos.

### 7.4 Safety and legal

- The app must never ask for input while moving beyond the two large hazard buttons and Exit.
- First-run notice: not a replacement for attention to the road; the driver is responsible.
- Check local rules on windshield-mounted devices and displays in the target market before distributing.

## 8. Technical risks and dependencies

| Risk | Impact | Mitigation |
|---|---|---|
| **Windshield reflection quality** (double image, glare, low contrast in sun) | HUD unreadable | Build the physical prototype first (§9 M0); test with combiner film vs. bare glass; fall back to HUD-lite (screen-space cues) |
| **Registration error from parallax** (virtual image at 1–2 m, head movement) | Ribbon doesn't sit on the lane | Keep graphics sparse and far-field-tolerant; rely on the fixed screen-space glyph for the cue (H5/§5.2); document the eyebox |
| **GPS error (5–10 m urban)** and 1 Hz updates | Turn arrow in wrong place | Existing snap + dead-reckoning; show turn distance as text; H9 fallback |
| **No gyro fusion** | Overlay drifts in turns | C1/C2 |
| **OSM data quality / OSRM public server** | Wrong turns, throttling | Self-hosted OSRM or a commercial router |
| **Phone heat in sun** (camera + GPS + GPU + max brightness) | Throttling, shutdown | HUD mode needs no camera; cap pixel ratio at 2 (already); consider a 30 fps option |
| iOS limitations (no orientation lock, no share target, no iPhone fullscreen) | Rougher setup flow | Rotate overlay, standalone install prompt, paste-first destination UI; verify on a real iPhone at M1 |
| Gyro/compass noise and magnetic interference (walking, and in-car metal) | Ribbon swings or points off-road | Complementary filter, ignore compass when accuracy is poor, re-anchor yaw to route bearing when on-route and moving |
| **Lens FOV assumption** (63° for every phone) | Ribbon too wide or narrow as it recedes | Measure per phone model (record a drive, run COLMAP on it as done for the 3D street work: one iPhone gave 56°), ship a small model → FOV table, keep the per-device override |
| Auto tilt on a slope or with a soft mount | Pitch off by the slope angle; ribbon floats or sinks | Average over several stops; hand-set value wins (A5); dynamic compensation C2 |
| **PeerJS public broker** (free, no SLA, rate-limited) | Pairing fails during a demo | Self-host `peerjs-server` or signal through Supabase Realtime (already a dependency) before real users |
| **No TURN relay** for the remote camera | No video between two different mobile networks or behind strict NAT | Same Wi-Fi or the iPhone's hotspot for now; add a TURN service if remote camera becomes a product feature |
| Wi-Fi client isolation (buildings, events) | Phone can't open the laptop's dev server at all | Use the iPhone's hotspot, or the deployed https site (pairing then goes through the broker, not the LAN) |
| Phone heat and battery as remote camera (camera + canvas redraw + WebRTC encode + GPS) | Throttled frame rate, shutdown in sun | 1280×720 at 30 fps is the cap; drop to 15 fps or 960×540 if field tests show heat |

## 9. Milestones

| ID | Milestone | Done when |
|---|---|---|
| D0 | **Demo (existing code, camera AR only)** | Phone held or mounted steady, aimed along the route; calibrated once with the ⚙ sliders. Run live on a street where the OSRM driving route matches the path walked or driven, with a recorded drive in Repetición mode as backup. No gyro, no HUD, no new code beyond fixes found while rehearsing |
| M0 | **Physical prototype, no code** | Static test page (black bg, mirrored text + ribbon) shown on a phone on a dash, reflected on a parked car's windshield; decision on combiner film vs. bare glass; notes on daylight legibility |
| M1 | **HUD mode MVP** | H1–H5 working in `RouteSim` on a laptop with the mirror toggle; HUD layout and render style behind `display=hud` |
| M2 | **HUD calibration + persisted profiles** | H6, §5.3 profiles, calibration pattern |
| M3 | **Drive test, HUD** | One real drive of ≥ 15 min on a known route; log of misregistration, missed turns, legibility; fix top 3 |
| M4 | **Sensor fusion + walking mode** | C1/C2 behind a flag; A/B on a recorded drive via replay; C6 works on a 10-minute walk on a street with the device-orientation permission flow on iOS and Android |
| M5 | **Foot routing + hazard sharing decision** | C7 resolved (self-hosted foot profile or provider); hazard sharing decided after M3 drive-test data |
| A0 | **Automatic calibration** (§6.1) | Built 2026-10-24. Remaining: one real drive comparing auto pitch/roll/FOV against careful hand calibration; per-model lens FOV |
| R0 | **Remote camera field test** (§6.2) | iPhone mounted horizontally + iPad/laptop, ≥ 15 min drive on a known route: no sideways or flipping picture, latency and dropouts logged, reconnect after a phone lock works, guide registration as good as single-phone mode |

HUD work (M0 onward) starts after D0. M1 and M2 can be developed and demoed entirely indoors using the existing simulation mode. The remote camera also helps D0: the audience sees the guide on a projector while the phone stays on the windshield.

## 10. Testing

- Existing: `npm test` ([tests/run.ts](tests/run.ts)) covers geometry, links, the upload queue, bump detection, orientation, routing text, automatic calibration (visible FOV, steady-tilt mean, tilt window with car moving/stopped) and the remote camera (peer ids, phone URL, reachable address, physical-up angle, upright plan and its FOV). Extend to cover: the HUD calibration profile migration, the `degraded fix` rule (H9), and the HUD phrasing function.
- Remote camera end to end: two browser tabs, one as the screen and one as the phone with a fake camera (a canvas stream drawn sideways), fake GPS and fake orientation events; checks pairing through the real broker, the upright picture on the screen, phone GPS routing, auto calibration from the phone's tilt, and the lost-phone message.
- Visual: screenshot the HUD at 1080p landscape in sim mode with mirror on/off; verify nothing but black and the intended elements are drawn.
- Replay: record one real drive (existing recorder) and use it as the regression fixture for registration changes (C1/C2, calibration).
- Field: M0 and M3 checklists, with a passenger operating the phone.

## 11. Decisions and open questions

Decided:

| Topic | Decision |
|---|---|
| Hardware | Phone on the bare windshield (no combiner). Must also work as a handheld camera pointed at a street for walking |
| Market | Venezuela-first: Spanish, current hazard set |
| Hazard sharing | Built on Supabase (uploads, offline queue with undo window, shared loading); file export kept. Merging duplicates and expiry are still open (see TODO.md) |
| Routing | Public OSRM for now; walking requires a foot profile (C7), so a router change is likely at M5 |
| Platforms | Android + iOS PWA |
| Two devices | Not needed to navigate: one phone does everything (iOS supports geolocation; its gaps are UI/OS features, §7.3). Supported as an option: phone as remote camera + laptop/iPad as the screen (§6.2), for demos, projection and passengers |
| Calibration | Automatic by default (§6.1), no button. A slider moved by hand wins for that value and orientation until *Restablecer* |
| Remote camera transport | WebRTC through PeerJS's public broker, Google STUN, no TURN; phone sends an upright 1280×720 landscape picture |

Still open:

1. Is walking mode meant for pedestrians navigating a city, or mostly a way to demo the app without driving? That decides whether C7 (foot routing) is v1 or later.
2. If the bare-windshield double image at M0 is unacceptable, do we accept adding a cheap film, or drop HUD to a fallback of screen-space cues only?
3. Remote camera signaling: keep the PeerJS public broker, or move to Supabase Realtime / a self-hosted broker plus a TURN relay before anyone outside the team uses it?
4. Should bump detection and *Usar sensores* also come from the remote phone, so the screen device can sit anywhere?
5. Lens FOV: a per-model table, a one-time measurement flow, or both?

## 12. Assumptions made in this draft

- The HUD is a phone screen reflected on the bare windshield, not custom optics.
- Android Chrome and iOS Safari are both supported; iOS has a reduced setup flow (§7.3).
- Spanish UI, Venezuelan hazard set, no accounts. The only backend is the Supabase hazard database; the remote camera also uses the PeerJS public broker to introduce devices.
- The existing virtual-camera approach (route-derived yaw, automatically calibrated pitch/roll/FOV) is kept and extended, not replaced by a computer-vision pipeline.
- The phone used as a remote camera is mounted horizontally; held upright it still works, with a narrower picture.
