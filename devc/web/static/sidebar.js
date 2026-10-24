// The `devc web` sidebar, in three zones: Tasks, the to-dos sent to agents; In use, the repo cards
// of what is open and the pinned files; and Containers, every running container's repo cards
// (Herdr panes, past agent sessions, pull requests, files) and the projects not running. With the
// dialogs it opens and the "Add project…" folder picker. It reaches the tiling area only through
// the `TileArea` `mountSidebar` is given (`lib/view.js`), so it can later run on a page of its
// own.

import { sameFile, tilesShowingPane } from './lib/layout_state.js';
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
  collapseContainersState,
  collapseTasksState,
  containerLabel,
  dragZones,
  filterMatches,
  filterOutline,
  gitRollup,
  gitSync,
  inUseLabel,
  isSidebarScope,
  labelText,
  paneLabel,
  paneTitle,
  repoAt,
  repoCardActive,
  repoCardKey,
  savedScope,
  settleZones,
  SIDEBAR_SCOPES,
  splitRepoName,
  statusCounts,
  statusRank,
  ZONE_MIN_HEIGHT,
} from './lib/sidebar.js';
import { AGENT_IDS } from './lib/agent_icons.js';
import { mediaKind } from './lib/media.js';
import {
  byDepth,
  childPath,
  createDirTree,
  formatSize,
  isHiddenName,
  isWithin,
  newEntryNameError,
  opensAsDir,
  opensAsFile,
  parentDir,
} from './lib/files.js';
import {
  defaultNotePath,
  filePinName,
  isFilePinShortcut,
  notePathError,
} from './lib/pinned_files.js';
import {
  groupTasks,
  parseTaskDefault,
  queueableTasks,
  queuePlaces,
  savedTaskAgent,
  sentTaskTooltip,
  TASK_AGENT_IDS,
  taskTitle,
} from './lib/tasks.js';
import { parseSessions, sessionAge, sessionTooltip } from './lib/sessions.js';
import {
  buildPrTree,
  folderOpenByDefault,
  prFileUrl,
  statusLetter,
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
  IS_MAC,
  LABELS,
  markedText,
  openMenu,
  openMenuAt,
  promptDialog,
  rowIcon,
  rowTrail,
  svgIcon,
  toast,
  writeClipboard,
} from './ui.js';
import {
  basename,
  byNumber,
  call,
  containerByFolder,
  containers,
  displayName,
  fileHostPath,
  filePinPanes,
  list,
  nextId,
  onConnectionChange,
  onServerMessage,
  paneKey,
  paneRepo,
  pendingRequests,
  pinnedFiles,
  projectOutput,
  projectRepos,
  projects,
  projectStarts,
  refLabel,
  refTooltip,
  request,
  resolveRef,
  saveFilePinPanes,
  send,
  sentTasks,
  sessionPane,
  snapshots,
  socket,
  tasks,
  tileRepo,
} from './client.js';
import {
  containerFilePath,
  containerRoot,
  copyPathItems,
  createPane,
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
  projectRequest,
  setMenuContext,
  startProject,
  submitPendingReview,
  tileMenuItems,
  unpinFile,
} from './menus.js';

/** @typedef {import('./lib/view.js').SidebarIntents} SidebarIntents */
/** @typedef {import('./lib/view.js').TileArea} TileArea */
/** @typedef {import('./lib/view.js').ViewState} ViewState */
/** @typedef {import('./lib/layout_state.js').PaneRef} PaneRef */
/** @typedef {import('./menus.js').FileRoot} FileRoot */

/** The tile rows' last render: the view's `layoutSignature` and `tileMarks` then. */
let shownLayout = '';
let shownMarks = '';
/** The focused tile's repo card at a scoped sidebar's last render (`scopeCardKey`). */
let shownScopeCard = /** @type {string | null} */ (null);
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
const paneRows = new Map();
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
/** The agent the task dialog last sent to. */
const TASK_AGENT_KEY = 'devc-web-task-agent-v1';
/** The default route and agent for new tasks, pinned in the task dialog. */
const TASK_DEFAULT_KEY = 'devc-web-task-default-v1';

/** The sidebar, its tree, connection indicator and scope picker: set by {@link mountSidebar}. */
let $sidebar = /** @type {HTMLElement} */ (null);
let $tree = /** @type {HTMLElement} */ (null);
let $conn = /** @type {HTMLElement | null} */ (null);
let $scopePicker = /** @type {HTMLElement | null} */ (null);
/** The filter box above the zones, and what it holds ({@link applyFilter}). */
let $filter = /** @type {HTMLInputElement | null} */ (null);
let filterQuery = '';
/**
 * The sidebar's three zones, each scrolling on its own: Tasks, what is in use now (In use,
 * pinned files, the Layout tree), and the containers to browse and manage; a draggable divider
 * between each two.
 */
const $zoneInUse = h('div', { class: 'zone zone-in-use' });
const $zoneTasks = h('div', { class: 'zone zone-tasks' });
const $zoneBrowse = h('div', { class: 'zone zone-browse' });
const zoneDivider = () =>
  h('div', {
    class: 'zone-divider',
    role: 'separator',
    'aria-orientation': 'horizontal',
    title: 'Drag to resize, double-click to reset',
  });
const $dividerTasks = zoneDivider();
const $dividerBrowse = zoneDivider();

// ---------------------------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------------------------

export const SIDEBAR_KEY = 'devc-web-sidebar-v1';
/**
 * Containers without a usable Herdr: their rows offer Start Herdr / Retry and list no panes.
 * They are still running, so they stay in the main list.
 */
const INACTIVE_STATES = new Set([
  'no-session',
  'no-herdr',
  'unsupported',
  'error',
]);

const STATE_TEXT = {
  connecting: 'connecting…',
  'no-session': 'no session',
  'no-herdr': 'no herdr',
  unsupported: 'unsupported',
  error: 'error',
};

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
const sidebarState = loadSidebarState();

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

function saveSidebarState() {
  const saved = storedSidebarState();
  try {
    localStorage.setItem(
      SIDEBAR_KEY,
      JSON.stringify({
        collapsed: [...sidebarState.collapsed],
        cardHistoryOpen: [...sidebarState.cardHistoryOpen],
        worktreesClosed: [...sidebarState.worktreesClosed],
        containerFilesOpen: [...sidebarState.containerFilesOpen],
        prOpen: [...sidebarState.prOpen],
        prFolders: sidebarState.prFolders,
        prHideViewed: sidebarState.prHideViewed,
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

function toggleContainer(c) {
  if (!sidebarState.collapsed.delete(c.localFolder)) {
    sidebarState.collapsed.add(c.localFolder);
  }
  saveSidebarState();
  renderTree();
}

/** Opens the Pinned section, as pinning a file does. */
function openPinnedSection() {
  if (sidebarState.pinnedOpen) return;
  sidebarState.pinnedOpen = true;
  saveSidebarState();
  renderTree();
}

function togglePinnedSection() {
  sidebarState.pinnedOpen = !sidebarState.pinnedOpen;
  saveSidebarState();
  renderTree();
}

function toggleContainersSection() {
  sidebarState.containersOpen = !sidebarState.containersOpen;
  saveSidebarState();
  renderTree();
}

function toggleTasksSection() {
  sidebarState.tasksOpen = !sidebarState.tasksOpen;
  saveSidebarState();
  renderTree();
}

/** Opens or closes a task group (by its `groupTasks` key). */
function toggleTaskGroup(key) {
  if (!sidebarState.taskGroupsClosed.delete(key)) {
    sidebarState.taskGroupsClosed.add(key);
  }
  saveSidebarState();
  renderTree();
}

function toggleSentTasks() {
  sidebarState.sentOpen = !sidebarState.sentOpen;
  saveSidebarState();
  renderTree();
}

/** The Tasks heading's Collapse all: closes its task groups and Sent; the section stays open. */
function collapseTasks() {
  Object.assign(
    sidebarState,
    collapseTasksState(sidebarState, groupTasks(tasks).map((g) => g.key)),
  );
  saveSidebarState();
  renderTree();
}

/**
 * The Containers heading's Collapse all: closes every row under it, at every level, including the
 * saved folders of file trees not drawn yet. Containers and projects known now stay collapsed
 * when they come back.
 */
function collapseContainers() {
  // Each clear() saves its tree's (now empty) open folders: before the state below, not after.
  for (const { tree } of fileTrees.values()) tree.clear();
  restoringFiles.clear();
  sidebarState.prOpen.clear();
  Object.assign(
    sidebarState,
    collapseContainersState(sidebarState, [
      ...[...containers.values()].map((c) => c.localFolder),
      ...projects.keys(),
    ]),
  );
  saveSidebarState();
  renderTree();
}

function toggleInactive() {
  sidebarState.inactiveOpen = !sidebarState.inactiveOpen;
  saveSidebarState();
  renderTree();
}

/**
 * Applies the sidebar's scope: the picker's checked option, and the sidebar's `data-scope`, which
 * the stylesheet reads.
 */
function applyScope() {
  const { scope } = sidebarState;
  $sidebar.dataset.scope = scope;
  for (const option of $scopePicker?.querySelectorAll('[role="radio"]') ?? []) {
    const checked = /** @type {HTMLElement} */ (option).dataset.scope === scope;
    option.setAttribute('aria-checked', String(checked));
    option.setAttribute('tabindex', checked ? '0' : '-1');
  }
}

/**
 * What the sidebar shows (the scope picker): everything (`all`), or Tasks and the focused tile's
 * container (`container`) or repo card (`repo`), with the Containers section, the In use heading
 * and pinned files hidden.
 *
 * @param {import('./lib/sidebar.js').SidebarScope} scope
 */
function setScope(scope) {
  if (!isSidebarScope(scope) || scope === sidebarState.scope) return;
  sidebarState.scope = scope;
  storedScope = scope;
  saveSidebarState();
  applyScope();
  renderTree();
}

/** The scope picker's keys, as a radio group's: an arrow key checks the option before or after. */
function scopePickerKeydown(e) {
  const step =
    { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[e.key];
  if (!step) return;
  e.preventDefault();
  const n = SIDEBAR_SCOPES.length;
  const next = SIDEBAR_SCOPES[
    (SIDEBAR_SCOPES.indexOf(sidebarState.scope) + step + n) % n
  ];
  setScope(next);
  /** @type {HTMLElement | null} */ ($scopePicker?.querySelector(
    `[data-scope="${next}"]`,
  ))?.focus();
}

/** Whether the Containers section is open: a scoped sidebar hides it, as if folded. */
function containersShown() {
  return sidebarState.containersOpen && sidebarState.scope === 'all';
}

/** The space the zones share: the sidebar's tree less its dividers. */
function zonesHeight() {
  return $tree.clientHeight - $dividerTasks.offsetHeight -
    $dividerBrowse.offsetHeight;
}

/** A zone's height with nothing squeezing or capping it: all of its rows. */
function naturalHeight(zone) {
  const { flex, maxHeight } = zone.style;
  zone.style.flex = '0 0 auto';
  zone.style.maxHeight = 'none';
  const height = zone.offsetHeight;
  zone.style.flex = flex;
  zone.style.maxHeight = maxHeight;
  return height;
}

/**
 * The zones' heights now and their limits, for `dragZones` / `settleZones`: Tasks on top, between
 * a heading and a row (or less, if that is all it has) and all of its rows, its heading alone when
 * folded; In use in the middle, from its heading to all of its rows, or filling what is left while
 * Containers is folded; Containers at the bottom, exactly its heading when folded.
 */
function zoneLimits() {
  const { tasksOpen } = sidebarState;
  const containersOpen = containersShown();
  const tasksAll = naturalHeight($zoneTasks);
  const browseAll = containersOpen ? Infinity : naturalHeight($zoneBrowse);
  return {
    total: zonesHeight(),
    top: $zoneTasks.offsetHeight,
    mid: $zoneInUse.offsetHeight,
    topMin: tasksOpen ? Math.min(tasksAll, 2 * ZONE_MIN_HEIGHT) : tasksAll,
    topMax: tasksAll,
    midMin: ZONE_MIN_HEIGHT,
    midMax: containersOpen
      ? Math.max(ZONE_MIN_HEIGHT, naturalHeight($zoneInUse))
      : Infinity,
    botMin: containersOpen ? ZONE_MIN_HEIGHT : browseAll,
    botMax: browseAll,
  };
}

/** The most sections whose heights are kept: the oldest is dropped. */
const MAX_SECTION_HEIGHTS = 50;

/**
 * A card section still loading (a `Loading…` note in it: a pull request not yet listed, a folder
 * not yet read, sessions not yet listed) keeps the height it last had once loaded, saved across
 * reloads, so it doesn't collapse to one row and grow back. Call before layout.
 */
function holdSections() {
  for (const el of $tree.querySelectorAll('.card-section')) {
    const box = /** @type {HTMLElement} */ (el);
    const px = sidebarState.sectionHeights[box.dataset.sectionKey ?? ''];
    if (px && sectionLoading(box)) box.style.minHeight = `${px}px`;
  }
}

/** Saves the heights of the card sections that are loaded, after layout (`holdSections`). */
function keepSectionHeights() {
  const heights = sidebarState.sectionHeights;
  let changed = false;
  for (const el of $tree.querySelectorAll('.card-section')) {
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

/** The least an open card section in In use shrinks to: six rows, or all of it. */
const SECTION_MIN_HEIGHT = 6 * 27;

/**
 * Keeps In use's boxes (style.css `.in-use-run`) from squeezing an open section to nothing: each
 * card with one is held to its rows plus SECTION_MIN_HEIGHT of each section, and each box to its
 * cards' floors (not their heights now: the window may shrink). Past that the boxes run taller
 * than the zone, which scrolls. CSS can't say this: a card's floor from its content is all of
 * its content.
 */
function floorInUseSections() {
  for (const el of $zoneInUse.querySelectorAll(':scope > .in-use-run')) {
    floorRunSections(/** @type {HTMLElement} */ (el));
  }
}

/** @param {HTMLElement} run */
function floorRunSections(run) {
  const cards = [...run.querySelectorAll(':scope > .repo-card')].map((
    el,
  ) => /** @type {HTMLElement} */ (el)).filter((card) =>
    card.querySelector(':scope > .card-section')
  );
  if (cards.length === 0) return;
  const floors = cards.map((card) => {
    let floor = card.scrollHeight;
    for (const el of card.querySelectorAll(':scope > .card-section')) {
      const section = /** @type {HTMLElement} */ (el);
      const border = section.offsetHeight - section.clientHeight;
      floor += Math.min(SECTION_MIN_HEIGHT, section.scrollHeight) + border -
        section.offsetHeight;
    }
    card.style.minHeight = `${floor}px`;
    return floor;
  });
  const slack = cards.reduce(
    (sum, card, i) => sum + Math.max(0, card.offsetHeight - floors[i]),
    0,
  );
  const last = /** @type {HTMLElement} */ (run.lastElementChild);
  const style = getComputedStyle(run);
  run.style.minHeight = `${
    last.getBoundingClientRect().bottom +
    parseFloat(getComputedStyle(last).marginBottom) +
    parseFloat(style.paddingBottom) + parseFloat(style.borderBottomWidth) -
    run.getBoundingClientRect().top - slack
  }px`;
}

/**
 * Gives Tasks and In use their dragged heights, kept to their limits (rows come and go, the
 * window resizes), or their default sizing when none was dragged. With Containers folded, In use
 * fills what Tasks leaves. A divider with nothing it can move is inert: the one under a folded
 * Tasks, the one over a folded Containers.
 */
function applyZoneSizes() {
  const { tasksOpen } = sidebarState;
  const containersOpen = containersShown();
  $dividerTasks.dataset.inert = String(!tasksOpen);
  $dividerBrowse.dataset.inert = String(!containersOpen);
  const set = (el, px) => {
    el.style.flex = px === null ? '' : `0 0 ${px}px`;
    el.style.maxHeight = px === null ? '' : 'none';
  };
  if (sidebarState.inUseSize === null || sidebarState.tasksSize === null) {
    set($zoneTasks, null);
    set($zoneInUse, null);
    return;
  }
  const lim = zoneLimits();
  if (lim.total <= 0) return;
  const z = settleZones({
    ...lim,
    top: sidebarState.tasksSize * lim.total,
    mid: sidebarState.inUseSize * lim.total,
  });
  set($zoneTasks, z.top);
  set($zoneInUse, containersOpen ? z.mid : null);
}

/**
 * Drags a zone divider (`top`: Tasks | In use, `bottom`: In use | Containers), with pointer
 * capture as the sidebar's resizer does; see `dragZones` for how the zones follow. A
 * double-click puts every zone back to its default size.
 *
 * @param {HTMLElement} divider @param {'top' | 'bottom'} line
 */
function dragZoneDivider(divider, line) {
  divider.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0 || divider.dataset.inert === 'true') return;
    ev.preventDefault();
    ev.stopPropagation();
    divider.setPointerCapture(ev.pointerId);
    divider.classList.add('dragging');
    document.body.classList.add('resizing-zones');
    const start = zoneLimits();
    // The divider's top edge, in the zones' own coordinates (dividers left out).
    const origin = $zoneTasks.getBoundingClientRect().top +
      (line === 'bottom' ? $dividerTasks.offsetHeight : 0);
    const grab = ev.clientY - divider.getBoundingClientRect().top;
    let moved = false;
    const onMove = (/** @type {PointerEvent} */ e) => {
      moved = true;
      const z = dragZones(start, line, e.clientY - grab - origin);
      sidebarState.tasksSize = z.top / start.total;
      sidebarState.inUseSize = z.mid / start.total;
      applyZoneSizes();
    };
    const onEnd = () => {
      divider.removeEventListener('pointermove', onMove);
      divider.removeEventListener('lostpointercapture', onEnd);
      divider.classList.remove('dragging');
      document.body.classList.remove('resizing-zones');
      // A click (or a double-click's two) moves nothing and saves nothing.
      if (moved) saveSidebarState();
    };
    divider.addEventListener('pointermove', onMove);
    divider.addEventListener('lostpointercapture', onEnd);
  });
  divider.addEventListener('dblclick', () => {
    sidebarState.inUseSize = null;
    sidebarState.tasksSize = null;
    saveSidebarState();
    applyZoneSizes();
  });
}

/**
 * The sidebar, in three zones, each scrolling on its own. Top: the Tasks section. Middle: In use,
 * the Pinned section (pinned files, only while something is pinned) and the Layout section (the
 * Golden Layout tree, single-child levels folded). Bottom: Containers, collapsible as a whole (Container → Terminals →
 * terminal, Container → Sessions → recent agent session, Container → Repos → repo → files, and
 * Container → Files → the container's own files from `/`).
 * Herdr tabs group nothing here: a pane the Herdr TUI split into a shared tab is just another pane.
 * Every running container is listed, Herdr or not; projects without one are listed last, under a
 * collapsed "Not running" group.
 */
function renderTree() {
  const generation = ++renderGeneration;
  const scroll = [
    $zoneInUse.scrollTop,
    $zoneTasks.scrollTop,
    $zoneBrowse.scrollTop,
  ];
  const sectionScroll = new Map();
  for (const el of $tree.querySelectorAll('.card-section')) {
    const box = /** @type {HTMLElement} */ (el);
    if (box.scrollTop > 0) {
      sectionScroll.set(box.dataset.sectionKey, box.scrollTop);
    }
  }
  const focusKey = focusedTreeKey($tree);
  // A just-created row takes the focus only from the sidebar, never from a terminal.
  const active = document.activeElement;
  const mayFocus = !active || active === document.body ||
    $tree.contains(active);
  const typing = newEntry !== null && active === newEntry.input;
  const caret = typing
    ? [newEntry.input.selectionStart, newEntry.input.selectionEnd]
    : null;
  // In use lists the tiles: it is re-rendered when they change (onViewState).
  const view = tileArea.state();
  shownLayout = layoutSignature(view);
  shownMarks = tileMarks(view);
  const cards = repoCards();
  const scoped = sidebarState.scope !== 'all';
  shownScopeCard = scoped ? scopeCardKey() : null;
  const upper = scoped
    ? inUseRows(cards, scopeShows(cards, shownScopeCard))
    : [...inUseRows(cards), ...pinnedFileRows()];
  const rows = [
    sectionRow(
      'Containers',
      sidebarState.containersOpen,
      toggleContainersSection,
      rowTrail(
        hoverActions(
          projectStarts ? iconButton('plus', 'Add project…', addProject) : '',
          iconButton('refresh', LABELS.refreshContainers, refreshContainers),
          iconButton('collapseAll', LABELS.collapseAll, collapseContainers),
        ),
      ),
      projectStarts
        ? (e) => openMenu(e, [['Add project…', addProject]])
        : undefined,
    ),
  ];
  // Projects with no running container: stopped, never created, or just pinned.
  const idle = [...projects.values()].filter((p) =>
    p.container !== 'running' && !containerByFolder(p.localFolder)
  ).sort(byPinThenRecent);
  if (
    sidebarState.containersOpen && containers.size === 0 && idle.length === 0
  ) {
    rows.push(
      h(
        'div',
        { class: 'empty' },
        socket ? 'No running dev containers.' : 'Waiting for devc web…',
      ),
    );
  }
  if (sidebarState.containersOpen && !scoped) {
    for (const c of containers.values()) rows.push(...containerRows(c, cards));
    if (idle.length > 0) rows.push(...inactiveRows(idle));
  }
  $zoneInUse.replaceChildren(...upper);
  $zoneTasks.replaceChildren(...taskRows());
  $zoneBrowse.replaceChildren(...(scoped ? [] : rows));
  $zoneBrowse.hidden = scoped;
  $dividerBrowse.hidden = scoped;
  if ($zoneInUse.parentNode !== $tree) {
    $tree.replaceChildren(
      $zoneTasks,
      $dividerTasks,
      $zoneInUse,
      $dividerBrowse,
      $zoneBrowse,
    );
  }
  $tree.classList.toggle('containers-closed', !containersShown());
  applyFilter();
  holdSections();
  floorInUseSections();
  applyZoneSizes();
  keepSectionHeights();
  [$zoneInUse.scrollTop, $zoneTasks.scrollTop, $zoneBrowse.scrollTop] = scroll;
  for (const el of $tree.querySelectorAll('.card-section')) {
    const box = /** @type {HTMLElement} */ (el);
    const top = sectionScroll.get(box.dataset.sectionKey);
    if (top) box.scrollTop = top;
  }
  const created = selectTreeKey === null
    ? null
    : treeRowByKey($tree, selectTreeKey);
  if (created) {
    selectTreeKey = null;
    if (mayFocus) {
      created.focus({ preventScroll: true });
      created.scrollIntoView({ block: 'nearest' });
    }
  } else refocusTreeKey($tree, focusKey);
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

/** A section heading; collapsible when `open` is given. */
function sectionRow(title, open, onToggle, trail = '', oncontextmenu) {
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
// Sidebar: In use section
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
function repoCards() {
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
    if (c.state !== 'connected') continue;
    const snap = snapshots.get(c.id);
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
 * The In use section: the active repo cards (see `repoCardActive`), each container's in a card of
 * its own under its name. Cards come most urgent agent first (see `statusRank`), those with no
 * agent last, then in the layout order of their first tile, then those with none in their
 * container's card order; containers where their first card is. A status change renders the
 * sidebar again, so cards move as their agents' statuses change. With `only` (a scoped sidebar),
 * the cards it takes instead, active or not.
 *
 * @param {(card: any) => boolean} [only]
 */
function inUseRows(cards, only) {
  const rows = [
    sectionRow(
      'In use',
      undefined,
      undefined,
      rowTrail(
        hoverActions(
          iconButton('refresh', LABELS.refreshSessions, refreshSessions),
        ),
      ),
    ),
  ];
  const rank = new Map();
  for (const card of cards.values()) {
    const shown = only ? only(card) : card.active;
    if (shown) rank.set(card, statusRank(cardPanes(card)));
  }
  const active = [...rank.keys()].sort((a, b) =>
    (rank.get(a) - rank.get(b)) || (a.firstTile - b.firstTile) ||
    (a.order - b.order)
  );
  if (active.length === 0) {
    rows.push(
      h(
        'div',
        { class: 'row tree-note', style: '--depth: 0' },
        h('span', { class: 'label' }, 'Nothing open'),
      ),
    );
  }
  const runs = new Map();
  for (const card of active) {
    let run = runs.get(card.localFolder);
    if (!run) {
      run = h(
        'div',
        { class: 'in-use-run' },
        h(
          'div',
          { class: 'in-use-run-name' },
          h('span', { class: 'label' }, containerNameOf(card.localFolder)),
        ),
      );
      runs.set(card.localFolder, run);
      rows.push(run);
    }
    run.append(repoCard(card));
  }
  return rows;
}

/**
 * The cards a scoped sidebar shows, given the focused tile's (`scopeCardKey`; null shows none):
 * that card alone (`repo`), or with its container's other active cards (`container`).
 */
function scopeShows(cards, key) {
  const focused = key === null ? undefined : cards.get(key);
  if (!focused) return () => false;
  if (sidebarState.scope === 'repo') return (card) => card === focused;
  return (card) =>
    card === focused ||
    (card.active && card.localFolder === focused.localFolder);
}

/** The focused tile's repo card's key, which a scoped sidebar shows; null for none or an empty tile. */
function scopeCardKey() {
  const tile = focusedTile(tileArea.state());
  if (!tile) return null;
  const { localFolder, repo } = tileRepo(tile);
  return localFolder ? repoCardKey(localFolder, repo?.folder ?? null) : null;
}

/** A card's panes: its tiles' (those still running), then those no tile shows. */
function cardPanes(card) {
  return [
    ...card.tiles.map(({ tile }) => resolveRef(tile.ref).pane).filter((p) => p),
    ...card.panes.map(({ pane }) => pane),
  ];
}

/** Lists the devcontainers and projects again, for what the server's `docker events` missed. */
function refreshContainers() {
  const id = nextId('r');
  pendingRequests.set(id, 'Refresh');
  send({ type: 'refresh_containers', id });
}

/** Lists every running container's sessions again. */
function refreshSessions() {
  for (const c of containers.values()) {
    if (c.state === 'connected') void loadSessions(c);
  }
}

/**
 * The name an In use group goes by: its repo's sidebar name, a worktree's main repo's (its
 * branch says which worktree), split into a muted parent path and the name itself.
 */
function repoGroupName(localFolder, repo) {
  const main = repo.primaryFolder ?? repo.worktreeOf;
  const named = main
    ? projectRepos(localFolder).find((r) => r.folder === main)
    : repo;
  return splitRepoName(named?.name ?? basename(main ?? repo.folder));
}

/** A repo's name as rows show it: the parent path muted, then the name itself. */
function repoNameParts({ prefix, base }) {
  return [
    prefix ? h('span', { class: 'repo-prefix' }, prefix) : '',
    h('span', { class: 'repo-base' }, base),
  ];
}

/** A container's name as rows show it, running or not. */
function containerNameOf(localFolder) {
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
 */
function repoCard(card, worktrees = 0) {
  const { key, localFolder, repo } = card;
  const c = containerByFolder(localFolder);
  const fr = { localFolder, root: repo ? repo.folder : localFolder };
  const branch = repo?.git?.branch;
  const hasHistory = card.sessions.length > 0;
  const historyOn = hasHistory && sidebarState.cardHistoryOpen.has(key);
  // Opened before this page listed the container's sessions: a Loading… section holds its place.
  const listed = c ? sessionLists.get(c.id) : undefined;
  const historyLoading = !hasHistory && !!c &&
    sidebarState.cardHistoryOpen.has(key) &&
    (!listed || (listed.loading && !listed.error));
  const canPr = !!repo && !!c;
  const prOn = canPr && sidebarState.prOpen.has(prKey(localFolder, fr.root));
  const tree = repo ? fileTree(fr) : null;
  const filesOn = !!tree && tree.isOpen('');
  const toggleHistory = () => {
    if (!sidebarState.cardHistoryOpen.delete(key)) {
      sidebarState.cardHistoryOpen.add(key);
    }
    saveSidebarState();
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
          repo
            ? [...dirMenuItems(fr, ''), ...jiraItems(branch)]
            : projectMenuItems(localFolder),
        ),
    },
    ...(repo
      ? [
        ...repoNameParts(repoGroupName(localFolder, repo)),
        branch ? h('span', { class: 'repo-branch' }, branch) : '',
        gitMark(gitSync(repo.git, repo.gitProblem)),
      ]
      : [h('span', { class: 'repo-base' }, containerNameOf(localFolder))]),
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
      () => togglePr(localFolder, fr.root),
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
      card.sessions.map(({ c: sc, s }) => sessionRow(sc, s, now, 1)),
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

// ---------------------------------------------------------------------------------------------
// Sidebar: the layout's tiles, as In use lists them
// ---------------------------------------------------------------------------------------------

/**
 * The tiling area's state changed (see {@link viewChanged}): renders again what shows it. A
 * change of layout or of what a tile shows rebuilds the tile rows; a title or unsaved mark
 * renders them again; focus moves the current-row marks, and in a scoped sidebar, the card shown.
 *
 * @param {ViewState} view
 */
function onViewState(view) {
  if (layoutSignature(view) !== shownLayout) {
    renderTree();
    return;
  }
  if (tileMarks(view) !== shownMarks) queueRender();
  updateCurrent();
  // A scoped sidebar's container or card is the focused tile's.
  if (sidebarState.scope !== 'all' && scopeCardKey() !== shownScopeCard) {
    queueRender();
  }
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
function layoutTileRow(tile, active, depth) {
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

/** Marks the focused tile's Layout row and its pane's Containers row(s). */
function updateCurrent() {
  const tile = focusedTile(tileArea.state());
  const { c } = resolveRef(tile?.ref ?? null);
  const key = c && tile?.ref ? paneKey(c.id, tile.ref.pane_id) : null;
  for (const row of $tree.querySelectorAll('[data-current]')) {
    row.removeAttribute('data-current');
  }
  if (!tile) return;
  for (const row of $tree.querySelectorAll('.row')) {
    const el = /** @type {HTMLElement} */ (row);
    if (
      el.dataset.tile === tile.id ||
      (key && el.classList.contains('pane') && el.dataset.paneKey === key)
    ) {
      el.setAttribute('data-current', '');
    }
  }
}

/**
 * Expands the pane's container and scrolls its Containers row into view, briefly flashed (see
 * `SidebarIntents.revealInContainers`).
 *
 * @param {PaneRef} ref
 */
function revealInContainers(ref) {
  const c = containerByFolder(ref.localFolder);
  if (!c) return;
  if (sidebarState.collapsed.delete(c.localFolder)) {
    saveSidebarState();
    renderTree();
  }
  const row = paneRows.get(paneKey(c.id, ref.pane_id))?.row;
  if (!row) return;
  row.scrollIntoView({ block: 'nearest' });
  row.classList.remove('flash');
  void row.offsetWidth;
  row.classList.add('flash');
}

// ---------------------------------------------------------------------------------------------
// Sidebar: Containers section
// ---------------------------------------------------------------------------------------------

/** Whether some tile shows the pane. */
function isVisible(c, pane) {
  return tileShowing(c, pane) !== null;
}

/** The most recently focused tile showing the pane, if any. */
function tileShowing(c, pane) {
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
 * A container's card in Containers: its row, then while it is expanded its repo cards that are not
 * in In use (see `repoCardActive`) nor a worktree's whose repo's card hides them, in card order,
 * and its Files row.
 */
function containerRows(c, cards) {
  const snap = c.state === 'connected' ? snapshots.get(c.id) : undefined;
  const panes = list(snap?.panes);
  const shown = [...cards.values()].filter((card) =>
    card.localFolder === c.localFolder && !card.active
  );
  // Folded, it opens while the filter matches one of its repo cards.
  const collapsed = sidebarState.collapsed.has(c.localFolder) &&
    !shown.some(cardMatchesFilter);
  const stateText = h(
    'span',
    { class: 'state', 'data-state': c.state },
    STATE_TEXT[c.state] ?? c.state,
  );
  const fr = { localFolder: c.localFolder, root: c.localFolder };
  /** @type {HTMLElement} */
  const head = h(
    'div',
    {
      class: 'row container',
      style: '--depth: 0',
      title: c.error ? `${c.localFolder}\n${c.error}` : c.localFolder,
      'aria-expanded': String(!collapsed),
      onclick: () => toggleContainer(c),
      oncontextmenu: (e) => openMenu(e, projectMenuItems(c.localFolder)),
    },
    h(
      'span',
      { class: 'label' },
      chevron(),
      displayName(c),
      pinMark(c),
      // Expanded, each repo card's own marks are right below.
      collapsed ? gitMark(gitRollup(projectRepos(c.localFolder))) : '',
    ),
    INACTIVE_STATES.has(c.state)
      ? h('span', { class: 'row-actions' }, stateText, herdrActions(c))
      : rowTrail(
        c.state !== 'connected' ? stateText : statusRollup(panes),
        hoverActions(
          // A new terminal at the project folder, starting Herdr first if it has no session.
          iconButton('plus', LABELS.newTerminal, () => {
            // Under the + at the row's right end, as newTerminalButton's.
            const r = head.getBoundingClientRect();
            openMenuAt(
              r.right - 20,
              r.bottom + 2,
              newTerminalMenuItems(fr, ''),
            );
          }),
          downButton(c),
          stopButton(c),
        ),
      ),
  );
  const rows = [head];
  if (collapsed) return [containerCard(rows, false)];
  // A worktree's card goes under its repo's when that one is here too, else as a repo's.
  const mainOf = (card) => {
    const main = card.repo?.worktreeOf;
    const key = main ? repoCardKey(c.localFolder, main) : null;
    return key && cards.get(key) && !cards.get(key).active ? key : null;
  };
  shown.forEach((card, i) => {
    const main = mainOf(card);
    if (main) {
      if (
        sidebarState.worktreesClosed.has(main) && !cardMatchesFilter(card)
      ) return;
      const el = repoCard(card);
      el.classList.add('worktree');
      // The rail on its left runs on to the next worktree's card under the same repo's.
      if (shown[i + 1] && mainOf(shown[i + 1]) === main) {
        el.classList.add('worktree-continues');
      }
      rows.push(el);
      return;
    }
    rows.push(
      repoCard(card, shown.filter((w) => mainOf(w) === card.key).length),
    );
  });
  rows.push(...containerFilesRows(c));
  return [containerCard(rows, true)];
}

/** A container's card as In use's: its own row on top, then the rest. */
function containerCard(rows, open) {
  return h(
    'div',
    { class: open ? 'container-card open' : 'container-card' },
    ...rows,
  );
}

/** A container's Files row, closed until opened; open, its filesystem under it. */
function containerFilesRows(c) {
  const open = sidebarState.containerFilesOpen.has(c.localFolder);
  const row = treeRow(
    `${c.localFolder}\n\nfiles`,
    0,
    open,
    {
      class: 'container-files',
      title: `The container's own filesystem, from /`,
      onclick: () => {
        if (!sidebarState.containerFilesOpen.delete(c.localFolder)) {
          sidebarState.containerFilesOpen.add(c.localFolder);
        }
        saveSidebarState();
        renderTree();
      },
      oncontextmenu: (e) =>
        openMenu(e, dirMenuItems(containerRoot(c.localFolder), '')),
    },
    LABELS.files,
  );
  return open ? [row, ...containerFileRows(c)] : [row];
}

/**
 * A container row's agents, a colored dot and count per status (most in need of attention
 * first), shown whichever view is open. Every agent is in the tooltip.
 */
function statusRollup(panes) {
  const counts = statusCounts(panes);
  if (counts.length === 0) return '';
  return h(
    'span',
    {
      class: 'status-rollup',
      title: panes.filter((p) => p.agent).map((p) =>
        `${paneTitle(p)}: ${p.agent} ${agentStatus(p)}`
      ).join('\n'),
    },
    ...counts.map(({ status, count }) =>
      h('span', { class: 'badge', 'data-status': status }, String(count))
    ),
  );
}

/**
 * Each running container's last `list_sessions` answer, by container id. `sessions` stays from
 * the previous answer while a new one loads.
 *
 * @type {Map<string, {loading: boolean, sessions: import('./lib/sessions.js').AgentSession[],
 *   error: string | null}>}
 */
const sessionLists = new Map();

/** Lists a container's recent agent sessions again (`list_sessions`). */
async function loadSessions(c) {
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

/** A container row's Stop button, when its project is known to be running. */
function stopButton(c) {
  const p = projects.get(c.localFolder);
  return p?.container === 'running'
    ? iconButton('stop', 'Stop container…', () => stopProject(p))
    : '';
}

/** A container row's Remove button (`devc down`), beside Stop: only while Stop is shown. */
function downButton(c) {
  const p = projects.get(c.localFolder);
  return p?.container === 'running'
    ? iconButton('trash', 'Remove container…', () => downProject(p))
    : '';
}

/** A Herdr-less container's hover buttons: Remove, Stop, Start Herdr (no session only) and Retry. */
function herdrActions(c) {
  return hoverActions(
    downButton(c),
    stopButton(c),
    c.state === 'no-session'
      ? iconButton(
        'play',
        'Start Herdr: a Herdr server for this session',
        () => startSession(c.id),
      )
      : '',
    h('button', {
      onclick: (e) => {
        e.stopPropagation();
        send({ type: 'retry', container: c.id });
      },
    }, 'Retry'),
  );
}

/** The "Not running" group: projects without a running container (`idle`). */
function inactiveRows(idle) {
  // Folded, it opens while the filter matches one of its projects.
  const open = sidebarState.inactiveOpen ||
    idle.some((p) => filterHas(containerLabel(p, projects.values())));
  const rows = [
    h(
      'div',
      {
        class: 'row group',
        style: '--depth: 0',
        'aria-expanded': String(open),
        onclick: toggleInactive,
      },
      h(
        'span',
        { class: 'label' },
        chevron(),
        `Not running (${idle.length})`,
      ),
    ),
  ];
  if (!open) return [containerCard(rows, false)];
  for (const p of idle) {
    rows.push(projectRow(p));
    if (sidebarState.projectsOpen.has(p.localFolder)) {
      // Just its own folder: its files go straight under the project row.
      const fr = { localFolder: p.localFolder, root: p.localFolder };
      const tree = fileTree(fr);
      if (!tree.isOpen('')) tree.expand('');
      rows.push(...rootEntryRows(fr, 2));
    }
  }
  return [containerCard(rows, true)];
}

// ---------------------------------------------------------------------------------------------
// Sidebar: projects without a running container
// ---------------------------------------------------------------------------------------------

/** Pinned first, then most recently used, then by name. */
function byPinThenRecent(a, b) {
  return Number(b.pinned) - Number(a.pinned) ||
    (b.lastUsed ?? '').localeCompare(a.lastUsed ?? '') ||
    a.name.localeCompare(b.name);
}

/** A pin glyph after a pinned project's name. */
function pinMark(project) {
  if (!projects.get(project.localFolder)?.pinned) return '';
  const mark = h('span', { class: 'pin-mark', title: 'Pinned' });
  mark.append(svgIcon('pin'));
  return mark;
}

/** ↑ push / ↓ pull counts, or a quiet ✓ / •, from `gitSync` or `gitRollup`; nothing for no repo. */
function gitMark(sync) {
  if (!sync) return '';
  return h(
    'span',
    {
      class: 'git-sync',
      title: sync.title,
      'data-diverged': sync.diverged,
    },
    ...sync.marks.map((m) => h('span', { 'data-dir': m.dir }, m.text)),
  );
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

/**
 * A running container's Files row: its own filesystem from `/`, read with `docker exec` whatever
 * Herdr's state (`list_container_dir`). Collapsed until opened. Open, `/workspaces` and the
 * remote user's home (once the server knows it) come first, each a folder row of its own.
 */
function containerFileRows(c) {
  const fr = containerRoot(c.localFolder);
  const tree = fileTree(fr);
  // The view is the root's listing: opening the view opens it.
  if (!tree.isOpen('')) tree.expand('');
  const rows = [];
  for (const root of containerShortcuts(c)) {
    const sfr = containerRoot(c.localFolder, root);
    const stree = fileTree(sfr);
    rows.push(
      treeRow(
        `${treeId(sfr)}\n`,
        1,
        stree.isOpen(''),
        {
          class: 'files-shortcut',
          title: pathTitle(sfr, ''),
          onclick: () => stree.toggle(''),
          oncontextmenu: (e) => openMenu(e, dirMenuItems(sfr, '')),
        },
        root,
      ),
    );
    if (stree.isOpen('')) rows.push(...rootEntryRows(sfr, 2));
  }
  rows.push(...rootEntryRows(fr, 1));
  return rows;
}

/** The folders a container's Files row lists first: `/workspaces`, then the home when apart. */
function containerShortcuts(c) {
  const home = c.home;
  const apart = typeof home === 'string' && home.startsWith('/') &&
    home !== '/' &&
    !isWithin('/workspaces', home);
  return apart ? ['/workspaces', home] : ['/workspaces'];
}

// ---------------------------------------------------------------------------------------------
// Sidebar: pull requests
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

/** A listed PR's header row, then its files as a tree (`buildPrTree`). */
function prListingRows(fr, result, depth) {
  const pr = result.pr;
  const review = prLists.get(prKey(fr.localFolder, fr.root))?.review ?? null;
  const files = list(result.files);
  const tree = buildPrTree(files);
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
  const buttons = () => {
    const toggle = iconButton(
      'viewed',
      hiding ? LABELS.showViewed(tree.viewed) : LABELS.hideViewed,
      togglePrHideViewed,
    );
    toggle.setAttribute('aria-pressed', String(hiding));
    return [
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
    h('span', { class: 'pr-count' }, `${tree.viewed}/${tree.total}`),
    // Hide viewed, while on, stays in sight as a repo card's toggles do, the buttons after it
    // kept as blank slots so it sits where hovering shows it.
    h(
      'span',
      { class: 'row-toggles' },
      ...(hiding
        ? buttons().map((b, i) => {
          if (i > 0) b.classList.add('slot');
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
  const walk = (dir, d) => {
    for (const sub of dir.dirs) {
      const open = prFolderOpen(foldersKey, sub);
      const row = treeRow(`${id}\npr\n${sub.path}/`, d, open, {
        class: 'pr-dir',
        'data-dim': sub.viewed === sub.total || undefined,
        title: sub.path,
        onclick: () => togglePrFolder(foldersKey, sub),
        oncontextmenu: (e) => openMenu(e, prDirMenuItems(fr, result, sub)),
      }, ...markedText(sub.name));
      row.append(
        rowTrail(
          h('span', { class: 'pr-count' }, `${sub.viewed}/${sub.total}`),
        ),
      );
      rows.push(row);
      if (open) walk(sub, d + 1);
    }
    for (const node of dir.files) {
      rows.push(prFileRow(fr, result, node, d));
    }
  };
  walk(hiding ? withoutViewed(tree) : tree, depth);
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
    ...(exists && !fr.container ? [null, filePinItem(fr, path)] : []),
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
function prViewed(ref, viewed) {
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

const PROJECT_STATE_TEXT = {
  starting: 'starting…',
  stopped: 'stopped',
  missing: 'not created',
};

/** Expands or collapses a project under "Not running", which shows its folder's files. */
function toggleProject(localFolder) {
  if (!sidebarState.projectsOpen.delete(localFolder)) {
    sidebarState.projectsOpen.add(localFolder);
  }
  saveSidebarState();
  renderTree();
}

function projectRow(p) {
  const output = projectOutput.get(p.localFolder) ?? [];
  const state = p.starting ? 'starting' : p.container;
  return h(
    'div',
    {
      class: 'row inactive project',
      style: '--depth: 1',
      'data-project': p.localFolder,
      'aria-expanded': String(sidebarState.projectsOpen.has(p.localFolder)),
      title: [p.localFolder, output.at(-1) ?? ''].filter((s) => s).join('\n'),
      onclick: () => toggleProject(p.localFolder),
      oncontextmenu: (e) =>
        openMenu(e, [
          ...projectMenuItems(p.localFolder),
          null,
          ...dirMenuItems(
            { localFolder: p.localFolder, root: p.localFolder },
            '',
          ),
        ]),
    },
    h(
      'span',
      { class: 'label' },
      chevron(),
      containerLabel(p, projects.values()),
      pinMark(p),
      gitMark(gitRollup(list(p.repos))),
    ),
    h(
      'span',
      { class: 'row-actions' },
      h(
        'span',
        { class: 'state', 'data-state': state },
        p.starting
          ? h('span', { class: 'spinner', 'aria-hidden': 'true' })
          : '',
        PROJECT_STATE_TEXT[state] ?? state,
      ),
      p.starting || !projectStarts ? '' : hoverActions(
        iconButton(
          'play',
          'Start container',
          () => startProject(p.localFolder),
        ),
      ),
    ),
  );
}

/** Container actions for a project (by folder), whichever row its menu is on. */
function projectMenuItems(localFolder) {
  const p = projects.get(localFolder);
  if (!p) return [];
  const items = [];
  if (p.container === 'running') {
    items.push(['Stop container…', () => stopProject(p)]);
  } else if (!p.starting && projectStarts) {
    items.push(['Start container', () => startProject(localFolder)]);
  }
  if (p.container !== 'missing' && !p.starting) {
    items.push(['Remove container…', () => downProject(p), true]);
  }
  if (p.pinned || projectStarts) {
    items.push([
      p.pinned ? 'Unpin' : 'Pin',
      () =>
        projectRequest('pin_project', localFolder, 'Pin', {
          pinned: !p.pinned,
        }),
    ]);
  }
  if (!p.pinned && p.container === 'missing' && !p.starting) {
    items.push([
      'Forget',
      () => projectRequest('forget_project', localFolder, 'Forget'),
    ]);
  }
  if (projectOutput.get(localFolder)?.length) {
    items.push(['Show output', () => showOutput(localFolder)]);
  }
  return items;
}

// ---------------------------------------------------------------------------------------------
// Sidebar: starting, stopping and removing containers
// ---------------------------------------------------------------------------------------------

async function stopProject(p) {
  if (
    await confirmDialog(
      `Stop the container for ${p.name}? Its panes end with it.`,
      { okLabel: 'Stop container', danger: true },
    )
  ) {
    projectRequest('stop_project', p.localFolder, 'Stop container');
  }
}

/** `devc down`: the container is stopped and deleted; the project stays listed. */
async function downProject(p) {
  if (
    await confirmDialog(
      `Remove the container for ${p.name}? Like devc down, it is stopped and deleted: its panes end, and anything outside its mounted folders and volumes is lost.`,
      { okLabel: 'Remove container', danger: true },
    )
  ) {
    projectRequest('down_project', p.localFolder, 'Remove container');
  }
}

function addProject() {
  openPicker();
}

/** One line of a container start's output (kept by `client.js`): on its row, and in an open dialog. */
function showProjectOutput(localFolder, line) {
  const lines = projectOutput.get(localFolder) ?? [];
  for (const row of $tree.querySelectorAll('[data-project]')) {
    const el = /** @type {HTMLElement} */ (row);
    if (el.dataset.project === localFolder) {
      el.title = `${localFolder}\n${line}`;
    }
  }
  if (outputDialog?.localFolder === localFolder) {
    const pre = outputDialog.pre;
    const atEnd = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 4;
    pre.textContent = lines.join('\n');
    if (atEnd) pre.scrollTop = pre.scrollHeight;
  }
}

/** @type {{localFolder: string, pre: HTMLElement, el: HTMLElement} | null} */
let outputDialog = null;

/** A dialog with a project's start output, following it while it runs. */
function showOutput(localFolder) {
  closeOutput();
  const pre = h(
    'pre',
    { class: 'dialog-output' },
    (projectOutput.get(localFolder) ?? []).join('\n'),
  );
  const el = h(
    'div',
    {
      class: 'dialog-backdrop',
      onmousedown: (e) => {
        if (e.target === el) closeOutput();
      },
    },
    h(
      'div',
      { class: 'dialog', role: 'dialog', 'aria-label': 'Start output' },
      h(
        'header',
        { class: 'dialog-header' },
        h('span', {}, `Start output · ${basename(localFolder)}`),
        h('button', { type: 'button', onclick: closeOutput }, 'Close'),
      ),
      pre,
    ),
  );
  document.body.append(el);
  pre.scrollTop = pre.scrollHeight;
  outputDialog = { localFolder, pre, el };
}

function closeOutput() {
  outputDialog?.el.remove();
  outputDialog = null;
}

// ---------------------------------------------------------------------------------------------
// Sidebar: Pinned section (pinned files)
// ---------------------------------------------------------------------------------------------

/**
 * A pin's row toggles its file's editor tile. Closing closes the tile only: the editor pane keeps
 * running in Herdr, so the next open (`open_pinned`, which reuses it) brings back the same buffer
 * and unsaved edits. Pins are kept by the server (`~/.config/devc/pinned-files.json`), so every
 * devc web window shows the same ones.
 */
function pinnedFileRows() {
  if (pinnedFiles.length === 0) return [];
  const rows = [
    sectionRow(
      LABELS.pinned,
      sidebarState.pinnedOpen,
      togglePinnedSection,
      rowTrail(hoverActions(iconButton('plus', LABELS.newNote, openNewNote))),
      (e) => openMenu(e, [[LABELS.newNote, openNewNote]]),
    ),
  ];
  if (!sidebarState.pinnedOpen) return rows;
  for (const pin of pinnedFiles) rows.push(filePinRow(pin));
  return rows;
}

/** @param {import('./lib/pinned_files.js').FilePin} pin */
function filePinRow(pin) {
  const open = filePinTiles(pin).length > 0;
  const p = projects.get(pin.localFolder);
  return h(
    'div',
    {
      class: open ? 'row file-pin visible' : 'row file-pin',
      style: '--depth: 1',
      'data-file-pin': pin.id,
      title: [
        childPath(pin.root, pin.path),
        open ? 'Shown in a tile: click to close it' : 'Click to open it',
      ].join('\n'),
      onclick: () => toggleFilePin(pin),
      oncontextmenu: (e) => openMenu(e, filePinMenuItems(pin)),
    },
    h(
      'span',
      { class: 'label' },
      rowIcon({ kind: 'file' }),
      filePinName(pin),
      h(
        'span',
        { class: 'pane-title' },
        p ? containerLabel(p, projects.values()) : basename(pin.localFolder),
      ),
    ),
    rowTrail(
      open ? h('span', { class: 'file-pin-dot', 'aria-label': 'Open' }) : '',
    ),
  );
}

/**
 * The tiles that are a pin's: those showing its editor pane and, while its project has no running
 * container, file tiles showing its file (the read-only fallback).
 *
 * @param {import('./lib/pinned_files.js').FilePin} pin
 */
function filePinTiles(pin) {
  const tiles = tileArea.state().tiles;
  const paneId = filePinPanes.get(pin.id);
  const shown = paneId
    ? tilesShowingPane(tiles, { localFolder: pin.localFolder, pane_id: paneId })
    : [];
  if (!containerByFolder(pin.localFolder)) {
    const file = {
      localFolder: pin.localFolder,
      root: pin.root,
      path: pin.path,
    };
    shown.push(...tiles.filter((t) => t.file && sameFile(t.file, file)));
  }
  return shown;
}

/**
 * A pin's click: closes the tiles showing it (tiles only, never the pane), else opens it.
 *
 * @param {import('./lib/pinned_files.js').FilePin} pin
 */
function toggleFilePin(pin) {
  const shown = filePinTiles(pin);
  if (shown.length === 0) {
    void openFilePin(pin, 'stack');
    return;
  }
  for (const t of shown) tileArea.close(t.id);
}

/** Pins with an `open_pinned` in flight: a second click waits for the first. */
const openingFilePins = new Set();

/**
 * Opens a pin's file in its editor pane (`open_pinned`: the pane it last had when that is still
 * running, else a new one), in a non-preview tile in the focused stack or to the right. A pane
 * already in a tile is focused there instead. With no running container, the file opens read-only.
 *
 * @param {import('./lib/pinned_files.js').FilePin} pin
 * @param {'stack' | 'right'} where
 */
async function openFilePin(pin, where) {
  if (openingFilePins.has(pin.id)) return;
  const c = containerByFolder(pin.localFolder);
  if (!c) {
    openFilePinReadOnly(pin, where);
    return;
  }
  if (c.state === 'no-session') toast('Starting Herdr…');
  openingFilePins.add(pin.id);
  let result;
  try {
    result = await call({ type: 'open_pinned', pin: pin.id });
  } catch (e) {
    if (e?.code === 'not_running') openFilePinReadOnly(pin, where);
    else errorToast(`Open ${filePinName(pin)} failed: ${e?.message ?? e}`);
    return;
  } finally {
    openingFilePins.delete(pin.id);
  }
  if (typeof result?.pane_id !== 'string') return;
  filePinPanes.set(pin.id, result.pane_id);
  saveFilePinPanes();
  placePane(pin.localFolder, result, { where });
}

/**
 * A pin's file in a file tile (the host-side viewer), for a stopped container: notes stay
 * readable. Offers to start the container.
 *
 * @param {import('./lib/pinned_files.js').FilePin} pin
 * @param {'stack' | 'right'} where
 */
function openFilePinReadOnly(pin, where) {
  openFileTile(
    { localFolder: pin.localFolder, root: pin.root },
    pin.path,
    where,
  );
  const p = projects.get(pin.localFolder);
  toast(
    `${
      filePinName(pin)
    }: the container is not running, so it opened read-only.`,
    projectStarts && p && !p.starting
      ? { label: 'Start', run: () => startProject(pin.localFolder) }
      : undefined,
  );
}

/** A pin's row menu. @param {import('./lib/pinned_files.js').FilePin} pin */
function filePinMenuItems(pin) {
  const fr = { localFolder: pin.localFolder, root: pin.root };
  return [
    ['Open to the right', () => void openFilePin(pin, 'right')],
    ['Open read-only', () => openFileTile(fr, pin.path, 'stack')],
    null,
    ...hostOpenItems(fr, pin.path),
    null,
    ...copyPathItems(fr, pin.path),
    null,
    ['Rename…', () => renameFilePin(pin)],
    null,
    [LABELS.unpinFile, () => unpinFile(pin)],
  ];
}

/** Relabels a pin; an empty name, or the file's own, goes back to the file's name. */
async function renameFilePin(pin) {
  const name = await promptDialog('Pinned file name', filePinName(pin));
  if (name === null) return;
  const label = name.trim() === basename(pin.path) ? '' : name.trim();
  call({ type: 'rename_pin', pin: pin.id, label }).catch((e) =>
    errorToast(`Rename failed: ${e?.message ?? e}`)
  );
}

/**
 * The open **New note…** dialog.
 *
 * @type {{el: HTMLDialogElement, $project: HTMLSelectElement, $path: HTMLInputElement,
 *   $error: HTMLElement, $create: HTMLButtonElement, edited: boolean, busy: boolean} | null}
 */
let newNote = null;

/** The repo a project's notes go in: the project folder's own. */
function noteRoot(localFolder) {
  return projectRepos(localFolder)[0]?.folder ?? localFolder;
}

/**
 * **New note…**: a project and a path in its repo (`.plans/notes.md` when the repo has a
 * `.plans/` folder, else `NOTES.md`). Creating makes the file (an existing one is fine) and pins
 * it, then opens it.
 */
function openNewNote() {
  newNote?.el.close();
  const candidates = [...projects.values()].sort(byPinThenRecent);
  if (candidates.length === 0) {
    toast('No projects yet: add one under Containers first');
    return;
  }
  const focused = focusedTile(tileArea.state());
  const near = focused?.ref?.localFolder ?? focused?.file?.localFolder;
  const initial = (near && projects.has(near) ? near : null) ??
    candidates.find((p) => containerByFolder(p.localFolder))?.localFolder ??
    candidates[0].localFolder;
  const $project = /** @type {HTMLSelectElement} */ (h(
    'select',
    {
      class: 'new-note-project',
      'aria-label': 'Project',
      onchange: () => suggestNotePath(),
    },
    ...candidates.map((p) =>
      h(
        'option',
        { value: p.localFolder, selected: p.localFolder === initial },
        containerLabel(p, projects.values()),
      )
    ),
  ));
  const $path = /** @type {HTMLInputElement} */ (h('input', {
    type: 'text',
    class: 'picker-path',
    spellcheck: 'false',
    autocomplete: 'off',
    'aria-label': 'Path in the repo',
    oninput: () => {
      if (newNote) newNote.edited = true;
      showNoteError(null);
    },
    onkeydown: (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      void submitNewNote();
    },
  }));
  const $error = h('div', { class: 'new-note-error', hidden: true });
  const $create = /** @type {HTMLButtonElement} */ (h('button', {
    type: 'button',
    class: 'primary',
    onclick: () => void submitNewNote(),
  }, 'Create and pin'));
  const el = /** @type {HTMLDialogElement} */ (h(
    'dialog',
    {
      class: 'dialog new-note',
      'aria-label': 'New note',
      onclose: () => {
        if (newNote?.el === el) newNote = null;
        el.remove();
      },
    },
    h(
      'header',
      { class: 'dialog-header' },
      h('span', {}, 'New note'),
      h('button', { type: 'button', onclick: () => el.close() }, 'Cancel'),
    ),
    h(
      'div',
      { class: 'new-note-body' },
      h('label', {}, 'Project', $project),
      h('label', {}, "File, in the project's repo", $path),
      $error,
    ),
    h(
      'footer',
      { class: 'dialog-footer' },
      h(
        'span',
        { class: 'picker-hint' },
        'Created if missing (its folder must exist), then pinned',
      ),
      $create,
    ),
  ));
  newNote = {
    el,
    $project,
    $path,
    $error,
    $create,
    edited: false,
    busy: false,
  };
  document.body.append(el);
  el.showModal();
  suggestNotePath();
  $path.focus();
}

/** Fills in the path for the selected project, unless it was typed. */
function suggestNotePath() {
  const nn = newNote;
  if (!nn || nn.edited) return;
  const localFolder = nn.$project.value;
  nn.$path.value = 'NOTES.md';
  showNoteError(null);
  call({ type: 'list_dir', localFolder, root: noteRoot(localFolder), path: '' })
    .then((result) => {
      if (newNote !== nn || nn.edited || nn.$project.value !== localFolder) {
        return;
      }
      nn.$path.value = defaultNotePath(list(result?.entries));
    }, () => {/* NOTES.md stays */});
}

/** Shows `message` under the dialog's fields, or hides it with `null`. */
function showNoteError(message) {
  if (!newNote) return;
  newNote.$error.textContent = message ?? '';
  newNote.$error.hidden = message === null;
}

/**
 * Creates the note (`create_file`, where `exists` is fine: the file is pinned as it is), pins it
 * (`pin_file`) and opens it. A missing folder is reported, not created. With no running
 * container, an existing file is still pinned.
 */
async function submitNewNote() {
  const nn = newNote;
  if (!nn || nn.busy) return;
  const path = nn.$path.value.trim();
  const invalid = notePathError(path);
  if (invalid !== null) {
    showNoteError(invalid);
    return;
  }
  const localFolder = nn.$project.value;
  const root = noteRoot(localFolder);
  const c = containerByFolder(localFolder);
  nn.busy = true;
  nn.$create.disabled = true;
  let pinId;
  try {
    if (c) {
      await call({
        type: 'create_file',
        container: c.id,
        root,
        path,
        kind: 'file',
      })
        .catch((e) => {
          if (e?.code !== 'exists') throw e;
        });
    }
    pinId = (await call({ type: 'pin_file', localFolder, root, path }))?.pin;
  } catch (e) {
    nn.busy = false;
    nn.$create.disabled = false;
    showNoteError(
      !c && e?.code === 'not_found'
        ? `${path} does not exist: start the container to create it`
        : String(e?.message ?? e),
    );
    return;
  }
  nn.el.close();
  if (!sidebarState.pinnedOpen) togglePinnedSection();
  const pin = pinnedFiles.find((p) => p.id === pinId);
  if (!pin) return;
  const shown = filePinTiles(pin);
  if (shown.length) tileArea.reveal(shown[0].id);
  else void openFilePin(pin, 'stack');
}

// ---------------------------------------------------------------------------------------------
// Sidebar: Tasks section
// ---------------------------------------------------------------------------------------------

/**
 * The Tasks section: to-dos kept by the server (`~/.config/devc/tasks.json`), each routed to a
 * project's repo or not yet, grouped under a node per route (the unrouted ones last). Sending one
 * starts an agent on it there and moves it under Sent, which reopens that agent's session.
 * Agents never write to the list.
 */
function taskRows() {
  const counts = [
    `${tasks.length} open`,
    sentTasks.length ? `${sentTasks.length} sent` : '',
  ].filter((t) => t).join(' · ');
  const rows = [
    sectionRow(
      LABELS.tasks,
      sidebarState.tasksOpen,
      toggleTasksSection,
      rowTrail(
        h('span', { class: 'section-count' }, counts),
        hoverActions(
          iconButton('plus', LABELS.newTask, () => openTaskDialog()),
          iconButton('collapseAll', LABELS.collapseAll, collapseTasks),
        ),
      ),
      (e) => openMenu(e, [[LABELS.newTask, () => openTaskDialog()]]),
    ),
  ];
  if (!sidebarState.tasksOpen) return rows;
  if (tasks.length === 0) {
    rows.push(
      h(
        'div',
        { class: 'row tree-note', style: '--depth: 1' },
        h('span', { class: 'label' }, LABELS.noTasks),
      ),
    );
  }
  if (selectedTasks.size) rows.push(taskSelectionRow());
  const places = queuePlaces(tasks);
  for (const group of groupTasks(tasks)) {
    rows.push(taskGroupRow(group));
    if (!sidebarState.taskGroupsClosed.has(group.key)) {
      for (const task of group.tasks) rows.push(taskRow(task, places));
    }
  }
  if (sentTasks.length === 0) return rows;
  rows.push(h(
    'div',
    {
      class: 'row sent-tasks',
      style: '--depth: 1',
      'aria-expanded': String(sidebarState.sentOpen),
      onclick: toggleSentTasks,
    },
    h(
      'span',
      { class: 'label' },
      chevron(),
      `${LABELS.sentTasks} (${sentTasks.length})`,
    ),
  ));
  if (sidebarState.sentOpen) {
    for (const s of sentTasks) rows.push(sentTaskRow(s));
  }
  return rows;
}

/**
 * The selected tasks' row, while any are: how many, then hover-free buttons that queue the
 * routed ones (`queue_tasks`) to the agent a row's send uses, for a plan or to be implemented,
 * and one that clears the selection. Each repo's queue sends its tasks one at a time, each
 * once the agent before it there is done; different repos' queues run side by side.
 */
function taskSelectionRow() {
  const agentLabel = LABELS.agents[taskSendAgent()];
  const queueable = queueableTasks(tasks, selectedTasks);
  const n = queueable.length;
  const skipped = selectedTasks.size - n;
  const queueButton = (/** @type {'plan' | 'implement'} */ action) => {
    const b = iconButton(
      action,
      n
        ? `Queue ${n} for ${agentLabel}: ${action}`
        : 'Nothing to queue: only routed tasks not already queued can be',
      () => void queueSelected(action),
    );
    /** @type {HTMLButtonElement} */ (b).disabled = n === 0;
    return b;
  };
  return h(
    'div',
    {
      class: 'row task-selection',
      style: '--depth: 1',
      title: [
        `${selectedTasks.size} selected`,
        skipped
          ? `${skipped} not routed or already queued: queueing leaves them`
          : '',
        'Each repo sends its queued tasks one at a time, repos side by side',
      ].filter((t) => t).join('\n'),
    },
    h('span', { class: 'label' }, `${selectedTasks.size} selected`),
    rowTrail(
      queueButton('plan'),
      queueButton('implement'),
      iconButton('close', 'Clear selection', clearTaskSelection),
    ),
  );
}

/**
 * Tasks ticked in the Tasks section, in the order ticked (their queue order), for queueing; this
 * page's own, forgotten on reload.
 */
const selectedTasks = new Set();

/** Ticks or unticks task `id`. */
function selectTask(id, on) {
  if (on) selectedTasks.add(id);
  else selectedTasks.delete(id);
  renderTree();
}

function clearTaskSelection() {
  selectedTasks.clear();
  renderTree();
}

/** Ticks every task of a group, or unticks them all when all are ticked. */
function selectTaskGroup(group) {
  const all = group.tasks.every((t) => selectedTasks.has(t.id));
  for (const t of group.tasks) {
    if (all) selectedTasks.delete(t.id);
    else selectedTasks.add(t.id);
  }
  renderTree();
}

/**
 * Queues the selected routed tasks (`queue_tasks`), in the order they were ticked, to be sent as `action` to the
 * agent a row's send uses, and clears the selection.
 *
 * @param {'plan' | 'implement'} action
 */
async function queueSelected(action) {
  const ids = queueableTasks(tasks, selectedTasks).map((t) => t.id);
  if (!ids.length) return;
  try {
    await call({
      type: 'queue_tasks',
      tasks: ids,
      agent: taskSendAgent(),
      action,
    });
  } catch (e) {
    errorToast(`Queue failed: ${e?.message ?? e}`);
    return;
  }
  clearTaskSelection();
}

/** Takes a task out of its repo's queue (`unqueue_task`). */
function unqueue(task) {
  call({ type: 'unqueue_task', task: task.id }).catch((e) =>
    errorToast(`Remove from queue failed: ${e?.message ?? e}`)
  );
}

/** Queues a task that failed to send again, at the end of its repo's queue, as it was. */
function requeue(task) {
  if (!task.queued) return;
  call({
    type: 'queue_tasks',
    tasks: [task.id],
    agent: task.queued.agent,
    action: task.queued.action,
  }).catch((e) => errorToast(`Queue failed: ${e?.message ?? e}`));
}

/**
 * A task's route, repo first as In use has it: its repo's name (null when routed to the project
 * alone, or to a repo that goes by the container's own name) and its container's.
 */
function taskRoute(localFolder, root) {
  const p = projects.get(localFolder);
  const container = p
    ? containerLabel(p, projects.values())
    : basename(localFolder);
  if (root === undefined) return { repo: null, container };
  const name = list(p?.repos).find((r) => r.folder === root)?.name ??
    basename(root);
  return { repo: name === container ? null : name, container };
}

/** The dimmed route after a task's title: its repo, then its container. */
function taskProjectLabel(localFolder, root) {
  if (localFolder === undefined) return LABELS.notRouted;
  const { repo, container } = taskRoute(localFolder, root);
  return repo ? `${repo} · ${container}` : container;
}

/** A task group's route: its repo, then its container muted, as an In use row ends. */
function taskRouteParts(localFolder, root) {
  if (localFolder === undefined) return [LABELS.notRouted];
  const { repo, container } = taskRoute(localFolder, root);
  return repo
    ? [repo, h('span', { class: 'row-container' }, container)]
    : [container];
}

/**
 * A task group's node: its route (or `not routed`) and how many tasks it holds. A click opens or
 * closes it; a routed one offers a new task routed there.
 *
 * @param {ReturnType<typeof groupTasks>[number]} group
 */
function taskGroupRow(group) {
  const { key, localFolder, root } = group;
  const route = localFolder === undefined || root === undefined
    ? null
    : { localFolder, root };
  const queued = group.tasks.filter((t) => t.queued).length;
  const selectItem = [
    group.tasks.every((t) => selectedTasks.has(t.id))
      ? 'Deselect these tasks'
      : 'Select these tasks',
    () => selectTaskGroup(group),
  ];
  return h(
    'div',
    {
      class: 'row task-group',
      style: '--depth: 1',
      'data-task-group': key,
      'aria-expanded': String(!sidebarState.taskGroupsClosed.has(key)),
      title: route?.root,
      onclick: () => toggleTaskGroup(key),
      oncontextmenu: (e) =>
        openMenu(
          e,
          route
            ? [[LABELS.newTaskHere, () => newTaskIn(route)], selectItem]
            : [selectItem],
        ),
    },
    h(
      'span',
      { class: 'label' },
      chevron(),
      ...taskRouteParts(localFolder, root),
    ),
    rowTrail(
      h(
        'span',
        { class: 'pane-title' },
        queued
          ? `${queued} queued · ${group.tasks.length}`
          : String(group.tasks.length),
      ),
      route
        ? hoverActions(
          iconButton('task', LABELS.newTaskHere, () => newTaskIn(route)),
        )
        : '',
    ),
  );
}

/**
 * A task's row, under its group: its checkbox selects it for queueing, and a click edits it. A
 * queued one shows its place in its repo's queue (or `failed`, its queue halted on it). Its
 * hover buttons send it now (to the agent the dialog last sent to) when it is routed, take it
 * out of its queue or queue it again, and delete it.
 *
 * @param {import('./lib/tasks.js').Task} task
 * @param {Map<string, number>} places from `queuePlaces`
 */
function taskRow(task, places) {
  const agentLabel = LABELS.agents[taskSendAgent()];
  const stop = (e) => e.stopPropagation();
  const checkbox = h('input', {
    type: 'checkbox',
    class: 'task-check',
    'aria-label': `Select: ${taskTitle(task.text)}`,
    title: 'Select, to queue with others',
    onclick: stop,
    onmousedown: stop,
    onchange: (e) =>
      selectTask(task.id, /** @type {HTMLInputElement} */ (e.target).checked),
  });
  /** @type {HTMLInputElement} */ (checkbox).checked = selectedTasks.has(
    task.id,
  );
  const q = task.queued;
  const place = places.get(task.id);
  const queueNote = !q
    ? ''
    : q.error
    ? `Sending failed: ${q.error}\nIts repo's queue waits on it.`
    : `Queued #${place} for ${LABELS.agents[q.agent]}: ${q.action}` +
      (place === 1 ? '\nSent once nothing else runs in its repo.' : '');
  return h(
    'div',
    {
      class: 'row task',
      style: '--depth: 2',
      'data-task': task.id,
      ...(q ? { 'data-queued': q.error ? 'failed' : String(place) } : {}),
      title: [task.text, queueNote, 'Click to edit'].filter((t) => t).join(
        '\n\n',
      ),
      onclick: () => openTaskDialog(task),
    },
    h(
      'span',
      { class: 'label' },
      checkbox,
      taskTitle(task.text),
    ),
    rowTrail(
      q
        ? h(
          'span',
          { class: 'pane-title task-queued' },
          q.error ? 'failed' : `queued #${place}`,
        )
        : '',
      hoverActions(
        ...(q
          ? [
            ...(q.error
              ? [iconButton('refresh', 'Queue again', () => requeue(task))]
              : []),
            iconButton('close', 'Remove from queue', () => unqueue(task)),
          ]
          : []),
        ...(task.localFolder === undefined ? [] : [
          iconButton(
            'plan',
            `Send to ${agentLabel}: plan`,
            () => void sendTaskFromRow(task, 'plan'),
          ),
          iconButton(
            'implement',
            `Send to ${agentLabel}: implement`,
            () => void sendTaskFromRow(task, 'implement'),
          ),
        ]),
        iconButton('trash', LABELS.deleteEntry, () => void deleteTask(task)),
      ),
    ),
  );
}

/** The agent the task dialog last sent to, as stored; `null` when there is none. */
function storedTaskAgent() {
  try {
    return localStorage.getItem(TASK_AGENT_KEY);
  } catch {
    return null;
  }
}

/** The default for new tasks pinned in the task dialog; `null` when there is none. */
function storedTaskDefault() {
  try {
    return parseTaskDefault(localStorage.getItem(TASK_DEFAULT_KEY));
  } catch {
    return null;
  }
}

/**
 * Pins `value` as the default for new tasks, or clears it with `null`.
 *
 * @param {import('./lib/tasks.js').TaskDefault | null} value
 */
function storeTaskDefault(value) {
  try {
    if (value === null) localStorage.removeItem(TASK_DEFAULT_KEY);
    else localStorage.setItem(TASK_DEFAULT_KEY, JSON.stringify(value));
  } catch { /* storage unavailable */ }
}

/** The agent a task starts on: the pinned default's, else the last one sent to, else Claude. */
function taskSendAgent() {
  return storedTaskDefault()?.agent ?? savedTaskAgent(storedTaskAgent());
}

/** Tasks with a `send_task` from their row in flight: a second click waits for the first. */
const sendingTasks = new Set();

/**
 * Sends a routed task from its row (`send_task`) to the agent the dialog last sent to, and shows
 * the agent's pane in the focused stack.
 *
 * @param {import('./lib/tasks.js').Task} task @param {'plan' | 'implement'} action
 */
async function sendTaskFromRow(task, action) {
  const { localFolder, root } = task;
  if (localFolder === undefined || root === undefined) return;
  if (sendingTasks.has(task.id)) return;
  const c = containerByFolder(localFolder);
  if (!c) {
    notRunningToast(localFolder, taskTitle(task.text));
    return;
  }
  if (c.state === 'no-session') toast('Starting Herdr…');
  sendingTasks.add(task.id);
  let result;
  try {
    result = await call({
      type: 'send_task',
      task: task.id,
      localFolder,
      root,
      agent: taskSendAgent(),
      action,
    });
  } catch (e) {
    if (e?.code === 'not_running') {
      notRunningToast(localFolder, taskTitle(task.text));
    } else errorToast(`Send failed: ${e?.message ?? e}`);
    return;
  } finally {
    sendingTasks.delete(task.id);
  }
  if (typeof result?.pane_id === 'string') placePane(localFolder, result);
}

/** A new task routed to folder root `fr`'s project and repo. */
function newTaskIn(fr) {
  openTaskDialog(undefined, { localFolder: fr.localFolder, root: fr.root });
}

/** @param {import('./lib/tasks.js').SentTask} s */
function sentTaskRow(s) {
  return h(
    'div',
    {
      class: 'row sent-task',
      style: '--depth: 2',
      'data-sent-task': s.id,
      title: sentTaskTooltip(s, LABELS.agents[s.agent]),
      onclick: () => viewSentTask(s),
      oncontextmenu: (e) =>
        openMenu(e, [
          ['View task', () => viewSentTask(s)],
          ['Open session', () => void openSentTask(s)],
          ['Copy task text', () => void copyTaskText(s)],
          ['Back to tasks', () => restoreSentTask(s)],
          ['Remove', () => removeSentTask(s)],
        ]),
    },
    h(
      'span',
      { class: 'label' },
      rowIcon({ agent: s.agent }),
      taskTitle(s.text),
      h(
        'span',
        { class: 'pane-title' },
        taskProjectLabel(s.localFolder, s.root),
      ),
    ),
  );
}

/**
 * A sent task, read-only: its text, where it went and how. **Open session** opens its session
 * as a click on its row once did ({@link openSentTask}).
 *
 * @param {import('./lib/tasks.js').SentTask} s
 */
function viewSentTask(s) {
  taskDialog?.el.close();
  const $text = /** @type {HTMLTextAreaElement} */ (h('textarea', {
    class: 'task-text',
    readonly: true,
    rows: 8,
    'aria-label': 'Task',
  }));
  $text.value = s.text;
  const field = (label, value) =>
    h(
      'label',
      {},
      label,
      h('span', { class: 'task-field', title: value }, value),
    );
  const sentAt = new Date(s.sentAt);
  const el = /** @type {HTMLDialogElement} */ (h(
    'dialog',
    {
      class: 'dialog new-note task-dialog',
      'aria-label': 'Sent task',
      onclose: () => el.remove(),
    },
    h('header', { class: 'dialog-header' }, h('span', {}, 'Sent task')),
    h(
      'div',
      { class: 'new-note-body' },
      $text,
      h(
        'div',
        { class: 'task-route' },
        field('Route', taskProjectLabel(s.localFolder, s.root)),
        field('Agent', LABELS.agents[s.agent]),
        field('Sent as', s.action === 'plan' ? 'Plan' : 'Implement'),
        field(
          'Sent',
          Number.isNaN(sentAt.getTime()) ? s.sentAt : sentAt.toLocaleString(),
        ),
      ),
    ),
    h(
      'footer',
      { class: 'dialog-footer' },
      h('span', { class: 'picker-hint', title: s.cwd }, s.cwd),
      h(
        'span',
        { class: 'task-buttons' },
        h('button', { type: 'button', onclick: () => el.close() }, 'Close'),
        h('button', {
          type: 'button',
          class: 'primary',
          onclick: () => {
            el.close();
            void openSentTask(s);
          },
        }, 'Open session'),
      ),
    ),
  ));
  document.body.append(el);
  el.showModal();
}

/** @param {import('./lib/tasks.js').Task} task */
async function deleteTask(task) {
  if (
    !await confirmDialog(`Delete the task “${taskTitle(task.text)}”?`, {
      okLabel: 'Delete',
      danger: true,
    })
  ) return;
  call({ type: 'delete_task', task: task.id }).catch((e) =>
    errorToast(`Delete failed: ${e?.message ?? e}`)
  );
}

/** Sent tasks with an `open_sent` in flight: a second click waits for the first. */
const openingSentTasks = new Set();

/**
 * A sent task's session, in the focused stack: its agent's pane while that is still running,
 * else the session resumed in a new tab (`open_sent`). A pane already in a tile is focused.
 *
 * @param {import('./lib/tasks.js').SentTask} s
 */
async function openSentTask(s) {
  if (openingSentTasks.has(s.id)) return;
  const c = containerByFolder(s.localFolder);
  if (!c) {
    notRunningToast(s.localFolder, taskTitle(s.text));
    return;
  }
  if (c.state === 'no-session') toast('Starting Herdr…');
  openingSentTasks.add(s.id);
  let result;
  try {
    result = await call({ type: 'open_sent', task: s.id });
  } catch (e) {
    if (e?.code === 'not_running') {
      notRunningToast(s.localFolder, taskTitle(s.text));
    } else errorToast(`Open session failed: ${e?.message ?? e}`);
    return;
  } finally {
    openingSentTasks.delete(s.id);
  }
  if (typeof result?.pane_id !== 'string') return;
  placePane(s.localFolder, result);
}

/** "`what`: the container is not running", offering to start it. */
function notRunningToast(localFolder, what) {
  const p = projects.get(localFolder);
  toast(
    `${what}: the container is not running.`,
    projectStarts && p && !p.starting
      ? { label: 'Start', run: () => startProject(localFolder) }
      : undefined,
  );
}

/** @param {import('./lib/tasks.js').SentTask} s */
async function copyTaskText(s) {
  try {
    await writeClipboard(s.text);
    toast('Copied');
  } catch (e) {
    errorToast(`Copy failed: ${e?.message ?? e}`);
  }
}

/** @param {import('./lib/tasks.js').SentTask} s */
function restoreSentTask(s) {
  call({ type: 'restore_task', task: s.id }).catch((e) =>
    errorToast(`Back to tasks failed: ${e?.message ?? e}`)
  );
}

/** Forgets a sent task; its agent's pane, if still running, stays. */
function removeSentTask(s) {
  call({ type: 'delete_task', task: s.id }).catch((e) =>
    errorToast(`Remove failed: ${e?.message ?? e}`)
  );
}

/**
 * The open task dialog. `taskId` is the task being edited, or set once a new one is saved.
 *
 * @type {{el: HTMLDialogElement, $text: HTMLTextAreaElement, $project: HTMLSelectElement,
 *   $repo: HTMLSelectElement, $repoLabel: HTMLElement, $agent: HTMLSelectElement,
 *   $error: HTMLElement, $buttons: HTMLButtonElement[], $send: HTMLButtonElement[],
 *   taskId: string | null, busy: boolean} | null}
 */
let taskDialog = null;

/**
 * The task dialog, for a new task or `task`: its text, its route (a project and one of its repos,
 * or none) and an agent. **Save** keeps it on the list; the header's **Send: plan** /
 * **Send: implement** icons save it, then send it (`send_task`) and show the agent's pane.
 *
 * A new task opens routed to `route` when it is given, else to the pinned default's route, else
 * (with no default pinned) to the focused tile's project. The header row's pin makes the
 * dialog's project, repo and agent the default for new tasks, or clears it.
 *
 * @param {import('./lib/tasks.js').Task} [task]
 * @param {{localFolder: string, root: string}} [route]
 */
function openTaskDialog(task, route) {
  taskDialog?.el.close();
  const candidates = [...projects.values()].sort(byPinThenRecent);
  const pinned = storedTaskDefault();
  const pinnedRoute = pinned?.localFolder !== undefined &&
      projects.has(pinned.localFolder)
    ? { localFolder: pinned.localFolder, root: pinned.root ?? null }
    : null;
  const focused = focusedTile(tileArea.state());
  // A default pinned without a route means "not routed": the focused tile does not count.
  const pinnedUnrouted = pinned !== null && pinned.localFolder === undefined;
  const near = route?.localFolder ?? pinnedRoute?.localFolder ??
    (pinnedUnrouted
      ? undefined
      : focused?.ref?.localFolder ?? focused?.file?.localFolder);
  const initial = task
    ? task.localFolder ?? ''
    : near && projects.has(near)
    ? near
    : '';
  const initialRoot = task ? task.root ?? null : route?.root ??
    (initial === pinnedRoute?.localFolder ? pinnedRoute.root : null);
  const $text = /** @type {HTMLTextAreaElement} */ (h('textarea', {
    class: 'task-text',
    spellcheck: 'true',
    rows: 8,
    'aria-label': 'Task',
    placeholder: 'What should be done? The first line is its title.',
    oninput: () => showTaskError(null),
    onkeydown: (e) => {
      if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey)) return;
      e.preventDefault();
      void submitTask(null);
    },
  }));
  $text.value = task?.text ?? '';
  const $project = /** @type {HTMLSelectElement} */ (h(
    'select',
    {
      class: 'new-note-project',
      'aria-label': 'Project',
      onchange: () => {
        fillTaskRepos(null);
        showPinned();
      },
    },
    h('option', { value: '', selected: initial === '' }, '(not routed)'),
    ...candidates.map((p) =>
      h(
        'option',
        { value: p.localFolder, selected: p.localFolder === initial },
        containerLabel(p, projects.values()),
      )
    ),
  ));
  const $repo = /** @type {HTMLSelectElement} */ (h('select', {
    class: 'new-note-project',
    'aria-label': 'Repo',
    onchange: () => showPinned(),
  }));
  const $repoLabel = h('label', {}, 'Repo', $repo);
  const $agent = /** @type {HTMLSelectElement} */ (h(
    'select',
    {
      class: 'new-note-project',
      'aria-label': 'Agent',
      onchange: () => {
        titleSends();
        showPinned();
      },
    },
    ...TASK_AGENT_IDS.map((id) =>
      h('option', { value: id }, LABELS.agents[id])
    ),
  ));
  $agent.value = taskSendAgent();
  const $error = h('div', { class: 'new-note-error', hidden: true });
  const $save = /** @type {HTMLButtonElement} */ (h('button', {
    type: 'button',
    class: 'primary',
    onclick: () => void submitTask(null),
  }, 'Save'));
  /** @type {['plan', 'implement']} */
  const actions = ['plan', 'implement'];
  const $send = actions.map((
    action,
  ) => /** @type {HTMLButtonElement} */ (iconButton(
    action,
    '',
    () => void submitTask(action),
  )));
  // The icons name the agent they send to, so they follow the Agent dropdown.
  const titleSends = () => {
    const agentLabel = LABELS.agents[$agent.value];
    $send.forEach(($b, i) => {
      const title = `Send to ${agentLabel}: ${actions[i]}`;
      $b.title = title;
      $b.setAttribute('aria-label', title);
    });
  };
  titleSends();
  // The dialog's project, repo and agent, as a default for new tasks would store them.
  const current = () =>
    $project.value === '' ? { agent: /** @type {any} */ ($agent.value) } : {
      localFolder: $project.value,
      root: $repo.value,
      agent: /** @type {any} */ ($agent.value),
    };
  const isPinned = () => {
    const saved = storedTaskDefault();
    const now = current();
    return saved !== null && saved.agent === now.agent &&
      saved.localFolder === now.localFolder && saved.root === now.root;
  };
  const $pin = /** @type {HTMLButtonElement} */ (iconButton('pin', '', () => {
    storeTaskDefault(isPinned() ? null : current());
    showPinned();
    renderTree();
  }));
  // The pin is pressed while the dialog shows the pinned default.
  const showPinned = () => {
    const on = isPinned();
    const title = on ? LABELS.unpinTaskDefault : LABELS.pinTaskDefault;
    $pin.setAttribute('aria-pressed', String(on));
    $pin.title = title;
    $pin.setAttribute('aria-label', title);
  };
  const el = /** @type {HTMLDialogElement} */ (h(
    'dialog',
    {
      class: 'dialog new-note task-dialog',
      'aria-label': task ? 'Task' : 'New task',
      onclose: () => {
        if (taskDialog?.el === el) taskDialog = null;
        el.remove();
      },
    },
    h(
      'header',
      { class: 'dialog-header' },
      h('span', {}, task ? 'Task' : 'New task'),
      h('span', { class: 'task-send' }, ...$send),
    ),
    h(
      'div',
      { class: 'new-note-body' },
      $text,
      h(
        'div',
        { class: 'task-route' },
        h('label', {}, 'Project', $project),
        $repoLabel,
        h('label', {}, 'Agent', $agent),
        $pin,
      ),
      $error,
    ),
    h(
      'footer',
      { class: 'dialog-footer' },
      h(
        'span',
        { class: 'picker-hint' },
        'Sending starts the agent in the repo',
      ),
      h(
        'span',
        { class: 'task-buttons' },
        h('button', { type: 'button', onclick: () => el.close() }, 'Cancel'),
        $save,
      ),
    ),
  ));
  taskDialog = {
    el,
    $text,
    $project,
    $repo,
    $repoLabel,
    $agent,
    $error,
    $buttons: [$save, ...$send, $pin],
    $send,
    taskId: task?.id ?? null,
    busy: false,
  };
  document.body.append(el);
  el.showModal();
  fillTaskRepos(initialRoot);
  showPinned();
  $text.focus();
}

/**
 * Lists the selected project's repos (selecting `root` when it is one of them), hides the Repo
 * field when there is no choice, and enables Send only for a routed task.
 */
function fillTaskRepos(root) {
  const td = taskDialog;
  if (!td) return;
  const localFolder = td.$project.value;
  const repos = localFolder === ''
    ? []
    : projectRepos(localFolder).filter((r, i) => i === 0 || r.git !== null);
  if (localFolder !== '' && repos.length === 0) {
    repos.push({ folder: localFolder });
  }
  td.$repo.replaceChildren(
    ...repos.map((r) =>
      h(
        'option',
        { value: r.folder, title: r.folder, selected: r.folder === root },
        r.name ?? basename(r.folder),
      )
    ),
  );
  if (root !== null && repos.some((r) => r.folder === root)) {
    td.$repo.value = root;
  }
  td.$repoLabel.hidden = repos.length < 2;
  for (const b of td.$send) b.disabled = td.busy || localFolder === '';
  showTaskError(null);
}

/** Shows `message` under the task dialog's fields, or hides it with `null`. */
function showTaskError(message) {
  if (!taskDialog) return;
  taskDialog.$error.textContent = message ?? '';
  taskDialog.$error.hidden = message === null;
}

/**
 * Saves the dialog's task (`add_task` or `update_task`), then with `action` sends it
 * (`send_task`) and shows the agent's pane in the focused stack. A failure keeps the dialog open
 * with the error; a task saved before a failed send stays saved, and stays on the list.
 *
 * @param {'plan' | 'implement' | null} action
 */
async function submitTask(action) {
  const td = taskDialog;
  if (!td || td.busy) return;
  const text = td.$text.value.trim();
  if (text === '') {
    showTaskError('Write the task first');
    return;
  }
  const localFolder = td.$project.value;
  const root = td.$repo.value;
  const route = localFolder !== '' && root !== '' ? { localFolder, root } : {};
  if (action !== null && !('localFolder' in route)) {
    showTaskError('Choose a project to send it to');
    return;
  }
  if (action !== null && !containerByFolder(localFolder)) {
    showTaskError('The container is not running: start it first');
    notRunningToast(localFolder, taskTitle(text));
    return;
  }
  const busy = (on) => {
    td.busy = on;
    for (const b of td.$buttons) b.disabled = on;
    if (!on) fillTaskRepos(td.$repo.value);
  };
  busy(true);
  try {
    if (td.taskId === null) {
      td.taskId = (await call({ type: 'add_task', text, ...route }))?.task ??
        null;
    } else {
      await call({ type: 'update_task', task: td.taskId, text, ...route });
    }
  } catch (e) {
    busy(false);
    showTaskError(String(e?.message ?? e));
    return;
  }
  if (action === null || td.taskId === null) {
    td.el.close();
    return;
  }
  const agent = td.$agent.value;
  try {
    localStorage.setItem(TASK_AGENT_KEY, agent);
  } catch { /* storage unavailable */ }
  const c = containerByFolder(localFolder);
  if (c?.state === 'no-session') toast('Starting Herdr…');
  let result;
  try {
    result = await call({
      type: 'send_task',
      task: td.taskId,
      localFolder,
      root,
      agent,
      action,
    });
  } catch (e) {
    busy(false);
    showTaskError(String(e?.message ?? e));
    return;
  }
  td.el.close();
  if (typeof result?.pane_id === 'string') placePane(localFolder, result);
}

// ---------------------------------------------------------------------------------------------
// Directory trees: shared by the repo file trees and the folder picker
// ---------------------------------------------------------------------------------------------

let renderQueued = false;

/** Renders the sidebar once, after everything else that changes in this turn. */
function queueRender() {
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
function treeRows(tree, root, depth, entryRow) {
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
function treeRow(key, depth, expanded, attrs, ...label) {
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
function treeKeydown(e, actions) {
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
function focusedTreeKey(container) {
  const el = /** @type {HTMLElement | null} */ (document.activeElement);
  return el && container.contains(el) ? el.dataset.treeKey ?? null : null;
}

/** The row with tree key `key` inside `container`, if there is one. */
function treeRowByKey(container, key) {
  for (const el of container.querySelectorAll('[data-tree-key]')) {
    const row = /** @type {HTMLElement} */ (el);
    if (row.dataset.treeKey === key) return row;
  }
  return null;
}

function refocusTreeKey(container, key) {
  if (key === null) return;
  treeRowByKey(container, key)?.focus({ preventScroll: true });
}

// ---------------------------------------------------------------------------------------------
// Sidebar: the filter
// ---------------------------------------------------------------------------------------------

/** Boxes whose first child heads the rest: a repo's card, a container's, an In use run. */
const HEADED_BOXES = ['repo-card', 'container-card', 'in-use-run'];

/** @typedef {import('./lib/sidebar.js').OutlineNode & {el: Element, children?: any[]}} FilterNode */

/**
 * Filters the rows rendered: with a query in the filter box, each zone shows the rows whose text
 * matches it with everything under them, and the rows above them; section headings always show.
 * A folded row's contents are not rendered, so they are not searched.
 */
function applyFilter() {
  const query = filterQuery.trim();
  for (const el of $tree.querySelectorAll('.filter-hidden, .filter-match')) {
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
  for (const zone of [$zoneTasks, $zoneInUse, $zoneBrowse]) {
    const nodes = [...zone.children].map(nodeOf);
    filterOutline(nodes);
    mark(nodes);
  }
}

/** Whether the filter has a query, and `text` matches it. */
function filterHas(text) {
  return filterQuery.trim() !== '' && filterMatches(text, filterQuery);
}

/**
 * Whether the filter matches a repo card's header (its repo's name and branch, or for the card of
 * what is outside every repo, its container's name), so a folded row it is under opens.
 */
function cardMatchesFilter(card) {
  if (!card.repo) return filterHas(containerNameOf(card.localFolder));
  const { prefix, base } = repoGroupName(card.localFolder, card.repo);
  return filterHas(`${prefix}${base} ${card.repo.git?.branch ?? ''}`);
}

/** Typing in the filter box filters the rows; Escape empties it, Down steps into the rows. */
function filterKeydown(e) {
  if (e.key === 'Escape' && $filter.value) {
    $filter.value = '';
    filterQuery = '';
    renderTree();
  } else if (e.key === 'Escape') {
    $filter.blur();
  } else if (e.key === 'ArrowDown') {
    const first = [...$tree.querySelectorAll('[data-tree-key]')].find((r) =>
      !r.closest('.filter-hidden')
    );
    /** @type {HTMLElement | undefined} */ (first)?.focus();
  } else return;
  e.preventDefault();
  e.stopPropagation();
}

// ---------------------------------------------------------------------------------------------
// Sidebar: project files
// ---------------------------------------------------------------------------------------------

/**
 * A file root's key: a repo mounted by two projects has a tree in each (container paths differ).
 * A container root's never matches a repo's: those are absolute.
 */
function treeId(fr) {
  if (!fr.container) return `${fr.localFolder}\n${fr.root}`;
  return `${fr.localFolder}\ncontainer${fr.root === '/' ? '' : `:${fr.root}`}`;
}

/** Where a file root's open folders are saved in `sidebarState.filesOpen`. */
function openKey(fr) {
  if (!fr.container) return fr.root;
  return `container:${fr.localFolder}${fr.root === '/' ? '' : `\n${fr.root}`}`;
}

/** Each file root's tree, by {@link treeId}: made when its row is first drawn. */
const fileTrees = new Map();
/** Saved open folders of each tree still listing after a reload: one that fails is dropped. */
const restoringFiles = new Map();
/** The container each tree was last listed for, so a container start lists it again. */
const filesListedFor = new Map();

/**
 * @param {FileRoot} fr
 * @returns {ReturnType<typeof createDirTree>}
 */
function fileTree(fr) {
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
function relistForContainers() {
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
function pathTitle(fr, path) {
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
    toast('Start the container first');
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
function newTerminalMenuItems(fr, path) {
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
      c ? 'Start Herdr in this container first' : 'Start the container first',
    );
    return;
  }
  newShell(c, { cwd: containerFilePath(fr, path) });
}

/** A folder's menu: the root itself (`path` '', its repo or Files row) or a directory under it. */
function dirMenuItems(fr, path) {
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
// Sidebar: new files and folders
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
    toast('Start the container first');
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
    toast('Start the container first');
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
    toast('Start the container first');
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
    ...(fr.container ? [] : [filePinItem(fr, path)]),
    null,
    ...changeEntryItems(fr, path, 'file'),
  ];
}

/** The folders and files of an open root, at `depth`, and an inline name row if it has one. */
function rootEntryRows(fr, depth) {
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

// ---------------------------------------------------------------------------------------------
// "Add project…": the host folder picker
// ---------------------------------------------------------------------------------------------

/**
 * The open picker: its tree of host folders (absolute paths), the folders shown at its top
 * (`null` until the server names the opening roots) and the selected folder.
 *
 * @type {{el: HTMLDialogElement, tree: ReturnType<typeof createDirTree>, $list: HTMLElement,
 *   $path: HTMLInputElement, $pin: HTMLButtonElement, tops: string[] | null,
 *   selected: string | null} | null}
 */
let picker = null;

function openPicker() {
  picker?.el.close();
  const tree = createDirTree({
    list: (path) => call({ type: 'list_host_dir', path }),
    onChange: () => renderPicker(),
  });
  const $list = h('div', {
    class: 'picker-tree',
    role: 'tree',
    'aria-label': 'Host folders',
  });
  $list.addEventListener('keydown', (e) =>
    treeKeydown(e, {
      activate: (row) => pinFolder(row.dataset.path ?? null),
      toggle: (row) => row.dataset.path && tree.toggle(row.dataset.path),
    }));
  const $path = /** @type {HTMLInputElement} */ (h('input', {
    class: 'picker-path',
    type: 'text',
    spellcheck: 'false',
    autocomplete: 'off',
    autofocus: true,
    placeholder: 'Pick a folder below, or paste an absolute path',
    'aria-label': 'Folder',
    onkeydown: (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const path = $path.value.trim().replace(/(.)\/+$/, '$1');
      if (path.startsWith('/')) rerootPicker(path);
      else toast('Enter an absolute path');
    },
  }));
  const $pin = /** @type {HTMLButtonElement} */ (h('button', {
    type: 'button',
    class: 'primary',
    disabled: true,
    onclick: () => pinFolder(picker?.selected ?? null),
  }, 'Pin this folder'));
  const el = /** @type {HTMLDialogElement} */ (h(
    'dialog',
    {
      class: 'dialog picker',
      'aria-label': 'Add project',
      onclose: () => {
        if (picker?.el === el) picker = null;
        el.remove();
      },
    },
    h(
      'header',
      { class: 'dialog-header' },
      h('span', {}, 'Add project'),
      h('button', { type: 'button', onclick: () => el.close() }, 'Cancel'),
    ),
    h('div', { class: 'picker-body' }, $path, $list),
    h(
      'footer',
      { class: 'dialog-footer' },
      h(
        'span',
        { class: 'picker-hint' },
        h('span', { class: 'project-mark' }, svgIcon('project')),
        'has a dev container config',
      ),
      $pin,
    ),
  ));
  picker = { el, tree, $list, $path, $pin, tops: null, selected: null };
  document.body.append(el);
  el.showModal();
  renderPicker();
  call({ type: 'list_host_dir', path: '' }).then(
    (result) => {
      if (picker?.tree !== tree) return;
      const roots = list(result?.roots).filter((r) => typeof r === 'string');
      picker.tops = roots;
      if (roots.length === 1) tree.expand(roots[0]);
      renderPicker();
    },
    (e) => {
      errorToast(`Add project failed: ${e?.message ?? e}`);
      if (picker?.tree === tree) el.close();
    },
  );
}

/** Shows only `path` at the top of the picker, open and selected. */
function rerootPicker(path) {
  if (!picker) return;
  picker.tops = [path];
  picker.tree.expand(path);
  selectFolder(path);
}

function selectFolder(path) {
  if (!picker) return;
  picker.selected = path;
  if (picker.$path.value !== (path ?? '')) {
    picker.$path.value = path ?? '';
    // The end of a long path is the folder's own name.
    picker.$path.scrollLeft = picker.$path.scrollWidth;
  }
  picker.$pin.disabled = path === null;
  for (const el of picker.$list.querySelectorAll('[data-path]')) {
    const row = /** @type {HTMLElement} */ (el);
    row.toggleAttribute('data-selected', row.dataset.path === path);
    row.setAttribute('aria-selected', String(row.dataset.path === path));
  }
}

/** Pins `path` as a project (`add_project`) and closes the picker. */
function pinFolder(path) {
  if (!picker || !path) return;
  projectRequest('add_project', path, 'Add project');
  // It joins the list as "not created", under "Not running".
  sidebarState.inactiveOpen = true;
  saveSidebarState();
  picker.el.close();
}

/** The top folder the selection is in (else the first): what "Parent folder" goes above. */
function pickerTop() {
  const tops = picker?.tops ?? [];
  const sel = picker?.selected;
  return tops.find((t) =>
    sel && (sel === t || sel.startsWith(t === '/' ? '/' : `${t}/`))
  ) ?? tops[0] ?? null;
}

function renderPicker() {
  if (!picker) return;
  const { tree, $list } = picker;
  const focusKey = focusedTreeKey($list);
  const scroll = $list.scrollTop;
  const rows = [];
  if (picker.tops === null) {
    rows.push(
      h('div', { class: 'row tree-note', style: '--depth: 0' }, 'Loading…'),
    );
  } else {
    const parent = parentDir(pickerTop() ?? '/');
    if (parent !== null) {
      rows.push(
        h(
          'div',
          {
            class: 'row tree-row picker-up',
            style: '--depth: 0',
            title: parent,
            onclick: () => rerootPicker(parent),
          },
          h('span', { class: 'label' }, '↑ Parent folder'),
        ),
      );
    }
    for (const top of picker.tops) {
      rows.push(pickerRow(top, top, 0, tree.isOpen(top), false));
      if (tree.isOpen(top)) {
        rows.push(
          ...treeRows(
            tree,
            top,
            1,
            (item) =>
              pickerRow(
                item.path,
                item.entry.name,
                item.depth,
                item.open,
                item.entry.project === true,
                isHiddenName(item.entry.name),
              ),
          ),
        );
      }
    }
  }
  $list.replaceChildren(...rows);
  $list.scrollTop = scroll;
  selectFolder(picker.selected);
  refocusTreeKey($list, focusKey);
}

function pickerRow(path, name, depth, open, project, hidden = false) {
  return treeRow(
    path,
    depth,
    open,
    {
      class: 'picker-row',
      role: 'treeitem',
      'data-path': path,
      'data-dim': hidden || undefined,
      title: path,
      onfocus: () => selectFolder(path),
      onclick: () => {
        selectFolder(path);
        picker?.tree.toggle(path);
      },
      ondblclick: () => pinFolder(path),
    },
    name,
    project
      ? h('span', {
        class: 'project-mark',
        title: 'Has a dev container config',
      }, svgIcon('project'))
      : '',
  );
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
function paneRow(c, pane, depth, space = '') {
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

function startSession(containerId) {
  const id = nextId('r');
  pendingRequests.set(id, 'Start session');
  send({ type: 'start_session', id, container: containerId });
}

// ---------------------------------------------------------------------------------------------
// Sidebar: mounting
// ---------------------------------------------------------------------------------------------

/** The tiling area, as the sidebar reaches it (see `lib/view.js`): set by {@link mountSidebar}. */
let tileArea = /** @type {TileArea} */ (null);

/** What the connection indicator says in each state. */
const CONN_TEXT = {
  'no-token': 'no token',
  connecting: 'connecting',
  open: 'live',
  closed: 'disconnected',
};

/** The connection indicator, and what the sidebar shows without a token or a connection. */
function onSidebarConnection(state) {
  if ($conn) {
    $conn.dataset.state = state === 'no-token' ? 'closed' : state;
    $conn.textContent = CONN_TEXT[state];
  }
  if (state === 'no-token') {
    $tree.replaceChildren(
      h(
        'div',
        { class: 'empty' },
        'This page needs the URL devc web printed, including its #token=… part.',
      ),
    );
  } else if (state === 'closed') renderTree();
}

/** A server message, as the sidebar takes it once `client.js` has applied it. */
function onSidebarMessage(msg) {
  switch (msg.type) {
    case 'hello':
      // Listings asked for while disconnected never got an answer.
      for (const { tree } of fileTrees.values()) tree.refresh('');
      // The server's own copy of each list may be gone (a restart): open Sessions rows list again.
      sessionLists.clear();
      prLists.clear();
      queueRender();
      for (const top of picker?.tops ?? []) picker?.tree.refresh(top);
      break;
    case 'containers':
      relistForContainers();
      renderTree();
      break;
    case 'projects':
    case 'pinned_files':
    case 'tasks':
      // A task sent, deleted or edited away elsewhere is no longer selected.
      for (const id of selectedTasks) {
        if (!tasks.some((t) => t.id === id)) selectedTasks.delete(id);
      }
      renderTree();
      break;
    case 'snapshot':
    case 'pane_updated':
    case 'agent_status':
      renderTree();
      break;
    case 'project_output':
      showProjectOutput(msg.localFolder, msg.line);
      break;
  }
}

/**
 * Mounts the sidebar into `root` (today's `aside.sidebar`: its header, and `#tree`) and returns
 * the tiling area's way in. `tileArea` is how the sidebar reaches the tiling area (see
 * `lib/view.js`).
 *
 * @param {HTMLElement} root
 * @param {{tileArea: TileArea}} opts
 * @returns {{intents: SidebarIntents, onViewState: (state: ViewState) => void}}
 */
export function mountSidebar(root, opts) {
  tileArea = opts.tileArea;
  $sidebar = root;
  $tree = /** @type {HTMLElement} */ (root.querySelector('#tree'));
  $conn = root.querySelector('#conn');
  $scopePicker = root.querySelector('#scope');
  $filter = /** @type {HTMLInputElement} */ (h('input', {
    class: 'sidebar-filter-input',
    type: 'search',
    placeholder: LABELS.filter,
    'aria-label': LABELS.filter,
    spellcheck: 'false',
    autocomplete: 'off',
    oninput: () => {
      filterQuery = $filter.value;
      renderTree();
    },
    onkeydown: filterKeydown,
  }));
  $tree.before(h('div', { class: 'sidebar-filter' }, $filter));
  setMenuContext({
    tileArea,
    fileTreeOf: fileTree,
    filePinned: openPinnedSection,
  });
  $scopePicker?.addEventListener('click', (e) => {
    const option = /** @type {HTMLElement} */ (e.target).closest?.(
      '[data-scope]',
    );
    if (option) setScope(/** @type {any} */ (option).dataset.scope);
  });
  $scopePicker?.addEventListener('keydown', scopePickerKeydown);
  // The page's URL, token included: devc-desktop's window has no address bar, and a container or
  // another browser may need it. The toast names it without showing it, since it is the token.
  root.querySelector('#copy-url')?.addEventListener('click', () => {
    navigator.clipboard?.writeText(location.href).then(
      () => toast('Copied page URL'),
      (e) => errorToast(`Copy failed: ${e?.message ?? e}`),
    );
  });
  window.addEventListener('resize', applyZoneSizes);
  dragZoneDivider($dividerTasks, 'top');
  dragZoneDivider($dividerBrowse, 'bottom');
  // Hovering a pane's row in either section highlights its rows in the other.
  $tree.addEventListener('mouseover', (e) => {
    const row = /** @type {HTMLElement} */ (e.target).closest?.(
      '[data-pane-key]',
    );
    const key = row ? /** @type {HTMLElement} */ (row).dataset.paneKey : null;
    for (const el of $tree.querySelectorAll('[data-pane-key]')) {
      el.classList.toggle(
        'linked',
        key !== null && /** @type {HTMLElement} */
          (el).dataset.paneKey === key &&
          el !== row,
      );
    }
  });
  $tree.addEventListener('mouseleave', () => {
    for (const el of $tree.querySelectorAll('.linked')) {
      el.classList.remove('linked');
    }
  });
  $tree.addEventListener('keydown', (e) =>
    treeKeydown(e, {
      activate: (row) => row.click(),
      toggle: (row) => row.click(),
    }));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeOutput();
  }, true);

  // Capture phase, so it works while a terminal has focus: xterm.js never sees the keys (on a Mac,
  // Option would type a character). Ctrl+Alt+N (Cmd+Alt+N on a Mac) toggles the first pinned file.
  document.addEventListener('keydown', (e) => {
    if (!isFilePinShortcut(e, IS_MAC)) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.repeat) return;
    if (pinnedFiles.length) toggleFilePin(pinnedFiles[0]);
    else openNewNote();
  }, true);

  onServerMessage(onSidebarMessage);
  onConnectionChange(onSidebarConnection);
  applyScope();
  renderTree();
  return { intents: { revealInContainers, prViewed }, onViewState };
}
