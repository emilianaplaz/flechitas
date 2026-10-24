// The 3D overlay drawn on top of the camera feed: a guide ribbon on the road, floating chevrons,
// a standing arrow plus roadside chevron signs at the next turn, a destination pin with a light
// beam, markers on reported hazards and the maqueta's road signs. With a maqueta elevation profile
// everything follows the road's slope; without one the road is flat.
import * as THREE from 'three';
import { bearingAt, pointAt, toDeg, toLocal, toRad, type LatLon, type Polyline } from '../core/geo.ts';
import type { Calib } from './calib.ts';
import type { Display } from '../core/state.ts';
import type { Step, TurnKind } from '../core/route.ts';
import { HAZARD_LABEL, type HazardType } from '../hazards/store.ts';
import type { HazardView } from '../hazards/ahead.ts';
import type { SignView } from '../signs/ahead.ts';
import { SignMarkers } from './signMarkers.ts';
import { mirrorCamera, virtualImage, type Optics } from './optics.ts';

const GUIDE = 0x00e676;
const GUIDE_SIDE = 0x00753c; // sides and bevels of guide objects, so their volume reads
const DEST = 0x22e07a;
const HAZARD = 0xff3b30;
const RIBBON_STEP = 2; // m between ribbon samples
const RIBBON_LEN = 160; // m of road ahead to draw
const RIBBON_LEN_HUD = 110; // shorter range in HUD mode to cut reflection clutter
const MAX_SAMPLES = Math.ceil(RIBBON_LEN / RIBBON_STEP) + 2;
const CHEVRON_EVERY = 8;
const MAX_CHEVRONS = Math.ceil(RIBBON_LEN / CHEVRON_EVERY);
// Chevrons lie almost flat close by and lean back further away, where a flat shape would vanish at the grazing angle.
const CHEVRON_TILT_NEAR = toRad(8);
const CHEVRON_TILT_FAR = toRad(40);
const TURN_SHOW = 300; // m before a turn where its arrow appears
const ARRIVE_SHOW = 500;
const GATE_SHOW = 200; // m before a turn where the roadside chevron signs appear
const GATE_SIGNS = 4;
const GATE_PAST = 7; // m past the turn point: roughly the far side of the junction
const ARROW_H = 2.4; // m, turn arrow and pin at scale 1
const ARROW_CLEAR = 2.8; // m from the road to the arrow's lowest point, above the roadside signs (at their scale 1)
const MIN_SCREEN = 0.08; // the turn arrow and pin never look smaller than this share of the screen height

export interface FrameInput {
  origin: LatLon; // point on the ground directly under the camera
  yaw: number; // camera heading, degrees from north
  poly: Polyline | null;
  along: number; // where the car is along the route
  next: Step | null;
  distToNext: number;
  hazards: HazardView[];
  calib: Calib;
  pose?: { pitch: number; roll: number }; // phone sensors: replaces the calibrated pitch and adds roll
  display?: Display;
  degraded?: boolean; // Safe fallback: GPS signal poor/stale -> hide ribbon, keep turn glyph
  mountRoll?: number; // fixed mount tilted sideways, degrees (measured by Auto); unused when `pose` is set
  /** Windshield HUD with exact optics: draw from the driver's eye through the glass (see optics.ts). */
  optics?: Optics | null;
  /** Car body pitch/roll relative to the road, degrees (braking dive, slopes); HUD optics only. */
  attitude?: { pitch: number; roll: number };
  /** Ground height in metres at a distance along the route (maqueta). Absent: flat road, as before. */
  elevAlong?: ((d: number) => number) | null;
  signs?: SignView[];
}

function arrowShape(): THREE.Shape {
  // Arrow pointing up (+y), ~2.4 m tall.
  const s = new THREE.Shape();
  s.moveTo(-0.35, -1.2);
  s.lineTo(0.35, -1.2);
  s.lineTo(0.35, 0.1);
  s.lineTo(0.9, 0.1);
  s.lineTo(0, 1.2);
  s.lineTo(-0.9, 0.1);
  s.lineTo(-0.35, 0.1);
  s.closePath();
  return s;
}

function uturnShape(): THREE.Shape {
  // Up the right leg, over the top, down the left leg into an arrowhead.
  const s = new THREE.Shape();
  s.moveTo(0.35, -1.2);
  s.lineTo(0.85, -1.2);
  s.lineTo(0.85, 0.35);
  s.absarc(0, 0.35, 0.85, 0, Math.PI, false);
  s.lineTo(-0.85, -0.4);
  s.lineTo(-1.15, -0.4);
  s.lineTo(-0.6, -1.2);
  s.lineTo(-0.05, -0.4);
  s.lineTo(-0.35, -0.4);
  s.lineTo(-0.35, 0.35);
  s.absarc(0, 0.35, 0.35, Math.PI, 0, true);
  s.closePath();
  return s;
}

function chevronShape(): THREE.Shape {
  // Pointing up (+y), 1.8 m wide.
  const s = new THREE.Shape();
  s.moveTo(-0.9, -0.3);
  s.lineTo(0, 0.5);
  s.lineTo(0.9, -0.3);
  s.lineTo(0.9, -0.75);
  s.lineTo(0, 0.05);
  s.lineTo(-0.9, -0.75);
  s.closePath();
  return s;
}

function signChevronShape(): THREE.Shape {
  // Roadside curve sign chevron, pointing right (+x).
  const s = new THREE.Shape();
  s.moveTo(-0.4, 0.55);
  s.lineTo(0.02, 0.55);
  s.lineTo(0.42, 0);
  s.lineTo(0.02, -0.55);
  s.lineTo(-0.4, -0.55);
  s.lineTo(0, 0);
  s.closePath();
  return s;
}

function roundedRect(w: number, h: number, r: number): THREE.Shape {
  const s = new THREE.Shape();
  const x = -w / 2;
  const y = -h / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r);
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  return s;
}

/** Extruded and bevelled, centred on z = 0. Group 0 is the front and back faces, group 1 the sides. */
function solid(shape: THREE.Shape, depth: number, bevel: number): THREE.ExtrudeGeometry {
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 2,
    curveSegments: 16,
  });
  geo.translate(0, 0, -depth / 2);
  return geo;
}

/** Lit, with enough self-glow to stay vivid over a bright camera picture. */
function lit(color: number, glow = 0.35, extra: THREE.MeshPhongMaterialParameters = {}): THREE.MeshPhongMaterial {
  return new THREE.MeshPhongMaterial({
    color,
    emissive: new THREE.Color(color).multiplyScalar(glow),
    shininess: 70,
    specular: 0x555555,
    ...extra,
  });
}

/** Map pin: a teardrop turned on a lathe, tip at y = -1.2, top at y = 1.15. */
function pinGeometry(): THREE.LatheGeometry {
  const r = 0.65;
  const c = 0.5;
  const tip = -1.2;
  const beta = Math.asin(r / (c - tip)); // half-angle of the cone at the tip
  const pts = [new THREE.Vector2(0.001, tip)];
  for (let k = 0; k <= 16; k++) {
    const a = -beta + ((Math.PI / 2 + beta) * k) / 16;
    pts.push(new THREE.Vector2(Math.max(0.001, r * Math.cos(a)), c + r * Math.sin(a)));
  }
  return new THREE.LatheGeometry(pts, 40);
}

/** Two rings on the road that keep expanding and fading. */
function pulseRings(color: number, radius: number): THREE.Group {
  const g = new THREE.Group();
  const geo = new THREE.RingGeometry(radius * 0.78, radius, 48).rotateX(-Math.PI / 2);
  for (let i = 0; i < 2; i++) {
    g.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, transparent: true, depthWrite: false, side: THREE.DoubleSide })));
  }
  g.position.y = 0.03;
  return g;
}

function animatePulse(g: THREE.Group, t: number) {
  g.children.forEach((ring, i) => {
    const p = (t / 1.6 + i / 2) % 1;
    ring.scale.setScalar(0.5 + p * 1.5);
    ((ring as THREE.Mesh).material as THREE.MeshBasicMaterial).opacity = (1 - p) * 0.85;
  });
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const easeOutBack = (x: number) => 1 + 2.70158 * (x - 1) ** 3 + 1.70158 * (x - 1) ** 2;
const smooth = (x: number) => 0.5 - 0.5 * Math.cos(2 * Math.PI * x); // 0 → 1 → 0 over one period

const KIND_ROTATION: Record<Exclude<TurnKind, 'arrive' | 'uturn'>, number> = {
  'straight': 0,
  'slight-left': 40,
  'left': 90,
  'sharp-left': 135,
  'slight-right': -40,
  'right': -90,
  'sharp-right': -135,
};

/** Turns that get roadside chevron signs: a real corner, not a fork or a U-turn. */
const GATE_KINDS = new Set<TurnKind>(['left', 'sharp-left', 'right', 'sharp-right']);

const sideOf = (kind: TurnKind) => (kind === 'uturn' || kind.includes('left') ? -1 : kind.includes('right') ? 1 : 0);

function labelTexture(text: string, bg: string): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = bg;
  g.beginPath();
  g.roundRect(4, 4, 504, 120, 24);
  g.fill();
  g.fillStyle = '#fff';
  g.font = 'bold 64px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, 256, 68, 480);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

interface Chevron {
  group: THREE.Group;
  body: THREE.Mesh;
  shadow: THREE.Mesh;
  mat: THREE.MeshPhongMaterial;
  sideMat: THREE.MeshPhongMaterial;
  shadowMat: THREE.MeshBasicMaterial;
}

interface GateSign {
  group: THREE.Group;
  chevron: THREE.Mesh;
  mat: THREE.MeshPhongMaterial;
}

export class ArScene {
  readonly renderer: THREE.WebGLRenderer;
  readonly camera = new THREE.PerspectiveCamera(40, 1, 0.3, 3000);
  private scene = new THREE.Scene();
  // Everything on the road. Identity for the camera overlay; for the windshield HUD with exact optics
  // it carries `reflection · worldToCar`, so the scene is drawn as the driver sees it in the glass.
  private world = new THREE.Group();
  private optics: Optics | null = null; // the optics the HUD camera was last built from
  private hudVfov = 0; // vertical angle the reflected picture covers, for readableScale

  private ribbonGeo = new THREE.BufferGeometry();
  private ribbonPos = new Float32Array(MAX_SAMPLES * 2 * 3);
  private ribbonCol = new Float32Array(MAX_SAMPLES * 2 * 4);
  private ribbon: THREE.Mesh;
  private chevrons: Chevron[] = [];

  // The next maneuver. Its bearings are worked out once, when it becomes the next step.
  private step: Step | null = null;
  private corner: LatLon | null = null;
  private cornerAlong = 0;
  private bearingIn = 0;
  private visibleSince: number | null = null;
  private gateSince: number | null = null; // the signs show up later than the arrow, with their own entrance

  private turn = new THREE.Group(); // at the turn point on the road, facing the driver
  private turnHead = new THREE.Group(); // the arrow, raised and scaled
  private turnArrows = new Map<TurnKind, THREE.Object3D>();
  private turnPulse: THREE.Group;

  private gate = new THREE.Group(); // roadside chevron signs across the far side of the junction
  private gateSigns: GateSign[] = [];

  private dest = new THREE.Group();
  private pin = new THREE.Group();
  private beam: THREE.Mesh;
  private destPulse: THREE.Group;

  private signMarkers = new SignMarkers();
  // Road height along the route for this frame, relative to the ground under the car.
  private elevAlong: ((d: number) => number) | null = null;
  private elevBase = 0;
  private heightAt = (d: number) => (this.elevAlong ? this.elevAlong(d) - this.elevBase : 0);

  private hazardPool: { group: THREE.Group; label: THREE.Sprite; pulse: THREE.Group; type: HazardType | null }[] = [];
  private labelMats = new Map<HazardType, THREE.SpriteMaterial>();

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x000000, 0);
    this.camera.rotation.order = 'YXZ';

    // Soft sky light, plus a key light that rides with the camera from above-left,
    // so fronts are always lit and sides fall into shade.
    this.world.add(new THREE.HemisphereLight(0xffffff, 0x334455, 1.4));
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(-2, 3, 2);
    key.target.position.set(0, 0, -4);
    this.camera.add(key, key.target);
    // The camera stays outside `world`: in the windshield HUD the world is reflected, the camera isn't.
    this.scene.add(this.camera, this.world);

    // Guide ribbon (vertex alpha fades it in and out).
    const idx: number[] = [];
    for (let i = 0; i < MAX_SAMPLES - 1; i++) {
      const a = i * 2;
      idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
    this.ribbonGeo.setIndex(idx);
    this.ribbonGeo.setAttribute('position', new THREE.BufferAttribute(this.ribbonPos, 3));
    this.ribbonGeo.setAttribute('color', new THREE.BufferAttribute(this.ribbonCol, 4));
    this.ribbon = new THREE.Mesh(
      this.ribbonGeo,
      new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide }),
    );
    this.ribbon.frustumCulled = false;
    this.world.add(this.ribbon);

    // Chevrons floating just above the road, tip toward -z (forward), each with a shadow.
    // Both pivot on the chevron's tail so tilting raises the tip.
    const chevGeo = solid(chevronShape(), 0.06, 0.03).rotateX(-Math.PI / 2).translate(0, 0, -0.75);
    const shadowGeo = new THREE.ShapeGeometry(chevronShape()).rotateX(-Math.PI / 2).translate(0, 0, -0.75);
    for (let i = 0; i < MAX_CHEVRONS; i++) {
      const mat = lit(0xffffff, 0.35, { transparent: true, depthWrite: false });
      mat.emissive.set(0x9fffc8);
      const sideMat = lit(GUIDE, 0.4, { transparent: true, depthWrite: false });
      const shadowMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, depthWrite: false, side: THREE.DoubleSide });
      const shadow = new THREE.Mesh(shadowGeo, shadowMat);
      shadow.position.set(0, 0.03, 0.6);
      const body = new THREE.Mesh(chevGeo, [mat, sideMat]);
      body.position.set(0, 0.12, 0.6);
      const group = new THREE.Group();
      group.add(shadow, body);
      group.visible = false;
      this.world.add(group);
      this.chevrons.push({ group, body, shadow, mat, sideMat, shadowMat });
    }

    // Turn arrows: one per kind, a bright face over darker bevelled sides, with a dark outline.
    const face = lit(GUIDE, 0.45);
    const side = lit(GUIDE_SIDE, 0.25);
    const outline = new THREE.MeshBasicMaterial({ color: 0x002a33, side: THREE.BackSide });
    const make = (shape: THREE.Shape, rotDeg: number) => {
      const geo = solid(shape, 0.45, 0.08);
      const g = new THREE.Group();
      const hull = new THREE.Mesh(geo, outline);
      hull.scale.set(1.06, 1.06, 1.3);
      g.add(new THREE.Mesh(geo, [face, side]), hull);
      g.rotation.z = toRad(rotDeg);
      g.visible = false;
      this.turnHead.add(g);
      return g;
    };
    for (const [kind, rot] of Object.entries(KIND_ROTATION)) {
      this.turnArrows.set(kind as TurnKind, make(arrowShape(), rot));
    }
    this.turnArrows.set('uturn', make(uturnShape(), 0));
    this.turnPulse = pulseRings(GUIDE, 2.2);
    this.turn.add(this.turnHead, this.turnPulse);
    this.turn.visible = false;
    this.world.add(this.turn);

    // Roadside chevron signs floating at eye level: see-through dark panel, bright chevron that lights up in sequence.
    // Translucent so the driver still sees the junction behind them.
    const panelGeo = solid(roundedRect(1.2, 1.4, 0.14), 0.08, 0.02);
    const signGeo = solid(signChevronShape(), 0.1, 0.02);
    const see = { transparent: true, depthWrite: false };
    const panelMat = [lit(0x0b1d2a, 0.15, { ...see, opacity: 0.35 }), lit(0x1c3346, 0.1, { ...see, opacity: 0.35 })];
    const signSide = lit(GUIDE_SIDE, 0.25, { ...see, opacity: 0.7 });
    for (let i = 0; i < GATE_SIGNS; i++) {
      const mat = lit(GUIDE, 0.5, { ...see, opacity: 0.8 });
      mat.emissive.set(GUIDE);
      const panel = new THREE.Mesh(panelGeo, panelMat);
      const chevron = new THREE.Mesh(signGeo, [mat, signSide]);
      chevron.position.z = 0.09;
      const group = new THREE.Group();
      group.position.y = 1.7; // scaled about its centre, so it pops in place
      group.add(panel, chevron);
      this.gate.add(group);
      this.gateSigns.push({ group, chevron, mat });
    }
    this.gate.visible = false;
    this.world.add(this.gate);

    // Destination: a spinning pin with a white dot, a light beam you can spot from far away, rings on the road.
    const pinMat = lit(DEST, 0.4);
    // The dot is a flattened lens on each face, so it stays flush when the pin turns side-on.
    const lensGeo = new THREE.SphereGeometry(0.3, 24, 12).scale(1, 1, 0.35);
    const lensMat = lit(0xffffff, 0.5);
    this.pin.add(new THREE.Mesh(pinGeometry(), pinMat));
    for (const z of [-0.6, 0.6]) {
      const lens = new THREE.Mesh(lensGeo, lensMat);
      lens.position.set(0, 0.5, z);
      this.pin.add(lens);
    }
    const beamGeo = new THREE.CylinderGeometry(0.5, 0.5, 40, 20, 8, true).translate(0, 20, 0);
    const beamPos = beamGeo.attributes.position;
    const beamCol = new Float32Array(beamPos.count * 4);
    const destRgb = new THREE.Color(DEST);
    for (let i = 0; i < beamPos.count; i++) {
      beamCol.set([destRgb.r, destRgb.g, destRgb.b, 0.5 * (1 - beamPos.getY(i) / 40) ** 1.5], i * 4);
    }
    beamGeo.setAttribute('color', new THREE.BufferAttribute(beamCol, 4));
    this.beam = new THREE.Mesh(
      beamGeo,
      new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide }),
    );
    this.destPulse = pulseRings(DEST, 2);
    this.dest.add(this.pin, this.beam, this.destPulse);
    this.dest.visible = false;
    this.world.add(this.dest, this.signMarkers.group);

    // Hazard markers: a traffic cone with a white band, a pulsing ring and a label.
    const red = lit(HAZARD, 0.35);
    const white = lit(0xffffff, 0.4);
    const coneGeo = new THREE.ConeGeometry(0.4, 1.0, 24);
    const bandGeo = new THREE.CylinderGeometry(0.17, 0.23, 0.15, 24);
    const baseGeo = new THREE.BoxGeometry(0.9, 0.06, 0.9);
    const baseMat = lit(0x5a0f0b, 0.2);
    for (let i = 0; i < 10; i++) {
      const group = new THREE.Group();
      const c = new THREE.Mesh(coneGeo, red);
      c.position.y = 0.53;
      const band = new THREE.Mesh(bandGeo, white);
      band.position.y = 0.555;
      const base = new THREE.Mesh(baseGeo, baseMat);
      base.position.y = 0.03;
      const pulse = pulseRings(HAZARD, 1.5);
      const label = new THREE.Sprite();
      label.position.y = 2.1;
      label.scale.set(3.2, 0.8, 1);
      group.add(c, band, base, pulse, label);
      group.visible = false;
      this.world.add(group);
      this.hazardPool.push({ group, label, pulse, type: null });
    }
  }

  private labelMat(type: HazardType): THREE.SpriteMaterial {
    let m = this.labelMats.get(type);
    if (!m) {
      m = new THREE.SpriteMaterial({ map: labelTexture(HAZARD_LABEL[type], 'rgba(220,30,30,0.92)'), depthTest: false });
      this.labelMats.set(type, m);
    }
    return m;
  }

  resize(w: number, h: number) {
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  update(f: FrameInput) {
    const { calib } = f;
    this.elevAlong = f.poly ? (f.elevAlong ?? null) : null;
    this.elevBase = this.elevAlong ? this.elevAlong(f.along) : 0;
    if (f.display === 'hud' && f.optics) this.placeHudCamera(f, f.optics);
    else {
      if (this.optics) this.leaveHudOptics();
      if (this.camera.fov !== calib.fov) {
        this.camera.fov = calib.fov;
        this.camera.updateProjectionMatrix();
      }
      this.camera.position.set(0, calib.height, 0);
      this.camera.rotation.y = -toRad(f.yaw + calib.yawOffset);
      // A calibrated mount tilts with the car: on a slope, add the road's grade under it.
      // Sensor pitch is already absolute.
      this.camera.rotation.x = -toRad(f.pose ? f.pose.pitch : calib.pitch - this.gradeDeg(f.along));
      this.camera.rotation.z = -toRad(f.pose ? f.pose.roll : (f.mountRoll ?? 0));
    }
    // Hazard labels are sprites, which don't mirror with the reflected world; the HUD banner says it instead.
    for (const slot of this.hazardPool) slot.label.visible = !this.optics;

    const now = performance.now() / 1000;
    this.updateRibbon(f, now);
    this.updateTurn(f, now);
    this.updateHazards(f, now);
    this.signMarkers.update(f.poly ? (f.signs ?? []) : [], f.origin, f.along, this.heightAt);
    this.renderer.render(this.scene, this.camera);
  }

  /**
   * Windshield HUD, exact optics: the camera is the driver's eye mirrored in the glass, looking at the
   * iPad's real rectangle (off-axis), and the world is reflected; mirror, perspective and keystone
   * come out of the projection. The world is turned to the car's heading and attitude around the eye.
   */
  private placeHudCamera(f: FrameInput, o: Optics) {
    if (o !== this.optics) {
      this.optics = o;
      const cam = mirrorCamera(o, 0.3, 3000);
      this.camera.matrixAutoUpdate = false;
      this.camera.matrix.copy(cam.matrixWorld);
      this.camera.projectionMatrix.copy(cam.projection);
      this.camera.projectionMatrixInverse.copy(cam.projection).invert();
      const img = virtualImage(o);
      this.hudVfov = img.highDeg - img.lowDeg;
      this.world.matrixAutoUpdate = false;
    }
    // World (local ENU around the car) -> car frame: heading, then the body's pitch and roll.
    const att = f.attitude ?? { pitch: 0, roll: 0 };
    const worldToCar = new THREE.Matrix4()
      .makeRotationZ(toRad(att.roll))
      .multiply(new THREE.Matrix4().makeRotationX(toRad(att.pitch)))
      .multiply(new THREE.Matrix4().makeRotationY(toRad(f.yaw)));
    this.world.matrix.multiplyMatrices(o.refl, worldToCar);
    this.world.matrixWorldNeedsUpdate = true;
  }

  private leaveHudOptics() {
    this.optics = null;
    this.camera.matrixAutoUpdate = true;
    this.camera.updateProjectionMatrix();
    this.world.matrix.identity();
    this.world.matrixAutoUpdate = true;
  }

  /** Slope of the road under the car, degrees (positive uphill), from the maqueta profile. */
  private gradeDeg(along: number): number {
    if (!this.elevAlong) return 0;
    return toDeg(Math.atan((this.elevAlong(along + 8) - this.elevAlong(along - 8)) / 16));
  }

  /** Scale at which something `height` metres tall, `dist` away, fills at least MIN_SCREEN of the screen. */
  private readableScale(dist: number, height: number, max: number): number {
    const vfov = this.optics ? this.hudVfov : this.camera.fov;
    const screen = 2 * Math.tan(toRad(vfov) / 2) * Math.max(0, dist);
    return THREE.MathUtils.clamp((MIN_SCREEN * screen) / height, 1, max);
  }

  private updateRibbon(f: FrameInput, now: number) {
    const { poly, degraded, display } = f;
    let count = 0;
    let chevI = 0;
    const isHud = display === 'hud';
    const activeLen = isHud ? RIBBON_LEN_HUD : RIBBON_LEN;

    if (poly && !degraded) {
      const end = Math.min(poly.length, f.along + activeLen);
      const half = f.calib.ribbonWidth / 2;
      const start = f.calib.ribbonStart;
      for (let d = f.along + start; d <= end && count < MAX_SAMPLES; d += RIBBON_STEP) {
        const c = toLocal(f.origin, pointAt(poly, d).p);
        const b = toRad(bearingAt(poly, d, 4));
        const tx = Math.sin(b);
        const tz = -Math.cos(b);
        const nx = tz; // left-hand normal
        const nz = -tx;
        const o = count * 6;
        const y = this.heightAt(d) + 0.02;
        this.ribbonPos.set([c.x + nx * half, y, c.z + nz * half, c.x - nx * half, y, c.z - nz * half], o);
        const ahead = d - f.along;
        // In HUD mode, higher opacity and saturated green for windshield reflection
        const alpha = isHud
          ? Math.min(1, (ahead - start) / 4) * Math.min(1, (end - d) / 16 + 0.25) * 0.92
          : Math.min(1, (ahead - start) / 6) * Math.min(1, (end - d) / 25 + 0.15) * 0.45;
        const ci = count * 8;
        if (isHud) {
          this.ribbonCol.set([0, 0.9, 0.46, alpha, 0, 0.9, 0.46, alpha], ci);
        } else {
          this.ribbonCol.set([0, 0.9, 1, alpha, 0, 0.9, 1, alpha], ci);
        }
        count++;

        // Chevrons at fixed spots along the road so they scroll naturally as you drive.
        if (Math.floor(d / CHEVRON_EVERY) !== Math.floor((d - RIBBON_STEP) / CHEVRON_EVERY) && chevI < MAX_CHEVRONS && ahead > 6) {
          const ch = this.chevrons[chevI++];
          ch.group.visible = true;
          ch.group.position.set(c.x, y - 0.02, c.z);
          ch.group.rotation.y = -b;
          const tilt = THREE.MathUtils.lerp(CHEVRON_TILT_NEAR, CHEVRON_TILT_FAR, clamp01((ahead - 10) / 50));
          ch.body.rotation.x = tilt;
          ch.shadow.scale.z = Math.cos(tilt);
          // Soft as they come into view, so the nearest ones never cover the road.
          const fade = isHud
            ? Math.max(0, 1.0 - ahead / activeLen)
            : clamp01((ahead - 6) / 18) * Math.max(0, 0.95 - ahead / RIBBON_LEN);
          ch.mat.opacity = fade;
          ch.sideMat.opacity = fade;
          ch.shadowMat.opacity = 0.3 * fade;
          // A glow that runs forward along the road, faster than the car, to show the way to go.
          const wave = Math.max(0, Math.sin(2 * Math.PI * (d / 48 - now * 0.9))) ** 3;
          ch.mat.emissiveIntensity = 0.35 + 0.65 * wave;
        }
      }
    }
    for (; chevI < MAX_CHEVRONS; chevI++) this.chevrons[chevI].group.visible = false;
    this.ribbonGeo.setDrawRange(0, Math.max(0, count - 1) * 6);
    this.ribbonGeo.attributes.position.needsUpdate = true;
    this.ribbonGeo.attributes.color.needsUpdate = true;
  }

  private updateTurn(f: FrameInput, now: number) {
    const step = f.next;
    if (step !== this.step) {
      this.step = step;
      this.visibleSince = null;
      this.gateSince = null;
      this.corner = null;
      if (step && f.poly) {
        this.corner = pointAt(f.poly, step.along).p;
        this.cornerAlong = step.along;
        this.bearingIn = bearingAt(f.poly, Math.max(0, step.along - 14), 12);
      }
    }
    const d = f.distToNext;
    const arrive = step?.kind === 'arrive';
    const show = !!step && !!this.corner && d < (arrive ? ARRIVE_SHOW : TURN_SHOW) && d > -5;
    this.turn.visible = show && !arrive;
    this.dest.visible = show && arrive;
    this.gate.visible = show && GATE_KINDS.has(step!.kind) && d < GATE_SHOW && d > -3;
    if (!this.gate.visible) this.gateSince = null;
    if (!show) {
      this.visibleSince = null;
      return;
    }
    this.visibleSince ??= now;
    const since = now - this.visibleSince;
    // Pops in when it first appears, shrinks away in the last few metres past the turn.
    const pop = easeOutBack(clamp01(since / 0.5)) * clamp01((d + 5) / 5);
    const c = toLocal(f.origin, this.corner!);
    const y = this.heightAt(this.cornerAlong);
    const s = this.readableScale(d, ARROW_H, 5);

    if (arrive) {
      this.dest.position.set(c.x, y, c.z);
      const ps = Math.max(1.5, s);
      this.pin.position.y = 1.3 * ps + 1.0 + 0.25 * ps * Math.sin(now * 2.2);
      this.pin.rotation.y = now * 1.2;
      this.pin.scale.setScalar(Math.max(0.001, ps * pop));
      // The beam is for spotting the destination from afar; up close the pin is enough.
      const beamWidth = THREE.MathUtils.clamp(d / 100, 1, 4);
      this.beam.scale.set(beamWidth, 1, beamWidth);
      (this.beam.material as THREE.MeshBasicMaterial).opacity = 0.25 + 0.75 * clamp01((d - 30) / 120);
      this.destPulse.scale.setScalar(Math.max(1, s * 0.6));
      animatePulse(this.destPulse, now);
      return;
    }

    const kind = step!.kind;
    const turnSide = sideOf(kind);
    for (const [k, obj] of this.turnArrows) obj.visible = k === kind;
    this.turn.position.set(c.x, y, c.z);
    this.turn.rotation.y = -toRad(f.yaw); // always face the driver
    const gateScale = this.readableScale(d, 2.8, 2.5);
    const lift = (ARROW_H / 2) * s + ARROW_CLEAR * gateScale;
    this.turnHead.position.y = lift;
    this.turnHead.scale.setScalar(Math.max(0.001, s * pop));
    // Swung a little so the tip points into the new street and the arrow's depth shows.
    this.turnHead.rotation.y = turnSide * 0.45;
    // Close to the turn the arrow nudges toward where to go.
    const arrow = this.turnArrows.get(kind)!;
    const nudge = d < 80 ? 0.3 * smooth(now / 0.9) : 0;
    const r = kind === 'uturn' ? Math.PI : toRad(KIND_ROTATION[kind as keyof typeof KIND_ROTATION]);
    arrow.position.set(-Math.sin(r) * nudge, Math.cos(r) * nudge, 0);
    this.turnPulse.scale.setScalar(s * 0.8);
    animatePulse(this.turnPulse, now);

    if (this.gate.visible) {
      this.gateSince ??= now;
      this.updateGate(c, y, gateScale, turnSide, d, now - this.gateSince, now);
    }
  }

  /** The signs stand across the road past the turn point, facing the driver's approach, chevrons toward the turn. */
  private updateGate(c: { x: number; z: number }, y: number, scale: number, turnSide: number, d: number, since: number, now: number) {
    const b = toRad(this.bearingIn);
    this.gate.position.set(c.x + Math.sin(b) * GATE_PAST, y, c.z - Math.cos(b) * GATE_PAST);
    this.gate.rotation.y = -b;
    this.gate.scale.setScalar(scale);
    this.gateSigns.forEach((sign, i) => {
      // Numbered toward the turn side, shifted a little to the outside of the curve.
      sign.group.position.x = turnSide * ((i - (GATE_SIGNS - 1) / 2) * 1.6 - 1);
      sign.chevron.scale.x = turnSide;
      // They pop in one after another, then light up in a wave toward the turn.
      const rise = easeOutBack(clamp01((since - i * 0.08) / 0.45)) * clamp01((d + 3) / 3);
      sign.group.scale.setScalar(Math.max(0.001, rise));
      const phase = (((now * 1.4 - i * 0.22) % 1) + 1) % 1;
      sign.mat.emissiveIntensity = 0.35 + 1.1 * Math.max(0, 1 - phase / 0.35);
    });
  }

  private updateHazards(f: FrameInput, now: number) {
    let i = 0;
    for (const h of f.hazards) {
      if (i >= this.hazardPool.length) break;
      const slot = this.hazardPool[i++];
      const c = toLocal(f.origin, h.p);
      slot.group.position.set(c.x, this.heightAt(h.along), c.z);
      slot.group.visible = true;
      animatePulse(slot.pulse, now + i * 0.3);
      if (slot.type !== h.type) {
        slot.label.material = this.labelMat(h.type);
        slot.type = h.type;
      }
    }
    for (; i < this.hazardPool.length; i++) this.hazardPool[i].group.visible = false;
  }
}
