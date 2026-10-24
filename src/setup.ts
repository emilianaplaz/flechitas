// Destination and drive options on the phone: mode, origin, destination (typed, pasted or shared from Maps/Waze).
import { extractUrl, resolveDestination } from './core/links.ts';
import type { LatLon } from './core/geo.ts';
import { app, type Display, type Mode } from './core/state.ts';
import { $, setText, setupMsg } from './core/ui.ts';
import { syncCalibProfile } from './render/calibDock.ts';

const DEST_HINT = 'Escribe una dirección, pega un enlace o toca el mapa';

function syncMode() {
  app.mode = (document.querySelector<HTMLInputElement>('input[name=mode]:checked')?.value ?? 'gps') as Mode;
  // Real drives start from the GPS; a simulation can start anywhere.
  const from = $<HTMLInputElement>('from');
  from.disabled = app.mode !== 'sim';
  from.placeholder = app.mode === 'sim' ? 'Desde (vacío = mi ubicación)' : 'Mi ubicación actual';
  if (app.mode !== 'sim') from.value = '';
  $('replayFields').hidden = app.mode !== 'replay';
}

function syncDisplay() {
  const chosen = (document.querySelector<HTMLInputElement>('input[name=display]:checked')?.value ?? 'camera') as Display;
  app.display = chosen;
  try {
    localStorage.setItem('ar-nav.display', chosen);
  } catch {
    /* ignore */
  }
  syncCalibProfile();
  $('hudGeomOpen').hidden = chosen !== 'hud';
}

function showDest(title: string, sub: string) {
  setText('dcTitle', title);
  setText('destLabel', sub);
}

const destListeners: (() => void)[] = [];
/** Called whenever the destination changes (typed, pasted, shared or tapped on the map). */
export function onDest(fn: () => void) {
  destListeners.push(fn);
}

/** Destination picked on the map. `labelOnly`: same point, only its name arrived. */
export function setDestination(d: { point: LatLon; label: string }, labelOnly = false) {
  if (labelOnly && (app.dest?.point.lat !== d.point.lat || app.dest?.point.lon !== d.point.lon)) return; // another tap since
  app.dest = d;
  $<HTMLInputElement>('dest').value = d.label;
  setupMsg('');
  setText('dcTitle', d.label);
  if (!labelOnly) destListeners.forEach((fn) => fn());
}

export async function resolveDestInput(): Promise<void> {
  const raw = $<HTMLInputElement>('dest').value.trim();
  if (!raw) {
    app.dest = null;
    showDest('¿A dónde vas?', DEST_HINT);
    destListeners.forEach((fn) => fn());
    return;
  }
  showDest('Buscando…', raw);
  try {
    app.dest = await resolveDestination(raw);
    showDest(app.dest.label, 'Destino listo');
    destListeners.forEach((fn) => fn());
  } catch (e) {
    app.dest = null;
    showDest('¿A dónde vas?', DEST_HINT);
    destListeners.forEach((fn) => fn());
    throw e;
  }
}

/** Caminar = the phone in the hand steers the view with its sensors; Manejar = fixed on the dash. */
function setGo(walk: boolean) {
  $<HTMLInputElement>('useSensors').checked = walk;
  $('goWalk').setAttribute('aria-pressed', String(walk));
  $('goDrive').setAttribute('aria-pressed', String(!walk));
  setText('chipCam', walk ? 'En la mano' : 'Cámara fija');
  try {
    localStorage.setItem('ar-nav.walk', walk ? '1' : '0');
  } catch {
    /* ignore */
  }
}

export function initSetupScreen() {
  document.querySelectorAll<HTMLInputElement>('input[name=mode]').forEach((r) => r.addEventListener('change', syncMode));
  document.querySelectorAll<HTMLInputElement>('input[name=display]').forEach((r) => r.addEventListener('change', syncDisplay));

  try {
    const savedDisplay = localStorage.getItem('ar-nav.display') as Display | null;
    if (savedDisplay === 'camera' || savedDisplay === 'hud') {
      const radio = document.querySelector<HTMLInputElement>(`input[name=display][value="${savedDisplay}"]`);
      if (radio) radio.checked = true;
    }
  } catch {
    /* ignore */
  }
  let walk = false;
  try {
    walk = localStorage.getItem('ar-nav.walk') === '1';
  } catch {
    /* ignore */
  }
  setGo(walk);
  $('goWalk').onclick = () => setGo(true);
  $('goDrive').onclick = () => setGo(false);

  // Browsers restore the checked radio after a reload without firing `change`.
  syncMode();
  syncDisplay();
  window.addEventListener('pageshow', () => {
    syncMode();
    syncDisplay();
  });

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
  const q = new URLSearchParams(location.search);
  const shared = [q.get('url'), q.get('text'), q.get('title')].filter(Boolean).join(' ');
  if (shared) {
    $<HTMLInputElement>('dest').value = extractUrl(shared) ?? shared;
    history.replaceState(null, '', '/');
    resolveDestInput().catch((e) => setupMsg((e as Error).message));
  }
}
