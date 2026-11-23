// What this device keeps on disk: its identity and the keys of its groups, never any content
// (the history only ever lives on the relay, encrypted, until it expires).
//
//   <home>/device.json         identity (name, signing keys)
//   <home>/groups/<id>.json    a group: its secret, relay, state and prekeys (private halves)
//   <home>/groups.json         order of the groups
//   <home>/config.json         CLI settings (default group)
//
// Folder 0700, files 0600, each one written whole (temporary file, then rename).
// Several entrenous may run at once with the same identity (a `watch` in a terminal, a `send`
// in another): writes are serialised by a lock, and a group written by one process never
// loses a prekey written by another (their private halves exist nowhere else).
import { mkdir, readFile, readdir, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { b64, fromJSON, toJSON } from '../../web/src/core/bytes.ts';
import type { LocalGroup, Prekey } from '../../web/src/core/group.ts';
import type { KV } from '../../web/src/core/storage.ts';

/** $ENTRENOUS_HOME, or the user's data folder (XDG on Linux and macOS, %LOCALAPPDATA% on Windows). */
export function defaultHome(env = process.env): string {
  if (env.ENTRENOUS_HOME) return env.ENTRENOUS_HOME;
  if (process.platform === 'win32') return join(env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'entrenous');
  return join(env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'entrenous');
}

const GROUP = 'group:';

export class FileKV implements KV {
  private ready: Promise<void>;

  constructor(readonly home: string) {
    this.ready = mkdir(join(home, 'groups'), { recursive: true, mode: 0o700 }).then(() => {});
  }

  private file(key: string) {
    if (key.startsWith(GROUP)) return join(this.home, 'groups', safe(key.slice(GROUP.length)) + '.json');
    if (key === 'groups') return join(this.home, 'groups.json');
    return join(this.home, safe(key) + '.json');
  }

  private async read<T>(file: string): Promise<T | undefined> {
    try {
      return fromJSON<T>(await readFile(file, 'utf8'));
    } catch (err: any) {
      if (err.code === 'ENOENT') return undefined;
      throw err;
    }
  }

  async get<T>(key: string): Promise<T | undefined> {
    await this.ready;
    if (key === 'groups') return (await this.groupIds()) as T;
    return this.read<T>(this.file(key));
  }

  async set(key: string, value: unknown): Promise<void> {
    await this.ready;
    await this.locked(async () => {
      const file = this.file(key);
      let v = value;
      if (key.startsWith(GROUP)) v = mergeGroup(await this.read<LocalGroup>(file), value as LocalGroup);
      await writeAtomic(file, toJSON(v));
    });
  }

  async del(key: string): Promise<void> {
    await this.ready;
    await this.locked(() => rm(this.file(key), { force: true }));
  }

  /**
   * The groups are the files of groups/, in the saved order: a process that started before a
   * `join` in another one does not make the new group disappear when it saves its own list.
   */
  private async groupIds(): Promise<string[]> {
    const present = (await readdir(join(this.home, 'groups'))).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
    const order = (await this.read<string[]>(this.file('groups'))) ?? [];
    return [...order.filter((id) => present.includes(id)), ...present.filter((id) => !order.includes(id))];
  }

  /** Runs `fn` with the lock of the folder (a directory: created atomically everywhere). */
  private async locked<T>(fn: () => Promise<T>): Promise<T> {
    const lock = join(this.home, '.lock');
    for (let i = 0; ; i++) {
      try {
        await mkdir(lock);
        break;
      } catch (err: any) {
        if (err.code !== 'EEXIST') throw err;
        // left by a process killed in the middle of a write: a write takes milliseconds
        const age = Date.now() - (await stat(lock).then((s) => s.mtimeMs, () => Date.now()));
        if (age > 10_000) await rmdir(lock).catch(() => {});
        else await new Promise((r) => setTimeout(r, Math.min(5 + i * 5, 50)));
      }
    }
    try {
      return await fn();
    } finally {
      await rmdir(lock).catch(() => {});
    }
  }
}

/** A key as a file name (ids are base64url already). */
const safe = (key: string) => key.replace(/[^A-Za-z0-9_-]/g, '_');

let seq = 0;
async function writeAtomic(file: string, data: string) {
  const tmp = `${file}.${process.pid}.${++seq}.tmp`;
  await writeFile(tmp, data, { mode: 0o600 });
  await rename(tmp, file);
}

/**
 * The group being saved, plus the prekeys that only the copy on disk has (created by another
 * process). If both made a new current prekey, the newest stays current. A newer state on
 * disk (same keys) is kept: the next connection would fetch it again anyway.
 */
export function mergeGroup(disk: LocalGroup | undefined, mine: LocalGroup): LocalGroup {
  if (!disk || disk.id !== mine.id) return mine;
  const tag = (p: Prekey) => b64(p.pk);
  const known = new Set(mine.prekeys.map(tag));
  const keepMs = (mine.state.ttl + 3600) * 1000;
  const now = Date.now();
  const extra = disk.prekeys.filter((p) => !known.has(tag(p)) && (!p.supersededAt || p.supersededAt + keepMs > now));
  // copies: the engine keeps using its own objects (and its current prekey) in memory
  const prekeys = [...mine.prekeys, ...extra].map((p) => ({ ...p }));
  const current = prekeys.filter((p) => !p.supersededAt).sort((a, b) => b.createdAt - a.createdAt);
  for (const p of current.slice(1)) p.supersededAt = now;
  const sameKeys = b64(disk.secret) === b64(mine.secret);
  const state = sameKeys && disk.state.v > mine.state.v ? disk.state : mine.state;
  return { ...mine, state, prekeys };
}
