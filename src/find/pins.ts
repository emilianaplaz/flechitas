// Places the person saved ("where I parked"), kept on this phone.
import type { LatLon } from '../core/geo.ts';

export interface Pin {
  id: string;
  label: string;
  p: LatLon;
  acc: number | null; // GPS accuracy when it was dropped, metres
  at: number; // Date.now()
}

const KEY = 'ar-nav.pins';
export const MAX_PINS = 8;

export function loadPins(): Pin[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]') as Pin[];
    return Array.isArray(v) ? v.filter((x) => typeof x?.id === 'string' && Number.isFinite(x.p?.lat) && Number.isFinite(x.p?.lon)) : [];
  } catch {
    return [];
  }
}

function save(pins: Pin[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(pins));
  } catch {
    /* storage unavailable: pins live only until the page reloads */
  }
}

/** Adds a pin named "Lugar N" (the next free number); at MAX_PINS the oldest goes. */
export function addPin(p: LatLon, acc: number | null, now = Date.now()): Pin {
  const pins = loadPins();
  const used = pins.map((x) => /^Lugar (\d+)$/.exec(x.label)?.[1]).filter(Boolean).map(Number);
  const pin: Pin = { id: `pin-${now}`, label: `Lugar ${Math.max(0, ...used) + 1}`, p, acc, at: now };
  save([...pins, pin].slice(-MAX_PINS));
  return pin;
}

export function renamePin(id: string, label: string) {
  const name = label.trim().slice(0, 40);
  if (name) save(loadPins().map((x) => (x.id === id ? { ...x, label: name } : x)));
}

export function removePin(id: string) {
  save(loadPins().filter((x) => x.id !== id));
}
