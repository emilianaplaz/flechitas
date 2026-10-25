# Desarrollo y pruebas

[← Índice](README.md) · Guía rápida original (en inglés): [SETUP.md](../SETUP.md)

## 1. Arrancar

Requisitos: **Node 22.6+** (los tests y el script de la maqueta usan `--experimental-strip-types`), npm.

```bash
npm install
npm run dev        # https://localhost:5173 y https://<ip-del-laptop>:5173 (certificado autofirmado)
npm test           # tests de lógica, sin navegador
npm run build      # tsc --noEmit && vite build → dist/
npm run preview    # sirve dist/
npm run maqueta -- san-juan-bosco   # regenera las teselas de una zona (red, varios minutos)
npm run maqueta:check               # revisa las teselas: conteos, repetidos, huellas sobre la calle
npm run fachadas   # experimento de fachadas en http://localhost:5190 (instala sus dependencias la primera vez)
```

- `vite --host` con `@vitejs/plugin-basic-ssl`: **https** para que el teléfono en el mismo Wi-Fi pueda
  usar cámara y GPS. Hay que aceptar el aviso del certificado en cada equipo (también en el iPad).
- Supabase opcional: `.env.example` → `.env.local` con `VITE_SUPABASE_URL` y `VITE_SUPABASE_ANON_KEY`
  ([cuentas-supabase.md](cuentas-supabase.md#1-configuración)). `.env*` está en `.gitignore`.
- Un Wi-Fi que aísla clientes impide abrir el servidor del laptop desde el teléfono: usar el hotspot
  del teléfono o el sitio desplegado.

Dependencias: `three` 0.170, `maplibre-gl` 4.7, `peerjs` 1.5. Desarrollo: `typescript` 5.6, `vite` 6,
`@types/three`, `@vitejs/plugin-basic-ssl`. Nada más.

## 2. Probar sin manejar

- **Simulación** (Ajustes → Modo): recorre la ruta a la velocidad de la barra (5–90 km/h). *Desde* permite
  empezar en cualquier punto (tocar *Desde* y luego el mapa). Dentro de la maqueta se ve la calle en 3D.
  La detección de huecos se puede probar sacudiendo el teléfono.
- **Repetición**: grabar un viaje real con ● (modo Real) y luego reproducir el video + `.json`.
  Ajustar *Sincronía video/GPS* en el dock si se desfasan.
- **HUD sin iPad**: Ajustes → Avanzado → *HUD aquí*, o abrir `/?role=hud` en otra pestaña o equipo.
- **Dos pestañas**: una con `?role=hud` y otra como teléfono en el mismo navegador sirven para probar el
  enlace (el broker de PeerJS es real).
- **Chrome DevTools → Sensors**: ubicación y orientación falsas.
- **Ganchos de depuración** (solo `npm run dev`): `window.__map` (el mapa MapLibre) y `window.__mq`
  (`items`, `camera`, `pick`, `toScreen`, `groundAt`, `transformAt`, `az` de la Maqueta).

## 3. Tests

`npm test` corre [tests/run.ts](../tests/run.ts) con Node (sin navegador, sin framework): una función
`check(nombre, ok)` y un `localStorage` en memoria. Hoy pasan **357 comprobaciones**. Secciones:

| Sección | Qué cubre |
|---|---|
| geo | haversine, bearing, offset, proyección y `pointAt` sobre una ruta en L, geohash |
| links | enlaces de Google (largos, `/dir/`, `/place/`, pin), Waze, coordenadas, texto |
| route text | `describe()` y `formatDistance()` |
| device orientation | `poseFromEuler` en varias posturas y orientaciones de pantalla |
| bump detection | golpes duros y suaves, tipo por el orden del movimiento, ruido ignorado, velocidad mínima, refractario |
| merging reports | agrupación, pesos, tipo ganador, vencimiento, OSM |
| upload queue | cola, ventana de deshacer, `amend`, `cancel`, 409, flush forzado |
| auto calibration | `visibleVfov`, `steadyMean`, `TiltWindow` con el carro quieto y en marcha, perfiles y espejo |
| phone ↔ iPad link | ids, código, `encodeRoute`/`decodeRoute` |
| remote camera | `physicalAngle`, `interfaceAngle`, `uprightPlan` |
| windshield HUD optics | reflexión, números del Fortuner, matrices vs. trazado de rayos, eje del espejo, homografía, ubicación |
| maqueta | matemática de teselas, interpolación, `RouteProfile` con 13 % de pendiente y huecos entre teselas, límites, señales por sentido, `zoneFor`, `tilesInBox`, `coverageEdges` |
| maqueta: revisión | `tileReport`, `maxGridSlope`, `crossTileDuplicates`, `roadsThroughBuildings`, `matchOffsets` |
| buildings | alturas, solapamiento, dedupe, overrides, `entrancesOf`, `buildingsIn` |
| find | `aim`, `onEdge`, `ViewerSlot`, `ApprovalGate`, `sanitizeName`, `parsePos`, `parseHello`, enlaces |
| saved places | pines, dueños, `mergePins`, la cola contra un Supabase falso (401, 400, red, dos usuarios) |
| seams / scenery | elevación continua entre teselas vecinas, calle 3D |
| accounts | alta, entrada, confirmación, renovación, salida contra un Supabase Auth falso |

Faltan tests de `drive/navigation`, `hazards/ahead` y `walk/view` ([TODO.md](../TODO.md)).

### Reglas para que los tests corran en Node

- Los archivos que importan los tests o los scripts se ejecutan con *type stripping*: **sin parameter
  properties en constructores ni `enum`** (ver el comentario de `RouteProfile`). Los archivos que solo
  corren en el navegador (p. ej. `drive/sources.ts`, `find/link.ts`) sí los usan.
- `import.meta.env?.…` con `?.`, porque en Node `import.meta.env` no existe.
- Lógica pura en archivos aparte (`optics.ts`, `autocalib.ts`, `protocol.ts`, `cluster.ts`,
  `buildings.ts`…) e inyección de `fetch`/`storage`/`now` (cuentas, lugares) para poder probar sin red.

## 4. Convenciones

- TypeScript `strict`, `noUnusedLocals`, imports con extensión `.ts` (`allowImportingTsExtensions`).
- Sin framework de UI: el HTML está en `index.html`; los módulos buscan elementos por id con `$()`.
- Textos de interfaz en español; comentarios de código en inglés.
- Ejes: los de `core/geo.ts` (x este, z sur, y arriba). Ángulos en grados salvo dentro de Three.js.
- `core/` es compartido: avisar al equipo antes de cambiarlo.
- Por cuadro: sin crear objetos en lo que corre 60 veces por segundo (buffers preasignados, pools).
- Todo `localStorage` en `try/catch`.
- Permisos de iOS: pedirlos como **primer `await`** dentro del manejador del toque.

## 5. Ramas y flujo

`origin/emi` es la rama por defecto (base de los PR). `main` es la que despliega Vercel (según
PLAN-HUD-AR.md); `v2`, `mejorar_UI` y `maqueta` son ramas de trabajo anteriores. El trabajo de esta ronda se junta en
`cambios-juando`; cada sesión trabaja en su rama de worktree, hace merge del último
`origin/cambios-juando` y sube con *fast-forward* (`git push origin HEAD:cambios-juando`). Antes de
integrar: `npm test && npm run build`.

## 6. Fuera de la app

- [pipeline3d/](../pipeline3d/README.md): de un video caminando a una calle 3D con textura (COLMAP +
  OpenMVS, sin GPU NVIDIA), con `select_frames.py`, `run_colmap.sh`, `run_openmvs.sh`, `georef.py` y su
  test. Spec: [SPEC-3D-STREETS.md](../SPEC-3D-STREETS.md). No está conectado a la app.
- [PRUEBA RENDER/](../PRUEBA%20RENDER/README.md): el primer modelo (97 s de video, ~76 m de calle) con un
  visor estilo Street View (`python -m http.server 8000 -d "PRUEBA RENDER"`).
- [experiments/fachadas/](../experiments/fachadas/README.md): página aparte (`npm run fachadas`, puerto
  5190, dependencias propias: `three`, `3d-tiles-renderer`, `vite`) que compara formas de darle aspecto
  real a los edificios de la maqueta. Lee las teselas de `public/maqueta/` con `core/maqueta.ts` y el video
  de `PRUEBA RENDER/`. Claves opcionales en `experiments/fachadas/.env.local`. Resultados en
  [RESULTADOS.md](../experiments/fachadas/RESULTADOS.md). No forma parte del build de la app.
