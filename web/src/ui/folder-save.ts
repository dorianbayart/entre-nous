// Saving files of a folder: the folder itself where the device can write one (the apps, and
// Chrome or Edge on a computer), otherwise a ZIP (Firefox, Safari, phones' browsers). The
// bytes are read piece by piece and written as they come.
import type { FolderSink, PlatformApi } from '../platform/types.ts';
import { ZipWriter } from '../core/zip.ts';

export interface SaveFile {
  /** Path in what is saved ("Jour 1/a.jpg"). */
  path: string;
  size: number;
  read(start: number, end: number): Promise<Uint8Array>;
}

/** Bytes read at once from a file being saved. */
const PIECE = 1024 * 1024;

export type SaveTarget = { kind: 'sink'; sink: FolderSink } | { kind: 'zip' };

/** Browsers' own folder picker (Chrome, Edge on a computer). */
const pickDirectory: ((o: object) => Promise<any>) | undefined =
  typeof window !== 'undefined' && 'showDirectoryPicker' in window && !/Android|iPhone|iPad/.test(navigator.userAgent)
    ? (o) => (window as any).showDirectoryPicker(o)
    : undefined;

/**
 * Where a folder named `name` goes: asked at once, while the tap still counts (a browser's
 * picker needs it). Null: cancelled.
 */
export async function chooseTarget(name: string, platform: Pick<PlatformApi, 'saveFolder'>): Promise<SaveTarget | null> {
  if (platform.saveFolder) {
    const sink = await platform.saveFolder(name);
    return sink ? { kind: 'sink', sink } : null;
  }
  if (pickDirectory) {
    let root: any;
    try {
      root = await pickDirectory({ mode: 'readwrite', id: 'entrenous' });
    } catch (err: any) {
      if (err?.name === 'AbortError') return null;
      return { kind: 'zip' }; // refused (a system folder…): a ZIP instead
    }
    return { kind: 'sink', sink: await browserSink(root, name) };
  }
  return { kind: 'zip' };
}

/** A new folder in `root` (the picked one): `name`, or `name (2)` if it exists. */
async function browserSink(root: any, name: string): Promise<FolderSink> {
  let dir: any;
  let made = name;
  for (let n = 1; ; n++) {
    made = n === 1 ? name : `${name} (${n})`;
    try {
      await root.getDirectoryHandle(made);
    } catch {
      dir = await root.getDirectoryHandle(made, { create: true });
      break;
    }
  }
  /** A name not taken yet in `d` ("a (2).txt"): two names that differ only by case are one here. */
  const free = async (d: any, name: string) => {
    const dot = name.lastIndexOf('.');
    const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
    for (let n = 1; ; n++) {
      const candidate = n === 1 ? name : `${stem} (${n})${ext}`;
      try {
        await d.getFileHandle(candidate);
      } catch {
        return candidate;
      }
    }
  };
  const dirOf = async (path: string) => {
    let d = dir;
    for (const part of path.split('/').filter(Boolean)) d = await d.getDirectoryHandle(part, { create: true });
    return d;
  };
  return {
    where: `${root.name}/${made}`,
    async file(path) {
      const at = path.lastIndexOf('/');
      const d = await dirOf(at < 0 ? '' : path.slice(0, at));
      const handle = await d.getFileHandle(await free(d, path.slice(at + 1)), { create: true });
      const w = await handle.createWritable();
      return { write: (data) => w.write(data), close: () => w.close() };
    },
    async dir(path) {
      await dirOf(path);
    },
  };
}

async function* pieces(f: SaveFile) {
  for (let at = 0; at < f.size; at += PIECE) yield await f.read(at, Math.min(f.size, at + PIECE));
}

/**
 * Writes `files` (and the empty folders `dirs`) where `target` says; `onBytes`: bytes written so
 * far. Resolves with where it went (a folder), or the ZIP to save.
 */
export async function writeFolder(
  target: SaveTarget,
  files: SaveFile[],
  dirs: string[],
  onBytes?: (done: number) => void,
): Promise<{ where: string } | { zip: Blob }> {
  let done = 0;
  const counted = async function* (f: SaveFile) {
    for await (const p of pieces(f)) {
      done += p.length;
      onBytes?.(done);
      yield p;
    }
  };
  if (target.kind === 'sink') {
    for (const d of dirs) await target.sink.dir(d);
    for (const f of files) {
      const out = await target.sink.file(f.path);
      try {
        for await (const p of counted(f)) await out.write(p);
      } finally {
        await out.close();
      }
    }
    return { where: target.sink.where };
  }
  const zip = new ZipWriter();
  for (const d of dirs) await zip.addDir(d);
  for (const f of files) await zip.addFile(f.path, f.size, counted(f));
  return { zip: await zip.finish() };
}
