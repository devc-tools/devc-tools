// Pure helpers for the page's Pinned section (pinned files: the `pinned_files` message), tested
// from `devc/tests/web_pinned_files_page_test.ts`. Not pinned projects and not a preview tile's
// "Keep open": code here always says `file pin` / `pinnedFiles`, never a bare `pin`.

import { newEntryNameError, opensAsDir } from './files.js';

/**
 * A pinned file as the page knows it: `path` is relative to `root`, one of the repo folders of
 * the project at `localFolder` (as `read_file` and `open_file` take them).
 *
 * `dashboard` marks the user's dashboard: at most one pin carries it.
 *
 * @typedef {{id: string, localFolder: string, root: string, path: string, label?: string,
 *   dashboard?: true}} FilePin
 */

/**
 * The pins of a `pinned_files` message, in their order. Malformed entries are dropped.
 *
 * @param {unknown} msg
 * @returns {FilePin[]}
 */
export function parsePinnedFiles(msg) {
  const pins = /** @type {{pins?: unknown} | null} */ (msg)?.pins;
  if (!Array.isArray(pins)) return [];
  /** @type {FilePin[]} */
  const out = [];
  for (const p of pins) {
    if (typeof p !== 'object' || p === null) continue;
    const { id, localFolder, root, path, label, dashboard } = p;
    if (
      typeof id !== 'string' || id === '' ||
      typeof localFolder !== 'string' || localFolder === '' ||
      typeof root !== 'string' || root === '' ||
      typeof path !== 'string' || path === ''
    ) continue;
    out.push({
      id,
      localFolder,
      root,
      path,
      ...(typeof label === 'string' && label !== '' ? { label } : {}),
      ...(dashboard === true ? { dashboard: /** @type {const} */ (true) } : {}),
    });
  }
  return out;
}

/**
 * The pin marked as the dashboard, or null.
 *
 * @param {FilePin[]} pins
 * @returns {FilePin | null}
 */
export function dashboardPin(pins) {
  return pins.find((p) => p.dashboard === true) ?? null;
}

/**
 * Whether a change to the tiling area should open the dashboard: it went from some tiles to none,
 * and none of the tiles it lost showed the dashboard's file (closing the dashboard last leaves the
 * area empty).
 *
 * @param {FilePin | null} pin
 * @param {{file?: {localFolder: string, root: string, path: string, container?: boolean} | null}[]} before
 * @param {number} after  how many tiles there are now
 */
export function reopensDashboard(pin, before, after) {
  if (!pin || before.length === 0 || after !== 0) return false;
  return !before.some((t) =>
    t.file && !t.file.container && t.file.localFolder === pin.localFolder &&
    t.file.root === pin.root && t.file.path === pin.path
  );
}

/** What a pin's row says: its label, else the file's name. @param {FilePin} pin */
export function filePinName(pin) {
  return pin.label || (pin.path.split('/').filter(Boolean).at(-1) ?? pin.path);
}

/**
 * Why `path` can't be a new note's path (relative to its repo), or null. Its folders must be
 * plain names; the last segment follows {@link newEntryNameError}.
 *
 * @param {string} path
 * @returns {string | null}
 */
export function notePathError(path) {
  if (path === '') return 'Enter a path';
  if (path.startsWith('/')) return 'The path is relative to the repo';
  if (path.includes('\0')) return 'A path cannot contain NUL';
  const segments = path.split('/');
  const name = /** @type {string} */ (segments.pop());
  if (segments.some((s) => s === '' || s === '.' || s === '..')) {
    return 'Folders in the path must be plain names';
  }
  return newEntryNameError(name);
}

/**
 * A new note's path, from its repo's top-level entries: `.plans/notes.md` when the repo has a
 * `.plans/` folder, else `NOTES.md`.
 *
 * @param {{name: string, kind: string, to?: string}[]} entries
 */
export function defaultNotePath(entries) {
  return entries.some((e) => e.name === '.plans' && opensAsDir(e))
    ? '.plans/notes.md'
    : 'NOTES.md';
}

/**
 * Whether a keydown is the shortcut that toggles the first pinned file: Ctrl+Alt+N, Cmd+Alt+N on
 * a Mac. Matched on `code`, since a Mac's Option changes `key` (Option+N is a dead key).
 *
 * @param {{code: string, ctrlKey: boolean, altKey: boolean, metaKey: boolean, shiftKey: boolean}} e
 * @param {boolean} isMac
 */
export function isFilePinShortcut(e, isMac) {
  return e.code === 'KeyN' && e.altKey && !e.shiftKey &&
    (isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey);
}

/**
 * The saved `pin id → pane_id` map (from `open_pinned` replies): which tiles show a pin's editor
 * pane, kept across reloads. Anything malformed is dropped.
 *
 * @param {string | null} text
 * @returns {Map<string, string>}
 */
export function parseFilePinPanes(text) {
  /** @type {Map<string, string>} */
  const out = new Map();
  let saved;
  try {
    saved = JSON.parse(text ?? 'null');
  } catch {
    return out;
  }
  if (typeof saved !== 'object' || saved === null || Array.isArray(saved)) {
    return out;
  }
  for (const [id, paneId] of Object.entries(saved)) {
    if (typeof paneId === 'string' && paneId !== '') out.set(id, paneId);
  }
  return out;
}
