// UI of Entre Nous (PWA and Mac app), with the CSP build of Alpine.js: no eval, so the
// page runs under a strict Content Security Policy.
import Alpine from '@alpinejs/csp';
import qrcode from 'qrcode-generator';
import jsQR from 'jsqr';
import { Engine, ItemGoneError, type ItemView, type Invite } from '../core/engine.ts';
import { hash } from '../core/crypto.ts';
import { b64, utf8 } from '../core/bytes.ts';
import { desktopPlatform, isDesktopApp } from '../platform/desktop.ts';
import { androidPlatform, isAndroidApp } from '../platform/android.ts';
import { isIOS, isStandalone, webPlatform } from '../platform/web.ts';
import { webrtcAvailable, webrtcLinks } from '../core/webrtc.ts';
import type { LocalCopy, Outgoing, PlatformApi } from '../platform/types.ts';

const platform: PlatformApi = isDesktopApp() ? desktopPlatform() : isAndroidApp() ? androidPlatform() : webPlatform();

const TTL_CHOICES = [
  { value: 600, label: '10 minutes' },
  { value: 3600, label: '1 heure' },
  { value: 86400, label: '24 heures' },
  { value: 7 * 86400, label: '7 jours' },
];
const MAX_ITEMS_CHOICES = [
  { value: 1, label: '1 élément' },
  { value: 10, label: '10 éléments' },
  { value: 0, label: 'Illimitée' },
];
const MB = 1024 * 1024;
const AUTO_MAX_CHOICES = [
  { value: MB, label: '1 Mo' },
  { value: 10 * MB, label: '10 Mo' },
  { value: 100 * MB, label: '100 Mo' },
];
const MAILBOX_AGE = 60_000; // an item received while closed is copied at opening if younger

interface Prefs {
  autoShare: boolean;
  paused: boolean;
  confirmDelete: boolean;
  notify: boolean; // desktop apps: notification on reception
  groupId: string | null;
  relay?: string; // native apps: server of new groups, when not the default one
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
let lastShared = '';
let pendingLocal: Outgoing | undefined;
let noteTypedAt = 0;
const copiedIds = new Set<string>(); // items already written to the clipboard here
let noteRetry: ReturnType<typeof setTimeout> | undefined;
let awake = false; // screen (phone) or system (Mac) kept awake during a transfer
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
const failure = (prefix: string, err: any) => (err instanceof ItemGoneError ? err.message : prefix + (err?.message ?? err));

function humanSize(n = 0) {
  const fr = (x: number, digits: number) => x.toFixed(digits).replace('.', ',').replace(/,0+$/, '');
  if (n < 1024) return `${n} o`;
  if (n < 1024 ** 2) return `${fr(n / 1024, 0)} Ko`;
  if (n < 1024 ** 3) return `${fr(n / 1024 ** 2, 1)} Mo`;
  return `${fr(n / 1024 ** 3, 1)} Go`;
}

function duration(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 2 * 86400) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86400)} j`;
}

Alpine.data('app', () => ({
  view: 'loading' as string,
  platform: platform.kind,
  native: platform.native, // bundled app (Mac, Android): the code does not come from the relay
  mac: platform.kind === 'mac',
  desktop: !!platform.onLocalCopy, // desktop app (Mac, Linux, Windows): watches the clipboard
  ios: isIOS,
  standalone: isStandalone,
  device: { id: '', name: '' },
  groups: [] as ReturnType<Engine['groupView']>[],
  groupId: null as string | null,
  transfers: [] as any[],
  prefs: {
    autoShare: true,
    paused: false,
    confirmDelete: true,
    notify: true,
    groupId: null,
  } as Prefs,
  maxItemsChoices: MAX_ITEMS_CHOICES,
  autoMaxChoices: AUTO_MAX_CHOICES,
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
  ttlChoices: TTL_CHOICES,
  dragging: false,
  relayInput: platform.defaultRelay,

  async init() {
    await platform.init?.();
    this.prefs = { ...this.prefs, ...((await platform.kv.get<Prefs>('prefs')) ?? {}) };
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
      else if (e.type === 'removed') this.toast(`Cet appareil a été retiré de « ${e.groupName} »`);
      else if (e.type === 'error') this.toast(e.message);
    });
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
      if (isIOS && !isStandalone) this.view = 'install';
      else this.join(link);
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
    if (engine.groups.length === 0 && !mobile && !pendingInvite) await engine.createGroup('Mes appareils');
    engine.start();
    this.refresh();

    if (pendingInvite) {
      if (isIOS && !isStandalone) {
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
    // An announced upload shows its progress in the history, not in this list.
    const listed = new Set(this.groups.flatMap((g) => g.items.map((i) => i.id)));
    this.transfers = [...engine.transfers.values()]
      .filter((t) => !(t.itemId && listed.has(t.itemId) && !t.error))
      .map((t) => ({ ...t }));
    if (engine.busy !== awake) {
      awake = engine.busy;
      platform.keepAwake?.(awake);
    }
    if (this.group) platform.setAutoLimit?.(this.group.autoMax);
    if (this.view === 'main' && !this.groups.length) this.view = 'welcome';
    this.showNote();
  },

  // ---------------------------------------------------------------- live note

  get note() {
    return this.group?.note ?? null;
  },

  get noteInfo() {
    const n = this.note;
    if (!n) return '';
    const who = n.mine ? 'Moi' : n.byName;
    return n.expiresAt ? `${who} · expire dans ${duration(n.expiresAt - this.now)}` : who;
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
      this.toast('Envoyé au serveur');
    } catch (err: any) {
      this.toast(/^Envoi annulé/.test(err.message) ? err.message : 'Erreur : ' + (err.message ?? err));
    }
  },

  copyNote() {
    const text = ((this as any).$refs.note as HTMLTextAreaElement).value;
    if (!text) return;
    lastShared = b64(hash(utf8(text)));
    platform
      .copy('text/plain', Promise.resolve({ text }))
      .then(() => this.toast('Copié'))
      .catch((err) => this.toast('Copie impossible : ' + (err.message ?? err)));
  },

  clearNote() {
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
    this.toast(paused ? 'En pause : l’envoi automatique du presse-papier est désactivé.' : 'Envoi automatique réactivé');
  },

  get shareHint() {
    if (this.prefs.paused) return 'En pause : l’envoi automatique du presse-papier est désactivé.';
    if (!this.prefs.autoShare) return 'Envoi automatique désactivé (voir Réglages).';
    return '';
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
    if (g.status !== 'online') return g.status === 'connecting' ? 'Connexion…' : 'Hors ligne';
    const online = this.others.filter((m) => m.online).map((m) => m.name);
    if (!this.others.length) return 'Aucun autre appareil : invites-en un depuis les Réglages';
    return online.length ? `En ligne : ${online.join(', ')}` : 'Aucun autre appareil en ligne';
  },

  get ttlOptions() {
    const max = this.group?.maxTtl ?? 7 * 86400;
    return TTL_CHOICES.filter((c) => c.value <= max);
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
    return ms < 60_000 ? 'à l’instant' : 'il y a ' + duration(ms);
  },

  left(item: ItemView) {
    if (item.unavailable) return `réseau local · « ${item.fromName} » n’est pas connecté`;
    if (item.local) return 'réseau local · expire dans ' + duration(item.expiresAt - this.now);
    if (item.pending) return this.now - (item.progressAt ?? 0) > STALLED_AFTER ? 'envoi en pause' : 'envoi en cours';
    return 'expire dans ' + duration(item.expiresAt - this.now);
  },

  /** Upload progress of an item still being sent (on every device). */
  itemProgress(item: ItemView) {
    // stalled: its last speed means nothing any more
    const stalled = this.now - (item.progressAt ?? 0) > STALLED_AFTER;
    return this.progress({ done: item.have ?? 0, total: item.chunks, rate: stalled ? undefined : item.rate });
  },

  itemRingOffset(item: ItemView) {
    return this.ringOffset({ done: item.have ?? 0, total: item.chunks });
  },

  label(item: ItemView) {
    if (item.error) return 'Impossible à déchiffrer sur cet appareil';
    if (item.kind === 'text') return item.text ?? 'Texte resté sur le réseau local';
    return item.name ?? 'fichier';
  },

  /** Size shown in the item's details (texts too: their UTF-8 size). */
  sizeOf(item: ItemView) {
    if (item.error) return '';
    if (item.kind === 'text') return humanSize(item.text === undefined ? (item.size ?? 0) : utf8(item.text).length);
    return item.size != null ? humanSize(item.size) : '';
  },

  canCopy(item: ItemView) {
    if (item.error || item.unavailable) return false;
    if (item.kind === 'text' || item.kind === 'image') return true;
    return this.desktop; // desktop apps paste any file
  },

  canSave(item: ItemView) {
    return !item.error && !item.unavailable && item.kind !== 'text';
  },

  /** Copy keeps the user gesture: the content is passed as a promise. */
  copy(item: ItemView) {
    const groupId = this.groupId!;
    const mime = item.kind === 'text' ? 'text/plain' : (item.mime ?? 'application/octet-stream');
    platform
      .copy(mime, engine.content(groupId, item.id).then((c) => ({ ...c, expiresAt: item.expiresAt })))
      .then(() => this.toast('Copié'))
      .catch((err) => this.toast(failure('Copie impossible : ', err)));
  },

  async save(item: ItemView) {
    try {
      const c = await engine.content(this.groupId!, item.id);
      await platform.save(c.blob!, c.name ?? 'fichier');
    } catch (err: any) {
      this.toast(failure('Erreur : ', err));
    }
  },

  async remove(item: ItemView) {
    if (this.prefs.confirmDelete && this.confirming !== 'item:' + item.id) {
      this.confirming = 'item:' + item.id;
      return;
    }
    this.confirming = '';
    await engine.deleteItem(this.groupId!, item.id).catch((err) => this.toast(err.message));
  },

  /** Whole history of the group, for every member. Always confirmed. */
  async clearAll() {
    if (this.confirming !== 'clear') {
      this.confirming = 'clear';
      return;
    }
    this.confirming = '';
    try {
      await engine.clearAll(this.groupId!);
      this.clearNote();
      this.toast('Historique supprimé');
    } catch (err: any) {
      this.toast('Erreur : ' + (err.message ?? err));
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
    const what = item.kind === 'text' ? 'Texte reçu' : item.kind === 'image' ? 'Image reçue' : 'Fichier reçu';
    platform.notify('Entre Nous', `${what} de ${item.fromName}`);
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
        await engine.sendBlob(this.groupId, o.blob, o.name, isImage ? 'image' : 'file', thumb);
      }
      this.toast('Envoyé');
    } catch (err: any) {
      if (err.message === 'full') this.toast('Serveur saturé, réessaie plus tard');
      else if (/^Envoi annulé/.test(err.message)) this.toast(err.message);
      else this.toast('Erreur : ' + (err.message ?? err));
    }
  },

  async sendClipboard() {
    try {
      const o = await platform.read();
      if (!o) {
        this.toast('Presse-papier vide');
        return;
      }
      await this.send(o);
    } catch (err: any) {
      this.toast('Accès au presse-papier refusé');
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

  onDrop(e: DragEvent) {
    this.dragging = false;
    for (const f of Array.from(e.dataTransfer?.files ?? [])) this.send({ kind: 'file', blob: f, name: f.name });
  },

  onDragOver() {
    this.dragging = true;
  },

  onDragLeave() {
    this.dragging = false;
  },

  /** Cmd/Ctrl+V in the page (desktop browsers). */
  onPaste(e: ClipboardEvent) {
    if (this.desktop || this.view !== 'main') return;
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
      const how = this.mac ? 'envoie-le avec « Fichier » ou glisse-le sur l’icône' : 'envoie-le avec « Fichier »';
      this.toast(`${c.name} (${humanSize(c.size)}) dépasse ${limit} : ${how}`);
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
      const name = decodeURIComponent(res.headers.get('X-Name') || 'partage');
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
        this.toast(`${name} a rejoint le groupe`);
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
      this.toast('Appareil associé');
      this.view = 'main';
    } catch (err: any) {
      this.toast('Association impossible : ' + (err.message ?? err));
    } finally {
      this.busy = false;
    }
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
      this.scanError = "Accès à la caméra refusé";
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
    return `${humanSize(Math.max(0, st.limit - st.used))} disponibles sur ${humanSize(st.limit)}`;
  },

  get storageLow() {
    const st = this.group?.storage;
    return !!st && st.limit - st.used < st.limit * 0.1;
  },

  async toggleLocalOnly() {
    const on = !this.group?.localOnly;
    if (this.groupId) await engine.setLocalOnly(this.groupId, on).catch((err) => this.toast(err.message));
  },

  transferLabel(t: { direction: string; name: string; direct?: boolean; peer?: string }) {
    const way = t.direction === 'up' ? 'vers' : 'de';
    const direct = t.direct ? ' · en direct' + (t.peer ? ` ${way} ${t.peer}` : '') : '';
    return (t.direction === 'up' ? '↑ ' : '↓ ') + (t.name || 'texte') + direct;
  },

  toggleAutoShare() {
    this.prefs.autoShare = !this.prefs.autoShare;
    this.savePrefs();
  },

  async createGroup() {
    const name = this.newGroupName.trim() || 'Nouveau groupe';
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
      this.toast('Adresse invalide');
      return;
    }
    this.busy = true;
    try {
      if (!(await reachable(relay))) {
        this.toast('Serveur injoignable : ' + relay);
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
      this.toast('Serveur enregistré');
    } catch (err: any) {
      this.toast('Erreur : ' + (err.message ?? err));
    } finally {
      this.busy = false;
    }
  },

  async removeMember(member: { id: string; name: string; me: boolean }) {
    const key = 'member:' + member.id;
    if (this.confirming !== key) {
      this.confirming = key;
      return;
    }
    this.confirming = '';
    try {
      await engine.removeMember(this.groupId!, member.id);
      this.toast(member.me ? 'Tu as quitté le groupe' : `${member.name} a été retiré du groupe`);
      if (member.me) this.back();
    } catch (err: any) {
      this.toast('Erreur : ' + (err.message ?? err));
    }
  },

  async resetAll() {
    if (this.confirming !== 'reset') {
      this.confirming = 'reset';
      return;
    }
    this.confirming = '';
    await engine.reset();
    location.reload();
  },

  isConfirming(key: string) {
    return this.confirming === key;
  },

  memberKey(member: { id: string }) {
    return 'member:' + member.id;
  },

  itemKey(item: { id: string }) {
    return 'item:' + item.id;
  },

  progress(t: { done: number; total: number; rate?: number }) {
    const pct = (t.total ? Math.round((t.done / t.total) * 100) : 0) + ' %';
    return t.rate ? `${pct} · ${humanSize(Math.round(t.rate))}/s` : pct;
  },

  /** Progress ring: dash offset of a circle of circumference 100. */
  ringOffset(t: { done: number; total: number }) {
    return t.total ? 100 - (100 * t.done) / t.total : 100;
  },

  deviceCount(g: { members: unknown[] }) {
    const n = g.members.length;
    return n + (n > 1 ? ' appareils' : ' appareil');
  },

  platformLabel(p: string) {
    return { mac: 'Mac', linux: 'Linux', windows: 'Windows', android: 'Android', ios: 'iOS', desktop: 'Navigateur' }[p] ?? p;
  },
}));

Alpine.start();

if ('serviceWorker' in navigator && !platform.native) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
