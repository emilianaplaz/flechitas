// Quick logic tests: `npm test` (Node 22+). No browser needed.
import { angleDiff, bearing, bearingAt, buildPolyline, decodeGeohash, haversine, offset, pointAt, project } from '../src/core/geo.ts';
import { extractUrl, parseInput } from '../src/core/links.ts';
// Minimal localStorage for the upload-queue tests (Node has none).
const mem = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
} as Storage;
import { cancel, enqueue, flush, pending } from '../src/hazards/cloud.ts';
import { BumpDetector } from '../src/hazards/bump.ts';
import { poseFromEuler } from '../src/walk/orientation.ts';
import { describe, formatDistance } from '../src/core/route.ts';
import { defaultsFor, loadCalib, loadFlip, saveCalib, saveFlip } from '../src/render/calib.ts';
import { DEFAULT_LENS_HFOV, TiltWindow, steadyMean, visibleVfov } from '../src/render/autocalib.ts';
import { decodeRoute, encodeRoute, formatCode, hudPeerId, newHudCode, normalizeCode } from '../src/remote/protocol.ts';
import { interfaceAngle, physicalAngle, uprightPlan } from '../src/remote/orient.ts';
import { Vector3, Vector4 } from 'three';
import { FORTUNER_2015, applyHomography, buildOptics, mirrorCamera, panelTransform, placementAdvice, reflectMatrix, virtualImage, worldToCss } from '../src/render/optics.ts';
import { RouteProfile, gridPoint, limitAt, speedLimits, tileElevation, tileOf, tileToLatLon, tileXY, type Tile, type TileSign, type TileWay } from '../src/core/maqueta.ts';
import { indexSigns, signsAhead } from '../src/signs/ahead.ts';

let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : `  ${detail}`}`);
  if (!ok) failed++;
}
const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

// ---- geo ----
const caracas = { lat: 10.4806, lon: -66.9036 };
check('haversine ~111 m per 0.001° lat', near(haversine(caracas, { lat: 10.4816, lon: -66.9036 }), 110.6, 1));
check('bearing east = 90', near(bearing(caracas, { lat: 10.4806, lon: -66.9 }), 90, 0.5));
check('bearing north = 0', near(bearing(caracas, { lat: 10.49, lon: -66.9036 }), 0, 0.5));
check('bearing south-west = 225', near(bearing(caracas, offset(caracas, 225, 100)), 225, 0.5));
check('offset 100 m', near(haversine(caracas, offset(caracas, 37, 100)), 100, 0.5));
check('angleDiff wraps', angleDiff(350, 10) === 20 && angleDiff(10, 350) === -20);

// L-shaped route: 200 m east, then 100 m north.
const corner = offset(caracas, 90, 200);
const end = offset(corner, 0, 100);
const poly = buildPolyline([caracas, corner, end]);
check('polyline length 300 m', near(poly.length, 300, 1), String(poly.length));
const pr = project(poly, offset(offset(caracas, 90, 50), 180, 7));
check('projection along 50 m, 7 m off', near(pr.along, 50, 1) && near(pr.dist, 7, 0.5), JSON.stringify(pr));
const pr2 = project(poly, offset(corner, 0, 40), 0);
check('projection on second leg', near(pr2.along, 240, 1), String(pr2.along));
check('pointAt 250 m is on second leg', near(haversine(pointAt(poly, 250).p, offset(corner, 0, 50)), 0, 0.5));
check('bearingAt first leg = 90', near(bearingAt(poly, 50), 90, 1));
check('bearingAt second leg = 0', near(bearingAt(poly, 250), 0, 1));
check('bearingAt end does not crash', Number.isFinite(bearingAt(poly, 300)));

// geohash round trip
const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';
function encodeGeohash(lat: number, lon: number, len = 10) {
  let latR = [-90, 90], lonR = [-180, 180], even = true, bit = 0, ch = 0, out = '';
  while (out.length < len) {
    const r = even ? lonR : latR;
    const v = even ? lon : lat;
    const mid = (r[0] + r[1]) / 2;
    if (v >= mid) { ch = (ch << 1) | 1; r[0] = mid; } else { ch <<= 1; r[1] = mid; }
    even = !even;
    if (++bit === 5) { out += BASE32[ch]; bit = 0; ch = 0; }
  }
  return out;
}
const gh = encodeGeohash(caracas.lat, caracas.lon);
const dec = decodeGeohash(gh)!;
check(`geohash decode (${gh})`, near(haversine(dec, caracas), 0, 2));

// ---- links ----
type P = ReturnType<typeof parseInput>;
const coordsOf = (p: P) => (p && p.kind === 'coords' ? p.point : null);

let p = parseInput('https://www.google.com/maps/place/Centro+Sambil/@10.4879,-66.8541,17z/data=!3m1!4b1!4m6!3m5!1s0x8c2a5:0x1!8m2!3d10.4880118!4d-66.8536722!16s');
check('google place link uses pin + name', near(coordsOf(p)?.lat ?? 0, 10.4880118, 1e-6) && p?.kind === 'coords' && p.label === 'Centro Sambil', JSON.stringify(p));
p = parseInput('https://www.google.com/maps/dir/?api=1&destination=10.5,-66.9');
check('google dir destination', coordsOf(p)?.lat === 10.5 && coordsOf(p)?.lon === -66.9, JSON.stringify(p));
p = parseInput('https://maps.google.com/?q=10.49,-66.88');
check('google ?q=coords', coordsOf(p)?.lon === -66.88, JSON.stringify(p));
p = parseInput('https://www.google.com/maps/search/?api=1&query=Plaza+Altamira');
check('google search text', p?.kind === 'text' && p.text === 'Plaza Altamira', JSON.stringify(p));
p = parseInput('https://www.google.com/maps/dir/Mi+ubicaci%C3%B3n/10.4901,-66.8512/@10.48,-66.86,15z');
check('google /dir/ path coords', coordsOf(p)?.lat === 10.4901, JSON.stringify(p));
p = parseInput('Mira este lugar https://maps.app.goo.gl/AbCdEf123?g_st=ic');
check('shared text with short link', p?.kind === 'shortlink' && p.url.startsWith('https://maps.app.goo.gl/AbCdEf123'), JSON.stringify(p));
p = parseInput('https://waze.com/ul?ll=10.4806%2C-66.9036&navigate=yes&zoom=17');
check('waze ll param', coordsOf(p)?.lat === 10.4806, JSON.stringify(p));
p = parseInput(`https://waze.com/ul/h${gh}`);
check('waze geohash link', near(haversine(coordsOf(p) ?? { lat: 0, lon: 0 }, caracas), 0, 2), JSON.stringify(p));
p = parseInput('https://ul.waze.com/ul?place=ChIJ123&ll=10.49120000%2C-66.85340000&navigate=yes');
check('waze place link', coordsOf(p)?.lon === -66.8534, JSON.stringify(p));
p = parseInput('10.4806, -66.9036');
check('plain coordinates', coordsOf(p)?.lon === -66.9036);
p = parseInput('Panadería La Cita, Chacao');
check('plain address -> text', p?.kind === 'text');
check('extractUrl trims punctuation', extractUrl('ver (https://waze.com/ul?ll=1,2).') === 'https://waze.com/ul?ll=1,2');

// ---- route text ----
check('roundabout text', describe('roundabout', 'right', 2).text.includes('2.ª salida'));
check('left turn', describe('turn', 'left').kind === 'left');
check('arrive', describe('arrive', undefined).kind === 'arrive');
check('formatDistance', formatDistance(1234) === '1.2 km' && formatDistance(243) === '240 m' && formatDistance(42) === '40 m');

// ---- device orientation -> camera pose ----
const pose = (a: number, b: number, g: number, screen = 0) => poseFromEuler(a, b, g, screen);
let o = pose(0, 90, 0);
check('portrait upright facing north', near(o.yaw, 0, 0.01) && near(o.pitch, 0, 0.01) && near(o.roll, 0, 0.01), JSON.stringify(o));
o = pose(270, 90, 0);
check('portrait upright facing east', near(o.yaw, 90, 0.01), JSON.stringify(o));
o = pose(180, 90, 0);
check('portrait upright facing south', near(o.yaw, 180, 0.01), JSON.stringify(o));
o = pose(0, 60, 0);
check('tilted down 30°', near(o.pitch, 30, 0.01) && near(o.yaw, 0, 0.01), JSON.stringify(o));
o = pose(0, 120, 0);
check('tilted up 30°', near(o.pitch, -30, 0.01), JSON.stringify(o));
o = pose(90, 0, -90, 90);
check('landscape upright facing north', near(o.yaw, 0, 0.01) && near(o.pitch, 0, 0.01) && near(o.roll, 0, 0.01), JSON.stringify(o));
o = pose(90, 20, -90, 90);
check('landscape rolled: only roll changes', near(Math.abs(o.roll), 20, 0.01) && near(o.yaw, 0, 0.01) && near(o.pitch, 0, 0.01), JSON.stringify(o));
check('roll flips sign with opposite tilt', near(pose(90, 20, -90, 90).roll, -pose(90, -20, -90, 90).roll, 0.01));
o = pose(0, 60, 0, 180);
check('screen angle 180 keeps the view direction and flips the horizon', near(o.yaw, 0, 0.01) && near(o.pitch, 30, 0.01) && near(Math.abs(o.roll), 180, 0.01), JSON.stringify(o));

// ---- bump / pothole detection ----
// Feed 60 Hz samples of vertical acceleration (m/s², up positive) on top of gravity, phone flat: device z is up.
function drive(profile: (t: number) => number, speed = 10, seconds = 3): ReturnType<BumpDetector['feed']>[] {
  const d = new BumpDetector();
  const out: ReturnType<BumpDetector['feed']>[] = [];
  for (let t = 0; t <= seconds * 1000; t += 16) out.push(d.feed(t, 0, 0, 9.81 + profile(t), speed));
  return out;
}
const events = (r: ReturnType<typeof drive>) => r.filter((e) => e !== null);
const pulse = (t: number, at: number, len: number, amp: number) => (t >= at && t < at + len ? amp : 0);
let ev = events(drive((t) => pulse(t, 1000, 60, -3.5) + pulse(t, 1060, 60, 7)));
check('pothole: drop then hard hit', ev.length === 1 && ev[0]!.type === 'hueco', JSON.stringify(ev));
ev = events(drive((t) => pulse(t, 1000, 100, 3.2) + pulse(t, 1100, 100, -3.2) + pulse(t, 1200, 60, 5)));
check('speed bump: rise first', ev.length === 1 && ev[0]!.type === 'policia', JSON.stringify(ev));
check('road noise is ignored', events(drive((t) => 1.2 * Math.sin(t / 40))).length === 0);
check('too slow (walking) is ignored', events(drive((t) => pulse(t, 1000, 60, -3.5) + pulse(t, 1060, 60, 7), 1.4)).length === 0);
check('weak bump below threshold is ignored', events(drive((t) => pulse(t, 1000, 100, 3))).length === 0);
ev = events(drive((t) => pulse(t, 1000, 60, -3.5) + pulse(t, 1060, 60, 7) + pulse(t, 1700, 60, -3.5) + pulse(t, 1760, 60, 7), 10, 4));
check('two hits within 3 s count once', ev.length === 1, String(ev.length));
const flipped = new BumpDetector();
let flippedEv: unknown[] = [];
for (let t = 0; t <= 3000; t += 16) {
  const a = -(9.81 + pulse(t, 1000, 60, -3.5) + pulse(t, 1060, 60, 7)); // iOS reports the opposite sign
  const e = flipped.feed(t, 0, 0, a, 10);
  if (e) flippedEv.push(e);
}
check('same result with inverted sign convention (iOS)', flippedEv.length === 1 && (flippedEv[0] as { type: string }).type === 'hueco', JSON.stringify(flippedEv));

// ---- upload queue ----
await (async () => {
  mem.clear();
  const sent: string[] = [];
  const ok = async (e: { id: string }) => (sent.push(e.id), true);
  enqueue('hazards', { client_id: 'a' }, 'a', 1000);
  enqueue('detections', { client_id: 'b' }, 'b', 1000, 0);
  check('queue holds both entries', pending().length === 2);
  await flush({ send: ok, now: 1000 + 1000 });
  check('detections go immediately, hazards wait out the undo window', sent.join() === 'b' && pending().length === 1, sent.join());
  cancel('a');
  await flush({ send: ok, now: 1000 + 120_000 });
  check('undo inside the window cancels the upload', sent.join() === 'b' && pending().length === 0, sent.join());

  enqueue('hazards', { client_id: 'c' }, 'c', 5000);
  const fail = async () => false;
  await flush({ send: fail, now: 5000 + 120_000 });
  check('failed upload stays queued for retry', pending().length === 1);
  await flush({ send: ok, now: 5000 + 130_000 });
  check('retry succeeds and clears the queue', pending().length === 0 && sent.join() === 'b,c', sent.join());

  enqueue('hazards', { client_id: 'd' }, 'd', 9000);
  await flush({ send: ok, now: 9100, force: true });
  check('force flush ignores the undo window (drive ended)', sent.at(-1) === 'd' && pending().length === 0);

  // ---- HUD & Calib profile tests ----
  const camDef = defaultsFor('landscape', 'camera');
  const hudDef = defaultsFor('landscape', 'hud');
  check('HUD defaults have distinct pitch/fov for windshield reflection', hudDef.pitch > camDef.pitch && hudDef.fov > camDef.fov);

  saveCalib({ ...camDef, pitch: 9.5 }, 'landscape', 'camera');
  saveCalib({ ...hudDef, pitch: 14.5 }, 'landscape', 'hud');
  check('camera and hud profiles persist independently in localStorage', loadCalib('landscape', 'camera').pitch === 9.5 && loadCalib('landscape', 'hud').pitch === 14.5);

  saveFlip({ mirrorX: true, flipY: true });
  check('flip state persists properly', loadFlip().mirrorX === true && loadFlip().flipY === true);
  saveFlip({ mirrorX: false, flipY: false });
  check('flip state toggles properly', loadFlip().mirrorX === false && loadFlip().flipY === false);
})();

// ---- auto calibration ----
// 63° lens, 1080p stream filling a 16:9 screen: the whole frame is visible, vfov = 2·atan(540/f).
const f1080 = 960 / Math.tan((63 * Math.PI) / 360);
check('vfov landscape, video fills the screen', near(visibleVfov(63, 1920, 1080, 1600, 900), (2 * Math.atan(540 / f1080) * 180) / Math.PI, 0.01));
check('vfov landscape ≈ 38° (close to the 40° default)', near(visibleVfov(DEFAULT_LENS_HFOV, 1920, 1080, 1600, 900), 38.1, 0.3));
check('vfov portrait: long side is vertical ≈ lens hfov', near(visibleVfov(63, 1080, 1920, 900, 1600), 63, 0.01));
// A 20:9 phone crops the top and bottom of a 16:9 video, so less is visible vertically.
check('vfov on a tall 20:9 screen is smaller (cover crop)', visibleVfov(63, 1920, 1080, 2400, 1080) < visibleVfov(63, 1920, 1080, 1920, 1080));
const still = Array.from({ length: 40 }, (_, i) => ({ pitch: 6 + (i % 2 ? 0.2 : -0.2), roll: -2 + (i % 3) * 0.1 }));
const m = steadyMean(still);
check('steady tilt averages', !!m && near(m.pitch, 6, 0.05) && near(m.roll, -1.9, 0.05), JSON.stringify(m));
check('moving phone is rejected', steadyMean(still.map((s, i) => ({ ...s, pitch: s.pitch + (i % 2 ? 4 : -4) }))) === null);
check('too few samples are rejected', steadyMean(still.slice(0, 5)) === null);

// Tilt window: 60 Hz readings; only a full, still window with the car stopped counts.
const feed = (w: TiltWindow, from: number, ms: number, moving: (t: number) => boolean, pitch = 7) => {
  for (let t = from; t <= from + ms; t += 16) w.push(t, { pitch: pitch + Math.sin(t) * 0.1, roll: 1 }, moving(t));
};
const tw = new TiltWindow(2500);
feed(tw, 0, 1000, () => false);
check('tilt window: too short is not trusted', tw.steady() === null);
feed(tw, 1016, 2000, () => false);
const st = tw.steady();
check('tilt window: still phone, car stopped gives the tilt', !!st && near(st.pitch, 7, 0.1) && near(st.roll, 1, 0.01), JSON.stringify(st));
const tw2 = new TiltWindow(2500);
feed(tw2, 0, 3000, (t) => t > 2000);
check('tilt window: ignored while the car moves (braking tilts gravity)', tw2.steady() === null);
feed(tw2, 3016, 2600, () => false);
check('tilt window: trusted again once stopped for the whole window', tw2.steady() !== null);

// ---- phone <-> iPad link ----
const hc = newHudCode();
check('iPad code is 6 digits', /^\d{6}$/.test(hc), hc);
check('iPad peer id comes from the code', hudPeerId('012345') === 'viaar-hud-012345');
check('typed code: spaces and dashes ignored', normalizeCode(' 012 345 ') === '012345' && normalizeCode('012-345') === '012345');
check('typed code: not 6 digits is rejected', normalizeCode('12345') === null && normalizeCode('12345a') === null);
check('code shown in two groups', formatCode('012345') === '012 345');
{
  // A route survives the trip to the iPad: same geometry, steps and arrival point.
  const r = { poly: buildPolyline([caracas, corner, end]), steps: [{ kind: 'left' as const, text: 'Gira a la izquierda', street: 'Av. X', location: corner, along: 200 }], duration: 95 };
  const arrival = { lat: end.lat, lon: end.lon, label: 'Edif. B · Entrada 2' };
  const back = decodeRoute(JSON.parse(JSON.stringify(encodeRoute(r, arrival))));
  check('route round-trip: same length', near(back.route.poly.length, r.poly.length, 0.5), `${back.route.poly.length} vs ${r.poly.length}`);
  check('route round-trip: steps and arrival kept', back.route.steps[0].kind === 'left' && back.route.steps[0].along === 200 && back.arrival?.label === arrival.label && back.route.duration === 95);
}

// ---- remote camera: keep the picture upright ----
check('phone upright portrait = 0', physicalAngle(85, 0, 0) === 0);
check('phone turned left (top to the left) = 90', physicalAngle(5, -85, 0) === 90);
check('phone turned right = 270', physicalAngle(5, 85, 0) === 270);
check('phone in a mount tilted back 30°, sideways = 90', physicalAngle(3, -60, 0) === 90);
check('lying flat keeps the last position', physicalAngle(2, 3, 90) === 90);
// beta 30°, gamma −35.26°: "up" points exactly 45° between portrait and landscape.
check('halfway between positions keeps the last one', physicalAngle(30, -35.26, 0) === 0 && physicalAngle(30, -35.26, 90) === 90);
check('22° off upright still counts as upright', physicalAngle(60, -45, 90) === 0);
check('window.orientation -90 is 270', interfaceAngle(undefined, -90) === 270 && interfaceAngle(90, undefined) === 90);
// Rotation lock on, phone horizontal: frames arrive portrait (720×1280) and must turn 90°.
const locked = uprightPlan(720, 1280, 90, 63, 1280, 720);
check('locked portrait frames: turned and filling 1280×720', locked.rot === 90 && near(locked.scale, 1, 1e-9));
check('locked portrait frames keep the full lens width', near(locked.hfov, 63, 0.01), String(locked.hfov));
// Phone held upright: the upright picture is portrait, so the landscape output is a narrow crop.
const upright = uprightPlan(720, 1280, 0, 63, 1280, 720);
check('upright phone: narrower field of view (crop)', upright.hfov < 40 && upright.hfov > 30, String(upright.hfov));
check('rotation is normalised', uprightPlan(1280, 720, -90, 63, 1280, 720).rot === 270);

// ---- windshield HUD optics ----
// iPad 11" in landscape: 1194 × 834 CSS px at 132 CSS px/inch = 0.230 × 0.161 m.
const IW = 1194;
const IH = 834;
{
  const R = reflectMatrix(new Vector3(0, 1.12, -1.05), new Vector3(0, -Math.cos(0.6), Math.sin(0.6)));
  const p = new Vector3(0.3, 1.4, -0.2);
  check('reflection is its own inverse', p.clone().applyMatrix4(R).applyMatrix4(R).distanceTo(p) < 1e-9);
  check('reflection has determinant -1', Math.abs(R.determinant() + 1) < 1e-9);
}
const fo = buildOptics(FORTUNER_2015, IW, IH);
const fi = virtualImage(fo);
check('Fortuner: picture ~0.91 m from the eye', near(fi.distance, 0.91, 0.03), String(fi.distance));
check('Fortuner: picture ~14° wide', near(fi.widthDeg, 14.4, 0.6), String(fi.widthDeg));
check('Fortuner: picture spans ~-8.4°…+0.6°', near(fi.lowDeg, -8.4, 0.5) && near(fi.highDeg, 0.6, 0.5), `${fi.lowDeg} ${fi.highDeg}`);
check('Fortuner: road from ~10 m, clear of the hood', near(fi.roadFrom, 10, 1) && fi.hoodClear, String(fi.roadFrom));
check('flat screen: reflected picture tilted at 2× the rake', near(fi.tiltDeg, 2 * FORTUNER_2015.rake, 0.5), String(fi.tiltDeg));
check('incidence at the glass is past Brewster (more reflection)', fi.incidenceDeg > 56, String(fi.incidenceDeg));
{
  // The matrices used for rendering agree with plain ray tracing for points on and above the road.
  const cam = mirrorCamera(fo);
  const view = cam.matrixWorld.clone().invert();
  const toCss = (p: Vector3) => {
    const c = new Vector4(p.x, p.y, p.z, 1).applyMatrix4(fo.refl).applyMatrix4(view).applyMatrix4(cam.projection);
    return { x: ((c.x / c.w + 1) / 2) * IW, y: ((1 - c.y / c.w) / 2) * IH };
  };
  let worst = 0;
  for (let i = 0; i < 200; i++) {
    const p = new Vector3(Math.sin(i) * 6, (i % 7) * 0.4, -10 - (i * 7.3) % 90);
    const a = toCss(p);
    const b = worldToCss(fo, p)!;
    worst = Math.max(worst, Math.hypot(a.x - b.x, a.y - b.y));
  }
  check('render matrices match ray tracing (< 0.01 px)', worst < 0.01, String(worst));
}
{
  // Mirror axis follows from the geometry: top edge to the driver = horizontal mirror; to the glass = vertical flip.
  const far = (x: number, z: number) => new Vector3(x, 0, z);
  const d = buildOptics({ ...FORTUNER_2015, topEdge: 'driver' }, IW, IH);
  const g = buildOptics({ ...FORTUNER_2015, topEdge: 'glass' }, IW, IH);
  const [dl, dr, dn, df] = [far(-1, -20), far(1, -20), far(0, -12), far(0, -40)].map((p) => worldToCss(d, p)!);
  const [gl, gr, gn, gf] = [far(-1, -20), far(1, -20), far(0, -12), far(0, -40)].map((p) => worldToCss(g, p)!);
  check('top edge to driver: right of the road drawn on the left (mirror X), farther road higher', dr.x < dl.x && df.y < dn.y, JSON.stringify({ dl, dr, dn, df }));
  check('top edge to glass: left/right kept, farther road lower on the canvas (flip Y)', gr.x > gl.x && gf.y > gn.y, JSON.stringify({ gl, gr, gn, gf }));
}
{
  // Text panel: the CSS box corners land where the homography says, and read upright in the glass.
  const { h } = panelTransform(fo);
  const corners = [{ x: 0, y: 0 }, { x: IW, y: 0 }, { x: IW, y: IH }, { x: 0, y: IH }].map((p) => applyHomography(h, p));
  const inScreen = corners.every((c) => c.x >= -0.5 && c.x <= IW + 0.5 && c.y >= -0.5 && c.y <= IH + 0.5);
  // Back from canvas to where the driver sees it: elevation and azimuth of each corner.
  const seen = corners.map((c) => {
    const q = fo.pa.clone().addScaledVector(fo.u, c.x * fo.mpp).addScaledVector(fo.v, (IH - c.y) * fo.mpp).applyMatrix4(fo.refl).sub(fo.eye);
    return { az: Math.atan2(q.x, -q.z), el: Math.atan2(q.y, Math.hypot(q.x, q.z)) };
  });
  const upright = seen[0].el > seen[3].el && seen[1].el > seen[2].el && seen[1].az > seen[0].az && seen[2].az > seen[3].az;
  check('text panel fits on the screen', inScreen, JSON.stringify(corners));
  check('text panel reads upright and unmirrored in the glass', upright, JSON.stringify(seen));
}
{
  const p = placementAdvice(FORTUNER_2015, IW, IH, -4);
  check('placement: Fortuner iPad ~34 cm back from the windshield base', near(p.fromGlassBase, 0.34, 0.03), String(p.fromGlassBase));
  check('placement: centres the picture at the target angle', near(p.centreDeg, -4, 0.3), String(p.centreDeg));
  const steep = placementAdvice({ ...FORTUNER_2015, rake: 40 }, IW, IH, -4);
  check('placement: steeper glass, iPad a little closer to it', steep.fromGlassBase < p.fromGlassBase, `${steep.fromGlassBase} ${p.fromGlassBase}`);
}

// ---- maqueta: tiles, elevation, route profile, speed limits ----
{
  // The San Juan Bosco zone covers x 20597–20598, y 30843–30844 at z16 (MAQUETA.md).
  const nw = tileOf({ lat: 10.5128, lon: -66.854 });
  const se = tileOf({ lat: 10.509, lon: -66.8498 });
  check('maqueta: zone NW corner tile', nw.x === 20597 && nw.y === 30843, JSON.stringify(nw));
  check('maqueta: zone SE corner tile', se.x === 20598 && se.y === 30844, JSON.stringify(se));
  const p = { lat: 10.51031, lon: -66.85181 };
  const f = tileXY(p);
  const back = tileToLatLon(f.x, f.y);
  check('maqueta: tile coordinates round trip', near(back.lat, p.lat, 1e-9) && near(back.lon, p.lon, 1e-9), JSON.stringify(back));
  const c0 = gridPoint(20597, 30843, 13, 13, 0, 0);
  const c1 = gridPoint(20597, 30843, 13, 13, 12, 12);
  const t1 = tileToLatLon(20598, 30844);
  check('maqueta: grid starts at the NW corner, ends at the SE corner', near(c0.lat, tileToLatLon(20597, 30843).lat, 1e-12) && near(c1.lat, t1.lat, 1e-12) && near(c1.lon, t1.lon, 1e-12));
}
{
  // Heights that are linear in grid space come back exactly from bilinear interpolation.
  const rows = 13;
  const cols = 13;
  const z: number[] = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) z.push(100 + 3 * c + 5 * r);
  const tile: Tile = { v: 1, tile: [16, 20597, 30843], built: '', sources: [], elev: { rows, cols, z }, signs: [], ways: [] };
  const inside = tileToLatLon(20597 + 2.5 / 12, 30843 + 7.25 / 12);
  check('maqueta: bilinear elevation inside a tile', near(tileElevation(tile, inside)!, 100 + 3 * 2.5 + 5 * 7.25, 1e-6), String(tileElevation(tile, inside)));
  check('maqueta: corner of the tile', near(tileElevation(tile, tileToLatLon(20598, 30844))!, 100 + 36 + 60, 1e-6));
  check('maqueta: no elevation outside the tile', tileElevation(tile, tileToLatLon(20599, 30843.5)) === null);
}
{
  // 300 m due north climbing 13 %: like San Juan Bosco, 6.5 m up at 50 m.
  const start = { lat: 10.51031, lon: -66.85181 };
  const north = buildPolyline([start, offset(start, 0, 300)]);
  const rise = (p: { lat: number }) => 900 + 0.13 * (p.lat - start.lat) * 110540;
  const prof = RouteProfile.build(north, rise)!;
  check('maqueta: profile 13 % slope, 6.5 m up at 50 m', near(prof.at(50) - prof.at(0), 6.5, 0.1), String(prof.at(50) - prof.at(0)));
  check('maqueta: profile between samples', near(prof.at(52.5) - prof.at(0), 0.13 * 52.5, 0.1), String(prof.at(52.5)));
  check('maqueta: profile clamps past the end', prof.at(1000) === prof.at(north.length));
  // No tile for the first 100 m: that stretch holds the first known height, so it reads as flat.
  const gap = RouteProfile.build(north, (p) => ((p.lat - start.lat) * 110540 < 100 ? null : rise(p)))!;
  check('maqueta: gap before the tiles is flat', gap.at(0) === gap.at(95) && gap.at(200) > gap.at(100));
  check('maqueta: no tiles at all, no profile', RouteProfile.build(north, () => null) === null);

  // Speed limit: a northbound one-way 5 m east matches; a closer southbound one-way doesn't.
  const way = (id: string, from: { lat: number; lon: number }, to: { lat: number; lon: number }, oneway: boolean, maxspeed: number): TileWay => ({
    id,
    name: null,
    oneway,
    lanes: 2,
    maxspeed,
    turnLanes: null,
    pts: [[from.lat, from.lon], [to.lat, to.lon]],
  });
  const east = (m: number) => offset(start, 90, m);
  const up = way('up', east(5), offset(east(5), 0, 300), true, 30);
  const down = way('down', offset(east(-3), 0, 300), east(-3), true, 60);
  const lim = speedLimits(north, [down, up]);
  check('maqueta: speed limit from the one-way going our way', limitAt(lim, 150) === 30, String(limitAt(lim, 150)));
  check('maqueta: no limit without a matching way', limitAt(speedLimits(north, [down]), 150) === null);
  const twoWay = way('two', offset(east(2), 0, 300), east(2), false, 50);
  check('maqueta: a two-way road matches either direction', limitAt(speedLimits(north, [twoWay]), 150) === 50);

  // Signs: our direction or both ways, on this street, not bumps.
  const sign = (id: string, type: TileSign['type'], m: number, side: number, dir: number | null): TileSign => {
    const p = offset(offset(start, 0, m), 90, side);
    return { id, type, lat: p.lat, lon: p.lon, dir, verified: false };
  };
  const list = indexSigns(
    [
      sign('ours', 'stop', 50, 4, 0),
      sign('theirs', 'stop', 60, -4, 180),
      sign('both', 'traffic_signals', 120, 0, null),
      sign('far', 'stop', 80, 30, 0),
      sign('bump', 'bump', 90, 0, null),
    ],
    north,
  );
  check('signs: keeps ours and both-ways, drops the other direction, other streets and bumps', list.map((r) => r.s.id).join() === 'ours,both', list.map((r) => r.s.id).join());
  check('signs: along the route', near(list[0].along, 50, 1) && near(list[0].bearing, 0, 1));
  const ahead = signsAhead(list, 100);
  check('signs: window ahead skips the ones well behind', ahead.length === 1 && ahead[0].type === 'traffic_signals');
}

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
