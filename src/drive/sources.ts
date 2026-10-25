// Where the car's position comes from: real GPS, a simulated drive along the route,
// a recorded track replayed in sync with a recorded dashcam video, or a video alone driven along the route.
import { bearing, bearingAt, haversine, pointAt, type Polyline } from '../core/geo.ts';
import type { Fix, Source } from '../core/types.ts';

export class GpsSource implements Source {
  readonly name = 'gps' as const;
  private watchId: number | null = null;
  private last: Fix | null = null;
  private onFix: (f: Fix) => void;
  private onError: (msg: string) => void;
  constructor(onFix: (f: Fix) => void = () => {}, onError: (msg: string) => void = () => {}) {
    this.onFix = onFix;
    this.onError = onError;
  }
  start() {
    if (!('geolocation' in navigator)) {
      this.onError('Este navegador no tiene GPS');
      return;
    }
    this.watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const c = pos.coords;
        this.last = {
          p: { lat: c.latitude, lon: c.longitude },
          speed: c.speed ?? null,
          heading: c.heading != null && !Number.isNaN(c.heading) ? c.heading : null,
          accuracy: c.accuracy ?? null,
          t: performance.now(),
        };
        this.onFix(this.last);
      },
      (err) => this.onError(`GPS: ${err.message}`),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 },
    );
  }
  stop() {
    if (this.watchId !== null) navigator.geolocation.clearWatch(this.watchId);
    this.watchId = null;
  }
  current(): Fix | null {
    return this.last;
  }
}

/**
 * GPS fixes sent by another phone (the one used as a remote camera, see src/remote/).
 * Fixes are pushed as they arrive and re-stamped with this device's clock.
 */
export class RemoteGpsSource implements Source {
  readonly name = 'gps' as const;
  onFix: (f: Fix) => void = () => {};
  private last: Fix | null = null;
  push(f: Fix) {
    this.last = f;
    this.onFix(f);
  }
  start() {}
  stop() {
    this.onFix = () => {};
  }
  current(): Fix | null {
    return this.last;
  }
}

/** Drives along the route at a set speed. Used for indoor development and stage demos. */
export class RouteSim implements Source {
  readonly name = 'sim' as const;
  along = 0;
  speedKmh = 35;
  paused = false;
  private lastNow: number | null = null;
  private poly: Polyline;
  constructor(poly: Polyline) {
    this.poly = poly;
  }
  start() {
    this.lastNow = null;
  }
  stop() {}
  current(now: number): Fix {
    if (this.lastNow !== null && !this.paused) {
      this.along = Math.min(this.poly.length, this.along + ((this.speedKmh / 3.6) * (now - this.lastNow)) / 1000);
    }
    this.lastNow = now;
    const speed = this.paused || this.along >= this.poly.length ? 0 : this.speedKmh / 3.6;
    return { p: pointAt(this.poly, this.along).p, speed, heading: bearingAt(this.poly, this.along), accuracy: 3, t: now };
  }
}

/** The part of an HTMLVideoElement a position source reads. */
export interface VideoClock {
  currentTime: number;
  paused: boolean;
}

/**
 * Replays a video with no GPS track: the car follows the planned route, advancing with the video
 * clock. Integrating clock deltas (not time * speed) keeps pause, seeks and speed changes honest.
 */
export class VideoRouteSource implements Source {
  readonly name = 'replay' as const;
  along = 0;
  speedKmh = 35;
  private lastTime: number | null = null;
  private poly: Polyline;
  private video: VideoClock;
  /** seconds added to video time (fix sync drift) */
  syncOffset: number;
  constructor(poly: Polyline, video: VideoClock, syncOffset = 0) {
    this.poly = poly;
    this.video = video;
    this.syncOffset = syncOffset;
  }
  start() {
    this.lastTime = null;
  }
  stop() {}
  current(now: number): Fix {
    const t = this.video.currentTime + this.syncOffset;
    if (this.lastTime !== null) {
      this.along = Math.min(this.poly.length, Math.max(0, this.along + (this.speedKmh / 3.6) * (t - this.lastTime)));
    }
    this.lastTime = t;
    const moving = !this.video.paused && this.along < this.poly.length;
    return {
      p: pointAt(this.poly, this.along).p,
      speed: moving ? this.speedKmh / 3.6 : 0,
      heading: bearingAt(this.poly, this.along),
      accuracy: 3,
      t: now,
    };
  }
}

export interface TrackPoint {
  t: number; // seconds since recording start
  lat: number;
  lon: number;
  speed?: number | null;
  heading?: number | null;
  acc?: number | null;
}

export interface Track {
  version: 1;
  startedAt?: string;
  points: TrackPoint[];
}

/** Replays a recorded GPS track, synced to video.currentTime. */
export class TrackReplay implements Source {
  readonly name = 'replay' as const;
  private track: Track;
  private video: HTMLVideoElement;
  /** seconds to add to video time to get track time (fix sync drift) */
  syncOffset: number;
  constructor(track: Track, video: HTMLVideoElement, syncOffset = 0) {
    this.track = track;
    this.video = video;
    this.syncOffset = syncOffset;
  }
  start() {}
  stop() {}
  current(now: number): Fix | null {
    const pts = this.track.points;
    if (!pts.length) return null;
    const t = this.video.currentTime + this.syncOffset;
    let i = 0;
    let j = pts.length - 1;
    if (t <= pts[0].t) j = 0;
    else if (t >= pts[j].t) i = j;
    else {
      while (j - i > 1) {
        const m = (i + j) >> 1;
        if (pts[m].t <= t) i = m;
        else j = m;
      }
    }
    const a = pts[i];
    const b = pts[j];
    const span = b.t - a.t;
    const k = span > 0 ? (t - a.t) / span : 0;
    const p = { lat: a.lat + (b.lat - a.lat) * k, lon: a.lon + (b.lon - a.lon) * k };
    const pa = { lat: a.lat, lon: a.lon };
    const pb = { lat: b.lat, lon: b.lon };
    const moved = haversine(pa, pb);
    const speed = span > 0 ? moved / span : (a.speed ?? 0);
    const heading = moved > 1 ? bearing(pa, pb) : (a.heading ?? null);
    return { p, speed, heading, accuracy: a.acc ?? null, t: now };
  }
}

export function parseTrack(json: unknown): Track {
  const obj = json as Partial<Track> | TrackPoint[];
  const points = Array.isArray(obj) ? obj : obj.points;
  if (!Array.isArray(points) || !points.length) throw new Error('El archivo de recorrido no tiene puntos');
  for (const p of points) {
    if (typeof p.t !== 'number' || typeof p.lat !== 'number' || typeof p.lon !== 'number') {
      throw new Error('Formato de recorrido inválido: cada punto necesita t, lat y lon');
    }
  }
  return { version: 1, points: [...points].sort((a, b) => a.t - b.t) };
}
