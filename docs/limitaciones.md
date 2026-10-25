# Limitaciones conocidas, defectos y diferencias con los documentos viejos

[← Índice](README.md)

## 1. Limitaciones del sistema

| Área | Limitación | Qué haría falta |
|---|---|---|
| Rutas | OSRM y Nominatim públicos: con límite de uso, sin garantía. Siempre perfil `driving`, también al *Caminar*. | OSRM propio (con `foot.lua`) o un proveedor pago. |
| Posición | GPS a ~1 Hz con 5–10 m de error en ciudad. Se pega a la ruta a menos de 25 m y estima entre fixes. | Fusión con sensores. |
| Orientación al manejar | El rumbo sale de la ruta, no de los sensores: no reacciona a un cambio de carril. La inclinación es fija del soporte: baches y cambios de pendiente (fuera de la maqueta) mueven la cinta. | Fusión giroscopio + ruta (SPEC C1/C2). |
| Lente | FOV de 63° supuesto para todos los teléfonos (un iPhone midió 56°). | Tabla por modelo o medición. |
| Enlace iPad / Encontrar | Broker público de PeerJS y sus TURN públicos, sin garantía. El código de 6 dígitos es el único secreto del enlace del iPad; cualquiera que lo sepa puede mandarle mensajes. | Broker propio o Supabase Realtime, TURN propio, autenticación. |
| HUD | Paralaje (la imagen está a ~0,9 m), doble imagen del vidrio laminado, poco contraste de día, medidas del preset estimadas, sin seguimiento de cabeza. Etiquetas de peligros y tarjeta del destino ocultas con la óptica. | Prueba en carro con medidas reales. |
| Maqueta | Chacao con calles: 28 teselas en 11 zonas (faltan bordes con poco municipio adentro, ver MAQUETA.md). Sin entradas medidas; edificios de Microsoft a 9 m. En la Cota Mil el relieve mezcla el cerro con la vía. Sin malla que oculte la flecha tras las esquinas. | Más zonas, overrides medidos. |
| Peligros | Detector sin ajustar con datos reales. Se cargan los últimos 5 000 de toda la base. Los reportes nuevos del teléfono no llegan al iPad durante el viaje (el iPad carga los compartidos al empezar). | Ajuste de umbrales, carga por zona, mandar reportes por el enlace. |
| Sin conexión | El service worker solo guarda `/`: sin red no hay app, mapa, rutas ni teselas. | Precaché de la app y las teselas. |
| Plataforma | iOS: sin Web Share Target, sin pantalla completa en iPhone salvo instalada, permisos dentro de un toque. | — |

## 2. Defectos y restos encontrados en el código

Encontrados al documentar contra el código de `cambios-juando` (a292172). No se corrigieron aquí.

1. **Calibración automática guarda en el perfil equivocado.** `applyAutoFov()` y `autoTiltTick()` en
   [render/calibDock.ts](../src/render/calibDock.ts) llaman `saveCalib(calib, layout)` sin `app.display`.
   En el iPad (pantalla HUD) la inclinación de reposo del teléfono se escribe en el perfil de cámara
   (`ar-nav.calib.<layout>`) en vez de `ar-nav.calib.hud.<layout>`. Durante la sesión funciona; al
   recargar se pierde y el perfil de cámara del iPad queda modificado.
2. **El HUD no tiene aviso de peligros.** El commit `e01902c` quitó `#hazardBanner`. Con la óptica
   calculada, las etiquetas 3D también se ocultan, así que en el parabrisas un hueco es solo un cono sin
   texto. El comentario de `ar.ts` ("the HUD banner says it instead") quedó viejo, y `HudInput.nearestHazard`
   y el CSS de `#hazardBanner` no se usan.
3. **No hay forma de reportar a mano.** Se quitaron los botones `data-report`; el manejador en
   `hazards/ui.ts` queda sin botones. `alcabala` no se puede reportar.
4. **`Arrival.outline` y `height`** viajan al iPad "para el contorno iluminado", que ya no se dibuja.
5. **Tema claro a medias.** Las paletas `light` de `ui/destino.ts` y `ui/maqueta.ts` y los
   escuchas de `prefers-color-scheme` siguen, pero `theme()` devuelve siempre `'dark'`.
6. **Capas del mapa sin control.** `visible.holes`/`visible.bumps` existen pero no hay botones.
7. **Espejo simple apagado por defecto.** `loadFlip()` devuelve `mirrorX: false` si nunca se tocó ⇄
   (solo devuelve `true` si falla `localStorage`).
8. **Restos de la cámara remota por video**: `uprightPlan` (solo en tests) y comentarios en
   `drive/sources.ts` ("the one used as a remote camera") y `calibDock.ts` ("a phone paired by QR").
9. **Nombre**: la interfaz dice *MapZ*; el manifest, el texto de *Enviar enlace* y los documentos, *Vía AR*.
10. ~~**`ZONE_LABEL`** solo conocía `san-juan-bosco`~~: resuelto, cada zona trae su `label` en `index.json`.
11. **Esquema**: la tabla `detections` y las columnas `hazards.confirmations`/`last_seen` ya no se escriben.
12. **Metadatos del hackathon** sin llenar: `platanus-hack-project.jsonc` y `project-description.md`.

## 3. Diferencias con los documentos anteriores

Lo que decían [SETUP.md](../SETUP.md), [TODO.md](../TODO.md), [MAQUETA.md](../MAQUETA.md),
[PLAN-HUD-AR.md](../PLAN-HUD-AR.md) y la versión anterior de [SPEC.md](../SPEC.md), contra el código:

| Documento | Decía | Hoy |
|---|---|---|
| SPEC §7.2, §12 | Sin cuentas en v1 | Cuentas opcionales (Supabase Auth), perfiles y lugares sincronizados. |
| SPEC §6.3 | "No login"; *Registrar lugar* y *Perfil* para después, ⊕ deshabilitado | *Lugares guardados* y *Cuenta* hechos; no hay botón ⊕. |
| SPEC §6.3 | Temas oscuro y claro según el sistema | Solo oscuro. |
| SPEC §6.3 | Capas *Huecos / Policías acostados* en el mapa | Se dibujan siempre; sin control. |
| SPEC §6.3, §2, §7.4; SETUP | Botones ⚠ Hueco / Policía acostado, chip *Cámara fija*, la pregunta "¿Qué fue eso?" | Quitados. Detección automática con botón de confirmar hueco. |
| SETUP | Cada respuesta a "¿Qué fue eso?" va a la tabla `detections` | Ya no se escribe esa tabla. |
| SPEC §5.4 | El banner del HUD muestra el peligro | No hay banner. |
| SPEC §5.4 | Incidencia ~70° en el Fortuner; imagen de −8,4° a +0,6° | 61,4°; de −8,5° a +0,25° (iPad 11″). |
| SPEC §3, §1, §11; TODO | Cámara remota por QR: el teléfono manda video; `remote/display.ts`, `phone.ts`, `remoteStream()`, `remoteHfov()` | Retirada; esos archivos y funciones no existen. El iPad es solo HUD por código de 6 dígitos. |
| SPEC §6.2, §8; SETUP | Google STUN y sin TURN | PeerJS 1.5.5 trae por defecto TURN públicos de PeerJS. |
| SPEC §6.2 L6 | PeerJS ~117 KB | ~89 KB minificado (24 KB gzip). |
| SPEC §5.3 | Perfiles `ar-nav.calib.camera` / `ar-nav.calib.hud` | `ar-nav.calib.<orientación>` y `ar-nav.calib.hud.<orientación>`. |
| SPEC §7.2; TODO | Exportar los peligros a un archivo | No existe; queda *Deshacer reporte*. |
| SPEC §11 | Agrupar duplicados y vencimiento pendientes | Hechos (`hazards/cluster.ts`). |
| TODO | Agrupación a 12 m huecos y 15 m policías | 15 m para huecos y policías (mismo grupo), 12 m alcabalas. |
| SETUP | Encontrar: botón +, *Guardar este lugar* en la cámara, lista con ✕ | Encontrar es una pestaña solo para compartir ubicación; guardar es en el mapa y la lista en Ajustes. |
| SETUP | Zona de la maqueta: Av. San Juan Bosco | Las 11 zonas de Chacao (MAQUETA.md). |
| SETUP | `npm test`: geometría y enlaces | 327 comprobaciones de casi todos los módulos puros. |
| MAQUETA | Edificios de San Juan Bosco sin nombre | 10 edificios de OSM tienen nombre (ninguno en el tramo de prueba). |
| PLAN-HUD-AR | Enlace por Supabase Realtime, `src/render/shaders.ts`, `src/sync/` | WebRTC/PeerJS; esos archivos no existen (su nota de estado ya lo aclara). |
