// Entre Nous relay: serves the PWA and relays end-to-end encrypted blobs between the
// devices of a group. It can read nothing, and forgets everything (RAM only by default).
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { startRedis } from './redis-process.js';
import { Store } from './store.js';

const env = process.env;
const PORT = Number(env.PORT || 8080);
const PERSIST = env.PERSIST === 'true';
const MAX_STORAGE = parseSize(env.MAX_STORAGE || '0'); // 0 = unlimited (bounded by memory)
const MAX_TTL = parseDuration(env.MAX_TTL || '7d');
const PUBLIC_DIR = env.PUBLIC_DIR || fileURLToPath(new URL('../public', import.meta.url));

const CHUNK_MAX = 1024 * 1024 + 128 * 1024; // 1 MiB of plaintext + padding and tag
const META_MAX = 512 * 1024;
const PAIR_TTL = 5 * 60 * 1000;
const MAX_CONN_PER_IP = 32;

function parseSize(s) {
  const m = /^(\d+(?:\.\d+)?)\s*([kmgt]?)b?$/i.exec(String(s).trim());
  if (!m) throw new Error(`bad size: ${s}`);
  return Math.floor(Number(m[1]) * 1024 ** ' kmgt'.indexOf((m[2] || ' ').toLowerCase()));
}

function parseDuration(s) {
  const m = /^(\d+)\s*([smhd]?)$/.exec(String(s).trim());
  if (!m) throw new Error(`bad duration: ${s}`);
  return Number(m[1]) * { '': 1, s: 1, m: 60, h: 3600, d: 86400 }[m[2]];
}

const log = (...args) => console.log(new Date().toISOString(), ...args);

// ---------------------------------------------------------------- static files

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.zip': 'application/zip',
  '.apk': 'application/vnd.android.package-archive',
  '.deb': 'application/vnd.debian.binary-package',
  '.AppImage': 'application/vnd.appimage',
  '.exe': 'application/vnd.microsoft.portable-executable',
};

function securityHeaders(req) {
  const host = req.headers.host || '';
  return {
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' blob: data:",
      "media-src 'self' blob:",
      `connect-src 'self' wss://${host} ws://${host}`,
      "worker-src 'self'",
      "manifest-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'",
    ].join('; '),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(self), clipboard-read=(self), clipboard-write=(self), geolocation=(), microphone=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Strict-Transport-Security': 'max-age=31536000',
  };
}

async function serveStatic(req, res) {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
    return;
  }
  // The share target (Android) is handled by the service worker; if it is not there yet,
  // send the user back to the app instead of failing.
  if (req.method === 'POST' && url.pathname === '/app/share') {
    res.writeHead(303, { Location: '/app/' }).end();
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end();
    return;
  }
  if (url.pathname === '/app') {
    res.writeHead(301, { Location: '/app/' }).end();
    return;
  }
  let path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
  if (path.endsWith('/')) path += 'index.html';
  let file = join(PUBLIC_DIR, path);
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end();
    return;
  }
  try {
    if (!(await stat(file)).isFile()) throw new Error('not a file');
  } catch {
    // The app (/app/) is a single page; anything else unknown is a 404.
    if (!path.startsWith('/app/')) {
      res.writeHead(404, { ...securityHeaders(req), 'Content-Type': 'text/plain; charset=utf-8' }).end('Introuvable');
      return;
    }
    file = join(PUBLIC_DIR, 'app', 'index.html');
  }
  try {
    const body = await readFile(file);
    const etag = '"' + createHash('sha256').update(body).digest('base64url').slice(0, 22) + '"';
    const headers = {
      ...securityHeaders(req),
      'Content-Type': MIME[extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'Content-Length': body.length,
      ETag: etag,
    };
    if (path.startsWith('/download/')) headers['Content-Disposition'] = 'attachment';
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers).end();
      return;
    }
    res.writeHead(200, headers).end(req.method === 'HEAD' ? undefined : body);
  } catch {
    res.writeHead(404).end();
  }
}

// ---------------------------------------------------------------- websocket protocol

const { client: redis, child: redisChild, maxmemory } = await startRedis({ persist: PERSIST });
const store = new Store(redis);

/** room id -> Set of sockets */
const rooms = new Map();
/** pairing channel -> { sockets: Set, expires } */
const pairings = new Map();
/** ip -> open connections */
const perIp = new Map();

const roomId = (roomKey) => createHash('sha256').update(Buffer.from(roomKey, 'base64url')).digest('hex');

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function sendBinary(ws, header, data) {
  const h = Buffer.from(JSON.stringify(header));
  const len = Buffer.alloc(4);
  len.writeUInt32BE(h.length);
  if (ws.readyState === ws.OPEN) ws.send(Buffer.concat([len, h, data]));
}

function broadcast(room, obj, except) {
  for (const ws of rooms.get(room) ?? []) if (ws !== except) send(ws, obj);
}

/** Devices currently connected to a room (pseudonymous ids). */
function online(room) {
  return [...new Set([...(rooms.get(room) ?? [])].map((ws) => ws.device).filter(Boolean))];
}

function leaveRoom(ws) {
  if (!ws.room) return;
  if (ws.bulk) {
    ws.room = null;
    return;
  }
  const room = ws.room;
  const set = rooms.get(room);
  set?.delete(ws);
  if (set && set.size === 0) rooms.delete(room);
  ws.room = null;
  broadcast(room, { ev: 'presence', online: online(room) });
}

/** Room left for contents on the relay (shared by every group). */
async function storage() {
  const used = await store.usedMemory();
  let limit = maxmemory * 0.95;
  if (MAX_STORAGE > 0) limit = Math.min(limit, MAX_STORAGE);
  return { used, limit: Math.round(limit) };
}

async function checkQuota(extra) {
  const used = await store.usedMemory();
  if (used + extra > maxmemory * 0.95) throw new Error('full');
  if (MAX_STORAGE > 0 && used + extra > MAX_STORAGE) throw new Error('full');
}

const b64 = (s, max) => typeof s === 'string' && s.length <= max && /^[A-Za-z0-9_-]*={0,2}$/.test(s);
const safeId = (s) => typeof s === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(s);

function requireRoom(ws) {
  if (!ws.room) throw new Error('no room');
  return ws.room;
}

const handlers = {
  async hello(ws, msg) {
    if (!b64(msg.roomKey, 64)) throw new Error('bad room key');
    leaveRoom(ws);
    const room = roomId(msg.roomKey);
    ws.room = room;
    ws.device = safeId(msg.device) ? msg.device : null;
    // second connection of a device, for chunks only: no events, no presence
    if (msg.bulk === true) {
      ws.bulk = true;
      return {};
    }
    if (!rooms.has(room)) rooms.set(room, new Set());
    rooms.get(room).add(ws);
    broadcast(room, { ev: 'presence', online: online(room) }, ws);
    const [{ state, gone }, items, prekeys] = await Promise.all([
      store.getState(room),
      store.listItems(room),
      store.listPrekeys(room),
    ]);
    await store.touchRoom(room);
    return {
      state,
      gone,
      items,
      prekeys,
      online: online(room),
      now: Date.now(),
      maxTtl: MAX_TTL,
      persist: PERSIST,
      storage: await storage(),
    };
  },

  /**
   * Direct connection between two devices of the room (same network): their setup messages,
   * encrypted with the group key, are only passed on. Never stored.
   */
  async signal(ws, msg) {
    const room = requireRoom(ws);
    if (!safeId(msg.to) || !b64(msg.data, 64 * 1024)) throw new Error('bad signal');
    let sent = 0;
    for (const peer of rooms.get(room) ?? []) {
      if (peer !== ws && peer.device === msg.to) {
        send(peer, { ev: 'signal', from: ws.device, data: msg.data });
        sent++;
      }
    }
    if (!sent) throw new Error('offline');
    return {};
  },

  /** Heartbeat: lets a client notice a dead connection (e.g. after the computer slept). */
  async ping() {
    return {};
  },

  async storage() {
    return { storage: await storage() };
  },

  async 'items.list'(ws) {
    return { items: await store.listItems(requireRoom(ws)) };
  },

  async 'state.put'(ws, msg) {
    const room = requireRoom(ws);
    if (!Number.isInteger(msg.v) || !b64(msg.blob, META_MAX)) throw new Error('bad state');
    const conflict = await store.putState(room, msg.v, msg.blob);
    if (conflict) return { conflict };
    broadcast(room, { ev: 'state', state: { v: msg.v, blob: msg.blob } }, ws);
    return {};
  },

  async 'prekey.put'(ws, msg) {
    const room = requireRoom(ws);
    if (!safeId(msg.device) || typeof msg.bundle !== 'string' || msg.bundle.length > 8192) throw new Error('bad prekey');
    await store.putPrekey(room, msg.device, msg.bundle);
    broadcast(room, { ev: 'prekey', device: msg.device, bundle: msg.bundle }, ws);
    return {};
  },

  async 'item.create'(ws, msg) {
    const room = requireRoom(ws);
    const { id, meta, sig, from, chunks, size } = msg;
    if (!safeId(id) || !safeId(from) || !b64(meta, META_MAX) || !b64(sig, 256)) throw new Error('bad item');
    if (!Number.isInteger(chunks) || chunks < 0 || chunks > 10_000_000) throw new Error('bad chunks');
    if (!Number.isInteger(size) || size < 0) throw new Error('bad size');
    const ttl = Math.min(Math.max(Number(msg.ttl) || 0, 60), MAX_TTL);
    await checkQuota(meta.length + size);
    const note = msg.note === true;
    const local = msg.local === true;
    const { createdAt, expiresAt } = await store.createItem(room, { id, meta, sig, from, chunks, size: local ? 0 : size, ttl, note, local });
    // shown at once; a file is announced again, complete, once all its chunks are there
    const complete = chunks === 0 || local;
    const progress = complete ? {} : { have: 0, progressAt: createdAt };
    const extra = local ? { local: true } : {};
    broadcast(room, {
      ev: 'item',
      item: { id, meta, sig, from, chunks, size: local ? 0 : size, createdAt, expiresAt, complete, ...progress, ...extra },
    });
    // history size of the group: the oldest items go
    const max = Number(msg.max) || 0;
    if (!note && max > 0) {
      for (const old of await store.trimItems(room, max)) broadcast(room, { ev: 'deleted', id: old });
    }
    return { createdAt, expiresAt };
  },

  /** A local item is uploaded after all: announced again, as being uploaded. */
  async 'item.publish'(ws, msg) {
    const room = requireRoom(ws);
    if (!safeId(msg.id) || !Number.isInteger(msg.size) || msg.size < 0) throw new Error('bad item');
    await checkQuota(msg.size);
    const item = await store.publishItem(room, msg.id, msg.size);
    broadcast(room, { ev: 'item', item });
    return { expiresAt: item.expiresAt };
  },

  // Live note: the whole (encrypted, padded) text at each change, relayed at once.
  async 'note.put'(ws, msg) {
    const room = requireRoom(ws);
    if (!safeId(msg.id) || !b64(msg.data, META_MAX)) throw new Error('bad note');
    await checkQuota(msg.data.length);
    const { updatedAt, expiresAt } = await store.putLive(room, msg.id, msg.data);
    broadcast(room, { ev: 'note', id: msg.id, data: msg.data, updatedAt, expiresAt }, ws);
    return { updatedAt, expiresAt };
  },

  async 'chunk.have'(ws, msg) {
    const room = requireRoom(ws);
    const item = await store.getItem(room, msg.id);
    if (!item) throw new Error('unknown item');
    return { have: await store.haveChunks(room, msg.id, item.chunks) };
  },

  async 'item.commit'(ws, msg) {
    const room = requireRoom(ws);
    const item = await store.commitItem(room, msg.id);
    broadcast(room, { ev: 'item', item });
    return {};
  },

  async 'chunk.get'(ws, msg) {
    const room = requireRoom(ws);
    if (!safeId(msg.id) || !Number.isInteger(msg.idx)) throw new Error('bad chunk');
    const data = await store.getChunk(room, msg.id, msg.idx);
    if (!data) throw new Error('unknown chunk');
    return { $binary: data };
  },

  async 'item.delete'(ws, msg) {
    const room = requireRoom(ws);
    if (!safeId(msg.id)) throw new Error('bad id');
    await store.deleteItem(room, msg.id);
    broadcast(room, { ev: 'deleted', id: msg.id });
    return {};
  },

  async 'items.trim'(ws, msg) {
    const room = requireRoom(ws);
    const max = Number(msg.max);
    if (!(Number.isInteger(max) && max > 0)) throw new Error('bad max');
    for (const old of await store.trimItems(room, max)) broadcast(room, { ev: 'deleted', id: old });
    return {};
  },

  async 'items.clear'(ws) {
    const room = requireRoom(ws);
    await store.clearItems(room);
    broadcast(room, { ev: 'refresh' }, ws);
    return {};
  },

  async 'items.shorten'(ws, msg) {
    const room = requireRoom(ws);
    const ttl = Number(msg.ttl);
    if (!(ttl >= 60)) throw new Error('bad ttl');
    if (await store.shortenItems(room, ttl)) broadcast(room, { ev: 'refresh' });
    return {};
  },

  async 'room.purge'(ws, msg) {
    const room = requireRoom(ws);
    const keep = Array.isArray(msg.keep) ? msg.keep.filter(safeId) : [];
    await store.purgeRoom(room, keep);
    broadcast(room, { ev: 'refresh' }, ws);
    return {};
  },

  /** Key rotation: the history goes to the group's new room (identified by its new key). */
  async 'items.move'(ws, msg) {
    const room = requireRoom(ws);
    if (!b64(msg.roomKey, 64)) throw new Error('bad room key');
    const except = Array.isArray(msg.except) ? msg.except.filter(safeId) : [];
    const to = roomId(msg.roomKey);
    if (to === room) throw new Error('same room');
    return { moved: await store.moveItems(room, to, except) };
  },

  async 'room.delete'(ws) {
    const room = requireRoom(ws);
    await store.deleteRoom(room);
    broadcast(room, { ev: 'gone' }, ws);
    return {};
  },

  // Pairing: a short-lived channel between two devices, authenticated end to end by the
  // secret in the QR code. The relay only forwards opaque messages.
  async 'pair.join'(ws, msg) {
    if (!b64(msg.channel, 64)) throw new Error('bad channel');
    let p = pairings.get(msg.channel);
    if (!p) {
      p = { sockets: new Set(), expires: Date.now() + PAIR_TTL };
      pairings.set(msg.channel, p);
    }
    if (p.sockets.size >= 2) throw new Error('channel busy');
    p.sockets.add(ws);
    ws.pairings.add(msg.channel);
    for (const other of p.sockets) if (other !== ws) send(other, { ev: 'pair.peer', channel: msg.channel });
    return { peers: p.sockets.size - 1 };
  },

  async 'pair.send'(ws, msg) {
    const p = pairings.get(msg.channel);
    if (!p || !p.sockets.has(ws)) throw new Error('not in channel');
    if (typeof msg.data !== 'string' || msg.data.length > META_MAX) throw new Error('bad data');
    for (const other of p.sockets) if (other !== ws) send(other, { ev: 'pair', channel: msg.channel, data: msg.data });
    return {};
  },

  async 'pair.leave'(ws, msg) {
    pairings.get(msg.channel)?.sockets.delete(ws);
    ws.pairings.delete(msg.channel);
    return {};
  },
};

async function handle(ws, msg, binary) {
  const reply = { rid: msg.rid };
  try {
    if (!ws.rate()) throw new Error('rate limited');
    let result;
    if (msg.op === 'chunk.put') {
      const room = requireRoom(ws);
      if (!binary || binary.length > CHUNK_MAX || !safeId(msg.itemId) || !Number.isInteger(msg.idx)) {
        throw new Error('bad chunk');
      }
      await checkQuota(binary.length);
      const have = await store.putChunk(room, msg.itemId, msg.idx, binary);
      broadcast(room, { ev: 'progress', id: msg.itemId, have, at: Date.now() });
      result = {};
    } else {
      const fn = handlers[msg.op];
      if (!fn) throw new Error('unknown op');
      result = await fn(ws, msg);
    }
    if (result?.$binary) {
      sendBinary(ws, { rid: msg.rid, ok: true }, result.$binary);
      return;
    }
    send(ws, { ...reply, ok: true, ...result });
  } catch (err) {
    const message = /OOM|maxmemory/i.test(err.message) ? 'full' : err.message;
    send(ws, { ...reply, ok: false, error: message });
  }
}

function rateLimiter(perSecond, burst) {
  let tokens = burst;
  let last = Date.now();
  return () => {
    const now = Date.now();
    tokens = Math.min(burst, tokens + ((now - last) / 1000) * perSecond);
    last = now;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  };
}

const server = createServer((req, res) => {
  serveStatic(req, res).catch(() => res.writeHead(500).end());
});

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: CHUNK_MAX + 4096 });

wss.on('connection', (ws, req) => {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const count = (perIp.get(ip) || 0) + 1;
  if (count > MAX_CONN_PER_IP) {
    ws.close(1013, 'too many connections');
    return;
  }
  perIp.set(ip, count);
  ws.room = null;
  ws.pairings = new Set();
  ws.rate = rateLimiter(200, 400);
  ws.alive = true;
  ws.on('pong', () => (ws.alive = true));

  ws.on('message', (data, isBinary) => {
    try {
      if (isBinary) {
        const len = data.readUInt32BE(0);
        const header = JSON.parse(data.subarray(4, 4 + len).toString());
        handle(ws, header, data.subarray(4 + len));
      } else {
        handle(ws, JSON.parse(data.toString()));
      }
    } catch {
      ws.close(1003, 'bad message');
    }
  });

  ws.on('close', () => {
    leaveRoom(ws);
    for (const channel of ws.pairings) pairings.get(channel)?.sockets.delete(ws);
    const n = (perIp.get(ip) || 1) - 1;
    if (n <= 0) perIp.delete(ip);
    else perIp.set(ip, n);
  });
});

// Heartbeat, and expiry of pairing channels.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) {
      ws.terminate();
      continue;
    }
    ws.alive = false;
    ws.ping();
  }
  const now = Date.now();
  for (const [channel, p] of pairings) if (p.expires < now || p.sockets.size === 0) pairings.delete(channel);
}, 30_000).unref();

server.listen(PORT, () => {
  log(
    `entrenous relay on :${PORT}`,
    `persist=${PERSIST}`,
    `redis maxmemory=${(maxmemory / 2 ** 20).toFixed(0)}MiB`,
    `max_storage=${MAX_STORAGE ? (MAX_STORAGE / 2 ** 20).toFixed(0) + 'MiB' : 'unlimited'}`,
    `max_ttl=${MAX_TTL}s`,
  );
});

let stopping = false;
redisChild.on('exit', (code) => {
  if (stopping) return;
  log(`redis exited (${code}), stopping`);
  process.exit(1);
});

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log(`${signal}: stopping`);
  server.close();
  for (const ws of wss.clients) ws.close(1001, 'restarting');
  try {
    // With PERSIST, SHUTDOWN SAVE writes a final snapshot: nothing is lost on a planned restart.
    await redis.call('SHUTDOWN', PERSIST ? 'SAVE' : 'NOSAVE');
  } catch { /* the connection drops when redis exits */ }
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
