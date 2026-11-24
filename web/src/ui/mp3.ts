// MPEG audio (MP3): what is needed to play a file from anywhere while it arrives. The frame
// headers (their length, their sample rate), the tags to skip (ID3), and where a moment is in
// the file: from the table of contents of the Xing/Info header (variable bitrate), else from
// the bitrate. Pure functions, no DOM.

export interface FrameHeader {
  /** 1, 2 or 2.5 */
  version: number;
  /** 1, 2 or 3 */
  layer: number;
  /** bits per second */
  bitrate: number;
  sampleRate: number;
  /** samples per frame */
  samples: number;
  /** bytes, header included */
  length: number;
  mono: boolean;
}

export interface VbrHeader {
  frames?: number;
  /** 100 entries: where each percent of the duration starts, in 256ths of the data */
  toc?: Uint8Array;
}

const RATES: Record<string, number[]> = { '1': [44100, 48000, 32000], '2': [22050, 24000, 16000], '2.5': [11025, 12000, 8000] };
/** kbit/s, by MPEG version (1 or 2 and 2.5) and layer */
const KBPS: Record<string, number[]> = {
  '1-1': [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  '1-2': [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  '1-3': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  '2-1': [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  '2-2': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};

const u32 = (b: Uint8Array, i: number) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
const text = (b: Uint8Array, i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n));

/** The frame header at `i`, or null when there is none there. */
export function frameAt(b: Uint8Array, i: number): FrameHeader | null {
  if (i < 0 || i + 4 > b.length || b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) return null;
  const v = (b[i + 1] >> 3) & 3;
  const l = (b[i + 1] >> 1) & 3;
  const br = b[i + 2] >> 4;
  const sr = (b[i + 2] >> 2) & 3;
  if (v === 1 || l === 0 || br === 0 || br === 15 || sr === 3) return null; // reserved values, or free bitrate
  const version = v === 3 ? 1 : v === 2 ? 2 : 2.5;
  const layer = 4 - l;
  const table = version === 1 ? KBPS[`1-${layer}`] : KBPS[layer === 1 ? '2-1' : '2-2'];
  const bitrate = table[br] * 1000;
  const sampleRate = RATES[String(version)][sr];
  const padding = (b[i + 2] >> 1) & 1;
  const samples = layer === 1 ? 384 : layer === 3 && version !== 1 ? 576 : 1152;
  const length =
    layer === 1 ? (Math.floor((12 * bitrate) / sampleRate) + padding) * 4 : Math.floor(((samples / 8) * bitrate) / sampleRate) + padding;
  return { version, layer, bitrate, sampleRate, samples, length, mono: b[i + 3] >> 6 === 3 };
}

const sameStream = (a: FrameHeader, b: FrameHeader) => a.version === b.version && a.layer === b.layer && a.sampleRate === b.sampleRate;

/**
 * The first frame at or after `from` that is followed by another one of the same stream (or by
 * the end of `b`), like `like` when given; -1 when there is none.
 */
export function syncFrom(b: Uint8Array, from: number, like?: FrameHeader): number {
  for (let i = Math.max(0, from); i + 4 <= b.length; i++) {
    const f = frameAt(b, i);
    if (!f || (like && !sameStream(f, like))) continue;
    const next = i + f.length;
    if (next + 4 > b.length) return i;
    const g = frameAt(b, next);
    if (g && sameStream(f, g)) return i;
  }
  return -1;
}

/** Bytes of the ID3v2 tag at the start of a file (title, cover…), 0 when there is none. */
export function id3Size(b: Uint8Array): number {
  if (b.length < 10 || text(b, 0, 3) !== 'ID3') return 0;
  const size = ((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f);
  return 10 + size + (b[5] & 0x10 ? 10 : 0);
}

/** The end of the data without the ID3v1 tag (128 bytes, "TAG") that may close the file. */
export function withoutId3v1(b: Uint8Array): Uint8Array {
  return b.length >= 128 && text(b, b.length - 128, 3) === 'TAG' ? b.subarray(0, b.length - 128) : b;
}

/** The Xing/Info (or VBRI) header in the first frame, at `i`: frames, table of contents. */
export function vbrHeader(b: Uint8Array, i: number, f: FrameHeader): VbrHeader | null {
  const side = f.version === 1 ? (f.mono ? 17 : 32) : f.mono ? 9 : 17;
  let x = i + 4 + side;
  if (x + 8 <= b.length && ['Xing', 'Info'].includes(text(b, x, 4))) {
    const flags = u32(b, x + 4);
    x += 8;
    const vbr: VbrHeader = {};
    if (flags & 1) (vbr.frames = u32(b, x)), (x += 4);
    if (flags & 2) x += 4; // bytes: the file's own size is used instead
    if (flags & 4 && x + 100 <= b.length) vbr.toc = b.slice(x, x + 100);
    return vbr;
  }
  x = i + 4 + 32;
  if (x + 18 <= b.length && text(b, x, 4) === 'VBRI') return { frames: u32(b, x + 14) };
  return null;
}

/** Where moment `t` is in the audio data [start, end) of a file lasting `duration` seconds. */
export function offsetOf(t: number, duration: number, start: number, end: number, toc?: Uint8Array): number {
  const p = duration > 0 ? Math.min(Math.max(t / duration, 0), 1) * 100 : 0;
  if (!toc) return Math.floor(start + ((end - start) * p) / 100);
  const i = Math.min(Math.floor(p), 99);
  const a = toc[i];
  const b = i < 99 ? toc[i + 1] : 256;
  return Math.floor(start + ((a + (b - a) * (p - i)) / 256) * (end - start));
}
