// La zona de prueba, leída de las teselas reales de la app (public/maqueta) con el mismo código de
// la app (src/core), así los edificios quedan exactamente donde los pone la pantalla Maqueta.
import { toLocal, fromLocal, type LatLon } from '../../../src/core/geo.ts';
import { buildingsIn, type MaquetaIndex, type Tile, type TileBuilding, type TileWay } from '../../../src/core/maqueta.ts';

export interface Zona {
  name: string;
  bbox: [number, number, number, number]; // sur, oeste, norte, este
  origin: LatLon; // centro de la caja, como en src/ui/maqueta.ts
  tiles: Tile[];
  buildings: TileBuilding[];
  ways: TileWay[]; // vías que tocan la zona
  bytes: number; // lo que pesan las teselas (JSON sin comprimir)
  local: (p: LatLon) => { x: number; z: number };
  latLon: (x: number, z: number) => LatLon;
}

async function json<T>(url: string): Promise<{ data: T; bytes: number }> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  const text = await res.text();
  return { data: JSON.parse(text) as T, bytes: text.length };
}

export async function cargarZona(name = 'san-juan-bosco'): Promise<Zona> {
  const { data: index } = await json<MaquetaIndex>('/maqueta/index.json');
  const z = index.zones.find((q) => q.name === name);
  if (!z) throw new Error(`No hay zona ${name} en public/maqueta/index.json`);
  const loaded = await Promise.all(z.tiles.map((k) => json<Tile>(`/maqueta/16/${k}.json`)));
  const tiles = loaded.map((l) => l.data);
  const [s, w, n, e] = z.bbox;
  const origin = { lat: (s + n) / 2, lon: (w + e) / 2 };
  const seen = new Set<string>();
  const ways: TileWay[] = [];
  for (const t of tiles) for (const wy of t.ways) if (!seen.has(wy.id)) (seen.add(wy.id), ways.push(wy));
  const pad = 0.0004;
  return {
    name,
    bbox: z.bbox,
    origin,
    tiles,
    buildings: buildingsIn(tiles, z.bbox),
    ways: ways.filter((wy) => wy.pts.some(([la, lo]) => la > s - pad && la < n + pad && lo > w - pad && lo < e + pad)),
    bytes: loaded.reduce((a, l) => a + l.bytes, 0),
    local: (p) => toLocal(origin, p),
    latLon: (x, zz) => fromLocal(origin, x, zz),
  };
}
