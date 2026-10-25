// "Encontrar": location sharing. The camera with a marker over one person who shares their live
// location, drawn from GPS and the phone's compass. The same screen, without the camera, is where
// that person shares. (Saved places live in Ajustes and on the map.)
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
let watchCode = '';
let raf = 0;
let last = 0;
let camera = false;
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

/** Call inside a tap: iOS asks for the motion permission there. */
export async function openFind(opts: { camera: boolean; shareCode?: string }) {
  if (isOpen()) return;
  camera = opts.camera;
  compassWarned = false;
  $('setup').hidden = true;
  $('find').hidden = false;
  $('find').classList.toggle('shareOnly', !camera);
  $('fShareBox').hidden = camera;
  $('fWatchBox').hidden = true;
  if (opts.shareCode) $<HTMLInputElement>('fShareCode').value = formatCode(opts.shareCode);
  rowsKey = '';

  gps = new GpsSource(() => {}, toast);
  gps.start();
  last = performance.now();
  raf = requestAnimationFrame(frame);
  if (!camera) return;
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
}

export function closeFind() {
  if (!isOpen()) return;
  cancelAnimationFrame(raf);
  stopWatching();
  stopSharing();
  gps?.stop();
  gps = null;
  sensor?.stop();
  sensor = null;
  view = null;
  lens = null;
  lensKey = '';
  app.stream?.getTracks().forEach((t) => t.stop());
  app.stream = null;
  const video = $<HTMLVideoElement>('video');
  video.pause();
  video.srcObject = null;
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

// ---------- watching someone ----------

const WATCH_TEXT: Record<WatchState, string> = {
  waiting: 'Esperando a que abra el enlace o escriba el código…',
  live: 'Conectado: lo verás en la cámara',
  lost: 'Se perdió la señal. Su teléfono tiene que seguir con la pantalla encendida.',
  offline: 'Sin conexión con el servidor de enlace. Revisa tu internet.',
};

async function startWatching() {
  stopWatching();
  $('fWatchBox').hidden = false;
  $('fSee').textContent = 'Dejar de ver';
  $('fCode').textContent = '··· ···';
  watcher = new Watcher({
    onCode: (code) => {
      watchCode = code;
      $('fCode').textContent = formatCode(code);
    },
    onPos: (s) => (friend = { s, seen: performance.now() }),
    onState: (s) => say('fWatchState', WATCH_TEXT[s]),
  });
  await watcher.start().catch(() => say('fWatchState', WATCH_TEXT.offline));
}

function stopWatching() {
  watcher?.stop();
  watcher = null;
  friend = null;
  watchCode = '';
  $('fWatchBox').hidden = true;
  $('fSee').textContent = 'Ver a alguien';
}

async function shareInvite() {
  if (!watchCode) return;
  const url = shareLink(location.origin, watchCode);
  const text = `Comparte tu ubicación conmigo para encontrarte: ${url}`;
  try {
    if (navigator.share) return await navigator.share({ text });
    await navigator.clipboard.writeText(text);
    toast('Enlace copiado');
  } catch {
    /* the share sheet was dismissed */
  }
}

// ---------- sharing my location ----------

const SHARE_TEXT: Record<ShareState, string> = {
  connecting: 'Conectando…',
  on: 'Compartiendo tu ubicación. Deja esta pantalla abierta.',
  lost: 'Reconectando…',
};

async function startSharing() {
  const code = normalizeCode($<HTMLInputElement>('fShareCode').value);
  if (!code) return toast('Escribe los 6 dígitos');
  stopSharing();
  const btn = $<HTMLButtonElement>('fShareBtn');
  btn.textContent = 'Dejar de compartir';
  btn.dataset.on = '1';
  sharer = new Sharer(code, {
    onState: (s) => say('fShareState', SHARE_TEXT[s]),
    onError: (m) => say('fShareState', m),
  });
  await sharer.start();
}

function stopSharing() {
  sharer?.stop();
  sharer = null;
  const btn = $<HTMLButtonElement>('fShareBtn');
  btn.textContent = 'Compartir mi ubicación';
  delete btn.dataset.on;
  say('fShareState', '');
}

export function initFind() {
  $('findOpen').onclick = () => void openFind({ camera: true });
  $('fClose').onclick = closeFind;
  $('fSee').onclick = () => (watcher ? stopWatching() : void startWatching());
  $('fInvite').onclick = () => void shareInvite();
  $('fShareOpen').onclick = () => ($('fShareBox').hidden = !$('fShareBox').hidden);
  $('fShareBtn').onclick = () => (sharer ? stopSharing() : void startSharing());
  // Opened from a link someone sent: go straight to sharing, without the camera.
  const code = codeFromSearch(location.search);
  if (code) {
    void openFind({ camera: false, shareCode: code });
  }
}
