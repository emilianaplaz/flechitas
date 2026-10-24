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

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
