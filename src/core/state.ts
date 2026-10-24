// The few values every module needs to read. Each module owns its own private state;
// only put something here when two or more modules genuinely share it.
import type { LatLon } from './geo.ts';
import type { Route } from './route.ts';
import type { Source } from './types.ts';

export type Mode = 'gps' | 'sim' | 'replay';

export const app = {
  mode: 'gps' as Mode,
  dest: null as { point: LatLon; label: string } | null,
  route: null as Route | null,
  source: null as Source | null, // where the car's position comes from
  stream: null as MediaStream | null, // camera feed
  running: false,
  yaw: 0, // direction of travel, degrees from north (written by drive/navigation)
};
