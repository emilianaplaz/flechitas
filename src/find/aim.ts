// Where a place on the ground shows up on the camera picture, from GPS positions and the phone's
// compass and tilt. Pure; tested in tests/run.ts. Small-angle pinhole model: roll is ignored, which
// is fine for a phone held upright.
import { angleDiff, bearing, haversine, toDeg, toRad, type LatLon } from '../core/geo.ts';
import { loadLensHfov, visibleVfov } from '../render/autocalib.ts';

export interface Lens {
  hfov: number; // degrees across the screen's width
  vfov: number; // degrees across the screen's height
}

export interface Screen {
  w: number;
  h: number;
}

/** What the camera sees on `screen` when the `videoW`×`videoH` stream is shown with object-fit: cover. */
export function lensOnScreen(videoW: number, videoH: number, screen: Screen, lensHfov = loadLensHfov()): Lens {
  const vfov = visibleVfov(lensHfov, videoW, videoH, screen.w, screen.h);
  const hfov = 2 * toDeg(Math.atan(Math.tan(toRad(vfov / 2)) * (screen.w / screen.h)));
  return { hfov, vfov };
}

export interface Aim {
  dist: number; // metres on the ground
  rel: number; // degrees right (+) or left (-) of where the camera points
  x: number; // px from the left edge; far off screen when the place is behind the camera
  y: number; // px from the top edge
  visible: boolean; // inside the picture
}

/** Eye height of someone holding the phone, and the metres a place sits below it. */
export const EYE_HEIGHT = 1.4;

/**
 * `drop` is how far the marked point sits below the camera: EYE_HEIGHT for a spot on the floor,
 * less for a person, whose chest is the thing to point at.
 */
export function aim(me: LatLon, target: LatLon, view: { yaw: number; pitch: number }, lens: Lens, screen: Screen, drop = EYE_HEIGHT): Aim {
  const dist = Math.max(1, haversine(me, target));
  const rel = angleDiff(view.yaw, bearing(me, target));
  const tanH = Math.tan(toRad(lens.hfov / 2));
  const tanV = Math.tan(toRad(lens.vfov / 2));
  const x = Math.abs(rel) < 90 ? screen.w / 2 + (screen.w / 2) * (Math.tan(toRad(rel)) / tanH) : Math.sign(rel) * screen.w * 10;
  const belowAxis = Math.atan(drop / dist) - toRad(view.pitch); // pitch is how far the camera looks down
  const y = screen.h / 2 + (screen.h / 2) * (Math.tan(belowAxis) / tanV);
  const visible = Math.abs(rel) < lens.hfov / 2 && y >= 0 && y <= screen.h;
  return { dist, rel, x, y, visible };
}

/** A marker that is off screen sits on the edge nearest to it and says which way to turn. */
export function onEdge(a: Aim, screen: Screen, margin: number): { x: number; y: number; turn: number } {
  return {
    x: Math.min(screen.w - margin, Math.max(margin, a.x)),
    y: Math.min(screen.h - margin, Math.max(margin, a.y)),
    turn: a.rel,
  };
}
