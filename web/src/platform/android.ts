// Android app (Capacitor): the same web code, bundled in the app; the native plugin
// (EntreNousPlugin.java) owns the Keystore-encrypted storage, the clipboard and the files.
import { Capacitor, registerPlugin } from '@capacitor/core';
import { b64, fromJSON, toJSON, unb64 } from '../core/bytes.ts';
import type { KV } from '../core/storage.ts';
import type { Outgoing, PlatformApi } from './types.ts';

const Native = registerPlugin<any>('EntreNous');

export const isAndroidApp = () => Capacitor.getPlatform() === 'android';

const RELAY = 'https://entrenous.0xdba.dev';
const FILE_PART = 512 * 1024;
const IMAGE_MAX = 32 * 1024 * 1024;

class KeystoreKV implements KV {
  async get<T>(key: string) {
    const { value } = await Native.kvGet({ key });
    return value == null ? undefined : fromJSON<T>(value);
  }
  async set(key: string, value: unknown) {
    await Native.kvSet({ key, value: toJSON(value) });
  }
  async del(key: string) {
    await Native.kvDel({ key });
  }
}

async function readShared(f: { token: string; name: string; mime: string; size: number }): Promise<Outgoing> {
  const parts: BlobPart[] = [];
  for (let offset = 0; offset < f.size; offset += FILE_PART) {
    const { data } = await Native.fileRead({ token: f.token, offset, length: FILE_PART });
    parts.push(unb64(data) as BlobPart);
  }
  await Native.fileDelete({ token: f.token });
  const blob = new Blob(parts, { type: f.mime });
  return { kind: f.mime.startsWith('image/') ? 'image' : 'file', blob, name: f.name };
}

export function androidPlatform(): PlatformApi {
  const p: PlatformApi = {
    kind: 'android',
    native: true,
    kv: new KeystoreKV(),
    defaultName: 'Android',
    defaultRelay: RELAY,
    autoWrite: true,

    async init() {
      const { model } = await Native.info().catch(() => ({ model: '' }));
      if (model) p.defaultName = model;
    },

    async copy(mime, content) {
      const c = await content;
      if (mime.startsWith('text/')) {
        await Native.clipWrite({ kind: 'text', text: c.text ?? '' });
        return;
      }
      const blob = c.blob!;
      if (!mime.startsWith('image/') || blob.size > IMAGE_MAX) throw new Error('utilise « Enregistrer »');
      await Native.clipWrite({ kind: 'image', data: b64(new Uint8Array(await blob.arrayBuffer())), mime });
    },

    async read() {
      const r = await Native.clipRead();
      if (r.kind === 'text') return { kind: 'text', text: r.text };
      if (r.kind === 'image') {
        const blob = new Blob([unb64(r.data) as BlobPart], { type: r.mime });
        return { kind: 'image', blob, name: 'image.' + (r.mime.split('/')[1] || 'png') };
      }
      return null;
    },

    async save(blob, name) {
      const { token } = await Native.fileCreate({ name });
      for (let offset = 0; offset < blob.size; offset += FILE_PART) {
        const part = new Uint8Array(await blob.slice(offset, offset + FILE_PART).arrayBuffer());
        await Native.fileAppend({ token, data: b64(part) });
      }
      await Native.fileShare({ token, mime: blob.type || 'application/octet-stream' });
    },

    onShare(cb) {
      Native.addListener('share', async (e: { text: string; files: any[] }) => {
        if (e.text) cb({ kind: 'text', text: e.text });
        for (const f of e.files ?? []) cb(await readShared(f));
      });
    },

    onLink(cb) {
      Native.addListener('link', (e: { url: string }) => cb(e.url));
    },

    onAppState(cb) {
      Native.addListener('appState', (e: { active: boolean }) => cb(e.active));
    },

    onBack(cb) {
      Native.addListener('back', () => cb());
    },

    background() {
      Native.background().catch(() => {});
    },
    keepAwake(on) {
      Native.keepAwake({ on }).catch(() => {});
    },
  };
  return p;
}
