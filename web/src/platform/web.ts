// Browser / PWA platform: async Clipboard API, IndexedDB, Web Share.
import { IndexedKV } from '../core/storage.ts';
import type { Platform } from '../core/group.ts';
import type { Outgoing, PlatformApi } from './types.ts';

const ua = navigator.userAgent;
export const isIOS = /iPad|iPhone|iPod/.test(ua) || (ua.includes('Mac') && navigator.maxTouchPoints > 1);
export const isAndroid = /Android/.test(ua);
export const isStandalone =
  matchMedia('(display-mode: standalone)').matches || (navigator as any).standalone === true;

function detectKind(): Platform {
  if (isIOS) return 'ios';
  if (isAndroid) return 'android';
  return 'desktop';
}

function defaultName(kind: Platform): string {
  if (kind === 'ios') return /iPad/.test(ua) ? 'iPad' : 'iPhone';
  if (kind === 'android') return 'Android';
  if (/Windows/.test(ua)) return 'PC Windows';
  if (/Linux/.test(ua)) return 'PC Linux';
  return 'Navigateur';
}

/** The async clipboard only accepts PNG images. */
async function toPng(blob: Blob): Promise<Blob> {
  if (blob.type === 'image/png') return blob;
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('png'))), 'image/png'));
}

/**
 * Screen Wake Lock during a transfer: a phone that turns its screen off freezes the page.
 * The lock is dropped when the page is hidden; taken again when it comes back.
 */
let wakeLock: any = null;
let wantAwake = false;
async function acquireWakeLock() {
  const wl = (navigator as any).wakeLock;
  if (!wl || !wantAwake || wakeLock || document.visibilityState !== 'visible') return;
  try {
    wakeLock = await wl.request('screen');
    wakeLock.addEventListener('release', () => (wakeLock = null));
    if (!wantAwake) releaseWakeLock(); // stopped meanwhile
  } catch {
    /* refused (battery saver…): the transfer resumes after a sleep anyway */
  }
}
function releaseWakeLock() {
  wakeLock?.release().catch(() => {});
  wakeLock = null;
}
if (typeof document !== 'undefined') document.addEventListener('visibilitychange', acquireWakeLock);

export function webPlatform(): PlatformApi {
  const kind = detectKind();
  return {
    kind,
    native: false,
    kv: new IndexedKV(),
    defaultName: defaultName(kind),
    defaultRelay: location.origin,
    autoWrite: !isIOS,
    keepAwake(on) {
      wantAwake = on;
      if (on) acquireWakeLock();
      else releaseWakeLock();
    },

    async copy(mime, content) {
      const isText = mime.startsWith('text/');
      const targetMime = isText ? 'text/plain' : 'image/png';
      const blob = content.then(async (c) => {
        if (isText) return new Blob([c.text ?? ''], { type: 'text/plain' });
        return toPng(c.blob!);
      });
      try {
        await navigator.clipboard.write([new ClipboardItem({ [targetMime]: blob })]);
      } catch (err) {
        await content; // a failed download is the real cause: report it, not the clipboard's error
        // Older engines: no promise in ClipboardItem.
        if (!isText) throw err;
        await navigator.clipboard.writeText((await content).text ?? '');
      }
    },

    async read(): Promise<Outgoing | null> {
      if (navigator.clipboard.read) {
        try {
          const items = await navigator.clipboard.read();
          for (const item of items) {
            const image = item.types.find((t) => t.startsWith('image/'));
            if (image) {
              const blob = await item.getType(image);
              return { kind: 'image', blob, name: 'image.' + (image.split('/')[1] || 'png') };
            }
            if (item.types.includes('text/plain')) {
              const text = await (await item.getType('text/plain')).text();
              return text ? { kind: 'text', text } : null;
            }
          }
          return null;
        } catch {
          /* fall back to text */
        }
      }
      const text = await navigator.clipboard.readText();
      return text ? { kind: 'text', text } : null;
    },

    async save(blob, name) {
      const file = new File([blob], name, { type: blob.type });
      if ((isIOS || isAndroid) && navigator.canShare?.({ files: [file] })) {
        try {
          await navigator.share({ files: [file] });
          return;
        } catch (err: any) {
          if (err?.name === 'AbortError') return;
        }
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    },
  };
}
