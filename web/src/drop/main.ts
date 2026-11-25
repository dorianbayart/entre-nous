// The page of a file request (/r/#<secret>), for someone outside the group: no account, no app.
// The person picks files; each pick is one item of the group's history (several files make a
// folder), encrypted here and sent at once, with the name they gave. Plain DOM: no framework,
// a strict Content Security Policy.
import { CHUNK_SIZE } from '../core/crypto.ts';
import { DROP_NAME_MAX, DropFullError, DropGoneError, type DropLink, dropSecretOf, openDrop } from '../core/drop.ts';
import type { Header } from '../core/items.ts';
import { duration, humanSize, lang, t } from '../i18n/index.ts';
import { prepareFolder } from '../ui/folder-send.ts';
import { preview } from '../ui/previews.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

document.documentElement.lang = lang();
$('e2e').textContent = t('deposit.e2e');
$('cta').textContent = t('deposit.cta') + ' →';

const NAME_KEY = 'entrenous-name';

function state(text: string) {
  $('state-text').textContent = text;
  $('state').hidden = false;
  $('deposit').hidden = true;
}

/** A file of the list: its line, and how far it got. */
interface Row {
  file: File;
  path: string;
  li: HTMLLIElement;
  status: HTMLSpanElement;
  /** In the folder's archive (several files): where its bytes are. */
  offset?: number;
}

let link: DropLink;
let queue: Promise<void> = Promise.resolve();
let busy = 0;
let stopped = false;

async function main() {
  const secret = dropSecretOf(location.href);
  if (!secret) return state(t('visit.bad'));
  state(t('viewer.loading'));
  try {
    link = await openDrop(location.origin, secret);
  } catch (err: any) {
    return state(err instanceof DropGoneError ? t('visit.gone') : t('visit.error', { msg: err?.message ?? err }));
  }
  show();
}

function show() {
  $('lead').textContent = t('deposit.lead');
  if (link.msg) {
    $('ask-label').textContent = t('deposit.message');
    $('ask-text').textContent = link.msg;
    $('ask').hidden = false;
  }
  $('name-label').textContent = t('deposit.name');
  const name = $<HTMLInputElement>('name');
  try {
    name.value = localStorage.getItem(NAME_KEY) ?? '';
  } catch {}
  name.oninput = () => {
    try {
      localStorage.setItem(NAME_KEY, name.value.trim());
    } catch {}
  };
  $('pick').textContent = t('deposit.pick');
  $('drop-here').textContent = t('deposit.dropHere');
  const meta = () => {
    $('meta').textContent = t('share.left', { left: duration(link.expiresAt - Date.now()) });
  };
  meta();
  setInterval(meta, 30_000);
  $('state').hidden = true;
  $('deposit').hidden = false;

  const input = $<HTMLInputElement>('files');
  $('zone').onclick = () => input.click();
  input.onchange = () => {
    const files = [...(input.files ?? [])];
    input.value = '';
    if (files.length) pick(files);
  };
  // files dropped anywhere on the page
  const zone = $('zone');
  document.addEventListener('dragover', (e) => {
    if (stopped || !e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    zone.classList.add('over');
  });
  document.addEventListener('dragleave', (e) => {
    if (!e.relatedTarget) zone.classList.remove('over');
  });
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('over');
    const files = [...(e.dataTransfer?.files ?? [])].filter((f) => f.size > 0 || f.type);
    if (!stopped && files.length) pick(files);
  });
  // leaving while sending loses what is not sent yet
  window.addEventListener('beforeunload', (e) => {
    if (busy) e.preventDefault();
  });
}

/** One pick: shown at once, sent after the previous ones. */
function pick(files: File[]) {
  const rows = files.map((file) => row(file));
  $('list').hidden = false;
  const zone = $('zone');
  zone.classList.add('compact');
  $('pick').textContent = t('deposit.more');
  busy++;
  queue = queue.then(() => send(rows)).finally(() => busy--);
}

function row(file: File): Row {
  const li = document.createElement('li');
  const thumb = document.createElement('span');
  thumb.className = 'deposit-thumb';
  // a file's mark, under the picture of an image (if this browser can show it)
  const ns = 'http://www.w3.org/2000/svg';
  const icon = document.createElementNS(ns, 'svg');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('aria-hidden', 'true');
  for (const d of ['M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z', 'M14 3v5h5']) {
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', d);
    icon.append(path);
  }
  thumb.append(icon);
  if (file.type.startsWith('image/') && file.size < 50 * 1024 * 1024) {
    const img = document.createElement('img');
    img.alt = '';
    img.src = URL.createObjectURL(file);
    img.onerror = () => img.remove(); // not decodable here (HEIC outside Safari)
    thumb.append(img);
  }
  const name = document.createElement('span');
  name.className = 'deposit-file';
  const strong = document.createElement('strong');
  strong.textContent = file.name;
  const size = document.createElement('small');
  size.textContent = humanSize(file.size);
  name.append(strong, size);
  const status = document.createElement('span');
  status.className = 'deposit-state';
  status.textContent = t('deposit.waiting');
  li.append(thumb, name, status);
  $('list').append(li);
  return { file, path: file.name, li, status };
}

function setState(r: Row, text: string, cls = '') {
  r.status.className = 'deposit-state' + (cls ? ' ' + cls : '');
  r.status.replaceChildren(text);
}

/** A ring and a percentage. */
function setProgress(r: Row, part: number) {
  const pct = Math.max(0, Math.min(100, Math.floor(part * 100)));
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 36 36');
  svg.setAttribute('class', 'ring');
  svg.setAttribute('aria-hidden', 'true');
  for (const [cls, extra] of [
    ['ring-track', {}],
    ['ring-bar', { pathLength: '100', 'stroke-dasharray': '100', 'stroke-dashoffset': String(100 - pct) }],
  ] as const) {
    const c = document.createElementNS(ns, 'circle');
    c.setAttribute('class', cls);
    c.setAttribute('cx', '18');
    c.setAttribute('cy', '18');
    c.setAttribute('r', '15.9155');
    for (const [k, v] of Object.entries(extra)) c.setAttribute(k, v);
    svg.append(c);
  }
  r.status.className = 'deposit-state';
  r.status.replaceChildren(svg, `${pct} %`);
}

/** Several files with the same name in one pick: "photo (2).jpg". */
function uniquePaths(rows: Row[]) {
  const seen = new Set<string>();
  for (const r of rows) {
    let path = r.file.name.replace(/[/\\]/g, '_') || 'file';
    const dot = path.lastIndexOf('.');
    const [base, ext] = dot > 0 ? [path.slice(0, dot), path.slice(dot)] : [path, ''];
    for (let n = 2; seen.has(path); n++) path = `${base} (${n})${ext}`;
    seen.add(path);
    r.path = path;
  }
}

async function send(rows: Row[]) {
  if (stopped) {
    for (const r of rows) setState(r, t('deposit.notSent'), 'failed');
    return;
  }
  const by = $<HTMLInputElement>('name').value.trim().slice(0, DROP_NAME_MAX);
  for (const r of rows) setState(r, t('deposit.preparing'));
  try {
    let src: Blob | Awaited<ReturnType<typeof prepareFolder>>['source'];
    let header: Header;
    if (rows.length === 1) {
      const file = rows[0].file;
      const { kind, extra } = await preview(file, file.name);
      const { thumb, w, h, duration: length, pages, excerpt } = extra;
      header = { kind, ts: Date.now(), name: file.name, mime: file.type || undefined, size: file.size };
      Object.assign(header, JSON.parse(JSON.stringify({ thumb, w, h, duration: length, pages, excerpt })));
      src = file;
    } else {
      uniquePaths(rows);
      const pack = await prepareFolder({
        name: '',
        files: rows.map((r) => ({ path: r.path, size: r.file.size, mime: r.file.type, src: r.file, blob: async () => r.file })),
        dirs: [],
        ignored: 0,
        bytes: rows.reduce((n, r) => n + r.file.size, 0),
      });
      for (const f of pack.index.files) {
        const r = rows.find((x) => x.path === f.path);
        if (r) r.offset = f.offset;
      }
      header = { kind: 'folder', ts: Date.now(), size: pack.source.size, folder: pack.summary };
      if (pack.thumb) header.thumb = pack.thumb;
      src = pack.source;
    }
    if (by) header.by = by;
    await link.send(src, header, (done, total) => {
      const sent = done * CHUNK_SIZE;
      for (const r of rows) {
        // the chunks go roughly in order: a file is as far as the bytes before its end
        const start = r.offset ?? 0;
        const part = r.file.size ? (sent - start) / r.file.size : done / total;
        setProgress(r, done === total ? 1 : part);
      }
    });
    for (const r of rows) setState(r, t('deposit.sent'), 'done');
  } catch (err: any) {
    const msg = err instanceof DropFullError ? t('deposit.full') : err instanceof DropGoneError ? t('visit.gone') : t('deposit.failed', { msg: err?.message ?? err });
    for (const r of rows) setState(r, t('deposit.notSent'), 'failed');
    const alert = $('error');
    alert.textContent = msg;
    alert.hidden = false;
    if (err instanceof DropGoneError) {
      // nothing more can be sent: the queue stops
      stopped = true;
      $('zone').hidden = true;
    }
  }
}

window.addEventListener('hashchange', () => location.reload());
main();
