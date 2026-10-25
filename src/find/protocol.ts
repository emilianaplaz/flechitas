// "Encontrar": the person who shares their location shows a 6-digit code (and a link that holds it);
// the one who wants to see them types it (or opens the link) and receives their GPS over a WebRTC data
// channel (PeerJS's public broker only introduces the two devices). Same pairing idea as the iPad HUD.
// Pure; tested in tests/run.ts.
import type { LatLon } from '../core/geo.ts';
import { newHudCode, normalizeCode } from '../remote/protocol.ts';

export { newHudCode as newShareCode, normalizeCode };

/** The sharer's peer id is derived from the code it shows, so the viewer can dial it. */
export const FIND_PREFIX = 'viaar-find-';
export const findPeerId = (code: string): string => FIND_PREFIX + code;

export const SHARE_PARAM = 'comparte';
export const shareLink = (origin: string, code: string): string => `${origin}/?${SHARE_PARAM}=${code}`;

/** The code in a `?comparte=123456` link, or null. */
export function codeFromSearch(search: string): string | null {
  const raw = new URLSearchParams(search).get(SHARE_PARAM);
  return raw ? normalizeCode(raw) : null;
}

/** What the sharer sends. The viewer only sends `ping`, so the sharer can tell its viewer is still there. */
export type FindMsg =
  | { t: 'pos'; lat: number; lon: number; acc: number | null }
  | { t: 'ping' };

/** Each end pings this often; either calls the link lost after LOST_MS of silence. */
export const PING_MS = 1000;
export const LOST_MS = 6000;

/** A code nobody has used for this long stops being shared: it protects a live location. */
export const CODE_TTL_MS = 10 * 60_000;

/** A shared position older than this is shown as stale. */
export const STALE_MS = 15_000;

export interface Sighting {
  p: LatLon;
  acc: number | null;
}

/**
 * The sharer's single seat for a viewer. A second connection is refused while the first was heard within
 * `lostMs`, and the code expires when no viewer has been there for `ttlMs` (counted from the start, or
 * from the moment the last viewer went quiet).
 */
export class ViewerSlot {
  private lastHeard: number | null = null;
  private emptySince: number;
  private now: () => number;
  private lostMs: number;
  private ttlMs: number;

  constructor(now: () => number, lostMs = LOST_MS, ttlMs = CODE_TTL_MS) {
    this.now = now;
    this.lostMs = lostMs;
    this.ttlMs = ttlMs;
    this.emptySince = now();
  }

  /** True if the newcomer takes the seat; false if the current viewer is still alive. */
  admit(): boolean {
    if (this.alive()) return false;
    this.lastHeard = this.now();
    return true;
  }

  heard() {
    if (this.lastHeard !== null) this.lastHeard = this.now();
  }

  alive(): boolean {
    return this.lastHeard !== null && this.now() - this.lastHeard <= this.lostMs;
  }

  /** The viewer left or went silent: the expiry clock starts again from now. */
  release() {
    this.lastHeard = null;
    this.emptySince = this.now();
  }

  expired(): boolean {
    if (this.alive()) return false;
    const since = this.lastHeard === null ? this.emptySince : this.lastHeard + this.lostMs;
    return this.now() - since >= this.ttlMs;
  }
}

/** A position from the wire, or null: anyone who learns the code can connect, so nothing is trusted. */
export function parsePos(raw: unknown): Sighting | null {
  const m = raw as { t?: unknown; lat?: unknown; lon?: unknown; acc?: unknown } | null;
  if (m?.t !== 'pos') return null;
  const { lat, lon, acc } = m;
  if (typeof lat !== 'number' || typeof lon !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { p: { lat, lon }, acc: typeof acc === 'number' && Number.isFinite(acc) && acc >= 0 ? acc : null };
}

/** "hace 12 s", "hace 3 min". */
export function ageLabel(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `hace ${s} s` : `hace ${Math.round(s / 60)} min`;
}
