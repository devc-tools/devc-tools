// Pure helpers for the page's dashboard (the `dashboard` message): one repo file the user marks as
// the place every session starts. Not a pinned file. Tested from
// `devc/tests/web_dashboard_page_test.ts`.

/**
 * The dashboard: `path` is relative to `root`, one of the repo folders of the project at
 * `localFolder` (as `read_file` takes them).
 *
 * @typedef {{localFolder: string, root: string, path: string}} DashboardFile
 */

/**
 * The file of a `dashboard` message, or null for none or a malformed one.
 *
 * @param {unknown} msg
 * @returns {DashboardFile | null}
 */
export function parseDashboard(msg) {
  const file = /** @type {{file?: unknown} | null} */ (msg)?.file;
  if (typeof file !== 'object' || file === null) return null;
  const { localFolder, root, path } =
    /** @type {Record<string, unknown>} */ (file);
  if (
    typeof localFolder !== 'string' || localFolder === '' ||
    typeof root !== 'string' || root === '' ||
    typeof path !== 'string' || path === ''
  ) return null;
  return { localFolder, root, path };
}

/**
 * Whether a file (a file tile's, or a repo row's) is the dashboard. A container file never is.
 *
 * @param {DashboardFile | null} d
 * @param {{localFolder: string, root: string, path: string, container?: boolean}} file
 */
export function isDashboardFile(d, file) {
  return !!d && !file.container && file.localFolder === d.localFolder &&
    file.root === d.root && file.path === d.path;
}

/**
 * Whether a change to the tiling area should open the dashboard: it went from some tiles to none,
 * and none of the tiles it lost showed the dashboard's file (closing the dashboard last leaves the
 * area empty).
 *
 * @param {DashboardFile | null} d
 * @param {{file?: {localFolder: string, root: string, path: string, container?: boolean} | null}[]} before
 * @param {number} after  how many tiles there are now
 */
export function reopensDashboard(d, before, after) {
  if (!d || before.length === 0 || after !== 0) return false;
  return !before.some((t) => t.file && isDashboardFile(d, t.file));
}
