// Automatic calibration from what the phone can measure: tilt and roll of the mount from gravity,
// and the on-screen field of view from the lens and how the video is cropped to the screen.
// It runs on its own and writes into the same calibration the sliders show; once a value is
// moved by hand, the hand-set value wins until "Restablecer".
// Pure logic here (tested in tests/run.ts); the sensor wiring lives in calibDock.ts.

/** Typical phone main camera, horizontal FOV of a 16:9 video stream (long side). Override with a measured value. */
export const DEFAULT_LENS_HFOV = 63;

/**
 * Vertical FOV of what's visible on screen when a video of `videoW`×`videoH` from a lens with
 * `lensHfov` degrees across its long side is shown with `object-fit: cover` in `screenW`×`screenH`.
 */
export function visibleVfov(lensHfov: number, videoW: number, videoH: number, screenW: number, screenH: number): number {
  const f = Math.max(videoW, videoH) / 2 / Math.tan((lensHfov * Math.PI) / 360); // focal length in video pixels
  const cover = Math.max(screenW / videoW, screenH / videoH); // screen px per video px
  const visibleH = screenH / cover; // video rows that fit on screen
  return (2 * Math.atan(visibleH / 2 / f) * 180) / Math.PI;
}

export interface Tilt {
  pitch: number; // degrees the camera looks down
  roll: number; // degrees, positive = phone rolled clockwise
}

/** Average of the samples, or null when there are too few or the phone moved (std dev above `maxStd`). */
export function steadyMean(samples: Tilt[], maxStd = 0.8, minSamples = 20): Tilt | null {
  if (samples.length < minSamples) return null;
  const mean = (k: keyof Tilt) => samples.reduce((s, x) => s + x[k], 0) / samples.length;
  const std = (k: keyof Tilt, m: number) => Math.sqrt(samples.reduce((s, x) => s + (x[k] - m) ** 2, 0) / samples.length);
  const pitch = mean('pitch');
  const roll = mean('roll');
  if (std('pitch', pitch) > maxStd || std('roll', roll) > maxStd) return null;
  return { pitch, roll };
}

/**
 * Collects tilt readings and says when the last `windowMs` were steady enough to trust as the
 * mount's tilt. Readings taken while the car moves are discarded: braking and accelerating tilt
 * the apparent gravity by several degrees.
 */
export class TiltWindow {
  private samples: { t: number; tilt: Tilt; moving: boolean }[] = [];
  private windowMs: number;
  private maxStd: number;
  constructor(windowMs = 2500, maxStd = 0.8) {
    this.windowMs = windowMs;
    this.maxStd = maxStd;
  }

  push(t: number, tilt: Tilt, moving: boolean) {
    this.samples.push({ t, tilt, moving });
    while (this.samples.length && t - this.samples[0].t > this.windowMs) this.samples.shift();
  }

  /** The steady tilt over the whole window, or null (too short, car moving, or phone moving). */
  steady(): Tilt | null {
    const s = this.samples;
    if (!s.length || s[s.length - 1].t - s[0].t < this.windowMs * 0.8) return null;
    if (s.some((x) => x.moving)) return null;
    return steadyMean(s.map((x) => x.tilt), this.maxStd);
  }

  clear() {
    this.samples = [];
  }
}

// ---- which values were set by hand (those are never overwritten) ----
export type AutoKey = 'pitch' | 'fov';
const manualKey = (layout: string) => `ar-nav.manual.${layout}`;

export function loadManual(layout: string): Partial<Record<AutoKey, true>> {
  try {
    return (JSON.parse(localStorage.getItem(manualKey(layout)) ?? '{}') as Partial<Record<AutoKey, true>>) ?? {};
  } catch {
    return {};
  }
}

export function saveManual(layout: string, manual: Partial<Record<AutoKey, true>>) {
  try {
    localStorage.setItem(manualKey(layout), JSON.stringify(manual));
  } catch {
    /* ignore */
  }
}

// ---- stored values that have no slider ----
const LENS_KEY = 'ar-nav.lens';
const rollKey = (layout: string) => `ar-nav.mount.${layout}`;

export function loadLensHfov(): number {
  try {
    const v = JSON.parse(localStorage.getItem(LENS_KEY) ?? 'null')?.hfov;
    return typeof v === 'number' && v > 20 && v < 130 ? v : DEFAULT_LENS_HFOV;
  } catch {
    return DEFAULT_LENS_HFOV;
  }
}

export function loadMountRoll(layout: string): number {
  try {
    const v = JSON.parse(localStorage.getItem(rollKey(layout)) ?? 'null')?.roll;
    return typeof v === 'number' ? v : 0;
  } catch {
    return 0;
  }
}

export function saveMountRoll(layout: string, roll: number) {
  try {
    localStorage.setItem(rollKey(layout), JSON.stringify({ roll }));
  } catch {
    /* ignore */
  }
}
