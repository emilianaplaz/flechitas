# Prueba de render: calle en 3D desde un video del teléfono

Primer modelo 3D de una calle de Caracas, hecho el 24 oct 2026 con un video de 97 s grabado caminando
(832×464, reenviado por WhatsApp), procesado en un laptop sin tarjeta NVIDIA con COLMAP y OpenMVS.
Cómo se hizo, paso a paso: [pipeline3d/README.md](../pipeline3d/README.md).

## Cómo abrirlo

Necesita un servidor local (el navegador no carga el modelo abriendo el archivo directamente):

```bash
python -m http.server 8000 -d "PRUEBA RENDER"
```

y abre <http://localhost:8000>. Carga Three.js desde jsDelivr, así que necesita internet.

- **Calle**: 98 paradas a lo largo de ~76 m (escala estimada, sin GPS). En cada parada se ve la foto
  real donde se tomó y el modelo 3D alrededor. Arrastra para mirar, clic en la calle o ↑ ↓ para
  caminar, rueda para acercar. *Foto real* apagado muestra solo el modelo.
- **Vista aérea**: el modelo completo.
- **Panorama**: el paneo del segundo video (~130°).

## Qué hay

| Archivo | Qué es | Tamaño |
|---|---|---|
| `street.glb` | Malla 3D (214 k vértices, 428 k caras) | 12 MB |
| `street_noseam_0.png` | Su textura (va siempre junto al `.glb`) | 17 MB |
| `frames/` | 98 fotos reales, una por parada | 19 MB |
| `nodes.json` | Posición, dirección y foto de cada parada | 27 KB |
| `pano.jpg`, `pano.json` | Panorama | 0.2 MB |
| `index.html`, `main.js`, `style.css` | Visor | 21 KB |

## Límites de esta prueba

- Huecos donde ninguna foto miró (sobre todo la acera de enfrente y la parte alta de las paredes),
  bordes irregulares y carros que se movieron, manchados: el video es de baja resolución y casi todo
  mira hacia un lado.
- Escala y ubicación aproximadas: no hubo GPS; la escala supone el teléfono a 1.5 m del piso.
- Con el video original en 4K, las dos aceras y el GPS del grabador de la app, el mismo proceso da un
  modelo mucho más completo y ubicado en el mapa (`pipeline3d/README.md`).
