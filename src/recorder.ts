// Records the camera feed together with a GPS track that shares the same clock,
// so the drive can be replayed later (Replay mode) with the overlay running live.
import type { Fix } from './sources.ts';
import type { Track } from './sources.ts';

function pickMime(): string {
  for (const m of ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)) return m;
  }
  return '';
}

export function download(blob: Blob, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

export class DriveRecorder {
  private rec: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private t0 = 0;
  private track: Track = { version: 1, points: [] };
  get recording() {
    return this.rec?.state === 'recording';
  }

  start(stream: MediaStream) {
    const mimeType = pickMime();
    this.chunks = [];
    this.track = { version: 1, startedAt: new Date().toISOString(), points: [] };
    this.rec = new MediaRecorder(stream, mimeType ? { mimeType, videoBitsPerSecond: 6_000_000 } : undefined);
    this.rec.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    this.rec.start(1000);
    this.t0 = performance.now();
  }

  /** Call for every raw GPS fix while recording. */
  addFix(f: Fix) {
    if (!this.recording) return;
    this.track.points.push({
      t: +((f.t - this.t0) / 1000).toFixed(3),
      lat: f.p.lat,
      lon: f.p.lon,
      speed: f.speed,
      heading: f.heading,
      acc: f.accuracy,
    });
  }

  async stop(): Promise<{ points: number }> {
    const rec = this.rec;
    if (!rec) return { points: 0 };
    await new Promise<void>((resolve) => {
      rec.onstop = () => resolve();
      rec.stop();
    });
    const type = rec.mimeType || 'video/webm';
    const ext = type.includes('mp4') ? 'mp4' : 'webm';
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    download(new Blob(this.chunks, { type }), `recorrido-${stamp}.${ext}`);
    download(new Blob([JSON.stringify(this.track)], { type: 'application/json' }), `recorrido-${stamp}.json`);
    this.rec = null;
    return { points: this.track.points.length };
  }
}
