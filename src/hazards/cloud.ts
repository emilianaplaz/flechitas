// Shared hazard database (Supabase) with an offline queue. With no keys configured the app works as before.
import type { Hazard } from './store.ts';

const URL_BASE = (import.meta.env?.VITE_SUPABASE_URL as string | undefined)?.replace(/\/$/, '');
const KEY = import.meta.env?.VITE_SUPABASE_ANON_KEY as string | undefined;
export const cloudEnabled = Boolean(URL_BASE && KEY);

// Legacy anon keys are JWTs and also go in Authorization. New sb_publishable_ keys are not JWTs: apikey alone.
const authHeaders = (): Record<string, string> => ({ apikey: KEY!, ...(KEY!.startsWith('eyJ') ? { authorization: `Bearer ${KEY}` } : {}) });

export type Table = 'hazards' | 'detections';
export interface OutboxEntry {
  id: string; // also the row's client_id, so a retried upload can't create a duplicate
  table: Table;
  row: Record<string, unknown>;
  due: number; // ms epoch: hazards wait out the undo window, detections go straight away
}

const OUTBOX = 'ar-nav.outbox';
const SHARED = 'ar-nav.shared';
export const UNDO_WINDOW_MS = 60_000;

function read<T>(key: string, fallback: T): T {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null') ?? fallback;
  } catch {
    return fallback;
  }
}
function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable: reports live only for this session */
  }
}

export const pending = (): OutboxEntry[] => read<OutboxEntry[]>(OUTBOX, []);

export function enqueue(table: Table, row: Record<string, unknown>, id: string, now = Date.now(), delayMs = UNDO_WINDOW_MS) {
  write(OUTBOX, [...pending().filter((e) => e.id !== id), { id, table, row, due: now + delayMs }]);
}

export function cancel(id: string) {
  write(OUTBOX, pending().filter((e) => e.id !== id));
}

async function sendToSupabase(e: OutboxEntry): Promise<boolean> {
  if (!cloudEnabled) return false;
  try {
    const res = await fetch(`${URL_BASE}/rest/v1/${e.table}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(), prefer: 'return=minimal' },
      body: JSON.stringify(e.row),
    });
    // 409 = this client_id is already stored (an earlier attempt got through but its reply was lost).
    return res.ok || res.status === 409;
  } catch {
    return false;
  }
}

let flushing = false;

/** Uploads what is due. Returns how many entries were sent. `force` ignores the undo window (the drive ended). */
export async function flush(opts: { force?: boolean; now?: number; send?: (e: OutboxEntry) => Promise<boolean> } = {}): Promise<number> {
  const send = opts.send ?? sendToSupabase;
  if (flushing || (!opts.send && !cloudEnabled)) return 0;
  flushing = true;
  let sent = 0;
  try {
    const now = opts.now ?? Date.now();
    for (const e of pending()) {
      if (!opts.force && e.due > now) continue;
      if (!(await send(e))) break; // offline or server down: keep the rest for the next try
      cancel(e.id);
      sent++;
    }
  } finally {
    flushing = false;
  }
  return sent;
}

type Row = { client_id: string; type: Hazard['type']; lat: number; lon: number; heading: number | null; source: Hazard['source'] | null; created_at: string };

/** Hazards reported by everyone. Falls back to the copy from the last successful load. */
export async function fetchShared(timeoutMs = 4000): Promise<Hazard[]> {
  const cached = read<Hazard[]>(SHARED, []);
  if (!cloudEnabled) return cached;
  try {
    const res = await Promise.race([
      fetch(`${URL_BASE}/rest/v1/hazards?select=client_id,type,lat,lon,heading,source,created_at&order=created_at.desc&limit=5000`, {
        headers: authHeaders(),
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs)),
    ]);
    if (!res.ok) return cached;
    const rows = (await res.json()) as Row[];
    const list: Hazard[] = rows.map((r) => ({
      id: r.client_id,
      type: r.type,
      lat: r.lat,
      lon: r.lon,
      createdAt: r.created_at,
      ...(r.heading != null ? { heading: r.heading } : {}),
      ...(r.source ? { source: r.source } : {}),
    }));
    write(SHARED, list);
    return list;
  } catch {
    return cached;
  }
}
