// Live reload's decisions, kept apart from the page so they can be tested: which of a
// `static_changed` message's paths a page uses, and whether it must reload for them or can swap
// its stylesheets in place. See `client.js` and `.plans/archived/devc-web-live.md`.

/**
 * The page file served for a page path relative to the static root: `''` → `index.html`,
 * `sidebar` → `sidebar.html`.
 *
 * @param {string} page
 */
export function pageFile(page) {
  return `${page === '' ? 'index' : page}.html`;
}

/**
 * The static files a page loaded, relative to the static root (`base`, a pathname ending in `/`),
 * from its resource URLs plus the page file itself. URLs from other origins or outside `base` are
 * left out, and so is a query (`style.css?g=…` is `style.css`).
 *
 * @param {string[]} urls @param {string} origin @param {string} base @param {string} page
 * @returns {Set<string>}
 */
export function loadedPaths(urls, origin, base, page) {
  const out = new Set([pageFile(page)]);
  for (const href of urls) {
    let url;
    try {
      url = new URL(href);
    } catch {
      continue;
    }
    if (url.origin !== origin || !url.pathname.startsWith(base)) continue;
    out.add(url.pathname.slice(base.length));
  }
  return out;
}

/**
 * What a page does about a `static_changed`: `reload` when it is unknown what changed (no
 * paths) or a file the page loaded changed that is not a stylesheet; otherwise it swaps `css`,
 * the changed stylesheets it loaded (none when it uses none of the changed files).
 *
 * @param {string[]} paths @param {Set<string>} loaded
 * @returns {{reload: boolean, css: string[]}}
 */
export function planStaticChange(paths, loaded) {
  if (paths.length === 0) return { reload: true, css: [] };
  const used = paths.filter((p) => loaded.has(p));
  if (used.some((p) => !p.endsWith('.css'))) return { reload: true, css: [] };
  return { reload: false, css: used };
}

/**
 * The host status strip's live reload item (live mode only): a button that pauses live reload,
 * or resumes it. `held`: a page edit arrived while paused, and resuming reloads.
 *
 * @param {{paused: boolean, held: boolean}} state
 * @returns {{key: string, state: string, text: string, title: string}}
 */
export function liveReloadItem({ paused, held }) {
  if (!paused) {
    return {
      key: 'live',
      state: 'on',
      text: 'live',
      title: 'Live reload: page edits reload this tab. Click to pause.',
    };
  }
  return held
    ? {
      key: 'live',
      state: 'held',
      text: 'live ⏸ UI changed',
      title:
        'Live reload is paused and the UI changed. Click to resume and reload.',
    }
    : {
      key: 'live',
      state: 'paused',
      text: 'live ⏸ paused',
      title: 'Live reload is paused. Click to resume.',
    };
}
