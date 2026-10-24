// Route following: turn a position fix into where we are along the route, which way we face,
// the next maneuver and when to reroute. No phone sensors involved.
import { angleDiff, bearingAt, offset, pointAt, project, type LatLon } from '../core/geo.ts';
import { fetchRoute, type Route, type Step } from '../core/route.ts';
import { app } from '../core/state.ts';
import { toast } from '../core/ui.ts';
import type { Fix } from '../core/types.ts';

let along = 0;
let alongInit = false;
let projHint: number | undefined;
let offRouteSince: number | null = null;
let rerouting = false;
let lastReroute = 0;

/** Forget progress along the old route. */
export function resetProgress() {
  alongInit = false;
  projHint = undefined;
}

export interface NavFrame {
  origin: LatLon; // point on the ground directly under the camera
  yaw: number;
  along: number;
  next: Step | null;
  distToNext: number;
  remaining: number;
  speed: number; // m/s
  onRoute: boolean;
}

/** Advance one frame. Updates `app.yaw`. `lateral` shifts the camera sideways, in metres. */
export function advance(fix: Fix, route: Route, now: number, dt: number, lateral: number, setRoute: (r: Route) => void): NavFrame {
  const poly = route.poly;
  const pr = project(poly, fix.p, projHint);
  projHint = pr.seg;
  const speed = fix.speed ?? 0;

  // Smooth position along the route: predict between 1 Hz GPS fixes, then ease toward the measurement.
  const predicted = pr.along + (speed * Math.min(2000, now - fix.t)) / 1000;
  if (!alongInit || Math.abs(predicted - along) > 30) {
    along = predicted;
    alongInit = true;
  } else {
    along += speed * dt;
    along += (predicted - along) * Math.min(1, dt * 3);
  }
  along = Math.min(Math.max(0, along), poly.length);

  // Snap to the route when we're on it: steadier than raw GPS, and the guide lines up with the road.
  const onRoute = pr.dist < 25;
  let ground: LatLon;
  let targetYaw: number;
  if (onRoute) {
    ground = pointAt(poly, along).p;
    targetYaw = bearingAt(poly, along, 15);
    offRouteSince = null;
  } else {
    ground = fix.p;
    targetYaw = fix.heading ?? app.yaw;
    offRouteSince ??= now;
    if (now - offRouteSince > 5000 && pr.dist > 45) void maybeReroute(fix, now, setRoute);
  }
  app.yaw = (app.yaw + angleDiff(app.yaw, targetYaw) * Math.min(1, dt * 4) + 360) % 360;

  const next = route.steps.find((s) => s.along > along + 3) ?? null;
  return {
    origin: offset(ground, app.yaw + 90, lateral),
    yaw: app.yaw,
    along,
    next,
    distToNext: next ? next.along - along : Infinity,
    remaining: poly.length - along,
    speed,
    onRoute,
  };
}

async function maybeReroute(fix: Fix, now: number, setRoute: (r: Route) => void) {
  if (app.mode !== 'gps' || !app.dest || rerouting || now - lastReroute < 10000) return;
  rerouting = true;
  lastReroute = now;
  toast('Recalculando ruta…');
  try {
    setRoute(await fetchRoute(fix.p, app.dest.point));
  } catch (e) {
    toast((e as Error).message);
  } finally {
    rerouting = false;
    offRouteSince = null;
  }
}
