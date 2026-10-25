// Imagen aérea para techos y suelo: un mosaico de teselas XYZ de la caja de la zona en un canvas,
// que el material de fachadas usa en los techos (y un plano en el suelo). La fuente se elige con
// VITE_AEREA_URL; ver RESULTADOS.md para qué fuentes se pueden usar en la app y con qué condiciones.
import * as THREE from 'three';
import { tileToLatLon, tileXY } from '../../../src/core/maqueta.ts';
import type { Zona } from './zona.ts';

export interface FuenteAerea {
  nombre: string;
  url: string; // {z} {x} {y}
  zoom: number;
  atribucion: string;
}

/**
 * Teselas de una imagen de OpenAerialMap. tiles.openaerialmap.org/<id>/{z}/{x}/{y} redirige al TiTiler
 * de HOT, pero la redirección no trae CORS y el navegador la bloquea: se pide directo al TiTiler.
 * Para la app no se usaría en vivo: se baja el COG una vez y se hornea en nuestras teselas.
 */
const oam = (id: string) => `https://titiler.hotosm.org/cog/tiles/WebMercatorQuad/{z}/{x}/{y}@1x?url=https://oin-hotosm-temp.s3.us-east-1.amazonaws.com/${id}.tif`;

export const FUENTES_AEREAS: Record<string, FuenteAerea> = {
  // OpenAerialMap: imágenes Vantor subidas por HOT, CC BY-NC 4.0. Se pueden hornear (sin SA) mientras
  // la app no sea comercial. Antes del sismo de junio de 2026: la de febrero o la de marzo.
  oam: {
    nombre: 'OpenAerialMap · Vantor LG04, 9 feb 2026, 0,42 m',
    url: oam('6a3db16ead92c093ebc2ca73/0/6a3db16ead92c093ebc2ca74'),
    zoom: 19,
    atribucion: '© Vantor, CC BY-NC 4.0, vía OpenAerialMap',
  },
  'oam-033': {
    nombre: 'OpenAerialMap · Vantor WV03, 27 jun 2026, 0,33 m',
    url: oam('6a416d99b27aa6a12ba65ff6/0/6a416d99b27aa6a12ba65ff7'),
    zoom: 19,
    atribucion: '© Vantor, CC BY-NC 4.0, vía OpenAerialMap',
  },
  esri: {
    nombre: 'Esri World Imagery (solo evaluación)',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    zoom: 19,
    atribucion: 'Imagen: Esri, Vantor, Earthstar Geographics y la comunidad GIS',
  },
};

export interface Aerea {
  textura: THREE.CanvasTexture;
  rect: THREE.Vector4; // x0, z0 (esquina noroeste), ancho, fondo, en metros locales
  suelo: THREE.Mesh;
  bytes: number;
  teselas: number;
  fallidas: number;
  ms: number;
  px: string;
  fuente: FuenteAerea;
}

/**
 * Cuánto está corrida la imagen respecto de nuestras huellas: se desliza el contorno de todas las
 * huellas sobre el mapa de bordes de la imagen (Sobel) y gana el corrimiento con más borde debajo.
 * Devuelve dx, dz en metros (dónde aparece en la imagen lo que en la huella está en 0,0) y cuánto
 * mejora el puntaje frente a no correrla.
 */
export function corrimiento(a: Aerea, contornos: { x: number; z: number }[][], max = 8, paso = 0.25): { dx: number; dz: number; mejora: number } {
  const cv = a.textura.image as HTMLCanvasElement;
  const W = cv.width;
  const H = cv.height;
  const px = cv.getContext('2d')!.getImageData(0, 0, W, H).data;
  const gris = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) gris[i] = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
  const borde = new Float32Array(W * H);
  for (let y = 1; y < H - 1; y++)
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      const gx = gris[i - W + 1] + 2 * gris[i + 1] + gris[i + W + 1] - gris[i - W - 1] - 2 * gris[i - 1] - gris[i + W - 1];
      const gy = gris[i + W - 1] + 2 * gris[i + W] + gris[i + W + 1] - gris[i - W - 1] - 2 * gris[i - W] - gris[i - W + 1];
      borde[i] = Math.hypot(gx, gy);
    }
  // puntos cada 0,5 m sobre los contornos
  const pts: number[] = [];
  for (const r of contornos)
    for (let i = 0; i < r.length; i++) {
      const p = r[i];
      const q = r[(i + 1) % r.length];
      const L = Math.hypot(q.x - p.x, q.z - p.z);
      for (let t = 0; t < L; t += 0.5) pts.push(p.x + ((q.x - p.x) * t) / L, p.z + ((q.z - p.z) * t) / L);
    }
  const sx = W / a.rect.z;
  const sz = H / a.rect.w;
  const puntaje = (dx: number, dz: number) => {
    let s = 0;
    for (let k = 0; k < pts.length; k += 2) {
      const x = Math.round((pts[k] + dx - a.rect.x) * sx);
      const y = Math.round((pts[k + 1] + dz - a.rect.y) * sz);
      if (x > 0 && y > 0 && x < W - 1 && y < H - 1) s += borde[y * W + x];
    }
    return s;
  };
  let best = { dx: 0, dz: 0, s: -1 };
  for (let dx = -max; dx <= max; dx += paso)
    for (let dz = -max; dz <= max; dz += paso) {
      const s = puntaje(dx, dz);
      if (s > best.s) best = { dx, dz, s };
    }
  return { dx: best.dx, dz: best.dz, mejora: best.s / Math.max(1, puntaje(0, 0)) };
}

export async function mosaicoAereo(zona: Zona, fuente: FuenteAerea): Promise<Aerea> {
  const t0 = performance.now();
  const [s, w, n, e] = zona.bbox;
  const pad = 0.0003;
  const z = fuente.zoom;
  const a = tileXY({ lat: n + pad, lon: w - pad }, z);
  const b = tileXY({ lat: s - pad, lon: e + pad }, z);
  const x0 = Math.floor(a.x);
  const y0 = Math.floor(a.y);
  const x1 = Math.floor(b.x);
  const y1 = Math.floor(b.y);
  const canvas = document.createElement('canvas');
  canvas.width = (x1 - x0 + 1) * 256;
  canvas.height = (y1 - y0 + 1) * 256;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#777';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  let bytes = 0;
  let fallidas = 0;
  const trabajos: Promise<void>[] = [];
  for (let x = x0; x <= x1; x++)
    for (let y = y0; y <= y1; y++) {
      const url = fuente.url.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
      trabajos.push(
        fetch(url)
          .then(async (r) => {
            if (!r.ok) throw new Error(String(r.status));
            const blob = await r.blob();
            bytes += blob.size;
            const img = await createImageBitmap(blob);
            ctx.drawImage(img, (x - x0) * 256, (y - y0) * 256);
          })
          .catch(() => void fallidas++),
      );
    }
  await Promise.all(trabajos);
  const textura = new THREE.CanvasTexture(canvas);
  textura.colorSpace = THREE.SRGBColorSpace;
  textura.anisotropy = 4;
  const nw = zona.local(tileToLatLon(x0, y0, z));
  const se = zona.local(tileToLatLon(x1 + 1, y1 + 1, z));
  const rect = new THREE.Vector4(nw.x, nw.z, se.x - nw.x, se.z - nw.z);
  const suelo = new THREE.Mesh(new THREE.PlaneGeometry(rect.z, rect.w), new THREE.MeshBasicMaterial({ map: textura }));
  suelo.rotation.x = -Math.PI / 2;
  suelo.position.set(nw.x + rect.z / 2, 0.02, nw.z + rect.w / 2);
  return {
    textura,
    rect,
    suelo,
    bytes,
    teselas: (x1 - x0 + 1) * (y1 - y0 + 1),
    fallidas,
    ms: performance.now() - t0,
    px: `${canvas.width}×${canvas.height}`,
    fuente,
  };
}
