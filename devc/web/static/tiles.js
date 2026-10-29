// The `devc web` tiling area: pane tiles (xterm.js, `renderer.js`), file tiles (CodeMirror,
// `viewer.js`), diff tiles, preview tiles and the layout (`layout.js`, Golden Layout), saved per
// browser. The browser owns all layout: it never splits a Herdr pane or shows a Herdr tab, and
// each pane it creates gets its own Herdr tab (`new_shell`). `mountTiles` returns the
// `TileArea` the sidebar reaches it through; it reaches the sidebar only through
// `SidebarIntents` (both in `lib/view.js`). The window title and `active_pane` follow its
// focused tile.

import { createRenderer } from './renderer.js';
import { createTiling } from './layout.js';
import { createViewer, highlightLines, lspHoverHtml } from './viewer.js';
import {
  attachTile,
  attachView,
  detachTile,
  detachView,
  openView,
  restartTile,
  setLspHooks,
  showViewLocation,
  tileAttached,
  tileExited,
  tileRestartable,
  tileStatus,
  viewRequest,
  viewStatus,
} from './lsp.js';
import { LSP_LANGUAGE_NAMES, lspLanguageFor } from './lib/languages.js';
import { openAskDialog } from './ask.js';
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
  zenFromSearch,
} from './lib/view.js';
import {
  createWheelAccumulator,
  decodeBase64,
  encodeInput,
  mouseButton,
  pixelToCell,
  wrapPaste,
} from './lib/input.js';
import {
  isZenShortcut,
  paneLabel,
  projectActions,
  savedZen,
  windowTitle,
} from './lib/sidebar.js';
import { resolvePath } from './lib/links.js';
import { fileView, mediaKind } from './lib/media.js';
import { childPath } from './lib/files.js';
import { sessionAge } from './lib/sessions.js';
import { statusLetter } from './lib/pr_tree.js';
import { reopensDashboard } from './lib/dashboard.js';
import {
  changedRanges,
  diffTexts,
  fillPatch,
  ignoreWhitespace,
  lineMap,
  markRanges,
  MAX_DIFF_LINES,
  newColumn,
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
  svgIcon,
  toast,
  writeClipboard,
} from './ui.js';
import {
  activeRepo,
  basename,
  call,
  containerByFolder,
  dashboard,
  displayName,
  fileHostPath,
  findPane,
  holdReloadWhile,
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
  tileRepo,
} from './client.js';
import {
  dashboardFileRef,
  discardPendingReview,
  fileRefOf,
  fileRootOf,
  killPane,
  mintPreviewUrl,
  openInEditor,
  previewable,
  setMenuContext,
  stackMenu,
  startProject,
  submitPendingReview,
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
/**
 * Where the focused tile (its pane, file or diff) is kept across a reload of this tab, when the
 * page had the keyboard as it went: `sessionStorage`, read once.
 */
const FOCUS_KEY = 'devc-web-focused-tile-v1';
/**
 * Where file and diff tiles' scroll positions are kept across a reload of this tab (a live
 * reload above all): `sessionStorage`, read once.
 */
const SCROLL_KEY = 'devc-web-tile-scroll-v1';
/**
 * Zen mode, `true` or `false`, per browser and per page: the page with the sidebar
 * (`ZEN_KEY`, off by default) and `/main` alone (`MAIN_ZEN_KEY`, on by default, as in a VS Code
 * webview). The page URL's `?zen=…` (`zenFromSearch`) only sets where the page starts, and is
 * never saved; a zen change is.
 */
const ZEN_KEY = 'devc-web-zen-v1';
const MAIN_ZEN_KEY = 'devc-web-main-zen-v1';
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
  prViewed: (ref, viewed) => showViewed(ref, viewed),
  askAgent: (id) => askAgentFrom(id),
  restartLanguage: (id) => void restartLanguage(id),
  languageSettings: (id) => void languageSettings(id),
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
 * @property {HTMLElement} lspStatus  the language server's status line (`lsp.js`)
 * @property {boolean} [lspWanted]    whether it wanted a language server at the last sync
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
// Ask agent: a question about a file or diff tile's file (`ask.js`)
// ---------------------------------------------------------------------------------------------

/** A file or diff tile's tab button for {@link askAgentFrom}. */
function askButton(tile) {
  return iconButton('ask', LABELS.askAgent, () => askAgentFrom(tile.id));
}

/**
 * Opens the Ask agent dialog for the file a file or diff tile shows, in the repo it is in, with
 * what is selected in it: a file tile's selection with its lines, a diff tile's selected text
 * (`diffText`, when it was read before a click that may have cleared it). The agent's terminal
 * opens to the right of the tile.
 *
 * @param {string} id @param {string} [diffText]
 */
function askAgentFrom(id, diffText) {
  const tile = tileOf(id);
  const ref = tile?.file ?? tile?.diff;
  if (!tile || !ref) return;
  const { localFolder, repo } = tileRepo(tile);
  if (!localFolder || !repo) {
    toast('Ask agent: this file is not in one of the project’s repos');
    return;
  }
  // As the agent finds it from the repo: relative, or a container file's absolute path.
  const path = tile.file?.container ? childPath('/', ref.path) : ref.path;
  /** @type {{text: string, startLine?: number, endLine?: number} | null | undefined} */
  let selection = fileViews.get(id)?.viewer?.selection();
  if (tile.diff) {
    const text = diffText ?? pageSelection(tile);
    selection = text ? { text } : null;
  }
  openAskDialog({
    at: id,
    localFolder,
    root: repo.folder,
    context: {
      path,
      ...(selection ? { selection } : {}),
      ...(tile.diff ? { diff: true } : {}),
    },
  });
}

/** The page's selected text while it is in `tile` ('' for none): a diff tile's selection. */
function pageSelection(tile) {
  const sel = window.getSelection();
  return sel && !sel.isCollapsed && sel.anchorNode &&
      tile.element.contains(sel.anchorNode)
    ? sel.toString()
    : '';
}

/** Whether a tile's file is in one of its project's repos: one an agent can be asked about. */
function askable(tile) {
  const { localFolder, repo } = tileRepo(tile);
  return Boolean(localFolder && repo);
}

/**
 * The menu a right-click on a file tile's text opens, in place of the browser's (Shift+right-click
 * still gets that): **Ask agent…**, about the selection or, with none, the file, and the
 * clipboard's items.
 */
function fileTextMenuItems(tile, viewer) {
  const cm = viewer.view;
  const { from, to } = cm.state.selection.main;
  const editable = !cm.state.readOnly;
  const copy = () =>
    writeClipboard(Promise.resolve(cm.state.sliceDoc(from, to))).catch((e) =>
      errorToast(`Copy failed: ${e?.message ?? e}`)
    );
  /** @type {import('./ui.js').MenuItem[]} */
  const items = [];
  if (askable(tile)) {
    items.push([LABELS.askAgent, () => askAgentFrom(tile.id)], null);
  }
  if (editable && from !== to) {
    items.push(['Cut', () => {
      void copy();
      cm.dispatch(cm.state.replaceSelection(''), { userEvent: 'delete.cut' });
      cm.focus();
    }]);
  }
  if (from !== to) items.push(['Copy', () => void copy()]);
  if (editable && navigator.clipboard?.readText) {
    items.push(['Paste', () => {
      navigator.clipboard.readText().then((text) => {
        cm.dispatch(cm.state.replaceSelection(text), {
          userEvent: 'input.paste',
          scrollIntoView: true,
        });
        cm.focus();
      }).catch((e) => errorToast(`Paste failed: ${e?.message ?? e}`));
    }]);
  }
  items.push(['Select all', () => {
    cm.dispatch({ selection: { anchor: 0, head: cm.state.doc.length } });
    cm.focus();
  }]);
  return items;
}

/**
 * The menu a right-click on a diff tile's text opens, in place of the browser's (Shift+right-click
 * still gets that): **Ask agent…**, about the selected text or, with none, the file, and Copy.
 */
function diffTextMenuItems(tile) {
  const text = pageSelection(tile);
  /** @type {import('./ui.js').MenuItem[]} */
  const items = [];
  if (askable(tile)) {
    items.push([LABELS.askAgent, () => askAgentFrom(tile.id, text)], null);
  }
  if (text) {
    items.push(['Copy', () => {
      writeClipboard(Promise.resolve(text)).catch((e) =>
        errorToast(`Copy failed: ${e?.message ?? e}`)
      );
    }]);
  }
  return items;
}

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
  const lspStatus = h('div', { class: 'lsp-status', hidden: '' });
  const body = h('div', { class: 'tile-body' }, host, lspStatus, overlay);
  tile.element.append(body);
  tile.element.addEventListener('mousedown', () => {
    focusedTileId = tile.id;
    focusSeq.set(tile.id, ++nextFocusSeq);
    tile.focus();
  }, true);
  body.addEventListener('contextmenu', (e) => {
    // The viewer's own text gets its text menu (Ask agent, the clipboard), Shift+right-click the
    // browser's; the margins get the tile's. A right-click inside an HTML media view's frame
    // never gets here: it is the page's.
    if (/** @type {HTMLElement} */ (e.target).closest('.cm-content')) {
      const viewer = fileViews.get(tile.id)?.viewer;
      if (!e.shiftKey && viewer) openMenu(e, fileTextMenuItems(tile, viewer));
      return;
    }
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
    if (file && !muted) tile.setActions(askButton(tile));
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
    lspStatus,
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
    detachTile(view.tile.id);
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
    detachTile(view.tile.id);
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
    const spot = takeSavedScroll(fileKey(file));
    if (Number.isInteger(spot?.line) && Number.isFinite(spot?.offset)) {
      view.viewer.scrollToSpot(spot);
    }
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

/**
 * Makes a file tile's viewer editable or read-only to match {@link fileEditable}, and attaches it
 * to its file's language server while it is editable ({@link syncLanguage}).
 */
function syncFileEditable(view) {
  view.viewer?.setEditable(fileEditable(view));
  syncLanguage(view);
}

// ---------------------------------------------------------------------------------------------
// Language servers: an editable text tile attaches to its file's (`lsp.js`)
// ---------------------------------------------------------------------------------------------

/**
 * Attaches a file tile to its file's language server while it shows the file as text and can
 * edit it (its container is connected), and detaches it otherwise. Read-only, media and diff
 * tiles never attach; neither does a file no server takes. A tile whose session exited keeps
 * saying so (`… stopped: container stopped`) after it stops being editable, and attaches anew
 * once it is editable again.
 *
 * @param {FileView} view
 */
function syncLanguage(view) {
  const file = view.tile.file;
  const c = file ? containerByFolder(file.localFolder) : null;
  const wanted = Boolean(
    file && view.viewer && !view.media && c && fileEditable(view) &&
      lspLanguageFor(file.path),
  );
  const was = view.lspWanted;
  view.lspWanted = wanted;
  if (wanted && file && view.viewer && c) {
    attachTile(view.tile.id, file, c, view.viewer, !was);
  } else if (tileAttached(view.tile.id) && !tileExited(view.tile.id)) {
    detachTile(view.tile.id);
  }
  renderLspStatus(view);
}

/** A file tile's language server status line (`lsp.js`'s `tileStatus`): hidden when empty. */
function renderLspStatus(view) {
  const { text, title } = tileStatus(view.tile.id);
  view.lspStatus.hidden = text === '';
  view.lspStatus.textContent = text;
  view.lspStatus.title = title;
}

/** **Restart language server**: the tile's session stops and starts again. */
async function restartLanguage(id) {
  try {
    await restartTile(id);
  } catch (e) {
    errorToast(`Restarting the language server failed: ${e?.message ?? e}`);
  }
}

/**
 * The file a file tile's language messages address: `write_file`'s fields.
 *
 * @param {FileRef} file
 */
function lspFileFields(file) {
  return file.container
    ? { path: childPath('/', file.path) }
    : { root: file.root, path: file.path };
}

/**
 * **Language server settings…**: the detected root and server, and for a repo file a form for
 * its project's entry in `language-servers.json` (a root from the checkout down to the file's
 * folder, and the launcher's options). **Save** sends `lsp_settings_set`; **Reset to detected**
 * removes the entry. A container file's settings are shown read-only.
 */
async function languageSettings(id) {
  const tile = tileOf(id);
  const file = tile?.file;
  const c = file ? containerByFolder(file.localFolder) : null;
  if (!file || !c) return;
  let info;
  try {
    info = await call({
      type: 'lsp_settings_get',
      container: c.id,
      ...lspFileFields(file),
    });
  } catch (e) {
    errorToast(`Language server settings: ${e?.message ?? e}`);
    return;
  }
  const entry = await settingsDialog(info, basename(file.path));
  if (entry === undefined) return;
  try {
    await call({
      type: 'lsp_settings_set',
      container: c.id,
      root: file.root,
      path: file.path,
      entry,
    });
    toast(
      entry
        ? 'Language server settings saved'
        : 'Language server settings reset',
    );
  } catch (e) {
    errorToast(`Saving language server settings failed: ${e?.message ?? e}`);
  }
}

/** `path` relative to container folder `root`: `.` for the folder itself, else as given. */
function relativeRoot(root, path) {
  if (path === root) return '.';
  const base = root.endsWith('/') ? root : `${root}/`;
  return path.startsWith(base) ? path.slice(base.length) : path;
}

/**
 * The settings dialog for {@link languageSettings}. Resolves the entry to save (`null`: reset to
 * detected), or undefined when it is closed without either.
 *
 * @param {any} info  `lsp_settings_get`'s answer
 * @param {string} name  the file's name
 * @returns {Promise<{root: string, options: Record<string, unknown>} | null | undefined>}
 */
function settingsDialog(info, name) {
  return new Promise((resolve) => {
    /** @type {{root: string, options: Record<string, unknown>} | null | undefined} */
    let answer;
    const language = LSP_LANGUAGE_NAMES[info.language] ?? info.language;
    const editable = info.editable === true;
    const checkout = typeof info.checkoutRoot === 'string'
      ? info.checkoutRoot
      : '';
    const detected = info.detected && typeof info.detected.root === 'string'
      ? info.detected
      : null;
    const detectedRel = detected
      ? (checkout ? relativeRoot(checkout, detected.root) : detected.root)
      : '';
    const facts = h(
      'dl',
      { class: 'lsp-settings-facts' },
      h('dt', {}, 'Language'),
      h('dd', {}, language),
      h('dt', {}, 'Detected root'),
      h('dd', {}, detected ? detected.root : 'none (this file is not served)'),
      h('dt', {}, 'Server'),
      h('dd', {}, detected?.server || '—'),
    );
    const fields = [];
    /** @type {HTMLSelectElement | null} */
    let $root = null;
    /** @type {{key: string, type: string, el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement}[]} */
    const inputs = [];
    const $error = h('p', { class: 'lsp-settings-error', hidden: '' });
    if (editable) {
      // The checkout's folders down to the file's own, checkout-relative.
      const parts = String(info.path ?? '').split('/').slice(0, -1);
      const dirs = [
        '.',
        ...parts.map((_, i) => parts.slice(0, i + 1).join('/')),
      ];
      $root = /** @type {HTMLSelectElement} */ (h(
        'select',
        { 'aria-label': 'Root' },
        h('option', { value: '' }, `Detected (${detectedRel || '?'})`),
        ...dirs.map((d) => h('option', { value: d }, d)),
      ));
      const current = info.entry
        ? (info.entry.root === '' ? '.' : info.entry.root)
        : '';
      $root.value = dirs.includes(current) ? current : '';
      fields.push(
        h(
          'label',
          { class: 'lsp-settings-field' },
          h('span', {}, 'Root'),
          $root,
        ),
      );
      const options = Array.isArray(info.schema?.options)
        ? info.schema.options
        : [];
      for (const opt of options) {
        if (typeof opt?.key !== 'string') continue;
        const set =
          info.entry?.options && Object.hasOwn(info.entry.options, opt.key)
            ? info.entry.options[opt.key]
            : undefined;
        let el;
        if (opt.type === 'enum' && Array.isArray(opt.enum)) {
          el = /** @type {HTMLSelectElement} */ (h(
            'select',
            { 'aria-label': opt.key },
            h(
              'option',
              { value: '' },
              `Default (${String(opt.default ?? '')})`,
            ),
            ...opt.enum.map((v) =>
              h('option', { value: String(v) }, String(v))
            ),
          ));
          el.value = set === undefined ? '' : String(set);
        } else if (opt.type === 'json') {
          el = /** @type {HTMLTextAreaElement} */ (h('textarea', {
            class: 'lsp-settings-json',
            rows: '4',
            spellcheck: 'false',
            'aria-label': opt.key,
            placeholder: JSON.stringify(opt.default ?? {}),
          }));
          el.value = set === undefined ? '' : JSON.stringify(set, null, 2);
        } else {
          el = /** @type {HTMLInputElement} */ (h('input', {
            type: 'text',
            class: 'ask-input',
            spellcheck: 'false',
            autocomplete: 'off',
            'aria-label': opt.key,
            placeholder: String(opt.default ?? ''),
          }));
          el.value = set === undefined ? '' : String(set);
        }
        inputs.push({ key: opt.key, type: String(opt.type), el });
        fields.push(h(
          'label',
          { class: 'lsp-settings-field', title: String(opt.description ?? '') },
          h('span', {}, opt.key),
          el,
          opt.description
            ? h(
              'small',
              { class: 'lsp-settings-help' },
              String(opt.description),
            )
            : null,
        ));
      }
    } else {
      fields.push(h(
        'p',
        { class: 'lsp-settings-help' },
        'Only a file in one of the project’s repos has per-project settings.',
      ));
    }
    const save = () => {
      /** @type {Record<string, unknown>} */
      const options = {};
      for (const { key, type, el } of inputs) {
        const v = el.value.trim();
        if (v === '') continue;
        if (type === 'json') {
          let parsed;
          try {
            parsed = JSON.parse(v);
          } catch {
            parsed = null;
          }
          if (
            typeof parsed !== 'object' || parsed === null ||
            Array.isArray(parsed)
          ) {
            $error.textContent = `${key} must be a JSON object`;
            $error.hidden = false;
            el.focus();
            return;
          }
          options[key] = parsed;
        } else options[key] = v;
      }
      const chosen = $root?.value ?? '';
      const root = chosen === '' ? detectedRel : chosen;
      if (chosen === '' && (!detected || root.startsWith('/'))) {
        $error.textContent =
          'The detected root is not in this checkout: pick a root';
        $error.hidden = false;
        return;
      }
      answer = { root: root === '.' ? '' : root, options };
      el.close();
    };
    const buttons = editable
      ? [
        h('button', {
          type: 'button',
          onclick: () => {
            answer = null;
            el.close();
          },
        }, 'Reset to detected'),
        h('span', { class: 'lsp-settings-gap' }),
        h('button', { type: 'button', onclick: () => el.close() }, 'Cancel'),
        h(
          'button',
          { type: 'button', class: 'primary', onclick: save },
          'Save',
        ),
      ]
      : [
        h('span', { class: 'lsp-settings-gap' }),
        h('button', { type: 'button', onclick: () => el.close() }, 'Close'),
      ];
    const el = /** @type {HTMLDialogElement} */ (h(
      'dialog',
      {
        class: 'dialog ask lsp-settings',
        'aria-label': 'Language server settings',
        onclose: () => {
          el.remove();
          resolve(answer);
        },
      },
      h(
        'div',
        { class: 'ask-body' },
        h('p', { class: 'ask-message' }, `Language server settings: ${name}`),
        facts,
        ...fields,
        $error,
      ),
      h('footer', { class: 'dialog-footer ask-footer' }, ...buttons),
    ));
    document.body.append(el);
    el.showModal();
  });
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
  detachTile(tile.id);
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

/**
 * Where **Show resolved**, **Split**, **Hide whitespace**, **Tint rows** and **Whole file** are
 * remembered, per browser.
 */
const SHOW_RESOLVED_KEY = 'devc-web-pr-show-resolved-v1';
const DIFF_SPLIT_KEY = 'devc-web-pr-diff-split-v1';
const HIDE_WHITESPACE_KEY = 'devc-web-pr-hide-whitespace-v1';
const PLAIN_ONE_SIDED_KEY = 'devc-web-pr-plain-one-sided-v1';
const WHOLE_FILE_KEY = 'devc-web-pr-whole-file-v1';
let showResolved = loadFlag(SHOW_RESOLVED_KEY);
/** Side by side (old left, new right) rather than unified. */
let diffSplit = loadFlag(DIFF_SPLIT_KEY);
/** Rows that change only whitespace shown as context (`git diff -w`). */
let hideWhitespace = loadFlag(HIDE_WHITESPACE_KEY);
/** An added or removed file's rows drawn without their green or red (**Tint rows** off). */
let plainOneSided = loadFlag(PLAIN_ONE_SIDED_KEY);
/** Every line of the file, not only the patch's hunks (see `fillPatch`). */
let wholeFile = loadFlag(WHOLE_FILE_KEY);

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
 * A new comment being written on a line or block (`pr_pending_comment`): `startLine` is a block's
 * first line on `side` (null for one line), `hunk` the hunk both ends are in.
 *
 * @typedef {{side: 'LEFT' | 'RIGHT', startLine: number | null, line: number, hunk: number,
 *   el: HTMLElement, label: HTMLElement, textarea: HTMLTextAreaElement, error: HTMLElement,
 *   buttons: HTMLButtonElement[], sending: boolean}} NewComment
 */

/**
 * A pending comment being edited (`pr_pending_edit`).
 *
 * @typedef {{el: HTMLElement, textarea: HTMLTextAreaElement, error: HTMLElement,
 *   buttons: HTMLButtonElement[], sending: boolean}} CommentEdit
 */

/**
 * A **Since viewed** comparison: the file at `sha` (the head it was last marked Viewed at)
 * against the file at the PR's head, both read with `pr_file_at` and diffed here (`diffTexts`).
 * `parsed` is set once both arrive; `message` says why there is none. `texts` keeps both, so
 * **Whole file** diffs them again (`whole`, made on first use) without reading them again.
 *
 * @typedef {{sha: string, state: 'loading' | 'ok' | 'error',
 *   parsed: import('./lib/diff.js').ParsedPatch | null, message: string,
 *   texts: [string, string] | null,
 *   whole: import('./lib/diff.js').ParsedPatch | null}} SinceView
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
 * @property {SinceView | null} since  the **Compare** choice when not `PR changes`; the tile's
 *   own, never saved in the layout
 * @property {boolean} wantViewed  opened with `compare: 'viewed'`: picks the newest Since viewed
 *   choice once the file is read
 * @property {boolean} noRecord  asked for changes since viewed with none recorded
 * @property {{id: string, comments: number} | null} review  the viewer's pending review
 * @property {NewComment | null} newComment
 * @property {{side: 'LEFT' | 'RIGHT', line: number, hunk: number} | null} anchor  the last `+`
 *   clicked: a Shift-click on another in its hunk and side makes a block
 * @property {Map<string, CommentEdit>} editing  pending comments being edited, by comment id
 * @property {{sha: string, got: Promise<{text: string | null, message: string}>,
 *   done: {text: string | null, message: string} | null} | null} head
 *   the PR head's text for its language server view and **Whole file** (`pr_file_at`, see
 *   `readHead`), `done` once it arrives, fetched once per head
 * @property {DiffView['head']} headWait  the head read a draw waits on, to draw again once
 * @property {{parsed: import('./lib/diff.js').ParsedPatch, text: string,
 *   out: import('./lib/diff.js').ParsedPatch | 'large' | null} | null} filled  the last
 *   `fillPatch` of `parsed` with the head's `text` (`'large'`: past `MAX_DIFF_LINES` lines)
 * @property {{head: string, text: string, map: (line: number) => number | null} | null} local
 *   while an open tile holds the file with other text: the PR head's lines mapped onto it
 * @property {number} scrollTop  where the body was last scrolled to while shown: a hidden tab
 *   reads as scrolled to the top, and a redraw starts a new body
 * @property {boolean} [lspWanted]  whether it wanted a language server at the last sync
 */

/**
 * A diff tile's patch as drawn: `parsed` after **Hide whitespace** (when on), and each row's
 * highlighted text (syntax colours, and the changed words of a deleted or added row that
 * faces one on the other side). `\ No newline` notes have none.
 *
 * @typedef {object} ShownPatch
 * @property {import('./lib/diff.js').ParsedPatch} source  the `parsed` it was made from
 * @property {boolean} whitespace  whether it hides whitespace
 * @property {boolean} whole  whether `source` is the whole file (**Whole file**)
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
function openDiff(ref, where, opts) {
  if (!tiling) return;
  const shown = where === 'right' ? null : tileShowingDiff(viewState(), ref);
  if (shown) {
    revealTile(shown.id);
    if (where === 'stack') keepTileOpen(tileOf(shown.id));
  } else if (where === 'preview') {
    openInPreview({ diff: ref });
  } else {
    const tile = tiling.addBeside(
      targetTile()?.id ?? null,
      { diff: ref },
      where,
    );
    focusedTileId = tile.id;
    focusSeq.set(tile.id, ++nextFocusSeq);
    viewChanged();
  }
  if (opts?.compare !== 'viewed') return;
  const view = diffViews.get(focusedTileId ?? '');
  if (!view || !sameDiff(view.tile.diff, ref)) return;
  if (view.state === 'ok') applyViewedCompare(view);
  else view.wantViewed = true;
}

/** @param {DiffRef | undefined} a @param {DiffRef | undefined} b */
function sameDiff(a, b) {
  return !!a && !!b && a.localFolder === b.localFolder && a.root === b.root &&
    a.path === b.path;
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
  // A right-click on the diff's text leaves the selection as it is (a Mac would select the word
  // under it): the text menu asks about what was selected, or the file.
  body.addEventListener('mousedown', (e) => {
    if (e.button !== 2 || e.shiftKey) return;
    if (/** @type {HTMLElement} */ (e.target).closest('.diff-text')) {
      e.preventDefault();
    }
  });
  body.addEventListener('contextmenu', (e) => {
    // The diff's text gets its text menu (Ask agent, Copy), Shift+right-click the browser's; a
    // thread's text keeps the browser's menu; the rest gets the tile's.
    const target = /** @type {HTMLElement} */ (e.target);
    if (target.closest('.diff-text')) {
      if (!e.shiftKey) openMenu(e, diffTextMenuItems(tile));
      return;
    }
    if (target.closest('.thread-body, textarea')) return;
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
    since: null,
    wantViewed: false,
    noRecord: false,
    review: null,
    newComment: null,
    anchor: null,
    editing: new Map(),
    head: null,
    headWait: null,
    filled: null,
    local: null,
    scrollTop: 0,
  };
  diffViews.set(tile.id, view);
  diffHoverEvents(view);
  const saved = tile.diff ? takeSavedScroll(diffScrollKey(tile.diff)) : null;
  if (Number.isFinite(saved) && saved > 0) view.scrollTop = saved;
  // Capture phase: `scroll` doesn't bubble, and the body is drawn anew on each render.
  body.addEventListener('scroll', (e) => {
    const el = /** @type {HTMLElement} */ (e.target);
    if (el.classList?.contains('diff-body') && el.clientHeight > 0) {
      view.scrollTop = el.scrollTop;
    }
  }, true);
  // After the factory returns: a title change mid-build would save a half-built layout.
  queueMicrotask(() => {
    if (diffViews.get(tile.id) !== view) return;
    setDiffTitle(view);
    if (tile.diff) tile.setActions(askButton(tile));
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
  if (diffHover.view === view) hideDiffHover();
  detachView(tile.id);
  diffViews.delete(tile.id);
  focusSeq.delete(tile.id);
  if (focusedTileId === tile.id) focusedTileId = null;
  updateSelectionMatches();
  paintDiffHighlights();
  queueMicrotask(updatePlaceholder);
}

// ---------------------------------------------------------------------------------------------
// Diff tiles' find bar (Ctrl/Cmd+F) and selection matches, painted with the CSS Custom Highlight
// API (`::highlight()` in style.css), which paints over the rows without changing them
// ---------------------------------------------------------------------------------------------

/** Past this many matches a search stops counting, so a one-letter query stays quick. */
const MAX_FIND_MATCHES = 5000;

/**
 * A diff tile's find bar, made on its first Ctrl/Cmd+F and kept (hidden when closed) so its query
 * survives a close and a redraw. `matches` are the last search's, `current` the one shown.
 *
 * @typedef {{el: HTMLElement, input: HTMLInputElement, count: HTMLElement, open: boolean,
 *   matches: Range[], current: number}} DiffFind
 */

/** @type {WeakMap<DiffView, DiffFind>} */
const diffFinds = new WeakMap();
/** The selected text's other occurrences, in the one diff tile it is in. @type {Range[]} */
let selectionMatches = [];

/** Every `.diff-text` cell in a diff tile's body, its text and where each text node starts. */
function diffTextCells(/** @type {DiffView} */ view) {
  const cells = [];
  for (const el of view.body.querySelectorAll('.diff-body .diff-text')) {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    /** @type {{node: Text, start: number}[]} */
    const nodes = [];
    let text = '';
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      nodes.push({ node: /** @type {Text} */ (n), start: text.length });
      text += n.nodeValue;
    }
    if (text) cells.push({ text, nodes });
  }
  return cells;
}

/** A Range over `[from, to)` of a cell's text. */
function cellRange(cell, from, to) {
  const at = (/** @type {number} */ i, /** @type {boolean} */ end) => {
    let k = cell.nodes.length - 1;
    while (
      k > 0 && (end ? cell.nodes[k].start >= i : cell.nodes[k].start > i)
    ) k--;
    return [cell.nodes[k].node, i - cell.nodes[k].start];
  };
  const range = document.createRange();
  range.setStart(...at(from, false));
  range.setEnd(...at(to, true));
  return range;
}

/**
 * The occurrences of `query` in a diff tile's text, within one row's cell each. `fold`: ignore
 * case; `word`: only where neither end touches another word character.
 *
 * @param {DiffView} view @param {string} query @param {{fold?: boolean, word?: boolean}} opts
 */
function diffMatches(view, query, { fold = false, word = false }) {
  /** @type {Range[]} */
  const out = [];
  if (!query) return out;
  const needle = fold ? query.toLowerCase() : query;
  const isWord = (/** @type {string | undefined} */ c) =>
    !!c && /[\p{L}\p{N}_]/u.test(c);
  for (const cell of diffTextCells(view)) {
    const hay = fold ? cell.text.toLowerCase() : cell.text;
    for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) {
      const end = i + needle.length;
      if (word && (isWord(hay[i - 1]) || isWord(hay[end]))) continue;
      out.push(cellRange(cell, i, end));
      if (out.length >= MAX_FIND_MATCHES) return out;
    }
  }
  return out;
}

/** Paints every diff tile's find matches and the selection's (a no-op without the API). */
function paintDiffHighlights() {
  if (typeof CSS === 'undefined' || !CSS.highlights) return;
  const all = [];
  const current = [];
  for (const view of diffViews.values()) {
    const find = diffFinds.get(view);
    if (!find?.open) continue;
    all.push(...find.matches);
    const at = find.matches[find.current];
    if (at) current.push(at);
  }
  CSS.highlights.set('diff-find', new Highlight(...all));
  CSS.highlights.set('diff-find-current', new Highlight(...current));
  CSS.highlights.set(
    'diff-selection-match',
    new Highlight(...selectionMatches),
  );
}

/** The find bar's `n of m` (or `No results`, or nothing before a query). */
function showFindCount(/** @type {DiffFind} */ find) {
  const n = find.matches.length;
  find.count.textContent = !find.input.value
    ? ''
    : n === 0
    ? 'No results'
    : `${find.current + 1} of ${n}${n >= MAX_FIND_MATCHES ? '+' : ''}`;
}

/**
 * Searches a diff tile again (a new query, or a redraw's new rows), keeping the current match's
 * place as near as it can. Case is ignored unless the query has a capital letter.
 */
function runDiffFind(/** @type {DiffView} */ view) {
  const find = diffFinds.get(view);
  if (!find) return;
  const query = find.open ? find.input.value : '';
  find.matches = diffMatches(view, query, {
    fold: query === query.toLowerCase(),
  });
  find.current = Math.min(
    Math.max(find.current, 0),
    Math.max(find.matches.length - 1, 0),
  );
  showFindCount(find);
  paintDiffHighlights();
}

/** Moves to the next (`step` 1) or previous (-1) match, scrolling it into the body's view. */
function stepDiffFind(
  /** @type {DiffView} */ view,
  /** @type {number} */ step,
) {
  const find = diffFinds.get(view);
  if (!find?.matches.length) return;
  const n = find.matches.length;
  find.current = (find.current + step + n) % n;
  showFindCount(find);
  paintDiffHighlights();
  const body = view.body.querySelector('.diff-body');
  const rect = find.matches[find.current].getBoundingClientRect();
  if (!body) return;
  const box = body.getBoundingClientRect();
  if (rect.top < box.top || rect.bottom > box.bottom) {
    body.scrollTop += rect.top - box.top - box.height / 2;
  }
  if (rect.left < box.left || rect.right > box.right) {
    body.scrollLeft += rect.left - box.left - box.width / 3;
  }
}

/** Opens a diff tile's find bar (making it the first time), with its query selected. */
function openDiffFind(/** @type {DiffView} */ view) {
  let find = diffFinds.get(view);
  if (!find) {
    const input = h('input', {
      type: 'search',
      class: 'diff-find-input',
      placeholder: 'Find',
      'aria-label': 'Find in diff',
      spellcheck: 'false',
    });
    const count = h('span', {
      class: 'diff-find-count',
      'aria-live': 'polite',
    });
    const button = (/** @type {string} */ label, title, run) =>
      h('button', {
        type: 'button',
        title,
        'aria-label': title,
        onclick: run,
      }, label);
    const created = /** @type {DiffFind} */ ({
      el: h(
        'div',
        { class: 'diff-find', role: 'search' },
        input,
        count,
        button(
          '↑',
          'Previous match (Shift+Enter)',
          () => stepDiffFind(view, -1),
        ),
        button('↓', 'Next match (Enter)', () => stepDiffFind(view, 1)),
        button('×', 'Close (Escape)', () => closeDiffFind(view)),
      ),
      input: /** @type {HTMLInputElement} */ (input),
      count,
      open: false,
      matches: [],
      current: 0,
    });
    find = created;
    input.addEventListener('input', () => {
      created.current = 0;
      runDiffFind(view);
      if (created.matches.length) stepDiffFind(view, 0);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        stepDiffFind(view, e.shiftKey ? -1 : 1);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        closeDiffFind(view);
      }
    });
    diffFinds.set(view, find);
  }
  // A selection on one line seeds the query, as the file viewer's search does.
  const picked = pageSelection(view.tile);
  if (picked && !picked.includes('\n')) find.input.value = picked;
  find.open = true;
  find.el.hidden = false;
  if (!find.el.isConnected) {
    view.body.querySelector('.diff-header')?.after(find.el);
  }
  runDiffFind(view);
  find.input.focus();
  find.input.select();
}

/** Closes a diff tile's find bar, its matches unpainted, and gives the tile the keyboard back. */
function closeDiffFind(/** @type {DiffView} */ view) {
  const find = diffFinds.get(view);
  if (!find?.open) return;
  find.open = false;
  find.el.hidden = true;
  find.matches = [];
  paintDiffHighlights();
  view.tile.focus();
}

/**
 * The selected text's other occurrences in its diff tile: one line of it, matched with its case,
 * and as a whole word when it is one (as the file viewer's `highlightSelectionMatches`).
 */
function updateSelectionMatches() {
  const sel = document.getSelection();
  let found = /** @type {Range[]} */ ([]);
  if (sel && sel.rangeCount && !sel.isCollapsed) {
    const range = sel.getRangeAt(0);
    const start = range.startContainer.parentElement?.closest('.diff-text');
    const end = range.endContainer.parentElement?.closest('.diff-text');
    const text = sel.toString();
    const view = start && start === end
      ? [...diffViews.values()].find((v) => v.body.contains(start))
      : undefined;
    if (view && text.trim() && !text.includes('\n') && text.length <= 200) {
      // A whole word (a double-click's) matches only whole words; part of one, anywhere.
      const outside = (/** @type {Node} */ node, /** @type {number} */ i) =>
        node.nodeType === Node.TEXT_NODE ? node.nodeValue?.[i] : undefined;
      const word = /^[\p{L}\p{N}_]+$/u.test(text) &&
        ![
          outside(range.startContainer, range.startOffset - 1),
          outside(range.endContainer, range.endOffset),
        ].some((c) => c && /[\p{L}\p{N}_]/u.test(c));
      found = diffMatches(view, text, { word });
    }
  }
  if (found.length < 2) found = [];
  if (!found.length && !selectionMatches.length) return;
  selectionMatches = found;
  paintDiffHighlights();
}

let selectionFrame = 0;
document.addEventListener('selectionchange', () => {
  cancelAnimationFrame(selectionFrame);
  selectionFrame = requestAnimationFrame(updateSelectionMatches);
});

// Ctrl/Cmd+F in a diff tile opens its find bar in place of the browser's find; in the capture
// phase, as the file tiles' Ctrl/Cmd+S. Ctrl/Cmd+G (Shift for back) and F3 step through matches.
document.addEventListener('keydown', (e) => {
  const view = diffViews.get(focusedTileId ?? '');
  if (!view || e.altKey) return;
  const target = /** @type {HTMLElement} */ (e.target);
  // Keys aimed at another tile, or at the sidebar's fields, are not the diff tile's.
  if (
    target instanceof HTMLElement && target !== document.body &&
    !view.tile.element.contains(target) && !target.contains(view.tile.element)
  ) return;
  const mod = IS_MAC ? e.metaKey : e.ctrlKey;
  const key = e.key.toLowerCase();
  if (mod && key === 'f' && !e.shiftKey) {
    e.preventDefault();
    e.stopPropagation();
    openDiffFind(view);
  } else if ((mod && key === 'g') || e.key === 'F3') {
    if (!diffFinds.get(view)?.open) return;
    e.preventDefault();
    e.stopPropagation();
    stepDiffFind(view, e.shiftKey ? -1 : 1);
  }
}, true);

// ---------------------------------------------------------------------------------------------
// Diff tiles' language server: hover and Ctrl/Cmd+click go to definition on the new side
// (added and context rows), from the PR head's text (`lsp.js`'s views). See
// `.plans/devc-web-lsp-diff-hover.md`.
// ---------------------------------------------------------------------------------------------

/** How long the mouse rests on a row's text before its hover is asked for: CodeMirror's. */
const DIFF_HOVER_MS = 300;

/** New-side text cells (added and context rows), to their rows. @type {WeakMap<Element, import('./lib/diff.js').DiffRow>} */
const newSideRows = new WeakMap();

/**
 * The hover shown or on its way: its tile, its element, and where the mouse was. `seq` numbers
 * the attempts, so only the latest one's answer lands.
 *
 * @type {{view: DiffView | null, el: HTMLElement | null, x: number, y: number, timer: number,
 *   seq: number}}
 */
const diffHover = { view: null, el: null, x: 0, y: 0, timer: 0, seq: 0 };

/**
 * Marks a row's text cell as new-side when the row is in the PR head (added or context), for
 * hover and go to definition.
 *
 * @param {HTMLElement} el @param {import('./lib/diff.js').DiffRow} row
 */
function markNewSide(el, row) {
  if ((row.kind === 'add' || row.kind === 'context') && row.new !== null) {
    el.dataset.new = String(row.new);
    newSideRows.set(el, row);
  }
  return el;
}

/** A unified (or added file's) row's text cell. @param {import('./lib/diff.js').DiffRow} row */
function newSideText(row, /** @type {(string | Node)[]} */ ...children) {
  return markNewSide(h('span', { class: 'diff-text' }, ...children), row);
}

/**
 * The LSP position under the mouse at (`x`, `y`) in a new-side cell, or null: its row's new line
 * and the character's UTF-16 offset in the row's text (`newColumn` undoes `markedText`'s
 * markers). Past the end of a line's text is nothing.
 *
 * @param {number} x @param {number} y
 * @returns {{line: number, character: number} | null}
 */
function diffPositionAt(x, y) {
  const d = /** @type {any} */ (document);
  let node;
  let offset;
  if (d.caretPositionFromPoint) {
    const p = d.caretPositionFromPoint(x, y);
    if (!p) return null;
    node = p.offsetNode;
    offset = p.offset;
  } else if (d.caretRangeFromPoint) {
    const r = d.caretRangeFromPoint(x, y);
    if (!r) return null;
    node = r.startContainer;
    offset = r.startOffset;
  } else return null;
  const at = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  const el = at?.closest?.('.diff-text[data-new]');
  const row = el ? newSideRows.get(el) : undefined;
  if (!el || !row || row.new === null) return null;
  const all = document.createRange();
  all.selectNodeContents(el);
  const over = [...all.getClientRects()].some((r) =>
    x >= r.left && x <= r.right && y >= r.top && y <= r.bottom
  );
  if (!over) return null;
  const before = document.createRange();
  before.setStart(el, 0);
  before.setEnd(node, offset);
  return {
    line: row.new - 1,
    character: newColumn(row.text, before.toString().length),
  };
}

/**
 * The PR head's text (`pr_file_at`), read once per head sha and shared by hover and **Whole
 * file**: `view.head.done` is set when it arrives. `null` before `pr_diff` has answered.
 *
 * @param {DiffView} view
 * @returns {Promise<{text: string | null, message: string}> | null}
 */
function readHead(view) {
  const ref = view.tile.diff;
  const sha = view.data?.pr?.headSha;
  if (!ref || typeof sha !== 'string') return null;
  if (view.head?.sha !== sha) {
    const path = view.data?.file?.path ?? ref.path;
    const head = {
      sha,
      done: /** @type {{text: string | null, message: string} | null} */ (null),
      got: call({
        type: 'pr_file_at',
        localFolder: ref.localFolder,
        root: ref.root,
        path,
        sha,
      }).then(
        (r) =>
          r?.available === true && typeof r.text === 'string'
            ? { text: r.text, message: '' }
            : { text: null, message: String(r?.message ?? 'unavailable') },
        (e) => ({ text: null, message: String(e?.message ?? e) }),
      ).then((r) => (head.done = r)),
    };
    view.head = head;
  }
  return view.head.got;
}

/**
 * Puts a diff tile on its file's session (`attachView`: once, a repeat resolves as the first
 * did), or null when it has none to be on: no server for the file, its container not connected.
 *
 * @param {DiffView} view
 */
function attachDiffLanguage(view) {
  const ref = view.tile.diff;
  const c = ref ? containerByFolder(ref.localFolder) : null;
  if (!ref || !c || c.state !== 'connected' || !lspLanguageFor(ref.path)) {
    return null;
  }
  return attachView(view.tile.id, {
    localFolder: ref.localFolder,
    root: ref.root,
    path: ref.path,
  }, c);
}

/**
 * Starts a diff tile's language server once its diff has loaded and its container is connected,
 * as a file tile's starts when it opens, so the first hover finds it ready (or nearly). Again
 * only after it stopped wanting one: each sync would otherwise ask anew for a file no server
 * takes.
 *
 * @param {DiffView} view
 */
function syncDiffLanguage(view) {
  const ref = view.tile.diff;
  const c = ref ? containerByFolder(ref.localFolder) : null;
  const wanted = Boolean(
    ref && view.state === 'ok' && c?.state === 'connected' &&
      lspLanguageFor(ref.path),
  );
  const was = view.lspWanted;
  view.lspWanted = wanted;
  if (wanted && !was) void attachDiffLanguage(view);
}

/**
 * Gets a diff tile's file ready for a request on its session: attached, the server ready, and
 * the PR head's text open as its view. While an open tile holds the file with other text, the
 * server keeps that text and `map` turns a PR head line into its line there (null: the line
 * differs). `message` says why not, or is '' when nothing should be shown (no server for the
 * file, its container not connected).
 *
 * @param {DiffView} view
 * @returns {Promise<{ok: true, map?: (line: number) => number | null} |
 *   {ok: false, message: string}>}
 */
async function diffLspReady(view) {
  const attaching = attachDiffLanguage(view);
  if (!attaching) return { ok: false, message: '' };
  const key = view.tile.id;
  const at = await attaching;
  if (!at.ok) return { ok: false, message: at.error };
  const st = viewStatus(key);
  if (!st) return { ok: false, message: '' };
  if (st.state === 'exited') {
    return {
      ok: false,
      message: `${st.name} language server stopped${
        st.detail ? `: ${st.detail}` : ''
      }`,
    };
  }
  if (st.state === 'starting') {
    return {
      ok: false,
      message: st.detail ? `${st.name}: ${st.detail}` : `${st.name}: starting…`,
    };
  }
  const got = readHead(view);
  if (!got) return { ok: false, message: '' };
  const head = await got;
  if (head.text === null) {
    return { ok: false, message: `No hover: ${head.message}` };
  }
  const opened = await openView(key, head.text);
  if (opened.ok) {
    view.local = null;
    return { ok: true };
  }
  if (opened.reason === 'edited' && typeof opened.text === 'string') {
    if (view.local?.head !== head.text || view.local.text !== opened.text) {
      view.local = {
        head: head.text,
        text: opened.text,
        map: lineMap(head.text, opened.text),
      };
    }
    return { ok: true, map: view.local.map };
  }
  return { ok: false, message: '' };
}

/**
 * `pos` (a PR head position) as the server has the file: through `map` when an open tile holds
 * other text. Null when its line differs there.
 *
 * @param {{line: number, character: number}} pos
 * @param {((line: number) => number | null) | undefined} map
 */
function serverPosition(pos, map) {
  if (!map) return pos;
  const line = map(pos.line);
  return line === null ? null : { line, character: pos.character };
}

/** What a hover (or a jump, `No definition`) says on a line the open tile has changed. */
const LINE_DIFFERS = 'this line differs in the file open in a tile.';

/** Hides the diff hover (and forgets one on its way). */
function hideDiffHover() {
  clearTimeout(diffHover.timer);
  diffHover.seq++;
  diffHover.el?.remove();
  diffHover.el = null;
  diffHover.view = null;
}

/**
 * Shows a diff hover at (`x`, `y`): sanitized HTML, or a plain message. Below the line, or above
 * it when there is no room below.
 *
 * @param {DiffView} view @param {number} x @param {number} y
 * @param {{html?: string, message?: string}} what
 */
function showDiffHover(view, x, y, what) {
  diffHover.el?.remove();
  const el = h('div', { class: 'diff-hover' });
  if (what.html) {
    el.classList.add('cm-lsp-documentation');
    el.innerHTML = what.html;
  } else {
    el.classList.add('diff-hover-note');
    el.textContent = what.message ?? '';
  }
  el.addEventListener('mouseleave', (e) => {
    const to = /** @type {Node | null} */ (e.relatedTarget);
    if (!to || !view.body.contains(to)) hideDiffHover();
  });
  document.body.append(el);
  const lineHeight = 20;
  const below = window.innerHeight - (y + lineHeight);
  el.style.left = `${
    Math.max(4, Math.min(x - 8, window.innerWidth - el.offsetWidth - 4))
  }px`;
  if (below >= Math.min(el.offsetHeight, 160) || below >= y) {
    el.style.top = `${y + lineHeight / 2 + 4}px`;
  } else {
    el.style.bottom = `${window.innerHeight - y + lineHeight / 2 + 4}px`;
  }
  diffHover.el = el;
  diffHover.view = view;
}

/**
 * The hover for the position under (`x`, `y`) in a diff tile, after the rest.
 *
 * @param {DiffView} view @param {number} x @param {number} y
 */
async function diffHoverAt(view, x, y) {
  const pos = diffPositionAt(x, y);
  if (!pos) return;
  const seq = ++diffHover.seq;
  const ready = await diffLspReady(view);
  if (seq !== diffHover.seq || !diffViews.has(view.tile.id)) return;
  if (!ready.ok) {
    if (ready.message) showDiffHover(view, x, y, { message: ready.message });
    return;
  }
  const at = serverPosition(pos, ready.map);
  if (!at) {
    showDiffHover(view, x, y, { message: `No hover: ${LINE_DIFFERS}` });
    return;
  }
  let result;
  try {
    result = await viewRequest(view.tile.id, 'textDocument/hover', at);
  } catch {
    return; // a timeout or a restart: nothing to show
  }
  if (seq !== diffHover.seq || !diffViews.has(view.tile.id)) return;
  const html = lspHoverHtml(
    /** @type {any} */ (result)?.contents,
    view.tile.diff?.path,
  );
  if (html) showDiffHover(view, x, y, { html });
}

/**
 * Ctrl/Cmd+click: the definition of what is under the mouse, opened in a file tile.
 *
 * @param {DiffView} view @param {number} x @param {number} y
 */
async function diffDefinitionAt(view, x, y) {
  const pos = diffPositionAt(x, y);
  if (!pos) return;
  hideDiffHover();
  // Not tied to the hover's `seq`: moving the mouse on after the click must not drop the jump.
  const ready = await diffLspReady(view);
  if (!diffViews.has(view.tile.id)) return;
  if (!ready.ok) {
    if (ready.message) showDiffHover(view, x, y, { message: ready.message });
    return;
  }
  const at = serverPosition(pos, ready.map);
  if (!at) {
    showDiffHover(view, x, y, {
      message: `No definition: ${LINE_DIFFERS}`,
    });
    return;
  }
  let result;
  try {
    result = await viewRequest(view.tile.id, 'textDocument/definition', at);
  } catch {
    return;
  }
  if (!diffViews.has(view.tile.id)) return;
  const loc = Array.isArray(result) ? result[0] : result;
  if (loc && typeof loc.uri === 'string') {
    await showViewLocation(view.tile.id, loc);
  }
}

/** A diff tile's hover and go to definition events, on its (lasting) element. */
function diffHoverEvents(/** @type {DiffView} */ view) {
  const el = view.body;
  el.addEventListener('mousemove', (e) => {
    el.classList.toggle('lsp-jump', e.ctrlKey || e.metaKey);
    if (
      diffHover.el && diffHover.view === view &&
      Math.hypot(e.clientX - diffHover.x, e.clientY - diffHover.y) <= 10
    ) return;
    hideDiffHover();
    const target = /** @type {HTMLElement} */ (e.target);
    if (!target.closest?.('.diff-text[data-new]')) return;
    diffHover.x = e.clientX;
    diffHover.y = e.clientY;
    diffHover.view = view;
    diffHover.timer = setTimeout(
      () => void diffHoverAt(view, diffHover.x, diffHover.y),
      DIFF_HOVER_MS,
    );
  });
  el.addEventListener('mouseleave', (e) => {
    el.classList.remove('lsp-jump');
    const to = /** @type {Node | null} */ (e.relatedTarget);
    if (!to || !diffHover.el?.contains(to)) hideDiffHover();
  });
  el.addEventListener('scroll', () => {
    if (diffHover.view === view) hideDiffHover();
  }, true);
  el.addEventListener('click', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.button !== 0) return;
    const target = /** @type {HTMLElement} */ (e.target);
    if (!target.closest?.('.diff-text[data-new]')) return;
    e.preventDefault();
    void diffDefinitionAt(view, e.clientX, e.clientY);
  });
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && diffHover.el) hideDiffHover();
  if (e.key === 'Control' || e.key === 'Meta') {
    diffHover.view?.body.classList.add('lsp-jump');
  }
});
document.addEventListener('keyup', (e) => {
  if (e.key === 'Control' || e.key === 'Meta') {
    for (const v of diffViews.values()) v.body.classList.remove('lsp-jump');
  }
});

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
  if (view.wantViewed) {
    view.wantViewed = false;
    applyViewedCompare(view);
  } else if (view.since) void loadSince(view, view.since.sha);
  renderDiff(view);
  syncDiffLanguage(view);
  void loadThreads(view);
  void loadPending(view);
}

/** The viewer's pending review (`pr_pending_show`), when the grants offer reviews. */
async function loadPending(view) {
  const ref = view.tile.diff;
  if (!ref || !view.data?.canReview) {
    view.review = null;
    return;
  }
  let review = view.review;
  try {
    const r = await call({
      type: 'pr_pending_show',
      localFolder: ref.localFolder,
      root: ref.root,
    });
    if (r?.available === true) review = r.review ?? null;
  } catch { /* keep what is shown */ }
  if (diffViews.get(view.tile.id) !== view) return;
  view.review = review;
  renderDiff(view);
}

/**
 * After a pending review changed: this repo's diff tiles list their threads and the review
 * again. Resolves when they are all shown.
 *
 * @param {DiffRef} ref
 * @returns {Promise<unknown>}
 */
function reviewChanged(ref) {
  const loads = [];
  for (const v of diffViews.values()) {
    const d = v.tile.diff;
    if (!d || d.localFolder !== ref.localFolder || d.root !== ref.root) {
      continue;
    }
    loads.push(loadThreads(v), loadPending(v));
  }
  return Promise.all(loads);
}

/**
 * The **Compare** choices besides `PR changes`: each head the file was marked Viewed at in devc
 * web that is not the PR's head now, newest first, once each.
 *
 * @param {DiffView} view
 * @returns {{headSha: string, path: string, at: string}[]}
 */
function sinceOptions(view) {
  const head = view.data?.pr?.headSha;
  /** @type {Map<string, {headSha: string, path: string, at: string}>} */
  const out = new Map();
  for (const m of list(view.data?.viewedHistory)) {
    if (
      m?.viewed !== 'VIEWED' || typeof m.headSha !== 'string' ||
      m.headSha === head || out.has(m.headSha)
    ) continue;
    out.set(m.headSha, { headSha: m.headSha, path: m.path, at: m.at });
  }
  return [...out.values()];
}

/** Selects the newest Since viewed choice, or notes there is none. @param {DiffView} view */
function applyViewedCompare(view) {
  const newest = sinceOptions(view)[0];
  view.noRecord = !newest;
  if (newest) void loadSince(view, newest.headSha);
  else renderDiff(view);
}

/**
 * Shows the file since it was viewed at `sha` (or, with `null`, the PR's changes again): the
 * file at `sha` and at the PR's head, read with `pr_file_at` and diffed here.
 *
 * @param {DiffView} view @param {string | null} sha
 */
async function loadSince(view, sha) {
  const ref = view.tile.diff;
  view.noRecord = false;
  view.newComment = null;
  view.anchor = null;
  view.openFolds.clear();
  const option = sinceOptions(view).find((o) => o.headSha === sha);
  if (!ref || !option) {
    view.since = null;
    renderDiff(view);
    return;
  }
  const since = {
    sha,
    state: 'loading',
    parsed: null,
    message: '',
    texts: null,
    whole: null,
  };
  view.since = /** @type {SinceView} */ (since);
  renderDiff(view);
  const repo = { localFolder: ref.localFolder, root: ref.root };
  const read = (path, at) =>
    call({ type: 'pr_file_at', ...repo, path, sha: at }).then(
      (r) => r,
      (e) => ({ available: false, message: String(e?.message ?? e) }),
    );
  const [before, now] = await Promise.all([
    read(option.path, sha),
    read(view.data.file.path, view.data.pr.headSha),
  ]);
  if (view.since !== since || diffViews.get(view.tile.id) !== view) return;
  const failed = [before, now].find((r) => r?.available !== true);
  if (failed) {
    since.state = 'error';
    since.message = String(failed?.message ?? 'failed');
  } else {
    const texts = /** @type {[string, string]} */ ([
      String(before.text),
      String(now.text),
    ]);
    const parsed = diffTexts(...texts);
    since.texts = texts;
    since.state = parsed ? 'ok' : 'error';
    since.parsed = parsed;
    since.message = parsed ? '' : LABELS.tooLargeToCompare;
  }
  renderDiff(view);
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

/** ⟳: the file, then its threads, again. A reply or comment with text in it stays. */
function refreshDiff(view) {
  for (const [id, c] of view.composers) {
    if (c.textarea.value.trim() === '' && !c.sending) view.composers.delete(id);
  }
  const n = view.newComment;
  if (n && n.textarea.value.trim() === '' && !n.sending) view.newComment = null;
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

function togglePlainOneSided() {
  plainOneSided = !plainOneSided;
  saveFlag(PLAIN_ONE_SIDED_KEY, plainOneSided);
  for (const view of diffViews.values()) renderDiff(view);
}

function toggleWholeFile() {
  wholeFile = !wholeFile;
  saveFlag(WHOLE_FILE_KEY, wholeFile);
  for (const view of diffViews.values()) {
    // Row keys change with the rows: folds opened under the old ones would land elsewhere.
    view.openFolds.clear();
    renderDiff(view);
  }
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
  const { parsed: source, whole } = wholeSource(view);
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
  // The whole file is highlighted as one text a side; a patch's hunks one by one.
  const groups = whole
    ? [parsed.hunks.flatMap((hunk) => hunk.rows)]
    : parsed.hunks.map((hunk) => hunk.rows);
  for (const rows of groups) {
    const olds = rows.filter((r) => r.kind === 'context' || r.kind === 'del');
    const news = rows.filter((r) => r.kind === 'context' || r.kind === 'add');
    // A context row's text is the new side's (after Hide whitespace the sides can differ).
    highlightLines(oldName, olds.map((r) => r.text)).forEach((line, i) => {
      if (olds[i].kind === 'del') spans.set(olds[i], line);
    });
    highlightLines(newName, news.map((r) => r.text)).forEach((line, i) => {
      spans.set(news[i], line);
    });
  }
  for (const hunk of parsed.hunks) {
    for (const [i, ranges] of changedRanges(hunk)) {
      const row = hunk.rows[i];
      const line = spans.get(row);
      if (line) spans.set(row, markRanges(line, ranges));
    }
  }
  view.shown = { source, whitespace: hideWhitespace, whole, parsed, spans };
  return view.shown;
}

/**
 * Whether the tile offers **Whole file**: not an added or removed file (it shows the whole file
 * already), and a patch or a Since viewed comparison to fill.
 *
 * @param {DiffView} view
 */
function offersWholeFile(view) {
  return !oneSided(view) &&
    (view.since !== null || typeof view.data?.file?.patch === 'string');
}

/**
 * The patch to draw, before **Hide whitespace**: with **Whole file** on, filled out to every line
 * (`whole`), else as read. `note` says why the whole file isn't shown when it was asked for. A
 * PR changes tile starts reading the head here, and draws again when it arrives.
 *
 * @param {DiffView} view
 * @returns {{parsed: import('./lib/diff.js').ParsedPatch | null, whole: boolean, note: string}}
 */
function wholeSource(view) {
  const since = view.since;
  const parsed = since ? since.parsed : view.parsed;
  if (!wholeFile || !parsed || !offersWholeFile(view)) {
    return { parsed, whole: false, note: '' };
  }
  if (since) {
    if (!since.texts) return { parsed, whole: false, note: '' };
    since.whole ??= diffTexts(...since.texts, MAX_DIFF_LINES);
    return since.whole ? { parsed: since.whole, whole: true, note: '' } : {
      parsed,
      whole: false,
      note: LABELS.wholeFileTooLarge(MAX_DIFF_LINES),
    };
  }
  const got = readHead(view);
  const head = view.head;
  if (!got || !head) return { parsed, whole: false, note: '' };
  if (!head.done) {
    if (view.headWait !== head) {
      view.headWait = head;
      void got.then(() => {
        if (diffViews.get(view.tile.id) === view && view.head === head) {
          renderDiff(view);
        }
      });
    }
    return { parsed, whole: false, note: LABELS.wholeFileLoading };
  }
  const text = head.done.text;
  if (text === null) {
    return {
      parsed,
      whole: false,
      note: LABELS.wholeFileUnavailable(head.done.message),
    };
  }
  if (view.filled?.parsed !== parsed || view.filled.text !== text) {
    view.filled = {
      parsed,
      text,
      out: text.split('\n').length - (text.endsWith('\n') ? 1 : 0) >
          MAX_DIFF_LINES
        ? 'large'
        : fillPatch(parsed, text),
    };
  }
  const out = view.filled.out;
  if (out === 'large') {
    return {
      parsed,
      whole: false,
      note: LABELS.wholeFileTooLarge(MAX_DIFF_LINES),
    };
  }
  return out ? { parsed: out, whole: true, note: '' } : {
    parsed,
    whole: false,
    note: LABELS.wholeFileUnavailable(LABELS.wholeFileMismatch),
  };
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

/**
 * The one side an added or removed file has: its rows and numbers, in either layout. A Since
 * viewed comparison has both.
 *
 * @param {DiffView} view
 * @returns {'old' | 'new' | null}
 */
function oneSided(view) {
  const status = view.since ? null : view.data?.file?.status;
  return status === 'added' ? 'new' : status === 'removed' ? 'old' : null;
}

/** Draws a diff tile from its view: the header, then File threads and the hunks. */
function renderDiff(view) {
  const active = /** @type {HTMLElement | null} */ (document.activeElement);
  const caret =
    active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement
      ? [active.selectionStart, active.selectionEnd]
      : null;
  const body = h('div', { class: 'diff-body' });
  const find = diffFinds.get(view);
  view.body.replaceChildren(diffHeader(view), ...(find ? [find.el] : []), body);
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
  // Hidden, it stays at the top: shown again, the tab scrolls back (`tileVisibility`).
  body.scrollTop = view.scrollTop;
  if (active && active.isConnected && active !== document.activeElement) {
    active.focus({ preventScroll: true });
    if (
      caret && caret[0] !== null &&
      (active instanceof HTMLTextAreaElement ||
        active instanceof HTMLInputElement)
    ) {
      active.setSelectionRange(caret[0], caret[1]);
    }
  }
  // The new rows' matches: the find bar's, and the selection's (gone with the old rows).
  if (find?.open) runDiffFind(view);
  updateSelectionMatches();
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
  const options = data ? sinceOptions(view) : [];
  if (file?.viewed === 'DISMISSED' && options.length && !view.since) {
    line.append(h(
      'span',
      { class: 'diff-note' },
      LABELS.changedSinceViewed,
      ' ',
      h('button', {
        type: 'button',
        onclick: () => void loadSince(view, options[0].headSha),
      }, LABELS.showChanges),
    ));
  }
  if (view.noRecord) {
    line.append(h('span', { class: 'diff-note' }, LABELS.noViewedRecord));
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
  /** Compare: the PR's patch, or the file since one of the heads it was viewed at. */
  const compare = () => {
    const now = Date.now();
    const select = /** @type {HTMLSelectElement} */ (h(
      'select',
      {
        class: 'diff-compare',
        'aria-label': LABELS.compare,
        title: LABELS.compare,
        onchange: (e) => {
          const v = /** @type {HTMLSelectElement} */ (e.target).value;
          void loadSince(view, v === '' ? null : v);
        },
      },
      h('option', { value: '' }, LABELS.prChanges),
      ...options.map((o) =>
        h(
          'option',
          { value: o.headSha },
          LABELS.sinceViewed(
            sessionAge(String(o.at), now),
            o.headSha.slice(0, 7),
          ),
        )
      ),
    ));
    select.value = view.since?.sha ?? '';
    return select;
  };
  const review = view.review;
  const tools = h(
    'div',
    { class: 'diff-tools' },
    options.length ? compare() : '',
    h(
      'span',
      { class: 'diff-layout', role: 'group', 'aria-label': 'Diff layout' },
      layoutButton('Unified', false),
      layoutButton('Split', true),
    ),
    offersWholeFile(view)
      ? checkbox(LABELS.wholeFile, wholeFile, toggleWholeFile)
      : '',
    checkbox('Hide whitespace', hideWhitespace, toggleHideWhitespace),
    oneSided(view)
      ? checkbox('Tint rows', !plainOneSided, togglePlainOneSided)
      : '',
    checkbox('Show resolved', showResolved, toggleShowResolved),
    h('span', { class: 'diff-head-fill' }),
    review && pr && ref
      ? h(
        'span',
        { class: 'pr-pending' },
        LABELS.reviewPending(review.comments),
        h('button', {
          type: 'button',
          onclick: async () => {
            const repo = { localFolder: ref.localFolder, root: ref.root };
            if (await submitPendingReview(repo, pr.url)) reviewChanged(ref);
          },
        }, LABELS.submitReview),
        h('button', {
          type: 'button',
          onclick: async () => {
            const repo = { localFolder: ref.localFolder, root: ref.root };
            if (await discardPendingReview(repo)) reviewChanged(ref);
          },
        }, LABELS.discardReview),
      )
      : '',
    data
      ? h(
        'span',
        {
          class: 'diff-via',
          'aria-busy': String(view.threadsLoading),
          title: view.threadsLoading ? 'Loading threads…' : undefined,
        },
        // Always there, hidden when idle: loading threads moves nothing.
        h('span', { class: 'spinner', 'aria-hidden': 'true' }),
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
      'data-hot': ks.some((k) => hotKeys.has(k)) || undefined,
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
  const since = view.since;
  if (since && since.state !== 'ok') {
    out.push(h(
      'div',
      { class: 'diff-message' },
      since.state === 'loading'
        ? h('div', {}, 'Loading…')
        : h('div', {}, ...markedText(since.message)),
      since.state === 'error'
        ? h('button', {
          type: 'button',
          onclick: () => void loadSince(view, null),
        }, LABELS.prChanges)
        : '',
    ));
    return out;
  }
  if (since && shown?.parsed.hunks.length === 0) {
    out.push(h(
      'div',
      { class: 'diff-message' },
      h('div', {}, LABELS.noChangesSinceViewed),
    ));
    return out;
  }
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
  const { note } = wholeSource(view);
  if (note) {
    out.push(
      h('div', { class: 'diff-message diff-note' }, ...markedText(note)),
    );
  }
  const single = oneSided(view);
  // `+` on a line number: a new comment, on the PR's own diff only (GitHub takes comments on
  // lines in it, not on a Since viewed comparison).
  const commenting = !since && view.data?.canReview === true;
  const nc = view.newComment;
  /** The rows the open new comment is on: marked hot while it is open. */
  const hotKeys = new Set(
    nc
      ? threadRows(shown.parsed, {
        line: nc.line,
        startLine: nc.startLine,
        diffSide: nc.side,
      })
      : [],
  );
  const lastHot = [...hotKeys].pop();
  /**
   * A line number cell, with its `+` when commenting: `side` and `n` are what it comments on.
   *
   * @param {number | null | undefined} n @param {'LEFT' | 'RIGHT'} side @param {number} hi
   * @param {string} [kind] @param {boolean} [filled]  a **Whole file** row not in the patch,
   *   where GitHub takes no comment
   */
  const numCell = (n, side, hi, kind, filled = false) => {
    const cell = h(
      'span',
      { class: 'diff-num', ...(kind ? { 'data-kind': kind } : {}) },
      n == null ? '' : String(n),
    );
    if (commenting && n != null && !filled) {
      cell.append(h('button', {
        type: 'button',
        class: 'diff-add-comment',
        title: LABELS.commentOnLine(n),
        'aria-label': LABELS.commentOnLine(n),
        onclick: (e) => openNewComment(view, side, n, hi, e.shiftKey),
      }, '+'));
    }
    return cell;
  };
  const table = h('div', {
    class: 'diff-table',
    'data-layout': single ? 'single' : diffSplit ? 'split' : 'unified',
    'data-plain': (single && plainOneSided) || undefined,
  });
  /** @param {string} key */
  const threadsAt = (key) => {
    const here = placed.rows.get(key);
    if (here) {
      table.append(
        h('div', { class: 'diff-threads' }, ...threadGroup(view, key, here)),
      );
    }
    if (nc && key === lastHot) {
      table.append(h('div', { class: 'diff-threads' }, newCommentEl(nc)));
      ncShown = true;
    }
  };
  let ncShown = false;
  shown.parsed.hunks.forEach((hunk, hi) => {
    // The whole file runs on with no bars: there are no gaps to mark.
    if (!shown.whole) {
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
    }
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
            numCell(row[single], single === 'old' ? 'LEFT' : 'RIGHT', hi),
            single === 'new'
              ? newSideText(row, ...rowText(shown, row))
              : h('span', { class: 'diff-text' }, ...rowText(shown, row)),
          ),
        );
        threadsAt(`${hi}:${ri}`);
      });
      return;
    }
    if (diffSplit) {
      for (const sr of splitRows(hunk)) {
        /** @param {import('./lib/diff.js').DiffRow | null} row @param {boolean} [right] */
        const side = (row, right = false) => {
          const el = h(
            'span',
            { class: 'diff-text', 'data-kind': row?.kind ?? 'empty' },
            ...(row ? rowText(shown, row) : []),
          );
          return right && row ? markNewSide(el, row) : el;
        };
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
            numCell(
              sr.left?.old,
              'LEFT',
              hi,
              sr.left?.kind ?? 'empty',
              sr.left?.filled,
            ),
            side(sr.left),
            numCell(
              sr.right?.new,
              'RIGHT',
              hi,
              sr.right?.kind ?? 'empty',
              sr.right?.filled,
            ),
            side(sr.right, true),
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
          numCell(row.old, 'LEFT', hi, undefined, row.filled),
          numCell(row.new, 'RIGHT', hi, undefined, row.filled),
          newSideText(row, ...rowText(shown, row)),
        ),
      );
      threadsAt(`${hi}:${ri}`);
    });
  });
  // Its lines gone from the diff (a refresh): the comment stays, above it, for its text.
  if (nc && !ncShown) {
    out.push(h('div', { class: 'diff-threads' }, newCommentEl(nc)));
  }
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

/**
 * Where a thread is, for its card: `File comment`, its line or block, or on an outdated thread
 * where it was (`Was line n`). Null when none of these is known.
 */
function threadPlace(thread) {
  if (thread.subjectType === 'FILE') return LABELS.fileComment;
  if (thread.line !== null && thread.line !== undefined) {
    return typeof thread.startLine === 'number'
      ? LABELS.lines(thread.startLine, thread.line)
      : LABELS.line(thread.line);
  }
  if (typeof thread.originalLine === 'number') {
    return typeof thread.originalStartLine === 'number'
      ? LABELS.wasLines(thread.originalStartLine, thread.originalLine)
      : LABELS.wasLine(thread.originalLine);
  }
  return null;
}

/** The last rows of an outdated thread's hunk: the code it was written against. */
const HUNK_ROWS = 4;

/** An outdated thread's hunk, its last rows highlighted as the tile's are, read-only. */
function threadHunk(view, thread) {
  if (typeof thread.diffHunk !== 'string' || thread.diffHunk === '') return '';
  const rows = parsePatch(thread.diffHunk).hunks.flatMap((hk) => hk.rows)
    .filter((r) => r.kind !== 'note').slice(-HUNK_ROWS);
  if (rows.length === 0) return '';
  const path = view.data?.file?.path ?? view.tile.diff?.path ?? '';
  /** @type {import('./lib/diff.js').Span[][]} */
  const spans = highlightLines(path, rows.map((r) => r.text));
  return h(
    'div',
    { class: 'thread-hunk' },
    ...rows.map((r, i) =>
      h(
        'div',
        { class: 'diff-row', 'data-kind': r.kind },
        h('span', { class: 'diff-num' }, r.old === null ? '' : String(r.old)),
        h('span', { class: 'diff-num' }, r.new === null ? '' : String(r.new)),
        h(
          'span',
          { class: 'diff-text' },
          ...spans[i].flatMap((sp) =>
            sp.cls
              ? [h('span', { class: sp.cls }, ...markedText(sp.text))]
              : markedText(sp.text)
          ),
        ),
      )
    ),
  );
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
  const place = threadPlace(thread);
  if (place !== null) {
    card.append(h(
      'div',
      {
        class: 'thread-where',
        'data-block': typeof thread.startLine === 'number' || undefined,
      },
      place,
    ));
  }
  if (
    thread.line === null && thread.subjectType !== 'FILE' &&
    typeof thread.originalLine === 'number'
  ) card.append(threadHunk(view, thread));
  const canReview = view.data?.canReview === true;
  for (const c of list(thread.comments)) {
    const pending = c.pending === true;
    const edit = pending ? view.editing.get(c.id) : undefined;
    card.append(
      h(
        'div',
        { class: 'thread-comment', 'data-pending': pending || undefined },
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
            ? h('span', { class: 'thread-tag' }, LABELS.outdated)
            : '',
          pending ? h('span', { class: 'thread-tag' }, LABELS.pending) : '',
          pending && canReview && c.id && !edit
            ? h(
              'span',
              { class: 'thread-comment-actions' },
              h('button', {
                type: 'button',
                onclick: () => openEdit(view, c),
              }, LABELS.edit),
              h('button', {
                type: 'button',
                onclick: () => void deletePending(view, c),
              }, LABELS.deleteComment),
            )
            : '',
        ),
        edit
          ? edit.el
          : h('div', { class: 'thread-body' }, ...markedText(c.body)),
      ),
    );
  }
  const actions = h('div', { class: 'thread-actions' });
  const composer = view.composers.get(thread.id);
  if ((view.data?.canReply || canReview) && !composer) {
    actions.append(h('button', {
      type: 'button',
      onclick: () => openComposer(view, thread.id),
    }, LABELS.reply));
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
    `Posted as you through ${view.data?.container}'s devc-bridge. Max 4000 bytes.`;
  // The buttons follow the grants as they are now.
  const [reply, add] = c.buttons;
  reply.hidden = !view.data?.canReply;
  add.hidden = !view.data?.canReview;
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
      onclick: () => void sendReply(view, c, false),
    }, LABELS.reply));
    const add = /** @type {HTMLButtonElement} */ (h('button', {
      type: 'button',
      class: 'composer-add',
      onclick: () => void sendReply(view, c, true),
    }, LABELS.addToReview));
    const cancel = /** @type {HTMLButtonElement} */ (h('button', {
      type: 'button',
      onclick: () => closeComposer(view, c),
    }, LABELS.cancel));
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        // Ctrl/⌘+Enter posts at once when it may, else adds to the review.
        void sendReply(view, c, !view.data?.canReply);
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
      h('div', { class: 'composer-actions' }, send, add, cancel),
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
      buttons: [send, add, cancel],
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
 * Sends a composer's reply: at once (`pr_reply`), or added to the pending review
 * (`pr_pending_reply`). The composer is disabled and busy while it goes and the threads (and
 * the review) are listed again; then it closes as the reply shows. On failure its text stays,
 * the error under it.
 *
 * @param {DiffView} view @param {Composer} c @param {boolean} toReview
 */
async function sendReply(view, c, toReview) {
  const ref = view.tile.diff;
  if (c.sending || !ref) return;
  const message = await sending(
    c,
    toReview
      ? {
        type: 'pr_pending_reply',
        localFolder: ref.localFolder,
        root: ref.root,
        thread: c.thread,
        body: c.textarea.value,
      }
      : { type: 'pr_reply', ...ref, thread: c.thread, body: c.textarea.value },
    toReview ? LABELS.addingToReview : LABELS.posting,
    () => toReview ? reviewChanged(ref) : loadThreads(view),
  );
  if (diffViews.get(view.tile.id) !== view || message !== null) return;
  view.composers.delete(c.thread);
  renderDiff(view);
}

/**
 * Sends `msg` for a composer (`c`: a reply, a new comment or an edit), disabled while it goes
 * with a spinner and `busy` beside its buttons. On success it stays so while `reload` lists
 * what it changed again, so the caller can close it as the result shows. Resolves `null` on
 * success, else the message, shown under it with its text kept.
 *
 * @param {{textarea: HTMLTextAreaElement, buttons: HTMLButtonElement[], error: HTMLElement,
 *   sending: boolean}} c
 * @param {Record<string, unknown>} msg
 * @param {string} busy
 * @param {() => Promise<unknown>} reload
 * @returns {Promise<string | null>}
 */
async function sending(c, msg, busy, reload) {
  c.sending = true;
  c.textarea.disabled = true;
  for (const b of c.buttons) b.disabled = true;
  c.error.hidden = true;
  const status = h(
    'span',
    { class: 'composer-busy', role: 'status' },
    h('span', { class: 'spinner', 'aria-hidden': 'true' }),
    busy,
  );
  c.buttons[0].parentElement?.append(status);
  let message = null;
  try {
    const r = await call(msg);
    if (r?.available === false) message = String(r.message ?? 'failed');
  } catch (e) {
    message = String(e?.message ?? e);
  }
  if (message === null) await reload().catch(() => {});
  status.remove();
  c.sending = false;
  c.textarea.disabled = false;
  for (const b of c.buttons) b.disabled = false;
  if (message !== null) {
    c.error.textContent = message;
    c.error.hidden = false;
    c.textarea.focus();
  }
  return message;
}

/**
 * A line number's `+`: a new comment on that line, or with Shift, after a `+` in the same hunk
 * and side, on the block between the two. The composer keeps what was typed.
 *
 * @param {DiffView} view @param {'LEFT' | 'RIGHT'} side @param {number} line
 * @param {number} hunk @param {boolean} shift
 */
function openNewComment(view, side, line, hunk, shift) {
  const a = view.anchor;
  let startLine = null;
  let last = line;
  if (shift && a && a.side === side && a.hunk === hunk && a.line !== line) {
    startLine = Math.min(a.line, line);
    last = Math.max(a.line, line);
  }
  view.anchor = { side, line, hunk };
  let nc = view.newComment;
  if (!nc) {
    const textarea = /** @type {HTMLTextAreaElement} */ (h('textarea', {
      class: 'composer-text',
      rows: '4',
      'aria-label': LABELS.addToReview,
    }));
    const add = /** @type {HTMLButtonElement} */ (h('button', {
      type: 'button',
      class: 'composer-add',
      onclick: () => void sendNewComment(view),
    }, LABELS.addToReview));
    const cancel = /** @type {HTMLButtonElement} */ (h('button', {
      type: 'button',
      onclick: () => closeNewComment(view),
    }, LABELS.cancel));
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        void sendNewComment(view);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        closeNewComment(view);
      }
    });
    const label = h('div', { class: 'thread-where' });
    const error = h('div', { class: 'composer-error', hidden: true });
    nc = {
      side,
      startLine,
      line: last,
      hunk,
      el: h(
        'div',
        { class: 'thread-card composer new-comment' },
        label,
        textarea,
        h('div', { class: 'composer-actions' }, add, cancel),
        error,
      ),
      label,
      textarea,
      error,
      buttons: [add, cancel],
      sending: false,
    };
    view.newComment = nc;
  } else if (nc.sending) return;
  nc.side = side;
  nc.startLine = startLine;
  nc.line = last;
  nc.hunk = hunk;
  renderDiff(view);
  nc.textarea.focus();
}

/** A new comment's element, its label naming its lines. @param {NewComment} nc */
function newCommentEl(nc) {
  nc.label.textContent = nc.startLine === null
    ? LABELS.line(nc.line)
    : LABELS.lines(nc.startLine, nc.line);
  return nc.el;
}

/** @param {DiffView} view */
function closeNewComment(view) {
  if (view.newComment?.sending) return;
  view.newComment = null;
  view.anchor = null;
  renderDiff(view);
}

/** Adds the new comment to the pending review (`pr_pending_comment`). @param {DiffView} view */
async function sendNewComment(view) {
  const ref = view.tile.diff;
  const nc = view.newComment;
  const path = view.data?.file?.path;
  if (!ref || !nc || nc.sending || typeof path !== 'string') return;
  const message = await sending(
    nc,
    {
      type: 'pr_pending_comment',
      localFolder: ref.localFolder,
      root: ref.root,
      path,
      line: nc.line,
      side: nc.side,
      startLine: nc.startLine,
      body: nc.textarea.value,
    },
    LABELS.addingToReview,
    () => reviewChanged(ref),
  );
  if (diffViews.get(view.tile.id) !== view || message !== null) return;
  if (view.newComment === nc) {
    view.newComment = null;
    view.anchor = null;
  }
  renderDiff(view);
}

/** Edits a pending comment in place: its body in a composer, **Save** / **Cancel**. */
function openEdit(view, comment) {
  if (view.editing.has(comment.id)) return;
  const textarea = /** @type {HTMLTextAreaElement} */ (h('textarea', {
    class: 'composer-text',
    rows: '4',
    'aria-label': LABELS.edit,
  }));
  textarea.value = String(comment.body ?? '');
  const close = () => {
    if (edit.sending) return;
    view.editing.delete(comment.id);
    renderDiff(view);
  };
  const save = async () => {
    const ref = view.tile.diff;
    if (!ref || edit.sending) return;
    const message = await sending(
      edit,
      {
        type: 'pr_pending_edit',
        localFolder: ref.localFolder,
        root: ref.root,
        comment: comment.id,
        body: textarea.value,
      },
      LABELS.saving,
      () => reviewChanged(ref),
    );
    if (diffViews.get(view.tile.id) !== view || message !== null) return;
    view.editing.delete(comment.id);
    renderDiff(view);
  };
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void save();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  });
  const saveButton = /** @type {HTMLButtonElement} */ (h('button', {
    type: 'button',
    class: 'composer-send',
    onclick: () => void save(),
  }, LABELS.save));
  const cancel = /** @type {HTMLButtonElement} */ (h('button', {
    type: 'button',
    onclick: close,
  }, LABELS.cancel));
  const error = h('div', { class: 'composer-error', hidden: true });
  /** @type {CommentEdit} */
  const edit = {
    el: h(
      'div',
      { class: 'composer' },
      textarea,
      h('div', { class: 'composer-actions' }, saveButton, cancel),
      error,
    ),
    textarea,
    error,
    buttons: [saveButton, cancel],
    sending: false,
  };
  view.editing.set(comment.id, edit);
  renderDiff(view);
  textarea.focus();
}

/** Deletes a pending comment (`pr_pending_delete`), asked first. */
async function deletePending(view, comment) {
  const ref = view.tile.diff;
  if (!ref) return;
  const ok = await confirmDialog(LABELS.deleteCommentConfirm, {
    okLabel: 'Delete',
    danger: true,
  });
  if (!ok) return;
  try {
    const r = await call({
      type: 'pr_pending_delete',
      localFolder: ref.localFolder,
      root: ref.root,
      comment: comment.id,
    });
    if (r?.available === false) errorToast(`Delete failed: ${r.message}`);
  } catch (e) {
    errorToast(`Delete failed: ${e?.message ?? e}`);
  }
  if (diffViews.get(view.tile.id) === view) reviewChanged(ref);
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

/** On leaving the page: what {@link restoreFocus} brings back after a reload. */
function saveFocus() {
  const tile = tiling?.focusedTile() ?? tileOf(focusedTileId);
  try {
    if (!tile || !document.hasFocus()) sessionStorage.removeItem(FOCUS_KEY);
    else {
      sessionStorage.setItem(
        FOCUS_KEY,
        JSON.stringify({ ref: tile.ref, file: tile.file, diff: tile.diff }),
      );
    }
  } catch { /* unavailable: a reload just won't refocus */ }
}

/** A diff tile's key in {@link SCROLL_KEY}: its PR file, beside {@link fileKey}'s. */
function diffScrollKey(/** @type {DiffRef} */ diff) {
  return `diff\n${diff.localFolder}\n${diff.root}\n${diff.path}`;
}

/**
 * The scroll positions {@link saveScroll} kept before a reload, by {@link fileKey} or
 * {@link diffScrollKey}: each taken by the first tile to show its file. Read once, on first use.
 *
 * @type {Map<string, any> | null}
 */
let savedScrolls = null;

/** On leaving the page: each file and diff tile's scroll position, for the reload. */
function saveScroll() {
  const pending = loadSavedScrolls();
  /** @type {[string, any][]} */
  const out = [];
  for (const view of fileViews.values()) {
    const file = view.tile.file;
    if (!file) continue;
    // Not read yet: what it was given to restore, still.
    const spot = view.viewer
      ? view.viewer.scrollSpot()
      : pending.get(fileKey(file));
    if (spot) out.push([fileKey(file), spot]);
  }
  for (const view of diffViews.values()) {
    if (view.tile.diff && view.scrollTop > 0) {
      out.push([diffScrollKey(view.tile.diff), view.scrollTop]);
    }
  }
  try {
    if (out.length === 0) sessionStorage.removeItem(SCROLL_KEY);
    else sessionStorage.setItem(SCROLL_KEY, JSON.stringify(out));
  } catch { /* unavailable: a reload just starts at the top */ }
}

/** The scroll position kept for `key` before the reload, once; `undefined` when none was. */
function takeSavedScroll(/** @type {string} */ key) {
  const saved = loadSavedScrolls();
  const value = saved.get(key);
  saved.delete(key);
  return value;
}

function loadSavedScrolls() {
  if (savedScrolls === null) {
    savedScrolls = new Map();
    try {
      const saved = JSON.parse(sessionStorage.getItem(SCROLL_KEY) ?? 'null');
      sessionStorage.removeItem(SCROLL_KEY);
      if (Array.isArray(saved)) {
        for (const entry of saved) {
          if (Array.isArray(entry) && typeof entry[0] === 'string') {
            savedScrolls.set(entry[0], entry[1]);
          }
        }
      }
    } catch { /* unavailable or malformed: nothing to restore */ }
  }
  return savedScrolls;
}

/** Focuses the tile {@link saveFocus} kept, so typing goes on where it was after a reload. */
function restoreFocus() {
  let saved = null;
  try {
    saved = JSON.parse(sessionStorage.getItem(FOCUS_KEY) ?? 'null');
    sessionStorage.removeItem(FOCUS_KEY);
  } catch { /* unavailable or malformed: nothing to refocus */ }
  if (!saved || typeof saved !== 'object') return;
  const state = viewState();
  const tile = saved.ref
    ? tileShowingPane(state, saved.ref)
    : saved.file
    ? tileShowingFile(state, saved.file)
    : saved.diff
    ? tileShowingDiff(state, saved.diff)
    : null;
  if (tile) revealTile(tile.id);
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
    removed: diffViews.get(tile.id)?.data?.file?.status === 'removed',
    lsp: file && tile.file && !file.media && lspLanguageFor(tile.file.path) &&
        containerByFolder(tile.file.localFolder)?.state === 'connected'
      ? { restart: tileRestartable(tile.id), settings: true }
      : null,
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

/** The tiles at the last view change: what a close that empties the area took away. */
let lastTiles = /** @type {TileState[]} */ ([]);

/** The dashboard's file at the last `dashboard` message; undefined until the first arrives. */
let dashboardKey = /** @type {string | null | undefined} */ (undefined);

/** Opens the dashboard when the tiling area holds no tiles. */
function openDashboardIfEmpty() {
  if (dashboard && tiling?.isEmpty()) {
    openFile(dashboardFileRef(dashboard), 'stack');
  }
}

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
    const state = viewState();
    const before = lastTiles;
    lastTiles = state.tiles;
    if (
      reopensDashboard(dashboard, before, state.tiles.length)
    ) {
      openDashboardIfEmpty();
    }
    onViewChange(state);
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
      const host = p?.environment === 'host';
      if (p?.starting) {
        message = host ? 'Starting session…' : 'Starting container…';
      } else if (p && p.container !== 'running') {
        message = host
          ? 'Session stopped'
          : p.container === 'stopped'
          ? 'Container stopped'
          : 'Container not created';
        if (projectStarts) {
          action = h('button', {
            onclick: () => startProject(ref.localFolder),
          }, projectActions(p.environment).start);
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
  const diff = diffViews.get(tile.id);
  if (diff && visible) {
    requestAnimationFrame(() => {
      const body = diff.body.querySelector('.diff-body');
      if (body) body.scrollTop = diff.scrollTop;
    });
  }
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

/**
 * Tells the server whether this page is visible and its window focused, for its activity log
 * (input counts as the user's time only then). Sent after each `hello` and on every change. A
 * server that doesn't know `page_state` ignores it: it carries no `id`, so nothing answers.
 */
function reportPageState() {
  send({
    type: 'page_state',
    visible: document.visibilityState === 'visible',
    focused: document.hasFocus(),
  });
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

/** Zen mode: the focused tile alone, filling the tiling area with no header or frame. */
let zenOn = false;
/** The tiling area's zen button, in its top-right corner (over the top-right tile's header). */
const $zenToggle = h('button', {
  class: 'sidebar-toggle zen-toggle',
  type: 'button',
  'aria-pressed': 'false',
  onclick: () => setZen(!zenOn),
}, svgIcon('zen'));

/** Whether zen mode is this page's default, and where it is saved: set by {@link mountTiles}. */
let zenByDefault = false;
let zenKey = ZEN_KEY;

/** Zen mode at load: the page URL's `?zen=…` over what was saved, else the page's default. */
function startingZen() {
  const asked = zenFromSearch(location.search);
  if (asked !== null) return asked;
  let own = null;
  try {
    own = JSON.parse(localStorage.getItem(zenKey) ?? 'null');
  } catch { /* unreadable: the default */ }
  return savedZen(own, zenByDefault);
}

/**
 * Turns zen mode on or off (`layout.js`): its button, a tile's menu and Ctrl+Alt+Z. The page's
 * `.app` gets `data-zen` (`on` or `off`), which the stylesheet reads.
 *
 * @param {boolean} on
 * @param {{save?: boolean}} [opts]  `save: false` leaves what is saved as it is (the page's start)
 */
function setZen(on, { save = true } = {}) {
  zenOn = on;
  if (save) {
    try {
      localStorage.setItem(zenKey, JSON.stringify(on));
    } catch { /* storage unavailable: zen mode just won't survive a reload */ }
  }
  const app = /** @type {HTMLElement | null} */ ($tiles.closest('.app'));
  if (app) app.dataset.zen = on ? 'on' : 'off';
  const label = `${on ? LABELS.zenOff : LABELS.zenOn} (${
    IS_MAC ? 'Cmd' : 'Ctrl'
  }+Alt+Z)`;
  $zenToggle.setAttribute('aria-pressed', String(on));
  $zenToggle.setAttribute('aria-label', label);
  $zenToggle.title = label;
  tiling?.setZen(on);
}

/**
 * A server message, as the tiling area takes it once `client.js` has applied it: reads waiting on
 * a connection, panes to open or close, frames, tab titles, its own requests' results, and the
 * window title and `active_pane`, which follow the focused tile.
 */
function onTilesMessage(msg) {
  switch (msg.type) {
    // The first one after loading, or a newly chosen dashboard, opens it into an empty area.
    case 'dashboard': {
      const key = dashboard ? fileKey(dashboard) : null;
      if (key !== dashboardKey) {
        dashboardKey = key;
        openDashboardIfEmpty();
      }
      break;
    }
    case 'hello':
      // File reads asked for while disconnected never got an answer.
      for (const view of fileViews.values()) {
        if (view.state === 'loading') loadFile(view);
      }
      for (const view of diffViews.values()) {
        if (view.state === 'loading') void loadDiff(view);
      }
      reportPageState();
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
      for (const view of diffViews.values()) syncDiffLanguage(view);
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
 * `zenByDefault` (`/main` alone) starts it in zen mode until zen mode is turned off there.
 *
 * @param {HTMLElement} root
 * @param {{sidebar: SidebarIntents | null,
 *   onViewChange: (state: ViewState) => void, zenByDefault?: boolean}} opts
 * @returns {TileArea}
 */
export function mountTiles(root, opts) {
  $tiles = root;
  zenByDefault = opts.zenByDefault ?? false;
  zenKey = zenByDefault ? MAIN_ZEN_KEY : ZEN_KEY;
  onViewChange = opts.onViewChange;
  sidebarIntents = opts.sidebar;
  setMenuContext({
    tileArea,
    sidebar: opts.sidebar,
    zen: { on: () => zenOn, set: setZen },
  });
  $tiles.replaceChildren($layoutRoot, $placeholder, $zenToggle);
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
  // A live edit's reload waits for them to be saved or dropped.
  holdReloadWhile(() => [...fileViews.values()].some((view) => view.dirty));

  // Ctrl+Alt+Z (Cmd+Alt+Z on a Mac) turns zen mode on or off, in the capture phase so it works
  // while a terminal has focus: xterm.js never sees the keys (on a Mac, Option would type one).
  document.addEventListener('keydown', (e) => {
    if (!isZenShortcut(e, IS_MAC)) return;
    e.preventDefault();
    e.stopPropagation();
    if (!e.repeat) setZen(!zenOn);
  }, true);

  window.addEventListener('focus', () => {
    reportPageState();
    reportActivePane(true);
  });
  window.addEventListener('blur', reportPageState);
  document.addEventListener('visibilitychange', reportPageState);
  setLspHooks({
    openFile: (file) => openFile(file, 'preview'),
    changed: (key) => {
      const view = fileViews.get(key);
      if (view) renderLspStatus(view);
      viewChanged();
    },
  });
  onServerMessage(onTilesMessage);
  onConnectionChange(onTilesConnection);
  acceptNativeDrops(root);
  window.addEventListener('pagehide', saveFocus);
  window.addEventListener('pagehide', saveScroll);
  restoreLayout();
  reconcileTiles();
  restoreFocus();
  setZen(startingZen(), { save: false });
  updateWindow();
  return tileArea;
}
