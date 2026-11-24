// The page of a share link (/s/#<secret>), for someone outside the group: no account, no app.
// It opens the link on the relay that serves it, decrypts the item here, and shows it: a text
// to copy, an image's preview, a video or a song played while it arrives, a text file's start;
// anything can be downloaded. Plain DOM: no framework, a strict Content Security Policy.
import { ShareGoneError, openShare, shareSecretOf, type SharedItem } from '../core/share.ts';
import { TEXT_PREVIEW_MAX, audioMime, decodeStart, previewKind } from '../core/media.ts';
import { NotStreamable, stream } from '../ui/player.ts';
import { duration, humanSize, lang, t } from '../i18n/index.ts';

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
