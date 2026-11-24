// The page of a share link (/s/#<secret>), for someone outside the group: no account, no app.
// It opens the link on the relay that serves it, decrypts the item here, and shows it: a text
// to copy, an image's preview, a video or a song played while it arrives, a text file's start;
// anything can be downloaded. Plain DOM: no framework, a strict Content Security Policy.
import { ShareGoneError, openShare, shareSecretOf, type SharedItem } from '../core/share.ts';
import { TEXT_PREVIEW_MAX, audioMime, decodeStart, previewKind } from '../core/media.ts';
import { NotStreamable, stream } from '../ui/player.ts';
import { duration, humanSize, lang, t, tn } from '../i18n/index.ts';
import { type FolderFile, type FolderIndex, baseName, fileReader, readBlob, readIndex } from '../core/folder.ts';
import { FolderBrowser } from '../ui/folder-view.ts';
import { chooseTarget, writeFolder } from '../ui/folder-save.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

document.documentElement.lang = lang();
$('e2e').textContent = t('visit.e2e');
$('cta').textContent = t('visit.cta') + ' →';

function state(text: string) {
  $('state-text').textContent = text;
  $('state').hidden = false;
  $('shared').hidden = true;
}

async function main() {
  const secret = shareSecretOf(location.href);
  if (!secret) return state(t('visit.bad'));
  state(t('viewer.loading'));
  let item: SharedItem;
  try {
    item = await openShare(location.origin, secret);
  } catch (err: any) {
    return state(err instanceof ShareGoneError ? t('visit.gone') : t('visit.error', { msg: err?.message ?? err }));
  }
  show(item);
}

function show(item: SharedItem) {
  const h = item.header;
  if (h.kind === 'folder') return showFolder(item);
  const isText = h.kind === 'text';
  $('lead').textContent = t(isText ? 'visit.text' : 'visit.file');
  $('name').textContent = isText ? '' : (h.name ?? t('name.file'));
  $('name').hidden = isText;
  const meta = () => {
    const parts = [];
    if (item.size) parts.push(humanSize(isText && h.text !== undefined ? new TextEncoder().encode(h.text).length : item.size));
    parts.push(t('expires', { d: duration(item.expiresAt - Date.now()) }));
    $('meta').textContent = parts.join(' · ');
  };
  meta();
  setInterval(meta, 30_000);
  $('state').hidden = true;
  $('shared').hidden = false;

  const media = $('media');
  const thumb = typeof h.thumb === 'string' && h.thumb.startsWith('data:image/') ? h.thumb : '';

  // a short text: shown, to copy
  if (isText && h.text !== undefined) {
    media.append(textBlock(h.text));
    copyButton(h.text);
    return;
  }
  downloadButton(item);
  const kind = previewKind(h.name, h.mime);
  if (kind === 'video') playMedia(item, document.createElement('video'), thumb);
  else if (kind === 'audio') playMedia(item, document.createElement('audio'), thumb);
  else if (kind === 'text' || kind === 'markdown' || isText) showTextStart(item);
  else if (thumb) {
    // an image, a PDF's first page: the preview made by the sender
    const img = document.createElement('img');
    img.className = 'visit-image';
    img.src = thumb;
    img.alt = h.name ?? '';
    media.append(img);
  }
}

function textBlock(text: string) {
  const pre = document.createElement('pre');
  pre.className = 'visit-text';
  pre.textContent = text;
  return pre;
}

function copyButton(text: string) {
  const b = $<HTMLButtonElement>('copy');
  b.textContent = t('copy');
  b.hidden = false;
  b.onclick = () =>
    navigator.clipboard.writeText(text).then(
      () => flash(b, t('toast.copied')),
      (err) => flash(b, t('toast.copyFailed', { msg: err?.message ?? err })),
    );
}

function flash(b: HTMLButtonElement, text: string) {
  const label = b.textContent;
  b.textContent = text;
  setTimeout(() => (b.textContent = label), 2000);
}

let whole: Promise<Blob> | undefined;

/** The whole content, once (the download, and a video that cannot be streamed, share it). */
function content(item: SharedItem, onProgress?: (done: number, total: number) => void) {
  whole ??= item.blob(onProgress);
  whole.catch(() => (whole = undefined));
  return whole;
}

function downloadButton(item: SharedItem) {
  const b = $<HTMLButtonElement>('download');
  const label = t('visit.download');
  b.textContent = label;
  b.hidden = false;
  b.onclick = async () => {
    b.disabled = true;
    try {
      const blob = await content(item, (done, total) => (b.textContent = `${label} · ${Math.round((done / total) * 100)}${lang() === 'fr' ? ' %' : '%'}`));
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = item.header.name || t('name.file');
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
    } catch (err: any) {
      note(err instanceof ShareGoneError ? t('visit.gone') : t('visit.error', { msg: err?.message ?? err }));
    } finally {
      b.textContent = label;
      b.disabled = false;
    }
  };
}

/** Saves a file here (a browser download). */
function saveBlob(blob: Blob, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
}

function note(text: string) {
  $('note').textContent = text;
  $('note').hidden = false;
}

/** A video or a song: played while it arrives; downloaded whole first where it cannot be. */
async function playMedia(item: SharedItem, el: HTMLVideoElement | HTMLAudioElement, poster: string) {
  const h = item.header;
  el.controls = true;
  el.preload = 'metadata';
  el.className = el instanceof HTMLVideoElement ? 'visit-video' : 'visit-audio';
  if (el instanceof HTMLVideoElement) {
    el.playsInline = true;
    if (poster) el.poster = poster;
  }
  $('media').append(el);
  const unreadable = () => note(t('viewer.unreadable'));
  el.onerror = unreadable;
  el.addEventListener('streamerror', unreadable);
  try {
    await stream(el, item.reader(el instanceof HTMLVideoElement ? { keep: 8, ahead: 3 } : { keep: 4, ahead: 2 }), { duration: h.duration });
  } catch (err) {
    if (!(err instanceof NotStreamable)) return note(t('visit.error', { msg: (err as Error)?.message ?? err }));
    const mime = h.mime || (el instanceof HTMLVideoElement ? 'video/mp4' : audioMime(h.name));
    if (!el.canPlayType(mime)) return unreadable();
    el.src = URL.createObjectURL(await content(item));
  }
}

/** A text file: its start (the first megabyte at most). */
async function showTextStart(item: SharedItem) {
  const reader = item.reader({ ahead: 0 });
  try {
    const bytes = await reader.read(0, TEXT_PREVIEW_MAX);
    const whole = item.size <= TEXT_PREVIEW_MAX;
    $('media').append(textBlock(decodeStart(bytes, whole)));
    if (!whole) note(t('viewer.truncated', { size: humanSize(item.size) }));
  } catch (err: any) {
    note(t('visit.error', { msg: err?.message ?? err }));
  } finally {
    reader.close();
  }
}

// another link opened in this tab only changes what follows the "#": start again
window.addEventListener('hashchange', () => location.reload());
main();

// ------------------------------------------------------------------ a folder

/** A folder: browsed here, one level at a time; its files previewed and downloaded. */
async function showFolder(item: SharedItem) {
  const h = item.header;
  $('lead').textContent = t('visit.folder');
  $('shared').hidden = false;
  $('state').hidden = true;
  const card = document.querySelector('.visit-card') as HTMLElement;
  card.hidden = true;
  const box = $('folder');
  box.hidden = false;
  $('folder-meta').textContent = t('folder.loading');
  const reader = item.reader({ keep: 6, ahead: 1 });
  let index: FolderIndex;
  try {
    index = await readIndex(reader);
  } catch (err: any) {
    reader.close();
    box.hidden = true;
    return state(err?.name === 'ShareGoneError' ? t('visit.gone') : t('visit.error', { msg: err?.message ?? err }));
  }
  const meta = () => {
    const files = h.folder?.files ?? index.files.length;
    $('folder-meta').textContent = [tn('folder.files', files), humanSize(h.folder?.bytes ?? 0), t('expires', { d: duration(item.expiresAt - Date.now()) })].join(' · ');
  };
  meta();
  setInterval(meta, 30_000);
  const thumbs = new Map<string, string>();
  const thumbOf = async (f: FolderFile) => {
    if (!f.thumb) return undefined;
    if (!thumbs.has(f.path)) {
      const bytes = await reader.read(f.thumb[0], f.thumb[0] + f.thumb[1]);
      thumbs.set(f.path, URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'image/jpeg' })));
    }
    return thumbs.get(f.path);
  };
  const host = {
    index,
    thumb: (f: FolderFile) => thumbOf(f).catch(() => undefined),
    open: (f: FolderFile, siblings: FolderFile[]) => preview(item, f, siblings, thumbOf),
    download: async (files: FolderFile[], dirs: string[], base: string, name: string) => {
      const strip = base ? base.length + 1 : 0;
      const total = files.reduce((n, f) => n + f.size, 0);
      const pct = (done: number) => (total ? Math.round((done / total) * 100) : 100) + (lang() === 'fr' ? ' %' : '%');
      try {
        if (files.length === 1 && !dirs.length) {
          browser.setBusy(pct(0));
          const f = files[0];
          saveBlob(await readBlob(reader, f, (n) => browser.setBusy(pct(n))), baseName(f.path));
          return;
        }
        // where it goes is asked first, while the tap counts
        const target = await chooseTarget(name, {});
        if (!target) return;
        browser.setBusy(pct(0));
        const res = await writeFolder(
          target,
          files.map((f) => ({ path: f.path.slice(strip), size: f.size, read: (a: number, b: number) => reader.read(f.offset + a, f.offset + b) })),
          dirs.map((d) => d.slice(strip)).filter(Boolean),
          (done) => browser.setBusy(pct(done)),
        );
        if ('zip' in res) saveBlob(res.zip, name + '.zip');
        else note(t('folder.saved', { where: res.where }));
      } catch (err: any) {
        note(err instanceof ShareGoneError ? t('visit.gone') : t('visit.error', { msg: err?.message ?? err }));
      } finally {
        browser.setBusy('');
      }
    },
  };
  const browser = new FolderBrowser($('folder-browser'), host);
}

let previewSeq = 0;
/** What the open preview holds: its player, its object URL. */
let previewStop: (() => void) | undefined;
let previewUrl = '';

/** Stops the open preview: its player, its reader, its object URL. */
function releasePreview() {
  previewSeq++;
  previewStop?.();
  previewStop = undefined;
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = '';
  const media = $('preview-media');
  media.querySelectorAll('video, audio').forEach((m) => {
    (m as HTMLMediaElement).pause();
    m.removeAttribute('src');
    (m as HTMLMediaElement).load();
  });
  media.replaceChildren();
}

/** A file of the folder, over the page: its preview, the others of its folder at its sides. */
async function preview(item: SharedItem, f: FolderFile, siblings: FolderFile[], thumbOf: (f: FolderFile) => Promise<string | undefined>) {
  releasePreview();
  const seq = previewSeq;
  const pane = $('preview');
  const media = $('preview-media');
  $('preview-note').hidden = true;
  pane.hidden = false;
  const name = baseName(f.path);
  $('preview-name').textContent = name;
  const parts = [humanSize(f.size)];
  if (f.w && f.h) parts.push(`${f.w} × ${f.h}`);
  if (f.pages) parts.push(tn('viewer.pages', f.pages));
  $('preview-meta').textContent = parts.join(' · ');
  const at = siblings.findIndex((x) => x.path === f.path);
  const prev = $<HTMLButtonElement>('preview-prev');
  const next = $<HTMLButtonElement>('preview-next');
  prev.hidden = at <= 0;
  next.hidden = at < 0 || at >= siblings.length - 1;
  prev.onclick = () => preview(item, siblings[at - 1], siblings, thumbOf);
  next.onclick = () => preview(item, siblings[at + 1], siblings, thumbOf);
  $('preview-close').onclick = () => {
    releasePreview();
    pane.hidden = true;
  };
  const say = (text: string) => {
    $('preview-note').textContent = text;
    $('preview-note').hidden = false;
  };
  const read = () => fileReader(item.reader({ keep: 8, ahead: 3 }), f);
  const kind = previewKind(name, f.mime);
  const thumb = await thumbOf(f).catch(() => undefined);
  if (seq !== previewSeq) return;
  try {
    if (kind === 'video' || kind === 'audio') {
      const el = document.createElement(kind);
      el.controls = true;
      el.className = kind === 'video' ? 'visit-video' : 'visit-audio';
      if (el instanceof HTMLVideoElement) {
        el.playsInline = true;
        if (thumb) el.poster = thumb;
      }
      media.append(el);
      el.onerror = () => say(t('viewer.unreadable'));
      try {
        const stop = await stream(el, read(), { duration: f.duration });
        if (seq !== previewSeq) return stop();
        previewStop = stop;
      } catch (err) {
        if (!(err instanceof NotStreamable)) throw err;
        const mime = f.mime || (kind === 'video' ? 'video/mp4' : audioMime(name));
        if (!el.canPlayType(mime)) return say(t('viewer.unreadable'));
        const r = item.reader({ keep: 2, ahead: 1 });
        const blob = await readBlob(r, f).finally(() => r.close());
        if (seq !== previewSeq) return;
        previewUrl = URL.createObjectURL(new Blob([blob], { type: mime }));
        el.src = previewUrl;
      }
    } else if (kind === 'text' || kind === 'markdown') {
      const r = read();
      const bytes = await r.read(0, TEXT_PREVIEW_MAX).finally(() => r.close());
      if (seq !== previewSeq) return;
      media.append(textBlock(decodeStart(bytes, f.size <= TEXT_PREVIEW_MAX)));
      if (f.size > TEXT_PREVIEW_MAX) say(t('viewer.truncated', { size: humanSize(f.size) }));
    } else if (thumb) {
      // an image, a PDF's first page: the preview made by the sender
      const img = document.createElement('img');
      img.className = 'visit-image';
      img.src = thumb;
      img.alt = name;
      media.append(img);
    } else say(t('viewer.noPreview'));
  } catch (err: any) {
    if (seq === previewSeq) say(err instanceof ShareGoneError ? t('visit.gone') : t('visit.error', { msg: err?.message ?? err }));
  }
  const save = $<HTMLButtonElement>('preview-save');
  save.textContent = t('visit.download');
  save.onclick = async () => {
    save.disabled = true;
    const r = item.reader({ keep: 2, ahead: 1 });
    try {
      saveBlob(await readBlob(r, f), name);
    } catch (err: any) {
      say(t('visit.error', { msg: err?.message ?? err }));
    } finally {
      r.close();
      save.disabled = false;
    }
  };
}

document.addEventListener('keydown', (e) => {
  if ($('preview').hidden) return;
  if (e.key === 'Escape') $('preview-close').click();
  else if (e.key === 'ArrowLeft' && !$('preview-prev').hidden) $('preview-prev').click();
  else if (e.key === 'ArrowRight' && !$('preview-next').hidden) $('preview-next').click();
});
