# MapZ / Vía AR — Especificación del producto

Estado: **v0.3 (25 oct 2026)**, reescrita contra el código de `cambios-juando` (a292172). Reemplaza la
v0.2 en inglés. El detalle técnico de cada parte está en [docs/](docs/README.md).

Leyenda: ✅ hecho · 🟡 parcial · ⏳ planeado · ❌ retirado o quitado.

## 1. Objetivo

Mostrar la navegación giro a giro como **gráficos 3D anclados a la calle de adelante**: una cinta sobre
el carril, flechas en las esquinas y el punto exacto de llegada, más avisos de **huecos y policías
acostados** compartidos entre todos. Una sola app web (PWA) con dos superficies:

| Superficie | Dónde se ve | Estado |
|---|---|---|
| **AR sobre la cámara** | El teléfono fijo en el tablero, horizontal o vertical: video de la cámara trasera con la escena 3D encima | ✅ |
| **HUD del parabrisas** | Un iPad acostado en el tablero; su pantalla se refleja en el parabrisas, sobre la calle. Solo gráficos sobre negro, con la óptica exacta de la reflexión | ✅ (sin prueba en carro con medidas reales) |
| **AR en la mano** (*Caminar*) | El teléfono en la mano apuntando a la calle; la vista sigue los sensores | 🟡 (rutas de carro) |

Además: una **maqueta 3D** de la zona para elegir el edificio y la entrada de llegada, **Encontrar**
(compartir la ubicación en vivo con aprobación), **lugares guardados** y **cuentas** opcionales.

Fuera de alcance por ahora: apps nativas, hardware HUD dedicado, película combinadora, visión por
computadora (carriles, detección de huecos por cámara), voz, mapas sin conexión, rutas con paradas.

## 2. Usuarios y escenarios

Usuario principal: un conductor en una ciudad con datos viales pobres y calles en mal estado. Mercado
inicial Venezuela: interfaz en español, peligros locales (*huecos*, *policías acostados*, *alcabalas*).

1. **Elegir el destino antes de salir**: buscar, pegar o compartir un enlace de Google Maps o Waze,
   escribir coordenadas, tocar el mapa o elegir un lugar guardado. ✅
2. **Llegar a la puerta**: si el destino está en una zona de la maqueta, elegir el edificio y la entrada
   en 3D; la guía termina en esa entrada. ✅
3. **Manejar con la AR sobre la cámara**: teléfono fijo, cinta y chevrones sobre el asfalto, flecha de pie
   en el giro, señales de curva, señales viales, peligros en 3D, velocidad y límite. ✅
4. **Manejar con el HUD**: el iPad refleja la guía en el parabrisas mientras el teléfono hace todo lo demás. ✅
5. **Mapear la vía sin hacer nada**: el acelerómetro detecta huecos y policías acostados y los comparte;
   un toque confirma un hueco. ✅ (sin ajustar con datos reales)
6. **Probar sin manejar**: simulación desde cualquier origen (con la calle en 3D donde hay maqueta) y
   repetición de un viaje grabado. ✅
7. **Encontrar a alguien**: compartir la ubicación con un código; quien la ve tiene un marcador sobre la
   cámara con la distancia. ✅
8. **Montar y salir**: sin paso de calibración; el campo de visión se calcula al abrir la cámara y la
   inclinación se mide en la primera parada. ✅ (sin validar en un viaje real)

## 3. Roles, pantallas y modos

### 3.1 Roles del equipo (ver [docs/arquitectura.md](docs/arquitectura.md#1-dos-roles-un-mismo-código))

| Rol | Cómo | Qué hace | Estado |
|---|---|---|---|
| **Teléfono** | Por defecto | Toda la app, el GPS, los sensores, la ruta, la cámara. En el viaje muestra la AR sobre la cámara. | ✅ |
| **iPad = HUD** | `?role=hud` o *Ajustes → Avanzado → Usar esta pantalla como HUD del parabrisas* (se recuerda) | Muestra un código de 6 dígitos; cuando el teléfono empieza un viaje dibuja el HUD; vuelve al código al terminar. *Usar como teléfono* lo devuelve. | ✅ |
| Un equipo en HUD | *Ajustes → Avanzado → Pantalla de este equipo → HUD aquí* | HUD con el GPS propio, sin cámara, sin actitud del carro. Para probar. | ✅ |

### 3.2 Pantallas del teléfono (ver [docs/interfaz.md](docs/interfaz.md))

| Pantalla | Qué hace | Estado |
|---|---|---|
| **Mapa (Destino)** | Mapa real (MapLibre + OpenFreeMap, cargado al abrir). *Desde* (vacío = mi ubicación; otro origen escrito o puesto en el mapa pasa a Simulación), *¿A dónde vas?* (búsqueda, enlace, toque en el mapa con nombre por geocodificación inversa), ☆ lugares guardados, Caminar/Manejar, *Guardar este lugar*, recentrar, vista previa de la ruta con minutos y km, zonas de la maqueta como marco azul punteado, huecos y policías acostados. Con destino en una zona, el botón dice **Elegir punto exacto**. | ✅ |
| Capas del mapa | Encender y apagar huecos / policías acostados | ⏳ (se dibujan siempre) |
| **Maqueta** | Vista isométrica 3D de la zona; letras A–E en los edificios cercanos al destino; tocar uno, elegir entrada (o *Frente al edificio*); gestos de app de mapas (arrastrar, pellizcar, girar con dos dedos o trackpad, Ctrl/⌘/⌥/⇧ + arrastrar), girar 90°, brújula. **Confirmar punto y conducir**. | ✅ |
| **Conducir** | AR sobre la cámara. Chip *iPad conectado*, tarjeta de maniobra, velocidad y límite, botón de confirmar hueco, ● grabar, ⌖ alinear (con Caminar), tarjeta ETA (min · *Llegada: hh:mm* · lugar · km) con *Pausar* (sim/repetición) y *Terminar*. Horizontal y vertical. | ✅ |
| Botones ⚠ Hueco / Policía acostado, chip *Cámara fija*, banner de peligro | | ❌ quitados el 25 oct (`e01902c`) |
| **Dock de calibración** | Un deslizador por valor, *Restablecer*, *Deshacer reporte* | ✅ |
| **Ajustes → Dispositivos** | Código del iPad y estado, *Calibrar la vista* (vista previa del horizonte, *Altura de vista*, *Horizonte*), Modo (Real / Simulación / Repetición), *Detectar huecos* (por defecto sí), Avanzado | ✅ |
| **Ajustes → Lugares guardados** | Lista con distancia, renombrar, *Ir*, borrar, estado de sincronización | ✅ |
| **Ajustes → Cuenta** | Entrar / Crear cuenta / confirmar correo / cerrar sesión | ✅ |
| Bienvenida, entrada y permisos estilo app (onboarding) | | ⏳ en curso ([docs/trabajo-en-paralelo.md](docs/trabajo-en-paralelo.md)) |
| **Encontrar** | Compartir mi ubicación con un código / ver a alguien sobre la cámara | ✅ |
| Tema claro | | ⏳ (solo tema oscuro; las paletas claras están en el código sin usar) |

### 3.3 Modos de posición

| Modo | Fuente | Estado |
|---|---|---|
| **Real** | GPS del teléfono, cámara obligatoria (salvo HUD) | ✅ |
| **Simulación** | Recorre la ruta a 5–90 km/h desde cualquier origen; con maqueta, la calle 3D reemplaza a la cámara | ✅ |
| **Repetición** | Video + recorrido GPS grabados con ●; sincronía ajustable | ✅ |
| iPad | Los fixes del teléfono por el enlace | ✅ |

## 4. Navegación (ver [docs/navegacion.md](docs/navegacion.md))

| ID | Requisito | Estado |
|---|---|---|
| N1 | Destino desde enlaces de Google Maps (largos, `maps.app.goo.gl` por `/api/expand`) y Waze (incluye geohash), coordenadas, direcciones (Nominatim, primero Venezuela) | ✅ |
| N2 | Compartir desde Google Maps/Waze a la app instalada (Web Share Target, Android) | ✅ |
| N3 | Rutas OSRM con instrucciones en español (redomas con número de salida, rampas, bifurcaciones) | ✅ |
| N4 | Seguimiento: estimación entre fixes, pegado a la ruta a menos de 25 m, rumbo de la ruta suavizado | ✅ |
| N5 | Recálculo tras 5 s fuera de ruta y a más de 45 m, como máximo cada 10 s, solo en modo Real | ✅ |
| N6 | Fuera de ruta: *Fuera de ruta…* en la tarjeta | ✅ |
| N7 (H9) | Modo degradado: GPS de más de 3 s o peor de 30 m oculta la cinta; quedan la flecha y la distancia | ✅ |
| N8 (C3) | Estado persistente "sin conexión" al fallar el recálculo, con reintentos | ⏳ (solo un toast) |
| N9 | Frase por distancia ("En 200 m, gira a la derecha") | ⏳ |
| N10 (C7) | Rutas a pie | ⏳ (el OSRM público solo tiene carro) |

## 5. AR sobre la cámara (ver [docs/render-ar.md](docs/render-ar.md))

| ID | Requisito | Estado |
|---|---|---|
| R1 | Cámara virtual a `height` sobre la vía, rumbo de la ruta + giro del soporte, inclinación y ladeo del soporte, FOV de lo visible | ✅ |
| R2 | Cinta de un carril (3 m) por 90 m, cian uniforme (α 0,5), con desvanecido al final y aro; esquinas redondeadas sobre 10 m | ✅ |
| R3 | Chevrones pintados cada 5 m, que se desvanecen donde la vía gira respecto a la vista | ✅ |
| R4 | Llegada dentro de la cinta: verde en los últimos 40 m, corte en seco y línea de meta a cuadros elevada | ✅ |
| R5 | Flecha de giro 3D de pie desde 300 m, legible a cualquier distancia (≥ 8 % de la pantalla), con anillos | ✅ |
| R6 | Señales de curva (4 paneles con chevrones en ola) al otro lado del cruce desde 200 m, en giros reales | ✅ |
| R7 | Destino en la entrada exacta: resplandor, anillos, pin con bandera y tarjeta *Llegada · N m* / *Llegaste* | ✅ |
| R8 | Peligros: cono para huecos, la joroba a rayas para policías acostados, etiqueta, pool de 10 a ≤20 m de la ruta (C4) | ✅ |
| R9 | Señales de la maqueta: PARE, CEDA, FOTOMULTA, semáforos (los pasos peatonales no) | ✅ |
| R10 | Todo sigue la pendiente con la maqueta; la inclinación de la cámara suma la pendiente bajo el carro | ✅ |
| R11 | Calle 3D de la maqueta en lugar de la cámara en Simulación | ✅ |
| R12 (C1) | Fusión de giroscopio y brújula al manejar | ⏳ (solo con Caminar) |
| R13 (C2) | Compensación dinámica de cabeceo y ladeo | ⏳ |
| R14 | Ocultar la flecha detrás de los edificios (malla de profundidad) | ⏳ |
| R15 | Ancho de la cinta y posición por carriles de OSM | ⏳ |
| R16 (C6) | Caminar: vista por sensores, permiso en iOS, ⌖ alinear | ✅ · cinta angosta y recálculo a 20 m ⏳ |

## 6. HUD del parabrisas (ver [docs/optica-hud.md](docs/optica-hud.md))

### 6.1 Requisitos

| ID | Requisito | Estado |
|---|---|---|
| H1 | Pantalla HUD elegible (iPad o un equipo), sin cámara ni `<video>` | ✅ |
| H2 | Fondo `#000` puro, sin tarjetas ni paneles grises | ✅ |
| H3 | Espejo ⇄ y volteo ⇅ guardados | ✅ (respaldo; por defecto manda la óptica calculada) |
| H4 | Paleta de máxima legibilidad (verde α 0,92, texto grande con resplandor) | 🟡 sin prueba de día |
| H5 | Pocos elementos: cinta, chevrones, flecha, distancia, velocidad | ✅ · aviso de peligro ❌ (se quitó el banner; con la óptica las etiquetas 3D tampoco se ven) |
| H6 | Calibración para el ojo del conductor | ✅ reemplazada por la óptica exacta + ajuste fino |
| H7 | Wake lock; aviso de subir el brillo | ✅ (el aviso sale solo en el HUD de un equipo, no en el iPad) · paleta nocturna ⏳ |
| H8 | Nada interactivo en movimiento salvo controles grandes | 🟡 el HUD no es interactivo; falta revisión en carro |
| H9 | Modo degradado | ✅ |

### 6.2 Óptica exacta — ✅

- **Modelo**: marco del carro con origen bajo el ojo; medidas de ojo, tablero, base y ángulo del
  parabrisas (*Medir* con el sensor del equipo apoyado en el vidrio), centro del iPad, qué borde mira al
  conductor, píxeles CSS por pulgada (132 en iPad). Reflexión `Refl(p) = p − 2((p − G)·n) n`.
- **Proyección**: se dibuja el mundo reflejado (`Refl · worldToCar`) con una cámara en el ojo reflejado
  `E′` y la proyección fuera de eje de Kooima sobre las esquinas reales del iPad. Espejo, perspectiva y
  trapecio salen solos; borde de arriba hacia el conductor ⇒ espejo horizontal, hacia el vidrio ⇒
  volteo vertical.
- **Texto** (maniobra, distancia, velocidad): CSS normal más una homografía `matrix3d` que lo deja derecho
  y sin deformar en el vidrio, dentro de la imagen reflejada.
- **Hoja 📐**: preset *Toyota Fortuner 2015* (estimado: ojo 1,50 m, tablero 1,12 m, base 1,05 m, rake
  33°, capó 9,9°), lectura en vivo, consejo de dónde poner el iPad, avisos (capó, horizonte, luz de día),
  ajuste fino del ojo (±15 cm vertical, ±40 cm lateral), *Óptica calculada* sí/no.
- **Números del preset** (iPad 11″ horizontal, tests): imagen a 0,91 m del ojo, ~15° de ancho, de −8,5° a
  +0,25° = vía desde ~10 m hasta el horizonte, inclinada 66° (2 × rake), incidencia 61° en el vidrio (pasado
  Brewster, 56°); iPad a ~35 cm detrás de la base del vidrio.
- **Actitud**: cabeceo y ladeo de la carrocería = inclinación del teléfono − su inclinación en reposo,
  paso bajo de ~3 Hz. La inclinación del iPad nunca se usa.
- **Pendiente**: prueba en carro con medidas reales (⏳ en curso), contraste de día, doble imagen,
  ancho de la cinta (3,2 m llena mucho de una imagen de 15°).

## 7. Calibración (ver [docs/calibracion.md](docs/calibracion.md))

Siete valores por orientación (horizontal/vertical) y por pantalla (cámara/HUD): inclinación, campo de
visión, altura, giro del soporte, posición en el carril, ancho e inicio de la guía.

| ID | Requisito | Estado |
|---|---|---|
| A1 | FOV de lo visible desde el lente, el video y el recorte `cover` a la pantalla; al abrir la cámara, al cambiar el video y al girar | ✅ |
| A2 | Lente por defecto 63°, sobrescribible por equipo (`ar-nav.lens`) | ✅ · tabla por modelo ⏳ |
| A3 | Inclinación y ladeo del soporte desde la gravedad, solo con 2,5 s quietos **y el carro detenido**; primera lectura directa, siguientes al 50 % | ✅ sin validar en un viaje real |
| A4 | Ladeo sin deslizador, guardado por orientación y aplicado a la cámara | ✅ |
| A5 | Lo movido a mano gana hasta *Restablecer* | ✅ |
| A6 | Permiso dentro del toque de *Conducir*; no corre en Repetición, con Caminar ni en un HUD de un solo equipo; en el iPad usa la inclinación del teléfono | ✅ · guarda en el perfil de cámara aunque la pantalla sea HUD (defecto, ver [docs/limitaciones.md](docs/limitaciones.md)) |
| A7 | Giro del soporte automático por flujo óptico | ⏳ |

## 8. Enlace teléfono ↔ iPad (ver [docs/enlace-ipad.md](docs/enlace-ipad.md))

| ID | Requisito | Estado |
|---|---|---|
| L1 | Rol HUD por URL o botón, recordado | ✅ |
| L2 | Emparejar por código: el iPad registra `viaar-hud-<6 dígitos>` (se conserva, otro si está tomado); el teléfono lo escribe (espacios y guiones ignorados). *Conectando / Conectado / Reintentando*; *iPad conectado* en Conducir | ✅ |
| L3 | Mensaje `route` con la ruta y el punto exacto al empezar, en cada recálculo y al reconectar | ✅ |
| L4 | El iPad navega solo con la ruta y los fixes (`fix` hasta 10/s, `tilt` a 20 Hz) | ✅ |
| L5 | Ping cada 1 s; a los 5 s de silencio el iPad sigue con lo último; a los 15 s vuelve al código; el teléfono reintenta solo | ✅ |
| L6 | PeerJS (~89 KB) solo al enlazar | ✅ |
| L7 | Mandar al iPad los peligros reportados durante el viaje | ⏳ |
| — | Cámara remota (el teléfono mandaba su video a un laptop/iPad por QR) | ❌ retirada |

Red: broker público de PeerJS para presentar a los equipos; datos por WebRTC con STUN de Google y los
TURN públicos que PeerJS trae por defecto. Mismo Wi-Fi o hotspot del iPhone.

## 9. Maqueta y punto exacto de llegada (ver [docs/maqueta.md](docs/maqueta.md))

| ID | Requisito | Estado |
|---|---|---|
| M1 | Teselas estáticas z16 en `public/maqueta/` con elevación (13 × 13), señales, vías y edificios; la app nunca consulta servicios de mapas para esto | ✅ |
| M2 | Script `npm run maqueta -- <zona>`: Overpass, Open-Meteo (Copernicus 90 m, suavizado 3×3), Microsoft Building Footprints, deduplicación con OSM | ✅ |
| M3 | Correcciones a mano (`overrides/{x}_{y}.json(c)`) que siempre ganan: señales, alturas del suelo, edificios, edificios nuevos | ✅ mecanismo · ninguna aplicada todavía 🟡 |
| M4 | Relieve en la AR (cinta, marcadores, pendiente de la cámara), continuo entre teselas | ✅ |
| M5 | Señales en 3D y límite de velocidad en la tarjeta | ✅ |
| M6 | Policías acostados de OSM como peligros (AR y mapa) | ✅ |
| M7 | Pantalla Maqueta para elegir edificio y entrada | ✅ |
| M8 | Entrada calculada *Frente al edificio* cuando no hay entradas | ✅ |
| M9 | Ruta y marcador de destino en la entrada exacta, también en el iPad | ✅ (la tarjeta no se ve con la óptica del HUD) |
| M10 | Calle 3D en Simulación | ✅ |
| M11 | Zonas: `san-juan-bosco` y `altamira-sur` | ✅ · Chacao completo ⏳ en curso |
| M12 | Nombres, alturas y entradas medidos | ⏳ |
| M13 | Visuales reales de fachadas | ⏳ experimento en curso |

## 10. Peligros (ver [docs/peligros.md](docs/peligros.md))

| ID | Requisito | Estado |
|---|---|---|
| P1 | Detección por acelerómetro: golpe duro (≥ 14 km/h) o movimiento suave lento, con contragolpe; hueco si baja primero, policía si sube primero; se guarda sola sin confirmar (peso 0,5) | ✅ sin ajustar con datos reales |
| P2 | Botón de confirmar hueco durante 8 s tras una detección | ✅ |
| P3 | Botones de reporte manual (hueco, policía, alcabala) | ❌ quitados el 25 oct |
| P4 | Agrupar reportes a ≤15 m en el mismo sentido (alcabalas a 12 m), tipo por peso, ocultar una detección sola, vencer huecos a 90 días y policías a 1 año, OSM no vence | ✅ |
| P5 | Base compartida en Supabase: cola sin conexión con 60 s para deshacer, reintentos cada 20 s, al volver la red y al terminar | ✅ |
| P6 | Deshacer el último reporte | ✅ |
| P7 | Peligros en la AR, el HUD y el mapa | ✅ · aviso de texto en el HUD ❌ |
| P8 | Cargar solo los peligros de la zona (hoy los últimos 5 000) | ⏳ |
| P9 | Detección por cámara | ⏳ |
| P10 | Exportar a archivo | ❌ ya no existe |

## 11. Cuentas, Encontrar y lugares

| ID | Requisito | Estado |
|---|---|---|
| U1 | Cuenta opcional con correo y contraseña (Supabase Auth por REST): crear, confirmar correo, entrar, renovar sola, salir | ✅ ([docs/cuentas-supabase.md](docs/cuentas-supabase.md)) |
| U2 | Perfil con nombre visible (tabla `profiles`, creada por trigger) | ✅ |
| U3 | Bienvenida y entrada estilo app | ⏳ en curso |
| F1 | Compartir la ubicación con un código de 6 dígitos y un enlace `?comparte=` | ✅ ([docs/encontrar.md](docs/encontrar.md)) |
| F2 | Nada se envía hasta *Permitir*; un visor a la vez; 60 s sin respuesta = rechazo; 3 rechazos cortan; 10 min sin visor y el código vence | ✅ |
| F3 | Quien pide ver manda el nombre de su cuenta, mostrado como *Nombre sin verificar* | ✅ |
| F4 | Marcador "Persona · distancia" sobre la cámara con brújula, o en el borde con ‹ › | ✅ |
| G1 | Guardar el lugar actual desde el mapa (hasta 8), renombrar, ir, borrar | ✅ ([docs/lugares-guardados.md](docs/lugares-guardados.md)) |
| G2 | Lugares sincronizados con la cuenta, con cola sin conexión y fusión por fecha | ✅ |

## 12. Datos y privacidad

- **Peligros**: anónimos, con la clave pública de Supabase: cualquiera con la app lee y agrega, nadie
  edita ni borra desde la app (RLS). Llevan posición, rumbo, origen y si se confirmó.
- **Cuentas**: correo, contraseña (en Supabase Auth) y nombre visible. Los lugares guardados solo los ve
  su dueño (RLS).
- **Encontrar**: la posición va directo entre los dos equipos por WebRTC (cifrado DTLS), solo después de
  aprobar al visor. El broker de PeerJS ve los ids y las direcciones de red; si no hay conexión directa, el
  TURN público de PeerJS retransmite el tráfico cifrado.
- **Enlace con el iPad**: igual, por WebRTC; el código de 6 dígitos es el único secreto.
- **Recorridos grabados**: solo en el equipo, iniciados por el usuario (se descargan).
- **Calibración, medidas del HUD, reportes propios, lugares**: en `localStorage` del equipo.
- Sin analítica.

## 13. Plataforma y rendimiento

- PWA instalable (manifest, service worker de red primero). **Android Chrome e iOS Safari**.
- HTTPS obligatorio (cámara, GPS, sensores). Los permisos de iOS se piden dentro de un toque.
- Pantalla completa y wake lock son "mejor esfuerzo" y nunca bloquean *Conducir*.
- 60 cuadros por segundo como objetivo: buffers preasignados en la cinta, pools fijos, `pixelRatio ≤ 2`.
- Carga diferida: MapLibre (~800 KB) al abrir el mapa, PeerJS (~89 KB) al enlazar.
- Sin modo sin conexión real ⏳.

## 14. Seguridad vial y legal

- En movimiento, la app no debe pedir más que toques grandes (confirmar hueco, *Terminar*).
- Aviso de primer uso: no reemplaza la atención a la vía ⏳.
- Revisar las normas locales sobre pantallas en el tablero y el parabrisas antes de distribuir.

## 15. Riesgos técnicos

| Riesgo | Impacto | Mitigación |
|---|---|---|
| Calidad del reflejo (doble imagen, brillo, poco contraste de día) | HUD ilegible | Pruebas al atardecer o de noche; película combinadora si hace falta; respaldo con la AR del teléfono |
| Paralaje (imagen a ~0,9 m, cabeza que se mueve) | La cinta no cae en el carril | Gráficos poco densos, flecha legible, ajuste fino del ojo |
| GPS urbano (5–10 m, 1 Hz) | Flecha en el lugar equivocado | Pegado a la ruta, estimación, distancia en texto, modo degradado |
| Sin fusión de sensores al manejar | La guía se desliza en giros | R12/R13 |
| OSRM, Nominatim y PeerJS públicos | Rutas lentas, enlace que falla en una demo | Servidores propios o pagos; broker propio o Supabase Realtime |
| FOV del lente supuesto (63°) | Cinta más ancha o angosta al alejarse | Medir por modelo; valor por equipo |
| Inclinación automática en pendiente | Cinta que flota o se hunde | Promediar paradas; valor a mano gana |
| Calor y batería (cámara + GPU + brillo) | Bajada de cuadros o apagado | HUD sin cámara; `pixelRatio ≤ 2` |
| Detector de golpes sin datos reales | Falsos positivos en vías rotas | Peso 0,5 sin confirmar, agrupación, ajuste con un viaje |

## 16. Hitos

| ID | Hito | Estado |
|---|---|---|
| D0 | Demo con la AR sobre la cámara (repetición como respaldo) | Sin registro en el repo |
| M0 | Prototipo físico del reflejo en un carro estacionado | Sin registro en el repo |
| M1 | HUD MVP (H1–H5) en simulación | ✅ |
| M2 | Calibración del HUD | ✅ (óptica exacta) |
| M3 | Prueba de manejo de ≥ 15 min con el HUD, registro de errores | ⏳ en curso ([docs/trabajo-en-paralelo.md](docs/trabajo-en-paralelo.md)) |
| M4 | Fusión de sensores y Caminar | 🟡 Caminar con sensores; fusión al manejar ⏳ |
| M5 | Rutas a pie | ⏳ |
| A0 | Calibración automática | ✅ hecha · validación en un viaje real ⏳ en curso |
| R0 | Prueba de campo teléfono + iPad (antes: cámara remota) | ⏳ |
| Q1 | Maqueta fase 1 (San Juan Bosco) | ✅ |
| Q2 | Maqueta: zona Altamira sur | ✅ |
| Q3 | Maqueta: todo Chacao | ⏳ en curso |
| Q4 | Edificios, pantalla Maqueta, punto exacto, calle 3D en Simulación | ✅ |

## 17. Pruebas

- `npm test` ([tests/run.ts](tests/run.ts)): 327 comprobaciones de la lógica pura (geometría, enlaces,
  rutas, orientación, detector, agrupación, cola, calibración automática, protocolo del iPad, óptica,
  maqueta, edificios, Encontrar, lugares, cuentas). Detalle en [docs/desarrollo.md](docs/desarrollo.md#3-tests).
- Faltan tests de `drive/navigation`, `hazards/ahead` y `walk/view`.
- `npm run build` (tipos estrictos + build de Vite).
- Visual: el HUD en simulación a 1080p; nada más que negro y los elementos previstos.
- Repetición de un viaje real como regresión para la calibración.
- Campo: M3 y R0, con un acompañante manejando el teléfono.

## 18. Decisiones y preguntas abiertas

Decidido:

| Tema | Decisión |
|---|---|
| Hardware | El teléfono hace todo y es la cámara; el iPad es solo el HUD reflejado, sin película combinadora |
| Enlace | WebRTC por PeerJS con código de 6 dígitos (no Supabase Realtime) |
| Óptica | Cálculo exacto de la reflexión; el espejo CSS queda de respaldo |
| Calibración | Automática por defecto; un valor puesto a mano gana hasta *Restablecer* |
| Peligros | Detección automática sin preguntar, confirmación de hueco con un toque, agrupación al leer |
| Cuentas | Opcionales; la app funciona sin ellas y sin Supabase |
| Maqueta | Teselas precompiladas y corregibles a mano, nada de consultas en vivo |
| Mercado | Venezuela primero, español |
| Plataformas | PWA para Android e iOS |

Abierto:

1. ¿*Caminar* es para peatones de verdad o para demostrar sin carro? Decide si las rutas a pie son v1.
2. Si la doble imagen del vidrio es inaceptable, ¿película combinadora o solo la AR del teléfono?
3. ¿Broker propio / Supabase Realtime y TURN propio antes de usuarios externos?
4. ¿Volver a poner un aviso de peligro en el HUD (texto que la óptica no voltee) y un botón de reporte manual?
5. Lente: ¿tabla por modelo, medición única, o ambas?
6. Nombre del producto: *MapZ* (interfaz) o *Vía AR* (manifest, textos).
7. ¿Tema claro? ¿Alcabalas como tipo de peligro reportable?

## 19. Supuestos

- El HUD es una pantalla reflejada en el parabrisas desnudo, no óptica a medida.
- La cámara virtual con rumbo de la ruta y calibración automática se mantiene; no hay visión por
  computadora en el camino crítico.
- Los únicos servicios propios son la función `/api/expand` de Vercel y la base de Supabase (opcional).
