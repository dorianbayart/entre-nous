// The song playing, told to the system: its name on a Bluetooth headset or car radio, the lock
// screen, the media keys; their buttons (play, pause, previous, next, seek) come back here.
// The Android app does it natively (its web view has no Media Session); the browsers and the
// other apps use the page's.
import type { MediaAction, NowPlaying, PlatformApi } from '../platform/types.ts';

export interface NowPlayingApi {
  set(m: NowPlaying): void;
  clear(): void;
}

const ACTIONS: Array<[MediaSessionAction, MediaAction]> = [
  ['play', 'play'],
  ['pause', 'pause'],
  ['previoustrack', 'prev'],
  ['nexttrack', 'next'],
  ['seekto', 'seek'],
  ['stop', 'stop'],
];

export function nowPlaying(platform: PlatformApi, onAction: (a: MediaAction, position?: number) => void): NowPlayingApi {
  const media = platform.media;
  if (media) {
    media.onAction(onAction);
    return { set: (m) => media.set(m), clear: () => media.clear() };
  }
  const session = typeof navigator !== 'undefined' ? navigator.mediaSession : undefined;
  if (!session) return { set() {}, clear() {} };
  const handle = (name: MediaSessionAction, on: boolean) => {
    const action = ACTIONS.find(([n]) => n === name)![1];
    try {
      session.setActionHandler(name, on ? (d) => onAction(action, d.seekTime ?? undefined) : null);
    } catch {
      // an action this browser does not know
    }
  };
  const artwork = [{ src: new URL('icon-512.png', location.href).href, sizes: '512x512', type: 'image/png' }];
  return {
    set(m) {
      if (typeof MediaMetadata !== 'undefined') session.metadata = new MediaMetadata({ title: m.title, artist: m.artist, album: m.album, artwork });
      session.playbackState = m.playing ? 'playing' : 'paused';
      // no "next" button at the end of the list
      for (const [name] of ACTIONS) handle(name, name !== 'nexttrack' || m.hasNext);
      if (m.duration > 0 && Number.isFinite(m.duration)) {
        try {
          session.setPositionState({ duration: m.duration, position: Math.min(Math.max(m.position, 0), m.duration), playbackRate: 1 });
        } catch {
          // not in this browser
        }
      }
    },
    clear() {
      session.metadata = null;
      session.playbackState = 'none';
      for (const [name] of ACTIONS) handle(name, false);
    },
  };
}
