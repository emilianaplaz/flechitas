// Display side (laptop / iPad): shows a QR code, receives the phone's camera, GPS and tilt.
// For the windshield HUD the phone pairs as a sensor only (`role=sensor`): GPS and tilt, no video.
import type { DataConnection, MediaConnection, Peer } from 'peerjs'; // loaded on demand: most drives never pair
import qrcode from 'qrcode-generator';
import { app } from '../core/state.ts';
import { $, toast } from '../core/ui.ts';
import { RemoteGpsSource } from '../drive/sources.ts';
import { LOST_MS, newPeerId, phoneUrl, reachableOrigin, type RemoteMsg } from './protocol.ts';

declare const __LAN_HOST__: string;
const lanHost = typeof __LAN_HOST__ === 'string' ? __LAN_HOST__ : '';

let peer: Peer | null = null;
let stream: MediaStream | null = null;
let tilt: { pitch: number; roll: number; t: number } | null = null;
let lastHeard = 0; // last message from the phone; silence means it's gone
let camHfov: number | null = null;
let linked = false; // the phone's data channel is up (with or without video)

/** Field of view of the phone's picture as it sends it, or null if not known (yet). */
export const remoteHfov = (): number | null => (stream ? camHfov : null);

/** GPS from the remote phone; used instead of this device's GPS while a phone is connected. */
export const remoteGps = new RemoteGpsSource();

/** The phone's camera, or null when no phone is connected. */
export const remoteStream = (): MediaStream | null => stream;
export const remoteActive = (): boolean => stream !== null;
/** A phone is paired and talking, as a camera or as a sensor only: its GPS and tilt are the car's. */
export const remotePhone = (): boolean => stream !== null || linked;

/** Latest tilt of the remote phone (its mount, not this device), or null if stale. */
export function remoteTilt(now: number): { pitch: number; roll: number } | null {
  return tilt && now - tilt.t < 1500 ? tilt : null;
}

const sensorRole = () => app.display === 'hud';

function setStatus(text: string, ok = false) {
  $('pairStatus').textContent = text;
  $('pairStatus').classList.toggle('ok', ok);
  $('pairState').textContent = ok ? (stream ? '📱 Cámara del teléfono conectada' : '📱 Sensor del teléfono conectado (GPS y movimiento)') : '';
  $('pairBtn').textContent = ok
    ? '📱 Teléfono conectado'
    : sensorRole()
      ? '📱 Conectar el iPhone (GPS y movimiento)'
      : '📱 Usar la cámara de un teléfono';
}

/** Redraws the QR for the current display choice (camera or sensor only). */
export function refreshPairQr() {
  if (peer?.open) showQr(peer.id);
  else setStatus($('pairStatus').textContent ?? '', remotePhone());
}

function showQr(id: string) {
  const url = phoneUrl(reachableOrigin(location, lanHost), id, sensorRole() ? 'sensor' : undefined);
  const qr = qrcode(0, 'M');
  qr.addData(url);
  qr.make();
  $('pairQr').innerHTML = qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
  $('pairUrl').textContent = url;
  const insecure = !url.startsWith('https:');
  const local = /\/\/(localhost|127\.)/.test(url);
  $('pairWarn').textContent = local
    ? 'Esta dirección solo funciona en este equipo. Abre la app con la IP de la red (npm run dev la muestra).'
    : insecure
      ? 'El teléfono necesita https para usar la cámara: abre la app con npm run dev (https) o la versión publicada.'
      : '';
}

function useStream(s: MediaStream) {
  stream = s;
  lastHeard = performance.now();
  setStatus('Teléfono conectado. Elige el modo y toca Iniciar.', true);
  toast('Cámara del teléfono conectada');
  // Reconnected in the middle of a drive: swap the picture right away.
  if (app.running && app.mode !== 'replay') {
    app.stream = s;
    const v = $<HTMLVideoElement>('video');
    v.srcObject = s;
    void v.play().catch(() => {});
  }
}

function dropStream(s: MediaStream) {
  if (stream !== s) return;
  dropPhone();
}

function dropPhone() {
  stream = null;
  linked = false;
  tilt = null;
  camHfov = null;
  setStatus('Se desconectó el teléfono. Vuelve a escanear el código.');
  toast('Se perdió la conexión con el teléfono');
}

function onCall(call: MediaConnection) {
  call.answer(); // receive only: the display sends nothing back
  call.on('stream', (s) => {
    useStream(s);
    s.getVideoTracks()[0]?.addEventListener('ended', () => dropStream(s));
    const pc = call.peerConnection;
    pc?.addEventListener('iceconnectionstatechange', () => {
      if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'closed') dropStream(s);
    });
  });
  call.on('close', () => stream && dropStream(stream));
}

function onData(conn: DataConnection) {
  conn.on('data', (raw) => {
    const m = raw as RemoteMsg;
    lastHeard = performance.now();
    if (!linked) {
      linked = true;
      // Sensor role: no video will come, the data channel is the connection.
      if (!stream) {
        setStatus('iPhone conectado: GPS y movimiento del carro. Elige el modo y toca Iniciar.', true);
        toast('iPhone conectado como sensor');
      }
    }
    if (m?.t === 'fix') {
      remoteGps.push({ p: { lat: m.lat, lon: m.lon }, speed: m.speed, heading: m.heading, accuracy: m.acc, t: performance.now() });
    } else if (m?.t === 'tilt') {
      tilt = { pitch: m.pitch, roll: m.roll, t: performance.now() };
    } else if (m?.t === 'cam' && Math.abs(m.hfov - (camHfov ?? 0)) > 0.3) {
      camHfov = m.hfov;
      window.dispatchEvent(new Event('remotecam')); // calibration recomputes the field of view
    }
  });
}

async function startPeer() {
  setStatus('Preparando el código…');
  const { Peer } = await import('peerjs');
  peer = new Peer(newPeerId());
  peer.on('open', (id) => {
    showQr(id);
    setStatus(remotePhone() ? 'Teléfono conectado.' : 'Escanea el código con la cámara del iPhone.', remotePhone());
  });
  peer.on('call', onCall);
  peer.on('connection', onData);
  peer.on('disconnected', () => peer?.reconnect());
  peer.on('error', (e) => {
    if (e.type === 'unavailable-id') {
      peer?.destroy();
      void startPeer();
    } else if (e.type === 'network' || e.type === 'server-error' || e.type === 'socket-error') {
      setStatus('Sin conexión con el servidor de enlace. Revisa el internet de este equipo.');
    }
  });
}

export function initRemoteDisplay() {
  $('pairBtn').onclick = () => {
    $('pair').hidden = false;
    if (!peer || peer.destroyed) startPeer().catch(() => setStatus('No se pudo cargar el enlace. Revisa el internet de este equipo.'));
  };
  $('pairClose').onclick = () => ($('pair').hidden = true);
  // A closed tab or locked phone doesn't say goodbye, and WebRTC can take ~30 s to notice.
  setInterval(() => {
    if (remotePhone() && performance.now() - lastHeard > LOST_MS) dropPhone();
  }, 1000);
  setStatus('', false);
}
