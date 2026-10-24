// Where reported hazards sit relative to the active route. Navigation calls these;
// the hazard module never touches the frame loop.
import { angleDiff, bearingAt, project, type LatLon } from '../core/geo.ts';
import type { Route } from '../core/route.ts';
import type { Hazard, HazardType } from './store.ts';

export interface HazardView {
  p: LatLon;
  type: HazardType;
  along: number; // distance along the route
}

export interface RouteHazard {
  h: Hazard;
  along: number;
}

/** Precompute where each hazard sits along the route, so per-frame work is cheap. */
export function indexOnRoute(all: Hazard[], route: Route | null): RouteHazard[] {
  const out: RouteHazard[] = [];
  if (!route) return out;
  for (const h of all) {
    const pr = project(route.poly, h);
    if (pr.dist >= 20) continue;
    // A bump reported while driving the other way sits on the opposite carriageway.
    if (h.heading != null && Math.abs(angleDiff(h.heading, bearingAt(route.poly, pr.along, 10))) > 100) continue;
    out.push({ h, along: pr.along });
  }
  return out.sort((a, b) => a.along - b.along);
}

/** Hazards worth drawing from `along`, plus the closest one close enough for a banner. */
export function hazardsAhead(list: RouteHazard[], along: number): { ahead: HazardView[]; nearest: { type: HazardType; dist: number } | null } {
  const ahead: HazardView[] = [];
  let nearest: { type: HazardType; dist: number } | null = null;
  for (const { h, along: ha } of list) {
    const d = ha - along;
    if (d < -8 || d > 220) continue;
    ahead.push({ p: h, type: h.type, along: ha });
    if (d > 0 && d < 150 && (!nearest || d < nearest.dist)) nearest = { type: h.type, dist: d };
  }
  return { ahead, nearest };
}
