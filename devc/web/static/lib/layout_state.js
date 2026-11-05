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
 * A file shown in a diff tile: `path` in the repo at `root`, one of the repo folders of the project
 * at `localFolder`. Without `sha` or `changes` it is the file in the repo's pull request (the
 * `pr_diff` message's fields); with `sha`, the file as that commit changed it (`commit_diff`'s);
 * with `changes`, its uncommitted changes since that ref (`uncommitted_diff`'s; only `'HEAD'` so
 * far). Never both. See {@link diffSource}.
 *
 * @typedef {{localFolder: string, root: string, path: string, sha?: string, changes?: string}}
 *   DiffRef
 */

/** A full commit id, as `commit_diff` takes one. */
const COMMIT_SHA = /^([0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * Where a diff tile's content comes from: the pull request, one commit, or the working tree's
 * uncommitted changes. Every check of what a diff tile offers goes through this, never through
 * `sha` or `changes` being set, so a further source gets none of a source's parts without saying
 * so.
 *
 * @param {DiffRef} ref
 * @returns {'pr' | 'commit' | 'changes'}
 */
export function diffSource(ref) {
  if (ref.changes !== undefined) return 'changes';
  return ref.sha === undefined ? 'pr' : 'commit';
}

/**
 * A diff reference as one string: two refs name the same diff exactly when their keys match.
 *
 * @param {DiffRef} ref
 */
export function diffKey(ref) {
  return `${ref.localFolder}\n${ref.root}\n${ref.path}${
    ref.sha === undefined ? '' : `\n${ref.sha}`
  }${ref.changes === undefined ? '' : `\nchanges:${ref.changes}`}`;
}

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

/** A host tile's slot id: 32 lowercase hex characters, issued by devc-desktop. */
export const HOST_SLOT = /^[0-9a-f]{32}$/;

/**
 * A host tile's component state as its slot id: devc-desktop covers the tile's content with a
 * host terminal of its own while the id is one it issued (`.plans/archived/devc-desktop-host-tiles.md`).
 * Only `{hostSlot}` with a well-formed id is one; anything else is `null`, and the tile is
 * dropped on restore.
 *
 * @param {unknown} state
 * @returns {string | null}
 */
export function hostSlotFromState(state) {
  if (typeof state !== 'object' || state === null || Array.isArray(state)) {
    return null;
  }
  const { hostSlot } = /** @type {Record<string, unknown>} */ (state);
  return typeof hostSlot === 'string' && HOST_SLOT.test(hostSlot)
    ? hostSlot
    : null;
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
 * and `path` are all non-empty strings, whose `sha`, if any, is a full commit id, and whose
 * `changes`, if any, is a non-empty string, never beside a `sha`, is one. Anything else is `null`.
 *
 * @param {unknown} state
 * @returns {DiffRef | null}
 */
export function diffRefFromState(state) {
  if (typeof state !== 'object' || state === null || Array.isArray(state)) {
    return null;
  }
  const { localFolder, root, path, sha, changes } =
    /** @type {Record<string, unknown>} */ (state);
  for (const v of [localFolder, root, path]) {
    if (typeof v !== 'string' || v === '') return null;
  }
  if (changes !== undefined) {
    if (sha !== undefined) return null;
    if (typeof changes !== 'string' || changes === '') return null;
    return /** @type {DiffRef} */ ({ localFolder, root, path, changes });
  }
  if (sha === undefined) {
    return /** @type {DiffRef} */ ({ localFolder, root, path });
  }
  if (typeof sha !== 'string' || !COMMIT_SHA.test(sha)) return null;
  return /** @type {DiffRef} */ ({ localFolder, root, path, sha });
}

/**
 * Whether two diff references name the same diff: the same file of the same repo, from the same
 * PR, commit or uncommitted changes.
 *
 * @param {DiffRef} a
 * @param {DiffRef} b
 */
export function sameDiff(a, b) {
  return a.localFolder === b.localFolder && a.root === b.root &&
    a.path === b.path && a.sha === b.sha && a.changes === b.changes;
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
 * What a tile shows, as its Golden Layout component type and state: `{file}` a file tile, `{draft}`
 * a file tile with no file yet,
 * `{diff}` a diff tile, `{host}` a host tile (never a preview), a `PaneRef` a pane tile, `null` an
 * empty pane tile. A preview tile (see {@link previewFromState}) carries `preview: true` beside
 * the reference.
 *
 * @param {PaneRef | {file: FileRef} | {diff: DiffRef} |
 *   {draft: import('./drafts.js').DraftRef} | {host: string} | null} ref
 * @param {boolean} [preview]
 * @returns {{type: 'pane' | 'file' | 'diff' | 'host',
 *   state: Record<string, string | boolean>}}
 */
export function tileContent(ref, preview = false) {
  if (ref && 'host' in ref) {
    return { type: 'host', state: { hostSlot: ref.host } };
  }
  const flag = preview ? { preview: true } : {};
  if (ref && 'draft' in ref) {
    return {
      type: 'file',
      state: { draft: ref.draft.id, name: ref.draft.name, ...flag },
    };
  }
  if (ref && 'diff' in ref) {
    const { localFolder, root, path, sha, changes } = ref.diff;
    const at = changes !== undefined
      ? { changes }
      : sha === undefined
      ? {}
      : { sha };
    return { type: 'diff', state: { localFolder, root, path, ...at, ...flag } };
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
  const pruned = pruneHostTiles(root);
  if (pruned === null) return null;
  return { ...value, root: pruned };
}

/**
 * A saved layout item without its `host` components whose state is no slot id (see
 * {@link hostSlotFromState}); a stack, row or column left empty goes too, and a stack's
 * `activeItemIndex` stays in range. `null` when nothing is left.
 *
 * @param {Record<string, unknown>} item
 * @returns {Record<string, unknown> | null}
 */
function pruneHostTiles(item) {
  if (
    item.type === 'component' && item.componentType === 'host' &&
    hostSlotFromState(item.componentState) === null
  ) return null;
  if (!Array.isArray(item.content)) return item;
  const content = item.content.flatMap((child) => {
    if (typeof child !== 'object' || child === null) return [child];
    const kept = pruneHostTiles(/** @type {Record<string, unknown>} */ (child));
    return kept === null ? [] : [kept];
  });
  if (content.length === item.content.length) return item;
  if (content.length === 0) return null;
  const out = { ...item, content };
  if (typeof out.activeItemIndex === 'number') {
    out.activeItemIndex = Math.min(out.activeItemIndex, content.length - 1);
  }
  return out;
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
