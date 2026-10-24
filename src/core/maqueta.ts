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
  zones: { name: string; bbox: [number, number, number, number]; tiles: string[] }[]; // bbox: south, west, north, east
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
  const [zoom, tx, ty] = t.tile;
  const { rows, cols, z } = t.elev;
  const f = tileXY(p, zoom);
  const u = (f.x - tx) * (cols - 1);
  const v = (f.y - ty) * (rows - 1);
  if (u < 0 || v < 0 || u > cols - 1 || v > rows - 1) return null;
  const c0 = Math.min(cols - 2, Math.floor(u));
  const r0 = Math.min(rows - 2, Math.floor(v));
  const a = u - c0;
  const b = v - r0;
  const at = (r: number, c: number) => z[r * cols + c];
  return (at(r0, c0) * (1 - a) + at(r0, c0 + 1) * a) * (1 - b) + (at(r0 + 1, c0) * (1 - a) + at(r0 + 1, c0 + 1) * a) * b;
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

  /** Null when no sample has a known height. Gaps (no tile) hold the nearest known height, so they read as flat. */
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
    let last = NaN;
    for (let i = 0; i < n; i++) (Number.isNaN(z[i]) ? (z[i] = last) : (last = z[i]));
    last = NaN;
    for (let i = n - 1; i >= 0; i--) (Number.isNaN(z[i]) ? (z[i] = last) : (last = z[i]));
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
  const elevationAt = (p: LatLon) => {
    for (const t of tiles) {
      const e = tileElevation(t, p);
      if (e != null) return e;
    }
    return null;
  };
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
  };
}
