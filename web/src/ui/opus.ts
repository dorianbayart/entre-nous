// Opus in Ogg (.opus files): what is needed to play one while it arrives. Browsers do not take
// Ogg in MediaSource, but they take Opus in fragmented MP4: the Ogg pages are read as they come,
// their Opus packets put into MP4 fragments. Every page carries its position in samples (its
// granule): a jump lands on an exact moment. Pure functions, no DOM.
import { audioEntry, box, fields, initSegment } from './fmp4.ts';

/** Opus always counts in 48 kHz samples. */
export const OPUS_RATE = 48000;

export interface OggPage {
  /** byte length of the whole page */
  length: number;
  /** the page goes on a packet begun on the previous page */
  continued: boolean;
  /** samples at the end of the last packet completed on this page; -1 when none is */
  granule: number;
  serial: number;
  /** the packets (or parts of packets) of the page; `ends[i]`: does part i end a packet? */
  parts: Uint8Array[];
  ends: boolean[];
}

export interface OpusHead {
  channels: number;
  preSkip: number;
  inputRate: number;
  gain: number;
  family: number;
  /** family > 0: stream count, coupled count, channel mapping */
  mapping?: Uint8Array;
}

const le32 = (b: Uint8Array, i: number) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
const isCapture = (b: Uint8Array, i: number) => b[i] === 0x4f && b[i + 1] === 0x67 && b[i + 2] === 0x67 && b[i + 3] === 0x53; // "OggS"

/** The page at `i`, or null when there is none there or it is not whole in `b`. */
export function pageAt(b: Uint8Array, i: number): OggPage | null {
  if (i < 0 || i + 27 > b.length || !isCapture(b, i) || b[i + 4] !== 0) return null;
  const count = b[i + 26];
  if (i + 27 + count > b.length) return null;
  let size = 0;
  for (let k = 0; k < count; k++) size += b[i + 27 + k];
  const length = 27 + count + size;
  if (i + length > b.length) return null;
  const lo = le32(b, i + 6);
  const hi = le32(b, i + 10);
  const granule = hi === 0xffffffff && lo === 0xffffffff ? -1 : hi * 2 ** 32 + lo;
  const parts: Uint8Array[] = [];
  const ends: boolean[] = [];
  let at = i + 27 + count;
  let from = at;
  for (let k = 0; k < count; k++) {
    at += b[i + 27 + k];
    if (b[i + 27 + k] < 255 || k === count - 1) {
      parts.push(b.subarray(from, at));
      ends.push(b[i + 27 + k] < 255);
      from = at;
    }
  }
  return { length, continued: (b[i + 5] & 1) === 1, granule, serial: le32(b, i + 14), parts, ends };
}

/** The first whole page of stream `serial` at or after `from` in `b`; -1 when there is none. */
export function syncPage(b: Uint8Array, from: number, serial: number): number {
  for (let i = Math.max(0, from); i + 27 <= b.length; i++) {
    if (!isCapture(b, i)) continue;
    const page = pageAt(b, i);
    if (page && page.serial === serial) return i;
  }
  return -1;
}

/** The OpusHead packet, or null when the stream is not Opus (Vorbis, FLAC…). */
export function opusHead(p: Uint8Array): OpusHead | null {
  if (p.length < 19 || String.fromCharCode(...p.subarray(0, 8)) !== 'OpusHead') return null;
  const family = p[18];
  return {
    channels: p[9],
    preSkip: p[10] | (p[11] << 8),
    inputRate: le32(p, 12),
    gain: ((p[16] | (p[17] << 8)) << 16) >> 16,
    family,
    mapping: family > 0 ? p.slice(19, 21 + p[9]) : undefined,
  };
}

/** Samples (at 48 kHz) in an Opus packet, from its first byte (TOC) and its frame count. */
export function packetSamples(p: Uint8Array): number {
  if (!p.length) return 0;
  const config = p[0] >> 3;
  const tenths = config < 12 ? [100, 200, 400, 600][config & 3] : config < 16 ? [100, 200][config & 1] : [25, 50, 100, 200][config & 3];
  const code = p[0] & 3;
  const frames = code === 0 ? 1 : code === 3 ? (p[1] ?? 0) & 0x3f : 2;
  return (tenths * 48 * frames) / 10;
}

// ---------------------------------------------------------------- MP4

/** The initialization segment of an Opus track (dOps: OpusHead in big-endian), at 48 kHz. */
export function opusInit(head: OpusHead): Uint8Array {
  const dOps = box(
    'dOps',
    fields([8, 0], [8, head.channels], [16, head.preSkip], [32, head.inputRate], [16, head.gain & 0xffff], [8, head.family]),
    head.mapping ?? new Uint8Array(0),
  );
  return initSegment(audioEntry('Opus', head.channels, 16, OPUS_RATE, dOps), OPUS_RATE);
}
