// Road signs from the maqueta, drawn in the 3D overlay: PARE, CEDA and FOTOMULTA panels and traffic
// lights floating at the kerb (no posts, like the turn signs), zebra crossings on the road. Pooled;
// ArScene owns one of these and feeds it the signs ahead every frame.
import * as THREE from 'three';
import { toLocal, toRad, type LatLon } from '../core/geo.ts';
import type { SignType } from '../core/maqueta.ts';
import type { SignView } from '../signs/ahead.ts';

const POOL = 12;
const CROSSING_POOL = 6;
const KERB = 4.5; // m to the right of the route line (OSM draws the road centre)
const PANEL = 1.2; // m, side of a sign panel
const PANEL_Y = 2.4; // m above the road, centre of a panel
const LIGHT_Y = 3.2; // m above the road, centre of a traffic light
const STRIPES = 7; // zebra stripes across the road, 1 m apart

type Standing = Exclude<SignType, 'crossing' | 'bump' | 'hump' | 'table'>;
type Panel = Exclude<Standing, 'traffic_signals'>;

/** Panel outlines in canvas pixels (256 × 256), shared by the printed face and its backplate. */
function outline(type: Panel): [number, number][] {
  if (type === 'stop') {
    return Array.from({ length: 8 }, (_, i) => {
      const a = Math.PI / 8 + (i * Math.PI) / 4;
      return [128 + 122 * Math.cos(a), 128 + 122 * Math.sin(a)];
    });
  }
  if (type === 'give_way') return [[128, 240], [10, 34], [246, 34]];
  return [[20, 20], [236, 20], [236, 236], [20, 236]];
}

const toMetres = ([px, py]: [number, number]): [number, number] => [(px / 256 - 0.5) * PANEL, (0.5 - py / 256) * PANEL];

function face(type: Panel): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  const path = (pts: [number, number][], inset: number) => {
    g.beginPath();
    pts.forEach(([x, y], i) => {
      const ix = x + (128 - x) * inset;
      const iy = y + (128 - y) * inset;
      if (i) g.lineTo(ix, iy);
      else g.moveTo(ix, iy);
    });
    g.closePath();
  };
  const pts = outline(type);
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  if (type === 'stop') {
    path(pts, 0);
    g.fillStyle = '#fff';
    g.fill();
    path(pts, 0.08);
    g.fillStyle = '#c8102e';
    g.fill();
    g.fillStyle = '#fff';
    g.font = 'bold 76px system-ui, sans-serif';
    g.fillText('PARE', 128, 132, 200);
  } else if (type === 'give_way') {
    path(pts, 0);
    g.fillStyle = '#c8102e';
    g.fill();
    path(pts, 0.22);
    g.fillStyle = '#fff';
    g.fill();
    g.fillStyle = '#c8102e';
    g.font = 'bold 40px system-ui, sans-serif';
    g.fillText('CEDA', 128, 100, 130);
  } else {
    path(pts, 0);
    g.fillStyle = '#fff';
    g.fill();
    path(pts, 0.07);
    g.fillStyle = '#1f5fbf';
    g.fill();
    g.fillStyle = '#fff';
    g.font = 'bold 54px system-ui, sans-serif';
    g.fillText('FOTO', 128, 100, 190);
    g.fillText('MULTA', 128, 158, 190);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function lit(color: number, glow: number): THREE.MeshPhongMaterial {
  return new THREE.MeshPhongMaterial({ color, emissive: new THREE.Color(color).multiplyScalar(glow), shininess: 50 });
}

/** A printed face over a thin backplate of the same shape. */
function panelModel(type: Panel, backMat: THREE.Material): THREE.Group {
  const shape = new THREE.Shape(outline(type).map((p) => new THREE.Vector2(...toMetres(p))));
  const back = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth: 0.05, bevelEnabled: false }).translate(0, 0, -0.06), backMat);
  const front = new THREE.Mesh(new THREE.PlaneGeometry(PANEL, PANEL), new THREE.MeshBasicMaterial({ map: face(type), transparent: true, alphaTest: 0.5 }));
  const g = new THREE.Group();
  g.add(back, front);
  g.position.y = PANEL_Y;
  return g;
}

/** Housing with three lamps, all dim: we don't know which one is on. */
function trafficLightModel(): THREE.Group {
  const g = new THREE.Group();
  g.add(new THREE.Mesh(new THREE.BoxGeometry(0.42, 1.2, 0.3), lit(0x1d2228, 0.1)));
  const lamp = new THREE.CylinderGeometry(0.13, 0.13, 0.04, 20).rotateX(Math.PI / 2);
  [0xff3b30, 0xffb020, 0x22e07a].forEach((color, i) => {
    const m = new THREE.Mesh(lamp, lit(color, 0.55));
    m.position.set(0, 0.38 - i * 0.38, 0.16);
    g.add(m);
  });
  g.position.y = LIGHT_Y;
  return g;
}

function crossingModel(): THREE.Group {
  const g = new THREE.Group();
  const stripe = new THREE.PlaneGeometry(0.5, 3).rotateX(-Math.PI / 2);
  const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.7, depthWrite: false, side: THREE.DoubleSide });
  for (let i = 0; i < STRIPES; i++) {
    const m = new THREE.Mesh(stripe, mat);
    m.position.x = i - (STRIPES - 1) / 2;
    g.add(m);
  }
  return g;
}

interface Slot {
  group: THREE.Group;
  type: Standing | null;
}

export class SignMarkers {
  readonly group = new THREE.Group();
  private models = new Map<Standing, THREE.Group>();
  private slots: Slot[] = [];
  private crossings: THREE.Group[] = [];

  constructor() {
    const backMat = lit(0x3a4148, 0.1);
    for (const type of ['stop', 'give_way', 'speed_camera'] as const) this.models.set(type, panelModel(type, backMat));
    this.models.set('traffic_signals', trafficLightModel());
    for (let i = 0; i < POOL; i++) {
      const group = new THREE.Group();
      group.visible = false;
      this.group.add(group);
      this.slots.push({ group, type: null });
    }
    for (let i = 0; i < CROSSING_POOL; i++) {
      const g = crossingModel();
      g.visible = false;
      this.group.add(g);
      this.crossings.push(g);
    }
  }

  /** `heightAt(d)` is the road's height at `d` metres along the route, relative to the car. */
  update(signs: SignView[], origin: LatLon, along: number, heightAt: (d: number) => number) {
    let si = 0;
    let ci = 0;
    for (const s of signs) {
      const c = toLocal(origin, s.p);
      const b = toRad(s.bearing);
      const h = heightAt(s.along);
      if (s.type === 'crossing') {
        if (ci >= this.crossings.length) continue;
        const g = this.crossings[ci++];
        g.visible = true;
        g.position.set(c.x, h + 0.03, c.z);
        g.rotation.y = -b;
        continue;
      }
      if (s.type === 'bump' || s.type === 'hump' || s.type === 'table' || si >= this.slots.length) continue;
      const slot = this.slots[si++];
      if (slot.type !== s.type) {
        slot.group.clear();
        slot.group.add(this.models.get(s.type)!.clone());
        slot.type = s.type;
      }
      slot.group.visible = true;
      // At the kerb on our right, facing drivers coming along the route; a little bigger far away so it reads.
      slot.group.position.set(c.x + Math.cos(b) * KERB, h, c.z + Math.sin(b) * KERB);
      slot.group.rotation.y = -b;
      slot.group.scale.setScalar(THREE.MathUtils.clamp((s.along - along) / 45, 1, 2.2));
    }
    for (; si < this.slots.length; si++) this.slots[si].group.visible = false;
    for (; ci < this.crossings.length; ci++) this.crossings[ci].visible = false;
  }
}
