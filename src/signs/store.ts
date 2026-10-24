// Road signs from the maqueta tiles for the active route. Navigation calls these;
// the signs module never touches the frame loop.
import type { TileSign } from '../core/maqueta.ts';
import type { Polyline } from '../core/geo.ts';
import { indexSigns, signsAhead, type RouteSign } from './ahead.ts';

let all: TileSign[] = [];
let onRoute: RouteSign[] = [];

/** The signs of the tiles the route touches. Call when the route's maqueta has loaded. */
export function setSigns(signs: TileSign[], poly: Polyline | null) {
  all = signs;
  onRoute = indexSigns(all, poly);
}

export function clearSigns() {
  all = [];
  onRoute = [];
}

/** Signs to draw from `along`. */
export const signsAheadOf = (along: number) => signsAhead(onRoute, along);
