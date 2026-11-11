// Cryptographic primitives of Entre Nous. Audited pure-JS libraries (noble), so the same
// code runs in the PWA, in the Mac app's WKWebView and in Node tests.
//
//   KEM          X25519 + ML-KEM-768 hybrid (X-Wing combiner)  post-quantum
//   signatures   Ed25519
//   AEAD         XChaCha20-Poly1305
//   KDF          HKDF-SHA-256, every derivation labelled "entrenous/v1/<purpose>"
import { ml_kem768_x25519 as KEM } from '@noble/post-quantum/hybrid.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes as nobleRandom } from '@noble/hashes/utils.js';
import { b64, concat, u32, utf8 } from './bytes.ts';

export const randomBytes = (n: number): Uint8Array => nobleRandom(n);
export const hash = (data: Uint8Array): Uint8Array => sha256(data);
export const randomId = (): string => b64(randomBytes(16));

export function kdf(ikm: Uint8Array, purpose: string, length = 32): Uint8Array {
  return hkdf(sha256, ikm, undefined, utf8('entrenous/v1/' + purpose), length);
}

// ---------------------------------------------------------------- AEAD

/** nonce (24 random bytes) || ciphertext || tag */
export function seal(key: Uint8Array, plaintext: Uint8Array, aad?: Uint8Array): Uint8Array {
  const nonce = randomBytes(24);
  return concat(nonce, xchacha20poly1305(key, nonce, aad).encrypt(plaintext));
}

export function open(key: Uint8Array, sealed: Uint8Array, aad?: Uint8Array): Uint8Array {
  if (sealed.length < 24 + 16) throw new Error('ciphertext too short');
  return xchacha20poly1305(key, sealed.subarray(0, 24), aad).decrypt(sealed.subarray(24));
}

// ---------------------------------------------------------------- padding

/** ISO/IEC 7816-4 padding up to a multiple of `block`: hides the exact length. */
export function pad(data: Uint8Array, block: number): Uint8Array {
  const len = Math.ceil((data.length + 1) / block) * block;
  const out = new Uint8Array(len);
  out.set(data);
  out[data.length] = 0x80;
  return out;
}

export function unpad(data: Uint8Array): Uint8Array {
  let i = data.length - 1;
  while (i >= 0 && data[i] === 0) i--;
  if (i < 0 || data[i] !== 0x80) throw new Error('bad padding');
  return data.subarray(0, i);
}

// ---------------------------------------------------------------- signatures

export interface SignKeys {
  sk: Uint8Array;
  pk: Uint8Array;
}

export function signKeygen(): SignKeys {
  const sk = ed25519.utils.randomSecretKey();
  return { sk, pk: ed25519.getPublicKey(sk) };
}

const signed = (context: string, msg: Uint8Array) => concat(utf8('entrenous/v1/' + context), new Uint8Array([0]), msg);

export function sign(sk: Uint8Array, context: string, msg: Uint8Array): Uint8Array {
  return ed25519.sign(signed(context, msg), sk);
}

export function verify(pk: Uint8Array, context: string, msg: Uint8Array, sig: Uint8Array): boolean {
  try {
    return ed25519.verify(sig, signed(context, msg), pk);
  } catch {
    return false;
  }
}

/** Device id: a short fingerprint of its signing key. */
export const deviceIdOf = (signPk: Uint8Array): string => b64(hash(signPk).subarray(0, 16));

// ---------------------------------------------------------------- hybrid KEM (key wrapping)

export interface KemKeys {
  sk: Uint8Array; // 32-byte seed
  pk: Uint8Array; // 1216 bytes
}

export function kemKeygen(): KemKeys {
  const { secretKey, publicKey } = KEM.keygen();
  return { sk: secretKey, pk: publicKey };
}

export interface Wrapped {
  kem: Uint8Array; // KEM ciphertext, 1120 bytes
  box: Uint8Array; // the wrapped key
}

/** Encrypts `key` for the holder of the KEM secret key behind `pk` (HPKE-like, base mode). */
export function wrapKey(pk: Uint8Array, key: Uint8Array, aad: Uint8Array): Wrapped {
  const { cipherText, sharedSecret } = KEM.encapsulate(pk);
  const k = kdf(concat(sharedSecret, hash(concat(pk, cipherText))), 'wrap');
  return { kem: cipherText, box: seal(k, key, aad) };
}

export function unwrapKey(keys: KemKeys, w: Wrapped, aad: Uint8Array): Uint8Array {
  const sharedSecret = KEM.decapsulate(w.kem, keys.sk);
  const k = kdf(concat(sharedSecret, hash(concat(keys.pk, w.kem))), 'wrap');
  return open(k, w.box, aad);
}

// ---------------------------------------------------------------- content streams

export const CHUNK_SIZE = 1024 * 1024;
const CHUNK_PAD = 64 * 1024;

function chunkNonce(idx: number, last: boolean): Uint8Array {
  const n = new Uint8Array(24);
  n.set(u32(idx), 0);
  n[4] = last ? 1 : 0;
  return n;
}

const chunkAad = (itemId: string, idx: number, last: boolean) => concat(utf8(itemId), u32(idx), new Uint8Array([last ? 1 : 0]));

/**
 * Encrypts one chunk of an item. The chunk key is unique per item, so a nonce made of
 * (index, last) is safe and lets the reader detect reordering and truncation, like
 * libsodium's secretstream. The last chunk is padded to hide the exact size.
 */
export function sealChunk(itemKey: Uint8Array, itemId: string, idx: number, last: boolean, data: Uint8Array): Uint8Array {
  const body = last ? pad(data, CHUNK_PAD) : data;
  return xchacha20poly1305(kdf(itemKey, 'chunk'), chunkNonce(idx, last), chunkAad(itemId, idx, last)).encrypt(body);
}

export function openChunk(itemKey: Uint8Array, itemId: string, idx: number, last: boolean, sealed: Uint8Array): Uint8Array {
  const body = xchacha20poly1305(kdf(itemKey, 'chunk'), chunkNonce(idx, last), chunkAad(itemId, idx, last)).decrypt(sealed);
  return last ? unpad(body) : body;
}
