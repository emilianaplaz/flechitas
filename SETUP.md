# Vía AR — setup

Camera AR navigation: turn arrows and a guide ribbon drawn on the road through the phone camera, plus 3D warnings for reported huecos and policías acostados. Destination comes from a Google Maps or Waze link (paste or share), coordinates, or an address.

## Run locally

```bash
npm install
npm run dev        # https://localhost:5173 and https://<your-laptop-ip>:5173
npm test           # logic tests (geometry, link parsing)
```

Open the network URL on your phone (same Wi-Fi) and accept the self-signed certificate warning. Camera and GPS only work over HTTPS.

## Deploy (Vercel)

Mirror the repo to a personal one (see the hackathon README), import it in Vercel, framework = Vite. `api/expand.ts` deploys automatically as the function that expands Google Maps short links. Put the Vercel URL in `platanus-hack-project.jsonc`.

## Demo setup: phone = app + camera, iPad = windshield HUD

1. **iPad**: open the app, **Dispositivos → Avanzado → Usar esta pantalla como HUD** (or open `/?role=hud`). It remembers it and shows a 6-digit code. Lay it on the dash under the windshield; 📐 sets the car and iPad measurements (Toyota Fortuner 2015 preset).
2. **Phone**: open the app, **Dispositivos**, type the iPad's code, **Conectar** → "Conectado". On iPhone accept the motion permission (used for tilt).
3. **Destino**: search, paste a Maps/Waze link or tap the map. Inside the maqueta zone (dashed blue frame, Av. San Juan Bosco) the button says **Elegir punto exacto**: pick the building and entrance in the Maqueta, then **Confirmar punto y conducir**.
4. Mount the phone on the dash **horizontally**, back camera to the road. It shows the camera AR view; the iPad switches to the HUD by itself and goes back to its code when you tap **Terminar**.

Both devices need internet and https (deployed site, or `npm run dev` and accept the certificate on each device). Same Wi-Fi or the iPhone's hotspot; Wi-Fi that isolates clients blocks the link. To stop being the HUD: **Usar como teléfono** on the iPad's code screen.

## Modes

In **Dispositivos → Modo**:

- **Real**: camera + GPS. Mount the phone on the dash, pointing at the road, in landscape or portrait. Each orientation keeps its own calibration. The ● button records video + GPS track together for later replay.
- **Simulación**: drives along the route at the speed on the slider. Use it indoors and on stage. "Desde" on the map screen sets the start point (empty = your location).
- **Repetición**: load a recorded video, optionally with its `.json` track, and the overlay runs on top of it. With the track, the car follows the recorded drive. Without it, pick a destination first: the car follows the planned route in step with the video (pause and seeking move it too) at the speed on the slider. Use the calibration sliders → "Sincronía" if the video and GPS drift apart.

Caminar / Manejar on the map: Caminar uses the phone sensors (phone in the hand), Manejar assumes a fixed mount. During a trip the **Manejar | Caminar** switch at the top of the drive screen changes it without ending the trip (not in Repetición or the iPad HUD): Caminar starts the sensors and shows ⌖, Manejar goes back to the fixed-mount tilt and, on a real drive with hazard detection on, to the bump sensor. The route stays the car route in both.

## Phone sensors (walking, phone in hand)

Tick **Usar sensores del teléfono** before **Iniciar**. The camera then looks wherever the phone points (compass, tilt and roll) instead of assuming it faces along the route. On iPhone, accept the motion permission prompt. If the ribbon is turned off the street, tap ⌖ while pointing the phone along the street to align it. Leave it off for a fixed car mount, where the compass is unreliable. In Simulación it also works, which lets you test it indoors.

## Calibrate, once per mount

*Altura de vista* and *Horizonte* are in **Dispositivos → Calibrar la vista**; every value (one slider at a time) is in the sliders button at the top right of Conducir.

Two values calibrate themselves, no button needed (`src/render/autocalib.ts`):
- **Campo de visión** is computed from the camera video size and the screen as soon as the camera starts, and again when the phone rotates. It assumes a 63° main lens (`DEFAULT_LENS_HFOV`); a measured value can be stored in `localStorage['ar-nav.lens'] = {"hfov": …}`.
- **Inclinación** and the sideways roll of the mount are read from gravity whenever the phone has been still for 2.5 s with the car stopped (accelerating and braking tilt gravity, so readings while moving are ignored). The first reading applies at once; later ones blend in. Roll has no slider and is applied directly. Needs the motion permission on iPhone (asked at **Iniciar**); without it, calibration stays manual. Not used in Repetición, nor with **Usar sensores**, which already reads the tilt live. On a slope the measured tilt includes the slope.

Moving **Inclinación** or **Campo de visión** by hand wins: from then on that value is not changed automatically for this orientation. **Restablecer** goes back to automatic.

Then fine-tune the rest by hand:
0. **Inicio de la guía** moves the start of the ribbon away from the bonnet or dashboard.
1. **Inclinación** until the guide sits on the asphalt rather than floating or sinking.
2. **Campo de visión** until the guide's width matches the lane as it recedes.
3. **Posición en el carril** to shift the guide sideways (route lines run down the road centre).
4. **Giro del soporte** if the guide drifts left or right on a straight road.

## Hazards

Two ways to get a hazard on the map:

1. **Tap** **⚠ Hueco** or **Policía acostado**. The point is placed about 1.5 s behind you, since you tap after hitting it.
2. **Automatic detection.** With **Detectar huecos y policías acostados** ticked, the accelerometer notices a jolt above ~14 km/h and asks "¿Qué fue eso?" with a guess selected. Pick Hueco, Policía acostado, or Nada. Needs the phone mounted firmly; on iPhone, accept the motion permission. In Simulación you can shake the phone to test it.

Reports upload to the shared database automatically (below) and are also kept on the phone. Hazards more than 20 m from the route are ignored.

## Shared hazard database (Supabase)

Taps and confirmed detections upload automatically, and everyone's hazards load when you press **Iniciar**.

1. Create a free project at supabase.com. In **SQL Editor**, paste and run [supabase/schema.sql](supabase/schema.sql).
2. In **Project Settings > API** copy the Project URL and the `anon` public key.
3. Local dev: copy `.env.example` to `.env.local` and fill both values, then restart `npm run dev`.
4. Deployed app: add the same two as environment variables on Vercel (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, for Production), then run `npx vercel --prod`. They are baked in at build time.

How it behaves: a reported hazard waits 60 s (so **Deshacer reporte** still works), then uploads. No signal means it stays queued on the phone and retries every 20 s, when the connection returns, and when you end the drive. Every answer to "¿Qué fue eso?" including **Nada** goes to a `detections` table with the sensor numbers, for tuning the detector. With no keys set the app works as before.

The app can add hazards but not edit or delete them. Fix or remove one in the Supabase table editor. The key is public, so anyone with the link can add reports.

## Encontrar: find a place or a person (GPS only)

The **+** button in the bottom bar opens the camera with a marker over each place you want to find, drawn from GPS and the phone's compass. Hold the phone upright; it needs the motion permission on iPhone.

- **Guardar este lugar** drops a pin where you stand ("Lugar 1", …, kept on this phone, up to 8). Walk back toward it by following the marker; ✕ in the list deletes it.
- **Compartir ubicación** creates a 6-digit code, starts your GPS and shows the code with **Enviar enlace**. The other person opens the link (or types the code under **Ver a alguien**) and taps **Ver ubicación**; they then see you as "Persona" on the camera, with your distance. Keep your screen open: a sleeping screen stops your GPS. The link opens the Encontrar screen with the code already typed and no camera yet; **Ver ubicación** starts the camera, because iPhone needs a tap for it.
- The code protects your live location. When someone connects, your screen asks **Alguien quiere ver tu ubicación** with their name (the name of their signed-in account, marked "Nombre sin verificar" because the app cannot check it, or "No ha iniciado sesión") and the buttons **Permitir** and **Rechazar**. Nothing is sent until you tap Permitir; no answer within 60 s counts as a refusal, and after 3 refusals the share stops and you need a new code. A person you allowed who loses signal reconnects without asking again, for as long as that share lasts. Only one person can watch at a time (anyone else is turned away while that person is connected), and if nobody connects within 10 minutes the share stops by itself. **Dejar de compartir** or leaving the screen ends it at once.

Accuracy is that of GPS, about 3–10 m in the open and worse between tall buildings or indoors; the marker says "±N m" when a fix is poor. Indoors and in garages it won't work. The link uses PeerJS's public broker like the iPad HUD, with no TURN server, so two phones on some mobile networks may not connect.

## Share from Google Maps / Waze (Android)

Install the deployed site to the home screen (Chrome menu → Install app). It then appears in the Share menu of Google Maps and Waze; sharing a place opens Vía AR with the destination filled in. On iPhone, copy the link and use **Pegar**.

## Files

Source is split by module so teammates can work in parallel. Each folder has one owner area; `core/` is shared, so tell the team before changing it.

- `src/main.ts`: composition root: wires the modules, start/stop, per-frame loop
- `src/setup.ts`: destination and drive options (mode, origin, destination, share target)
- `src/ui/`: phone screens. `shell.ts` screen switching + Dispositivos calibration, `destino.ts` the MapLibre map, `maqueta.ts` the 3D building picker
- `src/core/`: shared. `geo.ts` geometry, `route.ts` OSRM routing + Spanish instructions, `links.ts` Maps/Waze links + geocoding, `maqueta.ts` map tiles (elevation profile, speed limits, signs), `types.ts` (`Fix`, `Source`), `state.ts` (`app`), `ui.ts` DOM helpers
- `src/drive/`: navigation without orientation sensors. `sources.ts` GPS/sim/replay, `navigation.ts` route following + rerouting, `start.ts` per-mode startup, `controls.ts` record/sim buttons, `recorder.ts`
- `src/walk/`: navigation with sensors. `orientation.ts` compass/tilt/roll to camera pose, `view.ts` smoothing + "Alinear"
- `src/render/`: 3D and HUD. `ar.ts` Three.js overlay, `signMarkers.ts` road signs in 3D, `scene.ts`, `hud.ts`, `calib.ts` + `calibDock.ts`
- `src/remote/`: phone ↔ iPad link. `protocol.ts` code and messages, `phoneLink.ts` the phone side (route, fixes, tilt), `hudLink.ts` the iPad side, `orient.ts` tilt relative to the mounted phone
- `src/signs/`: road signs from the maqueta. `store.ts` signs of the current route, `ahead.ts` which ones apply to our street and direction. Navigation only calls `setSigns`, `signsAheadOf`, `clearSigns`
- `src/hazards/`: hazard mapping. `store.ts`, `cloud.ts` sync, `bump.ts` accelerometer detection, `ahead.ts` hazards along a route, `ui.ts` reporting UI. Navigation only calls `reindexHazards`, `aheadOf`, `trackPosition`
- `src/find/`: Encontrar (the + button). `aim.ts` where a place lands on the camera from GPS + compass + tilt, `pins.ts` saved places, `protocol.ts` + `link.ts` sharing a live location by 6-digit code over PeerJS (the sharer owns the code's peer id, the viewer dials it, and the sharer must approve each viewer before any position is sent), `ui.ts` the screen
- `api/expand.ts`: serverless function that expands `maps.app.goo.gl` links
- `scripts/maqueta/`: builds the map tiles in `public/maqueta/` (see below and [MAQUETA.md](MAQUETA.md))
- `pipeline3d/`: phone video → textured 3D street model (COLMAP + OpenMVS), step by step in [pipeline3d/README.md](pipeline3d/README.md)

The public OSRM and Nominatim servers are fine for a demo but rate-limited.

## Maqueta (map tiles)

The overlay follows the road's slope and shows OSM road signs and the speed limit where there are tiles in `public/maqueta/`. The tiles also carry building footprints (OSM + Microsoft), used by the Maqueta screen and the lit destination building. Elsewhere the road is drawn flat, as before. To build or refresh a zone listed in `scripts/maqueta/zones.json`:

```bash
npm run maqueta -- san-juan-bosco
```

It queries Overpass and Open-Meteo (a dozen requests for four tiles, with pauses), so run it by hand, not in CI, and commit the result. Hand corrections go in `scripts/maqueta/overrides/{x}_{y}.json` and win over OSM on the next build:

```json
{ "signs": [{ "id": "manual:1", "type": "stop", "lat": 10.5105, "lon": -66.8519, "dir": 350 }], "removeSigns": ["osm:n123"], "elev": [{ "r": 4, "c": 7, "z": 968.5 }] }
```

`dir` is the compass bearing of the traffic the sign is for; leave it `null` for both directions.
