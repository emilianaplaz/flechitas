// Phone side: opened by scanning the display's QR (`/?cam=<id>`). Sends the back camera, GPS and
// the phone's tilt to the display.
//
// The picture is redrawn upright from gravity, always as a 1280×720 landscape frame, before it's
// sent: camera frames follow the phone's *screen* orientation, which with rotation lock on (or a
// phone sideways in a mount) isn't where up is, and the display would get it sideways or flipping.
// The phone shows exactly what it sends, so it's easy to aim.
import type { DataConnection, Peer } from 'peerjs';
import { $ } from '../core/ui.ts';
import { DEFAULT_LENS_HFOV } from '../render/autocalib.ts';
import { poseFromEuler } from '../walk/orientation.ts';
import { interfaceAngle, physicalAngle, uprightPlan } from './orient.ts';
import { PING_MS, type RemoteMsg } from './protocol.ts';

const params = new URLSearchParams(location.search);
const target = params.get('cam');
/** Windshield HUD: the phone is only a sensor (GPS + tilt); no camera, no video sent. */
const sensorOnly = params.get('role') === 'sensor';
const OUT_W = 1280;
const OUT_H = 720;
const ROTATE_KEY = 'ar-nav.camRotate'; // manual correction, for a phone whose frames come in unexpectedly

/** True when this page was opened from a pairing QR code. */
export const isPhoneCamPage = (): boolean => !!target;

let peer: Peer | null = null;
let camStream: MediaStream | null = null; // raw camera
let outStream: MediaStream | null = null; // upright landscape picture, what the display gets
let gpsWatch: number | null = null;
let tiltTimer = 0;
let pingTimer = 0;
let wakeLock: { release(): Promise<void> } | null = null;

// ---------- which way is up ----------
let euler: { alpha: number; beta: number; gamma: number; t: number } | null = null;
let upAngle = currentInterface(); // until gravity says otherwise, assume the screen is the right way up
let manualRot = loadRotate();
let hfov = DEFAULT_LENS_HFOV;

function currentInterface(): number {
  return interfaceAngle(screen.orientation?.angle, (window as unknown as { orientation?: number }).orientation);
}
function loadRotate(): number {
  try {
    return Number(localStorage.getItem(ROTATE_KEY)) || 0;
  } catch {
    return 0;
  }
}

function onOrientation(e: DeviceOrientationEvent) {
  if (e.beta == null || e.gamma == null) return;
  euler = { alpha: e.alpha ?? 0, beta: e.beta, gamma: e.gamma, t: performance.now() };
  upAngle = physicalAngle(e.beta, e.gamma, upAngle);
}

/** iOS asks for motion permission inside a tap. Without it the picture follows the screen orientation and ⟳ fixes it. */
async function requestMotion(): Promise<boolean> {
  const DOE = DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> };
  try {
    if (DOE.requestPermission && (await DOE.requestPermission()) !== 'granted') return false;
  } catch {
    return false;
  }
  window.addEventListener('deviceorientation', onOrientation);
  return true;
}

// ---------- upright redraw ----------
const raw = document.createElement('video');
raw.muted = true;
raw.playsInline = true;
raw.setAttribute('playsinline', '');
// Kept in the page (iOS stops updating frames of a video that isn't), but invisible.
raw.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;left:0;top:0';
const canvas = document.createElement('canvas');
canvas.width = OUT_W;
canvas.height = OUT_H;
const ctx = canvas.getContext('2d')!;

function draw() {
  const fw = raw.videoWidth;
  const fh = raw.videoHeight;
  if (!fw || !fh) return;
  const plan = uprightPlan(fw, fh, upAngle - currentInterface() + manualRot, DEFAULT_LENS_HFOV, OUT_W, OUT_H);
  hfov = plan.hfov;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, OUT_W, OUT_H);
  ctx.translate(OUT_W / 2, OUT_H / 2);
  ctx.rotate((-plan.rot * Math.PI) / 180); // canvas turns clockwise; the plan is counter-clockwise
  const w = fw * plan.scale;
  const h = fh * plan.scale;
  ctx.drawImage(raw, -w / 2, -h / 2, w, h);
}

// ---------- connection ----------
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
    if (!euler) await requestMotion();
    if (!sensorOnly && (!camStream || !camStream.active)) {
      status('Abriendo la cámara…');
      camStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      raw.srcObject = camStream;
      if (!raw.isConnected) document.body.appendChild(raw);
      // Not awaited: play() can stay pending until the first frame, and nothing here needs to wait for it.
      void raw.play().catch(() => {});
    }
    if (!sensorOnly && !outStream) {
      outStream = canvas.captureStream(30);
      const v = $<HTMLVideoElement>('video');
      v.srcObject = outStream;
      void v.play().catch(() => {});
      window.setInterval(draw, 33); // ~30 fps, matching the stream
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

    const conn = p.connect(target!, { serialization: 'json' });
    const lost = () => {
      if (peer !== p) return;
      status('Se perdió la conexión. Toca Reconectar.', 'error');
      btn.textContent = 'Reconectar';
    };
    p.on('error', lost);
    conn.on('close', lost);
    conn.on('error', lost);
    if (!sensorOnly) {
      const call = p.call(target!, outStream!);
      call.on('close', lost);
      call.on('error', lost);
      const pc = call.peerConnection;
      pc?.addEventListener('iceconnectionstatechange', () => {
        if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') status('Conectado. La pantalla ya ve esta cámara.', 'ok');
        if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') lost();
      });
    }

    conn.on('open', () => {
      if (sensorOnly) status('Conectado. El iPad recibe tu GPS y el movimiento del carro.', 'ok');
      // Heartbeat, plus the field of view of the picture being sent (it narrows if the phone is upright).
      pingTimer = window.setInterval(() => {
        send(conn, { t: 'ping' });
        if (!sensorOnly) send(conn, { t: 'cam', hfov: +hfov.toFixed(1) });
      }, PING_MS);
      gpsWatch = navigator.geolocation.watchPosition(
        (pos) => {
          const c = pos.coords;
          send(conn, { t: 'fix', lat: c.latitude, lon: c.longitude, speed: c.speed ?? null, heading: c.heading != null && !Number.isNaN(c.heading) ? c.heading : null, acc: c.accuracy ?? null });
        },
        () => {},
        { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 },
      );
      // Tilt relative to the picture being sent: its "up" is the phone's physical up. As a HUD sensor
      // it's the car's body motion (braking dive, slopes), so it goes out faster.
      tiltTimer = window.setInterval(() => {
        if (!euler || performance.now() - euler.t > 1500) return;
        const pose = poseFromEuler(euler.alpha, euler.beta, euler.gamma, upAngle);
        send(conn, { t: 'tilt', pitch: +pose.pitch.toFixed(2), roll: +pose.roll.toFixed(2) });
      }, sensorOnly ? 50 : 100);
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
  if (sensorOnly) {
    $('phonecam').querySelector('b')!.textContent = 'Sensor para el HUD';
    $('pcRotate').hidden = true;
    status('Fija el teléfono en el soporte, horizontal, y toca Conectar. Solo envía GPS y movimiento, sin video.');
  } else {
    status('Pon el teléfono horizontal, toca Conectar y apunta la cámara a la calle.');
  }
  $('pcConnect').onclick = () => void connect();
  // Backup if a phone delivers its frames another way round: turn the sent picture 90° per tap.
  $('pcRotate').onclick = () => {
    manualRot = (manualRot + 90) % 360;
    try {
      localStorage.setItem(ROTATE_KEY, String(manualRot));
    } catch {
      /* ignore */
    }
  };
  // iOS pauses the camera when the page is hidden; ask to reconnect when it comes back.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && peer && camStream && !camStream.active) {
      status('La cámara se pausó. Toca Reconectar.', 'error');
      $('pcConnect').textContent = 'Reconectar';
    }
  });
}
