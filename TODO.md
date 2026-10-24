# TODO

## Team setup

- [ ] Invite teammates to the GitHub repo (Settings → Collaborators). The code is pushed to the `emi` branch of `emilianaplaz/flechitas`; open a PR to merge it into `main`.
- [ ] Invite teammates to the Supabase organization (Organization → Team → Invite) with the Developer role.
- [ ] Share `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` privately for each person's `.env.local` (see `.env.example`). Never share the `service_role` key.
- [ ] Optional: commit the schema as a Supabase migration (`supabase db pull`) so teammates can run a local copy.

## Tomorrow: camera detection of huecos and policías acostados

- Decide where it runs. Live in the browser is heavy (a small object-detection model on WebGL/WASM, with a risk of heating the phone). Post-processing a recorded drive is easier: load the video and `.json` track that the ● recorder already saves, run detection offline, and write hazards with the GPS position at the frame's timestamp.
- Needs training data. Record drives, label frames (pothole, speed bump, painted bump), or look for an open pothole dataset and check its licence and whether it looks like Venezuelan roads.
- Output goes into the same `Hazard` shape (`type`, `lat`, `lon`, `heading`, `source: 'camera'`) and goes through the same "¿Qué fue eso?" confirmation, so wrong detections never reach the map unconfirmed.
- Combine with the accelerometer: a camera detection followed by a jolt within about 2 s is much more reliable than either alone.

## Shared database: built (Supabase), still to do

Done: uploads, offline queue with undo window, shared loading, and the `confirmations` and `last_seen` columns in `supabase/schema.sql`.

Still missing: the app never reads or writes `confirmations` and `last_seen`, so nothing uses them yet.
- Merge reports within ~15 m and the same travel direction into one hazard, and bump `confirmations` and `last_seen` instead of adding a row. The anon key can't update rows, so this needs a serverless function or an RPC.
- Expire hazards that haven't been seen for a while (potholes get fixed), and stop loading them.
- Load only hazards near the route instead of the latest 5000 rows.

## Other follow-ups

- Tune the detector thresholds in `src/bump.ts` on a real drive (the values come from reasoning, not field data). Mount rigidly. Expect false positives on rough roads.
- Import speed bumps from OpenStreetMap (`traffic_calming=bump|hump|table`; the Caracas area has about 670 nodes) along the route at start.
- Sensor yaw: tune the compass alignment on a real phone walk.
