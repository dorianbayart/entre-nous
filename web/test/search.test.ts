// Search in the history: words, accents, types, highlighting, the part of a long text shown.
//   node test/run.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { type Searchable, highlight, isType, linkOf, matches, normalize, snippet } from '../src/core/search.ts';

const wifi: Searchable = { kind: 'text', text: 'Code Wi-Fi invités : Merlin-étoile-2026', fromName: 'Pixel' };
const link: Searchable = { kind: 'text', text: 'Le train : https://www.sncf-connect.com/app/trips', fromName: 'Mac' };
const photo: Searchable = { kind: 'file', name: 'IMG_2041.JPG', mime: 'image/jpeg', fromName: 'Pixel' };
const pasted: Searchable = { kind: 'image', mime: 'image/png', fromName: 'Mac' };
const video: Searchable = { kind: 'file', name: 'vacances-été.mp4', mime: 'video/mp4', fromName: 'iPhone' };
const song: Searchable = { kind: 'file', name: 'message vocal.m4a', fromName: 'Pixel' };
const pdf: Searchable = { kind: 'file', name: 'Facture-EDF-novembre.pdf', mime: 'application/pdf', fromName: 'Mac' };
const notes: Searchable = { kind: 'file', name: 'notes.md', excerpt: '# Réunion du 18 novembre', fromName: 'Mac' };
const zip: Searchable = { kind: 'file', name: 'build.zip', fromName: 'Mac' };
const folder: Searchable = { kind: 'folder', name: 'Photos soirée', fromName: 'Mac' };
const long: Searchable = { kind: 'text', excerpt: 'Début d’un très long texte https://example.org', fromName: 'Mac' };

test('normalize: no accents, lower case, no hyphens or apostrophes', () => {
  assert.equal(normalize('Étoile À ÇA'), 'etoile a ca');
  assert.equal(normalize('Wi-Fi l’été'), 'wifi lete');
});

test('every word, in any order, accents and case ignored', () => {
  assert.ok(matches(wifi, 'wifi'), 'hyphens do not count');
  assert.ok(matches(wifi, 'wi-fi'));
  assert.ok(matches({ kind: 'text', text: 'aujourd’hui' }, "aujourd'hui"), 'nor apostrophes');
  assert.ok(matches(wifi, 'ETOILE merlin'));
  assert.ok(matches(wifi, 'invites code'));
  assert.ok(!matches(wifi, 'merlin lyon'));
  assert.ok(matches(wifi, '  '), 'an empty query finds everything');
});

test('file names, the start of a text file, the sender', () => {
  assert.ok(matches(pdf, 'facture edf'));
  assert.ok(matches(notes, 'reunion'));
  assert.ok(matches(video, 'ete'));
  assert.ok(matches(photo, 'pixel'));
  assert.ok(!matches(photo, 'mac'));
});

test('types', () => {
  assert.ok(isType(wifi, 'text') && !isType(wifi, 'link'));
  assert.ok(isType(link, 'text') && isType(link, 'link'), 'a text holding a link is both');
  assert.ok(isType(long, 'link'), 'a long text: its start');
  assert.ok(isType(photo, 'image') && isType(pasted, 'image'));
  assert.ok(isType(video, 'video') && !isType(video, 'doc'));
  assert.ok(isType(song, 'audio'));
  assert.ok(isType(pdf, 'doc') && isType(notes, 'doc') && isType(zip, 'doc'));
  assert.ok(isType(folder, 'folder') && !isType(folder, 'doc'));
  assert.ok(!isType({ kind: 'note' }, 'text'));
  assert.ok(matches(photo, '', 'image') && !matches(photo, '', 'video'));
  assert.ok(matches(photo, 'img', 'image') && !matches(photo, 'facture', 'image'));
});

test('highlight: the words found, in the original text', () => {
  assert.deepEqual(highlight('Merlin-étoile', 'ETOILE'), [
    { text: 'Merlin-', hit: false },
    { text: 'étoile', hit: true },
  ]);
  assert.deepEqual(highlight('Code Wi-Fi', 'wifi'), [
    { text: 'Code ', hit: false },
    { text: 'Wi-Fi', hit: true },
  ]);
  assert.deepEqual(highlight('abc', ''), [{ text: 'abc', hit: false }]);
  assert.deepEqual(highlight('abc', 'x'), [{ text: 'abc', hit: false }]);
  assert.deepEqual(highlight('aXa', 'a'), [
    { text: 'a', hit: true },
    { text: 'X', hit: false },
    { text: 'a', hit: true },
  ]);
  // characters outside the BMP stay whole
  assert.equal(
    highlight('🙂 ok 🙂', 'ok')
      .map((p) => (p.hit ? `[${p.text}]` : p.text))
      .join(''),
    '🙂 [ok] 🙂',
  );
});

test('snippet: a long text shows where the word is', () => {
  assert.equal(snippet('court', 'court'), 'court');
  const text = 'a '.repeat(200) + 'le mot de passe est Merlin, à changer';
  const s = snippet(text, 'merlin');
  assert.ok(s.startsWith('…') && s.includes('Merlin') && s.length < 80, s);
  assert.equal(snippet(text, 'absent'), text);
  const lines = 'un\ndeux\ntrois\nquatre\ncinq Merlin';
  assert.equal(snippet(lines, 'merlin'), '…cinq Merlin');
});

test('linkOf: the first link of a text, to open it', () => {
  assert.deepEqual(linkOf('https://example.org/a?b=1'), { url: 'https://example.org/a?b=1', whole: true });
  assert.deepEqual(linkOf('  https://example.org/\n'), { url: 'https://example.org/', whole: true });
  assert.deepEqual(linkOf('Regarde ça : https://example.org/page.'), { url: 'https://example.org/page', whole: false });
  assert.deepEqual(linkOf('Titre de la page\nhttps://example.org/x'), { url: 'https://example.org/x', whole: false });
  assert.equal(linkOf('(voir https://example.org/a)')?.url, 'https://example.org/a');
  assert.equal(linkOf('https://fr.wikipedia.org/wiki/Alien_(film)')?.url, 'https://fr.wikipedia.org/wiki/Alien_(film)');
  assert.equal(linkOf('« https://example.org/b »')?.url, 'https://example.org/b');
  assert.equal(linkOf('un https://a.org/ puis https://b.org/')?.url, 'https://a.org/');
  assert.equal(linkOf('mot de passe : Merlin42'), undefined);
  assert.equal(linkOf('ftp://example.org/ javascript:alert(1)'), undefined);
  assert.equal(linkOf('http://'), undefined);
});
