// Phone app shell: switches between the screens of the bottom nav and runs the Dispositivos
// calibration (two sliders and a horizon preview, over the same calibration the dock edits).
import { $ } from '../core/ui.ts';
import { getCalib, onCalibChange, setCalibValue } from '../render/calibDock.ts';
import type { Calib } from '../render/calib.ts';
import { initAccount } from '../auth/ui.ts';
import { refreshSavedPins, showDestinoMap } from './destino.ts';
import { initDestShortcut, initLugares, renderLugares, renderSyncStatus } from './lugares.ts';
import { initPinsSync } from './syncPins.ts';
import { showMaqueta } from './maqueta.ts';

export type Screen = 'destino' | 'maqueta' | 'dispositivos';
const SCREENS: Record<Screen, string> = { destino: 'scrDestino', maqueta: 'scrMaqueta', dispositivos: 'scrDispositivos' };

export function go(screen: Screen) {
  for (const [name, id] of Object.entries(SCREENS)) $(id).hidden = name !== screen;
  const tab = screen === 'maqueta' ? 'destino' : screen; // the maqueta belongs to the Mapa tab
  document.querySelectorAll<HTMLElement>('.bottomNav [data-go]').forEach((b) => {
    if (b.dataset.go === tab) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  if (screen === 'dispositivos') {
    renderCalib(getCalib());
    renderLugares();
  }
  if (screen === 'destino') void showDestinoMap();
  if (screen === 'maqueta') showMaqueta();
}

/** Horizon line of the preview: tilting the camera down (more pitch) moves the horizon up in the picture. */
function renderCalib(c: Calib) {
  const h = $<HTMLInputElement>('calHeight');
  const p = $<HTMLInputElement>('calPitch');
  if (document.activeElement !== h) h.value = String(c.height);
  if (document.activeElement !== p) p.value = String(c.pitch);
  $('calHeightVal').textContent = `${c.height.toFixed(2).replace('.', ',')} m`;
  $('calPitchVal').textContent = `${String(c.pitch).replace('.', ',')}°`;
  const y = Math.round(Math.min(150, Math.max(20, 96 - c.pitch * 4)));
  const line = $('calHorizon');
  line.setAttribute('y1', String(y));
  line.setAttribute('y2', String(y));
  $('calRoad').setAttribute('points', `152,${y} 206,${y} 358,170 0,170`);
}

export function initShell() {
  document.querySelectorAll<HTMLElement>('[data-go]').forEach((b) => {
    b.addEventListener('click', () => go(b.dataset.go as Screen));
  });
  const bind = (id: string, key: keyof Calib) =>
    $<HTMLInputElement>(id).addEventListener('input', () => setCalibValue(key, parseFloat($<HTMLInputElement>(id).value)));
  bind('calHeight', 'height');
  bind('calPitch', 'pitch');
  onCalibChange(renderCalib);
  initLugares(() => go('destino'));
  initDestShortcut();
  initPinsSync(() => {
    refreshSavedPins();
    renderLugares();
  }, renderSyncStatus);
  initAccount();
  // The first screen is opened by the entry flow (src/ui/entry.ts): the map, once the user is in.
}
