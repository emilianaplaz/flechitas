// HUD controls tied to the position source: record a drive, pause/speed the simulation.
import { app } from '../core/state.ts';
import { $, toast } from '../core/ui.ts';
import { DriveRecorder } from './recorder.ts';
import { RouteSim, TrackReplay } from './sources.ts';

export const recorder = new DriveRecorder();

export function initDriveControls() {
  const video = $<HTMLVideoElement>('video');

  $('rec').onclick = async () => {
    const btn = $('rec');
    if (recorder.recording) {
      const { points } = await recorder.stop();
      btn.classList.remove('on');
      toast(`Recorrido guardado (${points} puntos GPS). Revisa tus descargas.`);
    } else if (app.stream) {
      recorder.start(app.stream);
      btn.classList.add('on');
      toast('Grabando video + GPS…');
    }
  };

  $('simPause').onclick = () => {
    const source = app.source;
    if (source instanceof RouteSim) {
      source.paused = !source.paused;
      $('simPause').textContent = source.paused ? '▶' : '⏸';
    } else if (source instanceof TrackReplay) {
      if (video.paused) void video.play();
      else video.pause();
    }
  };
  $('simSpeed').addEventListener('input', () => {
    const v = +$<HTMLInputElement>('simSpeed').value;
    $('simSpeedVal').textContent = `${v} km/h`;
    if (app.source instanceof RouteSim) app.source.speedKmh = v;
  });
}
