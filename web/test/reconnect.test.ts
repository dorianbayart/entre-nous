// What changes while a device connects (between the relay's answer to its hello and the end of
// its setup) must not be lost: new items, deletions, uploads that complete.
//   RELAY=http://127.0.0.1:8080 node test/run.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/core/engine.ts';
import { MemoryKV } from '../src/core/storage.ts';

const RELAY = process.env.RELAY ?? 'http://127.0.0.1:8080';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function device(name: string) {
  const e = await Engine.load({ kv: new MemoryKV(), platform: 'mac', defaultName: name, defaultRelay: RELAY });
  e.start();
  return e;
}

async function until<T>(what: string, fn: () => T | undefined | false, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timeout waiting for ' + what);
    await sleep(50);
  }
}

const group = (e: Engine, id: string) => e.groups.find((g) => g.id === id);

async function pair() {
  const alice = await device('Alice');
  const bob = await device('Bob');
  const gid = await alice.createGroup('Groupe');
  await until('alice online', () => group(alice, gid)?.status === 'online');
  const inv = alice.invite(gid, () => {});
  await sleep(300);
  await bob.join(inv.url);
  await until('paired', () => group(alice, gid)?.members.length === 2 && group(bob, gid)?.status === 'online');
  const rtB = (bob as any).runtimes.get(gid);
  const aliceId = group(alice, gid)!.members.find((m) => m.me)!.id;
  await until('alice knows bob', () => (alice as any).runtimes.get(gid).bundles.size === 2 && rtB.bundles.has(aliceId));
  return { alice, bob, gid, rtB };
}

/** Bob connects again; `meanwhile` runs once the relay has answered his hello, before he goes on. */
async function reconnect(bob: Engine, rtB: any, gid: string, meanwhile: () => Promise<void>) {
  rtB.conn.stop();
  await until('bob offline', () => group(bob, gid)?.status !== 'online');
  const raw = rtB.conn.raw.bind(rtB.conn);
  rtB.conn.raw = async (op: string, ...rest: any[]) => {
    const res = await raw(op, ...rest);
    if (op === 'hello') {
      rtB.conn.raw = raw;
      await meanwhile();
      await sleep(400); // their events reach Bob now
    }
    return res;
  };
  await rtB.conn.start();
  await until('bob online again', () => group(bob, gid)?.status === 'online');
}

const texts = (e: Engine, gid: string) => group(e, gid)!.items.map((i) => i.text);

test('items sent and deleted while a device connects', { timeout: 60_000 }, async () => {
  const { alice, bob, gid, rtB } = await pair();
  await alice.sendText(gid, 'avant');
  await alice.sendText(gid, 'à supprimer');
  await until('both on bob', () => texts(bob, gid).includes('à supprimer') && texts(bob, gid).includes('avant'));
  const doomed = group(alice, gid)!.items.find((i) => i.text === 'à supprimer')!.id;

  await reconnect(bob, rtB, gid, async () => {
    await alice.sendText(gid, 'pendant la connexion');
    await alice.deleteItem(gid, doomed);
  });
  await sleep(500);
  assert.ok(texts(bob, gid).includes('pendant la connexion'), 'an item sent meanwhile is lost: ' + texts(bob, gid));
  assert.ok(!texts(bob, gid).includes('à supprimer'), 'an item deleted meanwhile comes back: ' + texts(bob, gid));
  assert.ok(texts(bob, gid).includes('avant'));

  for (const e of [alice, bob]) e.stop();
});

test('an upload that completes while a device connects does not stay pending', { timeout: 60_000 }, async () => {
  const { alice, bob, gid, rtB } = await pair();
  // Alice's chunks are held back: her file is announced, not uploaded yet
  const held: Array<() => void> = [];
  let hold = true;
  const send = WebSocket.prototype.send;
  WebSocket.prototype.send = function (this: WebSocket, data: any) {
    if (hold && typeof data !== 'string') return void held.push(() => send.call(this, data));
    return send.call(this, data);
  };
  try {
    const data = new Uint8Array(2 * 1024 * 1024 + 10).fill(7);
    const upload = alice.sendBlob(gid, new Blob([data]), 'gros.bin', 'file');
    const pending = () => group(bob, gid)!.items.find((i) => i.name === 'gros.bin');
    await until('pending on bob', () => pending()?.pending);

    await reconnect(bob, rtB, gid, async () => {
      // completed once the relay has answered Bob (its list has the file still pending)
      hold = false;
      held.splice(0).forEach((f) => f());
      await upload;
    });
    await sleep(500);
    assert.ok(pending() && !pending()!.pending, 'the file stays pending on bob');
  } finally {
    WebSocket.prototype.send = send;
  }

  for (const e of [alice, bob]) e.stop();
});
