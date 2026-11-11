// Everything the relay keeps, in Redis. The relay only ever sees opaque, end-to-end
// encrypted blobs: rooms are identified by sha256(roomKey), never by the key itself.
//
//   r:{room}:state          hash  { v, blob }      encrypted group state, versioned
//   r:{room}:gone           string                 the group was dissolved
//   r:{room}:pk             hash  device -> bundle signed public prekeys
//   r:{room}:items          zset  item id -> expiresAt (ms)
//   r:{room}:i:{id}         hash  { meta, sig, from, chunks, size, ttl, createdAt, expiresAt, complete,
//                                   have, progressAt, local, note?, live?, updatedAt? }  local: content
//                                   never uploaded, devices fetch it from the sender directly  have: chunks received
//                                   so far (an item is listed while it is being uploaded); note: live
//                                   note (not counted in the history size), live = its latest text
//   r:{room}:c:{id}:{idx}   bytes one encrypted chunk

const ROOM_IDLE_TTL = 30 * 24 * 3600; // a group unused for 30 days is forgotten (devices keep their copy)

const CAS_STATE = `
local cur = tonumber(redis.call('HGET', KEYS[1], 'v') or '0')
if tonumber(ARGV[1]) <= cur then return cur end
redis.call('HSET', KEYS[1], 'v', ARGV[1], 'blob', ARGV[2])
redis.call('EXPIRE', KEYS[1], ARGV[3])
return -1`;

export class Store {
  /** @param {import('ioredis').Redis} redis */
  constructor(redis) {
    this.redis = redis;
    redis.defineCommand('casState', { numberOfKeys: 1, lua: CAS_STATE });
  }

  k(room, ...parts) {
    return ['r', room, ...parts].join(':');
  }

  async touchRoom(room) {
    await this.redis
      .multi()
      .expire(this.k(room, 'state'), ROOM_IDLE_TTL)
      .expire(this.k(room, 'pk'), ROOM_IDLE_TTL)
      .exec();
  }

  // ---- group state ----

  async getState(room) {
    const [state, gone] = await Promise.all([
      this.redis.hgetall(this.k(room, 'state')),
      this.redis.exists(this.k(room, 'gone')),
    ]);
    return { state: state.v ? { v: Number(state.v), blob: state.blob } : null, gone: gone === 1 };
  }

  /** Writes the state if `v` is newer. Returns null on success, or the current state on conflict. */
  async putState(room, v, blob) {
    const res = await this.redis.casState(this.k(room, 'state'), v, blob, ROOM_IDLE_TTL);
    if (Number(res) === -1) return null;
    return (await this.getState(room)).state;
  }

  // ---- prekeys ----

  async putPrekey(room, device, bundle) {
    await this.redis.multi().hset(this.k(room, 'pk'), device, bundle).expire(this.k(room, 'pk'), ROOM_IDLE_TTL).exec();
  }

  async listPrekeys(room) {
    return this.redis.hgetall(this.k(room, 'pk'));
  }

  async deletePrekey(room, device) {
    await this.redis.hdel(this.k(room, 'pk'), device);
  }

  // ---- items ----

  async createItem(room, { id, meta, sig, from, chunks, size, ttl, note, local }) {
    const key = this.k(room, 'i', id);
    if (await this.redis.exists(key)) throw new Error('exists');
    const createdAt = Date.now();
    const expiresAt = createdAt + ttl * 1000;
    await this.redis
      .multi()
      .hset(key, {
        meta, sig, from, chunks, size, ttl, createdAt, expiresAt,
        // local: the content stays on the sender, devices fetch it directly (never uploaded)
        complete: chunks === 0 || local ? 1 : 0, have: 0, progressAt: createdAt, note: note ? 1 : 0, local: local ? 1 : 0,
      })
      .pexpireat(key, expiresAt)
      .zadd(this.k(room, 'items'), expiresAt, id)
      .exec();
    return { createdAt, expiresAt };
  }

  async getItem(room, id) {
    const h = await this.redis.hgetall(this.k(room, 'i', id));
    if (!h.meta) return null;
    const item = {
      id,
      meta: h.meta,
      sig: h.sig,
      from: h.from,
      chunks: Number(h.chunks),
      size: Number(h.size),
      createdAt: Number(h.createdAt),
      expiresAt: Number(h.expiresAt),
      complete: h.complete === '1',
    };
    if (h.local === '1') item.local = true;
    if (!item.complete) {
      item.have = Number(h.have) || 0;
      item.progressAt = Number(h.progressAt) || item.createdAt;
    }
    if (h.live) {
      item.live = h.live;
      item.updatedAt = Number(h.updatedAt);
    }
    return item;
  }

  /** Live note: replaces its encrypted text; the retention restarts from now. */
  async putLive(room, id, data) {
    const key = this.k(room, 'i', id);
    const h = await this.redis.hmget(key, 'chunks', 'ttl');
    if (h[0] !== '0' || !h[1]) throw new Error('unknown item');
    const updatedAt = Date.now();
    const expiresAt = updatedAt + Number(h[1]) * 1000;
    await this.redis
      .multi()
      .hset(key, { live: data, updatedAt, expiresAt })
      .pexpireat(key, expiresAt)
      .zadd(this.k(room, 'items'), expiresAt, id)
      .exec();
    return { updatedAt, expiresAt };
  }

  /** A local item goes to the relay after all: its chunks are now expected. */
  async publishItem(room, id, size) {
    const key = this.k(room, 'i', id);
    const h = await this.redis.hmget(key, 'local', 'meta');
    if (!h[1]) throw new Error('unknown item');
    if (h[0] !== '1') throw new Error('not local');
    await this.redis.hset(key, { local: 0, complete: 0, have: 0, progressAt: Date.now(), size });
    return this.getItem(room, id);
  }

  /** Stores a chunk. Returns the number of chunks received so far. */
  async putChunk(room, id, idx, data) {
    const item = await this.getItem(room, id);
    if (!item) throw new Error('unknown item');
    if (item.complete) throw new Error('item already complete');
    if (!(idx >= 0 && idx < item.chunks)) throw new Error('bad chunk index');
    const key = this.k(room, 'c', id, idx);
    const ikey = this.k(room, 'i', id);
    // NX: a chunk sent again after a reconnection is not counted twice
    const [[, isNew]] = await this.redis.multi().set(key, data, 'PXAT', item.expiresAt, 'NX').exec();
    if (isNew !== 'OK') {
      await this.redis.set(key, data, 'PXAT', item.expiresAt);
      return item.have;
    }
    const [[, have]] = await this.redis.multi().hincrby(ikey, 'have', 1).hset(ikey, 'progressAt', Date.now()).exec();
    return Number(have);
  }

  async haveChunks(room, id, chunks) {
    if (chunks === 0) return [];
    const pipe = this.redis.pipeline();
    for (let i = 0; i < chunks; i++) pipe.exists(this.k(room, 'c', id, i));
    const res = await pipe.exec();
    return res.map(([, n], i) => (n === 1 ? i : -1)).filter((i) => i >= 0);
  }

  async commitItem(room, id) {
    const item = await this.getItem(room, id);
    if (!item) throw new Error('unknown item');
    const have = await this.haveChunks(room, id, item.chunks);
    if (have.length !== item.chunks) throw new Error('missing chunks');
    await this.redis.hset(this.k(room, 'i', id), 'complete', 1);
    item.complete = true;
    return item;
  }

  async getChunk(room, id, idx) {
    return this.redis.getBuffer(this.k(room, 'c', id, idx));
  }

  async listItems(room) {
    const zkey = this.k(room, 'items');
    await this.redis.zremrangebyscore(zkey, '-inf', Date.now());
    const ids = await this.redis.zrange(zkey, 0, -1);
    const items = await Promise.all(ids.map((id) => this.getItem(room, id)));
    return items.filter(Boolean); // items being uploaded too: they show their progress
  }

  async deleteItem(room, id) {
    const item = await this.getItem(room, id);
    const keys = [this.k(room, 'i', id)];
    for (let i = 0; i < (item?.chunks ?? 0); i++) keys.push(this.k(room, 'c', id, i));
    await this.redis.multi().del(...keys).zrem(this.k(room, 'items'), id).exec();
    return !!item;
  }

  /** Keeps the `max` most recent items (live notes aside). Returns the deleted ids. */
  async trimItems(room, max) {
    const ids = await this.redis.zrange(this.k(room, 'items'), 0, -1);
    if (ids.length <= max) return [];
    const pipe = this.redis.pipeline();
    for (const id of ids) pipe.hmget(this.k(room, 'i', id), 'createdAt', 'note');
    const rows = (await pipe.exec()).map(([, r], i) => ({ id: ids[i], createdAt: Number(r[0]), note: r[1] === '1' }));
    const old = rows
      .filter((r) => !r.note && r.createdAt)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(max)
      .map((r) => r.id);
    for (const id of old) await this.deleteItem(room, id);
    return old;
  }

  /** Deletes every item of the room (history and live note), keeps the group. */
  async clearItems(room) {
    const ids = await this.redis.zrange(this.k(room, 'items'), 0, -1);
    for (const id of ids) await this.deleteItem(room, id);
    return ids.length;
  }

  /** Shortens the lifetime of existing items to createdAt + ttl (never lengthens it). */
  async shortenItems(room, ttl) {
    const ids = await this.redis.zrange(this.k(room, 'items'), 0, -1);
    let changed = 0;
    for (const id of ids) {
      const item = await this.getItem(room, id);
      if (!item) continue;
      const expiresAt = (item.updatedAt || item.createdAt) + ttl * 1000;
      if (expiresAt >= item.expiresAt) continue;
      if (expiresAt <= Date.now()) {
        await this.deleteItem(room, id);
      } else {
        const multi = this.redis.multi();
        multi.hset(this.k(room, 'i', id), { expiresAt, ttl }).pexpireat(this.k(room, 'i', id), expiresAt);
        for (let i = 0; i < item.chunks; i++) multi.pexpireat(this.k(room, 'c', id, i), expiresAt);
        multi.zadd(this.k(room, 'items'), expiresAt, id);
        await multi.exec();
      }
      changed++;
    }
    return changed;
  }

  /** Deletes every item except `keep`, all prekeys and the state (after a key rotation). */
  /**
   * Moves the history to another room (the group after a key rotation): items and their
   * chunks keep their ids, ciphertexts and lifetimes. `except` stays behind.
   */
  async moveItems(room, to, except = []) {
    const ids = await this.redis.zrange(this.k(room, 'items'), 0, -1, 'WITHSCORES');
    let moved = 0;
    for (let i = 0; i < ids.length; i += 2) {
      const id = ids[i];
      const expiresAt = Number(ids[i + 1]);
      if (except.includes(id)) continue;
      const item = await this.getItem(room, id);
      if (!item) continue;
      const m = this.redis.multi().rename(this.k(room, 'i', id), this.k(to, 'i', id));
      for (let c = 0; c < item.chunks; c++) {
        if (await this.redis.exists(this.k(room, 'c', id, c))) m.rename(this.k(room, 'c', id, c), this.k(to, 'c', id, c));
      }
      m.zadd(this.k(to, 'items'), expiresAt, id).zrem(this.k(room, 'items'), id);
      await m.exec();
      moved++;
    }
    return moved;
  }

  async purgeRoom(room, keep = []) {
    const ids = await this.redis.zrange(this.k(room, 'items'), 0, -1);
    for (const id of ids) if (!keep.includes(id)) await this.deleteItem(room, id);
    await this.redis.del(this.k(room, 'pk'), this.k(room, 'state'));
  }

  /** Dissolves the group: deletes everything, and leaves a "gone" marker for latecomers. */
  async deleteRoom(room) {
    await this.purgeRoom(room);
    await this.redis.del(this.k(room, 'items'));
    await this.redis.set(this.k(room, 'gone'), 1, 'EX', ROOM_IDLE_TTL);
  }

  /** Bytes used by Redis, cached for one second (quota checks happen on every chunk). */
  async usedMemory() {
    const now = Date.now();
    if (this._mem && now - this._mem.at < 1000) return this._mem.bytes;
    const info = await this.redis.info('memory');
    const bytes = Number(/used_memory:(\d+)/.exec(info)?.[1] ?? 0);
    this._mem = { at: now, bytes };
    return bytes;
  }
}
