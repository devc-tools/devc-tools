// Pure tiling-state helpers for the `devc web` page, shared by `layout.js` and `app.js` and
// tested from `devc/tests/web_layout_test.ts`. No DOM access and no Golden Layout import here.

/** @typedef {{localFolder: string, pane_id: string}} PaneRef */
/**
 * A file shown in a file tile: `path` is relative to `root`, one of the repo folders of the
 * project at `localFolder` (the `read_file` message's fields). With `container`, `root` is `/`
 * inside the running container of the project at `localFolder` (`read_container_file`).
 *
 * @typedef {{localFolder: string, root: string, path: string, container?: true}} FileRef
 */

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
 * A file tile's component state as a file reference: only an object whose `localFolder`, `root`
 * and `path` are all non-empty strings is one. Anything else is `null`.
 *
 * @param {unknown} state
 * @returns {FileRef | null}
 */
export function fileRefFromState(state) {
  if (typeof state !== 'object' || state === null || Array.isArray(state)) {
    return null;
  }
  const { localFolder, root, path, container } =
    /** @type {Record<string, unknown>} */ (state);
  for (const v of [localFolder, root, path]) {
    if (typeof v !== 'string' || v === '') return null;
  }
  return /** @type {FileRef} */ ({
    localFolder,
    root,
    path,
    ...(container === true ? { container: true } : {}),
  });
}

/**
 * Whether two file references name the same file.
 *
 * @param {FileRef} a
 * @param {FileRef} b
 */
export function sameFile(a, b) {
  return a.localFolder === b.localFolder && a.root === b.root &&
    a.path === b.path && !a.container === !b.container;
}

/**
 * What a tile shows, as its Golden Layout component type and state: `{file}` a file tile, a
 * `PaneRef` a pane tile, `null` an empty pane tile. A preview tile (see {@link previewFromState})
 * carries `preview: true` beside the reference.
 *
 * @param {PaneRef | {file: FileRef} | null} ref
 * @param {boolean} [preview]
 * @returns {{type: 'pane' | 'file', state: Record<string, string | boolean>}}
 */
export function tileContent(ref, preview = false) {
  const flag = preview ? { preview: true } : {};
  if (ref && 'file' in ref) {
    const { localFolder, root, path, container } = ref.file;
    return {
      type: 'file',
      state: {
        localFolder,
        root,
        path,
        ...(container ? { container: true } : {}),
        ...flag,
      },
    };
  }
  return {
    type: 'pane',
    state: ref
      ? { localFolder: ref.localFolder, pane_id: ref.pane_id, ...flag }
      : { ...flag },
  };
}

/**
 * Whether a tile's component state marks it a *preview*: a tile a sidebar click opened, whose
 * content the next click replaces until it is pinned. Only `preview: true` counts, so layouts
 * saved before previews existed load pinned.
 *
 * @param {unknown} state
 * @returns {boolean}
 */
export function previewFromState(state) {
  return typeof state === 'object' && state !== null &&
    /** @type {Record<string, unknown>} */ (state).preview === true;
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

/**
 * A node of the tiling tree as the sidebar's Layout section sees it. `id` of a tile node is its
 * `Tile.id`; `active` is whether it is its stack's visible tab.
 *
 * @typedef {{kind: 'row' | 'column' | 'stack', id: string, children: LayoutNode[]}
 *   | {kind: 'tile', id: string, active: boolean}} LayoutNode
 */

/**
 * The tree the sidebar shows: a row, column or stack with exactly one child is replaced by that
 * child (recursively); an empty one is dropped. `null` in, `null` out.
 *
 * @param {LayoutNode | null} node
 * @returns {LayoutNode | null}
 */
export function foldTree(node) {
  if (node === null || node.kind === 'tile') return node;
  const children = /** @type {LayoutNode[]} */ (
    node.children.map(foldTree).filter((c) => c !== null)
  );
  if (children.length === 0) return null;
  if (children.length === 1) return children[0];
  return { kind: node.kind, id: node.id, children };
}

/**
 * A string that changes exactly when the tree's shape, its ids or any `active` flag changes, so
 * the sidebar re-renders on a move or a tab switch and not on every splitter drag.
 *
 * @param {LayoutNode | null} node
 * @returns {string}
 */
export function treeSignature(node) {
  if (node === null) return '';
  if (node.kind === 'tile') return `${node.id}${node.active ? '*' : ''}`;
  return `${node.kind}:${node.id}(${
    node.children.map(treeSignature).join(',')
  })`;
}
