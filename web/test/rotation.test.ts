// A device is removed: what the others write while their keys are renewed must not be lost.
// The first test once failed one time in twenty: a key announced during the hello was dropped.
//   RELAY=http://127.0.0.1:8080 node test/run.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/core/engine.ts';
import { MemoryKV } from '../src/core/storage.ts';

const RELAY = process.env.RELAY ?? 'http://127.0.0.1:8080';

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
    await new Promise((r) => setTimeout(r, 50));
  }
}

const group = (e: Engine, id: string) => e.groups.find((g) => g.id === id);

async function join(host: Engine, guest: Engine, gid: string, members: number) {
  const inv = host.invite(gid, () => {});
  await new Promise((r) => setTimeout(r, 300));
  await guest.join(inv.url);
  await until('joined', () => group(host, gid)?.members.length === members && group(guest, gid)?.status === 'online');
}

test('a note written while a removal renews the keys reaches the others', { timeout: 60_000 }, async () => {
  const alice = await device('Alice');
  const bob = await device('Bob');
  const carla = await device('Carla');
  const gid = await alice.createGroup('Groupe');
  await until('alice online', () => group(alice, gid)?.status === 'online');
  await join(alice, bob, gid, 2);
  await join(alice, carla, gid, 3);
  await until('bob sees three', () => group(bob, gid)?.members.length === 3);

  // as in the interface test: a note from Carla, then everything cleared by Bob
  carla.setNote(gid, 'depuis le téléphone');
  await until('note everywhere', () => [alice, bob].every((e) => group(e, gid)?.note?.text === 'depuis le téléphone'));
  await bob.clearAll(gid);
  bob.setNote(gid, '');
  await until('cleared everywhere', () => [alice, bob, carla].every((e) => group(e, gid)?.note === null));

  const carlaId = group(carla, gid)!.members.find((m) => m.me)!.id;
  await alice.removeMember(gid, carlaId);
  // right away: Bob has not necessarily received the new keys yet
  bob.setNote(gid, 'sans Carla');
  await until('alice reads the note', () => group(alice, gid)?.note?.text === 'sans Carla');
  await until('bob still has it', () => group(bob, gid)?.note?.text === 'sans Carla');

  for (const e of [alice, bob, carla]) e.stop();
});

test('a device whose key arrives while the note is being sent can read it', { timeout: 60_000 }, async () => {
  const alice = await device('Alice');
  const bob = await device('Bob');
  const gid = await alice.createGroup('Groupe');
  await until('alice online', () => group(alice, gid)?.status === 'online');
  await join(alice, bob, gid, 2);
  const aliceId = group(alice, gid)!.members.find((m) => m.me)!.id;
  const rtA = (alice as any).runtimes.get(gid);
  const rtB = (bob as any).runtimes.get(gid);
  await until('bob knows alice', () => rtB.bundles.has(aliceId));

  // As in a new room (after a removal): Bob does not know Alice's key yet, and it arrives
  // while Bob is sending his note.
  rtB.bundles.delete(aliceId);
  const request = rtB.conn.request.bind(rtB.conn);
  rtB.conn.request = async (op: string, ...rest: any[]) => {
    if (op === 'note.put') {
      rtA.bundles.delete(aliceId); // Alice publishes her key again
      await (alice as any).publishPrekey(rtA, rtA.conn);
      await until('bob gets the key', () => rtB.bundles.has(aliceId));
    }
    return request(op, ...rest);
  };
  bob.setNote(gid, 'pour Alice aussi');
  await until('alice reads the note', () => group(alice, gid)?.note?.text === 'pour Alice aussi');

  for (const e of [alice, bob]) e.stop();
});
