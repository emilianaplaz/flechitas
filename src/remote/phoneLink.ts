// Phone side of the link: the phone runs the app and, once linked to the iPad by its 6-digit code,
// sends what the windshield HUD needs: the route and exact arrival point when a drive starts (and
// on every reroute), GPS fixes (real or simulated), the phone's tilt (the car's body motion) and a
// heartbeat. No video. Reconnects by itself if the link drops.
import type { DataConnection, Peer } from 'peerjs'; // loaded on demand: most drives may not use the HUD
import type { Route } from '../core/route.ts';
import type { Fix } from '../core/types.ts';
import { poseFromEuler } from '../walk/orientation.ts';
import { interfaceAngle, physicalAngle } from './orient.ts';
import { PING_MS, encodeRoute, hudPeerId, type Arrival, type RemoteMsg } from './protocol.ts';

export type LinkState = 'off' | 'connecting' | 'on' | 'lost';

let peer: Peer | null = null;
let conn: DataConnection | null = null;
let wanted: string | null = null; // the code we should stay connected to
let state: LinkState = 'off';
let lastFix = { t: -1, sent: 0 };
let euler: { alpha: number; beta: number; gamma: number; t: number } | null = null;
let upAngle = currentInterface();
let timers: number[] = [];
let retry = 0;
const listeners: ((s: LinkState) => void)[] = [];
let current: (() => { route: Route; arrival: Arrival | null } | null) | null = null;

export const hudState = (): LinkState => state;
export const hudLinked = (): boolean => state === 'on';
export const hudCode = (): string | null => wanted;

export function onHudState(fn: (s: LinkState) => void) {
  listeners.push(fn);
}

/** What to send the iPad as soon as it connects, if a drive is already running. */
export function setDriveProvider(fn: () => { route: Route; arrival: Arrival | null } | null) {
  current = fn;
}

function setState(s: LinkState) {
  state = s;
  listeners.forEach((fn) => fn(s));
}

function currentInterface(): number {
  return interfaceAngle(screen.orientation?.angle, (window as unknown as { orientation?: number }).orientation);
}

function onOrientation(e: DeviceOrientationEvent) {
  if (e.beta == null || e.gamma == null) return;
  euler = { alpha: e.alpha ?? 0, beta: e.beta, gamma: e.gamma, t: performance.now() };
  upAngle = physicalAngle(e.beta, e.gamma, upAngle);
}

/** iOS asks for motion permission inside a tap: call connectHud from one. Optional; without it the HUD just doesn't follow body motion. */
async function requestMotion() {
  const DOE = DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> };
  try {
    if (DOE.requestPermission && (await DOE.requestPermission()) !== 'granted') return;
  } catch {
    return;
  }
  window.removeEventListener('deviceorientation', onOrientation);
  window.addEventListener('deviceorientation', onOrientation);
}

function send(m: RemoteMsg) {
  if (conn?.open) conn.send(m);
}

function clearTimers() {
  timers.forEach((t) => clearInterval(t));
  timers = [];
}

async function dial() {
  if (!wanted) return;
  const code = wanted;
  setState(state === 'on' ? 'lost' : 'connecting');
  const { Peer } = await import('peerjs');
  peer?.destroy();
  const p = new Peer();
  peer = p;
  p.on('error', () => drop(p));
  p.on('open', () => {
    const c = p.connect(hudPeerId(code), { serialization: 'json' });
    conn = c;
    c.on('open', () => {
      if (peer !== p) return;
      retry = 0;
      setState('on');
      clearTimers();
      timers.push(window.setInterval(() => send({ t: 'ping' }), PING_MS));
      // Tilt relative to the phone's physical "up" (mounted sideways or not), 20 Hz.
      timers.push(
        window.setInterval(() => {
          if (!euler || performance.now() - euler.t > 1500) return;
          const pose = poseFromEuler(euler.alpha, euler.beta, euler.gamma, upAngle);
          send({ t: 'tilt', pitch: +pose.pitch.toFixed(2), roll: +pose.roll.toFixed(2) });
        }, 50),
      );
      const drive = current?.();
      if (drive) sendRoute(drive.route, drive.arrival);
    });
    c.on('close', () => drop(p));
    c.on('error', () => drop(p));
  });
}

function drop(p: Peer) {
  if (peer !== p) return;
  clearTimers();
  conn = null;
  if (!wanted) return setState('off');
  setState('lost');
  // Keep trying while the person wants the HUD: the iPad may just have reloaded.
  retry = Math.min(retry + 1, 5);
  setTimeout(() => peer === p && void dial(), 1000 * retry);
}

/** Link to the iPad showing `code`. Call inside a tap (motion permission on iOS). */
export async function connectHud(code: string) {
  await requestMotion();
  wanted = code;
  retry = 0;
  await dial();
}

export function disconnectHud() {
  wanted = null;
  clearTimers();
  peer?.destroy();
  peer = null;
  conn = null;
  setState('off');
}

/** A drive started or was rerouted. */
export function sendRoute(route: Route, arrival: Arrival | null) {
  send(encodeRoute(route, arrival));
}

export function sendStop() {
  send({ t: 'stop' });
}

/** Per frame: forwards the position. Real GPS sends each new fix; a simulated drive ~10 times a second. */
export function sendFix(now: number, fix: Fix) {
  if (state !== 'on') return;
  if (now - lastFix.sent < 100) return; // at most ~10 per second
  if (fix.t === lastFix.t && now - lastFix.sent < 1000) return; // same GPS fix: once a second is enough
  lastFix = { t: fix.t, sent: now };
  send({ t: 'fix', lat: fix.p.lat, lon: fix.p.lon, speed: fix.speed, heading: fix.heading, acc: fix.accuracy });
}
