// Screenshots and animation of the documentation (docs/images/), from the real app.
//   docker compose up -d --build   (at the root: the relay serves the app to show)
//   npm run screenshots            (needs Chrome and ffmpeg): French, then English
//   node scripts/screenshots.mjs en   one language (fr by default); the English files end in -en
// Three devices in Chrome: a Mac (the desktop bridge is simulated: the app runs as in the Mac
// app, with automatic sharing), an Android phone and a PC (the web app in a browser). Demo
// contents only. The screenshots are put on a stage (stage()), drawn image by image.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const ROOT = new URL('../../', import.meta.url).pathname;
const OUT = ROOT + 'docs/images/';
const LANDING = ROOT + 'web/public/images/'; // the relay's landing page
const LANG = process.argv[2] === 'en' ? 'en' : 'fr';
/** A file of this language: name.png in French, name-en.png in English. */
const file = (dir, name, ext) => dir + name + (LANG === 'en' ? '-en' : '') + ext;
/** The texts of the pictures and the labels of the app, in the language of the pictures. */
const S = {
  fr: {
    settings: 'Réglages', name: 'Nom', back: 'Retour', invite: 'Inviter un appareil', scan: 'Scanner un QR code',
    save: 'Enregistrer', devices: 'Appareils', pcName: 'PC Linux',
    macLabel: 'Mac · barre des menus', pcLabel: 'PC · navigateur, rien à installer', lock: '🔒 chiffré de bout en bout',
    endSub: 'Le copier-coller, en mieux.',
    chips: ['Aperçus', 'Éphémère', 'Chiffré de bout en bout', 'Sans compte', 'Mac · Android · iPhone · Windows · Linux · CLI'],
    wifi: 'Code Wi-Fi invités : poney-violet-42', quote: 'Devis-cuisine.pdf',
    T: {
      copy: ['Tu copies sur ton Mac…', 'Rien à faire de plus : c’est envoyé tout seul.'],
      got: ['…c’est déjà sur ton téléphone.', 'Chiffré sur le Mac, illisible entre les deux, déchiffré sur le téléphone.'],
      trio: ['Une photo depuis Android, partout à la fois', 'Le Mac et le PC la reçoivent en même temps, par morceaux chiffrés.'],
      paste: ['Déjà dans le presse-papier du Mac', 'Prête à coller, en pleine qualité.'],
      view: ['Ou prévisualise-la', 'Sans la télécharger.'],
      md: ['Un document Markdown, mis en forme', 'Lis-le avant de le télécharger.'],
      note: ['Une note partagée, en direct', 'Tape-la sur le Mac : elle s’écrit sur tous les appareils.'],
    },
    md: {
      name: 'Week-end-Lisbonne.md',
      text: [
        '# Week-end à Lisbonne', '', '**Départ** vendredi à 7 h 40, Orly, terminal 3.', '',
        '## À ne pas oublier', '', '- Passeports', '- Chargeurs et adaptateur', '- Crème solaire', '',
        '## Programme', '', '| Jour | Au programme |', '|---|---|', '| Samedi | Alfama, le tram 28 |', '| Dimanche | Belém et ses *pastéis de nata* |', '',
        '> Réserver le restaurant de samedi soir avant jeudi.', '',
      ].join('\n'),
    },
    address: 'Rendez-vous 14 h, 8 rue des Tanneurs', addressShort: '📋 Rendez-vous 14 h…', addressFind: 'Tanneurs',
    received: 'Reçu à l’instant', chunk: (i, n) => `📷 morceau ${i}/${n}`, paste: 'Colle où tu veux',
    note: 'Courses : pain, tomates, café, citrons',
    hero: { title: 'Le copier-coller, en mieux.', sub: 'Un presse-papier malin, partagé, multiplateforme, chiffré de bout en bout, éphémère, sans compte, sans trace.' },
    pairing: { title: 'Association simple, par QR code ou par lien', leftLabel: 'Mac : Réglages → Inviter un appareil', rightLabel: 'Téléphone : scanner, ou coller le lien' },
    video: 'Vacances.mp4',
    uploading: {
      title: 'Pas besoin d’attendre la fin d’un envoi',
      sub: 'Pendant que le téléphone envoie la vidéo, le Mac et le PC la téléchargent déjà.',
      labels: { mac3: 'Mac : télécharge déjà la vidéo', phone3: 'Android : envoie la vidéo', pc3: 'PC : la télécharge aussi' },
    },
    settingsPair: { title: 'Des réglages simples, pour tout le groupe', leftLabel: 'Réglages de l’appareil et du groupe', rightLabel: 'Les appareils du groupe' },
    previewsPair: { title: 'Prévisualise tes photos et tes documents sans les télécharger', leftLabel: 'Mac : un document Markdown mis en forme', rightLabel: 'Téléphone : une photo en aperçu' },
  },
  en: {
    settings: 'Settings', name: 'Name', back: 'Back', invite: 'Invite a device', scan: 'Scan a QR code',
    save: 'Save', devices: 'Devices', pcName: 'Linux PC',
    macLabel: 'Mac · menu bar', pcLabel: 'PC · browser, nothing to install', lock: '🔒 end-to-end encrypted',
    endSub: 'Copy-paste, only better.',
    chips: ['Previews', 'Ephemeral', 'End-to-end encrypted', 'No account', 'Mac · Android · iPhone · Windows · Linux · CLI'],
    wifi: 'Guest Wi-Fi password: purple-pony-42', quote: 'Kitchen-quote.pdf',
    T: {
      copy: ['You copy on your Mac…', 'Nothing else to do: it’s sent on its own.'],
      got: ['…and it’s already on your phone.', 'Encrypted on the Mac, unreadable in between, decrypted on the phone.'],
      trio: ['A photo from Android, everywhere at once', 'The Mac and the PC receive it at the same time, in encrypted chunks.'],
      paste: ['Already in the Mac’s clipboard', 'Ready to paste, in full quality.'],
      view: ['Or preview it', 'Without downloading it.'],
      md: ['A Markdown document, formatted', 'Read it before downloading it.'],
      note: ['A shared note, live', 'Type it on the Mac: it appears on every device.'],
    },
    md: {
      name: 'Lisbon-weekend.md',
      text: [
        '# Lisbon weekend', '', '**Leaving** Friday at 7:40 am, Orly, terminal 3.', '',
        '## Don’t forget', '', '- Passports', '- Chargers and adapter', '- Sunscreen', '',
        '## Plan', '', '| Day | What |', '|---|---|', '| Saturday | Alfama, tram 28 |', '| Sunday | Belém and its *pastéis de nata* |', '',
        '> Book Saturday night’s restaurant before Thursday.', '',
      ].join('\n'),
    },
    address: 'Meet at 2 pm, 8 Tanners Street', addressShort: '📋 Meet at 2 pm…', addressFind: 'Tanners',
    received: 'Just received', chunk: (i, n) => `📷 chunk ${i}/${n}`, paste: 'Paste it anywhere',
    note: 'Shopping: bread, tomatoes, coffee, lemons',
    hero: { title: 'Copy-paste, only better.', sub: 'A smart clipboard: shared, cross-platform, end-to-end encrypted, ephemeral, no account, no trace.' },
    pairing: { title: 'Easy pairing, with a QR code or a link', leftLabel: 'Mac: Settings → Invite a device', rightLabel: 'Phone: scan, or paste the link' },
    video: 'Holidays.mp4',
    uploading: {
      title: 'No need to wait for an upload to finish',
      sub: 'While the phone uploads the video, the Mac and the PC are already downloading it.',
      labels: { mac3: 'Mac: already downloading the video', phone3: 'Android: uploading the video', pc3: 'PC: downloading it too' },
    },
    settingsPair: { title: 'Simple settings, for the whole group', leftLabel: 'Device and group settings', rightLabel: 'The group’s devices' },
    previewsPair: { title: 'Preview your photos and documents without downloading them', leftLabel: 'Mac: a formatted Markdown document', rightLabel: 'Phone: a photo preview' },
  },
}[LANG];
mkdirSync(LANDING, { recursive: true });
/** PNG → WebP (lossy, small enough for a web page). */
const webp = (png, out, quality = 82) => execFileSync('magick', [png, '-quality', String(quality), out]);
const APP = (process.env.RELAY ?? 'http://127.0.0.1:8080') + '/app/';
const ICON = 'data:image/svg+xml;base64,' + readFileSync(ROOT + 'web/public/app/icon.svg').toString('base64');
const PUBLIC = 'entrenous.0xdba.dev'; // shown in the pictures instead of the local relay
const MAC = { width: 400, height: 640 };
const PHONE = { width: 390, height: 844 };
const PC = { width: 440, height: 600 };
const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 16; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36';
const LINUX_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const FPS = 15;

// Chunks can be held back (an upload in progress), then let go one by one; no WebRTC.
const HOLD = `(() => {
  window.RTCPeerConnection = undefined;
  const held = []; let hold = false;
  const send = WebSocket.prototype.send;
  WebSocket.prototype.send = function (d) {
    if (hold && typeof d !== 'string') return void held.push(() => send.call(this, d));
    return send.call(this, d);
  };
  window.__hold = () => { hold = true; };
  window.__heldCount = () => held.length;
  window.__step = (n) => { for (const f of held.splice(0, n)) f(); };
  window.__release = () => { hold = false; held.splice(0).forEach((f) => f()); };
})();`;

// The Mac app's bridge (platform/desktop.ts), answered in the page: storage in memory, the
// rest accepted. `__entrenous.event('localCopy', …)` is a copy made on the Mac.
const MAC_BRIDGE = `(() => {
  const kv = new Map();
  window.__entrenous = {
    config: { relay: location.origin, name: 'MacBook Air' },
    event() {},
    call: async (m) => {
      if (m.cmd === 'kvGet') return kv.has(m.key) ? kv.get(m.key) : null;
      if (m.cmd === 'kvSet') return void kv.set(m.key, m.value);
      if (m.cmd === 'kvDel') return void kv.delete(m.key);
      if (m.cmd === 'clipRead') return null;
      if (m.cmd === 'fileCreate') return 'f' + Math.random();
      return true;
    },
  };
})();`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, fn, ms = 15_000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timeout: ' + what);
    await sleep(100);
  }
}

const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL ?? 'chrome', headless: !process.env.HEADED });

async function device(kind, url = APP) {
  const opts =
    kind === 'phone'
      ? { viewport: PHONE, userAgent: ANDROID_UA, isMobile: true, hasTouch: true }
      : kind === 'mac'
        ? { viewport: MAC }
        : { viewport: PC, userAgent: LINUX_UA };
  const context = await browser.newContext({ ...opts, deviceScaleFactor: 2, locale: LANG === 'en' ? 'en-GB' : 'fr-FR', bypassCSP: true });
  await context.addInitScript(HOLD);
  if (kind === 'mac') await context.addInitScript(MAC_BRIDGE);
  const page = await context.newPage();
  await page.goto(url);
  // no update banner (the local build is older than the latest release), no toasts
  await page.addStyleTag({ content: '.update, .toast { display: none !important; }' });
  return page;
}

const button = (scope, name) => scope.getByRole('button', { name, exact: true });

async function rename(page, name) {
  await page.getByLabel(S.settings).click();
  const field = page.getByLabel(S.name, { exact: true });
  await field.fill(name);
  await field.blur();
  await page.locator('section.settings').getByLabel(S.back, { exact: true }).click();
}

/** The invitation page (other pages have their own QR code and link). */
function inviteView(page) {
  return page.locator('section.page', { has: page.getByRole('heading', { name: S.invite, exact: true }) });
}

async function invite(host, open) {
  await host.getByLabel(S.settings).click();
  await button(host, S.invite).click();
  const link = await until('link', () => inviteView(host).locator('input.link').inputValue());
  await open(link);
  await host.locator('section.main').waitFor();
}

const shot = (page) => page.screenshot({ type: 'png' });

/** Opens the preview of the item named `name` (its tile), and waits until it is drawn. */
async function openPreview(page, name) {
  await page.locator('.history .item', { hasText: name }).locator('button.thumb').click();
  await until('preview', () =>
    page.evaluate(() => {
      const img = document.querySelector('.viewer-image');
      const md = document.querySelector('.viewer .markdown h1');
      return (img && img.offsetParent && img.complete && img.naturalWidth > 0) || (md && md.offsetParent);
    }),
  );
  await sleep(400);
}
async function closePreview(page) {
  await page.keyboard.press('Escape');
  await page.locator('section.viewer').waitFor({ state: 'hidden' });
  await sleep(200);
}
const dataUrl = (png) => 'data:image/png;base64,' + png.toString('base64');

/**
 * A photo for the demo, drawn in the page, `w` × `h` (any shape): a lake at sunset, mountains,
 * fir trees on the shore, their reflection. Always the same (seeded).
 */
async function photo(page, w, h) {
  const b64 = await page.evaluate(
    async ([w, h]) => {
      let seed = 42;
      const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const g = c.getContext('2d');
      const u = Math.min(w, h);
      const horizon = Math.round(h * 0.6);
      const sky = g.createLinearGradient(0, 0, 0, horizon);
      sky.addColorStop(0, '#1d2d5c');
      sky.addColorStop(0.4, '#6e5b94');
      sky.addColorStop(0.75, '#ee9479');
      sky.addColorStop(1, '#ffd59b');
      g.fillStyle = sky;
      g.fillRect(0, 0, w, horizon);
      // the sun and its glow
      const sx = w * 0.62, sy = horizon - u * 0.17, sr = u * 0.075;
      const glow = g.createRadialGradient(sx, sy, sr * 0.6, sx, sy, sr * 7);
      glow.addColorStop(0, 'rgba(255, 232, 175, .95)');
      glow.addColorStop(1, 'rgba(255, 190, 140, 0)');
      g.fillStyle = glow;
      g.fillRect(0, 0, w, horizon);
      g.fillStyle = '#fff4d8';
      g.beginPath();
      g.arc(sx, sy, sr, 0, Math.PI * 2);
      g.fill();
      // long thin clouds, lit from below
      for (let i = 0; i < 7; i++) {
        const y = horizon * (0.12 + 0.45 * rnd()), x = w * rnd(), len = w * (0.25 + 0.35 * rnd()), th = u * (0.008 + 0.014 * rnd());
        g.fillStyle = `rgba(255, ${170 + 50 * rnd()}, ${150 + 40 * rnd()}, ${0.35 + 0.3 * rnd()})`;
        g.beginPath();
        g.ellipse(x, y, len / 2, th, 0, 0, Math.PI * 2);
        g.fill();
      }
      // mountains: jagged ridges, from far (light) to near (dark)
      const ridge = (top, rough, color) => {
        const n = 512;
        const pts = new Array(n + 1).fill(0);
        pts[0] = rnd();
        pts[n] = rnd();
        for (let step = n; step > 1; step /= 2)
          for (let i = step / 2; i < n; i += step) pts[i] = (pts[i - step / 2] + pts[i + step / 2]) / 2 + (rnd() - 0.5) * rough * (step / n) ** 0.8;
        g.fillStyle = color;
        g.beginPath();
        g.moveTo(0, horizon);
        for (let i = 0; i <= n; i++) g.lineTo((i / n) * w, Math.min(horizon, horizon - top * u * (0.35 + pts[i])));
        g.lineTo(w, horizon);
        g.fill();
      };
      ridge(0.42, 1.3, '#9a7aa6');
      ridge(0.3, 1.2, '#6d5a8c');
      ridge(0.16, 1.0, '#3e3d66');
      // fir trees on both shores
      const fir = (x, height) => {
        g.fillStyle = '#171a30';
        g.fillRect(x - height * 0.02, horizon - height * 0.12, height * 0.04, height * 0.12);
        for (let k = 0; k < 5; k++) {
          const y0 = horizon - height * (0.1 + k * 0.17), half = height * (0.2 - k * 0.032);
          g.beginPath();
          g.moveTo(x - half, y0);
          g.lineTo(x, y0 - height * 0.32);
          g.lineTo(x + half, y0);
          g.fill();
        }
      };
      for (let i = 0; i < 9; i++) fir(w * (0.01 + 0.03 * i + 0.012 * rnd()), u * (0.12 + 0.12 * rnd()) * (1 - i * 0.07));
      for (let i = 0; i < 6; i++) fir(w * (0.99 - 0.035 * i - 0.01 * rnd()), u * (0.1 + 0.1 * rnd()) * (1 - i * 0.1));
      // the lake: everything above, upside down, darker; ripples; the sun's path
      g.save();
      g.translate(0, horizon * 2);
      g.scale(1, -1);
      g.globalAlpha = 0.85;
      g.drawImage(c, 0, 0, w, horizon, 0, 0, w, horizon);
      g.restore();
      const water = g.createLinearGradient(0, horizon, 0, h);
      water.addColorStop(0, 'rgba(20, 26, 55, .25)');
      water.addColorStop(1, 'rgba(12, 16, 38, .7)');
      g.fillStyle = water;
      g.fillRect(0, horizon, w, h - horizon);
      for (let i = 0; i < 260; i++) {
        const d = rnd() ** 1.6, y = horizon + d * (h - horizon);
        const near = Math.abs(rnd() * w - sx) < u * 0.12;
        const x = near ? sx + (rnd() - 0.5) * u * (0.15 + 0.3 * d) : rnd() * w;
        g.fillStyle = near ? `rgba(255, 228, 180, ${0.35 + 0.4 * rnd()})` : `rgba(255, 210, 190, ${0.06 + 0.1 * rnd()})`;
        g.fillRect(x, y, u * (0.02 + 0.08 * rnd()) * (0.5 + d), Math.max(1, u * 0.002 * (1 + 2 * d)));
      }
      // film grain: a realistic size for a phone photo
      const img = g.getImageData(0, 0, w, h);
      for (let i = 0; i < img.data.length; i += 4) {
        const n = (Math.random() - 0.5) * 22;
        img.data[i] += n;
        img.data[i + 1] += n;
        img.data[i + 2] += n;
      }
      g.putImageData(img, 0, 0);
      const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.92));
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let s = '';
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return btoa(s);
    },
    [w, h],
  );
  return Buffer.from(b64, 'base64');
}

// ------------------------------------------------------------------ the stage

const PALETTE = {
  light: { bg1: '#eef3f0', bg2: '#f6f5f2', text: '#1b1b1a', muted: '#5f5d57', accent: '#2f5d50', soft: '#e3ece8', bar: 'rgba(255,255,255,.72)', frame: '#1b1b1a', chrome: '#e6e4de', app: '#f6f5f2', appText: '#1b1b1a', onAccent: '#fff' },
  dark: { bg1: '#1d2a26', bg2: '#121212', text: '#ecebe7', muted: '#a9a69e', accent: '#7fb8a3', soft: '#233630', bar: 'rgba(40,40,40,.72)', frame: '#3a3a38', chrome: '#2a2a28', app: '#151515', appText: '#ecebe7', onAccent: '#10201b' },
};

const STATUSBAR = `<div class="statusbar"><span>14:02</span><span class="icons"><i class="sig"><b></b><b></b><b></b><b></b></i><i class="bat"><b></b></i></span></div>`;
const macHtml = (id, w) => `<div class="mac" style="width:${w}px">
    <div class="menubar"><span class="dots"></span><img src="${ICON}"><span class="clock">14:02</span></div>
    <div class="pop" id="${id}"><div class="arrow"></div><img><img></div>
    <div class="label" data-for="${id}">${S.macLabel}</div><div class="bubble" data-at="${id}"></div></div>`;
const phoneHtml = (id) => `<div class="phone">
    <div class="frame"><div class="island"></div>${STATUSBAR}<div class="screen" id="${id}"><img><img></div></div>
    <div class="label" data-for="${id}">Android</div><div class="bubble" data-at="${id}"></div></div>`;
const pcHtml = (id) => `<div class="pc">
    <div class="win"><div class="bar"><i></i><i></i><i></i><span class="url">${PUBLIC}/app/</span></div><div class="content" id="${id}"><img><img></div></div>
    <div class="label" data-for="${id}">${S.pcLabel}</div><div class="bubble" data-at="${id}"></div></div>`;

/**
 * The stage: two devices (Mac, phone) or three (Mac, phone, PC), a title, and what moves
 * between them. `setScene(state)` draws one image of it: screenshots cross-fade, titles too,
 * bubbles pop, packets travel (readable at both ends, encrypted on the way).
 */
function stage(theme) {
  const p = PALETTE[theme];
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    * { box-sizing: border-box; }
    html, body { margin: 0; width: 1200px; height: 800px; overflow: hidden; }
    body { position: relative; font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, sans-serif; color: ${p.text};
      background: radial-gradient(1200px 600px at 20% 0%, ${p.bg1}, ${p.bg2}); }
    header { position: relative; height: 128px; }
    body.bare { background: transparent; } body.bare header { visibility: hidden; }
    .cap { position: absolute; inset: 0; text-align: center; padding: 34px 40px 0; }
    h1 { margin: 0; font-size: 38px; letter-spacing: -.02em; font-weight: 750; }
    .cap p { margin: 8px 0 0; color: ${p.muted}; font-size: 19px; }
    main { position: absolute; left: 0; right: 0; top: 128px; display: flex; align-items: flex-start; justify-content: center; }
    #trio { top: 150px; gap: 64px; }
    .mac, .phone, .pc { position: relative; display: flex; flex-direction: column; align-items: center; }
    .menubar { width: 100%; height: 30px; border-radius: 9px; background: ${p.bar};
      display: flex; align-items: center; justify-content: flex-end; gap: 14px; padding: 0 14px; font-size: 13px; font-weight: 600;
      box-shadow: 0 1px 0 rgba(0,0,0,.04), 0 6px 20px rgba(0,0,0,.06); }
    .menubar .dots { flex: 1; height: 6px; background: linear-gradient(90deg, ${p.muted}55 0 40px, transparent 40px 56px, ${p.muted}33 56px 120px, transparent 120px); border-radius: 3px; opacity: .5; }
    .menubar img { width: 20px; height: 20px; border-radius: 5px; outline: 3px solid ${p.accent}44; }
    .pop { position: relative; margin-top: 12px; width: 360px; height: 576px; border-radius: 14px;
      box-shadow: 0 0 0 1px ${theme === 'dark' ? 'rgba(255,255,255,.12)' : 'rgba(0,0,0,.08)'}, 0 24px 60px rgba(0,0,0,.18); }
    .pop img, .screen img, .content img { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
    .pop img { border-radius: 14px; }
    .arrow { position: absolute; top: -8px; right: 54px; width: 16px; height: 16px; transform: rotate(45deg); background: ${p.app}; box-shadow: -1px -1px 0 rgba(0,0,0,.08); }
    .phone { margin-top: 14px; }
    .frame { position: relative; padding: 9px; border-radius: 46px; background: ${p.frame};
      box-shadow: 0 0 0 2px ${theme === 'dark' ? '#4a4a48' : '#3a3a38'}, 0 24px 60px rgba(0,0,0,.22); }
    .screen { position: relative; width: 262px; height: 567px; }
    .screen img { border-radius: 0 0 38px 38px; }
    .statusbar { width: 262px; height: 30px; border-radius: 38px 38px 0 0; display: flex; align-items: center; justify-content: space-between;
      padding: 4px 26px 0 30px; font: 600 12px/1 -apple-system, BlinkMacSystemFont, Roboto, sans-serif; background: ${p.app}; color: ${p.appText}; }
    .statusbar .icons { display: flex; gap: 6px; align-items: center; }
    .sig { display: flex; gap: 1.5px; align-items: flex-end; height: 10px; }
    .sig b { width: 3px; background: ${p.appText}; border-radius: 1px; }
    .sig b:nth-child(1) { height: 4px; } .sig b:nth-child(2) { height: 6px; } .sig b:nth-child(3) { height: 8px; } .sig b:nth-child(4) { height: 10px; }
    .bat { width: 20px; height: 10px; border: 1.5px solid ${p.appText}; border-radius: 3px; padding: 1px; }
    .bat b { display: block; height: 100%; width: 75%; background: ${p.appText}; border-radius: 1px; }
    .island { position: absolute; z-index: 2; top: 13px; left: 50%; width: 18px; height: 18px; margin-left: -9px; border-radius: 50%; background: #0b0b0b; }
    .win { border-radius: 12px; overflow: hidden; background: ${p.app}; box-shadow: 0 0 0 1px ${theme === 'dark' ? 'rgba(255,255,255,.12)' : 'rgba(0,0,0,.1)'}, 0 24px 60px rgba(0,0,0,.18); }
    .win .bar { height: 30px; display: flex; align-items: center; gap: 6px; padding: 0 12px; background: ${p.chrome}; }
    .win .bar i { width: 10px; height: 10px; border-radius: 50%; background: ${p.muted}55; }
    .win .url { flex: 1; margin-left: 10px; height: 19px; border-radius: 10px; background: ${p.app}; font-size: 11px; color: ${p.muted}; padding: 0 10px; line-height: 19px; }
    .content { position: relative; width: 330px; height: 450px; }
    /* three devices: smaller */
    #trio .pop { width: 300px; height: 480px; }
    #trio .screen { width: 218px; height: 472px; }
    #trio .statusbar { width: 218px; height: 26px; padding: 4px 20px 0 24px; font-size: 10.5px; }
    #trio .frame { border-radius: 40px; padding: 8px; }
    #trio .screen img { border-radius: 0 0 32px 32px; } #trio .statusbar { border-radius: 32px 32px 0 0; }
    #trio .phone { margin-top: 0; }
    .label { margin-top: 14px; font-size: 14px; color: ${p.muted}; font-weight: 600; letter-spacing: .02em; }
    .link { width: 210px; margin-top: 300px; display: flex; justify-content: center; }
    .lock { font-size: 14px; font-weight: 650; color: ${p.accent}; background: ${p.soft}; padding: 8px 14px; border-radius: 999px; white-space: nowrap; }
    .bubble { position: absolute; bottom: 110px; left: 50%; white-space: nowrap; z-index: 3; opacity: 0;
      padding: 12px 18px; border-radius: 16px; font-size: 17px; font-weight: 650; line-height: 1.35;
      background: ${p.accent}; color: ${p.onAccent}; box-shadow: 0 12px 30px rgba(0,0,0,.18); }
    .bubble kbd { display: inline-block; font: 600 14px/1 -apple-system, sans-serif; padding: 4px 7px; border-radius: 6px; background: rgba(255,255,255,.22); margin-right: 6px; }
    .packet { position: absolute; z-index: 5; left: 0; top: 0; opacity: 0; }
    .packet span { position: absolute; left: 0; top: 0; transform: translate(-50%, -50%); white-space: nowrap;
      padding: 9px 14px; border-radius: 12px; font-size: 15px; font-weight: 650; box-shadow: 0 10px 26px rgba(0,0,0,.2); }
    .packet .plain { background: ${p.accent}; color: ${p.onAccent}; }
    .packet .cipher { background: ${p.text}; color: ${p.bg2}; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 14px; }
    .end { position: absolute; inset: 0; z-index: 10; opacity: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center;
      background: radial-gradient(1200px 600px at 20% 0%, ${p.bg1}, ${p.bg2}); }
    .end img { width: 120px; height: 120px; border-radius: 28px; box-shadow: 0 20px 50px rgba(0,0,0,.2); }
    .end h1 { margin-top: 28px; font-size: 56px; }
    .end p { font-size: 24px; color: ${p.muted}; margin: 12px 0 0; }
    .chips { display: flex; gap: 10px; flex-wrap: wrap; justify-content: center; max-width: 900px; margin-top: 30px !important; }
    .chips span { font-size: 16px; font-weight: 600; color: ${p.accent}; background: ${p.soft}; padding: 8px 14px; border-radius: 999px; }
  </style></head><body>
    <header><div class="cap" id="capA"><h1></h1><p></p></div><div class="cap" id="capB"><h1></h1><p></p></div></header>
    <main id="duo">${macHtml('mac', 360)}<div class="link"><div class="lock" id="lock">${S.lock}</div></div>${phoneHtml('phone')}</main>
    <main id="trio">${macHtml('mac3', 300)}${phoneHtml('phone3')}${pcHtml('pc3')}</main>
    <div class="packet"><span class="plain"></span><span class="cipher"></span></div>
    <div class="packet"><span class="plain"></span><span class="cipher"></span></div>
    <div class="end" id="end"><img src="${ICON}"><h1>Entre Nous</h1><p>${S.endSub}</p>
      <p class="chips">${S.chips.map((c) => `<span>${c}</span>`).join('')}</p></div>
    <script>
      const images = {};
      window.addImage = (k, url) => { images[k] = url; };
      const $ = (id) => document.getElementById(id);
      const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
      const at = (id, fy) => { const r = $(id).getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height * fy]; };
      const cap = (el, t, s, o) => { el.querySelector('h1').textContent = t || ''; el.querySelector('p').textContent = s || ''; el.style.opacity = t ? o : 0; };
      window.setScene = async (s) => {
        document.body.classList.toggle('bare', !!s.bare); // devices only, on a transparent background
        for (const slot of ['mac', 'phone', 'mac3', 'phone3', 'pc3']) {
          const [a, b] = $(slot).querySelectorAll('img');
          const set = (el, key) => { if (key && el.dataset.k !== key) { el.src = images[key]; el.dataset.k = key; } };
          set(a, s[slot]);
          set(b, s[slot + 'Next'] || s[slot]);
          b.style.opacity = s[slot + 'Next'] ? s[slot + 'Mix'] : 0;
        }
        // a change of layout or of title: the old one fades out, then the new one fades in
        const trio = s.trio || 0;
        $('duo').style.opacity = Math.max(0, 1 - 2 * trio);
        $('trio').style.opacity = Math.max(0, 2 * trio - 1);
        const mix = s.capMix ?? 1;
        cap($('capA'), s.title, s.sub, Math.max(0, 2 * mix - 1));
        cap($('capB'), s.prevTitle, s.prevSub, Math.max(0, 1 - 2 * mix));
        for (const el of document.querySelectorAll('.label[data-for]')) {
          el.dataset.default ??= el.textContent;
          el.textContent = (s.labels || {})[el.dataset.for] || el.dataset.default;
        }
        for (const el of document.querySelectorAll('.bubble')) {
          const b = (s.bubbles || []).find((x) => x.at === el.dataset.at);
          if (!b) { el.style.opacity = 0; continue; }
          el.innerHTML = b.html;
          el.style.opacity = b.k;
          const tilt = el.dataset.at.startsWith('mac') ? -2 : 2;
          el.style.transform = 'translateX(-50%) translateY(' + (1 - b.k) * 14 + 'px) rotate(' + tilt + 'deg) scale(' + (0.86 + 0.14 * b.k) + ')';
        }
        const packets = document.querySelectorAll('.packet');
        packets.forEach((pk, i) => {
          const k = (s.packets || [])[i];
          if (!k) return void (pk.style.opacity = 0);
          const a = at(k.from, 0.42), d = at(k.to, 0.42);
          const c = k.from === 'mac' || k.from === 'phone' ? [at('lock', 0.5)[0], at('lock', 0.5)[1] - 150] : [(a[0] + d[0]) / 2, Math.min(a[1], d[1]) - 120];
          const e = ease(k.p);
          pk.style.left = (1 - e) * (1 - e) * a[0] + 2 * (1 - e) * e * c[0] + e * e * d[0] + 'px';
          pk.style.top = (1 - e) * (1 - e) * a[1] + 2 * (1 - e) * e * c[1] + e * e * d[1] + 'px';
          pk.style.opacity = Math.min(1, k.p * 10, (1 - k.p) * 10);
          // readable at both ends, encrypted on the way
          const p = k.p;
          const clear = p < 0.2 ? 1 : p < 0.25 ? (0.25 - p) / 0.05 : p > 0.8 ? 1 : p > 0.75 ? (p - 0.75) / 0.05 : 0;
          pk.querySelector('.plain').textContent = k.plain;
          pk.querySelector('.cipher').textContent = k.cipher;
          pk.querySelector('.plain').style.opacity = clear;
          pk.querySelector('.cipher').style.opacity = 1 - clear;
        });
        $('end').style.opacity = s.end || 0;
        await Promise.all([...document.images].map((i) => i.decode().catch(() => {})));
      };
    </script>
  </body></html>`;
}

const SLOTS = ['mac', 'phone', 'mac3', 'phone3', 'pc3'];

async function composer(theme, scale) {
  const page = await (await browser.newContext({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: scale })).newPage();
  await page.setContent(stage(theme));
  let n = 0;
  const keys = new Map();
  const image = async (png) => {
    if (!keys.has(png)) {
      const k = 'i' + n++;
      await page.evaluate(([key, url]) => window.addImage(key, url), [k, dataUrl(png)]);
      keys.set(png, k);
    }
    return keys.get(png);
  };
  return {
    async draw(state, path, options = {}) {
      const s = { ...state };
      for (const slot of SLOTS) for (const f of [slot, slot + 'Next']) if (s[f]) s[f] = await image(s[f]);
      await page.evaluate((x) => window.setScene(x), s);
      return page.screenshot({ type: 'png', path, ...options });
    },
    /** The three devices and their labels, with room for their shadows. */
    trioBox: () =>
      page.evaluate(() => {
        let [x0, y0, x1, y1] = [Infinity, Infinity, 0, 0];
        for (const el of document.querySelectorAll('#trio > div, #trio .label')) {
          const r = el.getBoundingClientRect();
          [x0, y0, x1, y1] = [Math.min(x0, r.left), Math.min(y0, r.top), Math.max(x1, r.right), Math.max(y1, r.bottom)];
        }
        const m = 40;
        return { x: x0 - m, y: y0 - m / 2, width: x1 - x0 + 2 * m, height: y1 - y0 + m * 1.5 };
      }),
  };
}

/** Two screenshots side by side, under a title (documentation). */
function pair({ title, left, right, leftLabel, rightLabel, leftPhone = false }) {
  const p = PALETTE.light;
  const pane = (png, label, isPhone) =>
    isPhone
      ? `<div class="col"><div class="frame"><div class="island"></div>${STATUSBAR}<img class="ph" src="${dataUrl(png)}"></div><div class="label">${label}</div></div>`
      : `<div class="col"><img class="win" src="${dataUrl(png)}"><div class="label">${label}</div></div>`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html, body { margin: 0; width: 900px; height: 780px; overflow: hidden; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: ${p.text};
      background: radial-gradient(900px 500px at 20% 0%, ${p.bg1}, ${p.bg2}); }
    h1 { margin: 0; padding: 30px 0 0; text-align: center; font-size: 30px; letter-spacing: -.02em; font-weight: 750; height: 80px; box-sizing: border-box; }
    .row { display: flex; align-items: center; justify-content: center; gap: 90px; height: 700px; }
    .col { display: flex; flex-direction: column; align-items: center; }
    .win { width: 360px; height: 576px; border-radius: 14px; box-shadow: 0 0 0 1px rgba(0,0,0,.08), 0 24px 60px rgba(0,0,0,.16); }
    .frame { position: relative; padding: 9px; border-radius: 46px; background: ${p.frame}; box-shadow: 0 0 0 2px #3a3a38, 0 24px 60px rgba(0,0,0,.2); }
    .ph { display: block; width: 262px; height: 567px; border-radius: 0 0 38px 38px; }
    .statusbar { width: 262px; height: 30px; border-radius: 38px 38px 0 0; display: flex; align-items: center; justify-content: space-between; box-sizing: border-box;
      padding: 4px 26px 0 30px; font: 600 12px/1 -apple-system, BlinkMacSystemFont, Roboto, sans-serif; background: ${p.app}; color: ${p.appText}; }
    .statusbar .icons { display: flex; gap: 6px; align-items: center; }
    .sig { display: flex; gap: 1.5px; align-items: flex-end; height: 10px; }
    .sig b { width: 3px; background: ${p.appText}; border-radius: 1px; }
    .sig b:nth-child(1) { height: 4px; } .sig b:nth-child(2) { height: 6px; } .sig b:nth-child(3) { height: 8px; } .sig b:nth-child(4) { height: 10px; }
    .bat { width: 20px; height: 10px; border: 1.5px solid ${p.appText}; border-radius: 3px; padding: 1px; box-sizing: border-box; }
    .bat b { display: block; height: 100%; width: 75%; background: ${p.appText}; border-radius: 1px; }
    .island { position: absolute; z-index: 2; top: 13px; left: 50%; width: 18px; height: 18px; margin-left: -9px; border-radius: 50%; background: #0b0b0b; }
    .label { margin-top: 16px; font-size: 14px; font-weight: 600; color: ${p.muted}; }
  </style></head><body><h1>${title}</h1><div class="row">${pane(left, leftLabel, leftPhone)}${pane(right, rightLabel, !leftPhone)}</div></body></html>`;
}

const docs = await (await browser.newContext({ viewport: { width: 900, height: 780 }, deviceScaleFactor: 2 })).newPage();
async function renderPair(html, file) {
  await docs.setContent(html);
  await docs.evaluate(() => Promise.all([...document.images].map((i) => i.decode().catch(() => {}))));
  await docs.screenshot({ type: 'png', path: file });
}

/** The invitation link: its start shown with a public address, its secret blurred. */
async function blurLink(page) {
  await inviteView(page).locator('input.link').evaluate((el, host) => {
    const cs = getComputedStyle(el);
    const d = document.createElement('div');
    for (const k of ['font', 'color', 'background', 'border', 'borderRadius', 'padding', 'width', 'boxSizing', 'margin']) d.style[k] = cs[k];
    Object.assign(d.style, { overflow: 'hidden', whiteSpace: 'nowrap', textAlign: 'left' });
    const secret = document.createElement('span');
    secret.textContent = el.value.split('#p=')[1];
    secret.style.filter = 'blur(5px)';
    d.append(`https://${host}/app/#p=`, secret);
    el.style.display = 'none';
    el.after(d);
  }, PUBLIC);
}

// ------------------------------------------------------------------ the devices

const mac = await device('mac');
const phone = await device('phone');
let pc; // opened on its invitation link
await mac.locator('section.main').waitFor();
await phone.locator('section.center', { hasText: S.scan }).waitFor();
const welcomePhone = await shot(phone);

// association: the Mac shows its QR code and its link
await mac.getByLabel(S.settings).click();
await button(mac, S.invite).click();
await inviteView(mac).locator('img.qr').waitFor();
const link = await inviteView(mac).locator('input.link').inputValue();
await blurLink(mac);
await sleep(300);
const inviteMac = await shot(mac);
await phone.goto(link);
await phone.locator('section.main').waitFor();
await mac.locator('section.main').waitFor();
await rename(phone, 'Pixel 9');
await invite(mac, async (l) => {
  pc = await device('pc', l);
  await pc.locator('section.main').waitFor();
});
await until('three devices', async () => (await mac.locator('.status').textContent()).includes(S.pcName));
await sleep(500);

// a lived-in history
const copy = (text) => mac.evaluate((t) => window.__entrenous.event('localCopy', { kind: 'text', text: t }), text);
await copy(S.wifi);
await phone.locator('.history .item', { hasText: S.wifi }).waitFor();
await mac.locator('input[type=file][multiple]').setInputFiles({ name: S.quote, mimeType: 'application/pdf', buffer: Buffer.alloc(1_830_000, 7) });
await phone.locator('.history .item', { hasText: S.quote }).waitFor();
await pc.locator('.history .item', { hasText: S.quote }).waitFor();
await phone.locator('.transfer').first().waitFor({ state: 'detached' }).catch(() => {});
await pc.locator('input[type=file][multiple]').setInputFiles({ name: S.md.name, mimeType: 'text/markdown', buffer: Buffer.from(S.md.text) });
for (const d of [mac, phone]) await d.locator('.history .item', { hasText: S.md.name }).waitFor();
await sleep(600);

const pct = async (page) => /(\d+) ?%/.exec((await page.locator('.transfer').allTextContents()).join(' '))?.[1];
/** Lets one more chunk go, and waits until every device shows the same progress. */
async function oneChunk(sender, others) {
  await until('a chunk sent', () => sender.evaluate(() => window.__heldCount()));
  await sender.evaluate(() => window.__step(1));
  await until('progress everywhere', async () => {
    const all = await Promise.all([sender, ...others].map(pct));
    return all[0] && all[0] !== '0' && all.every((x) => x === all[0]);
  });
}

// ------------------------------------------------------------------ the animation

const timeline = [];
const hold = (state, seconds) => timeline.push({ state, seconds });
const tween = (frames, fn) => {
  for (let i = 1; i <= frames; i++) timeline.push({ state: fn(i / frames), seconds: 1 / FPS });
};
const duoShots = async () => ({ mac: await shot(mac), phone: await shot(phone) });
const trioShots = async () => ({ mac3: await shot(mac), phone3: await shot(phone), pc3: await shot(pc), trio: 1 });
/** From state `a` to state `b`: every screenshot cross-fades with `k`. */
const blend = (a, b, k) => {
  const s = { ...b };
  for (const slot of SLOTS) if (a[slot] && b[slot] && a[slot] !== b[slot]) Object.assign(s, { [slot]: a[slot], [slot + 'Next']: b[slot], [slot + 'Mix']: k });
  return s;
};
const T = S.T;
const caption = (to, from, k = 1) => ({ title: to[0], sub: to[1], prevTitle: from?.[0], prevSub: from?.[1], capMix: k });
const bubble = (at, html, k) => ({ at, html, k });

// 1. two devices: a copy on the Mac travels to the phone
const address = S.address;
const copied = `<kbd>⌘C</kbd>${address}`;
const d0 = await duoShots();
hold({ ...d0, ...caption(T.copy) }, 0.8);
tween(9, (k) => ({ ...d0, ...caption(T.copy), bubbles: [bubble('mac', copied, k)] }));
hold({ ...d0, ...caption(T.copy), bubbles: [bubble('mac', copied, 1)] }, 1.3);
await copy(address);
await phone.locator('.history .item', { hasText: S.addressFind }).waitFor();
await pc.locator('.history .item', { hasText: S.addressFind }).waitFor();
await sleep(400);
const d1 = await duoShots();
tween(40, (p) => ({
  mac: d0.mac, macNext: d1.mac, macMix: Math.min(1, p * 8), phone: d0.phone,
  ...caption(T.got, T.copy, Math.min(1, p * 1.6)),
  bubbles: [bubble('mac', copied, Math.max(0, 1 - p * 4))],
  packets: [{ p, from: 'mac', to: 'phone', plain: S.addressShort, cipher: '🔒 8f3a c91e 07d2 4be6' }],
}));
tween(7, (k) => ({ ...blend(d0, d1, k), mac: d1.mac, ...caption(T.got), bubbles: [bubble('phone', S.received, k)] }));
hold({ ...d1, ...caption(T.got), bubbles: [bubble('phone', S.received, 1)] }, 2.2);

// 2. three devices: the phone shares a photo, the Mac and the PC receive it together
const t0 = await trioShots();
tween(12, (k) => ({ ...d1, ...t0, trio: k, ...caption(T.trio, T.got, k), bubbles: [bubble('phone', S.received, 1 - k)] }));
hold({ ...t0, ...caption(T.trio) }, 0.8);
const jpeg = await photo(phone, 2100, 2800); // a phone photo: upright
await phone.evaluate(() => window.__hold());
await phone.locator('input[type=file][multiple]').setInputFiles({ name: 'IMG_4127.jpg', mimeType: 'image/jpeg', buffer: jpeg });
await mac.locator('.transfer', { hasText: 'IMG_4127' }).waitFor();
await pc.locator('.transfer', { hasText: 'IMG_4127' }).waitFor();
await sleep(400);
let tu = await trioShots();
tween(8, (k) => ({ ...blend(t0, tu, k), ...caption(T.trio) }));
hold({ ...tu, ...caption(T.trio) }, 0.5);
const chunks = Math.ceil(jpeg.length / (1024 * 1024));
const ciphers = ['a1f0 9c37 e51b', '60c4 f7a9 13de', 'd72e 05b9 fa41', '3e8d b1c6 47f0'];
for (let i = 1; i <= chunks; i++) {
  if (i < chunks) await oneChunk(phone, [mac, pc]);
  else {
    await phone.evaluate(() => window.__release());
    for (const d of [mac, pc]) {
      await d.locator('.transfer').first().waitFor({ state: 'detached' });
      await until('thumbnail', () => d.locator('.history .item .thumb.pic img').count());
    }
  }
  await sleep(500);
  const tn = await trioShots();
  const packet = { plain: S.chunk(i, chunks), cipher: '🔒 ' + ciphers[(i - 1) % ciphers.length], from: 'phone3' };
  const before = tu;
  tween(32, (p) => ({
    ...blend(before, tn, p > 0.82 ? (p - 0.82) / 0.18 : 0), ...caption(T.trio),
    packets: [{ p, ...packet, to: 'mac3' }, { p, ...packet, to: 'pc3' }],
  }));
  tu = tn;
  hold({ ...tu, ...caption(T.trio) }, i < chunks ? 0.3 : 0.8);
}
const pasted = `<kbd>⌘V</kbd>${S.paste}`;
tween(9, (k) => ({ ...tu, ...caption(T.paste, T.trio, k), bubbles: [bubble('mac3', pasted, k)] }));
hold({ ...tu, ...caption(T.paste), bubbles: [bubble('mac3', pasted, 1)] }, 2.2);
const poster = timeline.at(-1).state;

// 3. previews: the photo full size on the Mac, the Markdown file formatted on the phone
await openPreview(mac, 'IMG_4127');
const tv = await trioShots();
tween(9, (k) => ({ ...blend(tu, tv, k), ...caption(T.view, T.paste, k), bubbles: [bubble('mac3', pasted, 1 - k)] }));
hold({ ...tv, ...caption(T.view) }, 2.4);
await openPreview(phone, S.md.name);
const tm = await trioShots();
tween(9, (k) => ({ ...blend(tv, tm, k), ...caption(T.md, T.view, k) }));
hold({ ...tm, ...caption(T.md) }, 2.8);
await closePreview(mac);
await closePreview(phone);
const tc = await trioShots();

// 4. the live note, letter by letter, on every device
const note = S.note;
tween(9, (k) => ({ ...blend(tm, tc, k), ...caption(T.note, T.md, k) }));
let last = tc;
for (let i = 2; i <= note.length; i += 2) {
  await mac.locator('.note textarea').fill(note.slice(0, i));
  for (const d of [phone, pc]) await until('note', async () => (await d.locator('.note textarea').inputValue()) === note.slice(0, i), 5000);
  last = await trioShots();
  hold({ ...last, ...caption(T.note) }, 2 / FPS);
}
await mac.locator('.note textarea').fill(note);
for (const d of [phone, pc]) await until('note', async () => (await d.locator('.note textarea').inputValue()) === note);
await mac.locator('.note textarea').blur();
await sleep(300);
last = await trioShots();
hold({ ...last, ...caption(T.note) }, 2.2);
tween(12, (k) => ({ ...last, ...caption(T.note), end: k }));
hold({ ...last, end: 1 }, 3.5);

// ------------------------------------------------------------------ stills

// landing page: the three devices, no title, on a transparent background, light and dark
const devices = async (theme, shots, name) => {
  const c = await composer(theme, 2);
  await c.draw({ ...shots, bare: true }); // the scene in place, to measure it
  const tmp = join(tmpdir(), `entrenous-${name}.png`);
  await c.draw({ ...shots, bare: true }, tmp, { omitBackground: true, clip: await c.trioBox() });
  webp(tmp, LANDING + name + '.webp');
  rmSync(tmp);
};
await devices('light', last, 'appareils' + (LANG === 'en' ? '-en' : ''));
for (const d of [mac, phone, pc]) await d.emulateMedia({ colorScheme: 'dark' });
await sleep(300);
await devices('dark', await trioShots(), 'appareils-sombre' + (LANG === 'en' ? '-en' : ''));
for (const d of [mac, phone, pc]) await d.emulateMedia({ colorScheme: 'light' });
await sleep(300);

const hero = S.hero;
await (await composer('light', 2)).draw({ ...(await duoShots()), ...hero }, file(OUT, 'apercu', '.png'));
for (const d of [mac, phone]) await d.emulateMedia({ colorScheme: 'dark' });
await sleep(300);
const dark = await duoShots();
for (const d of [mac, phone]) await d.emulateMedia({ colorScheme: 'light' });
await (await composer('dark', 2)).draw({ ...dark, ...hero }, file(OUT, 'apercu-sombre', '.png'));

await renderPair(
  pair({
    ...S.pairing,
    left: inviteMac,
    right: welcomePhone,
  }),
  file(OUT, 'association', '.png'),
);

// previews: the Markdown file on the Mac, the photo on the phone
await openPreview(mac, S.md.name);
await openPreview(phone, 'IMG_4127');
await renderPair(
  pair({
    ...S.previewsPair,
    left: await shot(mac),
    right: await shot(phone),
  }),
  file(OUT, 'apercus', '.png'),
);
await closePreview(mac);
await closePreview(phone);

// a video still being sent, already being downloaded by the two others: a real one (its
// image and its length in the history), made from the demo photo, about 6 MB
const vdir = mkdtempSync(join(tmpdir(), 'entrenous-video-'));
writeFileSync(join(vdir, 'photo.jpg'), await photo(phone, 1920, 1080));
execFileSync('ffmpeg', [
  '-y', '-loglevel', 'error', '-loop', '1', '-i', join(vdir, 'photo.jpg'), '-t', '12',
  '-vf', "zoompan=z='1+0.0006*on':d=1:s=1920x1080:fps=30,noise=alls=10:allf=t,format=yuv420p",
  '-c:v', 'libx264', '-b:v', '4M', '-maxrate', '4M', '-bufsize', '8M', '-movflags', '+faststart', join(vdir, 'video.mp4'),
]);
const video = readFileSync(join(vdir, 'video.mp4'));
rmSync(vdir, { recursive: true });
await phone.evaluate(() => window.__hold());
await phone.locator('input[type=file][multiple]').setInputFiles({ name: S.video, mimeType: 'video/mp4', buffer: video });
await mac.locator('.transfer', { hasText: S.video }).waitFor();
await pc.locator('.transfer', { hasText: S.video }).waitFor();
await oneChunk(phone, [mac, pc]);
for (const d of [mac, pc]) {
  const item = d.locator('.history .item', { hasText: S.video });
  await button(item, S.save).click();
  await item.locator('.download').waitFor();
}
await oneChunk(phone, [mac, pc]);
await oneChunk(phone, [mac, pc]);
await sleep(600);
await (await composer('light', 2)).draw(
  {
    ...(await trioShots()),
    ...S.uploading,
  },
  file(OUT, 'envoi-en-cours', '.png'),
);
await phone.evaluate(() => window.__release());
for (const d of [mac, pc]) await d.locator('.transfer').first().waitFor({ state: 'detached' });

// settings: the Mac at the top, the phone on the group and its devices
await mac.getByLabel(S.settings).click();
await phone.getByLabel(S.settings).click();
await phone.locator('h3', { hasText: S.devices }).scrollIntoViewIfNeeded();
await phone.evaluate(() => window.scrollBy(0, 220));
await sleep(400);
await renderPair(
  pair({
    ...S.settingsPair,
    left: await shot(mac),
    right: await shot(phone),
  }),
  file(OUT, 'reglages', '.png'),
);

// landing page: the pictures of the documentation shown in its FAQ, lighter
for (const name of ['association', 'apercus', 'envoi-en-cours', 'reglages']) {
  execFileSync('magick', [file(OUT, name, '.png'), '-resize', '1200x', '-quality', '82', file(LANDING, name, '.webp')]);
}

// ------------------------------------------------------------------ the film

const film = await composer('light', 1);
const dir = mkdtempSync(join(tmpdir(), 'entrenous-gif-'));
let list = '';
for (const [i, f] of timeline.entries()) {
  const file = join(dir, `f${String(i).padStart(4, '0')}.png`);
  await film.draw(f.state, file);
  list += `file '${file}'\nduration ${f.seconds.toFixed(4)}\n`;
}
list += `file '${join(dir, `f${String(timeline.length - 1).padStart(4, '0')}.png`)}'\n`; // the last duration counts
writeFileSync(join(dir, 'list.txt'), list);
execFileSync('ffmpeg', [
  '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', join(dir, 'list.txt'),
  '-vf', `fps=${FPS},scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=160:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`,
  '-loop', '0', file(OUT, 'demo', '.gif'),
]);
// landing page: the same film, as an animated WebP (far lighter than the GIF), and a still
// for the visitors who ask for less motion
const frames = [];
for (const [i, f] of timeline.entries()) frames.push('-delay', `${Math.max(1, Math.round(f.seconds * FPS))}x${FPS}`, join(dir, `f${String(i).padStart(4, '0')}.png`));
execFileSync('magick', [...frames, '-resize', '1000x', '-loop', '0', '-quality', '70', file(LANDING, 'demo', '.webp')], { maxBuffer: 1 << 26 });
await film.draw(poster, join(dir, 'poster.png'));
execFileSync('magick', [join(dir, 'poster.png'), '-resize', '1000x', '-quality', '80', file(LANDING, 'demo-fixe', '.webp')]);
rmSync(dir, { recursive: true });

await browser.close();
const x = LANG === 'en' ? '-en' : '';
console.log(`docs/images: apercu${x}.png, apercu-sombre${x}.png, demo${x}.gif (${timeline.length} images), association${x}.png, apercus${x}.png, envoi-en-cours${x}.png, reglages${x}.png`);
console.log(`web/public/images: appareils(-sombre)${x}.webp, demo(-fixe)${x}.webp, association${x}.webp, apercus${x}.webp, envoi-en-cours${x}.webp, reglages${x}.webp`);
