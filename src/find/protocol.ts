// "Ver a alguien": the person who wants to find someone shows a 6-digit code (and a link that holds it);
// the other person opens it and shares their GPS over a WebRTC data channel (PeerJS's public broker
// only introduces the two devices). Same pairing idea as the iPad HUD. Pure; tested in tests/run.ts.
import type { LatLon } from '../core/geo.ts';
import { newHudCode, normalizeCode } from '../remote/protocol.ts';

export { newHudCode as newShareCode, normalizeCode };

/** The watcher's peer id is derived from the code it shows, so the sharer can find it. */
export const FIND_PREFIX = 'viaar-find-';
export const findPeerId = (code: string): string => FIND_PREFIX + code;

export const SHARE_PARAM = 'comparte';
export const shareLink = (origin: string, code: string): string => `${origin}/?${SHARE_PARAM}=${code}`;

/** The code in a `?comparte=123456` link, or null. */
export function codeFromSearch(search: string): string | null {
  const raw = new URLSearchParams(search).get(SHARE_PARAM);
  return raw ? normalizeCode(raw) : null;
}

/** What the sharer sends. */
export type FindMsg =
  | { t: 'pos'; lat: number; lon: number; acc: number | null }
  | { t: 'ping' };

/** The sharer pings this often; the watcher calls the link lost after LOST_MS of silence. */
export const PING_MS = 1000;
export const LOST_MS = 6000;

/** A shared position older than this is shown as stale. */
export const STALE_MS = 15_000;

export interface Sighting {
  p: LatLon;
  acc: number | null;
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
