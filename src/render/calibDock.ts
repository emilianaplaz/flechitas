// The calibration dock: one slider at a time for the camera/overlay parameters
// (plus video/GPS sync when replaying). Calibration is stored per screen layout.
import { app } from '../core/state.ts';
import { $, toast } from '../core/ui.ts';
import { TrackReplay } from '../drive/sources.ts';
import { CALIB_RANGES, currentLayout, defaultsFor, loadCalib, saveCalib, type Calib } from './calib.ts';
import { ar } from './scene.ts';

type DockKey = keyof Calib | 'sync';
const SYNC_RANGE = { min: -5, max: 5, step: 0.1, label: 'Sincronía video/GPS', unit: 's' };
let dockKey: DockKey = 'fov';
let layout = currentLayout();
let calib: Calib = loadCalib(layout);

export const getCalib = (): Calib => calib;

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
function setCalibOpen(open: boolean) {
  $('calib').hidden = !open;
  document.body.classList.toggle('calibrating', open);
}

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
    calib = defaultsFor(layout);
    saveCalib(calib, layout);
    renderDockValue();
  };
  window.addEventListener('resize', resize);
  resize();
}
