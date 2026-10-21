// Pure tiling-state helpers for the `devc web` page, shared by `layout.js` and `app.js` and
// tested from `devc/tests/web_layout_test.ts`. No DOM access and no Golden Layout import here.

import { defaultView, fileView } from './media.js';

/** @typedef {{localFolder: string, pane_id: string}} PaneRef */
/**
 * A file shown in a file tile: `path` is relative to `root`, one of the repo folders of the
 * project at `localFolder` (the `read_file` message's fields). With `container`, `root` is `/`
 * inside the running container of the project at `localFolder` (`read_container_file`). `view`
 * shows it as text or as media (see `media.js`); it is set only when it differs from the
 * default, so the same file always has the same reference.
 *
 * @typedef {{localFolder: string, root: string, path: string, container?: true,
 *   view?: 'text' | 'media'}} FileRef
 */

/**
 * A pull request file shown in a diff tile: `path` is the file's path in the PR of the repo at
 * `root`, one of the repo folders of the project at `localFolder` (the `pr_diff` message's
 * fields).
 *
 * @typedef {{localFolder: string, root: string, path: string}} DiffRef
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
  const { localFolder, root, path, container, view } =
    /** @type {Record<string, unknown>} */ (state);
  for (const v of [localFolder, root, path]) {
    if (typeof v !== 'string' || v === '') return null;
  }
  return withView(
    /** @type {FileRef} */ ({
      localFolder,
      root,
      path,
      ...(container === true ? { container: true } : {}),
    }),
    view === 'text' || view === 'media' ? view : undefined,
  );
}

/**
 * A diff tile's component state as a diff reference: only an object whose `localFolder`, `root`
 * and `path` are all non-empty strings is one. Anything else is `null`.
 *
 * @param {unknown} state
 * @returns {DiffRef | null}
 */
export function diffRefFromState(state) {
  if (typeof state !== 'object' || state === null || Array.isArray(state)) {
    return null;
  }
  const { localFolder, root, path } =
    /** @type {Record<string, unknown>} */ (state);
  for (const v of [localFolder, root, path]) {
    if (typeof v !== 'string' || v === '') return null;
  }
  return /** @type {DiffRef} */ ({ localFolder, root, path });
}

/**
 * Whether two diff references name the same file of the same repo's PR.
 *
 * @param {DiffRef} a
 * @param {DiffRef} b
 */
export function sameDiff(a, b) {
  return a.localFolder === b.localFolder && a.root === b.root &&
    a.path === b.path;
}

/**
 * `file` shown as `view` (`undefined`: the default), with `view` kept only when it differs from
 * the default.
 *
 * @param {FileRef} file
 * @param {'text' | 'media'} [view]
 * @returns {FileRef}
 */
export function withView(file, view) {
  const { view: _, ...ref } = file;
  if (
    view === undefined ||
    fileView({ path: ref.path, view }) === defaultView(ref.path)
  ) {
    return ref;
  }
  return { ...ref, view };
}

/**
 * Whether two file references name the same file, however each shows it.
 *
 * @param {FileRef} a
 * @param {FileRef} b
 */
export function sameFile(a, b) {
  return a.localFolder === b.localFolder && a.root === b.root &&
    a.path === b.path && !a.container === !b.container;
}

/**
 * Whether two file references name the same file shown the same way: a file as text and as
 * media are two tiles' worth.
 *
 * @param {FileRef} a
 * @param {FileRef} b
 */
export function sameFileView(a, b) {
  return sameFile(a, b) && fileView(a) === fileView(b);
}

/**
 * The tiles showing a pane (pane tiles whose ref names it), in order: what a pinned file's toggle
 * closes, and whether its row shows the open dot.
 *
 * @template {{kind?: string, ref?: PaneRef | null}} T
 * @param {T[]} tiles
 * @param {PaneRef} ref
 * @returns {T[]}
 */
export function tilesShowingPane(tiles, ref) {
  return tiles.filter((t) =>
    t.kind !== 'file' && t.ref?.localFolder === ref.localFolder &&
    t.ref.pane_id === ref.pane_id
  );
}

/**
 * What a tile shows, as its Golden Layout component type and state: `{file}` a file tile,
 * `{diff}` a diff tile, a `PaneRef` a pane tile, `null` an empty pane tile. A preview tile (see
 * {@link previewFromState}) carries `preview: true` beside the reference.
 *
 * @param {PaneRef | {file: FileRef} | {diff: DiffRef} | null} ref
 * @param {boolean} [preview]
 * @returns {{type: 'pane' | 'file' | 'diff', state: Record<string, string | boolean>}}
 */
export function tileContent(ref, preview = false) {
  const flag = preview ? { preview: true } : {};
  if (ref && 'diff' in ref) {
    const { localFolder, root, path } = ref.diff;
    return { type: 'diff', state: { localFolder, root, path, ...flag } };
  }
  if (ref && 'file' in ref) {
    const { localFolder, root, path, container, view } = withView(
      ref.file,
      ref.file.view,
    );
    return {
      type: 'file',
      state: {
        localFolder,
        root,
        path,
        ...(container ? { container: true } : {}),
        ...(view ? { view } : {}),
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
