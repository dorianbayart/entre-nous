// FLAC, and WAV through FLAC: what is needed to play them while they arrive. MediaSource takes
// FLAC in fragmented MP4. A FLAC file's frames go in as they are; every frame header gives its
// position in samples, so a jump lands on an exact moment. A WAV holds raw samples, which no
// browser takes in MediaSource: they are put into FLAC frames as they are ("verbatim"
// subframes, nothing to compress), so both play the same way. Pure functions, no DOM.
import { audioEntry, box, concat, fields, initSegment } from './fmp4.ts';

export interface StreamInfo {
  minBlock: number;
  maxBlock: number;
  rate: number;
  channels: number;
  bits: number;
  /** 0 when unknown */
  samples: number;
  /** the 34 bytes of the STREAMINFO block, as they are */
  raw: Uint8Array;
}

export interface FlacFrame {
  /** first sample of the frame */
  sample: number;
  samples: number;
  /** bytes of the header, CRC-8 included */
  headerLength: number;
}

export interface SeekPoint {
  sample: number;
  /** from the first frame */
  offset: number;
}

// ---------------------------------------------------------------- checksums

const CRC8 = new Uint8Array(256);
const CRC16 = new Uint16Array(256);
for (let n = 0; n < 256; n++) {
  let c8 = n;
  let c16 = n << 8;
  for (let k = 0; k < 8; k++) {
    c8 = c8 & 0x80 ? ((c8 << 1) ^ 0x07) & 0xff : (c8 << 1) & 0xff;
    c16 = c16 & 0x8000 ? ((c16 << 1) ^ 0x8005) & 0xffff : (c16 << 1) & 0xffff;
  }
  CRC8[n] = c8;
  CRC16[n] = c16;
}

export function crc8(b: Uint8Array, from: number, to: number): number {
  let c = 0;
  for (let i = from; i < to; i++) c = CRC8[c ^ b[i]];
  return c;
}

export function crc16(b: Uint8Array, from: number, to: number): number {
  let c = 0;
  for (let i = from; i < to; i++) c = ((c << 8) & 0xffff) ^ CRC16[(c >> 8) ^ b[i]];
  return c;
}

// ---------------------------------------------------------------- FLAC files

const u24 = (b: Uint8Array, i: number) => (b[i] << 16) | (b[i + 1] << 8) | b[i + 2];

function streamInfo(raw: Uint8Array): StreamInfo {
  const hi = ((raw[13] & 0x0f) * 2 ** 32);
  return {
    minBlock: (raw[0] << 8) | raw[1],
    maxBlock: (raw[2] << 8) | raw[3],
    rate: (raw[10] << 12) | (raw[11] << 4) | (raw[12] >> 4),
    channels: ((raw[12] >> 1) & 7) + 1,
    bits: (((raw[12] & 1) << 4) | (raw[13] >> 4)) + 1,
    samples: hi + ((raw[14] << 24) >>> 0) + (raw[15] << 16) + (raw[16] << 8) + raw[17],
    raw: raw.slice(0, 34),
  };
}

/**
 * The metadata of a FLAC file, from its start: STREAMINFO, the seek table, and where the
 * frames start. Null when it is not FLAC; `more` when `b` stops before the frames.
 */
export function flacMetadata(b: Uint8Array): { info: StreamInfo; seek: SeekPoint[]; first: number } | { more: true } | null {
  if (b.length < 4 || String.fromCharCode(...b.subarray(0, 4)) !== 'fLaC') return null;
  let at = 4;
  let info: StreamInfo | undefined;
  const seek: SeekPoint[] = [];
  for (;;) {
    if (at + 4 > b.length) return { more: true };
    const last = (b[at] & 0x80) !== 0;
    const type = b[at] & 0x7f;
    const length = u24(b, at + 1);
    if (at + 4 + length > b.length && (type === 0 || type === 3)) return { more: true };
    if (type === 0) info = streamInfo(b.subarray(at + 4, at + 4 + length));
    if (type === 3) {
      for (let p = at + 4; p + 18 <= at + 4 + length; p += 18) {
        const sample = new DataView(b.buffer, b.byteOffset + p, 18).getBigUint64(0);
        if (sample === 0xffffffffffffffffn) continue; // a placeholder
        seek.push({ sample: Number(sample), offset: Number(new DataView(b.buffer, b.byteOffset + p, 18).getBigUint64(8)) });
      }
    }
    at += 4 + length;
    if (last) break;
  }
  return info ? { info, seek, first: at } : null;
}

/** The frame header at `i` (its CRC-8 checked), or null. `block`: the stream's fixed block size. */
export function flacFrameAt(b: Uint8Array, i: number, block: number): FlacFrame | null {
  if (i + 6 > b.length || b[i] !== 0xff || (b[i + 1] & 0xfe) !== 0xf8) return null;
  const variable = (b[i + 1] & 1) === 1;
  const bs = b[i + 2] >> 4;
  const sr = b[i + 2] & 0x0f;
  const ch = b[i + 3] >> 4;
  if (bs === 0 || sr === 15 || ch > 10 || ((b[i + 3] >> 1) & 7) === 3 || b[i + 3] & 1) return null;
  // the frame (or sample) number, coded like UTF-8
  let j = i + 4;
  const c0 = b[j];
  let n: number;
  let extra: number;
  if (c0 < 0x80) (n = c0), (extra = 0);
  else if ((c0 & 0xe0) === 0xc0) (n = c0 & 0x1f), (extra = 1);
  else if ((c0 & 0xf0) === 0xe0) (n = c0 & 0x0f), (extra = 2);
  else if ((c0 & 0xf8) === 0xf0) (n = c0 & 0x07), (extra = 3);
  else if ((c0 & 0xfc) === 0xf8) (n = c0 & 0x03), (extra = 4);
  else if ((c0 & 0xfe) === 0xfc) (n = c0 & 0x01), (extra = 5);
  else if (c0 === 0xfe) (n = 0), (extra = 6);
  else return null;
  if (j + 1 + extra + 3 > b.length) return null;
  for (let k = 1; k <= extra; k++) {
    if ((b[j + k] & 0xc0) !== 0x80) return null;
    n = n * 64 + (b[j + k] & 0x3f);
  }
  j += 1 + extra;
  let samples: number;
  if (bs === 1) samples = 192;
  else if (bs <= 5) samples = 576 << (bs - 2);
  else if (bs === 6) samples = b[j++] + 1;
  else if (bs === 7) (samples = ((b[j] << 8) | b[j + 1]) + 1), (j += 2);
  else samples = 256 << (bs - 8);
  if (sr === 12) j += 1;
  else if (sr === 13 || sr === 14) j += 2;
  if (j >= b.length || crc8(b, i, j) !== b[j]) return null;
  return { sample: variable ? n : n * block, samples, headerLength: j + 1 - i };
}

/**
 * The frames that start at `from` in `b`, one after the other, each checked by its CRC-16:
 * their bounds and positions. `end`: `b` closes the file, its last frame ends with it.
 */
export function flacFrames(b: Uint8Array, from: number, block: number, end: boolean): Array<FlacFrame & { at: number; length: number }> {
  const out: Array<FlacFrame & { at: number; length: number }> = [];
  let at = from;
  for (;;) {
    const frame = flacFrameAt(b, at, block);
    if (!frame) return out;
    let next = -1;
    for (let k = at + frame.headerLength + 2; k + 6 <= b.length; k++) {
      if (b[k] !== 0xff || (b[k + 1] & 0xfe) !== 0xf8) continue;
      if (!flacFrameAt(b, k, block)) continue;
      if (crc16(b, at, k - 2) === ((b[k - 2] << 8) | b[k - 1])) {
        next = k;
        break;
      }
    }
    if (next < 0) {
      if (end && b.length - at > frame.headerLength + 2 && crc16(b, at, b.length - 2) === ((b[b.length - 2] << 8) | b[b.length - 1])) {
        out.push({ ...frame, at, length: b.length - at });
      }
      return out;
    }
    out.push({ ...frame, at, length: next - at });
    at = next;
  }
}

/** The first frame at or after `from` (header and the frame after it checked); -1 if none. */
export function flacSync(b: Uint8Array, from: number, block: number): number {
  for (let i = Math.max(0, from); i + 6 <= b.length; i++) {
    if (b[i] !== 0xff || (b[i + 1] & 0xfe) !== 0xf8 || !flacFrameAt(b, i, block)) continue;
    if (flacFrames(b, i, block, false).length) return i;
  }
  return -1;
}

/** The initialization segment of a FLAC track (dfLa: its STREAMINFO block, the last one). */
export function flacInit(info: StreamInfo): Uint8Array {
  const dfLa = box('dfLa', fields([32, 0]), fields([8, 0x80], [24, 34]), info.raw);
  return initSegment(audioEntry('fLaC', info.channels, info.bits, info.rate, dfLa), info.rate);
}

// ---------------------------------------------------------------- WAV, through FLAC

export interface WavFormat {
  channels: number;
  rate: number;
  /** 8, 16 or 24 */
  bits: number;
  /** bytes of one sample of every channel */
  align: number;
  /** the samples: [start, end) in the file */
  start: number;
  end: number;
}

/** Samples per FLAC frame made from a WAV. */
export const WAV_BLOCK = 4096;

/**
 * The format of a WAV file, from its start: integer samples of 8, 16 or 24 bits only (floats
 * and other codings are not streamed). Null when it is not one; `more` when `b` stops first.
 */
export function wavFormat(b: Uint8Array, size: number): WavFormat | { more: true } | null {
  const tag = (i: number) => String.fromCharCode(...b.subarray(i, i + 4));
  if (b.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;
  const v = new DataView(b.buffer, b.byteOffset, b.length);
  let fmt: Omit<WavFormat, 'start' | 'end'> | undefined;
  for (let at = 12; ; ) {
    if (at + 8 > b.length) return { more: true };
    const id = tag(at);
    const length = v.getUint32(at + 4, true);
    if (id === 'fmt ') {
      if (at + 8 + 16 > b.length) return { more: true };
      let format = v.getUint16(at + 8, true);
      if (format === 0xfffe && length >= 26 && at + 8 + 26 <= b.length) format = v.getUint16(at + 8 + 24, true); // extensible: its sub-format
      const channels = v.getUint16(at + 10, true);
      const bits = v.getUint16(at + 22, true);
      if (format !== 1 || ![8, 16, 24].includes(bits) || channels < 1 || channels > 8) return null;
      fmt = { channels, rate: v.getUint32(at + 12, true), bits, align: v.getUint16(at + 20, true) };
      if (!fmt.rate || fmt.align !== (channels * bits) / 8) return null;
    } else if (id === 'data') {
      if (!fmt) return null;
      const start = at + 8;
      // a recording still being written says 0 or 0xFFFFFFFF: up to the end of the file
      const end = length && length !== 0xffffffff ? Math.min(size, start + length) : size;
      return { ...fmt, start, end: start + Math.floor((end - start) / fmt.align) * fmt.align };
    }
    at += 8 + length + (length & 1);
  }
}

/** The STREAMINFO of the FLAC stream a WAV becomes. */
export function wavStreamInfo(w: WavFormat): StreamInfo {
  const samples = (w.end - w.start) / w.align;
  const raw = fields(
    [16, WAV_BLOCK],
    [16, WAV_BLOCK],
    [24, 0],
    [24, 0],
    [32, (w.rate << 12) | ((w.channels - 1) << 9) | ((w.bits - 1) << 4) | Math.floor(samples / 2 ** 32)],
    [32, samples >>> 0],
    [64, 0],
    [64, 0], // no MD5
  );
  return { minBlock: WAV_BLOCK, maxBlock: WAV_BLOCK, rate: w.rate, channels: w.channels, bits: w.bits, samples, raw };
}

/** A number coded like UTF-8, as in a FLAC frame header. */
function codedNumber(n: number): number[] {
  if (n < 0x80) return [n];
  const bytes = n < 0x800 ? 2 : n < 0x10000 ? 3 : n < 0x200000 ? 4 : n < 0x4000000 ? 5 : n < 0x80000000 ? 6 : 7;
  const out: number[] = [];
  for (let k = 1; k < bytes; k++) {
    out.unshift(0x80 | (n & 0x3f));
    n = Math.floor(n / 64);
  }
  out.unshift(((0xff00 >> bytes) & 0xff) | n);
  return out;
}

/**
 * The FLAC frame `number` made from `pcm` (whole samples of every channel, as in the WAV): one
 * verbatim subframe per channel, big-endian, signed.
 */
export function wavFrame(w: WavFormat, number: number, pcm: Uint8Array): Uint8Array {
  const count = pcm.length / w.align;
  const width = w.bits / 8;
  const head = [0xff, 0xf8, 0x70, ((w.channels - 1) << 4) | 0, ...codedNumber(number), (count - 1) >> 8, (count - 1) & 0xff];
  // block size: 16 bits at the end of the header; rate and sample size: from STREAMINFO
  const out = new Uint8Array(head.length + 1 + w.channels * (1 + count * width) + 2);
  out.set(head);
  out[head.length] = crc8(out, 0, head.length);
  let at = head.length + 1;
  for (let c = 0; c < w.channels; c++) {
    out[at++] = 0x02; // a verbatim subframe
    for (let s = 0, i = c * width; s < count; s++, i += w.align) {
      if (width === 1) out[at++] = pcm[i] ^ 0x80; // unsigned in a WAV, signed in FLAC
      else if (width === 2) (out[at++] = pcm[i + 1]), (out[at++] = pcm[i]);
      else (out[at++] = pcm[i + 2]), (out[at++] = pcm[i + 1]), (out[at++] = pcm[i]);
    }
  }
  const crc = crc16(out, 0, at);
  out[at++] = crc >> 8;
  out[at] = crc & 0xff;
  return out;
}

export { concat };
