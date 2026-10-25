// Google Photorealistic 3D Tiles con 3d-tiles-renderer, recortadas a la caja de la zona y puestas en
// el mismo marco que la maqueta (x este, z sur, y arriba, origen en el centro de la zona).
// Necesita VITE_GOOGLE_MAPS_KEY en experiments/fachadas/.env.local (ver .env.example). Sin clave
// también acepta ?tileset=<url de un tileset.json público> para probar el cargador.
import * as THREE from 'three';
import { TilesRenderer } from '3d-tiles-renderer';
import { GoogleCloudAuthPlugin, LoadRegionPlugin, ReorientationPlugin, SphereRegion, TileCompressionPlugin, UnloadTilesPlugin } from '3d-tiles-renderer/plugins';
import { elevationIn } from '../../../src/core/maqueta.ts';
import type { Zona } from './zona.ts';

export interface Google {
  grupo: THREE.Group; // padre: gira el marco de la librería (x oeste, z norte) al nuestro
  tiles: TilesRenderer;
  update(): void;
  bytes(): number;
  requests(): number;
  atribuciones(): string;
  ajustarSuelo(): number | null; // sube/baja para que la calle quede en y = 0; devuelve el ajuste
  listoMs(): number | null;
  dispose(): void;
}

/** Altura del suelo según la maqueta, relativa al centro de la zona (para comparar con el relieve real). */
export function elevRel(zona: Zona): (x: number, z: number) => number {
  const el = elevationIn(zona.tiles);
  const e0 = el(zona.origin) ?? 0;
  return (x, z) => (el(zona.latLon(x, z)) ?? e0) - e0;
}

let bytes = 0;
let requests = 0;
let fetchEnvuelto = false;

/** Cuenta lo que baja de los servidores de teselas (para la tabla: datos por sesión). */
function contarDescargas(hosts: string[]) {
  if (fetchEnvuelto) return;
  fetchEnvuelto = true;
  const orig = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await orig(input, init);
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (hosts.some((h) => url.includes(h))) {
      requests++;
      res
        .clone()
        .arrayBuffer()
        .then((b) => (bytes += b.byteLength))
        .catch(() => {});
    }
    return res;
  };
}

export function crearGoogle(o: { key?: string; tileset?: string; zona: Zona; renderer: THREE.WebGLRenderer; camera: THREE.Camera; clip: boolean }): Google {
  const { zona } = o;
  bytes = 0;
  requests = 0;
  contarDescargas(['googleapis.com', o.tileset ? new URL(o.tileset).host : '__none__']);
  const tiles = new TilesRenderer(o.tileset);
  if (!o.tileset) tiles.registerPlugin(new GoogleCloudAuthPlugin({ apiToken: o.key!, autoRefreshToken: true }));
  tiles.registerPlugin(new TileCompressionPlugin());
  tiles.registerPlugin(new UnloadTilesPlugin());
  // Altura del elipsoide en el centro: la del modelo de la maqueta (ortométrica) es una primera
  // aproximación; ajustarSuelo() corrige la diferencia (geoide, error del modelo) con un rayo.
  const elev = elevationIn(zona.tiles)(zona.origin) ?? 900;
  const lat = THREE.MathUtils.degToRad(zona.origin.lat);
  const lon = THREE.MathUtils.degToRad(zona.origin.lon);
  // Un tileset de prueba (?tileset=) se centra donde esté; el de Google, en el centro de la zona.
  tiles.registerPlugin(o.tileset ? new ReorientationPlugin({ recenter: true }) : new ReorientationPlugin({ lat, lon, height: elev, recenter: true }));
  if (!o.tileset) {
    // Solo se bajan teselas que tocan una esfera alrededor de la zona (el error lo sigue
    // decidiendo la cámara: errorTarget enorme = esta región no obliga a refinar).
    const [s, w, n, e] = zona.bbox;
    const a = zona.local({ lat: s, lon: w });
    const b = zona.local({ lat: n, lon: e });
    const radio = Math.hypot(b.x - a.x, b.z - a.z) / 2 + 30;
    const centro = tiles.ellipsoid.getCartographicToPosition(lat, lon, elev, new THREE.Vector3());
    const region = new LoadRegionPlugin();
    region.addRegion(new SphereRegion({ sphere: new THREE.Sphere(centro, radio), mask: true, errorTarget: 1e9 }));
    tiles.registerPlugin(region);
  }
  tiles.setCamera(o.camera);
  tiles.setResolutionFromRenderer(o.camera, o.renderer);

  const grupo = new THREE.Group();
  grupo.rotation.y = Math.PI; // librería: x oeste, z norte → maqueta: x este, z sur
  grupo.add(tiles.group);

  // Recorte visual a la caja de la zona.
  const [s, w, n, e] = zona.bbox;
  const sw = zona.local({ lat: s, lon: w });
  const ne = zona.local({ lat: n, lon: e });
  const planos = [
    new THREE.Plane(new THREE.Vector3(1, 0, 0), -sw.x),
    new THREE.Plane(new THREE.Vector3(-1, 0, 0), ne.x),
    new THREE.Plane(new THREE.Vector3(0, 0, -1), sw.z),
    new THREE.Plane(new THREE.Vector3(0, 0, 1), -ne.z),
  ];
  o.renderer.localClippingEnabled = true;
  tiles.addEventListener('load-model', (ev: { scene: THREE.Object3D }) => {
    ev.scene.traverse((c) => {
      const m = (c as THREE.Mesh).material as THREE.Material | undefined;
      if (m && o.clip) m.clippingPlanes = planos;
    });
  });
  const t0 = performance.now();
  let listo: number | null = null;
  tiles.addEventListener('tiles-load-end', () => {
    listo = performance.now() - t0;
  });

  const ray = new THREE.Raycaster();
  return {
    grupo,
    tiles,
    update() {
      o.camera.updateMatrixWorld();
      tiles.update();
    },
    bytes: () => bytes,
    requests: () => requests,
    atribuciones() {
      const a = tiles.getAttributions().filter((x: { type: string }) => x.type === 'string').map((x: { value: string }) => x.value);
      return [...new Set(a)].join(' · ');
    },
    ajustarSuelo() {
      // Rayos hacia abajo en los puntos de las calles: el suelo de Google debería quedar a la altura
      // del modelo de relieve de la maqueta (relativa al centro). La diferencia es el ajuste.
      grupo.updateMatrixWorld(true);
      const rel = elevRel(zona);
      const dys: number[] = [];
      for (const wy of zona.ways)
        for (const [la, lo] of wy.pts) {
          const p = zona.local({ lat: la, lon: lo });
          if (p.x < sw.x || p.x > ne.x || p.z > sw.z || p.z < ne.z) continue;
          ray.set(new THREE.Vector3(p.x, 600, p.z), new THREE.Vector3(0, -1, 0));
          const hit = ray.intersectObject(tiles.group, true)[0];
          if (hit) dys.push(hit.point.y - rel(p.x, p.z));
        }
      if (dys.length < 3) return null;
      dys.sort((x, y) => x - y);
      const dy = dys[Math.floor(dys.length * 0.25)]; // la calle, no los carros ni los árboles
      grupo.position.y -= dy;
      return dy;
    },
    listoMs: () => listo,
    dispose() {
      tiles.dispose();
      grupo.removeFromParent();
    },
  };
}
