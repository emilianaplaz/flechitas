// Fotos a pie de calle de Mapillary: se piden las de la caja de la zona (API v4, necesita
// VITE_MAPILLARY_TOKEN en .env.local), se dibujan como conos en la maqueta y, para el edificio
// elegido, se hornean sobre sus paredes con la misma proyección que el video propio.
import * as THREE from 'three';
import { cargarFoto, hornear, puntaje, FOTOS_POR_PARED, type Foto, type Pared } from './proyeccion.ts';
import type { Edificio } from './edificios.ts';
import type { Zona } from './zona.ts';

export interface ImgMly {
  id: string;
  lat: number;
  lon: number;
  rumbo: number; // grados desde el norte
  esferica: boolean;
  url: string; // thumb_1024
  fecha: string;
  foto: Foto;
}

const CAMPOS = 'id,computed_geometry,geometry,computed_compass_angle,compass_angle,camera_type,camera_parameters,computed_rotation,thumb_1024_url,captured_at,width,height';

/** Rotación de OpenSfM (ángulo-eje, mundo ENU → cámara x der, y abajo, z adelante) a la de Three.js en la maqueta. */
function orientacion(rot: number[] | undefined, rumbo: number): THREE.Quaternion {
  if (!rot) return new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(-rumbo));
  const v = new THREE.Vector3(...rot);
  const ang = v.length();
  const R = new THREE.Matrix4().makeRotationAxis(ang > 0 ? v.clone().normalize() : new THREE.Vector3(1, 0, 0), ang); // ENU → cam OpenSfM
  const camToEnu = R.clone().transpose();
  const enuToMaq = new THREE.Matrix4().set(1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1); // x=E, y=U, z=-N
  const threeToSfm = new THREE.Matrix4().makeScale(1, -1, -1);
  return new THREE.Quaternion().setFromRotationMatrix(enuToMaq.multiply(camToEnu).multiply(threeToSfm));
}

export async function imagenesMapillary(token: string, zona: Zona, suelo: (x: number, z: number) => number): Promise<{ imgs: ImgMly[]; bytes: number; ms: number }> {
  const t0 = performance.now();
  const [s, w, n, e] = zona.bbox;
  const url = `https://graph.mapillary.com/images?access_token=${encodeURIComponent(token)}&fields=${CAMPOS}&bbox=${w},${s},${e},${n}&limit=2000`;
  const res = await fetch(url);
  const text = await res.text();
  if (!res.ok) throw new Error(`Mapillary ${res.status}: ${text.slice(0, 200)}`);
  const json = JSON.parse(text) as { data: Record<string, unknown>[] };
  const imgs = json.data.map((d): ImgMly => {
    const g = (d.computed_geometry ?? d.geometry) as { coordinates: [number, number] };
    const [lon, lat] = g.coordinates;
    const rumbo = Number(d.computed_compass_angle ?? d.compass_angle ?? 0);
    const esferica = d.camera_type === 'spherical' || d.camera_type === 'equirectangular';
    const W = Number(d.width) || 1024;
    const H = Number(d.height) || 768;
    const focal = (d.camera_parameters as number[] | undefined)?.[0] ?? 0.8;
    const p = zona.local({ lat, lon });
    return {
      id: String(d.id),
      lat,
      lon,
      rumbo,
      esferica,
      url: String(d.thumb_1024_url),
      fecha: new Date(Number(d.captured_at)).toISOString().slice(0, 10),
      foto: {
        tex: null as unknown as THREE.Texture,
        pos: new THREE.Vector3(p.x, suelo(p.x, p.z) + 2, p.z), // ~2 m: mano o techo del carro
        quat: orientacion(d.computed_rotation as number[] | undefined, rumbo),
        vfov: THREE.MathUtils.radToDeg(2 * Math.atan(H / Math.max(W, H) / (2 * focal))),
        aspect: W / H,
        esferica,
      },
    };
  });
  return { imgs, bytes: text.length, ms: performance.now() - t0 };
}

/** Conos que muestran dónde está cada foto y hacia dónde mira. */
export function marcadores(imgs: ImgMly[]): THREE.InstancedMesh {
  const g = new THREE.ConeGeometry(0.8, 2.4, 6).rotateX(-Math.PI / 2); // apunta a -z
  const m = new THREE.InstancedMesh(g, new THREE.MeshBasicMaterial({ color: 0x35c46a }), Math.max(1, imgs.length));
  const o = new THREE.Object3D();
  imgs.forEach((im, i) => {
    o.position.copy(im.foto.pos).setY(1.5); // la maqueta es plana
    o.quaternion.copy(im.foto.quat);
    o.updateMatrix();
    m.setMatrixAt(i, o.matrix);
  });
  m.count = imgs.length;
  return m;
}

/** Hornea las fotos más útiles sobre las paredes del edificio y devuelve la malla para la maqueta plana. */
export async function hornearEdificio(renderer: THREE.WebGLRenderer, ed: Edificio, imgs: ImgMly[], suelo: (x: number, z: number) => number) {
  const ccw = ed.ring.length > 2 && ed.ring.reduce((a, p, i) => a + p.x * ed.ring[(i + 1) % ed.ring.length].z - ed.ring[(i + 1) % ed.ring.length].x * p.z, 0) > 0;
  const paredes: Pared[] = [];
  for (let i = 0; i < ed.ring.length; i++) {
    const a = ed.ring[i];
    const b = ed.ring[(i + 1) % ed.ring.length];
    const L = Math.hypot(b.x - a.x, b.z - a.z);
    if (L < 1) continue;
    const dx = (b.x - a.x) / L;
    const dz = (b.z - a.z) / L;
    const ya = suelo(a.x, a.z);
    const yb = suelo(b.x, b.z);
    paredes.push({ a: new THREE.Vector2(a.x, a.z), b: new THREE.Vector2(b.x, b.z), y0a: ya, y0b: yb, alto: ed.height, normal: ccw ? new THREE.Vector2(dz, -dx) : new THREE.Vector2(-dz, dx) });
  }
  const pcam = new THREE.PerspectiveCamera();
  const cerca = imgs.filter((im) => Math.hypot(im.foto.pos.x - ed.center.x, im.foto.pos.z - ed.center.z) < 60);
  const elegidas = paredes.map((p) =>
    cerca
      .map((im) => ({ im, peso: puntaje(im.foto, p, pcam) }))
      .filter((q) => q.peso > 0)
      .sort((x, y) => y.peso - x.peso)
      .slice(0, FOTOS_POR_PARED),
  );
  const usadas = [...new Set(elegidas.flat().map((q) => q.im))];
  await Promise.all(usadas.map(async (im) => (im.foto.tex ??= await cargarFoto(im.url))));
  const h = await hornear(renderer, paredes, (p) => elegidas[paredes.indexOf(p)].map((q) => ({ foto: q.im.foto, peso: q.peso })), 48);
  // En la maqueta plana: cada pared baja a y = 0 y se separa un poco hacia afuera.
  const pos = h.malla.geometry.getAttribute('position') as THREE.BufferAttribute;
  paredes.forEach((p, i) => {
    for (let k = 0; k < 6; k++) {
      const j = i * 6 + k;
      const t = (pos.getX(j) - p.a.x) * (p.b.x - p.a.x) + (pos.getZ(j) - p.a.y) * (p.b.y - p.a.y);
      const y0 = t > 0.5 * p.a.distanceToSquared(p.b) ? p.y0b : p.y0a;
      pos.setXYZ(j, pos.getX(j) + p.normal.x * 0.06, pos.getY(j) - y0, pos.getZ(j) + p.normal.y * 0.06);
    }
  });
  pos.needsUpdate = true;
  return { ...h, usadas: usadas.length, paredes: paredes.length };
}
