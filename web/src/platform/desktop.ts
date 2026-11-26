// Desktop apps: the same web code runs in the system web view, and the native side owns the
// clipboard, the secure storage and the received files. Two hosts answer the same calls:
//  - Mac: Swift + WKWebView (macos/), through window.webkit.messageHandlers.native;
//  - Linux and Windows: Tauri (desktop/), through window.__entrenous.call.
import { b64, fromJSON, toJSON, unb64 } from '../core/bytes.ts';
import type { KV } from '../core/storage.ts';
import { utf8 } from '../core/bytes.ts';
import type { FolderSink, LocalCopy, Outgoing, PlatformApi } from './types.ts';
import { folderFromNative } from '../ui/folder-send.ts';
import { t } from '../i18n/index.ts';

declare global {
  interface Window {
    webkit?: { messageHandlers: { native: { postMessage(msg: unknown): Promise<any> } } };
    __entrenous?: {
      config: { relay: string; name: string; platform?: 'linux' | 'windows'; lang?: string };
      event(name: string, payload: any): void;
      /** Linux and Windows (Tauri): the native call. */
      call?(msg: unknown): Promise<any>;
    };
  }
}

export const isDesktopApp = () =>
  !!window.__entrenous && (!!window.__entrenous.call || !!window.webkit?.messageHandlers?.native);

const call = (cmd: string, args: Record<string, unknown> = {}) => {
  const msg = { cmd, ...args };
  const tauri = window.__entrenous?.call;
  return tauri ? tauri(msg) : window.webkit!.messageHandlers.native.postMessage(msg);
};

class NativeKV implements KV {
  async get<T>(key: string) {
    const v: string | null = await call('kvGet', { key });
    return v == null ? undefined : fromJSON<T>(v);
  }
  async set(key: string, value: unknown) {
    await call('kvSet', { key, value: toJSON(value) });
  }
  async del(key: string) {
    await call('kvDel', { key });
  }
}

const FILE_PART = 512 * 1024;

/** Reads a local file offered by the native side, piece by piece. */
async function readNativeFile(token: string, size: number, mime: string): Promise<Blob> {
  const parts: BlobPart[] = [];
  for (let offset = 0; offset < size; offset += FILE_PART) {
    const data: string = await call('fileRead', { token, offset, length: FILE_PART });
    parts.push(unb64(data) as BlobPart);
  }
  return new Blob(parts, { type: mime });
}

/** Bytes of a local file offered by the native side (a file of a folder being sent). */
const readToken = async (token: string, offset: number, length: number) => unb64(await call('fileRead', { token, offset, length }));

/** A folder being saved by the native side: it asked where, and created it there. */
async function nativeFolder(name: string): Promise<FolderSink | null> {
  const r: { token: string; where: string } | null = await call('folderCreate', { name });
  if (!r) return null;
  return {
    where: r.where,
    async file(path) {
      const token: string = await call('fileCreate', { name: path.split('/').pop(), folder: r.token, path });
      return {
        write: async (data) => {
          for (let at = 0; at < data.length; at += FILE_PART) await call('fileAppend', { token, data: b64(data.subarray(at, at + FILE_PART)) });
        },
        close: async () => {
          await call('fileClose', { token });
        },
      };
    },
    async dir(path) {
      await call('folderMkdir', { folder: r.token, path });
    },
  };
}

/** A payload read by Swift from a pasteboard; `limit`: larger content is not even read. */
async function fromNative(payload: any, limit: number): Promise<LocalCopy> {
  // a folder: nothing read yet (its size decides whether it goes by itself)
  if (payload.kind === 'folder') return { kind: 'folder', folder: folderFromNative(payload, readToken) };
  if (payload.kind === 'text') {
    const size = utf8(payload.text).length;
    return size > limit ? { kind: 'toobig', name: t('name.text'), size } : { kind: 'text', text: payload.text };
  }
  if (payload.kind === 'image') {
    const data = unb64(payload.data);
    return data.length > limit
      ? { kind: 'toobig', name: payload.name, size: data.length }
      : { kind: 'image', blob: new Blob([data as BlobPart], { type: payload.mime }), name: payload.name };
  }
  if (payload.size > limit) return { kind: 'toobig', name: payload.name, size: payload.size };
  return { kind: 'file', blob: await readNativeFile(payload.token, payload.size, payload.mime), name: payload.name };
}

export function desktopPlatform(): PlatformApi {
  const config = window.__entrenous!.config;
  const listeners: Array<(o: LocalCopy) => void> = [];
  let onDrop: (o: Outgoing) => void = () => {};
  let onPause: (paused: boolean) => void = () => {};
  let onWake: () => void = () => {};
  let onPip: (active: boolean, closed: boolean) => void = () => {};
  let autoLimit = Infinity;
  const mac = !config.platform;

  // Events pushed by Swift.
  window.__entrenous!.event = async (name, payload) => {
    if (name === 'pause') return onPause(!!payload.paused);
    if (name === 'wake') return onWake();
    if (name === 'pip') return onPip(!!payload.active, !!payload.closed);
    if (name === 'drop') {
      // dropped on the menu bar icon (Mac): sent whatever the size limit or the pause
      for (const item of payload.items ?? []) onDrop((await fromNative(item, Infinity)) as Outgoing);
      return;
    }
    if (name !== 'localCopy') return;
    const out = await fromNative(payload, autoLimit);
    for (const fn of listeners) fn(out);
  };

  return {
    kind: config.platform ?? 'mac',
    native: true,
    kv: new NativeKV(),
    defaultName: config.name || 'Mac',
    systemLang: config.lang,
    defaultRelay: config.relay,
    autoWrite: true,

    autostart: {
      get: async () => !!(await call('autostartGet')),
      set: async (on) => !!(await call('autostartSet', { on })),
    },

    setLang(lang) {
      call('setLang', { lang }).catch(() => {});
    },
    setPaused(paused) {
      call('setPaused', { paused }).catch(() => {});
    },

    onPauseRequest(cb) {
      onPause = cb;
    },

    setAutoLimit(bytes) {
      autoLimit = bytes;
    },

    onWake(cb) {
      onWake = cb;
    },
    onDrop(cb) {
      onDrop = cb;
    },

    keepAwake(on) {
      call('keepAwake', { on }).catch(() => {});
    },
    notify(title, body) {
      call('notify', { title, body }).catch(() => {});
    },

    async copy(mime, content) {
      const c = await content;
      if (mime.startsWith('text/')) {
        await call('clipWrite', { kind: 'text', text: c.text ?? '' });
        return;
      }
      const blob = c.blob!;
      if (mime.startsWith('image/') && blob.size < 32 * 1024 * 1024) {
        await call('clipWrite', { kind: 'image', data: b64(new Uint8Array(await blob.arrayBuffer())), mime });
        return;
      }
      // Any other file: written to the app's temporary folder, then put in the clipboard
      // as a file (paste in the file manager, a mail, an upload form…).
      const token = await writeNativeFile(blob, c.name ?? t('name.file'), c.expiresAt);
      await call('clipWrite', { kind: 'file', token });
    },

    /** Manual send, while the clipboard is not shared automatically (paused, or turned off). */
    async read() {
      const payload = await call('clipRead');
      return payload ? ((await fromNative(payload, Infinity)) as Outgoing) : null;
    },

    async openUrl(url) {
      await call('openUrl', { url });
    },

    async save(blob, name) {
      const token = await writeNativeFile(blob, name);
      await call('fileSaveAs', { token, name });
    },

    async pickFolder() {
      const payload = await call('folderPick');
      return payload ? folderFromNative(payload, readToken) : null;
    },

    saveFolder: nativeFolder,

    onLocalCopy(cb) {
      listeners.push(cb);
    },

    // Mac: the web view's own picture-in-picture; back from it, the popover shows again
    ...(mac
      ? {
          show() {
            call('show').catch(() => {});
          },
          focus() {
            call('focus').catch(() => {});
          },
        }
      : {
          // Linux and Windows: no picture-in-picture in their web views (WebKitGTK, WebView2):
          // the window itself shrinks to the video, without its frame, above the others
          pip: {
            enter: (width: number, height: number) => call('pipEnter', { width, height }).then(() => {}),
            exit: () => call('pipExit').then(() => {}),
            onChange(cb: (active: boolean, closed: boolean) => void) {
              onPip = cb;
            },
          },
        }),
  };
}

async function writeNativeFile(blob: Blob, name: string, expiresAt?: number): Promise<string> {
  const token: string = await call('fileCreate', { name, expiresAt });
  for (let offset = 0; offset < blob.size; offset += FILE_PART) {
    const part = new Uint8Array(await blob.slice(offset, offset + FILE_PART).arrayBuffer());
    await call('fileAppend', { token, data: b64(part) });
  }
  await call('fileClose', { token });
  return token;
}
