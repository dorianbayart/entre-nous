// Local mode: direct transfers between devices "on the same network", against the real
// relay (signaling) with an in-memory transport standing in for WebRTC (absent in Node).
// Devices given the same network name can link; the others never answer, like WebRTC
// without STUN/TURN between two networks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine, type EngineEvent } from '../src/core/engine.ts';
import { MemoryKV } from '../src/core/storage.ts';
import type { Link, LinkFactory, Pending } from '../src/core/peers.ts';

const RELAY = process.env.RELAY ?? 'http://127.0.0.1:8080';
const ends = new Map<string, Link>(); // the accepting end, waiting for its initiator
let directBytes = 0; // binary bytes carried by the in-memory links

function pair(): [Link, Link] {
  const make = (): Link & { other?: Link; closed?: boolean } => ({
    bufferedAmount: 0,
    maxMessage: 256 * 1024,
    drained: () => Promise.resolve(),
    onMessage: () => {},
    onClose: () => {},
    send(data) {
      const other = (this as any).other as Link;
      if ((this as any).closed) throw new Error('closed');
      if (typeof data !== 'string') directBytes += data.length;
      const copy = typeof data === 'string' ? data : data.slice();
      setTimeout(() => other.onMessage(copy), 0);
    },
    close() {
      for (const l of [this, (this as any).other]) {
        if (l.closed) continue;
        l.closed = true;
        l.onClose();
      }
    },
  });
  const a = make();
  const b = make();
  a.other = b;
  b.other = a;
  return [a, b];
}

function loopback(network: string): LinkFactory {
  const pending = (initiator: boolean, signal: (m: any) => void): Pending => {
    let resolve!: (l: Link) => void;
    let reject!: (e: Error) => void;
    const link = new Promise<Link>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    link.catch(() => {});
    const key = Math.random().toString(36).slice(2);
    if (initiator) signal({ t: 'offer', net: network, key });
    return {
      link,
      cancel: () => reject(new Error('cancelled')),
      receive(msg) {
        if (msg.t === 'offer' && !initiator) {
          if (msg.net !== network) return; // another network: never answers
          const [mine, theirs] = pair();
          ends.set(msg.key, theirs);
          signal({ t: 'answer', key: msg.key });
          resolve(mine);
        } else if (msg.t === 'answer' && initiator) {
          const l = ends.get(msg.key);
          ends.delete(msg.key);
          if (l) resolve(l);
        }
      },
    };
  };
  return { connect: (s) => pending(true, s), accept: (s) => pending(false, s) };
}

async function device(name: string, platform: 'mac' | 'android' | 'ios', network: string) {
  const e = await Engine.load({ kv: new MemoryKV(), platform, defaultName: name, defaultRelay: RELAY, links: loopback(network) });
  const events: EngineEvent[] = [];
  e.on((ev) => events.push(ev));
  return { e, events, name };
}

async function until<T>(what: string, fn: () => T | undefined | false, ms = 10_000): Promise<T> {
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

test('local mode: direct on the same network, relay otherwise', { timeout: 90_000 }, async () => {
  const mac = await device('Mac', 'mac', 'maison');
  const phone = await device('Pixel', 'android', 'maison');
  const tablet = await device('iPad', 'ios', 'bureau'); // another network

  const gid = await mac.e.createGroup('Mes appareils');
  for (const d of [mac, phone, tablet]) d.e.start();
  await until('mac online', () => group(mac.e, gid)?.status === 'online');
  for (const d of [phone, tablet]) {
    const inv = mac.e.invite(gid, () => {});
    await new Promise((r) => setTimeout(r, 300));
    await d.e.join(inv.url);
    await until(d.name + ' online', () => group(d.e, gid)?.status === 'online');
  }
  await until('everyone sees everyone', () =>
    [mac, phone, tablet].every((d) => group(d.e, gid).members.filter((m) => m.online).length === 3),
  );
  await until('prekeys loaded', () => (mac.e as any).runtimes.get(gid).bundles.size === 3);

  // --- normal mode: the phone downloads straight from the Mac, the relay still has it
  const file = new Uint8Array(3 * 1024 * 1024 + 123);
  for (let i = 0; i < file.length; i++) file[i] = (i * 7 + 3) & 0xff;
  await mac.e.sendBlob(gid, new Blob([file]), 'photo.raw', 'file');
  const item = await until('phone sees file', () => group(phone.e, gid).items.find((i) => i.name === 'photo.raw' && !i.pending));
  // the link is set up as soon as the item is announced (in the background)
  const macId = group(mac.e, gid).members.find((m) => m.me)!.id;
  await until('direct link up', () => (phone.e as any).runtimes.get(gid).peers.isConnected(macId), 40_000);
  directBytes = 0;
  let served: any = null; // the Mac shows what it serves directly
  const off = mac.e.on(() => {
    for (const t of mac.e.transfers.values()) if (t.id.startsWith('direct:')) served = { ...t };
  });
  const viaPeer = await bytesOf((await phone.e.content(gid, item.id)).blob!);
  off();
  assert.deepEqual(viaPeer, file);
  assert.ok(served && served.direction === 'up' && served.direct && served.peer === 'Pixel' && served.total === 4, 'no upload line on the Mac: ' + JSON.stringify(served));
  assert.ok(directBytes >= file.length, 'not downloaded directly: ' + directBytes);

  // --- another network: the direct try fails, the relay takes over without a word
  directBytes = 0;
  const viaRelay = await bytesOf((await tablet.e.content(gid, item.id)).blob!);
  assert.deepEqual(viaRelay, file);
  assert.equal(directBytes, 0);

  // --- local mode forced for the group: nothing but the announcement goes to the relay
  await mac.e.setLocalOnly(gid, true);
  await until('setting synced', () => group(phone.e, gid).localOnly && group(tablet.e, gid).localOnly);
  mac.events.length = phone.events.length = tablet.events.length = 0;
  await mac.e.sendText(gid, 'code wifi : 1234');
  const incoming = await until('phone gets the local text', () =>
    phone.events.find((x) => x.type === 'incoming' && x.item.text === 'code wifi : 1234'),
  );
  assert.ok((incoming as any).item.local);
  const onTablet = await until('tablet sees it', () => group(tablet.e, gid).items.find((i) => i.local && i.kind === 'text'));
  assert.equal(onTablet.text, undefined, 'the text reached another network');
  await assert.rejects(tablet.e.content(gid, onTablet.id), /Disponible seulement quand « Mac »/);
  assert.equal(group(mac.e, gid).items.find((i) => i.id === onTablet.id)?.text, 'code wifi : 1234', 'sender history');

  await mac.e.sendBlob(gid, new Blob([file]), 'local.raw', 'file');
  const localFile = await until('phone sees local file', () => group(phone.e, gid).items.find((i) => i.name === 'local.raw'));
  assert.ok(localFile.local && !localFile.pending);
  assert.deepEqual(await bytesOf((await phone.e.content(gid, localFile.id)).blob!), file);
  // the relay never got a single chunk of it
  const res = await (phone.e as any).runtimes.get(gid).conn.request('chunk.get', { id: localFile.id, idx: 0 }).catch((e: Error) => e);
  assert.ok(res instanceof Error && /unknown chunk/.test(res.message), 'relay holds local content');

  // --- another network: shown as unavailable; once the restriction lifted, the sender may
  //     upload it on purpose (never automatically), and then everyone gets it
  await until('tablet: unavailable', () => group(tablet.e, gid).items.find((i) => i.id === localFile.id)?.unavailable);
  assert.ok(!group(mac.e, gid).items.find((i) => i.id === localFile.id)?.canPublish, 'publishable while local only');
  await mac.e.setLocalOnly(gid, false);
  await until('mac may publish', () => group(mac.e, gid).items.find((i) => i.id === localFile.id)?.canPublish);
  await mac.e.publish(gid, localFile.id);
  const published = await until('tablet: no longer local', () =>
    group(tablet.e, gid).items.find((i) => i.id === localFile.id && !i.local && !i.pending && !i.unavailable),
  );
  directBytes = 0;
  assert.deepEqual(await bytesOf((await tablet.e.content(gid, published.id)).blob!), file);
  assert.equal(directBytes, 0, 'tablet is on another network');
  await mac.e.setLocalOnly(gid, true);
  await until('local only again', () => group(phone.e, gid).localOnly);
  await mac.e.sendBlob(gid, new Blob([file]), 'reste.raw', 'file');
  const stays = await until('phone sees reste.raw', () => group(phone.e, gid).items.find((i) => i.name === 'reste.raw'));
  assert.ok(stays.local);

  // --- the sender gone: a local item cannot be fetched any more
  mac.e.stop();
  await until('mac offline for the phone', () => !group(phone.e, gid).members.find((m) => m.name === 'Mac')?.online);
  await assert.rejects(phone.e.content(gid, stays.id), /Disponible seulement quand « Mac » est connecté/);
  assert.ok(group(phone.e, gid).items.find((i) => i.id === stays.id)?.unavailable, 'not shown as unavailable');

  for (const d of [phone, tablet]) d.e.stop();
});
