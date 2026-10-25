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

/**
 * The viewer sends `hello` once per connection and `ping` after, so the sharer can tell it is still there.
 * The sharer sends `pos` only after `ok`; `deny` ends the attempt.
 */
export type FindMsg =
  | { t: 'pos'; lat: number; lon: number; acc: number | null }
  | { t: 'ping' }
  | { t: 'hello'; name: string | null; sid: string }
  | { t: 'ok' }
  | { t: 'deny' };

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

/** How long the sharer has to answer a prompt before it counts as a denial. */
export const ASK_TTL_MS = 60_000;
/** After this many denials the share stops: the code is being guessed or abused. */
export const MAX_DENIALS = 3;

/** Names are self-reported and shown on the sharer's screen, so keep them short, one line and printable. */
export function sanitizeName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const clean = raw
    .slice(0, 400)
    .replace(/\s/g, ' ')
    .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '')
    .replace(/ +/g, ' ')
    .trim();
  return [...clean].slice(0, 40).join('').trim() || null;
}

/** A 128-bit random id, hex: lets the sharer recognize a viewer that redials after a dropped link. */
export function newSessionId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The viewer's greeting from the wire, or null. */
export function parseHello(raw: unknown): { name: string | null; sid: string } | null {
  const m = raw as { t?: unknown; name?: unknown; sid?: unknown } | null;
  if (m?.t !== 'hello' || typeof m.sid !== 'string' || !/^[0-9a-f]{16,64}$/i.test(m.sid)) return null;
  return { name: sanitizeName(m.name), sid: m.sid };
}

export type Verdict = 'ask' | 'auto' | 'refuse';

type Gate = { k: 'idle' } | { k: 'asking'; sid: string; name: string | null; since: number } | { k: 'admitted'; sid: string };

/**
 * Who may see the position. `ViewerSlot` keeps one connection at a time; this decides whether that
 * connection's viewer is let in: asked once, remembered for the share session (a redial after a drop
 * is not asked again), and the share is locked after too many refusals. The caller calls `leave` when
 * the connection ends.
 */
export class ApprovalGate {
  private state: Gate = { k: 'idle' };
  private approved = new Set<string>();
  private denied = new Set<string>();
  private now: () => number;
  denials = 0;

  constructor(now: () => number) {
    this.now = now;
  }

  hello(sid: string, name: string | null): Verdict {
    if (this.locked() || this.denied.has(sid) || this.state.k !== 'idle') return 'refuse';
    if (this.approved.has(sid)) {
      this.state = { k: 'admitted', sid };
      return 'auto';
    }
    this.state = { k: 'asking', sid, name, since: this.now() };
    return 'ask';
  }

  /** Who is waiting for an answer, or null. */
  asking(): { name: string | null } | null {
    return this.state.k === 'asking' ? { name: this.state.name } : null;
  }

  allow() {
    if (this.state.k !== 'asking') return;
    this.approved.add(this.state.sid);
    this.state = { k: 'admitted', sid: this.state.sid };
  }

  deny() {
    if (this.state.k !== 'asking') return;
    this.denied.add(this.state.sid);
    this.denials++;
    this.state = { k: 'idle' };
  }

  /** The connection ended: an unanswered prompt goes away, an approval stays for a redial. */
  leave() {
    this.state = { k: 'idle' };
  }

  askExpired(): boolean {
    return this.state.k === 'asking' && this.now() - this.state.since >= ASK_TTL_MS;
  }

  locked(): boolean {
    return this.denials >= MAX_DENIALS;
  }
}

/** "hace 12 s", "hace 3 min". */
export function ageLabel(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `hace ${s} s` : `hace ${Math.round(s / 60)} min`;
}
