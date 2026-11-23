// Previews made on the sending side, before the upload: they travel encrypted in the item's
// header, so the history shows them at once, without downloading anything. The sender is
// also the device most likely to decode its own files (an iPhone's HEIC photo, say).
//  - image: thumbnail, its size in pixels;
//  - video: a frame (poster), its size in pixels and its length;
//  - text file: its first characters.
import type { SendExtra } from '../core/engine.ts';
import { decodeStart, excerptOf, isText, previewKind } from '../core/media.ts';

/** Thumbnails: the history shows them 64 px wide, cropped: 192 px = 64 × 3 (phone screens). */
const THUMB_SHORT = 192;
/** …and no side above 384 px (a panorama). */
const THUMB_LONG = 384;
/** Bytes of a thumbnail aimed at; above, the quality goes down once. */
const THUMB_TARGET = 12 * 1024;
const QUALITIES = [0.8, 0.6];
/** Larger images are not decoded for a thumbnail (memory). */
export const IMAGE_PREVIEW_MAX = 50 * 1024 * 1024;
/** Under the thumbnail of a transparent image, in JPEG (no transparency): the app's background. */
const JPEG_BACKGROUND = '#f6f5f2';
/** A video that takes longer than this to give its first frame is sent without one. */
const VIDEO_WAIT = 8000;

let webp: Promise<boolean> | undefined;
/** Can this browser encode WebP? (not Safari: its canvas gives PNG instead) */
function canEncodeWebp(): Promise<boolean> {
  return (webp ??= new Promise((resolve) => {
    const c = document.createElement('canvas');
    c.width = c.height = 1;
    c.toBlob((b) => resolve(b?.type === 'image/webp'), 'image/webp', 0.8);
  }));
}

/** A frame (image or video), as a small WebP (or JPEG) data URL. */
async function thumbnailOf(source: CanvasImageSource, width: number, height: number): Promise<string | undefined> {
  if (!width || !height) return undefined;
  let scale = Math.min(1, THUMB_SHORT / Math.min(width, height));
  if (Math.max(width, height) * scale > THUMB_LONG) scale = THUMB_LONG / Math.max(width, height);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) return undefined;
  const type = (await canEncodeWebp()) ? 'image/webp' : 'image/jpeg';
  if (type === 'image/jpeg') {
    ctx.fillStyle = JPEG_BACKGROUND;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  let blob: Blob | null = null;
  for (const q of QUALITIES) {
    blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, type, q));
    if (!blob || blob.size <= THUMB_TARGET) break;
  }
  return blob ? dataUrl(blob) : undefined;
}

function dataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

/**
 * An image: decoded upright (EXIF orientation), its thumbnail re-encoded, so it carries no
 * metadata (place, camera). The file itself is sent as it is.
 */
async function imagePreview(blob: Blob): Promise<SendExtra> {
  if (blob.size > IMAGE_PREVIEW_MAX) return {};
  const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  try {
    return { thumb: await thumbnailOf(bitmap, bitmap.width, bitmap.height), w: bitmap.width, h: bitmap.height };
  } finally {
    bitmap.close();
  }
}

/** Resolves on `event`, rejects on an error or after `ms`. */
function once(el: HTMLMediaElement, event: string, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = (fn: () => void) => () => {
      clearTimeout(timer);
      el.removeEventListener(event, ok);
      el.removeEventListener('error', ko);
      fn();
    };
    const ok = done(resolve);
    const ko = done(() => reject(new Error('media error')));
    const timer = setTimeout(done(() => reject(new Error('timeout'))), ms);
    el.addEventListener(event, ok);
    el.addEventListener('error', ko);
  });
}

/**
 * A video: its size and length, and a frame at 1 s (or at a tenth of a shorter video: the very
 * first frame is often black). Nothing when this device cannot decode it.
 */
async function videoPreview(blob: Blob): Promise<SendExtra> {
  const url = URL.createObjectURL(blob);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  try {
    video.src = url;
    await once(video, 'loadedmetadata', VIDEO_WAIT);
    const duration = Number.isFinite(video.duration) && video.duration > 0 ? Math.round(video.duration * 10) / 10 : undefined;
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (!w || !h) return { duration };
    const at = duration ? Math.min(1, duration / 10) : 0;
    if (at > 0) {
      const seeked = once(video, 'seeked', VIDEO_WAIT);
      video.currentTime = at;
      await seeked;
    } else if (video.readyState < 2) await once(video, 'loadeddata', VIDEO_WAIT);
    return { thumb: await thumbnailOf(video, w, h).catch(() => undefined), w, h, duration };
  } catch {
    return {};
  } finally {
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
}

/** A text file: its first characters, shown under its name. */
async function textPreview(blob: Blob): Promise<SendExtra> {
  const head = new Uint8Array(await blob.slice(0, 4096).arrayBuffer());
  const excerpt = excerptOf(decodeStart(head, blob.size <= 4096));
  return excerpt ? { excerpt } : {};
}

/** The kind of item and its preview, for a file about to be sent. Never fails. */
export async function preview(blob: Blob, name: string): Promise<{ kind: 'image' | 'file'; extra: SendExtra }> {
  const kind = previewKind(name, blob.type);
  // an image (for the clipboard too), unless too big to be copied anyway
  const asImage = blob.type.startsWith('image/') && blob.size < IMAGE_PREVIEW_MAX;
  let extra: SendExtra = {};
  try {
    if (asImage) extra = await imagePreview(blob);
    else if (kind === 'video') extra = await videoPreview(blob);
    else if (isText(name, blob.type)) extra = await textPreview(blob);
  } catch {
    extra = {}; // not decodable here (a HEIC photo outside Safari…): sent without a preview
  }
  return { kind: asImage ? 'image' : 'file', extra };
}
