// The same hueco or bump is reported many times, each a few metres off (GPS error, taps placed behind the car).
// Reports that sit close together and face the same way are merged into one hazard. Hueco and policía share one
// pool because the detector can mistake one for the other; the type with the larger total weight wins.
// Done when the list is read, because the app can't edit rows in the database.
import { angleDiff, haversine } from '../core/geo.ts';
import type { Hazard, HazardType } from './store.ts';

const ROAD_RADIUS_M = 15;
const ALCABALA_RADIUS_M = 12;
/** A cluster is listed only from this total weight: one lone unconfirmed detection (0.5) is kept but stays hidden. */
export const MIN_SHOW_WEIGHT = 1;
export const OSM_WEIGHT = 3; // a mapped bump is authoritative
export const CONFIRMED_WEIGHT = 1;
export const UNCONFIRMED_WEIGHT = 0.5;

export function weightOf(h: Hazard): number {
  if (h.source === 'osm') return OSM_WEIGHT;
  if (h.source === 'tap' || h.confirmed === true) return CONFIRMED_WEIGHT;
  if (h.source === 'detected') return UNCONFIRMED_WEIGHT;
  return CONFIRMED_WEIGHT; // legacy rows without a source
}
const MAX_HEADING_DIFF = 60;
const DAY_MS = 86_400_000;
/** How long a hazard stays valid after its newest report. Potholes get patched; bumps are built to stay. */
const TTL_MS: Partial<Record<HazardType, number>> = { hueco: 90 * DAY_MS, policia: 365 * DAY_MS };

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

interface Group {
  members: Hazard[];
  lat: number;
  lon: number;
  heading?: number;
}

const poolOf = (t: HazardType) => (t === 'alcabala' ? 'alcabala' : 'road');

const near = (g: Group, h: Hazard) => {
  if ((g.heading != null && h.heading != null && Math.abs(angleDiff(g.heading, h.heading)) > MAX_HEADING_DIFF)) return false;
  return haversine(g, h) <= (h.type === 'alcabala' ? ALCABALA_RADIUS_M : ROAD_RADIUS_M);
};

/** Larger summed weight wins; a tie goes to the newest report (members are in time order). */
function winningType(members: Hazard[]): HazardType {
  const sum = new Map<HazardType, number>();
  for (const m of members) sum.set(m.type, (sum.get(m.type) ?? 0) + weightOf(m));
  let best = members[members.length - 1]!.type;
  for (const [t, w] of sum) if (w > sum.get(best)!) best = t;
  return best;
}

export function clusterHazards(all: Hazard[], now = Date.now()): Hazard[] {
  const groups: Group[] = [];
  const byPool = new Map<string, Group[]>();
  for (const h of [...all].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    const pool = poolOf(h.type);
    const list = byPool.get(pool) ?? [];
    byPool.set(pool, list);
    const g = list.find((x) => near(x, h));
    if (g) {
      g.members.push(h);
      g.lat = median(g.members.map((m) => m.lat));
      g.lon = median(g.members.map((m) => m.lon));
      g.heading ??= h.heading;
    } else {
      const created: Group = { members: [h], lat: h.lat, lon: h.lon, heading: h.heading };
      list.push(created);
      groups.push(created);
    }
  }

  const out: Hazard[] = [];
  for (const g of groups) {
    const osm = g.members.find((m) => m.source === 'osm'); // a mapped bump is exact and never expires
    const reports = g.members.filter((m) => m.source !== 'osm');
    const stamps = reports.map((m) => Date.parse(m.createdAt)).filter((t) => !Number.isNaN(t));
    const lastSeen = stamps.length ? Math.max(...stamps) : 0;
    const type = winningType(g.members);
    const ttl = TTL_MS[type];
    if (!osm && ttl && lastSeen && now - lastSeen > ttl) continue;
    const total = g.members.reduce((n, m) => n + weightOf(m), 0);
    if (!osm && total < MIN_SHOW_WEIGHT) continue;
    const first = osm ?? g.members.find((m) => m.type === type)!;
    out.push({
      ...first,
      type,
      lat: osm ? osm.lat : g.lat,
      lon: osm ? osm.lon : g.lon,
      ...(g.heading != null ? { heading: g.heading } : {}),
      confirmations: g.members.length,
      ...(lastSeen ? { lastSeen: new Date(lastSeen).toISOString() } : {}),
    });
  }
  return out;
}
