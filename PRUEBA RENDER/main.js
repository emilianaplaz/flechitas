// Street View-style viewer for a street reconstructed from a phone video.
// "Stops" are the video frames with known camera poses (COLMAP). At each stop the real photo is
// drawn exactly where the camera saw it; look away and the 3D model (OpenMVS) shows instead.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const STEP = 3; // metres per click, like Street View hops
const PHOTO_DIST = 12; // metres in front of the camera where the photo is drawn
const PHOTO_FULL = THREE.MathUtils.degToRad(8); // photo fully visible within this angle of where it was taken
const PHOTO_GONE = THREE.MathUtils.degToRad(30);
const MOVE_MS = 650;

const $ = (id) => document.getElementById(id);
const canvas = $('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xbfd4e6);
scene.fog = new THREE.Fog(0xbfd4e6, 60, 160);
const camera = new THREE.PerspectiveCamera(60, 1, 0.05, 500);
camera.rotation.order = 'YXZ';

const data = await (await fetch('nodes.json')).json();
const nodes = data.nodes.map((n) => {
  const q = new THREE.Quaternion(...n.quaternion);
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
  return { ...n, pos: new THREE.Vector3(...n.position), q, yaw: Math.atan2(-fwd.x, -fwd.z), pitch: Math.asin(fwd.y) };
});
const eye = data.eyeHeight;

// ---------- 3D model ----------
const world = new THREE.Group();
scene.add(world);
let model = null;
const texLoader = new THREE.TextureLoader();
try {
  const gltf = await new GLTFLoader().loadAsync('street.glb');
  model = gltf.scene;
  // OpenMVS writes COLMAP world coordinates; move them into the street-aligned viewer frame.
  model.applyMatrix4(new THREE.Matrix4().fromArray(data.worldToView));
  model.traverse((o) => {
    if (o.isMesh) {
      // The texture already holds the real lighting: draw it unlit.
      const map = o.material.map ?? null;
      o.material = new THREE.MeshBasicMaterial({ map, side: THREE.DoubleSide, vertexColors: !map && !!o.geometry.attributes.color });
    }
  });
  world.add(model);
} catch (e) {
  console.warn('Sin modelo 3D (street.glb):', e);
}

// Path line and stop dots (seen from the air).
const pathGeo = new THREE.BufferGeometry().setFromPoints(nodes.map((n) => n.pos.clone().setY(n.pos.y - eye + 0.05)));
const pathLine = new THREE.Line(pathGeo, new THREE.LineBasicMaterial({ color: 0x1a73e8 }));
pathLine.visible = false;
scene.add(pathLine);

// ---------- real photo overlay ----------
const photo = new THREE.Mesh(
  new THREE.PlaneGeometry(1, 1),
  new THREE.MeshBasicMaterial({ transparent: true, depthTest: false, depthWrite: false, opacity: 0 }),
);
photo.renderOrder = 10;
scene.add(photo);
const photoCache = new Map();
function photoTexture(n) {
  let t = photoCache.get(n.id);
  if (!t) {
    t = texLoader.load(n.image);
    t.colorSpace = THREE.SRGBColorSpace;
    photoCache.set(n.id, t);
  }
  return t;
}
function placePhoto(n) {
  const h = 2 * PHOTO_DIST * Math.tan(THREE.MathUtils.degToRad(n.vfov) / 2);
  photo.scale.set(h * n.aspect, h, 1);
  photo.quaternion.copy(n.q);
  photo.position.copy(n.pos).add(new THREE.Vector3(0, 0, -PHOTO_DIST).applyQuaternion(n.q));
  photo.material.map = photoTexture(n);
  photo.material.needsUpdate = true;
}

// ---------- ground arrows and hover ring ----------
function chevronGeometry() {
  const s = new THREE.Shape();
  s.moveTo(-0.55, -0.15);
  s.lineTo(0, 0.4);
  s.lineTo(0.55, -0.15);
  s.lineTo(0.55, -0.45);
  s.lineTo(0, 0.1);
  s.lineTo(-0.55, -0.45);
  s.closePath();
  return new THREE.ShapeGeometry(s).rotateX(-Math.PI / 2);
}
const arrowMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.92, depthTest: false });
const arrows = [0, 1].map(() => {
  const m = new THREE.Mesh(chevronGeometry(), arrowMat);
  m.renderOrder = 20;
  scene.add(m);
  return m;
});
const ring = new THREE.Mesh(
  new THREE.RingGeometry(0.35, 0.5, 40),
  new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.7, depthTest: false, side: THREE.DoubleSide }),
);
ring.renderOrder = 15;
ring.visible = false;
scene.add(ring);

// ---------- state ----------
let current = 0;
let yaw = nodes[0].yaw;
let pitch = nodes[0].pitch;
let mode = 'street';
let moving = null; // { from, to, t0, target }
let photoFade = 1; // multiplies the photo opacity, drops while moving
let aim = null; // after a hop, turn smoothly toward where the new photo was taken

/** Next stop at least STEP metres away along the walk, in the given direction (+1 / -1). */
function stepFrom(i, dir) {
  for (let j = i + dir; j >= 0 && j < nodes.length; j += dir) {
    if (nodes[j].pos.distanceTo(nodes[i].pos) >= STEP) return j;
  }
  const end = dir > 0 ? nodes.length - 1 : 0;
  return end !== i ? end : null;
}
function viewDir() {
  return new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
}
/** Of the two directions along the walk, the one closest to where we're looking (or opposite). */
function stepToward(sign) {
  const look = viewDir().multiplyScalar(sign);
  let best = null;
  let bestDot = -Infinity;
  for (const dir of [1, -1]) {
    const j = stepFrom(current, dir);
    if (j === null) continue;
    const d = nodes[j].pos.clone().sub(nodes[current].pos).setY(0).normalize().dot(look);
    if (d > bestDot) {
      bestDot = d;
      best = j;
    }
  }
  return best;
}

function goTo(j) {
  if (j === null || j === current || moving) return;
  moving = { from: nodes[current].pos.clone(), to: nodes[j].pos.clone(), t0: performance.now(), target: j };
}

function updateArrows() {
  const here = nodes[current];
  [1, -1].forEach((dir, k) => {
    const j = stepFrom(current, dir);
    const a = arrows[k];
    a.visible = mode === 'street' && j !== null && !moving;
    if (!a.visible) return;
    const d = nodes[j].pos.clone().sub(here.pos).setY(0).normalize();
    a.position.copy(here.pos).add(d.clone().multiplyScalar(2.2));
    a.position.y = here.pos.y - eye + 0.05;
    a.rotation.y = Math.atan2(-d.x, -d.z);
    a.userData.target = j;
  });
  $('where').textContent = `Parada ${current + 1} de ${nodes.length}`;
}

// ---------- input ----------
let drag = null;
canvas.addEventListener('pointerdown', (e) => {
  drag = { x: e.clientX, y: e.clientY, moved: 0 };
  aim = null;
  canvas.setPointerCapture(e.pointerId);
  canvas.classList.add('dragging');
});
canvas.addEventListener('pointermove', (e) => {
  if (mode !== 'aerial') updateHover(e);
  if (!drag || mode === 'aerial') return;
  const dx = e.clientX - drag.x;
  const dy = e.clientY - drag.y;
  drag.moved += Math.abs(dx) + Math.abs(dy);
  drag.x = e.clientX;
  drag.y = e.clientY;
  const k = (camera.fov / canvas.clientHeight) * (Math.PI / 180);
  yaw += dx * k;
  pitch = THREE.MathUtils.clamp(pitch + dy * k, -1.2, 1.2);
  if (mode === 'pano') clampPano();
});
canvas.addEventListener('pointerup', (e) => {
  canvas.classList.remove('dragging');
  const wasClick = drag && drag.moved < 6;
  drag = null;
  if (wasClick && mode === 'street') clickStreet(e);
});
canvas.addEventListener(
  'wheel',
  (e) => {
    if (mode === 'aerial') return;
    e.preventDefault();
    const maxFov = mode === 'pano' && panoInfo ? Math.floor(panoInfo.vfov_deg * 0.92) : 90;
    camera.fov = THREE.MathUtils.clamp(camera.fov + e.deltaY * 0.03, 20, maxFov);
    if (mode === 'pano') clampPano();
    camera.updateProjectionMatrix();
  },
  { passive: false },
);
addEventListener('keydown', (e) => {
  if (mode === 'aerial') return;
  if (e.key === 'ArrowUp' || e.key === 'w') goTo(stepToward(1));
  else if (e.key === 'ArrowDown' || e.key === 's') goTo(stepToward(-1));
  else if (e.key === 'ArrowLeft' || e.key === 'a') yaw += 0.15;
  else if (e.key === 'ArrowRight' || e.key === 'd') yaw -= 0.15;
  else return;
  if (mode === 'pano') clampPano();
  e.preventDefault();
});
$('fwd').onclick = () => goTo(stepToward(1));
$('back').onclick = () => goTo(stepToward(-1));

const ray = new THREE.Raycaster();
const ndc = new THREE.Vector2();
function pick(e) {
  const r = canvas.getBoundingClientRect();
  ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, camera);
}
/** Where the pointer meets the street: the model if we have it, otherwise the ground plane. */
function groundHit() {
  if (model) {
    const hit = ray.intersectObject(model, true)[0];
    if (hit && hit.distance < 80) return { point: hit.point, normal: hit.face?.normal?.clone().transformDirection(hit.object.matrixWorld) };
  }
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -(nodes[current].pos.y - eye));
  const p = ray.ray.intersectPlane(plane, new THREE.Vector3());
  return p && p.distanceTo(camera.position) < 60 ? { point: p, normal: new THREE.Vector3(0, 1, 0) } : null;
}
function updateHover(e) {
  if (mode !== 'street' || drag?.moved > 6) return;
  pick(e);
  const hit = groundHit();
  ring.visible = !!hit;
  if (!hit) return;
  ring.position.copy(hit.point).addScaledVector(hit.normal ?? new THREE.Vector3(0, 1, 0), 0.03);
  ring.lookAt(hit.point.clone().add(hit.normal ?? new THREE.Vector3(0, 1, 0)));
}
function clickStreet(e) {
  pick(e);
  const a = ray.intersectObjects(arrows.filter((m) => m.visible))[0];
  if (a) return goTo(a.object.userData.target);
  const hit = groundHit();
  if (!hit) return;
  // Nearest stop to the clicked spot (Street View jumps to the closest panorama).
  let best = current;
  let bestD = Infinity;
  nodes.forEach((n, i) => {
    const d = Math.hypot(n.pos.x - hit.point.x, n.pos.z - hit.point.z);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  goTo(best);
}

// ---------- minimap ----------
const mm = $('minimap');
const mmc = mm.getContext('2d');
const xs = nodes.map((n) => n.pos.x);
const zs = nodes.map((n) => n.pos.z);
const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs)) || 1;
const cx = (Math.max(...xs) + Math.min(...xs)) / 2;
const cz = (Math.max(...zs) + Math.min(...zs)) / 2;
const mmScale = (mm.width * 0.8) / span;
const toMM = (p) => [mm.width / 2 + (p.x - cx) * mmScale, mm.height / 2 + (p.z - cz) * mmScale];
function drawMinimap() {
  mmc.clearRect(0, 0, mm.width, mm.height);
  mmc.lineWidth = 10;
  mmc.lineCap = mmc.lineJoin = 'round';
  mmc.strokeStyle = '#ffffff';
  mmc.beginPath();
  nodes.forEach((n, i) => (i ? mmc.lineTo(...toMM(n.pos)) : mmc.moveTo(...toMM(n.pos))));
  mmc.stroke();
  mmc.lineWidth = 4;
  mmc.strokeStyle = '#1a73e8';
  mmc.stroke();
  const [px, py] = toMM(camera.position);
  // View cone, pointing where the camera looks.
  const ang = -yaw - Math.PI / 2;
  const half = THREE.MathUtils.degToRad(camera.fov * camera.aspect) / 2;
  mmc.fillStyle = 'rgba(26,115,232,0.25)';
  mmc.beginPath();
  mmc.moveTo(px, py);
  mmc.arc(px, py, 34, ang - half, ang + half);
  mmc.closePath();
  mmc.fill();
  mmc.fillStyle = '#1a73e8';
  mmc.strokeStyle = '#fff';
  mmc.lineWidth = 3;
  mmc.beginPath();
  mmc.arc(px, py, 7, 0, Math.PI * 2);
  mmc.fill();
  mmc.stroke();
}
mm.addEventListener('click', (e) => {
  if (mode !== 'street') return;
  const r = mm.getBoundingClientRect();
  const x = ((e.clientX - r.left) / r.width) * mm.width;
  const y = ((e.clientY - r.top) / r.height) * mm.height;
  let best = current;
  let bestD = Infinity;
  nodes.forEach((n, i) => {
    const [nx, ny] = toMM(n.pos);
    const d = Math.hypot(nx - x, ny - y);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  goTo(best);
});

// ---------- aerial view ----------
const orbit = new OrbitControls(camera, canvas);
orbit.enabled = false;
orbit.enableDamping = true;

// ---------- panorama (video 2) ----------
const panoScene = new THREE.Scene();
panoScene.background = new THREE.Color(0x111418);
let panoInfo = null;
try {
  panoInfo = await (await fetch('pano.json')).json();
  const tex = texLoader.load('pano.jpg');
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.repeat.x = -1; // seen from inside the cylinder
  const thetaLen = THREE.MathUtils.degToRad(panoInfo.hfov_deg);
  const r = 10;
  const pxPerRad = panoInfo.width / thetaLen;
  const height = (r * panoInfo.height) / pxPerRad;
  const cyl = new THREE.Mesh(
    new THREE.CylinderGeometry(r, r, height, 96, 1, true, Math.PI - thetaLen / 2, thetaLen),
    new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide }),
  );
  panoScene.add(cyl);
} catch {
  document.querySelector('[data-mode=pano]').hidden = true;
}
function clampPano() {
  if (!panoInfo) return;
  const half = THREE.MathUtils.degToRad(panoInfo.hfov_deg) / 2;
  const view = THREE.MathUtils.degToRad(camera.fov * camera.aspect) / 2;
  const lim = Math.max(0, half - view);
  yaw = THREE.MathUtils.clamp(yaw, -lim, lim);
  const vlim = Math.max(0, THREE.MathUtils.degToRad(panoInfo.vfov_deg - camera.fov) / 2);
  pitch = THREE.MathUtils.clamp(pitch, -vlim, vlim);
}

let saved = null;
function setMode(m) {
  if (m === mode) return;
  if (mode === 'street') saved = { yaw, pitch, fov: camera.fov };
  mode = m;
  document.body.className = m;
  document.querySelectorAll('#modes button').forEach((b) => b.classList.toggle('on', b.dataset.mode === m));
  orbit.enabled = m === 'aerial';
  pathLine.visible = m === 'aerial';
  ring.visible = false;
  if (m === 'aerial') {
    const c = new THREE.Vector3(cx, nodes[0].pos.y - eye, cz);
    camera.position.set(cx + span * 0.35, c.y + span * 0.9, cz + span * 0.6);
    orbit.target.copy(c);
    camera.fov = 50;
  } else if (m === 'pano') {
    camera.position.set(0, 0, 0);
    yaw = 0;
    pitch = 0;
    // No taller than the panorama itself, so there are no black bands above and below.
    camera.fov = panoInfo ? Math.floor(panoInfo.vfov_deg * 0.92) : 60;
    clampPano();
  } else if (saved) {
    camera.position.copy(nodes[current].pos);
    ({ yaw, pitch } = saved);
    camera.fov = saved.fov;
  }
  camera.updateProjectionMatrix();
  updateArrows();
}
document.querySelectorAll('#modes button').forEach((b) => (b.onclick = () => setMode(b.dataset.mode)));

// ---------- loop ----------
function resize() {
  const w = innerWidth;
  const h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
// Start zoomed to the photo's own field of view, so the real photo fills the screen.
camera.fov = Math.round(nodes[0].vfov + 4);
resize();

camera.position.copy(nodes[0].pos);
placePhoto(nodes[0]);
updateArrows();
$('loading').hidden = true;

function frame(now) {
  requestAnimationFrame(frame);
  if (mode === 'aerial') {
    orbit.update();
    photo.visible = false;
    arrows.forEach((a) => (a.visible = false));
    renderer.render(scene, camera);
    drawMinimap();
    return;
  }
  if (mode === 'pano') {
    camera.rotation.set(pitch, yaw, 0);
    renderer.render(panoScene, camera);
    return;
  }

  if (moving) {
    const t = Math.min(1, (now - moving.t0) / MOVE_MS);
    const k = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
    camera.position.lerpVectors(moving.from, moving.to, k);
    photoFade = Math.max(0, 1 - t * 3);
    if (t >= 1) {
      current = moving.target;
      moving = null;
      placePhoto(nodes[current]);
      updateArrows();
      const n = nodes[current];
      const dYaw = Math.atan2(Math.sin(n.yaw - yaw), Math.cos(n.yaw - yaw));
      if (Math.abs(dYaw) < THREE.MathUtils.degToRad(60)) aim = { yaw: yaw + dYaw, pitch: n.pitch };
    }
  } else {
    photoFade = Math.min(1, photoFade + 0.06);
  }
  if (aim) {
    yaw += (aim.yaw - yaw) * 0.12;
    pitch += (aim.pitch - pitch) * 0.12;
    if (Math.abs(aim.yaw - yaw) < 0.002 && Math.abs(aim.pitch - pitch) < 0.002) aim = null;
  }

  camera.rotation.set(pitch, yaw, 0);

  // Photo opacity: full when looking where the photo was taken, fading as you look away.
  const n = nodes[current];
  const look = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
  const shot = new THREE.Vector3(0, 0, -1).applyQuaternion(n.q);
  const ang = look.angleTo(shot);
  const vis = 1 - THREE.MathUtils.smoothstep(ang, PHOTO_FULL, PHOTO_GONE);
  const wantPhoto = $('photoToggle').checked || !model;
  photo.visible = wantPhoto && vis > 0.01;
  photo.material.opacity = vis * photoFade;

  renderer.render(scene, camera);
  drawMinimap();
}
requestAnimationFrame(frame);
