// Maqueta: isometric 3D view of a demo zone (buildings extruded from their footprints, streets from the
// tile ways) where the driver taps the building they're going to and picks the exact entrance.
// The chosen entrance becomes the arrival point: the route goes there and the AR/HUD marks it.
import * as THREE from 'three';
import { fromLocal, toLocal, type LatLon } from '../core/geo.ts';
import { buildingsIn, ENTRANCE_FALLBACK_NAME, entrancesOf, insideOutline, loadTile, type Tile, type TileBuilding, type TileEntrance, type TileWay } from '../core/maqueta.ts';
import { $, setText, toast } from '../core/ui.ts';
import { fetchRoutes, formatDistance, type Route } from '../core/route.ts';
import type { Arrival } from '../remote/protocol.ts';
import type { Zone } from './destino.ts';

const PALETTE = {
  dark: { bg: 0x0a0a0b, gnd: 0x111214, street: 0x2a2d32, top: 0x3a3e45, left: 0x24272c, right: 0x181a1d, stop: 0x4b86f5, sleft: 0x3e6ae1, sright: 0x2a4aa8, alt: 0x6b7482 },
  light: { bg: 0xf4f8fb, gnd: 0xe2ecf2, street: 0xffffff, top: 0xffffff, left: 0xcbd9e3, right: 0xb0c2d0, stop: 0x3b74e0, sleft: 0x1a56c4, sright: 0x123f94, alt: 0x8aa0b4 },
};
const ELEV = THREE.MathUtils.degToRad(35); // camera elevation: the isometric look of the canvas
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

interface Item {
  b: TileBuilding;
  mesh: THREE.Mesh;
  center: LatLon;
  letter: string | null;
}

export interface MaquetaChoice {
  arrival: Arrival; // where the pin goes: the entrance, with the building outline
  route: Route | null; // the route picked among the alternatives
  label: string; // destination name for the cards: building name or "Edificio B"
}

let renderer: THREE.WebGLRenderer | null = null;
const scene = new THREE.Scene();
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 5000);
let world = new THREE.Group();
let zoneKey = '';
let origin: LatLon = { lat: 0, lon: 0 };
let items: Item[] = [];
let ways: TileWay[] = [];
let selected: Item | null = null;
let entrances: TileEntrance[] = [];
let entIdx = 0;
let az = THREE.MathUtils.degToRad(45);
let scale = 0.4; // metres per CSS pixel
const target = new THREE.Vector3();
let half = { x: 0, z: 0 }; // half extent of the ground, local metres
const routeGroup = new THREE.Group();
let routeSeq = 0;
let routeStart: { at: LatLon; far: boolean } | null = null; // where the drawn route begins; far: it began outside the zone
let startPt: LatLon | null = null;
let fitted = false;
let onConfirm: (c: MaquetaChoice) => void = () => {};
let frameReq = 0;

const theme = () => PALETTE.dark;
const local = (p: LatLon) => toLocal(origin, p);

// ---------- scene ----------

/** Flat colours per face, as in the canvas: top, the face turned to the camera's left, the one to its right. */
function paint(item: Item) {
  const c = theme();
  const on = item === selected;
  const top = new THREE.Color(on ? c.stop : c.top);
  const left = new THREE.Color(on ? c.sleft : c.left);
  const right = new THREE.Color(on ? c.sright : c.right);
  const g = item.mesh.geometry;
  const n = g.getAttribute('normal');
  const col = g.getAttribute('color') as THREE.BufferAttribute;
  const rx = Math.cos(az);
  const rz = -Math.sin(az); // camera right on the ground
  for (let i = 0; i < n.count; i++) {
    const ny = n.getY(i);
    const k = ny > 0.5 ? top : n.getX(i) * rx + n.getZ(i) * rz > 0 ? right : left;
    col.setXYZ(i, k.r, k.g, k.b);
  }
  col.needsUpdate = true;
}

function buildingMesh(b: TileBuilding): THREE.Mesh {
  const pts = b.outline.map(([lat, lon]) => local({ lat, lon }));
  const shape = new THREE.Shape(pts.map((p) => new THREE.Vector2(p.x, -p.z)));
  let g: THREE.BufferGeometry = new THREE.ExtrudeGeometry(shape, { depth: b.height, bevelEnabled: false });
  g.rotateX(-Math.PI / 2);
  g = g.toNonIndexed();
  g.computeVertexNormals();
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(g.getAttribute('position').count * 3), 3));
  return new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true }));
}

/** A polyline on the ground (local metres) as flat quads of half-width `half`, one per segment. */
function pushRibbon(pos: number[], p: { x: number; z: number }[], half: number, y: number) {
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
    for (const k of [0, 1, 2, 0, 2, 3]) pos.push(q[k][0], y, q[k][1]);
  }
}

function ribbonMesh(pos: number[], mat: THREE.Material): THREE.Mesh {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  return new THREE.Mesh(g, mat);
}

/** Streets as flat ribbons. */
function streetsMesh(list: TileWay[]): THREE.Mesh {
  const pos: number[] = [];
  for (const w of list) pushRibbon(pos, w.pts.map(([lat, lon]) => local({ lat, lon })), Math.max(3, ((w.lanes ?? 2) * 3.2) / 2), 0.05);
  return ribbonMesh(pos, new THREE.MeshBasicMaterial({ color: theme().street, side: THREE.DoubleSide }));
}

async function buildZone(zone: Zone) {
  const tiles = (await Promise.all(zone.tiles.map(loadTile))).filter((t): t is Tile => !!t);
  if (!tiles.length) throw new Error('No encontré la maqueta de esta zona');
  const [s, w, n, e] = zone.bbox;
  origin = { lat: (s + n) / 2, lon: (w + e) / 2 };
  scene.remove(world);
  world = new THREE.Group();
  const c = theme();
  scene.background = new THREE.Color(c.bg);

  const sw = local({ lat: s, lon: w });
  const ne = local({ lat: n, lon: e });
  const pad = 40;
  const gw = ne.x - sw.x + pad * 2;
  const gd = sw.z - ne.z + pad * 2;
  half = { x: gw / 2, z: gd / 2 };
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(gw, gd), new THREE.MeshBasicMaterial({ color: c.gnd }));
  ground.rotation.x = -Math.PI / 2;
  world.add(ground);

  // Ways touching the zone, clipped by the ground's edge only visually.
  const seen = new Set<string>();
  ways = [];
  for (const t of tiles) for (const wy of t.ways) if (!seen.has(wy.id)) (seen.add(wy.id), ways.push(wy));
  const near = ways.filter((wy) => wy.pts.some(([lat, lon]) => lat > s - 0.0004 && lat < n + 0.0004 && lon > w - 0.0004 && lon < e + 0.0004));
  world.add(streetsMesh(near));

  items = buildingsIn(tiles, zone.bbox).map((b) => {
    let lat = 0;
    let lon = 0;
    const ring = b.outline.slice(0, -1);
    for (const [a, o] of ring) (lat += a), (lon += o);
    const item: Item = { b, mesh: buildingMesh(b), center: { lat: lat / ring.length, lon: lon / ring.length }, letter: null };
    item.mesh.userData.item = item;
    world.add(item.mesh);
    return item;
  });
  scene.add(world);
  scene.add(routeGroup);
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
  if (routeStart) {
    const s = toScreen(routeStart.at, 0.5);
    const start = document.createElement('div');
    start.className = 'mqStart';
    start.textContent = routeStart.far ? 'Entras a la zona' : 'Salida';
    start.style.left = `${s.x}px`;
    start.style.top = `${s.y}px`;
    box.appendChild(start);
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
    items.forEach(paint);
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

// ---------- route ----------

const routeCache = new Map<string, Route[]>();
let routes: Route[] = [];
let routeIdx = 0;
/** Each route's stretch inside the zone, in local metres, for drawing and for tapping it. */
let drawn: { kept: { x: number; z: number }[]; from: LatLon; far: boolean }[] = [];

const routeLine = (r: Route, en: LatLon) => [...r.poly.pts, en]; // OSRM snaps to the road: the line ends at the entrance

/** Routes from the start to the chosen entrance, the fastest first, drawn over the streets. */
async function loadRoutes() {
  const en = entrances[entIdx];
  const seq = ++routeSeq;
  routes = [];
  routeIdx = 0;
  if (!startPt || !en) return showRoutes();
  const key = `${startPt.lat},${startPt.lon}>${en.lat},${en.lon}`;
  try {
    let found = routeCache.get(key);
    if (!found) {
      found = await fetchRoutes(startPt, en);
      routeCache.set(key, found);
    }
    if (seq !== routeSeq) return;
    routes = found;
  } catch {
    if (seq !== routeSeq) return;
  }
  showRoutes();
}

function showRoutes() {
  routeGroup.children.slice().forEach((c) => routeGroup.remove(c));
  routeStart = null;
  drawn = [];
  const en = entrances[entIdx];
  const inside = (q: { x: number; z: number }) => Math.abs(q.x) <= half.x && Math.abs(q.z) <= half.z;
  routes.forEach((r) => {
    const pts = routeLine(r, en);
    const p = pts.map(local);
    let i = p.length - 1;
    while (i > 0 && inside(p[i - 1])) i--; // the last stretch that stays inside the zone's ground
    drawn.push({ kept: p.slice(i), from: pts[i], far: i > 0 });
  });
  // Alternatives first and thin, the chosen one on top with its outline.
  drawn.forEach((d, k) => {
    if (k === routeIdx || d.kept.length < 2) return;
    routeGroup.add(ribbon(d.kept, 2.2, 0.15, theme().alt, 1));
  });
  const sel = drawn[routeIdx];
  if (sel && sel.kept.length > 1) {
    routeGroup.add(ribbon(sel.kept, 5.5, 0.2, theme().bg, 2), ribbon(sel.kept, 3.2, 0.3, theme().stop, 3));
    routeStart = { at: sel.from, far: sel.far };
    if (!fitted) fit(sel.kept);
  }
  renderRouteChips();
  redraw();
}

function ribbon(p: { x: number; z: number }[], w: number, y: number, color: number, order: number): THREE.Mesh {
  const pos: number[] = [];
  pushRibbon(pos, p, w, y);
  const m = ribbonMesh(pos, new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, depthTest: false }));
  m.renderOrder = order; // above the buildings: the whole route stays readable
  return m;
}

function chooseRoute(i: number) {
  routeIdx = i;
  showRoutes();
}

function renderRouteChips() {
  const box = $('mqRoutes');
  box.textContent = '';
  if (routes.length < 2) return;
  routes.forEach((r, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = `${Math.max(1, Math.round(r.duration / 60))} min · ${formatDistance(r.poly.length)}`;
    b.setAttribute('aria-pressed', String(i === routeIdx));
    b.onclick = () => chooseRoute(i);
    box.appendChild(b);
  });
}

/** An alternative route under a tap (screen px), if any. */
function routeAt(x: number, y: number): number {
  const near = (a: { x: number; y: number }, b: { x: number; y: number }) => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / (dx * dx + dy * dy || 1)));
    return Math.hypot(x - (a.x + t * dx), y - (a.y + t * dy));
  };
  let best = -1;
  let bestD = 16; // px
  drawn.forEach((d, k) => {
    if (k === routeIdx) return;
    const s = d.kept.map((q) => toScreen(fromLocal(origin, q.x, q.z), 0.3));
    for (let i = 0; i < s.length - 1; i++) {
      const dist = near(s[i], s[i + 1]);
      if (dist < bestD) (bestD = dist), (best = k);
    }
  });
  return best;
}

/** Frames the whole drawn route in the free area (once per opening; later entrance changes keep the view). */
function fit(p: { x: number; z: number }[]) {
  fitted = true;
  const xs = p.map((q) => q.x);
  const zs = p.map((q) => q.z);
  const [x0, x1, z0, z1] = [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)];
  target.set((x0 + x1) / 2, 0, (z0 + z1) / 2);
  const diag = Math.hypot(x1 - x0, z1 - z0) + 40;
  const free = Math.min(innerWidth, Math.max(240, innerHeight - 280));
  scale = Math.min(3, Math.max(0.1, diag / free));
}

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
  void loadRoutes();
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
  if (!fallback) entrances.forEach((en, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = en.name;
    b.setAttribute('aria-pressed', String(i === entIdx));
    b.onclick = () => {
      entIdx = i;
      renderCard();
      redraw();
      void loadRoutes();
    };
    chips.appendChild(b);
  });
  go.disabled = !entrances.length;
}

function pick(clientX: number, clientY: number) {
  const ray = new THREE.Raycaster();
  ray.setFromCamera(new THREE.Vector2((clientX / innerWidth) * 2 - 1, -(clientY / innerHeight) * 2 + 1), camera);
  const hit = ray.intersectObjects(items.map((i) => i.mesh), false)[0];
  const alt = routeAt(clientX, clientY);
  if (alt >= 0) return chooseRoute(alt);
  if (hit) select(hit.object.userData.item as Item);
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
export async function prepareMaqueta(zone: Zone, dest: LatLon, start: LatLon | null) {
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
  startPt = start;
  fitted = false;
  routes = [];
  showRoutes();
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
  scale = Math.min(scale, 0.35); // until the route arrives and frames itself
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
      route: routes[routeIdx] ?? null,
      label: selected.b.name ?? `Edificio ${selected.letter}`,
    });
  };
  addEventListener('resize', redraw);
  matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
    zoneKey = ''; // rebuilt with the other palette next time it opens
  });
}
