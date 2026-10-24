// Contracts shared by the navigation, rendering and hazard modules.
import type { LatLon } from './geo.ts';

export interface Fix {
  p: LatLon;
  speed: number | null; // m/s
  heading: number | null; // degrees from north
  accuracy: number | null; // metres
  t: number; // performance.now() ms when this fix was valid
}

export interface Source {
  readonly name: 'gps' | 'sim' | 'replay';
  start(): void;
  stop(): void;
  current(now: number): Fix | null;
}
