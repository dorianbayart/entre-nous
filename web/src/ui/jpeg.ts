// Progressive JPEG, written by hand: browsers' canvases only give baseline JPEGs (shown from top
// to bottom while they load), a progressive one shows whole at once, blurry, then sharp. Used for
// the previews the sender makes. YCbCr 4:2:0, the standard quantization tables scaled to the
// quality (as libjpeg does), Huffman tables computed for each scan. Scans by frequency bands
// only (no successive approximation): the DC of all components, then the low frequencies of Y,
// the chroma, the rest of Y. Pure functions, no DOM.

/** Position k of the zigzag order → index in the 8×8 block (row × 8 + column). */
const ZIGZAG = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36,
  29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
];

// the tables of the JPEG standard (annex K), at quality 50
const LUMA = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109,
  103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
];
const CHROMA = [
  17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99, 99, 99, 47, 66, 99, 99, 99, 99, 99, 99, ...new Array(32).fill(99),
];

/** Scale factors of the AAN fast DCT. */
const AAN = [1, 1.387039845, 1.306562965, 1.175875602, 1, 0.785694958, 0.5411961, 0.275899379];

function quantTable(base: number[], quality: number): number[] {
  const q = Math.min(100, Math.max(1, Math.round(quality)));
  const scale = q < 50 ? 5000 / q : 200 - q * 2;
  return base.map((v) => Math.min(255, Math.max(1, Math.floor((v * scale + 50) / 100))));
}

/** Forward DCT of a block in place (AAN, as libjpeg's float version): rows, then columns. */
function fdct(d: Float32Array) {
  for (let pass = 0; pass < 2; pass++) {
    const step = pass === 0 ? 1 : 8;
    for (let line = 0; line < 8; line++) {
      const o = pass === 0 ? line * 8 : line;
      const d0 = d[o], d1 = d[o + step], d2 = d[o + 2 * step], d3 = d[o + 3 * step];
      const d4 = d[o + 4 * step], d5 = d[o + 5 * step], d6 = d[o + 6 * step], d7 = d[o + 7 * step];
      const t0 = d0 + d7, t7 = d0 - d7, t1 = d1 + d6, t6 = d1 - d6;
      const t2 = d2 + d5, t5 = d2 - d5, t3 = d3 + d4, t4 = d3 - d4;
      // even part
      const t10 = t0 + t3, t13 = t0 - t3, t11 = t1 + t2, t12 = t1 - t2;
      d[o] = t10 + t11;
      d[o + 4 * step] = t10 - t11;
      const z1 = (t12 + t13) * 0.707106781;
      d[o + 2 * step] = t13 + z1;
      d[o + 6 * step] = t13 - z1;
      // odd part
      const s10 = t4 + t5, s11 = t5 + t6, s12 = t6 + t7;
      const z5 = (s10 - s12) * 0.382683433;
      const z2 = 0.5411961 * s10 + z5;
      const z4 = 1.306562965 * s12 + z5;
      const z3 = s11 * 0.707106781;
      const z11 = t7 + z3, z13 = t7 - z3;
      d[o + 5 * step] = z13 + z2;
      d[o + 3 * step] = z13 - z2;
      d[o + step] = z11 + z4;
      d[o + 7 * step] = z11 - z4;
    }
  }
}

interface Component {
  id: number;
  /** blocks per line and per column, as the MCUs cover them (interleaved scan) */
  bw: number;
  bh: number;
  /** blocks really covering the component (a scan of this component alone) */
  cw: number;
  ch: number;
  /** quantized coefficients, 64 per block, in zigzag order */
  coef: Int16Array;
  table: number;
}

/** A plane of samples, `w`×`h`, as blocks of 64 quantized coefficients. */
function blocks(plane: Float32Array, w: number, h: number, bw: number, bh: number, q: number[]): Int16Array {
  const out = new Int16Array(bw * bh * 64);
  const scale = new Float32Array(64);
  for (let i = 0; i < 64; i++) scale[i] = 1 / (q[i] * AAN[i >> 3] * AAN[i & 7] * 8);
  const block = new Float32Array(64);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      for (let v = 0; v < 8; v++) {
        const row = Math.min(by * 8 + v, h - 1) * w; // past the edge: the last line, the last column again
        for (let u = 0; u < 8; u++) block[v * 8 + u] = plane[row + Math.min(bx * 8 + u, w - 1)] - 128;
      }
      fdct(block);
      const at = (by * bw + bx) * 64;
      for (let k = 0; k < 64; k++) out[at + k] = Math.round(block[ZIGZAG[k]] * scale[ZIGZAG[k]]);
    }
  }
  return out;
}

// ---------------------------------------------------------------- Huffman

type Emit = (table: number, symbol: number, bits: number, length: number) => void;

interface Huffman {
  /** code count per length (1 to 16), and the symbols in code order */
  counts: number[];
  symbols: number[];
  code: Uint16Array;
  size: Uint8Array;
}

/** The best code for these symbol frequencies, no code longer than 16 bits (libjpeg's method). */
function huffman(frequencies: Int32Array): Huffman {
  const freq = Array.from(frequencies);
  freq[256] = 1; // a reserved symbol: no code made only of ones
  const codesize = new Array(257).fill(0);
  const others = new Array(257).fill(-1);
  for (;;) {
    let c1 = -1;
    let c2 = -1;
    for (let i = 0, v = Infinity; i <= 256; i++) if (freq[i] && freq[i] <= v) (v = freq[i]), (c1 = i);
    for (let i = 0, v = Infinity; i <= 256; i++) if (freq[i] && freq[i] <= v && i !== c1) (v = freq[i]), (c2 = i);
    if (c2 < 0) break;
    freq[c1] += freq[c2];
    freq[c2] = 0;
    for (codesize[c1]++; others[c1] >= 0; codesize[c1]++) c1 = others[c1];
    others[c1] = c2;
    for (codesize[c2]++; others[c2] >= 0; codesize[c2]++) c2 = others[c2];
  }
  const bits = new Array(258).fill(0);
  for (let i = 0; i <= 256; i++) if (codesize[i]) bits[codesize[i]]++;
  for (let i = 257; i > 16; i--) {
    while (bits[i] > 0) {
      let j = i - 2;
      while (bits[j] === 0) j--;
      bits[i] -= 2;
      bits[i - 1]++;
      bits[j + 1] += 2;
      bits[j]--;
    }
  }
  let last = 16;
  while (bits[last] === 0) last--;
  bits[last]--; // the reserved symbol goes
  const symbols: number[] = [];
  for (let len = 1; len <= 256; len++) for (let s = 0; s < 256; s++) if (codesize[s] === len) symbols.push(s);
  const counts = bits.slice(1, 17);
  const code = new Uint16Array(256);
  const size = new Uint8Array(256);
  for (let len = 1, k = 0, c = 0; len <= 16; len++, c <<= 1) {
    for (let n = 0; n < counts[len - 1]; n++, k++, c++) {
      code[symbols[k]] = c;
      size[symbols[k]] = len;
    }
  }
  return { counts, symbols: symbols.slice(0, counts.reduce((a, b) => a + b, 0)), code, size };
}

/** Bits of a coefficient (its category, then its value; one less when negative). */
function category(v: number): [number, number] {
  if (v === 0) return [0, 0];
  const size = 32 - Math.clz32(Math.abs(v));
  return [size, v < 0 ? (v - 1) & ((1 << size) - 1) : v];
}

/** First scan: the DC coefficients of all components, MCU by MCU (2×2 Y blocks, then Cb, Cr). */
function dcScan(comps: Component[], mcuW: number, mcuH: number, emit: Emit) {
  const pred = comps.map(() => 0);
  for (let my = 0; my < mcuH; my++) {
    for (let mx = 0; mx < mcuW; mx++) {
      comps.forEach((c, n) => {
        const f = c.bw / mcuW; // 2 for Y, 1 for the chroma
        for (let v = 0; v < f; v++) {
          for (let u = 0; u < f; u++) {
            const dc = c.coef[((my * f + v) * c.bw + mx * f + u) * 64];
            const [size, bits] = category(dc - pred[n]);
            pred[n] = dc;
            emit(c.table, size, bits, size);
          }
        }
      });
    }
  }
}

/** A scan of the AC coefficients `from`…`to` of one component; runs of empty blocks as EOBRUN. */
function acScan(c: Component, from: number, to: number, emit: Emit) {
  let eobrun = 0;
  const flush = () => {
    if (!eobrun) return;
    const n = 31 - Math.clz32(eobrun);
    emit(0, n << 4, eobrun - (1 << n), n);
    eobrun = 0;
  };
  for (let by = 0; by < c.ch; by++) {
    for (let bx = 0; bx < c.cw; bx++) {
      const at = (by * c.bw + bx) * 64;
      let run = 0;
      for (let k = from; k <= to; k++) {
        const v = c.coef[at + k];
        if (v === 0) {
          run++;
          continue;
        }
        flush();
        for (; run > 15; run -= 16) emit(0, 0xf0, 0, 0);
        const [size, bits] = category(v);
        emit(0, (run << 4) | size, bits, size);
        run = 0;
      }
      if (run > 0 && ++eobrun === 0x7fff) flush();
    }
  }
  flush();
}

// ---------------------------------------------------------------- output

class Writer {
  buf = new Uint8Array(1 << 16);
  length = 0;
  private acc = 0;
  private n = 0;

  byte(b: number) {
    if (this.length === this.buf.length) {
      const bigger = new Uint8Array(this.buf.length * 2);
      bigger.set(this.buf);
      this.buf = bigger;
    }
    this.buf[this.length++] = b;
  }

  bytes(list: ArrayLike<number>) {
    for (let i = 0; i < list.length; i++) this.byte(list[i]);
  }

  /** A marker segment: its type, its length, its content. */
  segment(marker: number, content: number[]) {
    this.bytes([0xff, marker, (content.length + 2) >> 8, (content.length + 2) & 0xff]);
    this.bytes(content);
  }

  bits(value: number, length: number) {
    if (!length) return;
    this.acc = (this.acc << length) | value;
    this.n += length;
    while (this.n >= 8) {
      const b = (this.acc >>> (this.n - 8)) & 0xff;
      this.byte(b);
      if (b === 0xff) this.byte(0); // a 0xFF in the data is followed by a zero
      this.n -= 8;
    }
    this.acc &= (1 << this.n) - 1;
  }

  /** The end of a scan: the last byte filled with ones. */
  align() {
    if (this.n) this.bits((1 << (8 - this.n)) - 1, 8 - this.n);
  }
}

/**
 * `rgba` (`width`×`height`, 4 bytes a pixel, alpha ignored) as a progressive JPEG of `quality`
 * (1 to 100).
 */
export function encodeJpeg(rgba: ArrayLike<number>, width: number, height: number, quality: number): Uint8Array {
  if (width < 1 || height < 1 || width > 65535 || height > 65535) throw new Error('jpeg: size');
  const qLuma = quantTable(LUMA, quality);
  const qChroma = quantTable(CHROMA, quality);
  // YCbCr (JFIF), the chroma at half the size both ways (the mean of 4 pixels)
  const cw = Math.ceil(width / 2);
  const ch = Math.ceil(height / 2);
  const Y = new Float32Array(width * height);
  const Cb = new Float32Array(cw * ch);
  const Cr = new Float32Array(cw * ch);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
      Y[y * width + x] = 0.299 * r + 0.587 * g + 0.114 * b;
      const c = (y >> 1) * cw + (x >> 1);
      Cb[c] += -0.168736 * r - 0.331264 * g + 0.5 * b + 128;
      Cr[c] += 0.5 * r - 0.418688 * g - 0.081312 * b + 128;
    }
  }
  for (let y = 0; y < ch; y++) {
    const rows = Math.min(2, height - y * 2);
    for (let x = 0; x < cw; x++) {
      const n = rows * Math.min(2, width - x * 2);
      Cb[y * cw + x] /= n;
      Cr[y * cw + x] /= n;
    }
  }
  const mcuW = Math.ceil(width / 16);
  const mcuH = Math.ceil(height / 16);
  const comps: Component[] = [
    { id: 1, bw: mcuW * 2, bh: mcuH * 2, cw: Math.ceil(width / 8), ch: Math.ceil(height / 8), coef: blocks(Y, width, height, mcuW * 2, mcuH * 2, qLuma), table: 0 },
    { id: 2, bw: mcuW, bh: mcuH, cw: Math.ceil(cw / 8), ch: Math.ceil(ch / 8), coef: blocks(Cb, cw, ch, mcuW, mcuH, qChroma), table: 1 },
    { id: 3, bw: mcuW, bh: mcuH, cw: Math.ceil(cw / 8), ch: Math.ceil(ch / 8), coef: blocks(Cr, cw, ch, mcuW, mcuH, qChroma), table: 1 },
  ];

  const out = new Writer();
  out.bytes([0xff, 0xd8]);
  out.segment(0xe0, [0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]); // JFIF 1.1, no density
  out.segment(0xdb, [0, ...ZIGZAG.map((i) => qLuma[i]), 1, ...ZIGZAG.map((i) => qChroma[i])]);
  out.segment(0xc2, [8, height >> 8, height & 0xff, width >> 8, width & 0xff, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);

  // each scan: its components (with their DC and AC tables), its band, how its symbols come
  const scans: Array<{ comps: Array<[number, number]>; from: number; to: number; tables: number; run: (emit: Emit) => void }> = [
    { comps: [[1, 0x00], [2, 0x10], [3, 0x10]], from: 0, to: 0, tables: 2, run: (e) => dcScan(comps, mcuW, mcuH, e) },
    { comps: [[1, 0]], from: 1, to: 5, tables: 1, run: (e) => acScan(comps[0], 1, 5, e) },
    { comps: [[2, 0]], from: 1, to: 63, tables: 1, run: (e) => acScan(comps[1], 1, 63, e) },
    { comps: [[3, 0]], from: 1, to: 63, tables: 1, run: (e) => acScan(comps[2], 1, 63, e) },
    { comps: [[1, 0]], from: 6, to: 63, tables: 1, run: (e) => acScan(comps[0], 6, 63, e) },
  ];
  for (const scan of scans) {
    // a first pass counts the symbols, the tables come from it; the second writes
    const freqs = Array.from({ length: scan.tables }, () => new Int32Array(257));
    scan.run((t, symbol) => freqs[t][symbol]++);
    const tables = freqs.map(huffman);
    const dht: number[] = [];
    const ac = scan.from > 0 ? 0x10 : 0;
    tables.forEach((h, t) => dht.push(ac | t, ...h.counts, ...h.symbols));
    out.segment(0xc4, dht);
    out.segment(0xda, [scan.comps.length, ...scan.comps.flat(), scan.from, scan.to, 0]);
    scan.run((t, symbol, bits, length) => {
      out.bits(tables[t].code[symbol], tables[t].size[symbol]);
      out.bits(bits, length);
    });
    out.align();
  }
  out.bytes([0xff, 0xd9]);
  return out.buf.slice(0, out.length);
}
