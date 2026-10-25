// Destination and drive options on the phone: mode, origin, destination (typed, pasted or shared from Maps/Waze).
import { extractUrl, resolveDestination } from './core/links.ts';
import type { LatLon } from './core/geo.ts';
import type { Arrival } from './remote/protocol.ts';
import { app, type Display, type Mode } from './core/state.ts';
import { $, setText, setupMsg, toast } from './core/ui.ts';
import { syncCalibProfile } from './render/calibDock.ts';

const DEST_HINT = 'Escribe una dirección, pega un enlace o toca el mapa';

function syncMode() {
  app.mode = (document.querySelector<HTMLInputElement>('input[name=mode]:checked')?.value ?? 'gps') as Mode;
  // Real drives start from the GPS; a simulation can start anywhere.
  const from = $<HTMLInputElement>('from');
  from.placeholder = app.mode === 'sim' ? 'Desde (vacío = mi ubicación)' : 'Mi ubicación actual';
  if (app.mode !== 'sim' && from.value) {
    from.value = '';
    from.dispatchEvent(new Event('change')); // the map preview goes back to starting here
  }
  $('replayFields').hidden = app.mode !== 'replay';
}

/** Starting somewhere else means a simulation: a real drive can only start where the phone is. */
export function useSimulation() {
  if (app.mode === 'sim') return;
  const sim = document.querySelector<HTMLInputElement>('input[name=mode][value=sim]');
  if (!sim) return;
  sim.checked = true;
  sim.dispatchEvent(new Event('change'));
  toast('Modo Simulación: el viaje empieza en el origen que elegiste', 4000);
}

function originTyped() {
  if ($<HTMLInputElement>('from').value.trim()) useSimulation();
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
export function setDestination(d: { point: LatLon; label: string }, labelOnly = false, arrival: Arrival | null = null) {
  if (labelOnly && (app.dest?.point.lat !== d.point.lat || app.dest?.point.lon !== d.point.lon)) return; // another tap since
  app.dest = d;
  if (!labelOnly) app.arrival = arrival;
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
  app.arrival = null;
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

  // Before the map's own listener (initDestino), so the preview already starts from the typed origin.
  $('from').addEventListener('change', originTyped);
  $('dest').addEventListener('change', () => resolveDestInput().catch((e) => setupMsg((e as Error).message)));
  // Opened from the Android share sheet (Web Share Target) — Google Maps / Waze "Compartir".
  const q = new URLSearchParams(location.search);
  const shared = [q.get('url'), q.get('text'), q.get('title')].filter(Boolean).join(' ');
  if (shared) {
    $<HTMLInputElement>('dest').value = extractUrl(shared) ?? shared;
    history.replaceState(null, '', '/');
    resolveDestInput().catch((e) => setupMsg((e as Error).message));
  }
}
