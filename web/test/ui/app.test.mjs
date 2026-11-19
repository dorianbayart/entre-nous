// Interface tests: two browser devices (two Chrome contexts, separate storage) against a
// running relay, which serves the built app.
//   docker compose up -d --build   (at the root: the relay serves web/dist)
//   npm run test:ui                (HEADED=1 to watch; CHROME_CHANNEL=chromium for another browser)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomFillSync } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

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

/** A device: its own browser profile (storage). `phone`: seen as an Android phone; `locale`: its language. */
async function device(name, { phone = false, locale = 'fr-FR' } = {}) {
  const context = await browser.newContext({
    acceptDownloads: true,
    locale, // the interface follows the browser's language
    ...(phone ? { userAgent: ANDROID_UA, viewport: { width: 412, height: 860 }, isMobile: true, hasTouch: true } : {}),
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
  await d.page.getByLabel('Retour').click();
}

/** `host` shows its invitation, `guest` opens the link: both end on the main screen. */
async function pair(host, guest, join) {
  await host.page.getByLabel('Réglages').click();
  await button(host.page, 'Inviter un appareil').click();
  const link = await until('invitation link', () => host.page.locator('input.link').inputValue());
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
  await a.page.locator('input[type=file]').setInputFiles({ name: 'photo.png', mimeType: 'image/png', buffer: content });
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
  await a.page.locator('input[type=file]').setInputFiles({ name: 'rapport.pdf', mimeType: 'application/pdf', buffer: content });
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
  await a.page.getByLabel('Retour').click();
  await b.page.locator('.note textarea').fill('sans Carla');
  await until('Alice still with Bob', async () => (await a.page.locator('.note textarea').inputValue()) === 'sans Carla');

  for (const d of [a, b, c]) await d.context.close();
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
  await d.page.getByLabel('Retour').click();
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
