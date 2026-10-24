// Composition root: wires the modules together and runs the per-frame loop.
//   core/     shared types, geometry, routing, link parsing, DOM helpers
//   drive/    position sources (GPS / sim / replay) and route following; no phone sensors
//   walk/     phone orientation sensors that steer the camera view
//   render/   Three.js overlay, HUD and calibration dock
//   hazards/  hazard store, cloud sync, bump detection and reporting UI
import './style.css';
import { app } from './core/state.ts';
import { $, setupMsg, toast } from './core/ui.ts';
import type { Route } from './core/route.ts';
import { initDriveControls } from './drive/controls.ts';
import { advance, resetProgress } from './drive/navigation.ts';
import { startSource, stopDrive, stopSource } from './drive/start.ts';
import { aheadOf, initHazardUi, loadHazards, reindexHazards, startBumpWatcher, startCloudSync, stopBumpWatcher, stopHazards, trackPosition } from './hazards/ui.ts';
import { getCalib, initCalibDock } from './render/calibDock.ts';
import { hideHud, renderHud } from './render/hud.ts';
import { ar } from './render/scene.ts';
import { resolveDestInput, initSetupScreen } from './setup.ts';
import { align, sensorsActive, startSensors, stopSensors, updateView } from './walk/view.ts';

let lastFrame = performance.now();
let wakeLock: { release(): Promise<void> } | null = null;

initCalibDock();
initHazardUi();
initDriveControls();
initSetupScreen();

function setRoute(r: Route) {
  app.route = r;
  resetProgress();
  reindexHazards();
}

async function enterImmersive() {
  try {
    await document.documentElement.requestFullscreen?.();
  } catch {
    /* not supported (e.g. iOS) */
  }
  try {
    wakeLock = await (navigator as unknown as { wakeLock?: { request(t: string): Promise<{ release(): Promise<void> }> } }).wakeLock?.request('screen') ?? null;
  } catch {
    /* ignore */
  }
}

function clearScene(yaw: number) {
  ar?.update({ origin: { lat: 0, lon: 0 }, yaw, poly: null, along: 0, next: null, distToNext: Infinity, hazards: [], calib: getCalib() });
}

$('start').onclick = async () => {
  const btn = $<HTMLButtonElement>('start');
  btn.disabled = true;
  setupMsg('');
  try {
    // First awaits in the handler: iOS only shows the sensor permission prompts inside the tap.
    if ($<HTMLInputElement>('detectBumps').checked && app.mode !== 'replay') await startBumpWatcher();
    if ($<HTMLInputElement>('useSensors').checked && app.mode !== 'replay') await startSensors();
    if (!ar) throw new Error('Este navegador no puede dibujar 3D (WebGL desactivado). Activa la aceleración por hardware en Chrome: chrome://settings/system');
    if ($<HTMLInputElement>('dest').value.trim() && !app.dest) await resolveDestInput();
    await loadHazards();
    await startSource(setRoute);
    startCloudSync();
    $('setup').hidden = true;
    $('hud').hidden = false;
    $<HTMLButtonElement>('align').hidden = !sensorsActive();
    await enterImmersive();
    app.running = true;
    lastFrame = performance.now();
    requestAnimationFrame(frame);
  } catch (e) {
    setupMsg((e as Error).message);
    stopSource();
    stopSensors();
    stopBumpWatcher();
  } finally {
    btn.disabled = false;
  }
};

$('align').onclick = () => {
  if (align(app.yaw, performance.now())) toast('Alineado con la calle');
  else toast('Sin lectura de sensores todavía');
};

$('stop').onclick = async () => {
  app.running = false;
  await stopDrive();
  stopSensors();
  stopHazards();
  $('align').hidden = true;
  app.route = null;
  await wakeLock?.release().catch(() => {});
  if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
  hideHud();
  $('setup').hidden = false;
  setupMsg('');
  clearScene(0);
};

document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && app.running && !wakeLock) await enterImmersive();
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
  trackPosition(now, fix.p);
  const nav = advance(fix, route, now, dt, calib.lateral, setRoute);
  const { ahead, nearest } = aheadOf(nav.along);
  const view = updateView(now, dt);

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
  });
  renderHud({ route, speed: nav.speed, remaining: nav.remaining, next: nav.next, distToNext: nav.distToNext, nearestHazard: nearest, offRoute: !nav.onRoute && app.mode === 'gps' });
}

// Service worker: makes the app installable on Android, which is what puts it in the
// Google Maps / Waze share menu (Web Share Target in the manifest).
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
