// entrenous: the command line of Entre Nous. One more device in your groups, with the same
// engine and the same end-to-end encryption as the apps.
import { parseArgs } from 'node:util';
import { COMMANDS, type Command, type Option } from './commands.ts';
import { Context, type Globals } from './context.ts';
import { CliError, EXIT } from './errors.ts';
import { initLang, lang, tr } from './i18n.ts';
import { defaultHome } from './store.ts';
import { err, out, print, setQuiet, warn } from './term.ts';

const VERSION = __VERSION__;
const DOCS = { en: 'https://github.com/dorianbayart/entre-nous/blob/master/docs/en/cli.md', fr: 'https://github.com/dorianbayart/entre-nous/blob/master/docs/cli.md' };

/** The CLI of the latest release (not on the npm registry: installed from this file). */
const PACKAGE_URL = 'https://github.com/dorianbayart/entre-nous/releases/latest/download/entrenous-cli.tgz';
/** How to update: Homebrew (dorianbayart/tap) installs it under its Cellar, npm anywhere else. */
const UPDATE = import.meta.url.includes('/Cellar/entrenous/') ? 'brew upgrade entrenous' : `npm install -g ${PACKAGE_URL}`;

const GLOBAL: Record<string, Option> = {
  group: { type: 'string', short: 'g', arg: 'GROUP', desc: 'opt.group' },
  json: { type: 'boolean', desc: 'opt.json' },
  quiet: { type: 'boolean', short: 'q', desc: 'opt.quiet' },
  home: { type: 'string', arg: 'FOLDER', desc: 'opt.home' },
  help: { type: 'boolean', short: 'h', desc: 'opt.help' },
  version: { type: 'boolean', short: 'V', desc: 'opt.version' },
};

// ------------------------------------------------------------------ help

/** Placeholders of the usage lines, in French. */
const PLACEHOLDERS: Record<string, string> = {
  FILE: 'FICHIER', ITEM: 'ÉLÉMENT', TEXT: 'TEXTE', LINK: 'LIEN', NAME: 'NOM', GROUP: 'GROUPE',
  FOLDER: 'DOSSIER', PATH: 'CHEMIN', DURATION: 'DURÉE', URL: 'URL', N: 'N',
};
const ph = (s: string) => (lang() === 'fr' ? s.replace(/\b[A-Z]+\b/g, (w) => PLACEHOLDERS[w] ?? w) : s);

function optionRows(options: Record<string, Option>): string[][] {
  return Object.entries(options).map(([name, o]) => {
    const flags = (o.short ? `-${o.short}, ` : '    ') + `--${name}` + (o.arg ? ' ' + ph(o.arg) : '');
    return [flags, tr(o.desc, o.descVars)];
  });
}

function rows(list: string[][], indent = '  ', width?: number): string {
  const w = width ?? Math.max(...list.map((r) => r[0].length));
  return list.map(([a, b]) => `${indent}${a.padEnd(w)}   ${b}`).join('\n');
}

const heading = (s: string) => out.bold(s);

function mainHelp(): string {
  const label = (c: Command) => `${c.name} ${ph(c.args)}`.trim();
  const width = Math.max(...COMMANDS.map((c) => label(c).length));
  const section = (key: 'share' | 'devices') =>
    rows(COMMANDS.filter((c) => c.section === key).map((c) => [label(c), tr(c.summary)]), '  ', width);
  return [
    `${out.bold('entrenous')} ${out.dim(VERSION)}  ${tr('tagline')}`,
    '',
    `${heading(tr('usage'))}  entrenous <${lang() === 'fr' ? 'commande' : 'command'}> [options]`,
    '',
    heading(tr('section.share')),
    section('share'),
    '',
    heading(tr('section.devices')),
    section('devices'),
    '',
    heading(tr('globalOptions')),
    rows(optionRows(GLOBAL)),
    '',
    heading(tr('examples')),
    [
      "entrenous join 'https://entrenous.0xdba.dev/app/#p=…'",
      'entrenous send report.pdf',
      'echo "deployed ✓" | entrenous send',
      'entrenous get',
      'entrenous wait --timeout 10m -o ~/Downloads/',
    ]
      .map((e) => '  ' + out.dim('$ ') + e)
      .join('\n'),
    '',
    `${tr('help.more')}`,
    `${heading(tr('docs'))}  ${DOCS[lang()]}`,
    '',
  ].join('\n');
}

function commandHelp(c: Command): string {
  const usage = `entrenous ${c.name} ${ph(c.args)}`.trim() + ' [options]';
  return [
    `${heading(tr('usage'))}  ${usage}`,
    '',
    tr(c.summary) + (c.aliases ? out.dim(`  (${c.aliases.join(', ')})`) : ''),
    ...(c.long ? ['', tr(c.long)] : []),
    ...(Object.keys(c.options).length ? ['', heading(tr('options')), rows(optionRows(c.options))] : []),
    '',
    heading(tr('globalOptions')),
    rows(optionRows(GLOBAL)),
    '',
    heading(tr('examples')),
    c.examples.map((e) => '  ' + out.dim('$ ') + e).join('\n'),
    '',
  ].join('\n');
}

// ------------------------------------------------------------------ dispatch

function findCommand(name: string): Command | undefined {
  return COMMANDS.find((c) => c.name === name || c.aliases?.includes(name));
}

/** The closest command name, for a typo (at most 2 edits away). */
function closest(name: string): string | undefined {
  const dist = (a: string, b: string) => {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++)
      for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[a.length][b.length];
  };
  const names = COMMANDS.flatMap((c) => [c.name, ...(c.aliases ?? [])]);
  const best = names.map((n) => [n, dist(name, n)] as const).sort((a, b) => a[1] - b[1])[0];
  return best && best[1] <= 2 ? best[0] : undefined;
}

type ParseConfig = NonNullable<Parameters<typeof parseArgs>[0]>['options'];
const toParse = (opts: Record<string, Option>): ParseConfig =>
  Object.fromEntries(Object.entries(opts).map(([k, o]) => [k, { type: o.type, ...(o.short ? { short: o.short } : {}) }]));

/** Is `a` newer than `b` (dotted versions)? */
const newer = (a: string, b: string) => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  return false;
};

async function main(argv: string[]): Promise<number> {
  initLang();
  // the command: the first argument that is not an option or an option's value (--home DIR send…)
  const every = Object.assign({}, GLOBAL, ...COMMANDS.map((c) => c.options));
  const { tokens } = parseArgs({ args: argv, options: toParse(every), allowPositionals: true, strict: false, tokens: true });
  const first = tokens.find((t) => t.kind === 'positional')?.index ?? -1;
  const name = first >= 0 ? argv[first] : undefined;

  if (name === 'help') {
    const c = argv[first + 1] && findCommand(argv[first + 1]);
    await print(c ? commandHelp(c) : mainHelp());
    return EXIT.ok;
  }
  const command = name ? findCommand(name) : undefined;
  if (name && !command) {
    const near = closest(name);
    throw new CliError(tr('err.unknownCommand', { cmd: name }) + (near ? ' ' + tr('err.didYouMean', { cmd: near }) : '') + '\n' + tr('help.more'), EXIT.usage);
  }

  const rest = command ? [...argv.slice(0, first), ...argv.slice(first + 1)] : argv;
  let parsed;
  try {
    parsed = parseArgs({ args: rest, options: toParse({ ...GLOBAL, ...(command?.options ?? {}) }), allowPositionals: true, strict: true });
  } catch (e: any) {
    throw new CliError(String(e.message ?? e) + '\n' + tr('help.more'), EXIT.usage);
  }
  const o = parsed.values as Record<string, any>;
  if (o.version) {
    await print(VERSION + '\n');
    return EXIT.ok;
  }
  if (!command || o.help) {
    await print(command ? commandHelp(command) : mainHelp());
    return EXIT.ok;
  }

  setQuiet(!!o.quiet || !!o.json);
  const globals: Globals = { group: o.group, json: !!o.json, quiet: !!o.quiet, home: o.home ?? defaultHome() };
  const ctx = new Context(globals);
  const stop = async (code: number) => {
    await ctx.close().catch(() => {});
    process.exit(code);
  };
  // Ctrl-C: the end of `watch`, an interruption for anything else
  process.once('SIGINT', () => {
    process.stderr.write('\n');
    stop(command.name === 'watch' ? EXIT.ok : EXIT.interrupted);
  });
  process.once('SIGTERM', () => stop(EXIT.interrupted));
  try {
    const code = (await command.run(ctx, parsed.positionals, o)) ?? EXIT.ok;
    const latest = ctx.loaded ? (await ctx.engine()).latest : null;
    if (latest && newer(latest, VERSION) && process.stderr.isTTY && !globals.quiet && !globals.json) {
      process.stderr.write(err.dim(tr('msg.update', { v: latest, cmd: UPDATE })) + '\n');
    }
    return code;
  } finally {
    await ctx.close().catch(() => {});
  }
}

// a reader that went away (`entrenous list | head -1`) is not an error
process.stdout.on('error', (e: any) => process.exit(e.code === 'EPIPE' ? EXIT.ok : EXIT.error));

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e: any) => {
    if (e instanceof CliError) {
      process.stderr.write(err.red('✗ ') + e.message + '\n');
      process.exit(e.code);
    }
    warn(String(e?.stack ?? e));
    process.exit(EXIT.error);
  },
);
