// The 3D overlay drawn on top of the camera feed: a guide ribbon on the road, floating chevrons,
// a standing arrow plus roadside chevron signs at the next turn, a destination pin over a glow on the
// ground, markers on reported hazards and the maqueta's road signs. With a maqueta elevation profile
// everything follows the road's slope; without one the road is flat.
import * as THREE from 'three';
import { angleDiff, bearingAt, pointAt, toDeg, toLocal, toRad, type LatLon, type Polyline } from '../core/geo.ts';
import type { Calib } from './calib.ts';
import type { Display } from '../core/state.ts';
import type { Step, TurnKind } from '../core/route.ts';
import { HAZARD_LABEL, type HazardType } from '../hazards/store.ts';
import type { HazardView } from '../hazards/ahead.ts';
import type { SignView } from '../signs/ahead.ts';
import { SignMarkers } from './signMarkers.ts';
import { Scenery } from './scenery.ts';
import type { Tile } from '../core/maqueta.ts';
import { mirrorCamera, virtualImage, type Optics } from './optics.ts';

const GUIDE = 0x00e676;
const GUIDE_SIDE = 0x00753c; // sides and bevels of guide objects, so their volume reads
const DEST = 0x22e07a;
const HAZARD = 0xff3b30;
const BUMP_AMBER = 0xffb020; // speed bumps: their rings and label, apart from the red of a pothole
const BUMP_WIDE = 3.6; // m across the road
const BUMP_R = 0.6; // m: half its length along the road
const BUMP_H = 0.2; // m tall: a little more than a real one, so it reads from the driver's seat
const RIBBON_STEP = 2; // m between ribbon samples
const RIBBON_LEN = 90; // m of road ahead to draw over the camera: one lane-wide band that ends in a ring
const RIBBON_LEN_HUD = 110; // the windshield HUD reaches a little further
const MAX_SAMPLES = Math.ceil(Math.max(RIBBON_LEN, RIBBON_LEN_HUD) / RIBBON_STEP) + 2;
// The band: cyan over the camera, uniform, fading only at its far end. Green in the HUD, for the glass.
const BAND_RGB = [0.3, 0.82, 1] as const;
const BAND_ALPHA = 0.5;
const BAND_RGB_HUD = [0, 0.9, 0.46] as const;
const BAND_ALPHA_HUD = 0.92;
const BAND_FADE = 8; // m at the far end where band and chevrons fade out
// Chevrons painted on the band, at fixed spots so they scroll as you drive.
const CHEVRON_EVERY = 5;
const MAX_CHEVRONS = Math.ceil(Math.max(RIBBON_LEN, RIBBON_LEN_HUD) / CHEVRON_EVERY);
const CHEVRON_WIDTH = 0.82; // share of the band's width
const CHEVRON_LONG = 2.4; // stretch along the road: painted marks are long, so they read in perspective
const CHEVRON = 0x8ff0ff;
const CHEVRON_HUD = 0x7dffb8;
// Where the road turns away from the driver's view, a flat chevron is seen edge-on and seems to point
// somewhere else: between these angles off the view it fades out, and the turn arrow shows the way.
const CHEVRON_SIDE_FROM = 18;
const CHEVRON_SIDE_GONE = 32;
const CORNER_SMOOTH = 5; // m each side of a point over which the band's direction is averaged: rounded corners
const END_RING = 0.6; // radius of the ring at the band's end, as a share of the band's width
// Where the route itself ends inside the band: band and chevrons turn to the destination's green, the
// band stops sharp and a chequered finish line crosses it.
const FINISH_TINT = 40; // m before the end over which band and chevrons turn green
const FINISH_GAP = 4; // m before the finish line with no chevron, so it reads on its own
const FINISH_LONG = 3; // m along the road: long enough to read from afar
const FINISH_RISE = 0.3; // m: the finish line is a raised block, so it stands out of the road
const FINISH_GREEN = 0x5cf59a;
const FINISH_BAND = [0.2, 0.9, 0.5] as const;
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
  /** Exact arrival point picked in the maqueta (an entrance): the destination marker stands there. */
  arrival?: { p: LatLon } | null;
  /** Name shown on the destination card ("Edif. A · Frente al edificio", or the destination's). */
  destLabel?: string | null;
  /** Maqueta tiles to draw as the 3D street behind the overlay where the car is inside them (Simulación). Not in the HUD. */
  scenery?: Tile[] | null;
}

const AURA_R = 3.2; // m: radius of the glow on the ground at the destination, at scale 1
const CARD_W = 6.4; // m: destination card, at scale 1
const CARD_H = 1.7;

/** Finish line: three rows of squares, white and the destination's green. */
function finishTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 96;
  const g = c.getContext('2d')!;
  for (let col = 0; col < 8; col++) {
    for (let row = 0; row < 3; row++) {
      g.fillStyle = (col + row) % 2 ? '#22e07a' : '#ffffff';
      g.fillRect(col * 32, row * 32, 32, 32);
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Speed bump paint: yellow and black blocks across the road (v runs across it on the bump). */
function bumpTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 16;
  c.height = 256;
  const g = c.getContext('2d')!;
  for (let k = 0; k < 8; k++) {
    g.fillStyle = k % 2 ? '#1b1d20' : '#ffc61a';
    g.fillRect(0, k * 32, 16, 32);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** A speed bump lying across the road: half a cylinder along x, flattened, its ends closed. */
function bumpGeometry(): THREE.BufferGeometry {
  return new THREE.CylinderGeometry(BUMP_R, BUMP_R, BUMP_WIDE, 32, 1, false, -Math.PI / 2, Math.PI)
    .rotateX(-Math.PI / 2) // the half on +z now bulges up, axis along the road
    .rotateY(Math.PI / 2) // axis across the road
    .scale(1, BUMP_H / BUMP_R, 1);
}

/** Soft round glow: opaque white in the middle, transparent at the edge (tinted by the material). */
function glowTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.35, 'rgba(255,255,255,0.55)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

/** A finish flag, drawn in `color` inside a box of side `size` at (x, y). */
function drawFlag(g: CanvasRenderingContext2D, x: number, y: number, size: number, color: string) {
  const u = size / 10;
  g.fillStyle = color;
  g.beginPath();
  g.roundRect(x + 2 * u, y + 1 * u, 1.1 * u, 8.2 * u, 0.5 * u); // pole
  g.fill();
  g.beginPath(); // waving cloth
  g.moveTo(x + 3 * u, y + 1.4 * u);
  g.quadraticCurveTo(x + 5.5 * u, y + 0.4 * u, x + 8.4 * u, y + 1.8 * u);
  g.lineTo(x + 8.4 * u, y + 5.6 * u);
  g.quadraticCurveTo(x + 5.5 * u, y + 4.2 * u, x + 3 * u, y + 5.2 * u);
  g.closePath();
  g.fill();
}

/** Face of the pin: white disc with the flag in the destination colour. */
function pinFaceTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = '#fff';
  g.beginPath();
  g.arc(64, 64, 62, 0, 2 * Math.PI);
  g.fill();
  drawFlag(g, 30, 28, 72, '#13a85a');
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Destination card: dark glass with a green edge, the flag in a green disc, the name and how far it is. */
function drawDestCard(c: HTMLCanvasElement, name: string, sub: string) {
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, c.width, c.height);
  g.fillStyle = 'rgba(6, 24, 34, 0.9)';
  g.strokeStyle = '#22e07a';
  g.lineWidth = 6;
  g.beginPath();
  g.roundRect(6, 6, c.width - 12, c.height - 12, 40);
  g.fill();
  g.stroke();
  g.fillStyle = '#22e07a';
  g.beginPath();
  g.arc(100, c.height / 2, 58, 0, 2 * Math.PI);
  g.fill();
  drawFlag(g, 62, c.height / 2 - 38, 76, '#fff');
  g.textBaseline = 'middle';
  g.fillStyle = '#fff';
  g.font = 'bold 60px system-ui, sans-serif';
  g.fillText(name, 186, c.height / 2 - 30, c.width - 220);
  g.fillStyle = '#7dffb8';
  g.font = '600 46px system-ui, sans-serif';
  g.fillText(sub, 186, c.height / 2 + 38, c.width - 220);
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

/** Road-paint chevron pointing up (+y): 2 m wide, 1.2 m long, thick arms. */
function roadChevronShape(): THREE.Shape {
  const s = new THREE.Shape();
  s.moveTo(-1, -0.2);
  s.lineTo(0, 0.5);
  s.lineTo(1, -0.2);
  s.lineTo(1, -0.7);
  s.lineTo(0, 0);
  s.lineTo(-1, -0.7);
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
  mat: THREE.MeshBasicMaterial;
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
  private endRing: THREE.Mesh;
  private finish: THREE.Mesh; // at the route's end: the raised chequered line
  private tint = new THREE.Color();

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

  // Destination, at the entrance itself: a glow on the ground, rings, a floating pin with a flag and,
  // over the camera, a card with its name and distance.
  private dest = new THREE.Group();
  private pin = new THREE.Group();
  private destPulse: THREE.Group;
  private aura: THREE.Mesh;
  private pinShadow: THREE.Mesh;
  private card: THREE.Sprite;
  private cardCanvas = document.createElement('canvas');
  private cardText = '';
  private cardProbe = new THREE.Vector3();

  private signMarkers = new SignMarkers();
  private scenery = new Scenery();
  // Road height along the route for this frame, relative to the ground under the car.
  private elevAlong: ((d: number) => number) | null = null;
  private elevBase = 0;
  private heightAt = (d: number) => (this.elevAlong ? this.elevAlong(d) - this.elevBase : 0);

  // Hazards: a traffic cone for a pothole or a checkpoint; a speed bump is drawn as the bump itself.
  private hazardPool: { group: THREE.Group; cone: THREE.Group; bump: THREE.Mesh; label: THREE.Sprite; pulse: THREE.Group; bumpPulse: THREE.Group; type: HazardType | null }[] = [];
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

    // Chevrons painted on the band, tip toward -z (forward), drawn over it. Centred, so they turn and
    // stand up in place where the road goes sideways (see updateRibbon).
    const chevGeo = new THREE.ShapeGeometry(roadChevronShape()).rotateX(-Math.PI / 2).translate(0, 0, -0.15);
    for (let i = 0; i < MAX_CHEVRONS; i++) {
      const mat = new THREE.MeshBasicMaterial({ color: CHEVRON, transparent: true, depthWrite: false, side: THREE.DoubleSide });
      const body = new THREE.Mesh(chevGeo, mat);
      body.renderOrder = 1;
      const group = new THREE.Group();
      group.add(body);
      group.visible = false;
      this.world.add(group);
      this.chevrons.push({ group, body, mat });
    }
    // Ring on the road where the band ends.
    this.endRing = new THREE.Mesh(
      new THREE.RingGeometry(0.72, 1, 48).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: CHEVRON, transparent: true, opacity: 1, depthWrite: false, side: THREE.DoubleSide }),
    );
    this.endRing.renderOrder = 1;
    this.endRing.visible = false;
    this.world.add(this.endRing);
    // Where the route ends: a chequered block raised off the road across the band, lit so its top and
    // front read apart.
    const checks = finishTexture();
    this.finish = new THREE.Mesh(
      new THREE.BoxGeometry(1, FINISH_RISE, FINISH_LONG).translate(0, FINISH_RISE / 2, 0),
      new THREE.MeshPhongMaterial({ map: checks, emissive: 0xffffff, emissiveMap: checks, emissiveIntensity: 0.45, shininess: 40 }),
    );
    this.finish.visible = false;
    this.world.add(this.finish);

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

    // Destination pin: a glossy green teardrop with a white face showing a flag, front and back.
    this.pin.add(new THREE.Mesh(pinGeometry(), lit(DEST, 0.35, { shininess: 120, specular: 0x88ffcc })));
    const faceGeo = new THREE.CircleGeometry(0.46, 40);
    const faceMat = new THREE.MeshBasicMaterial({ map: pinFaceTexture() });
    for (const z of [0.68, -0.68]) { // just outside the head (radius 0.65), so the face is flat and whole
      const face = new THREE.Mesh(faceGeo, faceMat);
      face.position.set(0, 0.5, z);
      if (z < 0) face.rotation.y = Math.PI;
      this.pin.add(face);
    }
    const glow = glowTexture();
    this.aura = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: DEST, map: glow, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
    );
    this.aura.position.y = 0.04;
    this.pinShadow = new THREE.Mesh(
      new THREE.PlaneGeometry(1.6, 1.6).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0x000000, map: glow, transparent: true, opacity: 0.35, depthWrite: false }),
    );
    this.pinShadow.position.y = 0.05;
    this.cardCanvas.width = 1024;
    this.cardCanvas.height = 272;
    const cardTex = new THREE.CanvasTexture(this.cardCanvas);
    cardTex.colorSpace = THREE.SRGBColorSpace;
    this.card = new THREE.Sprite(new THREE.SpriteMaterial({ map: cardTex, depthTest: false, transparent: true }));
    this.card.renderOrder = 2;
    this.destPulse = pulseRings(DEST, 2);
    this.dest.add(this.aura, this.pinShadow, this.destPulse, this.pin, this.card);
    this.dest.visible = false;
    this.world.add(this.dest, this.signMarkers.group);

    // Hazard markers: a traffic cone with a white band (or a striped bump), a pulsing ring and a label.
    const bumpGeo = bumpGeometry();
    const bumpMap = bumpTexture();
    const bumpMat = new THREE.MeshPhongMaterial({ map: bumpMap, emissive: 0xffffff, emissiveMap: bumpMap, emissiveIntensity: 0.3, shininess: 30 });
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
      const cone = new THREE.Group();
      cone.add(c, band, base);
      const bump = new THREE.Mesh(bumpGeo, bumpMat);
      const pulse = pulseRings(HAZARD, 1.5);
      const bumpPulse = pulseRings(BUMP_AMBER, 2.2);
      const label = new THREE.Sprite();
      label.position.y = 2.1;
      label.scale.set(3.2, 0.8, 1);
      group.add(cone, bump, pulse, bumpPulse, label);
      group.visible = false;
      this.world.add(group);
      this.hazardPool.push({ group, cone, bump, label, pulse, bumpPulse, type: null });
    }
  }

  private labelMat(type: HazardType): THREE.SpriteMaterial {
    let m = this.labelMats.get(type);
    if (!m) {
      const bg = type === 'policia' ? 'rgba(214,128,0,0.94)' : 'rgba(220,30,30,0.92)';
      m = new THREE.SpriteMaterial({ map: labelTexture(HAZARD_LABEL[type], bg), depthTest: false });
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
    this.updateRibbon(f);
    this.updateTurn(f, now);
    this.updateHazards(f, now);
    this.signMarkers.update(f.poly ? (f.signs ?? []) : [], f.origin, f.along, this.heightAt);
    // Opaque where the car is inside the maqueta: it covers the camera picture. Elsewhere, as before.
    const scenery = this.scenery.set(f.scenery ?? null) && !this.optics && f.display !== 'hud' && !!f.poly && this.scenery.covers(f.origin);
    if (scenery) {
      // The overlay always draws over the street, as it does over the camera picture.
      this.scenery.place(f.origin, this.elevAlong ? this.elevBase : null);
      this.scene.updateMatrixWorld(); // the camera lives in the overlay scene; this pass needs its pose already
      this.renderer.autoClear = true; // clears to the scenery's sky
      this.renderer.render(this.scenery.scene, this.camera);
      this.renderer.clearDepth();
    }
    this.renderer.autoClear = !scenery;
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

  private updateRibbon(f: FrameInput) {
    const { poly, degraded, display } = f;
    let count = 0;
    let chevI = 0;
    const isHud = display === 'hud';
    const activeLen = isHud ? RIBBON_LEN_HUD : RIBBON_LEN;
    const [r, g, bl] = isHud ? BAND_RGB_HUD : BAND_RGB;
    const bandAlpha = isHud ? BAND_ALPHA_HUD : BAND_ALPHA;
    const paint = isHud ? CHEVRON_HUD : CHEVRON;
    let last: { x: number; y: number; z: number } | null = null;
    let end = 0;
    let finishes = false; // the route ends inside the band

    if (poly && !degraded) {
      end = Math.min(poly.length, f.along + activeLen);
      finishes = end >= poly.length - 0.01;
      const half = f.calib.ribbonWidth / 2;
      const start = f.calib.ribbonStart;
      // Every RIBBON_STEP, plus a last sample exactly at the end so the band stops where the route does.
      for (let k = 0, d = f.along + start; count < MAX_SAMPLES; k++, d = f.along + start + k * RIBBON_STEP) {
        if (d > end) {
          if (!finishes || d - RIBBON_STEP >= end - 0.01) break;
          d = end;
        }
        const c = toLocal(f.origin, pointAt(poly, d).p);
        // Direction averaged around d, so a sharp corner becomes a curve and the band doesn't fold over itself.
        const b = toRad(bearingAt(poly, Math.max(0, d - CORNER_SMOOTH), 2 * CORNER_SMOOTH));
        const tx = Math.sin(b);
        const tz = -Math.cos(b);
        const nx = tz; // left-hand normal
        const nz = -tx;
        const o = count * 6;
        const y = this.heightAt(d) + 0.02;
        this.ribbonPos.set([c.x + nx * half, y, c.z + nz * half, c.x - nx * half, y, c.z - nz * half], o);
        const ahead = d - f.along;
        const toEnd = poly.length - d;
        // Uniform from under the bonnet, fading only at the far end; sharp at the route's end.
        const fade = finishes ? 1 : clamp01((end - d) / BAND_FADE);
        const alpha = fade * bandAlpha;
        // Over the camera the band turns green as the end of the route nears (the HUD's is green already).
        const near = finishes && !isHud ? clamp01(1 - toEnd / FINISH_TINT) : 0;
        const [cr, cg, cb] = [r + (FINISH_BAND[0] - r) * near, g + (FINISH_BAND[1] - g) * near, bl + (FINISH_BAND[2] - bl) * near];
        this.ribbonCol.set([cr, cg, cb, alpha, cr, cg, cb, alpha], count * 8);
        count++;
        last = { x: c.x, y, z: c.z };

        // Chevrons at fixed spots along the road so they scroll naturally as you drive.
        const chevronHere = Math.floor(d / CHEVRON_EVERY) !== Math.floor((d - RIBBON_STEP) / CHEVRON_EVERY);
        if (chevronHere && chevI < MAX_CHEVRONS && ahead > start + 1 && !(finishes && toEnd < FINISH_GAP)) {
          const ch = this.chevrons[chevI++];
          ch.group.visible = true;
          ch.group.position.set(c.x, y, c.z);
          // Painted flat on the band, along the road.
          ch.group.rotation.y = -b;
          ch.body.scale.set((f.calib.ribbonWidth * CHEVRON_WIDTH) / 2, 1, CHEVRON_LONG);
          ch.body.position.y = 0.02;
          const off = Math.abs(angleDiff(f.yaw, toDeg(b)));
          const sideways = THREE.MathUtils.smoothstep(off, CHEVRON_SIDE_FROM, CHEVRON_SIDE_GONE);
          // Nearing the end of the route they turn to the destination's green (white in the green HUD).
          const tint = finishes ? clamp01(1 - toEnd / FINISH_TINT) : 0;
          ch.mat.color.set(paint).lerp(this.tint.set(isHud ? 0xffffff : FINISH_GREEN), tint);
          ch.mat.opacity = 0.9 * fade * (1 - sideways);
          ch.group.visible = sideways < 1;
        }
      }
    }
    for (; chevI < MAX_CHEVRONS; chevI++) this.chevrons[chevI].group.visible = false;
    // The ring marks where the band ends; at the destination the pin does instead.
    const ring = this.endRing;
    ring.visible = !!last && !!poly && count > 4 && end < poly.length - 1;
    if (ring.visible && last) {
      ring.position.set(last.x, last.y + 0.01, last.z);
      ring.scale.setScalar(f.calib.ribbonWidth * END_RING);
      (ring.material as THREE.MeshBasicMaterial).color.set(paint);
    }
    // The finish line, across the band at the route's end.
    this.finish.visible = finishes && !!poly && count > 1;
    if (this.finish.visible && poly) {
      const at = Math.max(0, poly.length - FINISH_LONG / 2);
      const c = toLocal(f.origin, pointAt(poly, at).p);
      this.finish.position.set(c.x, this.heightAt(at), c.z);
      this.finish.rotation.y = -toRad(bearingAt(poly, Math.max(0, poly.length - 2 * CORNER_SMOOTH), 2 * CORNER_SMOOTH));
      this.finish.scale.x = f.calib.ribbonWidth;
    }
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
    const c = toLocal(f.origin, arrive && f.arrival ? f.arrival.p : this.corner!);
    const y = this.heightAt(this.cornerAlong);
    const s = this.readableScale(d, ARROW_H, 5);

    if (arrive) {
      this.updateDest(f, c, y, d, s, pop, now);
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

  /** The destination marker at the entrance, `d` metres of route away. */
  private updateDest(f: FrameInput, c: { x: number; z: number }, y: number, d: number, s: number, pop: number, now: number) {
    this.dest.position.set(c.x, y, c.z);
    const ps = Math.max(1.5, s);
    // The pin floats over the entrance, facing the driver, swaying a little; its shadow breathes with it.
    const bob = Math.sin(now * 2.2);
    const pinY = 1.3 * ps + 0.8 + 0.2 * ps * bob;
    this.pin.position.y = pinY;
    this.pin.rotation.y = -toRad(f.yaw) + 0.25 * Math.sin(now * 1.3);
    this.pin.scale.setScalar(Math.max(0.001, ps * pop));
    this.pinShadow.scale.setScalar(ps * (0.9 - 0.12 * bob));
    // The glow marks the spot on the ground; it breathes slowly.
    const glow = Math.max(1, s * 0.6);
    this.aura.scale.setScalar(AURA_R * glow * (0.95 + 0.05 * Math.sin(now * 1.6)));
    (this.aura.material as THREE.MeshBasicMaterial).opacity = 0.55 + 0.2 * Math.sin(now * 1.6);
    this.destPulse.scale.setScalar(glow);
    animatePulse(this.destPulse, now);
    // The card is a sprite, which doesn't mirror with the reflected world: not in the windshield HUD.
    this.card.visible = !this.optics;
    if (!this.card.visible) return;
    const step = d < 100 ? 5 : 10;
    const sub = d < 8 ? 'Llegaste' : `Llegada · ${Math.round(Math.max(0, d) / step) * step} m`;
    const text = `${f.destLabel || 'Destino'}|${sub}`;
    if (text !== this.cardText) {
      this.cardText = text;
      drawDestCard(this.cardCanvas, f.destLabel || 'Destino', sub);
      (this.card.material as THREE.SpriteMaterial).map!.needsUpdate = true;
    }
    const cs = this.readableScale(d, CARD_H, 14) * pop;
    this.card.scale.set(CARD_W * cs, CARD_H * cs, 1);
    // Over the pin; up close, where that would be above the top of the picture, beside the pin's head
    // instead, on the side of the screen with more room.
    const h = CARD_H * cs;
    const top = f.calib.height + Math.hypot(c.x, c.z) * Math.tan(toRad(this.camera.fov / 2 - f.calib.pitch)) * 0.9 - y;
    const above = pinY + 1.2 * ps + 0.5 + h / 2;
    if (above + h / 2 <= top) {
      this.card.center.set(0.5, 0.5);
      this.card.position.y = above;
    } else {
      const onRight = this.cardProbe.set(c.x, y, c.z).project(this.camera).x > 0;
      this.card.center.set(onRight ? 1.08 : -0.08, 0.5);
      this.card.position.y = Math.min(pinY + 0.5 * ps, top - h / 2);
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
      const isBump = h.type === 'policia';
      // A bump lies across our lane, on the route line where it was reported; a cone stands where it was.
      const at = isBump && f.poly ? pointAt(f.poly, h.along).p : h.p;
      const c = toLocal(f.origin, at);
      slot.group.position.set(c.x, this.heightAt(h.along), c.z);
      slot.group.rotation.y = isBump && f.poly ? -toRad(bearingAt(f.poly, Math.max(0, h.along - CORNER_SMOOTH), 2 * CORNER_SMOOTH)) : 0;
      slot.group.visible = true;
      animatePulse(isBump ? slot.bumpPulse : slot.pulse, now + i * 0.3);
      if (slot.type !== h.type) {
        slot.label.material = this.labelMat(h.type);
        slot.cone.visible = slot.pulse.visible = !isBump;
        slot.bump.visible = slot.bumpPulse.visible = isBump;
        slot.label.position.y = isBump ? 1.4 : 2.1;
        slot.type = h.type;
      }
    }
    for (; i < this.hazardPool.length; i++) this.hazardPool[i].group.visible = false;
  }
}
