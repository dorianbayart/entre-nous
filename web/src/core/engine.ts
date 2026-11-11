// The Entre Nous engine: identity, groups, relay connections, history, pairing, removal.
// UI-agnostic: the PWA and the Mac app both drive it.
import { b64, fromJSON, toJSON, unb64, utf8, fromUtf8 } from './bytes.ts';
import { CHUNK_SIZE, kdf, open, randomBytes, randomId, seal, signKeygen } from './crypto.ts';
import {
  type Device,
  type GroupState,
  type LocalGroup,
  type Member,
  type Platform,
  type PrekeyBundle,
  autoMaxOf,
  currentPrekey,
  localOnlyOf,
  maintainPrekeys,
  maxItemsOf,
  memberOf,
  mergeState,
  newDevice,
  newGroup,
  openBundle,
  openState,
  roomKey,
  sameState,
  sealState,
  signedBundle,
} from './group.ts';
import {
  type Header,
  type NoteText,
  type Opened,
  type RelayItem,
  INLINE_TEXT_MAX,
  openNote,
  sealNote,
  openContentChunk,
  openItem,
  sealContentChunk,
  sealItem,
  sealedSize,
  verifyItem,
} from './items.ts';
import { RelayConnection, type RelayEvent } from './relay.ts';
import { type LinkFactory, Peers } from './peers.ts';
import type { KV } from './storage.ts';

export interface Host {
  kv: KV;
  platform: Platform;
  defaultName: string;
  defaultRelay: string;
  /** Direct links between devices on the same network (WebRTC), when the platform has them. */
  links?: LinkFactory;
}

export interface ItemView {
  id: string;
  from: string;
  fromName: string;
  mine: boolean;
  createdAt: number;
  expiresAt: number;
  kind: Header['kind'];
  text?: string;
  name?: string;
  mime?: string;
  size?: number;
  thumb?: string;
  chunks: number;
  /** Local item whose sender is not reachable now: nothing to copy or save. */
  unavailable?: boolean;
  /** Local item sent from here, the group no longer local only: can go to the relay. */
  canPublish?: boolean;
  /** Still being uploaded by its sender: `have` of `chunks` received, the last at `progressAt`. */
  pending?: boolean;
  have?: number;
  progressAt?: number;
  /** Being uploaded: speed of the upload, bytes per second. */
  rate?: number;
  /** Content only served directly by its sender, on the same network (local mode). */
  local?: boolean;
  error?: string;
}

/** The item disappeared from the relay before its content was fully downloaded. */
export class ItemGoneError extends Error {
  constructor() {
    super('Fichier supprimé avant la fin du téléchargement');
    this.name = 'ItemGoneError';
  }
}

export interface Transfer {
  id: string;
  groupId: string;
  name: string;
  direction: 'up' | 'down';
  /** Upload: the item, once announced (it then shows its own progress in the history). */
  itemId?: string;
  /** Straight between two devices on the same network (download, or served from here). */
  direct?: boolean;
  /** The other device of a direct transfer. */
  peer?: string;
  /** Speed, bytes per second over the last seconds. */
  rate?: number;
  marks?: Array<[number, number]>;
  done: number;
  total: number;
  error?: string;
}

interface Entry {
  relay: RelayItem;
  opened?: Opened;
  view: ItemView;
  note?: NoteText; // live note: latest text
  marks?: Array<[number, number]>; // being uploaded: (time, chunks received), for its speed
}

/** Counts `n` more chunks done at `at`, and updates the speed over the last 3 s. */
function track(t: { done?: number; rate?: number; marks?: Array<[number, number]> }, done: number, at = Date.now()) {
  t.done = done;
  const marks = (t.marks ??= []);
  marks.push([at, done]);
  while (marks.length > 2 && at - marks[0][0] > 3000) marks.shift();
  const [t0, d0] = marks[0];
  if (at - t0 >= 300) t.rate = ((done - d0) * CHUNK_SIZE * 1000) / (at - t0);
}

export interface NoteView {
  text: string;
  by: string;
  byName: string;
  mine: boolean;
  at: number;
  expiresAt: number;
}

interface Runtime {
  g: LocalGroup;
  conn: RelayConnection;
  items: Map<string, Entry>;
  /** Live note typed here and not yet acknowledged by the relay. */
  noteDraft?: string;
  noteSending: boolean;
  bundles: Map<string, PrekeyBundle>;
  online: Set<string>;
  maxTtl: number;
  persist: boolean;
  storage?: { used: number; limit: number };
  ready: boolean;
  /** Direct links to the other devices (local mode). */
  peers?: Peers;
  /** Second relay connection, for chunks: short messages never wait behind megabytes. */
  bulk?: RelayConnection;
  /** Deleted here while being sent: the upload stops. */
  cancelled: Set<string>;
  /** Contents sent from here, served directly to devices on the same network. */
  outbox: Map<string, Outgoing>;
}

interface Outgoing {
  blob: Blob;
  key: Uint8Array;
  chunks: number;
  name: string;
  text?: string; // local text: its content, for this device's own history
}

export type EngineEvent =
  | { type: 'change' }
  | { type: 'incoming'; groupId: string; item: ItemView }
  | { type: 'presence'; groupId: string; joined: string[] }
  | { type: 'synced'; groupId: string }
  | { type: 'removed'; groupName: string }
  | { type: 'error'; message: string };

export interface Invite {
  url: string;
  expiresAt: number;
  cancel(): void;
}

const INVITE_TTL = 3 * 60 * 1000;
/** A download that follows an upload gives up when the sender sent nothing for that long. */
const UPLOAD_STALLED = 5 * 60 * 1000;
/** Chunks requested at once by a download (a direct link pipelines them). */
const DOWNLOAD_WORKERS = 3;
/** Upload back-pressure: bytes allowed to wait in the relay socket before the next chunk. */
const SEND_QUEUE_MAX = 256 * 1024;

export class Engine {
  device!: Device;
  private runtimes = new Map<string, Runtime>();
  transfers = new Map<string, Transfer>();
  private uploadSeq = 0;
  private servedTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private listeners = new Set<(e: EngineEvent) => void>();
  private running = false;
  /** Sent to the background during a transfer: disconnects once it is over. */
  private stopWhenIdle = false;
  private sweeper?: ReturnType<typeof setInterval>;

  private constructor(private host: Host) {}

  static async load(host: Host): Promise<Engine> {
    const e = new Engine(host);
    let device = await host.kv.get<Device>('device');
    if (!device) {
      device = newDevice(host.defaultName, host.platform, signKeygen());
      await host.kv.set('device', device);
    }
    e.device = device;
    const ids = (await host.kv.get<string[]>('groups')) ?? [];
    for (const id of ids) {
      const g = await host.kv.get<LocalGroup>('group:' + id);
      if (g) e.attach(g);
    }
    return e;
  }

  on(fn: (e: EngineEvent) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(e: EngineEvent) {
    for (const fn of this.listeners) fn(e);
  }

  private changed() {
    this.emit({ type: 'change' });
  }

  // ------------------------------------------------------------ persistence

  private async saveIndex() {
    await this.host.kv.set('groups', [...this.runtimes.keys()]);
  }

  private async save(g: LocalGroup) {
    await this.host.kv.set('group:' + g.id, g);
  }

  // ------------------------------------------------------------ lifecycle

  /** Connects every group (app in the foreground). */
  start() {
    this.running = true;
    this.stopWhenIdle = false;
    for (const rt of this.runtimes.values()) rt.conn.start().catch(() => {});
    if (!this.sweeper) {
      this.sweeper = setInterval(() => this.sweep(), 1000);
      (this.sweeper as any).unref?.();
    }
  }

  /** Removes expired items from the local history (the relay deletes them on its side). */
  private sweep() {
    const now = Date.now();
    let removed = false;
    for (const rt of this.runtimes.values()) {
      for (const [id, e] of rt.items) {
        if (e.relay.expiresAt <= now) {
          rt.items.delete(id);
          rt.outbox.delete(id);
          removed = true;
        }
      }
    }
    if (removed) this.changed();
  }

  /** Checks every connection now (computer woke up, network back). */
  reconnect() {
    if (!this.running) return;
    for (const rt of this.runtimes.values()) rt.conn.kick();
  }

  /** App in the background: disconnects, but only once the transfers in progress are over. */
  background() {
    if (this.busy) this.stopWhenIdle = true;
    else this.stop();
  }

  /** Disconnects. */
  stop() {
    this.running = false;
    this.stopWhenIdle = false;
    clearInterval(this.sweeper);
    this.sweeper = undefined;
    for (const rt of this.runtimes.values()) {
      rt.conn.stop();
      rt.bulk?.stop();
      rt.peers?.closeAll();
      rt.online.clear();
    }
    this.changed();
  }

  get groups() {
    return [...this.runtimes.values()].map((rt) => this.groupView(rt));
  }

  groupView(rt: Runtime) {
    const s = rt.g.state;
    return {
      id: rt.g.id,
      name: s.name,
      relay: rt.g.relay,
      status: rt.conn.status,
      ttl: s.ttl,
      maxTtl: rt.maxTtl,
      persist: rt.persist,
      maxItems: maxItemsOf(s),
      autoMax: autoMaxOf(s),
      localOnly: localOnlyOf(s),
      storage: rt.storage ?? null,
      members: Object.values(s.members).map((m: Member) => ({
        id: m.id,
        name: m.name,
        platform: m.platform,
        me: m.id === this.device.id,
        online: m.id === this.device.id ? rt.conn.status === 'online' : rt.online.has(m.id),
      })),
      items: [...rt.items.values()]
        .map((i) => this.availability(rt, i))
        .filter((v) => v.kind !== 'note')
        .sort((a, b) => b.createdAt - a.createdAt),
      note: this.noteView(rt),
    };
  }

  /** A local item can only be fetched from its sender, when it is reachable. */
  private availability(rt: Runtime, e: Entry): ItemView {
    const v = e.view;
    if (!v.local) return v;
    if (v.mine) return rt.outbox.has(v.id) && !localOnlyOf(rt.g.state) ? { ...v, canPublish: true } : v;
    if (v.kind === 'text' && v.text !== undefined) return v; // already fetched
    const reachable = rt.online.has(v.from) && !!rt.peers?.reachable(v.from);
    return reachable ? v : { ...v, unavailable: true };
  }

  private rt(groupId: string): Runtime {
    const rt = this.runtimes.get(groupId);
    if (!rt) throw new Error('unknown group');
    return rt;
  }

  private attach(g: LocalGroup): Runtime {
    const rt: Runtime = {
      g,
      items: new Map(),
      bundles: new Map(),
      online: new Set(),
      maxTtl: 7 * 86400,
      persist: false,
      ready: false,
      noteSending: false,
      outbox: new Map(),
      cancelled: new Set(),
      conn: null as unknown as RelayConnection,
    };
    if (this.host.links) {
      rt.peers = new Peers({
        factory: this.host.links,
        signal: (to, msg) => this.sendSignal(rt, to, msg),
        serve: (id, idx, device) => this.serveChunk(rt, id, idx, device),
        onChange: () => this.changed(),
      });
    }
    rt.conn = new RelayConnection(
      g.relay,
      (c) => this.onOpen(rt, c),
      (e) =>
        this.onEvent(rt, e).catch((err) => {
          if (err.message !== 'disconnected') this.emit({ type: 'error', message: String(err.message ?? err) });
        }),
      () => this.changed(),
    );
    this.runtimes.set(g.id, rt);
    return rt;
  }

  private detach(groupId: string) {
    const rt = this.runtimes.get(groupId);
    if (!rt) return;
    rt.conn.stop();
    rt.bulk?.stop();
    rt.peers?.dispose();
    this.runtimes.delete(groupId);
  }

  /** The relay connection for chunks (opened when first needed). */
  private bulk(rt: Runtime): RelayConnection {
    if (!rt.bulk) {
      rt.bulk = new RelayConnection(
        rt.g.relay,
        async (c) => {
          await c.raw('hello', { roomKey: roomKey(rt.g), device: this.device.id, bulk: true });
        },
        () => {},
      );
    }
    if (!rt.bulk.isActive) rt.bulk.start().catch(() => {});
    return rt.bulk;
  }

  // ------------------------------------------------------------ direct links (local mode)

  /** Setup messages of a direct link: encrypted with the group key, bound to both devices. */
  private signalKey(rt: Runtime) {
    return kdf(rt.g.secret, 'signal');
  }

  private async sendSignal(rt: Runtime, to: string, msg: unknown) {
    const data = seal(this.signalKey(rt), utf8(JSON.stringify(msg)), utf8(this.device.id + '>' + to));
    await rt.conn.request('signal', { to, data: b64(data) });
  }

  private onSignal(rt: Runtime, from: string, data: string) {
    if (!rt.peers || !rt.g.state.members[from] || from === this.device.id) return;
    try {
      const plain = open(this.signalKey(rt), unb64(data), utf8(from + '>' + this.device.id));
      rt.peers.onSignal(from, JSON.parse(fromUtf8(plain)));
    } catch {
      /* not from our group */
    }
  }

  /** A sealed chunk of something sent from here, for a device on the same network. */
  private async serveChunk(rt: Runtime, itemId: string, idx: number, device: string) {
    const o = rt.outbox.get(itemId);
    if (!o || !(idx >= 0 && idx < o.chunks)) return null;
    const slice = new Uint8Array(await o.blob.slice(idx * CHUNK_SIZE, (idx + 1) * CHUNK_SIZE).arrayBuffer());
    const sealed = sealContentChunk(o.key, itemId, idx, o.chunks, slice);
    if (o.chunks > 1) this.servedChunk(rt, itemId, o, device);
    return sealed;
  }

  /** Progress of what another device downloads from here, shown like an upload. */
  private servedChunk(rt: Runtime, itemId: string, o: Outgoing, device: string) {
    const id = `direct:${itemId}:${device}`;
    let t = this.transfers.get(id);
    if (!t) {
      const peer = rt.g.state.members[device]?.name;
      t = { id, groupId: rt.g.id, name: o.name, direction: 'up', direct: true, peer, done: 0, total: o.chunks };
      this.transfers.set(id, t);
    }
    track(t, t.done + 1);
    clearTimeout(this.servedTimers.get(id));
    // over, or the other device stopped asking: the line goes
    const end = () => {
      this.servedTimers.delete(id);
      this.transfers.delete(id);
      this.changed();
      this.stopIfIdle();
    };
    this.servedTimers.set(id, setTimeout(end, t.done >= t.total ? 800 : 15_000));
    this.changed();
  }

  /** Local text received: fetched at once from its sender, then announced. */
  private fetchLocalText(rt: Runtime, id: string, announce: boolean) {
    this.content(rt.g.id, id)
      .then((c) => {
        const e = rt.items.get(id);
        if (!e || c.text === undefined) return;
        e.view = { ...e.view, text: c.text };
        // kept: copying it later needs no new transfer
        if (e.opened) e.opened = { ...e.opened, header: { ...e.opened.header, text: c.text } };
        this.changed();
        if (announce) this.emit({ type: 'incoming', groupId: rt.g.id, item: e.view });
      })
      .catch(() => {});
  }

  // ------------------------------------------------------------ groups

  async createGroup(name: string, relay = this.host.defaultRelay): Promise<string> {
    const g = newGroup(this.device, name, relay);
    maintainPrekeys(g);
    await this.save(g);
    const rt = this.attach(g);
    await this.saveIndex();
    if (this.running) rt.conn.start().catch(() => {});
    this.changed();
    return g.id;
  }

  async renameGroup(groupId: string, name: string) {
    const rt = this.rt(groupId);
    rt.g.state = { ...rt.g.state, name, nameAt: Date.now() };
    await this.pushState(rt);
  }

  async renameDevice(name: string) {
    this.device.name = name;
    await this.host.kv.set('device', this.device);
    for (const rt of this.runtimes.values()) {
      const me = rt.g.state.members[this.device.id];
      if (!me) continue;
      rt.g.state = {
        ...rt.g.state,
        members: { ...rt.g.state.members, [me.id]: { ...me, name, addedAt: Date.now() } },
      };
      await this.pushState(rt).catch(() => {});
    }
    this.changed();
  }

  /** Changes the relay retention. Shortening also applies to items already on the relay. */
  async setTtl(groupId: string, ttl: number) {
    const rt = this.rt(groupId);
    const shorter = ttl < rt.g.state.ttl;
    rt.g.state = { ...rt.g.state, ttl, ttlAt: Date.now() };
    await this.pushState(rt);
    if (shorter) await rt.conn.request('items.shorten', { ttl });
  }

  /** History size of the group (0 = unlimited); lowering it applies at once. */
  async setMaxItems(groupId: string, max: number) {
    const rt = this.rt(groupId);
    rt.g.state = { ...rt.g.state, maxItems: max, maxItemsAt: Date.now() };
    await this.pushState(rt);
    if (max > 0) await rt.conn.request('items.trim', { max });
  }

  /**
   * A local item sent from here goes to the relay after all (the group is no longer local
   * only): uploaded like any file, it is then available everywhere. Never automatic.
   */
  async publish(groupId: string, itemId: string) {
    const rt = this.rt(groupId);
    const o = rt.outbox.get(itemId);
    if (!o) throw new Error('contenu plus disponible sur cet appareil');
    const key = `up-${++this.uploadSeq}`;
    const transfer: Transfer = { id: key, groupId, name: o.name, direction: 'up', done: 0, total: o.chunks, itemId };
    this.transfers.set(key, transfer);
    this.changed();
    try {
      const res = await rt.conn.request('item.publish', { id: itemId, size: sealedSize(o.blob.size, o.chunks) });
      await this.upload(rt, itemId, o.key, o.chunks, o.blob, transfer, res.expiresAt);
      await this.retrying(rt, res.expiresAt, () => rt.conn.request('item.commit', { id: itemId }));
      this.transfers.delete(key);
    } catch (err: any) {
      if (err.message === 'unknown item') {
        this.transfers.delete(key);
        throw new Error('Envoi annulé : fichier supprimé');
      }
      transfer.error = err.message === 'full' ? 'Serveur saturé' : String(err.message ?? err);
      throw err;
    } finally {
      this.changed();
      this.stopIfIdle();
    }
  }

  /** Local mode for the whole group: contents only travel directly, on the same network. */
  async setLocalOnly(groupId: string, on: boolean) {
    const rt = this.rt(groupId);
    rt.g.state = { ...rt.g.state, localOnly: on, localOnlyAt: Date.now() };
    await this.pushState(rt);
  }

  /** A text whose content stays on its sender (local mode), not fetched yet. */
  private isLocalText(v: ItemView) {
    return v.kind === 'text' && v.text === undefined && !v.error && !v.mine;
  }

  /** Largest content shared automatically (bytes); manual sends are not limited. */
  async setAutoMax(groupId: string, bytes: number) {
    const rt = this.rt(groupId);
    rt.g.state = { ...rt.g.state, autoMax: bytes, autoMaxAt: Date.now() };
    await this.pushState(rt);
  }

  /** Deletes the whole history of the group, live note included, for every member. */
  async clearAll(groupId: string) {
    const rt = this.rt(groupId);
    await rt.conn.request('items.clear');
    rt.items.clear();
    rt.outbox.clear();
    rt.noteDraft = undefined;
    this.changed();
  }

  /** Room left on the relay (shared by all its groups). */
  async refreshStorage(groupId: string) {
    const rt = this.rt(groupId);
    if (rt.conn.status !== 'online') return;
    const res = await rt.conn.request('storage');
    rt.storage = res.storage;
    this.changed();
  }

  private async wipeGroup(rt: Runtime, notify: boolean) {
    const name = rt.g.state.name;
    this.detach(rt.g.id);
    await this.host.kv.del('group:' + rt.g.id);
    await this.saveIndex();
    if (notify) this.emit({ type: 'removed', groupName: name });
    this.changed();
  }

  /**
   * Removes a device (possibly this one) from a group. The group secret is rotated, the
   * remaining members get the new one through a rotation item that the removed device
   * cannot open, and everything else is deleted from the relay.
   */
  async removeMember(groupId: string, target: string) {
    const rt = this.rt(groupId);
    const me = this.device.id;
    const remaining = Object.keys(rt.g.state.members).filter((id) => id !== target);

    if (remaining.length <= 1) {
      // The group falls to one device: dissolved on the relay.
      await rt.conn.request('room.delete');
      if (target === me || !remaining.includes(me)) {
        await this.wipeGroup(rt, false);
      } else {
        await this.rotateLocally(rt, target, randomBytes(32));
      }
      return;
    }

    const secret = randomBytes(32);
    const next = this.rotatedState(rt, target);
    const recipients = this.recipients(rt).filter((b) => b.device !== target && b.device !== me);
    const header: Header = {
      kind: 'rekey',
      ts: Date.now(),
      rekey: { secret: b64(secret), state: b64(utf8(toJSON(next))) },
    };
    const sealed = sealItem(this.device, recipients, header, 0, target);
    // the history follows the group to its new room, out of reach of the removed device;
    // moved first, so that it is there when the others arrive
    await rt.conn.request('items.move', { roomKey: roomKey({ ...rt.g, secret }) });
    await rt.conn.request('item.create', {
      id: sealed.id,
      meta: sealed.meta,
      sig: sealed.sig,
      from: me,
      chunks: 0,
      size: 0,
      ttl: rt.maxTtl,
    });
    await rt.conn.request('room.purge', { keep: [sealed.id] });
    if (target === me) await this.wipeGroup(rt, false);
    else await this.rotateLocally(rt, target, secret, next);
  }

  private rotatedState(rt: Runtime, target: string): GroupState {
    const s = rt.g.state;
    const members = { ...s.members };
    delete members[target];
    return {
      ...s,
      v: 1,
      members,
      removed: [...new Set([...s.removed, target])],
      updatedBy: this.device.id,
      updatedAt: Date.now(),
    };
  }

  /** Moves this device to the new room after a rotation. */
  private async rotateLocally(rt: Runtime, target: string, secret: Uint8Array, state?: GroupState) {
    const next = state ?? this.rotatedState(rt, target);
    rt.conn.stop();
    // same prekeys: the history moved to the new room was sealed for them (their private
    // halves never left this device, the removed one only ever saw the public ones)
    const g: LocalGroup = { ...rt.g, secret, state: next };
    maintainPrekeys(g);
    await this.save(g);
    this.detach(rt.g.id);
    const fresh = this.attach(g);
    await this.saveIndex();
    if (this.running) await fresh.conn.start().catch(() => {});
    this.changed();
  }

  // ------------------------------------------------------------ relay session

  private async onOpen(rt: Runtime, c: RelayConnection) {
    rt.ready = false; // members' prekeys are reloaded below
    const res = await c.raw('hello', { roomKey: roomKey(rt.g), device: this.device.id });
    rt.maxTtl = res.maxTtl;
    rt.persist = res.persist;
    rt.storage = res.storage;
    rt.online = new Set(res.online ?? []);
    if (res.gone) {
      await this.wipeGroup(rt, true);
      throw new Error('group dissolved');
    }
    // A rotation item addressed to us (or announcing our removal) comes first.
    for (const item of res.items as RelayItem[]) {
      if (await this.handleRotation(rt, item)) throw new Error('group rotated');
    }
    await this.syncState(rt, c, res.state);
    rt.bundles.clear();
    for (const raw of Object.values(res.prekeys ?? {}) as string[]) {
      const b = openBundle(rt.g, raw);
      if (b) rt.bundles.set(b.device, b);
    }
    await this.publishPrekey(rt, c);
    rt.items.clear();
    for (const item of res.items as RelayItem[]) this.addItem(rt, item);
    for (const id of rt.outbox.keys()) if (!rt.items.has(id)) rt.outbox.delete(id);
    rt.ready = true;
    this.changed();
    this.emit({ type: 'synced', groupId: rt.g.id });
    for (const e of rt.items.values()) if (this.isLocalText(e.view)) this.fetchLocalText(rt, e.view.id, false);
    if (rt.noteDraft !== undefined) this.flushNote(rt); // typed while offline
    else this.extendNote(rt);
  }

  private async syncState(rt: Runtime, c: RelayConnection, remote: { v: number; blob: string } | null) {
    for (let attempt = 0; attempt < 5; attempt++) {
      if (remote) {
        let theirs: GroupState;
        try {
          theirs = openState(rt.g, remote.blob);
        } catch (err: any) {
          // Unreadable state on the relay: ours wins.
          this.emit({ type: 'error', message: 'État du groupe illisible sur le serveur : ' + (err.message ?? err) });
          rt.g.state = { ...rt.g.state, v: remote.v + 1, updatedBy: this.device.id, updatedAt: Date.now() };
          remote = null;
          continue;
        }
        const merged = mergeState(rt.g.state, theirs);
        rt.g.state = merged;
        if (sameState(merged, theirs)) {
          await this.save(rt.g);
          return;
        }
        rt.g.state = { ...merged, v: theirs.v + 1, updatedBy: this.device.id, updatedAt: Date.now() };
      }
      // Our state is newer (or the relay forgot it): publish it.
      const res = await c.raw('state.put', { v: rt.g.state.v, blob: sealState(rt.g, this.device) });
      if (!res.conflict) {
        await this.save(rt.g);
        return;
      }
      remote = res.conflict;
    }
    throw new Error('state sync conflict');
  }

  private async pushState(rt: Runtime) {
    rt.g.state = { ...rt.g.state, v: rt.g.state.v + 1, updatedBy: this.device.id, updatedAt: Date.now() };
    await this.save(rt.g);
    this.changed();
    if (rt.conn.status !== 'online') return; // published at the next connection
    const res = await rt.conn.request('state.put', { v: rt.g.state.v, blob: sealState(rt.g, this.device) });
    if (res.conflict) await this.syncState(rt, rt.conn, res.conflict);
  }

  private async publishPrekey(rt: Runtime, c: RelayConnection) {
    const created = maintainPrekeys(rt.g);
    const current = currentPrekey(rt.g)!;
    const published = rt.bundles.get(this.device.id);
    if (created || !published || published.at !== current.createdAt) {
      await c.raw('prekey.put', { device: this.device.id, bundle: signedBundle(rt.g, this.device, current) });
      rt.bundles.set(this.device.id, { device: this.device.id, pk: current.pk, at: current.createdAt });
    }
    await this.save(rt.g);
  }

  private async onEvent(rt: Runtime, e: RelayEvent) {
    switch (e.ev) {
      case 'item': {
        if (await this.handleRotation(rt, e.item)) return;
        const view = this.addItem(rt, e.item);
        if (view && !view.mine && rt.peers && rt.online.has(view.from)) rt.peers.warm(view.from);
        if (view && this.isLocalText(view)) this.fetchLocalText(rt, view.id, true); // announced once fetched
        else if (view && !view.mine && !view.error && !view.pending && view.kind !== 'note') {
          this.emit({ type: 'incoming', groupId: rt.g.id, item: view });
        }
        this.changed();
        break;
      }
      case 'progress': {
        const entry = rt.items.get(e.id);
        if (!entry || entry.relay.complete) break;
        entry.relay.have = e.have;
        entry.relay.progressAt = e.at;
        const speed: { rate?: number; marks?: Array<[number, number]> } = { marks: entry.marks };
        track(speed, e.have, e.at);
        entry.marks = speed.marks;
        entry.view = { ...entry.view, have: e.have, progressAt: e.at, rate: speed.rate };
        this.changed();
        break;
      }
      case 'signal':
        this.onSignal(rt, e.from, e.data);
        break;
      case 'deleted':
        rt.items.delete(e.id);
        rt.outbox.delete(e.id);
        this.changed();
        break;
      case 'refresh': {
        const res = await rt.conn.request('items.list');
        rt.items.clear();
        for (const item of res.items as RelayItem[]) {
          if (await this.handleRotation(rt, item)) return;
          this.addItem(rt, item);
        }
        for (const id of rt.outbox.keys()) if (!rt.items.has(id)) rt.outbox.delete(id);
        this.changed();
        break;
      }
      case 'state':
        await this.syncState(rt, rt.conn, e.state);
        this.changed();
        break;
      case 'prekey': {
        const b = openBundle(rt.g, e.bundle);
        if (b) rt.bundles.set(b.device, b);
        this.extendNote(rt);
        break;
      }
      case 'note': {
        const entry = rt.items.get(e.id);
        if (!entry?.opened) break;
        try {
          entry.note = openNote(entry.opened.key, e.id, e.data);
        } catch {
          break;
        }
        entry.relay.expiresAt = entry.view.expiresAt = e.expiresAt;
        this.changed();
        break;
      }
      case 'presence': {
        const before = rt.online;
        rt.online = new Set(e.online as string[]);
        const joined = [...rt.online].filter((d) => !before.has(d) && d !== this.device.id);
        for (const d of joined) rt.peers?.forget(d); // back: worth a direct try again
        if (joined.length) this.emit({ type: 'presence', groupId: rt.g.id, joined });
        this.changed();
        break;
      }
      case 'gone':
        await this.wipeGroup(rt, true);
        break;
    }
  }

  /** Returns true if the item was a rotation that changed this group. */
  private async handleRotation(rt: Runtime, item: RelayItem): Promise<boolean> {
    let meta;
    try {
      meta = verifyItem(rt.g, item);
    } catch {
      return false;
    }
    if (!meta.removed) return false;
    if (meta.removed === this.device.id) {
      await this.wipeGroup(rt, true);
      return true;
    }
    if (!meta.env[this.device.id]) return false;
    const opened = openItem(rt.g, this.device, item);
    const rekey = opened.header.rekey!;
    const next = fromJSON<GroupState>(fromUtf8(unb64(rekey.state)));
    await this.rotateLocally(rt, meta.removed, unb64(rekey.secret), next);
    return true;
  }

  private addItem(rt: Runtime, item: RelayItem): ItemView | null {
    const base = {
      id: item.id,
      from: item.from,
      fromName: rt.g.state.members[item.from]?.name ?? '?',
      mine: item.from === this.device.id,
      createdAt: item.createdAt,
      expiresAt: item.expiresAt,
      chunks: item.chunks,
      ...(item.complete ? {} : { pending: true, have: item.have ?? 0, progressAt: item.progressAt ?? item.createdAt }),
    };
    try {
      const opened = openItem(rt.g, this.device, item);
      if (opened.header.kind === 'rekey') return null;
      const h = opened.header;
      const text = h.text ?? rt.outbox.get(item.id)?.text; // a local text sent from here
      const view: ItemView = { ...base, kind: h.kind, text, name: h.name, mime: h.mime, size: h.size, thumb: h.thumb };
      if (item.local) view.local = true; // the relay's flag: it drops once sent to the relay
      const entry: Entry = { relay: item, opened, view };
      if (h.kind === 'note') {
        const prev = rt.items.get(item.id)?.note;
        let stored: NoteText | undefined;
        try {
          if (item.live) stored = openNote(opened.key, item.id, item.live);
        } catch {}
        entry.note = prev && (!stored || prev.at >= stored.at) ? prev : stored;
      }
      rt.items.set(item.id, entry);
      return view;
    } catch (err: any) {
      const view: ItemView = { ...base, kind: 'file', error: String(err.message ?? err) };
      rt.items.set(item.id, { relay: item, view });
      return view;
    }
  }

  // ------------------------------------------------------------ sending

  /**
   * Waits until the group is connected and its members' prekeys are loaded: an item sealed
   * before that would only be readable by this device (e.g. an Android share, handed over
   * while the app is still connecting).
   */
  private whenReady(rt: Runtime, timeout = 30_000): Promise<void> {
    const ok = () => rt.ready && rt.conn.status === 'online';
    if (ok()) return Promise.resolve();
    if (!this.running) rt.conn.start().catch(() => {});
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error('timeout'));
      }, timeout);
      const off = this.on(() => {
        if (!ok()) return;
        clearTimeout(timer);
        off();
        resolve();
      });
    });
  }

  /** Prekey bundles of every member we can encrypt to (including ourselves). */
  private recipients(rt: Runtime): PrekeyBundle[] {
    const out: PrekeyBundle[] = [];
    for (const id of Object.keys(rt.g.state.members)) {
      if (id === this.device.id) {
        const p = currentPrekey(rt.g);
        if (p) out.push({ device: id, pk: p.pk, at: p.createdAt });
      } else {
        const b = rt.bundles.get(id);
        if (b) out.push(b);
      }
    }
    return out;
  }

  async sendText(groupId: string, text: string) {
    if (utf8(text).length > INLINE_TEXT_MAX) {
      return this.sendBlob(groupId, new Blob([text], { type: 'text/plain' }), 'texte.txt', 'file');
    }
    const rt = this.rt(groupId);
    // local mode: not even a short text in the announcement, it is fetched from here
    if (localOnlyOf(rt.g.state)) return this.sendBlob(groupId, new Blob([text], { type: 'text/plain' }), '', 'text', undefined, text);
    await this.whenReady(rt);
    const header: Header = { kind: 'text', ts: Date.now(), text, size: text.length };
    const sealed = sealItem(this.device, this.recipients(rt), header, 0);
    await rt.conn.request('item.create', {
      id: sealed.id,
      meta: sealed.meta,
      sig: sealed.sig,
      from: this.device.id,
      chunks: 0,
      size: 0,
      ttl: rt.g.state.ttl,
      max: maxItemsOf(rt.g.state),
    });
  }

  async sendBlob(groupId: string, blob: Blob, name: string, kind: 'image' | 'file' | 'text', thumb?: string, text?: string) {
    const rt = this.rt(groupId);
    // shown at once, even while the connection is still being set up
    const key = `up-${++this.uploadSeq}`;
    const transfer: Transfer = { id: key, groupId, name, direction: 'up', done: 0, total: 0 };
    this.transfers.set(key, transfer);
    this.changed();
    try {
      await this.whenReady(rt);
      // local mode: only the announcement goes to the relay (no thumbnail: it is content too)
      const local = localOnlyOf(rt.g.state);
      const header: Header = { kind, ts: Date.now(), name: name || undefined, mime: blob.type, size: blob.size };
      if (local) header.local = true;
      else if (thumb) header.thumb = thumb;
      const sealed = sealItem(this.device, this.recipients(rt), header, Math.max(blob.size, 1));
      transfer.total = sealed.chunks;
      // served from here to the devices on the same network, before even the relay has it
      rt.outbox.set(sealed.id, { blob, key: sealed.key, chunks: sealed.chunks, name: name || 'texte', text });
      this.changed();
      const created = await rt.conn.request('item.create', {
        id: sealed.id,
        meta: sealed.meta,
        sig: sealed.sig,
        from: this.device.id,
        chunks: sealed.chunks,
        size: local ? 0 : sealedSize(blob.size, sealed.chunks),
        ttl: rt.g.state.ttl,
        max: maxItemsOf(rt.g.state),
        ...(local ? { local: true } : {}),
      });
      transfer.itemId = sealed.id;
      if (local) {
        this.transfers.delete(key);
        return;
      }
      const until: number = created.expiresAt;
      await this.upload(rt, sealed.id, sealed.key, sealed.chunks, blob, transfer, until);
      await this.retrying(rt, until, () => rt.conn.request('item.commit', { id: sealed.id }));
      this.transfers.delete(key);
    } catch (err: any) {
      if (err.message === 'unknown item') {
        // deleted (from this device or another) while being sent: nothing left to show
        this.transfers.delete(key);
        throw new Error('Envoi annulé : fichier supprimé');
      }
      transfer.error = err.message === 'full' ? 'Serveur saturé' : String(err.message ?? err);
      throw err;
    } finally {
      this.changed();
      this.stopIfIdle();
    }
  }

  /** A transfer is in progress (a failed one stays listed with its error). */
  get busy() {
    return [...this.transfers.values()].some((t) => !t.error);
  }

  private stopIfIdle() {
    if (this.stopWhenIdle && !this.busy) this.stop();
  }

  /**
   * Runs a relay request; when the connection drops (network change, phone asleep…), waits
   * for it to come back and tries again, until `until` (the item's expiry).
   */
  private async retrying<T>(rt: Runtime, until: number, fn: () => Promise<T>): Promise<T> {
    for (;;) {
      try {
        return await fn();
      } catch (err: any) {
        if (err.message !== 'disconnected' && err.message !== 'timeout') throw err;
        await this.reconnected(rt, until);
      }
    }
  }

  /** Waits for the connection (and the members' prekeys) to be back. */
  private async reconnected(rt: Runtime, until: number) {
    for (;;) {
      if (Date.now() > until) throw new Error('connexion perdue');
      if (!this.runtimes.has(rt.g.id)) throw new Error('groupe quitté');
      try {
        await this.whenReady(rt, 60_000);
        return;
      } catch {}
    }
  }

  /**
   * Uploads chunks 4 at a time. After a disconnection (or the phone waking up), waits for the
   * connection and resumes with the chunks the relay does not have yet.
   */
  private async upload(rt: Runtime, id: string, key: Uint8Array, chunks: number, blob: Blob, t: Transfer, until: number) {
    for (let attempt = 0; ; attempt++) {
      let missing = [...Array(chunks).keys()];
      if (attempt > 0) {
        const { have } = await this.retrying(rt, until, () => this.bulk(rt).request('chunk.have', { id }));
        missing = missing.filter((i) => !have.includes(i));
        t.done = chunks - missing.length;
        this.changed();
      }
      try {
        const queue = [...missing];
        const worker = async () => {
          for (let idx = queue.shift(); idx !== undefined; idx = queue.shift()) {
            if (rt.cancelled.has(id)) throw new Error('unknown item'); // deleted meanwhile
            const slice = new Uint8Array(await blob.slice(idx * CHUNK_SIZE, (idx + 1) * CHUNK_SIZE).arrayBuffer());
            const data = sealContentChunk(key, id, idx, chunks, slice);
            // little in the socket's queue: a short message (setting up a direct link, a
            // note) never waits behind megabytes of chunks
            const bulk = this.bulk(rt);
            while (bulk.buffered > SEND_QUEUE_MAX) await new Promise((r) => setTimeout(r, 20));
            await bulk.request('chunk.put', { itemId: id, idx }, data);
            track(t, t.done + 1);
            this.changed();
          }
        };
        await Promise.all([worker(), worker(), worker(), worker()]);
        return;
      } catch (err: any) {
        if (err.message !== 'disconnected' && err.message !== 'timeout') throw err;
        await this.reconnected(rt, until);
      }
    }
  }

  // ------------------------------------------------------------ receiving

  /** Text of a text item, or the decrypted content as a Blob. */
  async content(groupId: string, itemId: string): Promise<{ text?: string; blob?: Blob; name?: string; mime?: string }> {
    const rt = this.rt(groupId);
    const entry = rt.items.get(itemId);
    if (!entry) throw new ItemGoneError();
    if (!entry.opened) throw new Error('item unavailable');
    const { header, key } = entry.opened;
    if (header.kind === 'text' && header.text !== undefined) return { text: header.text };
    const textOf = async (blob: Blob) => (header.kind === 'text' ? { text: await blob.text() } : {});
    // sent from here: nothing to download
    const own = rt.outbox.get(itemId);
    if (own) return { blob: own.blob, name: header.name, mime: header.mime, ...(await textOf(own.blob)) };
    const from = entry.relay.from;
    const sender = rt.g.state.members[from]?.name ?? 'l’expéditeur';
    const unreachable = () => new Error(`Disponible seulement quand « ${sender} » est connecté sur le même réseau`);
    // same network as the sender: straight from it. Until the direct link is up (or if it
    // cannot be), chunks come from the relay; local items can only come directly.
    const peers = from !== this.device.id && rt.online.has(from) ? rt.peers : undefined;
    let directFailed = !peers || !peers.reachable(from);
    const local = !!entry.relay.local;
    if (local && directFailed) throw unreachable();
    if (!directFailed) peers!.warm(from);
    const chunks = entry.relay.chunks;
    const transfer: Transfer = { id: itemId, groupId, name: header.name ?? '', direction: 'down', done: 0, total: chunks, peer: sender };
    if (chunks > 1) this.transfers.set(itemId, transfer);
    try {
      const parts: Uint8Array[] = new Array(chunks);
      const queue = [...Array(chunks).keys()];
      const worker = async () => {
        for (let idx = queue.shift(); idx !== undefined; idx = queue.shift()) {
          for (let askedComplete = false; ; ) {
            // local item: waits for the link; otherwise only once it is up
            if (!directFailed && (local || peers!.isConnected(from))) {
              try {
                parts[idx] = openContentChunk(key, itemId, idx, chunks, await peers!.fetch(from, itemId, idx));
                transfer.direct = true;
                break;
              } catch {
                // the direct link failed: the relay takes over (except in local mode)
                directFailed = true;
                transfer.direct = false;
                if (local) throw unreachable();
              }
            }
            try {
              if (!rt.items.has(itemId)) throw new ItemGoneError(); // deleted meanwhile
              const res = await this.retrying(rt, entry.relay.expiresAt, () => this.bulk(rt).request('chunk.get', { id: itemId, idx }));
              parts[idx] = openContentChunk(key, itemId, idx, chunks, res.data);
              break;
            } catch (err: any) {
              if (err.message !== 'unknown chunk' && err.message !== 'unknown item') throw err;
              // Still being uploaded: this chunk is not there yet, wait for the sender.
              // Otherwise deleted (or expired) on the relay while we were downloading it.
              const now = rt.items.get(itemId);
              if (!now || err.message === 'unknown item') throw new ItemGoneError();
              if (now.relay.complete) {
                // completed just after our request: once more, then it really is gone
                if (askedComplete) throw new ItemGoneError();
                askedComplete = true;
                continue;
              }
              if (Date.now() - (now.relay.progressAt ?? now.relay.createdAt) > UPLOAD_STALLED) {
                throw new Error('Envoi interrompu : réessaie quand l’expéditeur sera de retour');
              }
              await this.nextChange(5_000);
            }
          }
          track(transfer, transfer.done + 1);
          this.changed();
        }
      };
      await Promise.all([...Array(DOWNLOAD_WORKERS)].map(worker));
      const content = parts.slice(0, chunks);
      // a 0-byte file is sent as one chunk holding one byte
      const size = header.size ?? 0;
      const blob = new Blob(content as BlobPart[], { type: header.mime || 'application/octet-stream' }).slice(0, size, header.mime);
      return { blob, name: header.name, mime: header.mime, ...(await textOf(blob)) };
    } finally {
      this.transfers.delete(itemId);
      this.changed();
      this.stopIfIdle();
    }
  }

  /** Resolves at the next change (a chunk received by the relay, a deletion…), or after `ms`. */
  private nextChange(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        off();
        resolve();
      };
      const timer = setTimeout(done, ms);
      const off = this.on((e) => e.type === 'change' && done());
    });
  }

  /** Gone from the screen at once (and its upload stopped); the relay follows. */
  async deleteItem(groupId: string, itemId: string) {
    const rt = this.rt(groupId);
    rt.items.delete(itemId);
    rt.outbox.delete(itemId);
    rt.cancelled.add(itemId);
    for (const id of [...this.transfers.keys()]) if (id.startsWith(`direct:${itemId}:`)) this.transfers.delete(id);
    this.changed();
    try {
      await rt.conn.request('item.delete', { id: itemId });
    } catch (err) {
      // not deleted after all: the relay's list is the truth
      this.refreshItems(rt).catch(() => {});
      throw err;
    }
  }

  private async refreshItems(rt: Runtime) {
    const res = await rt.conn.request('items.list');
    rt.items.clear();
    for (const item of res.items as RelayItem[]) this.addItem(rt, item);
    this.changed();
  }

  // ------------------------------------------------------------ live note

  /** The newest note this device can read. */
  private currentNote(rt: Runtime): Entry | undefined {
    let best: Entry | undefined;
    for (const e of rt.items.values()) {
      if (e.opened?.header.kind === 'note' && (!best || e.relay.createdAt > best.relay.createdAt)) best = e;
    }
    return best;
  }

  private noteView(rt: Runtime): NoteView | null {
    const cur = this.currentNote(rt);
    const draft = rt.noteDraft;
    if (draft !== undefined) {
      if (!draft) return null;
      const me = this.device.id;
      return { text: draft, by: me, byName: this.device.name, mine: true, at: Date.now(), expiresAt: cur?.relay.expiresAt ?? 0 };
    }
    const n = cur?.note;
    if (!cur || !n?.text || cur.relay.expiresAt < Date.now()) return null;
    return {
      text: n.text,
      by: n.by,
      byName: rt.g.state.members[n.by]?.name ?? '?',
      mine: n.by === this.device.id,
      at: n.at,
      expiresAt: cur.relay.expiresAt,
    };
  }

  /**
   * Sets the live note of a group. Each change is sent at once; while one is in flight,
   * the next ones collapse into the latest text. An empty note is deleted from the relay.
   */
  setNote(groupId: string, text: string) {
    const rt = this.rt(groupId);
    rt.noteDraft = text;
    this.changed();
    this.flushNote(rt);
  }

  private async flushNote(rt: Runtime) {
    if (rt.noteSending) return;
    rt.noteSending = true;
    try {
      while (rt.noteDraft !== undefined) {
        const text = rt.noteDraft;
        await this.pushNote(rt, text);
        if (rt.noteDraft === text) rt.noteDraft = undefined;
      }
    } catch (err: any) {
      // kept as a draft, sent again at the next connection
      if (err.message !== 'disconnected' && err.message !== 'timeout') {
        this.emit({ type: 'error', message: 'Note non envoyée : ' + (err.message ?? err) });
      }
    } finally {
      rt.noteSending = false;
      this.changed();
    }
  }

  private async pushNote(rt: Runtime, text: string) {
    const notes = [...rt.items.values()].filter((e) => e.opened?.header.kind === 'note');
    if (!text) {
      for (const e of notes) await this.deleteItem(rt.g.id, e.relay.id);
      return;
    }
    await this.whenReady(rt);
    const recipients = this.recipients(rt);
    let cur = this.currentNote(rt);
    // A new note when a member could not read the current one (new device, rotated prekey).
    if (!cur || recipients.some((r) => !cur!.opened!.meta.env[r.device])) {
      const sealed = sealItem(this.device, recipients, { kind: 'note', ts: Date.now() }, 0);
      const res = await rt.conn.request('item.create', {
        id: sealed.id,
        meta: sealed.meta,
        sig: sealed.sig,
        from: this.device.id,
        chunks: 0,
        size: 0,
        ttl: rt.g.state.ttl,
        note: true,
      });
      this.addItem(rt, {
        id: sealed.id,
        meta: sealed.meta,
        sig: sealed.sig,
        from: this.device.id,
        chunks: 0,
        size: 0,
        createdAt: res.createdAt,
        expiresAt: res.expiresAt,
        complete: true,
      });
      cur = rt.items.get(sealed.id)!;
    }
    const note: NoteText = { text, by: this.device.id, at: Date.now() };
    const res = await rt.conn.request('note.put', { id: cur.relay.id, data: sealNote(cur.opened!.key, cur.relay.id, note) });
    cur.note = note;
    cur.relay.expiresAt = cur.view.expiresAt = res.expiresAt;
    for (const e of notes) if (e !== cur) await this.deleteItem(rt.g.id, e.relay.id).catch(() => {});
  }

  /** A device joined: the author of the current note re-sends it so that it can read it. */
  private extendNote(rt: Runtime) {
    const cur = this.currentNote(rt);
    if (!cur?.note?.text || cur.relay.from !== this.device.id || rt.noteSending) return;
    if (this.recipients(rt).every((r) => cur.opened!.meta.env[r.device])) return;
    rt.noteDraft = cur.note.text;
    this.flushNote(rt);
  }

  // ------------------------------------------------------------ pairing

  /** Shows an invitation (QR code) for `groupId`. The first device to scan it joins. */
  invite(groupId: string, onJoined: (name: string) => void, publicUrl?: string): Invite {
    const rt = this.rt(groupId);
    const secret = randomBytes(32);
    const channel = b64(kdf(secret, 'pair-channel'));
    const key = kdf(secret, 'pair-key');
    const expiresAt = Date.now() + INVITE_TTL;
    let done = false;
    const conn: RelayConnection = new RelayConnection(
      rt.g.relay,
      async (c) => {
        await c.raw('pair.join', { channel });
      },
      async (e) => {
        if (e.ev !== 'pair' || done) return;
        try {
          const msg = JSON.parse(fromUtf8(open(key, unb64(e.data), utf8('join'))));
          const joiner = fromJSON<Member>(msg.member);
          if (joiner.id === this.device.id) return;
          done = true;
          const member: Member = { ...joiner, addedBy: this.device.id, addedAt: Date.now() };
          rt.g.state = {
            ...rt.g.state,
            members: { ...rt.g.state.members, [member.id]: member },
            removed: rt.g.state.removed.filter((id) => id !== member.id),
          };
          await this.pushState(rt);
          const welcome = toJSON({ groupId: rt.g.id, secret: rt.g.secret, relay: rt.g.relay, state: rt.g.state });
          await conn.request('pair.send', { channel, data: b64(seal(key, utf8(welcome), utf8('welcome'))) });
          setTimeout(() => conn.stop(), 1000);
          onJoined(member.name);
        } catch (err: any) {
          this.emit({ type: 'error', message: "Échec de l'association : " + (err.message ?? err) });
        }
      },
    );
    conn.start().catch(() => {});
    const timer = setTimeout(() => conn.stop(), INVITE_TTL);
    const base = publicUrl ?? rt.g.relay;
    return {
      url: `${base.replace(/\/$/, '')}/app/#p=${b64(secret)}`,
      expiresAt,
      cancel: () => {
        clearTimeout(timer);
        conn.stop();
      },
    };
  }

  /** Joins a group from an invitation link (https://relay/app/#p=…). */
  async join(link: string): Promise<string> {
    const url = new URL(link);
    const param = new URLSearchParams(url.hash.slice(1)).get('p');
    if (!param) throw new Error('lien invalide');
    const secret = unb64(param);
    const relay = url.origin;
    const channel = b64(kdf(secret, 'pair-channel'));
    const key = kdf(secret, 'pair-key');
    const me = toJSON(memberOf(this.device, this.device.id));
    const hello = b64(seal(key, utf8(JSON.stringify({ member: me })), utf8('join')));

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => fail(new Error('invitation expirée')), 60_000);
      const fail = (err: Error) => {
        clearTimeout(timer);
        conn.stop();
        reject(err);
      };
      const conn: RelayConnection = new RelayConnection(
        relay,
        async (c) => {
          const res = await c.raw('pair.join', { channel });
          if (res.peers > 0) await c.raw('pair.send', { channel, data: hello });
        },
        async (e) => {
          try {
            if (e.ev === 'pair.peer') {
              await conn.request('pair.send', { channel, data: hello });
              return;
            }
            if (e.ev !== 'pair') return;
            const w = fromJSON<{ groupId: string; secret: Uint8Array; relay: string; state: GroupState }>(
              fromUtf8(open(key, unb64(e.data), utf8('welcome'))),
            );
            const existing = this.runtimes.get(w.groupId);
            if (existing) this.detach(w.groupId);
            const g: LocalGroup = { id: w.groupId, secret: w.secret, relay: w.relay || relay, state: w.state, prekeys: [] };
            maintainPrekeys(g);
            await this.save(g);
            const rt = this.attach(g);
            await this.saveIndex();
            clearTimeout(timer);
            conn.stop();
            if (this.running) rt.conn.start().catch(() => {});
            this.changed();
            resolve(g.id);
          } catch (err: any) {
            fail(err);
          }
        },
      );
      conn.start().catch(fail);
    });
  }

  /** Erases every group and the identity of this device (local only). */
  async reset() {
    for (const rt of [...this.runtimes.values()]) {
      await this.removeMember(rt.g.id, this.device.id).catch(() => this.wipeGroup(rt, false));
    }
    await this.host.kv.del('device');
    await this.host.kv.del('groups');
  }
}

export { randomId };
