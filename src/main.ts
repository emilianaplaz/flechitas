import './style.css';
import { ArScene, type HazardView } from './ar.ts';
import { CALIB_RANGES, currentLayout, defaultsFor, loadCalib, saveCalib, type Calib } from './calib.ts';
import { angleDiff, bearingAt, offset, pointAt, project, type LatLon } from './geo.ts';
import { HAZARD_LABEL, HazardStore, type Hazard, type HazardType } from './hazards.ts';
import { extractUrl, resolveDestination } from './links.ts';
import { BumpWatcher, type BumpEvent } from './bump.ts';
import { cloudEnabled, enqueue, flush } from './cloud.ts';
import { OrientationSensor } from './orientation.ts';
import { DriveRecorder, download } from './recorder.ts';
import { fetchRoute, formatDistance, routeFromTrack, type Route, type Step, type TurnKind } from './route.ts';
import { GpsSource, RouteSim, TrackReplay, parseTrack, type Fix, type Source, type Track } from './sources.ts';

type Mode = 'gps' | 'sim' | 'replay';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const video = $<HTMLVideoElement>('video');
const canvas = $<HTMLCanvasElement>('ar');
let ar: ArScene | null = null;
try {
  ar = new ArScene(canvas);
} catch {
  /* no WebGL: the setup screen still loads and Iniciar explains why */
}
const hazards = new HazardStore();
const recorder = new DriveRecorder();
let layout = currentLayout();
let calib: Calib = loadCalib(layout);

// ---------- state ----------
let mode: Mode = 'gps';
let dest: { point: LatLon; label: string } | null = null;
let route: Route | null = null;
let source: Source | null = null;
let stream: MediaStream | null = null;
let running = false;
let along = 0;
let alongInit = false;
let projHint: number | undefined;
let yaw = 0;
let lastFrame = performance.now();
let offRouteSince: number | null = null;
let rerouting = false;
let lastReroute = 0;
let hazardsOnRoute: { h: Hazard; along: number }[] = [];
let sensor: OrientationSensor | null = null;
let sensorStart = 0;
let sensorWarned = false;
let sensorBias = 0; // degrees added to the compass so the view lines up with the street ("Alinear")
let view: { yaw: number; pitch: number; roll: number } | null = null;
let watcher: BumpWatcher | null = null;
let trail: { t: number; p: LatLon }[] = [];
let detectTimer = 0;
let syncTimer = 0;
let wakeLock: { release(): Promise<void> } | null = null;

// ---------- small UI helpers ----------
let toastTimer = 0;
function toast(msg: string, ms = 2600) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (t.hidden = true), ms);
}
function setText(id: string, text: string) {
  const el = $(id);
  if (el.textContent !== text) el.textContent = text;
}
function setupMsg(text: string) {
  $('setupMsg').textContent = text;
}

const GLYPH_ROT: Record<TurnKind, number> = {
  'straight': 0,
  'slight-left': -40,
  'left': -90,
  'sharp-left': -135,
  'slight-right': 40,
  'right': 90,
  'sharp-right': 135,
  'uturn': 0,
  'arrive': 0,
};
let lastGlyph = '';
function renderGlyph(kind: TurnKind) {
  if (kind === lastGlyph) return;
  lastGlyph = kind;
  const svg =
    kind === 'arrive'
      ? `<svg viewBox="0 0 64 64"><path d="M32 6c-10 0-18 8-18 18 0 13 18 34 18 34s18-21 18-34C50 14 42 6 32 6zm0 25a7 7 0 1 1 0-14 7 7 0 0 1 0 14z" fill="#22e07a"/></svg>`
      : kind === 'uturn'
        ? `<svg viewBox="0 0 64 64"><path d="M42 56V26a10 10 0 0 0-20 0v14h8L18 54 6 40h8V26a18 18 0 0 1 36 0v30z" fill="#00e676"/></svg>`
        : `<svg viewBox="0 0 64 64"><g transform="rotate(${GLYPH_ROT[kind]} 32 32)"><path d="M32 4 52 28H39v32H25V28H12z" fill="#00e676"/></g></svg>`;
  $('glyph').innerHTML = svg;
}

// ---------- calibration dock ----------
type DockKey = keyof Calib | 'sync';
const SYNC_RANGE = { min: -5, max: 5, step: 0.1, label: 'Sincronía video/GPS', unit: 's' };
let dockKey: DockKey = 'fov';

function dockKeys(): DockKey[] {
  const keys = Object.keys(CALIB_RANGES) as DockKey[];
  return mode === 'replay' ? [...keys, 'sync'] : keys;
}
function dockRange(key: DockKey) {
  return key === 'sync' ? SYNC_RANGE : CALIB_RANGES[key];
}
function dockValue(key: DockKey): number {
  if (key === 'sync') return source instanceof TrackReplay ? source.syncOffset : 0;
  return calib[key];
}
function setDockValue(key: DockKey, raw: number) {
  const r = dockRange(key);
  const v = Math.round(Math.min(r.max, Math.max(r.min, raw)) / r.step) * r.step;
  const clean = +v.toFixed(2);
  if (key === 'sync') {
    if (source instanceof TrackReplay) source.syncOffset = clean;
  } else {
    calib = { ...calib, [key]: clean };
    saveCalib(calib, layout);
  }
  renderDockValue();
}
function renderDockValue() {
  const r = dockRange(dockKey);
  const v = dockValue(dockKey);
  $('oneLabel').textContent = r.label;
  $('oneVal').textContent = `${v} ${r.unit}`;
  const input = $<HTMLInputElement>('oneRange');
  input.min = String(r.min);
  input.max = String(r.max);
  input.step = String(r.step);
  input.value = String(v);
}
function buildDock() {
  const keys = dockKeys();
  if (!keys.includes(dockKey)) dockKey = 'fov';
  const box = $('chips');
  box.innerHTML = '';
  for (const key of keys) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = `chip${key === dockKey ? ' on' : ''}`;
    chip.textContent = dockRange(key).label;
    chip.onclick = () => {
      dockKey = key;
      box.querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', c === chip));
      renderDockValue();
    };
    box.appendChild(chip);
  }
  renderDockValue();
}
$('oneRange').addEventListener('input', () => setDockValue(dockKey, parseFloat($<HTMLInputElement>('oneRange').value)));
$('oneMinus').onclick = () => setDockValue(dockKey, dockValue(dockKey) - dockRange(dockKey).step);
$('onePlus').onclick = () => setDockValue(dockKey, dockValue(dockKey) + dockRange(dockKey).step);
buildDock();
function setCalibOpen(open: boolean) {
  $('calib').hidden = !open;
  document.body.classList.toggle('calibrating', open);
}
$('calibBtn').onclick = () => {
  buildDock();
  setCalibOpen(true);
};
$('calibClose').onclick = () => setCalibOpen(false);
$('calibReset').onclick = () => {
  calib = defaultsFor(layout);
  saveCalib(calib, layout);
  renderDockValue();
};
$('exportHazards').onclick = () => {
  download(new Blob([hazards.exportJson()], { type: 'application/json' }), 'hazards.json');
  toast('Copia ese archivo a public/hazards.json para que todos lo vean');
};
$('undoReport').onclick = () => {
  const h = hazards.undoLast();
  indexHazards();
  toast(h ? `Se borró el último reporte (${HAZARD_LABEL[h.type].toLowerCase()})` : 'No hay reportes tuyos');
};

// ---------- setup screen ----------
function syncMode() {
  mode = (document.querySelector<HTMLInputElement>('input[name=mode]:checked')?.value ?? 'gps') as Mode;
  $('fromField').hidden = mode !== 'sim';
  $('replayFields').hidden = mode !== 'replay';
}
document.querySelectorAll<HTMLInputElement>('input[name=mode]').forEach((r) => r.addEventListener('change', syncMode));
// Browsers restore the checked radio after a reload without firing `change`.
syncMode();
window.addEventListener('pageshow', syncMode);

async function resolveDestInput(): Promise<void> {
  const raw = $<HTMLInputElement>('dest').value.trim();
  if (!raw) {
    dest = null;
    setText('destLabel', '');
    return;
  }
  setText('destLabel', 'Buscando…');
  try {
    dest = await resolveDestination(raw);
    setText('destLabel', `✓ ${dest.label}`);
  } catch (e) {
    dest = null;
    setText('destLabel', '');
    throw e;
  }
}

$('dest').addEventListener('change', () => resolveDestInput().catch((e) => setupMsg((e as Error).message)));
$('paste').onclick = async () => {
  try {
    const text = await navigator.clipboard.readText();
    $<HTMLInputElement>('dest').value = text;
    setupMsg('');
    await resolveDestInput();
  } catch (e) {
    setupMsg(e instanceof Error && e.name === 'NotAllowedError' ? 'Permite el acceso al portapapeles o pega a mano' : (e as Error).message);
  }
};

// Opened from the Android share sheet (Web Share Target) — Google Maps / Waze "Compartir".
{
  const q = new URLSearchParams(location.search);
  const shared = [q.get('url'), q.get('text'), q.get('title')].filter(Boolean).join(' ');
  if (shared) {
    $<HTMLInputElement>('dest').value = extractUrl(shared) ?? shared;
    history.replaceState(null, '', '/');
    resolveDestInput().catch((e) => setupMsg((e as Error).message));
  }
}

async function startCamera(required: boolean) {
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();
  } catch (e) {
    if (required) throw new Error('No se pudo abrir la cámara. Revisa los permisos (y que la página esté en https).');
  }
}

function currentPosition(): Promise<LatLon> {
  return new Promise((resolve, reject) =>
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude }),
      () => reject(new Error('No tengo tu ubicación. Escribe un punto de partida en "Desde".')),
      { enableHighAccuracy: true, timeout: 10000 },
    ),
  );
}

function waitForFix(src: GpsSource, timeoutMs = 30000): Promise<Fix> {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const tick = () => {
      const f = src.current();
      if (f) resolve(f);
      else if (performance.now() - t0 > timeoutMs) reject(new Error('El GPS no responde. Sal a cielo abierto e intenta otra vez.'));
      else setTimeout(tick, 250);
    };
    tick();
  });
}

function readJsonFile(file: File): Promise<unknown> {
  return file.text().then((t) => JSON.parse(t));
}

/** Fullscreen and wake lock are best-effort: some browsers never settle these promises, so nothing waits on them. */
function enterImmersive() {
  try {
    document.documentElement.requestFullscreen?.().catch(() => {});
  } catch {
    /* not supported (e.g. iOS) */
  }
  try {
    (navigator as unknown as { wakeLock?: { request(t: string): Promise<{ release(): Promise<void> }> } }).wakeLock
      ?.request('screen')
      .then((lock) => (wakeLock = lock))
      .catch(() => {});
  } catch {
    /* ignore */
  }
}

function setRoute(r: Route) {
  route = r;
  alongInit = false;
  projHint = undefined;
  indexHazards();
}

/** Precompute where each hazard sits along the route, so per-frame work is cheap. */
function indexHazards() {
  hazardsOnRoute = [];
  if (!route) return;
  for (const h of hazards.all()) {
    const pr = project(route.poly, h);
    if (pr.dist >= 20) continue;
    // A bump reported while driving the other way sits on the opposite carriageway.
    if (h.heading != null && Math.abs(angleDiff(h.heading, bearingAt(route.poly, pr.along, 10))) > 100) continue;
    hazardsOnRoute.push({ h, along: pr.along });
  }
  hazardsOnRoute.sort((a, b) => a.along - b.along);
}

$('start').onclick = async () => {
  const btn = $<HTMLButtonElement>('start');
  btn.disabled = true;
  setupMsg('');
  try {
    // First await in the handler: iOS only shows the sensor permission prompt inside the tap.
    // Bump detection is optional: without motion permission the drive still starts, just without it.
    let bumpWarning = '';
    if ($<HTMLInputElement>('detectBumps').checked && mode !== 'replay') {
      watcher = new BumpWatcher(() => source?.current(performance.now())?.speed ?? 0, onBump);
      try {
        await watcher.start();
      } catch (e) {
        watcher = null;
        bumpWarning = `Sin detección de huecos: ${(e as Error).message}`;
      }
    }
    if ($<HTMLInputElement>('useSensors').checked && mode !== 'replay') {
      sensor = new OrientationSensor();
      await sensor.start();
      sensorStart = performance.now();
      sensorWarned = false;
      sensorBias = 0;
      view = null;
    }
    if (!ar) throw new Error('Este navegador no puede dibujar 3D (WebGL desactivado). Activa la aceleración por hardware en Chrome: chrome://settings/system');
    if ($<HTMLInputElement>('dest').value.trim() && !dest) await resolveDestInput();
    await hazards.loadSeeds();
    await hazards.loadShared();

    if (mode === 'gps') {
      if (!dest) throw new Error('Elige un destino primero');
      await startCamera(true);
      const gps = new GpsSource((f) => recorder.addFix(f), toast);
      gps.start();
      source = gps;
      setupMsg('Esperando señal de GPS…');
      const fix = await waitForFix(gps);
      setRoute(await fetchRoute(fix.p, dest.point));
    } else if (mode === 'sim') {
      if (!dest) throw new Error('Elige un destino primero');
      const fromRaw = $<HTMLInputElement>('from').value.trim();
      const from = fromRaw ? (await resolveDestination(fromRaw)).point : await currentPosition();
      setRoute(await fetchRoute(from, dest.point));
      await startCamera(false);
      const sim = new RouteSim(route!.poly);
      source = sim;
      $('simBar').hidden = false;
    } else {
      const vf = $<HTMLInputElement>('replayVideo').files?.[0];
      const tf = $<HTMLInputElement>('replayTrack').files?.[0];
      if (!vf || !tf) throw new Error('Elige el video y el archivo de recorrido');
      const track: Track = parseTrack(await readJsonFile(tf));
      const first = track.points[0];
      const last = track.points[track.points.length - 1];
      const target = dest?.point ?? { lat: last.lat, lon: last.lon };
      try {
        setRoute(await fetchRoute({ lat: first.lat, lon: first.lon }, target));
      } catch {
        setRoute(routeFromTrack(track.points.map((p) => ({ lat: p.lat, lon: p.lon }))));
        toast('Sin servidor de rutas: uso el recorrido grabado como ruta');
      }
      video.srcObject = null;
      video.src = URL.createObjectURL(vf);
      video.loop = false;
      await video.play();
      source = new TrackReplay(track, video);
      $('simBar').hidden = false;
      $('simSpeed').hidden = true;
      $('simSpeedVal').hidden = true;
    }

    source.start();
    if (cloudEnabled) {
      void flush();
      syncTimer = window.setInterval(() => void flush(), 20000);
    }
    if (mode !== 'gps') $<HTMLButtonElement>('rec').hidden = true;
    $('setup').hidden = true;
    $('hud').hidden = false;
    $<HTMLButtonElement>('align').hidden = !sensor;
    enterImmersive();
    if (bumpWarning) toast(bumpWarning, 5000);
    running = true;
    lastFrame = performance.now();
    requestAnimationFrame(frame);
  } catch (e) {
    setupMsg((e as Error).message);
    source?.stop();
    source = null;
    sensor?.stop();
    sensor = null;
    watcher?.stop();
    watcher = null;
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
  } finally {
    btn.disabled = false;
  }
};

/** Where the car was `ms` ago: a tap on "Hueco" comes after the hit, so the point belongs behind us. */
function positionAgo(ms: number): LatLon | null {
  const cutoff = performance.now() - ms;
  let found: LatLon | null = null;
  for (const e of trail) if (e.t <= cutoff) found = e.p;
  return found;
}

function closeDetect() {
  clearTimeout(detectTimer);
  $('detect').hidden = true;
}

function onBump(e: BumpEvent) {
  if (!$('detect').hidden) return;
  const here = source?.current(performance.now())?.p;
  if (!here) return;
  const heading = Math.round(yaw);
  $('detect').querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.classList.toggle('suggested', b.dataset.detect === e.type));
  $('detect').hidden = false;
  navigator.vibrate?.(40);
  const answer = (choice: string) => {
    closeDetect();
    // Every answer, including "Nada", is a labelled example for tuning the detector.
    const cid = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
    enqueue(
      'detections',
      { client_id: cid, guess: e.type, answer: choice, peak: +e.peak.toFixed(2), duration_ms: Math.round(e.durationMs), speed: +e.speed.toFixed(2), lat: +here.lat.toFixed(6), lon: +here.lon.toFixed(6), heading },
      cid,
      Date.now(),
      0,
    );
    if (choice === 'hueco' || choice === 'policia') {
      hazards.add(choice, here, { heading, source: 'detected' });
      indexHazards();
      toast(`${HAZARD_LABEL[choice]} guardado. ¡Gracias!`);
    }
  };
  $('detect').onclick = (ev) => {
    const choice = (ev.target as HTMLElement).closest<HTMLElement>('[data-detect]')?.dataset.detect;
    if (choice) answer(choice);
  };
  detectTimer = window.setTimeout(closeDetect, 8000);
}

// ---------- HUD buttons ----------
document.querySelectorAll<HTMLButtonElement>('[data-report]').forEach((b) =>
  b.addEventListener('click', () => {
    const type = b.dataset.report as HazardType;
    const here = positionAgo(1500) ?? source?.current(performance.now())?.p;
    if (!here) return toast('Todavía no tengo tu posición');
    hazards.add(type, here, { heading: Math.round(yaw), source: 'tap' });
    indexHazards();
    toast(`${HAZARD_LABEL[type]} reportado aquí. ¡Gracias!`);
    navigator.vibrate?.(60);
  }),
);

$('rec').onclick = async () => {
  const btn = $('rec');
  if (recorder.recording) {
    const { points } = await recorder.stop();
    btn.classList.remove('on');
    toast(`Recorrido guardado (${points} puntos GPS). Revisa tus descargas.`);
  } else if (stream) {
    recorder.start(stream);
    btn.classList.add('on');
    toast('Grabando video + GPS…');
  }
};

$('align').onclick = () => {
  const raw = sensor?.current(performance.now());
  if (!raw) return toast('Sin lectura de sensores todavía');
  sensorBias = angleDiff(raw.yaw, yaw);
  view = null;
  toast('Alineado con la calle');
};

$('simPause').onclick = () => {
  if (source instanceof RouteSim) {
    source.paused = !source.paused;
    $('simPause').textContent = source.paused ? '▶' : '⏸';
  } else if (source instanceof TrackReplay) {
    if (video.paused) void video.play();
    else video.pause();
  }
};
$('simSpeed').addEventListener('input', () => {
  const v = +$<HTMLInputElement>('simSpeed').value;
  $('simSpeedVal').textContent = `${v} km/h`;
  if (source instanceof RouteSim) source.speedKmh = v;
});

$('stop').onclick = async () => {
  running = false;
  if (recorder.recording) await recorder.stop();
  source?.stop();
  source = null;
  sensor?.stop();
  sensor = null;
  watcher?.stop();
  watcher = null;
  closeDetect();
  clearInterval(syncTimer);
  void flush({ force: true });
  trail = [];
  $<HTMLButtonElement>('align').hidden = true;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  video.pause();
  video.removeAttribute('src');
  video.srcObject = null;
  route = null;
  await wakeLock?.release().catch(() => {});
  wakeLock = null;
  if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
  $('hud').hidden = true;
  $('simBar').hidden = true;
  $('simSpeed').hidden = false;
  $('simSpeedVal').hidden = false;
  $('arrived').hidden = true;
  $<HTMLButtonElement>('rec').hidden = false;
  $('setup').hidden = false;
  setupMsg('');
  ar?.update({ origin: { lat: 0, lon: 0 }, yaw: 0, poly: null, along: 0, next: null, distToNext: Infinity, hazards: [], calib });
};

window.addEventListener('online', () => void flush());
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible') void flush();
  if (document.visibilityState === 'visible' && running && !wakeLock) enterImmersive();
});

// ---------- per-frame ----------
function resize() {
  ar?.resize(window.innerWidth, window.innerHeight);
  const now = currentLayout();
  if (now !== layout) {
    layout = now;
    calib = loadCalib(layout);
    buildDock();
    toast(layout === 'portrait' ? 'Modo vertical: calibración propia' : 'Modo horizontal: calibración propia');
  }
}
window.addEventListener('resize', resize);
resize();

async function maybeReroute(fix: Fix, now: number) {
  if (mode !== 'gps' || !dest || rerouting || now - lastReroute < 10000) return;
  rerouting = true;
  lastReroute = now;
  toast('Recalculando ruta…');
  try {
    setRoute(await fetchRoute(fix.p, dest.point));
  } catch (e) {
    toast((e as Error).message);
  } finally {
    rerouting = false;
    offRouteSince = null;
  }
}

function frame(now: number) {
  if (!running) return;
  requestAnimationFrame(frame);
  const dt = Math.min(0.2, (now - lastFrame) / 1000);
  lastFrame = now;

  const fix = source?.current(now) ?? null;
  if (!fix || !route) {
    ar?.update({ origin: { lat: 0, lon: 0 }, yaw, poly: null, along: 0, next: null, distToNext: Infinity, hazards: [], calib });
    return;
  }
  const poly = route.poly;
  const pr = project(poly, fix.p, projHint);
  projHint = pr.seg;
  const speed = fix.speed ?? 0;
  if (!trail.length || trail[trail.length - 1].p !== fix.p) {
    trail.push({ t: now, p: fix.p });
    while (trail.length > 1 && now - trail[1].t > 4000) trail.shift();
  }

  // Smooth position along the route: predict between 1 Hz GPS fixes, then ease toward the measurement.
  const predicted = pr.along + (speed * Math.min(2000, now - fix.t)) / 1000;
  if (!alongInit || Math.abs(predicted - along) > 30) {
    along = predicted;
    alongInit = true;
  } else {
    along += speed * dt;
    along += (predicted - along) * Math.min(1, dt * 3);
  }
  along = Math.min(Math.max(0, along), poly.length);

  // Snap to the route when we're on it: steadier than raw GPS, and the guide lines up with the road.
  const onRoute = pr.dist < 25;
  let ground: LatLon;
  let targetYaw: number;
  if (onRoute) {
    ground = pointAt(poly, along).p;
    targetYaw = bearingAt(poly, along, 15);
    offRouteSince = null;
  } else {
    ground = fix.p;
    targetYaw = fix.heading ?? yaw;
    offRouteSince ??= now;
    if (now - offRouteSince > 5000 && pr.dist > 45) void maybeReroute(fix, now);
  }
  yaw = (yaw + angleDiff(yaw, targetYaw) * Math.min(1, dt * 4) + 360) % 360;
  const origin = offset(ground, yaw + 90, calib.lateral);

  // Next maneuver.
  const next: Step | null = route.steps.find((s) => s.along > along + 3) ?? null;
  const distToNext = next ? next.along - along : Infinity;
  const remaining = poly.length - along;

  // Hazards ahead on this route.
  const ahead: HazardView[] = [];
  let nearest: { type: HazardType; dist: number } | null = null;
  for (const { h, along: ha } of hazardsOnRoute) {
    const d = ha - along;
    if (d < -8 || d > 220) continue;
    ahead.push({ p: h, type: h.type });
    if (d > 0 && d < 150 && (!nearest || d < nearest.dist)) nearest = { type: h.type, dist: d };
  }

  // Phone sensors decide where the camera looks. Travel direction (yaw) still places the car on the road.
  const raw = sensor?.current(now) ?? null;
  if (raw) {
    const target = { yaw: (raw.yaw + sensorBias + 360) % 360, pitch: raw.pitch, roll: raw.roll };
    if (!view) view = target;
    else {
      const k = Math.min(1, dt * 10);
      view = {
        yaw: (view.yaw + angleDiff(view.yaw, target.yaw) * k + 360) % 360,
        pitch: view.pitch + (target.pitch - view.pitch) * k,
        roll: view.roll + angleDiff(view.roll, target.roll) * k,
      };
    }
  } else if (sensor && !sensorWarned && now - sensorStart > 3000) {
    sensorWarned = true;
    toast('Sin lectura de sensores: uso la dirección de la ruta');
  }
  if (raw && !sensorWarned && !sensor!.absolute) {
    sensorWarned = true;
    toast('Sin brújula: toca ⌖ para alinear con la calle');
  }
  ar?.update({
    origin,
    yaw: raw && view ? view.yaw : yaw,
    poly,
    along,
    next,
    distToNext,
    hazards: ahead,
    calib,
    pose: raw && view ? { pitch: view.pitch, roll: view.roll } : undefined,
  });

  // HUD text.
  setText('speed', String(Math.round(speed * 3.6)));
  const mins = route.duration ? Math.max(1, Math.round((route.duration * remaining) / poly.length / 60)) : null;
  setText('remaining', `${formatDistance(remaining)}${mins ? ` · ${mins} min` : ''}`);
  if (next) {
    renderGlyph(next.kind);
    setText('mDist', formatDistance(distToNext));
    setText('mText', next.text);
    setText('mStreet', next.street);
  }
  $('arrived').hidden = remaining > 20;
  const banner = $('hazardBanner');
  banner.hidden = !nearest;
  if (nearest) setText('hazardBanner', `⚠ ${HAZARD_LABEL[nearest.type]} en ${formatDistance(nearest.dist)}`);
  if (!onRoute && mode === 'gps') setText('mText', 'Fuera de ruta…');
}

// Service worker: makes the app installable on Android, which is what puts it in the
// Google Maps / Waze share menu (Web Share Target in the manifest).
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
