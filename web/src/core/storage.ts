// Key-value storage for the device identity, groups and prekeys. Values are JSON strings
// (bytes as {"$b": base64url}).
//   - PWA: IndexedDB (persistent storage requested)
//   - Mac: the native bridge, which keeps everything in the macOS Keychain
//   - tests: in memory
import { fromJSON, toJSON } from './bytes.ts';

export interface KV {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  del(key: string): Promise<void>;
}

export class MemoryKV implements KV {
  private m = new Map<string, string>();
  async get<T>(key: string) {
    const v = this.m.get(key);
    return v === undefined ? undefined : fromJSON<T>(v);
  }
  async set(key: string, value: unknown) {
    this.m.set(key, toJSON(value));
  }
  async del(key: string) {
    this.m.delete(key);
  }
}

export class IndexedKV implements KV {
  private db: Promise<IDBDatabase>;

  constructor(name = 'entrenous') {
    this.db = new Promise((resolve, reject) => {
      const req = indexedDB.open(name, 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    navigator.storage?.persist?.().catch(() => {});
  }

  private async tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await this.db;
    return new Promise((resolve, reject) => {
      const req = fn(db.transaction('kv', mode).objectStore('kv'));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async get<T>(key: string) {
    const v = await this.tx<string | undefined>('readonly', (s) => s.get(key));
    return v === undefined ? undefined : fromJSON<T>(v);
  }
  async set(key: string, value: unknown) {
    await this.tx('readwrite', (s) => s.put(toJSON(value), key));
  }
  async del(key: string) {
    await this.tx('readwrite', (s) => s.delete(key));
  }
}
