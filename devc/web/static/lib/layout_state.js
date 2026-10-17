// Pure tiling-state helpers for the `devc web` page, shared by `layout.js` and `app.js` and
// tested from `devc/tests/web_layout_test.ts`. No DOM access and no Golden Layout import here.

/** @typedef {{localFolder: string, pane_id: string}} PaneRef */

/**
 * A tile's component state as a pane reference: only an object with string `localFolder` and
 * `pane_id` (both non-empty) is one. Anything else — `{}` for an empty tile included — is `null`.
 *
 * @param {unknown} state
 * @returns {PaneRef | null}
 */
export function paneRefFromState(state) {
  if (typeof state !== 'object' || state === null || Array.isArray(state)) {
    return null;
  }
  const { localFolder, pane_id } =
    /** @type {Record<string, unknown>} */ (state);
  if (typeof localFolder !== 'string' || localFolder === '') return null;
  if (typeof pane_id !== 'string' || pane_id === '') return null;
  return { localFolder, pane_id };
}

/**
 * A tile's tab title: `<container name> · <pane title>`, or whichever half is known.
 *
 * @param {string} containerName
 * @param {string} paneTitle
 * @returns {string}
 */
export function tileTitle(containerName, paneTitle) {
  return [containerName, paneTitle].filter((s) => s).join(' · ');
}

/**
 * A saved layout read back from storage, or `null` when it is not JSON or has no object `root`
 * — checked before Golden Layout's `loadLayout` ever sees it.
 *
 * @param {string | null} text
 * @returns {Record<string, unknown> | null}
 */
export function parseSavedLayout(text) {
  if (typeof text !== 'string') return null;
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const root = /** @type {Record<string, unknown>} */ (value).root;
  if (typeof root !== 'object' || root === null || Array.isArray(root)) {
    return null;
  }
  return value;
}
