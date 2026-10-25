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

```bash
npm run maqueta -- los-palos-grandes                    # construye (o rehace) todas las teselas de la zona
npm run maqueta -- los-palos-grandes --solo-faltantes   # conserva las que ya existen y hace el resto
npm run maqueta:check                                   # revisa todas las teselas (o: -- <zona> [<zona>…])
```

- Recibe una zona de `scripts/maqueta/zones.json` (nombre, `label` y caja de coordenadas) y calcula qué teselas la cubren. Las cajas de Chacao están alineadas a las teselas y metidas ~1 m hacia adentro, para que cada zona caiga en sus teselas exactas y no toque las vecinas.
- `--solo-faltantes` sirve para registrar en `index.json` una zona cuyas teselas ya hizo otra persona (así se registraron `altamira-norte` y `altamira-sur` de Andrés sin reconstruirlas) y para reintentar una tesela que falló.
- Los archivos de Microsoft (índice de 7 MB y 9,6 MB del quadkey de Caracas) se bajan una vez y quedan en `scripts/maqueta/.cache/`, que git ignora. Para refrescarlos, se borra esa carpeta.
- Si Overpass u Open-Meteo responden 429/5xx o no contestan, reintenta a los 10, 30 y 60 s.
- Por cada tesela:
  - Hace una consulta a Overpass con los nodos de señales y las vías `highway` con sus tags.
  - Hace dos consultas a `api.open-meteo.com/v1/elevation` para los 169 puntos de la rejilla (máximo 100 puntos por consulta).
  - Suaviza la elevación con un promedio 3×3, porque el modelo de 90 m incluye ruido de edificios.
- Mezcla lo que haya en `scripts/maqueta/overrides/{x}_{y}.json`: señales verificadas o agregadas a mano, señales marcadas como falsas y alturas corregidas. Las correcciones manuales siempre ganan sobre OSM.
- Descarta las huellas de Microsoft que una calle con nombre atraviesa (6 m o más de su eje adentro; no cuentan distribuidores, elevados, túneles, puentes, rampas ni la autopista). Revisadas sobre el mapa, todas eran duplicados corridos de un edificio de OSM o manchas encima de la calle. Los edificios de OSM nunca se descartan.
- Informa por tesela cuántos edificios están en OSM y en Microsoft a la vez y cuánto se desfasan (ver "Coordenadas" abajo).
- Escribe la tesela y actualiza `index.json` (con el `label` de la zona, que Destino muestra).
- Espera entre consultas para no saturar los servidores públicos.

### Revisión de las teselas (`npm run maqueta:check`)

`scripts/maqueta/check.ts`, con la lógica en `quality.ts` (probada en `tests/run.ts`). Imprime una tabla por tesela: semáforos, pares, ceda, pasos, policías y fotomultas; vías, con nombre, con `maxspeed` y con `lanes`; edificios por fuente y con nombre; rango de altura y pendiente máxima de la rejilla. Después marca:

- **Errores** (salida con código 1): rejilla rota o alturas fuera de rango, tesela sin vías, señales o edificios cuyo centro cae fuera de la tesela, contornos abiertos, ids repetidos, el mismo edificio en dos teselas (mismo id o huellas que se solapan más de 50 %), zonas cuya caja toca teselas que no son suyas.
- **Avisos**: sin edificios o sin señales, pendiente de la rejilla mayor a 35 %, edificios atravesados por una calle.

### En la app

- **`core/maqueta.ts`**:
  - matemática de teselas (lat/lon a x/y, z16);
  - carga de las teselas que toca la ruta, con caché en memoria;
  - `elevationAt(p)` con interpolación bilineal, que devuelve `null` si no hay tesela;
  - `routeProfile(route)`: un `Float32Array` con la elevación cada 5 m de la ruta, calculado una vez al cargarla, con `elevAlong(d)` sin crear objetos por cuadro. Si la ruta sale de la maqueta y vuelve a entrar, el tramo sin teselas va en línea recta de una altura a la otra (antes mantenía la primera y daba un escalón de varios metros al volver a entrar).
  - `zoneFor(zones, p)`: la zona de un punto; donde se solapan (San Juan Bosco dentro de Altamira norte), gana la más chica.
- **Destino** (`ui/destino.ts`): pinta la cobertura de la maqueta, no un marco por zona: las teselas teñidas una sola vez y una línea punteada por el borde de afuera (`coverageEdges`). Los policías acostados de la maqueta se cargan solo de las teselas a la vista desde zoom 14,5 (`tilesInBox`), con la misma caché que la ruta y la pantalla Maqueta; antes bajaba todas las teselas de todas las zonas al abrir el mapa.
- **Pantalla Maqueta** (`ui/maqueta.ts`): todos los edificios de la zona van en una sola malla (una llamada de dibujo) armada directo de los contornos, y el color de cada cara (techo, lado izquierdo, lado derecho y la versión azul del elegido) lo calcula un shader con la normal de la cara y la derecha de la cámara. Con Altamira norte (1.027 edificios), en escritorio, abrir pasó de ~1,1 s a ~0,25 s, desplazarse de 3,5 a 0,6 ms por cuadro y girar de 14 a 1,3 ms por cuadro. Antes cada giro repintaba los vértices de todos los edificios en la CPU, y `toNonIndexed` escribía un aviso por edificio en la consola.
- **`render/ar.ts`**: `FrameInput` recibe `elevAlong?` y el renderer usa `elevAlong(d) - elevAlong(along)` como altura en la cinta, los chevrones, el aro y la flecha de giro y los marcadores. Sin perfil, se queda en `0.02` como hoy. Hay que mantener los buffers preasignados.
- **`signs/`**, nuevo módulo paralelo a `hazards/`:
  - `store.ts` carga las señales de las teselas;
  - `ahead.ts` copia la lógica de `hazards/ahead.ts`: proyecta cada señal sobre la ruta, la descarta si está a más de 15 m y la filtra por sentido cuando trae `dir`;
  - un pool de objetos 3D en el renderer: un octágono PARE de pie, un semáforo y rayas de paso peatonal sobre el asfalto;
  - los policías acostados de OSM entran por la ruta que ya existe de hazards, con `source: 'osm'`, que es el TODO de importarlos.
- **HUD**: el límite de velocidad de la vía donde va el carro, emparejando `along` con `ways` por cercanía y rumbo.

## Zonas de Chacao

El municipio (relación OSM 3335672) va desde el Guaire hasta la cumbre del Ávila. La parte con calles cabe en las teselas x 20595–20600, y 30843–30848; al norte de la Cota Mil es montaña. Hay 28 teselas (2,1 MB, 5.333 edificios, 937 señales) en 11 zonas. Cada zona es un rectángulo de teselas enteras, sin solaparse con las demás (salvo San Juan Bosco, que está dentro de Altamira norte).

| Zona | Teselas | En Chacao | Edificios (OSM / MS) | Señales (semáforos, policías) | Vías |
|---|---|---|---|---|---|
| `san-juan-bosco` Av. San Juan Bosco, Altamira · `10.509, -66.854, 10.5128, -66.8498` | 20597–20598 × 30843–30844 | 100 % | 195 dentro de la caja | — | — |
| `altamira-norte` Altamira norte y Av. Boyacá · `10.504026, -66.85729, 10.514808, -66.846323` | 20597–20598 × 30843–30844 (de Andrés) | 100 % | 1.027 (186 / 841) | 113 (9, 17) | 146 |
| `altamira-sur` Altamira sur, La Castellana y Chacao · `10.493223, -66.85729, 10.504006, -66.846323` | 20597–20598 × 30845–30846 (de Andrés) | 100 % | 815 (434 / 381) | 295 (35, 10) | 387 |
| `los-palos-grandes` Los Palos Grandes · `10.493223, -66.846303, 10.514808, -66.84083` | 20599 × 30843–30846 | 88 % | 895 (281 / 614) | 157 (13, 25) | 226 |
| `bello-campo` Bello Campo, Estado Leal y Av. Libertador · `10.487822, -66.85729, 10.493203, -66.846323` | 20597–20598 × 30847 | 100 % | 388 (316 / 72) | 66 (11, 3) | 167 |
| `la-castellana-oeste` La Castellana oeste, El Pedregal y San Marino · `10.493223, -66.862783, 10.514808, -66.85731` | 20596 × 30843–30846 | 96 % | 875 (99 / 776) | 77 (3, 14) | 201 |
| `el-rosal` El Rosal y El Retiro · `10.487822, -66.868276, 10.493203, -66.85731` | 20595–20596 × 30847 | 100 % | 268 (135 / 133) | 139 (29, 3) | 180 |
| `country-club` Country Club y El Bosque · `10.493223, -66.868276, 10.504006, -66.862803` | 20595 × 30845–30846 | 88 % | 208 (39 / 169) | 27 (3, 5) | 53 |
| `la-floresta` La Floresta · `10.487822, -66.846303, 10.493203, -66.84083` | 20599 × 30847 | 65 % | 211 (189 / 22) | 7 (0, 4) | 31 |
| `el-ciempies` Distribuidor El Ciempiés y el Guaire · `10.48242, -66.862783, 10.487802, -66.846323` | 20596–20598 × 30848 | 76 % | 220 (126 / 94) | 45 (1, 3) | 250 |
| `los-palos-grandes-este` Los Palos Grandes este · `10.504026, -66.84081, 10.514808, -66.835337` | 20600 × 30843–30844 | 36 % | 426 (3 / 423) | 11 (0, 8) | 64 |

"En Chacao" es la parte de la caja dentro del límite de OSM; el resto es Sebucán y Santa Eduvigis (Sucre) o Las Mercedes (Baruta), que igual sirve para rutas que cruzan el borde.

**Falta de Chacao** (bordes con poco municipio adentro): 20594 × 30846–30847 (Chacaíto y El Bosque oeste, 27 % y 26 %), 20595/30844 (25 %), 20595/30848 (20 %, Las Mercedes) y 20599/30848 (37 %, La Floresta sur). Al norte, de 30836 a 30842, es el Ávila: sin calles, solo caminos.

### Cómo se verificó cada zona (2026-10-25)

Por cada zona se repitió el mismo ciclo: construir, revisar, confirmar coordenadas, verla en la app y corregir.

1. **Límite.** Se comparó la caja con el polígono de Chacao de OSM (la columna "En Chacao").
2. **Contenido.** `npm run maqueta:check` termina sin errores en las 28 teselas: ninguna vacía y ningún edificio repetido entre teselas. El único repetido que apareció (una huella de Microsoft de 20597/30846, de Andrés, encima de un edificio de OSM de la tesela nueva 20597/30847) era además una de las 7 huellas viejas que una calle atraviesa. Esas 7 se ocultan en `overrides/20597_30846.jsonc`, `20598_30845.jsonc` y `20598_30846.jsonc`, y se quitaron de esas teselas aplicando los mismos overrides; no se tocó nada más de esas teselas. Queda un aviso aceptado: `osm:w153833757` (El Rosal) tiene 20 m de calle adentro. Es de OSM, probablemente un pasaje bajo el edificio, y se deja.
3. **Coordenadas.** Las huellas de Microsoft quedan entre 1 y 3 m al noreste de los edificios de OSM. Se midió con los pares de edificios que están en ambas fuentes (mediana por tesela, 10–117 pares) y, por separado, con la distancia de los edificios a las calles de OSM de cada lado, que da unos 2 m hacia el norte. En Los Palos Grandes llega a ~4,5 m. Sobre el mapa base, los bloques de casas calzan con las manzanas y no pisan las calles. La diferencia viene de torres altas, cuyo techo se ve corrido en la foto aérea. Por eso no se corrigió con un corrimiento fijo, que empeoraría las casas bajas: es menos que el error del GPS y menos que un canal. Donde ambas fuentes tienen el edificio, gana OSM, que es el mismo marco de las calles, la ruta y el mapa base.
4. **En la app** (navegador del escritorio, con pantalla de escritorio y de teléfono):
   - En Destino, la cobertura se pinta con un solo borde, la etiqueta dice "Zona de la maqueta · Los Palos Grandes" y en San Juan Bosco gana esa zona sobre Altamira norte.
   - La pantalla Maqueta se probó en Altamira norte (1.027 edificios), Los Palos Grandes (895) y El Rosal (268, en tamaño teléfono). Las letras A–E, el toque para elegir otro edificio, el giro con su sombreado y la entrada "Frente al edificio" funcionan. En El Rosal sale el nombre de OSM: "Centro Empresarial Galipán".
   - Se manejó en Simulación por la 4.ª Avenida de Los Palos Grandes. La calle 3D sube con la cuesta, la cinta y los chevrones la siguen, el HUD muestra 40 y aparece la flecha de giro en la 7.ª Transversal.
5. **Recorridos simulados** con rutas reales de OSRM y el mismo código de la app (perfil, límites y señales sobre la ruta):

   | Recorrido | Altura | Pendiente máx. | Límite conocido | Sobre la ruta |
   |---|---|---|---|---|
   | 4.ª Av. de Los Palos Grandes, de la Francisco de Miranda hacia el norte | 879–944 m | 12,6 % | 100 % (40) | 15 pasos, 1 semáforo, 1 pare, 2 policías |
   | Bello Campo, de este a oeste | 860–878 m | 6,2 % | 80 % (30–60) | 31 pasos, 8 semáforos, 3 ceda |
   | La Castellana oeste, hacia el norte | 888–953 m | 9,2 % | 100 % (30–50) | 11 pasos, 1 semáforo, 1 pare |
   | El Rosal | 857–873 m | 4,5 % | 93 % (20–60) | 28 pasos, 7 semáforos, 1 pare |
   | Country Club | 894–919 m | 6,8 % | 100 % (40) | 2 pasos, 1 semáforo, 1 policía |
   | La Floresta | 857–870 m | 5,2 % | 0 % | — (OSM no tiene `maxspeed` ni señales ahí) |
   | El Ciempiés | 846–874 m | 6,1 % | 84 % (30–60) | 13 pasos, 6 semáforos, 3 ceda, 2 pare |
   | Los Palos Grandes este, subiendo a la Boyacá | 930–980 m | 21,7 % | 95 % (30) | 2 policías |

   El de El Rosal daba 26 % antes de arreglar `routeProfile`, porque la ruta salía de la maqueta y volvía a entrar.

**Límites conocidos.** En la franja de la Cota Mil (teselas y 30843), la rejilla tiene pendientes del 60–70 %: el modelo de 90 m mezcla el cerro con la vía, y un recorrido por ahí puede marcar hasta ~20 % en tramos cortos. Las huellas de Microsoft no traen altura, así que casi todo mide 9 m. La Floresta no tiene límites de velocidad en OSM.

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
2. **Una zona: Altamira y Los Palos Grandes.** Mismo script con una caja más grande. *Hecho en datos: ver "Zonas de Chacao". Falta una prueba de manejo real grabada con el recorder, y la repetición como fixture de regresión.*
3. **Carriles.** Ancho de la cinta y `lateral` por tramo según `lanes` y `oneway`. Guía de carril antes de un giro cuando hay `turn:lanes`.
4. **Edificios y simulador.** *Hecho: huellas en las teselas, pantalla Maqueta para elegir edificio y entrada, la entrada de destino marcada en la AR y el HUD al llegar (aura, pin y tarjeta; ver SPEC.md §6.3–6.4), y en Simulación la calle en 3D detrás de la cinta (`render/scenery.ts`). Falta: nombres y entradas medidas en los overrides, y la malla que oculta la flecha detrás de las esquinas.*
   - Huellas de edificios (Microsoft Global ML Building Footprints) con alturas estimadas y corregibles en `overrides`.
   - En la app se usan como malla invisible que solo escribe profundidad, para que la flecha de giro quede oculta detrás de las esquinas.
   - En Simulación sirven de fondo 3D en lugar de la cámara: relieve, calles y edificios vistos desde el asiento, siempre que el carro esté dentro de una tesela; fuera de ellas se ve la cámara como antes. No aplica al HUD del parabrisas.
5. **Más zonas.** Chacao completo, después el resto. *Chacao con calles: hecho (28 teselas, ver "Zonas de Chacao" y lo que falta en sus bordes).* Las señales reportadas por la gente pueden alimentar los `overrides` desde Supabase, igual que los huecos.

## Reglas

- No tocar `core/` sin avisar al equipo (ver `SPEC.md`). `core/maqueta.ts` es nuevo y no cambia nada existente.
- Sin dependencias nuevas para la maqueta (la pantalla Maqueta usa Three.js, que ya estaba; MapLibre es solo del mapa de Destino). El script puede usar solo `fetch` de Node.
- Ninguna consulta a Overpass ni a Open-Meteo desde la app. Todo sale de `public/maqueta/`.
- Los ejes son los de `core/geo.ts`: x este, z sur, y arriba.
- `npm test` y `npm run build` tienen que pasar en cada fase.
