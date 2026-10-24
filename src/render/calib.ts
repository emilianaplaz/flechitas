// Camera calibration. Tune these once with the phone mounted (sliders in the ⚙ panel).
import type { Display } from '../core/state.ts';
import { FORTUNER_2015, type HudGeometry } from './optics.ts';

export interface Calib {
  pitch: number; // degrees the camera looks down
  fov: number; // vertical field of view of what's visible on screen, degrees
  height: number; // camera height above the road, m
  yawOffset: number; // mount not pointing straight ahead, degrees (+ = right)
  lateral: number; // car's distance to the right of the route line (OSM line = road centre), m
  ribbonWidth: number; // m
  ribbonStart: number; // m ahead of the car where the guide begins (skips the bonnet and dashboard)
}

export type Layout = 'landscape' | 'portrait';

// A phone held upright sees a much taller slice of the road than one held sideways,
// so the vertical field of view and the guide start differ per orientation.
const DEFAULTS: Record<Layout, Calib> = {
  landscape: { pitch: 5, fov: 40, height: 1.3, yawOffset: 0, lateral: 1.6, ribbonWidth: 3, ribbonStart: 3 },
  portrait: { pitch: 5, fov: 65, height: 1.3, yawOffset: 0, lateral: 1.6, ribbonWidth: 3, ribbonStart: 6 },
};

const HUD_DEFAULTS: Record<Layout, Calib> = {
  landscape: { pitch: 8, fov: 45, height: 1.2, yawOffset: 0, lateral: 1.6, ribbonWidth: 3.2, ribbonStart: 2.5 },
  portrait: { pitch: 8, fov: 60, height: 1.2, yawOffset: 0, lateral: 1.6, ribbonWidth: 3.2, ribbonStart: 4.5 },
};

export const defaultsFor = (layout: Layout, display: Display = 'camera'): Calib =>
  display === 'hud' ? { ...HUD_DEFAULTS[layout] } : { ...DEFAULTS[layout] };

export function currentLayout(): Layout {
  return window.innerHeight > window.innerWidth ? 'portrait' : 'landscape';
}

export const CALIB_RANGES: Record<keyof Calib, { min: number; max: number; step: number; label: string; unit: string }> = {
  pitch: { min: -10, max: 25, step: 0.5, label: 'Inclinación', unit: '°' },
  fov: { min: 20, max: 90, step: 1, label: 'Campo de visión', unit: '°' },
  height: { min: 0.5, max: 3, step: 0.05, label: 'Altura cámara', unit: 'm' },
  yawOffset: { min: -20, max: 20, step: 0.5, label: 'Giro del soporte', unit: '°' },
  lateral: { min: -5, max: 5, step: 0.1, label: 'Posición en el carril', unit: 'm' },
  ribbonWidth: { min: 1, max: 6, step: 0.1, label: 'Ancho de la guía', unit: 'm' },
  ribbonStart: { min: 2, max: 20, step: 0.5, label: 'Inicio de la guía', unit: 'm' },
};

const keyFor = (layout: Layout, display: Display = 'camera') =>
  display === 'hud' ? `ar-nav.calib.hud.${layout}` : `ar-nav.calib.${layout}`;
const LEGACY_KEY = 'ar-nav.calib'; // before portrait support there was a single landscape profile

export function loadCalib(layout: Layout, display: Display = 'camera'): Calib {
  try {
    const raw =
      localStorage.getItem(keyFor(layout, display)) ??
      (display === 'camera' && layout === 'landscape' ? localStorage.getItem(LEGACY_KEY) : null);
    const def = defaultsFor(layout, display);
    return { ...def, ...(JSON.parse(raw ?? '{}') as Partial<Calib>) };
  } catch {
    return defaultsFor(layout, display);
  }
}

export function saveCalib(c: Calib, layout: Layout, display: Display = 'camera') {
  try {
    localStorage.setItem(keyFor(layout, display), JSON.stringify(c));
  } catch {
    /* ignore */
  }
}

export interface FlipState {
  mirrorX: boolean;
  flipY: boolean;
}

export function loadFlip(): FlipState {
  try {
    return {
      mirrorX: localStorage.getItem('ar-nav.hud.mirrorX') === 'true',
      flipY: localStorage.getItem('ar-nav.hud.flipY') === 'true',
    };
  } catch {
    return { mirrorX: true, flipY: false };
  }
}

// ---- windshield HUD geometry (exact optics, see optics.ts) ----

/** Measurements of the car and where the iPad sits; defaults are the Toyota Fortuner 2015 preset. */
export function loadHudGeometry(): HudGeometry {
  try {
    return { ...FORTUNER_2015, ...(JSON.parse(localStorage.getItem('ar-nav.hud.geometry') ?? '{}') as Partial<HudGeometry>) };
  } catch {
    return { ...FORTUNER_2015 };
  }
}

export function saveHudGeometry(g: HudGeometry) {
  try {
    localStorage.setItem('ar-nav.hud.geometry', JSON.stringify(g));
  } catch {
    /* ignore */
  }
}

/** "Óptica calculada": on by default; off falls back to the simple CSS mirror (⇄ ⇅). */
export function loadOpticsOn(): boolean {
  try {
    return localStorage.getItem('ar-nav.hud.optics') !== 'false';
  } catch {
    return true;
  }
}

export function saveOpticsOn(on: boolean) {
  try {
    localStorage.setItem('ar-nav.hud.optics', String(on));
  } catch {
    /* ignore */
  }
}

export function saveFlip(flip: FlipState) {
  try {
    localStorage.setItem('ar-nav.hud.mirrorX', String(flip.mirrorX));
    localStorage.setItem('ar-nav.hud.flipY', String(flip.flipY));
  } catch {
    /* ignore */
  }
}
