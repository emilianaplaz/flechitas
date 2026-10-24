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

## Modes

- **Manejar**: real camera + GPS. Mount the phone on the windshield, pointing at the road, in landscape or portrait. Each orientation keeps its own calibration (portrait starts with a taller field of view and a later guide start). The ● button records video + GPS track together for later replay.
- **Simulación**: drives along the route at the speed on the slider. Use it indoors and on stage. "Desde" sets the start point.
- **Repetición**: load a recorded video + its `.json` track and the overlay runs on top of the real drive. Use ⚙ → "Sincronía" if the video and GPS drift apart.

## Phone as the camera, laptop or iPad as the screen

On the laptop/iPad, tap **📱 Usar la cámara de un teléfono** and scan the QR with the iPhone camera. The phone opens a camera page; tap **Conectar**. From then on the app on the big screen uses the phone's **camera, GPS and tilt** (for auto calibration), so it works on an iPad or laptop with no GPS. Then pick Manejar or Simulación and **Iniciar** as usual; the ● recorder records the phone's video.

- The phone needs **https** for its camera: use `npm run dev` (the QR uses the laptop's network IP, accept the certificate warning on the phone too) or the deployed site.
- Both devices need internet: [PeerJS](https://peerjs.com)'s free public server introduces them, then video goes directly between them over WebRTC. Same Wi-Fi (or the iPhone's hotspot) works best; on two different mobile networks it can fail, since there is no relay (TURN) server.
- Keep the phone screen on: if it locks or the page closes, the big screen says so within a few seconds; scan again to reconnect.
- Not relayed yet: bump detection and "Usar sensores" still use the screen device's own sensors.

## Phone sensors (walking, phone in hand)

Tick **Usar sensores del teléfono** before **Iniciar**. The camera then looks wherever the phone points (compass, tilt and roll) instead of assuming it faces along the route. On iPhone, accept the motion permission prompt. If the ribbon is turned off the street, tap ⌖ while pointing the phone along the street to align it. Leave it off for a fixed car mount, where the compass is unreliable. In Simulación it also works, which lets you test it indoors.

## Calibrate (⚙), once per mount

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

Three ways to get a hazard on the map:

1. **Tap** **⚠ Hueco** or **Policía acostado**. The point is placed about 1.5 s behind you, since you tap after hitting it.
2. **Automatic detection.** With **Detectar huecos y policías acostados** ticked, the accelerometer notices a jolt above ~14 km/h and asks "¿Qué fue eso?" with a guess selected. Pick Hueco, Policía acostado, or Nada. Needs the phone mounted firmly; on iPhone, accept the motion permission. In Simulación you can shake the phone to test it.
3. **Demo data you write by hand.** Add entries to `public/hazards.json`:

```json
[
  { "id": "demo1", "type": "hueco", "lat": 10.4812, "lon": -66.9021, "createdAt": "2026-10-24T00:00:00Z", "heading": 80 },
  { "id": "demo2", "type": "policia", "lat": 10.4820, "lon": -66.9005, "createdAt": "2026-10-24T00:00:00Z" }
]
```

`type` is `hueco`, `policia` or `alcabala`. `heading` (degrees from north, optional) is the travel direction; without it the hazard shows in both directions. Hazards more than 20 m from the route are ignored.

Reports made with taps or detection stay on that phone. To share them, ⚙ → **Exportar reportes**, then save the file as `public/hazards.json` and deploy.

## Shared hazard database (Supabase)

Taps and confirmed detections upload automatically, and everyone's hazards load when you press **Iniciar**.

1. Create a free project at supabase.com. In **SQL Editor**, paste and run [supabase/schema.sql](supabase/schema.sql).
2. In **Project Settings > API** copy the Project URL and the `anon` public key.
3. Local dev: copy `.env.example` to `.env.local` and fill both values, then restart `npm run dev`.
4. Deployed app: add the same two as environment variables on Vercel (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, for Production), then run `npx vercel --prod`. They are baked in at build time.

How it behaves: a reported hazard waits 60 s (so **Deshacer reporte** still works), then uploads. No signal means it stays queued on the phone and retries every 20 s, when the connection returns, and when you end the drive. Every answer to "¿Qué fue eso?" including **Nada** goes to a `detections` table with the sensor numbers, for tuning the detector. With no keys set the app works as before.

The app can add hazards but not edit or delete them. Fix or remove one in the Supabase table editor. The key is public, so anyone with the link can add reports.

## Share from Google Maps / Waze (Android)

Install the deployed site to the home screen (Chrome menu → Install app). It then appears in the Share menu of Google Maps and Waze; sharing a place opens Vía AR with the destination filled in. On iPhone, copy the link and use **Pegar**.

## Files

Source is split by module so teammates can work in parallel. Each folder has one owner area; `core/` is shared, so tell the team before changing it.

- `src/main.ts`: composition root: wires the modules, start/stop, per-frame loop
- `src/setup.ts`: setup screen (mode, destination, share target)
- `src/core/`: shared. `geo.ts` geometry, `route.ts` OSRM routing + Spanish instructions, `links.ts` Maps/Waze links + geocoding, `types.ts` (`Fix`, `Source`), `state.ts` (`app`), `ui.ts` DOM helpers
- `src/drive/`: navigation without orientation sensors. `sources.ts` GPS/sim/replay, `navigation.ts` route following + rerouting, `start.ts` per-mode startup, `controls.ts` record/sim buttons, `recorder.ts`
- `src/walk/`: navigation with sensors. `orientation.ts` compass/tilt/roll to camera pose, `view.ts` smoothing + "Alinear"
- `src/render/`: 3D and HUD. `ar.ts` Three.js overlay, `scene.ts`, `hud.ts`, `calib.ts` + `calibDock.ts`
- `src/remote/`: phone as remote camera. `protocol.ts` shared messages and URLs, `display.ts` QR + receiving side, `phone.ts` the phone's camera page (`/?cam=<id>`)
- `src/hazards/`: hazard mapping. `store.ts`, `cloud.ts` sync, `bump.ts` accelerometer detection, `ahead.ts` hazards along a route, `ui.ts` reporting UI. Navigation only calls `reindexHazards`, `aheadOf`, `trackPosition`
- `api/expand.ts`: serverless function that expands `maps.app.goo.gl` links

The public OSRM and Nominatim servers are fine for a demo but rate-limited.
