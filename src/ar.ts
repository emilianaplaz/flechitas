// The 3D overlay drawn on top of the camera feed: a guide ribbon on the road,
// chevrons, a big arrow at the next turn and markers on reported hazards.
import * as THREE from 'three';
import { bearingAt, pointAt, toLocal, toRad, type LatLon, type Polyline } from './geo.ts';
import type { Calib } from './calib.ts';
import type { Step, TurnKind } from './route.ts';
import { HAZARD_LABEL, type HazardType } from './hazards.ts';

const GUIDE = 0x00e5ff;
const RIBBON_STEP = 2; // m between ribbon samples
const RIBBON_LEN = 160; // m of road ahead to draw
const MAX_SAMPLES = Math.ceil(RIBBON_LEN / RIBBON_STEP) + 2;
const CHEVRON_EVERY = 8;
const MAX_CHEVRONS = Math.ceil(RIBBON_LEN / CHEVRON_EVERY);

export interface HazardView {
  p: LatLon;
  type: HazardType;
}

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

const KIND_ROTATION: Record<Exclude<TurnKind, 'arrive' | 'uturn'>, number> = {
  'straight': 0,
  'slight-left': 40,
  'left': 90,
  'sharp-left': 135,
  'slight-right': -40,
  'right': -90,
  'sharp-right': -135,
};

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

export class ArScene {
  readonly renderer: THREE.WebGLRenderer;
  readonly camera = new THREE.PerspectiveCamera(40, 1, 0.3, 3000);
  private scene = new THREE.Scene();

  private ribbonGeo = new THREE.BufferGeometry();
  private ribbonPos = new Float32Array(MAX_SAMPLES * 2 * 3);
  private ribbonCol = new Float32Array(MAX_SAMPLES * 2 * 4);
  private ribbon: THREE.Mesh;
  private chevrons: THREE.Mesh[] = [];

  private turn = new THREE.Group();
  private turnArrows = new Map<TurnKind, THREE.Object3D>();
  private turnRing: THREE.Mesh;

  private hazardPool: { group: THREE.Group; label: THREE.Sprite; type: HazardType | null }[] = [];
  private labelMats = new Map<HazardType, THREE.SpriteMaterial>();

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x000000, 0);
    this.camera.rotation.order = 'YXZ';

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
    this.scene.add(this.ribbon);

    // Chevrons lying on the road, pointing forward.
    const chev = new THREE.Shape();
    chev.moveTo(-0.9, -0.3);
    chev.lineTo(0, 0.5);
    chev.lineTo(0.9, -0.3);
    chev.lineTo(0.9, -0.75);
    chev.lineTo(0, 0.05);
    chev.lineTo(-0.9, -0.75);
    chev.closePath();
    const chevGeo = new THREE.ShapeGeometry(chev);
    chevGeo.rotateX(-Math.PI / 2); // lay flat, tip toward -z (forward)
    for (let i = 0; i < MAX_CHEVRONS; i++) {
      const m = new THREE.Mesh(
        chevGeo,
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, depthWrite: false, side: THREE.DoubleSide }),
      );
      m.visible = false;
      this.scene.add(m);
      this.chevrons.push(m);
    }

    // Turn arrows: one mesh per kind, standing up at the maneuver point.
    const extrude = { depth: 0.25, bevelEnabled: false };
    const fill = new THREE.MeshBasicMaterial({ color: GUIDE, transparent: true, opacity: 0.92 });
    const edge = new THREE.LineBasicMaterial({ color: 0x002a33 });
    const make = (shape: THREE.Shape, rotDeg: number) => {
      const geo = new THREE.ExtrudeGeometry(shape, extrude);
      geo.translate(0, 0, -0.125);
      const g = new THREE.Group();
      g.add(new THREE.Mesh(geo, fill));
      g.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo), edge));
      g.rotation.z = toRad(rotDeg);
      g.visible = false;
      this.turn.add(g);
      return g;
    };
    for (const [kind, rot] of Object.entries(KIND_ROTATION)) {
      this.turnArrows.set(kind as TurnKind, make(arrowShape(), rot));
    }
    this.turnArrows.set('uturn', make(uturnShape(), 0));

    // Destination pin.
    const pin = new THREE.Group();
    const pinMat = new THREE.MeshBasicMaterial({ color: 0x22e07a });
    const cone = new THREE.Mesh(new THREE.ConeGeometry(0.6, 1.6, 24), pinMat);
    cone.rotation.x = Math.PI;
    cone.position.y = -0.4;
    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.75, 24, 16), pinMat);
    ball.position.y = 0.7;
    pin.add(cone, ball);
    pin.visible = false;
    this.turn.add(pin);
    this.turnArrows.set('arrive', pin);

    this.turnRing = new THREE.Mesh(
      new THREE.RingGeometry(1.6, 2.2, 48).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: GUIDE, transparent: true, opacity: 0.8, depthWrite: false, side: THREE.DoubleSide }),
    );
    this.scene.add(this.turn, this.turnRing);

    // Hazard markers.
    const red = new THREE.MeshBasicMaterial({ color: 0xff3b30 });
    const ringGeo = new THREE.RingGeometry(1.0, 1.5, 40).rotateX(-Math.PI / 2);
    const ringMat = new THREE.MeshBasicMaterial({ color: 0xff3b30, transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide });
    const coneGeo = new THREE.ConeGeometry(0.4, 1.0, 20);
    for (let i = 0; i < 10; i++) {
      const group = new THREE.Group();
      const c = new THREE.Mesh(coneGeo, red);
      c.position.y = 0.5;
      const ring = new THREE.Mesh(ringGeo, ringMat);
      ring.position.y = 0.03;
      const label = new THREE.Sprite();
      label.position.y = 2.1;
      label.scale.set(3.2, 0.8, 1);
      group.add(c, ring, label);
      group.visible = false;
      this.scene.add(group);
      this.hazardPool.push({ group, label, type: null });
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
    if (this.camera.fov !== calib.fov) {
      this.camera.fov = calib.fov;
      this.camera.updateProjectionMatrix();
    }
    this.camera.position.set(0, calib.height, 0);
    this.camera.rotation.y = -toRad(f.yaw + calib.yawOffset);
    this.camera.rotation.x = -toRad(f.pose ? f.pose.pitch : calib.pitch);
    this.camera.rotation.z = f.pose ? -toRad(f.pose.roll) : 0;

    this.updateRibbon(f);
    this.updateTurn(f);
    this.updateHazards(f);
    this.renderer.render(this.scene, this.camera);
  }

  private updateRibbon(f: FrameInput) {
    const { poly } = f;
    let count = 0;
    let chevI = 0;
    if (poly) {
      const end = Math.min(poly.length, f.along + RIBBON_LEN);
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
        this.ribbonPos.set([c.x + nx * half, 0.02, c.z + nz * half, c.x - nx * half, 0.02, c.z - nz * half], o);
        const ahead = d - f.along;
        const alpha = Math.min(1, (ahead - start) / 6) * Math.min(1, (end - d) / 25 + 0.15) * 0.45;
        const ci = count * 8;
        this.ribbonCol.set([0, 0.9, 1, alpha, 0, 0.9, 1, alpha], ci);
        count++;

        // Chevrons at fixed spots along the road so they scroll naturally as you drive.
        if (Math.floor(d / CHEVRON_EVERY) !== Math.floor((d - RIBBON_STEP) / CHEVRON_EVERY) && chevI < MAX_CHEVRONS && ahead > 6) {
          const m = this.chevrons[chevI++];
          m.visible = true;
          m.position.set(c.x, 0.04, c.z);
          m.rotation.y = -b;
          (m.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 0.9 - ahead / RIBBON_LEN);
        }
      }
    }
    for (; chevI < MAX_CHEVRONS; chevI++) this.chevrons[chevI].visible = false;
    this.ribbonGeo.setDrawRange(0, Math.max(0, count - 1) * 6);
    this.ribbonGeo.attributes.position.needsUpdate = true;
    this.ribbonGeo.attributes.color.needsUpdate = true;
  }

  private updateTurn(f: FrameInput) {
    const show = !!f.next && f.distToNext < 300 && f.distToNext > -5;
    for (const [kind, obj] of this.turnArrows) obj.visible = show && f.next!.kind === kind;
    this.turnRing.visible = show;
    if (!show || !f.next) return;
    const c = toLocal(f.origin, f.next.location);
    this.turn.position.set(c.x, 2.6, c.z);
    this.turn.rotation.y = -toRad(f.yaw); // always face the driver
    // Grow a little when far away so it stays readable, and pulse when close.
    const far = THREE.MathUtils.clamp(f.distToNext / 120, 1, 2.2);
    const pulse = f.distToNext < 60 ? 1 + 0.08 * Math.sin(performance.now() / 120) : 1;
    this.turn.scale.setScalar(far * pulse);
    this.turnRing.position.set(c.x, 0.03, c.z);
  }

  private updateHazards(f: FrameInput) {
    let i = 0;
    for (const h of f.hazards) {
      if (i >= this.hazardPool.length) break;
      const slot = this.hazardPool[i++];
      const c = toLocal(f.origin, h.p);
      slot.group.position.set(c.x, 0, c.z);
      slot.group.visible = true;
      if (slot.type !== h.type) {
        slot.label.material = this.labelMat(h.type);
        slot.type = h.type;
      }
    }
    for (; i < this.hazardPool.length; i++) this.hazardPool[i].group.visible = false;
  }
}
