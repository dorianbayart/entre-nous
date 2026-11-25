// File requests: people outside the group send files to it through a link, against a running relay.
//   RELAY=http://127.0.0.1:8080 node test/run.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/core/engine.ts';
import { MemoryKV } from '../src/core/storage.ts';
import { RelayConnection } from '../src/core/relay.ts';
import { DropGoneError, dropIdOf, dropSecretOf, openDrop } from '../src/core/drop.ts';
import { buildPack } from '../src/core/folder.ts';
import { CHUNK_SIZE } from '../src/core/crypto.ts';

const RELAY = process.env.RELAY ?? 'http://127.0.0.1:8080';

async function device(name: string, kv = new MemoryKV()) {
  const e = await Engine.load({ kv, platform: 'mac', defaultName: name, defaultRelay: RELAY });
  e.on((ev) => ev.type === 'error' && console.log('  [' + name + '] ' + JSON.stringify(ev)));
  return { e, kv };
}

async function until<T>(what: string, fn: () => T | undefined | false, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timeout waiting for ' + what);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const group = (e: Engine, id: string) => e.groups.find((g) => g.id === id)!;
const bytesOf = async (b: Blob) => new Uint8Array(await b.arrayBuffer());

test('file requests: sent from outside, opened by every device, follow a rotation, deleted by any device', { timeout: 90_000 }, async () => {
  const mac = await device('Mac');
  const phone = await device('Pixel');
  const tablet = await device('iPad');
  const gid = await mac.e.createGroup('Mes appareils');
  for (const d of [mac, phone, tablet]) d.e.start();
  await until('mac online', () => group(mac.e, gid)?.status === 'online');
  for (const d of [phone, tablet]) {
    const inv = mac.e.invite(gid, () => {});
    await new Promise((r) => setTimeout(r, 300));
    await d.e.join(inv.url);
  }
  await until('prekeys', () => (mac.e as any).runtimes.get(gid).bundles.size === 3);

  // --- made on the Mac, known to every device
  const request = await mac.e.createDrop(gid, 3600, 'Les photos de samedi');
  assert.match(request.url, /\/r\/#[A-Za-z0-9_-]{43}$/);
  const secret = dropSecretOf(request.url)!;
  assert.equal(dropIdOf(secret), request.id);
  assert.notEqual(request.id, request.url.split('#')[1], 'the relay never gets the secret');
  assert.ok(Math.abs(request.expiresAt - Date.now() - 3600_000) < 5_000);
  const onPhone = await until('request on the phone', () => group(phone.e, gid).drops.find((d) => d.id === request.id));
  assert.equal(onPhone.url, request.url);
  assert.equal(onPhone.byName, 'Mac');
  assert.equal(onPhone.mine, false);

  // --- a file, from a browser outside the group
  const guest = await openDrop(RELAY, secret);
  assert.equal(guest.msg, 'Les photos de samedi');
  const bytes = new Uint8Array(2.5 * 1024 * 1024).map((_, i) => (i * 7) % 251);
  const progress: number[] = [];
  const fileId = await guest.send(
    new Blob([bytes], { type: 'image/jpeg' }),
    { kind: 'image', ts: Date.now(), name: 'IMG_2041.jpg', mime: 'image/jpeg', size: bytes.length, by: '  Marie ', w: 4, h: 3 },
    (done, total) => progress.push(done / total),
  );
  assert.equal(progress.at(-1), 1);
  for (const d of [mac, phone]) {
    const v = await until('the file', () => group(d.e, gid).items.find((i) => i.id === fileId && !i.pending));
    assert.equal(v.drop, request.id);
    assert.equal(v.by, 'Marie');
    assert.equal(v.fromName, 'Marie');
    assert.equal(v.mine, false);
    assert.equal(v.name, 'IMG_2041.jpg');
    assert.equal(v.kind, 'image');
    assert.equal(v.receipts, undefined, 'no receipts: nobody of the group sent it');
    assert.deepEqual(await bytesOf((await d.e.content(gid, fileId)).blob!), bytes);
  }

  // --- several files: one folder, named after the person
  const a = new Uint8Array(300_000).fill(1);
  const b = new Uint8Array(CHUNK_SIZE + 10).fill(2);
  const pack = buildPack('', [
    { path: 'a.jpg', size: a.length, mime: 'image/jpeg', src: new Blob([a]) },
    { path: 'b.mov', size: b.length, mime: 'video/quicktime', src: new Blob([b]) },
  ]);
  const folderId = await guest.send(pack.source, { kind: 'folder', ts: Date.now(), size: pack.source.size, folder: pack.summary, by: 'Marie' });
  const folder = await until('the folder', () => group(phone.e, gid).items.find((i) => i.id === folderId && !i.pending));
  assert.equal(folder.kind, 'folder');
  assert.equal(folder.files, 2);
  assert.match(folder.name!, /Marie/);
  // without a name
  const anon = await guest.send(new Blob([new Uint8Array([1, 2, 3])]), { kind: 'file', ts: Date.now(), name: 'note.txt', size: 3 });
  const anonView = await until('anonymous', () => group(mac.e, gid).items.find((i) => i.id === anon && !i.pending));
  assert.equal(anonView.by, undefined);
  assert.ok(anonView.fromName.length > 0 && anonView.fromName !== '?');
  // a text is not taken (only files and folders come through a request)
  const textId = await guest.send(new Blob([new Uint8Array([1])]), { kind: 'text', ts: Date.now(), text: 'coucou' });
  assert.ok((await until('text', () => group(mac.e, gid).items.find((i) => i.id === textId)))!.error);
  await mac.e.deleteItem(gid, textId);
  const counted = await until('counted', () => {
    const d = group(mac.e, gid).drops.find((x) => x.id === request.id)!;
    return d.received === 3 && d;
  });
  assert.ok(counted.bytes > bytes.length);

  // --- the link only sends: it cannot add chunks to an item of the group
  const own = await mac.e.sendBlob(gid, new Blob([new Uint8Array(10)]), 'x.bin', 'file');
  const outsider = new RelayConnection(RELAY, async () => {}, () => {});
  await outsider.start();
  await assert.rejects(outsider.request('chunk.put', { drop: request.id, itemId: own, idx: 0 }, new Uint8Array(40)), /unknown item/);
  await assert.rejects(outsider.request('drop.commit', { drop: request.id, id: own }), /unknown item/);
  await assert.rejects(outsider.request('drop.update', { drop: request.id, ttl: 60 }), /no room/);
  await assert.rejects(outsider.request('drop.delete', { drop: request.id }), /no room/);
  outsider.stop();

  // --- changed on the phone: message and lifetime, seen on the Mac and on the page
  await phone.e.setDropMessage(gid, request.id, 'Photos et vidéos');
  await phone.e.setDropTtl(gid, request.id, 86400);
  const changed = await until('changed on the mac', () => {
    const d = group(mac.e, gid).drops.find((x) => x.id === request.id);
    return d && d.msg === 'Photos et vidéos' && d.ttl === 86400 && d;
  });
  assert.ok(Math.abs(changed.expiresAt - Date.now() - 86_400_000) < 5_000);
  const again = await openDrop(RELAY, secret);
  assert.equal(again.msg, 'Photos et vidéos');
  again.close();

  // --- a member removed: the group moves to a new room, the request follows it
  const memberId = (name: string) => group(mac.e, gid).members.find((m) => m.name === name)!.id;
  await mac.e.removeMember(gid, memberId('iPad'));
  await until('two left', () => group(mac.e, gid)?.members.length === 2 && group(phone.e, gid)?.members.length === 2);
  await until('phone online again', () => group(phone.e, gid)?.status === 'online');
  const after = await guest.send(new Blob([new Uint8Array([9, 9])]), { kind: 'file', ts: Date.now(), name: 'after.bin', size: 2, by: 'Marie' });
  await until('sent after the rotation', () => group(phone.e, gid).items.find((i) => i.id === after && !i.pending));
  assert.ok(group(mac.e, gid).drops.some((d) => d.id === request.id));

  // --- deleted on the phone: gone everywhere at once; what came stays
  await phone.e.deleteDrop(gid, request.id);
  await until('gone on the mac', () => !group(mac.e, gid).drops.some((d) => d.id === request.id));
  await assert.rejects(openDrop(RELAY, secret), DropGoneError);
  await assert.rejects(guest.send(new Blob([new Uint8Array([1])]), { kind: 'file', ts: Date.now(), name: 'late.bin', size: 1 }), DropGoneError);
  guest.close();
  assert.ok(group(mac.e, gid).items.some((i) => i.id === fileId), 'what came through it stays');
  assert.ok(group(phone.e, gid).items.find((i) => i.id === fileId)!.by === 'Marie', 'and can still be opened');

  // --- not in local mode
  await mac.e.setLocalOnly(gid, true);
  await assert.rejects(mac.e.createDrop(gid), /local only/);

  for (const d of [mac, phone, tablet]) d.e.stop();
});
