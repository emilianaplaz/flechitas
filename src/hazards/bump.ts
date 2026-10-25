// Detects potholes and speed bumps from the phone's accelerometer.
// Heuristic, tuned by reasoning rather than field data. Every plausible hit is reported with a best-guess type
// and saved unconfirmed (half weight). Clustering by place and weight sorts out wrong guesses, and the driver can
// confirm a hole with the button. The order of the movement decides the guess: a pothole drops the phone first,
// a speed bump lifts it first. Two shapes are plausible: a hard jolt, or at moderate speed a gentle, longer
// movement with a real counter-movement. Everything else (road noise, footsteps, rough asphalt) is ignored.
import type { HazardType } from './store.ts';

export interface BumpEvent {
  type: Extract<HazardType, 'hueco' | 'policia'>;
  peak: number; // m/s² of vertical acceleration
  durationMs: number;
  speed: number; // m/s when the jolt began
}

const START = 2.0; // m/s²: vertical movement that opens an event; the shape and peak tests below filter it
const QUIET = 1.5; // below this the event is over once it stays there for QUIET_MS
const QUIET_MS = 120;
const MAX_EVENT_MS = 600;
const MAX_EVENT_SLOW_MS = 1500; // a bump crossed slowly takes longer
const MIN_PEAK = 5.5; // m/s²: the hardest lobe must reach this, so mild movement is never reported
const MIN_COUNTER = 2.5; // m/s²: a hard hit needs a real movement back after the first lobe
const MIN_SPEED = 4; // m/s (~14 km/h): hard jolts below this are footsteps or a phone being handled
const MIN_SLOW_SPEED = 2.5; // m/s: the soft path needs at least this
const SOFT_MAX_SPEED = 12; // m/s (~43 km/h): faster than this a bump or hole jolts hard, so a soft movement is just road
const SOFT_PEAK = 2.0; // m/s²: smallest lobe of the soft path, for bumps and holes alike
const SOFT_MIN_MS = 250; // both lobes of a bump or hole crossed slowly; shorter soft jolts are rough asphalt
const SOFT_COUNTER = 1.2; // m/s²: the movement back after the first lobe
const REFRACTORY_MS = 3000;
const GRAVITY_TAU_MS = 1000;

/** Feed samples in time order. Returns an event on the sample that ends it. */
export class BumpDetector {
  private g: [number, number, number] | null = null;
  private lastT = 0;
  private open: { t0: number; sign: 1 | -1; up: number; down: number; lastLoud: number; speed: number } | null = null;
  private lastEventT = -Infinity;

  feed(tMs: number, ax: number, ay: number, az: number, speed: number): BumpEvent | null {
    if (!this.g) {
      this.g = [ax, ay, az];
      this.lastT = tMs;
      return null;
    }
    const k = Math.min(1, (tMs - this.lastT) / (GRAVITY_TAU_MS + (tMs - this.lastT)));
    this.lastT = tMs;
    const g = this.g;
    for (let i = 0; i < 3; i++) g[i] += ([ax, ay, az][i] - g[i]) * k;

    // The measured gravity vector points the same way as the sign convention of the phone (Android up, iOS down),
    // so projecting the remainder on it gives "up is positive" on both.
    const n = Math.hypot(g[0], g[1], g[2]) || 1;
    const v = ((ax - g[0]) * g[0] + (ay - g[1]) * g[1] + (az - g[2]) * g[2]) / n;
    const mag = Math.abs(v);

    if (!this.open) {
      if (mag >= START) this.open = { t0: tMs, sign: v > 0 ? 1 : -1, up: Math.max(v, 0), down: Math.max(-v, 0), lastLoud: tMs, speed };
      return null;
    }
    const e = this.open;
    e.up = Math.max(e.up, v);
    e.down = Math.max(e.down, -v);
    if (mag >= QUIET) e.lastLoud = tMs;
    const maxMs = e.speed < SOFT_MAX_SPEED ? MAX_EVENT_SLOW_MS : MAX_EVENT_MS;
    if (tMs - e.lastLoud < QUIET_MS && tMs - e.t0 < maxMs) return null;

    this.open = null;
    const peak = Math.max(e.up, e.down);
    const dur = e.lastLoud - e.t0;
    if (tMs - this.lastEventT < REFRACTORY_MS) return null;
    // The lobe after the first one: a real bump or hole has both, a single jolt (kerb, phone knocked) does not.
    const counter = e.sign > 0 ? e.down : e.up;
    const hard = peak >= MIN_PEAK && e.speed >= MIN_SPEED && counter >= MIN_COUNTER;
    const soft = e.speed >= MIN_SLOW_SPEED && e.speed < SOFT_MAX_SPEED && dur >= SOFT_MIN_MS && peak >= SOFT_PEAK && counter >= SOFT_COUNTER;
    if (!hard && !soft) return null;
    const type: BumpEvent['type'] = e.sign < 0 ? 'hueco' : 'policia';
    this.lastEventT = tMs;
    return { type, peak, durationMs: dur, speed: e.speed };
  }
}

/** Wires BumpDetector to the browser's devicemotion events. */
export class BumpWatcher {
  private detector = new BumpDetector();
  private speed: () => number;
  private onEvent: (e: BumpEvent) => void;
  constructor(speed: () => number, onEvent: (e: BumpEvent) => void) {
    this.speed = speed;
    this.onEvent = onEvent;
  }

  /** Must run inside a user gesture: iOS shows its motion permission prompt here. */
  async start(): Promise<void> {
    const DME = DeviceMotionEvent as unknown as { requestPermission?: () => Promise<string> };
    if (DME.requestPermission && (await DME.requestPermission()) !== 'granted') {
      throw new Error('Permiso de movimiento denegado. Actívalo en Ajustes > Safari o desmarca "Detectar huecos".');
    }
    window.addEventListener('devicemotion', this.onMotion);
  }

  stop() {
    window.removeEventListener('devicemotion', this.onMotion);
    this.detector = new BumpDetector();
  }

  private onMotion = (e: DeviceMotionEvent) => {
    const a = e.accelerationIncludingGravity;
    if (a?.x == null || a.y == null || a.z == null) return;
    const hit = this.detector.feed(performance.now(), a.x, a.y, a.z, this.speed());
    if (hit) this.onEvent(hit);
  };
}
