# TODO

## Drive (`drive/`)

- [x] GPS, simulated drive and recorded-drive replay position sources
- [x] Route following: smoothed position, snapping to the route, next maneuver
- [x] Automatic rerouting when off route
- [x] Drive recorder (video + GPS track) for later replay
- [x] Windshield HUD display mode: black background, mirror/flip toggles, high-contrast palette (see `SPEC.md` §4–5)
- [x] Degrade gracefully on a bad GPS fix (show only the turn glyph and distance)

## Walk (`walk/`)

- [x] Compass, tilt and roll steer the camera view, with smoothing
- [x] ⌖ "Alinear" button to line the view up with the street
- [ ] Foot routing (routes use the OSRM driving profile today)
- [ ] Tune the compass alignment on a real phone walk
- [ ] Automatic yaw correction toward the route

## Render (`render/`)

- [x] 3D overlay on the camera feed: ribbon, chevrons, turn arrow, hazard markers
- [x] HUD: speed, remaining distance and time, next maneuver, hazard banner
- [x] Calibration dock with a separate profile for portrait and landscape
- [x] Automatic calibration, no button (`render/autocalib.ts`, SPEC §6.1): field of view from the video and screen, pitch and roll of the mount from gravity while stopped; a slider moved by hand wins until *Restablecer*
- [ ] Check automatic calibration on a real drive against careful hand calibration
- [ ] Lens field of view per phone model (63° assumed; one iPhone measured 56° with COLMAP)
- [ ] Automatic mount yaw (*Giro del soporte*) from the optical-flow focus of expansion on straight stretches; validate against COLMAP poses of a recorded drive
- [ ] Fix the UI: review the HUD, settings panel (⚙) and report buttons on a real phone, in portrait and landscape, and list what's hard to use while driving
- [x] Make the main controls bigger and easier to tap at a glance
- [x] HUD render style (wider edge lines, solid chevrons, fewer elements)

## Hazards (`hazards/`)

- [x] Tap-to-report huecos, policías acostados and alcabalas
- [x] Accelerometer bump detection with a "¿Qué fue eso?" confirmation
- [x] Undo last report and export to file
- [x] Shared Supabase database with an offline upload queue and undo window
- [ ] Camera detection of huecos and policías acostados. Decide where it runs (live in the browser is heavy; post-processing a recorded drive is easier), find or record training data, and send detections through the same confirmation. Combined with an accelerometer jolt within about 2 s it is much more reliable
- [ ] Tune the bump detector thresholds (`hazards/bump.ts`) on a real drive; expect false positives on rough roads
- [ ] Merge reports within ~15 m and the same travel direction into one hazard, and use `confirmations` and `last_seen` (the app doesn't read or write them yet). The anon key can't update rows, so this needs a serverless function or an RPC
- [ ] Expire hazards that haven't been seen for a while
- [ ] Load only hazards near the route instead of the latest 5000 rows
- [x] Import speed bumps from OpenStreetMap (`traffic_calming=bump|hump|table`) through the maqueta tiles, where there are tiles

## Remote camera (`remote/`)

- [x] Pair a phone with a laptop/iPad by QR; the phone streams its camera over WebRTC (PeerJS) and sends GPS, tilt and field of view (SPEC §6.2)
- [x] QR points at the laptop's Wi-Fi address in dev, not localhost/VPN/WSL
- [x] Phone sends an upright 1280×720 landscape picture whatever way it's held, rotation lock included; ⟳ Girar as backup
- [x] Lost-phone detection (1 s ping, 5 s timeout) and reconnect mid-drive
- [ ] Field test: iPhone mounted horizontally + iPad, ≥ 15 min drive (SPEC milestone R0)
- [ ] Replace the PeerJS public broker (self-hosted or Supabase Realtime) and add TURN before outside users
- [ ] Relay bump detection and *Usar sensores* from the phone too

## Core and destinations (`core/`)

- [x] Google Maps / Waze links, including the Android share sheet and short-link expansion
- [x] Addresses and coordinates as destinations
- [x] OSRM driving routes with Spanish instructions
- [x] Installable PWA
- [x] Maqueta phase 1 (MAQUETA.md): tiles for Av. San Juan Bosco with elevation, OSM signs and ways; ribbon and markers follow the slope, signs in 3D, speed limit in the HUD
- [ ] Maqueta phase 2: Altamira and Los Palos Grandes, plus a recorded drive replayed as a regression fixture

## Project structure

- [x] Source split into `core/`, `drive/`, `walk/`, `render/`, `hazards/` and `remote/` (see `SETUP.md`)
- [x] `SPEC.md` and `SETUP.md` updated for the new layout, automatic calibration and remote camera
- [ ] Tests for the newer seams: `drive/navigation`, `hazards/ahead` and `walk/view` (`tests/run.ts` covers geometry, links, the upload queue, bump detection, orientation, routing text, automatic calibration and the remote camera's pure parts)
- [ ] Smoke-test every mode (GPS, sim, replay, with and without sensors) on a phone
- [ ] Remove the `render/calibDock.ts` dependency on `drive/sources.ts`

## Housekeeping

- [ ] Share the Supabase URL and anon key privately for each person's `.env.local` (see `.env.example`); never share the `service_role` key
- [ ] Optional: commit the schema as a Supabase migration (`supabase db pull`) so teammates can run a local copy
