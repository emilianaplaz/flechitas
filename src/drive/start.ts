// Starting and stopping the position source for each mode: real GPS, simulated drive, or replay.
import { fetchRoute, routeFromTrack, type Route } from '../core/route.ts';
import { resolveDestination } from '../core/links.ts';
import type { LatLon } from '../core/geo.ts';
import { app } from '../core/state.ts';
import { $, setupMsg, toast } from '../core/ui.ts';
import type { Fix, Source } from '../core/types.ts';
import { recorder } from './controls.ts';
import { GpsSource, RouteSim, TrackReplay, parseTrack, type Track } from './sources.ts';

const video = () => $<HTMLVideoElement>('video');

async function startCamera(required: boolean) {
  try {
    app.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    });
    video().srcObject = app.stream;
    await video().play();
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

function waitForFix(src: Source, timeoutMs = 30000): Promise<Fix> {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const tick = () => {
      const f = src.current(performance.now());
      if (f) resolve(f);
      else if (performance.now() - t0 > timeoutMs) {
        reject(new Error('El GPS no responde. Sal a cielo abierto e intenta otra vez.'));
      }
      else setTimeout(tick, 250);
    };
    tick();
  });
}

function readJsonFile(file: File): Promise<unknown> {
  return file.text().then((t) => JSON.parse(t));
}

/** Open the camera, build the route and start `app.source` for the selected mode. */
export async function startSource(setRoute: (r: Route) => void) {
  const { mode, dest, display } = app;
  if (mode === 'gps') {
    if (!dest) throw new Error('Elige un destino primero');
    if (display !== 'hud') await startCamera(true);
    const gps = new GpsSource((f) => recorder.addFix(f), toast);
    gps.start();
    app.source = gps;
    setupMsg('Esperando señal de GPS…');
    const fix = await waitForFix(gps);
    setRoute(await fetchRoute(fix.p, dest.point));
  } else if (mode === 'sim') {
    if (!dest) throw new Error('Elige un destino primero');
    const fromRaw = $<HTMLInputElement>('from').value.trim();
    const from = fromRaw ? (await resolveDestination(fromRaw)).point : await currentPosition();
    setRoute(await fetchRoute(from, dest.point));
    if (display !== 'hud') await startCamera(false);
    app.source = new RouteSim(app.route!.poly);
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
    const v = video();
    v.srcObject = null;
    v.src = URL.createObjectURL(vf);
    v.loop = false;
    await v.play();
    app.source = new TrackReplay(track, v);
    $('simBar').hidden = false;
    $('simSpeed').hidden = true;
    $('simSpeedVal').hidden = true;
  }
  app.source.start();
  if (mode !== 'gps') $('rec').hidden = true;
}

/** Stop the position source and camera (used on a failed start and on a normal stop). */
export function stopSource() {
  app.source?.stop();
  app.source = null;
  app.stream?.getTracks().forEach((t) => t.stop());
  app.stream = null;
}

/** Full stop: also finish a recording and put the drive controls back for the next run. */
export async function stopDrive() {
  if (recorder.recording) await recorder.stop();
  stopSource();
  const v = video();
  v.pause();
  v.removeAttribute('src');
  v.srcObject = null;
  $('simBar').hidden = true;
  $('simSpeed').hidden = false;
  $('simSpeedVal').hidden = false;
  $('rec').hidden = false;
}
