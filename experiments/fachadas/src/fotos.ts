// Fachadas con el video propio (PRUEBA RENDER): la malla de OpenMVS tal cual, y la alternativa
// barata: líneas de fachada sacadas de esa malla, levantadas como paredes simples (lo mismo que
// son nuestras huellas) y las fotos del video horneadas encima. Todo en el marco del visor de la
// prueba (metros, Y arriba), porque el video no tiene GPS y no se puede ubicar en la maqueta.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { cargarFoto, hornear, puntaje, FOTOS_POR_PARED, type Foto, type Horneado, type Pared } from './proyeccion.ts';

interface NodesJson {
  nodes: { id: number; image: string; position: number[]; quaternion: number[]; vfov: number; aspect: number }[];
  worldToView: number[];
  eyeHeight: number;
}

export interface Piloto {
  grupo: THREE.Group;
  malla: THREE.Object3D;
  paredes: THREE.Mesh;
  lineas: THREE.LineSegments;
  suelo: THREE.Mesh;
  centro: THREE.Vector3;
  radio: number;
  fotos: Foto[];
  horneado: Horneado;
  stats: Record<string, string | number>;
}

const BIN = 1; // m a lo largo de la calle

const fmtMB = (b: number) => `${(b / 1e6).toFixed(1)} MB`;

function bytesDe(url: string): number {
  const e = performance.getEntriesByName(new URL(url, location.href).href).at(-1) as PerformanceResourceTiming | undefined;
  return e ? e.encodedBodySize || e.transferSize : 0;
}

/** Mediana de un arreglo (lo ordena). */
function mediana(a: number[]): number {
  a.sort((x, y) => x - y);
  return a.length ? a[Math.floor(a.length / 2)] : NaN;
}
function cuantil(a: number[], q: number): number {
  a.sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.max(0, Math.round(q * (a.length - 1))))];
}

/** Douglas–Peucker sobre puntos (s, t). */
function simplificar(p: { s: number; t: number; h: number }[], tol: number): typeof p {
  if (p.length < 3) return p;
  const a = p[0];
  const b = p[p.length - 1];
  const ds = b.s - a.s;
  const dt = b.t - a.t;
  const len = Math.hypot(ds, dt) || 1;
  let max = 0;
  let k = 0;
  for (let i = 1; i < p.length - 1; i++) {
    const d = Math.abs((p[i].s - a.s) * dt - (p[i].t - a.t) * ds) / len;
    if (d > max) (max = d), (k = i);
  }
  if (max <= tol) return [a, b];
  return [...simplificar(p.slice(0, k + 1), tol).slice(0, -1), ...simplificar(p.slice(k), tol)];
}

export async function cargarPiloto(renderer: THREE.WebGLRenderer, avisar: (t: string) => void): Promise<Piloto> {
  const t0 = performance.now();
  avisar('Fotos propias: leyendo poses…');
  const data = (await (await fetch('/prueba/nodes.json')).json()) as NodesJson;
  const eye = data.eyeHeight;
  const fotos: Foto[] = data.nodes.map((n) => ({
    tex: null as unknown as THREE.Texture, // se cargan solo las que se usan
    pos: new THREE.Vector3(...n.position),
    quat: new THREE.Quaternion(...n.quaternion),
    vfov: n.vfov,
    aspect: n.aspect,
  }));

  avisar('Fotos propias: bajando la malla de OpenMVS (29 MB)…');
  const tm = performance.now();
  const gltf = await new GLTFLoader().loadAsync('/prueba/street.glb');
  const msMalla = performance.now() - tm;
  const malla = gltf.scene;
  malla.applyMatrix4(new THREE.Matrix4().fromArray(data.worldToView));
  malla.updateMatrixWorld(true);
  let tris = 0;
  let verts = 0;
  const posiciones: THREE.Vector3[] = [];
  malla.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const map = (m.material as THREE.MeshStandardMaterial).map ?? null;
    m.material = new THREE.MeshBasicMaterial({ map, side: THREE.DoubleSide });
    const g = m.geometry;
    const p = g.getAttribute('position');
    verts += p.count;
    tris += (g.index ? g.index.count : p.count) / 3;
    const v = new THREE.Vector3();
    for (let i = 0; i < p.count; i++) posiciones.push(v.fromBufferAttribute(p, i).applyMatrix4(m.matrixWorld).clone());
  });
  const bytesMalla = bytesDe('/prueba/street.glb') + bytesDe('/prueba/street_noseam_0.png');

  // Eje de la calle: componente principal de las posiciones de la cámara (dos pasadas paralelas).
  avisar('Fotos propias: buscando las líneas de fachada…');
  const mean = new THREE.Vector2();
  for (const f of fotos) mean.add(new THREE.Vector2(f.pos.x, f.pos.z));
  mean.divideScalar(fotos.length);
  let sxx = 0;
  let sxz = 0;
  let szz = 0;
  for (const f of fotos) {
    const x = f.pos.x - mean.x;
    const z = f.pos.z - mean.y;
    sxx += x * x;
    sxz += x * z;
    szz += z * z;
  }
  const ang = 0.5 * Math.atan2(2 * sxz, sxx - szz);
  const d = new THREE.Vector2(Math.cos(ang), Math.sin(ang)); // a lo largo
  const n = new THREE.Vector2(-d.y, d.x); // a lo ancho
  const st = (x: number, z: number) => ({ s: (x - mean.x) * d.x + (z - mean.y) * d.y, t: (x - mean.x) * n.x + (z - mean.y) * n.y });
  const xz = (s: number, t: number) => new THREE.Vector2(mean.x + d.x * s + n.x * t, mean.y + d.y * s + n.y * t);

  // Piso a lo largo de la calle: la cámara iba a `eye` metros del piso.
  const camST = fotos.map((f) => ({ ...st(f.pos.x, f.pos.z), y: f.pos.y - eye }));
  const sMin = Math.min(...camST.map((c) => c.s)) - 8;
  const sMax = Math.max(...camST.map((c) => c.s)) + 8;
  const nb = Math.ceil((sMax - sMin) / BIN);
  const pisoBin = new Array<number>(nb).fill(NaN);
  for (let i = 0; i < nb; i++) {
    const s = sMin + (i + 0.5) * BIN;
    let wsum = 0;
    let ysum = 0;
    for (const c of camST) {
      const w = 1 / (1 + ((c.s - s) / 3) ** 2);
      wsum += w;
      ysum += w * c.y;
    }
    pisoBin[i] = ysum / wsum;
  }
  const binDe = (s: number) => Math.min(nb - 1, Math.max(0, Math.floor((s - sMin) / BIN)));
  const piso = (s: number) => pisoBin[binDe(s)];
  // Rejilla de ocupación (vista desde arriba). Una celda es pared si la malla tiene puntos abajo
  // (0,4–1,4 m), en el medio (1,8–2,4 m) y arriba (2,5–3,4 m): una pared es continua; un carro
  // estacionado con una copa de árbol encima deja un hueco entre el techo del carro y las hojas.
  const CELDA = 0.3;
  let gx0 = Infinity;
  let gz0 = Infinity;
  let gx1 = -Infinity;
  let gz1 = -Infinity;
  for (const p of posiciones) (gx0 = Math.min(gx0, p.x)), (gz0 = Math.min(gz0, p.z)), (gx1 = Math.max(gx1, p.x)), (gz1 = Math.max(gz1, p.z));
  const GW = Math.ceil((gx1 - gx0) / CELDA) + 1;
  const GD = Math.ceil((gz1 - gz0) / CELDA) + 1;
  const bajo = new Uint16Array(GW * GD);
  const medio = new Uint16Array(GW * GD);
  const arriba = new Uint16Array(GW * GD);
  const celda = (x: number, z: number) => {
    const i = Math.floor((x - gx0) / CELDA);
    const k = Math.floor((z - gz0) / CELDA);
    return i < 0 || k < 0 || i >= GW || k >= GD ? -1 : k * GW + i;
  };
  for (const p of posiciones) {
    const h = p.y - piso(st(p.x, p.z).s);
    const c = celda(p.x, p.z);
    if (c < 0) continue;
    if (h > 0.4 && h < 1.4 && bajo[c] < 65535) bajo[c]++;
    if (h > 1.8 && h < 2.4 && medio[c] < 65535) medio[c]++;
    if (h > 2.5 && h < 3.4 && arriba[c] < 65535) arriba[c]++;
  }
  const esPared = (c: number) => bajo[c] >= 1 && medio[c] >= 1 && arriba[c] >= 1;

  // Cada foto "mira" su fachada: rayos horizontales desde la cámara hasta la primera celda ocupada.
  // Se agrupan por el lado al que mira la cámara (cada pasada mira la acera de enfrente).
  const golpes: { s: number; t: number; lado: number }[] = [];
  for (const f of fotos) {
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(f.quat);
    const yaw = Math.atan2(fwd.x, fwd.z);
    const lado = Math.sign(fwd.x * n.x + fwd.z * n.y) || 1;
    for (const da of [-20, -10, 0, 10, 20]) {
      const a = yaw + THREE.MathUtils.degToRad(da);
      const dx = Math.sin(a);
      const dz = Math.cos(a);
      for (let r = 6; r < 30; r += 0.1) { // la acera de enfrente está a más de 6 m
        const x = f.pos.x + dx * r;
        const z = f.pos.z + dz * r;
        const c = celda(x, z);
        if (c < 0) break;
        if (esPared(c)) {
          golpes.push({ ...st(x, z), lado });
          break;
        }
      }
    }
  }

  // Alto de la pared en cada punto: hasta dónde llega la malla cerca de la línea.
  const altoEn = (x: number, z: number) => {
    const hs: number[] = [];
    for (const p of posiciones) {
      if (Math.abs(p.x - x) > 0.8 || Math.abs(p.z - z) > 0.8) continue;
      const h = p.y - piso(st(p.x, p.z).s);
      if (h > 0 && h < 14) hs.push(h);
    }
    return hs.length > 10 ? cuantil(hs, 0.95) : 3;
  };

  const paredes: Pared[] = [];
  const lineas: number[] = [];
  for (const lado of [-1, 1]) {
    const g = golpes.filter((q) => q.lado === lado);
    const perfil: { s: number; t: number; h: number }[] = [];
    for (let i = 0; i < nb; i++) {
      const s0 = sMin + i * BIN;
      const enBin = g.filter((q) => q.s >= s0 && q.s < s0 + BIN).map((q) => q.t);
      if (enBin.length < 4) continue;
      const t = mediana(enBin);
      const p = xz(s0 + BIN / 2, t);
      perfil.push({ s: s0 + BIN / 2, t, h: altoEn(p.x, p.y) });
    }
    // tramos continuos (huecos de más de 3 m o saltos de más de 1,5 m cortan), suavizados y simplificados
    const tramos: (typeof perfil)[] = [];
    for (const p of perfil) {
      const last = tramos.at(-1);
      const prev = last?.[last.length - 1];
      if (last && prev && p.s - prev.s <= 3 * BIN && Math.abs(p.t - prev.t) < 1.5) last.push(p);
      else tramos.push([p]);
    }
    for (const tr of tramos) {
      if (tr.length < 4) continue;
      const suave = tr.map((p, i) => ({
        s: p.s,
        t: mediana(tr.slice(Math.max(0, i - 2), i + 3).map((q) => q.t)),
        h: mediana(tr.slice(Math.max(0, i - 3), i + 4).map((q) => q.h)),
      }));
      const simple = simplificar(suave, 0.35);
      for (let k = 0; k < simple.length - 1; k++) {
        const pa = simple[k];
        const pb = simple[k + 1];
        const a = xz(pa.s, pa.t);
        const b = xz(pb.s, pb.t);
        const enTramo = suave.filter((q) => q.s >= pa.s && q.s <= pb.s).map((q) => q.h);
        const alto = THREE.MathUtils.clamp(mediana(enTramo.length ? enTramo : [3]), 2.5, 9);
        const seg = b.clone().sub(a).normalize();
        let nor = new THREE.Vector2(-seg.y, seg.x);
        if (nor.dot(n) * lado > 0) nor = nor.negate(); // hacia las cámaras que la vieron
        paredes.push({ a, b, y0a: piso(pa.s), y0b: piso(pb.s), alto, normal: nor });
        lineas.push(a.x, piso(pa.s) + 0.05, a.y, b.x, piso(pb.s) + 0.05, b.y);
      }
    }
  }
  const tCam = camST.map((c) => c.t);
  const tLo = Math.min(...tCam, ...golpes.map((q) => q.t));
  const tHi = Math.max(...tCam, ...golpes.map((q) => q.t));

  // Las mejores fotos para cada pared, y solo esas se bajan.
  avisar(`Fotos propias: horneando ${paredes.length} paredes…`);
  const pcam = new THREE.PerspectiveCamera();
  const elegidas = paredes.map((p) =>
    fotos
      .map((f, i) => ({ i, peso: puntaje(f, p, pcam) }))
      .filter((q) => q.peso > 0)
      .sort((x, y) => y.peso - x.peso)
      .slice(0, FOTOS_POR_PARED),
  );
  const usadas = [...new Set(elegidas.flat().map((q) => q.i))];
  const loader = new THREE.TextureLoader();
  await Promise.all(usadas.map(async (i) => (fotos[i].tex = await cargarFoto(`/prueba/${data.nodes[i].image}`, loader))));
  const bytesFotos = usadas.reduce((a, i) => a + bytesDe(`/prueba/${data.nodes[i].image}`), 0);
  const horneado = await hornear(renderer, paredes, (p) => elegidas[paredes.indexOf(p)].map((q) => ({ foto: fotos[q.i], peso: q.peso })), 40);

  // Piso gris entre las dos fachadas, siguiendo la pendiente.
  const sg = new THREE.PlaneGeometry(sMax - sMin, 1, nb, 1);
  const gp = sg.getAttribute('position');
  const tA = tLo - 2;
  const tB = tHi + 2;
  for (let i = 0; i < gp.count; i++) {
    const s = gp.getX(i) + (sMin + sMax) / 2;
    const t = gp.getY(i) > 0 ? tB : tA;
    const p = xz(s, t);
    gp.setXYZ(i, p.x, piso(s) - 0.02, p.y);
  }
  sg.computeVertexNormals();
  const suelo = new THREE.Mesh(sg, new THREE.MeshBasicMaterial({ color: 0x5b5f66, side: THREE.DoubleSide }));

  const lg = new THREE.BufferGeometry();
  const camino = camST.flatMap((c, i) => (i ? [fotos[i - 1].pos.x, camST[i - 1].y + 0.05, fotos[i - 1].pos.z, fotos[i].pos.x, c.y + 0.05, fotos[i].pos.z] : []));
  lg.setAttribute('position', new THREE.Float32BufferAttribute([...lineas, ...camino], 3));
  const lineasObj = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: 0x4b86f5, depthTest: false, transparent: true }));
  lineasObj.renderOrder = 5;

  const grupo = new THREE.Group();
  grupo.add(malla, horneado.malla, suelo, lineasObj);
  const box = new THREE.Box3().setFromPoints(paredes.flatMap((p) => [new THREE.Vector3(p.a.x, p.y0a, p.a.y), new THREE.Vector3(p.b.x, p.y0b, p.b.y)]));
  const centro = box.getCenter(new THREE.Vector3());
  return {
    grupo,
    malla,
    paredes: horneado.malla,
    lineas: lineasObj,
    suelo,
    centro,
    radio: box.getSize(new THREE.Vector3()).length() / 2,
    fotos,
    horneado,
    stats: {
      'Malla OpenMVS': `${fmtMB(bytesMalla)} · ${Math.round(tris / 1000)} k triángulos · ${Math.round(verts / 1000)} k vértices`,
      'Malla: carga + parseo': `${(msMalla / 1000).toFixed(1)} s (escritorio, disco local)`,
      'Paredes simples': `${paredes.length} paredes · ${paredes.length * 2} triángulos`,
      'Atlas horneado': `${horneado.canvas.width}×${horneado.canvas.height} px · JPEG ${(horneado.bytesJpeg / 1e3).toFixed(0)} kB · ${(horneado.cobertura * 100).toFixed(0)} % con foto`,
      'Fotos usadas para hornear': `${usadas.length} de ${fotos.length} (${fmtMB(bytesFotos)})`,
      'Horneado': `${(horneado.ms / 1000).toFixed(2)} s en el navegador`,
      'Total': `${((performance.now() - t0) / 1000).toFixed(1)} s`,
    },
  };
}
