// The setup screen: pick a mode, resolve the destination (typed, pasted or shared from Maps/Waze).
import { extractUrl, resolveDestination } from './core/links.ts';
import { app, type Display, type Mode } from './core/state.ts';
import { $, setText, setupMsg } from './core/ui.ts';
import { syncCalibProfile } from './render/calibDock.ts';

function syncMode() {
  app.mode = (document.querySelector<HTMLInputElement>('input[name=mode]:checked')?.value ?? 'gps') as Mode;
  $('fromField').hidden = app.mode !== 'sim';
  $('replayFields').hidden = app.mode !== 'replay';
}

function syncDisplay() {
  const chosen = (document.querySelector<HTMLInputElement>('input[name=display]:checked')?.value ?? 'camera') as Display;
  app.display = chosen;
  try {
    localStorage.setItem('ar-nav.display', chosen);
  } catch {
    /* ignore */
  }
  syncCalibProfile();
}

export async function resolveDestInput(): Promise<void> {
  const raw = $<HTMLInputElement>('dest').value.trim();
  if (!raw) {
    app.dest = null;
    setText('destLabel', '');
    return;
  }
  setText('destLabel', 'Buscando…');
  try {
    app.dest = await resolveDestination(raw);
    setText('destLabel', `✓ ${app.dest.label}`);
  } catch (e) {
    app.dest = null;
    setText('destLabel', '');
    throw e;
  }
}

export function initSetupScreen() {
  document.querySelectorAll<HTMLInputElement>('input[name=mode]').forEach((r) => r.addEventListener('change', syncMode));
  document.querySelectorAll<HTMLInputElement>('input[name=display]').forEach((r) => r.addEventListener('change', syncDisplay));
  
  try {
    const savedDisplay = localStorage.getItem('ar-nav.display') as Display | null;
    if (savedDisplay === 'camera' || savedDisplay === 'hud') {
      const radio = document.querySelector<HTMLInputElement>(`input[name=display][value="${savedDisplay}"]`);
      if (radio) radio.checked = true;
    }
  } catch {
    /* ignore */
  }

  // Browsers restore the checked radio after a reload without firing `change`.
  syncMode();
  syncDisplay();
  window.addEventListener('pageshow', () => {
    syncMode();
    syncDisplay();
  });

  $('dest').addEventListener('change', () => resolveDestInput().catch((e) => setupMsg((e as Error).message)));
  $('paste').onclick = async () => {
    try {
      const text = await navigator.clipboard.readText();
      $<HTMLInputElement>('dest').value = text;
      setupMsg('');
      await resolveDestInput();
    } catch (e) {
      setupMsg(e instanceof Error && e.name === 'NotAllowedError' ? 'Permite el acceso al portapapeles o pega a mano' : (e as Error).message);
    }
  };

  // Opened from the Android share sheet (Web Share Target) — Google Maps / Waze "Compartir".
  const q = new URLSearchParams(location.search);
  const shared = [q.get('url'), q.get('text'), q.get('title')].filter(Boolean).join(' ');
  if (shared) {
    $<HTMLInputElement>('dest').value = extractUrl(shared) ?? shared;
    history.replaceState(null, '', '/');
    resolveDestInput().catch((e) => setupMsg((e as Error).message));
  }
}
