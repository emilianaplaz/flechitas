// Looks over the built maqueta tiles before they're committed (see MAQUETA.md):
//   npm run maqueta:check                 every tile in public/maqueta/index.json
//   npm run maqueta:check -- <zone> [...]  only those zones (still compared with their neighbours)
// Prints what each tile holds, then the problems: broken tiles (errors, exit code 1), buildings that
// appear twice across tiles, and buildings a street runs through (likely false or shifted footprints).
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tileKey, tileOf, type MaquetaIndex, type Tile, type TileWay } from '../../src/core/maqueta.ts';
import { crossTileDuplicates, roadsThroughBuildings, tileReport } from './quality.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '../../public/maqueta');

const index = JSON.parse(await readFile(join(OUT, 'index.json'), 'utf8')) as MaquetaIndex;
const zoneNames = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const unknown = zoneNames.filter((n) => !index.zones.some((z) => z.name === n));
if (unknown.length) {
  console.error(`No hay zonas ${unknown.join(', ')} en index.json. Zonas: ${index.zones.map((z) => z.name).join(', ')}`);
  process.exit(1);
}
const zones = zoneNames.length ? index.zones.filter((z) => zoneNames.includes(z.name)) : index.zones;
const keys = zoneNames.length ? [...new Set(zones.flatMap((z) => z.tiles))].sort() : index.tiles;

let errors = 0;
const problem = (msg: string) => (errors++, console.log(`  ✗ ${msg}`));

// The index itself: every zone's tiles listed and its bbox covering exactly them.
for (const z of zones) {
  const [s, w, n, e] = z.bbox;
  const a = tileOf({ lat: n, lon: w });
  const b = tileOf({ lat: s, lon: e });
  const expect: string[] = [];
  for (let x = a.x; x <= b.x; x++) for (let y = a.y; y <= b.y; y++) expect.push(tileKey(x, y));
  const missing = z.tiles.filter((k) => !index.tiles.includes(k));
  if (missing.length) problem(`zona ${z.name}: teselas que index.tiles no lista: ${missing.join(', ')}`);
  const off = expect.filter((k) => !z.tiles.includes(k));
  if (off.length) problem(`zona ${z.name}: su caja toca ${off.join(', ')}, que no están en la zona`);
  if (!z.label) console.log(`  · zona ${z.name} sin label (Destino muestra el nombre)`);
}

const load = async (k: string) => {
  try {
    return JSON.parse(await readFile(join(OUT, '16', `${k}.json`), 'utf8')) as Tile;
  } catch {
    return null;
  }
};
const tiles: Tile[] = [];
for (const k of keys) {
  const t = await load(k);
  if (!t) problem(`${k}: falta el archivo public/maqueta/16/${k}.json`);
  else tiles.push(t);
}
// Neighbours of the checked tiles, so duplicates across a zone's edge show up too.
const neighbours: Tile[] = [];
if (zoneNames.length) {
  for (const k of index.tiles) {
    if (keys.includes(k)) continue;
    const [x, y] = k.split('/').map(Number);
    if (!tiles.some((t) => Math.abs(t.tile[1] - x) <= 1 && Math.abs(t.tile[2] - y) <= 1)) continue;
    const t = await load(k);
    if (t) neighbours.push(t);
  }
}

const pad = (v: unknown, n: number) => String(v).padStart(n);
console.log('tesela        semáf  pare  ceda  paso  pol.  foto │  vías  nombre límite carril │ edif.   osm    ms manual nombre │ altura m   pend.');
for (const t of tiles) {
  const r = tileReport(t);
  const s = r.signs;
  const pol = (s.bump ?? 0) + (s.hump ?? 0) + (s.table ?? 0);
  const total = Object.values(r.buildings).reduce((a, b) => a + (b ?? 0), 0);
  console.log(
    `${r.key.padEnd(12)} ${pad(s.traffic_signals ?? 0, 5)} ${pad(s.stop ?? 0, 5)} ${pad(s.give_way ?? 0, 5)} ${pad(s.crossing ?? 0, 5)} ${pad(pol, 5)} ${pad(s.speed_camera ?? 0, 5)} │ ${pad(r.ways, 5)} ${pad(r.named, 6)} ${pad(r.withLimit, 6)} ${pad(r.withLanes, 6)} │ ${pad(total, 5)} ${pad(r.buildings.osm ?? 0, 5)} ${pad(r.buildings.ms ?? 0, 5)} ${pad(r.buildings.manual ?? 0, 6)} ${pad(r.namedBuildings, 6)} │ ${pad(r.elev.min.toFixed(0), 4)}–${r.elev.max.toFixed(0).padEnd(4)} ${pad(Math.round(r.elev.maxSlope * 100), 4)} %`,
  );
  for (const e of r.errors) problem(`${r.key}: ${e}`);
  for (const w of r.warnings) console.log(`  · ${r.key}: ${w}`);
}

const dupes = crossTileDuplicates([...tiles, ...neighbours]).filter((d) => keys.some((k) => d.a.startsWith(`${k} `) || d.b.startsWith(`${k} `)));
for (const d of dupes.slice(0, 20)) problem(`repetido entre teselas (${d.why}): ${d.a} y ${d.b}`);
if (dupes.length > 20) problem(`…y ${dupes.length - 20} repetidos más`);

// Streets through buildings: every way of the tiles around, so a street just over the edge counts.
const ways = new Map<string, TileWay>();
for (const t of [...tiles, ...neighbours]) for (const w of t.ways) ways.set(w.id, w);
let crossed = 0;
for (const t of tiles) {
  const hits = roadsThroughBuildings(t.buildings ?? [], [...ways.values()]);
  if (!hits.size) continue;
  crossed += hits.size;
  const list = [...hits].sort((a, b) => b[1] - a[1]);
  const src = (id: string) => t.buildings!.find((b) => b.id === id)!.source;
  console.log(`  · ${tileKey(t.tile[1], t.tile[2])}: ${hits.size} edificios atravesados por una calle: ${list.slice(0, 4).map(([id, m]) => `${id} (${src(id)}, ${Math.round(m)} m)`).join(', ')}${hits.size > 4 ? '…' : ''}`);
}

console.log(`\n${tiles.length} teselas, ${dupes.length} repetidos entre teselas, ${crossed} edificios atravesados por calles, ${errors} errores`);
process.exit(errors ? 1 : 0);
