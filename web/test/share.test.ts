// Share links: an item of the history read by someone outside the group, against a running relay.
//   RELAY=http://127.0.0.1:8080 node test/run.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/core/engine.ts';
import { MemoryKV } from '../src/core/storage.ts';
import { RelayConnection } from '../src/core/relay.ts';
import { ShareGoneError, openShare, shareIdOf, shareSecretOf } from '../src/core/share.ts';
import { b64 } from '../src/core/bytes.ts';

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

async function visit(url: string) {
  const secret = shareSecretOf(url);
  assert.ok(secret, 'secret in the link');
  return openShare(RELAY, secret);
}

test('share links: read from outside, outlive the item, follow a rotation, deleted by their maker', { timeout: 90_000 }, async () => {
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

  // a file of three chunks, and a text
  const bytes = new Uint8Array(2.5 * 1024 * 1024).map((_, i) => (i * 7) % 251);
  const fileId = await mac.e.sendBlob(gid, new Blob([bytes], { type: 'application/pdf' }), 'devis.pdf', 'file');
  const textId = await mac.e.sendText(gid, 'le code : 4821');
  await until('file complete', () => mac.e.canShare(gid, fileId));

  // --- a link, opened in a browser outside the group
  const fileShare = await mac.e.createShare(gid, fileId, 600);
  const textShare = await mac.e.createShare(gid, textId, 600, 'https://example.test');
  assert.match(fileShare.url, /\/s\/#[A-Za-z0-9_-]{43}$/);
  assert.ok(textShare.url.startsWith('https://example.test/s/#'), 'the public address of the web app');
  assert.notEqual(fileShare.id, fileShare.url.split('#')[1], 'the relay never gets the secret');
  assert.ok(Math.abs(fileShare.expiresAt - Date.now() - 600_000) < 5_000);

  const visitor = await visit(fileShare.url);
  assert.equal(visitor.header.name, 'devis.pdf');
  assert.equal(visitor.header.mime, 'application/pdf');
  assert.equal(visitor.size, bytes.length);
  assert.deepEqual(new Uint8Array(await (await visitor.blob()).arrayBuffer()), bytes);
  // random access, as the players do
  const reader = visitor.reader();
  assert.deepEqual(await reader.read(1024 * 1024 + 5, 1024 * 1024 + 9), bytes.subarray(1024 * 1024 + 5, 1024 * 1024 + 9));
  reader.close();
  visitor.close();

  const text = await openShare(RELAY, shareSecretOf(textShare.url)!);
  assert.equal(text.header.kind, 'text');
  assert.equal(text.header.text, 'le code : 4821');
  text.close();

  // --- only on the device that made them, kept across restarts
  assert.deepEqual(group(mac.e, gid).shares.map((s) => s.id).sort(), [fileShare.id, textShare.id].sort());
  assert.equal(group(phone.e, gid).shares.length, 0);
  assert.equal(group(mac.e, gid).shares.find((s) => s.id === textShare.id)!.text, 'le code : 4821');
  const again = await Engine.load({ kv: mac.kv, platform: 'mac', defaultName: 'Mac', defaultRelay: RELAY });
  assert.equal(again.shares(gid).length, 2);

  // --- the item leaves the group: the link still works, for itself alone
  await phone.e.deleteItem(gid, fileId);
  await until('deleted on the mac', () => !group(mac.e, gid).items.some((i) => i.id === fileId));
  const after = await visit(fileShare.url);
  assert.deepEqual(new Uint8Array(await (await after.blob()).arrayBuffer()), bytes);
  after.close();

  // --- another lifetime, from now
  await mac.e.setShareTtl(fileShare.id, 86400);
  const longer = group(mac.e, gid).shares.find((s) => s.id === fileShare.id)!;
  assert.equal(longer.ttl, 86400);
  assert.ok(Math.abs(longer.expiresAt - Date.now() - 86_400_000) < 5_000);

  // --- only its maker can change or delete it (the visitor has the link, not the other secret)
  const outsider = new RelayConnection(RELAY, async () => {}, () => {});
  await outsider.start();
  await assert.rejects(
    outsider.request('share.delete', { share: shareIdOf(shareSecretOf(fileShare.url)!), del: b64(new Uint8Array(32)) }),
    /not allowed/,
  );
  outsider.stop();

  // --- a member removed: the history moves to a new room, the links follow it
  const shared = await mac.e.sendBlob(gid, new Blob([bytes.subarray(0, 300_000)]), 'photo.jpg', 'image');
  await until('photo complete', () => mac.e.canShare(gid, shared));
  const photoShare = await mac.e.createShare(gid, shared, 600);
  const memberId = (name: string) => group(mac.e, gid).members.find((m) => m.name === name)!.id;
  await mac.e.removeMember(gid, memberId('Pixel'));
  await until('two left', () => group(mac.e, gid)?.members.length === 2);
  const moved = await visit(photoShare.url);
  assert.equal((await moved.blob()).size, 300_000);
  moved.close();
  // the item that had left the group, its chunks in the old room: still readable
  const orphan = await visit(fileShare.url);
  assert.equal((await orphan.blob()).size, bytes.length);
  orphan.close();
  // the group dissolved: the links still work until they expire
  await mac.e.removeMember(gid, memberId('iPad'));
  const dissolved = await visit(photoShare.url);
  assert.equal((await dissolved.blob()).size, 300_000);
  dissolved.close();
  assert.equal(mac.e.shares(gid).length, 3, 'still listed, to be deleted');

  // --- deleted by its maker: gone at once
  await mac.e.deleteShare(fileShare.id);
  assert.ok(!group(mac.e, gid).shares.some((s) => s.id === fileShare.id));
  await assert.rejects(visit(fileShare.url), ShareGoneError);
  await assert.rejects(visit(fileShare.url.replace(/#.$/, '#A')), ShareGoneError);

  // --- not for an item that is not there
  assert.equal(mac.e.canShare(gid, 'nope'), false);

  for (const d of [mac, phone, tablet]) d.e.stop();
  again.stop();
});
