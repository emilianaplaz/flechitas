// Saved places mirrored to the signed-in account (Supabase table saved_places). The local list stays the source of
// truth for the UI. This layer merges what the account has, and uploads changes through a persisted outbox
// so they survive going offline. Takes its fetch, storage and token getter, so it runs the same in tests.
import { requestHeaders } from '../auth/session.ts';
import type { StorageLike } from '../auth/session.ts';
import { MAX_PINS, adoptUnowned, loadPins, writeVisiblePins, type Pin, type PinChange } from './pins.ts';

export interface MergeResult {
  merged: Pin[]; // what the local list becomes
  upload: Pin[]; // local pins the account lacks or has an older copy of
  evict: string[]; // remote ids pushed out by MAX_PINS, to delete from the account
}

const stamp = (x: Pin) => x.updatedAt ?? x.at;

/** Union by id. The newer `updatedAt` wins (a tie goes to the account). A pending delete is never resurrected. */
export function mergePins(local: Pin[], remote: Pin[], pendingDeletes: Iterable<string>): MergeResult {
  const deleted = new Set(pendingDeletes);
  const byId = new Map<string, Pin>();
  const upload = new Map<string, Pin>();
  for (const r of remote) if (!deleted.has(r.id)) byId.set(r.id, r);
  for (const l of local) {
    const r = byId.get(l.id);
    if (!r) {
      byId.set(l.id, l);
      upload.set(l.id, l);
    } else if (stamp(l) > stamp(r)) {
      byId.set(l.id, l);
      upload.set(l.id, l);
    }
  }
  const sorted = [...byId.values()].sort((a, b) => a.at - b.at);
  const kept = sorted.slice(-MAX_PINS);
  const cut = new Set(sorted.slice(0, sorted.length - kept.length).map((x) => x.id));
  const remoteIds = new Set(remote.map((x) => x.id));
  return {
    merged: kept,
    upload: [...upload.values()].filter((x) => !cut.has(x.id)),
    evict: [...cut].filter((id) => remoteIds.has(id)),
  };
}

export interface RemoteRow {
  client_id?: unknown;
  label?: unknown;
  lat?: unknown;
  lon?: unknown;
  acc?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
}

/** A pin from an account row, or null when the row is malformed. */
export function pinFromRow(r: RemoteRow, owner: string): Pin | null {
  const at = typeof r.created_at === 'string' ? Date.parse(r.created_at) : NaN;
  const updatedAt = typeof r.updated_at === 'string' ? Date.parse(r.updated_at) : at;
  if (typeof r.client_id !== 'string' || typeof r.label !== 'string' || !r.label) return null;
  if (typeof r.lat !== 'number' || typeof r.lon !== 'number' || !Number.isFinite(at) || !Number.isFinite(updatedAt)) return null;
  return { id: r.client_id, label: r.label, p: { lat: r.lat, lon: r.lon }, acc: typeof r.acc === 'number' ? r.acc : null, at, updatedAt, owner };
}

const rowFromPin = (x: Pin, userId: string) => ({
  user_id: userId,
  client_id: x.id,
  label: x.label,
  lat: x.p.lat,
  lon: x.p.lon,
  acc: x.acc,
  created_at: new Date(x.at).toISOString(),
  updated_at: new Date(stamp(x)).toISOString(),
});

export type Op = { owner: string; id: string; kind: 'delete' } | { owner: string; id: string; kind: 'upsert'; row: Record<string, unknown> };

export const OUTBOX_KEY = 'ar-nav.pins.outbox';

export interface PinsSyncDeps {
  config: { url: string; key: string } | null;
  fetch: typeof fetch;
  storage: StorageLike;
  user: () => string | null; // id of the signed-in user
  token: () => Promise<string | null>; // the current access token
  refresh: () => Promise<void>; // renews it after a 401
  onStatus?: () => void; // the queue changed
  onPins?: () => void; // the local list was rewritten by a merge
}

export type SyncStatus = 'off' | 'signedOut' | 'synced' | 'syncing';
type Sent = 'ok' | 'drop' | 'retry' | 'unauthorized';

export function createPinsSync(deps: PinsSyncDeps) {
  const { config } = deps;

  const read = (): Op[] => {
    try {
      const v: unknown = JSON.parse(deps.storage.getItem(OUTBOX_KEY) ?? '[]');
      return Array.isArray(v) ? (v as Op[]).filter((o) => typeof o?.id === 'string' && typeof o.owner === 'string') : [];
    } catch {
      return [];
    }
  };
  const write = (ops: Op[]) => {
    try {
      deps.storage.setItem(OUTBOX_KEY, JSON.stringify(ops));
    } catch {
      /* storage unavailable: the queue lives only until the page reloads */
    }
    deps.onStatus?.();
  };
  const mine = (uid: string) => read().filter((o) => o.owner === uid);

  /** The last op per pin id wins. */
  function enqueue(op: Op) {
    write([...read().filter((o) => !(o.owner === op.owner && o.id === op.id)), op]);
  }
  const enqueueChange = (uid: string, c: PinChange) =>
    enqueue(c.kind === 'delete' ? { owner: uid, id: c.id, kind: 'delete' } : { owner: uid, id: c.pin.id, kind: 'upsert', row: rowFromPin(c.pin, uid) });

  async function request(path: string, token: string, init: { method: string; body?: unknown; prefer?: string }): Promise<Response | null> {
    try {
      return await deps.fetch(`${config!.url}/rest/v1/${path}`, {
        method: init.method,
        headers: { ...requestHeaders(config!, token), ...(init.prefer ? { prefer: init.prefer } : {}) },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      });
    } catch {
      return null;
    }
  }

  async function send(op: Op, token: string): Promise<Sent> {
    const res =
      op.kind === 'upsert'
        ? await request('saved_places?on_conflict=user_id,client_id', token, { method: 'POST', body: op.row, prefer: 'resolution=merge-duplicates,return=minimal' })
        : await request(`saved_places?client_id=eq.${encodeURIComponent(op.id)}`, token, { method: 'DELETE' });
    if (!res) return 'retry';
    if (res.ok) return 'ok';
    if (res.status === 401) return 'unauthorized';
    // Other 4xx: the server will never accept this row, so it must not block the queue. 408 and 429 are transient.
    return res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429 ? 'drop' : 'retry';
  }

  let flushing: Promise<void> | null = null;

  async function doFlush() {
    const uid = deps.user();
    if (!config || !uid) return;
    let token = await deps.token();
    let refreshed = false;
    for (const op of mine(uid)) {
      if (!token || deps.user() !== uid) return;
      let r = await send(op, token);
      if (r === 'unauthorized' && !refreshed) {
        refreshed = true;
        await deps.refresh();
        token = await deps.token();
        if (!token) return;
        r = await send(op, token);
      }
      if (r === 'retry' || r === 'unauthorized') return; // offline or rejected token: keep the rest
      // Removed by identity of the sent op: a newer op for the same pin enqueued meanwhile stays.
      write(read().filter((o) => !(o.owner === op.owner && o.id === op.id && JSON.stringify(o) === JSON.stringify(op))));
    }
  }

  const flush = () => (flushing ??= doFlush().finally(() => (flushing = null)));

  async function pull(uid: string): Promise<Pin[] | null> {
    let token = await deps.token();
    if (!token) return null;
    const path = 'saved_places?select=client_id,label,lat,lon,acc,created_at,updated_at&order=created_at.asc';
    let res = await request(path, token, { method: 'GET' });
    if (res?.status === 401) {
      await deps.refresh();
      token = await deps.token();
      res = token ? await request(path, token, { method: 'GET' }) : null;
    }
    if (!res?.ok) return null;
    const rows: unknown = await res.json().catch(() => null);
    if (!Array.isArray(rows)) return null;
    return rows.map((r) => pinFromRow(r as RemoteRow, uid)).filter((x): x is Pin => x !== null);
  }

  let syncing: Promise<void> | null = null;

  /** Pull, merge into the local list, queue what the account lacks, then flush. */
  async function doSync() {
    const uid = deps.user();
    if (!config || !uid) return;
    const remote = await pull(uid);
    if (deps.user() !== uid) return;
    if (remote) {
      // No await between reading local state and writing it back, so edits made during the pull are merged, not lost.
      const pendingDeletes = mine(uid).filter((o) => o.kind === 'delete').map((o) => o.id);
      const m = mergePins(loadPins(), remote, pendingDeletes);
      writeVisiblePins(m.merged.map((x) => ({ ...x, owner: uid })));
      for (const x of m.upload) enqueueChange(uid, { kind: 'upsert', pin: { ...x, owner: uid } });
      for (const id of m.evict) enqueueChange(uid, { kind: 'delete', id });
      deps.onPins?.();
    }
    await flush();
  }

  const sync = () => (syncing ??= doSync().finally(() => (syncing = null)));

  return {
    sync,
    flush,
    /** Adopts pins made signed out, then syncs. Call when a user signs in. */
    async signedIn() {
      adoptUnowned();
      await sync();
    },
    /** A local edit made while signed in. */
    change(c: PinChange) {
      const uid = deps.user();
      if (!config || !uid) return;
      enqueueChange(uid, c);
      void flush();
    },
    pending: (uid: string) => mine(uid).length,
    status(): SyncStatus {
      const uid = deps.user();
      if (!config) return 'off';
      if (!uid) return 'signedOut';
      return mine(uid).length ? 'syncing' : 'synced';
    },
  };
}

export type PinsSync = ReturnType<typeof createPinsSync>;
