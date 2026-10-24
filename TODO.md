# TODO

## Tomorrow: camera detection of huecos and policías acostados

- Decide where it runs. Live in the browser is heavy (a small object-detection model on WebGL/WASM, with a risk of heating the phone). Post-processing a recorded drive is easier: load the video and `.json` track that the ● recorder already saves, run detection offline, and write hazards with the GPS position at the frame's timestamp.
- Needs training data. Record drives, label frames (pothole, speed bump, painted bump), or look for an open pothole dataset and check its licence and whether it looks like Venezuelan roads.
- Output goes into the same `Hazard` shape (`type`, `lat`, `lon`, `heading`, `source: 'camera'`) and goes through the same "¿Qué fue eso?" confirmation, so wrong detections never reach the map unconfirmed.
- Combine with the accelerometer: a camera detection followed by a jolt within about 2 s is much more reliable than either alone.

## Shared database: built (Supabase), still to do

Uploads, offline queue and shared loading exist (see SETUP.md). Still missing: merging reports within ~15 m and the same travel direction into one hazard, a confirmation count, a `lastSeen` date, and expiry (potholes get fixed). A hosted database with a few serverless functions is enough.

## Other follow-ups

- Tune the detector thresholds in `src/bump.ts` on a real drive (the values come from reasoning, not field data). Mount rigidly. Expect false positives on rough roads.
- Import speed bumps from OpenStreetMap (`traffic_calming=bump|hump|table`; the Caracas area has about 670 nodes) along the route at start.
- Sensor yaw: tune the compass alignment on a real phone walk.
