// Terminal output: results on stdout, messages and progress on stderr; colours only on a
// terminal, and never with NO_COLOR (https://no-color.org) or TERM=dumb.
import qrcode from 'qrcode-generator';
import { humanSize } from '../../web/src/i18n/index.ts';
import { tr } from './i18n.ts';

const env = process.env;
export const errTTY = !!process.stderr.isTTY;
export const outTTY = !!process.stdout.isTTY;
const colour = (tty: boolean) => !('NO_COLOR' in env) && env.TERM !== 'dumb' && (tty || !!env.FORCE_COLOR);

const paint = (code: string, tty: boolean) => (s: string) => (colour(tty) ? `\x1b[${code}m${s}\x1b[0m` : s);
/** Styles for stdout (`out.*`) and stderr (`err.*`). */
export const out = { bold: paint('1', outTTY), dim: paint('2', outTTY), green: paint('32', outTTY), cyan: paint('36', outTTY) };
export const err = { bold: paint('1', errTTY), dim: paint('2', errTTY), red: paint('31', errTTY), yellow: paint('33', errTTY), green: paint('32', errTTY) };

let quiet = false;
export const setQuiet = (q: boolean) => (quiet = q);

/** A message for the person at the terminal (stderr), silenced by --quiet. */
export function say(msg: string) {
  if (!quiet) process.stderr.write(msg + '\n');
}

export function warn(msg: string) {
  process.stderr.write(err.yellow('! ') + msg + '\n');
}

/** A result (stdout). Waits for it to be written: the process may exit right after. */
export function print(text: string): Promise<void> {
  return new Promise((resolve) => (process.stdout.write(text) ? resolve() : process.stdout.once('drain', resolve)));
}

// ------------------------------------------------------------------ formats

export { humanSize };

/** 45s, 10m, 2h, 1h30m, or plain seconds. */
export function parseDuration(value: string): number | null {
  const v = value.trim();
  if (/^\d+(\.\d+)?$/.test(v)) return Number(v) * 1000;
  const re = /(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)/gy;
  let ms = 0;
  let m: RegExpExecArray | null;
  let end = 0;
  while ((m = re.exec(v))) {
    ms += Number(m[1]) * { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as 'ms']!;
    end = re.lastIndex;
  }
  return end === v.length && end > 0 ? ms : null;
}

/** First line of a text, cut to `max` columns. */
export function oneLine(text: string, max: number) {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? line.slice(0, max - 1) + '…' : line;
}

export function columns() {
  return process.stdout.columns || 100;
}

/** Text columns aligned on their widest cell (the last one is not padded). */
export function table(rows: string[][], visible = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')): string {
  const widths: number[] = [];
  for (const r of rows) r.forEach((c, i) => (widths[i] = Math.max(widths[i] ?? 0, visible(c).length)));
  return rows.map((r) => r.map((c, i) => (i < r.length - 1 ? c + ' '.repeat(widths[i] - visible(c).length) : c)).join('  ')).join('\n') + '\n';
}

// ------------------------------------------------------------------ progress

/** A progress line on stderr (terminal only), redrawn at most 10 times a second. */
export class Progress {
  private last = 0;
  private shown = false;
  constructor(private label: string) {}

  update(done: number, total: number, rate?: number) {
    if (!errTTY || quiet || total <= 1) return;
    const now = Date.now();
    if (now - this.last < 100 && done < total) return;
    this.last = now;
    const width = 24;
    const ratio = Math.min(1, done / total);
    const bar = '█'.repeat(Math.round(ratio * width)).padEnd(width, '░');
    const pct = `${Math.round(ratio * 100)}%`.padStart(4);
    const speed = rate ? '  ' + humanSize(Math.round(rate)) + '/s' : '';
    const label = oneLine(this.label, Math.max(10, (process.stderr.columns || 80) - width - 24));
    process.stderr.write(`\r\x1b[2K${label}  ${err.dim(bar)} ${pct}${speed}`);
    this.shown = true;
  }

  end() {
    if (this.shown) process.stderr.write('\r\x1b[2K');
    this.shown = false;
  }
}

// ------------------------------------------------------------------ QR code

/**
 * The QR code of `text` in half blocks, dark on light whatever the terminal's colours (each
 * character is two modules: its top in the foreground colour, its bottom in the background).
 */
export function qr(text: string): string {
  const code = qrcode(0, 'L');
  code.addData(text);
  code.make();
  const n = code.getModuleCount();
  const quietZone = 2;
  const dark = (r: number, c: number) => r >= 0 && c >= 0 && r < n && c < n && code.isDark(r, c);
  const lines: string[] = [];
  for (let r = -quietZone; r < n + quietZone; r += 2) {
    let line = '';
    for (let c = -quietZone; c < n + quietZone; c++) {
      const fg = dark(r, c) ? '30' : '97';
      const bg = dark(r + 1, c) ? '40' : '107';
      line += `\x1b[${fg};${bg}m▀`;
    }
    lines.push(line + '\x1b[0m');
  }
  return lines.join('\n') + '\n';
}

// ------------------------------------------------------------------ questions

/** Asks a yes/no question on the terminal; false without a terminal. */
export async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY || !errTTY) return false;
  process.stderr.write(tr('msg.confirm', { what: question }));
  const answer = await new Promise<string>((resolve) => {
    process.stdin.setEncoding('utf8');
    process.stdin.once('data', (d) => resolve(String(d)));
    process.stdin.resume();
  });
  process.stdin.pause();
  return /^\s*(y|yes|o|oui)\s*$/i.test(answer);
}
