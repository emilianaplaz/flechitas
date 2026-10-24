// Keeping the remote camera picture upright and horizontal, whatever way the phone is held.
// The camera frames a phone delivers follow its *screen* orientation; with rotation lock on (or a
// phone lying sideways in a mount) that isn't where "up" is. The phone redraws every frame upright
// from gravity, always as a landscape picture, before sending it. Pure functions, tested.

/**
 * Which way the phone is physically turned, from gravity: 0 = upright portrait, 90 = turned
 * counter-clockwise (top to the left), 180 = upside down, 270 = turned clockwise. Degrees,
 * multiples of 90. Keeps `prev` when the phone lies nearly flat or sits between two positions,
 * so the picture doesn't flicker.
 */
export function physicalAngle(betaDeg: number, gammaDeg: number, prev: number): number {
  const b = (betaDeg * Math.PI) / 180;
  const g = (gammaDeg * Math.PI) / 180;
  // World "up" in the screen plane (device x right, y up), from the W3C Z-X'-Y'' angles.
  const ux = -Math.sin(g) * Math.cos(b);
  const uy = Math.sin(b);
  if (Math.hypot(ux, uy) < 0.5) return prev; // lying flat: no clear up
  const deg = ((Math.atan2(ux, uy) * 180) / Math.PI + 360) % 360;
  const snapped = (Math.round(deg / 90) * 90) % 360;
  const off = Math.abs(((deg - snapped + 540) % 360) - 180);
  return off <= 35 ? snapped : prev; // 35° either side of a position; in between, keep the last one
}

/** Screen orientation of this page, degrees 0/90/180/270 (iOS also has the older window.orientation). */
export function interfaceAngle(screenAngle: number | undefined, windowOrientation: number | undefined): number {
  const a = screenAngle ?? windowOrientation ?? 0;
  return ((Math.round(a / 90) * 90) % 360 + 360) % 360;
}

export interface UprightPlan {
  rot: number; // counter-clockwise degrees to turn the camera frame so it's upright
  scale: number; // frame pixels -> output pixels, cover-fitted
  hfov: number; // horizontal field of view of the output picture, degrees
}

/**
 * How to draw a `frameW`×`frameH` camera frame into an `outW`×`outH` landscape picture so it's
 * upright. `rot` = physical angle − screen angle (+ any manual correction). `lensHfov` is the
 * lens's field of view across the frame's long side.
 */
export function uprightPlan(frameW: number, frameH: number, rot: number, lensHfov: number, outW: number, outH: number): UprightPlan {
  const r = ((Math.round(rot / 90) * 90) % 360 + 360) % 360;
  const swap = r === 90 || r === 270;
  const upW = swap ? frameH : frameW; // the frame once upright
  const upH = swap ? frameW : frameH;
  const scale = Math.max(outW / upW, outH / upH); // cover: fill the output, crop the rest
  // Field of view across the upright picture's width, then across the part that survives the crop.
  const t = Math.tan((lensHfov * Math.PI) / 360);
  const tUp = upW >= upH ? t : (t * upW) / upH;
  const visibleW = outW / scale;
  const hfov = (2 * Math.atan((tUp * visibleW) / upW) * 180) / Math.PI;
  return { rot: r, scale, hfov };
}
