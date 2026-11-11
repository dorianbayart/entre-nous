// Desktop apps: the same web code runs in the system web view, and the native side owns the
// clipboard, the secure storage and the received files. Two hosts answer the same calls:
//  - Mac: Swift + WKWebView (macos/), through window.webkit.messageHandlers.native;
//  - Linux and Windows: Tauri (desktop/), through window.__entrenous.call.
import { b64, fromJSON, toJSON, unb64 } from '../core/bytes.ts';
import type { KV } from '../core/storage.ts';
import { utf8 } from '../core/bytes.ts';
import type { LocalCopy, Outgoing, PlatformApi } from './types.ts';

declare global {
  interface Window {
    webkit?: { messageHandlers: { native: { postMessage(msg: unknown): Promise<any> } } };
    __entrenous?: {
      config: { relay: string; name: string; platform?: 'linux' | 'windows' };
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

/** A payload read by Swift from a pasteboard; `limit`: larger content is not even read. */
async function fromNative(payload: any, limit: number): Promise<LocalCopy> {
  if (payload.kind === 'text') {
    const size = utf8(payload.text).length;
    return size > limit ? { kind: 'toobig', name: 'texte', size } : { kind: 'text', text: payload.text };
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
  let autoLimit = Infinity;

  // Events pushed by Swift.
  window.__entrenous!.event = async (name, payload) => {
    if (name === 'pause') return onPause(!!payload.paused);
    if (name === 'wake') return onWake();
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
    defaultRelay: config.relay,
    autoWrite: true,

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
      const token = await writeNativeFile(blob, c.name ?? 'fichier', c.expiresAt);
      await call('clipWrite', { kind: 'file', token });
    },

    async read() {
      return null; // desktop apps share their clipboard automatically (onLocalCopy)
    },

    async save(blob, name) {
      const token = await writeNativeFile(blob, name);
      await call('fileSaveAs', { token, name });
    },

    onLocalCopy(cb) {
      listeners.push(cb);
    },
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
