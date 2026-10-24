// Geometry helpers. Local frame: x = east (m), z = south (m), y = up — matches Three.js
// with the default camera looking down -z (north).

export interface LatLon {
  lat: number;
  lon: number;
}

const R = 6371000;
const M_PER_DEG_LAT = 110540;
const M_PER_DEG_LON = 111320;
export const toRad = (d: number) => (d * Math.PI) / 180;
export const toDeg = (r: number) => (r * 180) / Math.PI;

export function haversine(a: LatLon, b: LatLon): number {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Compass bearing from a to b, degrees clockwise from north, 0..360. */
export function bearing(a: LatLon, b: LatLon): number {
  const { x, z } = toLocal(a, b);
  return (toDeg(Math.atan2(x, -z)) + 360) % 360;
}

export function toLocal(origin: LatLon, p: LatLon): { x: number; z: number } {
  return {
    x: (p.lon - origin.lon) * Math.cos(toRad(origin.lat)) * M_PER_DEG_LON,
    z: -(p.lat - origin.lat) * M_PER_DEG_LAT,
  };
}

export function fromLocal(origin: LatLon, x: number, z: number): LatLon {
  return {
    lat: origin.lat - z / M_PER_DEG_LAT,
    lon: origin.lon + x / (Math.cos(toRad(origin.lat)) * M_PER_DEG_LON),
  };
}

/** Move from p by `dist` metres along compass `bearingDeg`. */
export function offset(p: LatLon, bearingDeg: number, dist: number): LatLon {
  const b = toRad(bearingDeg);
  return fromLocal(p, Math.sin(b) * dist, -Math.cos(b) * dist);
}

/** Smallest signed difference b - a in degrees, in (-180, 180]. */
export function angleDiff(a: number, b: number): number {
  let d = ((b - a) % 360 + 540) % 360 - 180;
  if (d === -180) d = 180;
  return d;
}

export interface Polyline {
  pts: LatLon[];
  cum: number[]; // cumulative distance at each vertex
  length: number;
}

export function buildPolyline(pts: LatLon[]): Polyline {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + haversine(pts[i - 1], pts[i]));
  return { pts, cum, length: cum[cum.length - 1] ?? 0 };
}

export interface Projection {
  along: number; // distance along the line to the closest point
  dist: number; // distance from p to the line
  seg: number;
  point: LatLon;
}

/** Closest point on the polyline to p. `hint` limits the search to nearby segments. */
export function project(poly: Polyline, p: LatLon, hint?: number): Projection {
  const n = poly.pts.length;
  let lo = 0;
  let hi = n - 2;
  if (hint !== undefined) {
    lo = Math.max(0, hint - 10);
    hi = Math.min(n - 2, hint + 60);
  }
  let best: Projection = { along: 0, dist: Infinity, seg: 0, point: poly.pts[0] };
  for (let i = lo; i <= hi; i++) {
    const a = toLocal(p, poly.pts[i]);
    const b = toLocal(p, poly.pts[i + 1]);
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len2 = dx * dx + dz * dz;
    const t = len2 > 0 ? Math.min(1, Math.max(0, -(a.x * dx + a.z * dz) / len2)) : 0;
    const cx = a.x + t * dx;
    const cz = a.z + t * dz;
    const d = Math.hypot(cx, cz);
    if (d < best.dist) {
      const segLen = poly.cum[i + 1] - poly.cum[i];
      best = { along: poly.cum[i] + t * segLen, dist: d, seg: i, point: fromLocal(p, cx, cz) };
    }
  }
  // If the hinted window found nothing close, fall back to a full search.
  if (hint !== undefined && best.dist > 60) return project(poly, p);
  return best;
}

/** Point at a given distance along the polyline (clamped to its ends). */
export function pointAt(poly: Polyline, along: number): { p: LatLon; seg: number } {
  const n = poly.pts.length;
  if (n === 1 || along <= 0) return { p: poly.pts[0], seg: 0 };
  if (along >= poly.length) return { p: poly.pts[n - 1], seg: n - 2 };
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (poly.cum[mid] <= along) lo = mid;
    else hi = mid;
  }
  const segLen = poly.cum[lo + 1] - poly.cum[lo];
  const t = segLen > 0 ? (along - poly.cum[lo]) / segLen : 0;
  const a = poly.pts[lo];
  const b = poly.pts[lo + 1];
  return { p: { lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t }, seg: lo };
}

/** Direction of travel at a distance along the line, smoothed over a short look-ahead. */
export function bearingAt(poly: Polyline, along: number, lookAhead = 12): number {
  const a = pointAt(poly, Math.min(along, poly.length - 1)).p;
  const b = pointAt(poly, Math.min(along + lookAhead, poly.length)).p;
  if (haversine(a, b) < 0.5) {
    return bearing(pointAt(poly, Math.max(0, poly.length - lookAhead)).p, poly.pts[poly.pts.length - 1]);
  }
  return bearing(a, b);
}

// ---- geohash (Waze short links use them: waze.com/ul/h<geohash>) ----
const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';
export function decodeGeohash(hash: string): LatLon | null {
  let even = true;
  const lat = [-90, 90];
  const lon = [-180, 180];
  for (const ch of hash.toLowerCase()) {
    const v = BASE32.indexOf(ch);
    if (v < 0) return null;
    for (let bit = 4; bit >= 0; bit--) {
      const on = (v >> bit) & 1;
      const range = even ? lon : lat;
      const mid = (range[0] + range[1]) / 2;
      if (on) range[0] = mid;
      else range[1] = mid;
      even = !even;
    }
  }
  return { lat: (lat[0] + lat[1]) / 2, lon: (lon[0] + lon[1]) / 2 };
}
