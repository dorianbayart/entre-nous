// Shared folders, in Chrome: a folder sent from a computer (its button, and dropped), shown
// before it is sent when large, browsed on two other devices (list, grid, viewer from one file
// to the next), files ticked and downloaded (as a folder where Chrome can write one, a ZIP on
// a phone), and a share link to it, opened outside the group.
//   docker compose up -d --build   (at the root: the relay serves web/dist)
//   npm run test:ui                (HEADED=1 to watch)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const APP = (process.env.RELAY ?? 'http://127.0.0.1:8080') + '/app/';
const FIXTURES = new URL('./fixtures/', import.meta.url).pathname;
const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 16; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36';

// Chrome's folder picker cannot be answered in a test: it gives the page's own private folder
// (OPFS) instead, where the test then looks. No WebRTC: everything goes through the relay.
const INIT = `(() => {
  window.RTCPeerConnection = undefined;
  if ('showDirectoryPicker' in window) window.showDirectoryPicker = async () => {
    const root = await navigator.storage.getDirectory();
    window.__picked = (window.__picked || 0) + 1;
    return root;
  };
})();`;

let browser;
const problems = [];
let dir;

before(async () => {
  browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL ?? 'chrome', headless: !process.env.HEADED });
  // a folder: photos in two days, a video, a PDF, notes, a system file, an empty folder
  dir = mkdtempSync(join(tmpdir(), 'entrenous-folder-'));
  const root = join(dir, 'Vacances');
  for (const d of ['Jour 1', 'Jour 2', 'Vidéos', 'Vide']) mkdirSync(join(root, d), { recursive: true });
  for (let i = 1; i <= 4; i++) cpSync(FIXTURES + 'photo.jpg', join(root, 'Jour 1', `IMG_${i}.jpg`));
  for (let i = 5; i <= 9; i++) cpSync(FIXTURES + 'photo.jpg', join(root, 'Jour 2', `IMG_${i}.jpg`));
  cpSync(FIXTURES + 'clip.mp4', join(root, 'Vidéos', 'coucher de soleil.mp4'));
  cpSync(FIXTURES + 'doc.pdf', join(root, 'billets.pdf'));
  writeFileSync(join(root, 'notes.md'), '# Bretagne\n\n- Saint-Malo\n- Cancale\n');
  writeFileSync(join(root, '.DS_Store'), 'finder');
  // a small one: sent at once
  const small = join(dir, 'Petit');
  mkdirSync(small);
  writeFileSync(join(small, 'a.txt'), 'premier');
  writeFileSync(join(small, 'b.txt'), 'second');
});
after(async () => {
  await browser?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

async function device(name, { phone = false } = {}) {
  const context = await browser.newContext({
    acceptDownloads: true,
    locale: 'fr-FR',
    ...(phone ? { userAgent: ANDROID_UA, viewport: { width: 412, height: 860 }, isMobile: true, hasTouch: true } : {}),
  });
  await context.addInitScript(INIT);
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

async function until(what, fn, ms = 15_000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timeout waiting for ' + what);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** SHOTS=<dir>: screenshots of each step, to look at. */
const shot = (d, name) => (process.env.SHOTS ? d.page.screenshot({ path: join(process.env.SHOTS, name + '.png') }) : null);
const button = (scope, name) => scope.getByRole('button', { name, exact: true });
/** A text on one line, its blanks folded. */
const text = async (loc) => (await loc.innerText()).replace(/\s+/g, ' ').trim();

async function pair(host, guest) {
  await host.page.getByLabel('Réglages').click();
  await button(host.page, 'Inviter un appareil').click();
  const link = await until('invitation link', () => host.page.locator('input.link:visible').inputValue());
  await guest.page.goto(link);
  await guest.page.locator('section.main').waitFor();
  await host.page.locator('section.main').waitFor();
}

/** Files written in a page's private folder (what the folder picker gave), with their sizes. */
async function opfs(page) {
  return page.evaluate(async () => {
    const out = {};
    const walk = async (d, path) => {
      for await (const [name, h] of d.entries()) {
        const p = path ? `${path}/${name}` : name;
        if (h.kind === 'directory') {
          out[p + '/'] = 0;
          await walk(h, p);
        } else out[p] = (await h.getFile()).size;
      }
    };
    await walk(await navigator.storage.getDirectory(), '');
    return out;
  });
}

test('folders: sent, browsed, previewed, downloaded, shared by a link', { timeout: 240_000 }, async () => {
  const a = await device('Alice');
  const b = await device('Bob');
  const p = await device('Pixel', { phone: true });
  await a.page.goto(APP);
  await a.page.locator('section.main').waitFor();
  await pair(a, b);
  await pair(a, p);

  // ---- a computer: a "Dossier" button of its own. A phone's browser cannot pick a folder:
  // its File button stays as it is (the Android app has the menu, see below)
  assert.ok(await button(a.page, 'Dossier').isVisible());
  assert.equal(await p.page.locator('button:visible', { hasText: /^Dossier$/ }).count(), 0);
  assert.ok(!(await p.page.locator('.file-pick .caret').isVisible()));

  // ---- a small folder goes at once
  let chooser = a.page.waitForEvent('filechooser');
  await button(a.page, 'Dossier').click();
  await (await chooser).setFiles(join(dir, 'Petit'));
  const smallB = b.page.locator('.history .item', { hasText: 'Petit' });
  await smallB.waitFor();
  assert.match(await text(smallB.locator('.meta')), /2 fichiers · 13 o/);
  assert.ok(await smallB.locator('.thumb.folder .folder-mark').isVisible(), 'no image: the folder icon');
  assert.equal(await smallB.locator('.thumb .badge').textContent(), '2');

  // ---- a large one (more than 10 files): shown first, system file left out
  chooser = a.page.waitForEvent('filechooser');
  await button(a.page, 'Dossier').click();
  await (await chooser).setFiles(join(dir, 'Vacances'));
  const sheet = a.page.locator('.sheet');
  await sheet.waitFor();
  assert.match(await text(sheet), /Envoyer « Vacances » \?/);
  assert.match(await text(sheet), /12 fichiers, 3 dossiers · 2,\d Mo/);
  assert.match(await text(sheet), /1 fichier système laissé de côté/);
  assert.doesNotMatch(await text(sheet), /Pas assez de place/);
  await shot(a, '1-sheet');
  await button(sheet, 'Envoyer').click();
  await sheet.waitFor({ state: 'hidden' });
  // the previews are made here first, then the upload
  const itemB = b.page.locator('.history .item', { hasText: 'Vacances' });
  await itemB.waitFor({ timeout: 60_000 });
  assert.match(await text(itemB.locator('.meta')), /12 fichiers · 2,\d Mo/);
  await until('mosaic on Bob', () => itemB.locator('.thumb.folder.pic img').isVisible());
  assert.ok(await button(itemB, 'Parcourir').isVisible());
  assert.ok(await button(itemB, 'Tout télécharger').isVisible());
  assert.equal(await button(itemB, 'Copier').count(), 0, 'a folder is not copied');
  await until('upload over', async () => !(await a.page.locator('.transfer').count()), 60_000);
  await shot(b, '2-history');

  // ---- browsed on Bob: the list, its folders first
  await button(itemB, 'Parcourir').click();
  const fb = b.page.locator('.folder-browser');
  await fb.locator('.folder-row').first().waitFor();
  const rows = await fb.locator('.row-name').allTextContents();
  // (a browser's folder picker gives no empty folder: "Vide" is not there)
  assert.deepEqual(rows, ['Jour 1', 'Jour 2', 'Vidéos', 'billets.pdf', 'notes.md']);
  assert.match(await fb.locator('.folder-row', { hasText: 'notes.md' }).textContent(), /# Bretagne/);
  await until('list thumbs', async () => (await fb.locator('.row-thumb img[src^="blob:"]').count()) >= 0);
  await shot(b, '3-list');
  assert.match(await fb.locator('.folder-row', { hasText: 'billets.pdf' }).textContent(), /\d+ pages/);
  // a folder of photos: a grid
  await fb.locator('.row-main', { hasText: 'Jour 1' }).click();
  await fb.locator('.folder-grid .tile').first().waitFor();
  assert.equal(await fb.locator('.folder-grid .tile').count(), 4);
  assert.equal(await fb.locator('.folder-crumbs').textContent(), 'VacancesJour 1');
  await until('thumbnails', async () => (await fb.locator('.folder-grid img[src^="blob:"]').count()) === 4);
  await shot(b, '4-grid');
  // the viewer, from one photo to the next
  await fb.locator('.folder-grid .tile').nth(1).click();
  const viewer = b.page.locator('section.viewer');
  await viewer.locator('.viewer-image[src^="blob:"]').waitFor();
  assert.equal(await viewer.locator('.viewer-title strong').textContent(), 'IMG_2.jpg');
  assert.equal(await viewer.locator('.viewer-count').textContent(), '2 / 4');
  await shot(b, '5-viewer');
  await viewer.locator('.nav.next').click();
  await until('next photo', async () => (await viewer.locator('.viewer-title strong').textContent()) === 'IMG_3.jpg');
  assert.equal(await viewer.getByRole('button', { name: 'Supprimer pour tous' }).count(), 0, 'no deletion from inside a folder');
  await b.page.keyboard.press('Escape');
  await viewer.waitFor({ state: 'hidden' });
  // the list, if asked; choosing in the grid
  await button(fb, 'Choisir').click();
  await fb.locator('.folder-grid .tile').nth(0).click();
  await fb.locator('.folder-grid .tile').nth(2).click();
  assert.match(await fb.locator('.folder-bottom').textContent(), /2 fichiers choisis/);
  await shot(b, '6-choose');
  await button(fb, 'Annuler').click();
  assert.match(await fb.locator('.folder-bottom').textContent(), /Jour 1/);
  // back, then the video: played while it arrives
  await fb.getByLabel('Retour', { exact: true }).click();
  await fb.locator('.row-main', { hasText: 'Vidéos' }).click();
  await fb.locator('.folder-grid .tile').first().click();
  await until('video plays', () => viewer.locator('video').evaluate((v) => v.readyState >= 2 && v.duration > 0), 30_000);
  await viewer.getByLabel('Retour', { exact: true }).click();
  await fb.getByLabel('Retour', { exact: true }).click();
  // the Markdown, rendered
  await fb.locator('.row-main', { hasText: 'notes.md' }).click();
  await viewer.locator('article.markdown h1', { hasText: 'Bretagne' }).waitFor();
  await viewer.getByLabel('Retour', { exact: true }).click();

  // ---- ticked in the list, then downloaded: a folder where Chrome can write one
  await fb.locator('.folder-row', { hasText: 'Jour 2' }).locator('.tick').click();
  await fb.locator('.folder-row', { hasText: 'notes.md' }).locator('.tick').click();
  assert.match(await fb.locator('.folder-bottom').textContent(), /6 fichiers choisis/);
  await shot(b, '7-ticked');
  await button(fb.locator('.folder-bottom'), 'Télécharger').click();
  await b.page.getByText('Enregistré dans').waitFor({ timeout: 30_000 });
  const written = await opfs(b.page);
  assert.equal(written['Vacances/notes.md'], Buffer.byteLength('# Bretagne\n\n- Saint-Malo\n- Cancale\n'));
  for (let i = 5; i <= 9; i++) assert.equal(written[`Vacances/Jour 2/IMG_${i}.jpg`], readFileSync(FIXTURES + 'photo.jpg').length);
  assert.equal(written['Vacances/Jour 1/'], undefined, 'only what was ticked');
  // one file alone: saved like a file
  await fb.locator('.folder-row', { hasText: 'Jour 2' }).locator('.tick').click(); // unticked
  await fb.locator('.folder-row', { hasText: 'notes.md' }).locator('.tick').click();
  await fb.locator('.folder-row', { hasText: 'billets.pdf' }).locator('.tick').click();
  const one = b.page.waitForEvent('download');
  await button(fb.locator('.folder-bottom'), 'Télécharger').click();
  const pdf = await one;
  assert.equal(pdf.suggestedFilename(), 'billets.pdf');
  assert.ok(readFileSync(await pdf.path()).equals(readFileSync(FIXTURES + 'doc.pdf')));
  await fb.getByLabel('Fermer', { exact: true }).click();
  await fb.waitFor({ state: 'hidden' });

  // ---- a phone: everything as a ZIP (no folder picker in a phone's browser)
  const itemP = p.page.locator('.history .item', { hasText: 'Vacances' });
  await itemP.waitFor();
  await shot(p, '8-phone');
  await button(itemP, 'Tout télécharger').click();
  const zip = await until('zip shared', () => p.page.evaluate(async () => {
    const f = window.__shared;
    if (!f) return null;
    const bytes = new Uint8Array(await f.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return { name: f.name, data: btoa(bin) };
  }), 60_000);
  assert.equal(zip.name, 'Vacances.zip');
  const zipFile = join(dir, 'out.zip');
  writeFileSync(zipFile, Buffer.from(zip.data, 'base64'));
  execFileSync('unzip', ['-q', '-t', zipFile]);
  const listing = execFileSync('unzip', ['-Z1', zipFile]).toString().trim().split('\n').sort();
  assert.deepEqual(listing, [
    'Jour 1/IMG_1.jpg', 'Jour 1/IMG_2.jpg', 'Jour 1/IMG_3.jpg', 'Jour 1/IMG_4.jpg',
    'Jour 2/IMG_5.jpg', 'Jour 2/IMG_6.jpg', 'Jour 2/IMG_7.jpg', 'Jour 2/IMG_8.jpg', 'Jour 2/IMG_9.jpg',
    'Vidéos/coucher de soleil.mp4', 'billets.pdf', 'notes.md',
  ]);
  execFileSync('unzip', ['-q', zipFile, '-d', join(dir, 'unzipped')]);
  assert.ok(readFileSync(join(dir, 'unzipped', 'Vidéos', 'coucher de soleil.mp4')).equals(readFileSync(FIXTURES + 'clip.mp4')));

  // ---- a share link to the folder, opened outside the group
  await button(itemB, 'Partager').click();
  const link = await until('share link', () => b.page.locator('section.share-page input.link').inputValue());
  await button(b.page, 'Retour').click();
  const visitor = await device('Visiteur');
  await visitor.page.addInitScript('delete window.showDirectoryPicker'); // Firefox, Safari: a ZIP
  await visitor.page.goto(link);
  await visitor.page.locator('.visit-lead', { hasText: 'Quelqu’un partage un dossier avec toi.' }).waitFor();
  const vb = visitor.page.locator('#folder-browser');
  await vb.locator('.folder-row').first().waitFor();
  assert.match(await visitor.page.locator('#folder-meta').textContent(), /12 fichiers · 2,\d Mo · expire dans/);
  assert.equal(await vb.getByLabel('Fermer', { exact: true }).count(), 0, 'nothing to close on the page');
  await shot(visitor, '9-visit');
  await vb.locator('.row-main', { hasText: 'Jour 2' }).click();
  await vb.locator('.folder-grid .tile').first().click();
  await visitor.page.locator('#preview .visit-image[src^="blob:"]').waitFor();
  await shot(visitor, '10-visit-preview');
  await visitor.page.locator('#preview-next').click();
  await until('next on the page', async () => (await visitor.page.locator('#preview-name').textContent()) === 'IMG_6.jpg');
  await visitor.page.locator('#preview-close').click();
  const vzip = visitor.page.waitForEvent('download');
  await button(vb.locator('.folder-bottom'), 'Télécharger ce dossier').click();
  const got = await vzip;
  assert.equal(got.suggestedFilename(), 'Jour 2.zip');
  const vlist = execFileSync('unzip', ['-Z1', await got.path()]).toString().trim().split('\n');
  assert.equal(vlist.length, 5);

  // ---- a dropped folder (from the file manager): sent like a picked one
  await a.page.evaluate(async () => {
    // a drop whose entry is a folder, as Chrome gives it
    const file = (name, text) => new File([text], name, { type: 'text/plain' });
    const entry = (name, children) => ({
      isDirectory: true, isFile: false, name,
      createReader() {
        let done = false;
        return { readEntries(ok) { ok(done ? [] : ((done = true), children)); } };
      },
    });
    const leaf = (f) => ({ isDirectory: false, isFile: true, name: f.name, file(ok) { ok(f); } });
    const root = entry('Déposé', [leaf(file('un.txt', '1')), entry('sous', [leaf(file('deux.txt', '22'))])]);
    const dt = {
      types: ['Files'],
      files: [],
      items: [{ kind: 'file', webkitGetAsEntry: () => root, getAsFile: () => null }],
    };
    const ev = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'dataTransfer', { value: dt });
    document.querySelector('.app').dispatchEvent(ev);
  });
  const dropped = b.page.locator('.history .item', { hasText: 'Déposé' });
  await dropped.waitFor({ timeout: 30_000 });
  assert.match(await text(dropped.locator('.meta')), /2 fichiers · 3 o/);

  for (const d of [a, b, p, visitor]) await d.context.close();
  assert.deepEqual(problems, []);
});

// The desktop apps' bridge (platform/desktop.ts), answered in the page: local files behind
// tokens (a folder picked, a folder copied), a folder saved through the native side.
const BRIDGE = (photo) => `(() => {
  const kv = new Map();
  const b64 = (s) => s.replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
  const local = new Map(); // token -> bytes (base64), the files offered by the native side
  const enc = (text) => btoa(unescape(encodeURIComponent(text)));
  const offer = (path, data, mime) => {
    const token = 't' + local.size;
    local.set(token, data);
    return { token, path, size: atob(data).length, mime };
  };
  window.__saved = {}; // what the native side wrote: path -> base64 pieces
  window.__notified = [];
  window.__copyFolder = (name, n) => {
    const files = [];
    for (let i = 0; i < n; i++) files.push(offer('f' + i + '.txt', enc('fichier ' + i), 'text/plain'));
    window.__entrenous.event('localCopy', { kind: 'folder', name, files, dirs: [] });
  };
  const open = new Map();
  window.__entrenous = {
    config: { relay: location.origin, name: 'MacBook' },
    event() {},
    call: async (m) => {
      if (m.cmd === 'kvGet') return kv.has(m.key) ? kv.get(m.key) : null;
      if (m.cmd === 'kvSet') return void kv.set(m.key, m.value);
      if (m.cmd === 'kvDel') return void kv.delete(m.key);
      if (m.cmd === 'clipRead') return null;
      if (m.cmd === 'notify') return void window.__notified.push(m.body);
      if (m.cmd === 'folderPick') return {
        kind: 'folder', name: 'Choisi',
        files: [offer('photo.jpg', '${photo}', 'image/jpeg'), offer('sous/texte.txt', enc('bonjour'), 'text/plain'), offer('.DS_Store', enc('x'), 'application/octet-stream')],
        dirs: ['vide'],
      };
      if (m.cmd === 'fileRead') {
        const bin = atob(local.get(m.token));
        return b64(btoa(bin.slice(m.offset, m.offset + m.length)));
      }
      if (m.cmd === 'folderCreate') return { token: 'dest', where: 'Téléchargements/' + m.name };
      if (m.cmd === 'folderMkdir') return void (window.__saved[m.path + '/'] = '');
      if (m.cmd === 'fileCreate') {
        const token = 'w' + Math.random();
        open.set(token, m.folder ? m.path : m.name);
        window.__saved[open.get(token)] = '';
        return token;
      }
      if (m.cmd === 'fileAppend') {
        const p = open.get(m.token);
        window.__saved[p] += atob(m.data.replace(/-/g, '+').replace(/_/g, '/'));
        return true;
      }
      return true;
    },
  };
})();`;

test('desktop apps: a folder picked, copied, saved through the native side', { timeout: 120_000 }, async () => {
  const mac = await device('Mac');
  await mac.context.addInitScript(BRIDGE(readFileSync(FIXTURES + 'photo.jpg').toString('base64')));
  const b = await device('Bob');
  await mac.page.goto(APP);
  await mac.page.locator('section.main').waitFor();
  await pair(mac, b);

  // ---- picked with the app's own picker: system file left out, empty folder kept
  await button(mac.page, 'Dossier').click();
  const picked = b.page.locator('.history .item', { hasText: 'Choisi' });
  await picked.waitFor({ timeout: 30_000 });
  assert.match(await text(picked.locator('.meta')), /2 fichiers · 23 Ko/);
  await until('mosaic', () => picked.locator('.thumb.folder.pic img').isVisible());

  // ---- copied in the Finder: a small one goes by itself, a large one waits (notification)
  await mac.page.evaluate(() => window.__copyFolder('Petit copié', 3));
  await b.page.locator('.history .item', { hasText: 'Petit copié' }).waitFor({ timeout: 30_000 });
  await mac.page.evaluate(() => window.__copyFolder('Gros copié', 11));
  const sheet = mac.page.locator('.sheet');
  await sheet.waitFor();
  assert.match(await text(sheet), /Dossier copié : « Gros copié »/);
  // (the update notice of the local build may come first)
  assert.ok((await mac.page.evaluate(() => window.__notified)).includes('« Gros copié » (11 fichiers) attend ton accord pour être envoyé : ouvre Entre Nous.'));
  await button(sheet, 'Annuler').click();
  await mac.page.waitForTimeout(500);
  assert.equal(await b.page.locator('.history .item', { hasText: 'Gros copié' }).count(), 0, 'not sent');

  // ---- received on the Mac: saved through the native side, the folder recreated
  const chooser = b.page.waitForEvent('filechooser');
  await button(b.page, 'Dossier').click();
  await (await chooser).setFiles(join(dir, 'Petit'));
  const fromBob = mac.page.locator('.history .item', { hasText: 'Petit' }).filter({ hasNotText: 'copié' });
  await fromBob.waitFor();
  await button(fromBob, 'Tout télécharger').click();
  await mac.page.getByText('Enregistré dans Téléchargements/Petit').waitFor({ timeout: 30_000 });
  assert.deepEqual(await mac.page.evaluate(() => window.__saved), { 'a.txt': 'premier', 'b.txt': 'second' });

  for (const d of [mac, b]) await d.context.close();
  assert.deepEqual(problems, []);
});
