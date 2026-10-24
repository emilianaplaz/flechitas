// Turns whatever the user pastes or shares (a Google Maps link, a Waze link,
// "10.48, -66.90", or a plain address) into a destination point.
import { decodeGeohash, type LatLon } from './geo.ts';

export type Parsed =
  | { kind: 'coords'; point: LatLon; label?: string }
  | { kind: 'text'; text: string }
  | { kind: 'shortlink'; url: string };

const COORDS = /(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)/;

function coordsFrom(s: string | null | undefined): LatLon | null {
  if (!s) return null;
  const m = decodeURIComponent(s.replace(/\+/g, ' ')).match(COORDS);
  if (!m) return null;
  const lat = parseFloat(m[1]);
  const lon = parseFloat(m[2]);
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

function cleanText(s: string): string {
  return decodeURIComponent(s.replace(/\+/g, ' ')).trim();
}

/** Pull the first URL out of shared text like "Mira este lugar https://maps.app.goo.gl/abc". */
export function extractUrl(text: string): string | null {
  const m = text.match(/https?:\/\/\S+/);
  return m ? m[0].replace(/[).,]+$/, '') : null;
}

export function parseInput(raw: string): Parsed | null {
  const input = raw.trim();
  if (!input) return null;
  const urlStr = extractUrl(input);
  if (!urlStr) {
    const c = coordsFrom(input);
    return c ? { kind: 'coords', point: c } : { kind: 'text', text: input };
  }
  let url: URL;
  try {
    url = new URL(urlStr);
  } catch {
    return { kind: 'text', text: input };
  }
  const host = url.hostname.toLowerCase();
  const q = url.searchParams;

  // ---- Waze ----
  if (host.endsWith('waze.com')) {
    const gh = url.pathname.match(/\/ul\/h([0-9a-z]+)/i);
    if (gh) {
      const p = decodeGeohash(gh[1]);
      if (p) return { kind: 'coords', point: p };
    }
    const to = q.get('to');
    const c =
      coordsFrom(q.get('ll')) ?? coordsFrom(q.get('latlng')) ?? (to?.startsWith('ll.') ? coordsFrom(to.slice(3)) : null);
    if (c) return { kind: 'coords', point: c, label: q.get('q') ?? undefined };
    if (q.get('q')) return { kind: 'text', text: cleanText(q.get('q')!) };
    return null;
  }

  // ---- Google short links need to be expanded on the server ----
  if (/(^|\.)goo\.gl$/.test(host) || host === 'g.co') {
    return { kind: 'shortlink', url: url.toString() };
  }

  // ---- Google Maps long links ----
  if (host.includes('google.')) {
    const full = decodeURIComponent(url.toString());
    // !3d<lat>!4d<lon> is the actual place pin — most precise.
    const pin = full.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
    const placeName = url.pathname.match(/\/place\/([^/]+)/)?.[1];
    const label = placeName ? cleanText(placeName) : undefined;
    if (pin) return { kind: 'coords', point: { lat: +pin[1], lon: +pin[2] }, label };

    for (const key of ['destination', 'daddr', 'q', 'query', 'll', 'center']) {
      const v = q.get(key);
      const c = coordsFrom(v);
      if (c) return { kind: 'coords', point: c, label };
      if (v && (key === 'destination' || key === 'daddr' || key === 'q' || key === 'query')) {
        return { kind: 'text', text: cleanText(v) };
      }
    }
    // /dir/<origin>/<destination>/
    const dir = url.pathname.match(/\/dir\/(?:[^/]*)\/([^/@]+)/);
    if (dir) {
      const c = coordsFrom(dir[1]);
      return c ? { kind: 'coords', point: c } : { kind: 'text', text: cleanText(dir[1]) };
    }
    if (label) return { kind: 'text', text: label };
    const search = url.pathname.match(/\/search\/([^/@]+)/);
    if (search) {
      const c = coordsFrom(search[1]);
      return c ? { kind: 'coords', point: c } : { kind: 'text', text: cleanText(search[1]) };
    }
    // Last resort: the map's viewport centre (@lat,lon,zoom).
    const at = url.pathname.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
    if (at) return { kind: 'coords', point: { lat: +at[1], lon: +at[2] } };
    return null;
  }

  return null;
}

export async function geocode(text: string): Promise<LatLon | null> {
  for (const extra of ['&countrycodes=ve', '']) {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?format=json&limit=1${extra}&q=${encodeURIComponent(text)}`,
      { headers: { 'accept-language': 'es' } },
    );
    if (!res.ok) continue;
    const data = (await res.json()) as { lat: string; lon: string }[];
    if (data[0]) return { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon) };
  }
  return null;
}

/** Full resolution: parse, expand Google short links, geocode names. */
export async function resolveDestination(raw: string): Promise<{ point: LatLon; label: string }> {
  let parsed = parseInput(raw);
  if (parsed?.kind === 'shortlink') {
    const res = await fetch(`/api/expand?url=${encodeURIComponent(parsed.url)}`);
    const body = (await res.json()) as { url?: string; error?: string };
    if (!body.url) throw new Error(body.error ?? 'No se pudo abrir el enlace de Google Maps');
    parsed = parseInput(body.url);
  }
  if (!parsed) throw new Error('No reconozco ese enlace o dirección');
  if (parsed.kind === 'coords') {
    return { point: parsed.point, label: parsed.label ?? `${parsed.point.lat.toFixed(5)}, ${parsed.point.lon.toFixed(5)}` };
  }
  if (parsed.kind === 'text') {
    const p = await geocode(parsed.text);
    if (!p) throw new Error(`No encontré "${parsed.text}"`);
    return { point: p, label: parsed.text };
  }
  throw new Error('No reconozco ese enlace o dirección');
}
