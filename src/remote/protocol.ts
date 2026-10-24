// Remote camera: a phone streams its camera (plus GPS and tilt) to the app running on a laptop or
// iPad, paired by scanning a QR code. Video goes over WebRTC; PeerJS's public broker only
// introduces the two devices. This file is the small contract both sides share.

/** Peer ids are random and short-lived: a new QR per page load. */
export const PEER_PREFIX = 'viaar-';

export function newPeerId(): string {
  const chars = 'abcdefghijkmnpqrstuvwxyz23456789';
  let s = '';
  for (let i = 0; i < 8; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return PEER_PREFIX + s;
}

/** Messages the phone sends over the data channel. */
export type RemoteMsg =
  | { t: 'fix'; lat: number; lon: number; speed: number | null; heading: number | null; acc: number | null }
  | { t: 'tilt'; pitch: number; roll: number }
  | { t: 'ping' };

/** The phone pings this often; the display gives up after LOST_MS of silence (a closed tab or a locked phone says nothing). */
export const PING_MS = 1000;
export const LOST_MS = 5000;

/** The page the phone opens: same app, `?cam=<display peer id>`. */
export function phoneUrl(origin: string, peerId: string): string {
  return `${origin}/?cam=${encodeURIComponent(peerId)}`;
}

/**
 * The origin a phone on the same Wi-Fi can reach. `localhost` only works on the laptop itself,
 * so in development it's swapped for the laptop's network address.
 */
export function reachableOrigin(loc: { protocol: string; hostname: string; port: string; origin: string }, lanHost: string): string {
  const local = loc.hostname === 'localhost' || loc.hostname.startsWith('127.') || loc.hostname === '[::1]';
  if (!local || !lanHost) return loc.origin;
  return `${loc.protocol}//${lanHost}${loc.port ? `:${loc.port}` : ''}`;
}
