// The two ends of "Encontrar". The sharer shows a code, owns the PeerJS id derived from it and sends its
// GPS to the one viewer who dials that id (typing the code or opening the `?comparte=` link). Like the
// iPad HUD link, the one that shows the code owns the peer id and the other dials it. No video travels,
// only a position about once a second.
import type { DataConnection, Peer } from 'peerjs'; // loaded on demand
import { GpsSource } from '../drive/sources.ts';
import { LOST_MS, PING_MS, ViewerSlot, findPeerId, newShareCode, parsePos, type FindMsg, type Sighting } from './protocol.ts';

export type ShareState = 'connecting' | 'waiting' | 'live' | 'offline' | 'expired';
export type WatchState = 'connecting' | 'live' | 'lost' | 'offline' | 'inactive';

export interface ShareEvents {
  onCode(code: string): void;
  onState(s: ShareState): void;
  onError(msg: string): void;
}

/** Shares this phone's GPS with one viewer. Call `start` inside a tap: it asks for the location permission. */
export class Sharer {
  private peer: Peer | null = null;
  private conn: DataConnection | null = null;
  private gps: GpsSource;
  private slot = new ViewerSlot(() => performance.now());
  private timer = 0;
  private stopped = false;
  private lastSent = 0;
  private code = newShareCode();
  private wakeLock: { release(): Promise<void> } | null = null;

  constructor(private ev: ShareEvents) {
    this.gps = new GpsSource((f) => this.send({ t: 'pos', lat: f.p.lat, lon: f.p.lon, acc: f.accuracy }), (m) => ev.onError(m));
  }

  async start() {
    this.stopped = false;
    this.gps.start();
    this.keepAwake();
    this.timer = window.setInterval(() => this.tick(), PING_MS);
    await this.open();
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

  /** Nothing leaves the phone until a viewer holds the seat. */
  private send(m: FindMsg) {
    if (!this.conn?.open) return;
    this.conn.send(m);
    this.lastSent = performance.now();
  }

  private tick() {
    if (this.conn && !this.slot.alive()) {
      this.conn.close();
      this.conn = null;
      this.slot.release();
      this.ev.onState('waiting');
    }
    if (!this.conn && this.slot.expired()) {
      this.stop();
      this.ev.onState('expired');
      return;
    }
    if (performance.now() - this.lastSent >= PING_MS / 2) this.send({ t: 'ping' });
  }

  private async open() {
    const { Peer } = await import('peerjs');
    if (this.stopped) return;
    this.ev.onState('connecting');
    const p = new Peer(findPeerId(this.code));
    this.peer = p;
    p.on('open', () => {
      this.ev.onCode(this.code);
      this.ev.onState(this.conn ? 'live' : 'waiting');
    });
    p.on('connection', (c) => this.onViewer(c));
    p.on('disconnected', () => !this.stopped && p.reconnect());
    p.on('error', (e) => {
      if (e.type === 'unavailable-id') {
        this.code = newShareCode(); // someone else holds this code: take a new one
        p.destroy();
        void this.open();
      } else if (e.type === 'network' || e.type === 'server-error' || e.type === 'socket-error') {
        if (!this.conn) this.ev.onState('offline');
      }
    });
  }

  private onViewer(c: DataConnection) {
    if (!this.slot.admit()) return c.close();
    const old = this.conn;
    this.conn = c;
    old?.close();
    c.on('open', () => {
      if (this.conn !== c) return;
      this.ev.onState('live');
      this.send({ t: 'ping' });
      const fix = this.gps.current();
      if (fix) this.send({ t: 'pos', lat: fix.p.lat, lon: fix.p.lon, acc: fix.accuracy });
    });
    c.on('data', (raw) => {
      if (this.conn === c && (raw as { t?: unknown } | null)?.t === 'ping') this.slot.heard();
    });
    const gone = () => {
      if (this.conn !== c) return;
      this.conn = null;
      this.slot.release();
      this.ev.onState('waiting');
    };
    c.on('close', gone);
    c.on('error', gone);
  }
}

export interface WatchEvents {
  onPos(s: Sighting): void;
  onState(s: WatchState): void;
}

/** Dials the sharer showing `code` and receives its positions, redialing with a growing delay if the link drops. */
export class Watcher {
  private peer: Peer | null = null;
  private conn: DataConnection | null = null;
  private lastHeard = 0;
  private timer = 0;
  private retry = 0;
  private stopped = false;
  private live = false;
  private everLive = false;

  constructor(
    private code: string,
    private ev: WatchEvents,
  ) {}

  async start() {
    this.stopped = false;
    this.timer = window.setInterval(() => this.tick(), PING_MS);
    await this.dial();
  }

  stop() {
    this.stopped = true;
    clearInterval(this.timer);
    this.conn?.close();
    this.conn = null;
    this.peer?.destroy();
    this.peer = null;
  }

  private tick() {
    if (!this.conn) return;
    if (this.peer && performance.now() - this.lastHeard > LOST_MS) return this.drop(this.peer);
    if (this.conn.open) this.conn.send({ t: 'ping' } satisfies FindMsg);
  }

  private async dial() {
    const { Peer } = await import('peerjs');
    if (this.stopped) return;
    this.peer?.destroy();
    this.ev.onState(this.everLive ? 'lost' : 'connecting');
    const p = new Peer();
    this.peer = p;
    p.on('error', (e) => {
      if (e.type === 'peer-unavailable' && !this.everLive) {
        // Dialing an id nobody owns: an unknown, expired or mistyped code. Retrying would not help.
        this.stop();
        this.ev.onState('inactive');
        return;
      }
      this.drop(p);
      if (e.type === 'network' || e.type === 'server-error' || e.type === 'socket-error') this.ev.onState('offline');
    });
    p.on('open', () => {
      const c = p.connect(findPeerId(this.code), { serialization: 'json' });
      this.conn = c;
      this.lastHeard = performance.now();
      c.on('open', () => {
        if (this.peer !== p) return;
        this.lastHeard = performance.now();
        c.send({ t: 'ping' } satisfies FindMsg);
      });
      c.on('data', (raw) => {
        if (this.conn !== c) return;
        this.lastHeard = performance.now();
        this.retry = 0;
        this.everLive = true;
        if (!this.live) {
          this.live = true;
          this.ev.onState('live');
        }
        const s = parsePos(raw);
        if (s) this.ev.onPos(s);
      });
      c.on('close', () => this.drop(p));
      c.on('error', () => this.drop(p));
    });
  }

  private drop(p: Peer) {
    if (this.peer !== p || this.stopped) return;
    p.destroy();
    this.peer = null;
    this.conn = null;
    this.live = false;
    this.ev.onState(this.everLive ? 'lost' : 'connecting');
    this.retry = Math.min(this.retry + 1, 5);
    setTimeout(() => !this.stopped && !this.peer && void this.dial(), 1000 * this.retry);
  }
}
