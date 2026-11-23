// Bundles the CLI into one file, dist/entrenous.mjs, with no dependencies: the engine of the
// apps (web/src/core, its packages installed by `npm ci` in web/) and the CLI itself.
import * as esbuild from 'esbuild';
import { execSync } from 'node:child_process';
import { chmod } from 'node:fs/promises';

// Same version as the apps built from this commit: 0.1.<number of commits> (APP_VERSION overrides).
function version() {
  if (process.env.APP_VERSION) return process.env.APP_VERSION;
  try {
    return '0.1.' + execSync('git rev-list --count HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return '0.0.0';
  }
}

const out = 'dist/entrenous.mjs';
await esbuild.build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outfile: out,
  minify: true,
  legalComments: 'none',
  banner: { js: '#!/usr/bin/env node\n// Entre Nous CLI: https://github.com/dorianbayart/entre-nous (AGPL-3.0-or-later)' },
  define: { __VERSION__: JSON.stringify(version()) },
  logLevel: 'warning',
});
await chmod(out, 0o755);
