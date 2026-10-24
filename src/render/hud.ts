// The flat HUD drawn over the 3D scene: speed, remaining distance, next maneuver, hazard banner.
import { HAZARD_LABEL, type HazardType } from '../hazards/store.ts';
import { formatDistance, type Route, type Step, type TurnKind } from '../core/route.ts';
import { $, setText } from '../core/ui.ts';

const GLYPH_ROT: Record<TurnKind, number> = {
  'straight': 0,
  'slight-left': -40,
  'left': -90,
  'sharp-left': -135,
  'slight-right': 40,
  'right': 90,
  'sharp-right': 135,
  'uturn': 0,
  'arrive': 0,
};
let lastGlyph = '';
function renderGlyph(kind: TurnKind) {
  if (kind === lastGlyph) return;
  lastGlyph = kind;
  const svg =
    kind === 'arrive'
      ? `<svg viewBox="0 0 64 64"><path d="M32 6c-10 0-18 8-18 18 0 13 18 34 18 34s18-21 18-34C50 14 42 6 32 6zm0 25a7 7 0 1 1 0-14 7 7 0 0 1 0 14z" fill="#22e07a"/></svg>`
      : kind === 'uturn'
        ? `<svg viewBox="0 0 64 64"><path d="M42 56V26a10 10 0 0 0-20 0v14h8L18 54 6 40h8V26a18 18 0 0 1 36 0v30z" fill="#00e676"/></svg>`
        : `<svg viewBox="0 0 64 64"><g transform="rotate(${GLYPH_ROT[kind]} 32 32)"><path d="M32 4 52 28H39v32H25V28H12z" fill="#00e676"/></g></svg>`;
  $('glyph').innerHTML = svg;
}

export interface HudInput {
  route: Route;
  speed: number; // m/s
  remaining: number; // m
  next: Step | null;
  distToNext: number;
  nearestHazard: { type: HazardType; dist: number } | null;
  offRoute: boolean; // show "Fuera de ruta…" in place of the instruction
}

export function renderHud(h: HudInput) {
  const { route } = h;
  setText('speed', String(Math.round(h.speed * 3.6)));
  const mins = route.duration ? Math.max(1, Math.round((route.duration * h.remaining) / route.poly.length / 60)) : null;
  setText('remaining', `${formatDistance(h.remaining)}${mins ? ` · ${mins} min` : ''}`);
  if (h.next) {
    renderGlyph(h.next.kind);
    setText('mDist', formatDistance(h.distToNext));
    setText('mText', h.next.text);
    setText('mStreet', h.next.street);
  }
  $('arrived').hidden = h.remaining > 20;
  $('hazardBanner').hidden = !h.nearestHazard;
  if (h.nearestHazard) setText('hazardBanner', `⚠ ${HAZARD_LABEL[h.nearestHazard.type]} en ${formatDistance(h.nearestHazard.dist)}`);
  if (h.offRoute) setText('mText', 'Fuera de ruta…');
}

export function hideHud() {
  $('hud').hidden = true;
  $('arrived').hidden = true;
}
