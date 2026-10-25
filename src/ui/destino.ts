// Destino: the real 2D map seen from above (MapLibre + OpenFreeMap vector tiles, drawn in the app's
// palette). Shows where you are, the demo zone of the maqueta, hazards and speed bumps, the chosen
// destination and a preview of the route. Tapping the map picks the destination, or the origin right
// after tapping the Desde field.
// MapLibre (~800 KB) is loaded only when this screen first opens.
import type { FilterSpecification, GeoJSONSource, Map as MlMap, Marker, StyleSpecification } from 'maplibre-gl';
import { bearing, type LatLon } from '../core/geo.ts';
import type { MaquetaIndex, Tile, TileWay } from '../core/maqueta.ts';
import { resolveDestination } from '../core/links.ts';
import { fetchRoute, formatDistance, type Route } from '../core/route.ts';
import { app } from '../core/state.ts';
import { $, setText, toast } from '../core/ui.ts';
import { allHazards, loadHazards } from '../hazards/ui.ts';
import { onDest, setDestination, useSimulation } from '../setup.ts';

type Theme = 'dark' | 'light';
const PALETTE = {
  dark: { bg: '#0A0A0B', minor: '#17181A', road: '#222428', major: '#2C2F34', water: '#0B1118', park: '#0F1613', bldg: '#121315', label: '#8A8E96', pri: '#3E6AE1', route: '#4B86F5', haz: '#FFE14D', bump: '#FF6FB5' },
  light: { bg: '#E6EEF3', minor: '#DAE5EC', road: '#FFFFFF', major: '#FFFFFF', water: '#BFD9EA', park: '#CFE6D6', bldg: '#D3DFE7', label: '#5E7A8E', pri: '#1A56C4', route: '#1A56C4', haz: '#A87C00', bump: '#C71F6E' },
};

export interface Zone {
  name: string;
  bbox: [number, number, number, number]; // south, west, north, east
  tiles: string[];
}

let ml: typeof import('maplibre-gl') | null = null;
let map: MlMap | null = null;
let loading: Promise<void> | null = null;
let zones: Zone[] = [];
let here: LatLon | null = null; // this phone's position, when the GPS gives it
let hereMarker: Marker | null = null;
let destMarker: Marker | null = null;
let fromMarker: Marker | null = null;
let pickFrom = false; // the Desde field was tapped last: the next tap on the map places the origin
let pickHintShown = false;
let preview: Route | null = null;
let previewSeq = 0;
const empty = (): GeoJSON.FeatureCollection => ({ type: 'FeatureCollection', features: [] });
const data = { zone: empty(), route: empty(), holes: empty(), bumps: empty() };
const visible = { holes: true, bumps: true };

const theme = (): Theme => 'dark';
const ZONE_LABEL: Record<string, string> = { 'san-juan-bosco': 'Av. San Juan Bosco' };
export const zoneLabel = (z: Zone) => ZONE_LABEL[z.name] ?? z.name;

/** The maqueta zone a point is in (destination → "Elegir punto exacto"), if any. */
export function zoneAt(p: LatLon | null | undefined): Zone | null {
  if (!p) return null;
  return zones.find((z) => p.lat >= z.bbox[0] && p.lat <= z.bbox[2] && p.lon >= z.bbox[1] && p.lon <= z.bbox[3]) ?? null;
}
export const destZone = () => zoneAt(app.dest?.point);
/** Route preview for the current destination, when the origin was known. */
export const previewRoute = () => preview;

function style(t: Theme): StyleSpecification {
  const c = PALETTE[t];
  const road = (id: string, classes: string[], color: string, w: [number, number, number, number]) => ({
    id,
    type: 'line' as const,
    source: 'omt',
    'source-layer': 'transportation',
    filter: ['in', ['get', 'class'], ['literal', classes]] as unknown as FilterSpecification,
    layout: { 'line-cap': 'round' as const, 'line-join': 'round' as const },
    paint: { 'line-color': color, 'line-width': ['interpolate', ['exponential', 1.6], ['zoom'], w[0], w[1], w[2], w[3]] as unknown as number },
  });
  return {
    version: 8,
    glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
    sources: {
      omt: { type: 'vector', url: 'https://tiles.openfreemap.org/planet', attribution: '© OpenFreeMap · © OpenStreetMap' },
      zone: { type: 'geojson', data: data.zone },
      route: { type: 'geojson', data: data.route },
      holes: { type: 'geojson', data: data.holes },
      bumps: { type: 'geojson', data: data.bumps },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': c.bg } },
      { id: 'park', type: 'fill', source: 'omt', 'source-layer': 'park', paint: { 'fill-color': c.park } },
      { id: 'green', type: 'fill', source: 'omt', 'source-layer': 'landcover', filter: ['in', ['get', 'class'], ['literal', ['grass', 'wood']]], paint: { 'fill-color': c.park, 'fill-opacity': 0.7 } },
      { id: 'water', type: 'fill', source: 'omt', 'source-layer': 'water', paint: { 'fill-color': c.water } },
      { id: 'waterway', type: 'line', source: 'omt', 'source-layer': 'waterway', paint: { 'line-color': c.water, 'line-width': 2 } },
      { id: 'building', type: 'fill', source: 'omt', 'source-layer': 'building', minzoom: 14, paint: { 'fill-color': c.bldg } },
      road('road-service', ['service', 'track', 'path'], c.minor, [13, 0.5, 18, 8]),
      road('road-minor', ['minor', 'residential'], c.road, [12, 1, 18, 18]),
      road('road-major', ['tertiary', 'secondary', 'primary', 'trunk', 'motorway'], c.major, [10, 1.5, 18, 26]),
      { id: 'zone-fill', type: 'fill', source: 'zone', paint: { 'fill-color': c.pri, 'fill-opacity': 0.08 } },
      { id: 'zone-line', type: 'line', source: 'zone', paint: { 'line-color': c.pri, 'line-width': 2.5, 'line-dasharray': [3, 2] } },
      { id: 'route-case', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': c.bg, 'line-width': 10 } },
      { id: 'route', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': c.route, 'line-width': 6 } },
      { id: 'holes', type: 'circle', source: 'holes', layout: { visibility: visible.holes ? 'visible' : 'none' }, paint: { 'circle-color': c.haz, 'circle-radius': 6, 'circle-stroke-color': c.bg, 'circle-stroke-width': 2 } },
      {
        id: 'bumps',
        type: 'symbol',
        source: 'bumps',
        layout: { visibility: visible.bumps ? 'visible' : 'none', 'icon-image': 'bump-bar', 'icon-rotate': ['coalesce', ['get', 'rot'], 0], 'icon-rotation-alignment': 'map', 'icon-allow-overlap': true, 'icon-size': ['interpolate', ['linear'], ['zoom'], 12, 0.35, 16, 1] },
      },
      {
        id: 'road-names',
        type: 'symbol',
        source: 'omt',
        'source-layer': 'transportation_name',
        minzoom: 14,
        layout: { 'symbol-placement': 'line', 'text-field': ['coalesce', ['get', 'name:es'], ['get', 'name']], 'text-font': ['Noto Sans Regular'], 'text-size': 12 },
        paint: { 'text-color': c.label, 'text-halo-color': c.bg, 'text-halo-width': 1.5 },
      },
      {
        id: 'places',
        type: 'symbol',
        source: 'omt',
        'source-layer': 'place',
        layout: { 'text-field': ['coalesce', ['get', 'name:es'], ['get', 'name']], 'text-font': ['Noto Sans Bold'], 'text-size': 13 },
        paint: { 'text-color': c.label, 'text-halo-color': c.bg, 'text-halo-width': 1.5 },
      },
    ],
  } as StyleSpecification;
}

function setData(key: keyof typeof data, fc: GeoJSON.FeatureCollection) {
  data[key] = fc;
  (map?.getSource(key) as GeoJSONSource | undefined)?.setData(fc);
}

const point = (p: LatLon, props: Record<string, unknown> = {}): GeoJSON.Feature => ({ type: 'Feature', properties: props, geometry: { type: 'Point', coordinates: [p.lon, p.lat] } });

function pin(cls: string): HTMLElement {
  const el = document.createElement('div');
  el.className = cls;
  return el;
}

async function loadZones() {
  try {
    const res = await fetch('/maqueta/index.json');
    if (!res.ok) return;
    const index = (await res.json()) as MaquetaIndex;
    zones = index.zones;
  } catch {
    return;
  }
  setData('zone', {
    type: 'FeatureCollection',
    features: zones.map((z) => {
      const [s, w, n, e] = z.bbox;
      return { type: 'Feature', properties: { name: z.name }, geometry: { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] } };
    }),
  });
  // Speed bumps the maqueta knows about in its zones.
  const bumps: GeoJSON.Feature[] = [];
  for (const key of new Set(zones.flatMap((z) => z.tiles))) {
    try {
      const t = (await (await fetch(`/maqueta/16/${key}.json`)).json()) as Tile;
      for (const s of t.signs) if (s.type === 'bump' || s.type === 'hump' || s.type === 'table') bumps.push(point(s, { rot: s.dir ?? roadBearing(s, t.ways) }));
      knownWays.push(...t.ways);
    } catch {
      /* tile missing: skip */
    }
  }
  bumpsFromMaqueta = bumps;
  refreshHazards();
  syncDest(); // a destination typed before the zones arrived
}
let bumpsFromMaqueta: GeoJSON.Feature[] = [];
const knownWays: TileWay[] = [];

/** Compass bearing of the road under `p` (its nearest way segment), 0 where no way is known. The bar icon lies east-west, so rotating it by this bearing lays it across the road. */
function roadBearing(p: LatLon, ways: TileWay[]): number {
  const kx = Math.cos((p.lat * Math.PI) / 180);
  let best = 0;
  let bestD = Infinity;
  for (const w of ways) {
    for (let i = 0; i + 1 < w.pts.length; i++) {
      const [a, b] = [w.pts[i], w.pts[i + 1]];
      const [ax, ay, bx, by] = [(a[1] - p.lon) * kx, a[0] - p.lat, (b[1] - p.lon) * kx, b[0] - p.lat];
      const [dx, dy] = [bx - ax, by - ay];
      const t = dx || dy ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy))) : 0;
      const d = Math.hypot(ax + t * dx, ay + t * dy);
      if (d < bestD) {
        bestD = d;
        best = bearing({ lat: a[0], lon: a[1] }, { lat: b[0], lon: b[1] });
      }
    }
  }
  return best;
}

function refreshHazards() {
  const all = allHazards();
  setData('holes', { type: 'FeatureCollection', features: all.filter((h) => h.type === 'hueco').map((h) => point(h)) });
  setData('bumps', { type: 'FeatureCollection', features: [...bumpsFromMaqueta, ...all.filter((h) => h.type === 'policia' && h.source !== 'osm').map((h) => point(h, { rot: roadBearing(h, knownWays) }))] });
}

function watchHere() {
  if (!('geolocation' in navigator)) return;
  navigator.geolocation.watchPosition(
    (p) => {
      const first = !here;
      here = { lat: p.coords.latitude, lon: p.coords.longitude };
      if (!map || !ml) return;
      hereMarker ??= new ml.Marker({ element: pin('mapHere') }).setLngLat([here.lon, here.lat]).addTo(map);
      hereMarker.setLngLat([here.lon, here.lat]);
      if (first && !app.dest) map.easeTo({ center: [here.lon, here.lat], zoom: 15 });
      if (first) void syncDest();
    },
    () => {},
    { enableHighAccuracy: true, maximumAge: 10000 },
  );
}

/** Where a drive would start: the chosen origin in a simulation, else this phone's GPS. */
async function origin(): Promise<LatLon | null> {
  return app.mode === 'sim' && app.from ? app.from : here;
}
export function setSimOrigin(p: LatLon | null) {
  app.from = p;
  void syncDest();
}

/** Origin picked on the map (tap or dragged pin): the drive becomes a simulation from that exact point. */
async function placeOrigin(p: LatLon) {
  pickFrom = false;
  const from = $<HTMLInputElement>('from');
  from.value = 'Punto en el mapa';
  app.from = p;
  useSimulation();
  void syncDest();
  const name = await placeName(p);
  if (app.from === p) from.value = name;
}

/** The origin pin, shown while a simulation starts somewhere other than here. Drag it to move the origin. */
function syncFromMarker() {
  if (!map || !ml) return;
  const p = app.mode === 'sim' ? app.from : null;
  if (!p) {
    fromMarker?.remove();
    return;
  }
  if (!fromMarker) {
    fromMarker = new ml.Marker({ element: pin('mapFrom'), draggable: true });
    fromMarker.on('dragend', () => {
      const ll = fromMarker!.getLngLat();
      void placeOrigin({ lat: ll.lat, lon: ll.lng });
    });
  }
  fromMarker.setLngLat([p.lon, p.lat]).addTo(map);
}

/** Destination changed (typed, pasted, shared or tapped): pin, zone, route preview, bottom card. */
async function syncDest() {
  const d = app.dest;
  const zone = destZone();
  setText('startLabel', zone && !app.arrival ? 'Elegir punto exacto' : 'Conducir');
  syncFromMarker();
  if (!d) {
    destMarker?.remove();
    destMarker = null;
    preview = null;
    setData('route', empty());
    return;
  }
  if (map && ml) {
    destMarker ??= new ml.Marker({ element: pin('mapDest'), anchor: 'bottom' });
    destMarker.setLngLat([d.point.lon, d.point.lat]).addTo(map);
  }
  const seq = ++previewSeq;
  const from = await origin();
  const zoneNote = app.arrival ? app.arrival.label : zone ? `Zona de la maqueta · ${zoneLabel(zone)}` : '';
  setText('destLabel', zoneNote || (from ? 'Calculando ruta…' : 'Te ubico al empezar'));
  if (!from) {
    map?.easeTo({ center: [d.point.lon, d.point.lat], zoom: Math.max(map.getZoom(), 15) });
    return;
  }
  try {
    const r = await fetchRoute(from, d.point);
    if (seq !== previewSeq) return;
    preview = r;
    const coords = r.poly.pts.map((p) => [p.lon, p.lat]);
    setData('route', { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } }] });
    const mins = Math.max(1, Math.round(r.duration / 60));
    setText('destLabel', [`${mins} min · ${formatDistance(r.poly.length)}`, zoneNote].filter(Boolean).join(' · '));
    if (map && ml) {
      const b = new ml.LngLatBounds(coords[0] as [number, number], coords[0] as [number, number]);
      for (const c of coords) b.extend(c as [number, number]);
      map.fitBounds(b, { padding: { top: 260, bottom: 300, left: 40, right: 40 }, maxZoom: 17, duration: 600 });
    }
  } catch {
    if (seq !== previewSeq) return;
    preview = null;
    setData('route', empty());
    setText('destLabel', zoneNote || 'Sin vista previa de la ruta');
  }
}

/** Name for a tapped point (street and number), or its coordinates. */
async function placeName(p: LatLon): Promise<string> {
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&zoom=18&lat=${p.lat}&lon=${p.lon}`, { headers: { 'accept-language': 'es' } });
    const j = (await res.json()) as { name?: string; address?: Record<string, string> };
    const a = j.address ?? {};
    const street = [a.road, a.house_number].filter(Boolean).join(' ');
    return j.name || street || a.neighbourhood || a.suburb || `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`;
  } catch {
    return `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`;
  }
}

/** The speed-bump marker: a rounded bar, laid across the road when the sign knows its direction. */
function bumpIcon(): ImageData {
  const [w, h] = [56, 24];
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const g = cv.getContext('2d')!;
  g.beginPath();
  g.roundRect(3, 3, w - 6, h - 6, (h - 6) / 2);
  g.fillStyle = PALETTE[theme()].bump;
  g.fill();
  g.lineWidth = 3;
  g.strokeStyle = PALETTE[theme()].bg;
  g.stroke();
  return g.getImageData(0, 0, w, h);
}

function applyTheme() {
  map?.setStyle(style(theme()), { diff: false });
}

/** Opens the map the first time Destino shows; later calls only fix its size. */
export function showDestinoMap(): Promise<void> {
  if (map) {
    map.resize();
    return Promise.resolve();
  }
  loading ??= (async () => {
    try {
      const [mod] = await Promise.all([import('maplibre-gl'), import('maplibre-gl/dist/maplibre-gl.css')]);
      ml = (mod as unknown as { default?: typeof import('maplibre-gl') }).default ?? mod;
    } catch {
      toast('No se pudo cargar el mapa. Revisa la conexión.');
      loading = null;
      return;
    }
    map = new ml.Map({
      container: 'map',
      style: style(theme()),
      center: [-66.8519, 10.5109], // the demo zone until the GPS answers
      zoom: 15,
      attributionControl: false,
      pitchWithRotate: false,
      dragRotate: false,
    });
    map.addControl(new ml.AttributionControl({ compact: true }), 'top-right');
    if (import.meta.env.DEV) (window as unknown as { __map: MlMap }).__map = map; // for debugging in the browser
    map.touchZoomRotate.disableRotation();
    // Data that arrived before the style finished loading had no source to go into yet.
    map.once('load', () => {
      for (const k of Object.keys(data) as (keyof typeof data)[]) (map!.getSource(k) as GeoJSONSource | undefined)?.setData(data[k]);
    });
    map.on('styleimagemissing', (e) => {
      if (e.id === 'bump-bar' && !map!.hasImage(e.id)) map!.addImage(e.id, bumpIcon(), { pixelRatio: 2 });
    });
    map.on('click', async (e) => {
      const p = { lat: e.lngLat.lat, lon: e.lngLat.lng };
      if (pickFrom) return placeOrigin(p);
      setDestination({ point: p, label: 'Punto en el mapa' });
      setDestination({ point: p, label: await placeName(p) }, true);
    });
    matchMedia('(prefers-color-scheme: light)').addEventListener('change', applyTheme);
    watchHere();
    void loadZones();
    void loadHazards().then(refreshHazards).catch(() => {});
    if (app.dest) void syncDest();
  })();
  return loading;
}

export function initDestino() {
  onDest(() => void syncDest());
  // Simulation from a typed origin: the preview starts there too.
  const from = $<HTMLInputElement>('from');
  from.addEventListener('focus', () => {
    pickFrom = true;
    if (!pickHintShown) toast('Escribe el origen o toca el mapa para ponerlo ahí', 3500);
    pickHintShown = true;
  });
  $('dest').addEventListener('focus', () => (pickFrom = false));
  from.addEventListener('change', async () => {
    pickFrom = false;
    const raw = from.value.trim();
    if (!raw) return setSimOrigin(null);
    app.from = null; // until the new text is found, so a drive started meanwhile looks it up itself
    try {
      const p = (await resolveDestination(raw)).point;
      if (from.value.trim() === raw) setSimOrigin(p); // not replaced by a pin meanwhile
    } catch (e) {
      if (from.value.trim() !== raw) return;
      setSimOrigin(null);
      toast(`No encontré el origen: ${(e as Error).message}`, 4000);
    }
  });
  document.querySelectorAll<HTMLInputElement>('input[name=mode]').forEach((r) => r.addEventListener('change', () => void syncDest()));
  $('recenter').onclick = () => {
    if (here) map?.easeTo({ center: [here.lon, here.lat], zoom: 16 });
    else toast('Todavía no tengo tu ubicación');
  };
  const layer = (btn: string, key: 'holes' | 'bumps') =>
    $(btn).addEventListener('click', () => {
      visible[key] = $(btn).getAttribute('aria-pressed') === 'true';
      map?.setLayoutProperty(key, 'visibility', visible[key] ? 'visible' : 'none');
    });
  layer('layerHoles', 'holes');
  layer('layerBumps', 'bumps');
}
