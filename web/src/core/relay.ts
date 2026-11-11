// WebSocket connection to the relay: request/response over JSON, binary frames for
// chunks, automatic reconnection while active.
import { fromUtf8, u32, utf8, concat } from './bytes.ts';

export interface RelayEvent {
  ev: string;
  [k: string]: any;
}

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

export class RelayError extends Error {}

export class RelayConnection {
  private ws: WebSocket | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private active = false;
  private backoff = 500;
  private opened: Promise<void> | null = null;
  private heartbeat?: ReturnType<typeof setInterval>;
  private retry?: ReturnType<typeof setTimeout>;
  private lastSeen = 0;
  status: 'offline' | 'connecting' | 'online' = 'offline';

  /**
   * @param url       relay base URL (https://… or http://localhost…)
   * @param onOpen    called after every (re)connection, before requests are served
   * @param onEvent   pushed events
   * @param onStatus  connection status changes
   */
  constructor(
    private url: string,
    private onOpen: (conn: RelayConnection) => Promise<void>,
    private onEvent: (e: RelayEvent) => void,
    private onStatus: (s: RelayConnection['status']) => void = () => {},
  ) {}

  start(): Promise<void> {
    this.active = true;
    return this.ensureOpen();
  }

  stop() {
    this.active = false;
    clearInterval(this.heartbeat);
    clearTimeout(this.retry);
    this.ws?.close(1000);
    this.ws = null;
    this.opened = null;
    this.failPending();
    this.setStatus('offline');
  }

  private failPending() {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new RelayError('disconnected'));
    }
    this.pending.clear();
  }

  get isActive() {
    return this.active;
  }

  private setStatus(s: RelayConnection['status']) {
    if (this.status === s) return;
    this.status = s;
    this.onStatus(s);
  }

  private wsUrl() {
    const u = new URL(this.url);
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    u.pathname = '/ws';
    u.hash = '';
    u.search = '';
    return u.toString();
  }

  /**
   * Checks the connection now (after the computer woke up, or the network came back):
   * a dead socket is dropped and replaced at once.
   */
  kick() {
    if (!this.active) return;
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      if (!this.opened) {
        clearTimeout(this.retry);
        this.backoff = 500;
        this.ensureOpen().catch(() => {});
      }
      return;
    }
    this.raw('ping', {}, undefined, 5_000).catch(() => this.drop(ws));
  }

  /** Gives up a socket that no longer answers, without waiting for TCP to notice. */
  private drop(ws: WebSocket) {
    if (this.ws !== ws) return;
    const lost = ws.onclose as (() => void) | null;
    ws.onclose = null;
    try {
      ws.close();
    } catch {}
    lost?.();
  }

  private ensureOpen(): Promise<void> {
    if (this.opened) return this.opened;
    this.setStatus('connecting');
    this.opened = new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl());
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      let ready = false;
      ws.onopen = async () => {
        try {
          await this.onOpen(this);
          ready = true;
          this.backoff = 500;
          this.setStatus('online');
          clearInterval(this.heartbeat);
          // ping only a silent connection with nothing waiting to go out (a large upload
          // on a slow link must not be taken for a dead socket)
          this.heartbeat = setInterval(() => {
            if (this.ws !== ws || ws.bufferedAmount > 0 || Date.now() - this.lastSeen < 20_000) return;
            this.raw('ping', {}, undefined, 10_000).catch(() => this.drop(ws));
          }, 10_000);
          (this.heartbeat as any).unref?.();
          resolve();
        } catch (err) {
          reject(err);
          ws.close();
        }
      };
      ws.onmessage = (e) => this.receive(e.data);
      ws.onclose = () => {
        if (this.ws !== ws) return;
        clearInterval(this.heartbeat);
        this.ws = null;
        this.opened = null;
        this.failPending();
        if (!ready) reject(new RelayError('connection failed'));
        this.setStatus(this.active ? 'connecting' : 'offline');
        if (this.active) {
          this.retry = setTimeout(() => this.active && this.ensureOpen().catch(() => {}), this.backoff);
          this.backoff = Math.min(this.backoff * 2, 15_000);
        }
      };
    });
    this.opened.catch(() => {});
    return this.opened;
  }

  private receive(data: string | ArrayBuffer) {
    this.lastSeen = Date.now();
    let msg: any;
    let binary: Uint8Array | undefined;
    if (typeof data === 'string') {
      msg = JSON.parse(data);
    } else {
      const bytes = new Uint8Array(data);
      const len = new DataView(data).getUint32(0);
      msg = JSON.parse(fromUtf8(bytes.subarray(4, 4 + len)));
      binary = bytes.slice(4 + len);
    }
    if (msg.ev) {
      this.onEvent(msg);
      return;
    }
    const p = this.pending.get(msg.rid);
    if (!p) return;
    this.pending.delete(msg.rid);
    clearTimeout(p.timer);
    if (msg.ok) p.resolve(binary ? { ...msg, data: binary } : msg);
    else p.reject(new RelayError(msg.error || 'error'));
  }

  /** Sends a request on the current socket (used inside onOpen, and by request()). */
  raw(op: string, payload: Record<string, unknown> = {}, binary?: Uint8Array, timeout = 30_000): Promise<any> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new RelayError('disconnected'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RelayError('timeout'));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      const header = JSON.stringify({ rid: id, op, ...payload });
      if (binary) {
        const h = utf8(header);
        ws.send(concat(u32(h.length), h, binary) as Uint8Array<ArrayBuffer>);
      } else {
        ws.send(header);
      }
    });
  }

  async request(op: string, payload: Record<string, unknown> = {}, binary?: Uint8Array): Promise<any> {
    await this.ensureOpen();
    return this.raw(op, payload, binary);
  }

  /** Bytes waiting in the socket buffer, for upload back-pressure. */
  get buffered() {
    return this.ws?.bufferedAmount ?? 0;
  }
}
