// A shared folder: one item of the history, whose content is a single archive, read by ranges
// like any other content (nothing to change on the relay):
//
//   "ENF1" | index length (4 bytes, big-endian) | index (JSON, UTF-8) | thumbnails | files
//
// The index and the thumbnails come first: another device browses the folder from its first
// megabytes, even while it is still being sent. A file of the folder is a range of the
// content: previews, streaming and partial downloads work as for an item of its own.
import { fromUtf8, utf8 } from './bytes.ts';
import { previewKind } from './media.ts';
import type { ContentReader } from './reader.ts';

const MAGIC = 'ENF1';
const PREFIX = 8;
/** An index larger than this is refused (some hundred thousand files). */
const INDEX_MAX = 64 * 1024 * 1024;

/** A file of the folder, as the index lists it. */
export interface FolderFile {
  /** Path in the folder ("Jour 1/IMG_2041.jpg"), never absolute, never "..". */
  path: string;
  size: number;
  /** Where its bytes start in the content. */
  offset: number;
  mime?: string;
  /** Its preview (JPEG): where in the content, how long. */
  thumb?: [number, number];
  w?: number;
  h?: number;
  duration?: number;
  pages?: number;
  excerpt?: string;
}

export interface FolderIndex {
  v: 1;
  name: string;
  files: FolderFile[];
  /** Every folder inside, even empty ones. */
  dirs: string[];
}

/** What the history shows before anything is downloaded (in the item's header). */
export interface FolderSummary {
  files: number;
  dirs: number;
  /** Size of the files, all together. */
  bytes: number;
}

/** Random access to bytes: a File, or files read through an app's native side. */
export interface ByteSource {
  readonly size: number;
  read(start: number, end: number): Promise<Uint8Array>;
}

/** Bytes [start, end) of a Blob or a ByteSource. */
export async function readSource(src: Blob | ByteSource, start: number, end: number): Promise<Uint8Array> {
  if (src instanceof Blob) return new Uint8Array(await src.slice(start, end).arrayBuffer());
  return src.read(start, end);
}

/** System files never sent: Finder's and Windows Explorer's own (the other hidden files go). */
const SYSTEM = /^(\.DS_Store|Thumbs\.db|ehthumbs\.db|desktop\.ini|Icon\r|\._.*|\.localized)$/i;

export const isSystemFile = (path: string) => SYSTEM.test(path.split('/').pop() ?? '');

/**
 * A path made safe, or null: its parts without "", ".", "..", control characters or
 * separators of another system (a name received from another device is never trusted).
 */
export function safePath(path: string): string | null {
  const parts = path.split(/[\\/]/);
  const clean: string[] = [];
  for (const raw of parts) {
    const p = raw.replace(/[\u0000-\u001f\u007f]/g, '').trim();
    if (!p || p === '.' || p === '..') {
      if (raw === '' || raw === '.') continue; // "a//b", "./a"
      return null;
    }
    clean.push(p.slice(0, 255));
  }
  return clean.length ? clean.join('/') : null;
}

export const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1);
export const dirName = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** A file to put in a folder: its path, its bytes, and what its preview found. */
export interface PackFile {
  path: string;
  size: number;
  mime?: string;
  src: Blob | ByteSource;
  preview?: { thumb?: Uint8Array; w?: number; h?: number; duration?: number; pages?: number; excerpt?: string };
}

/** The archive of a folder: its index, and its content as a ByteSource (read on demand). */
export function buildPack(name: string, files: PackFile[], dirs: string[] = []): { index: FolderIndex; source: ByteSource; summary: FolderSummary } {
  const sorted = [...files].sort((a, b) => comparePaths(a.path, b.path));
  // every folder that holds something, and the empty ones given
  const allDirs = new Set<string>();
  for (const d of dirs) for (let p = d; p; p = dirName(p)) allDirs.add(p);
  for (const f of sorted) for (let p = dirName(f.path); p; p = dirName(p)) allDirs.add(p);
  const thumbs = sorted.map((f) => f.preview?.thumb).filter((t): t is Uint8Array => !!t?.length);
  const entries: FolderFile[] = sorted.map((f) => {
    const e: FolderFile = { path: f.path, size: f.size, offset: 0 };
    if (f.mime) e.mime = f.mime;
    const p = f.preview;
    if (p?.w && p.h) Object.assign(e, { w: p.w, h: p.h });
    if (p?.duration) e.duration = p.duration;
    if (p?.pages) e.pages = p.pages;
    if (p?.excerpt) e.excerpt = p.excerpt;
    return e;
  });
  const index: FolderIndex = { v: 1, name, files: entries, dirs: [...allDirs].sort(compareDirs) };
  // The offsets are written in the index, whose length depends on them: the offsets are
  // computed with a placeholder length, then again until the length no longer changes.
  let json = '';
  let indexLen = 0;
  for (let round = 0; round < 8; round++) {
    let at = PREFIX + indexLen;
    sorted.forEach((f, i) => {
      const t = f.preview?.thumb;
      if (t?.length) {
        entries[i].thumb = [at, t.length];
        at += t.length;
      }
    });
    for (const e of entries) {
      e.offset = at;
      at += e.size;
    }
    json = JSON.stringify(index);
    const len = utf8(json).length;
    if (len === indexLen) break;
    indexLen = len;
  }
  const head = new Uint8Array(PREFIX + indexLen);
  head.set(utf8(MAGIC), 0);
  new DataView(head.buffer).setUint32(4, indexLen);
  head.set(utf8(json), PREFIX);
  // the parts, in order: what the content is made of
  const parts: Array<{ at: number; size: number; read: (s: number, e: number) => Promise<Uint8Array> }> = [];
  let at = 0;
  const push = (size: number, read: (s: number, e: number) => Promise<Uint8Array>) => {
    if (size > 0) parts.push({ at, size, read });
    at += size;
  };
  push(head.length, async (s, e) => head.subarray(s, e));
  for (const t of thumbs) push(t.length, async (s, e) => t.subarray(s, e));
  for (const f of sorted) push(f.size, (s, e) => readSource(f.src, s, e));
  const size = at;
  const source: ByteSource = {
    size,
    async read(start, end) {
      start = Math.max(0, start);
      end = Math.min(size, end);
      const out = new Uint8Array(Math.max(0, end - start));
      let i = findPart(parts, start);
      while (i < parts.length && parts[i].at < end) {
        const p = parts[i];
        const s = Math.max(start, p.at) - p.at;
        const e = Math.min(end, p.at + p.size) - p.at;
        const data = await p.read(s, e);
        if (data.length !== e - s) throw new Error('file changed while being sent');
        out.set(data, p.at + s - start);
        i++;
      }
      return out;
    },
  };
  const summary: FolderSummary = { files: entries.length, dirs: index.dirs.length, bytes: entries.reduce((n, e) => n + e.size, 0) };
  return { index, source, summary };
}

/** The part that holds byte `at` (parts sorted by position). */
function findPart(parts: Array<{ at: number; size: number }>, at: number): number {
  let lo = 0;
  let hi = parts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (parts[mid].at <= at) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Folders before their files, then by name, numbers in order ("2" before "10"). */
export function comparePaths(a: string, b: string): number {
  const x = a.split('/');
  const y = b.split('/');
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i] === y[i]) continue;
    // at this level, a folder (more parts below) comes before a file
    const xDir = i < x.length - 1;
    const yDir = i < y.length - 1;
    if (xDir !== yDir) return xDir ? -1 : 1;
    return collator.compare(x[i], y[i]) || (x[i] < y[i] ? -1 : 1);
  }
  return x.length - y.length;
}

/** Folders by name, each before what it holds. */
function compareDirs(a: string, b: string): number {
  const x = a.split('/');
  const y = b.split('/');
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i] !== y[i]) return collator.compare(x[i], y[i]) || (x[i] < y[i] ? -1 : 1);
  }
  return x.length - y.length;
}

/** Reads and checks the index at the start of a folder's content. */
export async function readIndex(reader: ContentReader): Promise<FolderIndex> {
  const head = await reader.read(0, PREFIX);
  if (head.length < PREFIX || fromUtf8(head.subarray(0, 4)) !== MAGIC) throw new Error('not a folder');
  const len = new DataView(head.buffer, head.byteOffset, head.byteLength).getUint32(4);
  if (len > INDEX_MAX || PREFIX + len > reader.size) throw new Error('bad folder index');
  const raw = JSON.parse(fromUtf8(await reader.read(PREFIX, PREFIX + len)));
  return checkIndex(raw, reader.size);
}

const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/** The index as received from another device: only what is well formed is kept. */
function checkIndex(raw: any, size: number): FolderIndex {
  if (!raw || raw.v !== 1 || !Array.isArray(raw.files)) throw new Error('bad folder index');
  const files: FolderFile[] = [];
  const seen = new Set<string>();
  for (const f of raw.files) {
    const path = typeof f?.path === 'string' ? safePath(f.path) : null;
    if (!path || seen.has(path) || !Number.isSafeInteger(f.size) || f.size < 0 || !Number.isSafeInteger(f.offset)) continue;
    if (f.offset < PREFIX || f.offset + f.size > size) continue;
    seen.add(path);
    const e: FolderFile = { path, size: f.size, offset: f.offset };
    if (typeof f.mime === 'string' && f.mime.length < 200) e.mime = f.mime;
    if (Array.isArray(f.thumb) && Number.isSafeInteger(f.thumb[0]) && Number.isSafeInteger(f.thumb[1])) {
      const [at, len] = f.thumb;
      if (at >= PREFIX && len > 0 && len <= 4 * 1024 * 1024 && at + len <= size) e.thumb = [at, len];
    }
    if (num(f.w) && num(f.h) && f.w > 0 && f.h > 0) Object.assign(e, { w: Math.round(f.w), h: Math.round(f.h) });
    if (num(f.duration) && f.duration > 0) e.duration = f.duration;
    if (Number.isInteger(f.pages) && f.pages > 0 && f.pages < 1_000_000) e.pages = f.pages;
    if (typeof f.excerpt === 'string') e.excerpt = f.excerpt.slice(0, 280);
    files.push(e);
  }
  files.sort((a, b) => comparePaths(a.path, b.path));
  const dirs = new Set<string>();
  for (const d of Array.isArray(raw.dirs) ? raw.dirs : []) {
    const p = typeof d === 'string' ? safePath(d) : null;
    if (p) for (let x = p; x; x = dirName(x)) dirs.add(x);
  }
  for (const f of files) for (let p = dirName(f.path); p; p = dirName(p)) dirs.add(p);
  const name = (typeof raw.name === 'string' && safePath(raw.name)?.replace(/\//g, '-')) || 'dossier';
  return { v: 1, name, files, dirs: [...dirs].sort(compareDirs) };
}

/** A folder inside: its path, its name, what it holds (all levels below). */
export interface FolderDir {
  path: string;
  name: string;
  files: number;
  bytes: number;
}

/** What folder `dir` ("" for the top) holds directly: its folders, then its files. */
export function listDir(index: FolderIndex, dir: string): { dirs: FolderDir[]; files: FolderFile[] } {
  const prefix = dir ? dir + '/' : '';
  const dirs = new Map<string, FolderDir>();
  for (const d of index.dirs) {
    if (!d.startsWith(prefix) || d === dir) continue;
    const rest = d.slice(prefix.length);
    if (!rest.includes('/')) dirs.set(d, { path: d, name: rest, files: 0, bytes: 0 });
  }
  const files: FolderFile[] = [];
  for (const f of index.files) {
    if (!f.path.startsWith(prefix)) continue;
    const rest = f.path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash < 0) {
      files.push(f);
      continue;
    }
    const sub = dirs.get(prefix + rest.slice(0, slash));
    if (sub) {
      sub.files++;
      sub.bytes += f.size;
    }
  }
  return { dirs: [...dirs.values()].sort((a, b) => compareDirs(a.path, b.path)), files };
}

/** Every file under `dir` (all levels). */
export const filesUnder = (index: FolderIndex, dir: string) =>
  dir ? index.files.filter((f) => f.path.startsWith(dir + '/')) : index.files;

/** Every folder under `dir` (all levels), even empty ones. */
export const dirsUnder = (index: FolderIndex, dir: string) => (dir ? index.dirs.filter((d) => d.startsWith(dir + '/')) : index.dirs);

/** Only images and videos (and at least one): shown as a grid. */
export function isGallery(files: FolderFile[]): boolean {
  if (!files.length) return false;
  return files.every((f) => {
    const k = previewKind(baseName(f.path), f.mime);
    return k === 'image' || k === 'video';
  });
}

/** One file of the folder, as a content of its own (previews, players, downloads). */
export function fileReader(reader: ContentReader, file: FolderFile, own = true): ContentReader {
  return {
    size: file.size,
    name: baseName(file.path),
    mime: file.mime,
    read: (start, end) => reader.read(file.offset + Math.max(0, start), file.offset + Math.min(file.size, Math.max(0, end))),
    close: () => {
      if (own) reader.close();
    },
  };
}

/** The empty folders under `dir` (all levels): their files would not make them. */
export function emptyDirs(index: FolderIndex, dir = ''): string[] {
  const full = new Set<string>();
  for (const f of index.files) for (let p = dirName(f.path); p && !full.has(p); p = dirName(p)) full.add(p);
  return dirsUnder(index, dir).filter((d) => !full.has(d));
}

/** Bytes read from a file at once, to save it whole. */
const PIECE = 1024 * 1024;

/**
 * A file of the folder as a Blob, read a megabyte at a time (each piece becomes a part of the
 * Blob at once: never one buffer of the file's size). `onBytes`: bytes read so far.
 */
export async function readBlob(reader: ContentReader, file: FolderFile, onBytes?: (n: number) => void): Promise<Blob> {
  const parts: BlobPart[] = [];
  for (let at = 0; at < file.size; at += PIECE) {
    const data = await reader.read(file.offset + at, file.offset + Math.min(file.size, at + PIECE));
    parts.push(new Blob([data as BlobPart]));
    onBytes?.(at + data.length);
  }
  return new Blob(parts, { type: file.mime || 'application/octet-stream' });
}
