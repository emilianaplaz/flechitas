# Glosario

[← Índice](README.md)

| Término | Significado |
|---|---|
| **Actitud** | Cabeceo (`pitch`) y ladeo (`roll`) de la carrocería respecto a la vía. En el HUD sale de la inclinación del teléfono menos su inclinación en reposo. |
| **Alcabala** | Punto de control policial o militar en la vía. Tipo de peligro (`alcabala`) que existe en el modelo pero hoy no se puede reportar. |
| **`along`** | Distancia en metros sobre la ruta desde su inicio. Todo lo que está "en la ruta" se ubica con su `along`. |
| **AR sobre la cámara** | Pantalla `display = 'camera'`: el video de la cámara trasera con la escena 3D encima. |
| **Arrival / punto exacto** | El punto de llegada elegido en la Maqueta (una entrada de un edificio): `{lat, lon, label, outline, height}` en `app.arrival`. |
| **Broker (PeerJS)** | Servidor público `0.peerjs.com` que presenta a dos equipos por su id para abrir WebRTC. No ve los datos. |
| **Cámara espejo (E′)** | El ojo del conductor reflejado en el plano del parabrisas. Una cámara ahí, mirando el iPad real, ve el mundo reflejado. |
| **Cinta (*ribbon*)** | La banda de un carril de ancho pintada sobre la vía a lo largo de la ruta (90 m; 110 m en el HUD). |
| **Chevrones** | Las flechas pintadas sobre la cinta cada 5 m. |
| **Código de vinculación** | 6 dígitos que muestra el iPad (o quien comparte su ubicación); el id de PeerJS sale de él (`viaar-hud-…`, `viaar-find-…`). |
| **Dock de calibración** | La barra con un deslizador por valor que se abre en Conducir. |
| **ENU / marco local** | Plano tangente centrado en un punto: x este, y arriba, z sur (en metros). Es el de `core/geo.ts` y la escena Three.js. |
| **Entrada calculada / *Frente al edificio*** | La entrada que propone `entrancesOf()` cuando un edificio no tiene entradas: el medio de la fachada que da a la calle más cercana. |
| **Espejo simple** | El HUD sin óptica calculada: voltea canvas y texto con CSS (⇄ horizontal, ⇅ vertical). |
| **Fix** | Una lectura de posición: `{p, speed, heading, accuracy, t}`. |
| **Flecha de giro** | La flecha 3D de pie en el punto de la próxima maniobra (desde 300 m). |
| **FOV** | Campo de visión. `calib.fov` es el **vertical** de lo que se ve en pantalla; el del lente (`hfov`, 63° por defecto) es el horizontal a lo largo del lado largo del video. |
| **Fortuner (preset)** | Medidas estimadas de un Toyota Fortuner 2015 para el HUD: ojo 1,50 m, tablero 1,12 m, base del vidrio 1,05 m, rake 33°, capó 9,9°. |
| **GoTrue** | La API de autenticación de Supabase (`/auth/v1/…`). |
| **Homografía** | Transformación proyectiva 2D (3×3). Se aplica al texto del HUD como CSS `matrix3d` para que se lea bien en el vidrio. |
| **Hueco** | Bache. Tipo de peligro `hueco`; se dibuja como un cono rojo. |
| **HUD (de texto)** | Las tarjetas de texto sobre la escena: maniobra, velocidad, límite, restante, ETA (`render/hud.ts`). |
| **HUD del parabrisas** | Pantalla `display = 'hud'`: fondo negro, la guía dibujada para verse reflejada en el parabrisas. Normalmente en el iPad. |
| **Imagen virtual** | Donde el conductor ve la pantalla reflejada: a ~0,9 m, inclinada 2 × rake. |
| **Kooima (proyección fuera de eje)** | Proyección en perspectiva para un ojo que mira un rectángulo que no está centrado ni de frente. |
| **Layout** | Orientación de la pantalla para la calibración: `landscape` (horizontal) o `portrait` (vertical). Cada una tiene su perfil. |
| **Línea de meta** | El bloque a cuadros que cruza la cinta donde termina la ruta. |
| **Maqueta** | Nuestros datos del mapa precompilados en teselas (relieve, señales, vías, edificios). También la pantalla isométrica para elegir el punto exacto. |
| **Modo** | De dónde sale la posición: **Real** (`gps`), **Simulación** (`sim`), **Repetición** (`replay`). |
| **Modo degradado** | GPS viejo (>3 s) o impreciso (>30 m): no se dibuja la cinta. |
| **`mountRoll`** | Ladeo medido del soporte del teléfono; no tiene deslizador. |
| **NavFrame** | Lo que devuelve `advance()` por cuadro: origen, rumbo, `along`, próxima maniobra, restante, velocidad, en ruta. |
| **Óptica calculada** | El HUD con la geometría exacta de la reflexión (`render/optics.ts`). Encendida por defecto. |
| **OSRM** | Motor de rutas sobre OpenStreetMap; usamos el servidor público de demostración. |
| **Outbox / cola de subida** | Lista persistente en `localStorage` de lo que falta subir a Supabase (peligros, lugares). |
| **Override** | Corrección a mano de una tesela (`scripts/maqueta/overrides/{x}_{y}.json(c)`) que gana sobre los datos abiertos. |
| **Perfil de elevación** | `RouteProfile`: la altura de la vía cada ≤5 m de la ruta, de la maqueta. |
| **Pitch / roll / yaw** | Inclinación hacia abajo, ladeo y rumbo, en grados. |
| **Policía acostado** | Reductor de velocidad (*speed bump*). Tipo `policia`; de OSM vienen como `bump`, `hump` o `table`. Se dibuja como la joroba a rayas. |
| **Quadkey** | Índice de teselas de Microsoft; los archivos de huellas van por quadkey de zoom 9. |
| **Rake** | Ángulo del parabrisas con la horizontal. |
| **Recálculo** | Pedir una ruta nueva al salir de la ruta (5 s, más de 45 m, cada 10 s como máximo). |
| **Refl** | La reflexión en el plano del parabrisas: `p − 2((p − G)·n) n`. |
| **RLS** | *Row Level Security* de Postgres/Supabase: las políticas que limitan qué filas ve y cambia cada rol. |
| **Rol** | Teléfono (app completa) o iPad HUD (`?role=hud`). |
| **Señales de curva (*gate*)** | Los cuatro paneles con chevrones al otro lado del cruce antes de un giro. |
| **`sid`** | Id de sesión al azar de quien pide ver una ubicación en Encontrar; permite reconectar sin volver a preguntar. |
| **Source** | Fuente de posición: `GpsSource`, `RouteSim`, `TrackReplay`, `RemoteGpsSource`. |
| **STUN / TURN** | Servidores que ayudan a WebRTC a atravesar NAT; TURN además retransmite cuando no hay conexión directa. |
| **Tesela** | Cuadro de la rejilla web estándar en zoom 16 (~600 m en Caracas): `public/maqueta/16/{x}/{y}.json`. |
| **Ventana de deshacer** | Los 60 s que espera un peligro reportado antes de subirse. |
| **Wake lock** | Pedido al navegador para que la pantalla no se duerma. |
| **Web Share Target** | Lo que permite que la PWA instalada aparezca en *Compartir* de Google Maps y Waze (Android). |
| **Zona** | Caja de coordenadas de `scripts/maqueta/zones.json` con sus teselas; un destino dentro activa *Elegir punto exacto*. |
