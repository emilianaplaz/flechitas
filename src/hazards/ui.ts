// Everything the user sees and does about hazards: tap-to-report buttons, the bump-detected
// prompt, undo/export, and the background upload queue. Navigation only calls the small
// functions at the bottom (`reindexHazards`, `aheadOf`, `trackPosition`).
import type { LatLon } from '../core/geo.ts';
import type { TileSign } from '../core/maqueta.ts';
import { app } from '../core/state.ts';
import { $, toast } from '../core/ui.ts';
import { hazardsAhead, indexOnRoute, type RouteHazard } from './ahead.ts';
import { BumpWatcher, type BumpEvent } from './bump.ts';
import { cloudEnabled, flush } from './cloud.ts';
import { MockMotion } from './mockMotion.ts';
import { HAZARD_LABEL, HazardStore, type HazardType } from './store.ts';

const hazards = new HazardStore();
let onRoute: RouteHazard[] = [];
let watcher: BumpWatcher | null = null;
let mock: MockMotion | null = null;
let trail: { t: number; p: LatLon }[] = [];
let syncTimer = 0;
const CONFIRM_MS = 8000;
let confirmTarget: string | null = null;
let confirmTimer = 0;

function hideConfirm() {
  clearTimeout(confirmTimer);
  confirmTarget = null;
  $('confirmHole').hidden = true;
}

/** Shows the hole button for the newest detection. A newer one retargets it and restarts the countdown ring. */
function offerConfirm(id: string) {
  const btn = $('confirmHole');
  confirmTarget = id;
  clearTimeout(confirmTimer);
  confirmTimer = window.setTimeout(hideConfirm, CONFIRM_MS);
  btn.style.setProperty('--confirm-ms', `${CONFIRM_MS}ms`);
  btn.hidden = true;
  void btn.offsetWidth; // reflow so the entrance and the ring animation restart
  btn.hidden = false;
}

/** Recompute which hazards lie on the current route. Call after the route or the store changes. */
export function reindexHazards() {
  onRoute = indexOnRoute(hazards.all(), app.route);
}

/** Hazards to draw from `along`, and the nearest one worth a banner. */
export const aheadOf = (along: number) => hazardsAhead(onRoute, along);

/** Speed bumps from the maqueta tiles of the current route (OSM `traffic_calming`), shown like reported ones. */
export function setOsmHazards(signs: TileSign[]) {
  hazards.osm = signs
    .filter((s) => s.type === 'bump' || s.type === 'hump' || s.type === 'table')
    .map((s) => ({ id: s.id, type: 'policia', lat: s.lat, lon: s.lon, createdAt: '', heading: s.dir ?? undefined, source: 'osm' }));
  reindexHazards();
}

/** Every known hazard (shared, this phone's), for the map. */
export const allHazards = () => hazards.all();

export async function loadHazards() {
  await hazards.loadShared();
}

/** Keep a few seconds of positions: a tap on "Hueco" comes after the hit, so the point belongs behind us. */
export function trackPosition(now: number, p: LatLon) {
  startMockMotion();
  if (app.route) mock?.update(app.route.poly, p, app.source?.current(now)?.speed ?? 0);
  if (trail.length && trail[trail.length - 1].p === p) return;
  trail.push({ t: now, p });
  while (trail.length > 1 && now - trail[1].t > 4000) trail.shift();
}

function positionAgo(ms: number): LatLon | null {
  const cutoff = performance.now() - ms;
  let found: LatLon | null = null;
  for (const e of trail) if (e.t <= cutoff) found = e.p;
  return found;
}

/** A detected hit is saved unconfirmed (half weight). The hole button lets the driver confirm it without stopping. */
function onBump(e: BumpEvent, simulated = false) {
  // The event ends after the hit; the hazard sits about half its length (plus the quiet wait) behind us.
  const here = positionAgo(e.durationMs / 2 + 120) ?? app.source?.current(performance.now())?.p;
  if (!here) return;
  const extra = { heading: Math.round(app.yaw) };
  const h = simulated ? hazards.addSimulated(e.type, here, extra) : hazards.add(e.type, here, { ...extra, source: 'detected' });
  reindexHazards();
  offerConfirm(h.id);
}

/** Simulación and Repetición have no real road under the sensor, so they get the mock instead. Started here because main only starts the real watcher on a GPS drive. */
function startMockMotion() {
  if (mock || app.mode === 'gps' || !app.running || !$<HTMLInputElement>('detectBumps').checked) return;
  mock = new MockMotion((e) => onBump(e, true));
  toast('Modo de prueba: los baches y policías son simulados y no se guardan.');
}

/** Call inside the tap handler: iOS only shows the motion permission prompt there. */
export async function startBumpWatcher() {
  watcher = new BumpWatcher(() => app.source?.current(performance.now())?.speed ?? 0, onBump);
  await watcher.start();
}

export function stopBumpWatcher() {
  watcher?.stop();
  watcher = null;
  mock?.stop();
  mock = null;
}

/** Begin uploading queued reports in the background. */
export function startCloudSync() {
  if (!cloudEnabled) return;
  void flush();
  syncTimer = window.setInterval(() => void flush(), 20000);
}

export function stopHazards() {
  stopBumpWatcher();
  clearInterval(syncTimer);
  void flush({ force: true });
  trail = [];
  hazards.osm = [];
  hazards.clearSimulated();
  hideConfirm();
}

export function initHazardUi() {
  document.querySelectorAll<HTMLButtonElement>('[data-report]').forEach((b) =>
    b.addEventListener('click', () => {
      const type = b.dataset.report as HazardType;
      const here = positionAgo(1500) ?? app.source?.current(performance.now())?.p;
      if (!here) return toast('Todavía no tengo tu posición');
      hazards.add(type, here, { heading: Math.round(app.yaw), source: 'tap' });
      reindexHazards();
      toast(`${HAZARD_LABEL[type]} reportado aquí. ¡Gracias!`);
      navigator.vibrate?.(60);
    }),
  );
  $('confirmHole').onclick = () => {
    if (confirmTarget && hazards.confirm(confirmTarget)) {
      reindexHazards();
      navigator.vibrate?.(40);
      toast('Hueco confirmado');
    }
    hideConfirm();
  };
  $('undoReport').onclick = () => {
    const h = hazards.undoLast();
    reindexHazards();
    toast(h ? `Se borró el último reporte (${HAZARD_LABEL[h.type].toLowerCase()})` : 'No hay reportes tuyos');
  };
  window.addEventListener('online', () => void flush());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void flush();
  });
}
