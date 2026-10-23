// The `devc web` tiling area: pane tiles (xterm.js, `renderer.js`), file tiles (CodeMirror,
// `viewer.js`), diff tiles, preview tiles and the layout (`layout.js`, Golden Layout), saved per
// browser. The browser owns all layout: it never splits a Herdr pane or shows a Herdr tab, and
// each pane it creates gets its own Herdr tab (`new_shell`). `mountTiles` returns the
// `TileArea` the sidebar reaches it through; it reaches the sidebar only through
// `SidebarIntents` (both in `lib/view.js`). The window title and `active_pane` follow its
// focused tile.

import { createRenderer } from './renderer.js';
import { createTiling } from './layout.js';
import { createViewer, highlightLines } from './viewer.js';
import { parseSavedLayout, sameFile } from './lib/layout_state.js';
import {
  DRAG_MIME,
  fileKey,
  focusedTile,
  parseDrag,
  previewTileNear,
  tileShowingDiff,
  tileShowingFile,
  tileShowingPane,
} from './lib/view.js';
import {
  createWheelAccumulator,
  decodeBase64,
  encodeInput,
  mouseButton,
  pixelToCell,
  wrapPaste,
} from './lib/input.js';
import { paneLabel, windowTitle } from './lib/sidebar.js';
import { resolvePath } from './lib/links.js';
import { fileView, mediaKind } from './lib/media.js';
import { childPath } from './lib/files.js';
import { sessionAge } from './lib/sessions.js';
import { statusLetter } from './lib/pr_tree.js';
import {
  changedRanges,
  ignoreWhitespace,
  markRanges,
  parsePatch,
  placeThreads,
  splitRows,
  threadRows,
} from './lib/diff.js';
import {
  badge,
  chevron,
  confirmDialog,
  diffStat,
  errorToast,
  h,
  iconButton,
  IS_MAC,
  LABELS,
  markedText,
  openMenu,
  toast,
  writeClipboard,
} from './ui.js';
import {
  activeRepo,
  basename,
  call,
  containerByFolder,
  displayName,
  fileHostPath,
  findPane,
  list,
  nextId,
  onConnectionChange,
  onServerMessage,
  paneKey,
  projects,
  projectStarts,
  refLabel,
  refTooltip,
  resolveRef,
  send,
  socket,
} from './client.js';
import {
  fileRefOf,
  fileRootOf,
  killPane,
  mintPreviewUrl,
  openInEditor,
  previewable,
  setMenuContext,
  stackMenu,
  startProject,
  tileOwnMenuItems,
} from './menus.js';

/** @typedef {import('./lib/view.js').SidebarIntents} SidebarIntents */
/** @typedef {import('./lib/view.js').TileArea} TileArea */
/** @typedef {import('./lib/view.js').ViewIntents} ViewIntents */
/** @typedef {import('./lib/view.js').ViewState} ViewState */
/** @typedef {import('./lib/view.js').TileState} TileState */
/** @typedef {import('./layout.js').Tile} Tile */
/** @typedef {import('./lib/layout_state.js').DiffRef} DiffRef */
/** @typedef {import('./lib/layout_state.js').FileRef} FileRef */
/** @typedef {import('./lib/layout_state.js').PaneRef} PaneRef */
/** @typedef {import('./client.js').ContainerInfo} ContainerInfo */
/** @typedef {import('./menus.js').Placement} Placement */

const LAYOUT_KEY = 'devc-web-layout-v2';
/** The split-tree layout before Golden Layout: removed on load, not migrated. */
const OLD_LAYOUT_KEY = 'devc-web-layout-v1';
const RESIZE_DEBOUNCE_MS = 100;
const DRAG_INTERVAL_MS = 50;
/** How long a `read_selection` may go unanswered before its copy is dropped. */
const SELECTION_TIMEOUT_MS = 5000;
/**
 * How long a copied drag's highlight stays, in a pane whose app draws no selection of its own
 * (see `attachMouse`). It marks grid cells, not text, so it would go stale on the app's next
 * redraw: a brief flash confirms what was copied.
 */
const COPY_FLASH_MS = 500;
/**
 * How long a tile opened on a pane this page just created waits for a snapshot listing it before
 * it says `LABELS.closed`: `new_shell` answers before Herdr's next snapshot arrives.
 */
const NEW_PANE_GRACE_MS = 5000;

/** @type {ReturnType<typeof createTiling> | null} set once the page has started */
let tiling = null;
/**
 * The tiling area as the sidebar reaches it (see `lib/view.js`): its state, the intents, and
 * `dragSource`, the one part that needs both halves in one page.
 *
 * @type {ViewIntents & {state: () => ViewState, dragSource: (el: HTMLElement,
 *   ref: () => PaneRef | {file: FileRef}, title: () => string) => () => void}}
 */
const tileArea = {
  state: viewState,
  openPane,
  openFile,
  openDiff,
  reveal: revealTile,
  close: closeTile,
  keepOpen: (id) => keepTileOpen(tileOf(id)),
  save: (id) => {
    const view = fileViews.get(id);
    if (view) void saveFile(view);
  },
  reload: (id) => {
    const file = fileViews.get(id);
    if (file) void reloadFile(file);
    const diff = diffViews.get(id);
    if (diff) refreshDiff(diff);
  },
  setZen: (on) => tiling?.setZen(on),
  prViewed: (ref, viewed) => showViewed(ref, viewed),
  dragSource: (el, ref, title) =>
    tiling ? tiling.dragSource(el, ref, title) : () => {},
};
/** @type {string | null} */
let focusedTileId = null;
/** Tile ids by when they were last focused (higher is later), to pick the one to reveal. */
const focusSeq = new Map();
let nextFocusSeq = 0;
/** `localFolder\npane` of panes from `new_shell`, → when their grace period ends. */
const newPanes = new Map();

/**
 * A tile's live view. `openKey` is the `container\npane` it has open on the server, if any.
 *
 * @typedef {object} TileView
 * @property {Tile} tile
 * @property {HTMLElement} body
 * @property {HTMLElement} overlay
 * @property {import('./renderer.js').Renderer} renderer
 * @property {string | null} openKey
 * @property {{cols: number, rows: number} | null} size
 * @property {string | null} closedReason
 * @property {boolean} hidden  in a background stack tab: no resize is sent
 * @property {ReturnType<typeof setTimeout> | undefined} resizeTimer
 * @property {ReturnType<typeof setTimeout> | undefined} flashTimer  clears the copy highlight
 * @property {number} frames  frames painted so far: whether the app redrew during a drag
 * @property {ResizeObserver} observer
 * @property {HTMLElement} killButton  the tab's trash button, shown while the pane is known
 */

/** @type {Map<string, TileView>} pane tiles' views, by Tile.id */
const views = new Map();

/**
 * A file tile's live view: the viewer once the file has been read, else an overlay saying why
 * not. `seq` numbers the reads, so only the latest one's answer lands. The viewer is an editor
 * while the file's container runs (saves are written in the container); `hash` is what the last
 * read or save left on disk, sent as a save's `base`. A tile showing its file as media has a
 * media view instead, and never a viewer.
 *
 * @typedef {object} FileView
 * @property {Tile} tile
 * @property {HTMLElement} host      where the viewer mounts
 * @property {HTMLElement} overlay
 * @property {import('./viewer.js').Viewer | null} viewer
 * @property {MediaView | null} media
 * @property {'loading' | 'ok' | 'error'} state
 * @property {string} error          the message shown while `state` is 'error'
 * @property {boolean} [noContainer] the error is that a container file's container isn't running
 * @property {number} seq
 * @property {string | null} hash
 * @property {boolean} dirty         edited since the last read or save
 * @property {boolean} saving
 */

/**
 * A file tile's media view: an image, or an HTML page in a sandboxed frame, loaded from a one-off
 * `/preview/…` URL. `show` loads a URL, `clear` drops what is shown.
 *
 * @typedef {object} MediaView
 * @property {'image' | 'html'} kind
 * @property {(url: string) => void} show
 * @property {() => void} clear
 * @property {() => void} dispose
 */

/** @type {Map<string, FileView>} file tiles' views, by Tile.id */
const fileViews = new Map();
/** Pending `open` request ids → tile id. */
const pendingOpens = new Map();
/**
 * Pending `read_selection` ids → the copy waiting on the text.
 * @type {Map<string, {resolve: (text: string) => void, reject: (e: Error) => void, timer: ReturnType<typeof setTimeout>}>}
 */
const pendingSelections = new Map();
/** The `active_pane` last sent, as `container\npane_id` ('' for none); `null` until one is. */
let sentActivePane = null;

/** The tiling area's element: set by {@link mountTiles}. */
let $tiles = /** @type {HTMLElement} */ (null);

// ---------------------------------------------------------------------------------------------
// File tiles: a project file in the viewer (viewer.js), read from the host (`read_file`)
// ---------------------------------------------------------------------------------------------

/** A file tile's title: the file's name, after a dot while it has unsaved edits. */
function fileTileTitle(file, dirty = false) {
  const name = file ? basename(file.path) : 'unknown file';
  return dirty ? `● ${name}` : name;
}

/**
 * Opens a file in a file tile: in the focused stack's preview tile (`'preview'`), in a new tile in
 * the focused stack (`'stack'`), or split to the right of the focused tile. A tile already showing
 * the file is brought forward instead, except for `'right'`.
 *
 * @param {FileRef} file @param {'preview' | 'stack' | 'right'} where
 */
function openFile(file, where) {
  if (!tiling) return;
  if (where !== 'right') {
    const shown = tileShowingFile(viewState(), file);
    if (shown) {
      revealTile(shown.id);
      return;
    }
  }
  if (where === 'preview') {
    openInPreview({ file });
    return;
  }
  const tile = tiling.addBeside(targetTile()?.id ?? null, { file }, where);
  focusedTileId = tile.id;
  focusSeq.set(tile.id, ++nextFocusSeq);
  fileViews.get(tile.id)?.viewer?.focus();
}

/**
 * Lines to jump to once a file tile's file has loaded (see {@link openFileAt}), by
 * `localFolder\nroot\npath`. Not part of the tile: the layout saves files, not positions.
 * @type {Map<string, {line: number, column?: number}>}
 */
const pendingLines = new Map();

/** Jumps a loaded file tile to the line it was opened at, if any. */
function revealPendingLine(view) {
  const file = view.tile.file;
  const at = file && pendingLines.get(fileKey(file));
  if (!at || !view.viewer) return;
  pendingLines.delete(fileKey(file));
  view.viewer.revealLine(at.line, at.column);
}

/** Opens a repo file in the preview tile, at a 1-based `line` and `column` when given. */
function openFileAt(file, line, column) {
  if (line) pendingLines.set(fileKey(file), { line, column });
  openFile(
    fileRefOf({ localFolder: file.localFolder, root: file.root }, file.path),
    'preview',
  );
  const tile = tileShowingFile(viewState(), file);
  const view = tile && fileViews.get(tile.id);
  if (view) revealPendingLine(view);
}

/** Builds a file tile's view and reads its file. */
function mountFileTile(tile) {
  const host = h('div', { class: 'file-view' });
  const overlay = h('div', { class: 'overlay' });
  const body = h('div', { class: 'tile-body' }, host, overlay);
  tile.element.append(body);
  tile.element.addEventListener('mousedown', () => {
    focusedTileId = tile.id;
    focusSeq.set(tile.id, ++nextFocusSeq);
    tile.focus();
  }, true);
  body.addEventListener('contextmenu', (e) => {
    // The viewer's own text keeps the browser's menu (copy); the margins get the tile's. A
    // right-click inside an HTML media view's frame never gets here: it is the page's.
    if (/** @type {HTMLElement} */ (e.target).closest('.cm-content')) return;
    openMenu(e, tileOwnMenuItems(tileState(tile)));
  });
  // After the factory returns: a title change mid-build would save a half-built layout.
  queueMicrotask(() => {
    if (!fileViews.has(tile.id)) return;
    const file = tile.file;
    // A rendering of a file people also edit as text: told apart from its source's tab.
    const muted = file && fileView(file) === 'media' && previewable(file.path)
      ? LABELS.preview
      : '';
    tile.setTitle(fileTileTitle(file, fileViews.get(tile.id)?.dirty), muted);
    if (file) tile.setTooltip(fileHostPath(file));
  });
  /** @type {FileView} */
  const view = {
    tile,
    host,
    overlay,
    viewer: null,
    media: null,
    state: 'loading',
    error: '',
    seq: 0,
    hash: null,
    dirty: false,
    saving: false,
  };
  fileViews.set(tile.id, view);
  const kind = tile.file && fileView(tile.file) === 'media'
    ? mediaKind(tile.file.path)
    : null;
  if (kind) view.media = createMediaView(view, kind);
  if (tile.file) loadFile(view);
  else {
    view.state = 'error';
    view.error = 'This tile names no file.';
  }
  updateFileOverlay(view);
  queueMicrotask(updatePlaceholder);
}

/**
 * Reads (or re-reads) a file tile's file and shows it. A tile that already shows the file keeps
 * it, scroll position included, while the new read is on its way. Asked while disconnected, the
 * read waits for the next `hello`.
 *
 * @param {FileView} view
 */
async function loadFile(view) {
  const file = view.tile.file;
  if (!file) return;
  const seq = ++view.seq;
  if (view.media ? view.state !== 'ok' : !view.viewer) {
    view.state = 'loading';
    updateFileOverlay(view);
  }
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    view.state = 'loading';
    return;
  }
  const c = file.container ? containerByFolder(file.localFolder) : null;
  view.noContainer = file.container === true && !c;
  if (view.noContainer) {
    view.state = 'error';
    view.error = LABELS.notRunning;
    view.viewer?.destroy();
    view.viewer = null;
    view.media?.clear();
    updateFileOverlay(view);
    return;
  }
  if (view.media) {
    loadMedia(view, view.media, c, seq);
    return;
  }
  let result;
  try {
    result = await call(
      c
        ? {
          type: 'read_container_file',
          container: c.id,
          path: childPath('/', file.path),
        }
        : {
          type: 'read_file',
          localFolder: file.localFolder,
          root: file.root,
          path: file.path,
        },
    );
  } catch (e) {
    if (seq !== view.seq || !fileViews.has(view.tile.id)) return;
    view.state = 'error';
    view.error = String(e?.message ?? e);
    view.viewer?.destroy();
    view.viewer = null;
    updateFileOverlay(view);
    return;
  }
  if (seq !== view.seq || !fileViews.has(view.tile.id)) return;
  const text = typeof result?.text === 'string' ? result.text : '';
  view.hash = typeof result?.hash === 'string' ? result.hash : null;
  if (view.viewer) view.viewer.setText(text);
  else {
    view.viewer = createViewer(view.host, {
      name: basename(file.path),
      text,
      onChange: (dirty) => setFileDirty(view, dirty),
    });
  }
  revealPendingLine(view);
  view.state = 'ok';
  view.error = '';
  syncFileEditable(view);
  updateFileOverlay(view);
}

/**
 * Shows a media view's file from a freshly minted preview URL. An HTML page counts as shown once
 * its frame is pointed at it; an image, once it has loaded (see {@link createMediaView}).
 *
 * @param {FileView} view @param {MediaView} media @param {ContainerInfo | null} c @param {number} seq
 */
async function loadMedia(view, media, c, seq) {
  const file = /** @type {FileRef} */ (view.tile.file);
  let url;
  try {
    url = await mintPreviewUrl(c, fileRootOf(file), file.path);
  } catch (e) {
    if (seq !== view.seq || !fileViews.has(view.tile.id)) return;
    view.state = 'error';
    view.error = String(e?.message ?? e);
    media.clear();
    updateFileOverlay(view);
    return;
  }
  if (seq !== view.seq || !fileViews.has(view.tile.id)) return;
  media.show(url);
  if (media.kind === 'html') {
    view.state = 'ok';
    view.error = '';
    updateFileOverlay(view);
  }
}

/**
 * Builds a file tile's media view in its host. Media views are read-only: never dirty, never
 * editable. An image fits the tile (never enlarged) until a click shows it 1:1, and back; an HTML
 * page gets a frame sandboxed as `/preview/` responses are, never same-origin with this page.
 *
 * @param {FileView} view @param {'image' | 'html'} kind @returns {MediaView}
 */
function createMediaView(view, kind) {
  const name = fileTileTitle(view.tile.file);
  if (kind === 'html') {
    const frame = /** @type {HTMLIFrameElement} */ (h('iframe', {
      sandbox:
        'allow-scripts allow-forms allow-modals allow-popups allow-downloads',
      title: name,
    }));
    view.host.append(h('div', { class: 'media-view' }, frame));
    return {
      kind,
      show: (url) => frame.src = url,
      clear: () => frame.src = 'about:blank',
      dispose: () => {},
    };
  }
  const img = /** @type {HTMLImageElement} */ (h('img', {
    alt: name,
    draggable: 'false',
  }));
  const info = h('div', { class: 'media-info' });
  const scroll = h('div', {
    class: 'media-scroll',
    'data-zoom': 'fit',
    title: 'Click to toggle fit and 1:1',
  }, img);
  // Crisp pixels whenever the image is drawn larger than it is, device pixels included. An SVG
  // has no pixels of its own to keep.
  const vector = /\.svg$/i.test(view.tile.file?.path ?? '');
  const sharpen = () => {
    const drawn = img.getBoundingClientRect().width * devicePixelRatio;
    img.classList.toggle(
      'pixelated',
      !vector && img.naturalWidth > 0 && drawn > img.naturalWidth + 0.5,
    );
  };
  scroll.addEventListener('click', () => {
    scroll.dataset.zoom = scroll.dataset.zoom === 'fit' ? '1:1' : 'fit';
    sharpen();
  });
  img.addEventListener('load', () => {
    if (!fileViews.has(view.tile.id)) return;
    img.hidden = false;
    info.textContent = `${img.naturalWidth} × ${img.naturalHeight}`;
    sharpen();
    view.state = 'ok';
    view.error = '';
    updateFileOverlay(view);
  });
  img.addEventListener('error', () => {
    if (!fileViews.has(view.tile.id) || !img.getAttribute('src')) return;
    // Not the browser's broken-image mark on a checkerboard behind the overlay.
    img.hidden = true;
    info.textContent = '';
    view.state = 'error';
    view.error = `Couldn't show ${name} as an image`;
    updateFileOverlay(view);
  });
  const resized = new ResizeObserver(sharpen);
  resized.observe(scroll);
  view.host.append(h('div', { class: 'media-view' }, scroll, info));
  return {
    kind,
    show: (url) => img.src = url,
    clear: () => {
      img.removeAttribute('src');
      info.textContent = '';
    },
    dispose: () => resized.disconnect(),
  };
}

/**
 * Whether a file tile can be edited: its file is shown and its project's container runs, since
 * saves are written in the container as its remote user, never from the host side.
 */
function fileEditable(view) {
  const file = view.tile.file;
  return Boolean(
    file && view.viewer && view.state === 'ok' &&
      containerByFolder(file.localFolder)?.state === 'connected',
  );
}

/** Makes a file tile's viewer editable or read-only to match {@link fileEditable}. */
function syncFileEditable(view) {
  view.viewer?.setEditable(fileEditable(view));
}

/** Marks a file tile edited or not, in its tab and Layout row. A first edit keeps a preview. */
function setFileDirty(view, dirty) {
  if (view.dirty === dirty) return;
  view.dirty = dirty;
  view.tile.setTitle(fileTileTitle(view.tile.file, dirty));
  if (dirty && view.tile.preview) keepTileOpen(view.tile);
  viewChanged();
}

/** Re-reads a file tile's file, after asking when that would drop unsaved edits. */
async function reloadFile(view) {
  if (
    view.dirty &&
    !await confirmDialog(
      `Discard your changes to ${fileTileTitle(view.tile.file)}?`,
      { okLabel: 'Discard', danger: true },
    )
  ) return;
  loadFile(view);
}

/**
 * Saves a file tile's text in the container (`write_file`). Refused because the file changed on
 * disk since it was read, it asks before overwriting; `overwrite` skips that check.
 *
 * @param {FileView} view @param {boolean} [overwrite]
 */
async function saveFile(view, overwrite = false) {
  const file = view.tile.file;
  if (!file || !view.viewer || view.saving) return;
  const name = fileTileTitle(file);
  if (!view.dirty) {
    toast(`${name} has no unsaved changes`);
    return;
  }
  const c = containerByFolder(file.localFolder);
  if (!fileEditable(view) || !c) {
    errorToast(`Can't save ${name}: its container is not running`);
    return;
  }
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    errorToast(`Can't save ${name}: not connected to devc web`);
    return;
  }
  const text = view.viewer.getText();
  view.saving = true;
  let result;
  try {
    result = await call({
      type: 'write_file',
      container: c.id,
      ...(file.container
        ? { path: childPath('/', file.path) }
        : { root: file.root, path: file.path }),
      text,
      ...(view.hash && !overwrite ? { base: view.hash } : {}),
    });
  } catch (e) {
    view.saving = false;
    if (e?.code !== 'conflict') {
      errorToast(`Couldn't save ${name}: ${e?.message ?? e}`);
      return;
    }
    if (
      fileViews.has(view.tile.id) &&
      await confirmDialog(
        `${name} changed on disk since it was opened. Overwrite it with your changes?`,
        { okLabel: 'Overwrite', danger: true },
      )
    ) saveFile(view, true);
    return;
  }
  view.saving = false;
  view.hash = typeof result?.hash === 'string' ? result.hash : null;
  // Edits typed while the save was on its way stay unsaved.
  if (view.viewer?.getText() === text) view.viewer.markClean();
  toast(`Saved ${name}`);
  // Renderings of the file show what was just saved.
  for (const other of fileViews.values()) {
    if (other.media && other.tile.file && sameFile(other.tile.file, file)) {
      loadFile(other);
    }
  }
}

/** Closes a tile, after asking when it is a file tile with unsaved edits. */
async function closeTile(tileId) {
  const view = fileViews.get(tileId);
  if (
    view?.dirty &&
    !await confirmDialog(
      `Close ${fileTileTitle(view.tile.file)} without saving?`,
      { okLabel: 'Close', danger: true },
    )
  ) return;
  tiling?.close(tileId);
}

/** A file tile's overlay: "Loading…", or why the file can't be shown (with "Open in editor"). */
function updateFileOverlay(view) {
  let message = '';
  let action = null;
  if (view.state === 'loading') message = 'Loading…';
  else if (view.state === 'error') {
    message = view.error;
    const file = view.tile.file;
    const c = file ? containerByFolder(file.localFolder) : null;
    if (file && c?.state === 'connected') {
      action = h('button', {
        onclick: () => openInEditor(fileRootOf(file), file.path, 'stack'),
      }, 'Open in editor');
    }
  }
  view.overlay.hidden = message === '';
  view.overlay.replaceChildren(
    h('div', {}, message),
    ...(action ? [action] : []),
  );
}

/** Tears a file tile's view down. */
function unmountFileTile(tile) {
  const view = fileViews.get(tile.id);
  if (!view) return;
  view.seq++;
  view.viewer?.destroy();
  view.media?.dispose();
  fileViews.delete(tile.id);
  focusSeq.delete(tile.id);
  if (focusedTileId === tile.id) focusedTileId = null;
  queueMicrotask(updatePlaceholder);
}

// ---------------------------------------------------------------------------------------------
// Diff tiles: a pull request file's patch and its review threads (`pr_diff`, `pr_threads`)
// ---------------------------------------------------------------------------------------------

/** Where **Show resolved**, **Split** and **Hide whitespace** are remembered, per browser. */
const SHOW_RESOLVED_KEY = 'devc-web-pr-show-resolved-v1';
const DIFF_SPLIT_KEY = 'devc-web-pr-diff-split-v1';
const HIDE_WHITESPACE_KEY = 'devc-web-pr-hide-whitespace-v1';
let showResolved = loadFlag(SHOW_RESOLVED_KEY);
/** Side by side (old left, new right) rather than unified. */
let diffSplit = loadFlag(DIFF_SPLIT_KEY);
/** Rows that change only whitespace shown as context (`git diff -w`). */
let hideWhitespace = loadFlag(HIDE_WHITESPACE_KEY);

/** @param {string} key */
function loadFlag(key) {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

/** @param {string} key @param {boolean} on */
function saveFlag(key, on) {
  try {
    localStorage.setItem(key, on ? '1' : '0');
  } catch { /* storage unavailable: it just won't survive a reload */ }
}

/**
 * A reply being written to one thread: kept across re-renders and ⟳ (while it has text), so
 * typing survives them.
 *
 * @typedef {{thread: string, el: HTMLElement, textarea: HTMLTextAreaElement,
 *   note: HTMLElement, error: HTMLElement, gone: HTMLElement, buttons: HTMLButtonElement[],
 *   sending: boolean}} Composer
 */

/**
 * A diff tile's live view. `seq` and `threadSeq` number the `pr_diff` and `pr_threads` reads,
 * so only the latest one's answer lands. `data` is the last `pr_diff` result, `threads` the last
 * `pr_threads` listing (this file's threads), `null` until one arrives.
 *
 * @typedef {object} DiffView
 * @property {Tile} tile
 * @property {HTMLElement} body
 * @property {'loading' | 'ok' | 'error'} state
 * @property {string} error
 * @property {any} data
 * @property {import('./lib/diff.js').ParsedPatch | null} parsed
 * @property {ShownPatch | null} shown  `parsed` as drawn, made again when it or
 *   **Hide whitespace** changes
 * @property {any[] | null} threads
 * @property {string | null} threadsError
 * @property {boolean} threadsLoading
 * @property {number} seq
 * @property {number} threadSeq
 * @property {Set<string>} openFolds   rows (`placeThreads` keys, `file`) whose Resolved fold is open
 * @property {Map<string, Composer>} composers  by thread id
 * @property {Set<string>} resolving   threads with a `pr_resolve` in flight
 * @property {boolean} viewedSending   a `pr_viewed` from the header's Viewed is in flight
 */

/**
 * A diff tile's patch as drawn: `parsed` after **Hide whitespace** (when on), and each row's
 * highlighted text (syntax colours, and the changed words of a deleted or added row that
 * faces one on the other side). `\ No newline` notes have none.
 *
 * @typedef {object} ShownPatch
 * @property {import('./lib/diff.js').ParsedPatch} source  the `parsed` it was made from
 * @property {boolean} whitespace  whether it hides whitespace
 * @property {import('./lib/diff.js').ParsedPatch} parsed
 * @property {Map<import('./lib/diff.js').DiffRow, import('./lib/diff.js').Span[]>} spans
 */

/** @type {Map<string, DiffView>} diff tiles' views, by Tile.id */
const diffViews = new Map();

/**
 * Opens a PR file's diff the way a Files click opens a file: a tile already showing it is
 * brought forward; else the focused stack's preview tile shows it (`'preview'`), or a new tile in
 * the focused stack does (`'stack'`, a Ctrl/⌘-click). `'right'` always opens a new tile beside
 * the focused one.
 *
 * @param {import('./lib/layout_state.js').DiffRef} ref
 * @param {'preview' | 'stack' | 'right'} where
 */
function openDiff(ref, where) {
  if (!tiling) return;
  const shown = where === 'right' ? null : tileShowingDiff(viewState(), ref);
  if (shown) {
    revealTile(shown.id);
    if (where === 'stack') keepTileOpen(tileOf(shown.id));
    return;
  }
  if (where === 'preview') {
    openInPreview({ diff: ref });
    return;
  }
  const tile = tiling.addBeside(
    targetTile()?.id ?? null,
    { diff: ref },
    where,
  );
  focusedTileId = tile.id;
  focusSeq.set(tile.id, ++nextFocusSeq);
  viewChanged();
}

/** A diff tile's title: `<basename> · #<n>` once its PR is known. */
function diffTileTitle(tile) {
  const ref = tile.diff;
  const name = ref ? basename(ref.path) : 'unknown file';
  const pr = diffViews.get(tile.id)?.data?.pr;
  return pr ? `${name} · #${pr.number}` : name;
}

function setDiffTitle(view) {
  const ref = view.tile.diff;
  const pr = view.data?.pr;
  view.tile.setTitle(diffTileTitle(view.tile));
  view.tile.setTooltip(
    [pr ? `${pr.repo}#${pr.number}` : '', ref?.path ?? ''].filter((s) => s)
      .join('\n'),
  );
  viewChanged();
}

/** Builds a diff tile's view and asks for its file (`pr_diff`). */
function mountDiffTile(tile) {
  const body = h('div', { class: 'diff-view' });
  tile.element.append(h('div', { class: 'tile-body' }, body));
  tile.element.addEventListener('mousedown', () => {
    focusedTileId = tile.id;
    focusSeq.set(tile.id, ++nextFocusSeq);
    tile.focus();
  }, true);
  body.addEventListener('contextmenu', (e) => {
    // Text keeps the browser's menu (copy); the rest gets the tile's.
    const target = /** @type {HTMLElement} */ (e.target);
    if (target.closest('.diff-text, .thread-body, textarea')) return;
    openMenu(e, tileOwnMenuItems(tileState(tile)));
  });
  /** @type {DiffView} */
  const view = {
    tile,
    body,
    state: 'loading',
    error: '',
    data: null,
    parsed: null,
    shown: null,
    threads: null,
    threadsError: null,
    threadsLoading: false,
    seq: 0,
    threadSeq: 0,
    openFolds: new Set(),
    composers: new Map(),
    resolving: new Set(),
    viewedSending: false,
  };
  diffViews.set(tile.id, view);
  // After the factory returns: a title change mid-build would save a half-built layout.
  queueMicrotask(() => {
    if (diffViews.get(tile.id) === view) setDiffTitle(view);
  });
  if (tile.diff) void loadDiff(view);
  else {
    view.state = 'error';
    view.error = 'This tile names no file.';
  }
  renderDiff(view);
  queueMicrotask(updatePlaceholder);
}

function unmountDiffTile(tile) {
  const view = diffViews.get(tile.id);
  if (!view) return;
  view.seq++;
  view.threadSeq++;
  diffViews.delete(tile.id);
  focusSeq.delete(tile.id);
  if (focusedTileId === tile.id) focusedTileId = null;
  queueMicrotask(updatePlaceholder);
}

/**
 * Reads (or re-reads) a diff tile's file (`pr_diff`), then its threads. What it shows stays up
 * while the new read is on its way. Asked while disconnected, the read waits for the next
 * `hello`.
 *
 * @param {DiffView} view
 */
async function loadDiff(view) {
  const ref = view.tile.diff;
  if (!ref) return;
  const seq = ++view.seq;
  if (view.state !== 'ok') {
    view.state = 'loading';
    renderDiff(view);
  }
  let result = null;
  let error = null;
  try {
    result = await call({ type: 'pr_diff', ...ref });
  } catch (e) {
    error = String(e?.message ?? e);
  }
  if (seq !== view.seq || diffViews.get(view.tile.id) !== view) return;
  if (error === null && result?.available !== true) {
    error = String(result?.message ?? 'The pull request is not available');
  }
  if (error !== null) {
    view.state = 'error';
    view.error = error;
    renderDiff(view);
    return;
  }
  view.state = 'ok';
  view.error = '';
  view.data = result;
  const patch = result.file?.patch;
  view.parsed = typeof patch === 'string' ? parsePatch(patch) : null;
  setDiffTitle(view);
  renderDiff(view);
  void loadThreads(view);
}

/** Lists the file's review threads again (`pr_threads`). @param {DiffView} view */
async function loadThreads(view) {
  const ref = view.tile.diff;
  if (!ref || view.state !== 'ok') return;
  const seq = ++view.threadSeq;
  view.threadsLoading = true;
  renderDiff(view);
  let result = null;
  let error = null;
  try {
    result = await call({ type: 'pr_threads', ...ref });
  } catch (e) {
    error = String(e?.message ?? e);
  }
  if (seq !== view.threadSeq || diffViews.get(view.tile.id) !== view) return;
  view.threadsLoading = false;
  if (error === null && result?.available !== true) {
    error = String(result?.message ?? 'The threads are not available');
  }
  if (error !== null) view.threadsError = error;
  else {
    view.threadsError = null;
    view.threads = list(result.threads);
  }
  renderDiff(view);
}

/** ⟳: the file, then its threads, again. A reply with text in it stays. */
function refreshDiff(view) {
  for (const [id, c] of view.composers) {
    if (c.textarea.value.trim() === '' && !c.sending) view.composers.delete(id);
  }
  void loadDiff(view);
}

/**
 * The header's **Viewed** (`pr_viewed`): shown at once, put back with a toast on a failure. A
 * success shows in the file's other diff tiles and the sidebar's PR tree.
 *
 * @param {DiffView} view @param {boolean} viewed
 */
async function setDiffViewed(view, viewed) {
  const ref = view.tile.diff;
  const file = view.data?.file;
  if (!ref || !file) return;
  const before = file.viewed;
  file.viewed = viewed ? 'VIEWED' : 'UNVIEWED';
  view.viewedSending = true;
  renderDiff(view);
  let message = null;
  try {
    const r = await call({ type: 'pr_viewed', ...ref, viewed });
    if (r?.available === false) message = String(r.message ?? 'failed');
    else if (r?.viewed === 'VIEWED' || r?.viewed === 'UNVIEWED') {
      file.viewed = r.viewed;
    }
  } catch (e) {
    message = String(e?.message ?? e);
  }
  view.viewedSending = false;
  if (message !== null) {
    file.viewed = before;
    errorToast(`Marking Viewed failed: ${message}`);
  }
  if (diffViews.get(view.tile.id) === view) renderDiff(view);
  if (message !== null) return;
  showViewed(ref, file.viewed);
  sidebarIntents?.prViewed(ref, file.viewed);
}

/**
 * A PR file was marked Viewed or not (here, or in the sidebar: `ViewIntents.prViewed`): each
 * diff tile showing it shows that.
 *
 * @param {DiffRef} ref @param {'VIEWED' | 'UNVIEWED'} viewed
 */
function showViewed(ref, viewed) {
  if (viewed !== 'VIEWED' && viewed !== 'UNVIEWED') return;
  for (const view of diffViews.values()) {
    const d = view.tile.diff;
    const file = view.data?.file;
    if (
      !d || !file || d.localFolder !== ref?.localFolder ||
      d.root !== ref?.root || d.path !== ref?.path || file.viewed === viewed
    ) continue;
    file.viewed = viewed;
    renderDiff(view);
  }
}

function toggleShowResolved() {
  showResolved = !showResolved;
  saveFlag(SHOW_RESOLVED_KEY, showResolved);
  for (const view of diffViews.values()) renderDiff(view);
}

/** @param {boolean} on */
function setDiffSplit(on) {
  if (diffSplit === on) return;
  diffSplit = on;
  saveFlag(DIFF_SPLIT_KEY, on);
  for (const view of diffViews.values()) renderDiff(view);
}

function toggleHideWhitespace() {
  hideWhitespace = !hideWhitespace;
  saveFlag(HIDE_WHITESPACE_KEY, hideWhitespace);
  for (const view of diffViews.values()) {
    // Row keys change with the rows: folds opened under the old ones would land elsewhere.
    view.openFolds.clear();
    renderDiff(view);
  }
}

/**
 * The patch as drawn (see {@link ShownPatch}), made on first use after a read or a
 * **Hide whitespace** change. Each hunk's old side (context and deleted rows) and new side
 * (context and added rows) are highlighted as one text each, under the old and new path.
 *
 * @param {DiffView} view
 * @returns {ShownPatch | null}
 */
function shownPatch(view) {
  const source = view.parsed;
  if (!source) return null;
  if (
    view.shown?.source === source && view.shown.whitespace === hideWhitespace
  ) {
    return view.shown;
  }
  const parsed = hideWhitespace ? ignoreWhitespace(source) : source;
  const file = view.data?.file;
  const newName = file?.path ?? view.tile.diff?.path ?? '';
  const oldName = file?.previousPath ?? newName;
  /** @type {ShownPatch['spans']} */
  const spans = new Map();
  for (const hunk of parsed.hunks) {
    const olds = hunk.rows.filter((r) =>
      r.kind === 'context' || r.kind === 'del'
    );
    const news = hunk.rows.filter((r) =>
      r.kind === 'context' || r.kind === 'add'
    );
    // A context row's text is the new side's (after Hide whitespace the sides can differ).
    highlightLines(oldName, olds.map((r) => r.text)).forEach((line, i) => {
      if (olds[i].kind === 'del') spans.set(olds[i], line);
    });
    highlightLines(newName, news.map((r) => r.text)).forEach((line, i) => {
      spans.set(news[i], line);
    });
    for (const [i, ranges] of changedRanges(hunk)) {
      const row = hunk.rows[i];
      const line = spans.get(row);
      if (line) spans.set(row, markRanges(line, ranges));
    }
  }
  view.shown = { source, whitespace: hideWhitespace, parsed, spans };
  return view.shown;
}

/** A row's text as nodes: its highlighted runs, or plain text for a note. */
function rowText(shown, row) {
  const spans = shown.spans.get(row);
  if (!spans) return markedText(row.text);
  return spans.flatMap((s) => {
    const cls = [s.cls, s.changed ? 'diff-word' : ''].filter((c) => c).join(
      ' ',
    );
    return cls
      ? [h('span', { class: cls }, ...markedText(s.text))]
      : markedText(s.text);
  });
}

/** Draws a diff tile from its view: the header, then File threads and the hunks. */
function renderDiff(view) {
  const active = /** @type {HTMLElement | null} */ (document.activeElement);
  const caret = active instanceof HTMLTextAreaElement
    ? [active.selectionStart, active.selectionEnd]
    : null;
  const scroll = view.body.querySelector('.diff-body')?.scrollTop ?? 0;
  const body = h('div', { class: 'diff-body' });
  view.body.replaceChildren(diffHeader(view), body);
  if (view.state === 'loading') {
    body.append(h('div', { class: 'diff-message' }, 'Loading…'));
  } else if (view.state === 'error') {
    body.append(
      h(
        'div',
        { class: 'diff-message' },
        h('div', {}, ...markedText(view.error)),
        view.tile.diff
          ? h('button', {
            type: 'button',
            onclick: () => void loadDiff(view),
          }, 'Retry')
          : '',
      ),
    );
  } else body.append(...diffContent(view));
  body.scrollTop = scroll;
  if (active && active.isConnected && active !== document.activeElement) {
    active.focus({ preventScroll: true });
    if (caret && active instanceof HTMLTextAreaElement) {
      active.setSelectionRange(caret[0], caret[1]);
    }
  }
}

/** The path (`old → new` for a rename), status, `+a −d`, `#n`, ⟳ and ↗, and whose bridge. */
function diffHeader(view) {
  const ref = view.tile.diff;
  const data = view.state === 'ok' ? view.data : null;
  const file = data?.file;
  const pr = data?.pr;
  const line = h('div', { class: 'diff-head-line' });
  const path = file?.previousPath
    ? [...markedText(file.previousPath), ' → ', ...markedText(file.path)]
    : markedText(file?.path ?? ref?.path ?? '');
  line.append(h('span', { class: 'diff-path' }, ...path));
  if (file) {
    const letter = statusLetter(file.status);
    line.append(
      h('span', { class: 'pr-status', 'data-status': letter }, letter),
      h('span', { class: 'pr-stat' }, diffStat(file)),
    );
  }
  if (pr) {
    line.append(
      h('span', { class: 'pr-number', title: pr.url }, `#${pr.number}`),
    );
  }
  line.append(h('span', { class: 'diff-head-fill' }));
  if (file && data.canViewed) {
    const viewed = h('input', {
      type: 'checkbox',
      class: 'pr-viewed',
      disabled: view.viewedSending,
      onchange: (e) =>
        void setDiffViewed(
          view,
          /** @type {HTMLInputElement} */ (e.target).checked,
        ),
    });
    /** @type {HTMLInputElement} */ (viewed).checked = file.viewed === 'VIEWED';
    line.append(h(
      'label',
      {
        class: 'diff-toggle diff-viewed',
        title: file.viewed === 'DISMISSED'
          ? 'Viewed, changed since viewed'
          : 'Mark this file Viewed on GitHub',
      },
      viewed,
      'Viewed',
    ));
  }
  line.append(
    iconButton('refresh', 'Refresh', () => refreshDiff(view)),
    data?.fileUrl
      ? iconButton(
        'external',
        'Open on GitHub',
        () => window.open(data.fileUrl, '_blank', 'noopener'),
      )
      : '',
  );
  /** @param {string} label @param {boolean} on @param {() => void} onchange */
  const checkbox = (label, on, onchange) => {
    const input = h('input', { type: 'checkbox', onchange });
    /** @type {HTMLInputElement} */ (input).checked = on;
    return h('label', { class: 'diff-toggle' }, input, label);
  };
  /** @param {string} label @param {boolean} split */
  const layoutButton = (label, split) =>
    h('button', {
      type: 'button',
      'aria-pressed': String(diffSplit === split),
      onclick: () => setDiffSplit(split),
    }, label);
  const tools = h(
    'div',
    { class: 'diff-tools' },
    h(
      'span',
      { class: 'diff-layout', role: 'group', 'aria-label': 'Diff layout' },
      layoutButton('Unified', false),
      layoutButton('Split', true),
    ),
    checkbox('Hide whitespace', hideWhitespace, toggleHideWhitespace),
    checkbox('Show resolved', showResolved, toggleShowResolved),
    h('span', { class: 'diff-head-fill' }),
    data
      ? h(
        'span',
        { class: 'diff-via' },
        `threads via ${data.container}'s bridge`,
      )
      : '',
  );
  return h('div', { class: 'diff-header' }, line, tools);
}

/** File threads, then each hunk with its threads, then any text the parse stopped at. */
function diffContent(view) {
  const data = view.data;
  const threads = view.threads ?? [];
  const shown = shownPatch(view);
  const placed = placeThreads(shown?.parsed ?? null, threads);
  /** The rows a thread is on (see `threadRows`): `open` when an unresolved one is. */
  const covered = new Map();
  for (const t of threads) {
    for (const key of threadRows(shown?.parsed ?? null, t)) {
      if (covered.get(key) !== 'open') {
        covered.set(key, t.isResolved ? 'resolved' : 'open');
      }
    }
  }
  /**
   * A row's keys (both sides' in a split row), for a thread card's hover to find it, and its
   * thread marker.
   *
   * @param {(string | null)[]} keys
   */
  const rowAttrs = (keys) => {
    const ks = [...new Set(keys.filter((k) => k !== null))];
    const marks = ks.map((k) => covered.get(k));
    return {
      'data-keys': ks.join(' '),
      'data-covered': marks.includes('open')
        ? 'open'
        : marks.includes('resolved')
        ? 'resolved'
        : undefined,
    };
  };
  const listed = new Set(threads.map((t) => t.id));
  const out = [];
  // Replies whose thread the last listing no longer has: kept for their text.
  const orphans = [...view.composers.values()].filter((c) =>
    view.threads !== null && !listed.has(c.thread)
  );
  const fileBlock = h('div', { class: 'file-threads' });
  if (view.threadsError) {
    fileBlock.append(
      h(
        'div',
        { class: 'diff-note', 'data-note': 'error' },
        ...markedText(
          view.threadsError,
        ),
      ),
    );
  } else if (view.threads === null && view.threadsLoading) {
    fileBlock.append(h('div', { class: 'diff-note' }, 'Loading threads…'));
  }
  if (placed.file.length || orphans.length) {
    fileBlock.append(h('div', { class: 'file-threads-title' }, 'File threads'));
    fileBlock.append(...threadGroup(view, 'file', placed.file));
    for (const c of orphans) {
      c.gone.hidden = false;
      fileBlock.append(composerEl(view, c));
    }
  }
  if (fileBlock.childNodes.length) out.push(fileBlock);
  if (!shown) {
    out.push(
      h(
        'div',
        { class: 'diff-message' },
        h('div', {}, 'No diff available for this file'),
        data.fileUrl
          ? h('button', {
            type: 'button',
            onclick: () => window.open(data.fileUrl, '_blank', 'noopener'),
          }, 'Open on GitHub')
          : '',
      ),
    );
    return out;
  }
  // An added or removed file has one side only: its rows and numbers, in either layout.
  const status = data.file?.status;
  /** @type {'old' | 'new' | null} */
  const single = status === 'added'
    ? 'new'
    : status === 'removed'
    ? 'old'
    : null;
  const table = h('div', {
    class: 'diff-table',
    'data-layout': single ? 'single' : diffSplit ? 'split' : 'unified',
  });
  /** A split row's line number, coloured as its side. */
  const num = (n, kind = 'empty') =>
    h(
      'span',
      { class: 'diff-num', 'data-kind': kind },
      n == null ? '' : String(n),
    );
  /** @param {string} key */
  const threadsAt = (key) => {
    const here = placed.rows.get(key);
    if (here) {
      table.append(
        h('div', { class: 'diff-threads' }, ...threadGroup(view, key, here)),
      );
    }
  };
  shown.parsed.hunks.forEach((hunk, hi) => {
    table.append(
      h(
        'div',
        { class: 'diff-hunk' },
        ...markedText(hunk.header),
        hunk.whitespaceOnly
          ? h('span', { class: 'diff-hunk-note' }, ' · whitespace only')
          : '',
      ),
    );
    if (single) {
      hunk.rows.forEach((row, ri) => {
        table.append(
          h(
            'div',
            {
              class: 'diff-row',
              'data-kind': row.kind,
              ...rowAttrs([`${hi}:${ri}`]),
            },
            h(
              'span',
              { class: 'diff-num' },
              row[single] === null ? '' : String(row[single]),
            ),
            h('span', { class: 'diff-text' }, ...rowText(shown, row)),
          ),
        );
        threadsAt(`${hi}:${ri}`);
      });
      return;
    }
    if (diffSplit) {
      for (const sr of splitRows(hunk)) {
        /** @param {import('./lib/diff.js').DiffRow | null} row */
        const side = (row) =>
          h(
            'span',
            { class: 'diff-text', 'data-kind': row?.kind ?? 'empty' },
            ...(row ? rowText(shown, row) : []),
          );
        table.append(
          h(
            'div',
            {
              class: 'diff-row',
              ...rowAttrs([
                sr.leftIndex === null ? null : `${hi}:${sr.leftIndex}`,
                sr.rightIndex === null ? null : `${hi}:${sr.rightIndex}`,
              ]),
            },
            num(sr.left?.old, sr.left?.kind),
            side(sr.left),
            num(sr.right?.new, sr.right?.kind),
            side(sr.right),
          ),
        );
        if (sr.rightIndex !== null) threadsAt(`${hi}:${sr.rightIndex}`);
        if (sr.leftIndex !== null && sr.leftIndex !== sr.rightIndex) {
          threadsAt(`${hi}:${sr.leftIndex}`);
        }
      }
      return;
    }
    hunk.rows.forEach((row, ri) => {
      table.append(
        h(
          'div',
          {
            class: 'diff-row',
            'data-kind': row.kind,
            ...rowAttrs([`${hi}:${ri}`]),
          },
          h(
            'span',
            { class: 'diff-num' },
            row.old === null ? '' : String(row.old),
          ),
          h(
            'span',
            { class: 'diff-num' },
            row.new === null ? '' : String(row.new),
          ),
          h('span', { class: 'diff-text' }, ...rowText(shown, row)),
        ),
      );
      threadsAt(`${hi}:${ri}`);
    });
  });
  out.push(table);
  if (shown.parsed.rest !== null) {
    out.push(
      h('pre', { class: 'diff-rest' }, ...markedText(shown.parsed.rest)),
    );
  }
  return out;
}

/**
 * One place's threads: each unresolved one as a card, then the resolved ones folded into one
 * `Resolved (n)` line, closed until opened (or **Show resolved**).
 *
 * @param {DiffView} view @param {string} key @param {any[]} threads
 */
function threadGroup(view, key, threads) {
  const open = threads.filter((t) => !t.isResolved);
  const resolved = threads.filter((t) => t.isResolved);
  const out = open.map((t) => threadCard(view, t));
  if (resolved.length) {
    const unfolded = showResolved || view.openFolds.has(key);
    out.push(h(
      'button',
      {
        type: 'button',
        class: 'resolved-fold',
        'aria-expanded': String(unfolded),
        onclick: () => {
          if (!view.openFolds.delete(key)) view.openFolds.add(key);
          renderDiff(view);
        },
      },
      chevron(),
      `Resolved (${resolved.length})`,
    ));
    if (unfolded) out.push(...resolved.map((t) => threadCard(view, t)));
  }
  return out;
}

/** Whether this tile's grants let it resolve `thread`. */
function canResolve(view, thread) {
  const scope = view.data?.resolveScope;
  return !thread.isResolved &&
    (scope === 'any' || (scope === 'copilot' && thread.copilot === true));
}

/** A thread's card: each comment, then Reply, Resolve and ↗ as the grants allow. */
function threadCard(view, thread) {
  const now = Date.now();
  const keys = threadRows(view.shown?.parsed ?? null, thread);
  /** Hovering a card marks the rows it is on. @param {boolean} on */
  const hot = (on) => {
    for (const key of keys) {
      for (
        const row of view.body.querySelectorAll(
          `.diff-row[data-keys~="${key}"]`,
        )
      ) row.toggleAttribute('data-hot', on);
    }
  };
  const card = h('div', {
    class: 'thread-card',
    'data-thread': thread.id,
    'data-resolved': thread.isResolved || undefined,
    onmouseenter: () => hot(true),
    onmouseleave: () => hot(false),
  });
  // Where it is: a block's lines, or its one line (none on an outdated thread).
  if (thread.line !== null && thread.line !== undefined) {
    const block = typeof thread.startLine === 'number';
    card.append(h(
      'div',
      { class: 'thread-where', 'data-block': block || undefined },
      block
        ? `Lines ${thread.startLine}–${thread.line}`
        : `Line ${thread.line}`,
    ));
  }
  for (const c of list(thread.comments)) {
    card.append(
      h(
        'div',
        { class: 'thread-comment' },
        h(
          'div',
          { class: 'thread-meta' },
          h(
            'span',
            { class: 'thread-author' },
            ...markedText(c.author ?? 'ghost'),
          ),
          h(
            'span',
            { class: 'thread-age', title: String(c.createdAt) },
            sessionAge(
              String(c.createdAt),
              now,
            ),
          ),
          thread.isOutdated
            ? h('span', { class: 'thread-tag' }, 'outdated')
            : '',
        ),
        h('div', { class: 'thread-body' }, ...markedText(c.body)),
      ),
    );
  }
  const actions = h('div', { class: 'thread-actions' });
  const composer = view.composers.get(thread.id);
  if (view.data?.canReply && !composer) {
    actions.append(h('button', {
      type: 'button',
      onclick: () => openComposer(view, thread.id),
    }, 'Reply'));
  }
  if (canResolve(view, thread)) {
    actions.append(h('button', {
      type: 'button',
      disabled: view.resolving.has(thread.id),
      onclick: () => void resolveThread(view, thread),
    }, 'Resolve'));
  }
  const url = list(thread.comments)[0]?.url;
  if (typeof url === 'string' && url.startsWith('https://github.com/')) {
    actions.append(
      iconButton(
        'external',
        'Open on GitHub',
        () => window.open(url, '_blank', 'noopener'),
      ),
    );
  }
  if (actions.childNodes.length) card.append(actions);
  if (composer) {
    composer.gone.hidden = true;
    card.append(composerEl(view, composer));
  }
  return card;
}

/** A composer's element, its note naming the container as it is now. */
function composerEl(view, c) {
  c.note.textContent =
    `Posted as you through ${view.data?.container}'s devc-bridge, prefixed with 🤖. Max 4000 bytes.`;
  return c.el;
}

/** Opens a reply composer under a thread, focused. */
function openComposer(view, thread) {
  let c = view.composers.get(thread);
  if (!c) {
    const textarea = /** @type {HTMLTextAreaElement} */ (h('textarea', {
      class: 'composer-text',
      rows: '4',
      'aria-label': 'Reply',
    }));
    const send = /** @type {HTMLButtonElement} */ (h('button', {
      type: 'button',
      class: 'composer-send',
      onclick: () => void sendReply(view, c),
    }, 'Reply'));
    const cancel = /** @type {HTMLButtonElement} */ (h('button', {
      type: 'button',
      onclick: () => closeComposer(view, c),
    }, 'Cancel'));
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        void sendReply(view, c);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        closeComposer(view, c);
      }
    });
    const gone = h(
      'div',
      { class: 'composer-gone', hidden: true },
      THREAD_GONE,
    );
    const note = h('div', { class: 'composer-note' });
    const error = h('div', { class: 'composer-error', hidden: true });
    const el = h(
      'div',
      { class: 'composer' },
      gone,
      textarea,
      h('div', { class: 'composer-actions' }, send, cancel),
      note,
      error,
    );
    c = {
      thread,
      el,
      textarea,
      note,
      error,
      gone,
      buttons: [send, cancel],
      sending: false,
    };
    view.composers.set(thread, c);
  }
  renderDiff(view);
  c.textarea.focus();
}

const THREAD_GONE = 'This thread is resolved or gone';

function closeComposer(view, c) {
  if (c.sending) return;
  view.composers.delete(c.thread);
  renderDiff(view);
}

/**
 * Sends a composer's reply (`pr_reply`). The composer is disabled while it goes; on success it
 * closes and the threads are listed again; on failure its text stays, the error under it.
 *
 * @param {DiffView} view @param {Composer} c
 */
async function sendReply(view, c) {
  const ref = view.tile.diff;
  if (c.sending || !ref) return;
  c.sending = true;
  c.textarea.disabled = true;
  for (const b of c.buttons) b.disabled = true;
  c.error.hidden = true;
  let message = null;
  try {
    const r = await call({
      type: 'pr_reply',
      ...ref,
      thread: c.thread,
      body: c.textarea.value,
    });
    if (r?.available === false) message = String(r.message ?? 'failed');
  } catch (e) {
    message = String(e?.message ?? e);
  }
  c.sending = false;
  c.textarea.disabled = false;
  for (const b of c.buttons) b.disabled = false;
  if (diffViews.get(view.tile.id) !== view) return;
  if (message !== null) {
    c.error.textContent = message;
    c.error.hidden = false;
    c.textarea.focus();
    return;
  }
  view.composers.delete(c.thread);
  renderDiff(view);
  void loadThreads(view);
}

/** Resolves a thread (`pr_resolve`), then lists the threads again. */
async function resolveThread(view, thread) {
  const ref = view.tile.diff;
  if (!ref || view.resolving.has(thread.id)) return;
  view.resolving.add(thread.id);
  renderDiff(view);
  try {
    const r = await call({ type: 'pr_resolve', ...ref, thread: thread.id });
    if (r?.available === false) errorToast(`Resolve failed: ${r.message}`);
  } catch (e) {
    errorToast(`Resolve failed: ${e?.message ?? e}`);
  } finally {
    view.resolving.delete(thread.id);
  }
  if (diffViews.get(view.tile.id) !== view) return;
  void loadThreads(view);
}

// ---------------------------------------------------------------------------------------------
// Layout persistence
// ---------------------------------------------------------------------------------------------

function saveLayout() {
  if (!tiling) return;
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(tiling.save()));
  } catch { /* storage unavailable: the layout just won't survive a reload */ }
}

function restoreLayout() {
  let text = null;
  try {
    localStorage.removeItem(OLD_LAYOUT_KEY);
    text = localStorage.getItem(LAYOUT_KEY);
  } catch { /* unavailable: start empty */ }
  const saved = parseSavedLayout(text);
  if (saved) tiling?.load(saved);
}

// ---------------------------------------------------------------------------------------------
// Tiles
// ---------------------------------------------------------------------------------------------

/** How many tiles have `key` open — a pane open in several tiles is closed with the last. */
function openCount(key) {
  let n = 0;
  for (const v of views.values()) if (v.openKey === key) n++;
  return n;
}

function closeTilePane(tileId) {
  const view = views.get(tileId);
  if (!view || view.openKey === null) return;
  const key = view.openKey;
  view.openKey = null;
  if (openCount(key) === 0) {
    const [container, pane_id] = key.split('\n');
    send({ type: 'close', container, pane_id });
  }
}

function openTilePane(tileId, containerId, paneId) {
  const view = views.get(tileId);
  if (!view) return;
  const size = (!view.hidden && view.renderer.resize()) ||
    { cols: 80, rows: 24 };
  view.size = size;
  view.openKey = paneKey(containerId, paneId);
  view.closedReason = null;
  const id = nextId('o');
  pendingOpens.set(id, tileId);
  send({
    type: 'open',
    id,
    container: containerId,
    pane_id: paneId,
    cols: size.cols,
    rows: size.rows,
  });
}

/** The tile a sidebar click opens into: the focused one, else the first. */
function targetTile() {
  if (!tiling) return null;
  const tiles = tiling.tiles();
  return tiling.focusedTile() ?? tiles.find((t) => t.id === focusedTileId) ??
    tiles[0] ?? null;
}

/** The live tile with id `id`, if any. @param {string | null | undefined} id */
function tileOf(id) {
  return tiling?.tiles().find((t) => t.id === id) ?? null;
}

/**
 * A tile as the sidebar sees it (`lib/view.js`).
 *
 * @param {Tile} tile @returns {TileState}
 */
function tileState(tile) {
  const file = fileViews.get(tile.id);
  return {
    id: tile.id,
    kind: tile.kind,
    ref: tile.ref,
    file: tile.file,
    diff: tile.diff,
    preview: tile.preview,
    focusSeq: focusSeq.get(tile.id) ?? 0,
    title: tile.kind === 'file'
      ? fileTileTitle(tile.file, file?.dirty)
      : tile.kind === 'diff'
      ? diffTileTitle(tile)
      : '',
    dirty: file?.dirty ?? false,
    saveable: Boolean(file?.dirty && fileEditable(file)),
    url: diffViews.get(tile.id)?.data?.fileUrl ?? null,
  };
}

/** What the tiling area shows, as the sidebar reads it. @returns {ViewState} */
function viewState() {
  return {
    tiles: tiling ? tiling.tiles().map(tileState) : [],
    tree: tiling?.tree() ?? null,
    focused: targetTile()?.id ?? null,
  };
}

let viewChangeQueued = false;

/**
 * Tells the sidebar what the tiling area shows may have changed (`onViewChange`), once for all
 * the changes made before the next microtask; the window title and `active_pane` follow.
 */
function viewChanged() {
  if (viewChangeQueued) return;
  viewChangeQueued = true;
  queueMicrotask(() => {
    viewChangeQueued = false;
    updateWindow();
    onViewChange(viewState());
  });
}

/**
 * Shows a pane, focused (see `ViewIntents.openPane`).
 *
 * @param {PaneRef} ref
 * @param {Placement & {created?: 'new' | 'reused'}} [opts]
 */
function openPane(ref, { where = 'stack', at, created } = {}) {
  if (!tiling) return;
  if (created === 'reused') {
    const shown = tileShowingPane(viewState(), ref);
    if (shown) {
      revealTile(shown.id);
      return;
    }
  }
  if (created === 'new') {
    newPanes.set(
      `${ref.localFolder}\n${ref.pane_id}`,
      Date.now() + NEW_PANE_GRACE_MS,
    );
    setTimeout(reconcileTiles, NEW_PANE_GRACE_MS + 50);
  }
  if (where === 'preview') {
    openInPreview(ref);
    return;
  }
  const tile = tiling.addBeside(
    at === undefined ? targetTile()?.id ?? null : at,
    ref,
    where,
  );
  focusedTileId = tile.id;
  reconcileTiles();
  views.get(tile.id)?.renderer.focus();
}

/** Brings a tile to the front of its stack and focuses its terminal (or file viewer). */
function revealTile(tileId) {
  tiling?.reveal(tileId);
  focusedTileId = tileId;
  views.get(tileId)?.renderer.focus();
  fileViews.get(tileId)?.viewer?.focus();
}

/** Whether a tile's missing pane is one this page just created and Herdr hasn't listed yet. */
function isNewPane(ref) {
  const key = `${ref.localFolder}\n${ref.pane_id}`;
  const until = newPanes.get(key);
  if (until === undefined) return false;
  if (Date.now() < until) return true;
  newPanes.delete(key);
  return false;
}

/**
 * Pins a preview tile: the next sidebar click opens a new preview instead of replacing it.
 *
 * @param {Tile | null} tile
 */
function keepTileOpen(tile) {
  if (!tile?.preview) return;
  tile.setPreview(false);
  viewChanged();
}

/**
 * Shows `ref` (a pane, `{file}` or `{diff}`) in the focused stack's preview tile: in place for a
 * pane replacing a pane, else a new tile in that tile's place; with no preview tile there, an
 * empty focused tile takes a pane, or a new preview tile joins the stack. The tile is revealed and
 * focused.
 *
 * @param {PaneRef | {file: FileRef} | {diff: import('./lib/layout_state.js').DiffRef}} ref
 */
function openInPreview(ref) {
  if (!tiling) return;
  const anchor = targetTile();
  const preview = tileOf(previewTileNear(viewState(), anchor?.id)?.id);
  const isFile = 'file' in ref || 'diff' in ref;
  let tile;
  if (preview && !isFile && preview.kind === 'pane') {
    closeTilePane(preview.id);
    views.get(preview.id).closedReason = null;
    preview.setRef(/** @type {PaneRef} */ (ref));
    tiling.reveal(preview.id);
    tile = preview;
  } else if (preview) {
    tile = tiling.replace(preview.id, ref);
  } else if (!isFile && anchor?.kind === 'pane' && !anchor.ref) {
    anchor.setRef(/** @type {PaneRef} */ (ref));
    anchor.setPreview(true);
    tile = anchor;
  } else {
    tile = tiling.addBeside(anchor?.id ?? null, ref, 'stack', {
      preview: true,
    });
  }
  if (!tile) return;
  focusedTileId = tile.id;
  focusSeq.set(tile.id, ++nextFocusSeq);
  reconcileTiles();
  viewChanged();
  if (isFile) fileViews.get(tile.id)?.viewer?.focus();
  else views.get(tile.id)?.renderer.focus();
}

/**
 * Brings every tile's server-side open state in line with the containers and snapshots: open
 * what is reachable and not yet open, close what vanished, and refresh each overlay.
 */
function reconcileTiles() {
  for (const [id, view] of views) {
    if (!isPlaced(view)) continue;
    const ref = view.tile.ref;
    const c = ref ? containerByFolder(ref.localFolder) : null;
    const reachable = c && c.state === 'connected' &&
      findPane(c.id, ref.pane_id);
    if (!reachable) {
      // Disconnected or gone: the server already dropped (or will drop) the controller.
      if (view.openKey !== null && c && c.state === 'connected') {
        closeTilePane(id);
      }
      view.openKey = null;
    } else if (view.openKey === null && view.closedReason === null) {
      openTilePane(id, c.id, ref.pane_id);
    } else if (
      view.openKey !== null && view.openKey !== paneKey(c.id, ref.pane_id)
    ) {
      // The container restarted under a new id, or the tile was pointed at another pane.
      closeTilePane(id);
      openTilePane(id, c.id, ref.pane_id);
    }
    updateOverlay(id);
  }
  for (const view of fileViews.values()) {
    if (view.state === 'error') updateFileOverlay(view);
  }
  renderTileTitles();
  updatePlaceholder();
}

function updateOverlay(tileId) {
  const view = views.get(tileId);
  if (!view) return;
  const ref = view.tile.ref;
  let message = '';
  let action = null;
  if (!ref) {
    message = LABELS.clickToOpen;
  } else {
    const c = containerByFolder(ref.localFolder);
    if (!socket) message = 'Disconnected from devc web.';
    else if (!c) {
      const p = projects.get(ref.localFolder);
      if (p?.starting) message = 'Starting container…';
      else if (p && p.container !== 'running') {
        message = p.container === 'stopped'
          ? 'Container stopped'
          : 'Container not created';
        if (projectStarts) {
          action = h('button', {
            onclick: () => startProject(ref.localFolder),
          }, 'Start container');
        } else message += ' (start it from a terminal)';
      } else message = `${basename(ref.localFolder)} is not running.`;
    } else if (c.state !== 'connected') {
      message = `${displayName(c)}: ${c.state}`;
    } else if (!findPane(c.id, ref.pane_id)) {
      message = isNewPane(ref) ? '' : LABELS.closed;
    } else if (view.closedReason !== null) {
      message = `Disconnected: ${view.closedReason}`;
      action = h('button', {
        onclick: () => {
          view.closedReason = null;
          reconcileTiles();
        },
      }, 'Reconnect');
    }
  }
  view.overlay.hidden = message === '';
  view.overlay.replaceChildren(
    h('div', {}, message),
    ...(action ? [action] : []),
  );
}

/**
 * Each tile's tab: its label (`refLabel`), the pane's agent badge, and a trash button that ends
 * the pane (`killPane`).
 */
function renderTileTitles() {
  for (const view of views.values()) {
    const ref = view.tile.ref;
    if (!ref) {
      view.tile.setTitle('empty');
      view.tile.setBadge(null);
      view.tile.setContext(null);
      view.tile.setActions(null);
      continue;
    }
    const { name, title } = refLabel(ref);
    const { pane } = resolveRef(ref);
    view.tile.setTitle(name, title);
    view.tile.setTooltip(refTooltip(ref).join('\n'));
    view.tile.setBadge(badge(pane) || null);
    view.tile.setActions(pane ? view.killButton : null);
    view.tile.setContext(tileContext(view.tile, name));
  }
}

/**
 * Where a pane tile is, after its label in the tab: its repo (left out when the label already
 * says it), the repo's branch, then its container, muted. Null until its container is known.
 */
function tileContext(tile, name) {
  const { c } = resolveRef(tile.ref);
  if (!c) return null;
  const container = displayName(c);
  const { label, branch } = activeRepo(tile);
  const parts = [];
  if (label && label !== container && label !== name) {
    parts.push(h('span', { class: 'tile-repo' }, label));
  }
  if (branch) parts.push(h('span', { class: 'tile-branch' }, branch));
  parts.push(h('span', { class: 'tile-container' }, container));
  return h('span', {}, ...parts);
}

/** Shown over the tiling area while it has no tiles. */
const $placeholder = h(
  'div',
  { class: 'tiles-placeholder', hidden: true },
  LABELS.dragHere,
);

function updatePlaceholder() {
  $placeholder.hidden = !tiling || !tiling.isEmpty();
}

/**
 * Whether a tile is placed in the layout. One being dragged — a new one from the sidebar, or a
 * tile whose tab is being moved — sits in Golden Layout's drag preview (or nowhere yet), and its
 * size there means nothing to Herdr: it must not open or resize its pane until it is dropped.
 */
function isPlaced(view) {
  return $layoutRoot.contains(view.body);
}

/** Refits a tile's terminal and tells the server when its size changed. */
function refit(view) {
  if (view.hidden || !isPlaced(view)) return;
  const size = view.renderer.resize();
  if (!size) return;
  if (
    view.size && size.cols === view.size.cols && size.rows === view.size.rows
  ) return;
  view.size = size;
  if (view.openKey !== null) {
    const [container, pane_id] = view.openKey.split('\n');
    send({ type: 'resize', container, pane_id, ...size });
  }
}

/** Builds the live view (renderer, overlay, input handlers) inside a new tile. */
function mountTile(tile) {
  if (tile.kind === 'file') {
    mountFileTile(tile);
    return;
  }
  if (tile.kind === 'diff') {
    mountDiffTile(tile);
    return;
  }
  const termEl = h('div', { class: 'term' });
  const overlay = h('div', { class: 'overlay' });
  const body = h('div', { class: 'tile-body' }, termEl, overlay);
  tile.element.append(body);
  tile.element.addEventListener('mousedown', () => {
    focusedTileId = tile.id;
    focusSeq.set(tile.id, ++nextFocusSeq);
    tile.focus();
  }, true);

  const renderer = createRenderer(termEl, {
    linkHint: LINK_HINT,
    linkModifier: isLinkModifier,
  });
  /** @type {TileView} */
  const view = {
    tile,
    body,
    overlay,
    renderer,
    openKey: null,
    size: null,
    closedReason: null,
    hidden: false,
    resizeTimer: undefined,
    flashTimer: undefined,
    frames: 0,
    observer: new ResizeObserver(() => {
      clearTimeout(view.resizeTimer);
      view.resizeTimer = setTimeout(() => refit(view), RESIZE_DEBOUNCE_MS);
    }),
    killButton: iconButton('trash', LABELS.close, () => {
      const { c, pane } = resolveRef(tile.ref);
      if (c && pane) killPane(c, pane);
    }),
  };
  views.set(tile.id, view);
  view.observer.observe(body);

  const target = () => {
    if (view.openKey === null) return null;
    const [container, pane_id] = view.openKey.split('\n');
    return { container, pane_id };
  };

  renderer.onData((data) => {
    const t = target();
    if (!t) return;
    // Typing into a preview means using it: it stays.
    keepTileOpen(tile);
    send({ type: 'input', ...t, bytes: encodeInput(data) });
  });

  const wheelToScroll = createWheelAccumulator();
  renderer.onWheel((ev) => {
    const t = target();
    const m = renderer.metrics();
    if (!t || !m) return;
    const scroll = wheelToScroll(ev.deltaY, m.cellHeight, ev.deltaMode);
    if (scroll) send({ type: 'scroll', ...t, ...scroll });
  });

  // Paste is intercepted before xterm.js sees it: a multi-line paste goes as one bracketed
  // input, because the page cannot know whether the app enabled bracketed paste.
  body.addEventListener('paste', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const t = target();
    const text = ev.clipboardData?.getData('text/plain') ?? '';
    if (t && text) {
      keepTileOpen(tile);
      send({ type: 'input', ...t, bytes: encodeInput(wrapPaste(text)) });
    }
  }, true);

  attachMouse(view, termEl, target);

  // Golden Layout mounts tiles while it builds or restores the layout; open them once it is done.
  queueMicrotask(reconcileTiles);
}

/** Tears a tile's view down; the pane closes on the server with the last tile showing it. */
function unmountTile(tile) {
  if (tile.kind === 'file') {
    unmountFileTile(tile);
    return;
  }
  if (tile.kind === 'diff') {
    unmountDiffTile(tile);
    return;
  }
  const view = views.get(tile.id);
  if (!view) return;
  closeTilePane(tile.id);
  for (const [id, tileId] of pendingOpens) {
    if (tileId === tile.id) pendingOpens.delete(id);
  }
  clearTimeout(view.resizeTimer);
  clearTimeout(view.flashTimer);
  view.observer.disconnect();
  view.renderer.dispose();
  views.delete(tile.id);
  focusSeq.delete(tile.id);
  if (focusedTileId === tile.id) focusedTileId = null;
  queueMicrotask(updatePlaceholder);
}

/** A tile in a background stack tab sends no resize; brought forward, it refits at once. */
function tileVisibility(tile, visible) {
  const view = views.get(tile.id);
  if (!view) return;
  view.hidden = !visible;
  if (visible) requestAnimationFrame(() => refit(view));
}

/**
 * Copies the text between two viewport cells of a pane, read from Herdr's buffer
 * (`read_selection`). Herdr draws no selection and sends no OSC 52 to a control client, so this
 * is the only way its text reaches the clipboard.
 */
function copySelection(t, anchor, cursor) {
  const id = nextId('s');
  /** @type {Promise<string>} */
  const text = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingSelections.delete(id);
      reject(new Error('no reply'));
    }, SELECTION_TIMEOUT_MS);
    pendingSelections.set(id, { resolve, reject, timer });
  });
  send({ type: 'read_selection', id, ...t, anchor, cursor });
  writeClipboard(text).catch((e) =>
    errorToast(`Copy failed: ${e?.message ?? e}`)
  );
}

/** Whether the key that opens terminal links is down during `ev`. */
function isLinkModifier(ev) {
  return IS_MAC ? ev.metaKey : ev.ctrlKey;
}

/** The tooltip over a terminal link. */
const LINK_HINT = `${IS_MAC ? 'Cmd' : 'Ctrl'}+click to open`;

/** The terminal cell under a mouse event, or null before the terminal is laid out. */
function cellAt(view, e) {
  const m = view.renderer.metrics();
  return m
    ? pixelToCell(
      e.clientX - m.left,
      e.clientY - m.top,
      m.cellWidth,
      m.cellHeight,
      m.cols,
      m.rows,
    )
    : null;
}

/**
 * Opens a link in pane `t`: a URL in a new browser tab, a file in the viewer when it is in one of
 * the container's project repos. Relative paths are from the pane's current folder.
 *
 * @param {{container: string, pane_id: string}} t
 * @param {import('./lib/links.js').Link} link
 */
async function openLink(t, link) {
  if (link.kind === 'url') {
    window.open(link.url, '_blank', 'noopener,noreferrer');
    return;
  }
  const pane = findPane(t.container, t.pane_id);
  const path = resolvePath(pane?.foreground_cwd || pane?.cwd || '', link.path);
  if (!path) {
    errorToast(`Can't open ${link.path}: the terminal's folder is unknown`);
    return;
  }
  try {
    const file = await call({
      type: 'locate_file',
      container: t.container,
      path,
    });
    openFileAt(file, link.line, link.column);
  } catch (e) {
    errorToast(`Can't open ${link.path}: ${e?.message ?? e}`);
  }
}

/**
 * Plain mouse down/drag/up over the terminal go to Herdr as cells (the browser does not
 * select); a plain left-drag's text is copied from Herdr, and flashed here unless the app redrew
 * during the drag (it draws its own selection). Shift+drag
 * is left to xterm.js for a local selection, copied on mouseup. A right-click opens the tile's
 * menu (the same as its tab's) and is not sent to the app. Cmd+click (Ctrl+click off a Mac) on
 * a link opens it ({@link openLink}); anywhere else it is an ordinary click.
 */
function attachMouse(view, termEl, target) {
  termEl.addEventListener('contextmenu', (ev) => {
    ev.preventDefault();
    openMenu(ev, tileOwnMenuItems(tileState(view.tile)));
  });
  termEl.addEventListener('mousedown', (ev) => {
    if (ev.button === 2) {
      ev.preventDefault();
      ev.stopPropagation();
      view.renderer.focus();
      return;
    }
    if (ev.button === 0 && isLinkModifier(ev)) {
      const at = cellAt(view, ev);
      const link = at && view.renderer.linkAt(at);
      const t = target();
      if (link && t) {
        ev.preventDefault();
        ev.stopPropagation();
        // The file opens in the preview tile, which must not be this terminal.
        keepTileOpen(view.tile);
        openLink(t, link);
        return;
      }
    }
    if (ev.shiftKey) {
      const onUp = () => {
        window.removeEventListener('mouseup', onUp, true);
        const text = view.renderer.selection();
        if (text) navigator.clipboard?.writeText(text).catch(() => {});
      };
      window.addEventListener('mouseup', onUp, true);
      return;
    }
    const button = mouseButton(ev.button);
    const t = target();
    ev.preventDefault();
    ev.stopPropagation();
    view.renderer.focus();
    view.renderer.clearHighlight();
    if (!button || !t) return;
    const cell = (e) => cellAt(view, e);
    const start = cell(ev);
    if (!start) return;
    send({ type: 'mouse', ...t, action: 'down', button, ...start });
    const framesAtDown = view.frames;
    let last = start;
    let lastSent = 0;
    let trailing;
    const onMove = (e) => {
      const c = cell(e);
      if (!c || (c.column === last.column && c.row === last.row)) return;
      last = c;
      const sendDrag = () => {
        lastSent = Date.now();
        send({ type: 'mouse', ...t, action: 'drag', button, ...last });
      };
      clearTimeout(trailing);
      const wait = DRAG_INTERVAL_MS - (Date.now() - lastSent);
      if (wait <= 0) sendDrag();
      else trailing = setTimeout(sendDrag, wait);
    };
    const onUp = (e) => {
      window.removeEventListener('mousemove', onMove, true);
      window.removeEventListener('mouseup', onUp, true);
      clearTimeout(trailing);
      const c = cell(e) ?? last;
      send({ type: 'mouse', ...t, action: 'up', button, ...c });
      if (
        button === 'left' && (c.column !== start.column || c.row !== start.row)
      ) {
        // An app that redrew during the drag is drawing its own selection (Claude Code, vim
        // with the mouse on): a second, grid-bound highlight would only contradict it.
        if (view.frames === framesAtDown) {
          view.renderer.highlight(start, c);
          clearTimeout(view.flashTimer);
          view.flashTimer = setTimeout(
            () => view.renderer.clearHighlight(),
            COPY_FLASH_MS,
          );
        }
        copySelection(t, start, c);
      }
    };
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('mouseup', onUp, true);
  }, true);
}

// ---------------------------------------------------------------------------------------------
// Tiles: the window title and the active pane
// ---------------------------------------------------------------------------------------------

/**
 * The window's title, from the focused tile's repo, branch and pane title, and the server's
 * `active_pane` (see {@link reportActivePane}): both follow the focused tile and what the server
 * says about it.
 */
function updateWindow() {
  const tile = focusedTile(viewState());
  const { label, branch } = tile ? activeRepo(tile) : {};
  // The title the pane's program sets, as its tab shows it after the name.
  const pane = tile?.ref ? resolveRef(tile.ref).pane : null;
  const title = windowTitle(label, branch, pane ? paneLabel(pane).title : '');
  if (document.title !== title) document.title = title;
  reportActivePane(false);
}

/**
 * Tells the server which terminal pane is focused (none when the focused tile isn't one), for
 * devc-desktop's host terminal, which offers to `cd` to its folder; the server focuses it in
 * Herdr too, which marks its agent's finished turn seen (`done` to `idle`). Sent when it changes, and
 * with `force` whatever it is: on connecting, and when this window gains focus, so the window
 * last used is the one that counts.
 *
 * @param {boolean} force
 */
function reportActivePane(force) {
  const tile = focusedTile(viewState());
  const { c } = resolveRef(tile?.ref ?? null);
  const msg = c && tile?.ref
    ? { type: 'active_pane', container: c.id, pane_id: tile.ref.pane_id }
    : { type: 'active_pane' };
  const now = 'container' in msg ? `${msg.container}\n${msg.pane_id}` : '';
  if (!force && now === sentActivePane) return;
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  sentActivePane = now;
  send(msg);
}

// ---------------------------------------------------------------------------------------------
// Tiles: mounting
// ---------------------------------------------------------------------------------------------

/** How the tiling area tells the sidebar what it shows: set by {@link mountTiles}. */
let onViewChange = (/** @type {ViewState} */ _state) => {};
/** How the tiling area reaches the sidebar: set by {@link mountTiles}; null with none. */
let sidebarIntents = /** @type {SidebarIntents | null} */ (null);

/** Golden Layout's root, in the tiling area's element. */
const $layoutRoot = h('div', { class: 'layout-root' });

/**
 * A server message, as the tiling area takes it once `client.js` has applied it: reads waiting on
 * a connection, panes to open or close, frames, tab titles, its own requests' results, and the
 * window title and `active_pane`, which follow the focused tile.
 */
function onTilesMessage(msg) {
  switch (msg.type) {
    case 'hello':
      // File reads asked for while disconnected never got an answer.
      for (const view of fileViews.values()) {
        if (view.state === 'loading') loadFile(view);
      }
      for (const view of diffViews.values()) {
        if (view.state === 'loading') void loadDiff(view);
      }
      reportActivePane(true);
      break;
    case 'containers':
      for (const view of fileViews.values()) {
        // A container file's rendering goes when its container does: its URL reads from it.
        const gone = view.media && view.tile.file?.container &&
          !containerByFolder(view.tile.file.localFolder);
        if (view.noContainer || gone) loadFile(view);
        else syncFileEditable(view);
      }
      reconcileTiles();
      break;
    case 'projects':
    case 'snapshot':
      reconcileTiles();
      break;
    case 'pane_updated':
    case 'agent_status':
      renderTileTitles();
      break;
    case 'frame':
      onFrame(msg);
      return;
    case 'pane_closed':
      onPaneClosed(msg.container, msg.pane_id, msg.reason);
      break;
    case 'result':
      onTileResult(msg);
      break;
  }
  updateWindow();
}

function onFrame(msg) {
  const key = paneKey(msg.container, msg.pane_id);
  const bytes = decodeBase64(msg.bytes);
  for (const view of views.values()) {
    if (view.openKey !== key) continue;
    view.renderer.write(bytes, msg.cols, msg.rows);
    view.frames++;
  }
}

function onPaneClosed(containerId, paneId, reason) {
  const key = paneKey(containerId, paneId);
  for (const [id, view] of views) {
    if (view.openKey !== key) continue;
    view.openKey = null;
    view.closedReason = reason;
    updateOverlay(id);
  }
}

/** Settles the tiling area's own requests: `read_selection` and `open`. */
function onTileResult(msg) {
  const selection = pendingSelections.get(msg.id);
  if (selection) {
    pendingSelections.delete(msg.id);
    clearTimeout(selection.timer);
    if (msg.ok) selection.resolve(String(msg.result?.text ?? ''));
    else {
      selection.reject(
        new Error(msg.error?.message ?? msg.error?.code ?? 'failed'),
      );
    }
    return;
  }
  if (pendingOpens.has(msg.id)) {
    const tileId = pendingOpens.get(msg.id);
    pendingOpens.delete(msg.id);
    const view = views.get(tileId);
    if (view && !msg.ok) {
      view.openKey = null;
      view.closedReason = msg.error?.message ?? 'open failed';
      updateOverlay(tileId);
    }
  }
}

/** The connection dropped: the server dropped every pane it had open; reopen on reconnect. */
function onTilesConnection(state) {
  if (state !== 'closed') return;
  for (const view of views.values()) view.openKey = null;
  pendingOpens.clear();
  reconcileTiles();
}

// ---------------------------------------------------------------------------------------------
// Native drops: a `/sidebar` page's rows dragged into this tiling area (`lib/view.js`'s
// `DRAG_MIME`). `/`'s own rows drag through Golden Layout instead (`tileArea.dragSource`).
// ---------------------------------------------------------------------------------------------

/**
 * Where a drop at the pointer lands: over a tile (its body or its tab), that tile, split right in
 * its body's right quarter, below in its bottom quarter, else in its stack. Over no tile, null.
 *
 * @param {DragEvent} e
 * @returns {{at: string, where: 'right' | 'below' | 'stack', rect: DOMRect} | null}
 */
function dropPlace(e) {
  if (!tiling) return null;
  const target = /** @type {Element} */ (e.target);
  const tiles = tiling.tiles();
  const tab = /** @type {HTMLElement | null} */ (target.closest?.('.lm_tab'));
  let tile = tab ? tiles.find((t) => t.id === tab.dataset.tile) : undefined;
  tile ??= tiles.find((t) => t.element.contains(target));
  if (!tile) return null;
  // The region is the body showing in the tile's stack: a background tab's own body is hidden.
  const stack = tile.element.closest('.lm_stack');
  const shown =
    tiles.find((t) =>
      stack?.contains(t.element) && t.element.getClientRects().length > 0
    ) ?? tile;
  const rect = shown.element.getBoundingClientRect();
  const where = e.clientX >= rect.right - rect.width / 4
    ? 'right'
    : e.clientY >= rect.bottom - rect.height / 4
    ? 'below'
    : 'stack';
  return { at: tile.id, where, rect };
}

/** The translucent region a native drop would fill, while one is dragged over. */
const $dropIndicator = h('div', { class: 'tile-drop-indicator', hidden: '' });

/** @param {{where: string, rect: DOMRect} | null} place */
function showDropIndicator(place) {
  const box = place?.rect ?? $tiles.getBoundingClientRect();
  const right = place?.where === 'right';
  const below = place?.where === 'below';
  Object.assign($dropIndicator.style, {
    left: `${right ? box.right - box.width / 4 : box.left}px`,
    top: `${below ? box.bottom - box.height / 4 : box.top}px`,
    width: `${right ? box.width / 4 : box.width}px`,
    height: `${below ? box.height / 4 : box.height}px`,
  });
  $dropIndicator.hidden = false;
}

function hideDropIndicator() {
  $dropIndicator.hidden = true;
}

/**
 * Opens a dropped row's content in a new tile placed by {@link dropPlace}, focused: a tile already
 * showing it is not reused, since the drag asked for a tile there.
 *
 * @param {PaneRef | {file: FileRef}} ref
 * @param {{at: string, where: 'right' | 'below' | 'stack'} | null} place
 */
function openDropped(ref, place) {
  if (!tiling) return;
  const at = place ? place.at : targetTile()?.id ?? null;
  const where = place?.where ?? 'stack';
  if (!('file' in ref)) {
    openPane(ref, { where, at });
    return;
  }
  const tile = tiling.addBeside(at, ref, where);
  focusedTileId = tile.id;
  focusSeq.set(tile.id, ++nextFocusSeq);
  fileViews.get(tile.id)?.viewer?.focus();
}

/**
 * Makes `root` take native drops of `DRAG_MIME`. Capture phase, so a file viewer or terminal
 * under the pointer never sees them (a viewer would insert the row's `text/plain`); every other
 * drag (Golden Layout's, text into a viewer) is left alone.
 *
 * @param {HTMLElement} root
 */
function acceptNativeDrops(root) {
  document.body.append($dropIndicator);
  /** @param {DragEvent} e */
  const ours = (e) => !!e.dataTransfer?.types.includes(DRAG_MIME);
  root.addEventListener('dragover', (e) => {
    if (!ours(e)) return;
    e.preventDefault();
    e.stopPropagation();
    /** @type {DataTransfer} */ (e.dataTransfer).dropEffect = 'copy';
    showDropIndicator(dropPlace(e));
  }, true);
  root.addEventListener('dragleave', (e) => {
    const to = /** @type {Node | null} */ (e.relatedTarget);
    if (!to || !root.contains(to)) hideDropIndicator();
  }, true);
  root.addEventListener('drop', (e) => {
    if (!ours(e)) return;
    e.preventDefault();
    e.stopPropagation();
    hideDropIndicator();
    const ref = parseDrag(
      /** @type {DataTransfer} */ (e.dataTransfer).getData(DRAG_MIME),
    );
    if (ref) openDropped(ref, dropPlace(e));
  }, true);
  document.addEventListener('dragend', hideDropIndicator);
}

/**
 * Mounts the tiling area into `root` (today's `#tiles`) and returns the sidebar's way in.
 * `sidebar` is how the tiling area reaches the sidebar; `null` when no sidebar is on the page.
 *
 * @param {HTMLElement} root
 * @param {{sidebar: SidebarIntents | null,
 *   onViewChange: (state: ViewState) => void}} opts
 * @returns {TileArea}
 */
export function mountTiles(root, opts) {
  $tiles = root;
  onViewChange = opts.onViewChange;
  sidebarIntents = opts.sidebar;
  setMenuContext({ tileArea, sidebar: opts.sidebar });
  $tiles.replaceChildren($layoutRoot, $placeholder);
  tiling = createTiling($layoutRoot, {
    mount: mountTile,
    unmount: unmountTile,
    visibility: tileVisibility,
    focused: (tile) => {
      if (tile) {
        focusedTileId = tile.id;
        focusSeq.set(tile.id, ++nextFocusSeq);
      }
      viewChanged();
    },
    // A drop is a change too: the dropped tile is placed now, so it may open its pane.
    changed: () => {
      saveLayout();
      reconcileTiles();
      viewChanged();
    },
    tileMenu: (tile, e) => openMenu(e, tileOwnMenuItems(tileState(tile))),
    stackMenu,
    tabDoubleClick: keepTileOpen,
  });

  // Golden Layout closes a tab on its × (and a middle click) with no way to refuse: a file tile
  // with unsaved edits asks first. Capture phase, ahead of Golden Layout's own listener.
  document.addEventListener('click', (e) => {
    const target = /** @type {HTMLElement} */ (e.target);
    const tab = /** @type {HTMLElement | null} */ (target.closest?.('.lm_tab'));
    if (!tab || !(target.closest('.lm_close_tab') || e.button === 1)) return;
    const tileId = tab.dataset.tile;
    if (!tileId || !fileViews.get(tileId)?.dirty) return;
    e.preventDefault();
    e.stopPropagation();
    closeTile(tileId);
  }, true);

  // Ctrl+S or Cmd+S (either on a Mac) in a file tile saves it. Here, in the capture phase, rather
  // than in CodeMirror's keymap: the page sees the key before anything in the view can type it,
  // and a terminal's Ctrl+S (XOFF) is left alone, since only keys aimed at a file view count.
  document.addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() !== 's' || e.altKey || e.shiftKey) return;
    if (!(IS_MAC ? e.metaKey || e.ctrlKey : e.ctrlKey && !e.metaKey)) return;
    const target = /** @type {Node} */ (e.target);
    for (const view of fileViews.values()) {
      if (!view.host.contains(target)) continue;
      e.preventDefault();
      e.stopPropagation();
      if (!e.repeat) saveFile(view);
      return;
    }
  }, true);

  // Leaving the page with unsaved edits: the browser asks.
  window.addEventListener('beforeunload', (e) => {
    for (const view of fileViews.values()) {
      if (view.dirty) {
        e.preventDefault();
        return;
      }
    }
  });

  window.addEventListener('focus', () => reportActivePane(true));
  onServerMessage(onTilesMessage);
  onConnectionChange(onTilesConnection);
  acceptNativeDrops(root);
  restoreLayout();
  reconcileTiles();
  updateWindow();
  return tileArea;
}
