// Camera calibration. Tune these once with the phone mounted (sliders in the ⚙ panel).

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

export const defaultsFor = (layout: Layout): Calib => ({ ...DEFAULTS[layout] });

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

const keyFor = (layout: Layout) => `ar-nav.calib.${layout}`;
const LEGACY_KEY = 'ar-nav.calib'; // before portrait support there was a single landscape profile

export function loadCalib(layout: Layout): Calib {
  try {
    const raw = localStorage.getItem(keyFor(layout)) ?? (layout === 'landscape' ? localStorage.getItem(LEGACY_KEY) : null);
    return { ...DEFAULTS[layout], ...(JSON.parse(raw ?? '{}') as Partial<Calib>) };
  } catch {
    return defaultsFor(layout);
  }
}

export function saveCalib(c: Calib, layout: Layout) {
  try {
    localStorage.setItem(keyFor(layout), JSON.stringify(c));
  } catch {
    /* ignore */
  }
}
