// History items: content encrypted once with a random item key, and that key wrapped
// (hybrid post-quantum KEM) for each member's current prekey. Signed by the sender.
import { b64, fromUtf8, unb64, utf8 } from './bytes.ts';
import {
  CHUNK_SIZE,
  kdf,
  open,
  openChunk,
  pad,
  randomBytes,
  randomId,
  seal,
  sealChunk,
  sign,
  unpad,
  unwrapKey,
  verify,
  wrapKey,
} from './crypto.ts';
import { type Device, type LocalGroup, type PrekeyBundle, prekeyTag } from './group.ts';

export type ItemKind = 'text' | 'image' | 'file' | 'rekey' | 'note';

/** Encrypted part, visible only to members. */
export interface Header {
  kind: ItemKind;
  ts: number;
  text?: string; // short texts travel in the header
  name?: string;
  mime?: string;
  size?: number;
  thumb?: string; // small JPEG data URL for images
  local?: boolean; // content only served directly by the sender (never uploaded to the relay)
  rekey?: { secret: string; state: string }; // key rotation after a removal
}

/** Clear part, as stored on the relay (signed). */
export interface Meta {
  v: 1;
  id: string;
  from: string;
  chunks: number;
  header: string;
  env: Record<string, { tag: string; kem: string; box: string }>;
  removed?: string; // set on a rotation item: the device that was removed
}

export interface RelayItem {
  id: string;
  meta: string;
  sig: string;
  from: string;
  chunks: number;
  size: number;
  createdAt: number;
  expiresAt: number;
  complete: boolean;
  local?: boolean; // content never uploaded: fetched directly from the sender
  have?: number; // being uploaded: chunks received so far
  progressAt?: number; // being uploaded: last chunk received
  live?: string; // live note: latest encrypted text
  updatedAt?: number;
}

export const INLINE_TEXT_MAX = 64 * 1024;
const HEADER_PAD = 256;

const envAad = (itemId: string, device: string) => utf8(`${itemId}|${device}`);

export interface Sealed {
  id: string;
  key: Uint8Array;
  meta: string;
  sig: string;
  chunks: number;
}

/** Builds an item for `recipients` (their verified prekey bundles). */
export function sealItem(
  device: Device,
  recipients: PrekeyBundle[],
  header: Header,
  contentSize: number,
  removed?: string,
): Sealed {
  const id = randomId();
  const key = randomBytes(32);
  const chunks = contentSize > 0 ? Math.ceil(contentSize / CHUNK_SIZE) : 0;
  const headerCt = seal(kdf(key, 'header'), pad(utf8(JSON.stringify(header)), HEADER_PAD), utf8(id));
  const env: Meta['env'] = {};
  for (const r of recipients) {
    const w = wrapKey(r.pk, key, envAad(id, r.device));
    env[r.device] = { tag: prekeyTag(r.pk), kem: b64(w.kem), box: b64(w.box) };
  }
  const meta: Meta = { v: 1, id, from: device.id, chunks, header: b64(headerCt), env };
  if (removed) meta.removed = removed;
  const metaStr = b64(utf8(JSON.stringify(meta)));
  const sig = b64(sign(device.sign.sk, 'item', utf8(metaStr)));
  return { id, key, meta: metaStr, sig, chunks };
}

/** Checks the signature and the clear fields. Does not need any key. */
export function verifyItem(g: LocalGroup, item: RelayItem): Meta {
  const meta: Meta = JSON.parse(fromUtf8(unb64(item.meta)));
  const sender = g.state.members[meta.from];
  if (!sender) throw new Error('unknown sender');
  if (meta.id !== item.id || meta.from !== item.from || meta.chunks !== item.chunks) throw new Error('meta mismatch');
  if (!verify(sender.signPk, 'item', utf8(item.meta), unb64(item.sig))) throw new Error('bad item signature');
  return meta;
}

export interface Opened {
  meta: Meta;
  header: Header;
  key: Uint8Array;
}

export function openItem(g: LocalGroup, device: Device, item: RelayItem): Opened {
  const meta = verifyItem(g, item);
  const e = meta.env[device.id];
  if (!e) throw new Error('not a recipient');
  const prekey = g.prekeys.find((p) => prekeyTag(p.pk) === e.tag);
  if (!prekey) throw new Error('prekey no longer available');
  const key = unwrapKey(prekey, { kem: unb64(e.kem), box: unb64(e.box) }, envAad(item.id, device.id));
  const header: Header = JSON.parse(fromUtf8(unpad(open(kdf(key, 'header'), unb64(meta.header), utf8(item.id)))));
  return { meta, header, key };
}

export const sealContentChunk = (key: Uint8Array, id: string, idx: number, chunks: number, data: Uint8Array) =>
  sealChunk(key, id, idx, idx === chunks - 1, data);

export const openContentChunk = (key: Uint8Array, id: string, idx: number, chunks: number, data: Uint8Array) =>
  openChunk(key, id, idx, idx === chunks - 1, data);

/** Size announced to the relay: the ciphertext size (the last chunk is padded). */
export function sealedSize(contentSize: number, chunks: number): number {
  if (chunks === 0) return 0;
  const last = contentSize - (chunks - 1) * CHUNK_SIZE;
  return (chunks - 1) * (CHUNK_SIZE + 16) + Math.ceil((last + 1) / 65536) * 65536 + 16;
}

// Live note: an item without content whose key encrypts the whole text at each change.
// The relay keeps only the latest version. Padded to hide the exact length.
const NOTE_PAD = 256;

export interface NoteText {
  text: string;
  by: string;
  at: number;
}

export function sealNote(key: Uint8Array, id: string, note: NoteText): string {
  return b64(seal(kdf(key, 'note'), pad(utf8(JSON.stringify(note)), NOTE_PAD), utf8(id)));
}

export function openNote(key: Uint8Array, id: string, data: string): NoteText {
  return JSON.parse(fromUtf8(unpad(open(kdf(key, 'note'), unb64(data), utf8(id)))));
}
