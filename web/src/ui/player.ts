// Video streaming: a video plays while its chunks arrive, without being downloaded whole.
// Phones and screen recorders make MP4 or MOV files, often with their index (moov) at the end,
// which Media Source Extensions cannot read as they are: mp4box.js (BSD-3-Clause) reads the
// index wherever it is, then cuts the file into fragments that a SourceBuffer accepts.
// The bytes come from the engine's reader (decrypted on demand); MediaSource keeps the next
// 30 seconds or so in memory, the reader a few chunks: a 2 GB video plays with little memory.
import type { ContentReader } from '../core/engine.ts';
import { CHUNK_SIZE } from '../core/crypto.ts';

/** Buffered ahead of the playback position before reading further. */
const AHEAD = 30;
/** Kept behind it, the rest given back to the browser when it runs short of room. */
const BEHIND = 10;
/** Samples per fragment given to MediaSource (≈ 4 s at 25 frames per second). */
const SAMPLES_PER_SEGMENT = 100;

/** The video cannot be streamed here (no MediaSource, not an MP4, codec not supported). */
export class NotStreamable extends Error {}

/** MediaSource, or its managed variant (iPhone, iOS 17.1 and later: the only one there). */
function mediaSourceClass(): typeof MediaSource | undefined {
  return (window as any).MediaSource ?? (window as any).ManagedMediaSource;
}

export const canStream = () => !!mediaSourceClass();

interface Track {
  id: number;
  sb: SourceBuffer;
  queue: ArrayBuffer[];
}

/**
 * Plays `reader` (an MP4 or MOV file) in `video`. Resolves once playable, with the function
 * that stops it; rejects with NotStreamable when this browser cannot.
 */
export async function stream(video: HTMLVideoElement, reader: ContentReader): Promise<() => void> {
  const MS = mediaSourceClass();
  if (!MS) throw new NotStreamable('no MediaSource');
  const { createFile, MP4BoxBuffer } = await import('mp4box');
  const file = createFile();
  let failure: Error | undefined;
  file.onError = (_module: string, message: string) => (failure = new NotStreamable(message));
  let info: any;
  file.onReady = (movie: any) => (info = movie);

  let pos = 0; // next byte of the file mp4box wants
  let closed = false;

  /** Gives mp4box the bytes at `pos` (up to the end of their chunk); false at the end. */
  const feed = async () => {
    if (pos >= reader.size) return false;
    const end = Math.min((Math.floor(pos / CHUNK_SIZE) + 1) * CHUNK_SIZE, reader.size);
    const data = await reader.read(pos, end);
    if (closed) return false;
    const buffer = MP4BoxBuffer.fromArrayBuffer(data.slice().buffer, pos);
    const next = file.appendBuffer(buffer, !!info && end === reader.size);
    // mp4box says where to go on: past a big mdat to an index at the end, then back
    pos = typeof next === 'number' && next >= 0 && next !== pos ? next : end;
    // everything read: the last samples, fewer than a fragment, are handed over too
    if (info && pos >= reader.size) file.flush();
    return true;
  };

  // 0. an MP4 or a MOV starts with one of these boxes (a WebM, an AVI do not)
  const head = await reader.read(0, 8);
  const box = String.fromCharCode(...head.subarray(4, 8));
  if (!['ftyp', 'moov', 'mdat', 'free', 'skip', 'wide', 'pnot'].includes(box)) throw new NotStreamable('not an MP4');

  // 1. the index (moov): its tracks, their codecs, the length (a few reads, mp4box jumps)
  for (let reads = 0; !info && !failure && reads < 64 && (await feed()); reads++);
  if (failure) throw failure;
  if (!info) throw new NotStreamable('no index');
  const type = (t: any, kind: string) => `${kind}/mp4; codecs="${t.codec}"`;
  const videoTrack = info.videoTracks?.[0];
  if (!videoTrack || !MS.isTypeSupported(type(videoTrack, 'video'))) throw new NotStreamable('codec');
  const audioTrack = info.audioTracks?.find((t: any) => MS.isTypeSupported(type(t, 'audio'))); // or silent

  // 2. MediaSource, one SourceBuffer per track
  const ms = new MS();
  // the managed variant (iPhone) wants this, or an AirPlay alternative
  if (!(window as any).MediaSource) (video as any).disableRemotePlayback = true;
  const url = URL.createObjectURL(ms);
  video.src = url;
  await new Promise<void>((resolve) => ms.addEventListener('sourceopen', () => resolve(), { once: true }));
  const seconds = info.duration / info.timescale;
  if (Number.isFinite(seconds) && seconds > 0) ms.duration = seconds;
  const tracks = new Map<number, Track>();
  for (const [t, kind] of [[videoTrack, 'video'], ...(audioTrack ? [[audioTrack, 'audio']] : [])] as Array<[any, string]>) {
    const track: Track = { id: t.id, sb: ms.addSourceBuffer(type(t, kind)), queue: [] };
    tracks.set(t.id, track);
    file.setSegmentOptions(t.id, track, { nbSamples: SAMPLES_PER_SEGMENT });
  }

  // 3. appending, one fragment at a time per SourceBuffer
  let wake: () => void = () => {};
  const append = (t: Track) => {
    if (closed || t.sb.updating || !t.queue.length || ms.readyState === 'closed') return;
    try {
      t.sb.appendBuffer(t.queue[0]);
      t.queue.shift();
    } catch (err: any) {
      if (err?.name !== 'QuotaExceededError') throw err;
      // full: what was already played goes, then the append is tried again
      const before = video.currentTime - BEHIND;
      if (before > 0) t.sb.remove(0, before);
    }
  };
  for (const t of tracks.values()) {
    t.sb.addEventListener('updateend', () => {
      append(t);
      wake();
    });
  }
  for (const init of file.initializeSegmentation('per-track')) {
    const t = tracks.get(init.id);
    if (!t) continue;
    t.queue.push(init.buffer);
    append(t);
  }
  file.onSegment = (id: number, user: unknown, buffer: ArrayBuffer, nextSample: number) => {
    const t = user as Track;
    t.queue.push(buffer);
    append(t);
    file.releaseUsedSamples(id, nextSample); // mp4box frees what it has handed over
  };
  file.start();
  // the index read (perhaps at the end of the file): back to the first samples
  pos = file.seek(0, true).offset;

  // 4. reading on, while less than AHEAD seconds are buffered
  const ahead = () => {
    let least = Infinity;
    for (const t of tracks.values()) {
      const b = t.sb.buffered;
      let end = video.currentTime;
      for (let i = 0; i < b.length; i++) if (b.start(i) <= video.currentTime + 0.3 && b.end(i) > end) end = b.end(i);
      least = Math.min(least, end - video.currentTime);
    }
    return least;
  };
  const queued = () => [...tracks.values()].some((t) => t.queue.length > 1);
  const ended = () => {
    if (ms.readyState !== 'open' || [...tracks.values()].some((t) => t.sb.updating || t.queue.length)) return;
    try {
      ms.endOfStream();
    } catch {}
  };
  const onSeeking = () => {
    if (ahead() > 0.5) return; // already there
    for (const t of tracks.values()) t.queue = [];
    const at = file.seek(video.currentTime, true);
    pos = at.offset;
    if (pos >= reader.size) file.processSamples(true); // its data is still held by mp4box
    wake();
  };
  video.addEventListener('seeking', onSeeking);
  const wakers = ['timeupdate', 'seeking', 'play', 'waiting'];
  const poke = () => wake();
  for (const e of wakers) video.addEventListener(e, poke);

  (async () => {
    while (!closed) {
      if (pos < reader.size && ahead() < AHEAD && !queued()) {
        try {
          await feed();
        } catch (err) {
          if (closed) return;
          video.dispatchEvent(new CustomEvent('streamerror', { detail: err }));
          return;
        }
        continue;
      }
      if (pos >= reader.size) ended();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 1000);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
  })();

  return () => {
    if (closed) return;
    closed = true;
    wake();
    video.removeEventListener('seeking', onSeeking);
    for (const e of wakers) video.removeEventListener(e, poke);
    try {
      file.stop();
    } catch {}
    reader.close();
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  };
}
