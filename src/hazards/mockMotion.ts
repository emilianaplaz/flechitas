// Stands in for the phone's accelerometer in Simulación and Repetición, where the real one says nothing about the
// road. Obstacles sit at fixed places along the route. As the car passes one, synthetic samples go through the real
// BumpDetector, so thresholds, speed limits and the hueco/policía guess behave exactly as on a real drive.
import { bearingAt, pointAt, project, type LatLon, type Polyline } from '../core/geo.ts';
import { BumpDetector, type BumpEvent } from './bump.ts';

export interface MockObstacle extends LatLon {
  kind: BumpEvent['type'];
  heading: number;
  along: number;
  index: number;
}

const SPACING_M = 300;
const FIRST_M = 150;
const PATTERN: BumpEvent['type'][] = ['policia', 'hueco', 'policia'];

/** Deterministic: the same route always gets the same obstacles. */
export function mockObstacles(poly: Polyline): MockObstacle[] {
  const out: MockObstacle[] = [];
  if (poly.pts.length < 2) return out;
  for (let along = FIRST_M, i = 0; along < poly.length; along += SPACING_M, i++) {
    out.push({ ...pointAt(poly, along).p, kind: PATTERN[i % PATTERN.length], heading: bearingAt(poly, along), along, index: i });
  }
  return out;
}

const HZ = 60;
const REF_SPEED = 10; // m/s: the shapes below are the detector tests' hard-hit shapes at this speed
const LEAD_MS = 200;
const TAIL_MS = 400; // quiet after the hit so the detector can close the event

// [duration ms, vertical m/s²] lobes at REF_SPEED. A hole drops then hits hard; a bump lifts, descends, lifts again.
const SHAPE: Record<BumpEvent['type'], [number, number][]> = {
  hueco: [[60, -4], [60, 8]],
  policia: [[150, 4], [150, -4], [80, 6]],
};

/** Vertical acceleration (up positive, gravity removed) at 60 Hz. Slow passes are longer and gentler, fast ones shorter and harder. */
export function obstacleProfile(kind: BumpEvent['type'], speed: number, jitter = 0): number[] {
  const rel = speed / REF_SPEED;
  const stretch = Math.min(2.5, Math.max(0.6, 1 / rel));
  const gain = Math.min(1.6, Math.max(0.6, Math.sqrt(rel))) * (1 + jitter);
  const out: number[] = new Array(Math.round((LEAD_MS * HZ) / 1000)).fill(0);
  for (const [ms, amp] of SHAPE[kind]) {
    const n = Math.round((ms * stretch * HZ) / 1000);
    for (let i = 0; i < n; i++) out.push(amp * gain);
  }
  for (let i = 0; i < (TAIL_MS * HZ) / 1000; i++) out.push(0);
  return out;
}

/** What the detector makes of crossing the obstacle at `speed`, or null when it ignores it (too slow, too gentle). */
export function simulateHit(kind: BumpEvent['type'], speed: number, jitter = 0): BumpEvent | null {
  const d = new BumpDetector();
  const profile = obstacleProfile(kind, speed, jitter);
  for (let i = 0; i < profile.length; i++) {
    const e = d.feed((i * 1000) / HZ, 0, 0, 9.81 + profile[i], speed);
    if (e) return e;
  }
  return null;
}

/** Fires `onEvent` once per obstacle as the car passes it. Feed it every position with `update`. */
export class MockMotion {
  private poly: Polyline | null = null;
  private obstacles: MockObstacle[] = [];
  private next = 0;
  private hint = 0;
  private timers = new Set<number>();
  private onEvent: (e: BumpEvent) => void;
  constructor(onEvent: (e: BumpEvent) => void) {
    this.onEvent = onEvent;
  }

  update(poly: Polyline, p: LatLon, speed: number) {
    if (poly !== this.poly) {
      this.poly = poly;
      this.obstacles = mockObstacles(poly);
      this.next = 0;
      this.hint = 0;
    }
    const pr = project(poly, p, this.hint);
    this.hint = pr.seg;
    let passed: MockObstacle | null = null;
    while (this.next < this.obstacles.length && this.obstacles[this.next].along <= pr.along) passed = this.obstacles[this.next++];
    // A jump (the replay seeking, a reroute) skips obstacles instead of firing them all at once.
    if (!passed || pr.along - passed.along > 40) return;
    const jitter = ((passed.index * 7) % 5 - 2) * 0.03;
    const hit = simulateHit(passed.kind, speed, jitter);
    if (!hit) return;
    const id = window.setTimeout(() => {
      this.timers.delete(id);
      this.onEvent(hit);
    }, hit.durationMs / 2 + 120);
    this.timers.add(id);
  }

  stop() {
    for (const id of this.timers) clearTimeout(id);
    this.timers.clear();
    this.poly = null;
    this.obstacles = [];
  }
}
