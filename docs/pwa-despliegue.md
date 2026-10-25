# PWA, compartir desde Maps/Waze y despliegue

[← Índice](README.md)

## 1. PWA

- [public/manifest.webmanifest](../public/manifest.webmanifest): nombre *Vía AR*, `display: fullscreen`,
  `orientation: any`, fondo `#0b0f14`, íconos 192 y 512 (maskable).
- [public/sw.js](../public/sw.js): service worker mínimo, **red primero**. Al instalar guarda `/` y el
  manifest; cada navegación exitosa actualiza la copia de `/`; sin red devuelve lo guardado. Ignora
  `/api/` y otros orígenes. Se registra solo en `https:` (`main.ts`).
- La app shell no se guarda entera: sin red, los módulos JS, las teselas de la maqueta y el mapa no
  están disponibles (no hay modo sin conexión real).
- `index.html` se titula *MapZ*; el manifest dice *Vía AR*. Hay que decidir un nombre.

## 2. Web Share Target (Android)

El manifest declara `share_target` con `action: "/"`, `method: GET` y los parámetros `title`, `text`,
`url`. Con la app **instalada** (Chrome → *Instalar app*), aparece en *Compartir* de Google Maps y Waze;
al abrir, `initSetupScreen()` junta `url`, `text` y `title`, extrae el primer enlace, limpia la URL
(`history.replaceState`) y resuelve el destino. En iPhone no existe: se copia el enlace y se pega en
*¿A dónde vas?*.

Otros parámetros de URL que la app entiende: `?role=hud` (iPad) y `?comparte=123456` (Encontrar).

## 3. La función `/api/expand`

[api/expand.ts](../api/expand.ts) exporta `GET(request)` (formato de funciones de Vercel) y
`expandShortUrl(url)`:
- Acepta solo hosts `goo.gl`, `*.goo.gl` y `g.co` (400 si no): no es un proxy abierto.
- Sigue hasta 6 redirecciones con `redirect: 'manual'` y un *user agent* de Android, mientras siga en
  esos hosts.
- Si cae en la página de consentimiento (`consent.*`), devuelve el `?continue=`.
- Responde `{ url }` o `{ error }` con `cache-control: public, max-age=3600`.

En desarrollo, [vite.config.ts](../vite.config.ts) monta el mismo `expandShortUrl` como middleware en
`/api/expand`, así `npm run dev` se comporta igual.

## 4. Despliegue en Vercel

1. Vercel solo se conecta a repos propios: espejar el repo del hackathon en uno personal (ver
   [README.md](../README.md)) e importarlo con framework **Vite**. `api/expand.ts` se despliega solo
   como función.
2. Variables de entorno de producción: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (se hornean en el
   build; cambiar una exige redesplegar).
3. `npm run build` = `tsc --noEmit && vite build` → `dist/`.
4. Según [PLAN-HUD-AR.md](../PLAN-HUD-AR.md), cada push a `main` actualiza
   `https://ar-nav-sage.vercel.app`. La URL pública aún no está en `platanus-hack-project.jsonc` (ese
   archivo y `project-description.md` siguen con la plantilla del hackathon).

Tamaños del build actual (minificado / gzip): app ~658 KB / 186 KB (Three.js incluido), MapLibre
~803 KB / 218 KB (solo al abrir el mapa), PeerJS ~89 KB / 24 KB (solo al enlazar), CSS 37 KB + 65 KB
de MapLibre. Vite avisa de los trozos de más de 500 KB.

## 5. Requisitos de plataforma

- **HTTPS** obligatorio para cámara, GPS y sensores (el sitio desplegado, o `npm run dev` con su
  certificado autofirmado aceptado en cada equipo).
- **iOS Safari**: GPS, cámara y *wake lock* (16.4+) funcionan; los permisos de orientación y movimiento
  (`DeviceOrientationEvent.requestPermission`, `DeviceMotionEvent.requestPermission`) solo se pueden pedir
  dentro de un toque, por eso todo arranca en el toque de *Conducir*, *Conectar*, *Ver ubicación* o
  *Medir*. Sin pantalla completa en iPhone salvo instalada; sin Web Share Target; sin bloqueo de orientación.
- **Android Chrome**: pantalla completa, compartir desde Maps/Waze, `deviceorientationabsolute`.
- Pantalla completa y *wake lock* son "mejor esfuerzo": nunca bloquean *Conducir* (algunos navegadores
  nunca resuelven esas promesas). Al volver a la app durante un viaje se piden de nuevo.
- Sin WebGL, la app carga igual y *Conducir* explica cómo activar la aceleración por hardware.
