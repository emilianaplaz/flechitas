// Where the phone camera is pointing, from the device's orientation sensors.
// World frame: x = east, y = north, z = up (the W3C DeviceOrientation frame).
import { toDeg, toRad } from '../core/geo.ts';

export interface Pose {
  yaw: number; // compass heading of the camera, degrees clockwise from north
  pitch: number; // degrees the camera looks down (negative = up)
  roll: number; // degrees the horizon is tilted, positive = phone rolled clockwise
}

type V = [number, number, number];

const rotZ = ([x, y, z]: V, a: number): V => [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a), z];
const rotX = ([x, y, z]: V, b: number): V => [x, y * Math.cos(b) - z * Math.sin(b), y * Math.sin(b) + z * Math.cos(b)];
const rotY = ([x, y, z]: V, g: number): V => [x * Math.cos(g) + z * Math.sin(g), y, -x * Math.sin(g) + z * Math.cos(g)];

/** W3C intrinsic Z-X'-Y'' rotation applied to a device-frame vector. */
function toWorld(v: V, alpha: number, beta: number, gamma: number): V {
  return rotZ(rotX(rotY(v, gamma), beta), alpha);
}

// Device-frame direction of "up on the screen" for each screen.orientation.angle.
const SCREEN_UP: Record<number, V> = { 0: [0, 1, 0], 90: [1, 0, 0], 180: [0, -1, 0], 270: [-1, 0, 0] };

const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: V): V => {
  const n = Math.hypot(...a) || 1;
  return [a[0] / n, a[1] / n, a[2] / n];
};

/** alpha/beta/gamma in degrees as reported by DeviceOrientationEvent; the back camera looks along the device's -z. */
export function poseFromEuler(alphaDeg: number, betaDeg: number, gammaDeg: number, screenAngle: number): Pose {
  const a = toRad(alphaDeg);
  const b = toRad(betaDeg);
  const g = toRad(gammaDeg);
  const fwd = toWorld([0, 0, -1], a, b, g);
  const up = toWorld(SCREEN_UP[((screenAngle % 360) + 360) % 360] ?? SCREEN_UP[0], a, b, g);

  const yaw = (toDeg(Math.atan2(fwd[0], fwd[1])) + 360) % 360;
  const pitch = toDeg(-Math.asin(Math.max(-1, Math.min(1, fwd[2]))));

  // Roll: how far the screen's up axis is turned from the horizon-level up for this view direction.
  const level = unit([-fwd[0] * fwd[2], -fwd[1] * fwd[2], 1 - fwd[2] * fwd[2]]);
  const right = cross(fwd, level);
  const roll = toDeg(Math.atan2(dot(up, right), dot(up, level)));
  return { yaw, pitch, roll };
}

const STALE_MS = 1500;

interface IosEvent extends DeviceOrientationEvent {
  webkitCompassHeading?: number;
}

/** Streams the camera pose. `absolute` is false when the compass isn't available, so yaw is only relative. */
export class OrientationSensor {
  absolute = true;
  private last: { pose: Pose; t: number } | null = null;

  /** Must run inside a user gesture: iOS shows its permission prompt here. */
  async start(): Promise<void> {
    const DOE = DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> };
    if (DOE.requestPermission && (await DOE.requestPermission()) !== 'granted') {
      throw new Error('Permiso de sensores denegado. Actívalo en Ajustes > Safari o desmarca "Usar sensores".');
    }
    window.addEventListener('deviceorientationabsolute', this.onEvent as EventListener);
    window.addEventListener('deviceorientation', this.onEvent as EventListener);
  }

  stop() {
    window.removeEventListener('deviceorientationabsolute', this.onEvent as EventListener);
    window.removeEventListener('deviceorientation', this.onEvent as EventListener);
    this.last = null;
  }

  current(now: number): Pose | null {
    return this.last && now - this.last.t < STALE_MS ? this.last.pose : null;
  }

  private onEvent = (e: IosEvent) => {
    if (e.beta == null || e.gamma == null) return;
    let alpha = e.alpha;
    if (typeof e.webkitCompassHeading === 'number') {
      alpha = (360 - e.webkitCompassHeading) % 360; // iOS: alpha is relative, the compass heading is not
      this.absolute = true;
    } else if (e.type === 'deviceorientationabsolute' || e.absolute) {
      this.absolute = true;
    } else if (this.last === null) {
      this.absolute = false;
    }
    if (alpha == null) return;
    // Android fires both events; once the absolute one is flowing, ignore the relative one.
    if (e.type === 'deviceorientation' && this.absolute && !e.absolute && typeof e.webkitCompassHeading !== 'number') return;
    this.last = { pose: poseFromEuler(alpha, e.beta, e.gamma, screen.orientation?.angle ?? 0), t: performance.now() };
  };
}
