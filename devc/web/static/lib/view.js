// The contract between the `devc web` sidebar and its tiling area: what the tiling area shows, as
// plain data the sidebar reads (`ViewState`), what the sidebar asks it to do (`ViewIntents`), and
// what the tiling area asks of the sidebar (`SidebarIntents`). Both halves are one page today:
// `tiles.js` implements the tiling area's side and `sidebar.js` the sidebar's, and `app.js` wires
// them in-process; neither reaches the other any other way, so the two can later run in pages of
// their own, with the state and intents relayed by the server. Pure helpers over the state are
// here, tested from `devc/tests/web_view_test.ts`. No DOM access here.

import { fileView } from './media.js';
import {
  fileRefFromState,
  foldTree,
  paneRefFromState,
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
 * @property {boolean} [removed]      a diff tile's file is deleted by its PR (once its diff is read)
 * @property {{restart: boolean, settings: boolean} | null} [lsp]
 *   a file tile's language server items: **Restart language server** while it is attached or its
 *   session exited, **Language server settings…** while its file has one and its container is
 *   connected; null for neither
 */

/**
 * @typedef {object} ViewState
 * @property {TileState[]} tiles
 * @property {LayoutNode | null} tree  the layout tree, unfolded
 * @property {string | null} focused   the tile a sidebar click opens into: the focused one, else
 *   the first
 * @property {string[]} [inUse]  relayed only: the repo cards In use shows (`repoCardKey`), from
 *   the view's sidebar, so a Containers page (`/containers`) draws their stand-ins
 * @property {string[]} [pinned] relayed only: the cards among them pinned to In use
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
 * @property {(diff: DiffRef, where: 'preview' | 'stack' | 'right',
 *   opts?: {compare?: 'viewed'}) => void} openDiff
 *   A tile already showing the PR file comes forward instead (and stays, for `'stack'`).
 *   `compare: 'viewed'` selects its newest **Since viewed** comparison once the file is read.
 * @property {(id: string) => void} reveal    brings a tile forward and focuses it
 * @property {(id: string) => void} close     a tile (asking first when it has unsaved edits), or a
 *   stack, row or column
 * @property {(id: string) => void} keepOpen  a preview tile stays
 * @property {(id: string) => void} save      a file tile's edits
 * @property {(id: string) => void} reload    a file or diff tile's content, read again
 * @property {(diff: DiffRef, viewed: 'VIEWED' | 'UNVIEWED') => void} prViewed
 *   a PR file was marked Viewed or not in the sidebar: its diff tiles show it
 * @property {(id: string) => void} askAgent  a file or diff tile's **Ask agent…**: the dialog
 *   asking an agent about its file, with what is selected in it
 * @property {(id: string) => void} restartLanguage  a file tile's **Restart language server**
 * @property {(id: string) => void} languageSettings a file tile's **Language server settings…**
 */

/**
 * The tiling area as the sidebar holds it (what `mountTiles` returns): the intents, its state,
 * and `dragSource`, which makes a sidebar row a Golden Layout drag source (the one part that needs
 * both halves in one page).
 *
 * @typedef {ViewIntents & {state: () => ViewState, dragSource: (el: HTMLElement,
 *   ref: () => PaneRef | {file: FileRef}, title: () => string) => () => void}} TileArea
 */

/**
 * What the tiling area asks of the sidebar: a tile menu's **Reveal in Containers**, and a diff
 * tile's Viewed.
 * Plain data in, nothing out, as {@link ViewIntents}.
 *
 * @typedef {object} SidebarIntents
 * @property {(ref: PaneRef) => void} revealInContainers  a tile menu's **Reveal in Containers**
 * @property {(diff: DiffRef, viewed: 'VIEWED' | 'UNVIEWED') => void} prViewed
 *   a PR file was marked Viewed or not in a diff tile: the sidebar's PR tree shows it
 */

/**
 * How the Containers section (`containers.js`) reaches In use (`sidebar.js`): the whole coupling
 * that way. In one page it is In use itself; across pages (`/containers` beside `/sidebar`) the
 * calls go as `inuse_intent`s and the keys come in `view_state`'s `inUse` and `pinned`.
 *
 * @typedef {object} InUseLink
 * @property {(key: string) => void} revealInUse  scrolls In use to a card and flashes it (a
 *   stand-in's **In use** link)
 * @property {() => Set<string>} inUseKeys  the cards In use shows, which Containers draws as
 *   stand-ins
 * @property {(key: string) => boolean} pinned  whether a card is pinned to In use (its menu says
 *   Pin or Unpin)
 * @property {(key: string, pinned: boolean) => void} pin  **Pin to In use** / **Unpin**
 * @property {(cb: () => void) => void} onInUseChange  `cb` runs when In use's cards or pins
 *   change (only across pages: in one page a render draws both)
 */

/**
 * What In use (`sidebar.js`) asks of the Containers section: what `mountContainers` returns,
 * or across pages, `containers_intent`s.
 *
 * @typedef {object} ContainersIntents
 * @property {(ref: PaneRef) => void} reveal  a tile's **Reveal in Containers**
 * @property {(part: 'history' | 'pr', key: string, open: boolean) => void} setFold  a card In use
 *   shows opened or closed its past sessions (by card key) or its pull request (by `prKey`): it
 *   shows the same in Containers once it is no longer in use
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

// ---------------------------------------------------------------------------------------------
// The contracts on the wire: `/sidebar` and `/main`, relayed by the server
// ---------------------------------------------------------------------------------------------

/** The {@link ViewIntents} a `view_intent` may name (the server checks the same list). */
export const VIEW_INTENT_NAMES = Object.freeze([
  'openPane',
  'openFile',
  'openDiff',
  'reveal',
  'close',
  'keepOpen',
  'save',
  'reload',
  'prViewed',
  'askAgent',
  'restartLanguage',
  'languageSettings',
]);

/** The {@link SidebarIntents} a `sidebar_intent` may name. */
export const SIDEBAR_INTENT_NAMES = Object.freeze([
  'revealInContainers',
  'prViewed',
]);

/** The {@link ContainersIntents} a `containers_intent` may name (In use → Containers). */
export const CONTAINERS_INTENT_NAMES = Object.freeze(['reveal', 'setFold']);

/** The {@link InUseLink} calls an `inuse_intent` may name (Containers → In use). */
export const INUSE_INTENT_NAMES = Object.freeze(['revealInUse', 'pin']);

/** The view id pattern: what pairs a `/sidebar` page with a `/main` page. */
const VIEW_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The view id in a page URL's hash (`#token=…&view=<id>`): `default` when missing or invalid.
 *
 * @param {string} hash  `location.hash`, `#` included or not
 */
export function viewIdFromHash(hash) {
  const id = new URLSearchParams(hash.replace(/^#/, '')).get('view');
  return id !== null && VIEW_ID.test(id) ? id : 'default';
}

/**
 * Whether a `/sidebar` page's URL hash says its Containers section is drawn elsewhere
 * (`#…&containers=external`: devc-desktop's own Containers pane): the page then draws none, and
 * Reveal in Containers goes out to the view's Containers sections only.
 *
 * @param {string} hash  `location.hash`, `#` included or not
 */
export function containersExternalFromHash(hash) {
  return new URLSearchParams(hash.replace(/^#/, '')).get('containers') ===
    'external';
}

/**
 * Whether a `/main` page's URL hash says its host status strip is drawn elsewhere
 * (`#…&status=external`: devc-desktop's `/host-status` view across the foot of its window): the
 * page then draws none.
 *
 * @param {string} hash  `location.hash`, `#` included or not
 */
export function statusExternalFromHash(hash) {
  return new URLSearchParams(hash.replace(/^#/, '')).get('status') ===
    'external';
}

/**
 * Zen mode as a page URL's query asks for it, the tiling area's starting point (`?zen=…`): `on`
 * is on, `off` is off; `container` or `repo` (from when zen mode had a sidebar scope) is on. Null
 * when the query names none (or an unknown value): the page starts as it was saved.
 *
 * @param {string} search  `location.search`, `?` included or not
 * @returns {boolean | null}
 */
export function zenFromSearch(search) {
  const zen = new URLSearchParams(search.replace(/^\?/, '')).get('zen');
  if (zen === 'on' || zen === 'container' || zen === 'repo') return true;
  if (zen === 'off') return false;
  return null;
}

/**
 * The sidebar's scope as a page URL's query asks for it, its starting point: `?scope=all`,
 * `container` or `repo`, else `?zen=container` or `repo` (from when zen mode had a sidebar
 * scope). Null when the query names none: the sidebar starts as it was saved.
 *
 * @param {string} search  `location.search`, `?` included or not
 * @returns {'all' | 'container' | 'repo' | null}
 */
export function scopeFromSearch(search) {
  const q = new URLSearchParams(search.replace(/^\?/, ''));
  const scope = q.get('scope');
  if (scope === 'all' || scope === 'container' || scope === 'repo') {
    return scope;
  }
  const zen = q.get('zen');
  return zen === 'container' || zen === 'repo' ? zen : null;
}

/** The state of a tiling area not heard from yet: no tiles. @returns {ViewState} */
export function emptyViewState() {
  return { tiles: [], tree: null, focused: null };
}

/**
 * `msg` as a relayed intent for `view` naming one of `names`: its name and arguments, else null.
 *
 * @param {any} msg  a server message
 * @param {'view_intent' | 'sidebar_intent' | 'containers_intent' | 'inuse_intent'} type
 * @param {string} view
 * @param {readonly string[]} names
 * @returns {{name: string, args: unknown[]} | null}
 */
export function relayedIntent(msg, type, view, names) {
  if (msg?.type !== type || msg.view !== view) return null;
  if (!names.includes(msg.name) || !Array.isArray(msg.args)) return null;
  return { name: msg.name, args: msg.args };
}

/**
 * `msg` as a relayed `view_state` for `view`: the state, else null. In use's cards (`inUse`) and
 * pins (`pinned`) come with it when the view's sidebar has sent them.
 *
 * @param {any} msg @param {string} view
 * @returns {ViewState | null}
 */
export function relayedState(msg, view) {
  if (msg?.type !== 'view_state' || msg.view !== view) return null;
  const s = msg.state;
  if (!s || typeof s !== 'object' || !Array.isArray(s.tiles)) return null;
  /** @type {ViewState} */
  const state = {
    tiles: s.tiles,
    tree: s.tree && typeof s.tree === 'object' ? s.tree : null,
    focused: typeof s.focused === 'string' ? s.focused : null,
  };
  if (Array.isArray(s.inUse)) state.inUse = strings(s.inUse);
  if (Array.isArray(s.pinned)) state.pinned = strings(s.pinned);
  return state;
}

/** In use's part of a view's state, as its sidebar sends it in a `view_state`. */
export function inUseState(
  /** @type {Iterable<string>} */ inUse,
  /** @type {Iterable<string>} */ pinned,
) {
  return { inUse: [...inUse].sort(), pinned: [...pinned].sort() };
}

/** @param {unknown[]} v */
function strings(v) {
  return v.filter((x) => typeof x === 'string');
}

/** The `DataTransfer` type of a sidebar row dragged into a tiling area. */
export const DRAG_MIME = 'application/x-devc-web-tile';

/**
 * What a row's drag carries: the content a dropped tile shows.
 *
 * @param {PaneRef | {file: FileRef}} ref
 * @returns {string}  JSON
 */
export function encodeDrag(ref) {
  return JSON.stringify(ref);
}

/**
 * A drag payload back, or null for anything that isn't one: a `PaneRef` (two non-empty strings)
 * or `{file}` with a well-formed `FileRef` (as `layout_state.js`'s `fileRefFromState` accepts).
 *
 * @param {string} text
 * @returns {PaneRef | {file: FileRef} | null}
 */
export function parseDrag(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  if ('file' in value) {
    const file = fileRefFromState(value.file);
    return file ? { file } : null;
  }
  return paneRefFromState(value);
}
