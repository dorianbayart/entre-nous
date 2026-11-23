// Reading a content on demand (previews, video streaming): random ranges across chunks, while
// the sender is still uploading, from the sender's own copy, and a preview sent with the item.
//   RELAY=http://127.0.0.1:8080 node test/run.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/core/engine.ts';
import { CHUNK_SIZE } from '../src/core/crypto.ts';
import { MemoryKV } from '../src/core/storage.ts';

const RELAY = process.env.RELAY ?? 'http://127.0.0.1:8080';

async function until<T>(what: string, fn: () => T | undefined | false, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timeout waiting for ' + what);
    await new Promise((r) => setTimeout(r, 50));
  }
}

function bytes(n: number) {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 65536) crypto.getRandomValues(out.subarray(i, Math.min(n, i + 65536)));
  return out;
}

test('reader: ranges on demand, during the upload, own copy, preview', { timeout: 90_000 }, async () => {
  const load = (name: string) => Engine.load({ kv: new MemoryKV(), platform: 'mac', defaultName: name, defaultRelay: RELAY });
  const mac = await load('Mac');
  const phone = await load('Pixel');
  const gid = await mac.createGroup('Lecture');
  mac.start();
  phone.start();
  await until('mac online', () => mac.groups[0]?.status === 'online');
  // the relay's version (RELAY_VERSION: the one it was built with), or null when it does not say
  const version = mac.groups[0].relayVersion;
  if (process.env.RELAY_VERSION) assert.equal(version, process.env.RELAY_VERSION);
  else assert.ok(version === null || /^\d+\.\d+\.\d+$/.test(version!), String(version));
  // what the versions after 0.1.20 bring (the relay's copy of CHANGELOG.md): newest first
  const changes = await mac.changelog('0.1.20');
  assert.ok(changes.length > 0, 'changelog from the relay');
  assert.ok(changes.every((e) => e.version !== '0.1.20' && e.fr.length === e.en.length));
  assert.ok(changes.some((e) => e.version === '0.1.27'));
  const inv = mac.invite(gid, () => {});
  await new Promise((r) => setTimeout(r, 300));
  await phone.join(inv.url);
  await until('phone knows mac', () => (phone as any).runtimes.get(gid)?.bundles.size === 2);
  await until('mac knows phone', () => (mac as any).runtimes.get(gid)?.bundles.size === 2);

  // 3.5 chunks, with a preview made by the sender
  const size = 3 * CHUNK_SIZE + CHUNK_SIZE / 2;
  const data = bytes(size);
  const preview = { thumb: 'data:image/webp;base64,AAAA', w: 1920, h: 1080, duration: 42.5 };
  const sent = mac.sendBlob(gid, new Blob([data], { type: 'video/mp4' }), 'film.mp4', 'file', preview);
  // read while it is still being uploaded: the end, first (where an MP4 often keeps its index)
  const item = await until('item on phone', () => phone.groups[0]?.items.find((i) => i.name === 'film.mp4'));
  assert.equal(item.w, 1920);
  assert.equal(item.duration, 42.5);
  assert.equal(item.thumb, preview.thumb);
  const r = phone.reader(gid, item.id, { keep: 2, ahead: 1 });
  assert.equal(r.size, size);
  const tail = await r.read(size - 1000, size + 50); // clamped to the size
  assert.deepEqual(tail, data.subarray(size - 1000));
  await sent;
  // across chunk boundaries, then a jump back (seek): bytes exact
  for (const [a, b] of [
    [CHUNK_SIZE - 10, CHUNK_SIZE + 10],
    [0, 3],
    [CHUNK_SIZE * 2 - 5, CHUNK_SIZE * 3 + 5],
    [5, CHUNK_SIZE + 7],
    [0, size],
  ]) {
    assert.deepEqual(await r.read(a, b), data.subarray(a, b), `range ${a}-${b}`);
  }
  // reads at once, the same chunk twice: one result each
  const both = await Promise.all([r.read(100, 200), r.read(150, 250), r.read(size - 10, size)]);
  assert.deepEqual(both[1], data.subarray(150, 250));
  assert.deepEqual((await r.read(10, 10)).length, 0);
  // few chunks kept in memory (keep 2), none of them waited for
  await new Promise((res) => setTimeout(res, 300));
  const slots = [...(r as any).slots.values()].filter((s: any) => s.state === 'done');
  assert.ok(slots.length <= 2, `${slots.length} chunks kept`);
  r.close();
  await assert.rejects(r.read(0, 10), /closed/);
  assert.equal((phone as any).readers.size, 0);

  // the sender reads its own copy, nothing fetched
  const own = mac.reader(gid, item.id);
  assert.deepEqual(await own.read(CHUNK_SIZE - 3, CHUNK_SIZE + 3), data.subarray(CHUNK_SIZE - 3, CHUNK_SIZE + 3));
  own.close();

  // the full download still works, and keeps the connection while in the background
  const r2 = phone.reader(gid, item.id); // a video playing, then the app goes to the background
  phone.background();
  await new Promise((res) => setTimeout(res, 200));
  assert.equal(phone.groups[0].status, 'online', 'a reader keeps the connection');
  const full = new Uint8Array(await (await phone.content(gid, item.id)).blob!.arrayBuffer());
  assert.deepEqual(full, data);
  r2.close();
  await until('disconnected once nothing is read', () => phone.groups[0].status !== 'online');

  mac.stop();
});
