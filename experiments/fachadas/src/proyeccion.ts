// Fotos proyectadas sobre paredes simples y "horneadas" en un atlas: para cada pared se eligen las
// mejores fotos (de frente, cerca, dentro del cuadro), se proyectan desde su cámara y se mezclan.
// El resultado es una textura chica por zona que la app podría bajar en vez de fotos o mallas.
// Sirve igual para el video propio (poses de COLMAP) que para fotos de Mapillary (pose del API).
import * as THREE from 'three';

export const FOTOS_POR_PARED = 4;

/** Carga una foto para hornear: sin conversión de color ni mipmaps (se muestrea en ramas del shader). */
export function cargarFoto(url: string, loader = new THREE.TextureLoader()): Promise<THREE.Texture> {
  return loader.loadAsync(url).then((t) => {
    t.colorSpace = THREE.NoColorSpace;
    t.generateMipmaps = false;
    t.minFilter = THREE.LinearFilter;
    return t;
  });
}

/** Una foto con su cámara: perspectiva (vfov/aspect) o esférica 360 (equirectangular). */
export interface Foto {
  tex: THREE.Texture;
  pos: THREE.Vector3;
  quat: THREE.Quaternion; // la cámara mira hacia -Z local, como en Three.js
  vfov: number; // grados (perspectiva)
  aspect: number;
  esferica?: boolean;
}

/** Una pared vertical: de a a b, del piso y0 hasta y1 (puede ir en pendiente: y0a/y0b). */
export interface Pared {
  a: THREE.Vector2; // x, z
  b: THREE.Vector2;
  y0a: number;
  y0b: number;
  alto: number;
  normal: THREE.Vector2; // hacia la calle
}

export interface Horneado {
  textura: THREE.CanvasTexture;
  canvas: HTMLCanvasElement;
  malla: THREE.Mesh;
  bytesJpeg: number;
  cobertura: number; // parte del atlas con foto (0..1)
  ms: number;
}

/** Puntaje de una foto para una pared: de frente, cerca y con la pared dentro del cuadro. */
export function puntaje(f: Foto, p: Pared, cam: THREE.PerspectiveCamera): number {
  const mid = new THREE.Vector3((p.a.x + p.b.x) / 2, (p.y0a + p.y0b) / 2 + p.alto / 2, (p.a.y + p.b.y) / 2);
  const toCam = f.pos.clone().sub(mid);
  const d = toCam.length();
  const facing = (toCam.x * p.normal.x + toCam.z * p.normal.y) / d;
  if (facing < 0.15 || d > 40) return 0;
  if (f.esferica) return facing ** 2 / (1 + d / 8);
  // ¿cuánto de la pared cae dentro del cuadro?
  cam.fov = f.vfov;
  cam.aspect = f.aspect;
  cam.position.copy(f.pos);
  cam.quaternion.copy(f.quat);
  cam.updateProjectionMatrix();
  cam.updateMatrixWorld();
  let inside = 0;
  const pts = [0.1, 0.5, 0.9];
  for (const t of pts)
    for (const h of [0.2, 0.8]) {
      const x = p.a.x + (p.b.x - p.a.x) * t;
      const z = p.a.y + (p.b.y - p.a.y) * t;
      const y = p.y0a + (p.y0b - p.y0a) * t + p.alto * h;
      const v = new THREE.Vector3(x, y, z).project(cam);
      if (v.z < 1 && Math.abs(v.x) < 0.95 && Math.abs(v.y) < 0.95) inside++;
    }
  return (inside / 6) * facing ** 2 / (1 + d / 8);
}

const BAKE_VERT = /* glsl */ `
attribute vec2 aAtlas;
varying vec3 vW;
void main() {
  vW = position;
  gl_Position = vec4(aAtlas * 2.0 - 1.0, 0.0, 1.0);
}`;

// Sin índices dinámicos en arreglos de samplers: cuatro fotos desenrolladas a mano.
const BAKE_FRAG = /* glsl */ `
uniform sampler2D uT0, uT1, uT2, uT3;
uniform mat4 uM0, uM1, uM2, uM3; // perspectiva: proyección*vista; esférica: inversa de la orientación
uniform vec3 uP0, uP1, uP2, uP3;
uniform vec4 uW; // peso de cada foto (0 = no hay)
uniform vec4 uSph; // 1 = esférica
uniform vec3 uNormal;
uniform vec3 uFallback;
varying vec3 vW;

vec4 sample1(sampler2D t, mat4 m, vec3 p, float w, float sph) {
  if (w <= 0.0) return vec4(0.0);
  vec2 uv;
  float fade;
  vec3 toCam = normalize(p - vW);
  float facing = max(dot(toCam, uNormal), 0.0);
  if (sph > 0.5) {
    vec3 d = normalize((m * vec4(vW - p, 0.0)).xyz);
    uv = vec2(atan(d.x, -d.z) / 6.2831853 + 0.5, asin(clamp(d.y, -1.0, 1.0)) / 3.1415927 + 0.5);
    fade = 1.0;
  } else {
    vec4 c = m * vec4(vW, 1.0);
    if (c.w <= 0.0) return vec4(0.0);
    vec2 ndc = c.xy / c.w;
    if (abs(ndc.x) > 1.0 || abs(ndc.y) > 1.0) return vec4(0.0);
    uv = ndc * 0.5 + 0.5;
    vec2 e = min(uv, 1.0 - uv);
    fade = smoothstep(0.0, 0.08, min(e.x, e.y)); // se funde cerca del borde del cuadro
  }
  float k = w * fade * facing * facing;
  return vec4(texture2D(t, uv).rgb * k, k);
}

void main() {
  vec4 s = sample1(uT0, uM0, uP0, uW.x, uSph.x)
         + sample1(uT1, uM1, uP1, uW.y, uSph.y)
         + sample1(uT2, uM2, uP2, uW.z, uSph.z)
         + sample1(uT3, uM3, uP3, uW.w, uSph.w);
  // Las fotos van sin conversión de color (NoColorSpace): se mezclan y se escriben tal cual en sRGB.
  gl_FragColor = s.a > 1e-4 ? vec4(s.rgb / s.a, 1.0) : vec4(uFallback, 0.0);
}`;

/** Tamaño del atlas en píxeles: estantes de 2048 de ancho. */
function empacar(paredes: Pared[], pxPorM: number) {
  const W = 2048;
  const rects: { x: number; y: number; w: number; h: number }[] = [];
  let x = 0;
  let y = 0;
  let fila = 0;
  for (const p of paredes) {
    const w = Math.max(4, Math.ceil(p.a.distanceTo(p.b) * pxPorM)) + 2;
    const h = Math.max(4, Math.ceil(p.alto * pxPorM)) + 2;
    if (x + w > W) {
      x = 0;
      y += fila;
      fila = 0;
    }
    rects.push({ x, y, w: Math.min(w, W), h });
    x += w;
    fila = Math.max(fila, h);
  }
  const H = THREE.MathUtils.ceilPowerOfTwo(Math.max(64, y + fila));
  return { W, H, rects };
}

/**
 * Hornea las fotos sobre las paredes. `elegir` devuelve hasta FOTOS_POR_PARED fotos con su peso.
 * Devuelve el atlas (JPEG medido) y la malla final, que es una sola geometría con un solo material.
 */
export async function hornear(
  renderer: THREE.WebGLRenderer,
  paredes: Pared[],
  elegir: (p: Pared) => { foto: Foto; peso: number }[],
  pxPorM = 40,
  fallback = new THREE.Color(0x808080),
): Promise<Horneado> {
  const t0 = performance.now();
  const { W, H, rects } = empacar(paredes, pxPorM);
  const rt = new THREE.WebGLRenderTarget(W, H, { depthBuffer: false }); // RGBA8 sin conversión: los bytes de las fotos pasan tal cual
  const scene = new THREE.Scene();
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, -1, 1);
  const pcam = new THREE.PerspectiveCamera();
  const finalPos: number[] = [];
  const finalUv: number[] = [];
  const mats: THREE.ShaderMaterial[] = [];
  paredes.forEach((p, i) => {
    const r = rects[i];
    const u0 = (r.x + 1) / W;
    const u1 = (r.x + r.w - 1) / W;
    const v0 = (r.y + 1) / H;
    const v1 = (r.y + r.h - 1) / H;
    const corners = [
      [p.a.x, p.y0a, p.a.y, u0, v0],
      [p.b.x, p.y0b, p.b.y, u1, v0],
      [p.b.x, p.y0b + p.alto, p.b.y, u1, v1],
      [p.a.x, p.y0a + p.alto, p.a.y, u0, v1],
    ];
    const pos: number[] = [];
    const uv: number[] = [];
    for (const k of [0, 1, 2, 0, 2, 3]) {
      pos.push(corners[k][0], corners[k][1], corners[k][2]);
      uv.push(corners[k][3], corners[k][4]);
    }
    finalPos.push(...pos);
    finalUv.push(...uv);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('aAtlas', new THREE.Float32BufferAttribute(uv, 2));
    const elegidas = elegir(p).slice(0, FOTOS_POR_PARED);
    const u: Record<string, THREE.IUniform> = {
      uW: { value: new THREE.Vector4() },
      uSph: { value: new THREE.Vector4() },
      uNormal: { value: new THREE.Vector3(p.normal.x, 0, p.normal.y) },
      uFallback: { value: fallback },
    };
    for (let k = 0; k < FOTOS_POR_PARED; k++) {
      const e = elegidas[k];
      let m = new THREE.Matrix4();
      if (e) {
        const f = e.foto;
        if (f.esferica) m = new THREE.Matrix4().makeRotationFromQuaternion(f.quat.clone().invert());
        else {
          pcam.fov = f.vfov;
          pcam.aspect = f.aspect;
          pcam.near = 0.1;
          pcam.far = 500;
          pcam.position.copy(f.pos);
          pcam.quaternion.copy(f.quat);
          pcam.updateProjectionMatrix();
          pcam.updateMatrixWorld();
          m.multiplyMatrices(pcam.projectionMatrix, pcam.matrixWorldInverse);
        }
        (u.uW.value as THREE.Vector4).setComponent(k, e.peso);
        (u.uSph.value as THREE.Vector4).setComponent(k, f.esferica ? 1 : 0);
      }
      u[`uT${k}`] = { value: e?.foto.tex ?? null };
      u[`uM${k}`] = { value: m };
      u[`uP${k}`] = { value: e ? e.foto.pos.clone() : new THREE.Vector3() };
    }
    const mat = new THREE.ShaderMaterial({ vertexShader: BAKE_VERT, fragmentShader: BAKE_FRAG, uniforms: u, side: THREE.DoubleSide, depthTest: false });
    mats.push(mat);
    const quad = new THREE.Mesh(g, mat);
    quad.frustumCulled = false; // se dibuja en el espacio del atlas, no donde está la pared
    scene.add(quad);
  });

  const prevTarget = renderer.getRenderTarget();
  const prevClear = renderer.getClearColor(new THREE.Color());
  const prevAlpha = renderer.getClearAlpha();
  renderer.setRenderTarget(rt);
  renderer.setClearColor(fallback, 0);
  renderer.clear();
  renderer.render(scene, cam);
  const px = new Uint8Array(W * H * 4);
  renderer.readRenderTargetPixels(rt, 0, 0, W, H, px);
  renderer.setRenderTarget(prevTarget);
  renderer.setClearColor(prevClear, prevAlpha);
  rt.dispose();
  mats.forEach((m) => m.dispose());

  // Al canvas, de arriba hacia abajo; cuenta qué parte de las paredes tiene foto.
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(W, H);
  let con = 0;
  let total = 0;
  for (const r of rects)
    for (let y = r.y; y < r.y + r.h; y++)
      for (let x = r.x; x < r.x + r.w; x++) {
        total++;
        if (px[(y * W + x) * 4 + 3] > 127) con++;
      }
  for (let y = 0; y < H; y++) {
    const src = (H - 1 - y) * W * 4;
    for (let i = 0; i < W * 4; i += 4) {
      const a = px[src + i + 3];
      img.data[y * W * 4 + i] = a > 0 ? px[src + i] : 128;
      img.data[y * W * 4 + i + 1] = a > 0 ? px[src + i + 1] : 128;
      img.data[y * W * 4 + i + 2] = a > 0 ? px[src + i + 2] : 128;
      img.data[y * W * 4 + i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const blob = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, 'image/jpeg', 0.8));
  const textura = new THREE.CanvasTexture(canvas);
  textura.colorSpace = THREE.SRGBColorSpace;
  textura.anisotropy = 4;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(finalPos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(finalUv, 2));
  const malla = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ map: textura, side: THREE.DoubleSide }));
  return { textura, canvas, malla, bytesJpeg: blob?.size ?? 0, cobertura: total ? con / total : 0, ms: performance.now() - t0 };
}
