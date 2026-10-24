// The setup screen: pick a mode, resolve the destination (typed, pasted or shared from Maps/Waze).
import { extractUrl, resolveDestination } from './core/links.ts';
import { app, type Mode } from './core/state.ts';
import { $, setText, setupMsg } from './core/ui.ts';

function syncMode() {
  app.mode = (document.querySelector<HTMLInputElement>('input[name=mode]:checked')?.value ?? 'gps') as Mode;
  $('fromField').hidden = app.mode !== 'sim';
  $('replayFields').hidden = app.mode !== 'replay';
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
  // Browsers restore the checked radio after a reload without firing `change`.
  syncMode();
  window.addEventListener('pageshow', syncMode);

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
