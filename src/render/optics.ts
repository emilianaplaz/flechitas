// Windshield HUD optics: the iPad lies on the dashboard and the driver sees its screen reflected in
// the windshield, over the road. Works out where on the iPad each road point must be drawn so that,
// seen from the driver's eye through the glass, it sits on the real road: perspective, the mirror
// and the keystone of the tilted reflection all come out of the geometry. Pure maths (Three.js math
// classes only), unit-tested in tests/run.ts.
//
// Car frame: metres, Three.js axes, origin on the road under the driver's eye; +x right, +y up,
// +z backward (forward is -z), same as the AR scene's local frame once rotated to the heading.
import { Matrix4, Vector3 } from 'three';

export type TopEdge = 'driver' | 'glass';

export interface HudGeometry {
  eyeHeight: number; // driver's eye above the road
  dashHeight: number; // iPad screen surface above the road
  glassBase: number; // horizontal distance from the eye to where the windshield meets the dash
  rake: number; // windshield angle from horizontal, degrees
  screenAhead: number; // horizontal distance from the eye to the iPad screen centre
  screenLateral: number; // iPad centre to the right (+) of the eye
  topEdge: TopEdge; // which way the iPad's top edge (canvas top, landscape) points
  cssPxPerInch: number; // 132 for iPads in CSS pixels (264 ppi / 2); 163 for iPad mini
  hoodDeg: number; // hood line, degrees below the horizon (road nearer than this is hidden)
  eyeDx: number; // fine alignment: eye to the right (+), m
  eyeDy: number; // fine alignment: eye higher (+), m
}

/**
 * Toyota Fortuner 2015, estimated (no official seat/glass figures found): replace with tape
 * measurements in the HUD setup. iPad centre 34 cm back from the windshield base puts the picture on
 * the road from ~10 m to the horizon, just above the hood.
 */
export const FORTUNER_2015: HudGeometry = {
  eyeHeight: 1.5,
  dashHeight: 1.12,
  glassBase: 1.05,
  rake: 33,
  screenAhead: 0.71,
  screenLateral: 0,
  topEdge: 'driver',
  cssPxPerInch: 132,
  hoodDeg: 9.9,
  eyeDx: 0,
  eyeDy: 0,
};

export interface Optics {
  g: HudGeometry;
  cssW: number;
  cssH: number;
  mpp: number; // metres per CSS pixel on the iPad screen
  eye: Vector3; // E
  mirrorEye: Vector3; // E' = Refl(E)
  glassPoint: Vector3; // G, a point on the windshield (its base on the dash)
  glassNormal: Vector3; // n, into the cabin
  refl: Matrix4; // reflection across the windshield plane (det -1, its own inverse)
  u: Vector3; // canvas right on the physical screen
  v: Vector3; // canvas up on the physical screen
  pa: Vector3; // physical screen corners: canvas bottom-left, bottom-right, top-left
  pb: Vector3;
  pc: Vector3;
  centre: Vector3; // physical screen centre
}

const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

/** Reflection across the plane through `p` with unit normal `n`: x -> x - 2((x - p)·n) n. */
export function reflectMatrix(p: Vector3, n: Vector3): Matrix4 {
  const d = p.dot(n);
  const { x, y, z } = n;
  // prettier-ignore
  return new Matrix4().set(
    1 - 2 * x * x, -2 * x * y, -2 * x * z, 2 * d * x,
    -2 * x * y, 1 - 2 * y * y, -2 * y * z, 2 * d * y,
    -2 * x * z, -2 * y * z, 1 - 2 * z * z, 2 * d * z,
    0, 0, 0, 1,
  );
}

export function buildOptics(g: HudGeometry, cssW: number, cssH: number): Optics {
  const mpp = 0.0254 / g.cssPxPerInch;
  const eye = new Vector3(g.eyeDx, g.eyeHeight + g.eyeDy, 0);
  const a = rad(g.rake);
  const glassPoint = new Vector3(0, g.dashHeight, -g.glassBase);
  const glassNormal = new Vector3(0, -Math.cos(a), Math.sin(a)); // the glass rises toward the driver
  const refl = reflectMatrix(glassPoint, glassNormal);
  const centre = new Vector3(g.screenLateral, g.dashHeight, -g.screenAhead);
  // Lying flat, landscape. Top edge to the driver: canvas up = backward, canvas right = car's left.
  const u = g.topEdge === 'driver' ? new Vector3(-1, 0, 0) : new Vector3(1, 0, 0);
  const v = g.topEdge === 'driver' ? new Vector3(0, 0, 1) : new Vector3(0, 0, -1);
  const w = cssW * mpp;
  const h = cssH * mpp;
  const pa = centre.clone().addScaledVector(u, -w / 2).addScaledVector(v, -h / 2);
  const pb = pa.clone().addScaledVector(u, w);
  const pc = pa.clone().addScaledVector(v, h);
  return { g, cssW, cssH, mpp, eye, mirrorEye: eye.clone().applyMatrix4(refl), glassPoint, glassNormal, refl, u, v, pa, pb, pc, centre };
}

/** Kooima's generalised perspective: an eye looking at a rectangle (bottom-left pa, bottom-right pb, top-left pc). */
function offAxis(eye: Vector3, pa: Vector3, pb: Vector3, pc: Vector3, near: number, far: number) {
  const vr = pb.clone().sub(pa).normalize();
  const vu = pc.clone().sub(pa).normalize();
  const vn = new Vector3().crossVectors(vr, vu).normalize();
  const va = pa.clone().sub(eye);
  const vb = pb.clone().sub(eye);
  const vc = pc.clone().sub(eye);
  const d = -va.dot(vn);
  if (d <= 0) throw new Error('optics: the eye is behind the screen');
  const k = near / d;
  const projection = new Matrix4().makePerspective(vr.dot(va) * k, vr.dot(vb) * k, vu.dot(vc) * k, vu.dot(va) * k, near, far);
  const matrixWorld = new Matrix4().makeBasis(vr, vu, vn).setPosition(eye);
  return { projection, matrixWorld };
}

/**
 * The camera for the iPad canvas. The driver at E looking at the reflected screen sees what a camera
 * at E' = Refl(E) sees looking at the real screen, if the world is reflected too: render the scene
 * with `refl · worldToCar` as its root matrix through this camera.
 */
export function mirrorCamera(o: Optics, near = 0.3, far = 3000) {
  return offAxis(o.mirrorEye, o.pa, o.pb, o.pc, near, far);
}

/** Debug: what the driver sees in the reflection, unmirrored (world not reflected). */
export function driverCamera(o: Optics, near = 0.3, far = 3000) {
  const [a, b, c] = [o.pa, o.pb, o.pc].map((p) => p.clone().applyMatrix4(o.refl));
  // The reflection swaps handedness: order the corners so the rectangle faces the eye, driver's right to the right.
  const n = new Vector3().crossVectors(b.clone().sub(a), c.clone().sub(a));
  if (n.dot(o.eye.clone().sub(a)) >= 0) return offAxis(o.eye, a, b, c, near, far);
  return offAxis(o.eye, b, a, b.clone().add(c).sub(a), near, far);
}

/** CSS pixel of a point on the physical screen. */
function screenToCss(o: Optics, q: Vector3): { x: number; y: number } {
  const local = q.clone().sub(o.pa);
  return { x: local.dot(o.u) / o.mpp, y: o.cssH - local.dot(o.v) / o.mpp };
}

/**
 * Where on the canvas a car-frame point must be drawn to be seen over it, by ray tracing (independent
 * of the matrices, used to test them): eye -> point, meet the reflected screen plane, reflect back.
 */
export function worldToCss(o: Optics, p: Vector3): { x: number; y: number } | null {
  const virtCentre = o.centre.clone().applyMatrix4(o.refl);
  const screenNormal = new Vector3().crossVectors(o.u, o.v);
  const virtNormal = screenNormal.clone().sub(o.glassNormal.clone().multiplyScalar(2 * screenNormal.dot(o.glassNormal)));
  const dir = p.clone().sub(o.eye);
  const denom = dir.dot(virtNormal);
  if (Math.abs(denom) < 1e-9) return null;
  const t = virtCentre.clone().sub(o.eye).dot(virtNormal) / denom;
  if (t <= 0) return null;
  const hit = o.eye.clone().addScaledVector(dir, t).applyMatrix4(o.refl);
  return screenToCss(o, hit);
}

const angleBelowHorizon = (o: Optics, p: Vector3) => {
  const d = p.clone().sub(o.eye);
  return deg(Math.atan2(d.y, Math.hypot(d.x, d.z)));
};

export interface VirtualImage {
  distance: number; // m from the eye to the reflected screen centre
  centreDeg: number; // + above the horizon
  lowDeg: number; // lowest and highest edge of the picture, degrees from the horizon
  highDeg: number;
  widthDeg: number;
  tiltDeg: number; // the reflected screen's angle from horizontal
  incidenceDeg: number; // at the glass, for the central ray (Brewster ≈ 56°)
  roadFrom: number; // road distances covered, m (Infinity above the horizon)
  roadTo: number;
  hoodClear: boolean; // the lowest edge is above the hood line
}

export function virtualImage(o: Optics): VirtualImage {
  const R = (p: Vector3) => p.clone().applyMatrix4(o.refl);
  const corners = [o.pa, o.pb, o.pc, o.pb.clone().add(o.pc).sub(o.pa)].map(R);
  const angles = corners.map((c) => angleBelowHorizon(o, c));
  const vc = R(o.centre);
  const dir = vc.clone().sub(o.eye);
  const distance = dir.length();
  const lowDeg = Math.min(...angles);
  const highDeg = Math.max(...angles);
  const road = (a: number) => (a < 0 ? o.g.eyeHeight / Math.tan(rad(-a)) : Infinity);
  const az = corners.map((c) => deg(Math.atan2(c.x - o.eye.x, -(c.z - o.eye.z))));
  const vv = R(o.centre.clone().add(o.v)).sub(vc);
  const vu = R(o.centre.clone().add(o.u)).sub(vc);
  const planeDir = Math.abs(vv.y) > Math.abs(vu.y) ? vv : vu; // the reflected screen axis that isn't horizontal
  return {
    distance,
    centreDeg: angleBelowHorizon(o, vc),
    lowDeg,
    highDeg,
    widthDeg: Math.max(...az) - Math.min(...az),
    tiltDeg: Math.abs(deg(Math.atan2(planeDir.y, Math.hypot(planeDir.x, planeDir.z)))),
    incidenceDeg: deg(Math.acos(Math.abs(dir.clone().normalize().dot(o.glassNormal)))),
    roadFrom: road(lowDeg),
    roadTo: road(highDeg),
    hoodClear: lowDeg > -o.g.hoodDeg,
  };
}

/** 3×3 homography (row-major) taking the 4 points `src` to `dst`. */
function homography(src: { x: number; y: number }[], dst: { x: number; y: number }[]): number[] {
  const A: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i];
    const { x: X, y: Y } = dst[i];
    A.push([x, y, 1, 0, 0, 0, -X * x, -X * y]);
    b.push(X);
    A.push([0, 0, 0, x, y, 1, -Y * x, -Y * y]);
    b.push(Y);
  }
  // Gaussian elimination with partial pivoting on the 8×8 system.
  for (let c = 0; c < 8; c++) {
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    [b[c], b[p]] = [b[p], b[c]];
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k < 8; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  const h = b.map((v, i) => v / A[i][i]);
  return [...h, 1];
}

/** Applies a 3×3 row-major homography to a point. */
export function applyHomography(h: number[], p: { x: number; y: number }): { x: number; y: number } {
  const w = h[6] * p.x + h[7] * p.y + h[8];
  return { x: (h[0] * p.x + h[1] * p.y + h[2]) / w, y: (h[3] * p.x + h[4] * p.y + h[5]) / w };
}

/**
 * Screen-space text (speed, next turn) that reads upright and undistorted in the glass. The CSS box
 * `cssW × cssH` is laid out as usual; this returns the homography from that box to where it must be
 * drawn, as a row-major 3×3 and as a CSS `matrix3d` (transform-origin 0 0). The box is fitted, at
 * `fill` of the size, inside the reflected screen as the driver sees it.
 */
export function panelTransform(o: Optics, fill = 0.9): { h: number[]; css: string } {
  // The driver's view plane: through the reflected screen centre, facing the eye, axes = driver's right and up.
  const vc = o.centre.clone().applyMatrix4(o.refl);
  const fwd = vc.clone().sub(o.eye).normalize();
  const right = new Vector3().crossVectors(fwd, new Vector3(0, 1, 0)).normalize();
  const up = new Vector3().crossVectors(right, fwd).normalize();
  const dist = vc.clone().sub(o.eye).length();
  // Reflected screen corners seen from the eye, projected onto that plane (2D, metres).
  const toPlane = (p: Vector3) => {
    const d = p.clone().sub(o.eye);
    const s = dist / d.dot(fwd);
    return { x: d.dot(right) * s, y: d.dot(up) * s };
  };
  const quad = [o.pa, o.pb, o.pb.clone().add(o.pc).sub(o.pa), o.pc].map((p) => toPlane(p.clone().applyMatrix4(o.refl)));
  const cx = quad.reduce((s, q) => s + q.x, 0) / 4;
  const cy = quad.reduce((s, q) => s + q.y, 0) / 4;
  // Largest box with the CSS aspect, centred, that fits inside the (keystoned) quad.
  const inside = (x: number, y: number) => {
    let sign = 0;
    for (let i = 0; i < 4; i++) {
      const a = quad[i];
      const b = quad[(i + 1) % 4];
      const c = (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
      if (c !== 0) {
        if (sign === 0) sign = Math.sign(c);
        else if (Math.sign(c) !== sign) return false;
      }
    }
    return true;
  };
  const aspect = o.cssW / o.cssH;
  let lo = 0;
  let hi = 10;
  for (let i = 0; i < 40; i++) {
    const m = (lo + hi) / 2;
    const hw = (m * aspect) / 2;
    const hh = m / 2;
    const ok = [-1, 1].every((sx) => [-1, 1].every((sy) => inside(cx + sx * hw, cy + sy * hh)));
    if (ok) lo = m;
    else hi = m;
  }
  const hh = (lo * fill) / 2;
  const hw = hh * aspect;
  // Box corners (CSS: top-left, top-right, bottom-right, bottom-left) -> plane -> eye ray -> canvas.
  const corners = [
    [-hw, hh],
    [hw, hh],
    [hw, -hh],
    [-hw, -hh],
  ].map(([x, y]) => {
    const p = o.eye.clone().addScaledVector(fwd, dist).addScaledVector(right, cx + x).addScaledVector(up, cy + y);
    // A point on the driver's sight line: extend it far enough that worldToCss meets the reflected screen.
    return worldToCss(o, o.eye.clone().addScaledVector(p.sub(o.eye), 10))!;
  });
  const src = [
    { x: 0, y: 0 },
    { x: o.cssW, y: 0 },
    { x: o.cssW, y: o.cssH },
    { x: 0, y: o.cssH },
  ];
  const h = homography(src, corners);
  // CSS matrix3d is column-major 4×4; the homography acts on (x, y, 1) -> (X, Y, W).
  const css = `matrix3d(${[h[0], h[3], 0, h[6], h[1], h[4], 0, h[7], 0, 0, 1, 0, h[2], h[5], 0, h[8]].map((v) => +v.toFixed(9)).join(',')})`;
  return { h, css };
}

export interface Placement {
  screenAhead: number; // where the iPad centre should be, m ahead of the eye
  fromGlassBase: number; // the same, measured back from the windshield base (what you tape)
  centreDeg: number;
  image: VirtualImage;
}

/**
 * Where to put the iPad so its reflection is centred `targetDeg` from the horizon (road ~20 m ahead
 * for -4°). Searches the iPad's distance from the windshield base.
 */
export function placementAdvice(g: HudGeometry, cssW: number, cssH: number, targetDeg = -4): Placement {
  const depth = (cssH * 0.0254) / g.cssPxPerInch;
  let best: Placement | null = null;
  for (let ahead = 0.3; ahead <= g.glassBase - depth / 2; ahead += 0.0025) {
    const img = virtualImage(buildOptics({ ...g, screenAhead: ahead }, cssW, cssH));
    if (!best || Math.abs(img.centreDeg - targetDeg) < Math.abs(best.centreDeg - targetDeg)) {
      best = { screenAhead: ahead, fromGlassBase: g.glassBase - ahead, centreDeg: img.centreDeg, image: img };
    }
  }
  return best!;
}
