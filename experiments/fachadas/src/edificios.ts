// Edificios de la zona como una sola malla (una llamada de dibujo) y el material de fachadas
// procedurales: pisos, ventanas, planta baja y color por uso, calculados en el shader a partir de
// la altura, los pisos y la huella. Sin texturas: no se descarga nada más que las teselas.
// Con detalle 0 y color por uso 0 da exactamente los colores planos de la pantalla Maqueta de hoy.
import * as THREE from 'three';
import type { TileBuilding } from '../../../src/core/maqueta.ts';
import type { Zona } from './zona.ts';

export type Uso = 0 | 1 | 2 | 3;
export const USO_NOMBRE = ['casa', 'edificio', 'comercial', 'torre'] as const;

export interface Edificio {
  idx: number;
  b: TileBuilding;
  ring: { x: number; z: number }[]; // contorno local, sin repetir el primer punto
  area: number; // m²
  height: number;
  uso: Uso;
  seed: number; // 0..1, estable por id
  center: { x: number; z: number };
}

/** Las teselas no traen el uso: se estima por altura y huella (ver RESULTADOS.md, datos que faltan). */
export function usoDe(area: number, h: number): Uso {
  if (h >= 24) return 3;
  if (area >= 1500 && h <= 12) return 2;
  if (h <= 9.5 && area < 350) return 0;
  return 1;
}

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}

export function signedArea(ring: { x: number; z: number }[]): number {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % ring.length];
    a += p.x * q.z - q.x * p.z;
  }
  return a / 2;
}

export function edificiosDe(z: Zona): Edificio[] {
  return z.buildings.map((b, idx) => {
    const ring = b.outline.slice(0, -1).map(([lat, lon]) => z.local({ lat, lon }));
    const area = Math.abs(signedArea(ring));
    let cx = 0;
    let cz = 0;
    for (const p of ring) (cx += p.x), (cz += p.z);
    return { idx, b, ring, area, height: b.height, uso: usoDe(area, b.height), seed: hashStr(b.id), center: { x: cx / ring.length, z: cz / ring.length } };
  });
}

/**
 * Paredes y techos de todos los edificios en una geometría. Atributos:
 * - aFac: paredes (u a lo largo de la pared en m, v altura en m, largo de la pared, altura del edificio);
 *         techos (x, z, -1, altura).
 * - aBld: (índice del edificio, uso, semilla).
 */
export function geometriaEdificios(eds: Edificio[]): THREE.BufferGeometry {
  const pos: number[] = [];
  const nor: number[] = [];
  const fac: number[] = [];
  const bld: number[] = [];
  const v = new THREE.Vector3();
  const e1 = new THREE.Vector3();
  const e2 = new THREE.Vector3();
  const push = (p: number[], n: number[], f: number[], b: number[]) => {
    pos.push(...p);
    nor.push(...n);
    fac.push(...f);
    bld.push(...b);
  };
  /** Un triángulo con la cara hacia `n` (da vuelta el orden si hace falta). */
  const tri = (a: number[], b: number[], c: number[], n: number[], fa: number[], fb: number[], fc: number[], bb: number[]) => {
    e1.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    e2.set(c[0] - a[0], c[1] - a[1], c[2] - a[2]);
    v.crossVectors(e1, e2);
    const ok = v.x * n[0] + v.y * n[1] + v.z * n[2] >= 0;
    push(a, n, fa, bb);
    if (ok) {
      push(b, n, fb, bb);
      push(c, n, fc, bb);
    } else {
      push(c, n, fc, bb);
      push(b, n, fb, bb);
    }
  };
  for (const ed of eds) {
    const { ring, height: H } = ed;
    const bb = [ed.idx, ed.uso, ed.seed];
    const ccw = signedArea(ring) > 0;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      const L = Math.hypot(b.x - a.x, b.z - a.z);
      if (L < 0.05) continue;
      const dx = (b.x - a.x) / L;
      const dz = (b.z - a.z) / L;
      const n = ccw ? [dz, 0, -dx] : [-dz, 0, dx];
      const a0 = [a.x, 0, a.z];
      const b0 = [b.x, 0, b.z];
      const a1 = [a.x, H, a.z];
      const b1 = [b.x, H, b.z];
      const fa0 = [0, 0, L, H];
      const fb0 = [L, 0, L, H];
      const fa1 = [0, H, L, H];
      const fb1 = [L, H, L, H];
      tri(a0, b0, b1, n, fa0, fb0, fb1, bb);
      tri(a0, b1, a1, n, fa0, fb1, fa1, bb);
    }
    const contour = ring.map((p) => new THREE.Vector2(p.x, p.z));
    const up = [0, 1, 0];
    for (const [i, j, k] of THREE.ShapeUtils.triangulateShape(contour, [])) {
      const p = [ring[i], ring[j], ring[k]];
      tri(
        [p[0].x, H, p[0].z],
        [p[1].x, H, p[1].z],
        [p[2].x, H, p[2].z],
        up,
        [p[0].x, p[0].z, -1, H],
        [p[1].x, p[1].z, -1, H],
        [p[2].x, p[2].z, -1, H],
        bb,
      );
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('aFac', new THREE.Float32BufferAttribute(fac, 4));
  g.setAttribute('aBld', new THREE.Float32BufferAttribute(bld, 3));
  g.computeBoundingSphere();
  g.computeBoundingBox();
  return g;
}

// ---------- paletas: las de src/ui/maqueta.ts, más ventanas y colores por uso ----------

export type Tema = 'dark' | 'light';

export const PALETA = {
  dark: {
    bg: 0x0a0a0b, gnd: 0x111214, street: 0x2a2d32, top: 0x3a3e45, left: 0x24272c, right: 0x181a1d,
    stop: 0x4b86f5, sleft: 0x3e6ae1, sright: 0x2a4aa8,
    win: 0x343a44, winLit: 0x9c7f4c, selWin: 0x8db0fa,
    usoL: [0x342f28, 0x262a30, 0x1f2835, 0x2b3039],
    usoTop: [0x4d3429, 0x3a3e45, 0x343c48, 0x3e434b],
  },
  light: {
    bg: 0xf4f8fb, gnd: 0xe2ecf2, street: 0xffffff, top: 0xffffff, left: 0xcbd9e3, right: 0xb0c2d0,
    stop: 0x3b74e0, sleft: 0x1a56c4, sright: 0x123f94,
    win: 0x8ea4b6, winLit: 0x8ea4b6, selWin: 0x86aef0,
    usoL: [0xeadfca, 0xcbd9e3, 0xc2d5e6, 0xd6dfe7],
    usoTop: [0xd99c7a, 0xffffff, 0xeef3f8, 0xf3f5f7],
  },
};

const col = (h: number) => new THREE.Color(h);

const VERT = /* glsl */ `
attribute vec4 aFac;
attribute vec3 aBld;
varying vec4 vFac;
varying vec3 vBld;
varying vec3 vN;
varying vec3 vW;
void main() {
  vFac = aFac;
  vBld = aBld;
  vN = normal;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const FRAG = /* glsl */ `
uniform vec3 uL, uR, uTop, uSelL, uSelR, uSelTop, uWin, uWinLit, uSelWin;
uniform vec3 uUsoL[4];
uniform vec3 uUsoTop[4];
uniform float uRShade;
uniform vec2 uCamRight;
uniform float uSel, uDetail, uUso, uDark, uLitShare;
uniform sampler2D uAerial;
uniform vec4 uAerialRect; // x0, z0, ancho, fondo (m) del mosaico aéreo
uniform float uAerialOn;
varying vec4 vFac;
varying vec3 vBld;
varying vec3 vN;
varying vec3 vW;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float box(float x, float a, float b, float w) {
  return smoothstep(a - w, a + w, x) - smoothstep(b - w, b + w, x);
}

void main() {
  bool sel = abs(vBld.x - uSel) < 0.5;
  int uso = int(vBld.y + 0.5);
  float seed = vBld.z;
  vec3 c;
  if (vFac.z < 0.0) {
    // techo
    c = sel ? uSelTop : mix(uTop, uUsoTop[uso], uUso);
    vec2 p = vFac.xy;
    float mpp = max(fwidth(p.x), fwidth(p.y));
    float det = uDetail * (1.0 - smoothstep(0.12, 0.45, mpp));
    if (uso == 0) {
      float s = abs(fract(p.x * 2.2 + p.y * 0.4 + seed * 7.0) - 0.5);
      c *= 1.0 - 0.10 * det * smoothstep(0.32, 0.5, s);
    } else {
      float g = max(box(fract(p.x / 6.0 + seed), 0.0, 0.03, 0.01), box(fract(p.y / 6.0 + seed), 0.0, 0.03, 0.01));
      c *= 1.0 - 0.06 * det * g;
    }
    if (uAerialOn > 0.5 && !sel) {
      vec2 uv = (vW.xz - uAerialRect.xy) / uAerialRect.zw;
      c = texture2D(uAerial, vec2(uv.x, 1.0 - uv.y)).rgb;
    }
  } else {
    float u = vFac.x;
    float v = vFac.y;
    float L = vFac.z;
    float H = vFac.w;
    float right = dot(normalize(vN.xz), uCamRight) > 0.0 ? 1.0 : 0.0;
    vec3 baseL = sel ? uSelL : mix(uL, uUsoL[uso], uUso);
    vec3 baseR = sel ? uSelR : mix(uR, uUsoL[uso] * uRShade, uUso);
    vec3 wall = mix(baseL, baseR, right);
    float mpp = max(fwidth(u), fwidth(v)); // metros por píxel en pantalla
    float det = uDetail * (1.0 - smoothstep(0.12, 0.45, mpp)); // lejos se apaga el detalle: sin moiré
    float nF = max(1.0, floor(H / 3.0 + 0.5));
    float fh = H / nF;
    float fi = floor(v / fh);
    float fv = fract(v / fh);
    float bayT = uso == 3 ? 2.6 : (uso == 0 ? 3.6 : 3.0);
    float nB = max(1.0, floor(L / bayT + 0.5));
    float bw = L / nB;
    float bi = floor(u / bw);
    float bu = fract(u / bw);
    float aw = fwidth(u) / bw;
    float ah = fwidth(v) / fh;
    float x0 = 0.24, x1 = 0.76, y0 = 0.30, y1 = 0.80;
    float r = hash(vec2(bi + seed * 61.0, fi + seed * 17.0));
    bool door = false;
    if (fi < 0.5) {
      if (uso == 2) { x0 = 0.06; x1 = 0.94; y0 = 0.08; y1 = 0.86; }
      else if (uso == 0 && r < 0.35) { x0 = 0.33; x1 = 0.67; y0 = 0.0; y1 = 0.74; door = true; }
      else { y0 = 0.40; }
    } else if (uso == 3) { x0 = 0.12; x1 = 0.88; y0 = 0.22; y1 = 0.86; }
    float win = box(bu, x0, x1, aw) * box(fv, y0, y1, ah);
    if (L < 1.4 || v > H - 0.5 || H < 2.4) win = 0.0;
    win *= det;
    vec3 wc = (sel ? uSelWin : uWin) * mix(1.0, 0.82, right);
    float lit = step(1.0 - uLitShare, r) * uDark * (sel ? 0.0 : 1.0) * (door ? 0.0 : 1.0);
    wc = mix(wc, uWinLit * mix(1.0, 0.8, right), lit);
    if (door) wc = wall * 0.62;
    c = mix(wall, wc, win);
    float slab = 1.0 - smoothstep(0.0, 2.0 * ah, min(fv, 1.0 - fv));
    if (fi > 0.5 || fv > 0.5) c = mix(c, c * (uDark > 0.5 ? 1.22 : 0.9), slab * 0.5 * det);
    float edge = min(u, L - u);
    c *= mix(1.0, mix(0.86, 1.0, smoothstep(0.0, 0.4, edge)), uDetail);
    c *= mix(1.0, mix(0.8, 1.0, smoothstep(0.0, 1.5, v)), uDetail);
  }
  gl_FragColor = vec4(c, 1.0);
  #include <colorspace_fragment>
}`;

export interface OpcionesFachada {
  detalle: number; // 0 = bloques planos de hoy, 1 = ventanas y pisos
  uso: number; // 0..1, cuánto se tiñe por uso
  tema: Tema;
}

export function materialFachadas(o: OpcionesFachada): THREE.ShaderMaterial {
  const m = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: {
      uL: { value: col(0) }, uR: { value: col(0) }, uTop: { value: col(0) },
      uSelL: { value: col(0) }, uSelR: { value: col(0) }, uSelTop: { value: col(0) },
      uWin: { value: col(0) }, uWinLit: { value: col(0) }, uSelWin: { value: col(0) },
      uUsoL: { value: [col(0), col(0), col(0), col(0)] },
      uUsoTop: { value: [col(0), col(0), col(0), col(0)] },
      uRShade: { value: 0.7 },
      uCamRight: { value: new THREE.Vector2(1, 0) },
      uSel: { value: -1 },
      uDetail: { value: o.detalle },
      uUso: { value: o.uso },
      uDark: { value: 1 },
      uLitShare: { value: 0.12 },
      uAerial: { value: null },
      uAerialRect: { value: new THREE.Vector4(0, 0, 1, 1) },
      uAerialOn: { value: 0 },
    },
  });
  aplicarTema(m, o.tema);
  return m;
}

export function aplicarTema(m: THREE.ShaderMaterial, tema: Tema) {
  const p = PALETA[tema];
  const u = m.uniforms;
  u.uL.value.setHex(p.left);
  u.uR.value.setHex(p.right);
  u.uTop.value.setHex(p.top);
  u.uSelL.value.setHex(p.sleft);
  u.uSelR.value.setHex(p.sright);
  u.uSelTop.value.setHex(p.stop);
  u.uWin.value.setHex(p.win);
  u.uWinLit.value.setHex(p.winLit);
  u.uSelWin.value.setHex(p.selWin);
  p.usoL.forEach((h, i) => u.uUsoL.value[i].setHex(h));
  p.usoTop.forEach((h, i) => u.uUsoTop.value[i].setHex(h));
  const l = new THREE.Color(p.left);
  const r = new THREE.Color(p.right);
  u.uRShade.value = (r.r + r.g + r.b) / (l.r + l.g + l.b);
  u.uDark.value = tema === 'dark' ? 1 : 0;
}

/** Suelo y calles como en la pantalla Maqueta. */
export function sueloYCalles(z: Zona, tema: Tema): { suelo: THREE.Mesh; calles: THREE.Mesh } {
  const c = PALETA[tema];
  const [s, w, n, e] = z.bbox;
  const sw = z.local({ lat: s, lon: w });
  const ne = z.local({ lat: n, lon: e });
  const pad = 40;
  const gw = ne.x - sw.x + pad * 2;
  const gd = sw.z - ne.z + pad * 2;
  const suelo = new THREE.Mesh(new THREE.PlaneGeometry(gw, gd), new THREE.MeshBasicMaterial({ color: c.gnd }));
  suelo.rotation.x = -Math.PI / 2;
  suelo.position.set((sw.x + ne.x) / 2, 0, (sw.z + ne.z) / 2);
  suelo.userData.size = { w: gw, d: gd };
  const pos: number[] = [];
  for (const wy of z.ways) {
    const half = Math.max(3, ((wy.lanes ?? 2) * 3.2) / 2);
    const p = wy.pts.map(([lat, lon]) => z.local({ lat, lon }));
    for (let i = 0; i < p.length - 1; i++) {
      const a = p[i];
      const b = p[i + 1];
      const len = Math.hypot(b.x - a.x, b.z - a.z) || 1;
      const nx = (-(b.z - a.z) / len) * half;
      const nz = ((b.x - a.x) / len) * half;
      const ex = ((b.x - a.x) / len) * half * 0.5;
      const ez = ((b.z - a.z) / len) * half * 0.5;
      const q = [
        [a.x - ex + nx, a.z - ez + nz],
        [a.x - ex - nx, a.z - ez - nz],
        [b.x + ex - nx, b.z + ez - nz],
        [b.x + ex + nx, b.z + ez + nz],
      ];
      for (const k of [0, 1, 2, 0, 2, 3]) pos.push(q[k][0], 0.05, q[k][1]);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  const calles = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: c.street, side: THREE.DoubleSide }));
  return { suelo, calles };
}

/** Contornos de las huellas (para ver cuánto calzan otras fuentes con nuestras huellas). */
export function contornos(eds: Edificio[], color: number, alto = true, suelo: (x: number, z: number) => number = () => 0): THREE.LineSegments {
  const pos: number[] = [];
  for (const ed of eds) {
    const r = ed.ring;
    const y0 = Math.min(...r.map((p) => suelo(p.x, p.z))) + 0.15; // en pendiente: desde el punto más bajo
    const y1 = y0 + ed.height;
    for (let i = 0; i < r.length; i++) {
      const a = r[i];
      const b = r[(i + 1) % r.length];
      pos.push(a.x, y0, a.z, b.x, y0, b.z);
      if (alto) {
        pos.push(a.x, y1, a.z, b.x, y1, b.z);
        pos.push(a.x, y0, a.z, a.x, y1, a.z);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  return new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.9 }));
}
