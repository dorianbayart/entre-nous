// Languages of the interface: French and English. No DOM here: the engine (and its tests in
// Node) use it too. The language is the system's or the browser's (French or English, English
// for any other), unless the user chose one.
import { fr, type Strings } from './fr.ts';
import { en } from './en.ts';

export type Lang = 'fr' | 'en';
export type Key = keyof Strings;
export const LANGS: Lang[] = ['fr', 'en'];

const dict: Record<Lang, Strings> = { fr, en };

/** French or English, from a list of preferred languages (BCP 47). English by default. */
export function pick(prefs: readonly string[]): Lang {
  for (const p of prefs) {
    const base = p.toLowerCase().split(/[-_]/)[0];
    if (base === 'fr' || base === 'en') return base;
  }
  return 'en';
}

/** The languages of the system or the browser (empty when there is no navigator). */
export function systemLangs(): readonly string[] {
  const nav = (globalThis as any).navigator;
  if (!nav) return [];
  return nav.languages?.length ? nav.languages : nav.language ? [nav.language] : [];
}

let current: Lang = pick(systemLangs());

export const lang = () => current;
export function setLang(l: Lang) {
  current = l;
}

/** The text of `key`, with its {placeholders} filled. */
export function t(key: Key, vars?: Record<string, string | number>): string {
  const s: string = dict[current][key] ?? fr[key];
  return vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : s;
}

/** `key.one` or `key.other` by the number `n`, which fills {n}. */
export function tn(key: string, n: number, vars?: Record<string, string | number>) {
  const one = current === 'fr' ? n < 2 : n === 1; // French: 0 and 1 are singular
  return t((key + (one ? '.one' : '.other')) as Key, { n, ...vars });
}

/** A number with `digits` decimals at most, with the language's decimal separator. */
function num(x: number, digits: number) {
  const s = x.toFixed(digits).replace(/\.0+$/, '');
  return current === 'fr' ? s.replace('.', ',') : s;
}

/** 512 o / 12 Ko / 1,5 Mo… in French, 512 B / 12 KB / 1.5 MB… in English. Above 999, the next
 *  unit: 1023 Mo is 1 Go. */
export function humanSize(n = 0) {
  const u = current === 'fr' ? ['o', 'Ko', 'Mo', 'Go'] : ['B', 'KB', 'MB', 'GB'];
  if (n <= 999) return `${n} ${u[0]}`;
  if (n / 1024 <= 999) return `${num(n / 1024, 0)} ${u[1]}`;
  if (n / 1024 ** 2 <= 999) return `${num(n / 1024 ** 2, 1)} ${u[2]}`;
  return `${num(n / 1024 ** 3, 1)} ${u[3]}`;
}

/** The relay's space: "1,1 Mo utilisés sur 1 Go". */
export function storageSpace(used: number, limit: number) {
  const size = humanSize(used);
  return tn('storage.space', parseFloat(size.replace(',', '.')), { used: size, total: humanSize(limit) });
}

/** 42 s, 5 min, 3 h, 2 j (French) or 2 d (English). */
export function duration(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 2 * 86400) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86400)} ${current === 'fr' ? 'j' : 'd'}`;
}
