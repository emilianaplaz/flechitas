// Phone ↔ iPad link. The phone runs the app (UI, GPS, sensors, routing, its own camera view) and
// the iPad on the dashboard shows the windshield HUD. The iPad shows a 6-digit code; the phone types
// it and opens a WebRTC data channel (PeerJS's public broker only introduces the two devices; no
// video is sent). This file is the small contract both sides share. Pure, tested in tests/run.ts.
import { buildPolyline, type LatLon } from '../core/geo.ts';
import type { Route, Step } from '../core/route.ts';

/** The iPad's peer id is derived from the code it shows, so the phone can find it. */
export const HUD_PREFIX = 'viaar-hud-';

export function newHudCode(): string {
  return String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0');
}

export const hudPeerId = (code: string): string => HUD_PREFIX + code;

/** What the person typed, as a code: 6 digits, spaces and dashes ignored; null if it isn't one. */
export function normalizeCode(input: string): string | null {
  const digits = input.replace(/[\s-]/g, '');
  return /^\d{6}$/.test(digits) ? digits : null;
}

/** "123456" -> "123 456", as the iPad shows it. */
export const formatCode = (code: string): string => `${code.slice(0, 3)} ${code.slice(3)}`;

/** The exact place to arrive at (an entrance picked in the maqueta), drawn as the arrival pin. */
export interface Arrival {
  lat: number;
  lon: number;
  label: string; // "Edif. B · Entrada 2"
  outline?: [number, number][]; // the destination building's footprint, [lat, lon]
  height?: number; // m, the building's height (for its lit outline)
}

/** A route as it travels over the wire: plain numbers, rebuilt into a Route on the other side. */
export interface RouteMsg {
  t: 'route';
  pts: [number, number][]; // [lat, lon]
  steps: { kind: Step['kind']; text: string; street: string; lat: number; lon: number; along: number }[];
  duration: number;
  arrival: Arrival | null;
}

/** Messages the phone sends to the iPad. */
export type RemoteMsg =
  | { t: 'fix'; lat: number; lon: number; speed: number | null; heading: number | null; acc: number | null }
  | { t: 'tilt'; pitch: number; roll: number } // the phone's tilt; the car's body motion for the HUD
  | RouteMsg // a drive starts (or was rerouted): the iPad switches to the HUD
  | { t: 'stop' } // the drive ended: the iPad goes back to its code screen
  | { t: 'ping' };

/** The phone pings this often; the iPad gives up after LOST_MS of silence (a locked phone says nothing). */
export const PING_MS = 1000;
export const LOST_MS = 5000;

export function encodeRoute(r: Route, arrival: Arrival | null): RouteMsg {
  return {
    t: 'route',
    pts: r.poly.pts.map((p) => [+p.lat.toFixed(6), +p.lon.toFixed(6)]),
    steps: r.steps.map((s) => ({ kind: s.kind, text: s.text, street: s.street, lat: s.location.lat, lon: s.location.lon, along: s.along })),
    duration: r.duration,
    arrival,
  };
}

export function decodeRoute(m: RouteMsg): { route: Route; arrival: Arrival | null } {
  const pts: LatLon[] = m.pts.map(([lat, lon]) => ({ lat, lon }));
  return {
    route: {
      poly: buildPolyline(pts),
      steps: m.steps.map((s) => ({ kind: s.kind, text: s.text, street: s.street, location: { lat: s.lat, lon: s.lon }, along: s.along })),
      duration: m.duration,
    },
    arrival: m.arrival,
  };
}
