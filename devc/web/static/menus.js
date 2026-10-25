// The `devc web` menus and actions built from the server's data and the contracts of
// `lib/view.js`: a tile's menu (on its tab, in it, and on its sidebar row), a stack's, new panes
// and where they go, pinning files, Open in Code and the other host actions. The sidebar and the
// tiling area both use them; they reach either only through what `setMenuContext` was given,
// never by importing `tiles.js` or `sidebar.js`.

import { withView } from './lib/layout_state.js';
import { nodeById, nodeTiles } from './lib/view.js';
import { paneLabel } from './lib/sidebar.js';
import { jiraKeys, jiraUrl } from './lib/jira.js';
import { defaultView, fileView, mediaKind } from './lib/media.js';
import { childPath, isWithin } from './lib/files.js';
import { isDashboardFile } from './lib/dashboard.js';
import {
  confirmDialog,
  copyText,
  errorToast,
  LABELS,
  openMenu,
  reviewDialog,
  toast,
} from './ui.js';
import {
  activeRepo,
  call,
  containerByFolder,
  dashboard,
  filePinOfTile,
  filePinPanes,
  jiraConfig,
  list,
  nextId,
  paneRepo,
  pendingRequests,
  pinnedFiles,
  projectOutput,
  projectRepos,
  requestPane,
  resolveRef,
  saveFilePinPanes,
  send,
  snapshots,
} from './client.js';

/** @typedef {import('./lib/view.js').SidebarIntents} SidebarIntents */
/** @typedef {import('./lib/view.js').TileArea} TileArea */
/** @typedef {import('./lib/view.js').ViewIntents} ViewIntents */
/** @typedef {import('./lib/view.js').TileState} TileState */
/** @typedef {import('./lib/layout_state.js').FileRef} FileRef */
/** @typedef {import('./client.js').ContainerInfo} ContainerInfo */
/** @typedef {import('./ui.js').MenuItem} MenuItem */

// ---------------------------------------------------------------------------------------------
// Menus and actions
// ---------------------------------------------------------------------------------------------

/**
 * The tiling area the menus act on (`mountTiles` sets it; `mountSidebar` too, for a sidebar on a
 * page of its own).
 *
 * @type {TileArea | null}
 */
let tileArea = null;
/**
 * How a tile's menu reaches the sidebar (**Reveal in Containers**): null when no sidebar is on
 * the page, and that item is left out.
 *
 * @type {SidebarIntents | null}
 */
let sidebar = null;
/** The tiling area's zen mode, which a tile's zen item turns on or off; null without one. */
let zen =
  /** @type {{on: () => boolean, set: (on: boolean) => void} | null} */ (null);
/**
 * The sidebar's directory tree of a file root, whose listings say where a container file is on
 * the host and a repo file in the container; null without a sidebar.
 *
 * @type {((fr: FileRoot) => ReturnType<typeof import('./lib/files.js').createDirTree>) | null}
 */
let fileTreeOf = null;
/** What pinning a file does in the sidebar: open its Pinned section. */
let filePinned = () => {};

/**
 * Sets what the menus reach beyond the server's data (see above): each half sets its own part as
 * it mounts.
 *
 * @param {{tileArea?: TileArea, sidebar?: SidebarIntents | null,
 *   zen?: {on: () => boolean, set: (on: boolean) => void},
 *   fileTreeOf?: (fr: FileRoot) => ReturnType<typeof import('./lib/files.js').createDirTree>,
 *   filePinned?: () => void}} parts
 */
export function setMenuContext(parts) {
  if (parts.tileArea !== undefined) tileArea = parts.tileArea;
  if (parts.sidebar !== undefined) sidebar = parts.sidebar;
  if (parts.zen !== undefined) zen = parts.zen;
  if (parts.fileTreeOf !== undefined) fileTreeOf = parts.fileTreeOf;
  if (parts.filePinned !== undefined) filePinned = parts.filePinned;
}

/**
 * Where a pane a message answered with goes (see `ViewIntents.openPane`): by default, a new tile
 * in the focused stack.
 *
 * @typedef {{where?: import('./lib/view.js').Where, at?: string | null}} Placement
 */

/**
 * Creates a pane in its own Herdr tab and shows it as `placement` says. The tile is placed as
 * soon as the server answers, before Herdr's snapshot lists the pane, so its overlay waits out
 * {@link NEW_PANE_GRACE_MS} instead of saying `LABELS.closed`.
 *
 * @param {ContainerInfo} c
 * @param {{workspace_id?: string, cwd?: string}} opts
 * @param {Placement} [placement]
 */
export function newShell(c, opts, placement = {}) {
  return createPane(
    c,
    { type: 'new_shell', ...opts },
    placement,
    LABELS.newTerminal,
  );
}

/**
 * Sends `msg` (`new_shell`, `open_file` or `open_tab`: a message that answers with a pane) for
 * container `c`, then places the pane as {@link newShell} does. A reused pane (`open_tab`'s
 * `reused`) already shown in a tile focuses that tile instead. Placement goes by `c`'s folder
 * only, never its state: an `open_tab` that started Herdr can answer before this page has seen
 * the container connect. A failure is a toast naming `what`.
 *
 * @param {ContainerInfo} c
 * @param {Record<string, unknown> & {type: string}} msg
 * @param {Placement} placement
 * @param {string} what
 */
export async function createPane(c, msg, placement, what) {
  let result;
  try {
    result = await requestPane({ ...msg, container: c.id });
  } catch (e) {
    errorToast(`${what} failed: ${e?.message ?? e}`);
    return;
  }
  placePane(c.localFolder, result, placement);
}

/**
 * Shows a pane a message answered with (see {@link createPane}), in the project at
 * `localFolder`. A reused pane already shown in a tile focuses that tile instead.
 *
 * @param {string} localFolder
 * @param {{pane_id: string, reused?: boolean}} result
 * @param {Placement} [placement]
 */
export function placePane(localFolder, result, placement = {}) {
  tileArea.openPane({ localFolder, pane_id: result.pane_id }, {
    ...placement,
    created: result.reused ? 'reused' : 'new',
  });
}

/** The workspace a pane belongs to, through its Herdr tab. */
function paneWorkspace(c, pane) {
  const tab = list(snapshots.get(c.id)?.tabs).find((t) =>
    t.tab_id === pane?.tab_id
  );
  return tab?.workspace_id;
}

/** `new_shell` options for a shell next to `pane`: its workspace, in its current folder. */
function shellOptsNear(c, pane) {
  const opts = {};
  const ws = pane ? paneWorkspace(c, pane) : undefined;
  if (ws) opts.workspace_id = ws;
  const cwd = pane?.foreground_cwd || pane?.cwd;
  if (cwd) opts.cwd = cwd;
  return opts;
}

/** The first tile in `tiles` whose pane is in a connected container, for a new shell's origin. */
function shellOrigin(tiles) {
  for (const tile of tiles) {
    const { c, pane } = resolveRef(tile.ref);
    if (c && c.state === 'connected') return { c, pane };
  }
  return null;
}

/**
 * Ends a pane's process (and closes its Herdr tab), after asking. Once Herdr confirms, every tile
 * showing the pane closes too, rather than staying behind with "Pane gone".
 */
export async function killPane(c, pane) {
  if (
    !await confirmDialog(
      `Close terminal "${paneLabel(pane).name}"? Its process ends.`,
      { okLabel: 'Close terminal', danger: true },
    )
  ) {
    return;
  }
  call({
    type: 'request',
    container: c.id,
    method: 'pane.close',
    params: { pane_id: pane.pane_id },
  }).then(
    () => {
      const shown = tileArea.state().tiles.filter((t) =>
        t.kind !== 'file' && t.ref?.localFolder === c.localFolder &&
        t.ref.pane_id === pane.pane_id
      );
      for (const t of shown) tileArea.close(t.id);
    },
    (err) => errorToast(`${LABELS.closeRequest} failed: ${err.message}`),
  );
}

export function killPaneItem(c, pane) {
  return [LABELS.close, () => killPane(c, pane), true];
}

/**
 * A tile's menu, on its tab, in it, and on its sidebar row.
 *
 * @param {TileState} tile @returns {MenuItem[]}
 */
export function tileMenuItems(tile) {
  if (tile.kind === 'file') return fileTileMenuItems(tile);
  if (tile.kind === 'diff') return diffTileMenuItems(tile);
  const { c, pane } = resolveRef(tile.ref);
  const items = [];
  if (c && c.state === 'connected') {
    const opts = shellOptsNear(c, pane);
    items.push(
      [
        LABELS.splitRight,
        () => newShell(c, opts, { at: tile.id, where: 'right' }),
      ],
      [
        LABELS.splitBelow,
        () => newShell(c, opts, { at: tile.id, where: 'below' }),
      ],
      [
        LABELS.newInStack,
        () => newShell(c, opts, { at: tile.id, where: 'stack' }),
      ],
    );
  }
  if (c && pane) {
    if (sidebar) {
      const ref = { localFolder: c.localFolder, pane_id: pane.pane_id };
      items.push(null, [
        'Reveal in Containers',
        () => sidebar.revealInContainers(ref),
      ]);
    }
    items.push(...jiraItems(activeRepo(tile).branch));
  }
  const filePin = filePinOfTile(tile);
  if (filePin) {
    items.push(null, [LABELS.unpinFile, () => unpinFile(filePin)]);
  }
  if (tile.preview) items.push(null, keepOpenItem(tile));
  items.push(null, ['Close', () => tileArea.close(tile.id)]);
  if (c && pane) items.push(killPaneItem(c, pane));
  return items;
}

/**
 * The menu of a tile's tab and body (not of its sidebar row): the tile's, then zen mode.
 *
 * @param {TileState} tile
 */
export function tileOwnMenuItems(tile) {
  return [...tileMenuItems(tile), null, ...zenItems()];
}

/**
 * Pins a preview tile: the next sidebar click opens a new preview instead of replacing it.
 *
 * @param {TileState | null} tile
 */
export function keepOpen(tile) {
  if (tile?.preview) tileArea.keepOpen(tile.id);
}

function keepOpenItem(tile) {
  return [LABELS.keepOpen, () => keepOpen(tile)];
}

/** A stack, row or column's menu. */
function nodeMenuItems(node, tiles) {
  const origin = shellOrigin(tiles);
  const items = [];
  if (origin) {
    const opts = shellOptsNear(origin.c, origin.pane);
    items.push([
      node.kind === 'stack' ? LABELS.newInStack : LABELS.newAtEnd,
      () => newShell(origin.c, opts, { at: node.id, where: 'stack' }),
    ]);
  }
  if (node.kind === 'stack') {
    items.push(['Close stack', () => tileArea.close(node.id)]);
  }
  return items;
}

/** A right-click on a stack header's empty area. */
export function stackMenu(stackId, e) {
  const view = tileArea.state();
  // The unfolded tree: the folded one has no node for a stack holding one tile.
  const stack = nodeById(view, stackId);
  if (!stack) return;
  const items = nodeMenuItems(stack, nodeTiles(view, stack));
  if (items.length > 0) openMenu(e, items);
}

/**
 * A file root: `root` is one of the repo folders (`repos[].folder`) of the project at
 * `localFolder`. Paths in a tree are relative to `root`; `localFolder` finds the container. With
 * `container`, `root` is `/` inside that running container (its Files row), not a host folder.
 *
 * @typedef {{localFolder: string, root: string, container?: true}} FileRoot
 */

/**
 * The file root of a project's container's own filesystem: `/` (the Files row), or a folder in it
 * (the `/workspaces` and home rows under it). @returns {FileRoot}
 */
export function containerRoot(localFolder, root = '/') {
  return { localFolder, root, container: true };
}

/** `path` under container root `fr` as an absolute container path; the root itself for `''`. */
export function containerFilePath(fr, path) {
  return path === '' ? fr.root : childPath(fr.root, path);
}

/**
 * A file under `fr`, as a file tile names it, shown as `view` (by default, its default). A
 * container file is always under `/`, whichever row it was opened from, so it is one file to
 * tiles and saved layouts. @returns {FileRef}
 */
export function fileRefOf(fr, path, view) {
  if (fr.container) {
    return withView({
      localFolder: fr.localFolder,
      root: '/',
      path: containerFilePath(fr, path).slice(1),
      container: true,
    }, view);
  }
  return withView({ localFolder: fr.localFolder, root: fr.root, path }, view);
}

/**
 * The dashboard's file as a file tile names it: rendered when it can be (HTML, SVG, images), else
 * as text. Always the host-side viewer.
 *
 * @param {import('./lib/dashboard.js').DashboardFile} d @returns {FileRef}
 */
export function dashboardFileRef(d) {
  return fileRefOf(
    { localFolder: d.localFolder, root: d.root },
    d.path,
    previewable(d.path) ? 'media' : undefined,
  );
}

/**
 * Makes a repo file the dashboard (`set_dashboard`), or with `file` null, stops using one.
 *
 * @param {import('./lib/dashboard.js').DashboardFile | null} file
 */
export function setDashboard(file) {
  call({ type: 'set_dashboard', file }).catch((e) =>
    errorToast(
      `${file ? LABELS.useAsDashboard : LABELS.stopDashboard} failed: ${
        e?.message ?? e
      }`,
    )
  );
}

/**
 * "Use as dashboard", or "Stop using as dashboard" on the dashboard itself, for a repo file's
 * menus (beside **Pin file**). @param {FileRoot} fr @param {string} path
 */
export function dashboardItem(fr, path) {
  const file = { localFolder: fr.localFolder, root: fr.root, path };
  return isDashboardFile(dashboard, file)
    ? [LABELS.stopDashboard, () => setDashboard(null)]
    : [LABELS.useAsDashboard, () => setDashboard(file)];
}

/** The file root a file tile's file is under. @returns {FileRoot} */
export function fileRootOf(file) {
  return file.container
    ? containerRoot(file.localFolder)
    : { localFolder: file.localFolder, root: file.root };
}

/**
 * A tile's menu item for zen mode: on or off.
 *
 * @returns {MenuItem[]}
 */
function zenItems() {
  if (!zen) return [];
  const on = zen.on();
  return [[on ? LABELS.zenOff : LABELS.zenOn, () => zen.set(!on)]];
}

/**
 * An In use terminal's **Open in Code**, on the repo its cwd is in, then a divider: none outside
 * every repo.
 */
export function paneCodeItems(c, pane) {
  const repo = paneRepo(c.localFolder, pane);
  if (!repo) return [];
  const fr = { localFolder: c.localFolder, root: repo.folder };
  return [[LABELS.openInCode, () => void openInCode(fr, '')], null];
}

/**
 * An **Open `<KEY>` in Jira** group for each Jira key in `branch` (none without one, or without
 * `"jira"` in devc's config), after a divider. Read when a menu opens, so it follows the branch.
 *
 * @param {string | null | undefined} branch
 * @returns {MenuItem[]}
 */
export function jiraItems(branch) {
  const jira = jiraConfig;
  const keys = jiraKeys(branch, jira);
  if (!jira || keys.length === 0) return [];
  return [
    null,
    ...keys.map((key) => [
      LABELS.openInJira(key),
      () =>
        void window.open(jiraUrl(jira, key), '_blank', 'noopener,noreferrer'),
    ]),
  ];
}

/** Sends a project message; a failure is a toast naming `what`. */
export function projectRequest(type, localFolder, what, extra = {}) {
  const id = nextId('r');
  pendingRequests.set(id, what);
  send({ type, id, localFolder, ...extra });
}

export function startProject(localFolder) {
  projectOutput.set(localFolder, []);
  projectRequest('start_project', localFolder, 'Start container');
}

/** "Pin file" or "Unpin file" for a repo file's menus. @param {FileRoot} fr @param {string} path */
export function filePinItem(fr, path) {
  const pin = pinnedFiles.find((p) => p.root === fr.root && p.path === path);
  return pin
    ? [LABELS.unpinFile, () => unpinFile(pin)]
    : [LABELS.pinFile, () => pinFile(fr, path)];
}

/** @param {FileRoot} fr @param {string} path */
function pinFile(fr, path) {
  call({
    type: 'pin_file',
    localFolder: fr.localFolder,
    root: fr.root,
    path,
  }).then(
    () => filePinned(),
    (e) => errorToast(`${LABELS.pinFile} failed: ${e?.message ?? e}`),
  );
}

/** Unpins a file; its editor pane, and any tile showing it, stay. */
export function unpinFile(pin) {
  call({ type: 'unpin_file', pin: pin.id }).then(
    () => {
      if (filePinPanes.delete(pin.id)) saveFilePinPanes();
    },
    (e) => errorToast(`${LABELS.unpinFile} failed: ${e?.message ?? e}`),
  );
}

/**
 * `path`'s container path: for a repo, from the nearest listed folder at or above it, else from
 * where the container mounts the repo; null if neither knows.
 */
function containerPathOf(fr, path) {
  if (fr.container) return containerFilePath(fr, path);
  const parts = path === '' ? [] : path.split('/');
  const tree = containerByFolder(fr.localFolder) ? fileTreeOf?.(fr) : null;
  if (tree) {
    for (let n = parts.length; n >= 0; n--) {
      const l = tree.listing(parts.slice(0, n).join('/'));
      if (l?.state === 'ok' && typeof l.containerPath === 'string') {
        return parts.slice(n).reduce(childPath, l.containerPath);
      }
    }
  }
  const mounted = projectRepos(fr.localFolder).find((r) => r.folder === fr.root)
    ?.containerFolder;
  return typeof mounted === 'string' ? parts.reduce(childPath, mounted) : null;
}

/**
 * `path`'s host path: a repo's is under its folder; a container's is known from the nearest
 * listed folder at or above it that a bind mount covers (`hostPath`), or that lists a mount
 * (`mounted`). Null if none does.
 */
export function hostPathOf(fr, path) {
  if (!fr.container) return path === '' ? fr.root : childPath(fr.root, path);
  const tree = fileTreeOf?.(fr);
  if (!tree) return null;
  const parts = path === '' ? [] : path.split('/');
  for (let n = parts.length; n >= 0; n--) {
    const l = tree.listing(parts.slice(0, n).join('/'));
    if (l?.state !== 'ok') continue;
    if (typeof l.hostPath === 'string') {
      return parts.slice(n).reduce(childPath, l.hostPath);
    }
    const at = n < parts.length ? l.mounted?.[parts[n]] : undefined;
    if (typeof at === 'string') return parts.slice(n + 1).reduce(childPath, at);
  }
  return null;
}

/**
 * **Copy path** (the host path) and **Copy container path** for a file or folder, each when its
 * path is known.
 */
export function copyPathItems(fr, path) {
  const host = hostPathOf(fr, path);
  const inContainer = containerPathOf(fr, path);
  return [
    ...(host !== null ? [[LABELS.copyPath, () => copyText(host)]] : []),
    ...(inContainer !== null
      ? [[LABELS.copyContainerPath, () => copyText(inContainer)]]
      : []),
  ];
}

/**
 * **Open in Code** and the reveal item for a file or folder: both need the host path in one of
 * the project's repos, as the server does.
 */
export function hostOpenItems(fr, path) {
  const host = hostPathOf(fr, path);
  const inRepo = host !== null &&
    (!fr.container ||
      projectRepos(fr.localFolder).some((r) => isWithin(r.folder, host)));
  return inRepo
    ? [
      [LABELS.openInCode, () => void openInCode(fr, path)],
      [LABELS.reveal, () => void revealPath(fr, path)],
    ]
    : [];
}

/** Opens a file or folder in VS Code on the host (`open_in_code`). */
async function openInCode(fr, path) {
  const c = fr.container ? containerByFolder(fr.localFolder) : null;
  if (fr.container && !c) {
    toast('Start the container first');
    return;
  }
  try {
    await call(
      c
        ? {
          type: 'open_in_code',
          container: c.id,
          path: containerFilePath(fr, path),
        }
        : {
          type: 'open_in_code',
          localFolder: fr.localFolder,
          root: fr.root,
          path,
        },
    );
  } catch (e) {
    errorToast(`Open in Code failed: ${e?.message ?? e}`);
  }
}

/** Shows a file or folder selected in the host's file manager (`reveal_path`). */
async function revealPath(fr, path) {
  const c = fr.container ? containerByFolder(fr.localFolder) : null;
  if (fr.container && !c) {
    toast('Start the container first');
    return;
  }
  const label = LABELS.reveal;
  try {
    await call(
      c
        ? {
          type: 'reveal_path',
          container: c.id,
          path: containerFilePath(fr, path),
        }
        : {
          type: 'reveal_path',
          localFolder: fr.localFolder,
          root: fr.root,
          path,
        },
    );
  } catch (e) {
    errorToast(`${label} failed: ${e?.message ?? e}`);
  }
}

/** Opens a repo file in a new pane running the container's editor. */
export function openInEditor(fr, path, where) {
  const c = containerByFolder(fr.localFolder);
  if (!c || c.state !== 'connected') {
    toast(
      c ? 'Start Herdr in this container first' : 'Start the container first',
    );
    return;
  }
  createPane(
    c,
    fr.container
      ? { type: 'open_file', path: containerFilePath(fr, path) }
      : { type: 'open_file', root: fr.root, path },
    { where },
    'Open in editor',
  );
}

/**
 * A one-off `/preview/…` URL serving a file, and the files beside it (`preview_file`,
 * `preview_container_file`). `c` is the running container of a container file. The server keeps
 * only so many, so each use mints its own.
 *
 * @param {ContainerInfo | null} c @param {FileRoot} fr @param {string} path @returns {Promise<string>}
 */
export async function mintPreviewUrl(c, fr, path) {
  const result = await call(
    c
      ? {
        type: 'preview_container_file',
        container: c.id,
        path: containerFilePath(fr, path),
      }
      : {
        type: 'preview_file',
        localFolder: fr.localFolder,
        root: fr.root,
        path,
      },
  );
  return new URL(String(result?.path ?? ''), location.origin).href;
}

/**
 * Opens an HTML file in a new browser tab, with the files beside it: the server serves it at a
 * one-off `/preview/…` URL (`preview_file`, `preview_container_file`), sandboxed so the page's own
 * scripts can't reach this one. A container file needs the container running.
 */
export async function openInBrowser(fr, path) {
  const c = fr.container ? containerByFolder(fr.localFolder) : null;
  if (fr.container && !c) {
    toast('Start the container first');
    return;
  }
  // Opened now, inside the click, so a popup blocker lets it through; navigated once answered.
  const win = window.open('about:blank', '_blank');
  if (win) win.opener = null;
  let url;
  try {
    url = await mintPreviewUrl(c, fr, path);
  } catch (e) {
    win?.close();
    errorToast(`Open in browser failed: ${e?.message ?? e}`);
    return;
  }
  if (win) win.location.href = url;
  else window.open(url, '_blank', 'noopener,noreferrer');
}

/** Whether a file opens as text but can also be shown as media: HTML, and SVG. */
export function previewable(path) {
  return mediaKind(path) !== null && defaultView(path) === 'text';
}

/**
 * Opens a repo file in a file tile (see `ViewIntents.openFile`). Works whether or not the
 * container runs: the server reads the host side of the mount. `view` shows it as text or as
 * media; by default, as its kind of file opens.
 *
 * @param {FileRoot} fr @param {string} path @param {'preview' | 'stack' | 'right'} where
 * @param {'text' | 'media'} [view]
 */
export function openFileTile(fr, path, where, view) {
  tileArea.openFile(fileRefOf(fr, path, view), where);
}

/**
 * A file tile's menu (its tab, its Layout row, and a right-click in it).
 *
 * @param {TileState} tile
 */
function fileTileMenuItems(tile) {
  const items = [];
  const file = tile.file;
  if (file) {
    const fr = fileRootOf(file);
    const asMedia = fileView(file) === 'media';
    if (tile.saveable) items.push(['Save', () => tileArea.save(tile.id)]);
    items.push(['Reload', () => tileArea.reload(tile.id)], null);
    items.push([LABELS.askAgent, () => tileArea.askAgent(tile.id)], null);
    if (previewable(file.path)) {
      items.push(
        asMedia
          ? [
            LABELS.openAsText,
            () => openFileTile(fr, file.path, 'stack', 'text'),
          ]
          : [
            LABELS.preview,
            () => openFileTile(fr, file.path, 'stack', 'media'),
          ],
      );
    }
    items.push(['Open in editor', () => openInEditor(fr, file.path, 'stack')]);
    if (mediaKind(file.path) === 'html') {
      items.push(['Open in browser', () => openInBrowser(fr, file.path)]);
    }
    items.push(...hostOpenItems(fr, file.path));
    items.push(null, ...copyPathItems(fr, file.path));
    if (!file.container) {
      items.push(
        null,
        filePinItem(fr, file.path),
        dashboardItem(fr, file.path),
      );
    }
    items.push(...jiraItems(activeRepo(tile).branch));
  }
  if (tile.preview) items.push(null, keepOpenItem(tile));
  items.push(null, ['Close', () => tileArea.close(tile.id)]);
  return items;
}

/**
 * A diff tile's menu (its tab, its Layout row, and a right-click in it).
 *
 * @param {TileState} tile
 */
function diffTileMenuItems(tile) {
  const items = [
    ['Refresh', () => tileArea.reload(tile.id)],
    [LABELS.askAgent, () => tileArea.askAgent(tile.id)],
  ];
  const url = tile.url;
  if (url) {
    items.push([
      'Open on GitHub',
      () => window.open(url, '_blank', 'noopener'),
    ]);
  }
  if (tile.preview) items.push(null, keepOpenItem(tile));
  items.push(null, ['Close', () => tileArea.close(tile.id)]);
  return items;
}

/**
 * A repo's pending review, submitted as a Comment (`pr_pending_submit`) after its summary is
 * asked for (`reviewDialog`, which links to GitHub for approving). Resolves whether it was sent,
 * failed or not, so the caller lists the threads and the review again.
 *
 * @param {{localFolder: string, root: string}} repo @param {string} prUrl
 * @returns {Promise<boolean>}
 */
export async function submitPendingReview(repo, prUrl) {
  const body = await reviewDialog(prUrl);
  if (body === null) return false;
  await pendingReviewCall(
    { type: 'pr_pending_submit', ...repo, body },
    'Submitting the review',
    'Review submitted',
  );
  return true;
}

/**
 * A repo's pending review discarded (`pr_pending_discard`), asked first. Resolves whether it
 * was sent.
 *
 * @param {{localFolder: string, root: string}} repo
 * @returns {Promise<boolean>}
 */
export async function discardPendingReview(repo) {
  const ok = await confirmDialog(LABELS.discardReviewConfirm, {
    okLabel: LABELS.discard,
    danger: true,
  });
  if (!ok) return false;
  await pendingReviewCall(
    { type: 'pr_pending_discard', ...repo },
    'Discarding the review',
    'Review discarded',
  );
  return true;
}

/** @param {Record<string, unknown>} msg @param {string} what @param {string} done */
async function pendingReviewCall(msg, what, done) {
  try {
    const r = await call(msg);
    if (r?.available === false) errorToast(`${what} failed: ${r.message}`);
    else toast(done);
  } catch (e) {
    errorToast(`${what} failed: ${e?.message ?? e}`);
  }
}
