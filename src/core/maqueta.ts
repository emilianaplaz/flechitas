// Maqueta: our own map data for the overlay, precompiled into static tiles under public/maqueta/
// by scripts/maqueta/build.ts (see MAQUETA.md). Each tile has a ground elevation grid, OSM signs
// and ways, and building footprints. The app only reads these files. Where a route has no tile, it behaves as before:
// flat road, no signs, no speed limit.
import { angleDiff, bearingAt, fromLocal, pointAt, toLocal, type LatLon, type Polyline } from './geo.ts';

export const MAQUETA_ZOOM = 16;
const PROFILE_STEP = 5; // m between route elevation samples
const LIMIT_STEP = 10; // m between route speed-limit samples
const WAY_MATCH_DIST = 12; // m: a way farther than this from the route isn't the road we're on

export type SignType = 'traffic_signals' | 'stop' | 'give_way' | 'crossing' | 'bump' | 'hump' | 'table' | 'speed_camera';

export interface TileSign {
  id: string;
  type: SignType;
  lat: number;
  lon: number;
  dir: number | null; // compass bearing of the traffic the sign applies to; null = both ways
  verified: boolean;
}

export interface TileWay {
  id: string;
  name: string | null;
  oneway: boolean;
  lanes: number | null;
  maxspeed: number | null; // km/h
  turnLanes: string | null;
  pts: [number, number][]; // [lat, lon] in the way's own direction
}

export interface TileEntrance {
  name: string;
  lat: number;
  lon: number;
}

export type BuildingSource = 'osm' | 'ms' | 'google' | 'manual';

export interface TileBuilding {
  id: string; // osm:w123 / osm:r123, ms:{lat},{lon} of the footprint's centre, or any id for hand-drawn ones
  name: string | null;
  height: number; // m: OSM `height`, else `building:levels` × 3, else 9; overrides win
  levels: number | null;
  source: BuildingSource; // where the outline came from
  outline: [number, number][]; // [lat, lon], closed ring (last point = first)
  entrances: TileEntrance[]; // hand-measured or from OSM; may be empty (see entrancesOf)
}

export interface Tile {
  v: 1;
  tile: [number, number, number]; // [zoom, x, y]
  built: string;
  sources: string[];
  /** Ground height in metres on a regular grid in tile space, row 0 = north edge, col 0 = west edge, edges included. */
  elev: { rows: number; cols: number; z: number[] };
  signs: TileSign[];
  ways: TileWay[];
  /** Footprints whose centre is in this tile (whole outline, may cross the edge). Missing in older tiles. */
  buildings?: TileBuilding[];
}

export interface MaquetaIndex {
  v: 1;
  zoom: number;
  tiles: string[]; // "x/y"
  zones: { name: string; label?: string; bbox: [number, number, number, number]; tiles: string[] }[]; // bbox: south, west, north, east
}

// ---- tile math (standard web map tiles) ----

/** Fractional tile coordinates of a point. The integer part is the tile, the rest the position inside it. */
export function tileXY(p: LatLon, zoom = MAQUETA_ZOOM): { x: number; y: number } {
  const n = 2 ** zoom;
  const lat = (p.lat * Math.PI) / 180;
  return {
    x: ((p.lon + 180) / 360) * n,
    y: ((1 - Math.log(Math.tan(lat) + 1 / Math.cos(lat)) / Math.PI) / 2) * n,
  };
}

/** The point at fractional tile coordinates (inverse of `tileXY`). */
export function tileToLatLon(x: number, y: number, zoom = MAQUETA_ZOOM): LatLon {
  const n = 2 ** zoom;
  return {
    lat: (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI,
    lon: (x / n) * 360 - 180,
  };
}

export const tileKey = (x: number, y: number) => `${x}/${y}`;

export function tileOf(p: LatLon, zoom = MAQUETA_ZOOM): { x: number; y: number } {
  const t = tileXY(p, zoom);
  return { x: Math.floor(t.x), y: Math.floor(t.y) };
}

/** Grid point (row, col) of a tile's elevation grid. Shared with the build script so both agree. */
export function gridPoint(tx: number, ty: number, rows: number, cols: number, r: number, c: number, zoom = MAQUETA_ZOOM): LatLon {
  return tileToLatLon(tx + c / (cols - 1), ty + r / (rows - 1), zoom);
}

/** Ground height at p from this tile's grid (bilinear), or null when p is outside the tile. */
export function tileElevation(t: Tile, p: LatLon): number | null {
  const { u, v } = gridUV(t, p);
  const { rows, cols } = t.elev;
  if (u < 0 || v < 0 || u > cols - 1 || v > rows - 1) return null;
  return bilinear(t, u, v);
}

/** Position of p in a tile's elevation grid, in cells: (0, 0) is its north-west corner. */
function gridUV(t: Tile, p: LatLon): { u: number; v: number } {
  const [zoom, tx, ty] = t.tile;
  const f = tileXY(p, zoom);
  return { u: (f.x - tx) * (t.elev.cols - 1), v: (f.y - ty) * (t.elev.rows - 1) };
}

/** Bilinear height at grid position (u, v), clamped to the grid. */
function bilinear(t: Tile, u: number, v: number): number {
  const { rows, cols, z } = t.elev;
  u = Math.min(cols - 1, Math.max(0, u));
  v = Math.min(rows - 1, Math.max(0, v));
  const c0 = Math.min(cols - 2, Math.floor(u));
  const r0 = Math.min(rows - 2, Math.floor(v));
  const a = u - c0;
  const b = v - r0;
  const at = (r: number, c: number) => z[r * cols + c];
  return (at(r0, c0) * (1 - a) + at(r0, c0 + 1) * a) * (1 - b) + (at(r0 + 1, c0) * (1 - a) + at(r0 + 1, c0 + 1) * a) * b;
}

const SEAM_BLEND = 1; // grid cells (~50 m) on each side of a tile edge where neighbouring tiles are blended

/** Weight of a tile at grid coordinate u (0..max inside it): 1 inside, 0.5 on its edge, 0 SEAM_BLEND cells past it. */
const seamWeight = (u: number, max: number) =>
  Math.min(1, Math.max(0, (u + SEAM_BLEND) / (2 * SEAM_BLEND))) * Math.min(1, Math.max(0, (max + SEAM_BLEND - u) / (2 * SEAM_BLEND)));

/**
 * Ground height at p from a set of tiles, continuous across their edges. Each tile's grid is smoothed
 * on its own when it's built, so two neighbours can disagree by metres along the edge they share; near
 * an edge both are blended. Null farther than SEAM_BLEND cells from every tile.
 */
export function elevationIn(tiles: Tile[]): (p: LatLon) => number | null {
  return (p) => {
    let sum = 0;
    let weight = 0;
    for (const t of tiles) {
      const { u, v } = gridUV(t, p);
      const w = seamWeight(u, t.elev.cols - 1) * seamWeight(v, t.elev.rows - 1);
      if (w <= 0) continue;
      sum += w * bilinear(t, u, v);
      weight += w;
    }
    return weight ? sum / weight : null;
  };
}

// ---- along the route ----

/** Ground height every few metres along the route, computed once per route; `at(d)` allocates nothing. */
export class RouteProfile {
  private z: Float32Array;
  private step: number;

  // No parameter properties: tests and the build script run under Node's type stripping.
  private constructor(z: Float32Array, step: number) {
    this.z = z;
    this.step = step;
  }

  /**
   * Null when no sample has a known height. Where the route has no tile before the maqueta starts or
   * after it ends, the nearest known height holds, so the road reads as flat. A stretch without tiles
   * between two known ones (the route leaves the maqueta and comes back) goes straight from one height
   * to the other, instead of holding one and jumping at the far end.
   */
  static build(poly: Polyline, elevationAt: (p: LatLon) => number | null, maxStep = PROFILE_STEP): RouteProfile | null {
    // Evenly spaced so the last sample is exactly the route's end.
    const n = Math.max(2, Math.ceil(poly.length / maxStep) + 1);
    const step = poly.length / (n - 1) || maxStep;
    const z = new Float32Array(n).fill(NaN);
    let known = 0;
    for (let i = 0; i < n; i++) {
      const e = elevationAt(pointAt(poly, i * step).p);
      if (e != null) {
        z[i] = e;
        known++;
      }
    }
    if (!known) return null;
    let prev = -1; // last sample with a known height
    for (let i = 0; i < n; i++) {
      if (Number.isNaN(z[i])) continue;
      if (prev < 0) z.fill(z[i], 0, i);
      else for (let k = prev + 1; k < i; k++) z[k] = z[prev] + ((z[i] - z[prev]) * (k - prev)) / (i - prev);
      prev = i;
    }
    z.fill(z[prev], prev + 1);
    return new RouteProfile(z, step);
  }

  /** Ground height at `d` metres along the route (clamped to its ends). */
  at = (d: number): number => {
    const f = Math.min(Math.max(0, d / this.step), this.z.length - 1);
    const i = Math.min(this.z.length - 2, Math.floor(f));
    return this.z[i] + (this.z[i + 1] - this.z[i]) * (f - i);
  };
}

/**
 * Speed limit every few metres along the route: the nearest way with a `maxspeed` that runs the same
 * way as the route there (a one-way only in its own direction). 0 where unknown.
 */
export function speedLimits(poly: Polyline, ways: TileWay[], step = LIMIT_STEP): Uint8Array {
  const n = Math.max(1, Math.ceil(poly.length / step) + 1);
  const out = new Uint8Array(n);
  const withLimit = ways.filter((w) => w.maxspeed && w.pts.length > 1);
  if (!withLimit.length) return out;
  const origin = poly.pts[0];
  const local = withLimit.map((w) => w.pts.map(([lat, lon]) => toLocal(origin, { lat, lon })));
  for (let i = 0; i < n; i++) {
    const d = i * step;
    const q = toLocal(origin, pointAt(poly, d).p);
    const routeBearing = bearingAt(poly, d, 10);
    let best = WAY_MATCH_DIST;
    for (let w = 0; w < withLimit.length; w++) {
      const pts = local[w];
      for (let k = 0; k < pts.length - 1; k++) {
        const a = pts[k];
        const b = pts[k + 1];
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const len2 = dx * dx + dz * dz;
        if (!len2) continue;
        const t = Math.min(1, Math.max(0, ((q.x - a.x) * dx + (q.z - a.z) * dz) / len2));
        const dist = Math.hypot(a.x + t * dx - q.x, a.z + t * dz - q.z);
        if (dist >= best) continue;
        const wayBearing = (Math.atan2(dx, -dz) * 180) / Math.PI;
        const off = Math.abs(angleDiff(wayBearing, routeBearing));
        if (off > 35 && (withLimit[w].oneway || off < 145)) continue;
        best = dist;
        out[i] = Math.min(255, withLimit[w].maxspeed!);
      }
    }
  }
  return out;
}

export interface RouteMaqueta {
  profile: RouteProfile | null;
  limits: Uint8Array;
  signs: TileSign[];
  tiles: Tile[]; // the tiles the route passes through, for the 3D street in Simulación
}

/** Speed limit in km/h at `d` metres along the route, or null where the maqueta doesn't know it. */
export function limitAt(limits: Uint8Array, d: number): number | null {
  const v = limits[Math.min(limits.length - 1, Math.max(0, Math.round(d / LIMIT_STEP)))];
  return v || null;
}

// ---- buildings ----

export const ENTRANCE_FALLBACK_NAME = 'Frente al edificio';

/** Whether p is inside a [lat, lon] ring (ray casting; fine at building scale). */
export function insideOutline(outline: [number, number][], p: LatLon): boolean {
  let inside = false;
  for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
    const [ai, oi] = outline[i];
    const [aj, oj] = outline[j];
    if (ai > p.lat !== aj > p.lat && p.lon < ((oj - oi) * (p.lat - ai)) / (aj - ai) + oi) inside = !inside;
  }
  return inside;
}

/** Buildings from these tiles whose outline touches bbox (south, west, north, east), each once. */
export function buildingsIn(tiles: Tile[], bbox: [number, number, number, number]): TileBuilding[] {
  const [s, w, n, e] = bbox;
  const out = new Map<string, TileBuilding>();
  for (const t of tiles) {
    for (const b of t.buildings ?? []) {
      if (out.has(b.id)) continue;
      let bs = Infinity;
      let bw = Infinity;
      let bn = -Infinity;
      let be = -Infinity;
      for (const [lat, lon] of b.outline) {
        bs = Math.min(bs, lat);
        bn = Math.max(bn, lat);
        bw = Math.min(bw, lon);
        be = Math.max(be, lon);
      }
      if (bs <= n && bn >= s && bw <= e && be >= w) out.set(b.id, b);
    }
  }
  return [...out.values()];
}

type XZ = { x: number; z: number };

/** Nearest point of segment a-c to q. */
function nearestOnSegment(q: XZ, a: XZ, c: XZ): XZ {
  const dx = c.x - a.x;
  const dz = c.z - a.z;
  const len2 = dx * dx + dz * dz;
  const t = len2 ? Math.min(1, Math.max(0, ((q.x - a.x) * dx + (q.z - a.z) * dz) / len2)) : 0;
  return { x: a.x + t * dx, z: a.z + t * dz };
}

function distToPolyline(q: XZ, pts: XZ[]): number {
  let best = Infinity;
  for (let k = 0; k < pts.length - 1; k++) {
    const r = nearestOnSegment(q, pts[k], pts[k + 1]);
    best = Math.min(best, Math.hypot(r.x - q.x, r.z - q.z));
  }
  return best;
}

/**
 * Where to arrive at a building: its own entrances, else one computed entrance "Frente al edificio",
 * the point of the outline nearest to the closest way. When a whole façade runs along that way (all
 * of it within 1 m of the nearest distance), the middle of that façade. Empty when it has neither
 * entrances nor ways.
 */
export function entrancesOf(b: TileBuilding, ways: TileWay[]): TileEntrance[] {
  if (b.entrances.length) return b.entrances;
  if (b.outline.length < 2) return [];
  const origin = { lat: b.outline[0][0], lon: b.outline[0][1] };
  const local = (pts: [number, number][]) => pts.map(([lat, lon]) => toLocal(origin, { lat, lon }));
  const ring = local(b.outline);

  // Closest way. Between two polylines that don't cross, the closest pair has a vertex of one of them.
  let best = Infinity;
  let closest: XZ[] | null = null;
  for (const w of ways) {
    const pts = local(w.pts);
    if (pts.length < 2) continue;
    let d = Infinity;
    for (const q of ring) d = Math.min(d, distToPolyline(q, pts));
    for (const q of pts) d = Math.min(d, distToPolyline(q, ring));
    if (d < best) {
      best = d;
      closest = pts;
    }
  }
  if (!closest) return [];

  // Outline sampled every metre (ring is closed, so the last edge returns to the start).
  const samples: { p: XZ; d: number }[] = [];
  for (let k = 0; k < ring.length - 1; k++) {
    const a = ring[k];
    const c = ring[k + 1];
    const n = Math.max(1, Math.ceil(Math.hypot(c.x - a.x, c.z - a.z)));
    for (let i = 0; i < n; i++) {
      const p = { x: a.x + ((c.x - a.x) * i) / n, z: a.z + ((c.z - a.z) * i) / n };
      samples.push({ p, d: distToPolyline(p, closest) });
    }
  }
  const dMin = Math.min(...samples.map((s) => s.d));
  const front = samples.map((s) => s.d <= dMin + 1);
  let at = samples.find((s) => s.d === dMin)!.p;
  // Longest run of front samples, walking round the ring from a sample that isn't one.
  const start = front.indexOf(false);
  if (start >= 0) {
    let run: number[] = [];
    let longest: number[] = [];
    for (let i = 1; i <= samples.length; i++) {
      const j = (start + i) % samples.length;
      if (front[j]) run.push(j);
      else run = [];
      if (run.length > longest.length) longest = [...run];
    }
    at = samples[longest[Math.floor(longest.length / 2)]].p;
  }
  const p = fromLocal(origin, at.x, at.z);
  return [{ name: ENTRANCE_FALLBACK_NAME, lat: +p.lat.toFixed(6), lon: +p.lon.toFixed(6) }];
}

// ---- zones ----

/** The zone a point is in. Where zones overlap (a street inside its neighbourhood), the smallest one. */
export function zoneFor<Z extends { bbox: [number, number, number, number] }>(zones: Z[], p: LatLon): Z | null {
  let best: Z | null = null;
  let bestArea = Infinity;
  for (const z of zones) {
    const [s, w, n, e] = z.bbox;
    if (p.lat < s || p.lat > n || p.lon < w || p.lon > e) continue;
    const area = (n - s) * (e - w);
    if (area < bestArea) (best = z), (bestArea = area);
  }
  return best;
}

/**
 * The outer edge of an area made of tiles, as straight [lat, lon] lines: tile sides with no tile on
 * the other side, joined where they continue. Holes in the area get their own edge.
 */
export function coverageEdges(keys: Iterable<string>): [number, number][][] {
  const have = new Set(keys);
  const at = (x: number, y: number) => have.has(tileKey(x, y));
  const rows = new Map<number, number[]>(); // y of a horizontal side → x where each piece starts
  const cols = new Map<number, number[]>(); // x of a vertical side → y where each piece starts
  const add = (m: Map<number, number[]>, k: number, v: number) => m.set(k, [...(m.get(k) ?? []), v]);
  for (const key of have) {
    const [x, y] = key.split('/').map(Number);
    if (!at(x, y - 1)) add(rows, y, x);
    if (!at(x, y + 1)) add(rows, y + 1, x);
    if (!at(x - 1, y)) add(cols, x, y);
    if (!at(x + 1, y)) add(cols, x + 1, y);
  }
  const out: [number, number][][] = [];
  const runs = (m: Map<number, number[]>, line: (fixed: number, from: number, to: number) => [number, number][]) => {
    for (const [fixed, starts] of m) {
      const s = [...new Set(starts)].sort((a, b) => a - b);
      for (let i = 0; i < s.length; ) {
        let j = i;
        while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
        out.push(line(fixed, s[i], s[j] + 1));
        i = j + 1;
      }
    }
  };
  const ll = (x: number, y: number): [number, number] => {
    const p = tileToLatLon(x, y);
    return [p.lat, p.lon];
  };
  runs(rows, (y, x0, x1) => [ll(x0, y), ll(x1, y)]);
  runs(cols, (x, y0, y1) => [ll(x, y0), ll(x, y1)]);
  return out;
}

/** Keys of the tiles a box (south, west, north, east) touches, among the ones in `have`. */
export function tilesInBox(have: Set<string>, box: [number, number, number, number]): string[] {
  const a = tileOf({ lat: box[2], lon: box[1] });
  const b = tileOf({ lat: box[0], lon: box[3] });
  const out: string[] = [];
  for (let x = a.x; x <= b.x; x++) for (let y = a.y; y <= b.y; y++) if (have.has(tileKey(x, y))) out.push(tileKey(x, y));
  return out;
}

// ---- loading ----

let indexReq: Promise<MaquetaIndex | null> | null = null;
const tileReqs = new Map<string, Promise<Tile | null>>();

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url);
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

export function loadTile(key: string): Promise<Tile | null> {
  let req = tileReqs.get(key);
  if (!req) {
    req = fetchJson<Tile>(`/maqueta/${MAQUETA_ZOOM}/${key}.json`);
    tileReqs.set(key, req);
  }
  return req;
}

/** The tiles the route passes through, among the ones that exist. */
async function tilesFor(poly: Polyline): Promise<Tile[]> {
  indexReq ??= fetchJson<MaquetaIndex>('/maqueta/index.json');
  const index = await indexReq;
  if (!index || index.zoom !== MAQUETA_ZOOM) return [];
  const have = new Set(index.tiles);
  const keys = new Set<string>();
  for (let d = 0; d <= poly.length; d += 25) {
    const t = tileOf(pointAt(poly, d).p);
    const k = tileKey(t.x, t.y);
    if (have.has(k)) keys.add(k);
  }
  const tiles = await Promise.all([...keys].map(loadTile));
  return tiles.filter((t): t is Tile => !!t);
}

/** Everything the maqueta knows about a route, or null when the route touches no tile. */
export async function loadRouteMaqueta(poly: Polyline): Promise<RouteMaqueta | null> {
  const tiles = await tilesFor(poly);
  if (!tiles.length) return null;
  const elevationAt = elevationIn(tiles);
  // A way crossing a tile edge is in both tiles; keep one copy.
  const ways = new Map<string, TileWay>();
  const signs = new Map<string, TileSign>();
  for (const t of tiles) {
    for (const w of t.ways) ways.set(w.id, w);
    for (const s of t.signs) signs.set(s.id, s);
  }
  return {
    profile: RouteProfile.build(poly, elevationAt),
    limits: speedLimits(poly, [...ways.values()]),
    signs: [...signs.values()],
    tiles,
  };
}
