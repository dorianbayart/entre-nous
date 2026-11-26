import type { Platform } from '../core/group.ts';
import type { KV } from '../core/storage.ts';
import type { ByteSource } from '../core/folder.ts';

/** A file of a folder to send: its path in the folder, its bytes. */
export interface FolderSourceFile {
  path: string;
  size: number;
  mime: string;
  src: Blob | ByteSource;
  /** The whole file, for its preview (read from an app's native side: only when small enough). */
  blob(): Promise<Blob | null>;
}

/** A folder to send, as picked, dropped or copied. */
export interface FolderSource {
  name: string;
  files: FolderSourceFile[];
  /** Empty folders inside (the others come with their files). */
  dirs: string[];
  /** System files left out (.DS_Store, Thumbs.db…). */
  ignored: number;
  /** Bytes of the files, all together. */
  bytes: number;
  /** Read by an app's native side, which stopped at its limit (100,000 files): not sent. */
  truncated?: boolean;
}

/** Something to send, read from the local clipboard or picked by the user. */
export type Outgoing =
  | { kind: 'text'; text: string }
  | { kind: 'image' | 'file'; blob: Blob; name: string }
  | { kind: 'folder'; folder: FolderSource };

/** A local copy (desktop apps): the content, or just its size when it exceeds the auto-share limit. */
export type LocalCopy = Outgoing | { kind: 'toobig'; name: string; size: number };

/** A folder being saved by an app: its files are written one after the other. */
export interface FolderSink {
  /** Where it went, to say it ("Téléchargements/Vacances"). */
  readonly where: string;
  /** A file at `path` in the folder: its bytes are written in order. */
  file(path: string): Promise<{ write(data: Uint8Array): Promise<void>; close(): Promise<void> }>;
  /** An empty folder. */
  dir(path: string): Promise<void>;
}

export interface PlatformApi {
  kind: Platform;
  native: boolean;
  kv: KV;
  defaultName: string;
  defaultRelay: string;
  /** Desktop apps: the language of the system (its web view may not say it). */
  systemLang?: string;
  /** Desktop apps: the language of the interface, for the menu of the icon. */
  setLang?(lang: string): void;
  /** Can the app write the clipboard by itself, without a tap (Mac, Android)? */
  autoWrite: boolean;

  /**
   * Writes the clipboard. `content` is a promise so that browsers which require a user
   * gesture (Safari) keep it while the item downloads and decrypts.
   */
  copy(
    mime: string,
    content: Promise<{ text?: string; blob?: Blob; name?: string; expiresAt?: number }>,
  ): Promise<void>;
  /** Largest image `copy` can write (bytes); above, the Copy button is not shown. */
  imageCopyMax?: number;
  /** Reads the local clipboard (needs a tap on mobile; desktop apps: when not shared automatically). */
  read(): Promise<Outgoing | null>;
  /** Saves or shares a received file. */
  save(blob: Blob, name: string): Promise<void>;
  /** Opens a web link (`http`, `https`) in the browser; called during the tap (browsers need it). */
  openUrl(url: string): Promise<void>;
  /** Apps: picks a folder to send (browsers use <input webkitdirectory>); null: cancelled. */
  pickFolder?(): Promise<FolderSource | null>;
  /**
   * Apps: asks where to save a folder named `name` and creates it there (another name if it
   * exists); null: cancelled. Browsers save it with showDirectoryPicker, or as a ZIP.
   */
  saveFolder?(name: string): Promise<FolderSink | null>;
  /** Desktop apps: called when the user copies something locally. */
  onLocalCopy?(cb: (o: LocalCopy) => void): void;
  /** Desktop apps: copies larger than this (bytes) are not read nor shared automatically. */
  setAutoLimit?(bytes: number): void;
  /** Mac only: files, an image or a text dropped on the menu bar icon (sent at once). */
  onDrop?(cb: (o: Outgoing) => void): void;
  /** Mac only: the computer woke up (connections may be dead). */
  onWake?(cb: () => void): void;
  /** Desktop apps: system notification, shown while the window is closed. */
  notify?(title: string, body: string): void;

  /** During a transfer: keeps the screen on (phone) or the computer awake (Mac). */
  keepAwake?(on: boolean): void;

  /** Prepares the platform (device name…) before the engine loads. */
  init?(): Promise<void>;
  /** Android app: "Share -> Entre Nous" from another app. */
  onShare?(cb: (o: Outgoing) => void): void;
  /** Android app: an invitation link opened the app. */
  onLink?(cb: (url: string) => void): void;
  /** Android app: foreground (true) / background (false). */
  onAppState?(cb: (active: boolean) => void): void;
  /** Android app: back button; `background()` sends the app to the background. */
  onBack?(cb: () => void): void;
  background?(): void;
  /** Desktop apps: open at login (the system keeps the setting); `set` returns the new state. */
  autostart?: { get(): Promise<boolean>; set(on: boolean): Promise<boolean> };
  /** Desktop apps: pauses the clipboard watching (menu bar or tray icon and menu). */
  setPaused?(paused: boolean): void;
  /** Desktop apps: pause toggled from the menu bar or tray icon's menu. */
  onPauseRequest?(cb: (paused: boolean) => void): void;

  /**
   * Picture-in-picture where the web view has none (otherwise the browser's own is used):
   * the Android app becomes the small window itself; the Linux and Windows apps shrink their
   * window to the video and keep it above the others. The page then shows only the video.
   */
  pip?: {
    enter(width: number, height: number): Promise<void>;
    exit(): Promise<void>;
    /** In or out (the system's buttons too); `closed`: the small window was dismissed. */
    onChange(cb: (active: boolean, closed: boolean) => void): void;
    /** Android: a video plays (or not): leaving the app then turns it into the small window. */
    playing?(on: boolean, width: number, height: number): void;
    /** Android: the play/pause button of the small window. */
    onToggle?(cb: () => void): void;
  };
  /**
   * Android app: the song playing, told to the system (Bluetooth headset or car, lock screen,
   * notification), which sends back its buttons. Elsewhere, the page's Media Session does it.
   */
  media?: {
    set(m: NowPlaying): void;
    clear(): void;
    onAction(cb: (action: MediaAction, position?: number) => void): void;
  };
  /** Mac: shows the window (popover) again: back from the browser's picture-in-picture. */
  show?(): void;
  /** Mac: the keystrokes go to the page (its window key, the web view first responder), for a
   *  field it focuses. */
  focus?(): void;
}

/** The song playing, as the system shows it (seconds). */
export interface NowPlaying {
  title: string;
  artist: string;
  album: string;
  duration: number;
  position: number;
  playing: boolean;
  hasNext: boolean;
}

/** A button of the system (headset, car, lock screen): `seek` comes with its position. */
export type MediaAction = 'play' | 'pause' | 'prev' | 'next' | 'seek' | 'stop';
