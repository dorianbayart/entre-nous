// Shared folders: the archive (index, previews, files), sent and browsed from another device
// while it is still being sent, a file read alone, part of it downloaded, a ZIP of it, and a
// share link to it.
//   RELAY=http://127.0.0.1:8080 node test/run.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from '../src/core/engine.ts';
import { CHUNK_SIZE } from '../src/core/crypto.ts';
import { MemoryKV } from '../src/core/storage.ts';
import {
  type PackFile,
  buildPack,
  comparePaths,
  fileReader,
  filesUnder,
  isGallery,
  isSystemFile,
  listDir,
  readIndex,
  safePath,
} from '../src/core/folder.ts';
import { ZipWriter, crc32 } from '../src/core/zip.ts';
import { openShare, shareSecretOf } from '../src/core/share.ts';

const RELAY = process.env.RELAY ?? 'http://127.0.0.1:8080';

async function until<T>(what: string, fn: () => T | undefined | false, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timeout waiting for ' + what);
    await new Promise((r) => setTimeout(r, 50));
  }
}

function bytes(n: number, seed = 1) {
  const out = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    out[i] = x >> 16;
  }
  return out;
}

test('folder: paths, order, system files', () => {
  assert.equal(safePath('Vacances/Jour 1/a.jpg'), 'Vacances/Jour 1/a.jpg');
  assert.equal(safePath('/a//b/./c'), 'a/b/c');
  assert.equal(safePath('a\\b'), 'a/b');
  assert.equal(safePath('../etc/passwd'), null);
  assert.equal(safePath('a/../../b'), null);
  assert.equal(safePath('a/\u0000b'), 'a/b');
  assert.equal(safePath(''), null);
  assert.ok(isSystemFile('a/.DS_Store'));
  assert.ok(isSystemFile('Thumbs.db'));
  assert.ok(isSystemFile('x/desktop.ini'));
  assert.ok(isSystemFile('._photo.jpg'));
  assert.ok(!isSystemFile('.env'));
  assert.ok(!isSystemFile('.git/config'));
  const sorted = ['b.txt', 'a/z.txt', 'IMG10.jpg', 'IMG2.jpg', 'a/b/c.txt'].sort(comparePaths);
  assert.deepEqual(sorted, ['a/b/c.txt', 'a/z.txt', 'b.txt', 'IMG2.jpg', 'IMG10.jpg']);
});

test('folder: CRC-32 of the ZIP', () => {
  // the standard CRC-32 of "123456789"
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('folder: sent, browsed during the upload, read, downloaded, zipped, shared', { timeout: 120_000 }, async () => {
  const load = (name: string) => Engine.load({ kv: new MemoryKV(), platform: 'mac', defaultName: name, defaultRelay: RELAY });
  const mac = await load('Mac');
  const phone = await load('Pixel');
  const gid = await mac.createGroup('Dossiers');
  mac.start();
  phone.start();
  await until('mac online', () => mac.groups[0]?.status === 'online');
  const inv = mac.invite(gid, () => {});
  await new Promise((r) => setTimeout(r, 300));
  await phone.join(inv.url);
  await until('phone knows mac', () => (phone as any).runtimes.get(gid)?.bundles.size === 2);
  await until('mac knows phone', () => (mac as any).runtimes.get(gid)?.bundles.size === 2);

  // a folder: a big video (several chunks), photos with previews, text, an empty folder
  const video = bytes(3 * CHUNK_SIZE + 1234, 7);
  const photo = bytes(200_000, 3);
  const thumb = bytes(5000, 9);
  const files: PackFile[] = [
    { path: 'Vidéos/coucher de soleil.mp4', size: video.length, mime: 'video/mp4', src: new Blob([video]), preview: { duration: 108 } },
    { path: 'Jour 2/IMG_2.jpg', size: photo.length, mime: 'image/jpeg', src: new Blob([photo]), preview: { thumb, w: 4000, h: 3000 } },
    { path: 'Jour 2/IMG_10.jpg', size: 10, mime: 'image/jpeg', src: new Blob([bytes(10, 4)]), preview: { thumb: bytes(300, 5) } },
    { path: 'notes.md', size: 10, mime: 'text/markdown', src: new Blob(['# Bretagne']), preview: { excerpt: '# Bretagne' } },
    { path: 'vide.txt', size: 0, src: new Blob([]) },
  ];
  const pack = buildPack('Vacances', files, ['Vide/Sous-dossier']);
  assert.equal(pack.summary.files, 5);
  assert.equal(pack.summary.bytes, video.length + photo.length + 10 + 10);
  assert.deepEqual(pack.index.dirs, ['Jour 2', 'Vide', 'Vide/Sous-dossier', 'Vidéos']);
  // the content, read across its parts, is exact
  const whole = await pack.source.read(0, pack.source.size);
  for (const f of pack.index.files) {
    const src = files.find((x) => x.path === f.path)!;
    const expected = new Uint8Array(await (src.src as Blob).arrayBuffer());
    assert.deepEqual(whole.subarray(f.offset, f.offset + f.size), expected, f.path);
  }

  const sent = mac.sendBlob(gid, pack.source, 'Vacances', 'folder', { folder: pack.summary, thumb: 'data:image/jpeg;base64,AAAA' });
  const item = await until('folder on phone', () => phone.groups[0]?.items.find((i) => i.kind === 'folder'));
  assert.equal(item.name, 'Vacances');
  assert.equal(item.files, 5);
  assert.equal(item.dirs, 4);
  assert.equal(item.size, pack.summary.bytes);
  assert.equal(item.thumb, 'data:image/jpeg;base64,AAAA');

  // browsed at once: the index comes first
  const r = phone.reader(gid, item.id, { keep: 4, ahead: 1 });
  const index = await readIndex(r);
  assert.equal(index.name, 'Vacances');
  assert.deepEqual(index.files.map((f) => f.path), ['Jour 2/IMG_2.jpg', 'Jour 2/IMG_10.jpg', 'Vidéos/coucher de soleil.mp4', 'notes.md', 'vide.txt']);
  const top = listDir(index, '');
  assert.deepEqual(top.dirs.map((d) => [d.name, d.files, d.bytes]), [
    ['Jour 2', 2, photo.length + 10],
    ['Vide', 0, 0],
    ['Vidéos', 1, video.length],
  ]);
  assert.deepEqual(top.files.map((f) => f.path), ['notes.md', 'vide.txt']);
  assert.ok(isGallery(listDir(index, 'Jour 2').files));
  assert.ok(!isGallery(top.files));
  // a preview, read alone
  const img = index.files[0];
  assert.equal(img.w, 4000);
  assert.deepEqual(await r.read(img.thumb![0], img.thumb![0] + img.thumb![1]), thumb);
  // a file of the folder, as a content of its own: the video, its end first
  const v = fileReader(r, index.files[2], false);
  assert.equal(v.size, video.length);
  assert.equal(v.name, 'coucher de soleil.mp4');
  assert.deepEqual(await v.read(video.length - 100, video.length + 100), video.subarray(video.length - 100));
  assert.deepEqual(await v.read(CHUNK_SIZE - 5, CHUNK_SIZE + 5), video.subarray(CHUNK_SIZE - 5, CHUNK_SIZE + 5));
  r.close();
  await sent;

  // part of it downloaded: progress shown on the item, gone once closed
  const sub = filesUnder(index, 'Jour 2');
  const d = phone.downloadReader(gid, item.id, 'Jour 2', 1);
  assert.ok([...phone.transfers.values()].some((t) => t.itemId === item.id && t.direction === 'down'));
  const zip = new ZipWriter();
  async function* pieces(f: (typeof sub)[number]) {
    for (let at = 0; at < f.size; at += 100_000) yield await d.read(f.offset + at, f.offset + Math.min(f.size, at + 100_000));
  }
  for (const f of sub) await zip.addFile(f.path.slice('Jour 2/'.length), f.size, pieces(f));
  await zip.addDir('Vide');
  d.close();
  assert.ok(![...phone.transfers.values()].some((t) => t.itemId === item.id));
  const dir = mkdtempSync(join(tmpdir(), 'entrenous-zip-'));
  try {
    const file = join(dir, 'Jour 2.zip');
    writeFileSync(file, new Uint8Array(await (await zip.finish()).arrayBuffer()));
    const listing = execFileSync('unzip', ['-l', file]).toString();
    assert.match(listing, /IMG_2\.jpg/);
    assert.match(listing, /Vide\//);
    execFileSync('unzip', ['-q', '-t', file]);
    execFileSync('unzip', ['-q', file, '-d', join(dir, 'out')]);
    assert.deepEqual(new Uint8Array(readFileSync(join(dir, 'out', 'IMG_2.jpg'))), photo);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // a share link to the folder: browsed the same way, outside the group
  assert.ok(phone.canShare(gid, item.id));
  const share = await phone.createShare(gid, item.id);
  const visit = await openShare(RELAY, shareSecretOf(share.url)!);
  assert.equal(visit.header.kind, 'folder');
  assert.equal(visit.header.folder?.files, 5);
  const vr = visit.reader();
  const vIndex = await readIndex(vr);
  const md = vIndex.files.find((f) => f.path === 'notes.md')!;
  assert.equal(new TextDecoder().decode(await fileReader(vr, md, false).read(0, 100)), '# Bretagne');
  vr.close();
  visit.close();

  mac.stop();
  phone.stop();
});
