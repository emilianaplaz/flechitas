// Builds the maqueta tiles for one zone (see MAQUETA.md):
//   npm run maqueta -- <zone>                    e.g. npm run maqueta -- san-juan-bosco
//   npm run maqueta -- <zone> --solo-faltantes   keeps the tiles already built, builds the rest
// Zones live in zones.json (bbox: south, west, north, east). For each z16 tile covering the zone it
// asks Overpass for signs, roads, buildings and entrances and Open-Meteo for a ground elevation grid,
// smooths the grid, adds the Microsoft Global ML Building Footprints that OSM lacks, applies the hand
// corrections in overrides/{x}_{y}.json (or .jsonc, with // comments), and writes
// public/maqueta/16/{x}/{y}.json plus public/maqueta/index.json. Uses only Node's fetch; waits between
// requests to be polite, retries when a server is busy, and keeps Microsoft's files (megabytes, the
// same for every zone) in scripts/maqueta/.cache, which git ignores. Delete that folder to refresh them.
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gridPoint, insideOutline, MAQUETA_ZOOM, tileKey, tileOf, tileToLatLon, type MaquetaIndex, type SignType, type Tile, type TileBuilding, type TileEntrance, type TileSign, type TileWay } from '../../src/core/maqueta.ts';
import { bearing } from '../../src/core/geo.ts';
import { applyBuildingOverrides, buildingHeight, closeRing, dedupe, matchOffsets, median, ringArea, ringCenter, stitchRings, type AddedBuilding, type BuildingOverride, type Ring } from './buildings.ts';
import { roadsThroughBuildings } from './quality.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '../../public/maqueta');
const CACHE = join(HERE, '.cache');
const GRID = 13; // rows and cols of the elevation grid (edges included): ~50 m apart at z16 in Caracas
const OVERPASS = 'https://overpass-api.de/api/interpreter';
const ELEVATION = 'https://api.open-meteo.com/v1/elevation';
const PAUSE_MS = 1500;
const RETRY_MS = [10_000, 30_000, 60_000]; // waits after a busy answer (429, 5xx) before trying again
// Microsoft Global ML Building Footprints: one gzipped GeoJSON-lines file per z9 quadkey, listed here.
const MS_LINKS = 'https://minedbuildings.z5.web.core.windows.net/global-buildings/dataset-links.csv';
const MS_ZOOM = 9;
const BUILDING_MARGIN = 0.0005; // ° (~55 m) around a tile, so footprints crossing its edge are de-duplicated whole
const UA = 'flechitas-maqueta/0.1 (https://github.com/emilianaplaz/flechitas)';

interface Zone {
  name: string;
  label: string;
  bbox: [number, number, number, number];
}

interface Override {
  signs?: (Omit<TileSign, 'verified'> & { verified?: boolean })[]; // added or corrected by hand (same id replaces)
  removeSigns?: string[]; // ids that OSM has wrong
  elev?: { r: number; c: number; z: number }[]; // grid heights measured by hand
  buildings?: BuildingOverride[]; // names, heights, entrances measured by hand, or hide
  addBuildings?: AddedBuilding[]; // buildings no dataset has
}

interface OsmNode {
  type: 'node';
  id: number;
  lat: number;
  lon: number;
  tags?: Record<string, string>;
}
interface OsmWay {
  type: 'way';
  id: number;
  nodes: number[];
  geometry: { lat: number; lon: number }[];
  tags?: Record<string, string>;
}
interface OsmRelation {
  type: 'relation';
  id: number;
  members: { type: string; ref: number; role: string; geometry?: { lat: number; lon: number }[] }[];
  tags?: Record<string, string>;
}
type OsmElement = OsmNode | OsmWay | OsmRelation;

/** A footprint from an open dataset, before it gets an id and a tile. */
interface Footprint {
  ring: Ring;
  height: number | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** fetch with our User-Agent (Overpass answers 406 without one), retried while the server is busy or unreachable. */
async function politeFetch(url: string, init: RequestInit = {}): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    let res: Response | null = null;
    let why: string;
    try {
      res = await fetch(url, { ...init, headers: { 'User-Agent': UA, ...init.headers } });
      if (res.status !== 429 && res.status < 500) return res;
      why = String(res.status);
    } catch (e) {
      if (attempt >= RETRY_MS.length) throw e;
      why = 'sin conexión';
    }
    if (attempt >= RETRY_MS.length) return res!;
    process.stdout.write(`(${why}, reintento en ${RETRY_MS[attempt] / 1000} s) `);
    await sleep(RETRY_MS[attempt]);
  }
}

/** A download kept in .cache/file after the first time. */
async function cached(url: string, file: string): Promise<Uint8Array> {
  const path = join(CACHE, file);
  try {
    return new Uint8Array(await readFile(path));
  } catch {
    /* not downloaded yet */
  }
  const res = await politeFetch(url);
  if (!res.ok) throw new Error(`${url} respondió ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  await mkdir(CACHE, { recursive: true });
  await writeFile(path, bytes);
  await sleep(PAUSE_MS);
  return bytes;
}

const exists = (path: string) => access(path).then(() => true, () => false);

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** JSON with // comments (whole-line or trailing, outside strings): for the hand-written overrides. */
async function readJsonc<T>(path: string): Promise<T | null> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return null;
  }
  const clean = text.replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*/g, (_m, str: string | undefined) => str ?? '');
  try {
    return JSON.parse(clean) as T;
  } catch (e) {
    throw new Error(`${path}: ${(e as Error).message}`);
  }
}

function tileBox(x: number, y: number): [number, number, number, number] {
  const nw = tileToLatLon(x, y);
  const se = tileToLatLon(x + 1, y + 1);
  return [se.lat, nw.lon, nw.lat, se.lon];
}

async function overpass(box: [number, number, number, number], wide: [number, number, number, number]): Promise<OsmElement[]> {
  const b = box.join(',');
  const w = wide.join(',');
  const roads = 'motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link';
  const query = `[out:json][timeout:60];
(
  node["highway"~"^(traffic_signals|stop|give_way|crossing|speed_camera)$"](${b});
  node["traffic_calming"~"^(bump|hump|table)$"](${b});
  way["highway"~"^(${roads})$"](${b});
  way["building"]["building"!="no"](${w});
  relation["building"]["building"!="no"](${w});
  node["entrance"](${w});
);
out geom;`;
  const res = await politeFetch(OVERPASS, { method: 'POST', body: new URLSearchParams({ data: query }) });
  if (!res.ok) throw new Error(`Overpass respondió ${res.status}`);
  return ((await res.json()) as { elements: OsmElement[] }).elements;
}

function quadkey(x: number, y: number, zoom: number): string {
  let key = '';
  for (let i = zoom; i > 0; i--) {
    const m = 1 << (i - 1);
    key += String((x & m ? 1 : 0) + (y & m ? 2 : 0));
  }
  return key;
}

const boxesTouch = (a: [number, number, number, number], b: [number, number, number, number]) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];

function ringBox(ring: Ring): [number, number, number, number] {
  const lats = ring.map((p) => p[0]);
  const lons = ring.map((p) => p[1]);
  return [Math.min(...lats), Math.min(...lons), Math.max(...lats), Math.max(...lons)];
}

/**
 * Microsoft's footprints touching box. Finds the z9 quadkey files in dataset-links.csv and streams
 * them (gzip, one GeoJSON feature per line), keeping only what touches the box. Heights of -1 mean
 * the model had no estimate.
 */
async function msFootprints(box: [number, number, number, number]): Promise<Footprint[]> {
  const a = tileOf({ lat: box[2], lon: box[1] }, MS_ZOOM);
  const b = tileOf({ lat: box[0], lon: box[3] }, MS_ZOOM);
  const keys = new Set<string>();
  for (let x = a.x; x <= b.x; x++) for (let y = a.y; y <= b.y; y++) keys.add(quadkey(x, y, MS_ZOOM));

  const urls: string[] = [];
  for (const line of new TextDecoder().decode(await cached(MS_LINKS, 'ms-dataset-links.csv')).split('\n')) {
    const m = /,(\d+),(https:[^,]+),/.exec(line); // Location,QuadKey,Url,Size,UploadDate
    if (m && keys.has(m[1])) urls.push(m[2]);
  }

  const out: Footprint[] = [];
  const take = (line: string) => {
    if (!line.trim()) return;
    const f = JSON.parse(line) as { properties?: { height?: number }; geometry: { type: string; coordinates: unknown } };
    const polys = (f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates : [f.geometry.coordinates]) as number[][][][];
    for (const poly of polys) {
      const ring = poly[0].map(([lon, lat]): [number, number] => [lat, lon]);
      if (ring.length < 4 || !boxesTouch(ringBox(ring), box)) continue;
      const h = f.properties?.height ?? -1;
      out.push({ ring, height: h > 0 ? h : null });
    }
  };
  for (const url of urls) {
    // Each quadkey's file has a unique name (part-…); a new dataset version gets new names.
    const gz = await cached(url, `ms-${url.split('quadkey=')[1]?.replace(/[^\w.-]+/g, '_') ?? encodeURIComponent(url)}`);
    let rest = '';
    for await (const chunk of new Blob([gz]).stream().pipeThrough(new DecompressionStream('gzip')).pipeThrough(new TextDecoderStream())) {
      const lines = (rest + chunk).split('\n');
      rest = lines.pop() ?? '';
      lines.forEach(take);
    }
    take(rest);
  }
  return out;
}

function entranceName(t: Record<string, string>): string {
  if (t['name']) return t['name'];
  if (t['ref']) return `Entrada ${t['ref']}`;
  if (t['entrance'] === 'main') return 'Entrada principal';
  if (t['entrance'] === 'garage') return 'Entrada de garaje';
  if (t['entrance'] === 'service') return 'Entrada de servicio';
  return 'Entrada';
}

/** OSM `building` ways and multipolygons, with their `entrance` nodes. */
function osmBuildings(elements: OsmElement[]): TileBuilding[] {
  const out: TileBuilding[] = [];
  const nodesOf = new Map<string, number[]>();
  for (const e of elements) {
    const t = e.tags ?? {};
    if (!t['building'] || e.type === 'node') continue;
    let ring: Ring | null = null;
    let id: string;
    if (e.type === 'way') {
      if (!e.geometry || e.geometry.length < 4) continue;
      ring = e.geometry.map((g): [number, number] => [g.lat, g.lon]);
      id = `osm:w${e.id}`;
      nodesOf.set(id, e.nodes);
    } else {
      const outer = e.members.filter((m) => m.type === 'way' && m.role !== 'inner' && m.geometry?.length);
      const rings = stitchRings(outer.map((m) => m.geometry!.map((g): [number, number] => [g.lat, g.lon])));
      ring = rings.sort((p, q) => ringArea(q) - ringArea(p))[0] ?? null;
      id = `osm:r${e.id}`;
    }
    if (!ring) continue;
    const { height, levels } = buildingHeight(t);
    out.push({ id, name: t['name'] ?? null, height, levels, source: 'osm', outline: closeRing(ring), entrances: [] });
  }
  // Entrances are usually nodes of the outline; otherwise take the building they fall in.
  for (const e of elements) {
    if (e.type !== 'node' || !e.tags?.['entrance']) continue;
    const b = out.find((b) => nodesOf.get(b.id)?.includes(e.id)) ?? out.find((b) => insideOutline(b.outline, e));
    const entrance: TileEntrance = { name: entranceName(e.tags), lat: e.lat, lon: e.lon };
    b?.entrances.push(entrance);
  }
  return out;
}

/** Footprint → building with a stable id: its centre, so overrides can name it across rebuilds. */
function datasetBuilding(f: Footprint, source: 'ms' | 'google', seen: Set<string>): TileBuilding {
  const outline = closeRing(f.ring);
  const c = ringCenter(outline);
  let id = `${source}:${c.lat.toFixed(6)},${c.lon.toFixed(6)}`;
  for (let n = 2; seen.has(id); n++) id = `${source}:${c.lat.toFixed(6)},${c.lon.toFixed(6)}#${n}`;
  seen.add(id);
  return { id, name: null, ...buildingHeight({}, f.height), source, outline, entrances: [] };
}

async function elevations(points: { lat: number; lon: number }[]): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < points.length; i += 100) {
    const chunk = points.slice(i, i + 100);
    const url = `${ELEVATION}?latitude=${chunk.map((p) => p.lat.toFixed(6)).join(',')}&longitude=${chunk.map((p) => p.lon.toFixed(6)).join(',')}`;
    const res = await politeFetch(url);
    if (!res.ok) throw new Error(`Open-Meteo respondió ${res.status}`);
    out.push(...((await res.json()) as { elevation: number[] }).elevation);
    await sleep(PAUSE_MS);
  }
  return out;
}

/** 3×3 mean: the 90 m model carries noise from buildings. Edges average the neighbours they have. */
function smooth(z: number[], rows: number, cols: number): number[] {
  const out = new Array<number>(z.length);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let sum = 0;
      let n = 0;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const rr = r + dr;
          const cc = c + dc;
          if (rr < 0 || cc < 0 || rr >= rows || cc >= cols) continue;
          sum += z[rr * cols + cc];
          n++;
        }
      }
      out[r * cols + c] = +(sum / n).toFixed(2);
    }
  }
  return out;
}

const CARDINAL: Record<string, number> = { N: 0, NNE: 22.5, NE: 45, ENE: 67.5, E: 90, ESE: 112.5, SE: 135, SSE: 157.5, S: 180, SSW: 202.5, SW: 225, WSW: 247.5, W: 270, WNW: 292.5, NW: 315, NNW: 337.5 };

/**
 * Bearing of the traffic a sign applies to, or null for both ways. `forward`/`backward` follow the
 * direction of a road the node is on. A number or N/NE/… is where the sign faces, so the traffic
 * it applies to travels the opposite way.
 */
function signDir(node: OsmNode, waysByNode: Map<number, OsmWay[]>): number | null {
  const t = node.tags ?? {};
  const raw = t['traffic_signals:direction'] ?? t['direction'];
  if (!raw) return null;
  if (raw === 'forward' || raw === 'backward') {
    for (const w of waysByNode.get(node.id) ?? []) {
      const i = w.nodes.indexOf(node.id);
      const a = w.geometry[Math.min(i, w.geometry.length - 2)];
      const b = w.geometry[Math.min(i, w.geometry.length - 2) + 1];
      if (!a || !b) continue;
      const along = bearing(a, b);
      return raw === 'forward' ? Math.round(along) : Math.round((along + 180) % 360);
    }
    return null;
  }
  const facing = CARDINAL[raw.toUpperCase()] ?? Number(raw);
  return Number.isFinite(facing) ? Math.round((facing + 180) % 360) : null;
}

function signType(tags: Record<string, string>): SignType | null {
  const calming = tags['traffic_calming'];
  if (calming === 'bump' || calming === 'hump' || calming === 'table') return calming;
  const h = tags['highway'];
  if (h === 'traffic_signals' || h === 'stop' || h === 'give_way' || h === 'crossing' || h === 'speed_camera') return h;
  return null;
}

function parseMaxspeed(v: string | undefined): number | null {
  if (!v) return null;
  const m = /^(\d+)\s*(mph)?/.exec(v.trim());
  if (!m) return null;
  return Math.round(Number(m[1]) * (m[2] ? 1.609 : 1));
}

function toWay(w: OsmWay): TileWay {
  const t = w.tags ?? {};
  const reversed = t['oneway'] === '-1';
  const pts = w.geometry.map((g): [number, number] => [+g.lat.toFixed(6), +g.lon.toFixed(6)]);
  if (reversed) pts.reverse();
  const lanes = Number.parseInt(t['lanes'] ?? '', 10);
  return {
    id: `osm:w${w.id}`,
    name: t['name'] ?? null,
    oneway: reversed || t['oneway'] === 'yes' || t['oneway'] === '1' || t['oneway'] === 'true' || t['junction'] === 'roundabout',
    lanes: Number.isFinite(lanes) ? lanes : null,
    maxspeed: parseMaxspeed(t['maxspeed']),
    turnLanes: t['turn:lanes'] ?? null,
    pts,
  };
}

/** A built tile, plus how Microsoft's footprints sit against the OSM buildings they duplicate (m, east and south). */
interface Built {
  tile: Tile;
  offsets: { dx: number; dz: number }[];
  dropped: number; // Microsoft footprints of this tile left out because a street runs through them
}

async function buildTile(x: number, y: number, ms: Footprint[]): Promise<Built> {
  const box = tileBox(x, y);
  const wide: [number, number, number, number] = [box[0] - BUILDING_MARGIN, box[1] - BUILDING_MARGIN, box[2] + BUILDING_MARGIN, box[3] + BUILDING_MARGIN];
  const elements = await overpass(box, wide);
  await sleep(PAUSE_MS);

  const osmWays = elements.filter((e): e is OsmWay => e.type === 'way' && !!e.geometry && !!e.tags?.['highway']);
  const waysByNode = new Map<number, OsmWay[]>();
  for (const w of osmWays) for (const n of w.nodes) waysByNode.set(n, [...(waysByNode.get(n) ?? []), w]);

  const signs = new Map<string, TileSign>();
  for (const e of elements) {
    if (e.type !== 'node' || !e.tags) continue;
    // Overpass also returns nodes just outside the box that belong to it by rounding; keep each node in one tile.
    const t = tileOf(e);
    if (t.x !== x || t.y !== y) continue;
    const type = signType(e.tags);
    if (!type) continue;
    const id = `osm:n${e.id}`;
    signs.set(id, { id, type, lat: e.lat, lon: e.lon, dir: type === 'crossing' ? null : signDir(e, waysByNode), verified: false });
  }

  const points: { lat: number; lon: number }[] = [];
  for (let r = 0; r < GRID; r++) for (let c = 0; c < GRID; c++) points.push(gridPoint(x, y, GRID, GRID, r, c));
  const z = smooth(await elevations(points), GRID, GRID);

  // Hand corrections always win over OSM and the elevation model.
  const ovDir = join(HERE, 'overrides');
  const ov = (await readJsonc<Override>(join(ovDir, `${x}_${y}.json`))) ?? (await readJsonc<Override>(join(ovDir, `${x}_${y}.jsonc`))) ?? {};
  for (const id of ov.removeSigns ?? []) signs.delete(id);
  for (const s of ov.signs ?? []) signs.set(s.id, { ...s, verified: s.verified ?? true });
  for (const e of ov.elev ?? []) z[e.r * GRID + e.c] = e.z;

  // Buildings: OSM first, then dataset footprints OSM doesn't already have. Matched over the wide box so
  // a building crossing the edge is compared whole; each one then goes to the tile holding its centre.
  const osm = osmBuildings(elements);
  const seen = new Set<string>();
  const candidates = ms.filter((f) => boxesTouch(ringBox(f.ring), wide)).map((f) => datasetBuilding(f, 'ms', seen));
  // A dataset footprint with a street running through it is a misplaced duplicate or not a building.
  const ways = osmWays.map(toWay);
  const crossed = roadsThroughBuildings(candidates, ways);
  const unique = dedupe(osm, candidates);
  const extra = unique.filter((b) => !crossed.has(b.id));
  const mine = (b: TileBuilding) => {
    const t = tileOf(ringCenter(b.outline));
    return t.x === x && t.y === y;
  };
  // The same building in both datasets says whether one is shifted against the other (coordinates check).
  const offsets = matchOffsets(osm.filter(mine), candidates);
  const merged = applyBuildingOverrides([...osm, ...extra].filter(mine), ov);
  for (const id of merged.unknown) console.warn(`\n  aviso: overrides/${x}_${y} nombra el edificio ${id}, que no está en la tesela`);
  const buildings = merged.buildings;

  const sources = ['OpenStreetMap', 'Copernicus DEM 90 m (Open-Meteo)'];
  if (buildings.some((b) => b.source === 'ms')) sources.push('Microsoft Global ML Building Footprints (ODbL)');

  const tile: Tile = {
    v: 1,
    tile: [MAQUETA_ZOOM, x, y],
    built: new Date().toISOString(),
    sources,
    elev: { rows: GRID, cols: GRID, z },
    signs: [...signs.values()],
    ways,
    buildings,
  };
  return { tile, offsets, dropped: unique.filter((b) => crossed.has(b.id) && mine(b)).length };
}

async function main() {
  const args = process.argv.slice(2);
  const name = args.find((a) => !a.startsWith('--'));
  const onlyMissing = args.includes('--solo-faltantes');
  const zones = (await readJson<Zone[]>(join(HERE, 'zones.json'))) ?? [];
  const zone = zones.find((z) => z.name === name);
  if (!zone) {
    console.error(`Uso: npm run maqueta -- <zona> [--solo-faltantes]\nZonas: ${zones.map((z) => z.name).join(', ')}`);
    process.exit(1);
  }
  const [south, west, north, east] = zone.bbox;
  const a = tileOf({ lat: north, lon: west });
  const b = tileOf({ lat: south, lon: east });
  // Microsoft's footprints for every tile of the zone at once (they come in files much larger than a tile),
  // fetched only when some tile has to be built.
  const nw = tileToLatLon(a.x, a.y);
  const se = tileToLatLon(b.x + 1, b.y + 1);
  let ms: Footprint[] | null = null;
  const footprints = async () => {
    if (ms) return ms;
    process.stdout.write('huellas de Microsoft… ');
    ms = await msFootprints([se.lat - BUILDING_MARGIN, nw.lon - BUILDING_MARGIN, nw.lat + BUILDING_MARGIN, se.lon + BUILDING_MARGIN]);
    console.log(`${ms.length}`);
    if (!ms.length) console.warn('  aviso: Microsoft no tiene huellas aquí; habría que probar Google Open Buildings v3');
    return ms;
  };

  const keys: string[] = [];
  for (let x = a.x; x <= b.x; x++) {
    for (let y = a.y; y <= b.y; y++) {
      const dir = join(OUT, String(MAQUETA_ZOOM), String(x));
      const file = join(dir, `${y}.json`);
      keys.push(tileKey(x, y));
      if (onlyMissing && (await exists(file))) {
        console.log(`tesela ${tileKey(x, y)}: ya está, se conserva`);
        continue;
      }
      const fp = await footprints();
      process.stdout.write(`tesela ${tileKey(x, y)}… `);
      const { tile, offsets, dropped } = await buildTile(x, y, fp);
      await mkdir(dir, { recursive: true });
      await writeFile(file, JSON.stringify(tile) + '\n');
      const zs = tile.elev.z;
      const bs = tile.buildings ?? [];
      const by = (s: string) => bs.filter((b) => b.source === s).length;
      console.log(`${tile.signs.length} señales, ${tile.ways.length} vías, ${bs.length} edificios (osm ${by('osm')}, ms ${by('ms')}, manual ${by('manual')}), altura ${Math.min(...zs).toFixed(0)}–${Math.max(...zs).toFixed(0)} m`);
      if (offsets.length) {
        const dx = median(offsets.map((o) => o.dx));
        const dz = median(offsets.map((o) => o.dz));
        console.log(`  Microsoft frente a OSM: ${offsets.length} edificios en ambos, desfase mediano ${dx.toFixed(1)} m este, ${(-dz).toFixed(1)} m norte`);
      }
      if (dropped) console.log(`  ${dropped} huellas de Microsoft descartadas: una calle pasa por encima`);
    }
  }

  const index = (await readJson<MaquetaIndex>(join(OUT, 'index.json'))) ?? { v: 1, zoom: MAQUETA_ZOOM, tiles: [], zones: [] };
  index.tiles = [...new Set([...index.tiles, ...keys])].sort();
  index.zones = [...index.zones.filter((z) => z.name !== zone.name), { name: zone.name, label: zone.label, bbox: zone.bbox, tiles: keys }];
  await writeFile(join(OUT, 'index.json'), JSON.stringify(index, null, 2) + '\n');
  console.log(`listo: ${keys.length} teselas de ${zone.label}`);
}

await main();
