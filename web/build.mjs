// Builds dist/: the landing page (/, landing.js) and the PWA (/app/, app/app.js), plus the
// static files of public/.
import * as esbuild from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const watch = process.argv.includes('--watch');
const outdir = fileURLToPath(new URL('./dist/', import.meta.url)); // a real path on Windows too

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await cp(fileURLToPath(new URL('./public/', import.meta.url)), outdir, { recursive: true });

const options = {
  entryPoints: [
    { in: 'src/ui/main.ts', out: 'app/app' },
    { in: 'src/landing/main.ts', out: 'landing' },
  ],
  bundle: true,
  format: 'esm',
  target: ['es2022', 'safari16', 'chrome110'],
  outdir,
  minify: !watch,
  sourcemap: watch ? 'inline' : false,
  legalComments: 'none',
  logLevel: 'info',
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
}
