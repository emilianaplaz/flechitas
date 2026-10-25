// Which side effects a Manejar/Caminar change needs, as data so it can be tested without a browser.
import type { Display, Mode } from '../core/state.ts';

export type Travel = 'drive' | 'walk';

export type SwitchAction =
  | 'startSensors'
  | 'stopSensors'
  | 'startAutoTilt'
  | 'stopAutoTilt'
  | 'startBumpWatcher'
  | 'stopBumpWatcher'
  | 'showAlign'
  | 'hideAlign'
  | 'persist'
  | 'syncControls'
  | 'toast:walk'
  | 'toast:drive';

export interface SwitchInput {
  from: Travel;
  to: Travel;
  mode: Mode;
  detectBumps: boolean;
  display: Display;
  running: boolean;
}

/** Order matters: the actions that can fail (sensor permission) come before the ones that record the new state. */
export function switchPlan({ from, to, mode, detectBumps, display, running }: SwitchInput): SwitchAction[] {
  const record: SwitchAction[] = ['persist', 'syncControls'];
  if (!running) return record;
  if (from === to || mode === 'replay' || display === 'hud') return [];
  if (to === 'walk') return ['startSensors', 'stopAutoTilt', 'stopBumpWatcher', 'showAlign', ...record, 'toast:walk'];
  const bumps: SwitchAction[] = detectBumps && mode === 'gps' ? ['startBumpWatcher'] : [];
  return ['stopSensors', 'startAutoTilt', ...bumps, 'hideAlign', ...record, 'toast:drive'];
}
