// The street in 3D behind the overlay, from the maqueta: ground with its relief (the tiles' elevation
// grids), streets from their ways and buildings extruded from their footprints. In Simulación it takes
// the place of the camera picture wherever the car is inside a tile. Built once per route in a local
// frame around the first tile; each frame only slides it under the car.
import * as THREE from 'three';
import { fromLocal, toLocal, type LatLon } from '../core/geo.ts';
import { elevationIn, gridPoint, tileKey, tileOf, tileToLatLon, type Tile, type TileWay } from '../core/maqueta.ts';

// The app's navy: dark ground under a lighter haze, so the horizon reads and far things fade into it.
const SKY = 0x1b4660;
const GROUND = 0x061923;
const STREET = 0x24536b;
const STREET_LINE = 0x7fa9bd;
const WALL_LOW = 0x163f57;
const WALL_HIGH = 0x2f6f93;
const ROOF = 0x4a8db3;
const TERRAIN_SUB = 4; // terrain vertices per elevation grid cell, so the mesh follows the bilinear surface
const STREET_STEP = 8; // m between street samples, so streets follow the slope
const FOG_NEAR = 70;
const FOG_FAR = 460;

type XZ = { x: number; z: number };

export class Scenery {
  readonly scene = new THREE.Scene();
  private tiles: Tile[] | null = null;
  private elev: (p: LatLon) => number | null = () => null;
  private keys = new Set<string>();
  private origin: LatLon = { lat: 0, lon: 0 };
  private root = new THREE.Group();

  constructor() {
    this.scene.background = new THREE.Color(SKY);
    this.scene.fog = new THREE.Fog(SKY, FOG_NEAR, FOG_FAR);
    this.scene.add(new THREE.HemisphereLight(0xcfe9ff, 0x0a1c26, 1.5));
    const sun = new THREE.DirectionalLight(0xffffff, 1.1);
    sun.position.set(-0.5, 1, 0.3); // high, from the north-west: east and south faces fall into shade
    this.scene.add(sun, this.root);
  }

  /** Builds the scenery for these tiles (no-op when they're the same as last time). False when there's nothing to draw. */
  set(tiles: Tile[] | null): boolean {
    if (tiles === this.tiles) return this.keys.size > 0;
    this.tiles = tiles;
    this.clear();
    if (!tiles?.length) return false;
    const [, tx, ty] = tiles[0].tile;
    this.origin = tileToLatLon(tx + 0.5, ty + 0.5);
    for (const t of tiles) this.keys.add(tileKey(t.tile[1], t.tile[2]));
    const local = (p: LatLon) => toLocal(this.origin, p);
    const elev = (this.elev = elevationIn(tiles)); // the same ground as the route profile
    const groundAt = (x: number, z: number) => elev(fromLocal(this.origin, x, z));
    this.root.add(terrainMesh(tiles, local, elev), ...streetMeshes(tiles, local, elev, groundAt), buildingsMesh(tiles, local, elev));
    return true;
  }

  /** Whether p is inside one of the tiles: outside them there's no street to show. */
  covers(p: LatLon): boolean {
    const t = tileOf(p);
    return this.keys.has(tileKey(t.x, t.y));
  }

  /**
   * Slides the scenery under the camera at `origin`, so the ground there sits at height 0. `base` is the
   * road height there from the route profile, the same the ribbon uses; without one, the terrain's own.
   */
  place(origin: LatLon, base: number | null) {
    const c = toLocal(origin, this.origin);
    this.root.position.set(c.x, -(base ?? this.elev(origin) ?? 0), c.z);
  }

  private clear() {
    this.keys.clear();
    for (const m of [...this.root.children] as THREE.Mesh[]) {
      this.root.remove(m);
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
  }
}

/** One grid per tile, TERRAIN_SUB × finer than its elevation grid, so it follows the same ground as the profile. */
function terrainMesh(tiles: Tile[], local: (p: LatLon) => XZ, elev: (p: LatLon) => number | null): THREE.Mesh {
  const pos: number[] = [];
  const idx: number[] = [];
  for (const t of tiles) {
    const [, tx, ty] = t.tile;
    const n = (t.elev.rows - 1) * TERRAIN_SUB + 1;
    const m = (t.elev.cols - 1) * TERRAIN_SUB + 1;
    const first = pos.length / 3;
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < m; c++) {
        const p = gridPoint(tx, ty, n, m, r, c);
        const l = local(p);
        pos.push(l.x, elev(p) ?? 0, l.z);
      }
    }
    for (let r = 0; r < n - 1; r++) {
      for (let c = 0; c < m - 1; c++) {
        const a = first + r * m + c;
        idx.push(a, a + m, a + 1, a + 1, a + m, a + m + 1);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color: GROUND }));
}

/** Each way once, as a strip on the ground every STREET_STEP m, plus a thin centre line on two-way streets. */
function streetMeshes(tiles: Tile[], local: (p: LatLon) => XZ, elev: (p: LatLon) => number | null, groundAt: GroundAt): THREE.Mesh[] {
  const ways = new Map<string, TileWay>();
  for (const t of tiles) for (const w of t.ways) ways.set(w.id, w);
  const road: number[] = [];
  const line: number[] = [];
  for (const w of ways.values()) {
    const half = Math.max(3, ((w.lanes ?? 2) * 3.2) / 2);
    for (const run of sampleWay(w.pts, local, elev)) {
      strip(road, run, half, 0.08, groundAt);
      if (!w.oneway && (w.lanes ?? 2) >= 2) strip(line, run, 0.12, 0.1, groundAt);
    }
  }
  // Drawn over the terrain without fighting it for depth.
  const mat = (color: number, k: number) =>
    new THREE.MeshLambertMaterial({ color, polygonOffset: true, polygonOffsetFactor: -k, polygonOffsetUnits: -k });
  return [mesh(road, mat(STREET, 2)), mesh(line, mat(STREET_LINE, 4))];
}

type XYZ = { x: number; y: number; z: number };
type GroundAt = (x: number, z: number) => number | null;

/**
 * The way's points, split so no piece is longer than STREET_STEP, each with its ground height. One run
 * per stretch over known ground: where a way leaves the tiles it stops instead of dropping to 0.
 */
function sampleWay(pts: [number, number][], local: (p: LatLon) => XZ, elev: (p: LatLon) => number | null): XYZ[][] {
  const runs: XYZ[][] = [];
  let run: XYZ[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const [la, oa] = pts[i];
    const [lb, ob] = pts[i + 1];
    const a = local({ lat: la, lon: oa });
    const b = local({ lat: lb, lon: ob });
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / STREET_STEP));
    for (let k = i ? 1 : 0; k <= n; k++) {
      const s = k / n;
      const y = elev({ lat: la + (lb - la) * s, lon: oa + (ob - oa) * s });
      if (y == null) {
        if (run.length > 1) runs.push(run);
        run = [];
      } else run.push({ x: a.x + (b.x - a.x) * s, y, z: a.z + (b.z - a.z) * s });
    }
  }
  if (run.length > 1) runs.push(run);
  return runs;
}

/**
 * Quads `half` m to each side of the polyline, overlapping a little to hide the gaps at bends, facing up.
 * Each corner sits `lift` m above the ground under it, so a street across a slope tilts with it.
 */
function strip(out: number[], p: XYZ[], half: number, lift: number, groundAt: GroundAt) {
  for (let i = 0; i < p.length - 1; i++) {
    const a = p[i];
    const b = p[i + 1];
    const len = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    const nx = (-(b.z - a.z) / len) * half;
    const nz = ((b.x - a.x) / len) * half;
    const ex = ((b.x - a.x) / len) * Math.min(half, 1) * 0.5;
    const ez = ((b.z - a.z) / len) * Math.min(half, 1) * 0.5;
    const q = [
      [a.x - ex + nx, a.y, a.z - ez + nz], // right of the way's direction
      [a.x - ex - nx, a.y, a.z - ez - nz],
      [b.x + ex - nx, b.y, b.z + ez - nz],
      [b.x + ex + nx, b.y, b.z + ez + nz],
    ];
    for (const k of [0, 2, 1, 0, 3, 2]) out.push(q[k][0], (groundAt(q[k][0], q[k][2]) ?? q[k][1]) + lift, q[k][2]);
  }
}

function mesh(pos: number[], mat: THREE.Material): THREE.Mesh {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return new THREE.Mesh(g, mat);
}

/**
 * Every building once, in one mesh: extruded from its outline, standing on the lowest ground under it
 * (so on a slope none floats) and rising to its height above the highest. Walls are darker at street level.
 */
function buildingsMesh(tiles: Tile[], local: (p: LatLon) => XZ, elev: (p: LatLon) => number | null): THREE.Mesh {
  const seen = new Set<string>();
  const parts: THREE.BufferGeometry[] = [];
  for (const t of tiles) {
    for (const b of t.buildings ?? []) {
      if (seen.has(b.id) || b.outline.length < 4) continue;
      seen.add(b.id);
      const hs = b.outline.map(([lat, lon]) => elev({ lat, lon })).filter((h): h is number => h != null);
      if (!hs.length) continue;
      const low = Math.min(...hs);
      const tall = Math.max(...hs) - low + b.height;
      const pts = b.outline.map(([lat, lon]) => local({ lat, lon }));
      const shape = new THREE.Shape(pts.map((p) => new THREE.Vector2(p.x, -p.z)));
      // Non-indexed, one normal per face: flat-shaded walls.
      const flat = new THREE.ExtrudeGeometry(shape, { depth: tall, bevelEnabled: false }).rotateX(-Math.PI / 2).translate(0, low, 0);
      const n = flat.getAttribute('normal');
      const p = flat.getAttribute('position');
      const col = new Float32Array(p.count * 3);
      const c = new THREE.Color();
      for (let i = 0; i < p.count; i++) {
        if (n.getY(i) > 0.5) c.set(ROOF);
        else c.set(WALL_LOW).lerp(new THREE.Color(WALL_HIGH), Math.min(1, (p.getY(i) - low) / Math.max(tall, 12)));
        col.set([c.r, c.g, c.b], i * 3);
      }
      flat.setAttribute('color', new THREE.BufferAttribute(col, 3));
      parts.push(flat);
    }
  }
  const pos = new Float32Array(parts.reduce((s, g) => s + g.getAttribute('position').array.length, 0));
  const nor = new Float32Array(pos.length);
  const col = new Float32Array(pos.length);
  let o = 0;
  for (const g of parts) {
    pos.set(g.getAttribute('position').array, o);
    nor.set(g.getAttribute('normal').array, o);
    col.set(g.getAttribute('color').array, o);
    o += g.getAttribute('position').array.length;
    g.dispose();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true }));
}
