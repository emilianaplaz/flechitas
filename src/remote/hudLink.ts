// iPad side of the link: shows a 6-digit code, waits for the phone, and receives what it needs to
// draw the windshield HUD: the route (and exact arrival point), GPS fixes and the phone's tilt. The
// iPad runs the navigation itself from those, so the HUD stays smooth if a message comes late.
import type { DataConnection, Peer } from 'peerjs'; // loaded on demand
import type { Route } from '../core/route.ts';
import { $, toast } from '../core/ui.ts';
import { RemoteGpsSource } from '../drive/sources.ts';
import { LOST_MS, decodeRoute, formatCode, hudPeerId, newHudCode, type Arrival, type RemoteMsg } from './protocol.ts';

export interface HudLinkEvents {
  onRoute(route: Route, arrival: Arrival | null): void; // a drive starts, or the phone rerouted
  onStop(): void; // the phone ended the drive
  onLost(): void; // the phone went silent
}

const CODE_KEY = 'ar-nav.hud.code'; // kept across reloads so the phone can reconnect with the same code

let peer: Peer | null = null;
let conn: DataConnection | null = null;
let code = '';
let linked = false;
let lastHeard = 0;
let tilt: { pitch: number; roll: number; t: number } | null = null;
let events: HudLinkEvents | null = null;

/** GPS from the phone: the car's position for the HUD. */
export const remoteGps = new RemoteGpsSource();

/** The phone is linked and talking: its GPS and tilt are the car's. */
export const remotePhone = (): boolean => linked;

/** Latest tilt of the phone in its mount, or null if stale. */
export function remoteTilt(now: number): { pitch: number; roll: number } | null {
  return tilt && now - tilt.t < 1500 ? tilt : null;
}

function status(text: string, ok = false) {
  $('hrStatus').textContent = text;
  $('hrStatus').classList.toggle('ok', ok);
}

function loadCode(): string {
  try {
    const c = localStorage.getItem(CODE_KEY);
    if (c && /^\d{6}$/.test(c)) return c;
  } catch {
    /* ignore */
  }
  return newHudCode();
}

function saveCode(c: string) {
  try {
    localStorage.setItem(CODE_KEY, c);
  } catch {
    /* ignore */
  }
}

function handle(raw: unknown) {
  const m = raw as RemoteMsg;
  lastHeard = performance.now();
  if (!linked) {
    linked = true;
    status('Teléfono conectado. Elige el destino en el teléfono y empieza a conducir.', true);
    toast('Teléfono conectado');
  }
  switch (m?.t) {
    case 'fix':
      remoteGps.push({ p: { lat: m.lat, lon: m.lon }, speed: m.speed, heading: m.heading, accuracy: m.acc, t: performance.now() });
      break;
    case 'tilt':
      tilt = { pitch: m.pitch, roll: m.roll, t: performance.now() };
      break;
    case 'route': {
      const { route, arrival } = decodeRoute(m);
      events?.onRoute(route, arrival);
      break;
    }
    case 'stop':
      events?.onStop();
      break;
  }
}

function lose() {
  if (!linked) return;
  linked = false;
  tilt = null;
  status('Se perdió el teléfono. Abre Dispositivos en el teléfono y vuelve a conectar.');
  toast('Se perdió la conexión con el teléfono');
  events?.onLost();
}

async function open() {
  const { Peer } = await import('peerjs');
  status('Preparando el código…');
  const p = new Peer(hudPeerId(code));
  peer = p;
  p.on('open', () => {
    $('hrCode').textContent = formatCode(code);
    status('En el teléfono: Dispositivos → escribe este código.');
  });
  p.on('connection', (c) => {
    conn?.close();
    conn = c;
    c.on('data', handle);
    c.on('close', () => conn === c && lose());
  });
  p.on('disconnected', () => p.reconnect());
  p.on('error', (e) => {
    if (e.type === 'unavailable-id') {
      // Someone else holds this code (or our old session hasn't expired): take a new one.
      code = newHudCode();
      saveCode(code);
      p.destroy();
      void open();
    } else if (e.type === 'network' || e.type === 'server-error' || e.type === 'socket-error') {
      status('Sin conexión con el servidor de enlace. Revisa el internet de este iPad.');
    }
  });
}

/** Starts listening for the phone and shows the code on the HUD screen. */
export function startHudLink(ev: HudLinkEvents) {
  events = ev;
  if (peer && !peer.destroyed) return;
  code = loadCode();
  saveCode(code);
  open().catch(() => status('No se pudo cargar el enlace. Revisa el internet de este iPad.'));
  // A locked phone says nothing, and WebRTC can take ~30 s to notice.
  setInterval(() => {
    if (linked && performance.now() - lastHeard > LOST_MS) lose();
  }, 1000);
}
