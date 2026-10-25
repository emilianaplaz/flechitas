// Places the person saved ("where I parked"), kept on this phone and, when signed in, mirrored to their account (see pinsSync.ts).
import type { LatLon } from '../core/geo.ts';

export interface Pin {
  id: string;
  label: string;
  p: LatLon;
  acc: number | null; // GPS accuracy when it was dropped, metres
  at: number; // Date.now()
  updatedAt?: number; // last add or rename; older pins fall back to `at`
  owner?: string; // user id the pin belongs to; unset while it was made signed out
}

export type PinChange = { kind: 'upsert'; pin: Pin } | { kind: 'delete'; id: string };

const KEY = 'ar-nav.pins';
export const MAX_PINS = 8;

let owner: string | null = null;
let listener: ((change: PinChange) => void) | null = null;

/** Who is signed in. Pins of anyone else stay on the device but are invisible. */
export function setPinOwner(userId: string | null) {
  owner = userId;
}

/** Called for every local change made while signed in. */
export function onPinChange(fn: (change: PinChange) => void) {
  listener = fn;
}

const emit = (c: PinChange) => {
  if (owner) listener?.(c);
};

function readAll(): Pin[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]') as Pin[];
    return Array.isArray(v) ? v.filter((x) => typeof x?.id === 'string' && Number.isFinite(x.p?.lat) && Number.isFinite(x.p?.lon)) : [];
  } catch {
    return [];
  }
}

const visibleTo = (x: Pin) => x.owner === undefined || x.owner === owner;

export function loadPins(): Pin[] {
  return readAll().filter(visibleTo);
}

function writeAll(pins: Pin[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(pins));
  } catch {
    /* storage unavailable: pins live only until the page reloads */
  }
}

/** Replaces the visible pins, keeping everyone else's untouched. */
export function writeVisiblePins(pins: Pin[]) {
  writeAll([...readAll().filter((x) => !visibleTo(x)), ...pins]);
}

/** Gives the pins made while signed out to the signed-in user. Returns them. */
export function adoptUnowned(): Pin[] {
  if (!owner) return [];
  const all = readAll();
  const adopted = all.filter((x) => x.owner === undefined).map((x) => ({ ...x, owner: owner! }));
  if (adopted.length) writeAll(all.map((x) => (x.owner === undefined ? { ...x, owner: owner! } : x)));
  return adopted;
}

/** Adds a pin named "Lugar N" (the next free number); at MAX_PINS the oldest goes. */
export function addPin(p: LatLon, acc: number | null, now = Date.now()): Pin {
  const pins = loadPins();
  const used = pins.map((x) => /^Lugar (\d+)$/.exec(x.label)?.[1]).filter(Boolean).map(Number);
  const pin: Pin = { id: `pin-${now}`, label: `Lugar ${Math.max(0, ...used) + 1}`, p, acc, at: now, updatedAt: now, ...(owner ? { owner } : {}) };
  const all = [...pins, pin];
  const kept = all.slice(-MAX_PINS);
  writeVisiblePins(kept);
  for (const dropped of all.slice(0, all.length - kept.length)) emit({ kind: 'delete', id: dropped.id });
  emit({ kind: 'upsert', pin });
  return pin;
}

export function renamePin(id: string, label: string, now = Date.now()) {
  const name = label.trim().slice(0, 40);
  const pins = loadPins();
  const found = pins.find((x) => x.id === id);
  if (!name || !found) return;
  const next = { ...found, label: name, updatedAt: now };
  writeVisiblePins(pins.map((x) => (x.id === id ? next : x)));
  emit({ kind: 'upsert', pin: next });
}

export function removePin(id: string) {
  const pins = loadPins();
  if (!pins.some((x) => x.id === id)) return;
  writeVisiblePins(pins.filter((x) => x.id !== id));
  emit({ kind: 'delete', id });
}
