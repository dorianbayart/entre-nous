// Sending a folder: what was picked, dropped or copied becomes a list of files with their paths
// (system files left out), then an archive with a preview of every image, video and PDF, made
// here before the upload (the other devices browse it without downloading anything).
import { type ByteSource, type FolderIndex, type FolderSummary, type PackFile, buildPack, comparePaths, isSystemFile, safePath } from '../core/folder.ts';
import { previewKind } from '../core/media.ts';
import type { FolderSource, FolderSourceFile } from '../platform/types.ts';
import { IMAGE_PREVIEW_MAX, dataUrlBytes, mosaicOf, preview } from './previews.ts';

/** Above either, a folder is shown before it is sent, and a copied one is not sent by itself. */
export const FOLDER_CONFIRM_FILES = 10;
export const FOLDER_CONFIRM_BYTES = 40 * 1024 * 1024;

export const needsConfirm = (f: { files: unknown[]; bytes: number }) =>
  f.files.length > FOLDER_CONFIRM_FILES || f.bytes > FOLDER_CONFIRM_BYTES;

/** Bytes read at once from a file offered by an app's native side. */
const NATIVE_PIECE = 1024 * 1024;

/** Previews made at once. */
const PREVIEW_WORKERS = 2;

function fileOf(path: string, f: File): FolderSourceFile {
  return { path, size: f.size, mime: f.type, src: f, blob: async () => f };
}

/** A folder from its files and their paths ("Vacances/Jour 1/a.jpg"); its name: their first part. */
function assemble(name: string, entries: Array<{ path: string; file: FolderSourceFile }>, dirs: string[]): FolderSource {
  const files: FolderSourceFile[] = [];
  const seen = new Set<string>();
  let ignored = 0;
  for (const { path, file } of entries) {
    const p = safePath(path);
    if (!p || seen.has(p)) continue;
    if (isSystemFile(p)) {
      ignored++;
      continue;
    }
    seen.add(p);
    files.push({ ...file, path: p });
  }
  files.sort((a, b) => comparePaths(a.path, b.path));
  const empty = dirs.map((d) => safePath(d)).filter((d): d is string => !!d && !files.some((f) => f.path.startsWith(d + '/')));
  return { name, files, dirs: empty, ignored, bytes: files.reduce((n, f) => n + f.size, 0) };
}

/** <input webkitdirectory>: one folder, its files with their path under it. */
export function folderFromInput(list: FileList | File[]): FolderSource | null {
  const files = Array.from(list);
  if (!files.length) return null;
  const first = ((files[0] as any).webkitRelativePath as string) || files[0].name;
  const name = first.split('/')[0] || 'dossier';
  const entries = files.map((f) => {
    const rel: string = (f as any).webkitRelativePath || f.name;
    return { path: rel.startsWith(name + '/') ? rel.slice(name.length + 1) : rel, file: fileOf('', f) };
  });
  return assemble(name, entries, []);
}

/**
 * A drop: its folders and its loose files. The entries must be taken during the drop event
 * itself (they are gone after it): call this synchronously from the handler.
 */
export function droppedEntries(dt: DataTransfer | null): { folders: Promise<FolderSource[]>; files: File[] } {
  const dirs: any[] = [];
  const files: File[] = [];
  const items = Array.from(dt?.items ?? []);
  const entries = items.map((i) => (i.kind === 'file' ? ((i as any).webkitGetAsEntry?.() ?? null) : null));
  if (!entries.some((e) => e?.isDirectory)) return { folders: Promise.resolve([]), files: Array.from(dt?.files ?? []) };
  items.forEach((item, i) => {
    const e = entries[i];
    if (e?.isDirectory) dirs.push(e);
    else {
      const f = item.getAsFile();
      if (f) files.push(f);
    }
  });
  return { folders: Promise.all(dirs.map(readDirectory)), files };
}

/** A dropped folder (FileSystemDirectoryEntry), read all the way down. */
async function readDirectory(root: any): Promise<FolderSource> {
  const entries: Array<{ path: string; file: FolderSourceFile }> = [];
  const empty: string[] = [];
  const walk = async (dir: any, path: string) => {
    const reader = dir.createReader();
    let any = false;
    for (;;) {
      // a hundred at a time: until an empty batch
      const batch: any[] = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
      if (!batch.length) break;
      any = true;
      for (const e of batch) {
        const p = path ? `${path}/${e.name}` : e.name;
        if (e.isDirectory) await walk(e, p);
        else {
          const f: File = await new Promise((resolve, reject) => e.file(resolve, reject));
          entries.push({ path: p, file: fileOf(p, f) });
        }
      }
    }
    if (!any && path) empty.push(path);
  };
  await walk(root, '');
  return assemble(root.name || 'dossier', entries, empty);
}

/** A folder read by an app's native side: its files are read through tokens, piece by piece. */
export function folderFromNative(
  payload: { name: string; files: Array<{ token: string; path: string; size: number; mime: string }>; dirs?: string[]; truncated?: boolean },
  read: (token: string, offset: number, length: number) => Promise<Uint8Array>,
): FolderSource {
  const entries = payload.files.map((f) => {
    // a megabyte per call at most: the bridge carries it as text
    const src: ByteSource = {
      size: f.size,
      async read(start, end) {
        end = Math.min(end, f.size);
        if (end - start <= NATIVE_PIECE) return read(f.token, start, Math.max(0, end - start));
        const out = new Uint8Array(end - start);
        for (let at = start; at < end; at += NATIVE_PIECE) out.set(await read(f.token, at, Math.min(NATIVE_PIECE, end - at)), at - start);
        return out;
      },
    };
    const file: FolderSourceFile = {
      path: f.path,
      size: f.size,
      mime: f.mime === 'application/octet-stream' ? '' : f.mime,
      src,
      // only what a preview is made of, and not too big: read whole, here
      blob: async () => {
        if (f.size > IMAGE_PREVIEW_MAX || !previewKind(f.path, f.mime)) return null;
        return new Blob([(await src.read(0, f.size)) as BlobPart], { type: f.mime });
      },
    };
    return { path: f.path, file };
  });
  return { ...assemble(payload.name || 'dossier', entries, payload.dirs ?? []), truncated: !!payload.truncated };
}

/**
 * The archive of a folder, ready to send: a preview of each image, video and PDF (the start of
 * each text), made here; and the card of the history, its first previews.
 */
export async function prepareFolder(
  src: FolderSource,
  onProgress?: (done: number, total: number) => void,
): Promise<{ source: ByteSource; summary: FolderSummary; thumb?: string; index: FolderIndex }> {
  const files: PackFile[] = src.files.map((f) => ({ path: f.path, size: f.size, mime: f.mime || undefined, src: f.src }));
  const todo = src.files.map((f, i) => i).filter((i) => !!previewKind(src.files[i].path, src.files[i].mime));
  const urls = new Map<number, string>();
  const total = todo.length;
  let done = 0;
  onProgress?.(0, total);
  const worker = async () => {
    for (let i = todo.shift(); i !== undefined; i = todo.shift()) {
      const f = src.files[i];
      try {
        const blob = await f.blob();
        if (blob) {
          const name = f.path.split('/').pop() ?? f.path;
          const { extra } = await preview(blob.type ? blob : new Blob([blob], { type: f.mime }), name);
          const { thumb, w, h, duration, pages, excerpt } = extra;
          files[i].preview = { thumb: thumb ? dataUrlBytes(thumb) : undefined, w, h, duration, pages, excerpt };
          if (thumb) urls.set(i, thumb);
        }
      } catch {
        // sent without a preview
      }
      onProgress?.(++done, total);
    }
  };
  await Promise.all(Array.from({ length: PREVIEW_WORKERS }, worker));
  const { source, summary, index } = buildPack(src.name, files, src.dirs);
  // the first previews, in the folder's order
  const firsts = [...urls.keys()].sort((a, b) => a - b).map((i) => urls.get(i)!);
  const thumb = await mosaicOf(firsts).catch(() => undefined);
  return { source, summary, thumb, index };
}
