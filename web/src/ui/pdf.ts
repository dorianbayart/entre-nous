// PDF previews: pdf.js (Apache-2.0, Mozilla), loaded only when a PDF is opened or sent. It asks
// for the byte ranges it needs (the table at the end of the file, then the objects of the pages
// shown), which come from the engine's reader, decrypted on demand: the first page of a big
// file shows without downloading the rest. On the sending side, the same from the file itself:
// the first page as a thumbnail, and the number of pages.
// Over each page: its text, transparent, to select and copy it (pdf.js's text layer), and its
// links: web links (http, https, mailto) open outside, like in a Markdown file; the others go to
// a page of the document.
// Safe settings: no PDF scripts, no XFA forms, no WebAssembly (the app's policy forbids it: the
// rare JPEG 2000 images do not show), no fetch from the worker.
import type { ContentReader } from '../core/engine.ts';

type PdfJs = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
export type PdfDocument = import('pdfjs-dist/legacy/build/pdf.mjs').PDFDocumentProxy;

let lib: Promise<PdfJs> | undefined;
function pdfjs(): Promise<PdfJs> {
  return (lib ??= import('pdfjs-dist/legacy/build/pdf.mjs').then((m) => {
    m.GlobalWorkerOptions.workerSrc = new URL('pdf.worker.js', document.baseURI).href;
    return m;
  }));
}

/** Bytes a PDF is read by: as pdf.js asks for them. */
const RANGE = 128 * 1024;

/**
 * Opens the PDF that `reader` holds. Resolves with the document and the function that closes
 * it (and the reader).
 */
export async function openPdf(reader: ContentReader): Promise<{ doc: PdfDocument; close: () => void }> {
  const { getDocument, PDFDataRangeTransport } = await pdfjs();
  let failed: (err: unknown) => void = () => {};
  const failure = new Promise<never>((_, reject) => (failed = reject));
  class Ranges extends PDFDataRangeTransport {
    override requestDataRange(begin: number, end: number) {
      reader.read(begin, Math.min(end, reader.size)).then(
        (data) => this.onDataRange(begin, data.slice()), // the copy goes to the worker
        (err) => failed(err),
      );
    }
  }
  const task = getDocument({
    range: new Ranges(reader.size, null),
    length: reader.size,
    rangeChunkSize: RANGE,
    disableAutoFetch: true,
    disableStream: true,
    enableXfa: false,
    useWasm: false,
    useWorkerFetch: false,
    isEvalSupported: false,
  } as any);
  const close = () => {
    task.destroy().catch(() => {});
    reader.close();
  };
  try {
    const doc = await Promise.race([task.promise, failure]);
    return { doc, close };
  } catch (err) {
    close();
    throw err;
  }
}

/**
 * Draws page `n` (from 1) in `canvas`, `width` CSS pixels wide (at the screen's density).
 * Resolves with the page's height in CSS pixels.
 */
export async function drawPage(doc: PdfDocument, n: number, canvas: HTMLCanvasElement, width: number): Promise<number> {
  const page = await doc.getPage(n);
  const base = page.getViewport({ scale: 1 });
  const ratio = Math.min(window.devicePixelRatio || 1, 3);
  const scale = width / base.width;
  // a canvas of 16 million pixels at most (a huge page, a strong zoom)
  const density = Math.min(ratio, Math.sqrt(16e6 / (base.width * scale * base.height * scale)));
  const viewport = page.getViewport({ scale: scale * density });
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  await page.render({ canvas, viewport } as any).promise;
  page.cleanup();
  return (base.height * width) / base.width;
}

const SAFE_LINK = /^(https?:|mailto:)/i;

/** The page (from 1) a link inside the document goes to, or null. */
async function pageOf(doc: PdfDocument, dest: unknown): Promise<number | null> {
  try {
    const d = typeof dest === 'string' ? await doc.getDestination(dest) : dest;
    if (!Array.isArray(d)) return null;
    const ref = d[0];
    const index = ref && typeof ref === 'object' ? await doc.getPageIndex(ref) : Number.isInteger(ref) ? (ref as number) : null;
    return index === null ? null : index + 1;
  } catch {
    return null;
  }
}

/**
 * Over page `n`, `width` CSS pixels wide: its text in `text` (selectable, transparent), its
 * links in `links`. `goTo`: a link to another page of the document.
 */
export async function drawLayers(doc: PdfDocument, n: number, text: HTMLElement, links: HTMLElement, width: number, goTo: (page: number) => void) {
  const { TextLayer } = await pdfjs();
  const page = await doc.getPage(n);
  const viewport = page.getViewport({ scale: width / page.getViewport({ scale: 1 }).width });
  text.replaceChildren();
  links.replaceChildren();
  text.style.setProperty('--total-scale-factor', String(viewport.scale));
  text.style.setProperty('--scale-round-x', '1px');
  text.style.setProperty('--scale-round-y', '1px');
  await new TextLayer({ textContentSource: page.streamTextContent(), container: text, viewport }).render();
  const end = document.createElement('div');
  end.className = 'endOfContent'; // where a selection dragged past the text ends
  text.append(end);
  for (const a of (await page.getAnnotations({ intent: 'display' })) as any[]) {
    if (a.subtype !== 'Link') continue;
    const [x1, y1] = viewport.convertToViewportPoint(a.rect[0], a.rect[1]);
    const [x2, y2] = viewport.convertToViewportPoint(a.rect[2], a.rect[3]);
    const link = document.createElement('a');
    Object.assign(link.style, {
      left: Math.min(x1, x2) + 'px',
      top: Math.min(y1, y2) + 'px',
      width: Math.abs(x2 - x1) + 'px',
      height: Math.abs(y2 - y1) + 'px',
    });
    if (typeof a.url === 'string' && SAFE_LINK.test(a.url)) {
      link.href = a.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.title = a.url;
    } else if (a.dest) {
      const target = await pageOf(doc, a.dest);
      if (target === null) continue;
      link.href = '#';
      link.addEventListener('click', (e) => {
        e.preventDefault();
        goTo(target);
      });
    } else continue;
    links.append(link);
  }
  page.cleanup();
}

/** The size of page `n`, in PDF points. */
export async function pageSize(doc: PdfDocument, n: number): Promise<{ w: number; h: number }> {
  const v = (await doc.getPage(n)).getViewport({ scale: 1 });
  return { w: v.width, h: v.height };
}

/** A file to be sent, read like the content of an item: by slices, without loading it whole. */
export function blobReader(blob: Blob): ContentReader {
  return {
    size: blob.size,
    read: async (start, end) => new Uint8Array(await blob.slice(start, end).arrayBuffer()),
    close() {},
  };
}
