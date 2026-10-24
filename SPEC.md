# Vía AR — Product Spec

Status: draft v0.1 · Baseline: current `ar-nav` codebase (v0.1.0, Vite + TypeScript + Three.js PWA)

## 1. Goal

Show turn-by-turn navigation as **3D graphics anchored to the road ahead**, in two display modes that share one engine:

| Mode | Surface | Status |
|---|---|---|
| **Camera AR** | Phone screen: live camera video with the 3D overlay on top | Built (demo-grade) |
| **Windshield HUD** | Phone lying on the dashboard; its image reflects off the bare windshield. No camera video, overlay only | New |
| **Walking AR** | Phone held up, camera pointed at the street; same camera overlay, foot routing, heading from device sensors | New (variant of Camera AR) |

Out of scope for now: native apps, dedicated HUD hardware, combiner film, a two-phone setup (iOS needs no second device: geolocation works in iOS Safari), lane detection / computer vision, voice guidance, offline maps, multi-stop routes.

## 2. Users and key scenarios

Primary user: a driver in a city with poor road data and poor road surface (the current hazard set — *huecos*, *policías acostados*, *alcabalas* — is Venezuelan; UI copy is Spanish).

1. **Set destination before driving.** Paste/share a Google Maps or Waze link, type an address, or enter coordinates.
2. **Drive with camera AR.** Phone mounted on the windshield, landscape, pointing at the road. Guide ribbon + chevrons on the asphalt, a standing 3D arrow at the next turn, red markers on hazards.
3. **Walk with camera AR.** Hold the phone up toward the street; the ribbon and turn arrow follow a walking route. Heading comes from the compass/gyro, not the route.
4. **Drive with the windshield HUD.** Phone lies flat on the dashboard, screen up. Driver sees the arrow, distance and speed floating over the road, with no video competing for attention.
5. **Report a hazard** with one tap while driving.
6. **Demo / develop without driving**: simulation and recorded-drive replay (already built; keep).

## 3. What exists today (reuse as-is)

| Module | Role | Reuse in HUD mode |
|---|---|---|
| [src/render/ar.ts](src/render/ar.ts) | Three.js scene: ribbon, chevrons, turn arrow/ring, destination pin, hazard markers. Transparent canvas (`alpha: true`) | Same scene; add a HUD render style (§5.2) |
| [src/main.ts](src/main.ts) | Wiring + per-frame loop (split into drive/, walk/, render/, hazards/ — see SETUP.md) | Add mode switch + HUD layout |
| [src/core/geo.ts](src/core/geo.ts) | Local ENU projection, bearings, polyline projection | Unchanged |
| [src/core/route.ts](src/core/route.ts) | OSRM routing, Spanish instructions | Unchanged (see §8) |
| [src/drive/sources.ts](src/drive/sources.ts) | `GpsSource`, `RouteSim`, `TrackReplay` | Unchanged |
| [src/render/calib.ts](src/render/calib.ts) | `pitch, fov, height, yawOffset, lateral, ribbonWidth` in localStorage | One calibration profile per display mode (§5.3) |
| [src/hazards/store.ts](src/hazards/store.ts), [src/core/links.ts](src/core/links.ts), [api/expand.ts](api/expand.ts) | Hazards, destination parsing, short-link expansion | Unchanged |

### How the current rendering works (the part that matters for HUD)

- A **virtual camera** sits at `calib.height` above the road, yawed to the route bearing, pitched by `calib.pitch`, with FOV `calib.fov`. Road geometry from the route polyline is drawn in this camera, so it lines up with the real road *if* the calibration matches the phone's real camera.
- Heading is **not read from the compass or gyro**. Yaw = bearing of the route at the car's position (snapped), eased at ~4 Hz; off-route it falls back to GPS heading. Pitch/roll are fixed from calibration.
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
- Using the phone as both HUD and camera at once (second device could be the camera later).

## 5. Design

### 5.1 Architecture changes

```
                  ┌──────────────┐
 Source (gps/sim/replay) ─▶ frame() in main.ts ─▶ ArScene.update(FrameInput)
                  └──────────────┘                 │
                                                   ├─ render style: 'camera' | 'hud'
                                                   └─ view transform: mirrorX, flipY (CSS on canvas)
```

- Introduce a `Display = 'camera' | 'hud'` value, orthogonal to `Mode`. `Mode` still decides where position comes from.
- `main.ts`: when `display === 'hud'`, skip `startCamera`, hide `<video>`, set body class `hud` (black background, HUD layout, no cards).
- `ArScene` takes a `style` option: materials (opacity/colors), ribbon rendering (edge lines instead of a translucent fill), arrow scale. The scene graph, pooling and update logic stay as they are.
- Mirror/flip implemented as a CSS transform on `#ar` and the HUD text container (`transform: scale(-1, 1)`), not in Three.js, so text and 3D flip together.
- Extract the HUD text block (glyph, distance, street, speed) into one container so the same flip applies to it.

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

## 6. Camera AR mode — gaps to close (carried over from the baseline)

The camera mode works for a demo. To be dependable on the road:

| ID | Gap | Proposed fix |
|---|---|---|
| C1 | **Built for gps and sim modes (opt-in checkbox + ⌖ align button):** pitch, roll and compass yaw drive the camera; see `src/walk/orientation.ts`. Not yet: automatic yaw correction toward the route, tuning on real phones. Original gap: yaw comes from the route, so the overlay can't react to the car's actual heading change during a turn or lane change | Fuse `DeviceOrientationEvent` (gyro/compass) for short-term yaw/pitch/roll; keep route bearing as the long-term reference when driving |
| C2 | No pitch/roll compensation: bumps and slopes shift the ribbon off the road | Same fusion for pitch and roll (high-pass the gyro, low-pass toward the calibrated value) |
| C6 | **Walking** (phone in hand): route-derived yaw and fixed pitch are wrong because the phone points wherever the hand does | New `walk` profile: yaw, pitch and roll come from device orientation (iOS needs `DeviceOrientationEvent.requestPermission()` from a tap); camera height ~1.5 m; ribbon narrower (~1.2 m); route requested with a foot profile; no speed-based dead-reckoning assumptions above ~2 m/s; re-route threshold smaller (~20 m). C1/C2 are a prerequisite |
| C7 | Public OSRM demo server only serves the `driving` profile | Walking needs a foot profile: self-host OSRM with `foot.lua` or use a router that supports pedestrian routing. Until then, walking mode snaps to driving routes and is demo-only |
| C3 | Re-routing only in GPS mode and never when the OSRM request fails repeatedly | Surface a persistent "sin conexión" state; keep last route; retry with backoff |
| C4 | Hazard pool is 10 markers; hazards are filtered to 20 m from the route | Keep; document. Raise only if a field test shows pop-in |
| C5 | Public OSRM/Nominatim are rate-limited demo servers | Self-host or use a paid router before real users (§8) |

## 7. Shared requirements

### 7.1 Navigation

- Destination: Google Maps/Waze link (including `maps.app.goo.gl` via `/api/expand`), coordinates, or address (Nominatim). Unchanged.
- Route steps → Spanish text and glyphs. Unchanged. Add distance-triggered **phrasing** ("En 200 m, gira a la derecha") for HUD text.
- Re-route after 5 s off-route and > 45 m away, at most every 10 s. Unchanged.

### 7.2 Data and privacy

- Hazard reports stay on-device unless exported by the user. A shared hazard database is a separate decision (§10).
- GPS track recording is local only, user-initiated.
- No accounts, no analytics in v1.

### 7.3 Performance and platform

- 60 fps target on a mid-range Android phone; the per-frame loop already avoids allocations in the ribbon (preallocated buffers) — keep it that way.
- Requires HTTPS (camera/GPS), landscape, wake lock. **Android + iOS PWA** are both v1 targets. Android Chrome gets fullscreen, orientation lock and the share-sheet entry. iOS Safari: GPS, camera and wake lock (16.4+) work; **no orientation lock** (show a "rotate your phone" overlay in portrait), **no fullscreen on iPhone** unless installed to the home screen (use `display: standalone`), **no Web Share Target** (paste-only destination), and `DeviceOrientationEvent` needs a user-gesture permission prompt. Test every milestone on one iPhone and one Android phone.

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

HUD work (M0 onward) starts after D0. M1 and M2 can be developed and demoed entirely indoors using the existing simulation mode.

## 10. Testing

- Existing: `npm test` runs geometry and link-parsing tests ([tests/run.ts](tests/run.ts)). Extend to cover: the HUD calibration profile migration, the `degraded fix` rule (H9), and the HUD phrasing function.
- Visual: screenshot the HUD at 1080p landscape in sim mode with mirror on/off; verify nothing but black and the intended elements are drawn.
- Replay: record one real drive (existing recorder) and use it as the regression fixture for registration changes (C1/C2, calibration).
- Field: M0 and M3 checklists, with a passenger operating the phone.

## 11. Decisions and open questions

Decided:

| Topic | Decision |
|---|---|
| Hardware | Phone on the bare windshield (no combiner). Must also work as a handheld camera pointed at a street for walking |
| Market | Venezuela-first: Spanish, current hazard set |
| Hazard sharing | Deferred until after the M3 drive tests; keep file export meanwhile |
| Routing | Public OSRM for now; walking requires a foot profile (C7), so a router change is likely at M5 |
| Platforms | Android + iOS PWA |
| Two-phone setup | Not needed. iOS supports geolocation; its gaps are UI/OS features, handled in §7.3 |

Still open:

1. Is walking mode meant for pedestrians navigating a city, or mostly a way to demo the app without driving? That decides whether C7 (foot routing) is v1 or later.
2. If the bare-windshield double image at M0 is unacceptable, do we accept adding a cheap film, or drop HUD to a fallback of screen-space cues only?

## 12. Assumptions made in this draft

- The HUD is a phone screen reflected on the bare windshield, not custom optics.
- Android Chrome and iOS Safari are both supported; iOS has a reduced setup flow (§7.3).
- Spanish UI, Venezuelan hazard set, no accounts, no backend.
- The existing virtual-camera approach (route-derived yaw, calibrated pitch/FOV) is kept and extended, not replaced by a computer-vision pipeline.
