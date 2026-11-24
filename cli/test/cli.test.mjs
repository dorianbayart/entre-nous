// Tests of the CLI: two terminal devices (two key folders) against a running relay.
//   docker compose up -d --build   (at the root)
//   npm run build && npm test      (RELAY=… for another relay)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomFillSync } from 'node:crypto';

const RELAY = process.env.RELAY ?? 'http://127.0.0.1:8080';
const CLI = new URL('../dist/entrenous.mjs', import.meta.url).pathname;
let dir;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'entrenous-cli-'));
});
after(() => rm(dir, { recursive: true, force: true }));

/** Runs the CLI as device `who`; resolves with its exit code and outputs. */
function run(who, args, { input, env = {} } = {}) {
  const child = spawn(process.execPath, [CLI, '--home', join(dir, who), ...args], {
    cwd: dir,
    env: { ...process.env, ENTRENOUS_RELAY: RELAY, LANG: 'en_US.UTF-8', NO_COLOR: '1', ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const chunks = [];
  let stderr = '';
  child.stdout.on('data', (d) => chunks.push(d));
  child.stderr.on('data', (d) => (stderr += d));
  if (input !== undefined) child.stdin.end(input);
  else child.stdin.end();
  const bytes = () => Buffer.concat(chunks);
  const done = new Promise((resolve) => child.on('close', (code) => resolve({ code, stdout: bytes().toString('utf8'), bytes: bytes(), stderr })));
  return Object.assign(done, { child, out: () => bytes().toString('utf8') });
}

async function ok(who, args, opts) {
  const res = await run(who, args, opts);
  assert.equal(res.code, 0, `${who} ${args.join(' ')} → ${res.code}\n${res.stderr}`);
  return res;
}

async function until(what, fn, ms = 15_000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timeout waiting for ' + what);
    await new Promise((r) => setTimeout(r, 100));
  }
}

test('help, version, usage errors', async () => {
  const help = await ok('x', []);
  assert.match(help.stdout, /send/);
  assert.match((await ok('x', ['send', '--help'])).stdout, /--message TEXT/);
  assert.match((await ok('x', ['help', 'get'], { env: { LANG: 'fr_FR.UTF-8' } })).stdout, /ÉLÉMENT/);
  assert.match((await ok('x', ['--version'])).stdout, /^\d+\.\d+\.\d+\n$/);
  const typo = await run('x', ['sned']);
  assert.equal(typo.code, 2);
  assert.match(typo.stderr, /Did you mean “send”/);
  assert.equal((await run('x', ['get', '--nope'])).code, 2);
  // no group yet: a clear message, its own exit code, and no keys created for nothing
  const none = await run('fresh', ['get']);
  assert.equal(none.code, 3);
  assert.match(none.stderr, /entrenous join/);
  assert.equal((await run('fresh', ['send', 'no-such-file.pdf'])).code, 2);
});

test('two terminals: pairing, texts, files, stdin, wait, watch, note, rm', { timeout: 120_000 }, async () => {
  // ---- Alice creates a group and invites; Bob joins with the link
  const created = JSON.parse((await ok('alice', ['create', 'Lab', '--json'])).stdout);
  assert.equal(created.name, 'Lab');
  const inv = run('alice', ['invite', '--json']);
  const first = await until('invitation', () => inv.out().split('\n')[0]);
  const { url, expiresAt } = JSON.parse(first);
  assert.match(url, /\/app\/#p=/);
  assert.ok(Date.parse(expiresAt) > Date.now());
  const joined = JSON.parse((await ok('bob', ['join', '--name', 'Bob', url, '--json'])).stdout);
  assert.equal(joined.id, created.id);
  const invited = await inv;
  assert.equal(invited.code, 0);
  assert.deepEqual(JSON.parse(invited.stdout.trim().split('\n')[1]), { joined: 'Bob' });
  const status = JSON.parse((await ok('alice', ['status', '--json'])).stdout);
  assert.deepEqual(status.groups[0].devices.map((d) => d.name).sort(), [status.device.name, 'Bob'].sort());
  assert.equal(status.groups[0].devices.find((d) => d.name === 'Bob').platform, 'cli');

  // ---- a text: exact bytes on a pipe
  const sent = JSON.parse((await ok('alice', ['send', '-m', 'hello\nworld', '--json'])).stdout);
  assert.equal(sent.kind, 'text');
  assert.equal((await ok('bob', ['get'])).stdout, 'hello\nworld');
  // after "--": an id may start with "-" (base64url)
  assert.equal((await ok('bob', ['get', '--', sent.id.slice(0, 6)])).stdout, 'hello\nworld');

  // ---- stdin: text, then binary (a file)
  await ok('bob', ['send'], { input: 'piped text' });
  assert.equal((await ok('alice', ['get'])).stdout, 'piped text');
  const binary = randomFillSync(Buffer.alloc(3000));
  binary[0] = 0;
  await ok('bob', ['send', '--name', 'data.bin'], { input: binary });
  assert.ok((await ok('alice', ['get', '-o', '-'])).bytes.equals(binary), 'binary through stdin and stdout');

  // ---- a file of several chunks, saved without overwriting
  const big = randomFillSync(Buffer.alloc(2 * 1024 * 1024 + 7));
  await writeFile(join(dir, 'big.bin'), big);
  await ok('alice', ['send', join(dir, 'big.bin')]);
  const dl = join(dir, 'dl');
  await import('node:fs/promises').then((fs) => fs.mkdir(dl));
  const p1 = (await ok('bob', ['get', '-o', dl])).stdout.trim();
  const p2 = (await ok('bob', ['get', '-o', dl])).stdout.trim();
  assert.equal(p1, join(dl, 'big.bin'));
  assert.equal(p2, join(dl, 'big (2).bin'));
  assert.ok((await readFile(p1)).equals(big));
  assert.equal((await run('bob', ['get', '-o', p1])).code, 1, 'never overwrites without --force');
  await ok('bob', ['get', '-o', p1, '--force']);

  // ---- a name chosen by another device never leaves the folder, nor hides the file
  await ok('bob', ['send', '--name', '../../.evil.sh'], { input: 'echo pwned' });
  const safe = (await ok('alice', ['get'], {})).stdout.trim();
  assert.equal(await realpath(safe), join(await realpath(dir), 'evil.sh'));

  // ---- the history, in JSON: positions, latest first
  const items = JSON.parse((await ok('bob', ['list', '--json'])).stdout);
  assert.deepEqual(items.map((i) => i.position), items.map((_, i) => i + 1));
  assert.equal(items[0].name, '../../.evil.sh');
  assert.equal(items[1].name, 'big.bin');
  assert.equal(items[1].size, big.length);

  // ---- wait: the next item from another device; a timeout is exit code 124
  const waiting = run('bob', ['wait', '--timeout', '30s', '--json']);
  await new Promise((r) => setTimeout(r, 1500));
  await ok('alice', ['send', '-m', 'ping']);
  const waited = await waiting;
  assert.equal(waited.code, 0, waited.stderr);
  assert.equal(JSON.parse(waited.stdout).text, 'ping');
  assert.equal((await run('bob', ['wait', '--timeout', '1s'])).code, 124);

  // ---- watch, while another process of the same device sends (same keys, two processes)
  const watchDir = join(dir, 'watched');
  await import('node:fs/promises').then((fs) => fs.mkdir(watchDir));
  const watching = run('bob', ['watch', '--json', '-o', watchDir]);
  const aliceWatch = run('alice', ['watch']);
  await new Promise((r) => setTimeout(r, 1500));
  await Promise.all([ok('alice', ['send', '-m', 'one']), ok('alice', ['send', join(dir, 'big.bin')])]);
  const lines = await until('two items watched', () => {
    const l = watching.out().trim().split('\n').filter(Boolean);
    return l.length >= 2 && l.map((x) => JSON.parse(x));
  });
  watching.child.kill('SIGINT');
  aliceWatch.child.kill('SIGINT');
  assert.equal((await watching).code, 0, 'Ctrl-C ends watch normally');
  assert.equal((await aliceWatch).code, 0);
  assert.deepEqual(lines.map((l) => l.text ?? l.name).sort(), ['big.bin', 'one']);
  assert.ok((await readFile(join(watchDir, 'big.bin'))).equals(big));
  // both processes of Alice still read everything (no prekey lost between them)
  await ok('bob', ['send', '-m', 'after']);
  assert.equal((await ok('alice', ['get'])).stdout, 'after');

  // ---- a folder: one item, recreated by get (system files left out), or a ZIP on stdout
  const src = join(dir, 'Vacances');
  await mkdir(join(src, 'Jour 1'), { recursive: true });
  await mkdir(join(src, 'Vide'));
  await writeFile(join(src, 'notes.md'), '# Bretagne\n');
  await writeFile(join(src, 'Jour 1', 'photo.bin'), Buffer.alloc(2 * 1024 * 1024 + 5, 7));
  await writeFile(join(src, '.DS_Store'), 'finder');
  const sentFolder = JSON.parse((await ok('alice', ['send', src, '--json'])).stdout);
  assert.equal(sentFolder.kind, 'folder');
  assert.equal(sentFolder.files, 2);
  const listed = JSON.parse((await ok('bob', ['list', '--json'])).stdout)[0];
  assert.equal(listed.kind, 'folder');
  assert.equal(listed.name, 'Vacances');
  assert.equal(listed.files, 2);
  assert.equal(listed.folders, 2);
  assert.match((await ok('bob', ['list'])).stdout, /Vacances\/ \(2 files, 2 MB\)/);
  const outDir = join(dir, 'reçus');
  const got = (await ok('bob', ['get', '-o', outDir + '/'])).stdout.trim();
  assert.equal(got, join(outDir, 'Vacances'));
  assert.equal(await readFile(join(got, 'notes.md'), 'utf8'), '# Bretagne\n');
  assert.ok((await readFile(join(got, 'Jour 1', 'photo.bin'))).equals(Buffer.alloc(2 * 1024 * 1024 + 5, 7)));
  assert.ok((await stat(join(got, 'Vide'))).isDirectory(), 'empty folders too');
  await assert.rejects(stat(join(got, '.DS_Store')));
  // once more: another name, nothing overwritten
  assert.equal((await ok('bob', ['get', '-o', outDir + '/'])).stdout.trim(), join(outDir, 'Vacances (2)'));
  const zip = (await ok('bob', ['get', '-o', '-'])).bytes;
  assert.equal(zip.readUInt32LE(0), 0x04034b50, 'a ZIP on stdout');
  await writeFile(join(dir, 'v.zip'), zip);
  const { execFileSync } = await import('node:child_process');
  assert.deepEqual(execFileSync('unzip', ['-Z1', join(dir, 'v.zip')]).toString().trim().split('\n').sort(), ['Jour 1/photo.bin', 'Vide/', 'notes.md']);

  // ---- the shared note, and waiting for someone else to change it
  await ok('alice', ['note', 'Wi-Fi: hunter2']);
  assert.equal((await ok('bob', ['note'])).stdout, 'Wi-Fi: hunter2');
  const noteWait = run('alice', ['wait', '--note', '--timeout', '30s']);
  await new Promise((r) => setTimeout(r, 1500));
  await ok('bob', ['note', '-'], { input: 'yes, deploy\n' });
  assert.equal((await noteWait).stdout, 'yes, deploy');
  await ok('bob', ['note', '--clear']);
  assert.equal((await ok('alice', ['note', '--json'])).stdout.trim(), 'null');

  // ---- deleting: one item, then everything (confirmation required without a terminal)
  const before = JSON.parse((await ok('alice', ['list', '--json'])).stdout).length;
  await ok('alice', ['rm', '1']);
  assert.equal(JSON.parse((await ok('bob', ['list', '--json'])).stdout).length, before - 1);
  assert.equal((await run('alice', ['rm', '--all'])).code, 2);
  await ok('alice', ['rm', '--all', '--yes']);
  assert.deepEqual(JSON.parse((await ok('bob', ['list', '--json'])).stdout), []);
  assert.equal((await run('bob', ['get'])).code, 5);

  // ---- the keys only: no content ever written in the key folder
  const files = await readdir(join(dir, 'bob'), { recursive: true });
  assert.deepEqual(files.filter((f) => !/^(device|groups|config)\.json$|^groups(\/[\w-]+\.json)?$/.test(f)), []);
  assert.equal((await stat(join(dir, 'bob', 'device.json'))).mode & 0o777, 0o600);

  // ---- leaving: Bob is gone from Alice's group, and has no group left
  await ok('bob', ['leave', '--yes']);
  const after = JSON.parse((await ok('alice', ['status', '--json'])).stdout);
  assert.ok(after.groups.every((g) => !g.devices.some((d) => d.name === 'Bob')), 'Bob is no longer a member');
  assert.equal((await run('bob', ['get'])).code, 3);
});
