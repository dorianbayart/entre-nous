// Direct links between two devices of a group on the same network (local mode).
//
// The transport (WebRTC data channels in browsers) is injected: this module only knows
// "links", reliable ordered pipes, and the setup messages they exchange through the relay
// (encrypted with the group key by the engine). What travels on a link is already end-to-end
// encrypted: the same sealed chunks as on the relay, served by the device that sent the item.
//
// Protocol on a link:
//   request   {"q": rid, "id": itemId, "i": idx}              (text)
//   response  {"r": rid, "n": bytes}  then n bytes in frames   (text, then binary)
//             {"r": rid, "e": "unknown"}                      (not served here)
// Responses are sent one at a time, so their frames never interleave.

/** A direct, reliable and ordered message pipe to another device. */
export interface Link {
  send(data: string | Uint8Array): void;
  readonly bufferedAmount: number;
  /** Largest message the other side accepts. */
  readonly maxMessage: number;
  /** Resolves once at most `bytes` wait to be sent (event-driven: no timer, which hidden
   *  pages throttle). */
  drained(bytes: number): Promise<void>;
  onMessage: (data: string | Uint8Array) => void;
  onClose: () => void;
  close(): void;
}

/** One link being set up: `receive` takes the peer's setup messages. */
export interface Pending {
  link: Promise<Link>;
  receive(msg: any): void;
  cancel(): void;
}

/** Creates links. `signal` sends a setup message to the other device. */
export interface LinkFactory {
  connect(signal: (msg: any) => void): Pending;
  accept(signal: (msg: any) => void): Pending;
}

export interface PeersOptions {
  factory: LinkFactory;
  /** Sends a setup message to a device (through the relay). */
  signal(to: string, msg: any): Promise<void>;
  /** The sealed chunk `idx` of an item this device can serve to `device`, or null. */
  serve(itemId: string, idx: number, device: string): Promise<Uint8Array | null>;
  connectTimeout?: number;
  /** A link opened or closed. */
  onChange?: () => void;
}

const MAX_FRAME = 256 * 1024; // larger messages: fewer per chunk (Chrome accepts 256 KB)
const HIGH_WATER = 4 * 1024 * 1024; // queued on the link before waiting
const CHUNK_TIMEOUT = 30_000;
const IDLE_CLOSE = 120_000;
const RETRY_AFTER = 30_000; // a device that could not be reached is not tried again before

/** Links kept per device: one WebRTC connection tops out well below a local network, two
 *  in parallel nearly double the throughput (measured: 16 → 31 MB/s), three gain nothing. */
const LINKS_PER_PEER = 2;

interface Peer {
  links: Link[];
  connecting?: Promise<Link>;
  lastUse: number;
  failedAt?: number;
  /** The second link could not be set up: not tried again for a while. */
  extraFailedAt?: number;
}

/** Thrown when the device cannot be reached directly (other network, closed, refused). */
export class UnreachableError extends Error {
  constructor() {
    super('unreachable');
  }
}

export class Peers {
  private peers = new Map<string, Peer>();
  /** Setup in progress, by session id (initiated here or by the other device). */
  private sessions = new Map<string, Pending>();
  private rid = 0;
  private waiting = new Map<number, { link: Link; resolve(d: Uint8Array): void; reject(e: Error): void; timer: any }>();
  /** Requests waiting on each link: a new one goes to the least busy. */
  private inflight = new Map<Link, number>();
  private idleTimer: any;

  constructor(private o: PeersOptions) {
    this.idleTimer = setInterval(() => this.closeIdle(), 30_000);
    this.idleTimer.unref?.();
  }

  /** Whether a direct link to this device is open (or worth trying). */
  reachable(device: string) {
    const p = this.peers.get(device);
    return !!p?.links.length || !p?.failedAt || Date.now() - p.failedAt > RETRY_AFTER;
  }

  isConnected(device: string) {
    return !!this.peers.get(device)?.links.length;
  }

  /** The other device came back online: worth trying again. */
  forget(device: string) {
    const p = this.peers.get(device);
    if (p && !p.links.length) p.failedAt = undefined;
  }

  /** Sets up the link ahead (an item arrived from this device): a download then knows at once. */
  warm(device: string) {
    this.link(device).catch(() => {});
  }

  /** Sealed chunk of an item, fetched directly from the device that sent it. */
  async fetch(device: string, itemId: string, idx: number): Promise<Uint8Array> {
    const link = await this.link(device);
    const rid = ++this.rid;
    const p = this.peers.get(device)!;
    p.lastUse = Date.now();
    this.inflight.set(link, (this.inflight.get(link) ?? 0) + 1);
    const done = () => this.inflight.set(link, Math.max(0, (this.inflight.get(link) ?? 1) - 1));
    return new Promise<Uint8Array>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(rid);
        link.close(); // stuck: fall back to the relay
        reject(new UnreachableError());
      }, CHUNK_TIMEOUT);
      this.waiting.set(rid, { link, resolve, reject, timer });
      try {
        link.send(JSON.stringify({ q: rid, id: itemId, i: idx }));
      } catch {
        clearTimeout(timer);
        this.waiting.delete(rid);
        reject(new UnreachableError());
      }
    }).finally(done);
  }

  /** A setup message from another device (decrypted by the engine). */
  onSignal(from: string, msg: any) {
    if (!msg || typeof msg.s !== 'string') return;
    let pending = this.sessions.get(msg.s);
    if (!pending) {
      if (msg.t !== 'offer') return; // stale message of a finished session
      pending = this.o.factory.accept((m) => this.o.signal(from, { ...m, s: msg.s }).catch(() => {}));
      this.sessions.set(msg.s, pending);
      const accepted = pending;
      setTimeout(() => accepted.cancel(), 60_000); // never completed: forgotten
      pending.link.then(
        (link) => {
          this.sessions.delete(msg.s);
          this.adopt(from, link);
        },
        () => this.sessions.delete(msg.s),
      );
    }
    pending.receive(msg);
  }

  /** For good: the group is left. */
  dispose() {
    clearInterval(this.idleTimer);
    this.closeAll();
  }

  closeAll() {
    for (const s of this.sessions.values()) s.cancel();
    this.sessions.clear();
    for (const p of this.peers.values()) for (const l of [...p.links]) l.close();
    this.peers.clear();
  }

  // ------------------------------------------------------------------ links

  private peer(device: string): Peer {
    let p = this.peers.get(device);
    if (!p) this.peers.set(device, (p = { links: [], lastUse: Date.now() }));
    return p;
  }

  /** The least busy open link (and a second one set up meanwhile), or a new one. */
  private link(device: string): Promise<Link> {
    const p = this.peer(device);
    if (p.links.length) {
      const extraOk = !p.extraFailedAt || Date.now() - p.extraFailedAt > RETRY_AFTER;
      if (p.links.length < LINKS_PER_PEER && !p.connecting && extraOk) this.connect(device, p).catch(() => {});
      return Promise.resolve(p.links.reduce((a, b) => ((this.inflight.get(b) ?? 0) < (this.inflight.get(a) ?? 0) ? b : a)));
    }
    if (p.connecting) return p.connecting;
    if (!this.reachable(device)) return Promise.reject(new UnreachableError());
    return this.connect(device, p);
  }

  private connect(device: string, p: Peer): Promise<Link> {
    const session = Math.random().toString(36).slice(2) + Date.now().toString(36);
    const pending = this.o.factory.connect((m) =>
      this.o.signal(device, { ...m, s: session }).catch(() => pending.cancel()),
    );
    this.sessions.set(session, pending);
    // generous: the other device's answer may wait seconds behind an upload on its
    // connection (OS buffers), and nobody waits for it: downloads use the relay meanwhile
    const timeout = this.o.connectTimeout ?? 30_000;
    const peer = p;
    peer.connecting = new Promise<Link>((resolve, reject) => {
      const timer = setTimeout(() => pending.cancel(), timeout);
      pending.link.then(
        (link) => {
          clearTimeout(timer);
          resolve(link);
        },
        () => {
          clearTimeout(timer);
          reject(new UnreachableError());
        },
      );
    })
      .then((link) => {
        this.adopt(device, link);
        return link;
      })
      .catch((err) => {
        if (peer.links.length) peer.extraFailedAt = Date.now();
        else peer.failedAt = Date.now();
        throw err;
      })
      .finally(() => {
        peer.connecting = undefined;
        this.sessions.delete(session);
      });
    return peer.connecting;
  }

  /** An open link, ours or accepted: requests go both ways on it. */
  private adopt(device: string, link: Link) {
    const p = this.peer(device);
    p.links.push(link); // ours or the other side's: either serves requests both ways
    p.failedAt = undefined;
    p.lastUse = Date.now();
    this.o.onChange?.();
    const peer = p;
    // requests are prepared (read, sealed) at once, in parallel; sent in order, one at a time
    const responses: Array<{ rid: number; data: Promise<Uint8Array | null> }> = [];
    let responding = false;
    let incoming: { rid: number; size: number; parts: Uint8Array[]; got: number } | null = null;

    const respond = async () => {
      if (responding) return;
      responding = true;
      while (responses.length) {
        const r = responses.shift()!;
        await this.answer(link, r.rid, await r.data).catch(() => {});
      }
      responding = false;
    };

    link.onMessage = (data) => {
      peer.lastUse = Date.now();
      if (typeof data !== 'string') {
        if (!incoming) return;
        incoming.parts.push(data);
        incoming.got += data.length;
        if (incoming.got >= incoming.size) {
          const done = incoming;
          incoming = null;
          this.settle(done.rid, joinParts(done.parts, done.size));
        }
        return;
      }
      let msg: any;
      try {
        msg = JSON.parse(data);
      } catch {
        return;
      }
      if (typeof msg.q === 'number') {
        const data = this.o.serve(String(msg.id), Number(msg.i), device).catch(() => null);
        responses.push({ rid: msg.q, data });
        respond();
      } else if (typeof msg.r === 'number') {
        if (msg.e) this.settle(msg.r, null);
        else if (msg.n === 0) this.settle(msg.r, new Uint8Array(0));
        else incoming = { rid: msg.r, size: Number(msg.n), parts: [], got: 0 };
      }
    };
    link.onClose = () => {
      peer.links = peer.links.filter((l) => l !== link);
      this.inflight.delete(link);
      this.o.onChange?.();
      // requests waiting on this link: they go to the relay instead
      for (const [rid, w] of this.waiting) {
        if (w.link !== link) continue;
        clearTimeout(w.timer);
        w.reject(new UnreachableError());
        this.waiting.delete(rid);
      }
    };
  }

  private settle(rid: number, data: Uint8Array | null) {
    const w = this.waiting.get(rid);
    if (!w) return;
    clearTimeout(w.timer);
    this.waiting.delete(rid);
    if (data) w.resolve(data);
    else w.reject(new UnreachableError());
  }

  private async answer(link: Link, rid: number, data: Uint8Array | null) {
    if (!data) {
      link.send(JSON.stringify({ r: rid, e: 'unknown' }));
      return;
    }
    link.send(JSON.stringify({ r: rid, n: data.length }));
    const frame = Math.min(MAX_FRAME, link.maxMessage);
    for (let off = 0; off < data.length; off += frame) {
      if (link.bufferedAmount > HIGH_WATER) await link.drained(HIGH_WATER / 2);
      link.send(data.subarray(off, off + frame));
    }
  }

  private closeIdle() {
    const now = Date.now();
    for (const p of this.peers.values()) {
      if (p.links.length && now - p.lastUse > IDLE_CLOSE && this.waiting.size === 0) {
        for (const l of [...p.links]) l.close();
      }
    }
  }
}

function joinParts(parts: Uint8Array[], size: number) {
  if (parts.length === 1) return parts[0];
  const out = new Uint8Array(size);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
