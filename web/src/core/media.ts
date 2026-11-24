// What a content can be previewed as, from its name and type; the start of a text file.
// Shared by the apps (previews, made on the sending side) and the command line.

export type PreviewKind = 'image' | 'video' | 'audio' | 'pdf' | 'markdown' | 'text';

/** Characters of a text file shown under its name in the history. */
export const EXCERPT_MAX = 280;
/** A text preview shows the start of the file: its first chunk at most. */
export const TEXT_PREVIEW_MAX = 1024 * 1024;

const IMAGE = /\.(jpe?g|png|gif|webp|avif|heic|heif|bmp|svg)$/i;
const VIDEO = /\.(mp4|m4v|mov|webm)$/i;
const AUDIO = /\.(mp3|m4a|aac|wav|ogg|oga|opus|flac|weba)$/i;
const MARKDOWN = /\.(md|markdown|mdown|mkd)$/i;
const TEXT =
  /\.(txt|text|log|csv|tsv|json|jsonl|ndjson|xml|ya?ml|toml|ini|conf|cfg|env|properties|sh|bash|zsh|fish|ps1|bat|py|rb|pl|php|js|mjs|cjs|ts|tsx|jsx|css|scss|less|html?|vue|svelte|c|h|cc|cpp|hpp|cs|java|kt|kts|swift|go|rs|dart|lua|r|sql|graphql|proto|gradle|tex|srt|vtt|diff|patch|gitignore|dockerfile|makefile)$/i;
const TEXT_MIME = /^(text\/|application\/(json|xml|x-yaml|yaml|toml|x-sh|javascript|typescript|sql|x-subrip)\b)/;

/** How a content is previewed, or undefined: saved only. */
export function previewKind(name = '', mime = ''): PreviewKind | undefined {
  mime = mime.toLowerCase().split(';')[0].trim();
  if (mime === 'text/markdown' || mime === 'text/x-markdown' || MARKDOWN.test(name)) return 'markdown';
  if (mime.startsWith('image/') || (!mime && IMAGE.test(name))) return 'image';
  if (mime === 'application/pdf' || /\.pdf$/i.test(name)) return 'pdf';
  if (mime.startsWith('audio/') || AUDIO.test(name)) return 'audio';
  if (mime.startsWith('video/') || VIDEO.test(name)) return 'video';
  if (TEXT_MIME.test(mime) || TEXT.test(name) || /^(readme|license|changelog|makefile|dockerfile)$/i.test(name)) return 'text';
  return undefined;
}

/** The type of an audio file from its name, when it came without one (to ask whether it plays). */
export function audioMime(name = ''): string {
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? '';
  const types: Record<string, string> = {
    mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg',
    opus: 'audio/ogg; codecs=opus', flac: 'audio/flac', weba: 'audio/webm',
  };
  return types[ext] ?? 'audio/mpeg';
}

/** Is it a text file (so that its first characters can be shown)? */
export const isText = (name = '', mime = '') => {
  const k = previewKind(name, mime);
  return k === 'text' || k === 'markdown';
};

/**
 * The first characters of a text, on one line: no control character, no byte order mark,
 * blank runs folded. Empty when it does not look like text (a NUL byte).
 */
export function excerptOf(start: string): string {
  if (start.includes('\u0000')) return '';
  const clean = start
    .replace(/^﻿/, '')
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return [...clean].slice(0, EXCERPT_MAX).join('');
}

/** The start of a text file as text: the last line cut where a multi-byte character would be. */
export function decodeStart(bytes: Uint8Array, complete: boolean): string {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  return complete ? text : text.replace(/�$/, '');
}
