# TODO

## Drive (`drive/`)

- [x] GPS, simulated drive and recorded-drive replay position sources
- [x] Route following: smoothed position, snapping to the route, next maneuver
- [x] Automatic rerouting when off route
- [x] Drive recorder (video + GPS track) for later replay
- [ ] Windshield HUD display mode: black background, mirror/flip toggles, high-contrast palette (see `SPEC.md` §4–5)
- [ ] Degrade gracefully on a bad GPS fix (show only the turn glyph and distance)

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
- [ ] Fix the UI: review the HUD, settings panel (⚙) and report buttons on a real phone, in portrait and landscape, and list what's hard to use while driving
- [ ] Make the main controls bigger and easier to tap at a glance
- [ ] HUD render style (wider edge lines, solid chevrons, fewer elements)

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
- [ ] Import speed bumps from OpenStreetMap (`traffic_calming=bump|hump|table`; about 670 nodes around Caracas) along the route at start

## Core and destinations (`core/`)

- [x] Google Maps / Waze links, including the Android share sheet and short-link expansion
- [x] Addresses and coordinates as destinations
- [x] OSRM driving routes with Spanish instructions
- [x] Installable PWA

## Project structure

- [x] Source split into `core/`, `drive/`, `walk/`, `render/` and `hazards/` (see `SETUP.md`)
- [x] `SPEC.md` and `SETUP.md` updated for the new layout
- [ ] Tests for the newer seams: `drive/navigation`, `hazards/ahead` and `walk/view` (`tests/run.ts` covers geometry, links, the upload queue, bump detection, orientation and routing text)
- [ ] Smoke-test every mode (GPS, sim, replay, with and without sensors) on a phone
- [ ] Remove the `render/calibDock.ts` dependency on `drive/sources.ts`

## Housekeeping

- [ ] Share the Supabase URL and anon key privately for each person's `.env.local` (see `.env.example`); never share the `service_role` key
- [ ] Optional: commit the schema as a Supabase migration (`supabase db pull`) so teammates can run a local copy
