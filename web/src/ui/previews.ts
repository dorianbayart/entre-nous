// Previews made on the sending side, before the upload: they travel encrypted in the item's
// header, so the history shows them at once, without downloading anything. The sender is
// also the device most likely to decode its own files (an iPhone's HEIC photo, say).
//  - image: its preview (the thumbnail in the history, the image the viewer shows: the file
//    itself is downloaded only to be copied or saved), its size in pixels;
//  - video: a frame (poster), its size in pixels and its length;
//  - audio: its length;
//  - PDF: its first page, its number of pages;
//  - text file: its first characters.
import type { SendExtra } from '../core/engine.ts';
import { decodeStart, excerptOf, isText, previewKind } from '../core/media.ts';
import { encodeJpeg } from './jpeg.ts';
import { blobReader, drawPage, openPdf } from './pdf.ts';

/**
 * Previews of images and videos: the history shows them as thumbnails, the viewer shows them
 * as they are, before anything is downloaded. No side above 720 px; a progressive JPEG.
 */
const PREVIEW_SIDE = 720;
const PREVIEW_QUALITY = 85;
/** The first page of a PDF: a thumbnail in the history only. */
const PDF_THUMB_WIDTH = 384;
/** A preview travels in the item's header: above this (an image like noise), lower qualities. */
const PREVIEW_MAX_BYTES = 160 * 1024;
const LOWER_QUALITIES = [70, 55, 40];
/** Larger images are not decoded for a preview (memory). */
export const IMAGE_PREVIEW_MAX = 50 * 1024 * 1024;
/** Under a transparent image (JPEG has no transparency): the app's background. */
const JPEG_BACKGROUND = '#f6f5f2';
/** A video that takes longer than this to give its first frame is sent without one. */
const VIDEO_WAIT = 8000;

/**
 * A frame (image, video, page) as a progressive JPEG data URL, `side` px at most. `vector`: an
 * SVG, drawn at that size whatever its own (it stays sharp).
 */
function thumbnailOf(source: CanvasImageSource, width: number, height: number, side = PREVIEW_SIDE, vector = false): string | undefined {
  if (!width || !height) return undefined;
  const scale = vector ? side / Math.max(width, height) : Math.min(1, side / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return undefined;
  ctx.fillStyle = JPEG_BACKGROUND;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let jpeg = encodeJpeg(data, canvas.width, canvas.height, PREVIEW_QUALITY);
  for (const q of LOWER_QUALITIES) {
    if (jpeg.length <= PREVIEW_MAX_BYTES) break;
    jpeg = encodeJpeg(data, canvas.width, canvas.height, q);
  }
  let bin = '';
  for (let i = 0; i < jpeg.length; i += 0x8000) bin += String.fromCharCode(...jpeg.subarray(i, i + 0x8000));
  return 'data:image/jpeg;base64,' + btoa(bin);
}

const UNITS: Record<string, number> = { '': 1, px: 1, pt: 4 / 3, pc: 16, in: 96, cm: 96 / 2.54, mm: 96 / 25.4 };

/** A length of an SVG in pixels; 0 when it has none (a percentage, nothing). */
function svgLength(value: string | null): number {
  const m = /^\s*([\d.]+(?:e[+-]?\d+)?)\s*(px|pt|pc|in|cm|mm)?\s*$/i.exec(value ?? '');
  return m ? Number(m[1]) * UNITS[(m[2] ?? '').toLowerCase()] : 0;
}

/**
 * An SVG's size, from its width and height, or else its viewBox (browsers give an SVG with only
 * a viewBox a made-up size, 150 px). Null when it has none.
 */
async function svgSize(blob: Blob): Promise<{ w: number; h: number } | null> {
  const root = new DOMParser().parseFromString(await blob.text(), 'image/svg+xml').documentElement;
  let w = svgLength(root.getAttribute('width'));
  let h = svgLength(root.getAttribute('height'));
  const box = (root.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number);
  const ratio = box.length === 4 && box[2] > 0 && box[3] > 0 ? box[2] / box[3] : 0;
  if (ratio && !w && !h) [w, h] = [box[2], box[3]];
  else if (ratio && !h) h = w / ratio;
  else if (ratio && !w) w = h * ratio;
  return w > 0 && h > 0 ? { w, h } : null;
}

/**
 * An image, decoded upright (EXIF orientation): by createImageBitmap, or else by an <img> (an
 * SVG; a HEIC or a TIFF in Safari). SVGs are shown in an <img>: none of their scripts run.
 */
async function decodeImage(blob: Blob, svg: boolean): Promise<{ source: CanvasImageSource; w: number; h: number; close: () => void }> {
  if (!svg) {
    try {
      const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
      return { source: bitmap, w: bitmap.width, h: bitmap.height, close: () => bitmap.close() };
    } catch {
      // below, by an <img>
    }
  }
  const url = URL.createObjectURL(svg && blob.type !== 'image/svg+xml' ? new Blob([blob], { type: 'image/svg+xml' }) : blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const own = svg ? await svgSize(blob).catch(() => null) : null;
    const w = own?.w ?? img.naturalWidth;
    const h = own?.h ?? img.naturalHeight;
    if (!w || !h) throw new Error('image size');
    return { source: img, w, h, close: () => URL.revokeObjectURL(url) };
  } catch (err) {
    URL.revokeObjectURL(url);
    throw err;
  }
}

/**
 * An image: its preview (re-encoded: it carries no metadata, no place, no camera) and its size
 * in pixels. The file itself is sent as it is.
 */
async function imagePreview(blob: Blob, name: string): Promise<SendExtra> {
  if (blob.size > IMAGE_PREVIEW_MAX) return {};
  const svg = blob.type === 'image/svg+xml' || /\.svgz?$/i.test(name);
  const image = await decodeImage(blob, svg);
  try {
    return { thumb: thumbnailOf(image.source, image.w, image.h, PREVIEW_SIDE, svg), w: Math.round(image.w), h: Math.round(image.h) };
  } finally {
    image.close();
  }
}

/** A frame's preview, or none when it cannot be read (a canvas made unreadable…). */
function tryThumbnail(source: CanvasImageSource, width: number, height: number, side = PREVIEW_SIDE): string | undefined {
  try {
    return thumbnailOf(source, width, height, side);
  } catch {
    return undefined;
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
    return { thumb: tryThumbnail(video, w, h), w, h, duration };
  } catch {
    return {};
  } finally {
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
}

/** An audio file: its length. Nothing when this device cannot decode it. */
async function audioPreview(blob: Blob): Promise<SendExtra> {
  const url = URL.createObjectURL(blob);
  const audio = document.createElement('audio');
  audio.preload = 'metadata';
  try {
    audio.src = url;
    await once(audio, 'loadedmetadata', VIDEO_WAIT);
    const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? Math.round(audio.duration * 10) / 10 : undefined;
    return duration ? { duration } : {};
  } catch {
    return {};
  } finally {
    audio.removeAttribute('src');
    audio.load();
    URL.revokeObjectURL(url);
  }
}

/** A PDF: its first page as a thumbnail, its number of pages. Nothing past VIDEO_WAIT. */
async function pdfPreview(blob: Blob): Promise<SendExtra> {
  const { doc, close } = await openPdf(blobReader(blob));
  try {
    const canvas = document.createElement('canvas');
    // about PDF_THUMB_WIDTH pixels wide, whatever the screen's density
    const drawn = drawPage(doc, 1, canvas, PDF_THUMB_WIDTH / Math.min(window.devicePixelRatio || 1, 3));
    await Promise.race([drawn, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), VIDEO_WAIT))]);
    const thumb = tryThumbnail(canvas, canvas.width, canvas.height, PDF_THUMB_WIDTH);
    return { thumb, pages: doc.numPages };
  } finally {
    close();
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
    if (kind === 'image') extra = await imagePreview(blob, name);
    else if (kind === 'video') extra = await videoPreview(blob);
    else if (kind === 'audio') extra = await audioPreview(blob);
    else if (kind === 'pdf') extra = await pdfPreview(blob);
    else if (isText(name, blob.type)) extra = await textPreview(blob);
  } catch {
    extra = {}; // not decodable here (a HEIC photo outside Safari…): sent without a preview
  }
  return { kind: asImage ? 'image' : 'file', extra };
}
