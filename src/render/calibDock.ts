// The calibration dock: one slider at a time for the camera/overlay parameters
// (plus video/GPS sync when replaying). Calibration is stored per screen layout.
import { app } from '../core/state.ts';
import { $, toast } from '../core/ui.ts';
import { TrackReplay } from '../drive/sources.ts';
import { remoteHfov, remotePhone, remoteTilt } from '../remote/display.ts';
import { OrientationSensor } from '../walk/orientation.ts';
import { sensorsActive } from '../walk/view.ts';
import { TiltWindow, loadLensHfov, loadManual, loadMountRoll, saveManual, saveMountRoll, visibleVfov } from './autocalib.ts';
import { CALIB_RANGES, currentLayout, defaultsFor, loadCalib, saveCalib, type Calib } from './calib.ts';
import { ar } from './scene.ts';

type DockKey = keyof Calib | 'sync';
const SYNC_RANGE = { min: -5, max: 5, step: 0.1, label: 'Sincronía video/GPS', unit: 's' };
let dockKey: DockKey = 'fov';
let layout = currentLayout();
let calib: Calib = loadCalib(layout, app.display);

let mountRoll = loadMountRoll(layout);
let manual = loadManual(layout); // values moved by hand: automatic calibration leaves them alone

export const getCalib = (): Calib => calib;
/** Measured roll of a fixed mount (no slider for it). Ignored while the phone sensors drive the view. */
export const getMountRoll = (): number => mountRoll;

export function syncCalibProfile() {
  layout = currentLayout();
  calib = loadCalib(layout, app.display);
  buildDock();
}

function dockKeys(): DockKey[] {
  const keys = Object.keys(CALIB_RANGES) as DockKey[];
  return app.mode === 'replay' ? [...keys, 'sync'] : keys;
}
function dockRange(key: DockKey) {
  return key === 'sync' ? SYNC_RANGE : CALIB_RANGES[key];
}
function dockValue(key: DockKey): number {
  if (key === 'sync') return app.source instanceof TrackReplay ? app.source.syncOffset : 0;
  return calib[key];
}
function setDockValue(key: DockKey, raw: number) {
  const r = dockRange(key);
  const v = Math.round(Math.min(r.max, Math.max(r.min, raw)) / r.step) * r.step;
  const clean = +v.toFixed(2);
  if (key === 'sync') {
    if (app.source instanceof TrackReplay) app.source.syncOffset = clean;
  } else {
    calib = { ...calib, [key]: clean };
    saveCalib(calib, layout, app.display);
    if (key === 'pitch' || key === 'fov') saveManual(layout, (manual = { ...manual, [key]: true }));
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
function setCalibOpen(open: boolean) {
  $('calib').hidden = !open;
  document.body.classList.toggle('calibrating', open);
}

function resize() {
  ar?.resize(window.innerWidth, window.innerHeight);
  const now = currentLayout();
  if (now !== layout) {
    layout = now;
    calib = loadCalib(layout, app.display);
    mountRoll = loadMountRoll(layout);
    manual = loadManual(layout);
    tiltWindow.clear();
    tiltMeasured = false;
    buildDock();
    toast(layout === 'portrait' ? 'Modo vertical: calibración propia' : 'Modo horizontal: calibración propia');
  }
  applyAutoFov();
}

// ---------- automatic calibration ----------
type Range = { min: number; max: number; step: number };
const fit = (v: number, r: Range) => +(Math.round(Math.min(r.max, Math.max(r.min, v)) / r.step) * r.step).toFixed(2);

/** Field of view from the lens and how the camera video is cropped to this screen. Skipped once set by hand. */
function applyAutoFov() {
  const video = $<HTMLVideoElement>('video');
  if (manual.fov || !video.videoWidth || !video.videoHeight) return;
  // A paired phone says how wide its (upright, landscape) picture is; otherwise assume our own lens.
  const lens = remoteHfov() ?? loadLensHfov();
  const fov = fit(visibleVfov(lens, video.videoWidth, video.videoHeight, window.innerWidth, window.innerHeight), CALIB_RANGES.fov);
  if (fov === calib.fov) return;
  calib = { ...calib, fov };
  saveCalib(calib, layout);
  renderDockValue();
}

let tiltSensor: OrientationSensor | null = null;
let tiltFromPhone = false; // a phone paired by QR is the camera: its tilt counts, not this device's
const tiltWindow = new TiltWindow();
let lastTiltCheck = 0;
let tiltMeasured = false;

/**
 * Starts measuring the mount's tilt and roll from gravity. Call inside the Iniciar tap (iOS asks
 * for motion permission there). Without permission it quietly leaves calibration to the sliders.
 * Not for replays (the phone isn't in the mount) or when the phone sensors already steer the view.
 */
export async function startAutoTilt() {
  if (app.mode === 'replay' || sensorsActive()) return;
  tiltWindow.clear();
  lastTiltCheck = 0;
  tiltMeasured = false;
  if (remotePhone()) {
    tiltFromPhone = true;
    return;
  }
  // Windshield HUD: this device lies flat on the dash; its tilt says nothing about the road.
  if (app.display === 'hud') return;
  const sensor = new OrientationSensor();
  try {
    await sensor.start();
  } catch {
    return;
  }
  tiltSensor = sensor;
}

export function stopAutoTilt() {
  tiltSensor?.stop();
  tiltSensor = null;
  tiltFromPhone = false;
}

/** Per frame. Updates tilt and roll whenever the phone has been still for a moment with the car stopped. */
export function autoTiltTick(now: number, carMoving: boolean) {
  if (!tiltSensor && !tiltFromPhone) return;
  const p = tiltFromPhone ? remoteTilt(now) : tiltSensor!.current(now);
  if (p) tiltWindow.push(now, { pitch: p.pitch, roll: p.roll }, carMoving);
  if (now - lastTiltCheck < 1000) return;
  lastTiltCheck = now;
  const m = tiltWindow.steady();
  if (!m) return;
  // First reading is taken as is; later ones blend in, so a nudge of the mount is followed smoothly.
  const k = tiltMeasured ? 0.5 : 1;
  const first = !tiltMeasured;
  tiltMeasured = true;
  mountRoll = +(mountRoll + (m.roll - mountRoll) * k).toFixed(1);
  saveMountRoll(layout, mountRoll);
  if (!manual.pitch) {
    const pitch = fit(calib.pitch + (m.pitch - calib.pitch) * k, CALIB_RANGES.pitch);
    if (pitch !== calib.pitch) {
      calib = { ...calib, pitch };
      saveCalib(calib, layout);
      renderDockValue();
    }
  }
  if (first) toast(`Calibrado solo: inclinación ${calib.pitch}°, ladeo ${mountRoll}°`);
}

export function initCalibDock() {
  $('oneRange').addEventListener('input', () => setDockValue(dockKey, parseFloat($<HTMLInputElement>('oneRange').value)));
  $('oneMinus').onclick = () => setDockValue(dockKey, dockValue(dockKey) - dockRange(dockKey).step);
  $('onePlus').onclick = () => setDockValue(dockKey, dockValue(dockKey) + dockRange(dockKey).step);
  buildDock();
  $('calibBtn').onclick = () => {
    buildDock();
    setCalibOpen(true);
  };
  $('calibClose').onclick = () => setCalibOpen(false);
  $('calibReset').onclick = () => {
    // Back to automatic: forget hand-set values, re-measure tilt, recompute the field of view.
    calib = defaultsFor(layout, app.display);
    saveCalib(calib, layout, app.display);
    mountRoll = 0;
    saveMountRoll(layout, 0);
    saveManual(layout, (manual = {}));
    tiltWindow.clear();
    tiltMeasured = false;
    applyAutoFov();
    renderDockValue();
  };
  // The camera (or a replay video) reports its size once it starts and when it changes.
  const video = $<HTMLVideoElement>('video');
  video.addEventListener('loadedmetadata', applyAutoFov);
  video.addEventListener('resize', applyAutoFov);
  window.addEventListener('remotecam', applyAutoFov);
  window.addEventListener('resize', resize);
  resize();
}
