// Markdown preview: markdown-it (MIT), loaded only when a Markdown file is opened.
// The text comes from another device, so it is shown, never run:
//  - HTML in it is written as text (html: false), links other than http(s) and mailto are
//    refused (markdown-it's own check, then ours);
//  - images are not loaded (a remote image would tell its server who reads the file): their
//    text is shown instead; the page's policy would block them anyway.
let md: Promise<{ render(src: string): string }> | undefined;

function renderer() {
  return (md ??= import('markdown-it').then(({ default: MarkdownIt }) => {
    const m = new MarkdownIt({ html: false, linkify: true, breaks: false });
    m.disable('image');
    return m;
  }));
}

const SAFE_LINK = /^(https?:|mailto:)/i;

/** Renders `src` into `el`: safe HTML, links opening outside, task lists as boxes. */
export async function renderMarkdown(el: HTMLElement, src: string) {
  const html = (await renderer()).render(src);
  el.innerHTML = html; // from markdown-it with html: false: no markup of the file's own
  for (const a of Array.from(el.querySelectorAll('a'))) {
    const href = a.getAttribute('href') ?? '';
    if (!SAFE_LINK.test(href)) {
      a.replaceWith(...Array.from(a.childNodes));
      continue;
    }
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
  }
  // "- [ ] to do" and "- [x] done"
  for (const li of Array.from(el.querySelectorAll('li'))) {
    const first = li.firstChild?.nodeType === Node.TEXT_NODE ? li.firstChild : li.firstElementChild?.tagName === 'P' ? li.firstElementChild.firstChild : null;
    const m = first?.nodeType === Node.TEXT_NODE ? /^\[( |x|X)\]\s/.exec(first.textContent ?? '') : null;
    if (!first || !m) continue;
    first.textContent = (first.textContent ?? '').slice(m[0].length);
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.disabled = true;
    box.checked = m[1] !== ' ';
    first.parentNode!.insertBefore(box, first);
    li.classList.add('task');
    if (box.checked) li.classList.add('done');
  }
}
