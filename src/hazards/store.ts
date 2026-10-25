// Road hazards (huecos, policías acostados…). Each one is just a GPS point.
// Reports made on this phone are kept in localStorage and uploaded to Supabase.
import type { LatLon } from '../core/geo.ts';
import { amend, cancel, enqueue, fetchShared } from './cloud.ts';
import { clusterHazards } from './cluster.ts';

export type HazardType = 'hueco' | 'policia' | 'alcabala';

export interface Hazard extends LatLon {
  id: string;
  type: HazardType;
  createdAt: string;
  heading?: number; // travel direction when reported; hazards in the other direction are ignored
  source?: 'tap' | 'detected' | 'osm'; // osm: speed bumps from the maqueta tiles, never uploaded
  simulated?: true; // from the mock accelerometer of Simulación/Repetición: lives in memory for the drive, never saved or uploaded
  confirmed?: boolean; // the driver said it was a hole; unconfirmed detections weigh half in a cluster
  confirmations?: number; // reports merged into this hazard (set by clusterHazards)
  lastSeen?: string; // newest report merged into it
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
  shared: Hazard[] = [];
  local: Hazard[] = loadLocal();
  osm: Hazard[] = []; // speed bumps from the maqueta tiles of the current route
  simulated: Hazard[] = [];

  async loadShared() {
    this.shared = await fetchShared();
  }

  /** Everyone's reports and this phone's own, one entry per id (a report we uploaded comes back from the database), then merged by place and expired. */
  all(): Hazard[] {
    const byId = new Map<string, Hazard>();
    for (const h of [...this.osm, ...this.shared, ...this.local, ...this.simulated]) byId.set(h.id, h);
    return clusterHazards([...byId.values()]);
  }

  private create(type: HazardType, p: LatLon, extra: { heading?: number; source?: Hazard['source']; confirmed?: boolean }): Hazard {
    return {
      id: crypto.randomUUID?.() ?? Math.random().toString(36).slice(2, 12),
      type,
      lat: +p.lat.toFixed(6),
      lon: +p.lon.toFixed(6),
      createdAt: new Date().toISOString(),
      ...extra,
      confirmed: extra.confirmed ?? extra.source !== 'detected',
    };
  }

  add(type: HazardType, p: LatLon, extra: { heading?: number; source?: Hazard['source']; confirmed?: boolean } = {}): Hazard {
    const h = this.create(type, p, extra);
    this.local.push(h);
    saveLocal(this.local);
    enqueue('hazards', { client_id: h.id, type: h.type, lat: h.lat, lon: h.lon, heading: h.heading ?? null, source: h.source ?? null, confirmed: h.confirmed }, h.id);
    return h;
  }

  /** A mock detection: counted like a real unconfirmed one for this drive, but not saved and not queued for upload. */
  addSimulated(type: HazardType, p: LatLon, extra: { heading?: number } = {}): Hazard {
    const h: Hazard = { ...this.create(type, p, { ...extra, source: 'detected' }), simulated: true };
    this.simulated.push(h);
    return h;
  }

  clearSimulated() {
    this.simulated = [];
  }

  /** The driver tapped the hole button: this report was a hueco. */
  confirm(id: string): Hazard | undefined {
    const h = this.local.find((x) => x.id === id) ?? this.simulated.find((x) => x.id === id);
    if (!h) return undefined;
    h.type = 'hueco';
    h.confirmed = true;
    if (!h.simulated) {
      saveLocal(this.local);
      amend(id, { type: 'hueco', confirmed: true });
    }
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
}
