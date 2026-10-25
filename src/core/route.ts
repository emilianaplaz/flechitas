// Routing via the public OSRM server (OpenStreetMap data, covers Venezuela).
// For production, self-host OSRM or switch to Mapbox/GraphHopper — the demo server is rate-limited.
import { buildPolyline, project, type LatLon, type Polyline } from './geo.ts';

export type TurnKind =
  | 'straight'
  | 'slight-left'
  | 'left'
  | 'sharp-left'
  | 'slight-right'
  | 'right'
  | 'sharp-right'
  | 'uturn'
  | 'arrive';

export interface Step {
  kind: TurnKind;
  text: string; // Spanish instruction
  street: string;
  location: LatLon;
  along: number; // distance along the route where the maneuver happens
}

export interface Route {
  poly: Polyline;
  steps: Step[];
  duration: number; // seconds
}

interface OsrmStep {
  name: string;
  maneuver: { type: string; modifier?: string; location: [number, number]; exit?: number };
}

const MOD_TO_KIND: Record<string, TurnKind> = {
  'straight': 'straight',
  'slight left': 'slight-left',
  'left': 'left',
  'sharp left': 'sharp-left',
  'slight right': 'slight-right',
  'right': 'right',
  'sharp right': 'sharp-right',
  'uturn': 'uturn',
};

const KIND_TEXT: Record<TurnKind, string> = {
  'straight': 'Sigue derecho',
  'slight-left': 'Mantente a la izquierda',
  'left': 'Gira a la izquierda',
  'sharp-left': 'Gira fuerte a la izquierda',
  'slight-right': 'Mantente a la derecha',
  'right': 'Gira a la derecha',
  'sharp-right': 'Gira fuerte a la derecha',
  'uturn': 'Da la vuelta en U',
  'arrive': 'Llegaste a tu destino',
};

export function describe(type: string, modifier: string | undefined, exit?: number): { kind: TurnKind; text: string } {
  if (type === 'arrive') return { kind: 'arrive', text: KIND_TEXT.arrive };
  const kind = MOD_TO_KIND[modifier ?? 'straight'] ?? 'straight';
  if (type === 'roundabout' || type === 'rotary' || type === 'exit roundabout' || type === 'exit rotary') {
    return { kind, text: exit ? `En la redoma, toma la ${exit}.ª salida` : 'Sal de la redoma' };
  }
  if (type === 'merge') return { kind, text: 'Incorpórate' };
  if (type === 'on ramp') return { kind, text: 'Toma la rampa' };
  if (type === 'off ramp') return { kind, text: 'Toma la salida' };
  if (type === 'fork') return { kind, text: kind.includes('left') ? 'En la bifurcación, ve a la izquierda' : 'En la bifurcación, ve a la derecha' };
  return { kind, text: KIND_TEXT[kind] };
}

/** The fastest route first, then the alternatives OSRM finds (often none on short trips). */
export async function fetchRoutes(from: LatLon, to: LatLon): Promise<Route[]> {
  const url =
    `https://router.project-osrm.org/route/v1/driving/${from.lon},${from.lat};${to.lon},${to.lat}` +
    `?steps=true&geometries=geojson&overview=full&alternatives=true`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`El servidor de rutas respondió ${res.status}`);
  const data = await res.json();
  if (data.code !== 'Ok' || !data.routes?.length) throw new Error('No se encontró una ruta');
  return data.routes.map(toRoute);
}

export async function fetchRoute(from: LatLon, to: LatLon): Promise<Route> {
  return (await fetchRoutes(from, to))[0];
}

function toRoute(r: { geometry: { coordinates: [number, number][] }; legs: { steps: OsrmStep[] }[]; duration: number }): Route {
  const pts: LatLon[] = r.geometry.coordinates.map(([lon, lat]: [number, number]) => ({ lat, lon }));
  const poly = buildPolyline(pts);

  const osrmSteps: OsrmStep[] = r.legs.flatMap((l: { steps: OsrmStep[] }) => l.steps);
  const steps: Step[] = [];
  let hint = 0;
  for (const s of osrmSteps) {
    if (s.maneuver.type === 'depart') continue;
    // "continue straight" / "new name" steps aren't worth an arrow.
    if ((s.maneuver.type === 'new name' || s.maneuver.type === 'continue') && (s.maneuver.modifier ?? 'straight') === 'straight') continue;
    const location = { lat: s.maneuver.location[1], lon: s.maneuver.location[0] };
    const pr = project(poly, location, hint);
    hint = pr.seg;
    const { kind, text } = describe(s.maneuver.type, s.maneuver.modifier, s.maneuver.exit);
    steps.push({ kind, text, street: s.name, location, along: pr.along });
  }
  if (!steps.length || steps[steps.length - 1].kind !== 'arrive') {
    steps.push({ kind: 'arrive', text: KIND_TEXT.arrive, street: '', location: pts[pts.length - 1], along: poly.length });
  }
  return { poly, steps, duration: r.duration };
}

/** Route from a pre-recorded GPS track (for replay demos when OSRM is unreachable). */
export function routeFromTrack(pts: LatLon[]): Route {
  const poly = buildPolyline(pts);
  return {
    poly,
    steps: [{ kind: 'arrive', text: KIND_TEXT.arrive, street: '', location: pts[pts.length - 1], along: poly.length }],
    duration: 0,
  };
}

export function formatDistance(m: number): string {
  if (m >= 1000) return `${(m / 1000).toFixed(m >= 10000 ? 0 : 1)} km`;
  if (m >= 100) return `${Math.round(m / 10) * 10} m`;
  return `${Math.max(0, Math.round(m / 5) * 5)} m`;
}
