// Maqueta: isometric 3D view of a demo zone (buildings extruded from their footprints, streets from the
// tile ways) where the driver taps the building they're going to and picks the exact entrance.
// The chosen entrance becomes the arrival point: the route goes there and the AR/HUD marks it.
import * as THREE from 'three';
import { toLocal, type LatLon } from '../core/geo.ts';
import { buildingsIn, ENTRANCE_FALLBACK_NAME, entrancesOf, insideOutline, loadTile, type Tile, type TileBuilding, type TileEntrance, type TileWay } from '../core/maqueta.ts';
import { $, setText, toast } from '../core/ui.ts';
import type { Arrival } from '../remote/protocol.ts';
import type { Zone } from './destino.ts';

const PALETTE = {
  dark: { bg: 0x0a0a0b, gnd: 0x111214, street: 0x2a2d32, top: 0x3a3e45, left: 0x24272c, right: 0x181a1d, stop: 0x4b86f5, sleft: 0x3e6ae1, sright: 0x2a4aa8 },
  light: { bg: 0xf4f8fb, gnd: 0xe2ecf2, street: 0xffffff, top: 0xffffff, left: 0xcbd9e3, right: 0xb0c2d0, stop: 0x3b74e0, sleft: 0x1a56c4, sright: 0x123f94 },
};
const ELEV = THREE.MathUtils.degToRad(35); // camera elevation: the isometric look of the canvas
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

interface Item {
  b: TileBuilding;
  start: number; // its first vertex in the merged buildings geometry
  count: number; // and how many it has
  center: LatLon;
  letter: string | null;
}

export interface MaquetaChoice {
  arrival: Arrival; // where the pin goes: the entrance, with the building outline
  label: string; // destination name for the cards: building name or "Edificio B"
}

let renderer: THREE.WebGLRenderer | null = null;
const scene = new THREE.Scene();
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 5000);
let world = new THREE.Group();
let zoneKey = '';
let origin: LatLon = { lat: 0, lon: 0 };
let items: Item[] = [];
// Every building of the zone in one mesh, so a whole neighbourhood is one draw call; triItem maps each
// triangle back to its item for taps.
let blocks: THREE.Mesh | null = null;
let triItem: Int32Array = new Int32Array(0);
let ways: TileWay[] = [];
let selected: Item | null = null;
let entrances: TileEntrance[] = [];
let entIdx = 0;
let az = THREE.MathUtils.degToRad(45);
let scale = 0.4; // metres per CSS pixel
const target = new THREE.Vector3();
let onConfirm: (c: MaquetaChoice) => void = () => {};
let frameReq = 0;

const theme = () => PALETTE.dark;
const local = (p: LatLon) => toLocal(origin, p);

// ---------- scene ----------

/**
 * Flat colours per face, as in the canvas: top, the face turned to the camera's left, the one to its
 * right; the blue set for the selected building. Worked out on the GPU from each face's normal and the
 * camera's right, so turning the view costs nothing however many buildings there are.
 */
const blockMaterial = new THREE.ShaderMaterial({
  uniforms: {
    camRight: { value: new THREE.Vector2(1, 0) },
    top: { value: new THREE.Color() },
    left: { value: new THREE.Color() },
    right: { value: new THREE.Color() },
    stop: { value: new THREE.Color() },
    sleft: { value: new THREE.Color() },
    sright: { value: new THREE.Color() },
  },
  vertexShader: /* glsl */ `
    attribute float sel;
    uniform vec2 camRight;
    uniform vec3 top, left, right, stop, sleft, sright;
    varying vec3 vColor;
    void main() {
      bool lid = normal.y > 0.5;
      bool toRight = dot(normal.xz, camRight) > 0.0;
      vColor = mix(lid ? top : toRight ? right : left, lid ? stop : toRight ? sright : sleft, sel);
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    varying vec3 vColor;
    void main() {
      gl_FragColor = vec4(vColor, 1.0);
      #include <colorspace_fragment>
    }`,
});

function setPalette() {
  const c = theme();
  const u = blockMaterial.uniforms;
  for (const k of ['top', 'left', 'right', 'stop', 'sleft', 'sright'] as const) (u[k].value as THREE.Color).set(c[k]);
}

/** Highlights a building or clears it: only its own vertices go back to the GPU. */
function paint(item: Item) {
  if (!blocks) return;
  const sel = blocks.geometry.getAttribute('sel') as THREE.BufferAttribute;
  (sel.array as Float32Array).fill(item === selected ? 1 : 0, item.start, item.start + item.count);
  sel.addUpdateRange(item.start, item.count);
  sel.needsUpdate = true;
}

/**
 * All the buildings as walls and a flat roof, in one geometry (no floor: the camera never looks from
 * below). Built straight from the outlines, several times faster than an ExtrudeGeometry per building.
 * Returns each building's vertex range and the building of each triangle.
 */
function blocksGeometry(list: TileBuilding[]): { geometry: THREE.BufferGeometry; ranges: { start: number; count: number }[]; triItem: Int32Array } {
  const pos: number[] = [];
  const nor: number[] = [];
  const tri: number[] = [];
  const ranges: { start: number; count: number }[] = [];
  const vert = (x: number, y: number, z: number, nx: number, ny: number, nz: number) => {
    pos.push(x, y, z);
    nor.push(nx, ny, nz);
  };
  list.forEach((b, k) => {
    const start = pos.length / 3;
    const ring: { x: number; z: number }[] = [];
    for (const [lat, lon] of b.outline.slice(0, -1)) {
      const p = local({ lat, lon });
      const q = ring[ring.length - 1];
      if (!q || Math.abs(q.x - p.x) > 0.01 || Math.abs(q.z - p.z) > 0.01) ring.push(p);
    }
    let area = 0;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const c = ring[(i + 1) % ring.length];
      area += a.x * c.z - c.x * a.z;
    }
    if (ring.length < 3 || !area) {
      ranges.push({ start, count: 0 });
      return;
    }
    if (area < 0) ring.reverse(); // so (dz, -dx) of each edge points out of the building
    const h = b.height;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const c = ring[(i + 1) % ring.length];
      const len = Math.hypot(c.x - a.x, c.z - a.z);
      const nx = (c.z - a.z) / len;
      const nz = -(c.x - a.x) / len;
      // Two triangles, counter-clockwise seen from outside.
      vert(c.x, 0, c.z, nx, 0, nz);
      vert(a.x, 0, a.z, nx, 0, nz);
      vert(a.x, h, a.z, nx, 0, nz);
      vert(c.x, 0, c.z, nx, 0, nz);
      vert(a.x, h, a.z, nx, 0, nz);
      vert(c.x, h, c.z, nx, 0, nz);
      tri.push(k, k);
    }
    for (const [i, j, l] of THREE.ShapeUtils.triangulateShape(ring.map((p) => new THREE.Vector2(p.x, p.z)), [])) {
      const [p, q, r] = [ring[i], ring[j], ring[l]];
      // Facing up: counter-clockwise seen from above.
      const [m, o] = (q.z - p.z) * (r.x - p.x) - (q.x - p.x) * (r.z - p.z) > 0 ? [q, r] : [r, q];
      vert(p.x, h, p.z, 0, 1, 0);
      vert(m.x, h, m.z, 0, 1, 0);
      vert(o.x, h, o.z, 0, 1, 0);
      tri.push(k);
    }
    ranges.push({ start, count: pos.length / 3 - start });
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geometry.setAttribute('sel', new THREE.Float32BufferAttribute(new Float32Array(pos.length / 3), 1));
  geometry.computeBoundingSphere();
  return { geometry, ranges, triItem: Int32Array.from(tri) };
}

/** Streets as flat ribbons, one quad per segment plus a round-ish joint. */
function streetsMesh(list: TileWay[]): THREE.Mesh {
  const pos: number[] = [];
  for (const w of list) {
    const half = Math.max(3, ((w.lanes ?? 2) * 3.2) / 2);
    const p = w.pts.map(([lat, lon]) => local({ lat, lon }));
    for (let i = 0; i < p.length - 1; i++) {
      const a = p[i];
      const b = p[i + 1];
      const len = Math.hypot(b.x - a.x, b.z - a.z) || 1;
      const nx = (-(b.z - a.z) / len) * half;
      const nz = ((b.x - a.x) / len) * half;
      const ex = ((b.x - a.x) / len) * half * 0.5; // a little overlap hides the gaps at bends
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
  return new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: theme().street, side: THREE.DoubleSide }));
}

async function buildZone(zone: Zone) {
  const tiles = (await Promise.all(zone.tiles.map(loadTile))).filter((t): t is Tile => !!t);
  if (!tiles.length) throw new Error('No encontré la maqueta de esta zona');
  const [s, w, n, e] = zone.bbox;
  origin = { lat: (s + n) / 2, lon: (w + e) / 2 };
  scene.remove(world);
  world.traverse((o) => (o as THREE.Mesh).geometry?.dispose()); // the previous zone's, off the GPU
  world = new THREE.Group();
  const c = theme();
  scene.background = new THREE.Color(c.bg);
  setPalette();

  const sw = local({ lat: s, lon: w });
  const ne = local({ lat: n, lon: e });
  const pad = 40;
  const gw = ne.x - sw.x + pad * 2;
  const gd = sw.z - ne.z + pad * 2;
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(gw, gd), new THREE.MeshBasicMaterial({ color: c.gnd }));
  ground.rotation.x = -Math.PI / 2;
  world.add(ground);

  // Ways touching the zone, clipped by the ground's edge only visually.
  const seen = new Set<string>();
  ways = [];
  for (const t of tiles) for (const wy of t.ways) if (!seen.has(wy.id)) (seen.add(wy.id), ways.push(wy));
  const near = ways.filter((wy) => wy.pts.some(([lat, lon]) => lat > s - 0.0004 && lat < n + 0.0004 && lon > w - 0.0004 && lon < e + 0.0004));
  world.add(streetsMesh(near));

  const list = buildingsIn(tiles, zone.bbox);
  const merged = blocksGeometry(list);
  selected = null; // belonged to the previous zone's geometry
  triItem = merged.triItem;
  blocks = new THREE.Mesh(merged.geometry, blockMaterial);
  world.add(blocks);
  items = list.map((b, k) => {
    let lat = 0;
    let lon = 0;
    const ring = b.outline.slice(0, -1);
    for (const [a, o] of ring) (lat += a), (lon += o);
    return { b, ...merged.ranges[k], center: { lat: lat / ring.length, lon: lon / ring.length }, letter: null };
  });
  scene.add(world);
  scale = Math.max(gw, gd) / Math.min(innerWidth, innerHeight) / 1.15;
  target.set(0, 0, 0);
}

// ---------- camera and drawing ----------

/** Where the middle of the free area (between the header and the card) is, in px from the top. */
function freeCenter(h: number): number {
  const head = $('scrMaqueta').querySelector('.mqHead')!.getBoundingClientRect().bottom;
  const card = $('mqCard').getBoundingClientRect().top;
  return card > head + 80 ? (head + card) / 2 : h / 2;
}

function placeCamera() {
  const w = innerWidth;
  const h = innerHeight;
  const yc = freeCenter(h);
  camera.left = (-w / 2) * scale;
  camera.right = (w / 2) * scale;
  camera.top = yc * scale;
  camera.bottom = -(h - yc) * scale;
  const dir = new THREE.Vector3(Math.sin(az) * Math.cos(ELEV), Math.sin(ELEV), Math.cos(az) * Math.cos(ELEV));
  camera.position.copy(target).addScaledVector(dir, 1500);
  camera.up.set(0, 1, 0);
  camera.lookAt(target);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(); // groundAt and toScreen need the new pose before the next render
}

function toScreen(p: LatLon, y = 0): { x: number; y: number } {
  const l = local(p);
  const v = new THREE.Vector3(l.x, y, l.z).project(camera);
  return { x: ((v.x + 1) / 2) * innerWidth, y: ((1 - v.y) / 2) * innerHeight };
}

function drawLabels() {
  const box = $('mqLabels');
  box.textContent = '';
  for (const it of items) {
    if (!it.letter) continue;
    const s = toScreen(it.center, it.b.height + 2);
    const el = document.createElement('div');
    el.className = 'mqBadge';
    el.textContent = it.letter;
    el.style.left = `${s.x}px`;
    el.style.top = `${s.y}px`;
    box.appendChild(el);
  }
  entrances.forEach((en, i) => {
    const s = toScreen(en, 0.5);
    const pin = document.createElement('div');
    pin.className = `mqPin${i === entIdx ? ' on' : ''}`;
    pin.style.left = `${s.x}px`;
    pin.style.top = `${s.y}px`;
    box.appendChild(pin);
    if (i === entIdx && selected) {
      const tag = document.createElement('div');
      tag.className = 'mqPinLabel';
      tag.textContent = `${en.name} · Edif. ${selected.letter}`;
      tag.style.left = `${s.x}px`;
      tag.style.top = `${s.y}px`;
      box.appendChild(tag);
    }
  });
}

let paintedAz = NaN;

function render() {
  frameReq = 0;
  if (!renderer || $('scrMaqueta').hidden) return;
  if (az !== paintedAz) {
    paintedAz = az; // face shading depends on which side faces the camera
    (blockMaterial.uniforms.camRight.value as THREE.Vector2).set(Math.cos(az), -Math.sin(az));
    $('mqNorth').style.transform = `rotate(${THREE.MathUtils.radToDeg(az)}deg)`;
  }
  const w = innerWidth;
  const h = innerHeight;
  const size = renderer.getSize(new THREE.Vector2());
  if (size.x !== w || size.y !== h) renderer.setSize(w, h);
  placeCamera();
  renderer.render(scene, camera);
  drawLabels();
}
const redraw = () => (frameReq ||= requestAnimationFrame(render));

// ---------- selection ----------

function nextLetter(): string {
  const used = new Set(items.map((i) => i.letter));
  return [...LETTERS].find((l) => !used.has(l)) ?? '•';
}

function select(item: Item | null) {
  const prev = selected;
  selected = item;
  if (prev) paint(prev);
  if (!item) {
    entrances = [];
    renderCard();
    return redraw();
  }
  item.letter ??= nextLetter();
  paint(item);
  entrances = entrancesOf(item.b, ways);
  entIdx = 0;
  renderCard();
  redraw();
}

const buildingName = (it: Item) => `Edificio ${it.letter}${it.b.name ? ` · ${it.b.name}` : ''}`;

function renderCard() {
  const chips = $('mqChips');
  chips.textContent = '';
  const go = $<HTMLButtonElement>('mqGo');
  if (!selected) {
    setText('mqTitle', 'Toca un edificio');
    setText('mqSub', 'Elige el punto exacto de llegada');
    go.disabled = true;
    return;
  }
  setText('mqTitle', buildingName(selected));
  const fallback = entrances.length === 1 && entrances[0].name === ENTRANCE_FALLBACK_NAME;
  setText('mqSub', !entrances.length ? 'No hay calle cerca para llegar a este edificio' : fallback ? 'Sin entradas registradas: llegas frente al edificio' : 'Elige el punto exacto de llegada');
  entrances.forEach((en, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = en.name;
    b.setAttribute('aria-pressed', String(i === entIdx));
    b.onclick = () => {
      entIdx = i;
      renderCard();
      redraw();
    };
    chips.appendChild(b);
  });
  go.disabled = !entrances.length;
}

function pick(clientX: number, clientY: number) {
  const ray = new THREE.Raycaster();
  ray.setFromCamera(new THREE.Vector2((clientX / innerWidth) * 2 - 1, -(clientY / innerHeight) * 2 + 1), camera);
  const hit = blocks && ray.intersectObject(blocks, false)[0];
  if (hit?.faceIndex != null) select(items[triItem[hit.faceIndex]]);
}

// ---------- gestures: like a maps app ----------
// One finger or the mouse drags the ground. Two fingers pinch, twist and drag at once, anchored where
// they are. A Mac trackpad pinches and twists too (Safari); in other browsers a sideways two-finger
// swipe turns it. With the mouse: Ctrl/⌘/⌥/⇧ + drag, or the right button, turns it.

const ROTATE_PER_PX = 0.005; // rad per pixel of a turning drag (~0.3°) or sideways swipe
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const ray = new THREE.Raycaster();

/** The point on the ground (y = 0) under a screen position, for the camera as it is now. */
function groundAt(x: number, y: number): THREE.Vector3 {
  ray.setFromCamera(new THREE.Vector2((x / innerWidth) * 2 - 1, -(y / innerHeight) * 2 + 1), camera);
  return ray.ray.intersectPlane(groundPlane, new THREE.Vector3()) ?? target.clone();
}

/**
 * Turns by `dAz` and zooms by `k` (metres per pixel × k), keeping the ground that was under (x, y)
 * under (nx, ny): the content follows the fingers, the cursor or the trackpad.
 */
function transformAt(x: number, y: number, dAz: number, k: number, nx = x, ny = y) {
  placeCamera();
  const before = groundAt(x, y);
  az += dAz;
  scale = Math.min(3, Math.max(0.05, scale * k));
  placeCamera();
  target.add(before.sub(groundAt(nx, ny)));
  redraw();
}

/** Middle of the free area, where the button turns and the compass pivots. */
const viewCenter = () => ({ x: innerWidth / 2, y: freeCenter(innerHeight) });

let spin = 0;
/** Turns smoothly to `to` (radians) around the middle of the view. */
function turnTo(to: number) {
  cancelAnimationFrame(spin);
  const from = az;
  const t0 = performance.now();
  const step = (now: number) => {
    const t = Math.min(1, (now - t0) / 350);
    const e = 1 - (1 - t) ** 3;
    const c = viewCenter();
    transformAt(c.x, c.y, from + (to - from) * e - az, 1);
    if (t < 1) spin = requestAnimationFrame(step);
  };
  spin = requestAnimationFrame(step);
}

function bindGestures(el: HTMLElement) {
  const pts = new Map<number, { x: number; y: number }>();
  let downAt = { x: 0, y: 0, t: 0 };
  let moved = 0;
  let turning = false; // this drag turns the view instead of moving it
  const pair = () => {
    const [a, b] = [...pts.values()];
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y), ang: Math.atan2(b.y - a.y, b.x - a.x) };
  };
  el.addEventListener('pointerdown', (e) => {
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic or already released pointer */
    }
    cancelAnimationFrame(spin);
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 1) {
      downAt = { x: e.clientX, y: e.clientY, t: performance.now() };
      moved = 0;
      turning = e.button === 2 || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey;
    }
  });
  el.addEventListener('pointermove', (e) => {
    const p = pts.get(e.pointerId);
    if (!p) return;
    if (pts.size === 1) {
      const dx = e.clientX - p.x;
      const dy = e.clientY - p.y;
      moved += Math.abs(dx) + Math.abs(dy);
      if (turning) {
        const c = viewCenter();
        transformAt(c.x, c.y, -dx * ROTATE_PER_PX, 1);
      } else transformAt(p.x, p.y, 0, 1, e.clientX, e.clientY);
      p.x = e.clientX;
      p.y = e.clientY;
    } else if (pts.size === 2) {
      moved = 99;
      const a = pair();
      p.x = e.clientX;
      p.y = e.clientY;
      const b = pair();
      // Twisting the fingers clockwise turns the ground clockwise with them.
      let dAng = b.ang - a.ang;
      if (dAng > Math.PI) dAng -= 2 * Math.PI;
      if (dAng < -Math.PI) dAng += 2 * Math.PI;
      transformAt(a.x, a.y, dAng, b.d > 0 ? a.d / b.d : 1, b.x, b.y);
    }
  });
  const up = (e: PointerEvent) => {
    pts.delete(e.pointerId);
  };
  // A tap (no drag) selects: the browser's click covers mouse and touch alike.
  el.addEventListener('click', (e) => {
    if (moved < 8 && performance.now() - downAt.t < 600) pick(e.clientX, e.clientY);
  });
  el.addEventListener('contextmenu', (e) => e.preventDefault()); // the right button turns the view
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  el.addEventListener('wheel', (e) => {
    e.preventDefault();
    cancelAnimationFrame(spin);
    const px = e.deltaMode === 1 ? 16 : 1; // lines → pixels
    if (e.ctrlKey) transformAt(e.clientX, e.clientY, 0, Math.exp(e.deltaY * px * 0.01)); // trackpad pinch
    else if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) transformAt(e.clientX, e.clientY, e.deltaX * px * ROTATE_PER_PX * 0.5, 1); // sideways swipe, or ⇧ + wheel
    else transformAt(e.clientX, e.clientY, 0, Math.exp(e.deltaY * px * 0.0015));
  }, { passive: false });
  // Safari on a Mac trackpad: pinch and twist arrive as gesture events (iOS sends them too, along
  // with the touches the pointer events above already handle, so those are skipped).
  let last = { scale: 1, rotation: 0 };
  type Gesture = Event & { scale: number; rotation: number; clientX: number; clientY: number };
  el.addEventListener('gesturestart', (e) => {
    e.preventDefault();
    cancelAnimationFrame(spin);
    last = { scale: 1, rotation: 0 };
  });
  el.addEventListener('gesturechange', (ev) => {
    ev.preventDefault();
    if (pts.size > 1) return;
    const e = ev as Gesture;
    transformAt(e.clientX, e.clientY, THREE.MathUtils.degToRad(e.rotation - last.rotation), e.scale > 0 ? last.scale / e.scale : 1);
    last = { scale: e.scale, rotation: e.rotation };
  });
  el.addEventListener('gestureend', (e) => e.preventDefault());
}

// ---------- public ----------

/**
 * Loads the zone (once) and preselects the building at or nearest to the destination.
 * The caller then shows the screen. Rejects when the zone has no tiles.
 */
export async function prepareMaqueta(zone: Zone, dest: LatLon) {
  if (!renderer) {
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(2, devicePixelRatio));
    $('mqView').appendChild(renderer.domElement);
    bindGestures(renderer.domElement);
  }
  if (zoneKey !== zone.name) {
    await buildZone(zone);
    zoneKey = zone.name;
  }
  // Letters for the buildings around the destination, nearest first, like the canvas (A–E).
  const d = local(dest);
  const byDist = [...items].sort((a, b) => {
    const pa = local(a.center);
    const pb = local(b.center);
    return Math.hypot(pa.x - d.x, pa.z - d.z) - Math.hypot(pb.x - d.x, pb.z - d.z);
  });
  items.forEach((i) => (i.letter = null));
  byDist.slice(0, 5).forEach((it, k) => (it.letter = LETTERS[k]));
  const inside = items.find((i) => insideOutline(i.b.outline, dest));
  paintedAz = NaN;
  select(inside ?? byDist[0] ?? null);
  const at = selected ? local(selected.center) : d;
  target.set(at.x, 0, at.z);
  scale = Math.min(scale, 0.35);
  // How to turn it, for the way this device is driven.
  const touch = matchMedia('(pointer: coarse)').matches;
  setText('mqZone', touch ? 'Toca un edificio · gira con dos dedos' : 'Toca un edificio · Ctrl + arrastrar para girar');
}

/** Call after the screen becomes visible (and on resize) so the canvas fits it. */
export const showMaqueta = () => redraw();

export function initMaqueta(confirm: (c: MaquetaChoice) => void) {
  onConfirm = confirm;
  if (import.meta.env.DEV) (window as unknown as { __mq: unknown }).__mq = { items: () => items, camera, pick, toScreen, groundAt, transformAt, az: () => az };
  $('mqRotate').onclick = () => turnTo(az + Math.PI / 2);
  // The compass needle points north; tapping it turns north back up (the shortest way round).
  $('mqCompass').onclick = () => turnTo(az - Math.atan2(Math.sin(az), Math.cos(az)));
  $('mqGo').onclick = () => {
    if (!selected || !entrances[entIdx]) return toast('Toca un edificio primero');
    const en = entrances[entIdx];
    onConfirm({
      arrival: { lat: en.lat, lon: en.lon, label: `Edif. ${selected.letter} · ${en.name}`, outline: selected.b.outline, height: selected.b.height },
      label: selected.b.name ?? `Edificio ${selected.letter}`,
    });
  };
  addEventListener('resize', redraw);
  matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
    zoneKey = ''; // rebuilt with the other palette next time it opens
  });
}
