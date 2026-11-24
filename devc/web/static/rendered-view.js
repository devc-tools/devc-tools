// A rendered view of a file's text (Markdown first, `lib/rendered.js`), shared by file tiles'
// media views and diff tiles' previews: the blocks `viewer.js` renders, a diff's change marks on
// them, and its links (a heading in the view, a repo file, a web page). See
// `.plans/devc-web-markdown-preview.md`.

import { h } from './ui.js';
import { markdownBlocks } from './viewer.js';
import { blockMarks } from './lib/rendered.js';

/**
 * Turns an image's `src` in a rendered file into a URL under the file's `/preview/<nonce>/` (the
 * nonce serves the files beside it): relative to the file, or to the nonce's root for a `/…`
 * path, as GitHub takes it to the repo's root. `null` for anything else (a remote or `data:`
 * image, a path out of the nonce), and for every image without a `base`.
 *
 * @param {string | null} base  the file's preview URL
 * @returns {(src: string) => string | null}
 */
export function previewImageResolver(base) {
  if (!base) return () => null;
  const root = /^\/preview\/[^/]+\//.exec(new URL(base).pathname)?.[0];
  if (!root) return () => null;
  const prefix = new URL(root, base).href;
  return (src) => {
    if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(src)) return null;
    try {
      const url = src.startsWith('/')
        ? new URL(src.slice(1), prefix)
        : new URL(src, base);
      return url.href.startsWith(prefix) ? url.href : null;
    } catch {
      return null;
    }
  };
}

/**
 * The repo path a relative link in the file at `path` names (`./a.md`, `../b/c.png#x`), with
 * any query and fragment dropped; '' when it names nothing.
 *
 * @param {string} path  the rendered file's, relative to its root
 * @param {string} href
 */
export function linkedPath(path, href) {
  try {
    const url = href.startsWith('/')
      ? new URL(href, 'file:///')
      : new URL(href, `file:///${path}`);
    return decodeURIComponent(url.pathname).replace(/^\/+/, '');
  } catch {
    return '';
  }
}

/**
 * @typedef {object} RenderedView
 * @property {HTMLElement} el  the scrolling element, to put in a tile
 * @property {(text: string, opts: {base: string | null,
 *   marks?: {added: Set<number>, deleted: Map<number, number>} | 'del'}) => void} render
 *   draws `text`; `marks` a diff's changes (`changeMarks`), or `'del'` for a removed file
 * @property {() => void} clear
 */

/**
 * A rendered view. A click on a link to a heading scrolls to it; on a relative link, calls
 * `openPath` with the repo path it names; an http(s) link opens a new window by itself.
 *
 * @param {{name: string, openPath: (href: string) => void}} opts
 * @returns {RenderedView}
 */
export function createRenderedView(opts) {
  const body = h('article', { class: 'md-body' });
  const el = h('div', { class: 'md-view', 'aria-label': opts.name }, body);
  el.addEventListener('click', (e) => {
    const a = /** @type {HTMLElement} */ (e.target).closest('a');
    if (!a || !el.contains(a)) return;
    const rel = a.getAttribute('data-path');
    const href = a.getAttribute('href') ?? '';
    if (rel !== null) {
      e.preventDefault();
      opts.openPath(rel);
    } else if (href.startsWith('#')) {
      e.preventDefault();
      let want = href.slice(1);
      try {
        want = decodeURIComponent(want);
      } catch { /* as written */ }
      want = want.toLowerCase();
      for (const heading of body.querySelectorAll('[data-anchor]')) {
        if (heading.getAttribute('data-anchor') === want) {
          heading.scrollIntoView({ block: 'start' });
          break;
        }
      }
    }
  });
  return {
    el,
    render(text, { base, marks }) {
      const blocks = markdownBlocks(text, previewImageResolver(base));
      const placed = marks && marks !== 'del'
        ? blockMarks(blocks, marks)
        : null;
      body.classList.toggle('md-diff', !!marks);
      /** @type {Node[]} */
      const nodes = [];
      /** @param {number} n */
      const removed = (n) =>
        h('div', {
          class: 'md-deleted',
          title: n === 1 ? '1 line removed' : `${n} lines removed`,
        });
      blocks.forEach((b, i) => {
        const mark = placed?.blocks[i];
        if (mark?.deleted) nodes.push(removed(mark.deleted));
        const block = h('div', {
          class: 'md-block',
          'data-change': marks === 'del'
            ? 'del'
            : mark?.add
            ? 'add'
            : undefined,
        });
        block.innerHTML = b.html;
        nodes.push(block);
      });
      if (placed?.end) nodes.push(removed(placed.end));
      body.replaceChildren(...nodes);
    },
    clear() {
      body.replaceChildren();
    },
  };
}
