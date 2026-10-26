// The `devc web` file palette: Cmd+P on a Mac, Ctrl+Alt+P elsewhere, opens a dialog that finds a
// file in the focused tile's repo by fuzzy name and opens it in a file tile. Only the combined
// page `/` mounts it (`app.js`): in the VS Code embedding (`/main`, `/sidebar`) VS Code takes
// Cmd+P first. It reaches the tiling area only through the `TileArea` it is given. Matching,
// ranking and the recent files are `lib/palette.js`'s. See `.plans/devc-web-file-palette.md`.

import {
  emptyQueryFiles,
  isPaletteShortcut,
  parseRecents,
  rankFiles,
  RECENTS_KEY,
  recordRecent,
} from './lib/palette.js';
import { h, IS_MAC } from './ui.js';
import { basename, call, projectRepos, tileRepo } from './client.js';

/** @typedef {import('./lib/view.js').TileArea} TileArea */

/** The most rows the palette lists. */
const LIMIT = 50;

/**
 * Each repo root's last listing, kept for the page's life so reopening the palette searches at
 * once while a fresh listing is on its way.
 *
 * @type {Map<string, {files: string[], truncated: boolean, listed: Set<string>}>}
 */
const listings = new Map();

/** The open palette, if any. @type {{close: () => void} | null} */
let current = null;

/** Mounts the palette's shortcut. Called once, by `app.js`. @param {{tileArea: TileArea}} opts */
export function mountPalette({ tileArea }) {
  // In the capture phase, so neither xterm.js nor CodeMirror sees the key, and the browser's
  // Print dialog does not open.
  document.addEventListener('keydown', (e) => {
    if (!isPaletteShortcut(e, IS_MAC)) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.repeat) return;
    if (current) current.close();
    else current = openPalette(tileArea);
  }, true);
}

/**
 * The repo the palette searches: the most recently focused tile's that is in one (a tile in a
 * project but outside its repos: the project's first repo), or null.
 *
 * @param {TileArea} tileArea
 */
function paletteScope(tileArea) {
  const tiles = [...tileArea.state().tiles].sort((a, b) =>
    b.focusSeq - a.focusSeq
  );
  for (const tile of tiles) {
    const { localFolder, repo } = tileRepo(tile);
    if (!localFolder) continue;
    const found = repo ?? projectRepos(localFolder)[0];
    if (found) return { localFolder, repo: found };
  }
  return null;
}

function loadRecents() {
  try {
    return parseRecents(localStorage.getItem(RECENTS_KEY));
  } catch {
    return {};
  }
}

/** Records `path` as opened from the palette in `root`. */
function saveRecent(root, path) {
  try {
    localStorage.setItem(
      RECENTS_KEY,
      JSON.stringify(recordRecent(loadRecents(), root, path)),
    );
  } catch { /* storage unavailable: it just won't be listed as recent */ }
}

/** `text` from `offset` on, with the characters at `marked` indices in `<mark>`s. */
function highlight(text, offset, marked) {
  /** @type {(Node | string)[]} */
  const nodes = [];
  let i = 0;
  while (i < text.length) {
    const on = marked.has(offset + i);
    let j = i + 1;
    while (j < text.length && marked.has(offset + j) === on) j++;
    const part = text.slice(i, j);
    nodes.push(on ? h('mark', {}, part) : part);
    i = j;
  }
  return nodes;
}

/** Opens the palette over the page. @param {TileArea} tileArea */
function openPalette(tileArea) {
  const returnFocus = /** @type {HTMLElement | null} */ (
    document.activeElement
  );
  const scope = paletteScope(tileArea);
  const el = /** @type {HTMLDialogElement} */ (h('dialog', {
    class: 'dialog palette',
    'aria-label': 'Find a file',
    onclose: () => {
      current = null;
      if (returnFocus?.isConnected) returnFocus.focus();
      el.remove();
    },
  }));
  const palette = { close: () => el.close() };
  document.body.append(el);
  if (!scope) {
    el.append(
      h(
        'p',
        { class: 'palette-message' },
        'No repo to search: focus a terminal or file in a repo first.',
      ),
    );
    el.showModal();
    return palette;
  }

  const { localFolder, repo } = scope;
  const root = repo.folder;
  const recents = loadRecents();
  let pending = true;
  let error = /** @type {string | null} */ (null);
  /** @type {{path: string, positions: number[]}[]} */
  let rows = [];
  let selected = 0;

  const $input = /** @type {HTMLInputElement} */ (h('input', {
    type: 'text',
    class: 'palette-input',
    spellcheck: 'false',
    autocomplete: 'off',
    placeholder: `Search files in ${basename(root)}`,
    'aria-label': `Search files in ${basename(root)}`,
    'aria-controls': 'palette-results',
    oninput: () => render(null),
    onkeydown: onKey,
  }));
  const branch = repo.git?.branch;
  const $status = h('div', { class: 'palette-status', hidden: true });
  const $results = h('ul', {
    class: 'palette-results',
    id: 'palette-results',
    role: 'listbox',
    'aria-label': 'Files',
  });
  const $foot = h('div', { class: 'palette-foot', hidden: true });
  el.append(
    h(
      'div',
      { class: 'palette-head' },
      $input,
      branch ? h('span', { class: 'palette-branch' }, branch) : '',
    ),
    $status,
    $results,
    $foot,
  );

  /** @param {KeyboardEvent} e */
  function onKey(e) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!rows.length) return;
      const step = e.key === 'ArrowDown' ? 1 : -1;
      select((selected + step + rows.length) % rows.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (e.isComposing) return;
      open((IS_MAC ? e.metaKey : e.ctrlKey) ? 'right' : 'preview');
    }
  }

  /** @param {number} i */
  function select(i) {
    const $rows = $results.children;
    $rows[selected]?.removeAttribute('aria-selected');
    selected = i;
    const $row = $rows[i];
    if (!$row) {
      $input.removeAttribute('aria-activedescendant');
      return;
    }
    $row.setAttribute('aria-selected', 'true');
    $input.setAttribute('aria-activedescendant', $row.id);
    $row.scrollIntoView({ block: 'nearest' });
  }

  /** @param {'preview' | 'right'} where */
  function open(where) {
    const row = rows[selected];
    if (!row) return;
    saveRecent(root, row.path);
    el.close();
    tileArea.openFile({ localFolder, root, path: row.path }, where);
  }

  /** Lists the rows for the query; the selection stays on `keep` when it is still listed. */
  function render(/** @type {string | null} */ keep) {
    const listing = listings.get(root);
    const query = $input.value;
    if (query.trim() === '') {
      rows = emptyQueryFiles(
        tileArea.state().tiles,
        root,
        recents[root] ?? [],
        listing?.listed ?? null,
        LIMIT,
      ).map((path) => ({ path, positions: [] }));
    } else {
      rows = rankFiles(query, listing?.files ?? [], LIMIT);
    }
    $results.replaceChildren(...rows.map((row, i) => {
      const slash = row.path.lastIndexOf('/');
      const marked = new Set(row.positions);
      return h(
        'li',
        {
          class: 'palette-row',
          id: `palette-option-${i}`,
          role: 'option',
          onmousemove: () => {
            if (selected !== i) select(i);
          },
          onclick: () => {
            select(i);
            open('preview');
          },
        },
        h(
          'span',
          { class: 'palette-name' },
          ...highlight(row.path.slice(slash + 1), slash + 1, marked),
        ),
        h(
          'span',
          { class: 'palette-dir' },
          ...highlight(row.path.slice(0, Math.max(slash, 0)), 0, marked),
        ),
      );
    }));
    let status = '';
    if (error !== null) status = `Couldn't list files: ${error}`;
    else if (rows.length === 0 && pending && !listing) {
      status = 'Listing files…';
    } else if (rows.length === 0 && query.trim() === '') {
      status = `Type to search ${
        (listing?.files.length ?? 0)
          .toLocaleString()
      } files`;
    } else if (rows.length === 0) status = 'No matching files';
    $status.textContent = status;
    $status.hidden = status === '';
    $foot.textContent = listing?.truncated
      ? `Searching the first ${listing.files.length.toLocaleString()} files`
      : '';
    $foot.hidden = !listing?.truncated;
    const kept = keep === null ? -1 : rows.findIndex((r) => r.path === keep);
    selected = 0;
    select(Math.max(kept, 0));
  }

  call({ type: 'find_files', localFolder, root }).then(
    (/** @type {{files: string[], truncated: boolean}} */ result) => {
      listings.set(root, {
        files: result.files,
        truncated: result.truncated,
        listed: new Set(result.files),
      });
      if (current !== palette) return;
      pending = false;
      error = null;
      render(rows[selected]?.path ?? null);
    },
    (/** @type {Error} */ e) => {
      if (current !== palette) return;
      pending = false;
      error = e.message;
      render(rows[selected]?.path ?? null);
    },
  );

  el.showModal();
  render(null);
  $input.focus();
  return palette;
}
