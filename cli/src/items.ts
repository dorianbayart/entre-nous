// Items of the history: finding one, describing it, saving its content.
import { createWriteStream } from 'node:fs';
import { mkdir, open as openFile, stat } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Engine, ItemView } from '../../web/src/core/engine.ts';
import { duration, t, tn } from '../../web/src/i18n/index.ts';
import { CHUNK_SIZE } from '../../web/src/core/crypto.ts';
import { emptyDirs, readIndex } from '../../web/src/core/folder.ts';
import { ZipWriter } from '../../web/src/core/zip.ts';
import type { GroupView } from './context.ts';
import { CliError, EXIT, usageError } from './errors.ts';
import { tr } from './i18n.ts';
import { humanSize, oneLine, Progress } from './term.ts';

/** `ref`: a position (1 = the latest) or the beginning of an id. Without it: the latest. */
export function findItem(group: GroupView, ref?: string): ItemView {
  const items = group.items;
  if (!items.length) throw new CliError(tr('msg.noItem', { group: group.name }), EXIT.notFound);
  if (ref === undefined) return items[0];
  if (/^\d{1,4}$/.test(ref)) {
    const item = items[Number(ref) - 1];
    if (item) return item;
  }
  const matches = items.filter((i) => i.id.startsWith(ref));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw usageError(tr('err.ambiguousItem', { item: ref }));
  throw new CliError(tr('err.noSuchItem', { item: ref, group: group.name }), EXIT.notFound);
}

/** The JSON of an item: stable field names, dates in ISO 8601, sizes in bytes. */
export function itemJSON(item: ItemView, position?: number, extra: Record<string, unknown> = {}) {
  return {
    id: item.id,
    ...(position ? { position } : {}),
    kind: item.kind,
    from: item.fromName,
    fromDevice: item.from,
    mine: item.mine,
    createdAt: new Date(item.createdAt).toISOString(),
    expiresAt: new Date(item.expiresAt).toISOString(),
    ...(item.name ? { name: item.name } : {}),
    ...(item.mime ? { mime: item.mime } : {}),
    ...(item.size !== undefined && item.kind !== 'text' ? { size: item.size } : {}),
    ...(item.kind === 'folder' ? { files: item.files ?? 0, folders: item.dirs ?? 0 } : {}),
    // made by the sender: pixels of an image or a video, its length, pages of a PDF, the start of a text file
    ...(item.w && item.h ? { width: item.w, height: item.h } : {}),
    ...(item.duration ? { duration: item.duration } : {}),
    ...(item.pages ? { pages: item.pages } : {}),
    ...(item.excerpt ? { excerpt: item.excerpt } : {}),
    ...(item.text !== undefined ? { text: item.text } : {}),
    ...(item.pending ? { uploading: true } : {}),
    ...(item.local ? { localOnly: true } : {}),
    ...(item.error ? { error: item.error } : {}),
    ...extra,
  };
}

/** “2 min ago”, “just now”. */
export function ago(at: number) {
  const ms = Date.now() - at;
  return ms < 60_000 ? t('ago.now') : t('ago', { d: duration(ms) });
}

/** What an item holds, on one line: its text, or its name and size. */
export function summary(item: ItemView, width = 60): string {
  if (item.error) return '⚠ ' + t('item.undecryptable');
  if (item.text !== undefined) return '“' + oneLine(item.text, width) + '”';
  if (item.kind === 'folder') return `${oneLine((item.name || '—') + '/', width)} (${tn('folder.files', item.files ?? 0)}, ${humanSize(item.size)})`;
  const name = item.name || (item.kind === 'text' ? tr('msg.sentText') : '—');
  return `${oneLine(name, width)} (${humanSize(item.size)})`;
}

/**
 * A file name received from another device, made safe: no folder, no control character,
 * nothing hidden (“../../.bashrc” becomes “bashrc”).
 */
export function safeName(name: string | undefined, fallback: string): string {
  const clean = ((name ?? '').split(/[\\/]/).pop() ?? '')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/^[.\s]+/, '')
    .trim()
    .slice(0, 200);
  return clean || fallback;
}

/** Downloads an item's content (with a progress line), as text or as a Blob. */
export async function fetchContent(engine: Engine, groupId: string, item: ItemView) {
  if (item.error) throw new CliError(t('item.undecryptable'));
  const progress = new Progress(item.name || item.kind);
  const off = engine.on((e) => {
    if (e.type !== 'change') return;
    const transfer = engine.transfers.get(item.id);
    if (transfer) progress.update(transfer.done, transfer.total, transfer.rate);
  });
  try {
    return await engine.content(groupId, item.id);
  } finally {
    off();
    progress.end();
  }
}

/**
 * Writes `blob` to `output`: a folder (existing, or ending with /), a file name, or (no
 * output) the current folder. Never overwrites without `force`: “name (2).ext” instead,
 * created exclusively, so two downloads at once never write the same file.
 */
export async function saveBlob(blob: Blob, name: string, output: string | undefined, force: boolean): Promise<string> {
  let dir = process.cwd();
  let file = name;
  let exact = false; // a file name given: no other name, only --force
  if (output) {
    const isDir = /[\\/]$/.test(output) || (await stat(output).then((s) => s.isDirectory(), () => false));
    if (isDir) dir = resolve(output);
    else {
      dir = resolve(output, '..');
      file = basename(output);
      exact = true;
    }
  }
  const ext = extname(file);
  const stem = file.slice(0, file.length - ext.length);
  for (let n = 1; ; n++) {
    const path = join(dir, n === 1 ? file : `${stem} (${n})${ext}`);
    try {
      await pipeline(Readable.fromWeb(blob.stream() as any), createWriteStream(path, { flags: force ? 'w' : 'wx', mode: 0o644 }));
      return path;
    } catch (err: any) {
      if (err.code !== 'EEXIST') throw err;
      if (exact) throw new CliError(tr('err.exists', { path }));
    }
  }
}

/**
 * Saves a folder of the history: recreated under `output` (the current folder by default) as
 * “name”, or “name (2)” if it exists (--force: written into it); `-`: a ZIP on the standard
 * output. Its files are read and written piece by piece. Resolves with where it went.
 */
export async function saveFolder(engine: Engine, groupId: string, item: ItemView, output: string | undefined, force: boolean): Promise<string> {
  if (item.error) throw new CliError(t('item.undecryptable'));
  const progress = new Progress(item.name || 'dossier');
  const reader = engine.downloadReader(groupId, item.id, item.name ?? '', item.chunks);
  const off = engine.on((e) => {
    if (e.type !== 'change') return;
    const tr = [...engine.transfers.values()].find((x) => x.itemId === item.id && x.direction === 'down');
    if (tr) progress.update(tr.done, tr.total, tr.rate);
  });
  try {
    const index = await readIndex(reader);
    const pieces = async function* (f: (typeof index.files)[number]) {
      for (let at = 0; at < f.size; at += CHUNK_SIZE) yield await reader.read(f.offset + at, f.offset + Math.min(f.size, at + CHUNK_SIZE));
    };
    const empty = emptyDirs(index);
    if (output === '-') {
      // written as it arrives: nothing waits for the whole folder
      const zip = new ZipWriter(
        (data) =>
          new Promise<void>((ok, fail) => {
            process.stdout.write(data, (err) => (err ? fail(err) : ok()));
          }),
      );
      for (const d of empty) await zip.addDir(d);
      for (const f of index.files) await zip.addFile(f.path, f.size, pieces(f));
      await zip.finish();
      return '-';
    }
    const parent = output ? resolve(output) : process.cwd();
    await mkdir(parent, { recursive: true });
    const name = safeName(index.name, 'entrenous-' + item.id.slice(0, 8));
    let root = '';
    for (let n = 1; ; n++) {
      root = join(parent, n === 1 ? name : `${name} (${n})`);
      try {
        await mkdir(root);
        break;
      } catch (err: any) {
        if (err.code !== 'EEXIST') throw err;
        if (force) break;
      }
    }
    // the paths were checked when the index was read: no "..", nothing absolute
    const local = (p: string) => p.split('/').map(localName);
    for (const d of empty) await mkdir(join(root, ...local(d)), { recursive: true });
    for (const f of index.files) {
      const parts = local(f.path);
      const dir = join(root, ...parts.slice(0, -1));
      await mkdir(dir, { recursive: true });
      // two names that differ only by case are one file on some disks: "a (2).txt"
      const name = parts[parts.length - 1];
      const ext = extname(name);
      let out;
      for (let n = 1; ; n++) {
        try {
          out = await openFile(join(dir, n === 1 ? name : `${name.slice(0, name.length - ext.length)} (${n})${ext}`), force && n === 1 ? 'w' : 'wx', 0o644);
          break;
        } catch (err: any) {
          if (err.code !== 'EEXIST') throw err;
        }
      }
      try {
        for await (const p of pieces(f)) await out.write(p);
      } finally {
        await out.close();
      }
    }
    return root;
  } finally {
    off();
    progress.end();
    reader.close();
  }
}

/** Windows: its reserved names (CON, NUL, COM1…) and characters; elsewhere, the name as it is. */
function localName(part: string): string {
  if (process.platform !== 'win32') return part;
  const clean = part.replace(/[<>:"|?*\\]/g, '-').replace(/[. ]+$/, '') || '-';
  return /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(clean) ? '_' + clean : clean;
}
