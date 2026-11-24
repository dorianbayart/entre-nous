// Video and audio streaming: a video or a song plays while its chunks arrive, without being
// downloaded whole.
// Phones and screen recorders make MP4 or MOV files, often with their index (moov) at the end,
// which Media Source Extensions cannot read as they are: mp4box.js (BSD-3-Clause) reads the
// index wherever it is, then cuts the file into fragments that a SourceBuffer accepts.
// The bytes come from the engine's reader (decrypted on demand); MediaSource keeps the next
// 30 seconds or so in memory, the reader a few chunks: a 2 GB video plays with little memory.
// An MP3 needs none of that: MediaSource takes its frames as they are (see mp3.ts). Opus in
// Ogg (.opus), FLAC and WAV are put into MP4 fragments as they arrive (see opus.ts, flac.ts).
import type { ContentReader } from '../core/engine.ts';
import { CHUNK_SIZE } from '../core/crypto.ts';
import { frameAt, id3Size, offsetOf, syncFrom, vbrHeader, withoutId3v1 } from './mp3.ts';
import { OPUS_RATE, opusHead, opusInit, packetSamples, pageAt, syncPage, type OggPage } from './opus.ts';
import { mediaSegment } from './fmp4.ts';
import { WAV_BLOCK, flacFrames, flacInit, flacMetadata, flacSync, wavFormat, wavFrame, wavStreamInfo, type StreamInfo } from './flac.ts';

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

const MP4_BOXES = ['ftyp', 'moov', 'mdat', 'free', 'skip', 'wide', 'pnot'];

/**
 * Plays `reader` in `media`: an MP4 or a MOV (a video, or an M4A song in an audio element),
 * an MP3, Opus in Ogg, FLAC or WAV (in an audio element). `duration`: its length in seconds, when the
 * sender gave it. Resolves once playable, with the function that stops it; rejects with
 * NotStreamable when this browser cannot.
 */
export async function stream(media: HTMLMediaElement, reader: ContentReader, { duration }: { duration?: number } = {}): Promise<() => void> {
  const MS = mediaSourceClass();
  if (!MS) throw new NotStreamable('no MediaSource');
  const head = await reader.read(0, Math.min(reader.size, 10));
  // an MP4 or a MOV starts with one of these boxes (a WebM, an AVI do not)
  if (MP4_BOXES.includes(String.fromCharCode(...head.subarray(4, 8)))) return streamMp4(MS, media, reader);
  if (media instanceof HTMLAudioElement) {
    const tag = String.fromCharCode(...head.subarray(0, 4));
    if (tag === 'OggS') return streamOpus(MS, media, reader, duration);
    if (tag === 'fLaC') return streamFrames(MS, media, reader, await flacSource(reader));
    if (tag === 'RIFF') return streamFrames(MS, media, reader, await wavSource(reader));
    if (id3Size(head) > 0 || frameAt(head, 0)) return streamMp3(MS, media, reader);
  }
  throw new NotStreamable('format');
}

/**
 * Appends to `sb`, one buffer at a time; when MediaSource is full, what was played goes first.
 * Resolves once the buffer is in (or the stream closed).
 */
function appender(sb: SourceBuffer, media: HTMLMediaElement, nap: (ms: number) => Promise<void>, closed: () => boolean) {
  const settled = () => new Promise<void>((resolve) => sb.addEventListener('updateend', () => resolve(), { once: true }));
  return async (bytes: Uint8Array) => {
    for (;;) {
      try {
        sb.appendBuffer(bytes as BufferSource);
      } catch (err: any) {
        if (err?.name !== 'QuotaExceededError') throw err;
        const before = media.currentTime - BEHIND;
        if (before > 1) {
          sb.remove(0, before);
          await settled();
        } else await nap(1000);
        if (closed()) return;
        continue;
      }
      await settled();
      return;
    }
  };
}

/** Wakes the reading loop: `wake()` ends the current wait at once. */
function sleeper() {
  let wake: () => void = () => {};
  return {
    wake: () => wake(),
    nap: (ms: number) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      }),
  };
}

/** Seconds buffered from the playback position on. */
function bufferedAhead(media: HTMLMediaElement, sb: SourceBuffer) {
  const b = sb.buffered;
  let end = media.currentTime;
  for (let i = 0; i < b.length; i++) if (b.start(i) <= media.currentTime + 0.3 && b.end(i) > end) end = b.end(i);
  return end - media.currentTime;
}

async function streamMp4(MS: typeof MediaSource, video: HTMLMediaElement, reader: ContentReader): Promise<() => void> {
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

  // 1. the index (moov): its tracks, their codecs, the length (a few reads, mp4box jumps)
  for (let reads = 0; !info && !failure && reads < 64 && (await feed()); reads++);
  if (failure) throw failure;
  if (!info) throw new NotStreamable('no index');
  const type = (t: any, kind: string) => `${kind}/mp4; codecs="${t.codec}"`;
  const song = video instanceof HTMLAudioElement; // the sound only
  const videoTrack = song ? undefined : info.videoTracks?.[0];
  if (!song && (!videoTrack || !MS.isTypeSupported(type(videoTrack, 'video')))) throw new NotStreamable('codec');
  const audioTrack = info.audioTracks?.find((t: any) => MS.isTypeSupported(type(t, 'audio'))); // or silent
  if (song && !audioTrack) throw new NotStreamable('codec');

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
  for (const [t, kind] of [...(videoTrack ? [[videoTrack, 'video']] : []), ...(audioTrack ? [[audioTrack, 'audio']] : [])] as Array<[any, string]>) {
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

/**
 * Plays `reader` (an MP3 file) in `audio`: its frames go to MediaSource as they come, which
 * times them itself ("sequence" mode). A jump outside of what is buffered starts again from
 * the frame found at that moment's place in the file.
 */
async function streamMp3(MS: typeof MediaSource, audio: HTMLMediaElement, reader: ContentReader): Promise<() => void> {
  const MPEG = 'audio/mpeg';
  if (!MS.isTypeSupported(MPEG)) throw new NotStreamable('codec');
  const chunkEnd = (at: number) => Math.min((Math.floor(at / CHUNK_SIZE) + 1) * CHUNK_SIZE, reader.size);

  // 1. the first frame, past the tags at the start, and its Xing/Info header (frames, contents)
  const tags = id3Size(await reader.read(0, Math.min(reader.size, 10)));
  if (tags >= reader.size) throw new NotStreamable('no audio');
  const data = await reader.read(tags, Math.min(reader.size, Math.max(chunkEnd(tags), tags + 64 * 1024)));
  const at = syncFrom(data, 0);
  if (at < 0) throw new NotStreamable('not an MP3');
  const first = frameAt(data, at)!;
  const vbr = vbrHeader(data, at, first);
  const start = tags + at + (vbr ? first.length : 0); // the Xing/Info frame is silence: skipped
  const end = reader.size; // an ID3v1 tag at the very end is cut when it is reached
  const duration = vbr?.frames ? (vbr.frames * first.samples) / first.sampleRate : ((end - start) * 8) / first.bitrate;

  // 2. MediaSource, one SourceBuffer
  const ms = new MS();
  if (!(window as any).MediaSource) (audio as any).disableRemotePlayback = true;
  const url = URL.createObjectURL(ms);
  audio.src = url;
  await new Promise<void>((resolve) => ms.addEventListener('sourceopen', () => resolve(), { once: true }));
  if (Number.isFinite(duration) && duration > 0) ms.duration = duration;
  const sb = ms.addSourceBuffer(MPEG);

  let pos = start; // next byte to give
  let jump: number | null = null; // a moment to go to, outside of what is buffered
  let closed = false;
  const { wake, nap } = sleeper();
  const append = appender(sb, audio, nap, () => closed);

  /** From moment `t`: its place in the file, then the next frame from there. */
  const goTo = async (t: number) => {
    const guess = Math.max(start, Math.min(offsetOf(t, duration, start, end, vbr?.toc), end - 1));
    const around = await reader.read(guess, Math.min(end, Math.max(chunkEnd(guess), guess + 16 * 1024)));
    if (closed) return;
    const i = syncFrom(around, 0, first);
    pos = i < 0 ? end : guess + i;
    if (ms.readyState === 'ended') sb.timestampOffset = t; // opens it again
    sb.abort(); // the frames given so far were for another moment
    sb.timestampOffset = t;
  };

  const onSeeking = () => {
    if (bufferedAhead(audio, sb) > 0.5) return; // already there
    jump = audio.currentTime;
    wake();
  };
  audio.addEventListener('seeking', onSeeking);
  const wakers = ['timeupdate', 'play', 'waiting'];
  for (const e of wakers) audio.addEventListener(e, wake);

  // 3. reading on, while less than AHEAD seconds are buffered
  (async () => {
    try {
      while (!closed) {
        if (jump !== null) {
          const t = jump;
          jump = null;
          await goTo(t);
          continue;
        }
        if (pos < end && bufferedAhead(audio, sb) < AHEAD) {
          const to = chunkEnd(pos);
          let bytes = await reader.read(pos, to);
          if (closed || jump !== null) continue; // a jump meanwhile: not needed any more
          if (to === end) bytes = withoutId3v1(bytes);
          pos = to;
          await append(bytes);
          continue;
        }
        if (pos >= end && ms.readyState === 'open' && !sb.updating) {
          try {
            ms.endOfStream();
          } catch {}
        }
        await nap(1000);
      }
    } catch (err) {
      if (!closed) audio.dispatchEvent(new CustomEvent('streamerror', { detail: err }));
    }
  })();

  return () => {
    if (closed) return;
    closed = true;
    wake();
    audio.removeEventListener('seeking', onSeeking);
    for (const e of wakers) audio.removeEventListener(e, wake);
    reader.close();
    audio.removeAttribute('src');
    audio.load();
    URL.revokeObjectURL(url);
  };
}

/**
 * Plays `reader` (Opus in Ogg) in `audio`: its pages are read as they come, their packets put
 * into MP4 fragments of about a second, timed by the pages' positions. A jump starts from the
 * first page found at that moment's place in the file, at that moment or a little before.
 */
async function streamOpus(MS: typeof MediaSource, audio: HTMLMediaElement, reader: ContentReader, known?: number): Promise<() => void> {
  const TYPE = 'audio/mp4; codecs="opus"';
  if (!MS.isTypeSupported(TYPE)) throw new NotStreamable('codec');
  const size = reader.size;
  const chunkEnd = (at: number) => Math.min((Math.floor(at / CHUNK_SIZE) + 1) * CHUNK_SIZE, size);

  // 1. the first page: the stream, and its OpusHead (a Vorbis file stops here)
  const first = await reader.read(0, Math.min(size, 64 * 1024));
  const p0 = pageAt(first, 0);
  const head = p0?.parts[0] ? opusHead(p0.parts[0]) : null;
  if (!p0 || !head) throw new NotStreamable('not Opus');
  const serial = p0.serial;
  // its length: given by the sender, else the position of the last page
  let duration = known ?? 0;
  if (!duration) {
    const tail = await reader.read(Math.max(0, size - 65536), size);
    for (let i = syncPage(tail, 0, serial); i >= 0; i = syncPage(tail, i + 1, serial)) {
      const g = pageAt(tail, i)!.granule;
      if (g > 0) duration = (g - head.preSkip) / OPUS_RATE;
    }
  }

  // 2. MediaSource, one SourceBuffer, the initialization segment
  const ms = new MS();
  if (!(window as any).MediaSource) (audio as any).disableRemotePlayback = true;
  const url = URL.createObjectURL(ms);
  audio.src = url;
  await new Promise<void>((resolve) => ms.addEventListener('sourceopen', () => resolve(), { once: true }));
  if (duration > 0) ms.duration = duration;
  const sb = ms.addSourceBuffer(TYPE);
  let closed = false;
  const { wake, nap } = sleeper();
  const append = appender(sb, audio, nap, () => closed);
  await append(opusInit(head));

  // 3. the pages, read on from `pos`; `buf`: bytes read but not yet taken (they end at `pos`)
  let pos = 0;
  let buf = new Uint8Array(0);
  let atEnd = false;
  let headers = 2; // OpusHead, OpusTags: not audio
  let audioStart = 0; // first byte of the audio pages
  let partial: Uint8Array[] = []; // a packet begun on an earlier page
  let dropping = false; // after a jump: the end of a packet begun before, not wanted
  let timed = true; // after a jump: false until a page gives its position
  let next = 0; // sample at which the next packet starts
  let packets: Uint8Array[] = [];
  let samples: number[] = [];
  let start = 0; // sample of packets[0]
  let sequence = 0;
  let jump: number | null = null;

  const join = (parts: Uint8Array[]) => {
    if (parts.length === 1) return parts[0].slice();
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) out.set(p, (at += p.length) - p.length);
    return out;
  };

  /** The next whole page of the stream; null at the end of the file. */
  const nextPage = async (): Promise<OggPage | null> => {
    for (;;) {
      const i = syncPage(buf, 0, serial);
      if (i >= 0) {
        const page = pageAt(buf, i)!;
        buf = buf.subarray(i + page.length);
        return page;
      }
      if (pos >= size) return null;
      // a page is at most 65,307 bytes: no need to keep more of what has none
      const keep = buf.length > 65536 ? buf.subarray(buf.length - 65536) : buf;
      const to = chunkEnd(pos);
      const data = await reader.read(pos, to);
      if (closed || jump !== null) return null;
      buf = join([keep, data]);
      pos = to;
    }
  };

  /** Takes the packets a page completes, timed from where the previous ones ended. */
  const take = (page: OggPage) => {
    const done: Uint8Array[] = [];
    page.parts.forEach((part, k) => {
      if (dropping) {
        if (page.ends[k]) dropping = false;
        return;
      }
      partial.push(part);
      if (page.ends[k]) {
        done.push(join(partial));
        partial = [];
      }
    });
    let audioPackets = done;
    if (headers > 0) {
      audioPackets = done.slice(headers);
      headers = Math.max(0, headers - done.length);
      if (headers === 0) audioStart = pos - buf.length; // the next page is the first one of audio
    }
    const lengths = audioPackets.map(packetSamples);
    if (!timed) {
      if (page.granule < 0) return; // nothing ends on this page
      next = page.granule - lengths.reduce((n, x) => n + x, 0);
      timed = true;
    }
    audioPackets.forEach((p, k) => {
      if (!packets.length) start = next;
      packets.push(p);
      samples.push(lengths[k]);
      next += lengths[k];
    });
  };

  const flush = async () => {
    if (!packets.length) return;
    const segment = mediaSegment(++sequence, start, packets, samples);
    packets = [];
    samples = [];
    await append(segment);
  };

  /** From moment `t`: a page at that moment's place in the file, moved back until it is not later. */
  const goTo = async (t: number) => {
    packets = [];
    samples = [];
    partial = [];
    const span = size - audioStart;
    const perSecond = duration > 0 ? span / duration : 16000;
    let guess = audioStart + Math.floor((Math.max(0, t - 0.5) / Math.max(duration, 1)) * span);
    let found = audioStart;
    for (let tries = 0; tries < 8; tries++) {
      guess = Math.max(audioStart, Math.min(guess, size - 1));
      const around = await reader.read(guess, Math.min(size, Math.max(chunkEnd(guess), guess + 128 * 1024)));
      if (closed) return;
      let i = syncPage(around, 0, serial);
      let granule = -1;
      for (let at = i; at >= 0 && granule < 0; ) {
        const page = pageAt(around, at);
        if (!page) break;
        granule = page.granule;
        if (granule < 0) at += page.length;
      }
      if (i < 0 || granule < 0) {
        if (guess <= audioStart) break;
        guess -= 65536;
        continue;
      }
      found = guess + i;
      const late = granule / OPUS_RATE - t; // the media is timed by the pages' positions
      if (late <= 0.2 || guess <= audioStart) break;
      guess -= Math.max(16384, Math.floor((late + 1) * perSecond));
    }
    pos = found;
    buf = new Uint8Array(0);
    atEnd = false;
    timed = false;
    dropping = true; // until the page found says whether it goes on a packet begun before
  };

  const onSeeking = () => {
    if (bufferedAhead(audio, sb) > 0.5) return; // already there
    jump = audio.currentTime;
    wake();
  };
  audio.addEventListener('seeking', onSeeking);
  const wakers = ['timeupdate', 'play', 'waiting'];
  for (const e of wakers) audio.addEventListener(e, wake);

  (async () => {
    try {
      while (!closed) {
        if (jump !== null) {
          const t = jump;
          jump = null;
          await goTo(t);
          continue;
        }
        if (!atEnd && bufferedAhead(audio, sb) < AHEAD) {
          const page = await nextPage();
          if (closed || jump !== null) continue;
          if (!page) {
            await flush();
            atEnd = true;
            continue;
          }
          if (!timed && dropping && !page.continued) dropping = false; // the page starts a packet
          take(page);
          if (samples.reduce((n, x) => n + x, 0) >= OPUS_RATE) await flush();
          continue;
        }
        if (atEnd && ms.readyState === 'open' && !sb.updating) {
          try {
            ms.endOfStream();
          } catch {}
        }
        await nap(1000);
      }
    } catch (err) {
      if (!closed) audio.dispatchEvent(new CustomEvent('streamerror', { detail: err }));
    }
  })();

  return () => {
    if (closed) return;
    closed = true;
    wake();
    audio.removeEventListener('seeking', onSeeking);
    for (const e of wakers) audio.removeEventListener(e, wake);
    reader.close();
    audio.removeAttribute('src');
    audio.load();
    URL.revokeObjectURL(url);
  };
}

// ---------------------------------------------------------------- FLAC and WAV

/** A format read as FLAC frames, put into MP4 fragments. */
interface FrameSource {
  info: StreamInfo;
  /** byte of the first frame */
  first: number;
  /** The frames from byte `pos` on (about a second of them), their first sample, the byte after them; null at the end. */
  frames(pos: number): Promise<{ frames: Uint8Array[]; samples: number[]; start: number; next: number } | null>;
  /** The byte of a frame that starts at sample `s` or a little before. */
  seek(s: number): Promise<number>;
}

/** Bytes from the start of the file, enough for its headers (up to 16 MB: a big cover). */
async function prefix<T extends object>(reader: ContentReader, parse: (b: Uint8Array) => T | { more: true } | null): Promise<T> {
  for (let n = 64 * 1024; ; n *= 4) {
    const b = await reader.read(0, Math.min(reader.size, n));
    const r = parse(b);
    if (!r) throw new NotStreamable('format');
    if (!('more' in r)) return r;
    if (n >= reader.size || n >= 16 * 1024 * 1024) throw new NotStreamable('headers');
  }
}

async function flacSource(reader: ContentReader): Promise<FrameSource> {
  const { info, seek: table, first } = await prefix(reader, flacMetadata);
  const size = reader.size;
  const block = info.minBlock === info.maxBlock ? info.maxBlock : 0;
  const chunkEnd = (at: number) => Math.min((Math.floor(at / CHUNK_SIZE) + 1) * CHUNK_SIZE, size);
  let buf = new Uint8Array(0); // bytes from `bufAt` on, read but not taken
  let bufAt = -1;
  return {
    info,
    first,
    async frames(pos) {
      if (pos >= size) return null;
      if (pos !== bufAt) (buf = new Uint8Array(0)), (bufAt = pos);
      for (;;) {
        const end = bufAt + buf.length >= size;
        const found = flacFrames(buf, 0, block, end);
        let take = 0;
        let count = 0;
        while (take < found.length && count < info.rate) count += found[take++].samples;
        if (take && (count >= info.rate || end || take < found.length)) {
          const used = found.slice(0, take);
          const last = used[used.length - 1];
          const out = { frames: used.map((f) => buf.slice(f.at, f.at + f.length)), samples: used.map((f) => f.samples), start: used[0].sample, next: bufAt + last.at + last.length };
          buf = buf.subarray(last.at + last.length);
          bufAt = out.next;
          return out;
        }
        if (end) return null; // nothing more that is whole
        const from = bufAt + buf.length;
        const data = await reader.read(from, chunkEnd(from));
        const joined = new Uint8Array(buf.length + data.length);
        joined.set(buf);
        joined.set(data, buf.length);
        buf = joined;
      }
    },
    async seek(s) {
      const total = info.samples || 1;
      const point = [...table].reverse().find((p) => p.sample <= s);
      let guess = point ? first + point.offset : first + Math.floor(((s - info.rate) / total) * (size - first));
      for (let tries = 0; tries < 8; tries++) {
        guess = Math.max(first, Math.min(guess, size - 1));
        const around = await reader.read(guess, Math.min(size, Math.max(chunkEnd(guess), guess + 256 * 1024)));
        const i = flacSync(around, 0, block);
        if (i >= 0) {
          const at = flacFrames(around, i, block, false)[0];
          if (at.sample <= s || guess <= first) return guess + i;
          guess -= Math.max(16384, Math.floor(((at.sample - s) / total + 0.01) * (size - first)));
        } else if (guess <= first) break;
        else guess -= 256 * 1024;
      }
      return first;
    },
  };
}

async function wavSource(reader: ContentReader): Promise<FrameSource> {
  const w = await prefix(reader, (b) => wavFormat(b, reader.size));
  const info = wavStreamInfo(w);
  const blockBytes = WAV_BLOCK * w.align;
  return {
    info,
    first: w.start,
    async frames(pos) {
      if (pos >= w.end) return null;
      // about a second of whole blocks
      const blocks = Math.max(1, Math.round(w.rate / WAV_BLOCK));
      const to = Math.min(w.end, pos + blocks * blockBytes);
      const pcm = await reader.read(pos, to);
      const frames: Uint8Array[] = [];
      const samples: number[] = [];
      const firstBlock = (pos - w.start) / blockBytes;
      for (let at = 0, n = firstBlock; at < pcm.length; at += blockBytes, n++) {
        const part = pcm.subarray(at, Math.min(pcm.length, at + blockBytes));
        frames.push(wavFrame(w, n, part));
        samples.push(part.length / w.align);
      }
      return { frames, samples, start: firstBlock * WAV_BLOCK, next: to };
    },
    async seek(s) {
      return w.start + Math.min(Math.floor(s / WAV_BLOCK), Math.floor((w.end - w.start) / blockBytes)) * blockBytes;
    },
  };
}

/**
 * Plays a FrameSource in `audio`: its frames go to MediaSource in MP4 fragments of about a
 * second, timed by the frames' own positions. A jump starts from the frame at that moment.
 */
async function streamFrames(MS: typeof MediaSource, audio: HTMLMediaElement, reader: ContentReader, src: FrameSource): Promise<() => void> {
  const TYPE = 'audio/mp4; codecs="flac"';
  if (!MS.isTypeSupported(TYPE)) throw new NotStreamable('codec');
  const ms = new MS();
  if (!(window as any).MediaSource) (audio as any).disableRemotePlayback = true;
  const url = URL.createObjectURL(ms);
  audio.src = url;
  await new Promise<void>((resolve) => ms.addEventListener('sourceopen', () => resolve(), { once: true }));
  if (src.info.samples > 0) ms.duration = src.info.samples / src.info.rate;
  const sb = ms.addSourceBuffer(TYPE);
  let closed = false;
  const { wake, nap } = sleeper();
  const append = appender(sb, audio, nap, () => closed);
  await append(flacInit(src.info));

  let pos = src.first;
  let atEnd = false;
  let sequence = 0;
  let jump: number | null = null;
  const onSeeking = () => {
    if (bufferedAhead(audio, sb) > 0.5) return; // already there
    jump = audio.currentTime;
    wake();
  };
  audio.addEventListener('seeking', onSeeking);
  const wakers = ['timeupdate', 'play', 'waiting'];
  for (const e of wakers) audio.addEventListener(e, wake);

  (async () => {
    try {
      while (!closed) {
        if (jump !== null) {
          const t = jump;
          jump = null;
          pos = await src.seek(Math.floor(t * src.info.rate));
          atEnd = false;
          continue;
        }
        if (!atEnd && bufferedAhead(audio, sb) < AHEAD) {
          const got = await src.frames(pos);
          if (closed || jump !== null) continue;
          if (!got) {
            atEnd = true;
            continue;
          }
          await append(mediaSegment(++sequence, got.start, got.frames, got.samples));
          pos = got.next;
          continue;
        }
        if (atEnd && ms.readyState === 'open' && !sb.updating) {
          try {
            ms.endOfStream();
          } catch {}
        }
        await nap(1000);
      }
    } catch (err) {
      if (!closed) audio.dispatchEvent(new CustomEvent('streamerror', { detail: err }));
    }
  })();

  return () => {
    if (closed) return;
    closed = true;
    wake();
    audio.removeEventListener('seeking', onSeeking);
    for (const e of wakers) audio.removeEventListener(e, wake);
    reader.close();
    audio.removeAttribute('src');
    audio.load();
    URL.revokeObjectURL(url);
  };
}
