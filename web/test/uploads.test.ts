// Uploads: never more than 4 chunks at once, all files together; a lost connection while an
// upload starts (or a lost answer) is tried again, not shown as an error.
//   RELAY=http://127.0.0.1:8080 node test/run.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/core/engine.ts';
import { MemoryKV } from '../src/core/storage.ts';
import { RelayError } from '../src/core/relay.ts';

const RELAY = process.env.RELAY ?? 'http://127.0.0.1:8080';
const MB = 1024 * 1024;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(what: string, fn: () => T | undefined | false, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timeout waiting for ' + what);
    await sleep(50);
  }
}

async function alone() {
  const e = await Engine.load({ kv: new MemoryKV(), platform: 'mac', defaultName: 'Alice', defaultRelay: RELAY });
  e.start();
  const gid = await e.createGroup('Groupe');
  await until('online', () => e.groups.find((g) => g.id === gid)?.status === 'online');
  const rt = (e as any).runtimes.get(gid);
  return { e, gid, rt };
}

/** Counts the chunks being uploaded at once on the group's bulk connection. */
function watchChunks(e: Engine, rt: any) {
  const bulk = (e as any).bulk(rt);
  const request = bulk.request.bind(bulk);
  const seen = { now: 0, max: 0 };
  bulk.request = async (op: string, ...rest: any[]) => {
    if (op !== 'chunk.put') return request(op, ...rest);
    seen.max = Math.max(seen.max, ++seen.now);
    try {
      return await request(op, ...rest);
    } finally {
      seen.now--;
    }
  };
  return seen;
}

const item = (e: Engine, gid: string, id: string) => e.groups.find((g) => g.id === gid)?.items.find((i) => i.id === id);
const file = (size: number, seed: number) => new Blob([new Uint8Array(size).fill(seed)]);

test('many files at once: 4 chunks at a time in all, the others wait their turn', { timeout: 90_000 }, async () => {
  const { e, gid, rt } = await alone();
  try {
    const seen = watchChunks(e, rt);
    const sends = Array.from({ length: 10 }, (_, i) => e.sendBlob(gid, file(2.5 * MB, i), `photo${i}.jpg`, 'file'));
    await sleep(0);
    assert.equal([...e.transfers.values()].filter((t) => t.queued).length, 6, 'six files wait for their turn');
    const ids = await Promise.all(sends);
    assert.ok(seen.max <= 4, `at most 4 chunks at once (seen ${seen.max})`);
    assert.equal(seen.max, 4);
    assert.equal(e.transfers.size, 0);
    for (const id of ids) await until('complete ' + id, () => item(e, gid, id) && !item(e, gid, id)!.pending);

    // a single file alone still goes 4 chunks at a time
    seen.max = 0;
    await e.sendBlob(gid, file(6 * MB, 42), 'video.mp4', 'file');
    assert.equal(seen.max, 4);
  } finally {
    e.stop();
  }
});

test('lost connection while starting an upload: tried again until it goes through', { timeout: 60_000 }, async () => {
  const { e, gid, rt } = await alone();
  try {
    const conn = rt.conn;
    const request = conn.request.bind(conn);
    let creates = 0;
    conn.request = async (op: string, ...rest: any[]) => {
      if (op === 'item.create') {
        creates++;
        // first: lost before reaching the relay; second: created, but its answer is lost
        if (creates === 1) throw new RelayError('disconnected');
        if (creates === 2) {
          await request(op, ...rest);
          throw new RelayError('timeout');
        }
      }
      return request(op, ...rest);
    };
    const bulk = (e as any).bulk(rt);
    const bulkRequest = bulk.request.bind(bulk);
    let failedOnce = false;
    bulk.request = async (op: string, ...rest: any[]) => {
      if (op === 'chunk.put' && !failedOnce) {
        failedOnce = true;
        throw new RelayError('connection failed');
      }
      return bulkRequest(op, ...rest);
    };

    const id = await e.sendBlob(gid, file(3 * MB, 7), 'photo.jpg', 'image');
    assert.equal(creates, 3);
    assert.ok(failedOnce);
    await until('complete', () => item(e, gid, id) && !item(e, gid, id)!.pending);
    assert.equal(e.transfers.size, 0);
  } finally {
    e.stop();
  }
});

test('a text: lost connection and lost answer, tried again, sent once', { timeout: 30_000 }, async () => {
  const { e, gid, rt } = await alone();
  try {
    const conn = rt.conn;
    const request = conn.request.bind(conn);
    let creates = 0;
    conn.request = async (op: string, ...rest: any[]) => {
      if (op === 'item.create') {
        creates++;
        if (creates === 1) throw new RelayError('disconnected');
        if (creates === 2) {
          await request(op, ...rest);
          throw new RelayError('timeout');
        }
      }
      return request(op, ...rest);
    };
    const id = await e.sendText(gid, 'bonjour');
    assert.equal(creates, 3);
    await until('received', () => item(e, gid, id));
    await sleep(300);
    assert.equal(e.groups.find((g) => g.id === gid)!.items.filter((i) => i.id === id).length, 1);
  } finally {
    e.stop();
  }
});
