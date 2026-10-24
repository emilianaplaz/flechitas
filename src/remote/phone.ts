// Phone side: opened by scanning the display's QR (`/?cam=<id>`). Sends the back camera, GPS and
// the phone's tilt to the display, and shows the camera full screen so it's easy to aim.
import type { DataConnection, Peer } from 'peerjs';
import { $ } from '../core/ui.ts';
import { OrientationSensor } from '../walk/orientation.ts';
import { PING_MS, type RemoteMsg } from './protocol.ts';

const target = new URLSearchParams(location.search).get('cam');

/** True when this page was opened from a pairing QR code. */
export const isPhoneCamPage = (): boolean => !!target;

let peer: Peer | null = null;
let stream: MediaStream | null = null;
let sensor: OrientationSensor | null = null;
let gpsWatch: number | null = null;
let tiltTimer = 0;
let pingTimer = 0;
let wakeLock: { release(): Promise<void> } | null = null;

function status(text: string, state: 'idle' | 'ok' | 'error' = 'idle') {
  $('pcStatus').textContent = text;
  $('pcStatus').className = state;
  $<HTMLButtonElement>('pcConnect').hidden = state === 'ok';
}

function send(conn: DataConnection, m: RemoteMsg) {
  if (conn.open) conn.send(m);
}

function stopAll() {
  if (gpsWatch !== null) navigator.geolocation.clearWatch(gpsWatch);
  gpsWatch = null;
  clearInterval(tiltTimer);
  clearInterval(pingTimer);
  peer?.destroy();
  peer = null;
}

async function connect() {
  const btn = $<HTMLButtonElement>('pcConnect');
  btn.disabled = true;
  try {
    // First await of the tap: iOS only shows the motion permission prompt here. Optional.
    if (!sensor) {
      const s = new OrientationSensor();
      try {
        await s.start();
        sensor = s;
      } catch {
        /* no tilt: the display then calibrates by hand */
      }
    }
    if (!stream) {
      status('Abriendo la cámara…');
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      const v = $<HTMLVideoElement>('video');
      v.srcObject = stream;
      await v.play().catch(() => {});
    }
    stopAll();
    status('Conectando con la pantalla…');
    const { Peer } = await import('peerjs');
    const p = new Peer();
    peer = p;
    await new Promise<void>((resolve, reject) => {
      p.on('open', () => resolve());
      p.on('error', (e) => reject(e));
    });

    const call = p.call(target!, stream);
    const conn = p.connect(target!, { serialization: 'json' });
    const lost = () => {
      if (peer !== p) return;
      status('Se perdió la conexión. Toca Reconectar.', 'error');
      btn.textContent = 'Reconectar';
    };
    call.on('close', lost);
    call.on('error', lost);
    p.on('error', lost);
    const pc = call.peerConnection;
    pc?.addEventListener('iceconnectionstatechange', () => {
      if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') status('Conectado. La pantalla ya ve esta cámara.', 'ok');
      if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') lost();
    });

    conn.on('open', () => {
      pingTimer = window.setInterval(() => send(conn, { t: 'ping' }), PING_MS);
      gpsWatch = navigator.geolocation.watchPosition(
        (pos) => {
          const c = pos.coords;
          send(conn, { t: 'fix', lat: c.latitude, lon: c.longitude, speed: c.speed ?? null, heading: c.heading != null && !Number.isNaN(c.heading) ? c.heading : null, acc: c.accuracy ?? null });
        },
        () => {},
        { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 },
      );
      tiltTimer = window.setInterval(() => {
        const pose = sensor?.current(performance.now());
        if (pose) send(conn, { t: 'tilt', pitch: +pose.pitch.toFixed(2), roll: +pose.roll.toFixed(2) });
      }, 100);
    });

    try {
      wakeLock ??= (await (navigator as unknown as { wakeLock?: { request(t: string): Promise<{ release(): Promise<void> }> } }).wakeLock?.request('screen')) ?? null;
    } catch {
      /* the screen may dim; the stream keeps going while the page is visible */
    }
  } catch (e) {
    const name = (e as Error).name;
    status(
      name === 'NotAllowedError'
        ? 'Sin permiso para la cámara. Actívalo en Ajustes > Safari > Cámara.'
        : `No se pudo conectar: ${(e as Error).message || name}. Revisa que la pantalla siga mostrando el código.`,
      'error',
    );
    btn.textContent = 'Reintentar';
  } finally {
    btn.disabled = false;
  }
}

/** Turns the page into the phone camera screen. */
export function initPhoneCam() {
  document.body.classList.add('phonecam');
  $('setup').hidden = true;
  $('phonecam').hidden = false;
  status('Toca Conectar y apunta la cámara a la calle.');
  $('pcConnect').onclick = () => void connect();
  // iOS pauses the camera when the page is hidden; ask to reconnect when it comes back.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && peer && stream && !stream.active) {
      stream = null;
      status('La cámara se pausó. Toca Reconectar.', 'error');
      $('pcConnect').textContent = 'Reconectar';
    }
  });
}
