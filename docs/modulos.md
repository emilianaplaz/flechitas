# Módulo por módulo

[← Índice](README.md) · Visión general en [arquitectura.md](arquitectura.md)

Cada sección lista qué hace el archivo, su API pública y con quién habla. Los archivos marcados
**(puro)** no tocan el DOM ni el navegador y tienen tests en [tests/run.ts](../tests/run.ts).

## Raíz

### [src/main.ts](../src/main.ts)
Raíz de composición. Inicializa los módulos (`initCalibDock`, `initHudControls`, `initHudSetup`,
`initHazardUi`, `initDriveControls`, `initSetupScreen`), decide el rol (teléfono o iPad HUD), conecta
los botones *Conducir* (`#start`), *Terminar* (`#stop`) y ⌖ (`#align`), y corre `frame()`.
Contiene `setRoute()`, `startRemoteDrive()`/`stopRemoteDrive()` (iPad), `enterImmersive()` (pantalla
completa + wake lock, ambos sin bloquear) y `carAttitude()`. Registra el service worker si la página es https.

### [src/setup.ts](../src/setup.ts)
Opciones del viaje en el teléfono. `initSetupScreen()` sincroniza los radios *Modo* y *Pantalla*,
Caminar/Manejar (`#goWalk`/`#goDrive`, que marcan el checkbox oculto `#useSensors`) y lee el destino
compartido por la Web Share Target (`?url=`, `?text=`, `?title=`).
- `setDestination(d, labelOnly?, arrival?)`: fija el destino (y el punto exacto si viene de la Maqueta).
- `resolveDestInput()`: resuelve lo escrito en `#dest` con `resolveDestination()`.
- `useSimulation()`: pasa a Simulación cuando el origen no es "aquí".
- `onDest(fn)`: avisa a quien le interese (el mapa) cuando cambia el destino.

## core/

### [core/geo.ts](../src/core/geo.ts) (puro)
Geometría local. Marco **x = este, z = sur, y = arriba** (Three.js con la cámara mirando a −z = norte).
Proyección equirectangular local con 110 540 m/° de latitud y 111 320·cos(lat) m/° de longitud.
`haversine`, `bearing`, `toLocal`/`fromLocal`, `offset`, `angleDiff`, `buildPolyline` (con distancias
acumuladas), `project` (punto más cercano de la polilínea, con `hint` de segmento para que sea barato por
cuadro y búsqueda completa si se aleja más de 60 m), `pointAt`, `bearingAt` (rumbo suavizado con
*look-ahead*) y `decodeGeohash` (enlaces cortos de Waze).

### [core/route.ts](../src/core/route.ts) (puro salvo `fetchRoute`)
`fetchRoute(from, to)` pide a OSRM (`/route/v1/driving/…?steps=true&geometries=geojson&overview=full`) y
devuelve `Route { poly, steps, duration }`. Cada `Step` trae `kind` (`TurnKind`), texto en español,
calle, ubicación y `along` (distancia sobre la ruta). Descarta `depart` y los `continue`/`new name`
rectos; siempre termina con un paso `arrive`. `describe()` traduce maniobras (redomas con número de
salida, rampas, bifurcaciones). `routeFromTrack()` hace una ruta desde un recorrido grabado.
`formatDistance()` redondea a 5 m, 10 m o km.

### [core/links.ts](../src/core/links.ts)
`parseInput()` (puro) reconoce enlaces de Google Maps (pin `!3d…!4d…`, `destination`/`daddr`/`q`/`ll`,
`/dir/`, `/place/`, `/search/`, `@lat,lon`), Waze (`/ul/h<geohash>`, `ll`, `to=ll.`, `q`), enlaces
cortos (`goo.gl`, `g.co`) y coordenadas sueltas. `resolveDestination()` expande los cortos por
`/api/expand` y geocodifica texto con Nominatim (`geocode()`).

### [core/maqueta.ts](../src/core/maqueta.ts) (puro salvo la carga)
Tipos de las teselas (`Tile`, `TileSign`, `TileWay`, `TileBuilding`, `TileEntrance`, `MaquetaIndex`),
matemática de teselas web z16 (`tileXY`, `tileToLatLon`, `tileOf`, `gridPoint`), elevación
(`tileElevation`, `elevationIn` que mezcla teselas vecinas), `RouteProfile` (elevación cada ≤5 m de la
ruta, `at(d)` sin crear objetos), `speedLimits`/`limitAt`, edificios (`buildingsIn`, `insideOutline`,
`entrancesOf`) y carga con caché (`loadTile`, `loadRouteMaqueta`). Ver [maqueta.md](maqueta.md).

### [core/types.ts](../src/core/types.ts)
`Fix { p, speed, heading, accuracy, t }` (`t` = `performance.now()` cuando el fix fue válido) y
`Source { name, start, stop, current(now) }`.

### [core/state.ts](../src/core/state.ts)
El objeto `app` (ver [arquitectura.md §3](arquitectura.md#3-estado-compartido)), `Mode` y `Display`.

### [core/ui.ts](../src/core/ui.ts)
`$()` (getElementById tipado), `toast()`, `setText()` (solo escribe si cambió), `setupMsg()`, `download()`.

## drive/

### [drive/sources.ts](../src/drive/sources.ts)
Fuentes de posición (`Source`):
- `GpsSource`: `watchPosition` con alta precisión; guarda el último fix y avisa por `onFix`.
- `RemoteGpsSource`: fixes que llegan del teléfono (el iPad la usa); `push(f)`.
- `RouteSim`: recorre la ruta a `speedKmh` (35 por defecto, barra 5–90), con pausa; precisión 3 m.
- `TrackReplay`: reproduce un recorrido grabado sincronizado con `video.currentTime + syncOffset`.
- `parseTrack()` valida y ordena un `.json` de recorrido.

### [drive/navigation.ts](../src/drive/navigation.ts)
`advance(fix, route, now, dt, lateral, setRoute) → NavFrame` (posición sobre la ruta, rumbo, próxima
maniobra, distancia, restante, velocidad, en ruta o no) y el recálculo. Ver [navegacion.md](navegacion.md).

### [drive/start.ts](../src/drive/start.ts)
`startSource(setRoute)` arranca cada modo (cámara, fuente, primera ruta), `startCamera(required)`,
`stopSource()` y `stopDrive()`.

### [drive/controls.ts](../src/drive/controls.ts) y [drive/recorder.ts](../src/drive/recorder.ts)
Botón ● (grabar video + GPS), *Pausar/Seguir* y la barra de velocidad de la simulación.
`DriveRecorder` graba con `MediaRecorder` (mp4 si se puede, si no webm; 6 Mb/s) y descarga
`recorrido-<fecha>.mp4|webm` y `recorrido-<fecha>.json` con el mismo reloj.

## walk/

### [walk/orientation.ts](../src/walk/orientation.ts) (`poseFromEuler` puro)
`poseFromEuler(alpha, beta, gamma, screenAngle) → {yaw, pitch, roll}` de la cámara trasera, con la
rotación W3C Z-X'-Y''. `OrientationSensor` escucha `deviceorientationabsolute`/`deviceorientation`,
pide permiso en iOS, usa `webkitCompassHeading` cuando existe y marca `absolute = false` si no hay
brújula. Una lectura vale 1,5 s.

### [walk/view.ts](../src/walk/view.ts)
Vista con sensores (*Caminar*): `startSensors()`, `stopSensors()`, `updateView(now, dt)` (suavizado
`k = dt·10`, devuelve `null` para usar el rumbo de la ruta) y `align(streetYaw)` (botón ⌖, guarda un
sesgo de brújula).

## render/

| Archivo | Qué hace |
|---|---|
| [ar.ts](../src/render/ar.ts) | `ArScene`: la escena Three.js con la cinta, chevrones, flecha de giro, señales de curva, destino, peligros, señales viales y la calle 3D. `update(FrameInput)` por cuadro. Ver [render-ar.md](render-ar.md). |
| [scene.ts](../src/render/scene.ts) | Crea el único `ArScene` sobre `#ar`; `ar` es `null` si no hay WebGL. |
| [signMarkers.ts](../src/render/signMarkers.ts) | Pool de 12 señales 3D (PARE, CEDA, FOTOMULTA, semáforo). |
| [scenery.ts](../src/render/scenery.ts) | `Scenery`: relieve, calles y edificios de la maqueta como fondo en Simulación. |
| [optics.ts](../src/render/optics.ts) (puro) | Óptica del parabrisas: reflexión, cámara espejo fuera de eje, imagen virtual, homografía del texto, consejo de ubicación, preset Fortuner. Ver [optica-hud.md](optica-hud.md). |
| [hudSetup.ts](../src/render/hudSetup.ts) | Hoja 📐 de medidas, `currentOptics()` (con caché por geometría y tamaño), `applyHudView()` (homografía del texto o espejo CSS). |
| [hud.ts](../src/render/hud.ts) | Tarjetas de texto (maniobra con glifo SVG, velocidad, límite, restante, ETA, *Llegaste*) y los botones ⇄ ⇅. `showHud()`, `renderHud()`, `hideHud()`. |
| [calib.ts](../src/render/calib.ts) | `Calib`, valores por defecto y rangos, perfiles por orientación y por pantalla, medidas del HUD, flags de espejo. |
| [autocalib.ts](../src/render/autocalib.ts) (puro) | `visibleVfov`, `steadyMean`, `TiltWindow`, flags de valores a mano, lente y ladeo guardados. |
| [calibDock.ts](../src/render/calibDock.ts) | Dock de calibración (un deslizador a la vez), `getCalib()`, `getMountRoll()`, `setCalibValue()`, `onCalibChange()`, calibración automática (`startAutoTilt`, `autoTiltTick`, `applyAutoFov`). Ver [calibracion.md](calibracion.md). |

## remote/

| Archivo | Qué hace |
|---|---|
| [protocol.ts](../src/remote/protocol.ts) (puro) | Código de 6 dígitos, id de peer `viaar-hud-<código>`, tipos `Arrival`, `RouteMsg`, `RemoteMsg`, `encodeRoute`/`decodeRoute`, `PING_MS = 1000`, `LOST_MS = 5000`. |
| [phoneLink.ts](../src/remote/phoneLink.ts) | Lado teléfono: `connectHud(code)`, `disconnectHud()`, `sendRoute`, `sendFix`, `sendStop`, inclinación a 20 Hz, reconexión, `onHudState`, `setDriveProvider`. |
| [hudLink.ts](../src/remote/hudLink.ts) | Lado iPad: `startHudLink(events)`, `remoteGps`, `remotePhone()`, `remoteTilt(now)`. |
| [orient.ts](../src/remote/orient.ts) (puro) | `physicalAngle` (hacia dónde está girado el teléfono según la gravedad), `interfaceAngle`, `uprightPlan`. Queda de la cámara remota por video (retirada); el teléfono usa `physicalAngle` para referir su inclinación a su "arriba" físico. |

Ver [enlace-ipad.md](enlace-ipad.md).

## hazards/

| Archivo | Qué hace |
|---|---|
| [store.ts](../src/hazards/store.ts) | `Hazard`, `HazardType` (`hueco`, `policia`, `alcabala`), `HAZARD_LABEL`, `HazardStore` (compartidos + locales + OSM; `add`, `confirm`, `undoLast`). |
| [cluster.ts](../src/hazards/cluster.ts) (puro) | Agrupa reportes cercanos, pesos, tipo ganador, vencimiento. |
| [bump.ts](../src/hazards/bump.ts) (puro `BumpDetector`) | Detector de golpes por acelerómetro y `BumpWatcher` (eventos `devicemotion`). |
| [cloud.ts](../src/hazards/cloud.ts) | Cola de subida persistente y lectura de Supabase. |
| [ahead.ts](../src/hazards/ahead.ts) (puro) | Proyecta los peligros sobre la ruta y elige los que se dibujan. |
| [ui.ts](../src/hazards/ui.ts) | Botón de confirmar hueco, *Deshacer reporte*, `reindexHazards`, `aheadOf`, `setOsmHazards`, `trackPosition`, `startBumpWatcher`, `startCloudSync`, `stopHazards`. |

Ver [peligros.md](peligros.md).

## signs/

[signs/ahead.ts](../src/signs/ahead.ts) (puro): `indexSigns()` proyecta las señales de las teselas sobre
la ruta (máx. 15 m de la línea, sentido compatible, sin policías acostados, que van por *hazards*) y
`signsAhead()` elige las que están entre 8 m atrás y 180 m adelante.
[signs/store.ts](../src/signs/store.ts): `setSigns`, `clearSigns`, `signsAheadOf`.

## find/

| Archivo | Qué hace |
|---|---|
| [protocol.ts](../src/find/protocol.ts) (puro) | Ids `viaar-find-<código>`, enlace `?comparte=`, mensajes, `ViewerSlot`, `ApprovalGate`, `sanitizeName`, `parsePos`, `parseHello`. |
| [link.ts](../src/find/link.ts) | `Sharer` (quien comparte) y `Watcher` (quien mira) sobre PeerJS. |
| [aim.ts](../src/find/aim.ts) (puro) | Dónde cae un punto GPS en la imagen de la cámara. |
| [ui.ts](../src/find/ui.ts) | Pantalla *Encontrar*. |
| [pins.ts](../src/find/pins.ts) | Lugares guardados en el equipo, con dueño. |
| [pinsSync.ts](../src/find/pinsSync.ts) (puro con dependencias inyectadas) | Fusión con la cuenta y cola de cambios. |

Ver [encontrar.md](encontrar.md) y [lugares-guardados.md](lugares-guardados.md).

## auth/

[auth/session.ts](../src/auth/session.ts) (puro con dependencias inyectadas): cliente de Supabase Auth
(alta, entrada, renovación, salida, perfil). [auth/ui.ts](../src/auth/ui.ts): instancia `auth` y la
pestaña *Cuenta*. Ver [cuentas-supabase.md](cuentas-supabase.md).

## ui/

| Archivo | Qué hace |
|---|---|
| [shell.ts](../src/ui/shell.ts) | `go(screen)` entre `destino`, `maqueta` y `dispositivos` (Ajustes); los deslizadores *Altura de vista* y *Horizonte* con su vista previa; inicia lugares, cuenta y sincronización. |
| [destino.ts](../src/ui/destino.ts) | Mapa MapLibre (cargado al abrir), zonas de la maqueta, peligros, destino, origen arrastrable, vista previa de la ruta, *Guardar este lugar*, recentrar. |
| [maqueta.ts](../src/ui/maqueta.ts) | Pantalla Maqueta: vista isométrica Three.js, gestos, selección de edificio y entrada. |
| [lugares.ts](../src/ui/lugares.ts) | *Ajustes → Lugares guardados* y el menú ☆ junto a *¿A dónde vas?*. |
| [syncPins.ts](../src/ui/syncPins.ts) | Conecta la sincronización de lugares con la sesión. |

Ver [interfaz.md](interfaz.md).

## Fuera de `src/`

| Ruta | Qué es |
|---|---|
| [api/expand.ts](../api/expand.ts) | Función de Vercel `GET /api/expand?url=…`; `vite.config.ts` la sirve igual en desarrollo. |
| [scripts/maqueta/build.ts](../scripts/maqueta/build.ts), [buildings.ts](../scripts/maqueta/buildings.ts) | Generador de teselas y sus partes puras. |
| [supabase/schema.sql](../supabase/schema.sql) | Esquema completo, idempotente. |
| [public/](../public/) | `manifest.webmanifest`, `sw.js`, íconos, `maqueta/`. |
| [pipeline3d/](../pipeline3d/README.md), [PRUEBA RENDER/](../PRUEBA%20RENDER/README.md) | Experimento video → calle 3D (COLMAP + OpenMVS) y su visor. No está conectado a la app. |
| [tests/run.ts](../tests/run.ts) | Tests de lógica. |
