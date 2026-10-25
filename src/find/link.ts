// The two ends of "Ver a alguien". The watcher shows a code and receives positions; the sharer types
// (or opens a link with) that code and sends its GPS. Like the iPad HUD link, the one that shows the
// code owns the peer id and the other dials it. No video travels, only a position about once a second.
import type { DataConnection, Peer } from 'peerjs'; // loaded on demand
import { GpsSource } from '../drive/sources.ts';
import { LOST_MS, PING_MS, findPeerId, newShareCode, parsePos, type FindMsg, type Sighting } from './protocol.ts';

export type WatchState = 'waiting' | 'live' | 'lost' | 'offline';
export type ShareState = 'connecting' | 'on' | 'lost';

export interface WatchEvents {
  onCode(code: string): void;
  onPos(s: Sighting): void;
  onState(s: WatchState): void;
}

export class Watcher {
  private peer: Peer | null = null;
  private conn: DataConnection | null = null;
  private lastHeard = 0;
  private timer = 0;
  private stopped = false;
  private code = newShareCode();

  constructor(private ev: WatchEvents) {}

  async start() {
    this.stopped = false;
    await this.open();
    this.timer = window.setInterval(() => {
      if (this.conn && performance.now() - this.lastHeard > LOST_MS) {
        this.conn.close();
        this.conn = null;
        this.ev.onState('lost');
      }
    }, 1000);
  }

  stop() {
    this.stopped = true;
    clearInterval(this.timer);
    this.conn?.close();
    this.conn = null;
    this.peer?.destroy();
    this.peer = null;
  }

  private async open() {
    const { Peer } = await import('peerjs');
    if (this.stopped) return;
    this.ev.onState('waiting');
    const p = new Peer(findPeerId(this.code));
    this.peer = p;
    p.on('open', () => this.ev.onCode(this.code));
    p.on('connection', (c) => {
      // The first sharer keeps the link: a second connection is ignored until that one goes silent.
      if (this.conn && performance.now() - this.lastHeard <= LOST_MS) return c.close();
      this.conn?.close();
      this.conn = c;
      this.lastHeard = performance.now();
      c.on('data', (raw) => {
        this.lastHeard = performance.now();
        const s = parsePos(raw);
        if (!s) return;
        this.ev.onState('live');
        this.ev.onPos(s);
      });
      c.on('close', () => {
        if (this.conn !== c) return;
        this.conn = null;
        this.ev.onState('lost');
      });
    });
    p.on('disconnected', () => !this.stopped && p.reconnect());
    p.on('error', (e) => {
      if (e.type === 'unavailable-id') {
        this.code = newShareCode(); // someone else holds this code: take a new one
        p.destroy();
        void this.open();
      } else if (e.type === 'network' || e.type === 'server-error' || e.type === 'socket-error') {
        this.ev.onState('offline');
      }
    });
  }
}

export interface ShareEvents {
  onState(s: ShareState): void;
  onError(msg: string): void;
}

/** Shares this phone's GPS with the watcher showing `code`. Call `start` inside a tap: it asks for the location permission. */
export class Sharer {
  private peer: Peer | null = null;
  private conn: DataConnection | null = null;
  private gps: GpsSource;
  private timer = 0;
  private retry = 0;
  private stopped = false;
  private lastSent = 0;
  private wakeLock: { release(): Promise<void> } | null = null;

  constructor(
    private code: string,
    private ev: ShareEvents,
  ) {
    this.gps = new GpsSource((f) => this.send({ t: 'pos', lat: f.p.lat, lon: f.p.lon, acc: f.accuracy }), (m) => ev.onError(m));
  }

  async start() {
    this.stopped = false;
    this.gps.start();
    this.ev.onState('connecting');
    this.keepAwake();
    await this.dial();
  }

  stop() {
    this.stopped = true;
    clearInterval(this.timer);
    this.gps.stop();
    this.conn?.close();
    this.conn = null;
    this.peer?.destroy();
    this.peer = null;
    void this.wakeLock?.release().catch(() => {});
    this.wakeLock = null;
  }

  /** A sleeping screen stops the browser's GPS and the link, so hold it awake while sharing (best effort). */
  private keepAwake() {
    try {
      (navigator as unknown as { wakeLock?: { request(t: string): Promise<{ release(): Promise<void> }> } }).wakeLock
        ?.request('screen')
        .then((lock) => (this.wakeLock = lock))
        .catch(() => {});
    } catch {
      /* not supported */
    }
  }

  private send(m: FindMsg) {
    if (!this.conn?.open) return;
    this.conn.send(m);
    this.lastSent = performance.now();
  }

  private async dial() {
    const { Peer } = await import('peerjs');
    if (this.stopped) return;
    this.peer?.destroy();
    const p = new Peer();
    this.peer = p;
    p.on('error', (e) => {
      if (e.type === 'peer-unavailable') this.ev.onError('Ese código no está activo. Revisa los 6 dígitos con quien te los dio.');
      this.drop(p);
    });
    p.on('open', () => {
      const c = p.connect(findPeerId(this.code), { serialization: 'json' });
      this.conn = c;
      c.on('open', () => {
        if (this.peer !== p) return;
        this.retry = 0;
        this.ev.onState('on');
        clearInterval(this.timer);
        this.timer = window.setInterval(() => performance.now() - this.lastSent >= PING_MS && this.send({ t: 'ping' }), PING_MS);
        const fix = this.gps.current();
        if (fix) this.send({ t: 'pos', lat: fix.p.lat, lon: fix.p.lon, acc: fix.accuracy });
      });
      c.on('close', () => this.drop(p));
      c.on('error', () => this.drop(p));
    });
  }

  private drop(p: Peer) {
    if (this.peer !== p || this.stopped) return;
    clearInterval(this.timer);
    this.conn = null;
    this.ev.onState('lost');
    this.retry = Math.min(this.retry + 1, 5);
    setTimeout(() => this.peer === p && !this.stopped && void this.dial(), 1000 * this.retry);
  }
}
