// Builds dist/: the landing page (/, landing.js) and the PWA (/app/, app/app.js), plus the
// static files of public/.
import * as esbuild from 'esbuild';
import { execSync } from 'node:child_process';
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The version of this build: 0.1.<number of commits>, the same for every app built from a
// commit (APP_VERSION overrides it). The apps compare it with the latest release.
function version() {
  if (process.env.APP_VERSION) return process.env.APP_VERSION;
  try {
    return '0.1.' + execSync('git rev-list --count HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return '0.0.0'; // no git (Docker build of the relay): the web app does not compare
  }
}

const watch = process.argv.includes('--watch');

// ---------------------------------------------------------------- changelog
// CHANGELOG.md and CHANGELOG.en.md (../scripts/changelog.mjs): app/changelog.json for the apps
// (what's new after an update), and the "What's new" pages of the site.
const { load: loadChangelog } = await import('../scripts/changelog.mjs');

const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** A change: text, **bold** and `code` only. */
const changeHtml = (s) =>
  escapeHtml(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`(.+?)`/g, '<code>$1</code>');

function changelogPage(entries, lang) {
  const fr = lang === 'fr';
  const date = (d) => new Date(d + 'T12:00:00Z').toLocaleDateString(fr ? 'fr-FR' : 'en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  const sections = entries
    .map((e) => `    <section class="version">
      <h2>${e.version} <span>${date(e.date)}</span></h2>
      <ul>
${e[lang].map((c) => `        <li>${changeHtml(c)}</li>`).join('\n')}
      </ul>
    </section>`)
    .join('\n');
  const other = fr ? { href: '/en/changelog/', label: 'English', lang: 'en' } : { href: '/nouveautes/', label: 'Français', lang: 'fr' };
  return `<!doctype html>
<html lang="${lang}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="color-scheme" content="light dark">
  <meta name="description" content="${fr ? 'Ce que chaque version d’Entre Nous apporte.' : 'What each version of Entre Nous brings.'}">
  <title>Entre Nous · ${fr ? 'Nouveautés' : 'What’s new'}</title>
  <link rel="alternate" hreflang="fr" href="/nouveautes/">
  <link rel="alternate" hreflang="en" href="/en/changelog/">
  <link rel="icon" href="/app/icon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="/landing.css">
</head>
<body>
<main class="page changelog">
  <a class="lang-switch" href="${other.href}" hreflang="${other.lang}" lang="${other.lang}">${other.label}</a>
  <header class="hero">
    <a href="${fr ? '/fr/' : '/en/'}"><img class="logo" src="/app/icon.svg" alt="Entre Nous" width="48" height="48"></a>
    <h1>${fr ? 'Nouveautés' : 'What’s new'}</h1>
    <p class="sub">${fr ? 'Ce que chaque version apporte. Les applis l’affichent aussi quand une mise à jour est proposée.' : 'What each version brings. The apps show it too when an update is offered.'}</p>
  </header>
${sections}
  <footer>Entre&nbsp;Nous · <a href="${fr ? '/fr/' : '/en/'}">${fr ? 'Accueil' : 'Home'}</a> ·
    <a href="/app/">${fr ? 'Ouvrir l’appli web' : 'Open the web app'}</a> ·
    <a href="https://github.com/dorianbayart/entre-nous/blob/master/${fr ? 'CHANGELOG.md' : 'CHANGELOG.en.md'}">GitHub</a></footer>
</main>
</body>
</html>
`;
}

const outdir = fileURLToPath(new URL('./dist/', import.meta.url)); // a real path on Windows too

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await cp(fileURLToPath(new URL('./public/', import.meta.url)), outdir, { recursive: true });
// the landing page shows the schemas of the documentation (docs/images/, the only copy)
for (const name of ['chiffrement.svg', 'reseau.svg', 'chiffrement-en.svg', 'reseau-en.svg']) {
  const schema = fileURLToPath(new URL('../docs/images/' + name, import.meta.url));
  if (existsSync(schema)) await cp(schema, outdir + 'images/' + name);
}

const changelog = loadChangelog();
await writeFile(outdir + 'app/changelog.json', JSON.stringify(changelog));
await mkdir(outdir + 'nouveautes', { recursive: true });
await writeFile(outdir + 'nouveautes/index.html', changelogPage(changelog, 'fr'));
await mkdir(outdir + 'en/changelog', { recursive: true });
await writeFile(outdir + 'en/changelog/index.html', changelogPage(changelog, 'en'));

const options = {
  entryPoints: [
    { in: 'src/ui/main.ts', out: 'app/app' },
    { in: 'src/landing/main.ts', out: 'landing' },
  ],
  bundle: true,
  format: 'esm',
  // loaded when needed (the video player, Markdown): under app/, which the apps bundle
  splitting: true,
  chunkNames: 'app/chunks/[name]-[hash]',
  target: ['es2022', 'safari16', 'chrome110'],
  outdir,
  minify: !watch,
  sourcemap: watch ? 'inline' : false,
  legalComments: 'none',
  // the changelog is in the code: no fetch (the Mac app's policy allows none to itself)
  define: { __VERSION__: JSON.stringify(version()), __CHANGELOG__: JSON.stringify(changelog) },
  logLevel: 'info',
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
}
