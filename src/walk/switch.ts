// Caminar (phone in hand, sensors steer the view) vs Manejar (phone fixed on the dash). The only owner of the change.
import { app } from '../core/state.ts';
import { $, toast } from '../core/ui.ts';
import { startBumpWatcher, stopBumpWatcher } from '../hazards/ui.ts';
import { startAutoTilt, stopAutoTilt } from '../render/calibDock.ts';
import { startSensors, stopSensors } from './view.ts';
import { switchPlan, type SwitchAction, type Travel } from './switchPlan.ts';

const WALK_KEY = 'ar-nav.walk';
const TOASTS = {
  'toast:walk': 'Modo caminar: sostén el teléfono frente a ti',
  'toast:drive': 'Modo manejar: fija el teléfono al tablero',
} as const;

let switching = false;

export const currentTravel = (): Travel => ($<HTMLInputElement>('useSensors').checked ? 'walk' : 'drive');

/** Both segmented controls (Mapa and the drive screen) and the hidden flag the start handler reads. */
function syncControls(to: Travel) {
  $<HTMLInputElement>('useSensors').checked = to === 'walk';
  for (const [walk, drive] of [['goWalk', 'goDrive'], ['travelWalk', 'travelDrive']]) {
    $(walk).setAttribute('aria-pressed', String(to === 'walk'));
    $(drive).setAttribute('aria-pressed', String(to === 'drive'));
  }
}

function persist(to: Travel) {
  try {
    localStorage.setItem(WALK_KEY, to === 'walk' ? '1' : '0');
  } catch {
    /* ignore */
  }
}

export function savedTravel(): Travel {
  try {
    return localStorage.getItem(WALK_KEY) === '1' ? 'walk' : 'drive';
  } catch {
    return 'drive';
  }
}

async function run(action: SwitchAction, to: Travel) {
  switch (action) {
    case 'startSensors': return startSensors();
    case 'stopSensors': return stopSensors();
    case 'startAutoTilt': return startAutoTilt();
    case 'stopAutoTilt': return stopAutoTilt();
    case 'stopBumpWatcher': return stopBumpWatcher();
    case 'startBumpWatcher':
      // Bump detection is optional: without motion permission the trip goes on without it.
      return startBumpWatcher().catch((e: Error) => {
        stopBumpWatcher();
        toast(`Sin detección de huecos: ${e.message}`, 5000);
      });
    case 'showAlign': $('align').hidden = false; return;
    case 'hideAlign': $('align').hidden = true; return;
    case 'persist': return persist(to);
    case 'syncControls': return syncControls(to);
    case 'toast:walk':
    case 'toast:drive': return toast(TOASTS[action]);
  }
}

/** Call it straight from the tap: iOS only shows the sensor permission prompt there. */
export async function setTravel(to: Travel) {
  if (switching) return;
  const plan = switchPlan({
    from: currentTravel(),
    to,
    mode: app.mode,
    detectBumps: $<HTMLInputElement>('detectBumps').checked,
    display: app.display,
    running: app.running,
  });
  switching = true;
  try {
    for (const action of plan) await run(action, to);
  } catch (e) {
    // Only startSensors can throw here, and it runs before anything was recorded, so the flags still say the old mode.
    stopSensors();
    toast((e as Error).message, 5000);
  } finally {
    switching = false;
  }
}
