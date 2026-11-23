// The clipboard of this computer, through the system's own tools (text only).
import { spawn } from 'node:child_process';
import { tr } from './i18n.ts';
import { CliError } from './errors.ts';

type Tool = [cmd: string, args: string[]];

function tools(write: boolean): Tool[] {
  if (process.platform === 'darwin') return [write ? ['pbcopy', []] : ['pbpaste', []]];
  if (process.platform === 'win32') {
    const ps = ['-NoProfile', '-NonInteractive', '-Command'];
    return [
      write
        ? ['powershell', [...ps, '[Console]::InputEncoding=[Text.Encoding]::UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())']]
        : ['powershell', [...ps, '[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Clipboard -Raw']],
    ];
  }
  const wayland: Tool[] = write ? [['wl-copy', []]] : [['wl-paste', ['--no-newline']]];
  const x11: Tool[] = write
    ? [['xclip', ['-selection', 'clipboard']], ['xsel', ['--clipboard', '--input']]]
    : [['xclip', ['-selection', 'clipboard', '-o']], ['xsel', ['--clipboard', '--output']]];
  return process.env.WAYLAND_DISPLAY ? [...wayland, ...x11] : [...x11, ...wayland];
}

function run([cmd, args]: Tool, input?: string): Promise<string | null> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'ignore'] });
    const chunks: Buffer[] = [];
    p.stdout!.on('data', (d) => chunks.push(d));
    p.on('error', () => resolve(null)); // not installed
    p.on('close', (code) => resolve(code === 0 ? Buffer.concat(chunks).toString('utf8') : null));
    if (input !== undefined) p.stdin!.end(input);
  });
}

async function first(write: boolean, input?: string): Promise<string> {
  const list = tools(write);
  for (const tool of list) {
    const res = await run(tool, input);
    if (res !== null) return res;
  }
  throw new CliError(tr('err.clipboard', { tools: list.map((t) => t[0]).join(', ') }));
}

export async function readClipboard(): Promise<string> {
  const text = await first(false);
  // PowerShell ends with a line break of its own
  return process.platform === 'win32' ? text.replace(/\r?\n$/, '') : text;
}

export async function writeClipboard(text: string): Promise<void> {
  await first(true, text);
}
