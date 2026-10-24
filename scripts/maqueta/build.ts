// Builds the maqueta tiles for one zone (see MAQUETA.md):
//   npm run maqueta -- <zone>        e.g. npm run maqueta -- san-juan-bosco
// Zones live in zones.json (bbox: south, west, north, east). For each z16 tile covering the zone it
// asks Overpass for signs and roads and Open-Meteo for a ground elevation grid, smooths the grid,
// applies the hand corrections in overrides/{x}_{y}.json, and writes public/maqueta/16/{x}/{y}.json
// plus public/maqueta/index.json. Uses only Node's fetch; waits between requests to be polite.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gridPoint, MAQUETA_ZOOM, tileKey, tileOf, tileToLatLon, type MaquetaIndex, type SignType, type Tile, type TileSign, type TileWay } from '../../src/core/maqueta.ts';
import { bearing } from '../../src/core/geo.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '../../public/maqueta');
const GRID = 13; // rows and cols of the elevation grid (edges included): ~50 m apart at z16 in Caracas
const OVERPASS = 'https://overpass-api.de/api/interpreter';
const ELEVATION = 'https://api.open-meteo.com/v1/elevation';
const PAUSE_MS = 1500;
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

function tileBox(x: number, y: number): [number, number, number, number] {
  const nw = tileToLatLon(x, y);
  const se = tileToLatLon(x + 1, y + 1);
  return [se.lat, nw.lon, nw.lat, se.lon];
}

async function overpass(box: [number, number, number, number]): Promise<(OsmNode | OsmWay)[]> {
  const b = box.join(',');
  const roads = 'motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link';
  const query = `[out:json][timeout:60];
(
  node["highway"~"^(traffic_signals|stop|give_way|crossing|speed_camera)$"](${b});
  node["traffic_calming"~"^(bump|hump|table)$"](${b});
  way["highway"~"^(${roads})$"](${b});
);
out geom;`;
  const res = await fetch(OVERPASS, { method: 'POST', headers: { 'User-Agent': UA }, body: new URLSearchParams({ data: query }) });
  if (!res.ok) throw new Error(`Overpass respondió ${res.status}`);
  return ((await res.json()) as { elements: (OsmNode | OsmWay)[] }).elements;
}

async function elevations(points: { lat: number; lon: number }[]): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < points.length; i += 100) {
    const chunk = points.slice(i, i + 100);
    const url = `${ELEVATION}?latitude=${chunk.map((p) => p.lat.toFixed(6)).join(',')}&longitude=${chunk.map((p) => p.lon.toFixed(6)).join(',')}`;
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
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

async function buildTile(x: number, y: number): Promise<Tile> {
  const box = tileBox(x, y);
  const elements = await overpass(box);
  await sleep(PAUSE_MS);

  const osmWays = elements.filter((e): e is OsmWay => e.type === 'way' && !!e.geometry);
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
  const ov = (await readJson<Override>(join(HERE, 'overrides', `${x}_${y}.json`))) ?? {};
  for (const id of ov.removeSigns ?? []) signs.delete(id);
  for (const s of ov.signs ?? []) signs.set(s.id, { ...s, verified: s.verified ?? true });
  for (const e of ov.elev ?? []) z[e.r * GRID + e.c] = e.z;

  return {
    v: 1,
    tile: [MAQUETA_ZOOM, x, y],
    built: new Date().toISOString(),
    sources: ['OpenStreetMap', 'Copernicus DEM 90 m (Open-Meteo)'],
    elev: { rows: GRID, cols: GRID, z },
    signs: [...signs.values()],
    ways: osmWays.map(toWay),
  };
}

async function main() {
  const name = process.argv[2];
  const zones = (await readJson<Zone[]>(join(HERE, 'zones.json'))) ?? [];
  const zone = zones.find((z) => z.name === name);
  if (!zone) {
    console.error(`Uso: npm run maqueta -- <zona>\nZonas: ${zones.map((z) => z.name).join(', ')}`);
    process.exit(1);
  }
  const [south, west, north, east] = zone.bbox;
  const a = tileOf({ lat: north, lon: west });
  const b = tileOf({ lat: south, lon: east });
  const keys: string[] = [];
  for (let x = a.x; x <= b.x; x++) {
    for (let y = a.y; y <= b.y; y++) {
      process.stdout.write(`tesela ${tileKey(x, y)}… `);
      const tile = await buildTile(x, y);
      const dir = join(OUT, String(MAQUETA_ZOOM), String(x));
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, `${y}.json`), JSON.stringify(tile) + '\n');
      const zs = tile.elev.z;
      console.log(`${tile.signs.length} señales, ${tile.ways.length} vías, altura ${Math.min(...zs).toFixed(0)}–${Math.max(...zs).toFixed(0)} m`);
      keys.push(tileKey(x, y));
    }
  }

  const index = (await readJson<MaquetaIndex>(join(OUT, 'index.json'))) ?? { v: 1, zoom: MAQUETA_ZOOM, tiles: [], zones: [] };
  index.tiles = [...new Set([...index.tiles, ...keys])].sort();
  index.zones = [...index.zones.filter((z) => z.name !== zone.name), { name: zone.name, bbox: zone.bbox, tiles: keys }];
  await writeFile(join(OUT, 'index.json'), JSON.stringify(index, null, 2) + '\n');
  console.log(`listo: ${keys.length} teselas de ${zone.label}`);
}

await main();
