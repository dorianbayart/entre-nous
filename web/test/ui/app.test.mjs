// Interface tests: two browser devices (two Chrome contexts, separate storage) against a
// running relay, which serves the built app.
//   docker compose up -d --build   (at the root: the relay serves web/dist)
//   npm run test:ui                (HEADED=1 to watch; CHROME_CHANNEL=chromium for another browser)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomFillSync } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from 'playwright-core';
import jsQR from 'jsqr';

const APP = (process.env.RELAY ?? 'http://127.0.0.1:8080') + '/app/';

/**
 * In each page, before the app: no WebRTC (everything goes through the relay, so the timing
 * is ours), and binary frames (chunks) can be held back, to look at an upload in progress.
 */
const INIT = `(() => {
  window.RTCPeerConnection = undefined;
  const held = [];
  let hold = false;
  const send = WebSocket.prototype.send;
  WebSocket.prototype.send = function (data) {
    if (hold && typeof data !== 'string') return void held.push(() => send.call(this, data));
    return send.call(this, data);
  };
  window.__hold = () => { hold = true; };
  window.__release = () => { hold = false; held.splice(0).forEach((f) => f()); };
})();`;

let browser;
const problems = [];

before(async () => {
  browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL ?? 'chrome', headless: !process.env.HEADED });
});
after(() => browser?.close());

const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 16; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36';
const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1';

/**
 * A device: its own browser profile (storage). `phone`: seen as an Android phone, or as an
 * iPhone in Safari with `phone: 'iphone'`; `locale`: its language.
 */
async function device(name, { phone = false, locale = 'fr-FR' } = {}) {
  const context = await browser.newContext({
    acceptDownloads: true,
    locale, // the interface follows the browser's language
    ...(phone
      ? { userAgent: phone === 'iphone' ? IPHONE_UA : ANDROID_UA, viewport: { width: 412, height: 860 }, isMobile: true, hasTouch: true }
      : {}),
  });
  await context.addInitScript(INIT);
  // a phone saves through the share sheet: the shared file is kept, to be checked
  if (phone) {
    await context.addInitScript(`navigator.canShare = () => true;
      navigator.share = async (d) => { window.__shared = d.files[0]; };`);
  }
  const page = await context.newPage();
  page.on('pageerror', (e) => problems.push(`${name}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' || /Alpine/.test(m.text())) problems.push(`${name}: ${m.text()}`);
  });
  return { name, context, page };
}

async function until(what, fn, ms = 10_000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timeout waiting for ' + what);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const button = (scope, name) => scope.getByRole('button', { name, exact: true });

async function rename(d, name) {
  await d.page.getByLabel('Réglages').click();
  const field = d.page.getByLabel('Nom', { exact: true });
  await field.fill(name);
  await field.blur();
  await d.page.locator('section.settings').getByLabel('Retour', { exact: true }).click();
}

/** `host` shows its invitation, `guest` opens the link: both end on the main screen. */
async function pair(host, guest, join) {
  await host.page.getByLabel('Réglages').click();
  await button(host.page, 'Inviter un appareil').click();
  const link = await until('invitation link', () => host.page.locator('input.link:visible').inputValue());
  await join(link);
  await guest.page.locator('section.main').waitFor();
  await host.page.locator('section.main').waitFor();
}

test('two devices: note, items, deletion, upload and download', { timeout: 120_000 }, async () => {
  const a = await device('Alice');
  const b = await device('Bob');
  await a.page.goto(APP);
  await a.page.locator('section.main').waitFor(); // a desktop browser starts with a group
  await rename(a, 'Alice');
  await pair(a, b, (link) => b.page.goto(link));
  await rename(b, 'Bob');

  // ---- live note, then sent as an item
  await a.page.locator('.note textarea').fill('Bonjour Bob');
  await until('note on Bob', async () => (await b.page.locator('.note textarea').inputValue()) === 'Bonjour Bob');
  await button(a.page.locator('.note-bar'), 'Envoyer').click();
  const textB = b.page.locator('.history .item', { hasText: 'Bonjour Bob' });
  await textB.waitFor();
  assert.ok(await button(textB, 'Copier').isVisible(), 'a text can be copied');
  assert.ok(await button(textB, 'Enregistrer').isHidden(), 'a text is not saved');
  // one item and the note: "clear all" is offered
  assert.ok(await b.page.locator('.history-bar').isVisible(), 'clear all with an item and the note');

  // ---- confirmations: they say it is for every device, and go back after a few seconds
  const delB = textB.locator('button.danger');
  await delB.click();
  assert.equal(await delB.textContent(), 'Supprimer partout');
  await sleep(4500);
  assert.equal(await delB.textContent(), 'Supprimer');

  const eraseB = button(b.page.locator('.note-bar'), 'Effacer');
  await eraseB.click();
  await until('note confirmation', async () => (await b.page.locator('.note-bar button.danger').textContent()) === 'Effacer partout');
  await b.page.locator('.note-bar button.danger').click();
  await until('note erased on Alice', async () => (await a.page.locator('.note textarea').inputValue()) === '');

  await delB.click();
  await b.page.locator('.history .item', { hasText: 'Bonjour Bob' }).locator('button.danger').click();
  await a.page.locator('.history .item', { hasText: 'Bonjour Bob' }).waitFor({ state: 'detached' });
  assert.ok(await a.page.locator('.history-bar').isHidden(), 'nothing left to clear');

  // ---- an upload in progress: small line above the history, on both devices
  const content = randomFillSync(Buffer.alloc(3 * 1024 * 1024 + 12345));
  await a.page.evaluate(() => window.__hold());
  await a.page.locator('input[type=file][multiple]').setInputFiles({ name: 'photo.png', mimeType: 'image/png', buffer: content });
  const lineA = a.page.locator('.transfer', { hasText: 'photo.png' });
  await lineA.waitFor();
  assert.match(await lineA.textContent(), /↑ photo\.png/);
  const itemB = b.page.locator('.history .item', { hasText: 'photo.png' });
  await itemB.waitFor();
  const lineB = b.page.locator('.transfer', { hasText: 'photo.png' });
  await lineB.waitFor();
  assert.match(await lineB.textContent(), /envoyé par Alice/);
  assert.match(await itemB.locator('.meta').textContent(), /envoi en cours/);
  assert.equal(await itemB.locator('.ring').count(), 1, 'no upload ring in the item (only the hidden download one)');
  assert.ok(await itemB.locator('.download').isHidden());
  // being received: no Copy (the clipboard would be written long after the tap), Save follows the upload
  assert.ok(await button(itemB, 'Copier').isHidden(), 'no Copy while being received');
  assert.ok(await button(itemB, 'Enregistrer').isVisible(), 'Save while being received');

  // ---- the download: its loader takes the place of Save, in the item
  const download = b.page.waitForEvent('download');
  await button(itemB, 'Enregistrer').click();
  await itemB.locator('.download').waitFor();
  assert.ok(await button(itemB, 'Enregistrer').isHidden(), 'the loader replaces Save');
  assert.equal(await b.page.locator('.transfer', { hasText: '↓' }).count(), 0, 'no download line above the history');
  await a.page.evaluate(() => window.__release());

  const saved = await readFile(await (await download).path());
  assert.ok(saved.equals(content), 'the saved file is the one sent');
  await lineA.waitFor({ state: 'detached' });
  await lineB.waitFor({ state: 'detached' });
  await itemB.locator('.download').waitFor({ state: 'hidden' });
  await until('item complete on Bob', async () => !/envoi/.test(await itemB.locator('.meta').textContent()));
  assert.ok(await button(itemB, 'Copier').isVisible(), 'an image received can be copied');
  assert.ok(await button(itemB, 'Enregistrer').isVisible());

  // ---- a desktop device without any group: create one, or join with a link
  await b.page.getByLabel('Réglages').click();
  const leave = b.page.locator('.members li', { hasText: 'cet appareil' }).locator('button');
  await leave.click();
  await leave.click();
  await b.page.locator('section.center', { hasText: 'Créer un groupe' }).waitFor();
  assert.ok(await b.page.getByRole('button', { name: 'Scanner un QR code' }).isHidden(), 'no scanner on a computer');
  // two devices only: the group is dissolved, Alice is left without a group too
  await a.page.locator('section.center', { hasText: 'Créer un groupe' }).waitFor();
  await button(a.page.locator('.welcome'), 'Créer un groupe').click();
  await a.page.locator('section.main').waitFor();
  assert.equal(await a.page.locator('.bar .title').textContent().then((t) => t.trim()), 'Mes appareils');
  await pair(a, b, async (link) => {
    await b.page.locator('.welcome input').fill(link);
    await b.page.locator('.welcome').getByRole('button', { name: 'Rejoindre' }).click();
  });
  await until('Bob back in the group', async () => (await b.page.locator('.status').textContent()).includes('Alice'));

  await a.context.close();
  await b.context.close();
  assert.deepEqual(problems, []);
});

test('offline: said at once, nothing sent twice when back', { timeout: 120_000 }, async () => {
  const a = await device('Alice');
  const b = await device('Bob');
  await a.page.goto(APP);
  await a.page.locator('section.main').waitFor();
  await pair(a, b, (link) => b.page.goto(link));

  await a.context.setOffline(true);
  await until('offline shown', async () => (await a.page.locator('.status').textContent()).includes('Hors ligne'), 20_000);
  await a.page.locator('.note textarea').fill('Écrite hors ligne');
  const send = button(a.page.locator('.note-bar'), 'Envoyer');
  assert.ok(await send.isDisabled(), 'the note can be sent offline');
  await send.click({ force: true });
  await send.click({ force: true });
  assert.ok(await button(a.page, 'Envoyer le presse-papier').isDisabled(), 'the clipboard can be sent offline');
  // a file chosen offline waits for the connection, listed once
  await a.page.locator('input[type=file][multiple]').setInputFiles({ name: 'hors-ligne.txt', mimeType: 'text/plain', buffer: Buffer.from('fichier') });

  await a.context.setOffline(false);
  await until('back online', async () => !(await send.isDisabled()), 30_000);
  await send.click();
  await b.page.locator('.history .item', { hasText: 'Écrite hors ligne' }).waitFor();
  await sleep(1000);
  assert.equal(await b.page.locator('.history .item', { hasText: 'Écrite hors ligne' }).count(), 1, 'the note is sent more than once');
  await b.page.locator('.history .item', { hasText: 'hors-ligne.txt' }).waitFor();
  await sleep(1000);
  assert.equal(await b.page.locator('.history .item', { hasText: 'hors-ligne.txt' }).count(), 1, 'the file is sent more than once');
  for (const d of [a, b]) await d.context.close();
  // the browser reports each failed attempt to connect
  const lost = problems.filter((p) => /ERR_INTERNET_DISCONNECTED/.test(p));
  for (const p of lost) problems.splice(problems.indexOf(p), 1);
  assert.deepEqual(problems, []);
});

test('three devices, one of them a phone: invitations, parallel downloads, removal', { timeout: 120_000 }, async () => {
  const a = await device('Alice');
  const b = await device('Bob');
  const c = await device('Carla', { phone: true });
  await a.page.goto(APP);
  await a.page.locator('section.main').waitFor();
  await rename(a, 'Alice');
  await pair(a, b, (link) => b.page.goto(link));
  await rename(b, 'Bob');

  // a phone starts without a group: scan first
  await c.page.goto(APP);
  await c.page.locator('section.center', { hasText: 'Scanner un QR code' }).waitFor();
  assert.ok(await c.page.getByRole('button', { name: 'Créer un groupe' }).isHidden(), 'the phone welcome scans first');
  // invited by Bob (not the creator of the group); the phone pastes the link on its first screen
  await pair(b, c, async (link) => {
    await c.page.locator('.welcome input').fill(link);
    await c.page.locator('.welcome').getByRole('button', { name: 'Rejoindre' }).click();
  });
  await rename(c, 'Carla');
  for (const d of [a, b]) {
    await until(`${d.name} sees Carla`, async () => (await d.page.locator('.status').textContent()).includes('Carla'));
  }
  assert.match(await c.page.locator('.status').textContent(), /Alice.*Bob|Bob.*Alice/);
  // the phone sends its clipboard by hand; no pause button anywhere in a browser
  await c.page.getByRole('button', { name: 'Envoyer le presse-papier' }).waitFor();
  assert.ok(await a.page.getByLabel('Mettre en pause').isHidden(), 'no pause in a browser');

  // ---- Alice uploads: Bob and Carla both download it while it is being sent
  const content = randomFillSync(Buffer.alloc(2 * 1024 * 1024 + 99));
  await a.page.evaluate(() => window.__hold());
  await a.page.locator('input[type=file][multiple]').setInputFiles({ name: 'rapport.pdf', mimeType: 'application/pdf', buffer: content });
  const downloads = [];
  for (const d of [b, c]) {
    const phone = d === c;
    const item = d.page.locator('.history .item', { hasText: 'rapport.pdf' });
    await item.waitFor();
    await d.page.locator('.transfer', { hasText: 'envoyé par Alice' }).waitFor();
    assert.ok(await button(item, 'Copier').isHidden(), `${d.name}: no Copy while receiving`);
    if (!phone) downloads.push(d.page.waitForEvent('download').then(async (dl) => readFile(await dl.path())));
    await button(item, 'Enregistrer').click();
    await item.locator('.download').waitFor();
  }
  await a.page.evaluate(() => window.__release());
  downloads.push(
    until('shared on the phone', () => c.page.evaluate(async () => window.__shared && Array.from(new Uint8Array(await window.__shared.arrayBuffer())))).then(Buffer.from),
  );
  for (const got of downloads) assert.ok((await got).equals(content), 'same file for both');
  for (const d of [a, b, c]) await d.page.locator('.transfer').first().waitFor({ state: 'detached' });
  // a file is copied only by the desktop apps; a browser saves it
  const onPhone = c.page.locator('.history .item', { hasText: 'rapport.pdf' });
  assert.ok(await button(onPhone, 'Copier').isHidden(), 'no Copy for a file in a browser');
  assert.ok(await button(onPhone, 'Enregistrer').isVisible());

  // ---- the phone writes, everyone sees it; then "clear all" (two things: an item and the note)
  await c.page.locator('.note textarea').fill('depuis le téléphone');
  for (const d of [a, b]) {
    await until(`note on ${d.name}`, async () => (await d.page.locator('.note textarea').inputValue()) === 'depuis le téléphone');
  }
  const clear = b.page.locator('.history-bar button');
  await clear.click();
  assert.match(await clear.textContent(), /pour tous les appareils/);
  await clear.click();
  for (const d of [a, b, c]) {
    await d.page.locator('.history .item').first().waitFor({ state: 'detached' });
    await until(`note cleared on ${d.name}`, async () => (await d.page.locator('.note textarea').inputValue()) === '');
  }

  // ---- Alice removes Carla: the group goes on for Alice and Bob, Carla is told
  await a.page.getByLabel('Réglages').click();
  const remove = a.page.locator('.members li', { hasText: 'Carla' }).locator('button');
  await remove.click();
  assert.equal(await remove.textContent(), 'Confirmer');
  await remove.click();
  await c.page.locator('.toast', { hasText: 'retiré' }).waitFor();
  await c.page.locator('section.center', { hasText: 'Scanner un QR code' }).waitFor();
  await until('Carla gone from the list', async () => (await a.page.locator('.members li').count()) === 2);
  await a.page.locator('section.settings').getByLabel('Retour', { exact: true }).click();
  await b.page.locator('.note textarea').fill('sans Carla');
  await until('Alice still with Bob', async () => (await a.page.locator('.note textarea').inputValue()) === 'sans Carla');

  for (const d of [a, b, c]) await d.context.close();
  assert.deepEqual(problems, []);
});

test('receipts: one tick, two ticks, coloured once read, the same on every device, the detail', { timeout: 120_000 }, async () => {
  const a = await device('Alice');
  const b = await device('Bob');
  const c = await device('Chloé');
  await a.page.goto(APP);
  await a.page.locator('section.main').waitFor();
  await rename(a, 'Alice');
  await pair(a, b, (link) => b.page.goto(link));
  await rename(b, 'Bob');
  await pair(a, c, (link) => c.page.goto(link));
  await rename(c, 'Chloé');
  await until('three devices', async () => /Bob/.test(await a.page.locator('.status').textContent()) && /Chloé/.test(await a.page.locator('.status').textContent()));

  await a.page.locator('.note textarea').fill('Code du portail : 4521');
  await button(a.page.locator('.note-bar'), 'Envoyer').click();
  const mine = a.page.locator('.history .item', { hasText: 'Code du portail' });
  const ticks = mine.locator('.receipts .ticks');
  const paths = mine.locator('.receipts path');
  const state = async () => [await paths.nth(0).getAttribute('class'), await paths.nth(1).getAttribute('class')].join('|');
  // both devices are online: two grey ticks
  await until('two grey ticks', async () => (await state()) === '|');
  assert.equal(await ticks.getAttribute('title'), 'Reçu par tous');
  // the same on a received item
  const theirs = b.page.locator('.history .item', { hasText: 'Code du portail' });
  const theirPaths = theirs.locator('.receipts path');
  const theirState = async () => [await theirPaths.nth(0).getAttribute('class'), await theirPaths.nth(1).getAttribute('class')].join('|');
  await until('two grey ticks on Bob', async () => (await theirState()) === '|');

  // read on Bob (copied): the first tick takes the colour
  await button(theirs, 'Copier').click();
  await until('first tick read', async () => (await state()) === 'read|');
  await until('first tick read on Bob', async () => (await theirState()) === 'read|');
  assert.equal(await ticks.getAttribute('title'), 'Reçu par tous · lu par 1 sur 2');
  // the detail by device
  await ticks.click();
  const detail = mine.locator('.receipts-detail');
  await detail.waitFor();
  assert.match(await detail.locator('li', { hasText: 'Bob' }).textContent(), /lu · \d\d:\d\d/);
  assert.match(await detail.locator('li', { hasText: 'Chloé' }).textContent(), /reçu · \d\d:\d\d/);
  // read on Chloé (opened in the preview): both coloured, while the detail is open
  const hers = c.page.locator('.history .item', { hasText: 'Code du portail' });
  await button(hers, 'Copier').click();
  await until('both read', async () => (await state()) === 'read|read');
  await until('both read on Bob', async () => (await theirState()) === 'read|read');
  await theirs.locator('.receipts .ticks').click();
  assert.match(await theirs.locator('.receipts-detail li', { hasText: 'Bob' }).textContent(), /Bob \(cet appareil\)lu · /);
  await b.page.locator('.bar .title').click();
  assert.equal(await ticks.getAttribute('title'), 'Lu par tous');
  assert.match(await detail.locator('li', { hasText: 'Chloé' }).textContent(), /lu · /);
  // a click elsewhere closes it
  await a.page.locator('.bar .title').click();
  await detail.waitFor({ state: 'hidden' });

  // a device offline: one tick until it comes back
  await c.page.close();
  await until('Chloé offline', async () => !/Chloé/.test(await a.page.locator('.status').textContent()));
  await a.page.locator('.note textarea').fill('Pour plus tard');
  await button(a.page.locator('.note-bar'), 'Envoyer').click();
  const later = a.page.locator('.history .item', { hasText: 'Pour plus tard' });
  const laterState = async () => [await later.locator('.receipts path').nth(0).getAttribute('class'), await later.locator('.receipts path').nth(1).getAttribute('class')].join('|');
  await until('one tick', async () => (await laterState()) === '|off');
  assert.equal(await later.locator('.receipts .ticks').getAttribute('title'), 'Reçu par 1 appareil sur 2');
  const back = await c.context.newPage();
  await back.goto(APP);
  await until('two ticks once Chloé is back', async () => (await laterState()) === '|');

  await a.context.close();
  await b.context.close();
  await c.context.close();
  assert.deepEqual(problems, []);
});

test('pins: on top on every device, in the search too, spared by the history size, unpinned with a confirmation', { timeout: 120_000 }, async () => {
  const a = await device('Alice');
  const b = await device('Bob');
  await a.page.goto(APP);
  await a.page.locator('section.main').waitFor();
  await pair(a, b, (link) => b.page.goto(link));
  for (const text of ['Code Wi-Fi : poney-violet-42', 'Rendez-vous 14 h', 'Courses : pain, café']) {
    await a.page.locator('.note textarea').fill(text);
    await button(a.page.locator('.note-bar'), 'Envoyer').click();
    await b.page.locator('.history .item', { hasText: text }).waitFor();
  }
  const first = async (d) => (await d.page.locator('.history .item .content').first().textContent()).trim();
  assert.equal(await first(b), 'Courses : pain, café');

  // pinned on Bob: on top, on Alice too, its button pressed and a pin before the sender
  const wifi = b.page.locator('.history .item', { hasText: 'Code Wi-Fi' });
  await button(wifi, 'Épingler').click();
  assert.equal(await first(b), 'Code Wi-Fi : poney-violet-42');
  await until('on top on Alice', async () => (await first(a)) === 'Code Wi-Fi : poney-violet-42');
  const onAlice = a.page.locator('.history .item', { hasText: 'Code Wi-Fi' });
  assert.equal(await button(onAlice, 'Désépingler').getAttribute('aria-pressed'), 'true');
  assert.ok(await onAlice.locator('.meta .pin-mark').isVisible());
  assert.ok(!(await a.page.locator('.history .item', { hasText: 'Courses' }).locator('.meta .pin-mark').isVisible()));

  // the search keeps them first
  await button(a.page, 'Rechercher').click();
  await a.page.locator('.search-field input').fill('e');
  await until('search on Alice', async () => (await a.page.locator('.history .item').count()) === 3);
  assert.equal(await first(a), 'Code Wi-Fi : poney-violet-42');
  await a.page.locator('.search-bar').getByRole('button', { name: 'Fermer la recherche' }).click();

  // the history size spares it: one item, and the pinned one
  await a.page.getByLabel('Réglages').click();
  await a.page.locator('section.settings select').filter({ hasText: '1 élément' }).selectOption({ label: '1 élément' });
  await a.page.locator('section.settings').getByLabel('Retour', { exact: true }).click();
  await until('trimmed on Bob', async () => (await b.page.locator('.history .item').count()) === 2);
  assert.deepEqual((await b.page.locator('.history .item .content').allTextContents()).map((s) => s.trim()), ['Code Wi-Fi : poney-violet-42', 'Courses : pain, café']);

  // unpinned, it would go: asked first, then gone everywhere
  await button(wifi, 'Désépingler').click();
  const confirm = button(wifi, 'Désépingler et supprimer');
  await confirm.waitFor();
  await confirm.click();
  await until('gone on Alice', async () => (await a.page.locator('.history .item').count()) === 1);
  assert.equal(await first(a), 'Courses : pain, café');

  await a.context.close();
  await b.context.close();
  assert.deepEqual(problems, []);
});

test('iPhone in Safari: an invitation offers to install, or to go on in Safari', { timeout: 60_000 }, async () => {
  const a = await device('Alice');
  const d = await device('Dan', { phone: 'iphone' });
  await a.page.goto(APP);
  await a.page.locator('section.main').waitFor();
  await rename(a, 'Alice');
  await pair(a, d, async (link) => {
    await d.page.goto(link);
    const install = d.page.locator('section.page', { hasText: 'Installe Entre Nous' });
    await install.waitFor();
    assert.equal(new URL(d.page.url()).hash, '', 'the invitation leaves the address bar');
    await button(install, 'Utiliser dans Safari sans installer').click();
  });
  await until('Dan sees Alice', async () => (await d.page.locator('.status').textContent()).includes('Alice'));
  await a.context.close();
  await d.context.close();
  assert.deepEqual(problems, []);
});

const CLI = new URL('../../../cli/dist/entrenous.mjs', import.meta.url).pathname;

test('the command line and the browser: one group, both ways', { timeout: 60_000, skip: !existsSync(CLI) && 'cli not built' }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'entrenous-ui-cli-'));
  const cli = (...args) =>
    promisify(execFile)(process.execPath, [CLI, '--home', home, ...args], { env: { ...process.env, LANG: 'en_US.UTF-8', NO_COLOR: '1' } });
  const a = await device('Alice');
  await a.page.goto(APP);
  await a.page.locator('section.main').waitFor();
  await rename(a, 'Alice');
  // the browser invites, the terminal joins with the link shown under the QR code
  await a.page.getByLabel('Réglages').click();
  await button(a.page, 'Inviter un appareil').click();
  const link = await until('invitation link', () => a.page.locator('input.link:visible').inputValue());
  await cli('join', '--name', 'serveur', link);
  await a.page.locator('section.main').waitFor();
  // the terminal sends, the browser receives
  await cli('send', '-m', 'depuis le terminal');
  await a.page.locator('.history .item', { hasText: 'depuis le terminal' }).waitFor();
  // the browser sends, the terminal gets it
  await a.page.locator('input[type=file][multiple]').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('du navigateur') });
  await a.page.locator('.history .item', { hasText: 'notes.txt' }).waitFor();
  const { stdout } = await cli('get', '-o', '-');
  assert.equal(stdout, 'du navigateur');
  // listed as a terminal in the devices of the group
  await a.page.getByLabel('Réglages').click();
  await a.page.locator('.settings', { hasText: 'serveur' }).getByText('Terminal', { exact: true }).waitFor();
  await a.context.close();
  await rm(home, { recursive: true, force: true });
  assert.deepEqual(problems, []);
});

test('languages: English by the browser, French by the settings, the landing page by Accept-Language', { timeout: 60_000 }, async () => {
  const d = await device('Erin', { locale: 'en-GB' });
  await d.page.goto(APP);
  await d.page.locator('section.main').waitFor();
  assert.equal(await d.page.evaluate(() => document.documentElement.lang), 'en');
  assert.ok(await button(d.page, 'File').isVisible(), 'English main screen');
  assert.equal(await d.page.locator('.title strong').textContent(), 'My devices');

  // French chosen in the settings: everything follows at once, and after a reload
  await d.page.getByLabel('Settings').click();
  await d.page.getByLabel('Language').selectOption('fr');
  await d.page.getByText('Cet appareil', { exact: true }).waitFor();
  await d.page.locator('section.settings').getByLabel('Retour', { exact: true }).click();
  await button(d.page, 'Fichier').waitFor(); // French main screen
  await d.page.reload();
  await d.page.locator('section.main').waitFor();
  assert.equal(await d.page.evaluate(() => document.documentElement.lang), 'fr');
  // back to the browser's language
  await d.page.getByLabel('Réglages').click();
  await d.page.getByLabel('Langue').selectOption('');
  await d.page.getByText('This device', { exact: true }).waitFor();

  // landing page: / by Accept-Language (English for any language but French), /fr/ and /en/
  const root = APP.replace(/app\/$/, '');
  const page = async (path, lang) => {
    const res = await fetch(root + path, { headers: lang ? { 'Accept-Language': lang } : {} });
    assert.equal(res.status, 200, path);
    return /<html lang="(\w+)"/.exec(await res.text())[1];
  };
  assert.equal(await page('', 'fr-FR,fr;q=0.9,en;q=0.8'), 'fr');
  assert.equal(await page('', 'de-DE,en;q=0.5,fr;q=0.9'), 'fr');
  assert.equal(await page('', 'de-DE'), 'en');
  assert.equal(await page('', 'en-US,fr;q=0.5'), 'en');
  assert.equal(await page('fr/', 'en-US'), 'fr');
  assert.equal(await page('en/', 'fr-FR'), 'en');
  await d.context.close();
  assert.deepEqual(problems, []);
});

const FIXTURES = new URL('./fixtures/', import.meta.url).pathname;

test('previews: tiles, image, Markdown (safe), text, streamed video, deletion', { timeout: 120_000 }, async () => {
  const a = await device('Alice');
  const b = await device('Bob', { phone: true });
  await a.page.goto(APP);
  await a.page.locator('section.main').waitFor();
  await pair(a, b, (link) => b.page.goto(link));
  const md = [
    '# Réunion produit',
    '',
    'Décisions : **sortir le CLI**.',
    '',
    '- [x] tester',
    '- [ ] publier',
    '',
    "<script>window.__ran = true</script> [piège](javascript:window.__ran=true) https://example.com",
  ].join('\n');
  const log = Array.from({ length: 300 }, (_, i) => `ligne ${i + 1}`).join('\n');
  // the video (H.264 + AAC, its index at the end, two chunks) first, so that it is the oldest
  for (const f of [
    `${FIXTURES}clip.mp4`,
    `${FIXTURES}photo.jpg`,
    { name: 'notes.md', mimeType: '', buffer: Buffer.from(md) },
    { name: 'journal.log', mimeType: 'text/plain', buffer: Buffer.from(log) },
    // a HEIC: Chrome cannot read it, sent without a preview
    { name: 'iphone.heic', mimeType: 'image/heic', buffer: Buffer.from('not really a HEIC photo') },
  ]) {
    await a.page.locator('input[type=file][multiple]').setInputFiles(f);
    await b.page.locator('.history .item', { hasText: typeof f === 'string' ? f.split('/').pop() : f.name }).waitFor();
  }
  await until('uploads over', async () => (await b.page.locator('.transfer').count()) === 0, 20_000);

  // ---- the history: made by the sender, shown before any download
  const item = (name) => b.page.locator('.history .item', { hasText: name });
  await item('clip.mp4').locator('.thumb.pic.video').waitFor();
  assert.equal(await item('clip.mp4').locator('.badge').textContent(), '0:08');
  assert.ok(await button(item('clip.mp4'), 'Lire').isVisible(), 'a video plays');
  assert.equal(await item('notes.md').locator('.thumb.doc .badge').textContent(), 'MD');
  assert.match(await item('notes.md').locator('.excerpt').textContent(), /^# Réunion produit Décisions/);
  assert.ok(await button(item('notes.md'), 'Ouvrir').isVisible(), 'a document opens');
  assert.ok(await button(item('photo.jpg'), 'Voir').isVisible(), 'an image is viewed');
  const thumb = await item('photo.jpg').locator('.thumb img').getAttribute('src');
  assert.match(thumb, /^data:image\/jpeg;base64,/, 'preview in JPEG');
  assert.ok(Buffer.from(thumb.split(',')[1], 'base64').includes(Buffer.from([0xff, 0xc2])), 'a progressive JPEG');

  // ---- Markdown: formatted, nothing of the file's own markup, no javascript: link
  await button(item('notes.md'), 'Ouvrir').click();
  const viewer = b.page.locator('section.viewer');
  await viewer.locator('.markdown h1', { hasText: 'Réunion produit' }).waitFor();
  assert.equal(await viewer.locator('.markdown script').count(), 0);
  assert.equal(await viewer.locator('.markdown input[type=checkbox]').count(), 2);
  const links = await viewer.locator('.markdown a').evaluateAll((all) => all.map((x) => x.getAttribute('href')));
  assert.deepEqual(links, ['https://example.com']);
  assert.equal(await b.page.evaluate(() => window.__ran), undefined);
  await button(viewer, 'Texte brut').click();
  await until('Markdown as plain text', async () => (await viewer.locator('.lines .ln').count()) === 8);
  await viewer.getByLabel('Retour', { exact: true }).click();
  await viewer.waitFor({ state: 'hidden' });

  // ---- text: numbered lines; the next items with the arrows
  await button(item('journal.log'), 'Ouvrir').click();
  await until('300 lines', async () => (await viewer.locator('.lines .ln').count()) === 300);
  assert.equal(await viewer.locator('.viewer-count').textContent(), '2 / 5');
  await b.page.keyboard.press('Escape');
  await viewer.waitFor({ state: 'hidden' });

  // ---- an image without a preview: said so, nothing else
  await button(item('iphone.heic'), 'Voir').click();
  await viewer.locator('.viewer-error', { hasText: 'Pas d’aperçu pour cette image' }).waitFor();
  assert.equal(await viewer.locator('.viewer-image').isVisible(), false);
  await viewer.getByLabel('Retour', { exact: true }).click();

  // ---- image: the sender's preview (720 px), nothing downloaded; the original's size in pixels
  await button(item('photo.jpg'), 'Voir').click();
  await until('image shown', () => viewer.locator('.viewer-image').evaluate((i) => i.complete && i.naturalWidth === 720 && i.naturalHeight === 540));
  assert.match(await viewer.locator('.viewer-image').getAttribute('src'), /^data:image\/jpeg;base64,/);
  assert.match(await viewer.locator('.viewer-title span').textContent(), /800 × 600/);
  assert.equal(await b.page.evaluate(() => document.querySelectorAll('.transfer').length), 0, 'the photo is not downloaded');

  await viewer.getByLabel('Élément précédent').click();
  await viewer.locator('.markdown h1').waitFor(); // the Markdown, newer

  // ---- video: streamed (MediaSource), it plays, a jump forward plays to the end
  await viewer.getByLabel('Retour', { exact: true }).click();
  await button(item('clip.mp4'), 'Lire').click();
  const video = viewer.locator('video');
  await video.evaluate((v) => {
    v.muted = true;
    return v.play().catch(() => {});
  });
  await until('video plays', () => video.evaluate((v) => v.currentTime > 0.5), 20_000);
  assert.ok(await video.evaluate((v) => v.src.startsWith('blob:') && v.duration > 7.9 && v.duration < 8.2), 'a MediaSource of 8 s');
  assert.equal(await b.page.evaluate(() => document.querySelectorAll('.transfer').length), 0, 'not downloaded as a whole');
  await video.evaluate((v) => (v.currentTime = 6.5));
  await until('video ends', () => video.evaluate((v) => v.ended), 20_000);
  assert.ok(await viewer.locator('.viewer-actions').getByText('Plein écran').isVisible());

  // ---- deleted from the preview: gone everywhere, the preview closes
  await viewer.getByLabel('Supprime l’élément sur tous les appareils').click();
  await viewer.getByText('Supprimer partout').click();
  await viewer.waitFor({ state: 'hidden' });
  await a.page.locator('.history .item', { hasText: 'clip.mp4' }).waitFor({ state: 'detached' });
  await a.context.close();
  await b.context.close();
  assert.deepEqual(problems, []);
});

test('songs: MP3, M4A, Opus, FLAC and WAV streamed, jumps to the middle and near the end', { timeout: 180_000 }, async () => {
  const a = await device('Alice');
  const b = await device('Bob');
  await a.page.goto(APP);
  await a.page.locator('section.main').waitFor();
  await pair(a, b, (link) => b.page.goto(link));
  // two chunks each: an MP3 (ID3, Info header), an M4A (its index at the end), Opus in Ogg,
  // FLAC (its frames as they are), WAV (16 bits, put into FLAC frames)
  const songs = [
    { f: 'song.mp3', length: 300, badge: '5:00' },
    { f: 'song.m4a', length: 300, badge: '5:00' },
    { f: 'song.opus', length: 300, badge: '5:00' },
    { f: 'song.flac', length: 110, badge: '1:50' },
    { f: 'song.wav', length: 80, badge: '1:20' },
  ];
  for (const { f } of songs) {
    await a.page.locator('input[type=file][multiple]').setInputFiles(`${FIXTURES}${f}`);
    await b.page.locator('.history .item', { hasText: f }).waitFor();
  }
  await until('uploads over', async () => (await b.page.locator('.transfer').count()) === 0, 90_000);

  const item = (name) => b.page.locator('.history .item', { hasText: name });
  const viewer = b.page.locator('section.viewer');
  for (const { f, length, badge } of songs) {
    // the history: a note, the length given by the sender, Listen
    await item(f).locator('.thumb.doc.audio .note').waitFor();
    assert.equal(await item(f).locator('.badge').textContent(), badge, f);
    await button(item(f), 'Écouter').click();
    const audio = viewer.locator('audio');
    await audio.evaluate((el) => {
      el.muted = true;
      return el.play().catch(() => {});
    });
    await until(`${f} plays`, () => audio.evaluate((el) => el.currentTime > 0.5), 20_000);
    const duration = await audio.evaluate((el) => el.duration);
    assert.ok(Math.abs(duration - length) < 2, `${f}: a MediaSource of ${length} s, not ${duration}`);
    assert.equal(await b.page.evaluate(() => document.querySelectorAll('.transfer').length), 0, 'not downloaded as a whole');
    const ahead = await audio.evaluate((el) => el.buffered.end(el.buffered.length - 1));
    assert.ok(ahead < length - 10, `${f}: streamed, ${ahead} s buffered, not the whole song`);
    const middle = Math.round(length / 2);
    await audio.evaluate((el, t) => (el.currentTime = t), middle);
    await until(`${f} plays from the middle`, () => audio.evaluate((el, t) => el.currentTime > t + 1 && el.currentTime < t + 10, middle), 20_000);
    await audio.evaluate((el, t) => (el.currentTime = t), length - 4);
    // at its end, the next one sent; the last one stops there
    const next = songs[songs.findIndex((s) => s.f === f) + 1];
    if (next) await viewer.locator('.viewer-title strong', { hasText: next.f }).waitFor({ timeout: 30_000 });
    else await until(`${f} ends`, () => audio.evaluate((el) => el.ended), 30_000);
    assert.ok(!(await viewer.locator('.viewer-actions').getByText('Copier le texte').isVisible()), 'no text to copy');
    await b.page.keyboard.press('Escape');
    await viewer.waitFor({ state: 'hidden' });
  }
  await a.context.close();
  await b.context.close();
  assert.deepEqual(problems, []);
});

test('songs one after another: previous, next, loop, up next, the system told', { timeout: 180_000 }, async () => {
  const a = await device('Alice');
  const b = await device('Bob');
  // the Media Session: what the system is told, and its buttons, kept to be checked
  await b.context.addInitScript(`window.__media = {};
    navigator.mediaSession.setActionHandler = (name, fn) => { window.__media[name] = fn; };`);
  await a.page.goto(APP);
  await a.page.locator('section.main').waitFor();
  await pair(a, b, (link) => b.page.goto(link));
  // three songs sent in this order, a photo between them
  for (const f of ['song.mp3', 'photo.jpg', 'song.m4a', 'song.opus']) {
    await a.page.locator('input[type=file][multiple]').setInputFiles(`${FIXTURES}${f}`);
    await b.page.locator('.history .item', { hasText: f }).waitFor();
  }
  await until('uploads over', async () => (await b.page.locator('.transfer').count()) === 0, 90_000);
  const viewer = b.page.locator('section.viewer');
  const audio = viewer.locator('audio');
  const title = viewer.locator('.viewer-title strong');
  const playing = (f) => viewer.locator('.viewer-title strong', { hasText: f }).waitFor({ timeout: 30_000 });
  const plays = () => until('it plays', () => audio.evaluate((el) => !el.paused && el.currentTime > 0.3), 20_000);
  const queue = () => viewer.locator('.audio-queue button').allTextContents();
  const loop = viewer.locator('.loop-mode');

  await button(b.page.locator('.history .item', { hasText: 'song.m4a' }), 'Écouter').click();
  await audio.evaluate((el) => {
    el.muted = true;
    return el.play().catch(() => {});
  });
  await plays();
  // up next: this one, then the next one sent (not the photo), in sending order
  assert.deepEqual(await queue(), ['song.m4a5:00', 'song.opus5:00']);
  assert.equal(await loop.textContent().then((x) => x.trim()), 'Pas de boucle');
  // the system: the song's name, playing, and its buttons
  await until('told to the system', () => b.page.evaluate(() => navigator.mediaSession.metadata?.title === 'song' && navigator.mediaSession.playbackState === 'playing'));
  assert.ok(await b.page.evaluate(() => typeof window.__media.nexttrack === 'function' && typeof window.__media.previoustrack === 'function'));

  // previous, early in the song: the one sent before
  await viewer.getByLabel('Audio précédent').click();
  await playing('song.mp3');
  await plays();
  assert.deepEqual(await queue(), ['song.mp35:00', 'song.m4a5:00', 'song.opus5:00']);
  // later in the song: back to its start
  await audio.evaluate((el) => (el.currentTime = 60));
  await until('at 60 s', () => audio.evaluate((el) => el.currentTime > 60));
  await viewer.getByLabel('Audio précédent').click();
  await until('back to the start', () => audio.evaluate((el) => el.currentTime < 5));
  assert.match(await title.textContent(), /song\.mp3/);

  // next, from the headset (the system's button)
  await b.page.evaluate(() => window.__media.nexttrack({ action: 'nexttrack' }));
  await playing('song.m4a');
  await b.page.evaluate(() => window.__media.nexttrack({ action: 'nexttrack' }));
  await playing('song.opus');
  await plays();
  // the last one: no next, unless everything loops
  assert.ok(await viewer.getByLabel('Audio suivant').isDisabled());
  assert.equal(await b.page.evaluate(() => window.__media.nexttrack), null, 'no next button for the system');

  // the loop, kept on this device: this file, then the whole history
  await loop.click();
  assert.equal(await loop.textContent().then((x) => x.trim()), 'Ce fichier');
  assert.equal(await loop.getAttribute('title'), 'Boucle sur le fichier');
  await audio.evaluate((el) => (el.currentTime = 296));
  await until('ended, then again from the start', () => audio.evaluate((el) => el.currentTime > 0.3 && el.currentTime < 10 && !el.paused), 30_000);
  assert.match(await title.textContent(), /song\.opus/);
  await loop.click();
  assert.equal(await loop.getAttribute('title'), 'Boucle sur l’historique');
  assert.deepEqual(await queue(), ['song.opus5:00', 'song.mp35:00', 'song.m4a5:00']);
  await audio.evaluate((el) => (el.currentTime = 296));
  await playing('song.mp3'); // round again
  await plays();
  // a song of the queue, touched
  await viewer.locator('.audio-queue button', { hasText: 'song.opus' }).click();
  await playing('song.opus');

  // paused from the lock screen, then closed: the system is told
  await b.page.evaluate(() => window.__media.pause({ action: 'pause' }));
  await until('paused', () => audio.evaluate((el) => el.paused));
  await until('told paused', () => b.page.evaluate(() => navigator.mediaSession.playbackState === 'paused'));
  await b.page.keyboard.press('Escape');
  await viewer.waitFor({ state: 'hidden' });
  assert.equal(await b.page.evaluate(() => navigator.mediaSession.metadata), null);

  // the loop mode, still there after a reload
  await b.page.reload();
  await button(b.page.locator('.history .item', { hasText: 'song.mp3' }), 'Écouter').click();
  assert.equal(await loop.getAttribute('title'), 'Boucle sur l’historique');
  await loop.click();
  assert.equal(await loop.getAttribute('title'), 'Pas de boucle');
  await a.context.close();
  await b.context.close();
  assert.deepEqual(problems, []);
});

test('PDF: first page and page count from the sender, pages drawn as they show, zoom', { timeout: 120_000 }, async () => {
  const a = await device('Alice');
  const b = await device('Bob');
  await a.page.goto(APP);
  await a.page.locator('section.main').waitFor();
  await pair(a, b, (link) => b.page.goto(link));
  // 12 pages, two chunks: the text pages, then a big image (last page), the table at the end
  await a.page.locator('input[type=file][multiple]').setInputFiles(`${FIXTURES}doc.pdf`);
  const item = b.page.locator('.history .item', { hasText: 'doc.pdf' });
  await item.waitFor();
  await until('upload over', async () => (await b.page.locator('.transfer').count()) === 0, 60_000);

  // ---- the history: the first page as a thumbnail, PDF, Open
  await item.locator('.thumb.pic.pdf img').waitFor();
  assert.equal(await item.locator('.badge').textContent(), 'PDF');
  await button(item, 'Ouvrir').click();
  const viewer = b.page.locator('section.viewer');
  assert.match(await viewer.locator('.viewer-title span').textContent(), /12 pages/);

  // ---- pages: the first drawn at once, a far one only once it shows
  const pages = viewer.locator('.pdf-pages .pdf-page');
  await until('12 frames', async () => (await pages.count()) === 12, 20_000);
  const drawn = (n) => pages.nth(n - 1).locator('canvas').evaluate((c) => c.width > 0);
  await until('page 1 drawn', () => drawn(1), 20_000);
  assert.equal(await viewer.locator('.pdf-count').textContent(), 'Page 1 / 12');
  assert.ok(!(await drawn(12)), 'the last page waits');
  assert.equal(await b.page.evaluate(() => document.querySelectorAll('.transfer').length), 0, 'not downloaded as a whole');
  // page 1 holds text: dark pixels on white
  const ink = await pages.nth(0).locator('canvas').evaluate((c) => {
    const d = c.getContext('2d').getImageData(0, 0, c.width, Math.floor(c.height / 3)).data;
    let dark = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] < 100) dark++;
    return dark;
  });
  assert.ok(ink > 100, `page 1 has ink (${ink} dark pixels)`);

  // ---- its text: selectable, copied by "Copy the selection"
  const text = pages.nth(0).locator('.textLayer');
  await text.locator('span', { hasText: 'Page 1' }).waitFor();
  assert.ok(!(await button(viewer, 'Copier la sélection').isVisible()), 'nothing selected yet');
  await text.locator('span', { hasText: 'Entre Nous' }).evaluate((span) => {
    const range = document.createRange();
    range.selectNodeContents(span);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  });
  await button(viewer, 'Copier la sélection').waitFor();
  assert.match(await b.page.evaluate(() => getSelection().toString()), /Entre Nous : apercu PDF/);
  await b.page.evaluate(() => getSelection().removeAllRanges());
  await button(viewer, 'Copier la sélection').waitFor({ state: 'hidden' });

  // ---- its links: a web link opens outside, the other goes to the last page
  const web = pages.nth(0).locator('.pdf-links a[href="https://example.com/"]');
  await web.waitFor();
  assert.equal(await web.getAttribute('target'), '_blank');
  assert.equal(await web.getAttribute('rel'), 'noopener noreferrer');
  await pages.nth(0).locator('.pdf-links a[href="#"]').click();
  await until('page 12 drawn', () => drawn(12), 20_000);
  await until('page 12 in view', async () => (await viewer.locator('.pdf-count').textContent()) === 'Page 12 / 12');

  // ---- zoom: wider pages, the same page kept in view
  const width = () => pages.nth(0).evaluate((p) => p.getBoundingClientRect().width);
  const before = await width();
  await viewer.getByLabel('Agrandir').last().click();
  await until('zoomed', async () => (await width()) > before * 1.4);
  assert.equal(await viewer.locator('.segmented .zoom').textContent(), '150 %');
  await until('still on page 12', () => drawn(12), 20_000);
  await viewer.getByLabel('À la largeur de l’écran').click();
  await until('back to the width', async () => Math.abs((await width()) - before) < 2);

  await b.page.keyboard.press('Escape');
  await viewer.waitFor({ state: 'hidden' });
  await a.context.close();
  await b.context.close();
  assert.deepEqual(problems, []);
});

test('what is new: shown once after an update, from the changelog built in', { timeout: 60_000 }, async () => {
  const d = await device('Fanny');
  await d.page.goto(APP);
  await d.page.locator('section.main').waitFor();
  const version = /Version ([\d.]+)/.exec(await d.page.locator('section.settings').textContent())?.[1];
  if (!version || version === '0.0.0') return; // a relay built without its version: nothing to compare
  const news = d.page.locator('.news');
  assert.ok(await news.isHidden(), 'nothing on a first run');
  // as if the app had been used in 0.1.17, then updated
  await d.page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open('entrenous', 1);
        req.onsuccess = () => {
          const store = req.result.transaction('kv', 'readwrite').objectStore('kv');
          const get = store.get('prefs');
          get.onsuccess = () => {
            const prefs = JSON.parse(get.result);
            prefs.newsSeen = '0.1.17';
            store.put(JSON.stringify(prefs), 'prefs').onsuccess = resolve;
          };
        };
        req.onerror = reject;
      }),
  );
  await d.page.reload();
  await news.waitFor();
  assert.equal(await news.locator('strong').first().textContent(), 'Nouveautés depuis la version 0.1.17');
  assert.ok((await news.textContent()).includes('Prévisualisation'));
  assert.ok(!(await news.textContent()).includes('Première version'), 'only what came after 0.1.17');
  await button(news, 'Compris').click();
  await news.waitFor({ state: 'hidden' });
  await d.page.reload();
  await d.page.locator('section.main').waitFor();
  await sleep(500);
  assert.ok(await news.isHidden(), 'shown once');
  await d.context.close();
  assert.deepEqual(problems, []);
});

test('share links: made from the history, opened outside the group, kept for the link alone, deleted', { timeout: 120_000 }, async () => {
  const a = await device('Alice');
  const b = await device('Bob');
  const visitor = await device('Visiteur');
  await a.page.goto(APP);
  await a.page.locator('section.main').waitFor();
  await rename(a, 'Alice');
  await pair(a, b, (link) => b.page.goto(link));

  // a text and a text file, sent by Alice
  await a.page.locator('.note textarea').fill('Rendez-vous à 18 h');
  await button(a.page.locator('.note-bar'), 'Envoyer').click();
  const content = Buffer.from('Liste des courses\n- pain\n- fromage\n'.repeat(200));
  await a.page.locator('input[type=file][multiple]').setInputFiles({ name: 'courses.txt', mimeType: 'text/plain', buffer: content });
  const textA = a.page.locator('.history .item:not(.shared-link)', { hasText: 'Rendez-vous à 18 h' });
  const fileA = a.page.locator('.history .item:not(.shared-link)', { hasText: 'courses.txt' });
  await textA.waitFor();
  await until('file complete', async () => !/envoi/.test(await fileA.locator('.meta').textContent()));

  // ---- the share button: discreet, an icon; the page slides in, the link is made at once, 1 h
  const share = button(textA, 'Partager');
  assert.ok(await share.isVisible(), 'a share button on an item');
  assert.equal((await share.textContent()).trim(), '', 'an icon only');
  await share.click();
  const page = a.page.locator('section.share-page');
  await page.waitFor();
  assert.ok(await a.page.locator('section.main').isHidden());
  const link = await until('share link', () => page.locator('input.link').inputValue());
  assert.match(link, /^http:\/\/127\.0\.0\.1:8080\/s\/#[A-Za-z0-9_-]{43}$/);
  await page.locator('img.qr').waitFor(); // a QR code
  assert.equal(await button(page, '1 h').getAttribute('aria-pressed'), 'true');
  assert.match(await page.textContent(), /Expire dans 1 h/);
  // another lifetime: the same link
  await button(page, '7 j').click();
  await until('7 days', async () => /Expire dans 7 j/.test(await page.textContent()));
  assert.equal(await page.locator('input.link').inputValue(), link, 'the address does not change');
  assert.ok((await page.locator('.segmented button').allTextContents()).join() === '10 min,1 h,24 h,7 j');
  await button(page, 'Retour').click();
  await a.page.locator('section.main').waitFor();

  // ---- in Alice's history, and only there
  const entry = a.page.locator('.history .item.shared-link', { hasText: 'Rendez-vous à 18 h' });
  await entry.waitFor();
  assert.match(await entry.locator('.meta').textContent(), /Lien de partage · expire dans 7 j/);
  assert.ok(await button(entry, 'Copier le lien').isVisible());
  await sleep(500);
  assert.equal(await b.page.locator('.history .item.shared-link').count(), 0, 'not on the other devices');

  // ---- opened outside the group, without an account
  await visitor.page.goto(link);
  await visitor.page.locator('.visit-lead', { hasText: 'Quelqu’un partage un texte avec toi.' }).waitFor();
  assert.equal(await visitor.page.locator('pre.visit-text').textContent(), 'Rendez-vous à 18 h');
  assert.ok(await button(visitor.page, 'Copier').isVisible());
  assert.match(await visitor.page.locator('#meta').textContent(), /expire dans 7 j/);

  // ---- a file: its start shown, downloaded whole
  await button(fileA, 'Partager').click();
  const fileLink = await until('file link', () => page.locator('input.link').inputValue());
  assert.notEqual(fileLink, link);
  await button(page, 'Retour').click();
  await visitor.page.goto(fileLink);
  await visitor.page.locator('.visit-name', { hasText: 'courses.txt' }).waitFor();
  assert.match(await visitor.page.locator('pre.visit-text').textContent(), /^Liste des courses\n- pain/);
  const download = visitor.page.waitForEvent('download');
  await button(visitor.page, 'Télécharger').click();
  const saved = await readFile(await (await download).path());
  assert.ok(saved.equals(content), 'the downloaded file is the one sent');

  // ---- the item leaves the group: the link still works
  await fileA.locator('button.danger').click();
  await fileA.locator('button.danger').click();
  await b.page.locator('.history .item', { hasText: 'courses.txt' }).waitFor({ state: 'detached' });
  await visitor.page.reload();
  await visitor.page.locator('.visit-name', { hasText: 'courses.txt' }).waitFor();
  const fileEntry = a.page.locator('.history .item.shared-link', { hasText: 'courses.txt' });
  assert.ok(await fileEntry.isVisible(), 'the link stays in the history');

  // ---- deleted by Alice: it stops working
  await fileEntry.locator('button.danger').click();
  assert.equal(await fileEntry.locator('button.danger').textContent(), 'Confirmer : supprimer le lien');
  await fileEntry.locator('button.danger').click();
  await fileEntry.waitFor({ state: 'detached' });
  await visitor.page.reload();
  await visitor.page.getByText('Ce lien n’est plus valable : il a expiré ou il a été supprimé.').waitFor();

  // ---- a link cut short
  await visitor.page.goto(link.slice(0, -5));
  await visitor.page.getByText('Ce lien est incomplet. Vérifie qu’il a été copié en entier.').waitFor();

  for (const d of [a, b, visitor]) await d.context.close();
  assert.deepEqual(problems, []);
});

test('texts: a link opens in the browser, a short text or a small text file as a QR code', { timeout: 120_000 }, async () => {
  const a = await device('Alice');
  const b = await device('Bob');
  await a.page.goto(APP);
  await a.page.locator('section.main').waitFor();
  await pair(a, b, (link) => b.page.goto(link));
  // no real web: the link opened answers here
  await b.context.route('https://example.org/**', (r) => r.fulfill({ contentType: 'text/html', body: 'ok' }));

  const send = async (text) => {
    await a.page.locator('.note textarea').fill(text);
    await button(a.page.locator('.note-bar'), 'Envoyer').click();
  };
  const wifi = 'Wi-Fi « Maison » : mot de passe ç€🙂 Merlin42';
  await send('https://example.org/page?a=1');
  await send('Regarde ça : https://example.org/autre.');
  await send(wifi);
  await send('long '.repeat(300));
  const md = '# Courses\n\n- pain\n- fromage\n';
  await a.page.locator('input[type=file][multiple]').setInputFiles({ name: 'notes.md', mimeType: 'text/markdown', buffer: Buffer.from(md) });
  const item = (text) => b.page.locator('.history .item:not(.shared-link)', { hasText: text });
  await item('notes.md').waitFor();
  await until('file complete', async () => !/envoi/.test(await item('notes.md').locator('.meta').textContent()));

  // ---- a link alone: Open first, Copy after; opened in a new tab
  const link = item('https://example.org/page');
  const open = button(link, 'Ouvrir');
  assert.ok(await open.isVisible());
  assert.match(await open.getAttribute('class'), /primary/);
  assert.match(await button(link, 'Copier').getAttribute('class'), /secondary/);
  assert.equal(await open.getAttribute('title'), 'Ouvrir https://example.org/page?a=1 dans le navigateur');
  const tab = b.context.waitForEvent('page');
  await open.click();
  const opened = await tab;
  await opened.waitForLoadState();
  assert.equal(opened.url(), 'https://example.org/page?a=1');
  await opened.close();

  // ---- a link among other words: Copy first, Open after, without the final dot
  const among = item('Regarde ça');
  assert.match(await button(among, 'Copier').getAttribute('class'), /primary/);
  assert.equal(await button(among, 'Ouvrir').getAttribute('title'), 'Ouvrir https://example.org/autre dans le navigateur');
  assert.equal(await button(item(wifi), 'Ouvrir').count(), 0, 'no link: no Open');

  // ---- a QR code, made here: what a phone reads is the text itself
  const read = async () => {
    const { w, h, px } = await b.page.locator('section.qr-page img.qr').evaluate(async (img) => {
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const g = c.getContext('2d');
      g.drawImage(img, 0, 0);
      return { w: c.width, h: c.height, px: Array.from(g.getImageData(0, 0, c.width, c.height).data) };
    });
    return jsQR(Uint8ClampedArray.from(px), w, h)?.data;
  };
  const qr = button(item(wifi), 'QR code');
  assert.equal((await qr.textContent()).trim(), '', 'an icon only');
  await qr.click();
  const page = b.page.locator('section.qr-page');
  await page.locator('img.qr').waitFor();
  assert.ok(await b.page.locator('section.main').isHidden());
  assert.equal(await page.locator('.share-name').textContent(), wifi);
  assert.match(await page.textContent(), /le texte s’affiche/);
  assert.equal(await read(), wifi, 'accents and emoji kept');
  await button(page, 'Retour').click();
  await b.page.locator('section.main').waitFor();

  // a link: the phone opens it
  await button(link, 'QR code').click();
  await page.locator('img.qr').waitFor();
  assert.match(await page.textContent(), /il ouvre le lien/);
  assert.equal(await read(), 'https://example.org/page?a=1');
  await b.page.keyboard.press('Escape');
  await b.page.locator('section.main').waitFor();

  // a small text file: read, then shown
  await button(item('notes.md'), 'QR code').click();
  await page.locator('img.qr').waitFor();
  assert.equal(await read(), md);
  await button(page, 'Retour').click();
  await b.page.locator('section.main').waitFor();

  // too long for a phone to read on a screen: no QR code
  assert.equal(await button(item('long long'), 'QR code').count(), 0);
  assert.ok(await button(item(wifi), 'QR code').isVisible());

  for (const d of [a, b]) await d.context.close();
  assert.deepEqual(problems, []);
});

test('file requests: made from the top bar, files sent from a browser, on every device, deleted', { timeout: 120_000 }, async () => {
  const a = await device('Alice');
  const b = await device('Bob');
  const guest = await device('Invitée', { phone: true });
  await a.page.goto(APP);
  await a.page.locator('section.main').waitFor();
  await rename(a, 'Alice');
  await pair(a, b, (link) => b.page.goto(link));

  // ---- the icon in the top bar; the page slides in, the link is made at once, 24 h
  await a.page.getByLabel('Recevoir des fichiers', { exact: true }).click();
  const page = a.page.locator('section.drop-page');
  await page.waitFor();
  assert.ok(await a.page.locator('section.main').isHidden());
  const link = await until('request link', () => page.locator('input.link').inputValue());
  assert.match(link, /^http:\/\/127\.0\.0\.1:8080\/r\/#[A-Za-z0-9_-]{43}$/);
  await page.locator('img.qr').waitFor();
  assert.equal(await button(page, '24 h').getAttribute('aria-pressed'), 'true');
  assert.equal((await page.locator('.segmented button').allTextContents()).join(), '1 h,24 h,7 j');
  assert.match(await page.textContent(), /Expire dans 2[34] h/);
  assert.doesNotMatch(await page.textContent(), /\d+ (Go|Mo)/, 'no size limit shown');
  const message = page.getByLabel('Message affiché sur la page (facultatif)');
  await message.fill('Les photos de samedi');
  await message.blur();

  // ---- on every device of the group, on top of the history
  const entryB = b.page.locator('.history .item.shared-link', { hasText: 'Les photos de samedi' });
  await entryB.waitFor();
  assert.match(await entryB.locator('.meta').textContent(), /^Demande de fichiers · expire dans 2[34] h$/);
  await button(page, 'Retour').click();
  await a.page.locator('section.main').waitFor();
  const entryA = a.page.locator('.history .item.shared-link', { hasText: 'Les photos de samedi' });
  await entryA.waitFor();

  // ---- the page of the link, on a phone outside the group
  await guest.page.goto(link);
  await guest.page.locator('.visit-lead', { hasText: 'Quelqu’un te demande des fichiers.' }).waitFor();
  assert.equal(await guest.page.locator('#ask-text').textContent(), 'Les photos de samedi');
  await guest.page.getByLabel('Ton prénom (facultatif)').fill('Marie');
  // two files at once: one item, a folder
  const one = Buffer.from('premier fichier\n'.repeat(100));
  const two = randomFillSync(Buffer.alloc(1_500_000));
  await guest.page.locator('#files').setInputFiles([
    { name: 'premier.txt', mimeType: 'text/plain', buffer: one },
    { name: 'second.bin', mimeType: 'application/octet-stream', buffer: two },
  ]);
  const rows = guest.page.locator('.deposit-list li');
  await until('two sent', async () => (await rows.locator('.deposit-state.done').count()) === 2);
  assert.equal(await guest.page.locator('#pick').textContent(), 'Ajouter des fichiers');
  for (const d of [a, b]) {
    const folder = d.page.locator('.history .item:not(.shared-link)', { hasText: 'Envoi de Marie' });
    await folder.waitFor();
    await until('complete', async () => /2 fichiers/.test(await folder.locator('.meta').textContent()) && !/envoi en cours/i.test(await folder.locator('.meta').textContent()));
    assert.match((await folder.locator('.meta').textContent()).trim(), /^Marie ·/);
  }
  // then one file: an item of its own
  await guest.page.locator('#files').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('à lire') });
  await until('third sent', async () => (await rows.locator('.deposit-state.done').count()) === 3);
  const notes = b.page.locator('.history .item:not(.shared-link)', { hasText: 'notes.txt' });
  await notes.waitFor();
  assert.match((await notes.locator('.meta').textContent()).trim(), /^Marie ·/);
  await until('counted', async () => /2 envois/.test(await entryA.locator('.meta').textContent()));
  // the name is remembered on the phone
  await guest.page.reload();
  await guest.page.locator('.visit-lead').waitFor();
  assert.equal(await guest.page.getByLabel('Ton prénom (facultatif)').inputValue(), 'Marie');

  // ---- deleted on Bob's device: gone everywhere, the page says so; what came stays
  await entryB.locator('button.danger').click();
  assert.equal(await entryB.locator('button.danger').textContent(), 'Confirmer : supprimer le lien');
  await entryB.locator('button.danger').click();
  await entryA.waitFor({ state: 'detached' });
  assert.ok(await a.page.locator('.history .item', { hasText: 'Envoi de Marie' }).isVisible());
  await guest.page.reload();
  await guest.page.getByText('Ce lien n’est plus valable : il a expiré ou il a été supprimé.').waitFor();

  for (const d of [a, b, guest]) await d.context.close();
  assert.deepEqual(problems, []);
});

test('search: words without accents, highlighted, a long text from its match, type chips, keyboard, phone', { timeout: 120_000 }, async () => {
  const a = await device('Alice');
  const b = await device('Bob', { phone: true });
  await a.context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(APP).origin });
  await a.page.goto(APP);
  await a.page.locator('section.main').waitFor();
  const loupe = a.page.locator('.bar-actions').getByRole('button', { name: 'Rechercher' });
  assert.ok(await loupe.isHidden(), 'no magnifier while the history is empty');

  const texts = ['Code Wi-Fi invités : Merlin-étoile-2026', 'Le train : https://example.org/billet', 'ligne\n'.repeat(10) + 'le digicode est 4B71'];
  for (const text of texts) {
    await a.page.locator('.note textarea').fill(text);
    await button(a.page.locator('.note-bar'), 'Envoyer').click();
    await a.page.locator('.history .item', { hasText: text.trim().split('\n').pop() }).waitFor();
  }
  await a.page.locator('input[type=file][multiple]').setInputFiles([
    { name: 'photo.jpg', mimeType: 'image/jpeg', buffer: await readFile(FIXTURES + 'photo.jpg') },
    { name: 'clip.mp4', mimeType: 'video/mp4', buffer: await readFile(FIXTURES + 'clip.mp4') },
    { name: 'Facture-novembre.pdf', mimeType: 'application/pdf', buffer: await readFile(FIXTURES + 'doc.pdf') },
    { name: 'notes.md', mimeType: 'text/markdown', buffer: Buffer.from('# Réunion du 18 novembre\n\nBudget.') },
  ]);
  const items = a.page.locator('.history .item');
  await until('7 items', async () => (await items.count()) === 7, 30_000);
  await until('uploads done', async () => (await a.page.locator('.transfer').count()) === 0, 30_000);

  // ---- open: the bar becomes the field, what is above the history goes away
  await loupe.click();
  const field = a.page.locator('.search-field input');
  await until('the field has the focus', () => field.evaluate((el) => el === document.activeElement));
  assert.ok(await a.page.locator('.status').isHidden(), 'no status line while searching');
  assert.ok(await a.page.locator('.note textarea').isHidden(), 'no note while searching');

  // ---- words: accents, case, hyphens do not count; every word is needed; highlighted
  await field.fill('wifi');
  await until('one result', async () => (await items.count()) === 1);
  assert.equal(await items.locator('.content .hit').textContent(), 'Wi-Fi');
  assert.equal(await a.page.locator('.search-count').textContent(), '1 résultat');
  await field.fill('ETOILE merlin');
  await until('still one', async () => (await items.count()) === 1 && (await items.locator('.hit').count()) === 2);
  await field.fill('merlin lyon');
  await until('none', async () => (await items.count()) === 0);
  assert.equal(await a.page.locator('.search-empty p').textContent(), 'Aucun résultat pour « merlin lyon ».');
  // a long text shows from where the word is
  await field.fill('digicode');
  await until('the long text', async () => (await items.count()) === 1);
  assert.match(await items.locator('.content').textContent(), /^…le digicode est 4B71/);
  // file names, the start of a text file, the sender
  await field.fill('facture');
  await until('the PDF', async () => (await items.count()) === 1 && /Facture/.test(await items.textContent()));
  await field.fill('reunion');
  await until('the Markdown file', async () => (await items.count()) === 1 && /notes\.md/.test(await items.textContent()));

  // ---- Escape clears, the field stays open; the chips: only the types in the history
  await field.press('Escape');
  await until('all back', async () => (await items.count()) === 7);
  assert.ok(await field.isVisible(), 'Escape first clears the field');
  const chips = a.page.locator('.search-tools .chip');
  assert.deepEqual(await chips.allTextContents(), ['Tout', 'Textes', 'Liens', 'Images', 'Vidéos', 'Documents']);
  const only = async (chip, n) => {
    await chips.getByText(chip, { exact: true }).click();
    await until(chip, async () => (await items.count()) === n);
  };
  await only('Images', 1);
  await only('Vidéos', 1);
  await only('Liens', 1);
  await only('Documents', 2);
  await only('Textes', 3);
  await field.fill('zzz');
  await until('nothing', async () => (await items.count()) === 0);
  await button(a.page.locator('.search-empty'), 'Effacer la recherche').click();
  await until('all again', async () => (await items.count()) === 7);
  assert.equal(await field.inputValue(), '');

  // ---- keyboard: the first result chosen, the arrows move, Enter copies
  await field.fill('e');
  await until('a selection', async () => (await a.page.locator('.history .item.selected').count()) === 1);
  const first = await items.first().getAttribute('class');
  assert.match(first, /selected/);
  await field.fill('code');
  await until('the code', async () => (await items.count()) === 2); // Wi-Fi code and the digicode
  await field.press('ArrowDown');
  await until('second chosen', async () => /selected/.test(await items.nth(1).getAttribute('class')));
  await field.press('ArrowUp');
  await until('first chosen', async () => /selected/.test(await items.nth(0).getAttribute('class')));
  const firstText = (await items.nth(0).locator('.content').textContent()).replace(/^…/, '');
  await field.press('Enter');
  await a.page.locator('.toast', { hasText: 'Copié' }).waitFor();
  assert.ok(texts.some((t) => t.endsWith(firstText.trim()) || t === firstText), 'a text is copied');
  const copied = await a.page.evaluate(() => navigator.clipboard.readText());
  assert.ok(texts.includes(copied), 'the chosen text is in the clipboard: ' + copied);

  // ---- Escape twice closes; Ctrl+F opens again, focused
  await field.press('Escape');
  await field.press('Escape');
  await until('closed', async () => await field.isHidden());
  assert.ok(await a.page.locator('.status').isVisible());
  assert.equal(await items.count(), 7);
  await a.page.locator('.note textarea').focus(); // the focus elsewhere: Ctrl+F still lands in the field
  await a.page.keyboard.press('Control+f');
  await until('open again', async () => (await field.isVisible()) && (await field.evaluate((el) => el === document.activeElement)));
  await field.fill('train');
  await items.first().locator('.content').click(); // the focus leaves the field
  await a.page.keyboard.press('Control+f');
  await until('back in the field, its text selected', () =>
    field.evaluate((el) => el === document.activeElement && el.selectionStart === 0 && el.selectionEnd === el.value.length));
  await a.page.keyboard.type('wifi');
  assert.equal(await field.inputValue(), 'wifi', 'typing replaces the query');
  await a.page.locator('.search-bar').getByRole('button', { name: 'Fermer la recherche' }).click();
  await until('closed by its button', () => field.isHidden());

  // ---- a phone: the same search, no chosen result (no keyboard to act on it)
  await pair(a, b, (link) => b.page.goto(link));
  // what was sent before it joined is not for it: something new
  await a.page.locator('.note textarea').fill('Wi-Fi du salon : Hibou');
  await button(a.page.locator('.note-bar'), 'Envoyer').click();
  await a.page.locator('.note textarea').fill('Rien à voir');
  await button(a.page.locator('.note-bar'), 'Envoyer').click();
  await b.page.locator('.history .item', { hasText: 'Rien à voir' }).waitFor();
  await b.page.locator('.bar-actions').getByRole('button', { name: 'Rechercher' }).click();
  await b.page.locator('.search-field input').fill('wifi');
  await until('found on the phone', async () => (await b.page.locator('.history .item').count()) === 1);
  assert.equal(await b.page.locator('.history .item.selected').count(), 0, 'no chosen result on a phone');

  for (const d of [a, b]) await d.context.close();
  assert.deepEqual(problems, []);
});

test('scrolls: each screen on its own, the history kept under a page or a preview', { timeout: 120_000 }, async () => {
  const a = await device('Alice');
  const b = await device('Bob');
  await a.page.goto(APP);
  await a.page.locator('section.main').waitFor();
  await pair(a, b, (link) => b.page.goto(link));
  await b.page.setViewportSize({ width: 420, height: 640 });
  await a.page.locator('input[type=file][multiple]').setInputFiles(`${FIXTURES}photo.jpg`);
  for (let i = 1; i <= 8; i++) {
    await a.page.locator('.note textarea').fill(`Texte numéro ${i}`);
    await button(a.page.locator('.note-bar'), 'Envoyer').click();
  }
  const photo = b.page.locator('.history .item', { hasText: 'photo.jpg' });
  await photo.waitFor();
  await b.page.locator('.history .item', { hasText: 'Texte numéro 8' }).waitFor();
  const scrollY = () => b.page.evaluate(() => Math.round(window.scrollY));

  // ---- the history scrolled down; a file request, scrolled to its end, deleted: back where it was
  await photo.scrollIntoViewIfNeeded();
  const kept = await scrollY();
  assert.ok(kept > 200, 'the history is scrolled down');
  // clicked where it is (a click by Playwright would scroll up to the top bar first)
  await b.page.getByLabel('Recevoir des fichiers', { exact: true }).dispatchEvent('click');
  const page = b.page.locator('section.drop-page');
  await until('request link', () => page.locator('input.link').inputValue());
  await until('the page at its top', async () => (await scrollY()) === 0);
  await button(page, 'Supprimer le lien').scrollIntoViewIfNeeded();
  await button(page, 'Supprimer le lien').click();
  await button(page, 'Confirmer : supprimer le lien').click();
  await b.page.locator('section.main').waitFor();
  await until('the history where it was', async () => (await scrollY()) === kept);

  // ---- the settings from the top, then the history again where it was
  await b.page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  const bottom = await scrollY();
  await b.page.getByLabel('Réglages').dispatchEvent('click');
  await until('the settings at their top', async () => (await scrollY()) === 0);
  await b.page.evaluate(() => window.scrollTo(0, 300));
  await b.page.locator('section.settings').getByLabel('Retour', { exact: true }).click();
  await until('the history at its bottom', async () => (await scrollY()) === bottom);

  // ---- a preview: the history under it does not scroll
  await photo.scrollIntoViewIfNeeded();
  const under = await scrollY();
  await photo.locator('.thumb').click();
  await b.page.locator('.viewer-image').waitFor();
  assert.ok(await b.page.evaluate(() => document.documentElement.classList.contains('locked')));
  await b.page.mouse.move(210, 320);
  await b.page.mouse.wheel(0, 600);
  await sleep(300);
  assert.equal(await scrollY(), under, 'the history stays still under the preview');
  await b.page.keyboard.press('Escape');
  await until('preview closed', () => b.page.locator('.viewer-image').isHidden());
  assert.ok(!(await b.page.evaluate(() => document.documentElement.classList.contains('locked'))));
  assert.equal(await scrollY(), under, 'the history where it was');

  for (const d of [a, b]) await d.context.close();
  assert.deepEqual(problems, []);
});

test('desktop app: Keychain unreadable at start, the logo with why and Try again', { timeout: 60_000 }, async () => {
  const mac = await device('Mac');
  // the native side refuses its storage until it is unlocked (kept across the reload)
  await mac.context.addInitScript(`(() => {
    const kv = new Map();
    window.__entrenous = {
      config: { relay: location.origin, name: 'MacBook' },
      event() {},
      call: async (m) => {
        if (m.cmd.startsWith('kv') && !sessionStorage.unlocked) throw new Error('Trousseau inaccessible');
        if (m.cmd === 'kvGet') return kv.has(m.key) ? kv.get(m.key) : null;
        if (m.cmd === 'kvSet') return void kv.set(m.key, m.value);
        if (m.cmd === 'clipRead') return null;
        return true;
      },
    };
  })();`);
  await mac.page.goto(APP);
  const loading = mac.page.locator('.app > .center').first();
  await loading.getByText('Entre Nous n’a pas pu démarrer.').waitFor();
  assert.ok(await loading.locator('.logo').isVisible(), 'the logo stays');
  assert.ok(await loading.getByText('Trousseau inaccessible').isVisible(), 'why');

  // unlocked: Try again starts the app
  await mac.page.evaluate(() => (sessionStorage.unlocked = '1'));
  await button(mac.page, 'Réessayer').click();
  await mac.page.locator('section.main').waitFor();
  assert.ok(!(await loading.isVisible()));

  await mac.context.close();
  assert.deepEqual(problems, []);
});
