// "Encontrar": location sharing. The camera with a marker over one person who shares their live
// location with you, drawn from GPS and the phone's compass. The same screen is where you share yours:
// you show a code, they type it. Opened from a `?comparte=` link it starts without the camera, with the
// code typed in, because iOS wants the camera and motion permission inside a tap. (Saved places live in
// Ajustes and on the map.)
import { angleDiff, haversine, type LatLon } from '../core/geo.ts';
import { formatDistance } from '../core/route.ts';
import { app } from '../core/state.ts';
import { $, toast } from '../core/ui.ts';
import { startCamera } from '../drive/start.ts';
import { GpsSource } from '../drive/sources.ts';
import { OrientationSensor } from '../walk/orientation.ts';
import { aim, lensOnScreen, onEdge, type Lens } from './aim.ts';
import { Sharer, Watcher, type ShareState, type WatchState } from './link.ts';
import { STALE_MS, ageLabel, codeFromSearch, normalizeCode, shareLink, type Sighting } from './protocol.ts';
import { formatCode } from '../remote/protocol.ts';
import { auth } from '../auth/ui.ts';

const PERSON_DROP = 0.4; // m below the camera: aim at their chest, not their feet
const EDGE_MARGIN = 56;

interface Target {
  id: string;
  kind: 'person';
  label: string;
  p: LatLon;
  acc: number | null;
  note: string | null; // "hace 20 s" when a shared position has gone stale
}

let gps: GpsSource | null = null;
let sensor: OrientationSensor | null = null;
let compassWarned = false;
let watcher: Watcher | null = null;
let sharer: Sharer | null = null;
let friend: { s: Sighting; seen: number } | null = null;
let shareCode = '';
let raf = 0;
let last = 0;
let camera = false; // camera and sensors are running (or were asked for)
let view: { yaw: number; pitch: number } | null = null;
let lens: Lens | null = null;
let lensKey = '';
let rowsKey = '';
const marks = new Map<string, HTMLElement>();

const isOpen = () => !$('find').hidden;

function say(id: string, text: string) {
  const el = $(id);
  if (el.textContent !== text) el.textContent = text;
}

function targets(now: number): Target[] {
  const list: Target[] = [];
  if (friend) {
    const age = now - friend.seen;
    list.push({ id: 'person', kind: 'person', label: 'Persona', p: friend.s.p, acc: friend.s.acc, note: age > STALE_MS ? ageLabel(age) : null });
  }
  return list;
}

/** Call inside a tap. With `camera: false` the screen opens plain, and `enableCamera` runs later from another tap. */
export async function openFind(opts: { camera: boolean; seeCode?: string }) {
  if (isOpen()) return;
  camera = false;
  compassWarned = false;
  $('setup').hidden = true;
  $('find').hidden = false;
  $('find').classList.toggle('noCamera', !opts.camera);
  $('fShareCard').hidden = true;
  hideAsk();
  $('fSeeBox').hidden = true;
  if (opts.seeCode) {
    $<HTMLInputElement>('fSeeCode').value = formatCode(opts.seeCode);
    $('fSeeBox').hidden = false;
  }
  rowsKey = '';

  gps = new GpsSource(() => {}, toast);
  gps.start();
  last = performance.now();
  raf = requestAnimationFrame(frame);
  if (opts.camera) await enableCamera();
}

/** Starts the compass and the camera. Call inside a tap: iOS asks for the motion permission there. */
async function enableCamera() {
  if (camera) return;
  camera = true;
  $('find').classList.remove('noCamera');
  try {
    sensor = new OrientationSensor();
    await sensor.start();
  } catch (e) {
    sensor = null;
    toast((e as Error).message);
  }
  try {
    await startCamera(true);
  } catch (e) {
    toast(`${(e as Error).message} Solo verás la distancia.`);
  }
  if (!isOpen()) stopCamera(); // the screen was closed while the permission prompts were up
}

function stopCamera() {
  sensor?.stop();
  sensor = null;
  app.stream?.getTracks().forEach((t) => t.stop());
  app.stream = null;
  const video = $<HTMLVideoElement>('video');
  video.pause();
  video.srcObject = null;
}

export function closeFind() {
  if (!isOpen()) return;
  cancelAnimationFrame(raf);
  stopWatching();
  stopSharing();
  gps?.stop();
  gps = null;
  stopCamera();
  camera = false;
  view = null;
  lens = null;
  lensKey = '';
  marks.forEach((el) => el.remove());
  marks.clear();
  $('find').hidden = true;
  $('setup').hidden = false;
  if (codeFromSearch(location.search)) history.replaceState(null, '', location.pathname);
}

function frame(now: number) {
  if (!isOpen()) return;
  raf = requestAnimationFrame(frame);
  const dt = Math.min(0.2, (now - last) / 1000);
  last = now;

  const fix = gps?.current() ?? null;
  say('fGps', fix ? `GPS ±${Math.round(fix.accuracy ?? 0)} m` : 'Buscando GPS…');
  $('fGps').classList.toggle('warn', !fix || (fix.accuracy ?? 0) > 20);
  if (!camera) return;

  const pose = sensor?.current(now) ?? null;
  if (pose) {
    if (!view) view = { yaw: pose.yaw, pitch: pose.pitch };
    else {
      const k = Math.min(1, dt * 10);
      view = { yaw: (view.yaw + angleDiff(view.yaw, pose.yaw) * k + 360) % 360, pitch: view.pitch + (pose.pitch - view.pitch) * k };
    }
  }
  const compass = Boolean(sensor?.absolute && view);
  if (sensor && !sensor.absolute && !compassWarned) {
    compassWarned = true;
    toast('Sin brújula: solo verás la distancia');
  }
  $('fCompass').hidden = compass;

  const list = targets(now);
  renderRows(list, fix?.p ?? null);
  const screen = { w: window.innerWidth, h: window.innerHeight };
  const video = $<HTMLVideoElement>('video');
  const key = `${video.videoWidth}x${video.videoHeight}@${screen.w}x${screen.h}`;
  if (key !== lensKey) {
    lensKey = key;
    lens = lensOnScreen(video.videoWidth || 1920, video.videoHeight || 1080, screen);
  }
  // Markers stay above the panel: a spot on the floor can land right behind it.
  const room = { w: screen.w, h: $('fBottom').getBoundingClientRect().top };
  const seen = new Set<string>();
  for (const t of list) {
    seen.add(t.id);
    const el = markFor(t);
    if (!fix || !compass || !view || !lens) {
      el.hidden = true;
      continue;
    }
    const a = aim(fix.p, t.p, view, lens, screen, PERSON_DROP);
    const shown = a.visible && a.y < room.h - EDGE_MARGIN / 2;
    const e = shown ? a : onEdge(a, room, EDGE_MARGIN);
    const dist = formatDistance(a.dist);
    const acc = t.acc && t.acc > 15 ? ` ±${Math.round(t.acc)} m` : '';
    const text = `${t.label} · ${dist}${acc}${t.note ? ` · ${t.note}` : ''}`;
    el.hidden = false;
    el.classList.toggle('off', !shown);
    el.classList.toggle('stale', t.note !== null);
    el.style.transform = `translate(${e.x}px, ${e.y}px)`;
    const tag = el.firstElementChild as HTMLElement;
    const side = !shown && a.rel < 0 ? `‹ ${text}` : !shown && a.rel > 0 ? `${text} ›` : text;
    if (tag.textContent !== side) tag.textContent = side;
  }
  for (const [id, el] of marks) {
    if (seen.has(id)) continue;
    el.remove();
    marks.delete(id);
  }
}

function markFor(t: Target): HTMLElement {
  let el = marks.get(t.id);
  if (!el) {
    el = document.createElement('div');
    el.className = `fMark ${t.kind}`;
    const tag = document.createElement('div');
    tag.className = 'fTag';
    const pole = document.createElement('div');
    pole.className = 'fPole';
    el.append(tag, pole);
    $('fMarks').append(el);
    marks.set(t.id, el);
  }
  return el;
}

/** The list under the camera: one row per person, distance updated live, rebuilt only when the set changes. */
function renderRows(list: Target[], me: LatLon | null) {
  const key = list.map((t) => t.id).join();
  const box = $('fList');
  if (key !== rowsKey) {
    rowsKey = key;
    box.replaceChildren(
      ...list.map((t) => {
        const row = document.createElement('div');
        row.className = 'fRow';
        row.dataset.id = t.id;
        const name = document.createElement('span');
        name.className = 'fName';
        name.textContent = t.label;
        const d = document.createElement('span');
        d.className = 'muted fDist';
        row.append(name, d);
        return row;
      }),
    );
  }
  for (const t of list) {
    const d = box.querySelector<HTMLElement>(`[data-id="${t.id}"] .fDist`);
    if (!d) continue;
    const text = me ? formatDistance(haversine(me, t.p)) : '—';
    if (d.textContent !== text) d.textContent = text;
  }
  box.hidden = list.length === 0;
}

// ---------- seeing someone ----------

const WATCH_TEXT: Record<WatchState, string> = {
  connecting: 'Conectando…',
  asking: 'Esperando que acepten…',
  live: 'Conectado: lo verás en la cámara',
  lost: 'Se perdió la señal. Su teléfono tiene que seguir con la pantalla encendida. Reconectando…',
  offline: 'Sin conexión con el servidor de enlace. Revisa tu internet.',
  inactive: 'Ese código no está activo. Revisa los 6 dígitos con quien comparte.',
  denied: 'No aceptaron compartir su ubicación.',
};

/** The signed-in account's name, or null: sent to the sharer so they know who is asking. */
function myName(): string | null {
  const s = auth.state();
  return s.kind === 'signedIn' ? s.session.user.displayName : null;
}

function showSeeBox() {
  stopSharing();
  $('fSeeBox').hidden = false;
}

/** The box's button: a tap, so the camera and sensors a link-opened screen skipped start here. */
async function startWatching() {
  const code = normalizeCode($<HTMLInputElement>('fSeeCode').value);
  if (!code) return toast('Escribe los 6 dígitos');
  stopWatching();
  stopSharing();
  const input = $<HTMLInputElement>('fSeeCode');
  input.disabled = true;
  $('fSeeBtn').hidden = true;
  $('fSeeBox').hidden = false;
  $('fSeeToggle').textContent = 'Dejar de ver';
  const w = new Watcher(code, myName, {
    onPos: (s) => (friend = { s, seen: performance.now() }),
    onState: (s) => {
      if (watcher !== w) return;
      if (s === 'inactive' || s === 'denied') stopWatching(WATCH_TEXT[s]);
      else say('fSeeState', WATCH_TEXT[s]);
    },
  });
  watcher = w;
  void enableCamera();
  await w.start().catch(() => say('fSeeState', WATCH_TEXT.offline));
}

/** `note` keeps the box open with a message (the code was refused); without it the box closes. */
function stopWatching(note?: string) {
  watcher?.stop();
  watcher = null;
  friend = null;
  $<HTMLInputElement>('fSeeCode').disabled = false;
  $('fSeeBtn').hidden = false;
  $('fSeeBox').hidden = !note;
  say('fSeeState', note ?? '');
  $('fSeeToggle').textContent = 'Ver a alguien';
}

// ---------- sharing my location ----------

const SHARE_TEXT: Record<ShareState, string> = {
  connecting: 'Conectando…',
  waiting: 'Esperando a que escriban el código o abran el enlace…',
  asking: 'Alguien pidió verte. Elige Permitir o Rechazar.',
  live: 'Te están viendo. Deja esta pantalla abierta.',
  offline: 'Sin conexión con el servidor de enlace. Revisa tu internet.',
  expired: 'El código venció. Toca Compartir ubicación para crear otro.',
  locked: 'Rechazaste varios intentos. Crea otro código para volver a compartir.',
};

function showAsk(name: string | null) {
  $('fAskWho').textContent = name ?? 'No ha iniciado sesión';
  $('fAskNote').hidden = name === null;
  $('fAsk').hidden = false;
  navigator.vibrate?.(200);
}

const hideAsk = () => ($('fAsk').hidden = true);

async function startSharing() {
  stopSharing();
  stopWatching();
  shareCode = '';
  $('fShareCodeText').textContent = '··· ···';
  $<HTMLButtonElement>('fShareInvite').disabled = true;
  $('fShareCard').hidden = false;
  $('fShareToggle').textContent = 'Dejar de compartir';
  const s = new Sharer({
    onCode: (code) => {
      if (sharer !== s) return;
      shareCode = code;
      $('fShareCodeText').textContent = formatCode(code);
      $<HTMLButtonElement>('fShareInvite').disabled = false;
    },
    onState: (st) => {
      if (sharer !== s) return;
      if (st !== 'asking') hideAsk();
      if (st === 'expired' || st === 'locked') stopSharing(SHARE_TEXT[st]);
      else say('fShareState', SHARE_TEXT[st]);
    },
    onAsk: (name) => {
      if (sharer === s) showAsk(name);
    },
    onError: (m) => sharer === s && say('fShareState', m),
  });
  sharer = s;
  await s.start().catch(() => say('fShareState', SHARE_TEXT.offline));
}

/** `note` keeps the card open with a message and no code (the share ended by itself); without it the card closes. */
function stopSharing(note?: string) {
  hideAsk();
  sharer?.stop();
  sharer = null;
  shareCode = '';
  $('fShareCard').hidden = !note;
  $('fShareCodeText').textContent = '··· ···';
  $<HTMLButtonElement>('fShareInvite').disabled = true;
  say('fShareState', note ?? '');
  $('fShareToggle').textContent = 'Compartir ubicación';
}

async function sendInvite() {
  if (!shareCode) return;
  const url = shareLink(location.origin, shareCode);
  const text = `Mira dónde estoy en Vía AR: ${url}`;
  try {
    if (navigator.share) return await navigator.share({ text });
    await navigator.clipboard.writeText(text);
    toast('Enlace copiado');
  } catch {
    /* the share sheet was dismissed */
  }
}

export function initFind() {
  $('findOpen').onclick = () => void openFind({ camera: true });
  $('fClose').onclick = closeFind;
  $('fShareToggle').onclick = () => (sharer ? stopSharing() : void startSharing());
  $('fSeeToggle').onclick = () => (watcher ? stopWatching() : $('fSeeBox').hidden ? showSeeBox() : stopWatching());
  $('fSeeBtn').onclick = () => void startWatching();
  $('fAskYes').onclick = () => {
    hideAsk();
    sharer?.allow();
  };
  $('fAskNo').onclick = () => {
    hideAsk();
    sharer?.deny();
  };
  $('fShareInvite').onclick = () => void sendInvite();
  // Opened from a link the sharer sent: show the code box filled in, and wait for a tap to start the camera.
  const code = codeFromSearch(location.search);
  if (code) void openFind({ camera: false, seeCode: code });
}
