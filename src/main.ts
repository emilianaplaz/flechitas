// Composition root: wires the modules together and runs the per-frame loop.
//   core/     shared types, geometry, routing, link parsing, DOM helpers, maqueta tiles
//   drive/    position sources (GPS / sim / replay) and route following; no phone sensors
//   walk/     phone orientation sensors that steer the camera view
//   render/   Three.js overlay, HUD and calibration dock
//   hazards/  hazard store, cloud sync, bump detection and reporting UI
//   signs/    road signs from the maqueta along the route
//   remote/   phone <-> iPad link: the phone runs the app, the iPad shows the windshield HUD
import './style.css';
import { app } from './core/state.ts';
import { $, setupMsg, toast } from './core/ui.ts';
import { limitAt, loadRouteMaqueta, type RouteMaqueta } from './core/maqueta.ts';
import type { Route } from './core/route.ts';
import { initDriveControls } from './drive/controls.ts';
import { advance, resetProgress } from './drive/navigation.ts';
import { startSource, stopDrive, stopSource } from './drive/start.ts';
import { aheadOf, initHazardUi, loadHazards, setOsmHazards, startBumpWatcher, startCloudSync, stopBumpWatcher, stopHazards, trackPosition } from './hazards/ui.ts';
import { autoTiltTick, getCalib, getMountRoll, initCalibDock, startAutoTilt, stopAutoTilt, syncCalibProfile } from './render/calibDock.ts';
import { hideHud, initHudControls, renderHud, showHud } from './render/hud.ts';
import { currentOptics, initHudSetup, openHudGeom } from './render/hudSetup.ts';
import { ar } from './render/scene.ts';
import { remoteGps, remotePhone, remoteTilt, startHudLink } from './remote/hudLink.ts';
import { connectHud, disconnectHud, hudLinked, onHudState, sendFix, sendRoute, sendStop, setDriveProvider, type LinkState } from './remote/phoneLink.ts';
import { normalizeCode } from './remote/protocol.ts';
import { resolveDestInput, initSetupScreen } from './setup.ts';
import { destZone, initDestino } from './ui/destino.ts';
import { initMaqueta, prepareMaqueta } from './ui/maqueta.ts';
import { initFind } from './find/ui.ts';
import { go, initShell } from './ui/shell.ts';
import { setDestination } from './setup.ts';
import { clearSigns, setSigns, signsAheadOf } from './signs/store.ts';
import { setTravel } from './walk/switch.ts';
import { align, sensorsActive, startSensors, stopSensors, updateView } from './walk/view.ts';

let lastFrame = performance.now();
let wakeLock: { release(): Promise<void> } | null = null;
let attitude = { pitch: 0, roll: 0 }; // car body pitch/roll for the windshield HUD, smoothed
let maqueta: RouteMaqueta | null = null; // the active route's map data, once loaded

/**
 * Windshield HUD: the car's pitch and roll relative to the road, from the paired phone. The phone is
 * rigid in its mount, so its tilt minus its tilt at rest (the auto-calibrated pitch and roll) is the
 * body's motion: braking dive, slopes. Low-passed (~3 Hz) so engine vibration doesn't shake the guide.
 */
function carAttitude(now: number, dt: number, restPitch: number, restRoll: number) {
  const t = remoteTilt(now);
  const target = t ? { pitch: t.pitch - restPitch, roll: t.roll - restRoll } : { pitch: 0, roll: 0 };
  const k = Math.min(1, dt * 2 * Math.PI * 3);
  attitude = { pitch: attitude.pitch + (target.pitch - attitude.pitch) * k, roll: attitude.roll + (target.roll - attitude.roll) * k };
  return attitude;
}

initCalibDock();
initHudControls();
initHudSetup();
initHazardUi();
initDriveControls();
initSetupScreen();

// ---------- roles: the phone runs the app; an iPad can be the windshield HUD ----------
const ROLE_KEY = 'ar-nav.role';
const isHudRole = () => {
  try {
    return new URLSearchParams(location.search).get('role') === 'hud' || localStorage.getItem(ROLE_KEY) === 'hud';
  } catch {
    return false;
  }
};
const hudRole = isHudRole(); // decided once per page load
const setRole = (role: 'hud' | 'phone') => {
  try {
    localStorage.setItem(ROLE_KEY, role);
  } catch {
    /* ignore */
  }
  location.replace(location.pathname);
};
$('beHud').onclick = () => setRole('hud');
$('hrLeave').onclick = () => setRole('phone');
$('hrGeom').onclick = () => openHudGeom();

let lostTimer = 0;
if (hudRole) {
  // iPad: a code screen until the phone starts a drive, then the HUD; back to the code when it ends.
  $('setup').hidden = true;
  $('hudRole').hidden = false;
  app.display = 'hud';
  syncCalibProfile();
  startHudLink({
    onRoute: (route, arrival) => {
      clearTimeout(lostTimer);
      app.arrival = arrival;
      if (app.running) setRoute(route); // the phone rerouted
      else void startRemoteDrive(route);
    },
    onStop: () => stopRemoteDrive(),
    // A locked phone or a dropped link: keep drawing on the last data for a moment, then give up.
    onLost: () => {
      clearTimeout(lostTimer);
      lostTimer = window.setTimeout(() => !remotePhone() && stopRemoteDrive(), 15000);
    },
  });
} else {
  // Phone: link to the iPad by the code it shows; the HUD then follows every drive.
  initShell();
  initDestino();
  initFind();
  // Maqueta: "Confirmar punto y conducir" sets the exact arrival point and starts the drive.
  initMaqueta(({ arrival, label }) => {
    setDestination({ point: { lat: arrival.lat, lon: arrival.lon }, label }, false, arrival);
    go('destino');
    $('start').click();
  });
  const show = (s: LinkState) => {
    const el = $('linkState');
    el.hidden = s === 'off';
    el.textContent = { off: '', connecting: 'Conectando…', on: 'Conectado', lost: 'Reintentando…' }[s];
    el.classList.toggle('on', s === 'on');
    el.classList.toggle('warn', s === 'connecting' || s === 'lost');
    $('linkBtn').textContent = s === 'off' ? 'Conectar' : 'Desconectar';
    $('linkCode').hidden = s !== 'off';
    $('chipHud').hidden = s !== 'on';
    if (s === 'on') toast('iPad conectado: seguirá cada viaje que empieces');
    if (s === 'lost') toast('Se perdió el iPad, reintentando…');
  };
  onHudState(show);
  $('linkBtn').onclick = () => {
    if ($('linkBtn').textContent === 'Desconectar') return disconnectHud();
    const code = normalizeCode($<HTMLInputElement>('linkCode').value);
    if (!code) return toast('Escribe los 6 dígitos que muestra el iPad');
    void connectHud(code);
  };
  setDriveProvider(() => (app.running && app.route ? { route: app.route, arrival: app.arrival } : null));
}

/** iPad: the phone started a drive. Position comes from the phone's GPS; this device only draws. */
async function startRemoteDrive(route: Route) {
  app.mode = 'gps';
  app.display = 'hud';
  syncCalibProfile();
  await loadHazards();
  app.source = remoteGps;
  setRoute(route);
  await startAutoTilt(); // the phone's tilt: its resting value is the baseline for body motion
  $('hudRole').hidden = true;
  showHud('hud');
  enterImmersive();
  app.running = true;
  lastFrame = performance.now();
  requestAnimationFrame(frame);
}

function stopRemoteDrive() {
  if (!app.running) return;
  app.running = false;
  app.source = null;
  app.arrival = null;
  stopAutoTilt();
  stopHazards();
  app.route = null;
  maqueta = null;
  clearSigns();
  void wakeLock?.release().catch(() => {});
  wakeLock = null;
  hideHud();
  $('hudRole').hidden = false;
  clearScene(0);
}

function setRoute(r: Route) {
  app.route = r;
  resetProgress();
  if (hudLinked()) sendRoute(r, app.arrival); // the iPad follows every new route, reroutes included
  // The maqueta loads in the background; until then, and where it has no tiles, the road is flat.
  maqueta = null;
  clearSigns();
  setOsmHazards([]); // also reindexes the hazards on the new route
  void loadRouteMaqueta(r.poly).then((m) => {
    if (app.route !== r || !m) return; // rerouted meanwhile, or no tiles here
    maqueta = m;
    setSigns(m.signs, r.poly);
    setOsmHazards(m.signs);
  });
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

function clearScene(yaw: number) {
  ar?.update({
    origin: { lat: 0, lon: 0 },
    yaw,
    poly: null,
    along: 0,
    next: null,
    distToNext: Infinity,
    hazards: [],
    calib: getCalib(),
    display: app.display,
    optics: currentOptics(),
  });
}

$('start').onclick = async () => {
  const btn = $<HTMLButtonElement>('start');
  // Destination inside a maqueta zone and no exact point yet: pick it in the maqueta first.
  const zone = destZone();
  if (zone && !app.arrival && app.dest) {
    btn.disabled = true;
    setupMsg('Cargando la maqueta…');
    try {
      await prepareMaqueta(zone, app.dest.point);
      setupMsg('');
      go('maqueta');
    } catch (e) {
      setupMsg((e as Error).message);
    } finally {
      btn.disabled = false;
    }
    return;
  }
  btn.disabled = true;
  setupMsg('');
  try {
    // First awaits in the handler: iOS only shows the sensor permission prompts inside the tap.
    // Bump detection is optional: without motion permission the drive still starts, just without it.
    let bumpWarning = '';
    if ($<HTMLInputElement>('detectBumps').checked && app.mode === 'gps') {
      try {
        await startBumpWatcher();
      } catch (e) {
        stopBumpWatcher();
        bumpWarning = `Sin detección de huecos: ${(e as Error).message}`;
      }
    }
    if ($<HTMLInputElement>('useSensors').checked && app.mode !== 'replay') await startSensors();
    await startAutoTilt(); // measures the mount's tilt by itself; no-op without permission
    if (!ar) throw new Error('Este navegador no puede dibujar 3D (WebGL desactivado). Activa la aceleración por hardware en Chrome: chrome://settings/system');
    if ($<HTMLInputElement>('dest').value.trim() && !app.dest) await resolveDestInput();
    await loadHazards();
    await startSource(setRoute);
    startCloudSync();
    $('setup').hidden = true;
    showHud(app.display);
    if (app.display === 'hud') {
      toast('Sube el brillo de la pantalla al máximo para el HUD');
    }
    $<HTMLButtonElement>('align').hidden = !sensorsActive();
    $('travel').hidden = app.mode === 'replay' || app.display === 'hud';
    enterImmersive();
    if (bumpWarning) toast(bumpWarning, 5000);
    app.running = true;
    lastFrame = performance.now();
    requestAnimationFrame(frame);
  } catch (e) {
    setupMsg((e as Error).message);
    stopSource();
    stopSensors();
    stopAutoTilt();
    stopBumpWatcher();
  } finally {
    btn.disabled = false;
  }
};

$('travelWalk').onclick = () => void setTravel('walk');
$('travelDrive').onclick = () => void setTravel('drive');

$('align').onclick = () => {
  if (align(app.yaw, performance.now())) toast('Alineado con la calle');
  else toast('Sin lectura de sensores todavía');
};

$('stop').onclick = async () => {
  if (hudRole) return stopRemoteDrive();
  app.running = false;
  sendStop();
  await stopDrive();
  stopSensors();
  stopAutoTilt();
  stopHazards();
  $('align').hidden = true;
  app.route = null;
  maqueta = null;
  clearSigns();
  await wakeLock?.release().catch(() => {});
  wakeLock = null;
  if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
  hideHud();
  $('setup').hidden = false;
  setupMsg('');
  clearScene(0);
};

document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && app.running && !wakeLock) enterImmersive();
});

function frame(now: number) {
  if (!app.running) return;
  requestAnimationFrame(frame);
  const dt = Math.min(0.2, (now - lastFrame) / 1000);
  lastFrame = now;

  const fix = app.source?.current(now) ?? null;
  const route = app.route;
  if (!fix || !route) return clearScene(app.yaw);

  const calib = getCalib();
  if (!hudRole) sendFix(now, fix);
  trackPosition(now, fix.p);
  const nav = advance(fix, route, now, dt, calib.lateral, setRoute);
  const { ahead, nearest } = aheadOf(nav.along);
  const view = updateView(now, dt);
  // Braking and accelerating tilt the apparent gravity: only trust tilt readings with the car stopped.
  autoTiltTick(now, app.mode === 'gps' && nav.speed > 1);

  // Safe fallback (H9): if GPS accuracy > 30m or fix age > 3s, fade the ribbon to avoid misleading graphics
  const staleFix = fix.t ? now - fix.t > 3000 : false;
  const inaccurate = fix.accuracy ? fix.accuracy > 30 : false;
  const degraded = (staleFix || inaccurate) && app.mode === 'gps';

  ar?.update({
    origin: nav.origin,
    yaw: view ? view.yaw : nav.yaw,
    poly: route.poly,
    along: nav.along,
    next: nav.next,
    distToNext: nav.distToNext,
    hazards: ahead,
    calib,
    pose: view ? { pitch: view.pitch, roll: view.roll } : undefined,
    display: app.display,
    degraded,
    mountRoll: getMountRoll(),
    optics: currentOptics(),
    attitude: app.display === 'hud' ? carAttitude(now, dt, calib.pitch, getMountRoll()) : undefined,
    elevAlong: maqueta?.profile?.at ?? null,
    signs: signsAheadOf(nav.along),
    arrival: app.arrival ? { p: { lat: app.arrival.lat, lon: app.arrival.lon } } : null,
    destLabel: app.arrival?.label ?? app.dest?.label ?? null,
    // Simulación: the street in 3D from the maqueta wherever there is one, instead of the camera.
    scenery: app.mode === 'sim' ? (maqueta?.tiles ?? null) : null,
  });
  renderHud({
    route,
    speed: nav.speed,
    remaining: nav.remaining,
    next: nav.next,
    distToNext: nav.distToNext,
    nearestHazard: nearest,
    offRoute: !nav.onRoute && app.mode === 'gps',
    speedLimit: maqueta ? limitAt(maqueta.limits, nav.along) : null,
  });
}

// Service worker: makes the app installable on Android, which is what puts it in the
// Google Maps / Waze share menu (Web Share Target in the manifest).
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
