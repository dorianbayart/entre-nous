// Android app (Capacitor): the same web code, bundled in the app; the native plugin
// (EntreNousPlugin.java) owns the Keystore-encrypted storage, the clipboard and the files.
import { Capacitor, registerPlugin } from '@capacitor/core';
import { b64, fromJSON, toJSON, unb64 } from '../core/bytes.ts';
import type { KV } from '../core/storage.ts';
import type { MediaAction, Outgoing, PlatformApi } from './types.ts';
import { folderFromNative } from '../ui/folder-send.ts';
import { t } from '../i18n/index.ts';

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
    imageCopyMax: IMAGE_MAX,

    async init() {
      const { model, pip } = await Native.info().catch(() => ({ model: '', pip: false }));
      if (model) p.defaultName = model;
      if (!pip) delete p.pip; // before Android 8, or turned off by the maker
    },

    async copy(mime, content) {
      const c = await content;
      if (mime.startsWith('text/')) {
        await Native.clipWrite({ kind: 'text', text: c.text ?? '' });
        return;
      }
      const blob = c.blob!;
      if (!mime.startsWith('image/') || blob.size > IMAGE_MAX) throw new Error(t('err.useSave'));
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

    async openUrl(url) {
      await Native.openUrl({ url });
    },

    async save(blob, name) {
      const { token } = await Native.fileCreate({ name });
      for (let offset = 0; offset < blob.size; offset += FILE_PART) {
        const part = new Uint8Array(await blob.slice(offset, offset + FILE_PART).arrayBuffer());
        await Native.fileAppend({ token, data: b64(part) });
      }
      await Native.fileShare({ token, mime: blob.type || 'application/octet-stream' });
    },

    // a folder: picked with Android's folder picker, its files read through the plugin
    async pickFolder() {
      const r = await Native.folderPick();
      if (!r?.name) return null;
      return folderFromNative(r, async (token, offset, length) => unb64((await Native.fileRead({ token, offset, length })).data));
    },

    // saved where the user picks (Android's folder picker), recreated as it is
    async saveFolder(name) {
      const r = await Native.folderCreate({ name });
      if (!r?.token) return null;
      return {
        where: r.where,
        async file(path) {
          const { token } = await Native.fileCreate({ name: path.split('/').pop(), folder: r.token, path });
          return {
            write: async (data: Uint8Array) => {
              for (let at = 0; at < data.length; at += FILE_PART) await Native.fileAppend({ token, data: b64(data.subarray(at, at + FILE_PART)) });
            },
            close: async () => {
              await Native.fileClose({ token });
            },
          };
        },
        async dir(path) {
          await Native.folderMkdir({ folder: r.token, path });
        },
      };
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

    // The WebView has no picture-in-picture: the whole app becomes the small window (its page
    // then shows only the video), with a play/pause button; leaving the app while a video
    // plays opens it too.
    pip: {
      enter: (width, height) => Native.pipEnter({ width, height }).then(() => {}),
      exit: () => Native.pipExit().then(() => {}),
      onChange(cb) {
        Native.addListener('pip', (e: { active: boolean; closed: boolean }) => cb(!!e.active, !!e.closed));
      },
      playing(on, width, height) {
        Native.pipPlaying({ on, width: Math.round(width), height: Math.round(height) }).catch(() => {});
      },
      onToggle(cb) {
        Native.addListener('pipToggle', () => cb());
      },
    },

    // The WebView tells the system nothing: the app's own media session gives the song's name
    // to a Bluetooth headset or car, the lock screen and the notification, and their buttons
    // back to the page; it keeps the app alive while a song plays in the background.
    media: {
      set(m) {
        Native.mediaSet({ ...m, duration: Math.round(m.duration * 1000), position: Math.round(m.position * 1000) }).catch(() => {});
      },
      clear() {
        Native.mediaClear().catch(() => {});
      },
      onAction(cb) {
        Native.addListener('media', (e: { action: MediaAction; position?: number }) =>
          cb(e.action, e.position === undefined ? undefined : e.position / 1000),
        );
      },
    },
  };
  return p;
}
