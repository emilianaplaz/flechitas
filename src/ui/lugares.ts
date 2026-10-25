// Ajustes → "Lugares guardados": the places saved from the map. Each row: name (tap ✎ to rename),
// when it was saved and how far it is now, "Ir" (make it the destination) and delete.
import { haversine } from '../core/geo.ts';
import { formatDistance } from '../core/route.ts';
import { $, toast } from '../core/ui.ts';
import { loadPins, removePin, renamePin } from '../find/pins.ts';
import { setDestination } from '../setup.ts';
import { getHere, refreshSavedPins } from './destino.ts';

const button = (cls: string, text: string, attrs: Record<string, string>) => {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  b.textContent = text;
  for (const [k, v] of Object.entries(attrs)) b.setAttribute(k, v);
  return b;
};

export function renderLugares() {
  const pins = loadPins();
  const list = $('placesList');
  list.hidden = pins.length === 0;
  $('placesEmpty').hidden = pins.length > 0;
  list.replaceChildren(
    ...pins
      .slice()
      .reverse()
      .map((x) => {
        const row = document.createElement('div');
        row.className = 'devRow placeRow';
        row.dataset.id = x.id;
        const text = document.createElement('div');
        text.className = 'devText';
        const name = document.createElement('span');
        name.className = 'devTitle placeName';
        name.textContent = x.label;
        const meta = document.createElement('span');
        meta.className = 'muted';
        const dist = document.createElement('b');
        dist.className = 'placeDist';
        meta.append(
          dist,
          ` · ${new Date(x.at).toLocaleString('es', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`,
        );
        text.append(name, meta);
        row.append(
          text,
          button('fX', '✎', { 'data-edit': x.id, 'aria-label': `Renombrar ${x.label}` }),
          button('ghost', 'Ir', { 'data-go': x.id }),
          button('fX', '✕', { 'data-del': x.id, 'aria-label': `Borrar ${x.label}` }),
        );
        return row;
      }),
  );
  updateDistances();
}

/** Distances change as you move: only their text is touched, so a name being edited isn't rebuilt. */
function updateDistances() {
  const me = getHere();
  const pins = new Map(loadPins().map((x) => [x.id, x]));
  document.querySelectorAll<HTMLElement>('#placesList .placeRow').forEach((row) => {
    const x = pins.get(row.dataset.id ?? '');
    const d = row.querySelector<HTMLElement>('.placeDist');
    if (!x || !d) return;
    const text = me ? `a ${formatDistance(haversine(me, x.p))}` : 'Sin ubicación';
    if (d.textContent !== text) d.textContent = text;
  });
}

function editName(row: HTMLElement) {
  const name = row.querySelector<HTMLElement>('.placeName');
  const id = row.dataset.id;
  if (!name || !id || row.querySelector('input')) return;
  const input = document.createElement('input');
  input.type = 'text';
  input.value = name.textContent ?? '';
  input.maxLength = 40;
  input.className = 'placeInput';
  input.setAttribute('aria-label', 'Nombre del lugar');
  let done = false;
  const finish = (save: boolean) => {
    if (done) return;
    done = true;
    if (save) {
      renamePin(id, input.value);
      refreshSavedPins();
    }
    renderLugares();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
  name.replaceWith(input);
  input.focus();
  input.select();
}

/** `onGo`: leave Ajustes for the map once a place is chosen as the destination. */
export function initLugares(onGo: () => void) {
  const tabs = [
    ['tabDev', 'panDev'],
    ['tabPlaces', 'panPlaces'],
    ['tabAccount', 'panAccount'],
  ] as const;
  const tab = (active: string) => {
    for (const [t, p] of tabs) {
      $(t).setAttribute('aria-pressed', String(t === active));
      $(p).hidden = t !== active;
    }
    if (active === 'tabPlaces') renderLugares();
  };
  for (const [t] of tabs) $(t).onclick = () => tab(t);
  setInterval(() => {
    if (!$('panPlaces').hidden && !$('scrDispositivos').hidden) updateDistances();
  }, 3000);
  $('placesList').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('button');
    const row = b?.closest<HTMLElement>('.placeRow');
    if (!b || !row) return;
    if (b.dataset.edit) editName(row);
    else if (b.dataset.del) {
      removePin(b.dataset.del);
      refreshSavedPins();
      renderLugares();
    } else if (b.dataset.go) {
      const x = loadPins().find((p) => p.id === b.dataset.go);
      if (!x) return;
      setDestination({ point: x.p, label: x.label });
      onGo();
    }
  });
}

/** Bookmark button beside "¿A dónde vas?": tapping it lists the saved places; tapping one sets the destination. */
export function initDestShortcut() {
  const btn = $('placesBtn');
  const menu = $('destPlaces');
  const close = () => {
    menu.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
  };
  const open = () => {
    const pins = loadPins().slice().reverse();
    if (!pins.length) return toast('Aún no guardaste lugares. Usa el botón del marcador en el mapa.', 3500);
    const me = getHere();
    menu.replaceChildren(
      ...pins.map((x) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.role = 'option';
        b.dataset.id = x.id;
        const name = document.createElement('span');
        name.className = 'pmName';
        name.textContent = x.label;
        const d = document.createElement('span');
        d.className = 'pmDist muted';
        d.textContent = me ? formatDistance(haversine(me, x.p)) : '';
        b.append(name, d);
        return b;
      }),
    );
    menu.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
  };
  btn.onclick = () => (menu.hidden ? open() : close());
  document.addEventListener('pointerdown', (e) => {
    const t = e.target as Node;
    if (!menu.hidden && !menu.contains(t) && !btn.contains(t)) close();
  });
  $('dest').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
  });
  menu.addEventListener('click', (e) => {
    const id = (e.target as HTMLElement).closest<HTMLElement>('button')?.dataset.id;
    const x = loadPins().find((p) => p.id === id);
    if (!x) return;
    setDestination({ point: x.p, label: x.label });
    close();
  });
}
