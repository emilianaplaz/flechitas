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
  dark: { bg: 0x031017, gnd: 0x071f2b, street: 0x0e3347, top: 0x1f5575, left: 0x123b53, right: 0x0b2b3e, stop: 0x4b86f5, sleft: 0x2563eb, sright: 0x1b47b0 },
  light: { bg: 0xf4f8fb, gnd: 0xe2ecf2, street: 0xffffff, top: 0xffffff, left: 0xcbd9e3, right: 0xb0c2d0, stop: 0x3b74e0, sleft: 0x1a56c4, sright: 0x123f94 },
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
let onConfirm: (c: MaquetaChoice) => void = () => {};
let frameReq = 0;

const theme = () => (matchMedia('(prefers-color-scheme: light)').matches ? PALETTE.light : PALETTE.dark);
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
  world = new THREE.Group();
  const c = theme();
  scene.background = new THREE.Color(c.bg);

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

function render() {
  frameReq = 0;
  if (!renderer || $('scrMaqueta').hidden) return;
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
  const hit = ray.intersectObjects(items.map((i) => i.mesh), false)[0];
  if (hit) select(hit.object.userData.item as Item);
}

// ---------- gestures: drag to pan, pinch or wheel to zoom, tap to select ----------

function bindGestures(el: HTMLElement) {
  const pts = new Map<number, { x: number; y: number }>();
  let downAt = { x: 0, y: 0, t: 0 };
  let moved = 0;
  let pinch = 0;
  const pan = (dx: number, dy: number) => {
    const right = new THREE.Vector3(Math.cos(az), 0, -Math.sin(az));
    const fwd = new THREE.Vector3(-Math.sin(az), 0, -Math.cos(az)); // away from the camera, on the ground
    target.addScaledVector(right, -dx * scale).addScaledVector(fwd, (dy * scale) / Math.sin(ELEV));
    redraw();
  };
  const zoom = (k: number) => {
    scale = Math.min(3, Math.max(0.05, scale * k));
    redraw();
  };
  el.addEventListener('pointerdown', (e) => {
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic or already released pointer */
    }
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 1) {
      downAt = { x: e.clientX, y: e.clientY, t: performance.now() };
      moved = 0;
    }
    if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      pinch = Math.hypot(a.x - b.x, a.y - b.y);
    }
  });
  el.addEventListener('pointermove', (e) => {
    const p = pts.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;
    if (pts.size === 1) {
      moved += Math.abs(dx) + Math.abs(dy);
      pan(dx, dy);
    } else if (pts.size === 2) {
      moved = 99;
      const [a, b] = [...pts.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch) zoom(pinch / d);
      pinch = d;
    }
  });
  const up = (e: PointerEvent) => {
    if (!pts.delete(e.pointerId)) return;
    pinch = 0;
  };
  // A tap (no drag) selects: the browser's click covers mouse and touch alike.
  el.addEventListener('click', (e) => {
    if (moved < 8 && performance.now() - downAt.t < 600) pick(e.clientX, e.clientY);
  });
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  el.addEventListener('wheel', (e) => {
    e.preventDefault();
    zoom(Math.exp(e.deltaY * 0.0015));
  }, { passive: false });
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
  items.forEach(paint);
  select(inside ?? byDist[0] ?? null);
  const at = selected ? local(selected.center) : d;
  target.set(at.x, 0, at.z);
  scale = Math.min(scale, 0.35);
  setText('mqZone', 'Zona demo · toca un edificio');
}

/** Call after the screen becomes visible (and on resize) so the canvas fits it. */
export const showMaqueta = () => redraw();

export function initMaqueta(confirm: (c: MaquetaChoice) => void) {
  onConfirm = confirm;
  if (import.meta.env.DEV) (window as unknown as { __mq: unknown }).__mq = { items: () => items, camera, pick, toScreen };
  $('mqRotate').onclick = () => {
    az += Math.PI / 2;
    items.forEach(paint);
    redraw();
  };
  $('mqGo').onclick = () => {
    if (!selected || !entrances[entIdx]) return toast('Toca un edificio primero');
    const en = entrances[entIdx];
    onConfirm({
      arrival: { lat: en.lat, lon: en.lon, label: `Edif. ${selected.letter} · ${en.name}`, outline: selected.b.outline },
      label: selected.b.name ?? `Edificio ${selected.letter}`,
    });
  };
  addEventListener('resize', redraw);
  matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
    zoneKey = ''; // rebuilt with the other palette next time it opens
  });
}
