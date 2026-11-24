// Random access to an encrypted content, chunk by chunk: what the previews, the players and
// the downloads read, for a group's items as for a share link.
import { CHUNK_SIZE } from './crypto.ts';

/**
 * Random access to an item's content, for previews and streaming: the chunks are fetched
 * (straight from the sender on the same network, otherwise from the relay) and decrypted
 * on demand, a few kept in memory, the next ones fetched ahead.
 */
export interface ContentReader {
  readonly size: number;
  readonly name?: string;
  readonly mime?: string;
  /** Bytes [start, end) of the content. */
  read(start: number, end: number): Promise<Uint8Array>;
  /** Stops: what is still being read fails, nothing more is fetched. */
  close(): void;
}

export interface ReaderOptions {
  /** Decrypted chunks kept in memory (default 16, i.e. 16 MB). */
  keep?: number;
  /** Chunks fetched ahead of the last read (default 4). */
  ahead?: number;
}

interface Slot {
  promise: Promise<Uint8Array>;
  resolve(data: Uint8Array): void;
  reject(err: unknown): void;
  state: 'queued' | 'fetching' | 'done';
  /** Reads waiting for it: never evicted, never dropped from the queue meanwhile. */
  waiting: number;
  urgent: boolean;
}

/** The chunks of one content: a queue (urgent first), a few fetches at once, a small cache. */
export class ChunkReader implements ContentReader {
  private slots = new Map<number, Slot>(); // least recently used first
  private queue: number[] = [];
  private running = 0;
  private closed = false;

  constructor(
    readonly size: number,
    private chunks: number,
    private fetch: (idx: number) => Promise<Uint8Array>,
    private opts: { keep: number; ahead: number; workers: number },
    private onClose: () => void,
    readonly name?: string,
    readonly mime?: string,
  ) {}

  /** Chunk `idx`, decrypted. */
  chunk(idx: number, urgent = true): Promise<Uint8Array> {
    if (this.closed) {
      const failed = Promise.reject(new Error('closed'));
      failed.catch(() => {}); // a prefetch: nobody waits for it
      return failed;
    }
    let s = this.slots.get(idx);
    if (s) {
      this.slots.delete(idx);
      this.slots.set(idx, s);
    } else {
      let resolve!: Slot['resolve'];
      let reject!: Slot['reject'];
      const promise = new Promise<Uint8Array>((res, rej) => ((resolve = res), (reject = rej)));
      promise.catch(() => {}); // a prefetch nobody waits for may fail quietly
      s = { promise, resolve, reject, state: 'queued', waiting: 0, urgent };
      this.slots.set(idx, s);
      this.enqueue(idx, s);
    }
    if (urgent && s.state === 'queued' && !s.urgent) {
      // a prefetched chunk now awaited: to the front
      s.urgent = true;
      this.queue.splice(this.queue.indexOf(idx), 1);
      this.enqueue(idx, s);
    }
    if (!urgent) return s.promise;
    s.waiting++;
    const slot = s;
    return s.promise.finally(() => {
      slot.waiting--;
      this.evict();
    });
  }

  private enqueue(idx: number, s: Slot) {
    // urgent: after the other urgent ones, before the prefetches
    const at = s.urgent ? this.queue.findIndex((i) => !this.slots.get(i)?.urgent) : -1;
    if (at < 0) this.queue.push(idx);
    else this.queue.splice(at, 0, idx);
    this.pump();
  }

  async read(start: number, end: number): Promise<Uint8Array> {
    start = Math.max(0, Math.min(start, this.size));
    end = Math.max(start, Math.min(end, this.size));
    if (end === start) return new Uint8Array(0);
    const first = Math.floor(start / CHUNK_SIZE);
    const last = Math.floor((end - 1) / CHUNK_SIZE);
    // a jump (seek): the prefetches nobody waits for give way to the new position
    this.queue = this.queue.filter((i) => {
      const s = this.slots.get(i)!;
      if (s.waiting > 0 || (i >= first && i <= last + this.opts.ahead)) return true;
      this.slots.delete(i);
      return false;
    });
    const parts = [];
    for (let i = first; i <= last; i++) parts.push(this.chunk(i));
    for (let i = last + 1; i <= last + this.opts.ahead && i < this.chunks; i++) this.chunk(i, false);
    const got = await Promise.all(parts);
    const out = new Uint8Array(end - start);
    let at = 0;
    for (let i = first; i <= last; i++) {
      const data = got[i - first];
      const from = i === first ? start - i * CHUNK_SIZE : 0;
      const to = Math.min(data.length, end - i * CHUNK_SIZE);
      out.set(data.subarray(from, to), at);
      at += to - from;
    }
    return out;
  }

  private pump() {
    while (!this.closed && this.running < this.opts.workers && this.queue.length) {
      const idx = this.queue.shift()!;
      const s = this.slots.get(idx);
      if (!s || s.state !== 'queued') continue;
      s.state = 'fetching';
      this.running++;
      this.fetch(idx)
        .then(
          (data) => {
            s.state = 'done';
            s.resolve(data);
          },
          (err) => {
            // failed: fetched again by the next read that needs it
            if (this.slots.get(idx) === s) this.slots.delete(idx);
            s.reject(err);
          },
        )
        .finally(() => {
          this.running--;
          this.evict();
          this.pump();
        });
    }
  }

  /** Keeps at most `keep` decrypted chunks, the least recently used go first. */
  private evict() {
    let done = 0;
    for (const s of this.slots.values()) if (s.state === 'done') done++;
    for (const [i, s] of this.slots) {
      if (done <= this.opts.keep) break;
      if (s.state !== 'done' || s.waiting > 0) continue;
      this.slots.delete(i);
      done--;
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const s of this.slots.values()) if (s.state !== 'done') s.reject(new Error('closed'));
    this.slots.clear();
    this.queue = [];
    this.onClose();
  }
}
