// A rendered view of a file's text (Markdown first, `lib/rendered.js`), shared by file tiles'
// media views and diff tiles' previews: the blocks `viewer.js` renders, a diff's change marks on
// them, its links (a heading in the view, a repo file, a web page), and its Mermaid diagrams. See
// `.plans/archived/devc-web-markdown-preview.md` and `.plans/devc-web-mermaid.md`.

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

// ---------------------------------------------------------------------------------------------
// Mermaid: a ```mermaid code block drawn as a diagram (`vendor/mermaid/`, loaded on first use)
// ---------------------------------------------------------------------------------------------

/** @type {Promise<any> | null} the Mermaid module, once asked for */
let mermaidLoad = null;
/** Mermaid draws one diagram at a time: each waits for the one before. */
let mermaidQueue = Promise.resolve();
let mermaidSeq = 0;
/**
 * Drawn diagrams by source, oldest first: a redraw of the same text (a save, a diff read again)
 * draws only what changed. Their blob URLs are let go when they drop out.
 *
 * @type {Map<string, MermaidImage>}
 */
const mermaidDrawn = new Map();
const MAX_MERMAID_DRAWN = 64;

/** @typedef {{url: string, width: number, height: number} | {error: string}} MermaidImage */

function loadMermaid() {
  mermaidLoad ??= import('./vendor/mermaid/mermaid.esm.min.mjs').then(
    (m) => {
      const mermaid = m.default;
      // `strict`: no click handlers, no HTML of the diagram's own in labels. A diagram's
      // `%%{init}%%` can't change it (Mermaid keeps it out of reach of directives). Always the
      // light theme: the diagram sits on a light card (style.css), as most are written for one.
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: 'default',
        suppressErrorRendering: true,
      });
      return mermaid;
    },
    (e) => {
      mermaidLoad = null;
      throw e;
    },
  );
  return mermaidLoad;
}

/**
 * Mermaid's SVG as an image's blob URL, sized from its `viewBox` (Mermaid's own `width="100%"`
 * would leave an image with no size). Parsed as HTML, which Mermaid's markup is (its labels'
 * `<br>`), and written back as XML, which an SVG file has to be.
 *
 * @param {string} svg
 * @returns {MermaidImage}
 */
function svgImage(svg) {
  const doc = new DOMParser().parseFromString(svg, 'text/html');
  const root = doc.querySelector('svg');
  if (!root) return { error: 'Mermaid drew nothing' };
  const box = (root.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/)
    .map(Number);
  const width = Math.ceil(box[2]);
  const height = Math.ceil(box[3]);
  if (!(width > 0 && height > 0)) return { error: 'Mermaid drew no size' };
  root.setAttribute('width', String(width));
  root.setAttribute('height', String(height));
  /** @type {HTMLElement} */ (/** @type {unknown} */ (root)).style
    .removeProperty('max-width');
  const xml = new XMLSerializer().serializeToString(root);
  return {
    url: URL.createObjectURL(new Blob([xml], { type: 'image/svg+xml' })),
    width,
    height,
  };
}

/**
 * A diagram drawn from its source, or why not.
 *
 * @param {string} source
 * @returns {Promise<MermaidImage>}
 */
function mermaidImage(source) {
  const done = mermaidDrawn.get(source);
  if (done) {
    mermaidDrawn.delete(source);
    mermaidDrawn.set(source, done);
    return Promise.resolve(done);
  }
  const job = mermaidQueue.then(async () => {
    const again = mermaidDrawn.get(source);
    if (again) return again;
    /** @type {MermaidImage} */
    let image;
    try {
      const mermaid = await loadMermaid();
      const { svg } = await mermaid.render(
        `devc-mermaid-${++mermaidSeq}`,
        source,
      );
      image = svgImage(svg);
    } catch (e) {
      image = { error: String(/** @type {any} */ (e)?.message ?? e) };
    }
    mermaidDrawn.set(source, image);
    while (mermaidDrawn.size > MAX_MERMAID_DRAWN) {
      const [oldest, gone] = mermaidDrawn.entries().next().value ?? [];
      if (oldest === undefined) break;
      mermaidDrawn.delete(oldest);
      if (gone && 'url' in gone) URL.revokeObjectURL(gone.url);
    }
    return image;
  });
  mermaidQueue = job.then(() => {}, () => {});
  return job;
}

/**
 * Turns a rendered body's ```mermaid code blocks into diagrams, each on its card once drawn.
 * One that can't be drawn keeps its code, under the reason. `current` says whether the body
 * still shows what these blocks came from.
 *
 * @param {HTMLElement} body @param {() => boolean} current
 */
function drawDiagrams(body, current) {
  for (const code of body.querySelectorAll('pre > code.language-mermaid')) {
    const pre = /** @type {HTMLElement} */ (code.parentElement);
    const source = code.textContent ?? '';
    const card = h(
      'div',
      { class: 'md-mermaid', 'aria-busy': 'true' },
      h('div', { class: 'md-mermaid-note' }, 'Drawing diagram…'),
    );
    pre.replaceWith(card);
    void mermaidImage(source).then((image) => {
      if (!current() || !card.isConnected) return;
      card.removeAttribute('aria-busy');
      if ('error' in image) {
        card.classList.add('md-mermaid-failed');
        card.replaceChildren(
          h('div', { class: 'md-mermaid-note' }, `Mermaid: ${image.error}`),
          pre,
        );
        return;
      }
      card.replaceChildren(h('img', {
        src: image.url,
        width: String(image.width),
        height: String(image.height),
        alt: 'Mermaid diagram',
        draggable: 'false',
      }));
    });
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
  /** Bumped by each draw: a diagram finishing for an older one is dropped. */
  let drawn = 0;
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
      const at = ++drawn;
      drawDiagrams(body, () => drawn === at);
    },
    clear() {
      drawn++;
      body.replaceChildren();
    },
  };
}
