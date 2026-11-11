import type { Platform } from '../core/group.ts';
import type { KV } from '../core/storage.ts';

/** Something to send, read from the local clipboard or picked by the user. */
export type Outgoing = { kind: 'text'; text: string } | { kind: 'image' | 'file'; blob: Blob; name: string };

/** A local copy (desktop apps): the content, or just its size when it exceeds the auto-share limit. */
export type LocalCopy = Outgoing | { kind: 'toobig'; name: string; size: number };

export interface PlatformApi {
  kind: Platform;
  native: boolean;
  kv: KV;
  defaultName: string;
  defaultRelay: string;
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
  /** Reads the local clipboard (needs a tap on mobile). */
  read(): Promise<Outgoing | null>;
  /** Saves or shares a received file. */
  save(blob: Blob, name: string): Promise<void>;
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
  /** Desktop apps: pauses the clipboard watching (menu bar or tray icon and menu). */
  setPaused?(paused: boolean): void;
  /** Desktop apps: pause toggled from the menu bar or tray icon's menu. */
  onPauseRequest?(cb: (paused: boolean) => void): void;
}
