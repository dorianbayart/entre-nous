// Builds dist/: the landing page (/, landing.js) and the PWA (/app/, app/app.js), plus the
// static files of public/.
import * as esbuild from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';

const watch = process.argv.includes('--watch');
const outdir = new URL('./dist/', import.meta.url).pathname;

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await cp(new URL('./public/', import.meta.url).pathname, outdir, { recursive: true });

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
