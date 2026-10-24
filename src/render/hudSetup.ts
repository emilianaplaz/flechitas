// Windshield HUD geometry: the measurements of the car and where the iPad sits, the optics built from
// them for this screen, and the setup sheet (measurements, placement advice, fine alignment).
// With "Óptica calculada" on, the 3D view and the text are drawn as the driver must see them in the
// glass; off, the HUD falls back to the simple CSS mirror (⇄ ⇅ buttons in hud.ts).
import { app } from '../core/state.ts';
import { $, toast } from '../core/ui.ts';
import { buildOptics, FORTUNER_2015, panelTransform, placementAdvice, virtualImage, type HudGeometry, type Optics } from './optics.ts';
import { loadHudGeometry, loadOpticsOn, saveHudGeometry, saveOpticsOn } from './calib.ts';

let geom: HudGeometry = loadHudGeometry();
let opticsOn = loadOpticsOn();
let cache: { key: string; optics: Optics } | null = null;

/** Exact optics are used: HUD display chosen and "Óptica calculada" on. */
export const opticsActive = (): boolean => app.display === 'hud' && opticsOn;

/** Optics for the current geometry and canvas size, or null when not in use. Rebuilt only on change. */
export function currentOptics(): Optics | null {
  if (!opticsActive()) return null;
  const w = window.innerWidth;
  const h = window.innerHeight;
  const key = `${JSON.stringify(geom)}|${w}x${h}`;
  if (cache?.key !== key) cache = { key, optics: buildOptics(geom, w, h) };
  return cache.optics;
}

/** After anything that changes how the HUD must be drawn (geometry, toggle, screen size). The 3D view picks it up next frame. */
function changed() {
  applyHudView();
}

/**
 * Text and CSS mirror for the current mode. With optics, the canvas is already mirrored by the
 * projection, so the CSS mirror is cancelled and the text box gets the homography that makes it read
 * upright and undistorted in the glass.
 */
export function applyHudView() {
  const proj = $('hudProjection');
  const o = currentOptics();
  const isHud = app.display === 'hud';
  $('hudGeomBtn').hidden = !isHud;
  $('mirrorX').hidden = !isHud || !!o;
  $('flipY').hidden = !isHud || !!o;
  if (o) {
    document.documentElement.style.setProperty('--mirror-x', '1');
    document.documentElement.style.setProperty('--flip-y', '1');
    proj.style.transform = panelTransform(o).css;
    proj.style.transformOrigin = '0 0';
  } else {
    proj.style.transform = '';
    proj.style.transformOrigin = '';
  }
}

// ---------- setup sheet ----------
interface Field {
  key: keyof HudGeometry;
  label: string;
  unit: 'cm' | '°';
  min: number;
  max: number;
  step: number;
  // How the stored value (metres / degrees) shows in the form.
  get: (g: HudGeometry) => number;
  set: (g: HudGeometry, v: number) => HudGeometry;
}
const cm = (k: keyof HudGeometry, label: string, min: number, max: number): Field => ({
  key: k,
  label,
  unit: 'cm',
  min,
  max,
  step: 0.5,
  get: (g) => +((g[k] as number) * 100).toFixed(1),
  set: (g, v) => ({ ...g, [k]: v / 100 }),
});
const FIELDS: Field[] = [
  cm('eyeHeight', 'Altura de tus ojos sobre el piso', 90, 200),
  cm('dashHeight', 'Altura del tablero (donde va el iPad)', 60, 160),
  cm('glassBase', 'De tus ojos a la base del parabrisas (horizontal)', 50, 160),
  { key: 'rake', label: 'Inclinación del parabrisas', unit: '°', min: 15, max: 70, step: 0.5, get: (g) => g.rake, set: (g, v) => ({ ...g, rake: v }) },
  {
    key: 'screenAhead',
    label: 'Del centro del iPad a la base del parabrisas',
    unit: 'cm',
    min: 5,
    max: 80,
    step: 0.5,
    get: (g) => +((g.glassBase - g.screenAhead) * 100).toFixed(1),
    set: (g, v) => ({ ...g, screenAhead: g.glassBase - v / 100 }),
  },
  cm('screenLateral', 'iPad a la derecha de tus ojos (− izquierda)', -60, 60),
];

function renderForm() {
  const box = $('hgFields');
  box.innerHTML = '';
  for (const f of FIELDS) {
    const row = document.createElement('label');
    row.className = 'field hgField';
    row.innerHTML = `<span>${f.label} (${f.unit})</span>`;
    const input = document.createElement('input');
    input.type = 'number';
    input.inputMode = 'decimal';
    input.min = String(f.min);
    input.max = String(f.max);
    input.step = String(f.step);
    input.value = String(f.get(geom));
    input.onchange = () => {
      const v = Math.min(f.max, Math.max(f.min, parseFloat(input.value)));
      if (Number.isNaN(v)) return;
      setGeom(f.set(geom, v));
    };
    row.appendChild(input);
    if (f.key === 'rake') row.appendChild(measureButton());
    box.appendChild(row);
  }
  const { eyeDx: _x, eyeDy: _y, ...mine } = geom;
  const { eyeDx: _fx, eyeDy: _fy, ...preset } = FORTUNER_2015;
  $<HTMLSelectElement>('hgPreset').value = JSON.stringify(mine) === JSON.stringify(preset) ? 'fortuner' : 'custom';
  $<HTMLSelectElement>('hgTop').value = geom.topEdge;
  $<HTMLInputElement>('hgOptics').checked = opticsOn;
  $<HTMLInputElement>('hgEyeDy').value = String(Math.round(geom.eyeDy * 100));
  $<HTMLInputElement>('hgEyeDx').value = String(Math.round(geom.eyeDx * 100));
  renderReadout();
}

function renderReadout() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const img = virtualImage(buildOptics(geom, w, h));
  const advice = placementAdvice(geom, w, h, -4);
  const road = (m: number) => (Number.isFinite(m) ? `${m.toFixed(0)} m` : 'el horizonte');
  const lines = [
    `La imagen se verá a <b>${img.distance.toFixed(2)} m</b> de tus ojos, <b>${img.widthDeg.toFixed(0)}°</b> de ancho, y cubre la vía desde <b>${road(img.roadFrom)}</b> hasta <b>${road(img.roadTo)}</b>.`,
  ];
  const off = (geom.glassBase - geom.screenAhead) - advice.fromGlassBase;
  if (Math.abs(off) > 0.01) {
    lines.push(
      `Para centrarla en la vía (~20 m) pon el centro del iPad a <b>${(advice.fromGlassBase * 100).toFixed(0)} cm</b> de la base del parabrisas ` +
        `(${off > 0 ? 'acércalo' : 'aléjalo'} ${Math.abs(off * 100).toFixed(0)} cm). <button id="hgUseAdvice" class="ghost" type="button">Usar</button>`,
    );
  }
  if (!img.hoodClear) lines.push('⚠ La parte baja de la imagen queda detrás del capó.');
  if (img.highDeg < 0) lines.push('⚠ La imagen no llega al horizonte: lo lejano no se verá.');
  lines.push('De día el reflejo es tenue; pruébalo primero al atardecer, de noche o en un estacionamiento techado.');
  $('hgReadout').innerHTML = lines.map((l) => `<p>${l}</p>`).join('');
  const use = document.getElementById('hgUseAdvice');
  if (use) use.onclick = () => setGeom({ ...geom, screenAhead: advice.screenAhead });
}

function setGeom(g: HudGeometry) {
  geom = g;
  saveHudGeometry(geom);
  renderForm();
  changed();
}

/** Windshield angle with this device's own tilt sensor: lay it flat on the glass. */
function measureButton(): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'ghost';
  b.textContent = 'Medir';
  b.title = 'Apoya este equipo plano sobre el parabrisas y toca Medir';
  b.onclick = async () => {
    const DOE = DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> };
    try {
      if (DOE.requestPermission && (await DOE.requestPermission()) !== 'granted') throw new Error();
    } catch {
      return toast('Sin permiso de movimiento: escribe el ángulo a mano');
    }
    b.textContent = 'Midiendo…';
    const samples: number[] = [];
    const on = (e: DeviceOrientationEvent) => {
      if (e.beta == null || e.gamma == null) return;
      // Tilt of the device's screen plane from horizontal, whichever way it lies on the glass.
      const b = (e.beta * Math.PI) / 180;
      const g = (e.gamma * Math.PI) / 180;
      samples.push((Math.acos(Math.abs(Math.cos(b) * Math.cos(g))) * 180) / Math.PI);
    };
    window.addEventListener('deviceorientation', on);
    setTimeout(() => {
      window.removeEventListener('deviceorientation', on);
      b.textContent = 'Medir';
      if (samples.length < 5) return toast('Este equipo no reporta inclinación: escribe el ángulo a mano');
      samples.sort((x, y) => x - y);
      const rake = +samples[Math.floor(samples.length / 2)].toFixed(1);
      setGeom({ ...geom, rake });
      toast(`Parabrisas a ${rake}° de la horizontal`);
    }, 1500);
  };
  return b;
}

/** Opens the measurements sheet (also from the iPad's HUD screen). */
export function openHudGeom() {
  renderForm();
  $('hudGeom').hidden = false;
}

export function initHudSetup() {
  $('hgPreset').onchange = () => {
    if ($<HTMLSelectElement>('hgPreset').value === 'fortuner') setGeom({ ...FORTUNER_2015, eyeDx: geom.eyeDx, eyeDy: geom.eyeDy });
  };
  $('hgTop').onchange = () => setGeom({ ...geom, topEdge: $<HTMLSelectElement>('hgTop').value as HudGeometry['topEdge'] });
  $('hgOptics').onchange = () => {
    opticsOn = $<HTMLInputElement>('hgOptics').checked;
    saveOpticsOn(opticsOn);
    changed();
  };
  // Fine alignment while looking at the reflection on a straight road: move the assumed eye.
  const fine = (id: string, key: 'eyeDy' | 'eyeDx') => {
    $<HTMLInputElement>(id).oninput = () => {
      geom = { ...geom, [key]: parseFloat($<HTMLInputElement>(id).value) / 100 };
      saveHudGeometry(geom);
      renderReadout();
      changed();
    };
  };
  fine('hgEyeDy', 'eyeDy');
  fine('hgEyeDx', 'eyeDx');
  const open = openHudGeom;
  $('hudGeomBtn').onclick = open;
  $('hudGeomOpen').onclick = open;
  $('hgClose').onclick = () => ($('hudGeom').hidden = true);
  window.addEventListener('resize', () => {
    changed();
    if (!$('hudGeom').hidden) renderReadout();
  });
}
