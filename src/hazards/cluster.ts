// The same hueco or bump is reported many times, each a few metres off (GPS error, taps placed behind the car).
// Reports of one type that sit close together and face the same way are merged into one hazard.
// Done when the list is read, because the app can't edit rows in the database.
import { angleDiff, haversine } from '../core/geo.ts';
import type { Hazard, HazardType } from './store.ts';

const RADIUS_M: Partial<Record<HazardType, number>> = { policia: 15, hueco: 12 };
const DEFAULT_RADIUS_M = 12;
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

const near = (g: Group, h: Hazard) => {
  if ((g.heading != null && h.heading != null && Math.abs(angleDiff(g.heading, h.heading)) > MAX_HEADING_DIFF)) return false;
  return haversine(g, h) <= (RADIUS_M[h.type] ?? DEFAULT_RADIUS_M);
};

export function clusterHazards(all: Hazard[], now = Date.now()): Hazard[] {
  const groups: Group[] = [];
  const byType = new Map<HazardType, Group[]>();
  for (const h of [...all].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    const list = byType.get(h.type) ?? [];
    byType.set(h.type, list);
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
    const ttl = TTL_MS[g.members[0]!.type];
    if (!osm && ttl && lastSeen && now - lastSeen > ttl) continue;
    const first = osm ?? g.members[0]!;
    out.push({
      ...first,
      lat: osm ? osm.lat : g.lat,
      lon: osm ? osm.lon : g.lon,
      ...(g.heading != null ? { heading: g.heading } : {}),
      confirmations: g.members.length,
      ...(lastSeen ? { lastSeen: new Date(lastSeen).toISOString() } : {}),
    });
  }
  return out;
}
