// File requests: a link that lets someone outside the group send files to it, from a browser,
// without an account. What they send arrives in the history, like an item of the group.
//
//   https://<relay>/r/#<secret>
//   drop id = sha256(kdf(secret, "drop/id"))                 what the relay sees
//   info    = seal(kdf(secret, "drop/info"), { pk, msg })     the link's public key, its message
//
// Each link has its own key pair (hybrid KEM, like the members' prekeys): the page encrypts the
// key of each item for the public key; the private one is in the group's encrypted state. The
// link lets one send, never read what was sent, not even by someone else with the same link.
import { b64, fromUtf8, unb64, utf8 } from './bytes.ts';
import { CHUNK_SIZE, hash, kdf, kemFromSeed, kemKeygen, open, pad, randomBytes, randomId, seal, unpad, unwrapKey, wrapKey } from './crypto.ts';
import type { DropRecord } from './group.ts';
import { type Header, type Meta, type Opened, type RelayItem, type Sealed, envAad, openHeader, sealContentChunk, sealedSize } from './items.ts';
import { type ByteSource, readSource } from './folder.ts';
import { RelayConnection } from './relay.ts';

/** Lifetimes offered for a link, in seconds (1 h, 24 h, 7 days). */
export const DROP_TTLS = [3600, 86400, 7 * 86400];
export const DROP_DEFAULT_TTL = 86400;
/** The message shown on the page, and the name the person gives. */
export const DROP_MESSAGE_MAX = 200;
export const DROP_NAME_MAX = 60;

export const dropIdOf = (secret: Uint8Array) => b64(hash(kdf(secret, 'drop/id')));
const infoKey = (secret: Uint8Array) => kdf(secret, 'drop/info');

export const dropUrl = (relay: string, secret: Uint8Array) => `${relay.replace(/\/$/, '')}/r/#${b64(secret)}`;

/** The secret of a link (https://relay/r/#…), or null. */
export function dropSecretOf(link: string): Uint8Array | null {
  const m = /#([A-Za-z0-9_-]{43})$/.exec(link.trim());
  return m ? unb64(m[1]) : null;
}

/** A new file request, made by `by`. */
export function newDrop(by: string, ttl: number, msg = ''): { id: string; record: DropRecord } {
  const secret = randomBytes(32);
  const now = Date.now();
  const record: DropRecord = {
    secret: b64(secret),
    sk: b64(kemKeygen().sk),
    ...(msg ? { msg } : {}),
    ttl,
    createdAt: now,
    expiresAt: now + ttl * 1000,
    by,
    at: now,
  };
  return { id: dropIdOf(secret), record };
}

const INFO_PAD = 64;

/** What the page of the link needs (its public key, its message), sealed with the link. */
export function sealDropInfo(d: DropRecord): string {
  const secret = unb64(d.secret);
  const { pk } = kemFromSeed(unb64(d.sk));
  const body = utf8(JSON.stringify({ pk: b64(pk), ...(d.msg ? { msg: d.msg } : {}) }));
  return b64(seal(infoKey(secret), pad(body, INFO_PAD), utf8(dropIdOf(secret))));
}

export function openDropInfo(secret: Uint8Array, info: string): { pk: Uint8Array; msg?: string } {
  const o = JSON.parse(fromUtf8(unpad(open(infoKey(secret), unb64(info), utf8(dropIdOf(secret))))));
  const msg = typeof o.msg === 'string' ? o.msg.slice(0, DROP_MESSAGE_MAX) : undefined;
  return { pk: unb64(o.pk), ...(msg ? { msg } : {}) };
}

const HEADER_PAD = 256;

/** An item sent through the link: like `sealItem`, its key wrapped for the link's key; not signed. */
export function sealDropItem(dropId: string, pk: Uint8Array, header: Header, contentSize: number): Sealed {
  const id = randomId();
  const key = randomBytes(32);
  const chunks = contentSize > 0 ? Math.ceil(contentSize / CHUNK_SIZE) : 0;
  const headerCt = seal(kdf(key, 'header'), pad(utf8(JSON.stringify(header)), HEADER_PAD), utf8(id));
  const w = wrapKey(pk, key, envAad(id, dropId));
  const meta: Meta = { v: 1, id, from: dropId, chunks, header: b64(headerCt), env: { [dropId]: { tag: 'drop', kem: b64(w.kem), box: b64(w.box) } } };
  return { id, key, meta: b64(utf8(JSON.stringify(meta))), sig: '', chunks };
}

/**
 * Opens an item that came through a file request of the group. Anyone with the link may have
 * sent it: only files and folders, and the name they gave, are taken.
 */
export function openDropItem(d: DropRecord, dropId: string, item: RelayItem): Opened {
  const meta: Meta = JSON.parse(fromUtf8(unb64(item.meta)));
  if (meta.id !== item.id || meta.from !== dropId || item.from !== dropId || meta.chunks !== item.chunks) throw new Error('meta mismatch');
  const e = meta.env?.[dropId];
  if (!e) throw new Error('not a recipient');
  const key = unwrapKey(kemFromSeed(unb64(d.sk)), { kem: unb64(e.kem), box: unb64(e.box) }, envAad(item.id, dropId));
  const h = openHeader(key, item.id, meta.header);
  if (!['image', 'file', 'folder'].includes(h.kind) || item.chunks < 1) throw new Error('bad item');
  const header: Header = { ...h, ts: Number(h.ts) || 0 };
  delete header.text;
  delete header.local;
  delete header.rekey;
  if (typeof h.by === 'string' && h.by.trim()) header.by = h.by.trim().slice(0, DROP_NAME_MAX);
  else delete header.by;
  return { meta, header, key };
}

// ---------------------------------------------------------------- the page of the link

export class DropGoneError extends Error {
  constructor() {
    super('drop gone');
  }
}

/** The server has no room left. */
export class DropFullError extends Error {
  constructor() {
    super('full');
  }
}

const UPLOAD_WORKERS = 4;
const SEND_QUEUE_MAX = 256 * 1024;

const gone = (err: any) => {
  if (err?.message === 'unknown drop') return new DropGoneError();
  if (err?.message === 'full') return new DropFullError();
  return err;
};

const retryable = (err: any) => err?.message === 'disconnected' || err?.message === 'timeout' || err?.message === 'connection failed';

/** A file request, as the person who sends files sees it. */
export interface DropLink {
  /** The group's message, if any. */
  msg?: string;
  expiresAt: number;
  /**
   * Sends a content: one item of the history. `onProgress`: chunks uploaded, out of how many.
   * Resolves once the group has it all.
   */
  send(src: Blob | ByteSource, header: Header, onProgress?: (done: number, total: number) => void): Promise<string>;
  close(): void;
}

/** Opens a file request, as someone outside the group: `relay` is the server that serves it. */
export async function openDrop(relay: string, secret: Uint8Array): Promise<DropLink> {
  const drop = dropIdOf(secret);
  const conn = new RelayConnection(relay, async () => {}, () => {});
  const request = async (op: string, payload: Record<string, unknown>, data?: Uint8Array) => {
    // a lost connection (a phone asleep, a network change) is waited for, then the request goes again
    for (let wait = 500; ; wait = Math.min(wait * 2, 10_000)) {
      try {
        return await conn.request(op, { drop, ...payload }, data);
      } catch (err: any) {
        if (!retryable(err)) throw gone(err);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  };
  try {
    await conn.start();
    const res = await conn.request('drop.open', { drop }).catch((err) => {
      throw gone(err);
    });
    const { pk, msg } = openDropInfo(secret, res.info);
    const link: DropLink = {
      msg,
      expiresAt: res.expiresAt,
      async send(src, header, onProgress) {
        const size = src.size;
        const sealed = sealDropItem(drop, pk, header, Math.max(size, 1));
        const { chunks, id, key } = sealed;
        const created = await request('drop.item', { id, meta: sealed.meta, chunks, size: sealedSize(size, chunks) });
        link.expiresAt = created.dropExpiresAt ?? link.expiresAt;
        let done = 0;
        onProgress?.(0, chunks);
        for (let attempt = 0; ; attempt++) {
          let todo = [...Array(chunks).keys()];
          if (attempt > 0) {
            const { have } = await request('drop.have', { id });
            todo = todo.filter((i) => !have.includes(i));
            done = chunks - todo.length;
            onProgress?.(done, chunks);
          }
          try {
            const worker = async () => {
              for (let idx = todo.shift(); idx !== undefined; idx = todo.shift()) {
                const slice = await readSource(src, idx * CHUNK_SIZE, (idx + 1) * CHUNK_SIZE);
                const data = sealContentChunk(key, id, idx, chunks, slice);
                while (conn.buffered > SEND_QUEUE_MAX) await new Promise((r) => setTimeout(r, 20));
                await conn.request('chunk.put', { drop, itemId: id, idx }, data);
                onProgress?.(++done, chunks);
              }
            };
            await Promise.all(Array.from({ length: UPLOAD_WORKERS }, worker));
            break;
          } catch (err: any) {
            if (!retryable(err)) throw gone(err);
            await new Promise((r) => setTimeout(r, 1000));
          }
        }
        await request('drop.commit', { id });
        return id;
      },
      close: () => conn.stop(),
    };
    return link;
  } catch (err) {
    conn.stop();
    throw err;
  }
}

