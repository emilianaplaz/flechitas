// Building footprints for the maqueta: the pure parts of build.ts (heights, overlap, de-duplication,
// hand overrides), kept apart so tests/run.ts can import them without running the build.
import { toLocal, type LatLon } from '../../src/core/geo.ts';
import { insideOutline, type TileBuilding, type TileEntrance } from '../../src/core/maqueta.ts';

export type Ring = [number, number][]; // [lat, lon]

export const DEFAULT_HEIGHT = 9; // m, when nothing says otherwise
export const LEVEL_HEIGHT = 3; // m per floor
export const DUPLICATE_OVERLAP = 0.5; // share of the smaller footprint covered by the other

/** In overrides/{x}_{y}.json(c): corrections to buildings already in the tile, by id. */
export interface BuildingOverride {
  id: string;
  name?: string | null;
  height?: number;
  levels?: number | null;
  entrances?: TileEntrance[];
  outline?: Ring;
  hide?: true; // footprint that isn't a building, or a duplicate the overlap test missed
}

/** In overrides: buildings drawn by hand (missing from every dataset). */
export interface AddedBuilding {
  id: string;
  name?: string | null;
  height?: number;
  levels?: number | null;
  outline: Ring;
  entrances?: TileEntrance[];
}

const round6 = (v: number) => +v.toFixed(6);

/** Rounded and closed (last point = first). */
export function closeRing(ring: Ring): Ring {
  const out = ring.map(([lat, lon]): [number, number] => [round6(lat), round6(lon)]);
  const a = out[0];
  const b = out[out.length - 1];
  if (a && (a[0] !== b[0] || a[1] !== b[1])) out.push([a[0], a[1]]);
  return out;
}

/** Mean of the ring's points (closing point excluded). Good enough to pick the tile a footprint goes to. */
export function ringCenter(ring: Ring): LatLon {
  const n = ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] ? ring.length - 1 : ring.length;
  let lat = 0;
  let lon = 0;
  for (let i = 0; i < n; i++) {
    lat += ring[i][0];
    lon += ring[i][1];
  }
  return { lat: lat / n, lon: lon / n };
}

function ringBox(ring: Ring): [number, number, number, number] {
  let s = Infinity;
  let w = Infinity;
  let n = -Infinity;
  let e = -Infinity;
  for (const [lat, lon] of ring) {
    s = Math.min(s, lat);
    n = Math.max(n, lat);
    w = Math.min(w, lon);
    e = Math.max(e, lon);
  }
  return [s, w, n, e];
}

/** Parses OSM lengths like "12", "12 m", "12.5m"; feet are converted. */
function parseMetres(v: string | undefined): number | null {
  if (!v) return null;
  const m = /^(\d+(?:[.,]\d+)?)\s*(m|ft|')?$/.exec(v.trim());
  if (!m) return null;
  const n = Number(m[1].replace(',', '.'));
  return m[2] === 'ft' || m[2] === "'" ? n * 0.3048 : n;
}

/** `height`, else `building:levels` × 3 m, else `fallback` (the dataset's own estimate) or 9 m. */
export function buildingHeight(tags: Record<string, string>, fallback: number | null = null): { height: number; levels: number | null } {
  const lv = Number.parseFloat(tags['building:levels'] ?? '');
  const levels = Number.isFinite(lv) && lv > 0 ? lv : null;
  const h = parseMetres(tags['height']);
  if (h && h > 0) return { height: +h.toFixed(1), levels };
  if (levels) return { height: +(levels * LEVEL_HEIGHT).toFixed(1), levels };
  return { height: fallback && fallback > 0 ? +fallback.toFixed(1) : DEFAULT_HEIGHT, levels };
}

/**
 * How much of the smaller footprint the other one covers, 0..1. Estimated on a grid of samples over
 * the smaller one, so it works for any shape (OSM outlines are often not convex).
 */
export function overlapShare(a: Ring, b: Ring, samples = 24): number {
  const ba = ringBox(a);
  const bb = ringBox(b);
  if (ba[0] > bb[2] || bb[0] > ba[2] || ba[1] > bb[3] || bb[1] > ba[3]) return 0;
  // Smaller by bounding box area (lat/lon degrees are near-square at building scale).
  const area = (x: [number, number, number, number]) => (x[2] - x[0]) * (x[3] - x[1]);
  const [small, big, box] = area(ba) <= area(bb) ? [a, b, ba] : [b, a, bb];
  let inSmall = 0;
  let inBoth = 0;
  for (let i = 0; i < samples; i++) {
    for (let j = 0; j < samples; j++) {
      const p = { lat: box[0] + ((i + 0.5) / samples) * (box[2] - box[0]), lon: box[1] + ((j + 0.5) / samples) * (box[3] - box[1]) };
      if (!insideOutline(small, p)) continue;
      inSmall++;
      if (insideOutline(big, p)) inBoth++;
    }
  }
  return inSmall ? inBoth / inSmall : 0;
}

/** The footprints of `extra` that don't duplicate any of `keep` (overlap above the threshold). */
export function dedupe(keep: TileBuilding[], extra: TileBuilding[], threshold = DUPLICATE_OVERLAP): TileBuilding[] {
  return extra.filter((x) => !keep.some((k) => overlapShare(k.outline, x.outline) > threshold));
}

/** Area-weighted centre of a ring (the vertex mean leans towards wherever the outline has more points). */
export function ringCentroid(ring: Ring): LatLon {
  // Relative to the first point: with raw coordinates the products cancel out and lose metres.
  const [lat0, lon0] = ring[0];
  let a = 0;
  let lat = 0;
  let lon = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [yi, xi] = [ring[i][0] - lat0, ring[i][1] - lon0];
    const [yj, xj] = [ring[j][0] - lat0, ring[j][1] - lon0];
    const f = xj * yi - xi * yj;
    a += f;
    lon += (xj + xi) * f;
    lat += (yj + yi) * f;
  }
  return a ? { lat: lat0 + lat / (3 * a), lon: lon0 + lon / (3 * a) } : ringCenter(ring);
}

/**
 * How far `extra`'s footprints sit from the `keep` buildings they duplicate, in metres (dx east, dz
 * south): one pair per kept building, its best match among those over the threshold and of about the
 * same size (so a block of footprints against one big OSM outline doesn't count). Near zero means both
 * datasets agree on where things are.
 */
export function matchOffsets(keep: TileBuilding[], extra: TileBuilding[], threshold = DUPLICATE_OVERLAP): { dx: number; dz: number }[] {
  const out: { dx: number; dz: number }[] = [];
  for (const k of keep) {
    const ak = ringArea(k.outline);
    let best: TileBuilding | null = null;
    let bestShare = threshold;
    for (const x of extra) {
      const ratio = ringArea(x.outline) / ak;
      if (ratio < 2 / 3 || ratio > 3 / 2) continue;
      const s = overlapShare(k.outline, x.outline);
      if (s > bestShare) (best = x), (bestShare = s);
    }
    if (!best) continue;
    const c = ringCentroid(k.outline);
    const p = toLocal(c, ringCentroid(best.outline));
    out.push({ dx: p.x, dz: p.z });
  }
  return out;
}

export function median(v: number[]): number {
  if (!v.length) return NaN;
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Hand corrections always win: `addBuildings` go in as source 'manual', then each entry of `buildings`
 * replaces the fields it sets on the building with that id, or removes it with `hide`. Returns the
 * ids that matched nothing, so the build can warn about them.
 */
export function applyBuildingOverrides(
  list: TileBuilding[],
  ov: { buildings?: BuildingOverride[]; addBuildings?: AddedBuilding[] },
): { buildings: TileBuilding[]; unknown: string[] } {
  const byId = new Map(list.map((b) => [b.id, b]));
  for (const a of ov.addBuildings ?? []) {
    byId.set(a.id, {
      id: a.id,
      name: a.name ?? null,
      height: a.height ?? DEFAULT_HEIGHT,
      levels: a.levels ?? null,
      source: 'manual',
      outline: closeRing(a.outline),
      entrances: a.entrances ?? [],
    });
  }
  const unknown: string[] = [];
  for (const o of ov.buildings ?? []) {
    const b = byId.get(o.id);
    if (!b) {
      unknown.push(o.id);
      continue;
    }
    if (o.hide) {
      byId.delete(o.id);
      continue;
    }
    byId.set(o.id, {
      ...b,
      ...(o.name !== undefined && { name: o.name }),
      ...(o.height !== undefined && { height: o.height }),
      ...(o.levels !== undefined && { levels: o.levels }),
      ...(o.entrances !== undefined && { entrances: o.entrances }),
      ...(o.outline !== undefined && { outline: closeRing(o.outline) }),
    });
  }
  return { buildings: [...byId.values()], unknown };
}

/** Joins open way pieces (a multipolygon's outer members) into closed rings. Unclosable pieces are dropped. */
export function stitchRings(pieces: Ring[]): Ring[] {
  const same = (p: [number, number], q: [number, number]) => p[0] === q[0] && p[1] === q[1];
  const left = pieces.filter((p) => p.length > 1).map((p) => [...p]);
  const rings: Ring[] = [];
  while (left.length) {
    const ring = left.shift()!;
    let grew = true;
    while (!same(ring[0], ring[ring.length - 1]) && grew) {
      grew = false;
      const end = ring[ring.length - 1];
      for (let i = 0; i < left.length; i++) {
        const p = left[i];
        if (same(p[0], end)) ring.push(...p.slice(1));
        else if (same(p[p.length - 1], end)) ring.push(...p.slice(0, -1).reverse());
        else continue;
        left.splice(i, 1);
        grew = true;
        break;
      }
    }
    if (ring.length > 3 && same(ring[0], ring[ring.length - 1])) rings.push(ring);
  }
  return rings;
}

/** Area in square degrees (shoelace); only used to compare rings. */
export function ringArea(ring: Ring): number {
  let s = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) s += (ring[j][1] + ring[i][1]) * (ring[j][0] - ring[i][0]);
  return Math.abs(s / 2);
}
