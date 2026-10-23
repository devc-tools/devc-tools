// The contract between the `devc web` sidebar and its tiling area: what the tiling area shows, as
// plain data the sidebar reads (`ViewState`), and what the sidebar asks it to do (`ViewIntents`).
// Both halves are one page today, and `app.js` implements the contract in-process; the sidebar
// reaches the tiling area no other way, so the two can later run in pages of their own, with the
// state and intents relayed by the server. Pure helpers over the state are here, tested from
// `devc/tests/web_view_test.ts`. No DOM access here.

import { fileView } from './media.js';
import {
  foldTree,
  sameDiff,
  sameFileView,
  treeSignature,
} from './layout_state.js';

/** @typedef {import('./layout_state.js').PaneRef} PaneRef */
/** @typedef {import('./layout_state.js').FileRef} FileRef */
/** @typedef {import('./layout_state.js').DiffRef} DiffRef */
/** @typedef {import('./layout_state.js').LayoutNode} LayoutNode */

/**
 * One tile, as the sidebar sees it. A pane tile's label comes from the Herdr snapshots, which the
 * sidebar has too; a file or diff tile's `title` is its tab's, which only the tiling area knows.
 *
 * @typedef {object} TileState
 * @property {string} id
 * @property {'pane' | 'file' | 'diff'} kind
 * @property {PaneRef | null} ref     the pane a pane tile shows (null: an empty tile)
 * @property {FileRef | null} file    the file a file tile shows
 * @property {DiffRef | null} diff    the PR file a diff tile shows
 * @property {boolean} preview        the next sidebar click replaces what it shows
 * @property {number} focusSeq        when it was last focused: higher is later, 0 never
 * @property {string} title           a file or diff tile's tab title; '' for a pane tile
 * @property {boolean} dirty          a file tile with unsaved edits
 * @property {boolean} saveable       a file tile whose edits Save would write now
 * @property {string | null} url      a diff tile's file on github.com, once known
 */

/**
 * @typedef {object} ViewState
 * @property {TileState[]} tiles
 * @property {LayoutNode | null} tree  the layout tree, unfolded
 * @property {string | null} focused   the tile a sidebar click opens into: the focused one, else
 *   the first
 */

/**
 * Where a new tile goes, relative to `at`: in its stack, or split to the right of it or below it
 * (`at` a tile or a stack; a row or column takes a new stack at its end). `at` left out is the
 * focused tile. `'preview'` is the focused stack's preview tile.
 *
 * @typedef {'preview' | 'stack' | 'right' | 'below'} Where
 */

/**
 * What the sidebar asks of the tiling area. Each takes plain data and answers nothing: what
 * happened shows in the next state.
 *
 * @typedef {object} ViewIntents
 * @property {(ref: PaneRef, opts?: {where?: Where, at?: string | null,
 *   created?: 'new' | 'reused'}) => void} openPane
 *   Shows a pane (default: a new tile in the focused stack), focused. `created` says the server
 *   just answered with it: `'new'` waits out Herdr listing it, `'reused'` shows the tile already
 *   showing it instead, if any.
 * @property {(file: FileRef, where: 'preview' | 'stack' | 'right') => void} openFile
 *   A tile already showing the file comes forward instead, except for `'right'`.
 * @property {(diff: DiffRef, where: 'preview' | 'stack') => void} openDiff
 *   A tile already showing the PR file comes forward instead (and stays, for `'stack'`).
 * @property {(id: string) => void} reveal    brings a tile forward and focuses it
 * @property {(id: string) => void} close     a tile (asking first when it has unsaved edits), or a
 *   stack, row or column
 * @property {(id: string) => void} keepOpen  a preview tile stays
 * @property {(id: string) => void} save      a file tile's edits
 * @property {(id: string) => void} reload    a file or diff tile's content, read again
 * @property {(on: boolean) => void} setZen   the focused tile alone, filling the area
 */

/** @param {ViewState} state @param {string | null | undefined} id */
export function tileById(state, id) {
  return state.tiles.find((t) => t.id === id) ?? null;
}

/** The tile a sidebar click opens into, or null with no tiles. @param {ViewState} state */
export function focusedTile(state) {
  return tileById(state, state.focused);
}

/**
 * The tiles in layout order, each with whether it is the front tab of its stack.
 *
 * @param {ViewState} state
 * @returns {{tile: TileState, active: boolean}[]}
 */
export function layoutTiles(state) {
  const tree = foldTree(state.tree);
  if (!tree) return [];
  const byId = new Map(state.tiles.map((t) => [t.id, t]));
  /** @type {{tile: TileState, active: boolean}[]} */
  const out = [];
  /** @param {LayoutNode} node */
  const walk = (node) => {
    if (node.kind === 'tile') {
      const tile = byId.get(node.id);
      if (tile) out.push({ tile, active: node.active });
    } else node.children.forEach(walk);
  };
  walk(tree);
  return out;
}

/**
 * The most recently focused of `tiles`, or null.
 *
 * @param {TileState[]} tiles
 */
function latest(tiles) {
  let best = null;
  for (const tile of tiles) {
    if (!best || tile.focusSeq > best.focusSeq) best = tile;
  }
  return best;
}

/**
 * The most recently focused tile showing a pane, if any.
 *
 * @param {ViewState} state @param {PaneRef} ref
 */
export function tileShowingPane(state, ref) {
  return latest(
    state.tiles.filter((t) =>
      t.ref?.localFolder === ref.localFolder && t.ref.pane_id === ref.pane_id
    ),
  );
}

/**
 * The most recently focused file tile showing `file` as `file` names it (as text or as media).
 *
 * @param {ViewState} state @param {FileRef} file
 */
export function tileShowingFile(state, file) {
  return latest(
    state.tiles.filter((t) => t.file && sameFileView(t.file, file)),
  );
}

/**
 * The most recently focused diff tile showing a PR file.
 *
 * @param {ViewState} state @param {DiffRef} diff
 */
export function tileShowingDiff(state, diff) {
  return latest(state.tiles.filter((t) => t.diff && sameDiff(t.diff, diff)));
}

/** A file reference as one string: the same file shown the same way, the same key. */
export function fileKey(/** @type {FileRef} */ file) {
  return `${file.localFolder}\n${file.root}\n${file.path}${
    file.container ? '\ncontainer' : ''
  }${fileView(file) === 'media' ? '\nmedia' : ''}`;
}

/**
 * A string that changes exactly when the layout's shape, what a tile shows or a preview flag
 * changes: when the sidebar's tile rows need building again. Focus, unsaved edits and titles are
 * left out; see {@link tileMarks}.
 *
 * @param {ViewState} state
 */
export function layoutSignature(state) {
  const refs = state.tiles.map((t) =>
    `${t.id}=${
      t.file
        ? fileKey(t.file)
        : t.diff
        ? `diff\n${t.diff.localFolder}\n${t.diff.root}\n${t.diff.path}`
        : t.ref
        ? `${t.ref.localFolder}\n${t.ref.pane_id}`
        : ''
    }${t.preview ? '*' : ''}`
  ).sort().join(';');
  return `${treeSignature(foldTree(state.tree))}|${refs}`;
}

/**
 * A string that changes when a tile's title or unsaved mark does: what a tile row shows beyond
 * {@link layoutSignature}.
 *
 * @param {ViewState} state
 */
export function tileMarks(state) {
  return state.tiles.map((t) => `${t.id}=${t.title}${t.dirty ? '*' : ''}`)
    .join(';');
}

/**
 * The preview tile in `anchor`'s stack (`anchor` itself included), or null.
 *
 * @param {ViewState} state @param {string | null | undefined} anchor
 */
export function previewTileNear(state, anchor) {
  if (!anchor) return null;
  const byId = new Map(state.tiles.map((t) => [t.id, t]));
  /** @param {LayoutNode} node @returns {TileState | null | undefined} undefined: not under it */
  const search = (node) => {
    if (node.kind === 'tile') return undefined;
    if (node.kind === 'stack') {
      if (!node.children.some((ch) => ch.id === anchor)) return undefined;
      return node.children.map((ch) => byId.get(ch.id)).find((t) =>
        t?.preview
      ) ?? null;
    }
    for (const child of node.children) {
      const found = search(child);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  return (state.tree && search(state.tree)) ?? null;
}

/**
 * A stack, row or column of the unfolded tree by id, or null.
 *
 * @param {ViewState} state @param {string} id
 * @returns {Extract<LayoutNode, {children: LayoutNode[]}> | null}
 */
export function nodeById(state, id) {
  /** @param {LayoutNode | null} node @returns {any} */
  const find = (node) => {
    if (!node || node.kind === 'tile') return null;
    if (node.id === id) return node;
    for (const child of node.children) {
      const found = find(child);
      if (found) return found;
    }
    return null;
  };
  return find(state.tree);
}

/**
 * Every tile under a layout node, in order.
 *
 * @param {ViewState} state @param {LayoutNode} node
 * @returns {TileState[]}
 */
export function nodeTiles(state, node) {
  if (node.kind === 'tile') {
    const tile = tileById(state, node.id);
    return tile ? [tile] : [];
  }
  return node.children.flatMap((child) => nodeTiles(state, child));
}
