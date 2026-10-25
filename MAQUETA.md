# Maqueta: datos del mapa para el overlay

Estado: plan v0.1 · Complementa a `SPEC.md`. Rama sugerida: `maqueta`, a partir de `emi`.

## Para qué

Hoy el overlay se ubica con GPS, la línea de la ruta de OSRM y la calibración manual, y todo se dibuja como si la calle fuera plana (`y = 0.02` en `render/ar.ts`). La maqueta es una capa propia de datos del mapa que la app carga junto con la ruta, y que da tres cosas que hoy faltan:

- **Relieve.** En Caracas la pendiente cambia todo. En la Av. San Juan Bosco (Altamira) la pendiente ronda el 13 %, y a 50 m del carro la calle está unos 6,5 m más arriba. Con la calibración por defecto (fov 40°, 1080 px), la cinta queda unos 200 px por debajo de la calle real.
- **Señales.** Semáforos, pares, ceda el paso, pasos peatonales, policías acostados y fotomultas salen de OpenStreetMap. Solo en Chacao/Altamira (2×2 km) hay 67 semáforos, 79 pares, 79 policías acostados y unos 470 pasos peatonales.
- **Carriles y límites.** OSM trae `lanes` en el 89 % de las calles de esa zona, `maxspeed` en el 78 % y `turn:lanes` en el 35 %.

La idea es crecer por escala: primero una calle, después una zona y luego más zonas, hasta completar una ciudad. Por eso la maqueta se precompila en teselas estáticas, no se consulta en vivo. Así no se depende de servidores públicos con límite de uso y se pueden guardar correcciones hechas a mano que no se pierden al regenerar.

## Cómo está armada

### Teselas

- Rejilla estándar de mapas web en zoom 16. Cada tesela mide unos 600 × 600 m en Caracas.
- Ruta del archivo: `public/maqueta/16/{x}/{y}.json`.
- `public/maqueta/index.json` lista las teselas disponibles y las zonas que cubren, para saber qué partes de la ciudad ya están hechas.
- Si una ruta pasa por una zona sin tesela, la app se comporta exactamente como hoy: calle plana y sin señales. Nada se rompe donde no hay maqueta.

Contenido de cada tesela:

```jsonc
{
  "v": 1,
  "tile": [16, 20597, 30843],
  "built": "2026-10-24T00:00:00Z",
  "sources": ["OpenStreetMap", "Copernicus DEM 90 m (Open-Meteo)"],
  "elev": { "rows": 13, "cols": 13, "z": [/* metros, de norte a sur y de oeste a este, cubriendo el borde de la tesela */] },
  "signs": [{ "id": "osm:n123", "type": "traffic_signals", "lat": 10.51, "lon": -66.85, "dir": null, "verified": false }],
  "ways": [{ "id": "osm:w456", "name": "Avenida San Juan Bosco", "oneway": true, "lanes": 2, "maxspeed": 30, "turnLanes": null, "pts": [[10.51, -66.85]] }],
  "buildings": [{ "id": "ms:10.510790,-66.852097", "name": null, "height": 9, "levels": null, "source": "ms", "outline": [[10.5107, -66.8521]], "entrances": [] }]
}
```

`buildings` (opcional en teselas viejas): huellas de OSM `building=*` y de Microsoft Global ML Building Footprints, sin duplicados (si se solapan más de 50 %, gana OSM). Cada edificio va completo en la tesela que contiene su centro. Altura: `height` de OSM, si no `building:levels` × 3 m, si no 9 m. Los de Microsoft se identifican por su centro, así los overrides los encuentran después de reconstruir. En San Juan Bosco hay 1.027 en las 4 teselas (195 dentro de la zona), ninguno con nombre ni entradas todavía.

Nombres, alturas y entradas van a mano en `scripts/maqueta/overrides/{x}_{y}.json` (o `.jsonc` con comentarios); hay una plantilla sin aplicar en `overrides/ejemplo_20597_30843.jsonc`:

```jsonc
{ "buildings": [{ "id": "ms:10.510790,-66.852097", "name": "Torre B", "height": 24, "entrances": [{ "name": "Entrada 2", "lat": 10.51075, "lon": -66.85215 }] }] }
```

Sin entradas, la app propone una sola, **Frente al edificio**: el medio de la fachada que da a la calle más cercana (`entrancesOf` en `core/maqueta.ts`).

Los tipos de `signs` son: `traffic_signals`, `stop`, `give_way`, `crossing`, `bump`, `hump`, `table` y `speed_camera`. `dir` se llena con `direction`, `traffic_signals:direction` o `forward/backward` cuando OSM lo trae.

### Script que genera las teselas

`scripts/maqueta/build.ts`, ejecutado con `node --experimental-strip-types`, como los tests.

- Recibe una zona de `scripts/maqueta/zones.json` (nombre y caja de coordenadas) y calcula qué teselas la cubren.
- Por cada tesela:
  - Hace una consulta a Overpass con los nodos de señales y las vías `highway` con sus tags.
  - Hace dos consultas a `api.open-meteo.com/v1/elevation` para los 169 puntos de la rejilla (máximo 100 puntos por consulta).
  - Suaviza la elevación con un promedio 3×3, porque el modelo de 90 m incluye ruido de edificios.
- Mezcla lo que haya en `scripts/maqueta/overrides/{x}_{y}.json`: señales verificadas o agregadas a mano, señales marcadas como falsas y alturas corregidas. Las correcciones manuales siempre ganan sobre OSM.
- Escribe la tesela y actualiza `index.json`.
- Espera entre consultas para no saturar los servidores públicos.

### En la app

- **`core/maqueta.ts`**:
  - matemática de teselas (lat/lon a x/y, z16);
  - carga de las teselas que toca la ruta, con caché en memoria;
  - `elevationAt(p)` con interpolación bilineal, que devuelve `null` si no hay tesela;
  - `routeProfile(route)`: un `Float32Array` con la elevación cada 5 m de la ruta, calculado una vez al cargarla, con `elevAlong(d)` sin crear objetos por cuadro.
- **`render/ar.ts`**: `FrameInput` recibe `elevAlong?` y el renderer usa `elevAlong(d) - elevAlong(along)` como altura en la cinta, los chevrones, el aro y la flecha de giro y los marcadores. Sin perfil, se queda en `0.02` como hoy. Hay que mantener los buffers preasignados.
- **`signs/`**, nuevo módulo paralelo a `hazards/`:
  - `store.ts` carga las señales de las teselas;
  - `ahead.ts` copia la lógica de `hazards/ahead.ts`: proyecta cada señal sobre la ruta, la descarta si está a más de 15 m y la filtra por sentido cuando trae `dir`;
  - un pool de objetos 3D en el renderer: un octágono PARE de pie, un semáforo y rayas de paso peatonal sobre el asfalto;
  - los policías acostados de OSM entran por la ruta que ya existe de hazards, con `source: 'osm'`, que es el TODO de importarlos.
- **HUD**: el límite de velocidad de la vía donde va el carro, emparejando `along` con `ways` por cercanía y rumbo.

## Fases

1. **Una calle: Av. San Juan Bosco, Altamira.**
   - Zona `san-juan-bosco` con caja `10.5090, -66.8540, 10.5128, -66.8498` (4 teselas: x 20597–20598, y 30843–30844).
   - El tramo de prueba va desde la 9.ª Transversal (`10.51031, -66.85181`) hasta `10.51136, -66.85200`, unos 119 m hacia el norte.
   - Hecho cuando:
     - en Simulación, con una ruta que sube por San Juan Bosco, la cinta sigue la pendiente: se compara una captura con y sin perfil;
     - las señales del tramo aparecen en su sitio;
     - el HUD muestra "30";
     - fuera de la zona todo funciona como antes;
     - hay tests nuevos en `tests/run.ts` para la matemática de teselas, la interpolación, `routeProfile` con una pendiente sintética del 13 % y el filtro de sentido de señales.
2. **Una zona: Altamira y Los Palos Grandes.** Mismo script con una caja más grande. Una prueba de manejo real grabada con el recorder, y la repetición como fixture de regresión.
3. **Carriles.** Ancho de la cinta y `lateral` por tramo según `lanes` y `oneway`. Guía de carril antes de un giro cuando hay `turn:lanes`.
4. **Edificios y simulador.** *Hecho: huellas en las teselas, pantalla Maqueta para elegir edificio y entrada, la entrada de destino marcada en la AR y el HUD al llegar (aura, pin y tarjeta; ver SPEC.md §6.3–6.4), y en Simulación la calle en 3D detrás de la cinta (`render/scenery.ts`). Falta: nombres y entradas medidas en los overrides, y la malla que oculta la flecha detrás de las esquinas.*
   - Huellas de edificios (Microsoft Global ML Building Footprints) con alturas estimadas y corregibles en `overrides`.
   - En la app se usan como malla invisible que solo escribe profundidad, para que la flecha de giro quede oculta detrás de las esquinas.
   - En Simulación sirven de fondo 3D en lugar de la cámara: relieve, calles y edificios vistos desde el asiento, siempre que el carro esté dentro de una tesela; fuera de ellas se ve la cámara como antes. No aplica al HUD del parabrisas.
5. **Más zonas.** Chacao completo, después el resto. Las señales reportadas por la gente pueden alimentar los `overrides` desde Supabase, igual que los huecos.

## Reglas

- No tocar `core/` sin avisar al equipo (ver `SPEC.md`). `core/maqueta.ts` es nuevo y no cambia nada existente.
- Sin dependencias nuevas para la maqueta (la pantalla Maqueta usa Three.js, que ya estaba; MapLibre es solo del mapa de Destino). El script puede usar solo `fetch` de Node.
- Ninguna consulta a Overpass ni a Open-Meteo desde la app. Todo sale de `public/maqueta/`.
- Los ejes son los de `core/geo.ts`: x este, z sur, y arriba.
- `npm test` y `npm run build` tienen que pasar en cada fase.
