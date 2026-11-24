// Fragmented MP4, written by hand for one audio track: what MediaSource takes when a format
// cannot be given to it as it is (Opus in Ogg, FLAC, WAV). An initialization segment (the
// track and its codec), then media segments (a few frames, their lengths, their bytes).
// Pure functions, no DOM.

export function box(type: string, ...parts: Uint8Array[]): Uint8Array {
  const size = 8 + parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(size);
  new DataView(out.buffer).setUint32(0, size);
  for (let k = 0; k < 4; k++) out[4 + k] = type.charCodeAt(k);
  let at = 8;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Big-endian fields: [bits, value] pairs. */
export function fields(...list: Array<[8 | 16 | 24 | 32 | 64, number]>): Uint8Array {
  const out = new Uint8Array(list.reduce((n, [bits]) => n + bits / 8, 0));
  const v = new DataView(out.buffer);
  let at = 0;
  for (const [bits, value] of list) {
    if (bits === 8) v.setUint8(at, value);
    else if (bits === 16) v.setUint16(at, value);
    else if (bits === 24) (v.setUint8(at, (value >>> 16) & 0xff), v.setUint16(at + 1, value & 0xffff));
    else if (bits === 32) v.setUint32(at, value >>> 0);
    else v.setBigUint64(at, BigInt(Math.max(0, Math.round(value))));
    at += bits / 8;
  }
  return out;
}

export function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export const zeros = (n: number) => new Uint8Array(n);
const ascii = (s: string) => new TextEncoder().encode(s);
const MATRIX = fields([32, 0x10000], [32, 0], [32, 0], [32, 0], [32, 0x10000], [32, 0], [32, 0], [32, 0], [32, 0x40000000]);

/**
 * An audio sample entry (`format`: 'Opus', 'fLaC'), with its codec box. The sample rate field
 * holds 16 bits: 0 above (the codec box tells it).
 */
export function audioEntry(format: string, channels: number, bits: number, rate: number, codecBox: Uint8Array): Uint8Array {
  return box(
    format,
    zeros(6),
    fields([16, 1], [32, 0], [32, 0], [16, channels], [16, bits], [16, 0], [16, 0], [32, rate < 65536 ? rate * 65536 : 0]),
    codecBox,
  );
}

/** The initialization segment: one audio track counting time in `timescale` units. */
export function initSegment(entry: Uint8Array, timescale: number): Uint8Array {
  const empty = fields([32, 0], [32, 0]); // version and flags, no entry
  const stbl = box(
    'stbl',
    box('stsd', fields([32, 0], [32, 1]), entry),
    box('stts', empty),
    box('stsc', empty),
    box('stsz', fields([32, 0], [32, 0], [32, 0])),
    box('stco', empty),
  );
  const minf = box('minf', box('smhd', fields([32, 0], [16, 0], [16, 0])), box('dinf', box('dref', fields([32, 0], [32, 1]), box('url ', fields([32, 1])))), stbl);
  const mdia = box(
    'mdia',
    box('mdhd', fields([32, 0], [32, 0], [32, 0], [32, timescale], [32, 0], [16, 0x55c4], [16, 0])),
    box('hdlr', fields([32, 0], [32, 0]), ascii('soun'), zeros(12), ascii('SoundHandler\0')),
    minf,
  );
  const tkhd = box('tkhd', fields([32, 3], [32, 0], [32, 0], [32, 1], [32, 0], [32, 0], [32, 0], [32, 0], [16, 0], [16, 0], [16, 0x100], [16, 0]), MATRIX, fields([32, 0], [32, 0]));
  const mvhd = box('mvhd', fields([32, 0], [32, 0], [32, 0], [32, timescale], [32, 0], [32, 0x10000], [16, 0x100], [16, 0]), zeros(8), MATRIX, zeros(24), fields([32, 2]));
  const mvex = box('mvex', box('trex', fields([32, 0], [32, 1], [32, 1], [32, 0], [32, 0], [32, 0])));
  const ftyp = box('ftyp', ascii('iso6'), fields([32, 0]), ascii('iso6mp41'));
  return concat([ftyp, box('moov', mvhd, box('trak', tkhd, mdia), mvex)]);
}

/** A media segment: `frames` from time `start` on, each lasting `durations[i]` (timescale units). */
export function mediaSegment(sequence: number, start: number, frames: Uint8Array[], durations: number[]): Uint8Array {
  const trunHead = fields([32, 0x000301], [32, frames.length], [32, 0]); // duration and size per sample, data offset
  const perSample = fields(...frames.flatMap((f, k): Array<[32, number]> => [[32, durations[k]], [32, f.length]]));
  const traf = box('traf', box('tfhd', fields([32, 0x020000], [32, 1])), box('tfdt', fields([32, 0x01000000], [64, start])), box('trun', trunHead, perSample));
  const moof = box('moof', box('mfhd', fields([32, 0], [32, sequence])), traf);
  // the data offset: from the start of moof to the first byte in mdat
  new DataView(moof.buffer).setUint32(moof.length - perSample.length - 4, moof.length + 8);
  return concat([moof, box('mdat', ...frames)]);
}
