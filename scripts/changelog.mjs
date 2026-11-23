#!/usr/bin/env node
// The changelog: CHANGELOG.md (French) and CHANGELOG.en.md (English), written by hand, one
// "## <version> — <date>" section per version that changed something for the users, each change
// a "- " line (continued by indented lines; **bold** allowed). The version of an entry is the
// version of the commit that adds it (0.1.<number of commits>): `node scripts/changelog.mjs next`.
//   node scripts/changelog.mjs check            both files valid, the same versions
//   node scripts/changelog.mjs json             changelog.json (apps, relay, release asset)
//   node scripts/changelog.mjs notes FROM TO    release notes: the versions after FROM, up to TO
//   node scripts/changelog.mjs next             version of the next commit
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FILES = { fr: 'CHANGELOG.md', en: 'CHANGELOG.en.md' };
const HEADING = /^## (\d+\.\d+\.\d+) — (\d{4}-\d{2}-\d{2})\s*$/;

/** a > b, for versions like 0.1.42 */
export function newer(a, b) {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
}

/** The sections of one file: [{ version, date, items: ['**Bold**: text', …] }], newest first. */
function parse(text, file) {
  const sections = [];
  let item = null;
  text.split('\n').forEach((line, n) => {
    const where = `${file}:${n + 1}`;
    if (line.startsWith('## ')) {
      const m = HEADING.exec(line);
      if (!m) throw new Error(`${where}: heading "## 0.1.42 — 2026-11-23" expected`);
      sections.push({ version: m[1], date: m[2], items: [] });
      item = null;
    } else if (line.startsWith('- ')) {
      if (!sections.length) throw new Error(`${where}: a change before any version`);
      item = line.slice(2).trim();
      sections.at(-1).items.push(item);
    } else if (/^\s+\S/.test(line) && item !== null) {
      sections.at(-1).items[sections.at(-1).items.length - 1] += ' ' + line.trim();
    } else if (line.trim() && sections.length) {
      throw new Error(`${where}: only "- " lines (and their indented continuation) in a version`);
    } else if (!line.trim()) item = null;
  });
  for (const s of sections) if (!s.items.length) throw new Error(`${file}: ${s.version} has no change`);
  for (let i = 1; i < sections.length; i++) {
    if (!newer(sections[i - 1].version, sections[i].version)) throw new Error(`${file}: ${sections[i - 1].version} should come after ${sections[i].version} (newest first)`);
  }
  return sections;
}

/** Both languages, checked against each other: [{ version, date, fr: [...], en: [...] }]. */
export function load(root = ROOT) {
  const [fr, en] = ['fr', 'en'].map((l) => parse(readFileSync(root + FILES[l], 'utf8'), FILES[l]));
  if (fr.map((s) => s.version).join() !== en.map((s) => s.version).join()) {
    throw new Error(`${FILES.fr} and ${FILES.en} do not have the same versions`);
  }
  return fr.map((s, i) => {
    if (s.date !== en[i].date) throw new Error(`${s.version}: not the same date in both files`);
    if (s.items.length !== en[i].items.length) throw new Error(`${s.version}: not the same number of changes in both files`);
    return { version: s.version, date: s.date, fr: s.items, en: en[i].items };
  });
}

/** The entries after `from` (exclusive), up to `to` (inclusive). */
export const between = (entries, from, to) => entries.filter((e) => newer(e.version, from) && !newer(e.version, to));

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cmd, a, b] = process.argv.slice(2);
  try {
    if (cmd === 'check') {
      const entries = load();
      const next = nextVersion();
      if (next && entries[0] && newer(entries[0].version, next)) throw new Error(`${entries[0].version} is beyond the next commit (${next})`);
      console.log(`changelog: ${entries.length} versions, ${entries[0]?.version ?? 'none'} the latest`);
    } else if (cmd === 'json') {
      process.stdout.write(JSON.stringify(load()) + '\n');
    } else if (cmd === 'notes') {
      const list = between(load(), a || '0.0.0', b);
      const block = (lang) => list.map((e) => `### ${e.version}\n` + e[lang].map((i) => `- ${i}`).join('\n')).join('\n\n');
      process.stdout.write(list.length ? `## Nouveautés\n\n${block('fr')}\n\n## What's new\n\n${block('en')}\n` : '');
    } else if (cmd === 'next') {
      console.log(nextVersion());
    } else {
      console.error('usage: changelog.mjs check | json | notes FROM TO | next');
      process.exit(2);
    }
  } catch (err) {
    console.error('changelog: ' + err.message);
    process.exit(1);
  }
}

/** 0.1.<commits + 1>: the version of the commit about to be made (none outside git). */
function nextVersion() {
  try {
    return '0.1.' + (Number(execSync('git rev-list --count HEAD', { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] })) + 1);
  } catch {
    return '';
  }
}
