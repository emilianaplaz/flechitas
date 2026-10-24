// Everything the user sees and does about hazards: tap-to-report buttons, the bump-detected
// prompt, undo/export, and the background upload queue. Navigation only calls the small
// functions at the bottom (`reindexHazards`, `aheadOf`, `trackPosition`).
import type { LatLon } from '../core/geo.ts';
import { app } from '../core/state.ts';
import { $, download, toast } from '../core/ui.ts';
import { hazardsAhead, indexOnRoute, type RouteHazard } from './ahead.ts';
import { BumpWatcher, type BumpEvent } from './bump.ts';
import { cloudEnabled, enqueue, flush } from './cloud.ts';
import { HAZARD_LABEL, HazardStore, type HazardType } from './store.ts';

const hazards = new HazardStore();
let onRoute: RouteHazard[] = [];
let watcher: BumpWatcher | null = null;
let trail: { t: number; p: LatLon }[] = [];
let detectTimer = 0;
let syncTimer = 0;

/** Recompute which hazards lie on the current route. Call after the route or the store changes. */
export function reindexHazards() {
  onRoute = indexOnRoute(hazards.all(), app.route);
}

/** Hazards to draw from `along`, and the nearest one worth a banner. */
export const aheadOf = (along: number) => hazardsAhead(onRoute, along);

export async function loadHazards() {
  await hazards.loadSeeds();
  await hazards.loadShared();
}

/** Keep a few seconds of positions: a tap on "Hueco" comes after the hit, so the point belongs behind us. */
export function trackPosition(now: number, p: LatLon) {
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

function closeDetect() {
  clearTimeout(detectTimer);
  $('detect').hidden = true;
}

function onBump(e: BumpEvent) {
  if (!$('detect').hidden) return;
  const here = app.source?.current(performance.now())?.p;
  if (!here) return;
  const heading = Math.round(app.yaw);
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
      reindexHazards();
      toast(`${HAZARD_LABEL[choice]} guardado. ¡Gracias!`);
    }
  };
  $('detect').onclick = (ev) => {
    const choice = (ev.target as HTMLElement).closest<HTMLElement>('[data-detect]')?.dataset.detect;
    if (choice) answer(choice);
  };
  detectTimer = window.setTimeout(closeDetect, 8000);
}

/** Call inside the tap handler: iOS only shows the motion permission prompt there. */
export async function startBumpWatcher() {
  watcher = new BumpWatcher(() => app.source?.current(performance.now())?.speed ?? 0, onBump);
  await watcher.start();
}

export function stopBumpWatcher() {
  watcher?.stop();
  watcher = null;
}

/** Begin uploading queued reports in the background. */
export function startCloudSync() {
  if (!cloudEnabled) return;
  void flush();
  syncTimer = window.setInterval(() => void flush(), 20000);
}

export function stopHazards() {
  stopBumpWatcher();
  closeDetect();
  clearInterval(syncTimer);
  void flush({ force: true });
  trail = [];
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
  $('exportHazards').onclick = () => {
    download(new Blob([hazards.exportJson()], { type: 'application/json' }), 'hazards.json');
    toast('Copia ese archivo a public/hazards.json para que todos lo vean');
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
