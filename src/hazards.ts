// Road hazards (huecos, policías acostados…). Each one is just a GPS point.
// Seeds come from /hazards.json; reports made on this phone are kept in localStorage.
import type { LatLon } from './geo.ts';
import { cancel, enqueue, fetchShared } from './cloud.ts';

export type HazardType = 'hueco' | 'policia' | 'alcabala';

export interface Hazard extends LatLon {
  id: string;
  type: HazardType;
  createdAt: string;
  heading?: number; // travel direction when reported; hazards in the other direction are ignored
  source?: 'tap' | 'detected';
}

export const HAZARD_LABEL: Record<HazardType, string> = {
  hueco: 'HUECO',
  policia: 'POLICÍA ACOSTADO',
  alcabala: 'ALCABALA',
};

const KEY = 'ar-nav.hazards';

function loadLocal(): Hazard[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '[]') as Hazard[];
  } catch {
    return [];
  }
}

function saveLocal(list: Hazard[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* storage unavailable — reports live only for this session */
  }
}

export class HazardStore {
  seeds: Hazard[] = [];
  shared: Hazard[] = [];
  local: Hazard[] = loadLocal();

  async loadSeeds() {
    try {
      const res = await fetch('/hazards.json', { cache: 'no-store' });
      if (res.ok) this.seeds = (await res.json()) as Hazard[];
    } catch {
      /* no seed file — fine */
    }
  }

  async loadShared() {
    this.shared = await fetchShared();
  }

  /** Seeds, everyone's reports and this phone's own, one entry per id (a report we uploaded comes back from the database). */
  all(): Hazard[] {
    const byId = new Map<string, Hazard>();
    for (const h of [...this.seeds, ...this.shared, ...this.local]) byId.set(h.id, h);
    return [...byId.values()];
  }

  add(type: HazardType, p: LatLon, extra: { heading?: number; source?: Hazard['source'] } = {}): Hazard {
    const h: Hazard = {
      id: crypto.randomUUID?.() ?? Math.random().toString(36).slice(2, 12),
      type,
      lat: +p.lat.toFixed(6),
      lon: +p.lon.toFixed(6),
      createdAt: new Date().toISOString(),
      ...extra,
    };
    this.local.push(h);
    saveLocal(this.local);
    enqueue('hazards', { client_id: h.id, type: h.type, lat: h.lat, lon: h.lon, heading: h.heading ?? null, source: h.source ?? null }, h.id);
    return h;
  }

  undoLast(): Hazard | undefined {
    const h = this.local.pop();
    saveLocal(this.local);
    if (h) cancel(h.id);
    return h;
  }

  clearLocal() {
    this.local = [];
    saveLocal(this.local);
  }

  /** Everything, ready to paste into public/hazards.json. */
  exportJson(): string {
    return JSON.stringify(this.all(), null, 2);
  }
}
