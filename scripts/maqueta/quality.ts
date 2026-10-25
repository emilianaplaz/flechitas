// Checks on built maqueta tiles: what each tile holds and what's wrong with it. check.ts prints them
// for a zone or for every tile; tests/run.ts tests them. Errors mean a broken tile; warnings are worth
// a look (and maybe an override) but don't block.
import { haversine, toLocal, type LatLon } from '../../src/core/geo.ts';
import { gridPoint, insideOutline, tileKey, tileOf, type BuildingSource, type SignType, type Tile, type TileBuilding, type TileWay } from '../../src/core/maqueta.ts';
import { DUPLICATE_OVERLAP, overlapShare, ringCenter } from './buildings.ts';

export const MAX_SLOPE = 0.35; // grid slope worth a look: streets in Chacao stay well under this
export const ROAD_IN_BUILDING_M = 6; // metres of a street's centreline inside a footprint before it counts
const MIN_ELEV = 0; // m: anything outside this is a broken grid, not relief
const MAX_ELEV = 3000;
/** Roads that may run over or under buildings, so crossing a footprint is fine. */
const OVER_UNDER = /^(Distribuidor|Elevado|Puente|T[uú]nel|Autopista|Rampa|Viaducto|Retorno)\b/i;

export interface TileReport {
  key: string;
  signs: Partial<Record<SignType, number>>;
  ways: number;
  named: number; // ways with a name
  withLimit: number; // ways with maxspeed
  withLanes: number;
  buildings: Partial<Record<BuildingSource, number>>;
  namedBuildings: number;
  elev: { min: number; max: number; maxSlope: number };
  errors: string[];
  warnings: string[];
}

const count = <K extends string>(keys: K[]) => keys.reduce<Partial<Record<K, number>>>((m, k) => ((m[k] = (m[k] ?? 0) + 1), m), {});

function dupes(ids: string[]): string[] {
  const seen = new Set<string>();
  const out = new Set<string>();
  for (const id of ids) (seen.has(id) ? out : seen).add(id);
  return [...out];
}

/** Steepest rise between neighbouring grid points (fraction: 0.1 = 10 %). */
export function maxGridSlope(t: Tile): number {
  const [zoom, x, y] = t.tile;
  const { rows, cols, z } = t.elev;
  const at = (r: number, c: number) => gridPoint(x, y, rows, cols, r, c, zoom);
  const dCol = haversine(at(0, 0), at(0, 1)); // same spacing all over a tile, near enough
  const dRow = haversine(at(0, 0), at(1, 0));
  let worst = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const h = z[r * cols + c];
      if (c + 1 < cols) worst = Math.max(worst, Math.abs(z[r * cols + c + 1] - h) / dCol);
      if (r + 1 < rows) worst = Math.max(worst, Math.abs(z[(r + 1) * cols + c] - h) / dRow);
    }
  }
  return worst;
}

export function tileReport(t: Tile): TileReport {
  const [, x, y] = t.tile;
  const key = tileKey(x, y);
  const errors: string[] = [];
  const warnings: string[] = [];
  const bs = t.buildings ?? [];
  const { rows, cols, z } = t.elev;

  if (z.length !== rows * cols) errors.push(`rejilla de elevación de ${z.length} puntos, debería tener ${rows * cols}`);
  const bad = z.filter((h) => !Number.isFinite(h) || h < MIN_ELEV || h > MAX_ELEV).length;
  if (bad) errors.push(`${bad} alturas fuera de rango`);
  const min = Math.min(...z);
  const max = Math.max(...z);
  const maxSlope = z.length === rows * cols && !bad ? maxGridSlope(t) : NaN;
  if (maxSlope > MAX_SLOPE) warnings.push(`pendiente de ${Math.round(maxSlope * 100)} % en la rejilla`);

  if (!t.ways.length) errors.push('sin vías');
  if (!bs.length) warnings.push('sin edificios');
  if (!t.signs.length) warnings.push('sin señales');

  const outSigns = t.signs.filter((s) => {
    const k = tileOf(s);
    return k.x !== x || k.y !== y;
  });
  if (outSigns.length) errors.push(`${outSigns.length} señales fuera de la tesela (${outSigns[0].id})`);
  const outBuildings = bs.filter((b) => {
    const k = tileOf(ringCenter(b.outline));
    return k.x !== x || k.y !== y;
  });
  if (outBuildings.length) errors.push(`${outBuildings.length} edificios con el centro fuera de la tesela (${outBuildings[0].id})`);
  const open = bs.filter((b) => b.outline.length < 4 || b.outline[0][0] !== b.outline.at(-1)![0] || b.outline[0][1] !== b.outline.at(-1)![1]);
  if (open.length) errors.push(`${open.length} contornos abiertos o con menos de 3 lados (${open[0].id})`);
  const flat = bs.filter((b) => !(b.height > 0));
  if (flat.length) errors.push(`${flat.length} edificios sin altura (${flat[0].id})`);
  for (const [what, ids] of [['edificio', bs.map((b) => b.id)], ['vía', t.ways.map((w) => w.id)], ['señal', t.signs.map((s) => s.id)]] as const) {
    const d = dupes([...ids]);
    if (d.length) errors.push(`${what} repetido en la tesela: ${d.slice(0, 3).join(', ')}`);
  }

  return {
    key,
    signs: count(t.signs.map((s) => s.type)),
    ways: t.ways.length,
    named: t.ways.filter((w) => w.name).length,
    withLimit: t.ways.filter((w) => w.maxspeed).length,
    withLanes: t.ways.filter((w) => w.lanes).length,
    buildings: count(bs.map((b) => b.source)),
    namedBuildings: bs.filter((b) => b.name).length,
    elev: { min, max, maxSlope },
    errors,
    warnings,
  };
}

// ---- across tiles ----

type Box = [number, number, number, number]; // south, west, north, east

function boxOf(outline: [number, number][]): Box {
  let s = Infinity;
  let w = Infinity;
  let n = -Infinity;
  let e = -Infinity;
  for (const [lat, lon] of outline) {
    s = Math.min(s, lat);
    n = Math.max(n, lat);
    w = Math.min(w, lon);
    e = Math.max(e, lon);
  }
  return [s, w, n, e];
}

const CELL = 0.0005; // ° (~55 m): bucket size of the spatial index below

/** Buildings bucketed by the cells their box covers, to find neighbours without comparing all pairs. */
class Buckets<T> {
  private cells = new Map<string, T[]>();
  add(box: Box, item: T) {
    for (let i = Math.floor(box[0] / CELL); i <= Math.floor(box[2] / CELL); i++) {
      for (let j = Math.floor(box[1] / CELL); j <= Math.floor(box[3] / CELL); j++) {
        const k = `${i},${j}`;
        const list = this.cells.get(k);
        if (list) list.push(item);
        else this.cells.set(k, [item]);
      }
    }
  }
  at(p: LatLon): T[] {
    return this.cells.get(`${Math.floor(p.lat / CELL)},${Math.floor(p.lon / CELL)}`) ?? [];
  }
  near(box: Box): Set<T> {
    const out = new Set<T>();
    for (let i = Math.floor(box[0] / CELL); i <= Math.floor(box[2] / CELL); i++) {
      for (let j = Math.floor(box[1] / CELL); j <= Math.floor(box[3] / CELL); j++) for (const t of this.cells.get(`${i},${j}`) ?? []) out.add(t);
    }
    return out;
  }
}

export interface Duplicate {
  a: string; // "tile building-id"
  b: string;
  why: 'mismo id' | 'se solapan';
}

/**
 * The same building twice across tiles: one id in two tiles, or two footprints from different tiles
 * covering each other past the de-duplication threshold (tiles built at different times, or with
 * different data). Also signs repeated across tiles.
 */
export function crossTileDuplicates(tiles: Tile[]): Duplicate[] {
  const out: Duplicate[] = [];
  const firstTile = new Map<string, string>();
  const index = new Buckets<{ tile: string; b: TileBuilding; box: Box }>();
  for (const t of tiles) {
    const key = tileKey(t.tile[1], t.tile[2]);
    for (const s of t.signs) {
      const prev = firstTile.get(s.id);
      if (prev && prev !== key) out.push({ a: `${prev} ${s.id}`, b: `${key} ${s.id}`, why: 'mismo id' });
      else firstTile.set(s.id, key);
    }
    for (const b of t.buildings ?? []) {
      const prev = firstTile.get(b.id);
      if (prev && prev !== key) out.push({ a: `${prev} ${b.id}`, b: `${key} ${b.id}`, why: 'mismo id' });
      else firstTile.set(b.id, key);
      index.add(boxOf(b.outline), { tile: key, b, box: boxOf(b.outline) });
    }
  }
  const done = new Set<string>();
  for (const t of tiles) {
    const key = tileKey(t.tile[1], t.tile[2]);
    for (const b of t.buildings ?? []) {
      for (const o of index.near(boxOf(b.outline))) {
        if (o.tile === key || o.b.id === b.id) continue;
        const pair = [`${key} ${b.id}`, `${o.tile} ${o.b.id}`].sort().join('|');
        if (done.has(pair)) continue;
        done.add(pair);
        if (overlapShare(b.outline, o.b.outline) > DUPLICATE_OVERLAP) out.push({ a: `${key} ${b.id}`, b: `${o.tile} ${o.b.id}`, why: 'se solapan' });
      }
    }
  }
  return out;
}

/**
 * Buildings a named street runs through (at least ROAD_IN_BUILDING_M of its centreline inside the
 * footprint): a footprint that isn't a building (trees, a market's awning), or a dataset shifted
 * against the streets. Roads that may go over or under (distribuidores, túneles, autopista) don't count.
 * Returns metres of street inside, per building id.
 */
export function roadsThroughBuildings(buildings: TileBuilding[], ways: TileWay[], step = 1): Map<string, number> {
  const index = new Buckets<{ b: TileBuilding; box: Box }>();
  for (const b of buildings) index.add(boxOf(b.outline), { b, box: boxOf(b.outline) });
  const inside = new Map<string, number>();
  const seen = new Set<string>();
  for (const w of ways) {
    if (!w.name || OVER_UNDER.test(w.name) || seen.has(w.id) || w.pts.length < 2) continue;
    seen.add(w.id);
    for (let i = 0; i + 1 < w.pts.length; i++) {
      const a = { lat: w.pts[i][0], lon: w.pts[i][1] };
      const c = { lat: w.pts[i + 1][0], lon: w.pts[i + 1][1] };
      const d = toLocal(a, c);
      const len = Math.hypot(d.x, d.z);
      const n = Math.max(1, Math.round(len / step));
      for (let k = 0; k < n; k++) {
        const f = (k + 0.5) / n;
        const p = { lat: a.lat + (c.lat - a.lat) * f, lon: a.lon + (c.lon - a.lon) * f };
        for (const o of index.at(p)) {
          if (p.lat < o.box[0] || p.lat > o.box[2] || p.lon < o.box[1] || p.lon > o.box[3]) continue;
          if (insideOutline(o.b.outline, p)) inside.set(o.b.id, (inside.get(o.b.id) ?? 0) + len / n);
        }
      }
    }
  }
  for (const [id, m] of inside) if (m < ROAD_IN_BUILDING_M) inside.delete(id);
  return inside;
}
