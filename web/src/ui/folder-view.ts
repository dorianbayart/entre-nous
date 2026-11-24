// The browser of a shared folder, one level at a time: in the app (over the history) and on
// a share link's page. A list with boxes to tick by default; a grid of previews where the
// folder shown holds only images and videos, with a "Choose" mode. The bar at the bottom
// downloads the folder shown, or what is ticked. Plain DOM (the share page has no framework);
// every text is set as text, never parsed as HTML.
import { type FolderDir, type FolderFile, type FolderIndex, baseName, dirName, emptyDirs, filesUnder, isGallery, listDir } from '../core/folder.ts';
import { previewKind } from '../core/media.ts';
import { humanSize, t, tn } from '../i18n/index.ts';

export interface FolderHost {
  index: FolderIndex;
  /** A file's preview made by the sender, as a URL (or nothing). */
  thumb(file: FolderFile): Promise<string | undefined>;
  /** Opens a file's preview; `siblings`: the files of the same folder that have one. */
  open(file: FolderFile, siblings: FolderFile[]): void;
  /** Downloads files (paths kept from `base`, the folder shown), as `name`. */
  download(files: FolderFile[], dirs: string[], base: string, name: string): void;
  /** Closes the browser (the app); none: it stays (a share link's page). */
  close?(): void;
}

const ICONS = {
  back: 'm15 18-6-6 6-6',
  close: 'M6 6l12 12M18 6 6 18',
  right: 'm9 6 6 6-6 6',
  folder: 'M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2.2h7.5A2.5 2.5 0 0 1 21 9.7v7.8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z',
  check: 'm5 12 5 5 9-10',
  down: 'M12 4v11M7 10l5 5 5-5M5 20h14',
  play: 'M7 4.5v15l12-7.5z',
};

function icon(name: keyof typeof ICONS, cls = 'fi') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', cls);
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICONS[name]);
  svg.append(path);
  return svg;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** 0:42, 12:05, 1:02:03 */
function clock(seconds: number) {
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return (h ? `${h}:${String(m).padStart(2, '0')}` : String(m)) + ':' + String(s % 60).padStart(2, '0');
}

const extOf = (path: string) => /\.([a-z0-9]{1,5})$/i.exec(path)?.[1]?.toUpperCase() ?? '';

export class FolderBrowser {
  private dir = '';
  /** Grid or list, as chosen here for a folder of images; null: as the folder suggests. */
  private mode: 'grid' | 'list' | null = null;
  /** Ticked files, by path (in any folder). */
  private picked = new Set<string>();
  private choosing = false;
  private busy = '';
  private observer: IntersectionObserver | null = null;
  /** Previews already read: shown at once when the view is drawn again. */
  private thumbs = new Map<string, string>();
  private bodyEl!: HTMLElement;

  constructor(
    private root: HTMLElement,
    private host: FolderHost,
  ) {
    this.render();
  }

  get path() {
    return this.dir;
  }

  /** Back: one level up, or closed from the top. */
  back() {
    if (this.choosing) return this.stopChoosing();
    if (this.dir) this.go(dirName(this.dir));
    else this.host.close?.();
  }

  go(dir: string) {
    this.dir = dir;
    this.choosing = false;
    this.render();
    this.bodyEl.scrollTop = 0;
  }

  /** A download in progress: its state in the bottom bar (empty: over). */
  setBusy(text: string) {
    this.busy = text;
    this.renderBottom();
  }

  destroy() {
    this.observer?.disconnect();
    this.root.replaceChildren();
  }

  private get listing() {
    return listDir(this.host.index, this.dir);
  }

  private get gridMode() {
    const { files } = this.listing;
    return (this.mode ?? (isGallery(files) ? 'grid' : 'list')) === 'grid' && isGallery(files);
  }

  private bottom!: HTMLElement;

  private render() {
    this.observer?.disconnect();
    this.observer = new IntersectionObserver((entries) => this.onVisible(entries), { root: null, rootMargin: '300px 0px' });
    const { dirs, files } = this.listing;
    const name = this.dir ? baseName(this.dir) : this.host.index.name;

    const bar = el('header', 'viewer-bar folder-bar');
    const back = el('button', 'icon');
    back.append(icon('back'));
    back.title = back.ariaLabel = t('back');
    back.onclick = () => this.back();
    // a share link's page: nothing to close, nothing above the top
    if (!this.host.close && !this.dir) back.hidden = true;
    const title = el('div', 'viewer-title');
    title.append(el('strong', '', name), el('span', '', this.metaOf(filesUnder(this.host.index, this.dir))));
    const close = el('button', 'icon');
    close.append(icon('close'));
    close.title = close.ariaLabel = t('close');
    close.onclick = () => this.host.close?.();
    bar.append(back, title);
    if (this.host.close) bar.append(close);

    const nodes: HTMLElement[] = [bar];
    if (this.dir) nodes.push(this.crumbs());

    const gallery = isGallery(files);
    if (gallery) {
      const tools = el('div', 'folder-tools');
      const seg = el('div', 'segmented');
      seg.setAttribute('role', 'group');
      for (const m of ['grid', 'list'] as const) {
        const b = el('button', '', t(m === 'grid' ? 'folder.grid' : 'folder.list'));
        b.setAttribute('aria-pressed', String(this.gridMode === (m === 'grid')));
        b.onclick = () => {
          this.mode = m;
          this.choosing = false;
          this.render();
        };
        seg.append(b);
      }
      tools.append(seg);
      if (this.gridMode) {
        const choose = el('button', 'small ' + (this.choosing ? 'primary' : 'secondary'), t(this.choosing ? 'folder.chooseDone' : 'folder.choose'));
        choose.onclick = () => (this.choosing ? this.stopChoosing() : this.startChoosing());
        tools.append(choose);
      }
      nodes.push(tools);
    }

    const body = el('div', 'folder-body');
    this.bodyEl = body;
    if (this.gridMode) body.append(...this.gridView(dirs, files));
    else body.append(this.listView(dirs, files));
    if (!dirs.length && !files.length) body.append(el('p', 'empty', t('folder.empty')));
    nodes.push(body);

    this.bottom = el('footer', 'folder-bottom');
    nodes.push(this.bottom);
    this.root.replaceChildren(...nodes);
    this.renderBottom();
  }

  /** "Vacances › Jour 2": each level goes back to it. */
  private crumbs() {
    const nav = el('nav', 'folder-crumbs');
    const parts = this.dir.split('/');
    const top = el('button', 'crumb', this.host.index.name);
    top.onclick = () => this.go('');
    nav.append(top);
    parts.forEach((p, i) => {
      nav.append(icon('right', 'fi sep'));
      const path = parts.slice(0, i + 1).join('/');
      const b = el('button', 'crumb', p);
      if (i === parts.length - 1) b.setAttribute('aria-current', 'page');
      else b.onclick = () => this.go(path);
      nav.append(b);
    });
    return nav;
  }

  private metaOf(files: FolderFile[]) {
    return tn('folder.files', files.length, { n: files.length }) + (files.length ? ' · ' + humanSize(files.reduce((n, f) => n + f.size, 0)) : '');
  }

  // ------------------------------------------------------------ list

  private listView(dirs: FolderDir[], files: FolderFile[]) {
    const list = el('ul', 'folder-list');
    for (const d of dirs) {
      const li = el('li', 'folder-row');
      const under = filesUnder(this.host.index, d.path);
      const n = under.filter((f) => this.picked.has(f.path)).length;
      li.append(this.checkbox(n > 0 && n === under.length, n > 0 && n < under.length, under.length > 0, () => this.toggleAll(under)));
      const main = el('button', 'row-main');
      const th = el('span', 'row-thumb folder-icon');
      th.append(icon('folder'));
      const text = el('span', 'row-text');
      const meta = n > 0 && n < under.length ? t('folder.partial', { n, total: under.length }) : this.metaOf(under);
      text.append(el('span', 'row-name', d.name), el('span', 'row-meta', meta));
      main.append(th, text, icon('right', 'fi chevron'));
      main.onclick = () => this.go(d.path);
      li.append(main);
      list.append(li);
    }
    for (const f of files) {
      const li = el('li', 'folder-row' + (this.picked.has(f.path) ? ' picked' : ''));
      li.append(this.checkbox(this.picked.has(f.path), false, true, () => this.toggle(f)));
      const main = el('button', 'row-main');
      main.append(this.fileThumb(f, 'row-thumb'));
      const text = el('span', 'row-text');
      const meta = [humanSize(f.size)];
      if (f.duration) meta.push(clock(f.duration));
      if (f.pages) meta.push(tn('viewer.pages', f.pages, { n: f.pages }));
      text.append(el('span', 'row-name', baseName(f.path)), el('span', 'row-meta', meta.join(' · ')));
      if (f.excerpt) text.append(el('span', 'row-excerpt', f.excerpt));
      main.append(text);
      // a file with a preview opens it; another one is ticked
      main.onclick = () => (this.previewable(f) ? this.host.open(f, this.siblings()) : this.toggle(f));
      li.append(main);
      list.append(li);
    }
    return list;
  }

  private checkbox(on: boolean, partial: boolean, enabled: boolean, toggle: () => void) {
    const b = el('button', 'tick' + (on ? ' on' : partial ? ' partial' : ''));
    b.setAttribute('role', 'checkbox');
    b.setAttribute('aria-checked', on ? 'true' : partial ? 'mixed' : 'false');
    b.ariaLabel = t('folder.pick');
    b.disabled = !enabled;
    if (on) b.append(icon('check'));
    b.onclick = toggle;
    return b;
  }

  // ------------------------------------------------------------ grid

  private gridView(dirs: FolderDir[], files: FolderFile[]) {
    const out: HTMLElement[] = [];
    if (dirs.length) {
      const chips = el('div', 'folder-chips');
      for (const d of dirs) {
        const b = el('button', 'folder-chip');
        b.append(icon('folder'), el('span', '', d.name), el('small', '', String(d.files)));
        b.onclick = () => this.go(d.path);
        chips.append(b);
      }
      out.push(chips);
    }
    const grid = el('div', 'folder-grid' + (this.choosing ? ' choosing' : ''));
    for (const f of files) {
      const b = el('button', 'tile' + (this.picked.has(f.path) ? ' picked' : ''));
      b.title = baseName(f.path);
      b.append(this.fileThumb(f, 'tile-img'));
      if (previewKind(baseName(f.path), f.mime) === 'video') {
        const badge = el('span', 'tile-badge');
        badge.append(icon('play', 'fi play'));
        if (f.duration) badge.append(el('span', '', clock(f.duration)));
        b.append(badge);
      }
      if (this.choosing) {
        const mark = el('span', 'tile-mark' + (this.picked.has(f.path) ? ' on' : ''));
        if (this.picked.has(f.path)) mark.append(icon('check'));
        b.append(mark);
      }
      b.onclick = () => (this.choosing ? this.toggle(f) : this.host.open(f, this.siblings()));
      grid.append(b);
    }
    out.push(grid);
    return out;
  }

  private startChoosing() {
    this.choosing = true;
    this.render();
  }

  private stopChoosing() {
    this.choosing = false;
    this.picked.clear();
    this.render();
  }

  // ------------------------------------------------------------ thumbnails

  /** A file's preview (loaded when it comes near the screen), or its type. */
  private fileThumb(f: FolderFile, cls: string) {
    const box = el('span', cls);
    const kind = previewKind(baseName(f.path), f.mime);
    if (f.thumb) {
      const img = el('img');
      img.alt = '';
      img.decoding = 'async';
      box.append(img);
      const known = this.thumbs.get(f.path);
      if (known) img.src = known;
      else {
        (img as any)._file = f;
        this.observer!.observe(img);
      }
    } else {
      box.classList.add('doc');
      box.append(el('b', '', kind === 'pdf' ? 'PDF' : extOf(f.path)));
    }
    return box;
  }

  private onVisible(entries: IntersectionObserverEntry[]) {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const img = e.target as HTMLImageElement;
      this.observer?.unobserve(img);
      const f: FolderFile = (img as any)._file;
      this.host.thumb(f).then((url) => {
        if (!url) return;
        this.thumbs.set(f.path, url);
        img.src = url;
      });
    }
  }

  // ------------------------------------------------------------ choice and download

  private previewable(f: FolderFile) {
    return !!previewKind(baseName(f.path), f.mime);
  }

  /** The files of the folder shown that open in a preview (the viewer goes from one to the next). */
  private siblings() {
    return this.listing.files.filter((f) => this.previewable(f));
  }

  private toggle(f: FolderFile) {
    if (this.picked.has(f.path)) this.picked.delete(f.path);
    else this.picked.add(f.path);
    this.render();
  }

  private toggleAll(files: FolderFile[]) {
    const all = files.every((f) => this.picked.has(f.path));
    for (const f of files) {
      if (all) this.picked.delete(f.path);
      else this.picked.add(f.path);
    }
    this.render();
  }

  private renderBottom() {
    const b = this.bottom;
    if (!b) return;
    const sum = el('div', 'folder-sum');
    const actions: HTMLElement[] = [];
    const index = this.host.index;
    if (this.picked.size) {
      const files = index.files.filter((f) => this.picked.has(f.path));
      sum.append(el('strong', '', tn('folder.chosen', files.length, { n: files.length })), el('span', '', humanSize(files.reduce((n, f) => n + f.size, 0))));
      const clear = el('button', 'small ghost', t('cancel'));
      clear.onclick = () => (this.choosing ? this.stopChoosing() : (this.picked.clear(), this.render()));
      const go = el('button', 'primary', t('folder.download'));
      go.prepend(icon('down'));
      go.onclick = () => {
        // paths from the folder that holds them all
        let base = dirName(files[0].path);
        while (base && !files.every((f) => f.path.startsWith(base + '/'))) base = dirName(base);
        this.host.download(files, [], base, base ? baseName(base) : index.name);
      };
      actions.push(clear, go);
    } else {
      const files = filesUnder(index, this.dir);
      sum.append(el('strong', '', this.dir ? baseName(this.dir) : t('folder.whole')), el('span', '', this.metaOf(files)));
      const go = el('button', 'primary', t(this.dir ? 'folder.downloadDir' : 'folder.downloadAll'));
      go.prepend(icon('down'));
      go.disabled = !files.length;
      go.onclick = () => this.host.download(files, emptyDirs(index, this.dir), this.dir, this.dir ? baseName(this.dir) : index.name);
      actions.push(go);
    }
    if (this.busy) {
      sum.replaceChildren(el('strong', '', t('folder.downloading')), el('span', '', this.busy));
      for (const a of actions) (a as HTMLButtonElement).disabled = true;
    }
    b.replaceChildren(sum, ...actions);
  }
}
