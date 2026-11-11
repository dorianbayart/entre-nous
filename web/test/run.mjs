// Bundles the TypeScript tests with esbuild, then runs them with node:test.
import * as esbuild from 'esbuild';
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const dir = new URL('.', import.meta.url).pathname;
const tests = readdirSync(dir).filter((f) => f.endsWith('.test.ts'));
const outdir = dir + '.out/';

await esbuild.build({
  entryPoints: tests.map((f) => dir + f),
  bundle: true,
  platform: 'node',
  format: 'esm',
  outdir,
  outExtension: { '.js': '.mjs' },
  logLevel: 'warning',
});

const res = spawnSync(process.execPath, ['--test', '--test-force-exit', ...tests.map((f) => outdir + f.replace(/\.ts$/, '.mjs'))], {
  stdio: 'inherit',
});
process.exit(res.status ?? 1);
