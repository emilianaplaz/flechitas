// The flat HUD drawn over the 3D scene: speed, remaining distance, next maneuver, hazard banner.
import { type HazardType } from '../hazards/store.ts';
import { formatDistance, type Route, type Step, type TurnKind } from '../core/route.ts';
import { app, type Display } from '../core/state.ts';
import { $, setText } from '../core/ui.ts';
import { loadFlip, saveFlip, type FlipState } from './calib.ts';
import { applyHudView } from './hudSetup.ts';

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
  speedLimit?: number | null; // km/h, from the maqueta; hidden when unknown
}

let flipState: FlipState = loadFlip();

export function applyFlip(flip: FlipState) {
  flipState = flip;
  document.documentElement.style.setProperty('--mirror-x', flip.mirrorX ? '-1' : '1');
  document.documentElement.style.setProperty('--flip-y', flip.flipY ? '-1' : '1');
  $('mirrorX')?.classList.toggle('active', flip.mirrorX);
  $('flipY')?.classList.toggle('active', flip.flipY);
}

export function initHudControls() {
  const mx = $<HTMLButtonElement>('mirrorX');
  const fy = $<HTMLButtonElement>('flipY');
  if (mx) {
    mx.onclick = () => {
      flipState = { ...flipState, mirrorX: !flipState.mirrorX };
      saveFlip(flipState);
      applyFlip(flipState);
    };
  }
  if (fy) {
    fy.onclick = () => {
      flipState = { ...flipState, flipY: !flipState.flipY };
      saveFlip(flipState);
      applyFlip(flipState);
    };
  }
}

export function showHud(display: Display) {
  $('hud').hidden = false;
  const isHud = display === 'hud';
  document.body.classList.toggle('hud-mode', isHud);
  document.querySelectorAll<HTMLElement>('.hudOnly').forEach((el) => {
    el.hidden = !isHud;
  });
  if (isHud) applyFlip(flipState);
  else {
    document.documentElement.style.setProperty('--mirror-x', '1');
    document.documentElement.style.setProperty('--flip-y', '1');
  }
  // Exact optics replace the CSS mirror and warp the text so it reads right in the glass.
  applyHudView();
}

export function renderHud(h: HudInput) {
  const { route } = h;
  const isHud = app.display === 'hud';
  setText('speed', String(Math.round(h.speed * 3.6)));
  $('limit').hidden = !h.speedLimit;
  if (h.speedLimit) setText('limit', String(h.speedLimit));

  const remainingEl = $('remaining');
  if (isHud) {
    remainingEl.textContent = '';
    remainingEl.hidden = true;
  } else {
    remainingEl.hidden = false;
    const mins = route.duration ? Math.max(1, Math.round((route.duration * h.remaining) / route.poly.length / 60)) : null;
    setText('remaining', `${formatDistance(h.remaining)}${mins ? ` · ${mins} min` : ''}`);
    // ETA card: minutes, arrival time and place, distance left.
    setText('etaMin', mins ? `${mins} min` : '—');
    const at = mins ? new Date(Date.now() + mins * 60000).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' }) : '';
    const place = app.arrival?.label ?? app.dest?.label.split(',')[0] ?? '';
    setText('etaDest', [at && `Llegada: ${at}`, place].filter(Boolean).join(' · '));
    setText('etaKm', formatDistance(h.remaining));
  }

  if (h.next) {
    renderGlyph(h.next.kind);
    setText('mDist', formatDistance(h.distToNext));
    setText('mText', h.next.text);
    setText('mStreet', h.next.street);
  }
  $('arrived').hidden = h.remaining > 20;

  if (h.offRoute) setText('mText', 'Fuera de ruta…');
}

export function hideHud() {
  $('hud').hidden = true;
  $('arrived').hidden = true;
  document.body.classList.remove('hud-mode');
  document.documentElement.style.setProperty('--mirror-x', '1');
  document.documentElement.style.setProperty('--flip-y', '1');
  $('hudProjection').style.transform = '';
  $('hudProjection').style.transformOrigin = '';
}
