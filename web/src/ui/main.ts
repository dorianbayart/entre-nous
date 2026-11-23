// UI of Entre Nous (PWA and Mac app), with the CSP build of Alpine.js: no eval, so the
// page runs under a strict Content Security Policy.
import Alpine from '@alpinejs/csp';
import qrcode from 'qrcode-generator';
import jsQR from 'jsqr';
import { Engine, ItemGoneError, SendCancelledError, UPLOAD_STALLED, type ItemView, type Invite } from '../core/engine.ts';
import { hash } from '../core/crypto.ts';
import { b64, utf8 } from '../core/bytes.ts';
import { desktopPlatform, isDesktopApp } from '../platform/desktop.ts';
import { androidPlatform, isAndroidApp } from '../platform/android.ts';
import { isIOS, isStandalone, webPlatform } from '../platform/web.ts';
import { webrtcAvailable, webrtcLinks } from '../core/webrtc.ts';
import type { LocalCopy, Outgoing, PlatformApi } from '../platform/types.ts';
import { LANGS, duration, humanSize, lang as currentLang, pick, setLang, systemLangs, t as translate, tn as translateN, type Key, type Lang } from '../i18n/index.ts';

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
let pendingLocal: Outgoing | undefined;
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
  o.kind === 'text' ? b64(hash(utf8(o.text))) : `${o.kind}:${o.name}:${o.blob.size}:${o.blob.type}`;

async function thumbnail(blob: Blob): Promise<string | undefined> {
  try {
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, 240 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.7);
  } catch {
    return undefined;
  }
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
  noteEmpty: true,
  toastText: '',
  toastTimer: undefined as ReturnType<typeof setTimeout> | undefined,
  busy: false,
  confirming: '' as string,
  inviteQr: '',
  inviteUrl: '',
  inviteLeft: '',
  joinLink: '',
  newGroupName: '',
  scanError: '',
  canInstall: false,
  now: Date.now(),
  dragging: false,
  relayInput: platform.defaultRelay,
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
    engine.on((e) => {
      if (e.type === 'change') this.refresh();
      else if (e.type === 'incoming') {
        this.onIncoming(e.groupId, e.item);
        this.notifyIncoming(e.item);
      } else if (e.type === 'synced') this.onSynced(e.groupId);
      else if (e.type === 'presence') this.onPresence(e.groupId);
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
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      installPrompt = e;
      this.canInstall = true;
    });
    document.addEventListener('paste', (e) => this.onPaste(e as ClipboardEvent));
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
      } else engine.background(); // a transfer in progress goes on, then it disconnects
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
    if (!v || !platform.notify || this.prefs.updateNotified === v) return;
    this.prefs.updateNotified = v;
    this.savePrefs();
    platform.notify('Entre Nous', this.t('update.notify', { v }));
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
    if (text.trim()) await this.send({ kind: 'text', text });
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
    pendingLocal = undefined; // a copy made before the pause is not sent afterwards
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
    const lines: any[] = [...this.sending];
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

  transferState(t: { error?: string; paused?: boolean; done: number; total: number; rate?: number }) {
    if (t.error) return t.error;
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
    if (item.kind === 'text') return true;
    if (item.kind === 'image') return !platform.imageCopyMax || (item.size ?? 0) <= platform.imageCopyMax;
    return this.desktop; // desktop apps paste any file
  },

  /** Also while it is being uploaded: the download follows the upload. */
  canSave(item: ItemView) {
    return !item.error && !item.unavailable && !this.interrupted(item) && item.kind !== 'text';
  },

  /** Copy keeps the user gesture: the content is passed as a promise. */
  copy(item: ItemView) {
    const groupId = this.groupId!;
    const mime = item.kind === 'text' ? 'text/plain' : (item.mime ?? 'application/octet-stream');
    platform
      .copy(mime, engine.content(groupId, item.id).then((c) => ({ ...c, expiresAt: item.expiresAt })))
      .then(() => this.toast(this.t('toast.copied')))
      .catch((err) => this.toast(failure('toast.copyFailed', err)));
  },

  async save(item: ItemView) {
    try {
      const c = await engine.content(this.groupId!, item.id);
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
    if (item.kind === 'file' && !this.desktop) return;
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
    const what = item.kind === 'text' ? 'notify.text' : item.kind === 'image' ? 'notify.image' : 'notify.file';
    platform.notify('Entre Nous', this.t(what, { name: item.fromName }));
  },

  // ---------------------------------------------------------------- sending

  async send(o: Outgoing) {
    if (!this.groupId) return;
    try {
      if (o.kind === 'text') {
        await engine.sendText(this.groupId, o.text);
      } else {
        const isImage = o.blob.type.startsWith('image/') && o.blob.size < 50 * 1024 * 1024;
        const thumb = isImage ? await thumbnail(o.blob) : undefined;
        await engine.sendBlob(this.groupId, o.blob, o.name, isImage ? 'image' : 'file', { thumb });
      }
      this.toast(this.t('toast.sent'));
    } catch (err: any) {
      if (err.message === 'full') this.toast(this.t('toast.full'));
      else if (err instanceof SendCancelledError) this.toast(err.message);
      else this.toast(this.t('toast.error', { msg: err.message ?? err }));
    }
  },

  async sendClipboard() {
    try {
      const o = await platform.read();
      if (!o) {
        this.toast(this.t('toast.clipboardEmpty'));
        return;
      }
      await this.send(o);
    } catch (err: any) {
      this.toast(this.t('toast.clipboardDenied'));
    }
  },

  pickFiles() {
    ((this as any).$refs.file as HTMLInputElement).click();
  },

  async onFiles(e: Event) {
    const input = e.target as HTMLInputElement;
    for (const f of Array.from(input.files ?? [])) await this.send({ kind: 'file', blob: f, name: f.name });
    input.value = '';
  },

  /** Files dropped on the main screen (elsewhere, the drop is only kept from opening them). */
  onDrop(e: DragEvent) {
    dragDepth = 0;
    this.dragging = false;
    if (this.view !== 'main') return;
    for (const f of Array.from(e.dataTransfer?.files ?? [])) this.send({ kind: 'file', blob: f, name: f.name });
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
   * Mac: every copy is shared while another device of the group is online (otherwise with
   * the first one that comes). Contents above the group's limit are left to manual sending.
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
    pendingLocal = o;
    if (!this.others.some((m) => m.online)) return;
    lastShared = fp;
    this.send(o);
  },

  /** Mac: a device comes online -> it gets the current clipboard. */
  onPresence(groupId: string) {
    const o = pendingLocal;
    if (!this.desktop || this.prefs.paused || !this.prefs.autoShare || groupId !== this.groupId || !o) return;
    const fp = fingerprint(o);
    if (fp === lastShared) return;
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
    if (this.view === 'scan') this.stopScan();
    else if (this.view === 'settings' || this.view === 'invite') this.back();
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

  get storageText() {
    const st = this.group?.storage;
    if (!st) return '';
    return this.t('storage.space', { free: humanSize(Math.max(0, st.limit - st.used)), total: humanSize(st.limit) });
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
    const pct = (t.total ? Math.round((t.done / t.total) * 100) : 0) + (this.lang === 'fr' ? ' %' : '%');
    return t.rate ? `${pct} · ${humanSize(Math.round(t.rate))}/s` : pct;
  },

  /** Progress ring: dash offset of a circle of circumference 100. */
  ringOffset(t: { done: number; total: number }) {
    return t.total ? 100 - (100 * t.done) / t.total : 100;
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
