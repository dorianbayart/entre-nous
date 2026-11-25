// Pins: an item kept on top of the history, on every device; the history size spares it.
//   RELAY=http://127.0.0.1:8080 node test/run.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/core/engine.ts';
import { MemoryKV } from '../src/core/storage.ts';
import { dropSecretOf, openDrop } from '../src/core/drop.ts';

const RELAY = process.env.RELAY ?? 'http://127.0.0.1:8080';

async function device(name: string, kv = new MemoryKV()) {
  const e = await Engine.load({ kv, platform: 'mac', defaultName: name, defaultRelay: RELAY });
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

const group = (e: Engine, id: string) => e.groups.find((g) => g.id === id)!;
const item = (e: Engine, gid: string, id: string) => group(e, gid)?.items.find((i) => i.id === id);
const texts = (e: Engine, gid: string) => group(e, gid).items.map((i) => i.text ?? i.name).join();
const rt = (e: Engine, gid: string) => (e as any).runtimes.get(gid);

async function pair(...names: string[]) {
  const [first, ...others] = await Promise.all(names.map((n) => device(n)));
  const gid = await first.e.createGroup('Épingles');
  first.e.start();
  await until('online', () => group(first.e, gid)?.status === 'online');
  for (const d of others) {
    const inv = first.e.invite(gid, () => {});
    await new Promise((r) => setTimeout(r, 200));
    await d.e.join(inv.url);
    d.e.start();
  }
  await until('every member', () => group(first.e, gid)?.members.length === names.length);
  await until('every key', () => rt(first.e, gid).bundles.size === names.length);
  return { devices: [first, ...others], gid };
}

test('pins: on every device, kept by the relay, which cannot tell them apart', { timeout: 40_000 }, async () => {
  const { devices, gid } = await pair('Mac', 'Pixel');
  const [mac, phone] = devices;
  const wifi = await mac.e.sendText(gid, 'wifi : chat-noir-42');
  const other = await mac.e.sendText(gid, 'à demain');
  await until('both on the phone', () => item(phone.e, gid, other));

  // --- pinned on the phone: at once there, then on the Mac
  await phone.e.pin(gid, wifi, true);
  assert.equal(item(phone.e, gid, wifi)!.pinned, true);
  await until('pinned on the mac', () => item(mac.e, gid, wifi)?.pinned);
  assert.ok(!item(mac.e, gid, other)!.pinned);
  // the order of the items stays by date: the latest item is the latest sent
  assert.equal(group(mac.e, gid).items[0].id, other);

  // --- the relay keeps it, sealed: pinned and unpinned look the same
  await mac.e.pin(gid, other, true);
  await mac.e.pin(gid, other, false);
  await until('unpinned on the phone', () => !item(phone.e, gid, other)?.pinned && rt(phone.e, gid).items.get(other).pin);
  const listed = (await rt(mac.e, gid).conn.request('items.list')).items;
  const sealed = listed.map((i: any) => i.pin);
  assert.equal(sealed.length, 2);
  assert.ok(sealed.every((p: string) => typeof p === 'string' && p.length === sealed[0].length));
  assert.ok(!JSON.stringify(listed).includes('wifi'));

  // --- a device coming back finds it as it was
  phone.e.stop();
  const again = await device('Pixel', phone.kv);
  again.e.start();
  await until('pinned after a restart', () => item(again.e, gid, wifi)?.pinned && item(again.e, gid, other) && !item(again.e, gid, other)!.pinned);

  // --- unpinned from any device; the latest change wins
  await again.e.pin(gid, wifi, false);
  await until('unpinned on the mac', () => item(mac.e, gid, wifi) && !item(mac.e, gid, wifi)!.pinned);

  // --- an item gone cannot be pinned
  await mac.e.deleteItem(gid, other);
  await assert.rejects(mac.e.pin(gid, other, true), /unknown item/);

  mac.e.stop();
  again.e.stop();
});

test('pins: the history size spares them, kept by the devices', { timeout: 40_000 }, async () => {
  const { devices, gid } = await pair('Mac', 'Pixel');
  const [mac, phone] = devices;
  const ids: Record<string, string> = {};
  for (const t of ['h1', 'h2', 'h3']) ids[t] = await mac.e.sendText(gid, t);
  await until('three on the phone', () => group(phone.e, gid).items.length === 3);
  await mac.e.pin(gid, ids.h1, true);
  await until('pinned on the phone', () => item(phone.e, gid, ids.h1)?.pinned);

  // --- two items at most: the pinned one does not count
  await phone.e.setMaxItems(gid, 2);
  await until('h1 kept, pinned', () => texts(mac.e, gid) === 'h3,h2,h1');
  await mac.e.sendText(gid, 'h4');
  await until('the oldest unpinned goes', () => texts(phone.e, gid) === 'h4,h3,h1' && texts(mac.e, gid) === 'h4,h3,h1');

  // --- unpinned, it is too old: it goes at once
  assert.equal(phone.e.unpinDeletes(gid, ids.h1), true);
  assert.equal(phone.e.unpinDeletes(gid, ids.h3), false, 'not pinned');
  await phone.e.pin(gid, ids.h1, false);
  await until('gone everywhere', () => texts(phone.e, gid) === 'h4,h3' && texts(mac.e, gid) === 'h4,h3');

  // --- pinned, then the limit lowered: pinned items stay above it
  await mac.e.pin(gid, ids.h3, true);
  await until('h3 pinned on the phone', () => item(phone.e, gid, ids.h3)?.pinned);
  await mac.e.setMaxItems(gid, 1);
  await mac.e.sendText(gid, 'h5');
  await until('one unpinned and the pinned one', () => texts(phone.e, gid) === 'h5,h3');

  // --- sent through a file request, with no device of the group online: trimmed once one is back
  const request = await mac.e.createDrop(gid, 3600);
  mac.e.stop();
  phone.e.stop();
  const guest = await openDrop(RELAY, dropSecretOf(request.url)!);
  const bytes = new Uint8Array(1000).fill(7);
  await guest.send(new Blob([bytes]), { kind: 'file', ts: Date.now(), name: 'devis.pdf', mime: 'application/pdf', size: bytes.length });
  const back = await device('Mac', mac.kv);
  back.e.start();
  await until('the request item kept, the older one gone, the pinned one kept', () => texts(back.e, gid) === 'devis.pdf,h3');

  back.e.stop();
});

test('pins: they follow the history through a key rotation', { timeout: 60_000 }, async () => {
  const { devices, gid } = await pair('Mac', 'Pixel', 'iPad');
  const [mac, phone, tablet] = devices;
  const id = await mac.e.sendText(gid, 'code du portail : 1789');
  await until('on the phone', () => item(phone.e, gid, id));
  await phone.e.pin(gid, id, true);
  await until('pinned on the mac', () => item(mac.e, gid, id)?.pinned);
  await mac.e.removeMember(gid, tablet.e.device.id);
  await until('rotated', () => group(phone.e, gid)?.members.length === 2 && group(phone.e, gid)?.status === 'online');
  await until('still pinned after the rotation', () => item(phone.e, gid, id)?.pinned && item(mac.e, gid, id)?.pinned);
  for (const d of devices) d.e.stop();
});
