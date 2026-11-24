// A ZIP archive without compression (photos and videos are compressed already), written as the
// bytes arrive: to a stream (the command line), or as the parts of a Blob, never one large buffer.
// ZIP64 past 4 GB. Names in UTF-8.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array, crc = 0): number {
  let c = ~crc >>> 0;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

const MAX32 = 0xffffffff;
const enc = new TextEncoder();

interface Entry {
  name: Uint8Array;
  crc: number;
  size: number;
  offset: number;
  dir: boolean;
}

/** DOS date and time (the ZIP format's), local time. */
function dosTime(d: Date): [number, number] {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return [time, date];
}

/**
 * Written as it goes: each entry's header, its bytes, then its CRC (a data descriptor), so
 * nothing waits for a whole file. `write` receives the archive piece by piece; without it, the
 * pieces become the parts of a Blob (`finish` returns it).
 */
export class ZipWriter {
  private parts: BlobPart[] = [];
  private entries: Entry[] = [];
  private offset = 0;
  private readonly time: number;
  private readonly date: number;
  private readonly out: (data: Uint8Array) => Promise<void>;

  constructor(write?: (data: Uint8Array) => Promise<void>, now = new Date()) {
    [this.time, this.date] = dosTime(now);
    this.out = write ?? (async (d) => void this.parts.push(new Blob([d as BlobPart])));
  }

  private async emit(data: Uint8Array) {
    this.offset += data.length;
    await this.out(data);
  }

  /** An empty folder ("a/b"). */
  async addDir(path: string) {
    await this.addFile(path.replace(/\/?$/, '/'), 0, (async function* () {})(), true);
  }

  /** A file: its bytes come from `pieces`, in order; `size` must be their total. */
  async addFile(path: string, size: number, pieces: AsyncIterable<Uint8Array>, dir = false) {
    const name = enc.encode(path);
    const big = size >= MAX32;
    // sizes and CRC come after the bytes (flag 8); a large file says so already (ZIP64)
    const extra = big ? zip64Extra([0, 0]) : new Uint8Array(0);
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true);
    h.setUint16(4, big ? 45 : 20, true);
    h.setUint16(6, 0x0808, true); // names in UTF-8, data descriptor
    h.setUint16(8, 0, true); // stored
    h.setUint16(10, this.time, true);
    h.setUint16(12, this.date, true);
    h.setUint32(14, 0, true);
    h.setUint32(18, big ? MAX32 : 0, true);
    h.setUint32(22, big ? MAX32 : 0, true);
    h.setUint16(26, name.length, true);
    h.setUint16(28, extra.length, true);
    const offset = this.offset;
    await this.emit(new Uint8Array(h.buffer));
    await this.emit(name);
    if (extra.length) await this.emit(extra);
    let crc = 0;
    let got = 0;
    for await (const p of pieces) {
      crc = crc32(p, crc);
      got += p.length;
      await this.emit(p);
    }
    if (got !== size) throw new Error('size mismatch');
    const d = new DataView(new ArrayBuffer(big ? 24 : 16));
    d.setUint32(0, 0x08074b50, true);
    d.setUint32(4, crc, true);
    if (big) {
      d.setBigUint64(8, BigInt(size), true);
      d.setBigUint64(16, BigInt(size), true);
    } else {
      d.setUint32(8, size, true);
      d.setUint32(12, size, true);
    }
    await this.emit(new Uint8Array(d.buffer));
    this.entries.push({ name, crc, size, offset, dir });
  }

  /** The central directory: the archive is complete. Without `write`: the archive, as a Blob. */
  async finish(): Promise<Blob> {
    const cdStart = this.offset;
    for (const e of this.entries) {
      const fields: number[] = [];
      if (e.size >= MAX32) fields.push(e.size, e.size);
      if (e.offset >= MAX32) fields.push(e.offset);
      const extra = fields.length ? zip64Extra(fields) : new Uint8Array(0);
      const c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true);
      c.setUint16(4, (3 << 8) | 45, true); // made by: Unix, 4.5
      c.setUint16(6, fields.length ? 45 : 20, true);
      c.setUint16(8, 0x0808, true);
      c.setUint16(10, 0, true);
      c.setUint16(12, this.time, true);
      c.setUint16(14, this.date, true);
      c.setUint32(16, e.crc, true);
      c.setUint32(20, e.size >= MAX32 ? MAX32 : e.size, true);
      c.setUint32(24, e.size >= MAX32 ? MAX32 : e.size, true);
      c.setUint16(28, e.name.length, true);
      c.setUint16(30, extra.length, true);
      // Unix mode (rwxr-xr-x folder, rw-r--r-- file), and the MS-DOS folder flag
      c.setUint32(38, ((e.dir ? 0o40755 : 0o100644) << 16) | (e.dir ? 0x10 : 0), true);
      c.setUint32(42, e.offset >= MAX32 ? MAX32 : e.offset, true);
      await this.emit(new Uint8Array(c.buffer));
      await this.emit(e.name);
      if (extra.length) await this.emit(extra);
    }
    const cdSize = this.offset - cdStart;
    const count = this.entries.length;
    if (count >= 0xffff || cdStart >= MAX32 || cdSize >= MAX32) {
      const zEnd = this.offset;
      const z = new DataView(new ArrayBuffer(56 + 20));
      z.setUint32(0, 0x06064b50, true);
      z.setBigUint64(4, 44n, true);
      z.setUint16(12, 45, true);
      z.setUint16(14, 45, true);
      z.setBigUint64(24, BigInt(count), true);
      z.setBigUint64(32, BigInt(count), true);
      z.setBigUint64(40, BigInt(cdSize), true);
      z.setBigUint64(48, BigInt(cdStart), true);
      // locator
      z.setUint32(56, 0x07064b50, true);
      z.setBigUint64(64, BigInt(zEnd), true);
      z.setUint32(72, 1, true);
      await this.emit(new Uint8Array(z.buffer));
    }
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, Math.min(count, 0xffff), true);
    end.setUint16(10, Math.min(count, 0xffff), true);
    end.setUint32(12, Math.min(cdSize, MAX32), true);
    end.setUint32(16, Math.min(cdStart, MAX32), true);
    await this.emit(new Uint8Array(end.buffer));
    return new Blob(this.parts, { type: 'application/zip' });
  }
}

/** The ZIP64 extra field, with these 8-byte values. */
function zip64Extra(values: number[]): Uint8Array {
  const d = new DataView(new ArrayBuffer(4 + 8 * values.length));
  d.setUint16(0, 0x0001, true);
  d.setUint16(2, 8 * values.length, true);
  values.forEach((v, i) => d.setBigUint64(4 + 8 * i, BigInt(v), true));
  return new Uint8Array(d.buffer);
}
