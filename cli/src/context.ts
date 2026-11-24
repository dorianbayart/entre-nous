// What a command works with: this device's engine (loaded on first use), its groups, the
// group chosen for the command, and its connection to the relay.
import { hostname } from 'node:os';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Engine, type EngineEvent } from '../../web/src/core/engine.ts';
import { FileKV } from './store.ts';
import { CliError, EXIT } from './errors.ts';
import { tr } from './i18n.ts';
import { warn } from './term.ts';

export const DEFAULT_RELAY = 'https://entrenous.0xdba.dev';
/** How long a command waits for the relay before giving up. */
const CONNECT_TIMEOUT = 20_000;

export type GroupView = Engine['groups'][number];
type Config = { group?: string };

export interface Globals {
  group?: string;
  json: boolean;
  quiet: boolean;
  home: string;
}

export class Context {
  private engineLoad?: Promise<Engine>;
  private connected = new Map<string, Promise<void>>();
  private configCache?: Config;

  constructor(readonly g: Globals) {}

  /** This device's engine. Its identity is created on first use. */
  engine(): Promise<Engine> {
    this.engineLoad ??= (async () => {
      const kv = new FileKV(this.g.home);
      const engine = await Engine.load({
        kv,
        platform: 'cli',
        defaultName: hostname().split('.')[0] || 'Terminal',
        defaultRelay: relayUrl(process.env.ENTRENOUS_RELAY || DEFAULT_RELAY),
      });
      // shown, not fatal: a note not sent, a state unreadable…
      engine.on((e: EngineEvent) => {
        if (e.type === 'error') warn(e.message);
      });
      return engine;
    })();
    return this.engineLoad;
  }

  // ---------------------------------------------------------------- settings of the CLI

  private async config(): Promise<Config> {
    if (!this.configCache) {
      try {
        this.configCache = JSON.parse(await readFile(join(this.g.home, 'config.json'), 'utf8'));
      } catch {
        this.configCache = {};
      }
    }
    return this.configCache!;
  }

  async setConfig(change: Config) {
    const c = { ...(await this.config()), ...change };
    this.configCache = c;
    await mkdir(this.g.home, { recursive: true, mode: 0o700 });
    await writeFile(join(this.g.home, 'config.json'), JSON.stringify(c, null, 2) + '\n', { mode: 0o600 });
  }

  async defaultGroupId(): Promise<string | undefined> {
    return (await this.config()).group;
  }

  // ---------------------------------------------------------------- groups

  /** A group by its name or the beginning of its id (case and accents ignored). */
  async findGroup(query: string): Promise<GroupView> {
    const groups = (await this.engine()).groups;
    const norm = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
    const q = norm(query);
    const exact = groups.filter((g) => g.id === query || norm(g.name) === q);
    const matches = exact.length ? exact : groups.filter((g) => g.id.startsWith(query) || norm(g.name).startsWith(q));
    if (matches.length === 1) return matches[0];
    const list = groups.map((g) => `“${g.name}”`).join(', ') || '—';
    if (!groups.length) throw new CliError(tr('err.noGroup'), EXIT.noGroup);
    if (!matches.length) throw new CliError(tr('err.unknownGroup', { group: query, groups: list }), EXIT.noGroup);
    throw new CliError(tr('err.ambiguousGroup', { group: query, groups: matches.map((g) => `“${g.name}” (${g.id.slice(0, 6)})`).join(', ') }), EXIT.usage);
  }

  /** The group of the command: --group, else the default one, else the only one. */
  async group(query = this.g.group): Promise<GroupView> {
    if (query) return this.findGroup(query);
    const groups = (await this.engine()).groups;
    if (!groups.length) throw new CliError(tr('err.noGroup'), EXIT.noGroup);
    const def = await this.defaultGroupId();
    const chosen = groups.find((g) => g.id === def) ?? (groups.length === 1 ? groups[0] : undefined);
    if (!chosen) throw new CliError(tr('err.whichGroup', { groups: groups.map((g) => `“${g.name}”`).join(', ') }), EXIT.usage);
    return chosen;
  }

  /** The latest view of a group (after a change). */
  async view(id: string): Promise<GroupView> {
    const g = (await this.engine()).groups.find((x) => x.id === id);
    if (!g) throw new CliError(tr('err.noGroup'), EXIT.noGroup);
    return g;
  }

  /** Connects a group and waits for its history and its members' keys. */
  connect(id: string, timeout = CONNECT_TIMEOUT): Promise<void> {
    let p = this.connected.get(id);
    if (!p) {
      p = (async () => {
        const engine = await this.engine();
        const relay = (await this.view(id)).relay;
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            off();
            reject(new CliError(tr('err.unreachable', { relay }), EXIT.unreachable));
          }, timeout);
          const off = engine.on((e) => {
            if (e.type !== 'synced' || e.groupId !== id) return;
            clearTimeout(timer);
            off();
            resolve();
          });
          engine.start(id);
        });
      })();
      this.connected.set(id, p);
    }
    return p;
  }

  /** The engine was loaded (by a command that needed it). */
  get loaded() {
    return !!this.engineLoad;
  }

  /** Disconnects everything (end of the command). */
  async close() {
    if (!this.engineLoad) return;
    const engine = await this.engineLoad;
    // the receipts of what this command received or read, before leaving (3 s at most)
    await Promise.race([engine.acksSent(), new Promise((r) => setTimeout(r, 3000).unref())]);
    engine.stop();
  }
}

/** A relay address: https://host (a bare host name gets https://). */
export function relayUrl(value: string): string {
  const v = /^[a-z]+:\/\//i.test(value) ? value : 'https://' + value;
  const u = new URL(v);
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new CliError(`${value}: http(s) only`, EXIT.usage);
  return u.origin;
}
