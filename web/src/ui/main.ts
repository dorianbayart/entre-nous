// UI of Entre Nous (PWA and Mac app), with the CSP build of Alpine.js: no eval, so the
// page runs under a strict Content Security Policy.
import Alpine from '@alpinejs/csp';
import qrcode from 'qrcode-generator';
import jsQR from 'jsqr';
import { Engine, ItemGoneError, SendCancelledError, UPLOAD_STALLED, type ChangelogEntry, type DropView, type ItemView, type Invite, type ShareView } from '../core/engine.ts';
import { SHARE_DEFAULT_TTL, SHARE_TTLS, ShareGoneError } from '../core/share.ts';
import { DROP_MESSAGE_MAX, DROP_TTLS, DropGoneError } from '../core/drop.ts';
import { hash } from '../core/crypto.ts';
import { b64, utf8 } from '../core/bytes.ts';
import { desktopPlatform, isDesktopApp } from '../platform/desktop.ts';
import { androidPlatform, isAndroidApp } from '../platform/android.ts';
import { isIOS, isStandalone, webPlatform } from '../platform/web.ts';
import { webrtcAvailable, webrtcLinks } from '../core/webrtc.ts';
import { preview } from './previews.ts';
import { NotStreamable, stream } from './player.ts';
import { renderMarkdown } from './markdown.ts';
import { drawLayers, drawPage, openPdf, pageSize, type PdfDocument } from './pdf.ts';
import { TEXT_PREVIEW_MAX, audioMime, decodeStart, previewKind, type PreviewKind } from '../core/media.ts';
import { SEARCH_TYPES, highlight, isType, matches, snippet, type Part, type SearchType } from '../core/search.ts';
import type { FolderSource, LocalCopy, Outgoing, PlatformApi } from '../platform/types.ts';
import { type ContentReader } from '../core/reader.ts';
import { type FolderFile, type FolderIndex, baseName, emptyDirs, fileReader, readBlob, readIndex, safePath } from '../core/folder.ts';
import { FolderBrowser } from './folder-view.ts';
import { droppedEntries, folderFromInput, needsConfirm, prepareFolder } from './folder-send.ts';
import { chooseTarget, writeFolder } from './folder-save.ts';
import { CHUNK_SIZE } from '../core/crypto.ts';
import { LANGS, duration, humanSize, storageSpace, lang as currentLang, pick, setLang, systemLangs, t as translate, tn as translateN, type Key, type Lang } from '../i18n/index.ts';

const platform: PlatformApi = isDesktopApp() ? desktopPlatform() : isAndroidApp() ? androidPlatform() : webPlatform();

const TTL_CHOICES = [600, 3600, 86400, 7 * 86400]; // labels: ttl.<seconds>
const MAX_ITEMS_CHOICES = [1, 10, 0]; // labels: maxItems.<n>
const MB = 1024 * 1024;
const AUTO_MAX_CHOICES = [MB, 10 * MB, 100 * MB];
/** The language of the system: the desktop apps say it, their web view may not. */
const systemLang = () => pick(platform.systemLang ? [platform.systemLang] : systemLangs());
const MAILBOX_AGE = 60_000; // an item received while closed is copied at opening if younger

interface Prefs {
  autoShare: boolean;
  paused: boolean;
  confirmDelete: boolean;
  notify: boolean; // desktop apps: notification on reception
  groupId: string | null;
  lang?: Lang; // chosen by the user; none: the system's
  relay?: string; // native apps: server of new groups, when not the default one
  updateSeen?: string; // new version whose banner was closed
  newsSeen?: string; // version whose "What's new" was seen (none: first run, nothing to show)
  updateNotified?: string; // new version already announced by a system notification
}

/** The apps are published on GitHub: the latest release, and each platform's file in it. */
const RELEASE = 'https://github.com/dorianbayart/entre-nous/releases/latest';
const RELEASE_FILE: Partial<Record<string, string>> = {
  mac: 'Entre-Nous-mac.zip',
  android: 'Entre-Nous-android.apk',
  windows: 'Entre-Nous-windows.exe',
};

/** Is version `a` (0.1.42) newer than `b`? */
function newer(a: string, b: string) {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  }
  return false;
}

/** Can a relay be reached? A WebSocket is not subject to CORS, unlike fetch from the apps. */
function reachable(relay: string): Promise<boolean> {
  return new Promise((resolve) => {
    let ws: WebSocket;
    const done = (ok: boolean) => {
      clearTimeout(timer);
      try {
        ws.close();
      } catch {}
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), 8000);
    try {
      ws = new WebSocket(relay.replace(/^http/, 'ws') + '/ws');
      ws.onopen = () => done(true);
      ws.onerror = () => done(false);
    } catch {
      done(false);
    }
  });
}

const NOTE_MAX = 60_000; // characters
const NOTE_TYPING = 1500; // ms: a remote change does not overwrite what is being typed

// The invitation link may arrive in the URL fragment: read it, then erase it at once.
const pendingInvite = location.hash.includes('p=') ? location.href : null;
if (pendingInvite) history.replaceState(null, '', location.pathname);

let engine: Engine;
let invite: Invite | null = null;
let scanStream: MediaStream | null = null;
let installPrompt: any = null;
/** iPhone, in Safari: the invitation waits while the install screen is shown, for "Use in Safari". */
let installInvite: string | null = null;
let lastShared = '';
let loadingNewsFor = ''; // the new version whose changelog was asked to the relay
let noteTypedAt = 0;
const copiedIds = new Set<string>(); // items already written to the clipboard here
let noteRetry: ReturnType<typeof setTimeout> | undefined;
let awake = false; // screen (phone) or system (Mac) kept awake during a transfer
let confirmTimer: ReturnType<typeof setTimeout> | undefined;
let dragDepth = 0; // dragenter/dragleave also fire on the page's children
/** A confirmation not given within that time is dropped. */
const CONFIRM_FOR = 4000;
/** An upload that has received nothing for that long shows as paused. */
const STALLED_AFTER = 30_000;

const fingerprint = (o: Outgoing) =>
  o.kind === 'text'
    ? b64(hash(utf8(o.text)))
    : o.kind === 'folder'
      ? `folder:${o.folder.name}:${o.folder.files.length}:${o.folder.bytes}`
      : `${o.kind}:${o.name}:${o.blob.size}:${o.blob.type}`;

/** A file of a shared folder, shown in the viewer like an item: `folder` is its folder's item. */
type FileView = ItemView & { folder?: string; path?: string };

/** The folder open in its browser (over the history). */
let folderOpen: { groupId: string; item: ItemView; reader?: ContentReader; index: FolderIndex; browser?: FolderBrowser; thumbs: Map<string, string> } | undefined;

/** The open folder's reader (its previews): opened again after the app came back to the front. */
function folderReader(open: NonNullable<typeof folderOpen>): ContentReader {
  return (open.reader ??= engine.reader(open.groupId, open.item.id, { keep: 6, ahead: 1 }));
}
/** A folder waiting for a confirmation before it is sent (large, or copied). */
let pendingFolder: FolderSource | undefined;
let prepareSeq = 0;

/** Chunks to read for these files of a folder (each counted once). */
function chunksOf(files: FolderFile[]) {
  const seen = new Set<number>();
  for (const f of files) {
    if (!f.size) continue;
    for (let i = Math.floor(f.offset / CHUNK_SIZE); i <= Math.floor((f.offset + f.size - 1) / CHUNK_SIZE); i++) seen.add(i);
  }
  return seen.size;
}

/** What the open preview holds outside Alpine: stopped and released when it closes. */
let viewerSeq = 0; // each opening; an older one still loading gives up
let stopMedia: (() => void) | undefined;
let viewerUrl = ''; // object URL of an image or of a whole video
let textShown = ''; // the text of a text preview, for "Copy the text"
let swipeX: number | null = null;
/** An open PDF: its document, what closes it, what draws its pages as they show. */
let pdf: { doc: PdfDocument; close: () => void; observer?: IntersectionObserver; drawing: Promise<void>; onSelect?: () => void } | undefined;
const PDF_ZOOMS = [1, 1.5, 2, 3];
/** Lines of a text preview drawn at most (a megabyte of short lines would be heavy). */
const TEXT_LINES_MAX = 20_000;

/** A text with its line numbers: two cells per line, built as text nodes (never as HTML). */
function drawLines(el: HTMLElement, text: string) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  const frag = document.createDocumentFragment();
  lines.slice(0, TEXT_LINES_MAX).forEach((line, i) => {
    const n = document.createElement('span');
    n.className = 'ln';
    n.textContent = String(i + 1);
    const tx = document.createElement('span');
    tx.className = 'tx';
    tx.textContent = line || ' ';
    frag.append(n, tx);
  });
  el.replaceChildren(frag);
  return lines.length > TEXT_LINES_MAX;
}

/** 0:42, 12:05, 1:02:03 */
function clock(seconds: number) {
  const s = Math.round(seconds);
  const hms = [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60];
  const [h, m, sec] = hms;
  return (h ? `${h}:${String(m).padStart(2, '0')}` : String(m)) + ':' + String(sec).padStart(2, '0');
}

/** Toast text of a failed copy or save: a deleted item says so plainly. */
const failure = (key: Key, err: any) => (err instanceof ItemGoneError ? err.message : translate(key, { msg: err?.message ?? err }));

/** The nodes of a text with **bold**, [[glyph]] and line breaks (never parsed as HTML). */
function richNodes(text: string): Node[] {
  return text.split(/(\*\*.+?\*\*|\[\[.+?\]\]|\n)/).filter(Boolean).map((part) => {
    if (part === '\n') return document.createElement('br');
    const bold = /^\*\*(.+)\*\*$/.exec(part);
    const glyph = /^\[\[(.+)\]\]$/.exec(part);
    if (!bold && !glyph) return document.createTextNode(part);
    const el = document.createElement(bold ? 'strong' : 'span');
    if (glyph) el.className = 'glyph';
    el.textContent = (bold ?? glyph)![1];
    return el;
  });
}

// x-rich="t('…')": a translated text with a little markup (x-html is not in the CSP build).
Alpine.directive('rich', (el, { expression }, { effect, evaluateLater }) => {
  const get = evaluateLater(expression);
  effect(() => get((text) => el.replaceChildren(...richNodes(String(text ?? '')))));
});

Alpine.data('app', () => ({
  view: 'loading' as string,
  platform: platform.kind,
  native: platform.native, // bundled app (Mac, Android): the code does not come from the relay
  mac: platform.kind === 'mac',
  desktop: !!platform.onLocalCopy, // desktop app (Mac, Linux, Windows): watches the clipboard
  mobile: platform.kind === 'ios' || platform.kind === 'android',
  ios: isIOS,
  standalone: isStandalone,
  device: { id: '', name: '' },
  groups: [] as ReturnType<Engine['groupView']>[],
  groupId: null as string | null,
  /** Uploads from here (and contents served directly to another device). */
  sending: [] as any[],
  /** Downloads in progress, by item. */
  downloads: {} as Record<string, { done: number; total: number; rate?: number }>,
  version: __VERSION__,
  canAutostart: !!platform.autostart,
  autostart: false,
  latest: null as string | null,
  prefs: {
    autoShare: true,
    paused: false,
    confirmDelete: true,
    notify: true,
    groupId: null,
  } as Prefs,
  noteMax: NOTE_MAX,
  /** After an update: what the versions since the last one used here brought (shown once). */
  whatsNew: [] as ChangelogEntry[],
  /** Before an update: what it brings, from the relay (the banner's "What's new"). */
  updateNews: [] as ChangelogEntry[],
  updateNewsOpen: false,
  noteEmpty: true,
  /** The note or the clipboard is being sent: a second tap must not send it again. */
  textSending: false,
  toastText: '',
  toastTimer: undefined as ReturnType<typeof setTimeout> | undefined,
  busy: false,
  confirming: '' as string,
  /** The item whose receipts are shown (detail by device). */
  receiptsOpen: '',
  /** Search in the history (on this device only): the query, the type chosen, and on a computer
   *  the result chosen with the arrow keys (Enter copies it). */
  search: { open: false, q: '', type: '' as SearchType | '', sel: '' },
  inviteQr: '',
  inviteUrl: '',
  inviteLeft: '',
  // the share link shown (its page: QR code, lifetime)
  share: null as ShareView | null,
  shareName: '',
  shareQr: '',
  // the file request shown (its page: message, QR code, lifetime)
  drop: null as DropView | null,
  dropQr: '',
  dropMessageMax: DROP_MESSAGE_MAX,
  /** Coming back from a page that slid in: the main view slides back. */
  slide: '',
  joinLink: '',
  newGroupName: '',
  scanError: '',
  canInstall: false,
  now: Date.now(),
  dragging: false,
  relayInput: platform.defaultRelay,
  /** The preview of an item, over the history (`open`). */
  viewer: {
    open: false,
    id: '',
    kind: '' as PreviewKind | '',
    loading: false,
    error: '',
    src: '', // image: its object URL
    note: '', // text: only its start is shown
    source: false, // Markdown shown as plain text
    wrap: true,
    canPip: false,
    pages: 0, // PDF: its pages, the one in view, the zoom (1: the width of the screen)
    page: 1,
    zoom: 1,
    selection: '', // PDF: the text selected in it
  },
  /** Picture-in-picture by the app itself (Android, Linux, Windows): only the video shows. */
  pipMode: false,
  /** The browser of a shared folder (over the history), and its viewer's files. */
  folderView: { open: false, id: '', loading: false, error: '' },
  viewerFiles: [] as FileView[],
  /** A folder shown before it is sent (large, or copied): what it holds. */
  folderAsk: null as null | { name: string; files: number; dirs: number; bytes: number; ignored: number; copied: boolean },
  /** Folders being prepared here (their previews), before their upload. */
  preparing: [] as Array<{ id: string; name: string; done: number; total: number }>,
  /** Phones: the File button's small menu (files, or a folder). */
  fileMenu: false,
  canPickFolder: !!platform.pickFolder || (!isIOS && !(platform.kind === 'android') && 'webkitdirectory' in document.createElement('input')),
  /** Language of the interface: read by t(), so that the texts follow a change. */
  lang: currentLang() as Lang,
  langNames: { fr: 'Français', en: 'English' } as Record<Lang, string>,
  langs: LANGS,

  async init() {
    await platform.init?.();
    this.prefs = { ...this.prefs, ...((await platform.kv.get<Prefs>('prefs')) ?? {}) };
    this.applyLang();
    // the web app always uses the server that serves it (its policy allows no other)
    if (platform.native && this.prefs.relay) this.relayInput = this.prefs.relay;
    engine = await Engine.load({
      kv: platform.kv,
      platform: platform.kind,
      defaultName: platform.defaultName,
      defaultRelay: (platform.native && this.prefs.relay) || platform.defaultRelay,
      // direct transfers on the same network, when WebRTC is there
      links: webrtcAvailable() ? webrtcLinks() : undefined,
    });
    // the web app: links to where it is served from (the relay may know itself by another name)
    if (!platform.native) engine.linkOrigin = location.origin;
    engine.on((e) => {
      if (e.type === 'change') this.refresh();
      else if (e.type === 'incoming') {
        this.onIncoming(e.groupId, e.item);
        this.notifyIncoming(e.item);
      } else if (e.type === 'synced') this.onSynced(e.groupId);
      else if (e.type === 'removed') this.toast(this.t('toast.removedHere', { group: e.groupName }));
      else if (e.type === 'error') this.toast(e.message);
    });
    platform.autostart?.get().then((on) => (this.autostart = on), () => {});
    platform.onLocalCopy?.((o) => this.onLocalCopy(o));
    platform.onDrop?.((o) => this.send(o));
    platform.setPaused?.(this.prefs.paused);
    platform.onPauseRequest?.((paused) => this.setPaused(paused));
    // after a sleep or a network change, connections may be dead: check them now
    platform.onWake?.(() => engine.reconnect());
    window.addEventListener('online', () => engine.reconnect());
    window.addEventListener('offline', () => engine.reconnect());
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      installPrompt = e;
      this.canInstall = true;
    });
    document.addEventListener('paste', (e) => this.onPaste(e as ClipboardEvent));
    document.addEventListener('keydown', (e) => this.onKey(e));
    // the app's own picture-in-picture (Android, Linux, Windows)
    platform.pip?.onChange((active, closed) => {
      this.pipMode = active;
      document.documentElement.classList.toggle('pip', active);
      // the small window dismissed: the video stops, its connection too
      if (closed) this.closeViewer();
    });
    platform.pip?.onToggle?.(() => {
      const v = this.videoEl();
      if (v) v.paused ? v.play().catch(() => {}) : v.pause();
    });
    // An invitation link opened while the app is already loaded only changes the fragment.
    window.addEventListener('hashchange', () => {
      if (!location.hash.includes('p=')) return;
      const link = location.href;
      history.replaceState(null, '', location.pathname);
      if (isIOS && !isStandalone) {
        installInvite = link;
        this.view = 'install';
      } else this.join(link);
    });
    setInterval(() => (this.now = Date.now()), 15_000);

    // Background = disconnected (mobile). The Mac app and desktop browsers stay connected.
    const mobile = platform.kind === 'ios' || platform.kind === 'android';
    const onForeground = (active: boolean) => {
      if (!mobile) return;
      if (active) {
        engine.start();
        engine.reconnect();
      } else {
        // a folder left open does not keep the phone connected (its reader opens again later)
        if (folderOpen?.reader) {
          folderOpen.reader.close();
          folderOpen.reader = undefined;
        }
        engine.background(); // a transfer in progress goes on, then it disconnects
      }
    };
    if (platform.onAppState) platform.onAppState(onForeground); // Android app
    else document.addEventListener('visibilitychange', () => onForeground(document.visibilityState === 'visible'));

    // The Mac (and desktop browsers) start with a group of their own, ready to invite.
    if (engine.groups.length === 0 && !mobile && !pendingInvite) await engine.createGroup(this.t('group.default'));
    engine.start();
    this.refresh();

    if (pendingInvite) {
      if (isIOS && !isStandalone) {
        installInvite = pendingInvite;
        this.view = 'install';
        return;
      }
      await this.join(pendingInvite);
    }
    this.view = engine.groups.length ? 'main' : 'welcome';
    this.loadWhatsNew().catch(() => {});
    // sent with the interface shown, so their progress is visible
    this.handleSharedFiles().catch(() => {});
    // Android app: shares, invitation links and the back button come from the native side
    platform.onShare?.((o) => this.send(o));
    platform.onLink?.((url) => {
      if (url.includes('#p=')) this.join(url);
    });
    platform.onBack?.(() => this.onBack());
  },

  refresh() {
    this.device = { id: engine.device.id, name: engine.device.name };
    this.groups = engine.groups;
    if (!this.groups.find((g) => g.id === this.groupId)) {
      this.groupId = this.groups.find((g) => g.id === this.prefs.groupId)?.id ?? this.groups[0]?.id ?? null;
    }
    // copies: the engine mutates its transfers, the UI must see new objects to update.
    // Uploads: small lines above the history, gone once over. Downloads: in their item.
    const all = [...engine.transfers.values()];
    this.sending = all.filter((t) => t.direction === 'up').map((t) => ({ ...t }));
    const downloads: Record<string, { done: number; total: number; rate?: number }> = {};
    for (const t of all) {
      if (t.direction === 'down' && t.itemId) downloads[t.itemId] = { done: t.done, total: t.total, rate: t.rate };
    }
    this.downloads = downloads;
    if (engine.busy !== awake) {
      awake = engine.busy;
      platform.keepAwake?.(awake);
    }
    if (this.group) platform.setAutoLimit?.(this.group.autoMax);
    if (this.view === 'main' && !this.groups.length) this.view = 'welcome';
    // the item shown was deleted (here or elsewhere) or expired
    const shown = this.viewerFiles.length ? this.folderView.id : this.viewer.id;
    if (this.viewer.open && !this.items.some((i) => i.id === shown)) this.closeViewer();
    if (this.folderView.open && !this.items.some((i) => i.id === this.folderView.id)) this.closeFolder();
    // the link shown expired (it is created when its page opens: not before)
    if (this.view === 'share' && this.share && !this.group?.shares.some((s) => s.id === this.share!.id)) this.closeShare();
    // the request shown: as changed on any device, or closed once it ends
    if (this.view === 'drop' && this.drop) {
      const now = this.group?.drops.find((d) => d.id === this.drop!.id);
      if (now) this.drop = now;
      else this.closeDrop();
    }
    this.latest = engine.latest;
    this.announceUpdate();
    this.showNote();
  },

  // ---------------------------------------------------------------- language

  /** A text of the interface (reads `lang`: the bindings follow a change of language). */
  t(key: Key, vars?: Record<string, string | number>) {
    void this.lang;
    return translate(key, vars);
  },

  /** A text by a number: `key.one` or `key.other`. */
  tn(key: string, n: number) {
    void this.lang;
    return translateN(key, n);
  },

  /** The chosen language, or the system's: the texts, the page, the menu of the icon. */
  applyLang() {
    const l = this.prefs.lang ?? systemLang();
    setLang(l);
    this.lang = l;
    document.documentElement.lang = l;
    platform.setLang?.(l);
  },

  /** Settings: the selected entry of the language list ('' = the system's). */
  isLangChoice(code: string) {
    return (this.prefs.lang ?? '') === code;
  },

  /** Settings: '' follows the system. */
  setLanguage(e: Event) {
    const v = (e.target as HTMLSelectElement).value as Lang | '';
    this.prefs.lang = v || undefined;
    this.savePrefs();
    this.applyLang();
  },

  // ---------------------------------------------------------------- new version

  /** A newer version of this app, not dismissed yet (the web app updates itself). */
  get update() {
    const v = this.latest;
    return platform.native && v && newer(v, __VERSION__) && v !== this.prefs.updateSeen ? v : null;
  },

  get updateUrl() {
    const file = RELEASE_FILE[platform.kind];
    return file ? `${RELEASE}/download/${file}` : RELEASE; // Linux: .deb or AppImage, on the page
  },

  /** Desktop apps: one system notification per new version, seen even with the window closed. */
  announceUpdate() {
    const v = this.update;
    if (v) this.loadUpdateNews().catch(() => {});
    if (!v || !platform.notify || this.prefs.updateNotified === v) return;
    this.prefs.updateNotified = v;
    this.savePrefs();
    platform.notify('Entre Nous', this.t('update.notify', { v }));
  },

  /** After an update: the changes since the version last used here (CHANGELOG.md, built in). */
  async loadWhatsNew() {
    if (__VERSION__ === '0.0.0') return; // built without a version
    const seen = this.prefs.newsSeen;
    if (!seen || newer(seen, __VERSION__)) {
      // first run (or an older build): nothing to announce
      this.prefs.newsSeen = __VERSION__;
      this.savePrefs();
      return;
    }
    if (!newer(__VERSION__, seen)) return;
    this.whatsNew = __CHANGELOG__.filter((e) => newer(e.version, seen) && !newer(e.version, __VERSION__));
    if (!this.whatsNew.length) this.dismissWhatsNew();
  },

  get whatsNewTitle() {
    const list = this.whatsNew;
    if (!list.length) return '';
    return list.length === 1 ? this.t('news.title', { v: list[0].version }) : this.t('news.since', { v: this.prefs.newsSeen ?? '' });
  },

  dismissWhatsNew() {
    this.whatsNew = [];
    this.prefs.newsSeen = __VERSION__;
    this.savePrefs();
  },

  /** The changes of a version in the language of the interface (**bold**, no `code` marks). */
  newsItems(e: ChangelogEntry) {
    return (this.lang === 'fr' ? e.fr : e.en).map((c) => c.replace(/`(.+?)`/g, '$1'));
  },

  /** The banner of a new version: what it brings, asked once to the relay. */
  async loadUpdateNews() {
    const v = this.update;
    if (!v || this.updateNews[0]?.version === v || loadingNewsFor === v) return;
    loadingNewsFor = v;
    const entries = await engine.changelog(__VERSION__).catch(() => []);
    this.updateNews = entries.filter((e) => !newer(e.version, v));
  },

  toggleUpdateNews() {
    this.updateNewsOpen = !this.updateNewsOpen;
  },

  dismissUpdate() {
    this.prefs.updateSeen = this.latest ?? undefined;
    this.savePrefs();
  },

  // ---------------------------------------------------------------- live note

  get note() {
    return this.group?.note ?? null;
  },

  get noteInfo() {
    const n = this.note;
    if (!n) return '';
    const who = n.mine ? this.t('me') : n.byName;
    return n.expiresAt ? this.t('note.by', { who, left: duration(n.expiresAt - this.now) }) : who;
  },

  /** Puts the group's note in the field, unless the user is typing in it right now. */
  showNote() {
    const el = (this as any).$refs?.note as HTMLTextAreaElement | undefined;
    if (!el) return;
    const text = this.note?.text ?? '';
    const typing = document.activeElement === el && Date.now() - noteTypedAt < NOTE_TYPING;
    if (el.value !== text && typing) {
      // applied once the user pauses
      clearTimeout(noteRetry);
      noteRetry = setTimeout(() => this.showNote(), NOTE_TYPING - (Date.now() - noteTypedAt) + 50);
    } else if (el.value !== text) {
      const focused = document.activeElement === el;
      const start = el.selectionStart;
      const end = el.selectionEnd;
      el.value = text;
      if (focused) el.setSelectionRange(Math.min(start, text.length), Math.min(end, text.length));
    }
    this.noteEmpty = !el.value;
    this.fitNote();
  },

  fitNote() {
    const el = (this as any).$refs?.note as HTMLTextAreaElement | undefined;
    if (!el) return;
    el.style.height = 'auto';
    // empty: the CSS height (the placeholder does not count in scrollHeight on Safari)
    if (el.value) el.style.height = el.scrollHeight + 2 + 'px';
  },

  onNoteInput(e: Event) {
    const el = e.target as HTMLTextAreaElement;
    noteTypedAt = Date.now();
    this.noteEmpty = !el.value;
    this.fitNote();
    if (this.groupId) engine.setNote(this.groupId, el.value);
  },

  /** The note becomes an item of the history; the note itself stays, live. */
  async sendNote() {
    const text = ((this as any).$refs.note as HTMLTextAreaElement).value;
    if (!text.trim() || !this.canSendText) return;
    this.textSending = true;
    try {
      await this.send({ kind: 'text', text });
    } finally {
      this.textSending = false;
    }
  },

  /**
   * The note and the clipboard: offline, a send would wait for the connection, and each tap
   * would send one more.
   */
  get canSendText() {
    return this.group?.status === 'online' && !this.textSending;
  },

  async publish(item: ItemView) {
    try {
      await engine.publish(this.groupId!, item.id);
      this.toast(this.t('toast.published'));
    } catch (err: any) {
      this.toast(err instanceof SendCancelledError ? err.message : this.t('toast.error', { msg: err.message ?? err }));
    }
  },

  copyNote() {
    const text = ((this as any).$refs.note as HTMLTextAreaElement).value;
    if (!text) return;
    lastShared = b64(hash(utf8(text)));
    platform
      .copy('text/plain', Promise.resolve({ text }))
      .then(() => this.toast(this.t('toast.copied')))
      .catch((err) => this.toast(this.t('toast.copyFailed', { msg: err.message ?? err })));
  },

  /** The note is erased for every device: confirmed like a deletion. */
  clearNote() {
    if (this.prefs.confirmDelete && !this.isConfirming('note')) {
      this.askConfirm('note');
      return;
    }
    this.confirming = '';
    this.eraseNote();
  },

  eraseNote() {
    const el = (this as any).$refs.note as HTMLTextAreaElement;
    el.value = '';
    this.noteEmpty = true;
    this.fitNote();
    if (this.groupId) engine.setNote(this.groupId, '');
  },

  // ---------------------------------------------------------------- pause (Mac)

  togglePause() {
    this.setPaused(!this.prefs.paused);
  },

  setPaused(paused: boolean) {
    this.prefs.paused = paused;
    platform.setPaused?.(paused);
    this.savePrefs();
    this.toast(this.t(paused ? 'pause.on' : 'pause.off'));
  },

  get shareHint() {
    // turned off: the pause button is hidden, so this comes first
    if (!this.prefs.autoShare) return this.t('autoShare.off');
    if (this.prefs.paused) return this.t('pause.on');
    return '';
  },

  /** Desktop apps share their clipboard by themselves; by hand when paused or turned off. */
  get manualClipboard() {
    return !this.desktop || this.prefs.paused || !this.prefs.autoShare;
  },

  get group() {
    return this.groups.find((g) => g.id === this.groupId) ?? null;
  },

  get items(): ItemView[] {
    return this.group?.items ?? [];
  },

  /**
   * The history as shown: the group's file requests still open, on top; then the items and the
   * share links made here (newest first).
   */
  get history(): Array<ItemView | { id: string; createdAt: number; share: ShareView } | { id: string; createdAt: number; request: DropView }> {
    const requests = (this.group?.drops ?? []).map((request) => ({ id: 'request:' + request.id, createdAt: request.createdAt, request }));
    const shares = (this.group?.shares ?? []).map((share) => ({ id: 'share:' + share.id, createdAt: share.createdAt, share }));
    return [...requests, ...[...this.items, ...shares].sort((a, b) => b.createdAt - a.createdAt)];
  },

  /** What an entry of the history gives to the search. */
  searchable(e: any) {
    if (e.share) return e.share;
    if (e.request) return { kind: 'request', text: e.request.msg ?? '' };
    return e;
  },

  /** The history shown: what the search finds, when there is one. */
  get shown() {
    if (!this.searchActive) return this.history;
    const { q, type } = this.search;
    return this.history.filter((e: any) => matches(this.searchable(e), q, type));
  },

  // ---------------------------------------------------------------- search

  /** A query or a type: the history is filtered. */
  get searchActive() {
    return this.search.open && (!!this.search.q.trim() || !!this.search.type);
  },

  /** The type chips: only the types found in the history, if there are at least two. */
  get searchTypes() {
    void this.lang;
    const all = this.history.map((e: any) => this.searchable(e));
    const types = SEARCH_TYPES.filter((type) => all.some((e) => isType(e, type)));
    if (types.length < 2 && !this.search.type) return [];
    return [{ value: '', label: this.t('search.all') }, ...types.map((value) => ({ value, label: this.t(('search.type.' + value) as Key) }))];
  },

  /** The magnifier's tooltip: its shortcut on a computer. */
  get searchTitle() {
    if (this.mobile) return this.t('search');
    return this.t('search.title', { key: /Mac/.test(navigator.platform) ? '⌘F' : 'Ctrl+F' });
  },

  /** Opens the search, the field focused (its text selected: ⌘F again replaces the query). */
  openSearch() {
    this.search.open = true;
    platform.focus?.();
    (this as any).$nextTick(() => {
      const field = (this as any).$refs.search as HTMLInputElement | undefined;
      field?.focus();
      field?.select();
    });
  },

  closeSearch() {
    this.search = { open: false, q: '', type: '', sel: '' };
  },

  clearSearch() {
    this.search.q = '';
    this.search.sel = '';
    ((this as any).$refs.search as HTMLInputElement | undefined)?.focus();
  },

  /** Nothing found: back to the whole history, the field still open. */
  clearSearchAll() {
    this.search.type = '';
    this.clearSearch();
  },

  onSearchInput(e: Event) {
    this.search.q = (e.target as HTMLInputElement).value;
    this.search.sel = '';
  },

  setSearchType(type: SearchType | '') {
    this.search.type = type;
    this.search.sel = '';
  },

  searchTypeClass(c: { value: string }) {
    return 'chip' + (this.search.type === c.value ? ' on' : '');
  },

  /** On a computer: the result Enter acts on (the first one, until the arrows choose another). */
  get searchSelected() {
    if (this.mobile || !this.searchActive) return '';
    const shown = this.shown;
    return shown.some((e) => e.id === this.search.sel) ? this.search.sel : (shown[0]?.id ?? '');
  },

  /** In the search field: Escape clears, then closes; the arrows choose a result, Enter copies it. */
  onSearchKey(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (this.search.q) this.clearSearch();
      else this.closeSearch();
      return;
    }
    const shown = this.shown;
    if (!this.searchSelected || !shown.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const i = shown.findIndex((x) => x.id === this.searchSelected);
      const next = shown[(i + (e.key === 'ArrowDown' ? 1 : shown.length - 1)) % shown.length];
      this.search.sel = next.id;
      (this as any).$nextTick(() => document.querySelector('.history .item.selected')?.scrollIntoView({ block: 'nearest' }));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const entry: any = shown.find((x) => x.id === this.searchSelected);
      if (entry.share) this.copyShareLink(entry.share);
      else if (entry.request) this.copyDropLink(entry.request);
      else if (this.canCopy(entry)) this.copy(entry);
      else if (this.canBrowse(entry)) this.openFolder(entry);
      else if (this.previewOf(entry)) this.openPreview(entry);
    }
  },

  /** A text cut into found and not found pieces (the whole text when nothing is searched). */
  marked(s: string): Part[] {
    return this.search.open && this.search.q.trim() ? highlight(s, this.search.q) : [{ text: s, hit: false }];
  },

  /** The item's text or name: a long text shows from where the query is found. */
  labelParts(item: ItemView) {
    const label = this.label(item);
    return this.marked(item.kind === 'text' && this.search.open ? snippet(label, this.search.q) : label);
  },

  excerptParts(item: ItemView) {
    return this.marked(item.excerpt ?? '');
  },

  fromParts(item: ItemView) {
    return this.marked(item.mine ? this.t('me') : item.fromName);
  },

  shareParts(share: ShareView) {
    return this.marked(this.shareLabel(share));
  },

  hitClass(p: Part) {
    return p.hit ? 'hit' : '';
  },

  get searchCount() {
    return this.tn('search.results', this.shown.length);
  },

  get searchNone() {
    return this.search.q.trim() ? this.t('search.none', { q: this.search.q.trim() }) : this.t('search.noneType');
  },

  get others() {
    return (this.group?.members ?? []).filter((m) => !m.me);
  },

  get statusText() {
    const g = this.group;
    if (!g) return '';
    if (g.status !== 'online') return this.t(g.status === 'connecting' ? 'status.connecting' : 'status.offline');
    const online = this.others.filter((m) => m.online).map((m) => m.name);
    if (!this.others.length) return this.t('status.alone');
    return online.length ? this.t('status.online', { names: online.join(', ') }) : this.t('status.nobodyOnline');
  },

  get ttlOptions() {
    const max = this.group?.maxTtl ?? 7 * 86400;
    return TTL_CHOICES.filter((v) => v <= max).map((value) => ({ value, label: this.t(('ttl.' + value) as Key) }));
  },

  get maxItemsChoices() {
    return MAX_ITEMS_CHOICES.map((value) => ({ value, label: this.t(('maxItems.' + value) as Key) }));
  },

  get autoMaxChoices() {
    void this.lang;
    return AUTO_MAX_CHOICES.map((value) => ({ value, label: humanSize(value) }));
  },

  savePrefs() {
    platform.kv.set('prefs', { ...this.prefs }).catch(() => {});
  },

  selectGroup(id: string) {
    if (id !== this.groupId) this.closeSearch();
    this.groupId = id;
    this.prefs.groupId = id;
    this.savePrefs();
    noteTypedAt = 0;
    this.showNote();
  },

  toast(text: string) {
    this.toastText = text;
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => (this.toastText = ''), 3500);
  },

  // ---------------------------------------------------------------- items

  ago(item: ItemView) {
    const ms = this.now - item.createdAt;
    return ms < 60_000 ? this.t('ago.now') : this.t('ago', { d: duration(ms) });
  },

  itemClass(item: any) {
    const selected = item.id === this.searchSelected ? ' selected' : '';
    if (item.share || item.request) return 'shared-link' + selected;
    return (item.error ? 'broken' : '') + (this.hasReceipts(item) ? ' has-receipts' : '') + selected;
  },

  // ---------------------------------------------------------------- receipts

  /** Delivered somewhere: nothing shows before the first recipient has it. */
  hasReceipts(item: ItemView) {
    return !!item.receipts && item.receipts.delivered > 0;
  },

  /** 1st tick: a device has it (read on one: coloured); 2nd: all have it (read on all: coloured). */
  tickClass(item: ItemView, n: number) {
    const r = item.receipts;
    if (!r) return 'off';
    if (n === 1) return r.delivered ? (r.read ? 'read' : '') : 'off';
    return r.delivered < r.total ? 'off' : r.read === r.total ? 'read' : '';
  },

  receiptsTitle(item: ItemView) {
    const r = item.receipts;
    if (!r) return '';
    if (r.delivered < r.total) {
      const text = this.t(r.delivered > 1 ? 'receipt.some' : 'receipt.one', { n: r.delivered, total: r.total });
      return r.read ? this.t('receipt.readBy', { text, n: r.read }) : text;
    }
    if (!r.read) return this.t('receipt.all');
    return r.read < r.total ? this.t('receipt.allReadBy', { n: r.read, total: r.total }) : this.t('receipt.allRead');
  },

  toggleReceipts(item: ItemView) {
    this.receiptsOpen = this.receiptsOpen === item.id ? '' : item.id;
  },

  receiptsShown(item: ItemView) {
    return this.receiptsOpen === item.id;
  },

  /** A click elsewhere closes the detail (each item's ticks listen: only the open one acts). */
  closeReceiptsOf(item: ItemView) {
    if (this.receiptsOpen === item.id) this.receiptsOpen = '';
  },

  receiptDevices(item: ItemView) {
    return item.receipts?.devices ?? [];
  },

  receiptName(dev: { name: string; me?: boolean }) {
    return dev.me ? this.t('settings.thisDevice', { name: dev.name }) : dev.name;
  },

  receiptState(dev: { delivered?: number; read?: number }) {
    if (dev.read) return this.t('receipt.read', { at: this.clockTime(dev.read) });
    if (dev.delivered) return this.t('receipt.delivered', { at: this.clockTime(dev.delivered) });
    return this.t('receipt.waiting');
  },

  receiptClass(dev: { delivered?: number; read?: number }) {
    return dev.read ? 'read' : dev.delivered ? '' : 'waiting';
  },

  /** 14:05 today, “Mon 14:05” before. */
  clockTime(at: number) {
    const d = new Date(at);
    const time = d.toLocaleTimeString(this.lang, { hour: '2-digit', minute: '2-digit' });
    if (d.toDateString() === new Date(this.now).toDateString()) return time;
    return d.toLocaleDateString(this.lang, { weekday: 'short' }) + ' ' + time;
  },

  /** Still being uploaded, but its sender sent nothing for minutes: a download would give up. */
  interrupted(item: ItemView) {
    return !!item.pending && this.now - (item.progressAt ?? 0) > UPLOAD_STALLED;
  },

  left(item: ItemView) {
    if (item.unavailable) return this.t('left.unavailable', { name: item.fromName });
    if (item.local) return this.t('left.local', { d: duration(item.expiresAt - this.now) });
    if (this.interrupted(item)) return this.t('left.interrupted');
    if (item.pending) return this.t(this.now - (item.progressAt ?? 0) > STALLED_AFTER ? 'left.paused' : 'left.sending');
    return this.t('expires', { d: duration(item.expiresAt - this.now) });
  },

  /**
   * The upload lines: those of this device, and the items another device is still sending
   * (or this one, before a restart). An interrupted upload is no longer shown.
   */
  get transfers() {
    const lines: any[] = [...this.preparing.map((p) => ({ ...p, direction: 'up', preparing: true })), ...this.sending];
    const shown = new Set(lines.map((t) => t.itemId).filter(Boolean));
    for (const item of this.items) {
      if (!item.pending || shown.has(item.id) || this.interrupted(item)) continue;
      // stalled: its last speed means nothing any more
      const paused = this.now - (item.progressAt ?? 0) > STALLED_AFTER;
      lines.push({
        id: 'item:' + item.id,
        direction: 'up',
        name: item.name ?? '',
        from: item.mine ? undefined : item.fromName,
        done: item.have ?? 0,
        total: item.chunks,
        rate: paused ? undefined : item.rate,
        paused,
      });
    }
    return lines;
  },

  transferState(t: { error?: string; paused?: boolean; preparing?: boolean; done: number; total: number; rate?: number }) {
    if (t.error) return t.error;
    if (t.preparing) return this.t('folder.preparing', { n: t.done, total: t.total });
    return t.paused ? this.t('transfer.paused', { p: this.progress(t) }) : this.progress(t);
  },

  /** A download in progress: its loader takes the place of Copy and Save. */
  downloading(item: ItemView) {
    return !!this.downloads[item.id];
  },

  downloadProgress(item: ItemView) {
    const d = this.downloads[item.id];
    return d ? this.progress(d) : '';
  },

  downloadOffset(item: ItemView) {
    const d = this.downloads[item.id];
    return d ? this.ringOffset(d) : 100;
  },

  label(item: ItemView) {
    if (item.error) return this.t('item.undecryptable');
    if (item.kind === 'folder') return item.name ?? this.t('name.folder');
    if (item.kind === 'text') return item.text ?? this.t('item.localText');
    return item.name ?? this.t('name.file');
  },

  /** Size shown in the item's details (texts too: their UTF-8 size). */
  sizeOf(item: ItemView) {
    if (item.error) return '';
    if (item.kind === 'text') return humanSize(item.text === undefined ? (item.size ?? 0) : utf8(item.text).length);
    return item.size != null ? humanSize(item.size) : '';
  },

  canCopy(item: ItemView) {
    if (item.error || item.unavailable || this.interrupted(item)) return false;
    // being received: the clipboard would only be written at the end of the upload, long
    // after the tap (refused by browsers); the apps copy it by themselves once complete
    if (item.pending && !item.mine) return false;
    if (item.kind === 'folder') return false;
    if (item.kind === 'text') return true;
    if (item.kind === 'image') return !platform.imageCopyMax || (item.size ?? 0) <= platform.imageCopyMax;
    return this.desktop; // desktop apps paste any file
  },

  /** Also while it is being uploaded: the download follows the upload. */
  canSave(item: ItemView) {
    return !item.error && !item.unavailable && !this.interrupted(item) && item.kind !== 'text' && item.kind !== 'folder';
  },

  /** A folder can be browsed (and downloaded) while it is still being sent. */
  canBrowse(item: ItemView) {
    return item.kind === 'folder' && !item.error && !item.unavailable && !this.interrupted(item);
  },

  /** "248 fichiers" */
  folderCount(item: ItemView) {
    return this.tn('folder.files', item.files ?? 0);
  },

  /** Copy keeps the user gesture: the content is passed as a promise. */
  copy(item: ItemView) {
    const groupId = this.groupId!;
    engine.markRead(groupId, item.id);
    const mime = item.kind === 'text' ? 'text/plain' : (item.mime ?? 'application/octet-stream');
    platform
      .copy(mime, this.contentOf(groupId, item).then((c) => ({ ...c, expiresAt: item.expiresAt })))
      .then(() => this.toast(this.t('toast.copied')))
      .catch((err) => this.toast(failure('toast.copyFailed', err)));
  },

  async save(item: ItemView) {
    engine.markRead(this.groupId!, item.id);
    try {
      const c = await this.contentOf(this.groupId!, item);
      await platform.save(c.blob!, c.name ?? this.t('name.file'));
    } catch (err: any) {
      this.toast(failure('toast.error', err));
    }
  },

  /** Deleted for every device of the group. */
  async remove(item: ItemView) {
    if (this.prefs.confirmDelete && !this.isConfirming(this.itemKey(item))) {
      this.askConfirm(this.itemKey(item));
      return;
    }
    this.confirming = '';
    await engine.deleteItem(this.groupId!, item.id).catch((err) => this.toast(err.message));
  },

  /** More than one thing to delete (items, live note): otherwise their own button does it. */
  get canClearAll() {
    return this.items.length + (this.note ? 1 : 0) > 1;
  },

  /** Whole history of the group, for every member. Always confirmed. */
  async clearAll() {
    if (!this.isConfirming('clear')) {
      this.askConfirm('clear');
      return;
    }
    this.confirming = '';
    try {
      await engine.clearAll(this.groupId!);
      this.eraseNote();
      this.toast(this.t('toast.cleared'));
    } catch (err: any) {
      this.toast(this.t('toast.error', { msg: err.message ?? err }));
    }
  },

  /** Incoming item: the Mac and Android write it to the clipboard at once. */
  onIncoming(groupId: string, item: ItemView) {
    if (groupId !== this.groupId || !platform.autoWrite || copiedIds.has(item.id)) return;
    copiedIds.add(item.id);
    if (item.kind === 'folder' || (item.kind === 'file' && !this.desktop)) return;
    if (!this.native && !document.hasFocus()) return;
    const mime = item.kind === 'text' ? 'text/plain' : (item.mime ?? 'application/octet-stream');
    if (item.kind === 'text') lastShared = b64(hash(utf8(item.text ?? '')));
    const content = engine.content(groupId, item.id).then((c) => ({ ...c, expiresAt: item.expiresAt }));
    platform.copy(mime, content).catch(() => {});
  },

  /** Connected (app opened, or back from sleep): the latest item that arrived meanwhile. */
  onSynced(groupId: string) {
    const g = engine.groups.find((x) => x.id === groupId);
    const latest = g?.items.find((i) => !i.mine && !i.error && !i.pending);
    if (latest && Date.now() - latest.createdAt < MAILBOX_AGE) this.onIncoming(groupId, latest);
  },

  /** Mac: a notification while the window is closed (never the content itself). */
  notifyIncoming(item: ItemView) {
    if (!this.prefs.notify || !platform.notify) return;
    const what = item.kind === 'text' ? 'notify.text' : item.kind === 'image' ? 'notify.image' : item.kind === 'folder' ? 'notify.folder' : 'notify.file';
    platform.notify('Entre Nous', this.t(what, { name: item.fromName }));
  },

  // ---------------------------------------------------------------- previews

  /** How an item opens in the preview, or undefined (saved only). */
  previewOf(item: ItemView): PreviewKind | undefined {
    if (item.error || item.unavailable || item.kind === 'text' || item.kind === 'folder' || this.interrupted(item)) return undefined;
    return previewKind(item.name, item.mime);
  },

  isVideo(item: ItemView) {
    return this.previewOf(item) === 'video';
  },

  isAudio(item: ItemView) {
    return this.previewOf(item) === 'audio';
  },

  /** The button that opens it: Play, Open or View. */
  openLabel(item: ItemView) {
    const k = this.previewOf(item);
    return this.t(k === 'video' ? 'open.video' : k === 'audio' ? 'open.audio' : k === 'image' ? 'open.image' : 'open.doc');
  },

  openTitle(item: ItemView) {
    return this.t('open.title', { name: this.label(item) });
  },

  /** Videos, songs and documents open first; an image is copied first, then viewed. */
  opensFirst(item: ItemView) {
    const k = this.previewOf(item);
    return !!k && k !== 'image';
  },

  copyClass(item: ItemView) {
    return this.opensFirst(item) ? 'small secondary' : 'small primary';
  },

  openClass(item: ItemView) {
    return this.opensFirst(item) ? 'small primary' : 'small secondary';
  },

  /** A tile at the left of the item: its thumbnail, or a drawn page for a document. */
  hasTile(item: ItemView) {
    return !!item.thumb || !!this.previewOf(item) || item.kind === 'folder';
  },

  /** The tile opens the preview, or a folder's browser. */
  openTile(item: ItemView) {
    if (item.kind === 'folder') this.openFolder(item);
    else this.openPreview(item);
  },

  tileDisabled(item: ItemView) {
    return item.kind === 'folder' ? !this.canBrowse(item) : !this.previewOf(item);
  },

  tileClass(item: ItemView) {
    if (item.kind === 'folder') return 'thumb folder ' + (item.thumb ? 'pic' : 'doc');
    const k = this.previewOf(item);
    return 'thumb ' + (item.thumb ? 'pic' : 'doc') + (k === 'video' || k === 'audio' || k === 'pdf' ? ' ' + k : '');
  },

  /** On the tile: the length of a video or a song, a document's extension. */
  badge(item: ItemView) {
    if (item.kind === 'folder') return String(item.files ?? 0);
    if (this.isVideo(item) || this.isAudio(item)) return item.duration ? clock(item.duration) : '';
    if (this.previewOf(item) === 'pdf') return 'PDF';
    if (item.thumb) return '';
    const ext = /\.([a-z0-9]{1,5})$/i.exec(item.name ?? '')?.[1];
    return ext ? ext.toUpperCase() : '';
  },

  get previewable(): ItemView[] {
    if (this.viewerFiles.length) return this.viewerFiles;
    return this.items.filter((i) => this.previewOf(i));
  },

  get viewerItem(): FileView | undefined {
    if (!this.viewer.open) return undefined;
    return (this.viewerFiles.length ? this.viewerFiles : this.items).find((i) => i.id === this.viewer.id);
  },

  /** A file of a folder: no deletion from the viewer (the folder goes as a whole). */
  get viewerInFolder() {
    return this.viewerFiles.length > 0;
  },

  get viewerName() {
    const item = this.viewerItem;
    return item ? this.label(item) : '';
  },

  /** Who sent it, when, its size (and its pixels). */
  get viewerMeta() {
    const item = this.viewerItem;
    if (!item) return '';
    const parts = [item.mine ? this.t('me') : item.fromName, this.ago(item), this.sizeOf(item)];
    if (item.w && item.h && this.viewer.kind === 'image') parts.push(this.t('viewer.size', { w: item.w, h: item.h }));
    if (item.duration) parts.push(clock(item.duration));
    if (item.pages) parts.push(this.tn('viewer.pages', item.pages));
    return parts.filter(Boolean).join(' · ');
  },

  get viewerIndex() {
    return this.previewable.findIndex((i) => i.id === this.viewer.id);
  },

  get viewerTotal() {
    return this.previewable.length;
  },

  get viewerCount() {
    return this.t('viewer.count', { n: this.viewerIndex + 1, total: this.viewerTotal });
  },

  get viewerClass() {
    return 'viewer kind-' + (this.viewer.kind || 'none') + (this.viewer.wrap ? ' wrap' : '');
  },

  /** While the full image or the video loads: its thumbnail, blurred. */
  get viewerThumb() {
    return this.viewer.loading ? (this.viewerItem?.thumb ?? '') : '';
  },

  get viewerProgress() {
    const d = this.downloads[this.viewerInFolder ? this.folderView.id : this.viewer.id];
    return d ? this.progress(d) : '';
  },

  /** The image of the viewer cannot be shown here (a format this device does not read). */
  onViewerImageError() {
    if (this.viewer.open && this.viewer.kind === 'image' && this.viewer.src) {
      this.viewer.src = '';
      this.viewer.error = this.t('viewer.unreadable');
    }
  },

  viewerIs(kind: string) {
    return this.viewer.open && this.viewer.kind === kind;
  },

  /** Text and Markdown as plain text: the numbered lines. */
  get viewerLines() {
    return this.viewerIs('text') || (this.viewerIs('markdown') && this.viewer.source);
  },

  get viewerRendered() {
    return this.viewerIs('markdown') && !this.viewer.source;
  },

  /** Android's small window takes no taps: its own buttons (play/pause, back) replace them. */
  get videoControls() {
    return !(this.pipMode && this.platform === 'android');
  },

  videoEl(): HTMLVideoElement | undefined {
    return (this as any).$refs?.player;
  },

  /** Opens `item` in the preview; the previous one (if any) is released. */
  async openPreview(item: ItemView) {
    const kind = this.previewOf(item);
    if (!kind || !this.groupId) return;
    this.releaseViewer();
    const seq = ++viewerSeq;
    const groupId = this.groupId;
    engine.markRead(groupId, item.id);
    this.confirming = '';
    this.viewer = { open: true, id: item.id, kind, loading: true, error: '', src: '', note: '', source: false, wrap: this.viewer.wrap, canPip: false, pages: 0, page: 1, zoom: 1, selection: '' };
    await (this as any).$nextTick();
    const stale = () => seq !== viewerSeq;
    try {
      if (kind === 'image') {
        if (item.thumb) {
          // the preview made by the sender: nothing to download
          this.viewer.src = item.thumb;
        } else if (item.previewless) {
          // the local mode sends no preview: the image itself
          const c = await this.contentOf(groupId, item);
          if (stale()) return;
          viewerUrl = URL.createObjectURL(c.blob!);
          this.viewer.src = viewerUrl;
        } else this.viewer.error = this.t('viewer.noPreview');
      } else if (kind === 'video') {
        await this.playVideo(groupId, item, stale);
      } else if (kind === 'audio') {
        await this.playAudio(groupId, item, stale);
      } else if (kind === 'pdf') {
        await this.showPdf(groupId, item, stale);
      } else {
        // a text: its start (the first chunk at most)
        const reader = this.readerOf(groupId, item, { ahead: 0 });
        let bytes: Uint8Array;
        try {
          bytes = await reader.read(0, TEXT_PREVIEW_MAX);
        } finally {
          reader.close();
        }
        if (stale()) return;
        const whole = (item.size ?? 0) <= TEXT_PREVIEW_MAX;
        const text = decodeStart(bytes, whole);
        textShown = text;
        const cut = drawLines((this as any).$refs.lines, text);
        if (!whole || cut) this.viewer.note = this.t('viewer.truncated', { size: humanSize(item.size) });
        if (kind === 'markdown') await renderMarkdown((this as any).$refs.md, text);
      }
    } catch (err: any) {
      if (stale()) return;
      this.viewer.error = err instanceof ItemGoneError ? err.message : this.t('toast.error', { msg: err?.message ?? err });
    } finally {
      if (!stale()) this.viewer.loading = false;
    }
  },

  /**
   * Streams the video (it plays while it arrives); where it cannot be streamed (an older
   * iPhone, a WebM…), downloads it whole first, if this device can play it at all.
   */
  async playVideo(groupId: string, item: ItemView, stale: () => boolean) {
    const video = this.videoEl()!;
    video.poster = item.thumb ?? '';
    const onError = () => {
      if (!stale()) this.viewer.error = this.t('viewer.unreadable');
    };
    video.onerror = onError;
    video.addEventListener('streamerror', onError);
    // Android: leaving the app while it plays turns it into the small window
    const playing = () => platform.pip?.playing?.(!video.paused, video.videoWidth || item.w || 16, video.videoHeight || item.h || 9);
    video.onplay = playing;
    video.onpause = playing;
    // Mac: back from the picture-in-picture window, the popover shows again
    video.onleavepictureinpicture = () => platform.show?.();
    try {
      stopMedia = await stream(video, this.readerOf(groupId, item, { keep: 8, ahead: 3 }));
    } catch (err) {
      if (stale()) return;
      if (!(err instanceof NotStreamable)) throw err;
      if (!video.canPlayType(item.mime || 'video/mp4')) {
        this.viewer.error = this.t('viewer.unreadable');
        return;
      }
      const c = await this.contentOf(groupId, item);
      if (stale()) return;
      viewerUrl = URL.createObjectURL(c.blob!);
      video.src = viewerUrl;
    }
    if (stale()) return;
    this.viewer.canPip = !!platform.pip || (document as any).pictureInPictureEnabled === true || typeof (video as any).webkitSetPresentationMode === 'function';
    video.play().catch(() => {}); // may wait for a tap (no sound without a gesture)
  },

  /**
   * Plays a song while it arrives (MP3, M4A, Opus, FLAC, WAV); other formats (Ogg Vorbis,
   * floating-point WAV…) are downloaded whole first, if this device can play them at all.
   */
  async playAudio(groupId: string, item: ItemView, stale: () => boolean) {
    const audio = this.audioEl()!;
    const onError = () => {
      if (!stale()) this.viewer.error = this.t('viewer.unreadable');
    };
    audio.onerror = onError;
    audio.addEventListener('streamerror', onError);
    try {
      stopMedia = await stream(audio, this.readerOf(groupId, item, { keep: 4, ahead: 2 }), { duration: item.duration });
    } catch (err) {
      if (stale()) return;
      if (!(err instanceof NotStreamable)) throw err;
      if (!audio.canPlayType(item.mime || audioMime(item.name))) {
        this.viewer.error = this.t('viewer.unreadable');
        return;
      }
      const c = await this.contentOf(groupId, item);
      if (stale()) return;
      viewerUrl = URL.createObjectURL(c.blob!);
      audio.src = viewerUrl;
    }
    if (stale()) return;
    audio.play().catch(() => {}); // may wait for a tap (no sound without a gesture)
  },

  /**
   * A PDF: pdf.js reads only the parts it needs (its table, the pages shown); a page is drawn
   * when it comes near the screen, and forgotten far from it.
   */
  async showPdf(groupId: string, item: ItemView, stale: () => boolean) {
    const opened = await openPdf(this.readerOf(groupId, item, { keep: 8, ahead: 0 }));
    if (stale()) return opened.close();
    pdf = { ...opened, drawing: Promise.resolve() };
    this.viewer.pages = opened.doc.numPages;
    // text selected in the PDF: "Copy the selection"
    pdf.onSelect = () => {
      const sel = document.getSelection();
      const box: HTMLElement | undefined = (this as any).$refs.pdf;
      const text = sel && box && sel.anchorNode && box.contains(sel.anchorNode) ? sel.toString() : '';
      this.viewer.selection = text.trim() ? text : '';
    };
    document.addEventListener('selectionchange', pdf.onSelect);
    await this.layoutPdf();
  },

  /** One frame per page, its height from the first page's shape until it is drawn. */
  async layoutPdf() {
    const box: HTMLElement | undefined = (this as any).$refs.pdf;
    if (!pdf || !box) return;
    const current = pdf;
    current.observer?.disconnect();
    const width = Math.max(200, (box.clientWidth - 24) * this.viewer.zoom);
    const first = await pageSize(current.doc, 1);
    if (pdf !== current) return;
    const frames: HTMLElement[] = [];
    for (let n = 1; n <= current.doc.numPages; n++) {
      const frame = document.createElement('div');
      frame.className = 'pdf-page';
      frame.dataset.n = String(n);
      frame.style.width = width + 'px';
      frame.style.height = Math.round((first.h * width) / first.w) + 'px';
      const text = document.createElement('div');
      text.className = 'textLayer';
      const links = document.createElement('div');
      links.className = 'pdf-links';
      frame.append(document.createElement('canvas'), text, links);
      frames.push(frame);
    }
    box.replaceChildren(...frames);
    current.observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const frame = e.target as HTMLElement;
          const canvas = frame.firstElementChild as HTMLCanvasElement;
          if (!e.isIntersecting) {
            // far from the screen: its pixels and its text are given back
            canvas.width = canvas.height = 0;
            for (const layer of Array.from(frame.children).slice(1)) layer.replaceChildren();
            delete frame.dataset.drawn;
            continue;
          }
          if (frame.dataset.drawn) continue;
          frame.dataset.drawn = '1';
          // one page at a time: pdf.js asks for the bytes of each in turn
          current.drawing = current.drawing.then(async () => {
            if (pdf !== current || !frame.dataset.drawn) return;
            try {
              const n = Number(frame.dataset.n);
              const height = await drawPage(current.doc, n, canvas, width);
              frame.style.height = Math.round(height) + 'px';
              const [, text, links] = Array.from(frame.children) as HTMLElement[];
              await drawLayers(current.doc, n, text, links, width, (page) => this.pdfGoTo(page));
            } catch {
              delete frame.dataset.drawn;
            }
          });
        }
      },
      { root: box, rootMargin: '150% 0px' },
    );
    for (const f of frames) current.observer.observe(f);
  },

  /** A link to another page: that page at the top. */
  pdfGoTo(page: number) {
    const box: HTMLElement | undefined = (this as any).$refs.pdf;
    const frame = box?.children[page - 1] as HTMLElement | undefined;
    if (box && frame) box.scrollTop = frame.offsetTop - 12;
  },

  /** The page in view, as the PDF scrolls. */
  onPdfScroll() {
    const box: HTMLElement | undefined = (this as any).$refs.pdf;
    if (!box || !this.viewer.pages) return;
    const mark = box.scrollTop + box.clientHeight / 3;
    let n = 1;
    for (const frame of box.children as any as HTMLElement[]) {
      if (frame.offsetTop > mark) break;
      n = Number(frame.dataset.n);
    }
    this.viewer.page = n;
  },

  get pdfPageLabel() {
    return this.t('viewer.page', { n: this.viewer.page, total: this.viewer.pages });
  },

  get pdfZoomLabel() {
    return Math.round(this.viewer.zoom * 100) + ' %';
  },

  pdfZoomIn() {
    this.pdfZoom(1);
  },

  pdfZoomOut() {
    this.pdfZoom(-1);
  },

  /** Back to the width of the screen. */
  pdfZoomReset() {
    this.pdfZoom(-PDF_ZOOMS.indexOf(this.viewer.zoom));
  },

  /** The next zoom up or down, the same page kept in view. */
  async pdfZoom(step: number) {
    const i = PDF_ZOOMS.indexOf(this.viewer.zoom) + step;
    if (!step || i < 0 || i >= PDF_ZOOMS.length) return;
    const page = this.viewer.page;
    this.viewer.zoom = PDF_ZOOMS[i];
    await this.layoutPdf();
    const box: HTMLElement | undefined = (this as any).$refs.pdf;
    const frame = box?.children[page - 1] as HTMLElement | undefined;
    if (box && frame) box.scrollTop = frame.offsetTop - 12;
  },

  audioEl(): HTMLAudioElement | undefined {
    return (this as any).$refs?.audio;
  },

  /** Stops what the preview holds: video, song, object URL, picture-in-picture. */
  releaseViewer() {
    viewerSeq++;
    stopMedia?.();
    stopMedia = undefined;
    const video = this.videoEl();
    if (video) {
      if ((document as any).pictureInPictureElement === video) (document as any).exitPictureInPicture().catch(() => {});
      video.onplay = video.onpause = video.onerror = video.onleavepictureinpicture = null;
      video.pause();
      video.removeAttribute('src');
      video.removeAttribute('poster');
      video.load();
      platform.pip?.playing?.(false, 16, 9);
    }
    const audio = this.audioEl();
    if (audio) {
      audio.onerror = null;
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    }
    if (this.pipMode) this.exitPip();
    if (pdf) {
      pdf.observer?.disconnect();
      if (pdf.onSelect) document.removeEventListener('selectionchange', pdf.onSelect);
      pdf.close();
      pdf = undefined;
    }
    if (viewerUrl) URL.revokeObjectURL(viewerUrl);
    viewerUrl = '';
    textShown = '';
    const refs = (this as any).$refs ?? {};
    refs.lines?.replaceChildren();
    refs.md?.replaceChildren();
    refs.pdf?.replaceChildren();
  },

  closeViewer() {
    this.releaseViewer();
    this.viewer.open = false;
    this.viewer.kind = '';
    this.viewer.id = '';
    this.viewerFiles = [];
  },

  /** The previous (-1) or next (1) item that has a preview. */
  viewerStep(delta: number) {
    const list = this.previewable;
    const next = list[this.viewerIndex + delta];
    if (next && this.viewerInFolder) this.openFolderFile(next as FileView);
    else if (next) this.openPreview(next);
  },

  viewerPrev() {
    this.viewerStep(-1);
  },

  viewerNext() {
    this.viewerStep(1);
  },

  onKey(e: KeyboardEvent) {
    // ⌘F / Ctrl+F: the search, from the history
    if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'f' && this.view === 'main' && !this.viewer.open && !this.folderView.open) {
      e.preventDefault();
      if (this.history.length) this.openSearch();
      return;
    }
    if (!this.viewer.open && !this.folderView.open && this.view === 'main' && this.search.open && e.key === 'Escape') {
      this.closeSearch();
      return;
    }
    if (!this.viewer.open) {
      if (this.folderView.open && e.key === 'Escape') this.closeFolder();
      return;
    }
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (e.key === 'Escape') this.closeViewer();
    else if (e.key === 'ArrowLeft' && !this.viewerIs('video') && !this.viewerIs('audio')) this.viewerPrev();
    else if (e.key === 'ArrowRight' && !this.viewerIs('video') && !this.viewerIs('audio')) this.viewerNext();
  },

  /** Phones: a swipe on an image goes to the next or previous item. */
  onSwipeStart(e: TouchEvent) {
    swipeX = this.viewerIs('image') && e.touches.length === 1 ? e.touches[0].clientX : null;
  },

  onSwipeEnd(e: TouchEvent) {
    if (swipeX === null) return;
    const dx = (e.changedTouches[0]?.clientX ?? swipeX) - swipeX;
    swipeX = null;
    if (Math.abs(dx) > 60) this.viewerStep(dx < 0 ? 1 : -1);
  },

  toggleWrap() {
    this.viewer.wrap = !this.viewer.wrap;
  },

  showRendered() {
    this.viewer.source = false;
  },

  showSource() {
    this.viewer.source = true;
  },

  isRendered() {
    return !this.viewer.source;
  },

  /** Copy from the preview: the text shown, or the item itself (an image). */
  viewerCopy() {
    const item = this.viewerItem;
    if (!item) return;
    if (this.viewer.kind === 'text' || this.viewer.kind === 'markdown' || this.viewer.kind === 'pdf') {
      const text = this.viewer.kind === 'pdf' ? this.viewer.selection : textShown;
      platform
        .copy('text/plain', Promise.resolve({ text }))
        .then(() => this.toast(this.t('toast.copied')))
        .catch((err) => this.toast(failure('toast.copyFailed', err)));
    } else this.copy(item);
  },

  get viewerCanCopy() {
    const item = this.viewerItem;
    if (!item || this.viewer.loading || this.viewer.error) return false;
    if (this.viewer.kind === 'image') return this.canCopy(item);
    if (this.viewer.kind === 'pdf') return !!this.viewer.selection;
    return this.viewer.kind === 'text' || this.viewer.kind === 'markdown';
  },

  get viewerCopyLabel() {
    return this.t(this.viewer.kind === 'image' ? 'copy' : this.viewer.kind === 'pdf' ? 'viewer.copySelection' : 'viewer.copyText');
  },

  viewerSave() {
    const item = this.viewerItem;
    if (item) this.save(item);
  },

  viewerRemove() {
    const item = this.viewerItem;
    if (item && !this.viewerInFolder) this.remove(item);
  },

  get viewerRemoving() {
    return this.isConfirming(this.itemKey({ id: this.viewer.id }));
  },

  get pipHint() {
    return this.t(this.mac || this.platform === 'desktop' || this.platform === 'ios' ? 'viewer.pipHint' : 'viewer.pipHintApp');
  },

  /**
   * Picture-in-picture. Called straight from the tap: the browser's own needs the gesture,
   * so nothing is awaited before asking for it.
   */
  startPip() {
    const video = this.videoEl();
    if (!video) return;
    if (video.paused) video.play().catch(() => {});
    if (platform.pip) {
      this.pipMode = true;
      document.documentElement.classList.add('pip');
      platform.pip.enter(video.videoWidth || 16, video.videoHeight || 9).catch((err) => {
        this.pipMode = false;
        document.documentElement.classList.remove('pip');
        this.toast(this.t('toast.error', { msg: err?.message ?? err }));
      });
      return;
    }
    const v = video as any;
    if ((document as any).pictureInPictureEnabled && v.requestPictureInPicture) {
      v.requestPictureInPicture().catch((err: any) => this.toast(this.t('toast.error', { msg: err?.message ?? err })));
    } else if (typeof v.webkitSetPresentationMode === 'function') {
      v.webkitSetPresentationMode('picture-in-picture');
    }
  },

  /** Linux and Windows: back from the small window. */
  exitPip() {
    platform.pip?.exit().catch(() => {});
    this.pipMode = false;
    document.documentElement.classList.remove('pip');
  },

  fullscreen() {
    const v = this.videoEl() as any;
    if (!v) return;
    if (v.requestFullscreen) v.requestFullscreen().catch(() => v.webkitEnterFullscreen?.());
    else v.webkitEnterFullscreen?.(); // iPhone
  },

  // ---------------------------------------------------------------- sending

  async send(o: Outgoing) {
    if (!this.groupId) return;
    if (o.kind === 'folder') return this.sendFolder(o.folder);
    try {
      if (o.kind === 'text') {
        await engine.sendText(this.groupId, o.text);
      } else {
        const { kind, extra } = await preview(o.blob, o.name);
        await engine.sendBlob(this.groupId, o.blob, o.name, kind, extra);
      }
      this.toast(this.t('toast.sent'));
    } catch (err: any) {
      if (err.message === 'full') this.toast(this.t('toast.full'));
      else if (err instanceof SendCancelledError) this.toast(err.message);
      else this.toast(this.t('toast.error', { msg: err.message ?? err }));
    }
  },

  async sendClipboard() {
    if (!this.canSendText) return;
    this.textSending = true;
    try {
      const o = await platform.read();
      if (!o) {
        this.toast(this.t('toast.clipboardEmpty'));
        return;
      }
      await this.send(o);
    } catch (err: any) {
      this.toast(this.t('toast.clipboardDenied'));
    } finally {
      this.textSending = false;
    }
  },

  pickFiles() {
    this.fileMenu = false;
    ((this as any).$refs.file as HTMLInputElement).click();
  },

  /** Phones: the File button opens a choice (files, or a folder) where a folder can be sent. */
  onFileButton() {
    if (this.mobile && this.canPickFolder) this.fileMenu = !this.fileMenu;
    else this.pickFiles();
  },

  closeFileMenu() {
    this.fileMenu = false;
  },

  /** A folder to send: the apps' own picker, or the browser's. */
  async pickFolder() {
    this.fileMenu = false;
    if (!platform.pickFolder) {
      ((this as any).$refs.folder as HTMLInputElement).click();
      return;
    }
    try {
      const src = await platform.pickFolder();
      if (src) await this.sendFolder(src);
    } catch (err: any) {
      this.toast(this.t('toast.error', { msg: err?.message ?? err }));
    }
  },

  async onFolderInput(e: Event) {
    const input = e.target as HTMLInputElement;
    const src = folderFromInput(input.files ?? []);
    input.value = '';
    if (src) await this.sendFolder(src);
  },

  /**
   * Sends a folder: at once when small, otherwise after a look at what it holds. `copied`: it
   * was copied (desktop apps), not picked: a notification asks.
   */
  async sendFolder(src: FolderSource, copied = false) {
    if (!this.groupId) return;
    if (src.truncated) {
      this.toast(this.t('folder.tooMany', { name: src.name }));
      return;
    }
    if (!src.files.length && !src.dirs.length) {
      this.toast(this.t('folder.nothing', { name: src.name }));
      return;
    }
    if (needsConfirm(src) || copied) {
      pendingFolder = src;
      this.folderAsk = { name: src.name, files: src.files.length, dirs: new Set(src.files.map((f) => f.path.split('/').slice(0, -1).join('/')).filter(Boolean)).size + src.dirs.length, bytes: src.bytes, ignored: src.ignored, copied };
      platform.show?.(); // Mac: the window, if a folder was dropped on the icon
      return;
    }
    await this.doSendFolder(src);
  },

  get folderAskText() {
    const a = this.folderAsk;
    if (!a) return '';
    const parts = [this.tn('folder.files', a.files)];
    if (a.dirs) parts.push(this.tn('folder.dirs', a.dirs));
    return parts.join(', ') + ' · ' + humanSize(a.bytes);
  },

  get folderAskIgnored() {
    return this.folderAsk?.ignored ? this.tn('folder.ignored', this.folderAsk.ignored) : '';
  },

  get folderAskSpace() {
    const s = this.group?.storage;
    if (!s || !s.limit || this.group?.localOnly) return '';
    return this.t('folder.space', { free: humanSize(Math.max(0, s.limit - s.used)) });
  },

  get folderAskTooBig() {
    const s = this.group?.storage;
    return !!(this.folderAsk && s && s.limit && !this.group?.localOnly && this.folderAsk.bytes > s.limit - s.used);
  },

  async confirmFolder() {
    const src = pendingFolder;
    pendingFolder = undefined;
    this.folderAsk = null;
    if (src) await this.doSendFolder(src);
  },

  cancelFolder() {
    pendingFolder = undefined;
    this.folderAsk = null;
  },

  /** The previews of every image, video and PDF (here, shown as a line), then the upload. */
  async doSendFolder(src: FolderSource) {
    const groupId = this.groupId;
    if (!groupId) return;
    const id = 'prep:' + ++prepareSeq;
    const line = { id, name: src.name, done: 0, total: 0 };
    this.preparing = [...this.preparing, line];
    let pack: Awaited<ReturnType<typeof prepareFolder>>;
    try {
      pack = await prepareFolder(src, (done, total) => {
        this.preparing = this.preparing.map((p) => (p.id === id ? { ...p, done, total } : p));
      });
    } catch (err: any) {
      this.toast(this.t('toast.error', { msg: err?.message ?? err }));
      return;
    } finally {
      this.preparing = this.preparing.filter((p) => p.id !== id);
    }
    try {
      await engine.sendBlob(groupId, pack.source, src.name, 'folder', { folder: pack.summary, thumb: pack.thumb });
      this.toast(this.t('toast.sent'));
    } catch (err: any) {
      if (err.message === 'full') this.toast(this.t('toast.full'));
      else if (err instanceof SendCancelledError) this.toast(err.message);
      else this.toast(this.t('toast.error', { msg: err.message ?? err }));
    }
  },

  // ---------------------------------------------------------------- folders received

  /** A content to read: an item, or a file of a folder (a range of the folder's). */
  readerOf(groupId: string, item: FileView, opts: { keep?: number; ahead?: number } = {}): ContentReader {
    if (!item.folder || !item.path) return engine.reader(groupId, item.id, opts);
    const file = folderOpen?.index.files.find((f) => f.path === item.path);
    if (!file) throw new ItemGoneError();
    return fileReader(engine.reader(groupId, item.folder, opts), file);
  },

  /** The whole content of an item, or of a file of a folder (with its download's progress). */
  async contentOf(groupId: string, item: FileView): Promise<{ text?: string; blob?: Blob; name?: string; mime?: string }> {
    if (!item.folder || !item.path) return engine.content(groupId, item.id);
    const file = folderOpen?.index.files.find((f) => f.path === item.path);
    if (!file) throw new ItemGoneError();
    const reader = engine.downloadReader(groupId, item.folder, baseName(file.path), chunksOf([file]));
    try {
      return { blob: await readBlob(reader, file), name: baseName(file.path), mime: file.mime };
    } finally {
      reader.close();
    }
  },

  /** Opens a folder's browser: its index comes first, the previews as they show. */
  async openFolder(item: ItemView) {
    const groupId = this.groupId;
    if (!groupId || !this.canBrowse(item)) return;
    if (this.folderView.open && this.folderView.id === item.id) return; // a second tap
    this.closeFolder();
    this.confirming = '';
    this.folderView = { open: true, id: item.id, loading: true, error: '' };
    engine.markRead(groupId, item.id);
    const reader = engine.reader(groupId, item.id, { keep: 6, ahead: 1 });
    try {
      const index = await readIndex(reader);
      if (this.folderView.id !== item.id || !this.folderView.open || folderOpen) return reader.close();
      folderOpen = { groupId, item, reader, index, thumbs: new Map() };
      this.folderView.loading = false;
      await (this as any).$nextTick();
      const open = folderOpen;
      open.browser = new FolderBrowser((this as any).$refs.folderBox, {
        index,
        thumb: (f) => this.folderThumb(open, f),
        open: (f, siblings) => this.openFolderFiles(f, siblings),
        download: (files, dirs, base, name) => this.downloadFolderFiles(open, files, dirs, base, name),
        close: () => this.closeFolder(),
      });
    } catch (err: any) {
      reader.close();
      if (this.folderView.id !== item.id) return;
      this.folderView.loading = false;
      this.folderView.error = err instanceof ItemGoneError ? err.message : this.t('toast.error', { msg: err?.message ?? err });
    }
  },

  closeFolder() {
    if (this.viewerInFolder) this.closeViewer();
    if (folderOpen) {
      folderOpen.browser?.destroy();
      folderOpen.reader?.close();
      for (const url of folderOpen.thumbs.values()) URL.revokeObjectURL(url);
      folderOpen = undefined;
    }
    this.folderView = { open: false, id: '', loading: false, error: '' };
  },

  /** Back in the folder: one level up, or closed. */
  folderBack() {
    if (folderOpen?.browser) folderOpen.browser.back();
    else this.closeFolder();
  },

  /** A file's preview (made by the sender), as an object URL, read once. */
  async folderThumb(open: NonNullable<typeof folderOpen>, f: FolderFile): Promise<string | undefined> {
    if (!f.thumb) return undefined;
    const known = open.thumbs.get(f.path);
    if (known) return known;
    try {
      const bytes = await folderReader(open).read(f.thumb[0], f.thumb[0] + f.thumb[1]);
      if (folderOpen !== open) return undefined;
      const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'image/jpeg' }));
      open.thumbs.set(f.path, url);
      return url;
    } catch {
      return undefined;
    }
  },

  /** A file of the folder as an item of the viewer. */
  fileView(open: NonNullable<typeof folderOpen>, f: FolderFile): FileView {
    const item = open.item;
    const name = baseName(f.path);
    const k = previewKind(name, f.mime);
    return {
      id: `${item.id}/${f.path}`,
      folder: item.id,
      path: f.path,
      from: item.from,
      fromName: item.fromName,
      mine: item.mine,
      createdAt: item.createdAt,
      expiresAt: item.expiresAt,
      kind: k === 'image' ? 'image' : 'file',
      name,
      mime: f.mime,
      size: f.size,
      thumb: open.thumbs.get(f.path),
      w: f.w,
      h: f.h,
      duration: f.duration,
      pages: f.pages,
      excerpt: f.excerpt,
      chunks: 0,
      // an image without a preview: the file itself is shown
      previewless: !f.thumb,
    };
  },

  /** Opens a file of the folder; the viewer goes from it to the other files of its folder. */
  async openFolderFiles(f: FolderFile, siblings: FolderFile[]) {
    const open = folderOpen;
    if (!open) return;
    this.viewerFiles = siblings.map((x) => this.fileView(open, x));
    await this.openFolderFile(this.viewerFiles.find((v) => v.path === f.path) ?? this.fileView(open, f));
  },

  /** Its preview read first (an image shows it, a video uses it as its poster). */
  async openFolderFile(v: FileView) {
    const open = folderOpen;
    if (!open) return;
    const f = open.index.files.find((x) => x.path === v.path);
    if (f?.thumb && !v.thumb) {
      const url = await this.folderThumb(open, f);
      if (folderOpen !== open) return;
      this.viewerFiles = this.viewerFiles.map((x) => (x.path === v.path ? { ...x, thumb: url } : x));
      v = { ...v, thumb: url };
    }
    await this.openPreview(v);
  },

  /**
   * Downloads files of the folder: one alone is saved like a file; several, as a folder (where
   * the device can write one) or a ZIP. Where it goes is asked first, while the tap counts.
   */
  async downloadFolderFiles(open: NonNullable<typeof folderOpen>, files: FolderFile[], dirs: string[], base: string, name: string) {
    const strip = base ? base.length + 1 : 0;
    const groupId = open.groupId;
    const itemId = open.item.id;
    try {
      if (files.length === 1 && !dirs.length) {
        open.browser?.setBusy(this.t('viewer.loading'));
        const c = await this.contentOf(groupId, this.fileView(open, files[0]));
        await platform.save(c.blob!, c.name ?? this.t('name.file'));
        return;
      }
      const target = await chooseTarget(name, platform);
      if (!target) return;
      const total = files.reduce((n, f) => n + f.size, 0);
      const reader = engine.downloadReader(groupId, itemId, name, chunksOf(files));
      try {
        const pct = (done: number) => (total ? Math.round((done / total) * 100) : 100) + (this.lang === 'fr' ? ' %' : '%');
        open.browser?.setBusy(pct(0));
        const res = await writeFolder(
          target,
          files.map((f) => ({ path: f.path.slice(strip), size: f.size, read: (s: number, e: number) => reader.read(f.offset + s, f.offset + e) })),
          dirs.map((d) => d.slice(strip)).filter(Boolean),
          (done) => open.browser?.setBusy(pct(done)),
        );
        if ('zip' in res) await platform.save(res.zip, name + '.zip');
        else this.toast(this.t('folder.saved', { where: res.where }));
      } finally {
        reader.close();
      }
    } catch (err: any) {
      this.toast(failure('toast.error', err));
    } finally {
      open.browser?.setBusy('');
    }
  },

  /** "Download all" from the history: the folder's index, then all of it. */
  async downloadFolder(item: ItemView) {
    const groupId = this.groupId;
    if (!groupId || !this.canBrowse(item)) return;
    engine.markRead(groupId, item.id);
    // a name from another device: made safe before it names anything here
    const name = safePath(item.name ?? '')?.replace(/\//g, '-') || this.t('name.folder');
    let reader: ContentReader | undefined;
    try {
      // asked first: a browser's folder picker needs the tap
      const target = await chooseTarget(name, platform);
      if (!target) return;
      reader = engine.downloadReader(groupId, item.id, name, item.chunks);
      const r = reader;
      const index = await readIndex(r);
      const res = await writeFolder(
        target,
        index.files.map((f) => ({ path: f.path, size: f.size, read: (s: number, e: number) => r.read(f.offset + s, f.offset + e) })),
        emptyDirs(index),
      );
      if ('zip' in res) await platform.save(res.zip, name + '.zip');
      else this.toast(this.t('folder.saved', { where: res.where }));
    } catch (err: any) {
      this.toast(failure('toast.error', err));
    } finally {
      reader?.close();
    }
  },

  async onFiles(e: Event) {
    const input = e.target as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    input.value = '';
    for (const f of files) await this.send({ kind: 'file', blob: f, name: f.name });
  },

  /** Files and folders dropped on the main screen (elsewhere, the drop is only kept from opening them). */
  onDrop(e: DragEvent) {
    dragDepth = 0;
    this.dragging = false;
    if (this.view !== 'main') return;
    // taken now: the drop's entries are gone after this event
    const { folders, files } = droppedEntries(e.dataTransfer);
    for (const f of files) this.send({ kind: 'file', blob: f, name: f.name });
    folders.then(
      async (list) => {
        for (const src of list) await this.sendFolder(src);
      },
      (err) => this.toast(this.t('toast.error', { msg: err?.message ?? err })),
    );
  },

  onDragEnter(e: DragEvent) {
    if (this.view !== 'main' || !Array.from(e.dataTransfer?.types ?? []).includes('Files')) return;
    dragDepth++;
    this.dragging = true;
  },

  /** Accepts the drop (and keeps the browser from opening the file). */
  onDragOver() {},

  onDragLeave() {
    if (dragDepth && --dragDepth === 0) this.dragging = false;
  },

  /** Cmd/Ctrl+V in the page (browsers; desktop apps when the clipboard is not shared by itself). */
  onPaste(e: ClipboardEvent) {
    if (!this.manualClipboard || this.view !== 'main') return;
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    const files = Array.from(e.clipboardData?.files ?? []);
    if (files.length) {
      for (const f of files) this.send({ kind: 'file', blob: f, name: f.name || 'image.png' });
    } else {
      const text = e.clipboardData?.getData('text/plain');
      if (text) this.send({ kind: 'text', text });
    }
    e.preventDefault();
  },

  /**
   * Desktop apps: every copy goes to the relay at once, whether another device is online or not.
   * Contents above the group's limit are left to manual sending.
   */
  onLocalCopy(c: LocalCopy) {
    if (this.prefs.paused || !this.prefs.autoShare) return;
    if (c.kind === 'toobig') {
      const limit = humanSize(this.group?.autoMax);
      const how = this.t(this.mac ? 'toast.tooBigHowMac' : 'toast.tooBigHow');
      this.toast(this.t('toast.tooBig', { name: c.name, size: humanSize(c.size), limit, how }));
      return;
    }
    const o = c;
    const fp = fingerprint(o);
    if (fp === lastShared) return; // what we just received ourselves
    if (o.kind === 'folder' && needsConfirm(o.folder)) {
      // too large to go by itself: shown, and a notification says so (never its content)
      lastShared = fp;
      if (platform.notify) platform.notify('Entre Nous', this.t('notify.folderCopied', { name: o.folder.name, what: this.tn('folder.files', o.folder.files.length) }));
      this.sendFolder(o.folder, true);
      return;
    }
    lastShared = fp;
    this.send(o);
  },

  /** Android share target: files handed over by the service worker. */
  async handleSharedFiles() {
    if (!new URLSearchParams(location.search).has('share') || !('caches' in window)) return;
    history.replaceState(null, '', location.pathname);
    const cache = await caches.open('entrenous-share');
    const keys = await cache.keys();
    for (const req of keys) {
      const res = await cache.match(req);
      if (!res) continue;
      const blob = await res.blob();
      const name = decodeURIComponent(res.headers.get('X-Name') || this.t('name.shared'));
      await cache.delete(req);
      if (blob.type === 'text/plain' && name === 'texte') await this.send({ kind: 'text', text: await blob.text() });
      else await this.send({ kind: 'file', blob, name });
    }
  },

  // ---------------------------------------------------------------- share links

  /** A link can be made to an item whose content is entirely on the relay. */
  canShare(item: ItemView) {
    return !!this.groupId && !this.interrupted(item) && engine.canShare(this.groupId, item.id);
  },

  /** Makes a link to `item` (valid 1 h), on a page that slides in: QR code, link, lifetime. */
  async shareItem(item: ItemView) {
    const groupId = this.groupId;
    if (!groupId) return;
    this.confirming = '';
    this.share = null;
    this.shareQr = '';
    this.shareName = this.label(item);
    this.slide = '';
    this.view = 'share';
    try {
      // the web app: links to where it is served from (the relay may know itself by another name)
      this.showShare(await engine.createShare(groupId, item.id, SHARE_DEFAULT_TTL, this.native ? undefined : location.origin));
    } catch (err: any) {
      this.toast(failure('toast.error', err));
      this.closeShare();
    }
  },

  /** The page of a link already made (from its entry in the history). */
  openShare(share: ShareView) {
    this.confirming = '';
    this.shareName = this.shareLabel(share);
    this.slide = '';
    this.view = 'share';
    this.showShare(share);
  },

  showShare(share: ShareView) {
    this.share = share;
    const qr = qrcode(0, 'M');
    qr.addData(share.url);
    qr.make();
    this.shareQr = qr.createDataURL(6, 2);
  },

  closeShare() {
    this.share = null;
    this.shareQr = '';
    this.confirming = '';
    if (this.view !== 'share') return;
    this.slide = 'slide-back';
    this.view = this.groups.length ? 'main' : 'welcome';
    setTimeout(() => (this.slide = ''), 400);
  },

  /** The lifetimes offered (no longer than the server allows). */
  get shareTtls() {
    const max = this.group?.maxTtl ?? 7 * 86400;
    const current = this.share?.ttl;
    return SHARE_TTLS.filter((v) => v <= max).map((value) => ({
      value,
      label: this.t(('share.ttl.' + value) as Key),
      pressed: value === current ? 'true' : 'false',
    }));
  },

  get shareLeft() {
    return this.share ? this.t('share.left', { left: duration(this.share.expiresAt - this.now) }) : '';
  },

  /** Another lifetime for the link shown, from now: its address does not change. */
  async setShareTtl(ttl: number) {
    const share = this.share;
    if (!share || share.ttl === ttl || !this.groupId) return;
    try {
      await engine.setShareTtl(share.id, ttl);
      const now = engine.shares(this.groupId).find((s) => s.id === share.id);
      if (now && this.share?.id === share.id) this.share = now;
      this.now = Date.now();
    } catch (err: any) {
      if (err instanceof ShareGoneError) {
        this.toast(this.t('toast.shareGone'));
        this.closeShare();
      } else this.toast(failure('toast.error', err));
    }
  },

  /** Copies a link: not shared with the group by the desktop apps (it is not a copy of the user's). */
  copyShareLink(share: ShareView | null) {
    if (!share) return;
    lastShared = b64(hash(utf8(share.url)));
    platform
      .copy('text/plain', Promise.resolve({ text: share.url }))
      .then(() => this.toast(this.t('toast.linkCopied')))
      .catch((err) => this.toast(failure('toast.copyFailed', err)));
  },

  copyShownLink() {
    this.copyShareLink(this.share);
  },

  /** Deletes a link: it stops working at once (confirmed like a deletion). */
  async removeShare(share: ShareView) {
    const key = this.shareKey(share);
    if (this.prefs.confirmDelete && !this.isConfirming(key)) {
      this.askConfirm(key);
      return;
    }
    this.confirming = '';
    try {
      await engine.deleteShare(share.id);
      this.toast(this.t('toast.shareDeleted'));
    } catch (err: any) {
      this.toast(failure('toast.error', err));
    }
  },

  async removeShownShare() {
    const share = this.share;
    if (!share) return;
    await this.removeShare(share);
    if (!engine.shares(this.groupId ?? '').some((s) => s.id === share.id)) this.closeShare();
  },

  get removingShownShare() {
    return !!this.share && this.isConfirming(this.shareKey(this.share));
  },

  shareKey(share: { id: string }) {
    return 'share:' + share.id;
  },

  shareLabel(share: ShareView) {
    if (share.kind === 'text') return share.text ?? '';
    return share.name ?? this.t('name.file');
  },

  shareMeta(share: ShareView) {
    return this.t('share.label') + ' · ' + this.t('expires', { d: duration(share.expiresAt - this.now) });
  },

  /** The item's thumbnail, while it is still in the group. */
  shareThumb(share: ShareView) {
    return this.items.find((i) => i.id === share.itemId)?.thumb ?? '';
  },

  // ---------------------------------------------------------------- file requests

  /** A file request needs the relay: not in local mode. */
  get canDrop() {
    return !!this.group && !this.group.localOnly;
  },

  /**
   * The page of a file request, sliding in over the history: a new one (made at once, valid
   * 24 h), or one already open (from its entry in the history).
   */
  async openDrop(request?: DropView) {
    const groupId = this.groupId;
    if (!groupId) return;
    this.confirming = '';
    this.slide = '';
    this.view = 'drop';
    if (request) return this.showDrop(request);
    this.drop = null;
    this.dropQr = '';
    try {
      this.showDrop(await engine.createDrop(groupId));
    } catch (err: any) {
      this.toast(failure('toast.error', err));
      this.closeDrop();
    }
  },

  showDrop(request: DropView) {
    this.drop = request;
    const qr = qrcode(0, 'M');
    qr.addData(request.url);
    qr.make();
    this.dropQr = qr.createDataURL(6, 2);
  },

  closeDrop() {
    this.drop = null;
    this.dropQr = '';
    this.confirming = '';
    if (this.view !== 'drop') return;
    this.slide = 'slide-back';
    this.view = this.groups.length ? 'main' : 'welcome';
    setTimeout(() => (this.slide = ''), 400);
  },

  get dropTtls() {
    const max = this.group?.maxTtl ?? 7 * 86400;
    const current = this.drop?.ttl;
    return DROP_TTLS.filter((v) => v <= max).map((value) => ({
      value,
      label: this.t(('share.ttl.' + value) as Key),
      pressed: value === current ? 'true' : 'false',
    }));
  },

  get dropLeft() {
    return this.drop ? this.t('share.left', { left: duration(this.drop.expiresAt - this.now) }) : '';
  },

  /** A request gone from the server meanwhile: said, and its page closed. */
  dropFailed(err: any) {
    if (err instanceof DropGoneError) {
      this.toast(this.t('toast.shareGone'));
      this.closeDrop();
    } else this.toast(failure('toast.error', err));
  },

  async setDropTtl(ttl: number) {
    const request = this.drop;
    if (!request || request.ttl === ttl || !this.groupId) return;
    try {
      const now = await engine.setDropTtl(this.groupId, request.id, ttl);
      if (this.drop?.id === request.id) this.drop = now;
    } catch (err: any) {
      this.dropFailed(err);
    }
  },

  /** The message shown on the page of the link (saved once typed). */
  async setDropMessage(e: Event) {
    const request = this.drop;
    const msg = (e.target as HTMLInputElement).value.trim();
    if (!request || !this.groupId || msg === (request.msg ?? '')) return;
    try {
      const now = await engine.setDropMessage(this.groupId, request.id, msg);
      if (this.drop?.id === request.id) this.drop = now;
    } catch (err: any) {
      this.dropFailed(err);
    }
  },

  /** Copies the link (not shared with the group by the desktop apps: not a copy of the user's). */
  copyDropLink(request: DropView | null) {
    if (!request) return;
    lastShared = b64(hash(utf8(request.url)));
    platform
      .copy('text/plain', Promise.resolve({ text: request.url }))
      .then(() => this.toast(this.t('toast.linkCopied')))
      .catch((err) => this.toast(failure('toast.copyFailed', err)));
  },

  copyShownDropLink() {
    this.copyDropLink(this.drop);
  },

  /** Deletes a request, on every device: nothing more comes through it (confirmed like a deletion). */
  async removeDrop(request: DropView) {
    const key = this.dropKey(request);
    if (this.prefs.confirmDelete && !this.isConfirming(key)) {
      this.askConfirm(key);
      return;
    }
    this.confirming = '';
    if (!this.groupId) return;
    try {
      await engine.deleteDrop(this.groupId, request.id);
      this.toast(this.t('toast.shareDeleted'));
    } catch (err: any) {
      this.toast(failure('toast.error', err));
    }
  },

  async removeShownDrop() {
    const request = this.drop;
    if (!request) return;
    await this.removeDrop(request);
    if (!engine.drops(this.groupId ?? '').some((d) => d.id === request.id)) this.closeDrop();
  },

  get removingShownDrop() {
    return !!this.drop && this.isConfirming(this.dropKey(this.drop));
  },

  dropKey(request: { id: string }) {
    return 'request:' + request.id;
  },

  requestParts(request: DropView) {
    return this.marked(request.msg || this.t('drop.title'));
  },

  requestMeta(request: DropView) {
    const parts = request.msg ? [this.t('drop.title')] : [];
    if (request.received) parts.push(this.tn('drop.received', request.received), humanSize(request.bytes));
    parts.push(this.t('expires', { d: duration(request.expiresAt - this.now) }));
    return parts.join(' · ');
  },

  // ---------------------------------------------------------------- pairing

  showInvite() {
    if (!this.groupId) return;
    this.closeInvite();
    invite = engine.invite(
      this.groupId,
      (name) => {
        this.toast(this.t('toast.joined', { name }));
        this.closeInvite();
        this.view = 'main';
      },
      this.native ? undefined : location.origin,
    );
    const qr = qrcode(0, 'M');
    qr.addData(invite.url);
    qr.make();
    this.inviteQr = qr.createDataURL(6, 2);
    this.inviteUrl = invite.url;
    this.view = 'invite';
    const tick = () => {
      if (!invite) return;
      const left = invite.expiresAt - Date.now();
      if (left <= 0) {
        this.closeInvite();
        this.view = 'settings';
        this.toast(this.t('toast.inviteExpired'));
        return;
      }
      this.inviteLeft = duration(left);
      setTimeout(tick, 1000);
    };
    tick();
  },

  closeInvite() {
    invite?.cancel();
    invite = null;
    this.inviteQr = '';
    this.inviteUrl = '';
  },

  async join(link: string) {
    this.busy = true;
    try {
      const id = await engine.join(link);
      this.selectGroup(id);
      this.toast(this.t('toast.paired'));
      this.view = 'main';
    } catch (err: any) {
      this.toast(this.t('toast.pairFailed', { msg: err.message ?? err }));
    } finally {
      this.busy = false;
    }
  },

  /** iPhone: the invitation is used by Safari, without installing the app. */
  async joinInBrowser() {
    const link = installInvite;
    installInvite = null;
    if (link) await this.join(link);
    if (this.view === 'install') this.view = engine.groups.length ? 'main' : 'welcome';
  },

  joinFromLink() {
    const link = this.joinLink.trim();
    this.joinLink = '';
    if (link) this.join(link);
  },

  async startScan() {
    this.scanError = '';
    this.view = 'scan';
    try {
      scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    } catch {
      this.scanError = this.t('toast.cameraDenied');
      return;
    }
    const video = (this as any).$refs.video as HTMLVideoElement;
    video.srcObject = scanStream;
    await video.play().catch(() => {});
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    const loop = () => {
      if (!scanStream) return;
      if (video.readyState >= 2) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0);
        const code = jsQR(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height);
        if (code?.data?.includes('#p=')) {
          this.stopScan();
          this.join(code.data);
          return;
        }
      }
      requestAnimationFrame(loop);
    };
    loop();
  },

  stopScan() {
    scanStream?.getTracks().forEach((t) => t.stop());
    scanStream = null;
    if (this.view === 'scan') this.view = this.groups.length ? 'main' : 'welcome';
  },

  async install() {
    if (!installPrompt) return;
    installPrompt.prompt();
    await installPrompt.userChoice.catch(() => {});
    installPrompt = null;
    this.canInstall = false;
  },

  // ---------------------------------------------------------------- settings

  openSettings() {
    this.confirming = '';
    this.view = 'settings';
    if (this.groupId) engine.refreshStorage(this.groupId).catch(() => {});
  },

  /** Android back button: back to the main screen, then to the background. */
  onBack() {
    if (this.viewer.open) this.closeViewer();
    else if (this.folderAsk) this.cancelFolder();
    else if (this.folderView.open) folderOpen?.browser ? folderOpen.browser.back() : this.closeFolder();
    else if (this.view === 'scan') this.stopScan();
    else if (this.view === 'share') this.closeShare();
    else if (this.view === 'drop') this.closeDrop();
    else if (this.view === 'settings' || this.view === 'invite') this.back();
    else if (this.search.open) this.closeSearch();
    else platform.background?.();
  },

  back() {
    this.closeInvite();
    this.confirming = '';
    this.view = this.groups.length ? 'main' : 'welcome';
  },

  async renameDevice(e: Event) {
    const name = (e.target as HTMLInputElement).value.trim();
    if (name && name !== engine.device.name) await engine.renameDevice(name);
  },

  async renameGroup(e: Event) {
    const name = (e.target as HTMLInputElement).value.trim();
    if (name && this.groupId && name !== this.group?.name) await engine.renameGroup(this.groupId, name);
  },

  async setTtl(e: Event) {
    const ttl = Number((e.target as HTMLSelectElement).value);
    if (this.groupId) await engine.setTtl(this.groupId, ttl).catch((err) => this.toast(err.message));
  },

  toggleConfirmDelete() {
    this.prefs.confirmDelete = !this.prefs.confirmDelete;
    this.savePrefs();
  },

  toggleNotify() {
    this.prefs.notify = !this.prefs.notify;
    this.savePrefs();
  },

  async toggleAutostart() {
    const want = !this.autostart;
    try {
      this.autostart = await platform.autostart!.set(want);
      if (want && !this.autostart) this.toast(this.t('toast.autostartAllow'));
    } catch (err: any) {
      this.toast(this.t('toast.settingFailed', { msg: err?.message ?? err }));
    }
  },

  async setMaxItems(e: Event) {
    const max = Number((e.target as HTMLSelectElement).value);
    if (this.groupId) await engine.setMaxItems(this.groupId, max).catch((err) => this.toast(err.message));
  },

  async setAutoMax(e: Event) {
    const bytes = Number((e.target as HTMLSelectElement).value);
    if (this.groupId) await engine.setAutoMax(this.groupId, bytes).catch((err) => this.toast(err.message));
  },

  /** Settings, Server: the relay's version, once connected to it. */
  get relayVersionText() {
    const v = this.group?.relayVersion;
    if (v === undefined) return '';
    return v ? this.t('settings.relayVersion', { v }) : this.t('settings.relayVersionUnknown');
  },

  get storageText() {
    const st = this.group?.storage;
    if (!st) return '';
    return storageSpace(st.used, st.limit);
  },

  /** The width of the space bar; a sliver as soon as something is stored. */
  get storageBar() {
    const st = this.group?.storage;
    if (!st?.limit) return { width: '0%' };
    const pct = Math.min(100, (st.used / st.limit) * 100);
    return { width: (st.used > 0 ? Math.max(1, pct) : 0) + '%' };
  },

  get storageLow() {
    const st = this.group?.storage;
    return !!st && st.limit - st.used < st.limit * 0.1;
  },

  async toggleLocalOnly() {
    const on = !this.group?.localOnly;
    if (this.groupId) await engine.setLocalOnly(this.groupId, on).catch((err) => this.toast(err.message));
  },

  /** An upload line: from here (to the relay, or straight to a device), or by another device. */
  transferLabel(t: { name: string; direct?: boolean; peer?: string; from?: string }) {
    const name = t.name || this.t('name.text');
    if (t.from) return this.t('transfer.from', { name, from: t.from });
    if (!t.direct) return '↑ ' + name;
    return t.peer ? this.t('transfer.directTo', { name, peer: t.peer }) : this.t('transfer.direct', { name });
  },

  toggleAutoShare() {
    this.prefs.autoShare = !this.prefs.autoShare;
    this.savePrefs();
  },

  async createGroup() {
    // the first group gets the name the desktop apps give to theirs
    const name = this.newGroupName.trim() || this.t(this.groups.length ? 'group.new' : 'group.default');
    this.newGroupName = '';
    const id = await engine.createGroup(name);
    this.selectGroup(id);
    this.view = 'main';
  },

  /**
   * Native apps: server of the groups created from now on. The groups of this device alone
   * move there (created again, the old one deleted); a group shared with other devices stays
   * on its server, which the devices invited later join through the invitation link.
   */
  async saveRelay() {
    let url = this.relayInput.trim() || platform.defaultRelay;
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    let relay: string;
    try {
      relay = new URL(url).origin;
    } catch {
      this.toast(this.t('toast.relayInvalid'));
      return;
    }
    this.busy = true;
    try {
      if (!(await reachable(relay))) {
        this.toast(this.t('toast.relayUnreachable', { relay }));
        return;
      }
      this.prefs.relay = relay === platform.defaultRelay ? undefined : relay;
      this.savePrefs();
      engine.setDefaultRelay(relay);
      this.relayInput = relay;
      const me = engine.device.id;
      for (const g of engine.groups) {
        if (g.relay === relay || g.members.length !== 1) continue;
        const id = await engine.createGroup(g.name, relay);
        if (this.groupId === g.id) this.selectGroup(id);
        await engine.removeMember(g.id, me);
      }
      this.toast(this.t('toast.relaySaved'));
    } catch (err: any) {
      this.toast(this.t('toast.error', { msg: err.message ?? err }));
    } finally {
      this.busy = false;
    }
  },

  async removeMember(member: { id: string; name: string; me: boolean }) {
    const key = this.memberKey(member);
    if (!this.isConfirming(key)) {
      this.askConfirm(key);
      return;
    }
    this.confirming = '';
    try {
      await engine.removeMember(this.groupId!, member.id);
      this.toast(member.me ? this.t('toast.left') : this.t('toast.memberRemoved', { name: member.name }));
      if (member.me) this.back();
    } catch (err: any) {
      this.toast(this.t('toast.error', { msg: err.message ?? err }));
    }
  },

  async resetAll() {
    if (!this.isConfirming('reset')) {
      this.askConfirm('reset');
      return;
    }
    this.confirming = '';
    await engine.reset();
    location.reload();
  },

  /** A destructive button turns into its confirmation, back to normal after a few seconds. */
  askConfirm(key: string) {
    this.confirming = key;
    clearTimeout(confirmTimer);
    confirmTimer = setTimeout(() => {
      if (this.confirming === key) this.confirming = '';
    }, CONFIRM_FOR);
  },

  isConfirming(key: string) {
    return this.confirming === key;
  },

  dismissTransfer(t: { id: string }) {
    engine.dismissTransfer(t.id);
  },

  memberKey(member: { id: string }) {
    return 'member:' + member.id;
  },

  itemKey(item: { id: string }) {
    return 'item:' + item.id;
  },

  progress(t: { done: number; total: number; rate?: number }) {
    const pct = (t.total ? Math.round(Math.min(1, t.done / t.total) * 100) : 0) + (this.lang === 'fr' ? ' %' : '%');
    return t.rate ? `${pct} · ${humanSize(Math.round(t.rate))}/s` : pct;
  },

  /** Progress ring: dash offset of a circle of circumference 100. */
  ringOffset(t: { done: number; total: number }) {
    return t.total ? 100 - 100 * Math.min(1, t.done / t.total) : 100;
  },

  deviceCount(g: { members: unknown[] }) {
    return this.tn('devices', g.members.length);
  },

  platformLabel(p: string) {
    return { mac: 'Mac', linux: 'Linux', windows: 'Windows', android: 'Android', ios: 'iOS', cli: 'Terminal', desktop: this.t('device.browser') }[p] ?? p;
  },
}));

Alpine.start();

if ('serviceWorker' in navigator && !platform.native) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
