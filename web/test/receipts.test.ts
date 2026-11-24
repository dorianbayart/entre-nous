// Receipts: one tick once a device has an item, two once all have it, coloured once read.
//   RELAY=http://127.0.0.1:8080 node test/run.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/core/engine.ts';
import { MemoryKV } from '../src/core/storage.ts';

const RELAY = process.env.RELAY ?? 'http://127.0.0.1:8080';

async function device(name: string, platform: 'mac' | 'android' | 'ios') {
  const kv = new MemoryKV();
  const e = await Engine.load({ kv, platform, defaultName: name, defaultRelay: RELAY });
  return { e, kv, name };
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

const group = (e: Engine, id: string) => e.groups.find((g) => g.id === id);
const item = (e: Engine, gid: string, id: string) => group(e, gid)?.items.find((i) => i.id === id);
const keys = (e: Engine, gid: string) => (e as any).runtimes.get(gid)?.bundles.size ?? 0;

test('receipts with two devices: the receiving one shows its own ticks too', { timeout: 30_000 }, async () => {
  const mac = await device('Mac', 'mac');
  const phone = await device('Pixel', 'android');
  const gid = await mac.e.createGroup('À deux');
  mac.e.start();
  await until('mac online', () => group(mac.e, gid)?.status === 'online');
  const inv = mac.e.invite(gid, () => {});
  await new Promise((r) => setTimeout(r, 200));
  await phone.e.join(inv.url);
  phone.e.start();
  await until('two members', () => group(mac.e, gid)?.members.length === 2);
  await until('mac knows every key', () => keys(mac.e, gid) === 2);

  const id = await mac.e.sendText(gid, 'rendez-vous à 18 h');
  await until('delivered, seen by the sender', () => item(mac.e, gid, id)?.receipts?.delivered === 1);
  const got = await until('delivered, seen by the phone', () => item(phone.e, gid, id)?.receipts?.delivered === 1 && item(phone.e, gid, id));
  assert.equal(got.receipts!.total, 1);
  assert.deepEqual(got.receipts!.devices.map((d) => [d.name, !!d.me]), [['Pixel', true]]);
  phone.e.markRead(gid, id);
  assert.equal(item(phone.e, gid, id)!.receipts!.read, 1);
  await until('read, seen by the sender', () => item(mac.e, gid, id)?.receipts?.read === 1);

  mac.e.stop();
  phone.e.stop();
});

test('receipts: delivered, read, offline devices, relay knows nothing', { timeout: 60_000 }, async () => {
  const mac = await device('Mac', 'mac');
  const phone = await device('Pixel', 'android');
  const tablet = await device('iPad', 'ios');
  const gid = await mac.e.createGroup('Accusés');
  mac.e.start();
  await until('mac online', () => group(mac.e, gid)?.status === 'online');
  for (const d of [phone, tablet]) {
    const inv = mac.e.invite(gid, () => {});
    await new Promise((r) => setTimeout(r, 200));
    await d.e.join(inv.url);
    d.e.start();
  }
  await until('three members', () => group(mac.e, gid)?.members.length === 3);
  await until('mac knows every key', () => keys(mac.e, gid) === 3);

  // --- alone in the group before: nothing to show; now two other devices
  const id = await mac.e.sendText(gid, 'code de la porte : 4521');
  const first = await until('item listed', () => item(mac.e, gid, id));
  assert.equal(first.receipts?.total, 2);
  const both = await until('both delivered', () => item(mac.e, gid, id)?.receipts?.delivered === 2 && item(mac.e, gid, id));
  assert.equal(both.receipts!.read, 0);
  assert.deepEqual(both.receipts!.devices.map((d) => d.name), ['iPad', 'Pixel']);
  assert.ok(both.receipts!.devices.every((d) => d.delivered && !d.read));
  // the receiving devices show the same: both recipients have it, this one marked
  await until('the same on the phone', () => item(phone.e, gid, id)?.receipts?.delivered === 2);
  assert.deepEqual(item(phone.e, gid, id)!.receipts!.devices.map((d) => [d.name, !!d.me]), [['iPad', false], ['Pixel', true]]);

  // --- read on one, then on all
  phone.e.markRead(gid, id);
  assert.equal(item(phone.e, gid, id)!.receipts!.read, 1, 'its own tick at once');
  await until('read on one', () => item(mac.e, gid, id)?.receipts?.read === 1);
  await until('the tablet sees it read on the phone', () => item(tablet.e, gid, id)?.receipts?.read === 1);
  assert.ok(item(mac.e, gid, id)!.receipts!.devices.find((d) => d.name === 'Pixel')!.read);
  phone.e.markRead(gid, id); // once only
  tablet.e.markRead(gid, id);
  await until('read on all', () => item(mac.e, gid, id)?.receipts?.read === 2);
  await until('read on all, seen by the phone', () => item(phone.e, gid, id)?.receipts?.read === 2);

  // --- the relay keeps them sealed: no clear time, no "read"
  const raw = (mac.e as any).runtimes.get(gid).items.get(id).relay;
  const res = await (mac.e as any).runtimes.get(gid).conn.request('items.list');
  const stored = res.items.find((i: any) => i.id === id);
  assert.equal(Object.keys(stored.acks).length, 2);
  for (const data of Object.values(stored.acks) as string[]) {
    const bytes = Buffer.from(data, 'base64url').toString('latin1');
    assert.ok(!/"[dr]"|read|lu/.test(bytes), 'receipt readable by the relay');
  }
  assert.ok(raw);

  // --- a device offline: one tick, then two once it comes back (its mailbox)
  tablet.e.stop();
  await until('tablet offline', () => !group(mac.e, gid)!.members.find((m) => m.name === 'iPad')?.online);
  const id2 = await mac.e.sendText(gid, 'à lire plus tard');
  await until('delivered on the phone', () => item(mac.e, gid, id2)?.receipts?.delivered === 1);
  phone.e.markRead(gid, id2);
  await until('read on the phone', () => item(mac.e, gid, id2)?.receipts?.read === 1);
  assert.equal(item(mac.e, gid, id2)!.receipts!.delivered, 1);

  // read while the relay cannot be reached: told at the next connection
  tablet.e.start();
  await until('delivered everywhere', () => item(mac.e, gid, id2)?.receipts?.delivered === 2);
  const conn = (tablet.e as any).runtimes.get(gid).conn;
  const request = conn.request.bind(conn);
  conn.request = (op: string, ...rest: any[]) => (op === 'item.ack' ? Promise.reject(new Error('disconnected')) : request(op, ...rest));
  tablet.e.markRead(gid, id2);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(item(mac.e, gid, id2)!.receipts!.read, 1);
  conn.request = request;
  conn.drop(conn.ws); // the network comes back
  await until('read told after reconnecting', () => item(mac.e, gid, id2)?.receipts?.read === 2);

  // --- the sender, restarted, gets them back from the relay
  mac.e.stop();
  const again = await Engine.load({ kv: mac.kv, platform: 'mac', defaultName: 'Mac', defaultRelay: RELAY });
  again.start();
  await until('receipts reloaded', () => item(again, gid, id2)?.receipts?.read === 2);
  assert.equal(item(again, gid, id)!.receipts!.read, 2);

  // --- a file: delivered only once uploaded entirely
  const bytes = new Uint8Array(3 * 1024 * 1024).fill(7);
  const fid = await again.sendBlob(gid, new Blob([bytes]), 'plan.pdf', 'file');
  await until('file delivered', () => item(again, gid, fid)?.receipts?.delivered === 2);
  const got = item(again, gid, fid)!;
  assert.ok(got.receipts!.devices.every((d) => d.delivered! >= got.createdAt - 5000));

  again.stop();
  phone.e.stop();
  tablet.e.stop();
});
