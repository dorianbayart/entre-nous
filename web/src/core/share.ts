// Share links: read access to one item of the history for someone outside the group, in a
// browser, without an account. The link carries a secret after its "#" (never sent to the
// server); the relay only knows a hash of it, and keeps the item's key sealed with it.
//
//   https://<relay>/s/#<secret>
//   share id = sha256(kdf(secret, "share/id"))     what the relay sees
//   box      = seal(kdf(secret, "share/key"), item key, aad = share id)
//
// A second secret, kept by the device that made the link, changes or deletes it.
import { b64, unb64, utf8 } from './bytes.ts';
import { hash, kdf, open, randomBytes, seal } from './crypto.ts';
import { type Header, openContentChunk, openHeader } from './items.ts';
import { ChunkReader, type ContentReader, type ReaderOptions } from './reader.ts';
import { RelayConnection } from './relay.ts';

/** Lifetimes offered for a link, in seconds (10 min, 1 h, 24 h, 7 days). */
export const SHARE_TTLS = [600, 3600, 86400, 7 * 86400];
export const SHARE_DEFAULT_TTL = 3600;

export const shareIdOf = (secret: Uint8Array) => b64(hash(kdf(secret, 'share/id')));
const boxKey = (secret: Uint8Array) => kdf(secret, 'share/key');

/** A new link to the item whose key is `itemKey`. */
export function newShare(itemKey: Uint8Array) {
  const secret = randomBytes(32);
  const id = shareIdOf(secret);
  return { secret, id, del: randomBytes(32), box: b64(seal(boxKey(secret), itemKey, utf8(id))) };
}

export const shareUrl = (relay: string, secret: Uint8Array) => `${relay.replace(/\/$/, '')}/s/#${b64(secret)}`;

/** The secret of a link (https://relay/s/#…), or null. */
export function shareSecretOf(link: string): Uint8Array | null {
  const m = /#([A-Za-z0-9_-]{43})$/.exec(link.trim());
  return m ? unb64(m[1]) : null;
}

export class ShareGoneError extends Error {
  constructor() {
    super('share gone');
  }
}

export interface SharedItem {
  header: Header;
  size: number;
  expiresAt: number;
  /** Random access to the content (video, audio, text); to be closed. */
  reader(opts?: ReaderOptions): ContentReader;
  /** The whole content; `onProgress`: chunks received so far, out of how many. */
  blob(onProgress?: (done: number, total: number) => void): Promise<Blob>;
  close(): void;
}

const WORKERS = 3;

/** Opens a share link, as someone outside the group: `relay` is the server that serves it. */
export async function openShare(relay: string, secret: Uint8Array): Promise<SharedItem> {
  const id = shareIdOf(secret);
  const conn = new RelayConnection(relay, async () => {}, () => {});
  try {
    await conn.start();
    const res = await conn.request('share.open', { share: id }).catch((err) => {
      throw err.message === 'unknown share' ? new ShareGoneError() : err;
    });
    const key = open(boxKey(secret), unb64(res.box), utf8(id));
    const header = openHeader(key, res.item, res.header);
    const chunks: number = res.chunks;
    const size = header.size ?? 0;
    const fetch = async (idx: number) => {
      const r = await conn.request('share.chunk', { share: id, idx }).catch((err) => {
        throw err.message === 'unknown share' || err.message === 'unknown chunk' ? new ShareGoneError() : err;
      });
      return openContentChunk(key, res.item, idx, chunks, r.data);
    };
    const reader = (opts: ReaderOptions = {}) =>
      new ChunkReader(size, chunks, fetch, { keep: opts.keep ?? 16, ahead: opts.ahead ?? 4, workers: WORKERS }, () => {}, header.name, header.mime);
    return {
      header,
      size,
      expiresAt: res.expiresAt,
      reader,
      async blob(onProgress) {
        const mime = header.mime || 'application/octet-stream';
        if (header.kind === 'text' && header.text !== undefined && chunks === 0) return new Blob([header.text], { type: 'text/plain' });
        const r = reader({ keep: chunks, ahead: 0 });
        try {
          let done = 0;
          const parts = await Promise.all(
            [...Array(chunks).keys()].map((i) =>
              (r as ChunkReader).chunk(i).then((data) => {
                onProgress?.(++done, chunks);
                return data;
              }),
            ),
          );
          // a 0-byte file is sent as one chunk holding one byte
          return new Blob(parts as BlobPart[], { type: mime }).slice(0, size, mime);
        } finally {
          r.close();
        }
      },
      close: () => conn.stop(),
    };
  } catch (err) {
    conn.stop();
    throw err;
  }
}
