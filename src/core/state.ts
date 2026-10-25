// The few values every module needs to read. Each module owns its own private state;
// only put something here when two or more modules genuinely share it.
import type { LatLon } from './geo.ts';
import type { Route } from './route.ts';
import type { Source } from './types.ts';
import type { Arrival } from '../remote/protocol.ts';

export type Mode = 'gps' | 'sim' | 'replay';
export type Display = 'camera' | 'hud';

export const app = {
  mode: 'gps' as Mode,
  display: 'camera' as Display,
  dest: null as { point: LatLon; label: string } | null,
  from: null as LatLon | null, // where a simulation starts, typed or picked on the map; null = this phone's GPS
  route: null as Route | null,
  arrival: null as Arrival | null, // exact arrival point picked in the maqueta (building entrance), if any
  source: null as Source | null, // where the car's position comes from
  stream: null as MediaStream | null, // camera feed
  running: false,
  yaw: 0, // direction of travel, degrees from north (written by drive/navigation)
};
