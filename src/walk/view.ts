// Phone sensors decide where the camera looks. Travel direction (yaw) still places the
// user on the route; this only supplies the smoothed view direction and tilt.
import { angleDiff } from '../core/geo.ts';
import { toast } from '../core/ui.ts';
import { OrientationSensor } from './orientation.ts';

export interface View {
  yaw: number;
  pitch: number;
  roll: number;
}

let sensor: OrientationSensor | null = null;
let sensorStart = 0;
let sensorWarned = false;
let bias = 0; // degrees added to the compass so the view lines up with the street ("Alinear")
let view: View | null = null;

export const sensorsActive = () => sensor !== null;

/** Call inside the tap handler: iOS only shows the sensor permission prompt there. */
export async function startSensors() {
  sensor = new OrientationSensor();
  await sensor.start();
  sensorStart = performance.now();
  sensorWarned = false;
  bias = 0;
  view = null;
}

export function stopSensors() {
  sensor?.stop();
  sensor = null;
  view = null;
}

/** Make the camera yaw match `streetYaw` from now on. Returns false if there's no reading yet. */
export function align(streetYaw: number, now: number): boolean {
  const raw = sensor?.current(now);
  if (!raw) return false;
  bias = angleDiff(raw.yaw, streetYaw);
  view = null;
  return true;
}

/** The smoothed sensor view, or null to fall back to the route bearing. */
export function updateView(now: number, dt: number): View | null {
  const raw = sensor?.current(now) ?? null;
  if (raw) {
    const target = { yaw: (raw.yaw + bias + 360) % 360, pitch: raw.pitch, roll: raw.roll };
    if (!view) view = target;
    else {
      const k = Math.min(1, dt * 10);
      view = {
        yaw: (view.yaw + angleDiff(view.yaw, target.yaw) * k + 360) % 360,
        pitch: view.pitch + (target.pitch - view.pitch) * k,
        roll: view.roll + angleDiff(view.roll, target.roll) * k,
      };
    }
  } else if (sensor && !sensorWarned && now - sensorStart > 3000) {
    sensorWarned = true;
    toast('Sin lectura de sensores: uso la dirección de la ruta');
  }
  if (raw && !sensorWarned && !sensor!.absolute) {
    sensorWarned = true;
    toast('Sin brújula: toca ⌖ para alinear con la calle');
  }
  return raw && view ? view : null;
}
