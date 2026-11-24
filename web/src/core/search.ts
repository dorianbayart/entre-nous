// Search in the history: on the device only, over what each item's header already holds
// (text, file name, start of a text file, sender). Accents, case, hyphens and apostrophes do
// not count; every word
// of the query must be found, in any order. Shared by the apps and the command line.
import { previewKind } from './media.ts';

/** The filters by type. `text` and `link` overlap: a text holding a link is both. */
export type SearchType = 'text' | 'link' | 'image' | 'video' | 'audio' | 'doc' | 'folder';
export const SEARCH_TYPES: SearchType[] = ['text', 'link', 'image', 'video', 'audio', 'doc', 'folder'];

/** What an item gives to the search (an item of the history, or a share link of one). */
export interface Searchable {
  kind: string;
  text?: string;
  name?: string;
  mime?: string;
  excerpt?: string;
  fromName?: string;
}

/** A piece of a text, found (`hit`) or not. */
export interface Part {
  text: string;
  hit: boolean;
}

const LINK = /\bhttps?:\/\/\S/i;

/** Lower case, without accents, hyphens or apostrophes: "Étoile" is "etoile", "Wi-Fi" is "wifi",
 *  "l’été" is "l'ete". */
export const normalize = (s: string) =>
  s.normalize('NFD').replace(/[\p{M}\p{Pd}'’‘]/gu, '').toLowerCase();

/** The words of a query, normalized. */
export const queryWords = (q: string) => normalize(q).split(/\s+/).filter(Boolean);

/** Is `item` of this type? */
export function isType(item: Searchable, type: SearchType): boolean {
  if (item.kind === 'text') return type === 'text' || (type === 'link' && LINK.test(item.text ?? item.excerpt ?? ''));
  if (item.kind === 'folder') return type === 'folder';
  if (item.kind === 'image') return type === 'image';
  if (item.kind !== 'file') return false;
  const k = previewKind(item.name, item.mime);
  if (k === 'image' || k === 'video' || k === 'audio') return type === k;
  return type === 'doc';
}

/** Does `item` match every word of `q` (and the type, if one)? */
export function matches(item: Searchable, q: string, type?: SearchType | ''): boolean {
  if (type && !isType(item, type)) return false;
  const words = queryWords(q);
  if (!words.length) return true;
  const hay = normalize([item.text, item.name, item.excerpt, item.fromName].filter(Boolean).join('\n'));
  return words.every((w) => hay.includes(w));
}

/** `s` normalized, with for each of its characters the index of the character of `s` it comes from. */
function mapped(s: string): { n: string; at: number[] } {
  let n = '';
  const at: number[] = [];
  let i = 0;
  for (const ch of s) {
    const c = normalize(ch);
    n += c;
    for (let k = 0; k < c.length; k++) at.push(i); // one per UTF-16 unit, like `n`
    i += ch.length;
  }
  return { n, at };
}

/** Where the words of `q` are in `s`: one flag per UTF-16 unit of `s`. */
function hits(s: string, q: string): boolean[] | null {
  const words = queryWords(q);
  if (!words.length || !s) return null;
  const { n, at } = mapped(s);
  const flags = new Array<boolean>(s.length).fill(false);
  let any = false;
  for (const w of words) {
    for (let k = n.indexOf(w); k !== -1; k = n.indexOf(w, k + 1)) {
      const start = at[k];
      const last = at[k + w.length - 1];
      // the whole last character (a surrogate pair, or an accented letter in NFD)
      const end = last + (s.codePointAt(last)! > 0xffff ? 2 : 1);
      for (let x = start; x < end; x++) flags[x] = true;
      any = true;
    }
  }
  return any ? flags : null;
}

/** `s` cut into found and not found pieces, for highlighting. */
export function highlight(s: string, q: string): Part[] {
  const flags = hits(s, q);
  if (!flags) return s ? [{ text: s, hit: false }] : [];
  const parts: Part[] = [];
  for (let i = 0; i < s.length; ) {
    let j = i;
    while (j < s.length && flags[j] === flags[i]) j++;
    parts.push({ text: s.slice(i, j), hit: flags[i] });
    i = j;
  }
  return parts;
}

/** Characters (or lines) after which a found word would be hidden in a card: show from it. */
const SNIPPET_AFTER = 120;
const SNIPPET_LINES = 3;
const SNIPPET_BEFORE = 40;

/**
 * A long text shows where the query is found, not its start, when the first word found would
 * be cut off in the card: "…the Wi-Fi password is Merlin…".
 */
export function snippet(s: string, q: string): string {
  const flags = hits(s, q);
  if (!flags) return s;
  const first = flags.indexOf(true);
  const lines = s.slice(0, first).split('\n').length - 1;
  if (first <= SNIPPET_AFTER && lines < SNIPPET_LINES) return s;
  let start = Math.max(0, first - SNIPPET_BEFORE);
  const line = s.lastIndexOf('\n', first - 1);
  if (line >= start) start = line + 1;
  else {
    const space = s.indexOf(' ', start);
    if (space !== -1 && space < first) start = space + 1;
  }
  // never in the middle of a surrogate pair
  if (start > 0 && /[\udc00-\udfff]/.test(s[start])) start--;
  return start > 0 ? '…' + s.slice(start) : s;
}
