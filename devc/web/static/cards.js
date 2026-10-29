// The `devc web` repo cards, as In use (`sidebar.js`) and Containers (`containers.js`) both draw
// them: the cards' model (`repoCards`), a card with its terminals, past sessions, pull request and
// file trees, the git mark and Fetch, new files and folders, and the tree rows and keys they share.
// Also what the two halves share around them: the saved sidebar state (`SIDEBAR_KEY`, its keys
// unchanged), the tiling area they reach, the filter's query, and one render pass over the page's
// cards (`renderPass`). Each page mounts it once (`mountCards`) with the render that draws its
// halves: `sidebar.js`'s on `/` and `/sidebar`, `containers.js`'s on `/containers`.

import {
  focusedTile,
  layoutSignature,
  layoutTiles,
  scopeFromSearch,
  tileMarks,
  tileShowingDiff,
  tileShowingFile,
  tileShowingPane,
} from './lib/view.js';
import {
  agentStatus,
  containerLabel,
  filterMatches,
  filterOutline,
  gitSync,
  inUseLabel,
  labelText,
  paneLabel,
  paneTitle,
  projectActions,
  repoAt,
  repoCardActive,
  repoCardKey,
  savedScope,
  splitRepoName,
} from './lib/sidebar.js';
import { AGENT_IDS } from './lib/agent_icons.js';
import { mediaKind } from './lib/media.js';
import {
  byDepth,
  childPath,
  createDirTree,
  formatSize,
  isHiddenName,
  newEntryNameError,
  opensAsDir,
  opensAsFile,
} from './lib/files.js';
import { parseSessions, sessionAge, sessionTooltip } from './lib/sessions.js';
import {
  buildPrFlat,
  buildPrTree,
  folderOpenByDefault,
  isTestPath,
  prFileUrl,
  statusLetter,
  viewedPercent,
  withoutViewed,
} from './lib/pr_tree.js';
import {
  badge,
  chevron,
  confirmDialog,
  copyText,
  diffStat,
  errorToast,
  h,
  hoverActions,
  iconButton,
  LABELS,
  markedText,
  openMenu,
  openMenuAt,
  promptDialog,
  rowIcon,
  rowTrail,
  svgIcon,
  toast,
} from './ui.js';
import {
  basename,
  byNumber,
  call,
  containerByFolder,
  containers,
  desktopChannel,
  displayName,
  fileHostPath,
  list,
  nextId,
  paneKey,
  paneRepo,
  pendingRequests,
  projectRepos,
  projects,
  refLabel,
  refTooltip,
  request,
  resolveRef,
  send,
  sessionPane,
  snapshots,
  tileRepo,
} from './client.js';
import {
  containerFilePath,
  copyPathItems,
  createPane,
  dashboardItem,
  discardPendingReview,
  filePinItem,
  fileRefOf,
  hostOpenItems,
  hostPathOf,
  jiraItems,
  keepOpen,
  killPane,
  killPaneItem,
  newShell,
  openFileTile,
  openInBrowser,
  openInEditor,
  paneCodeItems,
  placePane,
  previewable,
  projectMenuItems,
  requestPush,
  submitPendingReview,
  tileMenuItems,
} from './menus.js';
import { newTaskIn } from './task-dialog.js';

/** @typedef {import('./lib/view.js').TileArea} TileArea */
/** @typedef {import('./lib/view.js').ViewState} ViewState */
/** @typedef {import('./menus.js').FileRoot} FileRoot */

/**
 * Which half draws a repo card, and how its pin and its open parts reach In use: In use's own
 * cards pin themselves; Containers' go through the `InUseLink` (`containers.js`). `folded` says
 * a card's past sessions (`'history'`, by card key) or pull request (`'pr'`, by `prKey`) were
 * opened or closed: In use passes it on to Containers on another page, where the card goes when
 * it is no longer in use.
 *
 * @typedef {object} CardSide
 * @property {(key: string) => boolean} pinned
 * @property {(key: string, pinned: boolean) => void} pin
 * @property {(part: 'history' | 'pr', key: string, open: boolean) => void} folded
 */

// ---------------------------------------------------------------------------------------------
// The page's cards: mounting, and one render pass
// ---------------------------------------------------------------------------------------------

/** The tiling area, as the cards reach it (see `lib/view.js`): set by {@link mountCards}. */
let tileArea = /** @type {TileArea} */ (null);
/** What every card on the page is drawn in (`#tree`, or `/containers`' section). */
let $root = /** @type {HTMLElement} */ (null);
/** The page's render: draws every half of it, each inside a {@link renderPass}. */
let render = () => {};
/** What the filter box holds ({@link applyFilter}); '' on a page without one. */
let filterQuery = '';

/**
 * Mounts the cards for the page: the tiling area they reach, the element they are all drawn in,
 * and the page's render, which {@link renderTree} runs. Once per page.
 *
 * @param {{tileArea: TileArea, root: HTMLElement, render: () => void}} opts
 */
export function mountCards(opts) {
  tileArea = opts.tileArea;
  $root = opts.root;
  render = opts.render;
  // Hovering a pane's row in either section highlights its rows in the other.
  $root.addEventListener('mouseover', (e) => {
    const row = /** @type {HTMLElement} */ (e.target).closest?.(
      '[data-pane-key]',
    );
    const key = row ? /** @type {HTMLElement} */ (row).dataset.paneKey : null;
    for (const el of $root.querySelectorAll('[data-pane-key]')) {
      el.classList.toggle(
        'linked',
        key !== null && /** @type {HTMLElement} */
          (el).dataset.paneKey === key &&
          el !== row,
      );
    }
  });
  $root.addEventListener('mouseleave', () => {
    for (const el of $root.querySelectorAll('.linked')) {
      el.classList.remove('linked');
    }
  });
  $root.addEventListener('keydown', (e) =>
    treeKeydown(e, {
      activate: (row) => row.click(),
      toggle: (row) => row.click(),
    }));
}

/** The tiling area the cards reach. */
export function cardsTileArea() {
  return tileArea;
}

/** Renders the page's cards again, now. */
export function renderTree() {
  render();
}

/** The filter box's query changed (`sidebar.js`). */
export function setFilterQuery(/** @type {string} */ query) {
  filterQuery = query;
}

/**
 * One render of the page's cards: `fill(cards)` draws every half from the cards' model (and lays
 * them out); around it, what a render keeps: the scroll of each open card section, the focused
 * row (or a row just created, which takes the focus from the page's own rows only), a name being
 * typed in a new entry row, the rows kept across renders that no longer show (dropped), and the
 * focused tile's marks.
 *
 * @param {(cards: Map<string, any>) => void} fill
 */
export function renderPass(fill) {
  const generation = ++renderGeneration;
  const sectionScroll = new Map();
  for (const el of $root.querySelectorAll('.card-section')) {
    const box = /** @type {HTMLElement} */ (el);
    if (box.scrollTop > 0) {
      sectionScroll.set(box.dataset.sectionKey, box.scrollTop);
    }
  }
  const focusKey = focusedTreeKey($root);
  // A just-created row takes the focus only from the cards, never from a terminal.
  const active = document.activeElement;
  const mayFocus = !active || active === document.body ||
    $root.contains(active);
  const typing = newEntry !== null && active === newEntry.input;
  const caret = typing
    ? [newEntry.input.selectionStart, newEntry.input.selectionEnd]
    : null;
  // The cards list the tiles: they are rendered again when those change (`onCardsViewState`).
  const view = tileArea.state();
  shownLayout = layoutSignature(view);
  shownMarks = tileMarks(view);
  fill(repoCards());
  for (const el of $root.querySelectorAll('.card-section')) {
    const box = /** @type {HTMLElement} */ (el);
    const top = sectionScroll.get(box.dataset.sectionKey);
    if (top) box.scrollTop = top;
  }
  const created = selectTreeKey === null
    ? null
    : treeRowByKey($root, selectTreeKey);
  if (created) {
    selectTreeKey = null;
    if (mayFocus) {
      created.focus({ preventScroll: true });
      created.scrollIntoView({ block: 'nearest' });
    }
  } else refocusTreeKey($root, focusKey);
  if (newEntry !== null && newEntry.seen !== generation) newEntry = null;
  if (typing && newEntry !== null) {
    newEntry.input.focus({ preventScroll: true });
    newEntry.input.setSelectionRange(caret[0], caret[1]);
  }
  for (const [key, rec] of paneRows) {
    if (rec.seen === generation) continue;
    rec.remove?.();
    paneRows.delete(key);
  }
  for (const [key, rec] of fileRows) {
    if (rec.seen === generation) continue;
    rec.remove();
    fileRows.delete(key);
  }
  updateCurrent();
}

/**
 * The tiling area's state changed: renders the cards again as it needs. A change of layout or of
 * what a tile shows renders them now; a title or unsaved mark, soon; focus moves the current-row
 * marks.
 *
 * @param {ViewState} view
 */
export function onCardsViewState(view) {
  if (layoutSignature(view) !== shownLayout) {
    renderTree();
    return;
  }
  if (tileMarks(view) !== shownMarks) queueRender();
  updateCurrent();
}

/**
 * A server message, as the cards take it once `client.js` has applied it: what they keep about
 * it. The page's own handler renders.
 */
export function cardsMessage(msg) {
  switch (msg.type) {
    case 'hello':
      // A fetch asked for before a reconnect never gets its answer.
      fetchingRepos.clear();
      // Listings asked for while disconnected never got an answer.
      for (const { tree } of fileTrees.values()) tree.refresh('');
      // The server's own copy of each list may be gone (a restart): open Sessions rows list again.
      sessionLists.clear();
      prLists.clear();
      queueRender();
      break;
    case 'containers':
      relistForContainers();
      break;
    case 'agent_status':
      if (msg.agent_status === 'done' || msg.agent_status === 'idle') {
        sessionsAfterTurn(msg.container);
      }
      break;
  }
}

// ---------------------------------------------------------------------------------------------
// The saved sidebar state, and the rows kept across renders
// ---------------------------------------------------------------------------------------------

/** The tile rows' last render: the view's `layoutSignature` and `tileMarks` then. */
let shownLayout = '';
let shownMarks = '';

/**
 * Sidebar file rows (each a Golden Layout drag source) by tree key, kept across renders for the
 * same reason as {@link paneRows}.
 *
 * @type {Map<string, {row: HTMLElement, seen: number, remove: () => void}>}
 */
const fileRows = new Map();
/**
 * Sidebar pane rows by `container\npane`, kept across renders and updated in place. Each is a
 * Golden Layout drag source, and unregistering one tears down the document listeners of a drag
 * in progress — so a row (and its drag source) lives as long as its pane, not one render.
 *
 * @type {Map<string, {row: HTMLElement, c: any, pane: any, seen: number, remove: (() => void) | null}>}
 */
export const paneRows = new Map();
let renderGeneration = 0;
/**
 * The inline name row of a **New file…** / **New folder…** in progress: under folder `dir` of
 * file root `fr`, kept across renders (so typing survives them) until Enter creates the entry or
 * Escape cancels. A render that no longer shows its folder drops it. For a **Rename…**, `rename`
 * is the entry's path, and the row stands in place of that entry's own.
 *
 * @type {{fr: FileRoot, dir: string, kind: 'file' | 'dir', rename: string | null,
 *   row: HTMLElement, input: HTMLInputElement, error: HTMLElement, busy: boolean,
 *   seen: number} | null}
 */
let newEntry = null;
/** The tree key of a row just created, focused by the first render that shows it. */
let selectTreeKey = null;

export const SIDEBAR_KEY = 'devc-web-sidebar-v1';

/**
 * Collapsed containers (by local folder), repo cards' and containers' open parts, whether "Not
 * running" is open, which of its projects are expanded, and each repo's open folders, per
 * browser. Saved under {@link SIDEBAR_KEY} with the sidebar's own width and hidden state, which
 * are the page's (`app.js`): each saves its own fields and keeps the other's.
 */
/**
 * The sidebar's scope as saved in this browser, which a save writes: the page URL's `?scope=…`
 * (`scopeFromSearch`) only sets where the page starts, and is never saved; a scope change is.
 *
 * @type {import('./lib/sidebar.js').SidebarScope}
 */
let storedScope = savedScope(null);
export const sidebarState = loadSidebarState();

/** A scope change, saved from now on (the sidebar's scope picker). */
export function setStoredScope(/** @type {any} */ scope) {
  storedScope = scope;
}

function loadSidebarState() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(SIDEBAR_KEY) ?? 'null');
  } catch { /* unavailable or corrupt: everything starts expanded */ }
  return {
    collapsed: new Set(
      Array.isArray(saved?.collapsed)
        ? saved.collapsed.filter((f) => typeof f === 'string')
        : [],
    ),
    /** Repo cards (by `repoCardKey`) whose past sessions are shown; new ones start hidden. */
    cardHistoryOpen: new Set(
      Array.isArray(saved?.cardHistoryOpen)
        ? saved.cardHistoryOpen.filter((f) => typeof f === 'string')
        : [],
    ),
    /** Repo cards (by `repoCardKey`) kept in In use with nothing open (`sidebar.js` `setCardPinned`). */
    cardsPinned: new Set(
      Array.isArray(saved?.cardsPinned)
        ? saved.cardsPinned.filter((f) => typeof f === 'string')
        : [],
    ),
    /** Repo cards (by `repoCardKey`) whose worktrees' cards are hidden; new ones show them. */
    worktreesClosed: new Set(
      Array.isArray(saved?.worktreesClosed)
        ? saved.worktreesClosed.filter((f) => typeof f === 'string')
        : [],
    ),
    /** Containers (by local folder) whose Files row is open; new ones start closed. */
    containerFilesOpen: new Set(
      Array.isArray(saved?.containerFilesOpen)
        ? saved.containerFilesOpen.filter((f) => typeof f === 'string')
        : [],
    ),
    /** Repos (by `localFolder\nroot`) whose Pull request row is open; new ones start closed. */
    prOpen: new Set(
      Array.isArray(saved?.prOpen)
        ? saved.prOpen.filter((f) => typeof f === 'string')
        : [],
    ),
    /** PR folders opened or closed, by `prFoldersKey` then folder path. */
    prFolders: savedPrFolders(saved?.prFolders),
    /** Whether PR trees leave out Viewed files and fully viewed folders; off at first. */
    prHideViewed: saved?.prHideViewed === true,
    /**
     * PR files as one flat list by changed lines, `'most'` or `'fewest'` first, or (`null`, at
     * first) as a tree. A saved `true` is from before `'fewest'`.
     */
    prFlat: saved?.prFlat === true || saved?.prFlat === 'most'
      ? 'most'
      : saved?.prFlat === 'fewest'
      ? 'fewest'
      : null,
    /** Whether PR test files (`isTestPath`) are listed apart, under a Tests row; off at first. */
    prTestsApart: saved?.prTestsApart === true,
    /** Open card sections' last settled heights in px, by `data-section-key` (`holdSections`). */
    sectionHeights: savedSectionHeights(saved?.sectionHeights),
    inactiveOpen: saved?.inactiveOpen === true,
    projectsOpen: new Set(
      Array.isArray(saved?.projectsOpen)
        ? saved.projectsOpen.filter((f) => typeof f === 'string')
        : [],
    ),
    /** @type {Record<string, string[]>} repo folder (file root) → open paths ('' is the root) */
    filesOpen: savedFilesOpen(saved?.rootsOpen),
    pinnedOpen: saved?.pinnedOpen !== false,
    tasksOpen: saved?.tasksOpen !== false,
    containersOpen: saved?.containersOpen !== false,
    /** In use's and Tasks' dragged heights, as fractions of the zones'; null: default sizing. */
    inUseSize: savedFraction(saved?.inUseSize),
    tasksSize: savedFraction(saved?.tasksSize),
    /** Task groups (by `groupTasks` key) that are collapsed; new ones start open. */
    taskGroupsClosed: new Set(
      Array.isArray(saved?.taskGroupsClosed)
        ? saved.taskGroupsClosed.filter((f) => typeof f === 'string')
        : [],
    ),
    sentOpen: saved?.sentOpen === true,
    /**
     * What the sidebar shows: everything (`all`), or Tasks and the focused tile's container
     * (`container`) or repo card (`repo`). The page URL's `?scope=…` overrides what was saved.
     */
    scope: startingScope(saved),
  };
}

/** The scope at load: the page URL's `?scope=…` over what was saved, which {@link storedScope} keeps. */
function startingScope(saved) {
  storedScope = savedScope(saved);
  return scopeFromSearch(location.search) ?? storedScope;
}

function savedPrFolders(v) {
  /** @type {Record<string, Record<string, boolean>>} */
  const out = {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
  for (const [key, folders] of Object.entries(v)) {
    if (!folders || typeof folders !== 'object' || Array.isArray(folders)) {
      continue;
    }
    const kept = Object.fromEntries(
      Object.entries(folders).filter(([, open]) => typeof open === 'boolean'),
    );
    if (Object.keys(kept).length) out[key] = kept;
  }
  return out;
}

function savedSectionHeights(v) {
  /** @type {Record<string, number>} */
  const out = {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
  for (const [key, px] of Object.entries(v)) {
    if (typeof px === 'number' && px > 0) out[key] = px;
  }
  return out;
}

function savedFraction(v) {
  return typeof v === 'number' && v > 0 && v < 1 ? v : null;
}

function savedFilesOpen(v) {
  /** @type {Record<string, string[]>} */
  const out = {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
  for (const [folder, paths] of Object.entries(v)) {
    if (!Array.isArray(paths)) continue;
    const kept = paths.filter((p) => typeof p === 'string');
    if (kept.length) out[folder] = kept;
  }
  return out;
}

/**
 * What is saved under {@link SIDEBAR_KEY} now, as stored (null when nothing is, or it can't be
 * read): the sidebar's and the page's fields both.
 */
function storedSidebarState() {
  try {
    const saved = JSON.parse(localStorage.getItem(SIDEBAR_KEY) ?? 'null');
    return saved && typeof saved === 'object' ? saved : null;
  } catch {
    return null;
  }
}

export function saveSidebarState() {
  const saved = storedSidebarState();
  try {
    localStorage.setItem(
      SIDEBAR_KEY,
      JSON.stringify({
        collapsed: [...sidebarState.collapsed],
        cardHistoryOpen: [...sidebarState.cardHistoryOpen],
        cardsPinned: [...sidebarState.cardsPinned],
        worktreesClosed: [...sidebarState.worktreesClosed],
        containerFilesOpen: [...sidebarState.containerFilesOpen],
        prOpen: [...sidebarState.prOpen],
        prFolders: sidebarState.prFolders,
        prHideViewed: sidebarState.prHideViewed,
        prFlat: sidebarState.prFlat,
        prTestsApart: sidebarState.prTestsApart,
        sectionHeights: sidebarState.sectionHeights,
        inactiveOpen: sidebarState.inactiveOpen,
        projectsOpen: [...sidebarState.projectsOpen],
        // Not `filesOpen`: entries saved under that name were keyed by project, not by repo.
        rootsOpen: sidebarState.filesOpen,
        pinnedOpen: sidebarState.pinnedOpen,
        tasksOpen: sidebarState.tasksOpen,
        containersOpen: sidebarState.containersOpen,
        inUseSize: sidebarState.inUseSize,
        tasksSize: sidebarState.tasksSize,
        taskGroupsClosed: [...sidebarState.taskGroupsClosed],
        sentOpen: sidebarState.sentOpen,
        width: saved?.width,
        hidden: saved?.hidden,
        scope: storedScope,
      }),
    );
  } catch { /* storage unavailable: collapsing just won't survive a reload */ }
}

/** The most sections whose heights are kept: the oldest is dropped. */
const MAX_SECTION_HEIGHTS = 50;

/**
 * A card section still loading (a `Loading…` note in it: a pull request not yet listed, a folder
 * not yet read, sessions not yet listed) keeps the height it last had once loaded, saved across
 * reloads, so it doesn't collapse to one row and grow back. Call before layout.
 */
export function holdSections() {
  for (const el of $root.querySelectorAll('.card-section')) {
    const box = /** @type {HTMLElement} */ (el);
    const px = sidebarState.sectionHeights[box.dataset.sectionKey ?? ''];
    if (px && sectionLoading(box)) box.style.minHeight = `${px}px`;
  }
}

/** Saves the heights of the card sections that are loaded, after layout (`holdSections`). */
export function keepSectionHeights() {
  const heights = sidebarState.sectionHeights;
  let changed = false;
  for (const el of $root.querySelectorAll('.card-section')) {
    const box = /** @type {HTMLElement} */ (el);
    const key = box.dataset.sectionKey;
    if (!key || sectionLoading(box)) continue;
    const px = box.offsetHeight;
    if (px === 0 || heights[key] === px) continue;
    delete heights[key];
    heights[key] = px;
    changed = true;
  }
  if (!changed) return;
  for (const old of Object.keys(heights).slice(0, -MAX_SECTION_HEIGHTS)) {
    delete heights[old];
  }
  saveSidebarState();
}

/** @param {HTMLElement} box */
function sectionLoading(box) {
  return box.querySelector(':scope > .tree-note[data-note="loading"]') !== null;
}

/** A section heading; collapsible when `open` is given. */
export function sectionRow(title, open, onToggle, trail = '', oncontextmenu) {
  return h(
    'div',
    {
      class: 'row section',
      style: '--depth: 0',
      'aria-expanded': open === undefined ? undefined : String(open),
      onclick: onToggle,
      oncontextmenu,
    },
    h('span', { class: 'label' }, open === undefined ? '' : chevron(), title),
    trail,
  );
}

// ---------------------------------------------------------------------------------------------
// Repo cards: the model, and a card as In use and Containers both draw it
// ---------------------------------------------------------------------------------------------

/**
 * Every repo card (see `repoCardKey`): one per repo or worktree a listed container shows, in
 * {@link cardRepoOrder}, then one wherever a tile, pane or session is outside those (a repo no
 * longer listed, or outside every repo: `repo` null). A card holds its tiles in layout order, its
 * container's panes no tile shows, and its past sessions, newest first. Agent homes are shared, so
 * every container mounting a folder lists its sessions: each is on that folder's card in each of
 * them, to resume there, unless it runs in a pane of any of them (the pane's row stands for it,
 * on its own card only). A running container's sessions are listed the first time.
 */
export function repoCards() {
  /** @type {Map<string, any>} */
  const cards = new Map();
  const cardFor = (localFolder, repo) => {
    const key = repoCardKey(localFolder, repo?.folder ?? null);
    let card = cards.get(key);
    if (!card) {
      card = {
        key,
        localFolder,
        repo,
        order: cards.size,
        firstTile: Infinity,
        tiles: [],
        panes: [],
        sessions: [],
        active: false,
      };
      cards.set(key, card);
    }
    return card;
  };
  for (const c of containers.values()) {
    for (const r of cardRepoOrder(c.localFolder)) cardFor(c.localFolder, r);
  }
  layoutTiles(tileArea.state()).forEach((t, i) => {
    const { localFolder, repo } = tileRepo(t.tile);
    if (!localFolder) return;
    const card = cardFor(localFolder, repo);
    card.tiles.push(t);
    card.firstTile = Math.min(card.firstTile, i);
  });
  /** @type {{c: any, s: any}[]} */
  const listedSessions = [];
  const running = new Set();
  for (const c of containers.values()) {
    if (!listsSessions(c)) continue;
    const snap = c.state === 'connected' ? snapshots.get(c.id) : undefined;
    const repos = projectRepos(c.localFolder);
    const spaces = paneSpaces(snap);
    for (const pane of list(snap?.panes)) {
      if (tileShowing(c, pane)) continue;
      cardFor(
        c.localFolder,
        repoAt(repos, pane.foreground_cwd || pane.cwd || ''),
      )
        .panes.push({ c, pane, space: spaces.get(pane.pane_id) ?? '' });
    }
    const listed = sessionLists.get(c.id);
    if (!listed) {
      void loadSessions(c);
      continue;
    }
    for (const s of listed.error ? [] : listed.sessions) {
      if (sessionPane(c, s)) running.add(`${s.agent}\n${s.session}`);
      listedSessions.push({ c, s });
    }
  }
  for (const { c, s } of listedSessions) {
    if (running.has(`${s.agent}\n${s.session}`)) continue;
    const repo = projectRepos(c.localFolder).find((r) => r.folder === s.root);
    cardFor(c.localFolder, repo ?? null).sessions.push({ c, s });
  }
  for (const card of cards.values()) {
    card.sessions.sort((a, b) =>
      Date.parse(b.s.updatedAt) - Date.parse(a.s.updatedAt)
    );
    card.active = repoCardActive({
      tiles: card.tiles.length,
      agents: card.panes.filter(({ pane }) => pane.agent).length,
      pinned: sidebarState.cardsPinned.has(card.key),
    });
  }
  return cards;
}

/** A project's repos in card order: each repo, then its worktrees. */
function cardRepoOrder(localFolder) {
  const repos = shownRepos(localFolder);
  return topRepos(repos).flatMap((r) => [
    r,
    ...repos.filter((w) => w !== r && w.worktreeOf === r.folder),
  ]);
}

/** Each pane's Herdr space, by pane id, when a container has more than one; else none. */
function paneSpaces(snap) {
  const workspaces = list(snap?.workspaces).sort(byNumber);
  const out = new Map();
  if (workspaces.length < 2) return out;
  for (const ws of workspaces) {
    const space = ws.label || `space ${ws.number ?? ''}`;
    for (
      const pane of workspacePanes(ws, list(snap?.tabs), list(snap?.panes))
    ) {
      out.set(pane.pane_id, space);
    }
  }
  return out;
}

/**
 * The name an In use group goes by: its repo's sidebar name, a worktree's main repo's (its
 * branch says which worktree), split into a muted parent path and the name itself.
 */
export function repoGroupName(localFolder, repo) {
  const main = repo.primaryFolder ?? repo.worktreeOf;
  const named = main
    ? projectRepos(localFolder).find((r) => r.folder === main)
    : repo;
  return splitRepoName(named?.name ?? basename(main ?? repo.folder));
}

/** A repo's name as rows show it: the parent path muted, then the name itself. */
export function repoNameParts({ prefix, base }) {
  return [
    prefix ? h('span', { class: 'repo-prefix' }, prefix) : '',
    h('span', { class: 'repo-base' }, base),
  ];
}

/** A container's name as rows show it, running or not. */
export function containerNameOf(localFolder) {
  const c = containerByFolder(localFolder);
  if (c) return displayName(c);
  const project = projects.get(localFolder);
  return project
    ? containerLabel(project, projects.values())
    : basename(localFolder);
}

/**
 * A repo card, in In use or in its container's card: its header (repo name, branch and sync mark;
 * the container's name for the card of what is outside every repo), its terminals (tiles, then
 * panes no tile shows, shells too), then while their toggles are on its past sessions, its pull
 * request and its files. The toggles' state is the card's wherever it is shown. The header's click
 * hides what its toggles opened; with none open, a repo's card in Containers shows or hides its
 * worktrees' cards there (see `containerRows`), and any other does nothing and doesn't look
 * clickable. `worktrees` is how many worktrees' cards follow it in Containers, hidden or not.
 * `side` is the half drawing it (see {@link CardSide}).
 *
 * @param {any} card @param {CardSide} side @param {number} [worktrees]
 */
export function repoCard(card, side, worktrees = 0) {
  const { key, localFolder, repo } = card;
  const c = containerByFolder(localFolder);
  const fr = { localFolder, root: repo ? repo.folder : localFolder };
  const branch = repo?.git?.branch;
  // Opened before this page listed the container's sessions: a Loading… section holds its place.
  const listed = c ? sessionLists.get(c.id) : undefined;
  // Once listed, the toggle shows even with none, so an empty list reads as empty, not missing.
  const hasHistory = card.sessions.length > 0 ||
    (!!listed && !listed.loading && !!c && listsSessions(c));
  const historyOn = hasHistory && sidebarState.cardHistoryOpen.has(key);
  const historyLoading = !hasHistory && !!c &&
    sidebarState.cardHistoryOpen.has(key) &&
    (!listed || (listed.loading && !listed.error));
  const canPr = !!repo && !!c;
  // Fetch moves the repo's own remote-tracking ref, so it needs an upstream and its environment.
  const canFetch = !!repo && !!c && !!repo.git?.upstream;
  const prOn = canPr && sidebarState.prOpen.has(prKey(localFolder, fr.root));
  const tree = repo ? fileTree(fr) : null;
  const filesOn = !!tree && tree.isOpen('');
  const toggleHistory = () => {
    if (!sidebarState.cardHistoryOpen.delete(key)) {
      sidebarState.cardHistoryOpen.add(key);
    }
    saveSidebarState();
    side.folded('history', key, sidebarState.cardHistoryOpen.has(key));
    renderTree();
  };
  const worktreesHidden = worktrees > 0 &&
    sidebarState.worktreesClosed.has(key);
  const anyOpen = historyOn || prOn || filesOn;
  const headClick = () => {
    if (anyOpen) {
      sidebarState.cardHistoryOpen.delete(key);
      sidebarState.prOpen.delete(prKey(localFolder, fr.root));
      saveSidebarState();
      side.folded('history', key, false);
      side.folded('pr', prKey(localFolder, fr.root), false);
      // Saves and renders again itself.
      if (filesOn) tree.collapse('');
      else renderTree();
    } else if (worktrees > 0) {
      if (!sidebarState.worktreesClosed.delete(key)) {
        sidebarState.worktreesClosed.add(key);
      }
      saveSidebarState();
      renderTree();
    }
  };
  const idle = card.tiles.length === 0 && card.panes.length === 0;
  const head = treeRow(
    key,
    0,
    // A chevron on a repo's card with worktrees' cards under it, open while they show.
    worktrees > 0 ? !worktreesHidden : undefined,
    {
      // Nothing runs in it: its name is muted, so what is at work stands out.
      class: [
        'repo-card-head',
        idle ? 'idle' : '',
        anyOpen || worktrees > 0 ? '' : 'inert',
      ].filter((k) => k).join(' '),
      // Its path in the container, then where that is mounted from on the host.
      title: [
        repo?.containerFolder ?? repo?.folder ?? localFolder,
        repo?.containerFolder ? `Host: ${repo.folder}` : '',
        branch ? `Branch: ${branch}` : '',
        worktreesHidden ? LABELS.worktreesHidden(worktrees) : '',
      ].filter((t) => t).join('\n'),
      onclick: anyOpen || worktrees > 0 ? headClick : undefined,
      oncontextmenu: (e) =>
        openMenu(
          e,
          [
            ...(repo
              ? [
                ...(canFetch
                  ? [[LABELS.fetch, () => fetchRepo(localFolder, repo.folder)]]
                  : []),
                // devc-desktop shows its own push plan, and the user confirms it there.
                ...(desktopChannel
                  ? [[
                    LABELS.requestPush,
                    () => requestPush(localFolder, repo.folder),
                  ]]
                  : []),
                ...(canFetch || desktopChannel ? [null] : []),
                ...dirMenuItems(fr, ''),
                ...jiraItems(branch),
              ]
              : projectMenuItems(localFolder)),
            null,
            pinnedCardItem(key, side),
          ],
        ),
    },
    ...(repo
      ? [
        ...repoNameParts(repoGroupName(localFolder, repo)),
        branch ? h('span', { class: 'repo-branch' }, branch) : '',
        gitMark(
          gitSync(
            repo.git,
            repo.gitProblem,
            repo.changes,
            repo.changesProblem,
          ),
          canFetch
            ? {
              fetching: fetchingRepos.has(repo.folder),
              fetch: () => fetchRepo(localFolder, repo.folder),
            }
            : undefined,
        ),
      ]
      : [h('span', { class: 'repo-base' }, containerNameOf(localFolder))]),
    cardPinMark(key, side),
  );
  /** @type {[string, string, boolean, () => void][]} */
  const toggles = [];
  if (hasHistory) {
    toggles.push([
      'history',
      historyOn
        ? LABELS.hidePastSessions
        : LABELS.showPastSessions(card.sessions.length),
      historyOn,
      toggleHistory,
    ]);
  }
  if (canPr) {
    toggles.push([
      'pullRequest',
      LABELS.pullRequest,
      prOn,
      () => {
        togglePr(localFolder, fr.root);
        side.folded(
          'pr',
          prKey(localFolder, fr.root),
          sidebarState.prOpen.has(prKey(localFolder, fr.root)),
        );
      },
    ]);
  }
  if (tree) {
    toggles.push(['folder', LABELS.files, filesOn, () => tree.toggle('')]);
  }
  const toggleButton = ([icon, title, on, action]) => {
    const b = iconButton(icon, title, action);
    b.setAttribute('aria-pressed', String(on));
    return b;
  };
  // The toggles that are on stay in sight, where the hover strip that covers them has them: from
  // the first one on, with the toggles and new-terminal buttons after it kept as blank slots.
  const firstOn = toggles.findIndex((t) => t[2]);
  const newButtons = () => c ? newTerminalButtons(head, fr, '') : [];
  const slot = (b) => {
    b.classList.add('slot');
    return b;
  };
  head.append(
    rowTrail(
      h(
        'span',
        { class: 'row-toggles' },
        ...(firstOn < 0 ? [] : [
          ...toggles.slice(firstOn).map((t) =>
            t[2] ? toggleButton(t) : slot(toggleButton(t))
          ),
          ...newButtons().map(slot),
        ]),
      ),
      hoverActions(...toggles.map(toggleButton), ...newButtons()),
    ),
  );
  const now = Date.now();
  const rows = [head];
  for (const { tile, active } of card.tiles) {
    rows.push(layoutTileRow(tile, active, 1));
  }
  for (const { c: pc, pane, space } of card.panes) {
    rows.push(paneRow(pc, pane, 1, space));
  }
  // Each open section scrolls in a box of capped height, so a long one doesn't stretch the zone.
  const section = (name, sectionRows) =>
    h('div', {
      class: 'card-section',
      'data-section-key': `${key}\n${name}`,
    }, ...sectionRows);
  if (historyOn) {
    rows.push(section(
      'history',
      card.sessions.length
        ? card.sessions.map(({ c: sc, s }) => sessionRow(sc, s, now, 1))
        : [
          h(
            'div',
            {
              class: 'row tree-note',
              style: '--depth: 1',
              'data-note': 'empty',
            },
            h(
              'span',
              { class: 'label' },
              listed?.error
                ? `Couldn't list sessions: ${listed.error}`
                : 'No past sessions',
            ),
          ),
        ],
    ));
  } else if (historyLoading) {
    rows.push(section('history', [
      h(
        'div',
        {
          class: 'row tree-note',
          style: '--depth: 1',
          'data-note': 'loading',
        },
        h('span', { class: 'label' }, 'Loading…'),
      ),
    ]));
  }
  // The open Pull request row's contents, without the row: the toggle stands for it.
  if (prOn) {
    rows.push(section('pr', prRows(localFolder, fr.root, 0).slice(1)));
  }
  if (filesOn) rows.push(section('files', rootEntryRows(fr, 1)));
  return h('div', { class: 'repo-card', 'data-card-key': key }, ...rows);
}

/** A Layout tile row's classes: `background` behind its stack's front tab, `preview` (italic). */
function tileRowClass(tile, active) {
  return [
    'row layout-node tile',
    active ? '' : 'background',
    tile.preview ? 'preview' : '',
  ].filter((s) => s).join(' ');
}

/**
 * A tile's row in its In use card: what it is doing, and its pane's Open in Code on a right-click;
 * the card names its folder and container.
 */
export function layoutTileRow(tile, active, depth) {
  if (tile.kind === 'file') return layoutFileTileRow(tile, active, depth);
  if (tile.kind === 'diff') return layoutDiffTileRow(tile, active, depth);
  const { c, pane } = resolveRef(tile.ref);
  return h(
    'div',
    {
      class: tileRowClass(tile, active),
      style: `--depth: ${depth}`,
      'data-tile': tile.id,
      'data-pane-key': c && tile.ref
        ? paneKey(c.id, tile.ref.pane_id)
        : undefined,
      title: [...refTooltip(tile.ref), active ? '' : 'Background tab']
        .filter((s) => s).join('\n') || undefined,
      onclick: () => tileArea.reveal(tile.id),
      oncontextmenu: (e) =>
        openMenu(e, [
          ...(c && pane ? paneCodeItems(c, pane) : []),
          ...tileMenuItems(tile),
        ]),
    },
    h(
      'span',
      { class: 'label' },
      rowIcon({ agent: pane?.agent, empty: !tile.ref }),
      inUseLabel(refLabel(tile.ref)),
    ),
    rowTrail(
      badge(pane),
      hoverActions(
        c && pane
          ? iconButton('trash', LABELS.close, () => killPane(c, pane))
          : '',
        iconButton('close', 'Close tile', () => tileArea.close(tile.id)),
      ),
    ),
  );
}

/** A file tile's Layout row: the file's name, its host path as the tooltip. */
function layoutFileTileRow(tile, active, depth) {
  return h(
    'div',
    {
      class: tileRowClass(tile, active),
      style: `--depth: ${depth}`,
      'data-tile': tile.id,
      title: [
        tile.file ? fileHostPath(tile.file) : '',
        active ? '' : 'Background tab',
      ].filter((s) => s).join('\n') || undefined,
      onclick: () => tileArea.reveal(tile.id),
      oncontextmenu: (e) => openMenu(e, tileMenuItems(tile)),
    },
    h(
      'span',
      { class: 'label' },
      rowIcon({ kind: 'file' }),
      tile.title,
    ),
    rowTrail(
      hoverActions(
        iconButton('close', 'Close tile', () => tileArea.close(tile.id)),
      ),
    ),
  );
}

/** A diff tile's Layout row: its title, the PR file's path as the tooltip. */
function layoutDiffTileRow(tile, active, depth) {
  return h(
    'div',
    {
      class: tileRowClass(tile, active),
      style: `--depth: ${depth}`,
      'data-tile': tile.id,
      title: [tile.diff?.path ?? '', active ? '' : 'Background tab']
        .filter((s) => s).join('\n') || undefined,
      onclick: () => tileArea.reveal(tile.id),
      oncontextmenu: (e) => openMenu(e, tileMenuItems(tile)),
    },
    h(
      'span',
      { class: 'label' },
      rowIcon({ kind: 'file' }),
      tile.title,
    ),
    rowTrail(
      hoverActions(
        iconButton('close', 'Close tile', () => tileArea.close(tile.id)),
      ),
    ),
  );
}

/** Marks the focused tile's rows in In use and its pane's rows in Containers. */
export function updateCurrent() {
  const tile = focusedTile(tileArea.state());
  const { c } = resolveRef(tile?.ref ?? null);
  const key = c && tile?.ref ? paneKey(c.id, tile.ref.pane_id) : null;
  for (const row of $root.querySelectorAll('[data-current]')) {
    row.removeAttribute('data-current');
  }
  if (!tile) return;
  for (const row of $root.querySelectorAll('.row')) {
    const el = /** @type {HTMLElement} */ (row);
    if (
      el.dataset.tile === tile.id ||
      (key && el.classList.contains('pane') && el.dataset.paneKey === key)
    ) {
      el.setAttribute('data-current', '');
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Repo cards: panes, pins and past sessions
// ---------------------------------------------------------------------------------------------

/** Whether some tile shows the pane. */
function isVisible(c, pane) {
  return tileShowing(c, pane) !== null;
}

/** The most recently focused tile showing the pane, if any. */
export function tileShowing(c, pane) {
  return tileShowingPane(tileArea.state(), {
    localFolder: c.localFolder,
    pane_id: pane.pane_id,
  });
}

/** A workspace's panes in Herdr's order: by tab number, then as listed within the tab. */
function workspacePanes(ws, tabs, panes) {
  const wsTabs = tabs.filter((t) => t.workspace_id === ws.workspace_id)
    .sort(byNumber);
  return wsTabs.flatMap((tab) => panes.filter((p) => p.tab_id === tab.tab_id));
}

/**
 * "Pin to In use" or "Unpin from In use" for a repo card's menus, as `side` pins (see
 * {@link CardSide}).
 *
 * @param {string} key @param {CardSide} side
 * @returns {import('./ui.js').MenuItem}
 */
export function pinnedCardItem(key, side) {
  const pinned = side.pinned(key);
  return [
    pinned ? LABELS.unpinCard : LABELS.pinCard,
    () => side.pin(key, !pinned),
  ];
}

/** A pin glyph after a pinned repo card's name; its click unpins the card. @param {CardSide} side */
function cardPinMark(key, side) {
  if (!side.pinned(key)) return '';
  const mark = h('span', {
    class: 'pin-mark card-pin-mark',
    title: LABELS.unpinCard,
    onclick: (e) => {
      e.stopPropagation();
      side.pin(key, false);
    },
  });
  mark.append(svgIcon('pin'));
  return mark;
}

/**
 * Each running container's last `list_sessions` answer, by container id. `sessions` stays from
 * the previous answer while a new one loads.
 *
 * @type {Map<string, {loading: boolean, sessions: import('./lib/sessions.js').AgentSession[],
 *   error: string | null}>}
 */
const sessionLists = new Map();

/**
 * Whether a container's past sessions are listed: once Herdr is up, and before its session is
 * (the server reads them with `docker exec`, and resuming one starts the session).
 */
export function listsSessions(c) {
  return c.state === 'connected' || c.state === 'no-session';
}

/** Pending re-lists after an agent's turn, by container id: a burst of statuses lists once. */
const turnRelists = new Map();

/** Lists container `id`'s sessions again shortly after one of its agents finishes a turn. */
export function sessionsAfterTurn(id) {
  clearTimeout(turnRelists.get(id));
  turnRelists.set(
    id,
    setTimeout(() => {
      turnRelists.delete(id);
      const c = containers.get(id);
      if (c && listsSessions(c)) void loadSessions(c);
    }, 1500),
  );
}

/** Lists a container's recent agent sessions again (`list_sessions`). */
export async function loadSessions(c) {
  const prev = sessionLists.get(c.id);
  if (prev?.loading) return;
  const entry = { loading: true, sessions: prev?.sessions ?? [], error: null };
  sessionLists.set(c.id, entry);
  queueRender();
  try {
    entry.sessions = parseSessions(
      await call({ type: 'list_sessions', container: c.id }),
    );
  } catch (e) {
    entry.error = String(e?.message ?? e);
  }
  entry.loading = false;
  if (sessionLists.get(c.id) === entry) queueRender();
}

/**
 * One past session in its repo card: its agent's icon, title and age, after the status of the pane
 * running it, if one is. A click resumes it (the server reuses the pane it runs in).
 *
 * @param {import('./lib/sessions.js').AgentSession} s
 */
function sessionRow(c, s, now, depth) {
  return h(
    'div',
    {
      class: 'row agent-session',
      style: `--depth: ${depth}`,
      'data-session': s.session,
      title: sessionTooltip(s, LABELS.agents[s.agent]),
      onclick: () => void resumeSession(c, s),
      oncontextmenu: (e) =>
        openMenu(e, [
          [LABELS.resumeSession, () => void resumeSession(c, s)],
          [LABELS.copySessionId, () => copyText(s.session)],
        ]),
    },
    // In the slot a chevron would take, as a terminal's and a Sent task's. The age (and a
    // running pane's status) always shows.
    h('span', { class: 'label' }, rowIcon({ agent: s.agent }), s.title),
    rowTrail(
      badge(sessionPane(c, s)),
      h('span', { class: 'pane-title' }, sessionAge(s.updatedAt, now)),
    ),
  );
}

/** Sessions with a `resume_session` in flight: a second click waits for the first. */
const resumingSessions = new Set();

/**
 * A listed session in the focused stack: the pane this server resumed it in while that is still
 * open, else resumed in a new tab at the folder it started in (`resume_session`).
 *
 * @param {import('./lib/sessions.js').AgentSession} s
 */
async function resumeSession(c, s) {
  const key = `${c.id}\n${s.agent}\n${s.session}`;
  if (resumingSessions.has(key)) return;
  if (c.state === 'no-session') toast('Starting Herdr…');
  resumingSessions.add(key);
  let result;
  try {
    result = await call({
      type: 'resume_session',
      container: c.id,
      agent: s.agent,
      session: s.session,
    });
  } catch (e) {
    if (e?.code === 'not_found') {
      // The server no longer lists it (a restart, or another window listed since): list again.
      void loadSessions(c);
      errorToast('That session is no longer listed: the list was refreshed');
    } else errorToast(`Resume failed: ${e?.message ?? e}`);
    return;
  } finally {
    resumingSessions.delete(key);
  }
  if (typeof result?.pane_id !== 'string') return;
  placePane(c.localFolder, result);
  // List again once the agent has had time to start, so the list knows the pane it runs in.
  if (!result.reused) setTimeout(() => void loadSessions(c), 5000);
}

// ---------------------------------------------------------------------------------------------
// Repo cards: the git mark, and Fetch
// ---------------------------------------------------------------------------------------------

/**
 * ● changes to commit, ↑ push / ↓ pull counts, or a quiet ✓ / ?, from `gitSync` or `gitRollup`;
 * nothing for no repo. With `opts.fetch` (a repo card's), a click on ↓ fetches; with
 * `opts.fetching`, a spinner follows the counts.
 *
 * @param {{fetch: () => void, fetching: boolean}} [opts]
 */
export function gitMark(sync, opts) {
  if (!sync) return '';
  return h(
    'span',
    {
      class: 'git-sync',
      title: sync.title,
      'data-diverged': sync.diverged,
    },
    ...sync.marks.map((m) =>
      opts && m.dir === 'behind'
        ? h('span', {
          'data-dir': m.dir,
          class: 'git-fetch',
          role: 'button',
          title: LABELS.fetchBehind,
          onclick: (/** @type {MouseEvent} */ e) => {
            // Not the card head's own click.
            e.stopPropagation();
            opts.fetch();
          },
        }, m.text)
        : h('span', { 'data-dir': m.dir }, m.text)
    ),
    opts?.fetching
      ? h('span', { class: 'spinner git-fetching', 'aria-hidden': 'true' })
      : '',
  );
}

/** Repo folders with a `fetch_repo` in flight → its request id. */
const fetchingRepos = new Map();

/**
 * Fetches a repo of a running project (`fetch_repo`): its own remote-tracking branch moves, its
 * ↓ count updates once the server reads it again. A second click while one runs does nothing; a
 * problem is a toast.
 */
function fetchRepo(localFolder, folder) {
  if (fetchingRepos.has(folder)) return;
  const id = nextId('f');
  // A refused message comes back as a `result`: `client.js` toasts it.
  pendingRequests.set(id, LABELS.fetch);
  fetchingRepos.set(folder, id);
  send({ type: 'fetch_repo', id, localFolder, folder });
  renderTree();
}

/**
 * A `fetch_result`, or a `result` refusing a `fetch_repo`: the spinner stops. Returns whether it
 * was one of this page's fetches.
 */
export function onFetchDone(msg) {
  let ours = false;
  for (const [folder, id] of fetchingRepos) {
    if (id === msg.id) {
      fetchingRepos.delete(folder);
      ours = true;
    }
  }
  if (msg.type !== 'fetch_result') return ours;
  pendingRequests.delete(msg.id);
  if (!msg.ok) {
    errorToast(`${LABELS.fetch} failed: ${msg.problem ?? 'unknown problem'}`);
  }
  return ours;
}

/** The repos listed at the top of a Repos view: all but the worktrees listed under their repo. */
function topRepos(repos) {
  const folders = new Set(repos.map((r) => r.folder));
  // A worktree whose repo has no row of its own is listed as a repo.
  return repos.filter((r) => !r.worktreeOf || !folders.has(r.worktreeOf));
}

/**
 * A project's repos as its Repos view lists them: the project folder always; a later folder
 * that turned out to be no repo (`git: null` with no `gitProblem`) not. One whose status can't
 * be read stays, marked `?`.
 */
function shownRepos(localFolder) {
  return projectRepos(localFolder).filter((r, i) =>
    i === 0 || r.git !== null || !!r.gitProblem
  );
}

// ---------------------------------------------------------------------------------------------
// Repo cards: pull requests
// ---------------------------------------------------------------------------------------------

/**
 * Each repo's last `pr_files` answer, by `localFolder\nroot`: what its Pull request row shows.
 * `result` is the server's `{available, …}`; `error` a failed call's message; `review` the
 * viewer's pending review (`pr_pending_show`, read when the grants offer reviews).
 *
 * @type {Map<string, {loading: boolean, result: any, error: string | null,
 *   review: {id: string, comments: number} | null}>}
 */
const prLists = new Map();

function prKey(localFolder, root) {
  return `${localFolder}\n${root}`;
}

/** Lists a repo's PR files again (`pr_files`), keeping what is shown until the answer. */
async function loadPr(localFolder, root) {
  const key = prKey(localFolder, root);
  const prev = prLists.get(key);
  if (prev?.loading) return;
  const entry = {
    loading: true,
    result: prev?.result ?? null,
    error: null,
    review: prev?.review ?? null,
  };
  prLists.set(key, entry);
  queueRender();
  try {
    const result = await call({ type: 'pr_files', localFolder, root });
    entry.result = result && typeof result === 'object' ? result : null;
  } catch (e) {
    entry.result = null;
    entry.error = String(e?.message ?? e);
  }
  entry.review = entry.result?.canReview === true
    ? await pendingReview(localFolder, root, entry.review)
    : null;
  entry.loading = false;
  if (prLists.get(key) === entry) queueRender();
}

/** The viewer's pending review on a repo's PR (`pr_pending_show`); `kept` when it can't be read. */
async function pendingReview(localFolder, root, kept) {
  try {
    const r = await call({ type: 'pr_pending_show', localFolder, root });
    return r?.available === true ? r.review ?? null : kept;
  } catch {
    return kept;
  }
}

/** Opens or closes a repo's Pull request row; opening it lists the PR's files. */
function togglePr(localFolder, root) {
  const key = prKey(localFolder, root);
  if (!sidebarState.prOpen.delete(key)) {
    sidebarState.prOpen.add(key);
    void loadPr(localFolder, root);
  }
  saveSidebarState();
  renderTree();
}

/** Where a PR's folder rows keep their open state: per repo and PR number. */
function prFoldersKey(localFolder, root, number) {
  return `${localFolder}\n${root}\n${number}`;
}

/**
 * Each PR folder's open-by-default state as it was when this page first drew it, by
 * `prFoldersKey\npath`: a folder whose last file is marked Viewed stays open until closed.
 */
const prFolderDefaults = new Map();

/** @param {string} key @param {import('./lib/pr_tree.js').PrDir} dir */
function prFolderOpen(key, dir) {
  const saved = sidebarState.prFolders[key]?.[dir.path];
  if (saved !== undefined) return saved;
  const id = `${key}\n${dir.path}`;
  if (!prFolderDefaults.has(id)) {
    prFolderDefaults.set(id, folderOpenByDefault(dir));
  }
  return prFolderDefaults.get(id);
}

/** The most PRs whose folders' open state is kept: the oldest is dropped. */
const MAX_PR_FOLDER_KEYS = 50;

/** @param {string} key @param {import('./lib/pr_tree.js').PrDir} dir */
function togglePrFolder(key, dir) {
  const open = prFolderOpen(key, dir);
  const folders = sidebarState.prFolders[key] ?? {};
  delete sidebarState.prFolders[key];
  sidebarState.prFolders[key] = { ...folders, [dir.path]: !open };
  const keys = Object.keys(sidebarState.prFolders);
  for (const old of keys.slice(0, -MAX_PR_FOLDER_KEYS)) {
    delete sidebarState.prFolders[old];
  }
  saveSidebarState();
  renderTree();
}

/**
 * A running container's repo's Pull request row: closed until opened. Open, the PR of the repo's
 * pinned branch (`pr_files`): a header row and its changed files as a tree, or one dimmed line
 * saying why there is none.
 */
function prRows(localFolder, root, depth) {
  const key = prKey(localFolder, root);
  const open = sidebarState.prOpen.has(key);
  const fr = { localFolder, root };
  const rows = [
    treeRow(`${treeId(fr)}\npr`, depth, open, {
      class: 'pr-row',
      title:
        "The pull request of this repo's pinned branch, through its container's devc-bridge",
      onclick: () => togglePr(localFolder, root),
    }, LABELS.pullRequest),
  ];
  if (!open) return rows;
  // Opened before this page listed it (a saved open row): list now.
  if (!prLists.has(key)) void loadPr(localFolder, root);
  const listed = prLists.get(key);
  const note = (text, kind) =>
    h(
      'div',
      {
        class: 'row tree-note',
        style: `--depth: ${depth + 1}`,
        'data-note': kind,
        title: text,
      },
      h('span', { class: 'label' }, ...markedText(text)),
    );
  const result = listed?.result;
  if (listed?.error) rows.push(note(listed.error, 'error'));
  else if (!result) rows.push(note('Loading…', 'loading'));
  else if (result.available !== true) {
    const hint = result.reason === 'no_grant' ||
      result.reason === 'not_running';
    rows.push(note(String(result.message ?? ''), hint ? 'hint' : 'error'));
  } else rows.push(...prListingRows(fr, result, depth + 1));
  return rows;
}

/**
 * A listed PR's header row, then its files as a tree (`buildPrTree`) or, with Flat, by size on,
 * as one list, most or fewest changed lines first (`buildPrFlat`). With Tests apart on, the
 * test files (`isTestPath`) are left out of that and listed the same way under a Tests row.
 */
function prListingRows(fr, result, depth) {
  const pr = result.pr;
  const review = prLists.get(prKey(fr.localFolder, fr.root))?.review ?? null;
  const files = list(result.files);
  const flat = sidebarState.prFlat;
  const tree = flat ? buildPrFlat(files, flat) : buildPrTree(files);
  const percent = viewedPercent(tree);
  const id = treeId(fr);
  const header = treeRow(
    `${id}\npr\n#`,
    depth,
    undefined,
    {
      class: 'pr-header',
      title: [
        `${pr.repo}#${pr.number}`,
        pr.title,
        `${pr.headRef} → ${pr.baseRef}${pr.author ? ` · ${pr.author}` : ''}`,
        `via ${result.container}'s bridge`,
      ].join('\n'),
    },
    h('span', { class: 'pr-number' }, `#${pr.number}`),
    ...markedText(
      pr.title,
    ),
  );
  const hiding = sidebarState.prHideViewed;
  const apart = sidebarState.prTestsApart;
  const buttons = () => {
    const testsToggle = iconButton(
      'tests',
      apart ? LABELS.testsTogether : LABELS.testsApart,
      togglePrTestsApart,
    );
    testsToggle.setAttribute('aria-pressed', String(apart));
    const toggle = iconButton(
      'viewed',
      hiding ? LABELS.showViewed(tree.viewed) : LABELS.hideViewed,
      togglePrHideViewed,
    );
    toggle.setAttribute('aria-pressed', String(hiding));
    // Its title says what a click does next: tree, then most first, then fewest first.
    const flatToggle = iconButton(
      flat === 'fewest' ? 'flatBySizeFewest' : 'flatBySize',
      flat === 'most'
        ? LABELS.flatBySizeFewest
        : flat === 'fewest'
        ? LABELS.flatOff
        : LABELS.flatBySize,
      togglePrFlat,
    );
    flatToggle.setAttribute('aria-pressed', String(flat !== null));
    return [
      testsToggle,
      flatToggle,
      toggle,
      iconButton(
        'refresh',
        'Refresh',
        () => void loadPr(fr.localFolder, fr.root),
      ),
      iconButton(
        'external',
        'Open on GitHub',
        () => window.open(pr.url, '_blank', 'noopener'),
      ),
    ];
  };
  header.append(rowTrail(
    pr.state !== 'OPEN'
      ? h('span', { class: 'pr-state' }, String(pr.state).toLowerCase())
      : '',
    pr.isDraft ? h('span', { class: 'pr-state' }, 'draft') : '',
    review ? pendingReviewBar(fr, pr, review) : '',
    h('span', {
      class: 'pr-count',
      title: LABELS.viewedPercent(percent, tree.viewedLines, tree.totalLines),
    }, `${tree.viewed}/${tree.total} · ${percent}%`),
    // Flat, by size and Hide viewed, while on, stay in sight as a repo card's toggles do, the
    // other buttons kept as blank slots so each sits where hovering shows it.
    h(
      'span',
      { class: 'row-toggles' },
      ...(hiding || flat || apart
        ? buttons().map((b) => {
          if (b.getAttribute('aria-pressed') !== 'true') {
            b.classList.add('slot');
          }
          return b;
        })
        : []),
    ),
    hoverActions(...buttons()),
  ));
  const rows = [header];
  if (result.truncated) {
    rows.push(
      h(
        'div',
        {
          class: 'row tree-note',
          style: `--depth: ${depth}`,
          'data-note': 'truncated',
        },
        h('span', { class: 'label' }, 'GitHub lists at most 3000 files'),
      ),
    );
  }
  const foldersKey = prFoldersKey(fr.localFolder, fr.root, pr.number);
  // The Tests row's tree keeps its folders' state, and its rows' ids, apart from the Files row's:
  // a folder can be in both. The Files row's own state is its tree's root ('') under `foldersKey`.
  const testsKey = `${foldersKey}\ntests`;
  const walk = (dir, d, key = foldersKey, idPrefix = '') => {
    for (const sub of dir.dirs) {
      const open = prFolderOpen(key, sub);
      const row = treeRow(`${id}\npr\n${idPrefix}${sub.path}/`, d, open, {
        class: 'pr-dir',
        'data-dim': sub.viewed === sub.total || undefined,
        title: sub.path,
        onclick: () => togglePrFolder(key, sub),
        oncontextmenu: (e) => openMenu(e, prDirMenuItems(fr, result, sub)),
      }, ...markedText(sub.name));
      row.append(
        rowTrail(
          h('span', { class: 'pr-count' }, `${sub.viewed}/${sub.total}`),
        ),
      );
      rows.push(row);
      if (open) walk(sub, d + 1, key, idPrefix);
    }
    for (const node of dir.files) {
      rows.push(prFileRow(fr, result, node, d));
    }
  };
  const shown = (t) => hiding ? withoutViewed(t) : t;
  const build = (fs) => flat ? buildPrFlat(fs, flat) : buildPrTree(fs);
  const testFiles = apart ? files.filter((f) => isTestPath(f.path)) : [];
  if (testFiles.length === 0) walk(shown(tree), depth);
  else {
    /** @type {[string, string, string, string, any][]} */
    const groups = [
      [
        'files',
        foldersKey,
        LABELS.otherFiles,
        LABELS.otherFilesTitle,
        build(files.filter((f) => !isTestPath(f.path))),
      ],
      ['tests', testsKey, LABELS.tests, LABELS.testFiles, build(testFiles)],
    ];
    for (const [name, key, label, title, group] of groups) {
      if (group.total === 0 || (hiding && group.viewed === group.total)) {
        continue;
      }
      rows.push(
        prGroupRow(fr, result, `${id}\npr\n${name}\n`, key, group, depth, {
          label,
          title,
        }),
      );
      if (prFolderOpen(key, group)) {
        walk(shown(group), depth + 1, key, name === 'tests' ? 'tests\n' : '');
      }
    }
  }
  if (hiding && tree.total > 0 && tree.viewed === tree.total) {
    rows.push(
      h(
        'div',
        {
          class: 'row tree-note',
          style: `--depth: ${depth}`,
          'data-note': 'all-viewed',
        },
        h('span', { class: 'label' }, LABELS.allViewedHidden(tree.total)),
      ),
    );
  }
  return rows;
}

/**
 * A Files or Tests row (Tests apart): its files' Viewed count and share of their changed lines;
 * it opens and closes as a folder does (`group` the root of its tree, under `key`), and its menu
 * marks them all Viewed or not.
 *
 * @param {FileRoot} fr @param {any} result @param {string} rowId @param {string} key
 * @param {import('./lib/pr_tree.js').PrDir} group
 * @param {number} depth @param {{label: string, title: string}} text
 */
function prGroupRow(fr, result, rowId, key, group, depth, { label, title }) {
  const allViewed = group.viewed === group.total;
  const percent = viewedPercent(group);
  const row = treeRow(
    rowId,
    depth,
    prFolderOpen(key, group),
    {
      class: 'pr-dir pr-group',
      'data-dim': allViewed || undefined,
      title,
      onclick: () => togglePrFolder(key, group),
      oncontextmenu: result.canViewed
        ? (e) =>
          openMenu(e, [[
            allViewed ? 'Mark all as not viewed' : 'Mark all as viewed',
            () => void setFolderViewed(fr, group, !allViewed),
          ]])
        : undefined,
    },
    label,
  );
  row.append(rowTrail(h('span', {
    class: 'pr-count',
    title: LABELS.viewedPercent(percent, group.viewedLines, group.totalLines),
  }, `${group.viewed}/${group.total} · ${percent}%`)));
  return row;
}

/**
 * The PR header's `Review · n pending`, with **Submit review…** and **Discard review…**; either
 * lists the PR again after.
 *
 * @param {FileRoot} fr @param {any} pr @param {{comments: number}} review
 */
function pendingReviewBar(fr, pr, review) {
  const repo = { localFolder: fr.localFolder, root: fr.root };
  const stop = (e) => e.stopPropagation();
  /** @param {string} label @param {() => Promise<boolean>} act */
  const button = (label, act) =>
    h('button', {
      type: 'button',
      class: 'pr-review-action',
      onmousedown: stop,
      ondblclick: stop,
      onclick: async (e) => {
        e.stopPropagation();
        if (await act()) void loadPr(fr.localFolder, fr.root);
      },
    }, label);
  return h(
    'span',
    { class: 'pr-pending' },
    LABELS.reviewPending(review.comments),
    button(LABELS.submitReview, () => submitPendingReview(repo, pr.url)),
    button(LABELS.discardReview, () => discardPendingReview(repo)),
  );
}

/** Lists every PR's test files apart, under a Tests row, or among the rest again; kept per browser. */
function togglePrTestsApart() {
  sidebarState.prTestsApart = !sidebarState.prTestsApart;
  saveSidebarState();
  renderTree();
}

/**
 * Lists every PR's files flat, most changed lines first, then fewest first, then as a tree again;
 * kept per browser.
 */
function togglePrFlat() {
  const flat = sidebarState.prFlat;
  sidebarState.prFlat = flat === null
    ? 'most'
    : flat === 'most'
    ? 'fewest'
    : null;
  saveSidebarState();
  renderTree();
}

/** Shows or hides every PR tree's Viewed files (the PR header's eye), kept per browser. */
function togglePrHideViewed() {
  sidebarState.prHideViewed = !sidebarState.prHideViewed;
  saveSidebarState();
  renderTree();
}

/**
 * A PR file's row: its Viewed checkbox (GitHub's own state; disabled without `canViewed`), its
 * status letter, name and `+a −d`. A click opens its diff tile as a Files click opens a file.
 *
 * @param {FileRoot} fr @param {any} result
 * @param {import('./lib/pr_tree.js').PrFileNode} node
 */
function prFileRow(fr, result, node, depth) {
  const file = node.file;
  const letter = statusLetter(file.status);
  const dismissed = file.viewed === 'DISMISSED';
  const stop = (e) => e.stopPropagation();
  const checkbox = h('input', {
    type: 'checkbox',
    class: 'pr-viewed',
    'aria-label': `Viewed: ${file.path}`,
    title: !result.canViewed
      ? 'Marking Viewed needs --bridge-allow gh-pr-viewed'
      : dismissed
      ? 'Viewed, changed since viewed'
      : 'Viewed',
    disabled: !result.canViewed,
    onclick: stop,
    onmousedown: stop,
    ondblclick: stop,
    onchange: (e) =>
      void setViewed(
        fr,
        file,
        /** @type {HTMLInputElement} */ (e.target).checked,
      ),
  });
  /** @type {HTMLInputElement} */ (checkbox).checked = file.viewed === 'VIEWED';
  const ref = { localFolder: fr.localFolder, root: fr.root, path: file.path };
  const row = treeRow(
    `${treeId(fr)}\npr\n${file.path}`,
    depth,
    undefined,
    {
      class: 'pr-file',
      'data-viewed': file.viewed,
      title: [
        file.previousPath ? `${file.previousPath} → ${file.path}` : file.path,
        dismissed ? 'changed since viewed' : '',
      ].filter((s) => s).join('\n'),
      onclick: (e) =>
        tileArea.openDiff(ref, e.ctrlKey || e.metaKey ? 'stack' : 'preview'),
      ondblclick: () => keepOpen(tileShowingDiff(tileArea.state(), ref)),
      oncontextmenu: (e) => openMenu(e, prFileMenuItems(fr, result, file)),
    },
    checkbox,
    h('span', {
      class: 'pr-status',
      'data-status': letter,
    }, letter),
    ...markedText(node.name),
    node.dir
      ? h('span', { class: 'pr-file-dir' }, ...markedText(node.dir))
      : '',
  );
  row.append(rowTrail(h('span', { class: 'pr-stat' }, diffStat(file))));
  return row;
}

/**
 * A PR file's menu: its diff, the file itself as the Files tree opens it (not for a deleted
 * file, which is no longer in the checkout), GitHub, and the file's paths and pin. Viewed is
 * the row's checkbox.
 *
 * @param {FileRoot} fr @param {any} result @param {any} file
 */
function prFileMenuItems(fr, result, file) {
  const ref = { localFolder: fr.localFolder, root: fr.root, path: file.path };
  const path = file.path;
  const exists = file.status !== 'removed';
  return [
    ['Open diff', () => tileArea.openDiff(ref, 'stack')],
    ['Open diff to the right', () => tileArea.openDiff(ref, 'right')],
    ...(file.viewed === 'DISMISSED'
      ? [[
        LABELS.openChangesSinceViewed,
        () => tileArea.openDiff(ref, 'stack', { compare: 'viewed' }),
      ]]
      : []),
    null,
    ...(exists
      ? [
        ['Open file', () => openFileTile(fr, path, 'stack')],
        ['Open file to the right', () => openFileTile(fr, path, 'right')],
        ['Open in editor', () => openInEditor(fr, path, 'stack')],
        ...hostOpenItems(fr, path),
        null,
      ]
      : []),
    [
      'Open on GitHub',
      () =>
        void prFileUrl(result.pr.url, path).then((url) =>
          window.open(url, '_blank', 'noopener')
        ),
    ],
    null,
    ...copyPathItems(fr, path),
    ...(exists && !fr.container
      ? [null, filePinItem(fr, path), dashboardItem(fr, path)]
      : []),
  ];
}

/**
 * A PR folder's menu: every file under it marked Viewed (or, when all are, not), the folder in
 * Code or the file manager, and its paths.
 *
 * @param {FileRoot} fr @param {any} result
 * @param {import('./lib/pr_tree.js').PrDir} dir
 */
function prDirMenuItems(fr, result, dir) {
  const allViewed = dir.viewed === dir.total;
  return [
    ...(result.canViewed
      ? [[
        allViewed ? 'Mark all as not viewed' : 'Mark all as viewed',
        () => void setFolderViewed(fr, dir, !allViewed),
      ]]
      : []),
    null,
    ...hostOpenItems(fr, dir.path),
    null,
    ...copyPathItems(fr, dir.path),
  ];
}

/**
 * Marks every file under `dir` Viewed or not, one `pr_viewed` at a time (GitHub has one file per
 * call), skipping those already so. The first failure stops the rest, with its toast.
 *
 * @param {FileRoot} fr @param {import('./lib/pr_tree.js').PrDir} dir @param {boolean} viewed
 */
async function setFolderViewed(fr, dir, viewed) {
  /** @param {import('./lib/pr_tree.js').PrDir} d @returns {any[]} */
  const filesOf = (d) => [
    ...d.files.map((n) => n.file),
    ...d.dirs.flatMap(filesOf),
  ];
  for (const file of filesOf(dir)) {
    if ((file.viewed === 'VIEWED') === viewed) continue;
    if (!await setViewed(fr, file, viewed)) return;
  }
}

/**
 * A diff tile marked a PR file Viewed or not (`SidebarIntents.prViewed`): the PR tree's listing
 * of that repo, if it has one, shows it.
 *
 * @param {{localFolder: string, root: string, path: string}} ref
 * @param {'VIEWED' | 'UNVIEWED'} viewed
 */
export function prViewed(ref, viewed) {
  if (viewed !== 'VIEWED' && viewed !== 'UNVIEWED') return;
  const result = prLists.get(prKey(ref?.localFolder, ref?.root))?.result;
  const file = list(result?.files).find((f) => f.path === ref?.path);
  if (!file || file.viewed === viewed) return;
  file.viewed = viewed;
  queueRender();
}

/**
 * Marks a PR file Viewed or not (`pr_viewed`): the counts change at once, and a failure puts
 * the checkbox back with a toast. Its diff tiles hear of a success (`ViewIntents.prViewed`).
 * Resolves whether it worked.
 *
 * @param {FileRoot} fr @param {any} file @param {boolean} viewed
 * @returns {Promise<boolean>}
 */
async function setViewed(fr, file, viewed) {
  const before = file.viewed;
  file.viewed = viewed ? 'VIEWED' : 'UNVIEWED';
  queueRender();
  let message = null;
  try {
    const r = await call({
      type: 'pr_viewed',
      localFolder: fr.localFolder,
      root: fr.root,
      path: file.path,
      viewed,
    });
    if (r?.available === false) message = String(r.message ?? 'failed');
    else if (r?.viewed === 'VIEWED' || r?.viewed === 'UNVIEWED') {
      file.viewed = r.viewed;
    }
  } catch (e) {
    message = String(e?.message ?? e);
  }
  if (message !== null) {
    file.viewed = before;
    errorToast(`Marking Viewed failed: ${message}`);
  }
  queueRender();
  if (message !== null) return false;
  tileArea.prViewed(
    { localFolder: fr.localFolder, root: fr.root, path: file.path },
    file.viewed,
  );
  return true;
}

// ---------------------------------------------------------------------------------------------
// Directory trees: shared by the file trees and the Add project folder picker
// ---------------------------------------------------------------------------------------------

let renderQueued = false;

/** Renders the page's cards once, after everything else that changes in this turn. */
export function queueRender() {
  if (renderQueued) return;
  renderQueued = true;
  queueMicrotask(() => {
    renderQueued = false;
    renderTree();
  });
}

/**
 * A tree's rows under `root`: `entryRow` for each entry, and a muted note while a folder loads,
 * when it failed, or when the server cut it short.
 *
 * @param {ReturnType<typeof createDirTree>} tree
 * @param {(item: any) => HTMLElement} entryRow
 */
export function treeRows(tree, root, depth, entryRow) {
  return tree.walk(root, depth).map((item) => {
    if (item.type === 'entry') return entryRow(item);
    const text = item.type === 'loading'
      ? 'Loading…'
      : item.type === 'truncated'
      ? '… more not shown'
      : item.message;
    return h(
      'div',
      {
        class: 'row tree-note',
        'data-note': item.type,
        style: `--depth: ${item.depth}`,
      },
      h('span', { class: 'label' }, text),
    );
  });
}

/**
 * A row in a directory tree, focusable for {@link treeKeydown}: a chevron when `expanded` is
 * given, else a gap where it would be.
 *
 * @param {string} key unique within its tree's container
 * @param {number} depth
 * @param {boolean | undefined} expanded
 * @param {Record<string, any>} attrs
 * @param {...(Node|string)} label
 */
export function treeRow(key, depth, expanded, attrs, ...label) {
  return h(
    'div',
    {
      ...attrs,
      class: `row tree-row ${attrs.class ?? ''}`,
      style: `--depth: ${depth}`,
      tabindex: '-1',
      'data-tree-key': key,
      'data-depth': depth,
      'aria-expanded': expanded === undefined ? undefined : String(expanded),
    },
    h(
      'span',
      { class: 'label' },
      expanded === undefined
        ? h('span', { class: 'chevron', 'aria-hidden': 'true' })
        : chevron(),
      ...label,
    ),
  );
}

/**
 * Arrow keys and Enter on the tree rows inside `e.currentTarget`: up and down move, right
 * expands (or steps into), left collapses (or steps out), Enter activates.
 *
 * @param {KeyboardEvent} e
 * @param {{activate: (row: HTMLElement) => void, toggle: (row: HTMLElement) => void}} actions
 */
export function treeKeydown(e, actions) {
  const row = /** @type {HTMLElement | null} */ (
    /** @type {HTMLElement} */ (e.target).closest?.('[data-tree-key]')
  );
  if (!row) return;
  const rows = /** @type {HTMLElement[]} */ ([
    ...(/** @type {HTMLElement} */ (e.currentTarget)).querySelectorAll(
      '[data-tree-key]',
    ),
  ]).filter((r) => !r.closest('.filter-hidden'));
  const i = rows.indexOf(row);
  const expanded = row.getAttribute('aria-expanded');
  switch (e.key) {
    case 'ArrowDown':
      rows[i + 1]?.focus();
      break;
    case 'ArrowUp':
      rows[i - 1]?.focus();
      break;
    case 'ArrowRight':
      if (expanded === 'false') actions.toggle(row);
      else if (expanded === 'true') rows[i + 1]?.focus();
      break;
    case 'ArrowLeft': {
      if (expanded === 'true') {
        actions.toggle(row);
        break;
      }
      const depth = Number(row.dataset.depth);
      rows.slice(0, i).reverse().find((r) => Number(r.dataset.depth) < depth)
        ?.focus();
      break;
    }
    case 'Enter':
      actions.activate(row);
      break;
    default:
      return;
  }
  e.preventDefault();
  e.stopPropagation();
}

/** The tree key of the focused row inside `container`, to focus again after a re-render. */
export function focusedTreeKey(container) {
  const el = /** @type {HTMLElement | null} */ (document.activeElement);
  return el && container.contains(el) ? el.dataset.treeKey ?? null : null;
}

/** The row with tree key `key` inside `container`, if there is one. */
export function treeRowByKey(container, key) {
  for (const el of container.querySelectorAll('[data-tree-key]')) {
    const row = /** @type {HTMLElement} */ (el);
    if (row.dataset.treeKey === key) return row;
  }
  return null;
}

export function refocusTreeKey(container, key) {
  if (key === null) return;
  treeRowByKey(container, key)?.focus({ preventScroll: true });
}

// ---------------------------------------------------------------------------------------------
// The filter (its box is the sidebar's)
// ---------------------------------------------------------------------------------------------

/** Boxes whose first child heads the rest: a repo's card, a container's, an In use run. */
const HEADED_BOXES = ['repo-card', 'container-card', 'in-use-run'];

/** @typedef {import('./lib/sidebar.js').OutlineNode & {el: Element, children?: any[]}} FilterNode */

/**
 * Filters the rows rendered: with a query in the filter box, each of `zones` shows the rows whose text
 * matches it with everything under them, and the rows above them; section headings always show.
 * A folded row's contents are not rendered, so they are not searched.
 */
export function applyFilter(/** @type {HTMLElement[]} */ zones) {
  const query = filterQuery.trim();
  for (const el of $root.querySelectorAll('.filter-hidden, .filter-match')) {
    el.classList.remove('filter-hidden', 'filter-match');
  }
  if (!query) return;
  /** @type {(el: Element) => number} */
  const depthOf = (el) =>
    Number(
      /** @type {HTMLElement} */ (el).style.getPropertyValue('--depth'),
    ) || 0;
  /** @type {(el: Element) => FilterNode} */
  const nodeOf = (el) => {
    if (
      el.classList.contains('row') || el.classList.contains('in-use-run-name')
    ) {
      const text = el.querySelector('.label')?.textContent ?? el.textContent;
      return {
        el,
        depth: depthOf(el),
        // A name being typed shows, with the rows above it.
        matches: el.classList.contains('new-entry') ||
          filterMatches(text ?? '', query),
        keep: el.classList.contains('section'),
      };
    }
    const first = el.querySelector('.row');
    const depth = first ? depthOf(first) : 0;
    if (!first) return { el, depth, matches: false };
    const [head, ...rest] = [...el.children].map(nodeOf);
    if (head && HEADED_BOXES.some((k) => el.classList.contains(k))) {
      head.children = rest;
      return { el, depth, matches: false, children: [head] };
    }
    return {
      el,
      depth,
      matches: false,
      children: head ? [head, ...rest] : [],
    };
  };
  /** @type {(nodes: FilterNode[]) => void} */
  const mark = (nodes) => {
    for (const node of nodes) {
      node.el.classList.toggle('filter-hidden', !node.shown);
      node.el.classList.toggle('filter-match', node.matches && !node.keep);
      mark(node.children ?? []);
    }
  };
  for (const zone of zones) {
    const nodes = [...zone.children].map(nodeOf);
    filterOutline(nodes);
    mark(nodes);
  }
}

/** Whether the filter has a query, and `text` matches it. */
export function filterHas(text) {
  return filterQuery.trim() !== '' && filterMatches(text, filterQuery);
}

/**
 * Whether the filter matches a repo card's header (its repo's name and branch, or for the card of
 * what is outside every repo, its container's name), so a folded row it is under opens.
 */
export function cardMatchesFilter(card) {
  if (!card.repo) return filterHas(containerNameOf(card.localFolder));
  const { prefix, base } = repoGroupName(card.localFolder, card.repo);
  return filterHas(`${prefix}${base} ${card.repo.git?.branch ?? ''}`);
}

// ---------------------------------------------------------------------------------------------
// File trees
// ---------------------------------------------------------------------------------------------

/**
 * A file root's key: a repo mounted by two projects has a tree in each (container paths differ).
 * A container root's never matches a repo's: those are absolute.
 */
export function treeId(fr) {
  if (!fr.container) return `${fr.localFolder}\n${fr.root}`;
  return `${fr.localFolder}\ncontainer${fr.root === '/' ? '' : `:${fr.root}`}`;
}

/** Where a file root's open folders are saved in `sidebarState.filesOpen`. */
function openKey(fr) {
  if (!fr.container) return fr.root;
  return `container:${fr.localFolder}${fr.root === '/' ? '' : `\n${fr.root}`}`;
}

/** Each file root's tree, by {@link treeId}: made when its row is first drawn. */
export const fileTrees = new Map();
/** Saved open folders of each tree still listing after a reload: one that fails is dropped. */
export const restoringFiles = new Map();
/** The container each tree was last listed for, so a container start lists it again. */
const filesListedFor = new Map();

/**
 * @param {FileRoot} fr
 * @returns {ReturnType<typeof createDirTree>}
 */
export function fileTree(fr) {
  const id = treeId(fr);
  const entry = fileTrees.get(id);
  if (entry) return entry.tree;
  const { localFolder, root } = fr;
  const tree = createDirTree({
    list: (path) => {
      if (!fr.container) {
        return call({ type: 'list_dir', localFolder, root, path });
      }
      const c = containerByFolder(localFolder);
      return c
        ? call({
          type: 'list_container_dir',
          container: c.id,
          path: containerFilePath(fr, path),
        })
        : Promise.reject(new Error(LABELS.notRunning));
    },
    onChange: () => onFilesChange(fr),
  });
  fileTrees.set(id, { fr: { ...fr }, tree });
  filesListedFor.set(id, containerByFolder(localFolder)?.id ?? null);
  const saved = byDepth(sidebarState.filesOpen[openKey(fr)] ?? []);
  restoringFiles.set(id, new Set(saved));
  for (const p of saved) tree.expand(p);
  return tree;
}

function onFilesChange(fr) {
  const id = treeId(fr);
  const tree = fileTrees.get(id)?.tree;
  if (!tree) return;
  const restoring = restoringFiles.get(id);
  for (const p of [...(restoring ?? [])]) {
    const state = tree.listing(p)?.state;
    if (state === 'loading') continue;
    restoring.delete(p);
    if (state !== 'ok' && tree.isOpen(p)) tree.collapse(p);
  }
  const open = tree.openPaths();
  if (open.length) sidebarState.filesOpen[openKey(fr)] = open;
  else delete sidebarState.filesOpen[openKey(fr)];
  saveSidebarState();
  queueRender();
}

/**
 * Lists a tree again when its project's container came or went: the listing says where each
 * folder is in the container, which only a running one knows.
 */
export function relistForContainers() {
  for (const [id, { fr, tree }] of fileTrees) {
    const cid = containerByFolder(fr.localFolder)?.id ?? null;
    if (filesListedFor.get(id) === cid) continue;
    filesListedFor.set(id, cid);
    tree.refresh('');
  }
}

/**
 * A file or folder's tooltip lines for its path: the host path, then for a container's own file
 * its container path (alone when no bind mount covers it).
 */
export function pathTitle(fr, path) {
  const host = hostPathOf(fr, path);
  if (!fr.container) return host;
  const inContainer = containerFilePath(fr, path);
  return host === null ? inContainer : `${host}\n${inContainer}`;
}

/**
 * A Herdr tab at a repo folder (`open_tab`), shown in the focused stack: with `reuse`, a shell
 * already there (its tile focused if it has one), else a new tab. Starts Herdr in a running
 * container that has no session; never starts the container.
 */
function openHerdrTab(fr, path, reuse, agent) {
  const c = containerByFolder(fr.localFolder);
  if (!c) {
    toast(projectActions(projects.get(fr.localFolder)?.environment).notRunning);
    return;
  }
  if (c.state === 'no-session') toast('Starting Herdr…');
  createPane(
    c,
    {
      type: 'open_tab',
      root: fr.root,
      path,
      reuse,
      ...(agent ? { agent } : {}),
    },
    {},
    agent ? LABELS.agents[agent] : reuse ? LABELS.openHere : LABELS.newTerminal,
  );
}

/**
 * A row's + (the Terminals row, or a folder's in a running container): opens
 * {@link newTerminalMenuItems} for folder `path` under the row's right end. Before it, a button
 * for a new task routed to the folder's project and repo.
 *
 * @param {HTMLElement} row @param {FileRoot} fr @param {string} path
 */
function newTerminalButton(row, fr, path) {
  return hoverActions(...newTerminalButtons(row, fr, path));
}

/** {@link newTerminalButton}'s two buttons, for a row with more hover buttons of its own. */
function newTerminalButtons(row, fr, path) {
  return [
    iconButton('task', LABELS.newTaskHere, () => newTaskIn(fr)),
    iconButton('plus', LABELS.newTerminal, () => {
      // Under the + at the row's right end. The row, not the button: hover buttons can be
      // hidden (zero-sized) by the time the click lands.
      const r = row.getBoundingClientRect();
      openMenuAt(r.right - 20, r.bottom + 2, newTerminalMenuItems(fr, path));
    }),
  ];
}

/** Gives a folder's row a {@link newTerminalButton} while its container is running. */
function folderTerminalButton(row, fr, path) {
  if (!fr.container && containerByFolder(fr.localFolder)) {
    row.append(rowTrail(newTerminalButton(row, fr, path)));
  }
}

/**
 * The + menu: a shell or one of the agents, each in a new terminal at folder `path` (`open_tab`,
 * which starts Herdr first when the container has no session).
 */
export function newTerminalMenuItems(fr, path) {
  return [
    [
      LABELS.plainTerminal,
      () => openHerdrTab(fr, path, false),
      false,
      rowIcon({}),
    ],
    ...AGENT_IDS.map((id) => [
      LABELS.agents[id],
      () => openHerdrTab(fr, path, false, id),
      false,
      rowIcon({ agent: id }),
    ]),
  ];
}

/** A new terminal at a container folder (`new_shell`), shown in the focused stack. */
function newShellIn(fr, path) {
  const c = containerByFolder(fr.localFolder);
  if (!c || c.state !== 'connected') {
    toast(
      c
        ? `Start Herdr ${
          c.kind === 'host' ? 'on this machine' : 'in this container'
        } first`
        : projectActions(projects.get(fr.localFolder)?.environment).notRunning,
    );
    return;
  }
  newShell(c, { cwd: containerFilePath(fr, path) });
}

/** A folder's menu: the root itself (`path` '', its repo or Files row) or a directory under it. */
export function dirMenuItems(fr, path) {
  return [
    fr.container
      ? [LABELS.newTerminalHere, () => newShellIn(fr, path)]
      : [LABELS.openHere, () => openHerdrTab(fr, path, true)],
    ...(fr.container ? [] : [[LABELS.newTaskHere, () => newTaskIn(fr)]]),
    null,
    [LABELS.newFile, () => startNewEntry(fr, path, 'file')],
    [LABELS.newFolder, () => startNewEntry(fr, path, 'dir')],
    null,
    ...hostOpenItems(fr, path),
    null,
    ...copyPathItems(fr, path),
    null,
    ['Refresh', () => fileTree(fr).refresh(path)],
    null,
    // Not a root: it is the project's repo, or the container's `/`.
    ...(path === '' ? [] : changeEntryItems(fr, path, 'dir')),
  ];
}

/** **Rename…** and **Delete…** for an entry (not a root) of `fr`. */
function changeEntryItems(fr, path, kind) {
  return [
    [LABELS.renameEntry, () => startNewEntry(fr, treeParent(path), kind, path)],
    [LABELS.deleteEntry, () => void deleteEntry(fr, path, kind)],
  ];
}

/** The folder a tree path is in: `''` for the root's own entries. */
function treeParent(path) {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

// ---------------------------------------------------------------------------------------------
// New files and folders
// ---------------------------------------------------------------------------------------------

/**
 * Opens the inline name row under folder `path` of `fr`, expanding the folder. Creating needs a
 * running container: the entry is made inside it, as the remote user (`create_file`). With
 * `rename` (an entry of `path`), the row takes that entry's place with its name to edit
 * (`rename_file`).
 *
 * @param {FileRoot} fr @param {string} path @param {'file' | 'dir'} kind
 * @param {string | null} [rename]
 */
function startNewEntry(fr, path, kind, rename = null) {
  if (!containerByFolder(fr.localFolder)) {
    toast(projectActions(projects.get(fr.localFolder)?.environment).notRunning);
    return;
  }
  const input = /** @type {HTMLInputElement} */ (h('input', {
    type: 'text',
    class: 'new-entry-input',
    spellcheck: 'false',
    autocomplete: 'off',
    'aria-label': rename !== null
      ? 'New name'
      : kind === 'file'
      ? 'New file name'
      : 'New folder name',
    placeholder: kind === 'file' ? 'File name' : 'Folder name',
  }));
  const oldName = rename === null
    ? ''
    : rename.slice(rename.lastIndexOf('/') + 1);
  input.value = oldName;
  const error = h('div', { class: 'new-entry-error', hidden: '' });
  const row = h(
    'div',
    { class: 'row new-entry', 'data-kind': kind },
    h(
      'span',
      { class: 'label' },
      h('span', { class: 'chevron', 'aria-hidden': 'true' }),
      input,
    ),
    error,
  );
  const entry = {
    fr,
    dir: path,
    kind,
    rename,
    row,
    input,
    error,
    busy: false,
    seen: 0,
  };
  input.addEventListener('keydown', (e) => {
    // The tree's own keys (arrows, Enter) must not act on the rows behind it.
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      void submitNewEntry(entry);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelNewEntry(entry);
    }
  });
  input.addEventListener('input', () => showNewEntryError(entry, null));
  newEntry = entry;
  const tree = fileTree(fr);
  if (!tree.isOpen(path)) tree.expand(path);
  renderTree();
  input.focus();
  // A file's name without its extension, ready to retype, as a desktop rename selects it.
  const dot = oldName.lastIndexOf('.');
  input.setSelectionRange(0, kind === 'file' && dot > 0 ? dot : oldName.length);
}

function cancelNewEntry(entry) {
  if (newEntry !== entry) return;
  newEntry = null;
  renderTree();
}

/** Shows `message` under the inline row, or hides it with `null`. */
function showNewEntryError(entry, message) {
  entry.error.textContent = message ?? '';
  entry.error.hidden = message === null;
}

/**
 * Creates the entry named in the inline row. On success the folder is listed again with the new
 * row selected, and a file opens in the editor (as **Open in editor** places it). On failure
 * (`exists` among them) the row stays open with the reason under it.
 */
async function submitNewEntry(entry) {
  if (newEntry !== entry || entry.busy) return;
  const name = entry.input.value;
  const invalid = newEntryNameError(name);
  if (invalid !== null) {
    showNewEntryError(entry, invalid);
    return;
  }
  const { fr, dir, kind } = entry;
  const c = containerByFolder(fr.localFolder);
  if (!c) {
    toast(projectActions(projects.get(fr.localFolder)?.environment).notRunning);
    return;
  }
  const path = childPath(dir, name);
  const where = (p) =>
    fr.container
      ? { path: containerFilePath(fr, p) }
      : { root: fr.root, path: p };
  if (entry.rename === path) {
    cancelNewEntry(entry);
    return;
  }
  entry.busy = true;
  try {
    await call(
      entry.rename !== null
        ? {
          type: 'rename_file',
          container: c.id,
          ...where(entry.rename),
          to: name,
        }
        : { type: 'create_file', container: c.id, ...where(path), kind },
    );
  } catch (e) {
    entry.busy = false;
    showNewEntryError(
      entry,
      e?.code === 'exists' ? `${name} already exists` : String(e?.message ?? e),
    );
    return;
  }
  if (newEntry === entry) newEntry = null;
  selectTreeKey = `${treeId(fr)}\n${path}`;
  fileTree(fr).refresh(dir);
  if (kind === 'file' && entry.rename === null) openInEditor(fr, path, 'stack');
}

/**
 * Deletes an entry of `fr` in the container (`delete_file`), once confirmed: a folder with
 * everything in it. Its folder is listed again; a failure is a toast.
 *
 * @param {FileRoot} fr @param {string} path @param {'file' | 'dir'} kind
 */
async function deleteEntry(fr, path, kind) {
  const c = containerByFolder(fr.localFolder);
  if (!c) {
    toast(projectActions(projects.get(fr.localFolder)?.environment).notRunning);
    return;
  }
  const name = path.slice(path.lastIndexOf('/') + 1);
  const question = kind === 'dir'
    ? `Delete the folder "${name}" and everything in it? This can't be undone.`
    : `Delete "${name}"? This can't be undone.`;
  if (!await confirmDialog(question, { okLabel: 'Delete', danger: true })) {
    return;
  }
  try {
    await call({
      type: 'delete_file',
      container: c.id,
      ...(fr.container
        ? { path: containerFilePath(fr, path) }
        : { root: fr.root, path }),
    });
  } catch (e) {
    errorToast(`Delete failed: ${e?.message ?? e}`);
    return;
  }
  fileTree(fr).refresh(treeParent(path));
}

/**
 * `rows` (a root's entry rows, at `depth`) with the inline name row in place when it belongs to
 * this root: first under its folder's row, or first of all for the root itself.
 *
 * @param {FileRoot} fr @param {number} depth @param {HTMLElement[]} rows
 */
function withNewEntryRow(fr, depth, rows) {
  const entry = newEntry;
  if (entry === null || treeId(entry.fr) !== treeId(fr)) return rows;
  if (!fileTree(fr).isOpen(entry.dir)) return rows;
  if (entry.rename !== null) {
    const key = `${treeId(fr)}\n${entry.rename}`;
    const at = rows.findIndex((r) => r.dataset.treeKey === key);
    if (at === -1) return rows;
    entry.row.style.setProperty(
      '--depth',
      rows[at].dataset.depth ?? String(depth),
    );
    entry.seen = renderGeneration;
    return [...rows.slice(0, at), entry.row, ...rows.slice(at + 1)];
  }
  let at = 0;
  let rowDepth = depth;
  if (entry.dir !== '') {
    const key = `${treeId(fr)}\n${entry.dir}`;
    at = rows.findIndex((r) => r.dataset.treeKey === key) + 1;
    if (at === 0) return rows;
    rowDepth = Number(rows[at - 1].dataset.depth) + 1;
  }
  entry.row.style.setProperty('--depth', String(rowDepth));
  entry.seen = renderGeneration;
  return [...rows.slice(0, at), entry.row, ...rows.slice(at)];
}

function fileMenuItems(fr, path) {
  return [
    ['Open', () => openFileTile(fr, path, 'stack')],
    ['Open to the right', () => openFileTile(fr, path, 'right')],
    ...(previewable(path)
      ? [
        [LABELS.preview, () => openFileTile(fr, path, 'stack', 'media')],
        [LABELS.previewRight, () => openFileTile(fr, path, 'right', 'media')],
      ]
      : []),
    null,
    ['Open in editor', () => openInEditor(fr, path, 'stack')],
    [
      'Open in editor to the right',
      () => openInEditor(fr, path, 'right'),
    ],
    null,
    ...(mediaKind(path) === 'html'
      ? [['Open in browser', () => openInBrowser(fr, path)]]
      : []),
    ...hostOpenItems(fr, path),
    null,
    ...copyPathItems(fr, path),
    null,
    // A repo file only: the container's own files are outside the bind mount.
    ...(fr.container ? [] : [filePinItem(fr, path), dashboardItem(fr, path)]),
    null,
    ...changeEntryItems(fr, path, 'file'),
  ];
}

/** The folders and files of an open root, at `depth`, and an inline name row if it has one. */
export function rootEntryRows(fr, depth) {
  const tree = fileTree(fr);
  return withNewEntryRow(
    fr,
    depth,
    treeRows(tree, '', depth, (item) => fileEntryRow(fr, tree, item)),
  );
}

function fileEntryRow(fr, tree, item) {
  const { entry, path } = item;
  const dir = opensAsDir(entry);
  const file = opensAsFile(entry);
  const key = `${treeId(fr)}\n${path}`;
  const row = treeRow(
    key,
    item.depth,
    dir ? item.open : undefined,
    {
      class: file ? 'file-entry file-drag' : 'file-entry',
      'data-kind': entry.kind,
      'data-dim': isHiddenName(entry.name) || (!dir && !file) || undefined,
      title: [
        pathTitle(fr, path),
        entry.size !== undefined ? formatSize(entry.size) : '',
        entry.kind === 'symlink'
          ? entry.to ? 'Symbolic link' : 'Broken symbolic link'
          : '',
      ].filter((s) => s).join('\n'),
      onclick: dir
        ? () => tree.toggle(path)
        : file
        ? () => openFileTile(fr, path, 'preview')
        : undefined,
      ondblclick: file
        ? () => keepOpen(tileShowingFile(tileArea.state(), fileRefOf(fr, path)))
        : undefined,
      oncontextmenu: (e) =>
        openMenu(
          e,
          dir ? dirMenuItems(fr, path) : file ? fileMenuItems(fr, path) : [
            ...hostOpenItems(fr, path),
            null,
            ...copyPathItems(fr, path),
            null,
            ...changeEntryItems(fr, path, 'file'),
          ],
        ),
    },
    entry.name,
    entry.kind === 'symlink' ? h('span', { class: 'link-mark' }, '→') : '',
  );
  if (dir) folderTerminalButton(row, fr, path);
  return file ? keptFileRow(key, row, fr, path) : row;
}

/**
 * A file row that is a drag source into the layout (a drop opens a file tile there). The first
 * row made for `key` is kept and brought up to date from `fresh` on each render, so its drag
 * source lives as long as the row is shown (see {@link paneRows}). Its listeners stay the first
 * row's: they act on the same root and path, which is what `key` names.
 *
 * @param {string} key @param {HTMLElement} fresh @param {FileRoot} fr @param {string} path
 */
function keptFileRow(key, fresh, fr, path) {
  const rec = fileRows.get(key);
  if (!rec) {
    const ref = fileRefOf(fr, path);
    fileRows.set(key, {
      row: fresh,
      seen: renderGeneration,
      remove: tileArea.dragSource(
        fresh,
        () => ({ file: ref }),
        () => basename(path),
      ),
    });
    return fresh;
  }
  rec.seen = renderGeneration;
  const { row } = rec;
  for (const { name } of [...row.attributes]) {
    if (!fresh.hasAttribute(name)) row.removeAttribute(name);
  }
  for (const { name, value } of [...fresh.attributes]) {
    if (row.getAttribute(name) !== value) row.setAttribute(name, value);
  }
  row.replaceChildren(...fresh.childNodes);
  return row;
}

function paneMenu(rec) {
  const { c, pane } = rec;
  const items = [
    [
      'Open in new tile',
      () =>
        tileArea.openPane({
          localFolder: c.localFolder,
          pane_id: pane.pane_id,
        }),
    ],
  ];
  const tile = tileShowing(c, pane);
  if (tile) items.push(['Show in layout', () => tileArea.reveal(tile.id)]);
  const jira = jiraItems(paneRepo(c.localFolder, pane)?.git?.branch);
  if (jira.length > 0) items.push(...jira, null);
  items.push(
    ['Rename…', async () => {
      const label = await promptDialog(LABELS.renamePrompt, paneTitle(pane));
      if (label) {
        request(
          c.id,
          'pane.rename',
          { pane_id: pane.pane_id, label },
          LABELS.rename,
        );
      }
    }],
    killPaneItem(c, pane),
  );
  return items;
}

/**
 * Click: show the pane where it already is, else open it in the focused stack's preview tile.
 * Ctrl/Cmd-click: a new tile that stays.
 */
function onPaneClick(rec, e) {
  const ref = { localFolder: rec.c.localFolder, pane_id: rec.pane.pane_id };
  if (e.ctrlKey || e.metaKey) {
    tileArea.openPane(ref);
    return;
  }
  const tile = tileShowing(rec.c, rec.pane);
  if (tile) tileArea.reveal(tile.id);
  else tileArea.openPane(ref, { where: 'preview' });
}

/**
 * A pane no tile shows, in its repo card: the kept row for this pane (see {@link paneRows}),
 * brought up to date. It says what it is doing, as In use rows do; its card names its folder and
 * container. `space` names its Herdr space in the tooltip; '' when the container has just one.
 */
export function paneRow(c, pane, depth, space = '') {
  const key = paneKey(c.id, pane.pane_id);
  let rec = paneRows.get(key);
  if (!rec) {
    const row = h('div', {
      class: 'row pane',
      onclick: (e) => onPaneClick(rec, e),
      // The two clicks opened it (as a preview); a double-click also keeps it.
      ondblclick: () => keepOpen(tileShowing(rec.c, rec.pane)),
      oncontextmenu: (e) =>
        openMenu(e, [...paneCodeItems(rec.c, rec.pane), ...paneMenu(rec)]),
    });
    rec = { row, c, pane, seen: 0, remove: null };
    paneRows.set(key, rec);
  }
  Object.assign(rec, { c, pane, seen: renderGeneration });
  // Dragging the row into the tiling area opens the pane in a new tile where it lands. Golden
  // Layout only starts a drag on the row itself, so its children ignore the pointer (CSS).
  if (!rec.remove) {
    const r = rec;
    rec.remove = tileArea.dragSource(
      r.row,
      () => ({ localFolder: r.c.localFolder, pane_id: r.pane.pane_id }),
      () => labelText(paneLabel(r.pane)),
    );
  }
  const { row } = rec;
  const visible = isVisible(c, pane);
  row.style.setProperty('--depth', String(depth));
  row.dataset.paneKey = key;
  row.classList.toggle('visible', visible);
  // The children ignore the pointer, so the badge's tooltip lives here.
  row.title = [
    paneTitle(pane),
    pane.foreground_cwd || pane.cwd || '',
    space ? `Space: ${space}` : '',
    pane.agent ? `${pane.agent}: ${agentStatus(pane)}` : '',
    visible ? 'Shown in a tile' : '',
  ].filter((s) => s).join('\n');
  row.replaceChildren(
    h(
      'span',
      { class: 'label' },
      // In the slot a chevron would take, so terminals line up with the tree rows at their depth.
      // Shown in a tile, it turns the accent color (the row's `visible` class).
      rowIcon({ agent: pane.agent }),
      inUseLabel(paneLabel(pane)),
    ),
    rowTrail(
      badge(pane),
      hoverActions(
        iconButton('trash', LABELS.close, () => killPane(rec.c, rec.pane)),
      ),
    ),
  );
  return row;
}
