# Fuentes de fachadas, techos y alturas: licencias, costos y cobertura (Vía AR / MapZ)

> Lectura de términos y precios publicados (no es asesoría legal). Acompaña a [RESULTADOS.md](RESULTADOS.md).

Investigación del 2026-10-25. Zona de prueba: San Juan Bosco, Altamira (Chacao, Caracas), bbox S 10.5090 · O -66.8540 · N 10.5128 · E -66.8498.
Solo se leyeron páginas públicas y se consultaron APIs sin clave. No se creó ninguna cuenta ni clave.
⚠ = no verificado / inferido.

## Resumen

| # | Fuente | Veredicto | Costo | Motivo principal |
|---|---|---|---|---|
| 1 | Google Photorealistic 3D Tiles | **No usable** | 1.000 gratis/mes, luego USD 6/1.000 | Venezuela no tiene cobertura 3D; además prohíbe caché/offline, "bake" y mezclarlo con mapas no-Google |
| 2 | Google Street View | **No usable** | 100k tiles gratis/mes | Prohíbe descarga masiva, crear contenido a partir de las imágenes y mostrarlas junto a mapas no-Google |
| 3 | Mapillary | **Dudoso / no recomendado** | Gratis (token) | CC BY-SA, pero el ToS prohíbe usarlo con navegación en tiempo real; cobertura no verificable sin token |
| 4 | KartaView | **No aplica** | Gratis | 0 imágenes en el bbox y en 5 km alrededor |
| 5a | Esri World Imagery | **No usable** sin clave · **con condiciones** vía ALP | 2M tiles/mes gratis | Solo visualización en vivo, sin "bake"; excluye apps de consumo cuyo fin principal es navegar ⚠ |
| 5b | Mapbox Satellite | **Con condiciones** (solo en vivo) | 750k raster tiles/mes gratis | Caché ≤30 días en el dispositivo; prohíbe derivar y redistribuir |
| 5c | Google 2D satellite | **No usable** para techos | 100k tiles/mes gratis | Mismas reglas que el punto 1; no se puede usar con nuestro mapa propio |
| 5d | Bing Maps / Azure Maps | **No usable** | Azure: 1.000 transacciones/mes gratis | Bing está retirado; Azure prohíbe la navegación paso a paso y los datos derivados |
| 5e | **OpenAerialMap (Vantor 2026)** | **Usable con condiciones** | Gratis | CC BY-NC 4.0, 0,33–0,42 m, 2026; se permite hornear con atribución, solo uso no comercial |
| 5f | Planet (sismo 2026) | **Usable con condiciones** | Gratis | CC BY-NC 4.0, 0,5–0,87 m |
| 6 | Alturas: Open Buildings 2.5D, 3D-GloBFP, GHSL | **Usable** | Gratis | CC BY 4.0 / ODbL / reutilización con atribución. Overture no trae alturas aquí |

---

## 1. Google Photorealistic 3D Tiles (Map Tiles API): **NO USABLE**

**Precio** (pricing, actualizada 2026-10-23):
- SKU: "Map Tiles API: Photorealistic 3D Tiles" (Enterprise, C6E1-98B2-DBD0).
- Gratis: 1.000 eventos al mes.
- Luego, por cada 1.000: USD 6,00 hasta 100k · 5,10 · 4,20 · 3,30 · 2,40 por encima de 5M.

**Cómo se factura:**
- La página de SKU define el evento como "Request that returns a 3D tile".
- La página de uso dice que la petición *root tileset* cuenta para la cuota diaria (10.000 al día por proyecto) y abre una sesión de hasta 3 h.
- Las peticiones de tiles que hace el renderer son ilimitadas y no cuentan para la cuota. Límite: 12.000 QPM.
- ⚠ Se infiere que 1 evento facturable ≈ 1 petición root (1 sesión). Conviene confirmarlo en la consola.

**Cuenta de facturación:** sí es obligatoria, aunque se use solo el tramo gratis: "you must enable billing on each of your projects". Para el free trial piden "a credit card or other payment method".

**Términos:**
- **Atribución:** logo de Google Maps sin modificar (16–19 dp) y todas las atribuciones de los tiles visibles, agregadas en una línea. El logo del renderer no puede taparlas.
- **Caché:** "must not pre-fetch, index, store, or cache any Content". Solo se permite la caché HTTP según `Cache-Control`/`ETag`. Uso offline prohibido.
- **Extraer o "hornear":** prohibido.
  - ToS §3.2.3(c): "will not create content based on Google Maps Content", por ejemplo "create 3D building models…".
  - Política de Map Tiles: solo usos de visualización, nada de "Geodata extraction". Se pueden superponer objetos 3D propios "as long as the 3D objects aren't extracted, traced, or otherwise derived… from Photorealistic 3D Tiles".
  - Conclusión: no se puede proyectar su textura sobre nuestras huellas ni sacar alturas de sus tiles.
- **Mezcla con datos y mapas no-Google:**
  - ToS §3.2.3(e): "will not use the Google Maps Core Services with or near a non-Google Map". Map Tiles API es un Core Service.
  - Sí se permite superponer datos propios sobre su base, con atribución separada.
  - Conclusión: no se puede combinar con nuestros tiles OSM/maqueta en la misma pantalla.
- **AR y conducción:** no hay cláusula específica de AR.
  - §3.2.3(f) prohíbe el uso en sistemas embebidos en vehículos.
  - §3.2.3(d)(iv) prohíbe recrear la navegación de Google Maps.

**Cobertura:**
- La tabla oficial de cobertura (actualizada 2026-10-23) marca "Map Tiles 2D / 3D" para Venezuela con un solo ⬤, es decir, solo 2D. "Maps JavaScript 3D" aparece como "—".
- Solo 55 países tienen "⬤ / ⬤". Colombia tampoco tiene 3D.
- ⚠ No se probó con una llamada real porque requiere API key. No encontré ninguna lista de Google Earth que muestre 3D en Caracas.

**Venezuela y facturación:**
- Venezuela no está en los "Prohibited Territories" de GMP (China, Crimea, Cuba, DNR, Irán, LNR, Corea del Norte, Siria, Vietnam; última modificación 2022-03-21).
- Tampoco está en la lista de monedas locales de Cloud Billing (2026-10-22). Según esa página, "might incur charges in USD".
- ⚠ No se verificó si Google acepta una tarjeta venezolana. El único documento con la respuesta es la herramienta de métodos de pago de Google.
- Las sanciones de OFAC a Venezuela son selectivas (EO 13884 / 13850, con GL 25 para comunicaciones por Internet), no un embargo total. Página actualizada el 2026-10-16.
- Nota: los términos de Navigation Connect API ya listan a Venezuela como "Country of Concern".
- Bonus: Esri revende "Google Photorealistic 3D Basemap", pero solo para "internal business purposes" (E300, nota 72).

**Fuentes:**
- https://developers.google.com/maps/billing-and-pricing/pricing (2026-10-23)
- https://developers.google.com/maps/billing-and-pricing/sku-details
- https://developers.google.com/maps/documentation/tile/usage-and-billing (2026-10-23; todavía menciona el crédito de USD 200, que está desactualizado)
- https://developers.google.com/maps/documentation/tile/policies (2026-10-23)
- https://developers.google.com/maps/documentation/tile/3d-tiles (2026-10-23)
- https://developers.google.com/maps/coverage (2026-10-23)
- https://cloud.google.com/maps-platform/terms (Last modified 2026-08-26)
- https://cloud.google.com/maps-platform/terms/maps-service-terms (2026-10-15; no tiene sección propia de Map Tiles)
- https://cloud.google.com/maps-platform/terms/maps-services (2026-10-23)
- https://cloud.google.com/maps-platform/terms/maps-prohibited-territories (2022-03-21)
- https://docs.cloud.google.com/billing/docs/resources/currency (2026-10-22)
- https://docs.cloud.google.com/free/docs/free-cloud-features (2026-10-22)
- https://ofac.treasury.gov/sanctions-programs-and-country-information/venezuela-related-sanctions (2026-10-16)

## 2. Google Street View (Static API / Street View Tiles): **NO USABLE** como textura ni para almacenar

Cláusulas del ToS de GMP (2026-08-26):
- **§3.2.3(a):** "will not export, extract, or otherwise scrape Google Maps Content for use outside the Services… (ii) bulk download Google Maps tiles, Street View images…"
- **§3.2.3(b):** no caché.
- **§3.2.3(c):** "will not create content based on Google Maps Content", con el ejemplo "(v) construct an index of tree locations within a city from Street View imagery".
- **§3.2.3(e)(ii):** "display Street View imagery and non-Google Maps on the same screen".

Lo único que se puede guardar es el `pano_id`.

Otras condiciones:
- Hay que mostrar el copyright de cada panorama y el enlace "Report a problem".
- Precio: Street View Tiles, 100k gratis al mes y luego USD 2,00/1.000.
- ⚠ No se verificó si hay cobertura de Street View en Caracas (consultarlo requiere clave).

**Fuentes:**
- https://cloud.google.com/maps-platform/terms
- https://developers.google.com/maps/documentation/streetview/policies (2026-10-23)
- https://developers.google.com/maps/documentation/tile/streetview (2026-10-23)

## 3. Mapillary: **DUDOSO / NO RECOMENDADO** para una app de navegación

**Licencia:**
- "User Content… is subject to the Creative Commons Share Alike (CC BY-SA) license, unless we indicate otherwise" (ToS §3(b), vigente desde 2024-02-15).
- §11 exige además, si se sirven imágenes desde servidores propios, "visibly displaying the Mapillary logo and linking back to the Mapillary homepage or corresponding Mapillary image page".

**Si recortamos y rectificamos fachadas:**
- El resultado es "Adapted Material" de CC BY-SA 4.0. Hay que atribuir (autor/usuario, aviso de licencia, enlace a la imagen) e indicar los cambios.
- Las texturas derivadas deben distribuirse bajo **CC BY-SA 4.0**, sin DRM.
- El código de la app no queda afectado.
- No conviene mezclar esas texturas en un mismo atlas con imágenes NC (por ejemplo las de OAM). Hay que mantenerlas como archivos separados, cada uno con su atribución.
- Está prohibido des-difuminar caras y placas.

**Bloqueante:**
- ToS §5: "Use any Mapillary Services with any products, systems, or applications for or in connection with real-time navigation or route guidance, such as to turn-by-turn route guidance that is synchronized to the position of a sensor-enabled device".
- Vía AR encaja en ese supuesto. ⚠ Requiere consulta legal o permiso de Mapillary/Meta.

**Uso comercial (§12):** solo se permite para "improvement, training, and development of products…" o para prestar servicios a clientes. Hay que tener salvaguardas contra la reidentificación.

**API v4:**
- Siempre hay que autorizar las peticiones: "All requests against https://graph.mapillary.com and https://tiles.mapillary.com must be authorized".
- El client token se obtiene en mapillary.com/dashboard/developers (exige cuenta).
- Límites: Entity 60.000/min, Search 10.000/min, vector tiles 50.000/día.

**Cobertura del bbox: no verificable sin token.**
- Todas las rutas (Graph API y tiles) requieren token.
- La web pública (mapillary.com/app) no renderizó en el navegador embebido.
- Indicio débil: Overpass (OSM 2026-10-25) no tiene ningún objeto con `mapillary=*` dentro del bbox.

**Fuentes:**
- https://www.mapillary.com/terms (Effective 2024-02-15)
- https://www.mapillary.com/developer/api-documentation

## 4. KartaView: **SIN COBERTURA**

**Licencia:** las imágenes están bajo CC BY-SA 4.0 según la wiki de OSM (editada 2024-11-15). Pertenece a Grab desde 2019. ⚠ La página oficial de términos es JS y no se pudo leer.

**Cobertura** (consultas sin clave a `api.kartaview.org`; el endpoint se validó con Bucarest, que sí devuelve fotos):
- v2 `/2.0/photo/?lat&lng&radius=500` en 5 puntos del bbox: **0 fotos**.
- v1 `/1.0/list/nearby-photos/` con radio de 5 km en el centro, en Chacaíto/Las Mercedes y en el centro de Caracas: **0**.
- Panoramax (STAC `api.panoramax.xyz/api/search`, bbox): **0**.

**Fuentes:**
- https://wiki.openstreetmap.org/wiki/KartaView
- https://api.kartaview.org

## 5. Imágenes aéreas para techos

### 5a. Esri World Imagery: **NO USABLE** con el endpoint sin clave · **USABLE CON CONDICIONES** vía ArcGIS Location Platform (ALP) ⚠

**Ítem `10df2279…`** (modificado 2026-10-07):
- "licensed under the Esri Master License Agreement".
- "not intended to be used to export tiles for offline".
- Créditos: "Esri, Vantor, Earthstar Geographics, and the GIS User Community".

**Endpoint sin clave** `services/server.arcgisonline.com/.../World_Imagery/MapServer/tile`: John Foster (Esri), en Esri Community el 2024-12-17, dice: "the service is not free, it can only be used with an ArcGIS Online or ArcGIS Enterprise license… this service is not available for commercial use". Es un foro, no un contrato, pero es coherente con el MLA.

**ALP:**
- Gratis: 2.000.000 tiles al mes, luego USD 0,15/1.000. Alternativa: 1.000 sesiones al mes, luego USD 4/1.000.
- El pay-as-you-go viene desactivado y el servicio se corta al agotar el tramo gratis.
- ⚠ No encontré si piden tarjeta.

**Contrato ALP E204** (rev. 2025-11-21), §3.1.d:
- "only use Resultant Output for visualization purposes".
- "may not scrape, download, or extract Resultant Output, nor cache or store" salvo lo que permitan las cabeceras de caché.
- Una petición sirve a un solo usuario.
- Hay que atribuir.
- §3.1.c.4 prohíbe combinarlo de forma que quede sujeto a licencias "open-database" como ODbL (OSM).
- Conclusión: no se puede hornear.

**Términos de producto E300** (2025-11-13):
- Nota 10: prohíbe la "Programmatic use of session tokens (e.g., exporting volumes of basemap tiles)".
- Nota 5 excluye a "Applications whose purpose is to target consumers for the primary purpose of providing real-time routing and/or navigation". ⚠ Puede excluir a Vía AR; hay que consultarlo con Esri.

**Fuentes:**
- https://www.arcgis.com/home/item.html?id=10df2279f9684e4a9f6a7f08febac2a9
- https://community.esri.com/t5/arcgis-location-platform-developers-ques/inquiry-about-world-imagery/td-p/1569266
- https://location.arcgis.com/pricing/
- https://location.arcgis.com/help
- https://location.arcgis.com/help/account-management
- https://www.esri.com/content/dam/esrisites/en-us/media/legal/platform/platform-legal.pdf
- https://www.esri.com/content/dam/esrisites/en-us/media/legal/product-specific-terms-of-use/e300.pdf

### 5b. Mapbox Satellite: **USABLE CON CONDICIONES** (solo en vivo; no se puede hornear)

Product Terms (Last Updated 2026-10-20):
- **§1.6:** "shall not trace or otherwise derive or extract content". Solo se exceptúa trazar satélite para fines no comerciales o para OSM.
- **§1.9:** no cachear ni almacenar.
- **§2.8.1:** caché "on an End User's device… limited to thirty (30) days", poblada directamente desde la API. No se puede redistribuir por proxy ni como imagen estática.
- **§2.8.2:** no se puede "improve… or otherwise enhance any imagery".
- **§1.4.1 Atribución:** logo de Mapbox, "© Mapbox", "© OpenStreetMap" y lo que indique la documentación.

**Gratis por mes:** Raster Tiles API 750k (luego USD 0,25/1.000), Static Tiles 200k, GL JS 50k cargas.

**Cuenta:** sin tarjeta solo se obtienen "trial usage limits". El free tier completo requiere tarjeta.

⚠ No se verificó la cobertura ni la fecha de la imagen en Caracas.

**Fuentes:**
- https://www.mapbox.com/legal/product-terms (PDF del 2026-10-20)
- https://www.mapbox.com/legal/tos (2024-03-31)
- https://www.mapbox.com/pricing
- https://docs.mapbox.com/accounts/guides/signup/

### 5c. Google 2D satellite tiles (Map Tiles API): **NO USABLE** para texturizar

- **Precio:** SKU "2D Map Tiles" (Essentials). 100k tiles gratis al mes, luego USD 0,60/1.000. La sesión y el viewport no se cobran. Cuota por defecto: 15.000 tiles al día y 6.000/min.
- **Términos:** los mismos del punto 1 (no caché ni offline, no crear contenido, no usar con mapas no-Google). El ToS da como ejemplo prohibido "trace or digitize… building outlines… from… Satellite".
- **Cobertura:** Venezuela sí tiene 2D.
- **Fuentes:** las del punto 1.

### 5d. Bing Maps / Azure Maps: **NO USABLE**

**Bing Maps for Enterprise:**
- Las cuentas Free/Basic dejaron de funcionar el 2025-06-30.
- Las Enterprise funcionan hasta el 2028-06-30 o hasta que termine el contrato.
- Microsoft recomienda migrar a Azure Maps.

**Azure Maps, Microsoft Product Terms** (versión vigente 2026-10-15):
- "may not use Azure Maps… to enable turn-by-turn navigation functionality".
- No se pueden crear "derived database".
- No se pueden mostrar resultados "on any third-party… geographical map database".
- Caché solo para reducir latencia y ≤ min(cabeceras, 6 meses). Prohibido "for the purpose of scaling such Results… to serve multiple users".
- No se permiten derivados.
- Hay que usar la API "Get Map Attribution".

**Precio Gen2:**
- Imagery Tiles: 1.000 transacciones gratis al mes; 1 transacción = 15 tiles.
- ⚠ El precio por encima de eso no aparece en el HTML estático.

**Fuentes:**
- https://blogs.bing.com/maps/2025/1/What-are-my-options-regarding-Bing-Maps-for-Enterprise-Retirement/
- https://learn.microsoft.com/en-us/answers/questions/2288680/is-bing-maps-going-to-be-discontinued
- https://www.microsoft.com/licensing/terms/productoffering/MicrosoftAzure/MCA
- https://azure.microsoft.com/en-us/pricing/details/azure-maps/

### 5e. OpenAerialMap: **USABLE CON CONDICIONES** (mejor candidato para techos)

Consulta `https://api.openaerialmap.org/meta?bbox=-66.854,10.509,-66.8498,10.5128` (2026-10-25): 9 resultados, todos Vantor (ex-Maxar).
- Licencia de cada imagen: **CC BY-NC 4.0**. El catálogo dice "CC-BY 4.0" por defecto, pero manda la licencia de cada imagen.
- Las subió HOT por el **sismo del 24 de junio de 2026** (Caracas y La Guaira).

| Título | Fecha | GSD | ¿Cubre el bbox? |
|---|---|---|---|
| Vantor B110001100BB2210 (WV03) | 2026-06-27 | 0,33 m | completo |
| Vantor WV03 B040001100075510 | 2026-06-26 | 0,34 m | completo |
| Vantor LG01 B110001100BB2210 | 2026-06-25 | 0,35 m | completo |
| Vantor LG05 B15000110186C810 | 2026-06-27 | 0,36 m | completo |
| Vantor LG04 B140001100B5C710 | 2026-06-29 | 0,38 m | ~70% (borde O en -66.8528) |
| Vantor LG05 B150001101015C10 | 2026-03-20 | 0,40 m | completo |
| Vantor LG06 B160001100FD1910 | 2026-03-20 | 0,40 m | apenas toca el borde S |
| Vantor LG04 B140001100B5C810 | 2026-06-29 | 0,41 m | completo |
| Vantor LG04 B1400011000BDF10 | 2026-02-09 | 0,42 m | completo |

- Las huellas son bboxes. Revisé visualmente tiles z17 en el centro (WV03 2026-06-27 y LG04 2026-02-09): son nítidos, sin nubes, y se ven los techos.
- **Servicio de tiles** sin clave: `https://tiles.openaerialmap.org/<id>/{z}/{x}/{y}` (redirige a titiler.hotosm.org). También se pueden descargar los COG.
- **Condiciones:**
  - Solo uso no comercial. Una app gratuita sin fines de lucro encaja; si se monetiza, deja de servir.
  - Atribución: "© Vantor, CC BY-NC 4.0, vía OpenAerialMap".
  - Se permite hornear y adaptar (recortar techos), porque CC BY-NC no lleva SA.
  - Preferir las imágenes de feb./mar. 2026 (pre-sismo) para que no aparezcan escombros.
- **Otra fuente abierta:** Planet Crisis Response, "Venezuela Earthquake 2026-06-24". Son imágenes SkySat/Pelican post-evento del 26 al 28 de junio de 2026, **CC BY-NC 4.0**. Dos escenas de Caracas intersectan el bbox (2026-06-26: GSD 0,87 m, 48% de nubes; 2026-06-27: 0,65 m, 10% de nubes). Hay además un mosaico pre-evento Q1-2026 de ~4,8 m.
- **Sin ortofotos oficiales abiertas:** el editor-layer-index de OSM no tiene ninguna fuente para Venezuela (`sources/south-america` solo tiene ar, br, cl, co, ec, gs, pa, pe, uy).

**Fuentes:**
- https://api.openaerialmap.org/meta?bbox=-66.854,10.509,-66.8498,10.5128
- https://community.openstreetmap.org/t/mapping-to-support-the-venezuela-earthquake-response/144882 (junio 2026)
- https://data.source.coop/planet/disasterdata/venezuela-earthquake-2026-06-24/llms.txt
- https://data.source.coop/planet/venezuela-earthquake-2026-06-24/post-event/collection.json
- https://github.com/osmlab/editor-layer-index/tree/gh-pages/sources/south-america

## 6. Alturas y uso de edificios para un fallback procedural: **USABLE**

**Google Open Buildings 2.5D Temporal: sí cubre Venezuela** ("VEN Venezuela" en su lista de países).
- Datos anuales 2016–2023, resolución efectiva ~4 m (rásters a 0,5 m).
- Bandas: `building_height` (0–100 m), `building_presence` y `building_fractional_count`.
- El MAE de altura es de 1,5 m, pero solo se evaluó en el Norte global. ⚠ La precisión en Caracas es desconocida.
- Licencia: **CC BY 4.0 u ODbL**, a elección.
- Acceso: Earth Engine (requiere registro) o rásters en GCS mediante Colab.

**Overture Maps** (release `2026-10-21.0`, S3 anónimo `overturemaps-us-west-2`):
- 349 edificios en el bbox: 244 de Google Open Buildings, 86 de Microsoft y 19 de OSM.
- Ninguno trae `height`, `num_floors` ni `class`.
- Los 244 de Google Open Buildings son huellas que nuestra maqueta hoy no tiene.

**OSM** (Overpass, 2026-10-25):
- En el bbox hay 19 edificios, todos `building=yes`, sin `height` ni `levels`.
- En toda la zona de la maqueta, 96 de 620 edificios OSM sí traen altura o niveles.

**Microsoft:** en `public/maqueta` los 1.229 edificios MS tienen la altura por defecto de 9 m, porque MS no trae altura aquí.

**Otras fuentes abiertas:**
- **3D-GloBFP** (2020): huellas con altura estimada. Licencia **CC BY 4.0** (Zenodo 10.5281/zenodo.15487037; figshare publicado el 2025-12-11). Cubre Venezuela; Caracas está en el archivo `415_-67.5_10.0_-65.0_12.5_VE.zip` (146,9 MB). RMSE de 1,9 a 14,6 m.
- **GHS-BUILT-C R2023A** (JRC): 10 m, año 2018. Clasifica **residencial / no residencial × 5 rangos de altura** (≤3, 3–6, 6–15, 15–30, >30 m). Sirve para el *uso* del edificio. "Reuse is authorised, provided the source is acknowledged."
- **GHS-BUILT-H R2023A**: altura media en celdas de 100 m, año 2018. Misma licencia.
- **GlobalBuildingAtlas (GBA.LoD1)**: modelos LoD1 globales con altura (RMSE 1,5–8,9 m). Licencia **CC BY-NC 4.0** (según su README en Hugging Face).
- ⚠ Para el uso comercial/residencial también podría servir Overture *places* (POIs), pero no lo verifiqué en el bbox.

**Fuentes:**
- https://sites.research.google/gr/open-buildings/temporal/
- https://developers.google.com/earth-engine/datasets/catalog/GOOGLE_Research_open-buildings-temporal_v1
- https://overturemaps-us-west-2.s3.amazonaws.com/?prefix=release/2026-10-21.0/
- https://zenodo.org/records/15487037
- https://figshare.com/articles/dataset/3D-GloBFP_the_first_global_three-dimensional_building_footprint_dataset_PART_grid_ID_0-400_/28879733
- https://developers.google.com/earth-engine/datasets/catalog/JRC_GHSL_P2023A_GHS_BUILT_C
- https://developers.google.com/earth-engine/datasets/catalog/JRC_GHSL_P2023A_GHS_BUILT_H
- https://huggingface.co/datasets/vitrobot/GBA.LoD1/blob/main/README.md
- https://essd.copernicus.org/articles/17/6647/2025/

## Recomendación práctica

- **Techos:** hornear texturas desde OAM, usando Vantor LG04 2026-02-09 o LG05 2026-03-20 (pre-sismo, ~0,4 m) o WV03 2026-06-27 (0,33 m). Mantener la app no comercial y mostrar la atribución "© Vantor (CC BY-NC 4.0) vía OpenAerialMap".
- **Fachadas:** no hay ninguna fuente fotográfica viable y verificada. Lo recomendable es generarlas de forma procedural: altura de Open Buildings 2.5D / 3D-GloBFP y uso + rango de altura de GHS-BUILT-C.
- **Mapillary:** usarlo solo si se resuelve la cláusula de navegación. En ese caso, publicar las texturas derivadas como CC BY-SA 4.0, en archivos separados de las de OAM.
- **Huellas:** se pueden sumar las 244 de Google Open Buildings que vienen en Overture.
