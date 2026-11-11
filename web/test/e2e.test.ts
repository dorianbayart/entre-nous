// End-to-end test: three devices (real engine, in-memory storage) against a running relay.
//   RELAY=http://127.0.0.1:8080 node test/run.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine, ItemGoneError, type EngineEvent } from '../src/core/engine.ts';
import { MemoryKV } from '../src/core/storage.ts';

const RELAY = process.env.RELAY ?? 'http://127.0.0.1:8080';

async function device(name: string, platform: 'mac' | 'android' | 'ios') {
  const kv = new MemoryKV();
  const e = await Engine.load({ kv, platform, defaultName: name, defaultRelay: RELAY });
  const events: EngineEvent[] = [];
  e.on((ev) => {
    events.push(ev);
    if (ev.type === 'error' || ev.type === 'removed') console.log('  [' + name + '] ' + JSON.stringify(ev));
  });
  return { e, events, kv, platform, name };
}

async function until<T>(what: string, fn: () => T | undefined | false, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timeout waiting for ' + what);
    if (!(until as any).logged?.has(what)) {
      ((until as any).logged ??= new Set()).add(what);
      console.log('  … ' + what);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

const group = (e: Engine, id: string) => e.groups.find((g) => g.id === id);

test('pairing, sync, mailbox, files, retention, removal', { timeout: 90_000 }, async () => {
  const mac = await device('Mac', 'mac');
  const phone = await device('Pixel', 'android');
  const tablet = await device('iPad', 'ios');

  const gid = await mac.e.createGroup('Mes appareils');
  mac.e.start();
  phone.e.start();
  tablet.e.start();
  await until('mac online', () => group(mac.e, gid)?.status === 'online');

  // --- pairing Mac -> phone
  let joined = '';
  const inv = mac.e.invite(gid, (n) => (joined = n));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(await phone.e.join(inv.url), gid);
  await until('joined callback', () => joined === 'Pixel');
  await until('phone online', () => group(phone.e, gid)?.status === 'online');
  await until('both members on mac', () => group(mac.e, gid)?.members.length === 2);
  assert.equal(group(phone.e, gid)!.members.length, 2);
  await until('presence', () => group(mac.e, gid)!.members.find((m) => m.name === 'Pixel')?.online);

  // --- phone -> Mac text, live
  await until('phone has mac prekey', () => {
    try {
      return (phone.e as any).runtimes.get(gid).bundles.size === 2;
    } catch {
      return false;
    }
  });
  await phone.e.sendText(gid, '4970 1234 5678 9012');
  const incoming = await until('mac incoming', () => mac.events.find((x) => x.type === 'incoming') as any);
  assert.equal(incoming.item.text, '4970 1234 5678 9012');
  assert.equal(incoming.item.fromName, 'Pixel');
  assert.equal((await mac.e.content(gid, incoming.item.id)).text, '4970 1234 5678 9012');
  // what the relay stores and serves does not contain the text
  const stored = (mac.e as any).runtimes.get(gid).items.get(incoming.item.id).relay;
  const relayView = JSON.stringify(stored) + Buffer.from(stored.meta, 'base64url').toString();
  assert.ok(!relayView.includes('4970') && !relayView.includes('Pixel'), 'plaintext visible to the relay');

  // --- sent right after starting (Android share): sealed only once the members are known
  // (a fresh engine, as when Android opens the app to hand it a share)
  phone.e.stop();
  const fresh = await Engine.load({ kv: phone.kv, platform: 'android', defaultName: 'Pixel', defaultRelay: RELAY });
  fresh.start();
  await fresh.sendText(gid, 'partagé au démarrage');
  fresh.stop();
  phone.e.start();
  const early = await until('mac gets early item', () => group(mac.e, gid)!.items.find((i) => i.text === 'partagé au démarrage'));
  assert.ok(!early.error, 'early item unreadable: ' + early.error);

  // --- file of 2.5 MB, Mac -> phone
  const bytes = new Uint8Array(2.5 * 1024 * 1024);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + 7) & 0xff;
  await mac.e.sendBlob(gid, new Blob([bytes], { type: 'video/mp4' }), 'clip.mp4', 'file');
  const fileItem = await until('phone sees file', () => group(phone.e, gid)!.items.find((i) => i.name === 'clip.mp4' && !i.pending));
  assert.equal(fileItem.chunks, 3);
  const got = await phone.e.content(gid, fileItem.id);
  const back = new Uint8Array(await got.blob!.arrayBuffer());
  assert.equal(back.length, bytes.length);
  assert.ok(back.every((b, i) => b === bytes[i]), 'file content differs');

  // --- upload: listed everywhere while in progress, resumed after a network drop
  // big enough to still be uploading when the connection drops (a remote relay is slower)
  const big = new Uint8Array((/127\.0\.0\.1|localhost/.test(RELAY) ? 40 : 6) * 1024 * 1024);
  for (let i = 0; i < big.length; i++) big[i] = (i * 13 + 5) & 0xff;
  const sending = mac.e.sendBlob(gid, new Blob([big]), 'gros.bin', 'file');
  const pend = await until('phone sees upload in progress', () =>
    group(phone.e, gid)!.items.find((i) => i.name === 'gros.bin' && i.pending),
  );
  // downloading before the end follows the upload until its last chunk
  const following = phone.e.content(gid, pend.id);
  await until('progress reaches phone', () => (group(phone.e, gid)!.items.find((i) => i.id === pend.id)?.have ?? 0) > 0);
  assert.ok(mac.e.busy, 'upload already over: the drop below tests nothing');
  const macConn = (mac.e as any).runtimes.get(gid).conn;
  macConn.drop(macConn.ws); // as when the network goes or the phone falls asleep
  await sending;
  await until('phone sees upload complete', () => group(phone.e, gid)!.items.find((i) => i.id === pend.id && !i.pending));
  assert.ok(phone.events.some((ev) => ev.type === 'incoming' && ev.item.id === pend.id), 'no incoming once complete');
  const bigBack = new Uint8Array(await (await phone.e.content(gid, pend.id)).blob!.arrayBuffer());
  assert.ok(bigBack.length === big.length && bigBack.every((b, i) => b === big[i]), 'resumed upload differs');
  const followed = new Uint8Array(await (await following).blob!.arrayBuffer());
  assert.ok(followed.length === big.length && followed.every((b, i) => b === big[i]), 'download during upload differs');
  await mac.e.deleteItem(gid, pend.id);

  // --- deleted by its sender during the upload: at once, even behind megabytes of chunks
  const sendingBig = mac.e.sendBlob(gid, new Blob([big]), 'annule.bin', 'file').then(() => 'done', (e) => e.message);
  const toCancel = await until('phone sees annule.bin', () => group(phone.e, gid)!.items.find((i) => i.name === 'annule.bin'));
  await until('upload under way', () => (group(phone.e, gid)!.items.find((i) => i.id === toCancel.id)?.have ?? 0) > 0);
  const t0 = Date.now();
  await mac.e.deleteItem(gid, toCancel.id);
  const deleteMs = Date.now() - t0;
  assert.ok(deleteMs < 2000, 'delete took ' + deleteMs + ' ms');
  assert.match(await sendingBig, /Envoi annulé/);
  await until('gone on the phone', () => !group(phone.e, gid)!.items.some((i) => i.id === toCancel.id));
  console.log('  … delete during upload: ' + deleteMs + ' ms');

  // --- file deleted by its sender while the phone downloads it
  await mac.e.sendBlob(gid, new Blob([bytes], { type: 'video/mp4' }), 'gone.mp4', 'file');
  const goneItem = await until('phone sees gone.mp4', () => group(phone.e, gid)!.items.find((i) => i.name === 'gone.mp4' && !i.pending));
  const racing = phone.e.content(gid, goneItem.id).then(
    () => 'done',
    (err) => err,
  );
  await mac.e.deleteItem(gid, goneItem.id);
  const raced = await racing;
  assert.ok(raced === 'done' || raced instanceof ItemGoneError, 'unexpected error: ' + raced);
  await assert.rejects(phone.e.content(gid, goneItem.id), ItemGoneError);
  assert.equal(phone.e.transfers.size, 0);

  // --- mailbox: phone offline, Mac sends, phone comes back
  phone.e.stop();
  await mac.e.sendText(gid, 'pendant ton absence');
  phone.e.start();
  await until('phone gets mailbox', () => group(phone.e, gid)?.items.find((i) => i.text === 'pendant ton absence'));

  // --- live note: typed on the phone, seen on the Mac as it is typed, edited back
  for (const t of ['C', 'Co', 'Code', 'Code porte 4821']) phone.e.setNote(gid, t);
  await until('mac sees live note', () => group(mac.e, gid)?.note?.text === 'Code porte 4821');
  assert.equal(group(mac.e, gid)!.note!.byName, 'Pixel');
  assert.ok(!group(mac.e, gid)!.items.some((i) => (i.kind as string) === 'note'), 'note listed in history');
  const noteEntry = [...(mac.e as any).runtimes.get(gid).items.values()].find((x: any) => x.view.kind === 'note');
  assert.ok(!JSON.stringify(noteEntry.relay).includes('4821'), 'note plaintext visible to the relay');
  mac.e.setNote(gid, 'Code porte 4821 B');
  await until('phone sees edit', () => group(phone.e, gid)?.note?.text === 'Code porte 4821 B');

  // --- an expired item leaves the local history at once (the relay deletes it on its side)
  const expiring = group(mac.e, gid)!.items[0];
  (mac.e as any).runtimes.get(gid).items.get(expiring.id).relay.expiresAt = Date.now() - 1;
  await until('expired item swept', () => !group(mac.e, gid)!.items.some((i) => i.id === expiring.id), 3000);
  await phone.e.sendText(gid, 'remplace'); // keeps the history non-empty for what follows
  await until('mac gets replacement', () => group(mac.e, gid)!.items.some((i) => i.text === 'remplace'));

  // --- phone invites the tablet (phone -> phone pairing)
  const inv2 = phone.e.invite(gid, () => {});
  await new Promise((r) => setTimeout(r, 300));
  await tablet.e.join(inv2.url);
  await until('3 members everywhere', () =>
    [mac, phone, tablet].every((d) => group(d.e, gid)?.members.length === 3),
  );
  // history sent before the tablet joined is not readable by it (it had no key yet)
  await until('tablet online', () => group(tablet.e, gid)?.status === 'online');
  await until('mac knows tablet prekey', () => (mac.e as any).runtimes.get(gid).bundles.size === 3);
  // the note author re-sends the note so that the newcomer can read it
  await until('tablet reads live note', () => group(tablet.e, gid)?.note?.text === 'Code porte 4821 B', 15000);
  tablet.e.setNote(gid, '');
  await until('note cleared everywhere', () => [mac, phone].every((d) => group(d.e, gid)?.note === null));
  await mac.e.sendText(gid, 'pour les trois');
  await until('tablet reads new item', () => group(tablet.e, gid)?.items.find((i) => i.text === 'pour les trois'));

  // --- retention set by any device; shortening applies to existing items
  await tablet.e.setTtl(gid, 600);
  await until('ttl synced to mac', () => group(mac.e, gid)?.ttl === 600);
  await phone.e.stop();
  phone.e.start();
  await until('items shortened', () => {
    const items = group(phone.e, gid)?.items ?? [];
    return items.length > 0 && items.every((i) => i.expiresAt - i.createdAt <= 600_000 + 1000);
  });

  // --- delete one item from any device
  const toDelete = group(tablet.e, gid)!.items.find((i) => i.text === 'pour les trois')!;
  await tablet.e.deleteItem(gid, toDelete.id);
  await until('deleted on mac', () => !group(mac.e, gid)?.items.find((i) => i.id === toDelete.id));

  // --- history size, set by any device, enforced by the relay (the live note does not count)
  const st = group(mac.e, gid)!.storage;
  assert.ok(st && st.limit > 0 && st.used > 0, 'storage not reported');
  phone.e.setNote(gid, 'note gardée');
  await until('note on mac', () => group(mac.e, gid)?.note?.text === 'note gardée');
  for (const t of ['h1', 'h2', 'h3']) await mac.e.sendText(gid, t);
  await tablet.e.setMaxItems(gid, 2);
  await until('max synced to mac', () => group(mac.e, gid)?.maxItems === 2);
  await until('history trimmed to 2', () => group(phone.e, gid)!.items.map((i) => i.text).join() === 'h3,h2');
  await mac.e.sendText(gid, 'h4');
  await until('oldest goes', () => group(phone.e, gid)!.items.map((i) => i.text).join() === 'h4,h3');
  assert.equal(group(phone.e, gid)!.note?.text, 'note gardée');
  await phone.e.setAutoMax(gid, 10 * 1024 * 1024);
  await until('auto max synced', () => group(mac.e, gid)?.autoMax === 10 * 1024 * 1024);

  // --- clear everything from any device: history and note, for everyone
  await tablet.e.clearAll(gid);
  await until('cleared everywhere', () =>
    [mac, phone].every((d) => group(d.e, gid)!.items.length === 0 && group(d.e, gid)!.note === null),
  );

  // --- the Mac removes the tablet: it is wiped, the others rotate keys and keep talking
  const tabletId = tablet.e.device.id;
  await mac.e.sendText(gid, 'avant retrait');
  const kept = new Uint8Array(1.5 * 1024 * 1024).map((_, i) => i & 0xff);
  await mac.e.sendBlob(gid, new Blob([kept]), 'garde.bin', 'file');
  await until('phone has the history', () => group(phone.e, gid)!.items.filter((i) => !i.pending).length === 2);
  await mac.e.removeMember(gid, tabletId);
  await until('tablet wiped', () => tablet.e.groups.length === 0);
  assert.ok(tablet.events.some((x) => x.type === 'removed'));
  await until('phone rotated', () => group(phone.e, gid)?.members.length === 2 && group(phone.e, gid)?.status === 'online');
  await until('mac online after rotation', () => group(mac.e, gid)?.status === 'online');
  // the history stays (in the new room, out of the tablet's reach), still readable
  const keptItem = await until('history kept on the phone', () => group(phone.e, gid)!.items.find((i) => i.name === 'garde.bin'));
  assert.ok(group(phone.e, gid)!.items.some((i) => i.text === 'avant retrait'), 'text lost on rotation');
  const keptBack = new Uint8Array(await (await phone.e.content(gid, keptItem.id)).blob!.arrayBuffer());
  assert.ok(keptBack.length === kept.length && keptBack.every((b, i) => b === kept[i]), 'file lost on rotation');
  await until('phone has mac prekey again', () => (phone.e as any).runtimes.get(gid).bundles.size === 2);
  await phone.e.sendText(gid, 'après rotation');
  await until('mac reads after rotation', () => group(mac.e, gid)?.items.find((i) => i.text === 'après rotation'));

  // --- the phone leaves: group of one, dissolved on the relay
  await phone.e.removeMember(gid, phone.e.device.id);
  assert.equal(phone.e.groups.length, 0);
  await until('mac learns dissolution', () => mac.e.groups.length === 0);

  inv.cancel();
  inv2.cancel();
  for (const d of [mac, phone, tablet]) d.e.stop();
});
