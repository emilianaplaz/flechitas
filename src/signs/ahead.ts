// Where the maqueta's road signs sit relative to the active route. Same idea as hazards/ahead.ts:
// project once per route, then a cheap window per frame.
import { angleDiff, bearingAt, project, type LatLon, type Polyline } from '../core/geo.ts';
import type { SignType, TileSign } from '../core/maqueta.ts';

const MAX_OFF_ROUTE = 15; // m: farther than this the sign belongs to another street
const MAX_DIR_OFF = 100; // degrees: a sign for traffic going the other way isn't ours

/** Speed bumps are drawn as hazards (the hazards module owns them), not as signs. */
export const BUMP_TYPES = new Set<SignType>(['bump', 'hump', 'table']);

export interface SignView {
  p: LatLon;
  type: SignType;
  along: number; // distance along the route
  bearing: number; // route direction at the sign, degrees: the sign faces drivers coming this way
}

export interface RouteSign {
  s: TileSign;
  along: number;
  bearing: number;
}

/** Signs on this route that apply to our direction of travel, ordered along it. */
export function indexSigns(all: TileSign[], poly: Polyline | null): RouteSign[] {
  const out: RouteSign[] = [];
  if (!poly) return out;
  for (const s of all) {
    if (BUMP_TYPES.has(s.type)) continue;
    const pr = project(poly, s);
    if (pr.dist > MAX_OFF_ROUTE) continue;
    const routeBearing = bearingAt(poly, pr.along, 10);
    if (s.dir != null && Math.abs(angleDiff(s.dir, routeBearing)) > MAX_DIR_OFF) continue;
    out.push({ s, along: pr.along, bearing: routeBearing });
  }
  return out.sort((a, b) => a.along - b.along);
}

/** Signs worth drawing from `along`. */
export function signsAhead(list: RouteSign[], along: number): SignView[] {
  const ahead: SignView[] = [];
  for (const { s, along: sa, bearing } of list) {
    const d = sa - along;
    if (d < -8 || d > 180) continue;
    ahead.push({ p: s, type: s.type, along: sa, bearing });
  }
  return ahead;
}
