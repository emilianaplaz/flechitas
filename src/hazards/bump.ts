// Detects potholes and speed bumps from the phone's accelerometer.
// Heuristic, tuned by reasoning rather than field data. Every plausible hit is reported with a best-guess type
// and saved unconfirmed (half weight). Clustering by place and weight sorts out wrong guesses, and the driver can
// confirm a hole with the button. Two shapes are plausible: a hard jolt, or at slow speed a gentle, longer
// lift-then-descend that looks like a speed bump. Everything else (road noise, footsteps, rough asphalt) is ignored.
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
const MIN_COUNTER = 2.5; // m/s²: a bump needs a real descent after the lift
const SHORT_MS = 250; // a pothole is over in less than this; a speed bump (front then rear axle) lasts longer
const MIN_SPEED = 4; // m/s (~14 km/h): hard jolts below this are footsteps or a phone being handled
const MIN_SLOW_SPEED = 2.5; // m/s: the soft speed-bump path needs at least this
const SLOW_SPEED = 7; // m/s (~25 km/h): above this a speed bump would jolt hard, so a soft lobe is just road
const SOFT_PEAK = 2.0; // m/s²: smallest lobe of the soft path
const SOFT_MIN_MS = 300; // lift plus descent of a bump crossed slowly
const SOFT_COUNTER = 1.2; // m/s²: the descent after the lift
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
    const maxMs = e.speed < SLOW_SPEED ? MAX_EVENT_SLOW_MS : MAX_EVENT_MS;
    if (tMs - e.lastLoud < QUIET_MS && tMs - e.t0 < maxMs) return null;

    this.open = null;
    const peak = Math.max(e.up, e.down);
    const dur = e.lastLoud - e.t0;
    if (tMs - this.lastEventT < REFRACTORY_MS) return null;
    let type: BumpEvent['type'];
    if (peak >= MIN_PEAK && e.speed >= MIN_SPEED) {
      // A pothole drops the phone first and then slams up, within a quarter second.
      // A speed bump lifts it first, comes back down, and lasts longer. A mixed shape gets the nearer guess.
      if (e.sign < 0 && dur < SHORT_MS && e.up >= MIN_PEAK && e.up > e.down) type = 'hueco';
      else if (e.sign > 0 && dur >= SHORT_MS && e.down >= MIN_COUNTER) type = 'policia';
      else type = dur < SHORT_MS ? 'hueco' : 'policia';
    } else if (e.speed >= MIN_SLOW_SPEED && e.speed < SLOW_SPEED && e.sign > 0 && dur >= SOFT_MIN_MS && e.down >= SOFT_COUNTER && peak >= SOFT_PEAK) {
      type = 'policia';
    } else return null;
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
