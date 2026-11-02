// New, unsaved files (Cmd+N): the pure half of a draft tile, shared with the Deno tests
// (`devc/tests/web_drafts_test.ts`). `tiles.js` owns the tile and `draft-dialog.js` asks where it
// goes. A draft's text lives in `localStorage` under {@link draftKey}, so a reload keeps it; the
// layout saves only its id and name.

/**
 * @typedef {{id: string, name: string}} DraftRef
 */

/** The `localStorage` key of draft `id`'s text. @param {string} id */
export function draftKey(id) {
  return `devc-web-draft-${id}`;
}

/**
 * A file tile's component state as a draft reference: an object whose `draft` and `name` are both
 * non-empty strings. Anything else is `null`.
 *
 * @param {unknown} state
 * @returns {DraftRef | null}
 */
export function draftRefFromState(state) {
  if (typeof state !== 'object' || state === null || Array.isArray(state)) {
    return null;
  }
  const { draft, name } = /** @type {Record<string, unknown>} */ (state);
  if (typeof draft !== 'string' || draft === '') return null;
  if (typeof name !== 'string' || name === '') return null;
  return { id: draft, name };
}

/**
 * The name of a new draft: `Untitled-N` with the lowest `N` the open ones leave free.
 *
 * @param {Iterable<string>} names  the open drafts' names
 */
export function nextDraftName(names) {
  const taken = new Set(names);
  let n = 1;
  while (taken.has(`Untitled-${n}`)) n++;
  return `Untitled-${n}`;
}

/**
 * Whether a key press makes a new file: Cmd+N on a Mac, and Alt+Shift+N everywhere, since a browser
 * tab keeps Cmd+N and Ctrl+N for itself (and a terminal wants Ctrl+N; Alt+Cmd+N and Ctrl+Alt+N toggle
 * the first pinned file). By `code`, since Option changes `key` on a Mac; by `key` too, as a menu's
 * synthesized key press may have no `code`.
 *
 * @param {{code: string, key: string, metaKey: boolean, ctrlKey: boolean, altKey: boolean,
 *   shiftKey: boolean}} e
 * @param {boolean} isMac
 */
export function isNewFileShortcut(e, isMac) {
  if (e.code !== 'KeyN' && e.key.toLowerCase() !== 'n') return false;
  if (e.ctrlKey) return false;
  if (e.altKey && e.shiftKey) return !e.metaKey;
  return isMac && e.metaKey && !e.altKey && !e.shiftKey;
}

/**
 * The path a draft's Save dialog starts with: its name, in the folder of the file it was opened
 * beside when that file is in the same repo.
 *
 * @param {string} name
 * @param {string | null | undefined} nearPath  a path relative to the repo
 */
export function suggestedDraftPath(name, nearPath) {
  const i = nearPath ? nearPath.lastIndexOf('/') : -1;
  return i > 0 ? `${nearPath?.slice(0, i)}/${name}` : name;
}
