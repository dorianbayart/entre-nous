// The commands. Each one: its help, its options, and what it does. Results go to stdout
// (plain, or JSON with --json); messages and progress go to stderr.
import { openAsBlob } from 'node:fs';
import { readdir, rm, rmdir, stat } from 'node:fs/promises';
import { basename, extname, join as joinPath } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ItemView, NoteView } from '../../web/src/core/engine.ts';
import { duration, storageSpace, t, tn } from '../../web/src/i18n/index.ts';
import { decodeStart, excerptOf, isText } from '../../web/src/core/media.ts';
import { readClipboard, writeClipboard } from './clipboard.ts';
import { type Context, DEFAULT_RELAY, type GroupView, relayUrl } from './context.ts';
import { CliError, EXIT, usageError } from './errors.ts';
import { type CliKey, tr } from './i18n.ts';
import { ago, fetchContent, findItem, itemJSON, safeName, saveBlob, saveFolder, summary, ticks } from './items.ts';
import { type PackFile, buildPack, isSystemFile } from '../../web/src/core/folder.ts';
import { confirm, err, errTTY, humanSize, out, outTTY, parseDuration, print, Progress, qr, say, table } from './term.ts';

export interface Option {
  type: 'string' | 'boolean';
  short?: string;
  /** Name of its value in the help (translated by placeholders). */
  arg?: string;
  desc: CliKey;
  descVars?: Record<string, string>;
}

export interface Command {
  name: string;
  aliases?: string[];
  section: 'share' | 'devices';
  /** Its arguments, as in the usage line (placeholders in capitals). */
  args: string;
  summary: CliKey;
  long?: CliKey;
  options: Record<string, Option>;
  examples: string[];
  /** Resolves with the exit code (0 when nothing is returned). */
  run(ctx: Context, args: string[], o: Record<string, any>): Promise<number | void>;
}

// ------------------------------------------------------------------ shared bits

const json = (v: unknown) => print(JSON.stringify(v) + '\n');
/** A text on stdout, with a final line break on a terminal only (a pipe gets the exact text). */
const printText = (text: string) => print(outTTY && !text.endsWith('\n') ? text + '\n' : text);

const timeoutOpt: Option = { type: 'string', arg: 'DURATION', desc: 'opt.timeout' };
const outputOpt: Option = { type: 'string', short: 'o', arg: 'PATH', desc: 'opt.output' };
const forceOpt: Option = { type: 'boolean', short: 'f', desc: 'opt.force' };
const clipboardGetOpt: Option = { type: 'boolean', short: 'c', desc: 'opt.clipboardGet' };
const yesOpt: Option = { type: 'boolean', short: 'y', desc: 'opt.yes' };

function timeoutOf(o: Record<string, any>): number | undefined {
  if (o.timeout === undefined) return undefined;
  const ms = parseDuration(o.timeout);
  if (ms === null) throw usageError(tr('err.badDuration', { value: o.timeout }));
  return ms;
}

function needArgs(args: string[], min: number, max: number, usage: string) {
  if (args.length < min || args.length > max) throw usageError(tr('err.usage', { usage }));
}

/** Asks before something that cannot be undone: --yes, or a yes on the terminal. */
async function confirmed(question: string, yes: boolean) {
  if (yes) return;
  if (!process.stdin.isTTY) throw usageError(tr('err.needsYes'));
  if (!(await confirm(question))) throw new CliError(tr('err.notConfirmed'));
}

/** This CLI only goes through the relay: a "local network only" group is out of its reach. */
function relayed(group: GroupView) {
  if (group.localOnly) throw new CliError(tr('err.localOnly', { group: group.name }));
}

/**
 * Rejects with `error` (by default, the timeout error) after `ms`; never without `ms`. Once the
 * race it is in is won by something else, it no longer matters: its rejection is handled.
 */
function deadline(ms: number | undefined, error = () => new CliError(tr('err.timeout'), EXIT.timeout)): Promise<never> {
  const p = new Promise<never>((_, reject) => {
    if (ms !== undefined) setTimeout(() => reject(error()), ms).unref();
  });
  p.catch(() => {});
  return p;
}

const MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.heic': 'image/heic', '.avif': 'image/avif', '.svg': 'image/svg+xml', '.bmp': 'image/bmp',
  '.pdf': 'application/pdf', '.zip': 'application/zip', '.gz': 'application/gzip', '.tar': 'application/x-tar',
  '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.json': 'application/json', '.html': 'text/html',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4',
  '.markdown': 'text/markdown', '.log': 'text/plain', '.yaml': 'application/yaml', '.yml': 'application/yaml', '.xml': 'application/xml',
  '.wav': 'audio/wav', '.apk': 'application/vnd.android.package-archive', '.dmg': 'application/x-apple-diskimage',
  '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.odt': 'application/vnd.oasis.opendocument.text',
};
// images the apps can show (not SVG: shown as a file, never rendered)
const IMAGE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/heic', 'image/avif', 'image/bmp']);

async function readStdin(): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

/** UTF-8 text without NUL: sent as a text; anything else as a file. */
function asText(bytes: Buffer): string | null {
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** Does what `get` does with an item: prints a text, saves a file. */
async function deliver(ctx: Context, group: GroupView, item: ItemView, o: Record<string, any>, position?: number) {
  const engine = await ctx.engine();
  if (item.kind === 'folder') {
    if (o.clipboard) throw new CliError(tr('err.textOnly'));
    // the folder recreated (or a ZIP on the standard output)
    const path = await saveFolder(engine, group.id, item, o.output, !!o.force);
    if (path === '-') return;
    if (ctx.g.json) await json(itemJSON(item, position, { path }));
    else await print(path + '\n');
    return;
  }
  if (o.clipboard) {
    if (item.kind !== 'text') throw new CliError(tr('err.textOnly'));
    const c = await fetchContent(engine, group.id, item);
    await writeClipboard(c.text ?? '');
    if (ctx.g.json) await json(itemJSON(item, position, { text: c.text, clipboard: true }));
    else say(err.green('✓ ') + t('toast.copied'));
    return;
  }
  const c = await fetchContent(engine, group.id, item);
  if (item.kind === 'text' && c.text !== undefined) {
    if (o.output && o.output !== '-') {
      const path = await saveBlob(new Blob([c.text]), `entrenous-${item.id.slice(0, 8)}.txt`, o.output, !!o.force);
      if (ctx.g.json) await json(itemJSON(item, position, { text: c.text, path }));
      else say(tr('msg.saved', { path }));
      return;
    }
    if (ctx.g.json) await json(itemJSON(item, position, { text: c.text }));
    else await printText(c.text);
    return;
  }
  const blob = c.blob!;
  if (o.output === '-') {
    await pipeline(Readable.fromWeb(blob.stream() as any), process.stdout, { end: false });
    return;
  }
  const path = await saveBlob(blob, safeName(c.name, 'entrenous-' + item.id.slice(0, 8)), o.output, !!o.force);
  if (ctx.g.json) await json(itemJSON(item, position, { path }));
  else await print(path + '\n');
}

// ------------------------------------------------------------------ share

const send: Command = {
  name: 'send',
  section: 'share',
  args: '[FILE…]',
  summary: 'cmd.send',
  long: 'cmd.send.long',
  options: {
    message: { type: 'string', short: 'm', arg: 'TEXT', desc: 'opt.send.message' },
    clipboard: { type: 'boolean', short: 'c', desc: 'opt.send.clipboard' },
    name: { type: 'string', arg: 'NAME', desc: 'opt.send.name' },
  },
  examples: [
    'entrenous send report.pdf photo.jpg',
    'entrenous send ~/Photos/Vacances/',
    'entrenous send -m "https://example.com/build/42"',
    'git diff | entrenous send',
    'pg_dump app | gzip | entrenous send --name app.sql.gz',
    'entrenous send --clipboard',
  ],
  async run(ctx, args, o) {
    // what to send, checked before connecting
    const files: { path: string; size: number; dir?: boolean }[] = [];
    for (const path of args) {
      const s = await stat(path).catch(() => null);
      if (!s) throw usageError(tr('err.noSuchFile', { path }));
      files.push({ path, size: s.size, dir: s.isDirectory() });
    }
    const texts: string[] = [];
    if (o.message !== undefined) texts.push(o.message);
    if (o.clipboard) {
      const text = await readClipboard();
      if (!text) throw new CliError(tr('err.clipboardEmpty'));
      texts.push(text);
    }
    let piped: { text: string } | { blob: Blob; name: string } | undefined;
    if (!files.length && !texts.length) {
      if (process.stdin.isTTY) throw usageError(tr('err.nothingToSend'));
      const bytes = await readStdin();
      if (!bytes.length) throw usageError(tr('err.nothingToSend'));
      const text = o.name === undefined ? asText(bytes) : null;
      piped = text !== null ? { text } : { blob: new Blob([new Uint8Array(bytes)], { type: MIME[extname(o.name ?? '').toLowerCase()] ?? 'application/octet-stream' }), name: o.name ?? 'stdin' };
    }

    const group = await ctx.group();
    relayed(group);
    const engine = await ctx.engine();
    await ctx.connect(group.id);
    const sent: unknown[] = [];
    const done = async (id: string, what: string, extra: Record<string, unknown>) => {
      sent.push({ id, ...extra });
      say(err.green('✓ ') + tr('msg.sent', { group: group.name, what }));
    };

    const sendBlob = async (blob: Blob, name: string) => {
      const mime = blob.type;
      const progress = new Progress(name);
      const off = engine.on((e) => {
        if (e.type !== 'change') return;
        const up = [...engine.transfers.values()].find((x) => x.direction === 'up' && x.groupId === group.id && !x.direct);
        if (up) progress.update(up.done, up.total, up.rate);
      });
      try {
        // a text file: its first characters, shown under its name in the apps (no image is
        // decoded here: no thumbnail, the apps show an icon)
        const extra = isText(name, mime) ? { excerpt: excerptOf(decodeStart(new Uint8Array(await blob.slice(0, 4096).arrayBuffer()), blob.size <= 4096)) || undefined } : {};
        const id = await engine.sendBlob(group.id, blob, name, IMAGE.has(mime) ? 'image' : 'file', extra);
        progress.end();
        await done(id, `${name} (${humanSize(blob.size)})`, { kind: IMAGE.has(mime) ? 'image' : 'file', name, size: blob.size });
      } finally {
        off();
        progress.end();
      }
    };

    for (const text of texts) {
      const id = await engine.sendText(group.id, text);
      await done(id, '“' + text.replace(/\s+/g, ' ').slice(0, 40) + (text.length > 40 ? '…' : '') + '”', { kind: 'text' });
    }
    if (piped && 'text' in piped) {
      const id = await engine.sendText(group.id, piped.text);
      await done(id, tr('msg.sentText') + ` (${humanSize(Buffer.byteLength(piped.text))})`, { kind: 'text' });
    } else if (piped) await sendBlob(piped.blob, piped.name);
    // a folder: one item, its files with their paths (system files left out)
    const sendFolder = async (root: string) => {
      const name = basename(root.replace(/[\\/]+$/, '')) || 'dossier';
      const pack: PackFile[] = [];
      const empty: string[] = [];
      const walk = async (dir: string, rel: string) => {
        const entries = await readdir(dir, { withFileTypes: true });
        if (!entries.length && rel) empty.push(rel);
        for (const e of entries) {
          const p = rel ? `${rel}/${e.name}` : e.name;
          if (e.isDirectory()) await walk(joinPath(dir, e.name), p);
          else if (e.isFile() && !isSystemFile(p)) {
            const full = joinPath(dir, e.name);
            const mime = MIME[extname(e.name).toLowerCase()];
            const blob = await openAsBlob(full, mime ? { type: mime } : {});
            const excerpt = isText(e.name, mime) ? excerptOf(decodeStart(new Uint8Array(await blob.slice(0, 4096).arrayBuffer()), blob.size <= 4096)) || undefined : undefined;
            pack.push({ path: p, size: blob.size, mime, src: blob, preview: excerpt ? { excerpt } : undefined });
          }
        }
      };
      await walk(root, '');
      const { source, summary } = buildPack(name, pack, empty);
      const progress = new Progress(name);
      const off = engine.on((e) => {
        if (e.type !== 'change') return;
        const up = [...engine.transfers.values()].find((x) => x.direction === 'up' && x.groupId === group.id && !x.direct);
        if (up) progress.update(up.done, up.total, up.rate);
      });
      try {
        const id = await engine.sendBlob(group.id, source, name, 'folder', { folder: summary });
        progress.end();
        await done(id, `${name}/ (${tn('folder.files', summary.files) + ', ' + humanSize(summary.bytes)})`, { kind: 'folder', name, files: summary.files, size: summary.bytes });
      } finally {
        off();
        progress.end();
      }
    };

    for (const f of files) {
      if (f.dir) {
        await sendFolder(f.path);
        continue;
      }
      const name = basename(f.path);
      const blob = await openAsBlob(f.path, { type: MIME[extname(name).toLowerCase()] ?? 'application/octet-stream' });
      await sendBlob(blob, name);
    }
    if (ctx.g.json) await json(sent.length === 1 ? sent[0] : sent);
  },
};

const get: Command = {
  name: 'get',
  section: 'share',
  args: '[ITEM]',
  summary: 'cmd.get',
  long: 'cmd.get.long',
  options: { output: outputOpt, force: forceOpt, clipboard: clipboardGetOpt },
  examples: ['entrenous get', 'entrenous get 2 -o ~/Downloads/', 'entrenous get --clipboard', 'entrenous get -o - | tar x', 'entrenous get -o - > folder.zip', 'entrenous get --json'],
  async run(ctx, args, o) {
    needArgs(args, 0, 1, 'entrenous get [ITEM]');
    const group = await ctx.group();
    await ctx.connect(group.id);
    const view = await ctx.view(group.id);
    const item = findItem(view, args[0]);
    await deliver(ctx, view, item, o, view.items.indexOf(item) + 1);
  },
};

const list: Command = {
  name: 'list',
  aliases: ['ls'],
  section: 'share',
  args: '',
  summary: 'cmd.list',
  long: 'cmd.list.long',
  options: { limit: { type: 'string', short: 'n', arg: 'N', desc: 'opt.list.limit' } },
  examples: ['entrenous list', 'entrenous list -n 3', "entrenous list --json | jq -r '.[0].text'"],
  async run(ctx, args, o) {
    needArgs(args, 0, 0, 'entrenous list');
    let limit = Infinity;
    if (o.limit !== undefined) {
      limit = Number(o.limit);
      if (!Number.isInteger(limit) || limit < 0) throw usageError(tr('err.badNumber', { value: o.limit }));
    }
    const group = await ctx.group();
    await ctx.connect(group.id);
    const items = (await ctx.view(group.id)).items.slice(0, limit);
    if (ctx.g.json) return void (await json(items.map((it, i) => itemJSON(it, i + 1))));
    if (!items.length) return say(tr('msg.noItem', { group: group.name }));
    const width = Math.max(20, (process.stdout.columns || 100) - 40);
    const rows = items.map((it, i) => [
      out.bold(String(i + 1)),
      it.mine ? out.dim(t('me')) : it.fromName,
      out.dim(ago(it.createdAt)) + ticks(it, out.green, out.dim),
      summary(it, width) + (it.pending ? out.dim(' · ' + t('left.sending')) : ''),
    ]);
    await print(table(rows));
  },
};

const wait: Command = {
  name: 'wait',
  section: 'share',
  args: '',
  summary: 'cmd.wait',
  long: 'cmd.wait.long',
  options: { timeout: timeoutOpt, note: { type: 'boolean', desc: 'opt.wait.note' }, output: outputOpt, force: forceOpt, clipboard: clipboardGetOpt },
  examples: ['entrenous wait', 'entrenous wait --timeout 10m -o ~/Downloads/', 'entrenous wait --note --timeout 1h'],
  async run(ctx, args, o) {
    needArgs(args, 0, 0, 'entrenous wait');
    const ms = timeoutOf(o);
    const group = await ctx.group();
    relayed(group);
    const engine = await ctx.engine();
    // listening before connecting: an item arriving meanwhile is not missed
    let seen: ItemView | undefined;
    let wake = () => {};
    const off = engine.on((e) => {
      if (e.type === 'incoming' && e.groupId === group.id && !seen) {
        seen = e.item;
        wake();
      } else if (e.type === 'change') wake();
    });
    const limit = deadline(ms); // one limit for connecting and waiting
    await Promise.race([ctx.connect(group.id), limit]);
    const noteKey = (n: NoteView | null) => (n ? `${n.at}:${n.by}` : '');
    const before = noteKey((await ctx.view(group.id)).note);
    say(err.dim(tr(o.note ? 'msg.waitingNote' : 'msg.waiting', { group: group.name })));
    const arrived = new Promise<void>((resolve) => {
      const check = async () => {
        if (o.note) {
          const n = (await ctx.view(group.id)).note;
          if (noteKey(n) !== before && !n?.mine) resolve();
        } else if (seen) resolve();
      };
      wake = () => void check();
      check();
    });
    await Promise.race([arrived, limit]);
    off();
    if (o.note) {
      const n = (await ctx.view(group.id)).note;
      if (ctx.g.json) return void (await json(n ? { text: n.text, by: n.byName, at: new Date(n.at).toISOString() } : { text: '' }));
      return void (await printText(n?.text ?? ''));
    }
    const view = await ctx.view(group.id);
    const item = view.items.find((i) => i.id === seen!.id) ?? seen!;
    await deliver(ctx, view, item, o, view.items.indexOf(item) + 1 || undefined);
  },
};

const watch: Command = {
  name: 'watch',
  section: 'share',
  args: '',
  summary: 'cmd.watch',
  long: 'cmd.watch.long',
  options: { output: { type: 'string', short: 'o', arg: 'FOLDER', desc: 'opt.watch.output' } },
  examples: ['entrenous watch', 'entrenous watch -o ~/Downloads/entrenous/', 'entrenous watch --json | jq --unbuffered -r .text'],
  async run(ctx, args, o) {
    needArgs(args, 0, 0, 'entrenous watch');
    const group = await ctx.group();
    relayed(group);
    const engine = await ctx.engine();
    if (o.output) {
      const s = await stat(o.output).catch(() => null);
      if (!s?.isDirectory()) throw usageError(tr('err.noSuchFile', { path: o.output }));
    }
    // one item after the other, in their order of arrival
    let queue = Promise.resolve();
    engine.on((e) => {
      if (e.type !== 'incoming' || e.groupId !== group.id) return;
      const item = e.item;
      queue = queue.then(async () => {
        let path: string | undefined;
        if (o.output && item.kind !== 'text') {
          try {
            if (item.kind === 'folder') path = await saveFolder(engine, group.id, item, o.output, false);
            else {
              const c = await fetchContent(engine, group.id, item);
              path = await saveBlob(c.blob!, safeName(c.name, 'entrenous-' + item.id.slice(0, 8)), o.output + '/', false);
            }
          } catch (e: any) {
            say(err.red('✗ ') + (item.name ?? '') + ': ' + (e.message ?? e));
          }
        }
        if (ctx.g.json) return json(itemJSON(item, undefined, path ? { path } : {}));
        const head = out.dim(`${new Date().toLocaleTimeString()} ${item.fromName}:`);
        const body = item.text !== undefined ? item.text : path ? path : `${summary(item)}  ${out.dim(tr('msg.getIt', { id: item.id.slice(0, 8) }))}`;
        return print(`${head} ${body}\n`);
      });
    });
    await ctx.connect(group.id);
    say(err.dim(tr('msg.watching', { group: group.name })));
    await new Promise(() => {}); // until Ctrl-C
  },
};

const NOTE_MAX = 60_000; // characters, as in the apps

const note: Command = {
  name: 'note',
  section: 'share',
  args: '[TEXT | -]',
  summary: 'cmd.note',
  long: 'cmd.note.long',
  options: { clear: { type: 'boolean', desc: 'opt.note.clear' } },
  examples: ['entrenous note', 'entrenous note "Wi-Fi: hunter2"', 'cat todo.md | entrenous note -', 'entrenous note --clear'],
  async run(ctx, args, o) {
    needArgs(args, 0, 1, 'entrenous note [TEXT | -]');
    const group = await ctx.group();
    const engine = await ctx.engine();
    let text: string | undefined = o.clear ? '' : args[0];
    if (text === '-') text = (await readStdin()).toString('utf8').replace(/\n$/, '');
    if (text !== undefined && text.length > NOTE_MAX) throw usageError(tr('err.noteTooLong', { n: text.length, max: NOTE_MAX }));
    await ctx.connect(group.id);
    if (text === undefined) {
      const n = (await ctx.view(group.id)).note;
      if (ctx.g.json) return void (await json(n ? { text: n.text, by: n.byName, at: new Date(n.at).toISOString(), expiresAt: new Date(n.expiresAt).toISOString() } : null));
      if (!n?.text) return say(tr('msg.noNote', { group: group.name }));
      return void (await printText(n.text));
    }
    engine.setNote(group.id, text);
    await engine.noteSent(group.id);
    say(err.green('✓ ') + tr(text ? 'msg.noteSet' : 'msg.noteCleared', { group: group.name }));
  },
};

const rmCmd: Command = {
  name: 'rm',
  aliases: ['delete'],
  section: 'share',
  args: 'ITEM… | --all',
  summary: 'cmd.rm',
  long: 'cmd.rm.long',
  options: { all: { type: 'boolean', desc: 'opt.rm.all' }, yes: yesOpt },
  examples: ['entrenous rm 1', 'entrenous rm 2 3', 'entrenous rm --all --yes'],
  async run(ctx, args, o) {
    if (!o.all && !args.length) throw usageError(tr('err.usage', { usage: 'entrenous rm ITEM… | --all' }));
    const group = await ctx.group();
    const engine = await ctx.engine();
    await ctx.connect(group.id);
    if (o.all) {
      await confirmed(tr('msg.confirmClear', { group: group.name }), !!o.yes);
      await engine.clearAll(group.id);
      return say(err.green('✓ ') + tr('msg.cleared', { group: group.name }));
    }
    const view = await ctx.view(group.id);
    const items = args.map((ref) => findItem(view, ref)); // all found before deleting any
    for (const item of new Set(items)) await engine.deleteItem(group.id, item.id);
    if (ctx.g.json) await json(items.map((i) => i.id));
    say(err.green('✓ ') + tr('msg.deleted', { n: items.map((i) => summary(i, 30)).join(', ') }));
  },
};

// ------------------------------------------------------------------ devices and groups

const join: Command = {
  name: 'join',
  section: 'devices',
  args: 'LINK',
  summary: 'cmd.join',
  long: 'cmd.join.long',
  options: { name: { type: 'string', arg: 'NAME', desc: 'opt.join.name' } },
  examples: ["entrenous join 'https://entrenous.0xdba.dev/app/#p=…'", "entrenous join --name build-server 'https://…/app/#p=…'"],
  async run(ctx, args, o) {
    needArgs(args, 1, 1, 'entrenous join LINK');
    const engine = await ctx.engine();
    if (o.name) await engine.renameDevice(o.name);
    let id: string;
    try {
      id = await engine.join(args[0]);
    } catch (e: any) {
      throw new CliError(t('err.pairFailed', { msg: e.message ?? e }), e.message === t('err.inviteExpired') ? EXIT.timeout : EXIT.error);
    }
    // connected once: the others learn its keys, and can send to it at once
    await ctx.connect(id);
    if (!(await ctx.defaultGroupId()) || engine.groups.length === 1) await ctx.setConfig({ group: id });
    const group = await ctx.view(id);
    if (ctx.g.json) await json({ id, name: group.name });
    say(err.green('✓ ') + tr('msg.joined', { group: group.name }));
  },
};

const invite: Command = {
  name: 'invite',
  section: 'devices',
  args: '',
  summary: 'cmd.invite',
  long: 'cmd.invite.long',
  options: { 'no-qr': { type: 'boolean', desc: 'opt.invite.noQr' } },
  examples: ['entrenous invite', 'entrenous invite --group Work --no-qr'],
  async run(ctx, args, o) {
    needArgs(args, 0, 0, 'entrenous invite');
    const group = await ctx.group();
    const engine = await ctx.engine();
    await ctx.connect(group.id); // the new member is published on the relay at once
    let joined: (name: string) => void = () => {};
    const done = new Promise<string>((resolve) => (joined = resolve));
    const inv = engine.invite(group.id, (name) => joined(name));
    try {
      if (ctx.g.json) await json({ url: inv.url, expiresAt: new Date(inv.expiresAt).toISOString() });
      else {
        if (errTTY && !o['no-qr']) process.stderr.write('\n' + qr(inv.url) + '\n');
        await print(inv.url + '\n');
        say(err.dim(tr('msg.inviteValid', { left: duration(inv.expiresAt - Date.now()) })));
      }
      const name = await Promise.race([done, deadline(inv.expiresAt - Date.now(), () => new CliError(tr('err.inviteExpired'), EXIT.timeout))]);
      if (ctx.g.json) await json({ joined: name });
      say(err.green('✓ ') + tr('msg.inviteJoined', { name, group: group.name }));
    } finally {
      inv.cancel();
    }
  },
};

const create: Command = {
  name: 'create',
  section: 'devices',
  args: '[NAME]',
  summary: 'cmd.create',
  long: 'cmd.create.long',
  options: { relay: { type: 'string', arg: 'URL', desc: 'opt.create.relay', descVars: { relay: DEFAULT_RELAY } } },
  examples: ['entrenous create', 'entrenous create Work --relay https://relay.example.com'],
  async run(ctx, args, o) {
    needArgs(args, 0, 1, 'entrenous create [NAME]');
    const engine = await ctx.engine();
    const relay = o.relay ? relayUrl(o.relay) : undefined;
    // checked first: a group on a relay that cannot be reached is of no use
    const target = relay ?? relayUrl(process.env.ENTRENOUS_RELAY || DEFAULT_RELAY);
    const up = await fetch(target + '/healthz', { signal: AbortSignal.timeout(10_000) }).then((r) => r.ok, () => false);
    if (!up) throw new CliError(tr('err.unreachable', { relay: target }), EXIT.unreachable);
    const id = await engine.createGroup(args[0] || t('group.default'), relay);
    await ctx.connect(id);
    if (!(await ctx.defaultGroupId()) || engine.groups.length === 1) await ctx.setConfig({ group: id });
    const group = await ctx.view(id);
    if (ctx.g.json) await json({ id, name: group.name, relay: group.relay });
    say(err.green('✓ ') + tr('msg.created', { group: group.name }));
  },
};

const groups: Command = {
  name: 'groups',
  section: 'devices',
  args: '',
  summary: 'cmd.groups',
  options: {},
  examples: ['entrenous groups', 'entrenous groups --json'],
  async run(ctx, args) {
    needArgs(args, 0, 0, 'entrenous groups');
    const engine = await ctx.engine();
    const def = await ctx.defaultGroupId();
    const all = engine.groups;
    const isDefault = (g: GroupView) => g.id === def || (all.length === 1 && !def);
    if (ctx.g.json) {
      return void (await json(all.map((g) => ({ id: g.id, name: g.name, relay: g.relay, default: isDefault(g), devices: g.members.map((m) => ({ id: m.id, name: m.name, platform: m.platform, me: m.me })) }))));
    }
    if (!all.length) return say(tr('err.noGroup'));
    const rows = all.map((g) => [
      isDefault(g) ? out.green('●') : ' ',
      out.bold(g.name),
      out.dim(g.id.slice(0, 8)),
      t(g.members.length < 2 ? 'devices.one' : 'devices.other', { n: g.members.length }),
      out.dim(g.relay),
    ]);
    await print(table(rows));
  },
};

const use: Command = {
  name: 'use',
  section: 'devices',
  args: 'GROUP',
  summary: 'cmd.use',
  options: {},
  examples: ['entrenous use Work'],
  async run(ctx, args) {
    needArgs(args, 1, 1, 'entrenous use GROUP');
    const group = await ctx.findGroup(args[0]);
    await ctx.setConfig({ group: group.id });
    say(err.green('✓ ') + tr('msg.default', { group: group.name }));
  },
};

const leave: Command = {
  name: 'leave',
  section: 'devices',
  args: '[GROUP]',
  summary: 'cmd.leave',
  long: 'cmd.leave.long',
  options: { yes: yesOpt },
  examples: ['entrenous leave Work'],
  async run(ctx, args, o) {
    needArgs(args, 0, 1, 'entrenous leave [GROUP]');
    const group = await ctx.group(args[0] ?? ctx.g.group);
    await confirmed(tr('msg.confirmLeave', { group: group.name }), !!o.yes);
    const engine = await ctx.engine();
    await ctx.connect(group.id);
    await engine.removeMember(group.id, engine.device.id);
    if ((await ctx.defaultGroupId()) === group.id) await ctx.setConfig({ group: undefined });
    say(err.green('✓ ') + tr('msg.left', { group: group.name }));
  },
};

const status: Command = {
  name: 'status',
  aliases: ['info'],
  section: 'devices',
  args: '',
  summary: 'cmd.status',
  options: {},
  examples: ['entrenous status', 'entrenous status --json'],
  async run(ctx, args) {
    needArgs(args, 0, 0, 'entrenous status');
    const engine = await ctx.engine();
    const def = await ctx.defaultGroupId();
    // every group at once; one that cannot be reached shows offline
    await Promise.all(engine.groups.map((g) => ctx.connect(g.id, 8000).catch(() => {})));
    const all = engine.groups;
    if (ctx.g.json) {
      return void (await json({
        device: { id: engine.device.id, name: engine.device.name, platform: engine.device.platform },
        home: ctx.g.home,
        version: __VERSION__,
        groups: all.map((g) => ({
          id: g.id,
          name: g.name,
          relay: g.relay,
          default: g.id === def || (all.length === 1 && !def),
          connected: g.status === 'online',
          ttl: g.ttl,
          maxItems: g.maxItems,
          localOnly: g.localOnly,
          storage: g.storage,
          devices: g.members.map((m) => ({ id: m.id, name: m.name, platform: m.platform, me: m.me, online: m.online })),
        })),
      }));
    }
    let s = `${out.bold(tr('msg.device'))}  ${engine.device.name} ${out.dim('(' + engine.device.id.slice(0, 8) + ')')}\n`;
    s += `${out.bold(tr('msg.home'))}  ${out.dim(ctx.g.home)}\n`;
    if (!all.length) s += '\n' + tr('err.noGroup') + '\n';
    for (const g of all) {
      const dflt = g.id === def || (all.length === 1 && !def) ? out.green(' ● ' + tr('msg.default.mark')) : '';
      s += `\n${out.bold(g.name)}${dflt}  ${g.status === 'online' ? out.green(tr('msg.online')) : out.dim(tr('msg.offline'))}\n`;
      const rows = [
        [out.dim(tr('msg.relay')), g.relay],
        [out.dim(tr('msg.keep')), duration(g.ttl * 1000)],
      ];
      if (g.storage?.limit) rows.push([out.dim(tr('msg.space')), storageSpace(g.storage.used, g.storage.limit)]);
      s += table(rows).replace(/^(?=.)/gm, '  ');
      s += `  ${out.dim(tr('msg.members'))}\n`;
      s += table(
        g.members.map((m) => [
          m.online ? out.green('●') : out.dim('○'),
          m.name + (m.me ? out.dim(' (' + tr('msg.you') + ')') : ''),
          out.dim(platformLabel(m.platform)),
        ]),
      ).replace(/^(?=.)/gm, '    ');
    }
    await print(s);
  },
};

const PLATFORMS: Record<string, string> = { mac: 'Mac', linux: 'Linux', windows: 'Windows', android: 'Android', ios: 'iOS', cli: 'Terminal' };
const platformLabel = (p: string) => PLATFORMS[p] ?? t('device.browser');

const name: Command = {
  name: 'name',
  section: 'devices',
  args: 'NAME',
  summary: 'cmd.name',
  options: {},
  examples: ['entrenous name "build-server"'],
  async run(ctx, args) {
    needArgs(args, 1, 1, 'entrenous name NAME');
    const engine = await ctx.engine();
    // connected: the other devices see the new name at once
    await Promise.all(engine.groups.map((g) => ctx.connect(g.id, 8000).catch(() => {})));
    await engine.renameDevice(args[0]);
    say(err.green('✓ ') + tr('msg.renamed', { name: args[0] }));
  },
};

const reset: Command = {
  name: 'reset',
  section: 'devices',
  args: '',
  summary: 'cmd.reset',
  long: 'cmd.reset.long',
  options: { yes: yesOpt },
  examples: ['entrenous reset --yes'],
  async run(ctx, args, o) {
    needArgs(args, 0, 0, 'entrenous reset');
    await confirmed(tr('msg.confirmReset'), !!o.yes);
    const engine = await ctx.engine();
    await Promise.all(engine.groups.map((g) => ctx.connect(g.id, 8000).catch(() => {})));
    await engine.reset();
    await ctx.close();
    // only its own files: the folder may have been given by --home
    const home = ctx.g.home;
    for (const f of ['device.json', 'groups.json', 'config.json']) await rm(joinPath(home, f), { force: true });
    await rm(joinPath(home, 'groups'), { recursive: true, force: true });
    await rmdir(home).catch(() => {}); // if nothing else is in it
    say(err.green('✓ ') + tr('msg.reset'));
  },
};

export const COMMANDS: Command[] = [send, get, list, wait, watch, note, rmCmd, join, invite, create, groups, use, leave, status, name, reset];
