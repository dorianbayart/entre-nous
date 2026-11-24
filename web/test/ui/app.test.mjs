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
  await a.page.locator('section.settings').getByLabel('Retour', { exact: true }).click();
  await b.page.locator('.note textarea').fill('sans Carla');
  await until('Alice still with Bob', async () => (await a.page.locator('.note textarea').inputValue()) === 'sans Carla');

  for (const d of [a, b, c]) await d.context.close();
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
  await a.page.locator('input[type=file]').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('du navigateur') });
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
    await a.page.locator('input[type=file]').setInputFiles(f);
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
    await a.page.locator('input[type=file]').setInputFiles(`${FIXTURES}${f}`);
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
    await until(`${f} ends`, () => audio.evaluate((el) => el.ended), 30_000);
    assert.ok(!(await viewer.locator('.viewer-actions').getByText('Copier le texte').isVisible()), 'no text to copy');
    await b.page.keyboard.press('Escape');
    await viewer.waitFor({ state: 'hidden' });
  }
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
  await a.page.locator('input[type=file]').setInputFiles(`${FIXTURES}doc.pdf`);
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
  await a.page.locator('input[type=file]').setInputFiles({ name: 'courses.txt', mimeType: 'text/plain', buffer: content });
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
  assert.ok(await page.locator('img.qr').isVisible(), 'a QR code');
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
