// The `devc web` sidebar, in three zones: Tasks, the to-dos sent to agents; In use, the repo cards
// of what is open and the pinned files; and Containers, every running container's repo cards and
// the projects not running, which `containers.js` draws (mounted in the bottom zone, reached
// through what `mountContainers` returns, and reaching In use through the `InUseLink` it is
// given). The repo cards both draw are `cards.js`'s; the task dialog is `task-dialog.js`'s. It
// reaches the tiling area only through the `TileArea` `mountSidebar` is given (`lib/view.js`), so
// it can run on a page of its own (`/sidebar`), as the Containers section can (`/containers`).

import {
  sameFile,
  sameFileView,
  tilesShowingPane,
} from './lib/layout_state.js';
import { focusedTile, inUseState } from './lib/view.js';
import {
  byName,
  collapseTasksState,
  containerLabel,
  dragZones,
  isSidebarScope,
  repoCardKey,
  settleZones,
  SIDEBAR_SCOPES,
  statusRank,
  ZONE_MIN_HEIGHT,
} from './lib/sidebar.js';
import { mediaKind } from './lib/media.js';
import { childPath } from './lib/files.js';
import {
  defaultNotePath,
  filePinName,
  isFilePinShortcut,
  notePathError,
} from './lib/pinned_files.js';
import {
  groupTasks,
  queueableTasks,
  queuePlaces,
  sentTaskTooltip,
  taskTitle,
} from './lib/tasks.js';
import {
  chevron,
  confirmDialog,
  errorToast,
  h,
  hoverActions,
  iconButton,
  IS_MAC,
  LABELS,
  openMenu,
  promptDialog,
  rowIcon,
  rowTrail,
  toast,
  writeClipboard,
} from './ui.js';
import { CONN_TEXT } from './lib/host_status.js';
import {
  basename,
  call,
  containerByFolder,
  containers,
  dashboard,
  filePinPanes,
  list,
  onConnectionChange,
  onServerMessage,
  pinnedFiles,
  projectRepos,
  projects,
  projectStarts,
  resolveRef,
  saveFilePinPanes,
  sentTasks,
  tasks,
  tileRepo,
} from './client.js';
import {
  copyPathItems,
  dashboardFileRef,
  dashboardItem,
  hostOpenItems,
  openFileTile,
  openInBrowser,
  placePane,
  previewable,
  setDashboard,
  setMenuContext,
  startProject,
  unpinFile,
} from './menus.js';
import {
  applyFilter,
  cardsMessage,
  containerNameOf,
  fileTree,
  holdSections,
  keepSectionHeights,
  listsSessions,
  loadSessions,
  mountCards,
  onCardsViewState,
  onRepoGitDone,
  prViewed,
  queueRender,
  renderPass,
  repoCard,
  saveSidebarState,
  sectionRow,
  setFilterQuery,
  setStoredScope,
  sidebarState,
} from './cards.js';
import { mountContainers } from './containers.js';
import {
  closeTaskDialog,
  newTaskIn,
  notRunningToast,
  openTaskDialog,
  setTaskContext,
  taskSendAgent,
} from './task-dialog.js';

/** @typedef {import('./lib/view.js').SidebarIntents} SidebarIntents */
/** @typedef {import('./lib/view.js').ContainersIntents} ContainersIntents */
/** @typedef {import('./lib/view.js').InUseLink} InUseLink */
/** @typedef {import('./lib/view.js').TileArea} TileArea */
/** @typedef {import('./lib/view.js').ViewState} ViewState */

/** Where the sidebar's state is saved (`cards.js`), with the page's own fields (`app.js`). */
export { SIDEBAR_KEY } from './cards.js';

/** The focused tile's repo card at a scoped sidebar's last render (`scopeCardKey`). */
let shownScopeCard = /** @type {string | null} */ (null);

/** The sidebar, its tree, connection indicator and scope picker: set by {@link mountSidebar}. */
let $sidebar = /** @type {HTMLElement} */ (null);
let $tree = /** @type {HTMLElement} */ (null);
let $conn = /** @type {HTMLElement | null} */ (null);
let $scopePicker = /** @type {HTMLElement | null} */ (null);
/** The header's dashboard button (`#dashboard`), when the page has one. */
let $dashboardButton = /** @type {HTMLElement | null} */ (null);
/** The filter box above the zones (its query is `cards.js`' `applyFilter`'s). */
let $filter = /** @type {HTMLInputElement | null} */ (null);
/** The tiling area, as the sidebar reaches it (see `lib/view.js`): set by {@link mountSidebar}. */
let tileArea = /** @type {TileArea} */ (null);
/**
 * The Containers section in the Containers zone (`containers.js`), and the one on another page
 * of the view (`/containers`), when this is the `/sidebar` page: In use's way to them both.
 */
let containersSection =
  /** @type {ReturnType<typeof mountContainers>} */ (null);
let otherContainers = /** @type {ContainersIntents | null} */ (null);
/** `/sidebar`'s `#…&containers=external`: no Containers section here (see `mountSidebar`). */
let containersExternal = false;
/** The cards In use showed at the last render (`card.active`): Containers' stand-ins. */
let shownInUse = new Set();
/** In use's cards and pins as last told (`onInUse`), so it is told again only on a change. */
let toldInUse = '';
/** Tells another page's Containers section In use's cards and pins (`/sidebar`); null on `/`. */
let onInUse =
  /** @type {((state: {inUse: string[], pinned: string[]}) => void) | null} */ (
    null
  );
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
// Sidebar: folding, the scope, and the zones
// ---------------------------------------------------------------------------------------------

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

function toggleTasksSection() {
  sidebarState.tasksOpen = !sidebarState.tasksOpen;
  saveSidebarState();
  renderTree();
}

/** Folds the Tasks section, as a task goes to an agent: the agent's pane takes the attention. */
function foldTasksSection() {
  if (!sidebarState.tasksOpen) return;
  sidebarState.tasksOpen = false;
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
  setStoredScope(scope);
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

/**
 * Whether the Containers section is open: a scoped sidebar hides it, as if folded, and one drawn
 * elsewhere (`containers=external`) is never shown here.
 */
function containersShown() {
  return !containersExternal && sidebarState.containersOpen &&
    sidebarState.scope === 'all';
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
 * The sidebar, in three zones, each scrolling on its own. Top: the Tasks section. Middle: In use
 * (the repo cards of what is open) and the Pinned section (pinned files, only while something is
 * pinned). Bottom: Containers, collapsible as a whole (`containers.js` draws it). A scoped
 * sidebar shows Tasks and the focused tile's cards only.
 */
function renderTree() {
  renderPass((cards) => {
    const scroll = [
      $zoneInUse.scrollTop,
      $zoneTasks.scrollTop,
      $zoneBrowse.scrollTop,
    ];
    const scoped = sidebarState.scope !== 'all';
    shownScopeCard = scoped ? scopeCardKey() : null;
    shownInUse = new Set(
      [...cards.values()].filter((card) => card.active).map((card) => card.key),
    );
    const upper = scoped
      ? inUseRows(cards, scopeShows(cards, shownScopeCard))
      : [...inUseRows(cards), ...pinnedFileRows()];
    $zoneInUse.replaceChildren(...upper);
    $zoneTasks.replaceChildren(...taskRows());
    if (scoped) $zoneBrowse.replaceChildren();
    else containersSection.draw(cards);
    $zoneBrowse.hidden = scoped || containersExternal;
    $dividerBrowse.hidden = scoped || containersExternal;
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
    applyFilter([$zoneTasks, $zoneInUse, $zoneBrowse]);
    holdSections();
    floorInUseSections();
    applyZoneSizes();
    keepSectionHeights();
    [$zoneInUse.scrollTop, $zoneTasks.scrollTop, $zoneBrowse.scrollTop] =
      scroll;
  });
  tellInUse();
}

// ---------------------------------------------------------------------------------------------
// Sidebar: In use section
// ---------------------------------------------------------------------------------------------

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
    run.append(repoCard(card, inUseSide));
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

/** Lists every running container's sessions again. */
function refreshSessions() {
  for (const c of containers.values()) {
    if (listsSessions(c)) void loadSessions(c);
  }
}

// ---------------------------------------------------------------------------------------------
// Sidebar: following the tiling area, and In use's link with Containers
// ---------------------------------------------------------------------------------------------

/**
 * The tiling area's state changed (see {@link viewChanged}): renders again what shows it (see
 * `onCardsViewState`), and in a scoped sidebar, the card shown.
 *
 * @param {ViewState} view
 */
function onViewState(view) {
  onCardsViewState(view);
  // A scoped sidebar's container or card is the focused tile's.
  if (sidebarState.scope !== 'all' && scopeCardKey() !== shownScopeCard) {
    queueRender();
  }
}

/**
 * Pins a repo card to In use, where it stays with no terminal or agent in it (`repoCardActive`),
 * or unpins it. Saved with the sidebar's state, by card key, so it lasts across reloads; a pin
 * whose container isn't listed shows nothing until it is again.
 *
 * @param {string} key @param {boolean} pinned
 */
function setCardPinned(key, pinned) {
  if (sidebarState.cardsPinned.has(key) === !!pinned) return;
  if (pinned) sidebarState.cardsPinned.add(key);
  else sidebarState.cardsPinned.delete(key);
  saveSidebarState();
  renderTree();
}

/**
 * In use's side of its repo cards: they pin themselves, and what they open or close is passed
 * on to a Containers section on another page, where a card goes once it is no longer in use.
 *
 * @type {import('./cards.js').CardSide}
 */
const inUseSide = {
  pinned: (key) => sidebarState.cardsPinned.has(key),
  pin: setCardPinned,
  folded: (part, key, open) => otherContainers?.setFold(part, key, open),
};

/**
 * In use as the Containers section reaches it (see `InUseLink`): in this page, directly. One
 * render draws both, so there is no change to follow.
 *
 * @type {InUseLink}
 */
const inUseLink = {
  revealInUse,
  inUseKeys: () => shownInUse,
  pinned: (key) => sidebarState.cardsPinned.has(key),
  pin: setCardPinned,
  onInUseChange: () => {},
};

/** A tile's **Reveal in Containers**: in this page's Containers section, and another page's. */
function revealInContainers(ref) {
  containersSection.reveal(ref);
  otherContainers?.reveal(ref);
}

/** Tells another page's Containers section In use's cards and pins, when they changed. */
function tellInUse() {
  if (!onInUse) return;
  const state = inUseState(shownInUse, sidebarState.cardsPinned);
  const told = JSON.stringify(state);
  if (told === toldInUse) return;
  toldInUse = told;
  onInUse(state);
}

/** Scrolls In use to the card with key `key`, focuses its header and briefly flashes the card. */
function revealInUse(key) {
  const el = [...$zoneInUse.querySelectorAll('.repo-card')].find((e) =>
    /** @type {HTMLElement} */ (e).dataset.cardKey === key
  );
  if (!el) return;
  el.scrollIntoView({ block: 'nearest' });
  /** @type {HTMLElement | null} */ (el.querySelector('.repo-card-head'))
    ?.focus({ preventScroll: true });
  el.classList.remove('flash');
  void (/** @type {HTMLElement} */ (el)).offsetWidth;
  el.classList.add('flash');
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
    ...(previewable(pin.path)
      ? [[LABELS.preview, () => openFileTile(fr, pin.path, 'stack', 'media')]]
      : []),
    ...(mediaKind(pin.path) === 'html'
      ? [['Open in browser', () => openInBrowser(fr, pin.path)]]
      : []),
    null,
    ...hostOpenItems(fr, pin.path),
    null,
    ...copyPathItems(fr, pin.path),
    null,
    ['Rename…', () => renameFilePin(pin)],
    dashboardItem(fr, pin.path),
    null,
    [LABELS.unpinFile, () => unpinFile(pin)],
  ];
}

/**
 * The header's dashboard button: brings the dashboard's tile forward and reads its file again
 * (it may have been regenerated), else opens it. With none marked, says how to mark one.
 */
function openDashboard() {
  if (!dashboard) {
    toast(LABELS.noDashboard);
    return;
  }
  const file = dashboardFileRef(dashboard);
  const shown = tileArea.state().tiles.find((t) =>
    t.file && sameFileView(t.file, file)
  );
  if (shown) {
    tileArea.reveal(shown.id);
    tileArea.reload(shown.id);
    return;
  }
  tileArea.openFile(file, 'stack');
}

/** The dashboard button's tooltip: the dashboard's name, or how to mark one. */
function updateDashboardButton() {
  if (!$dashboardButton) return;
  const label = dashboard
    ? LABELS.openDashboard(basename(dashboard.path))
    : LABELS.noDashboard;
  $dashboardButton.title = label;
  $dashboardButton.setAttribute('aria-label', label);
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
  const candidates = [...projects.values()].sort(byName);
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
 * The Tasks section: to-dos kept by the server (`~/.config/devc/tasks/tasks.json`), each routed to a
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
 * agent a row's send uses, clears the selection and folds the Tasks section.
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
  foldTasksSection();
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
      task.source?.kind === 'agent'
        ? h('span', { class: 'task-agent', title: 'Added by an agent' }, '🤖 ')
        : '',
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

/** Tasks with a `send_task` from their row in flight: a second click waits for the first. */
const sendingTasks = new Set();

/**
 * Sends a routed task from its row (`send_task`) to the agent the dialog last sent to, folds the
 * Tasks section, and shows the agent's pane in the focused stack.
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
  foldTasksSection();
  if (typeof result?.pane_id === 'string') placePane(localFolder, result);
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
  closeTaskDialog();
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

/** Typing in the filter box filters the rows; Escape empties it, Down steps into the rows. */
function filterKeydown(e) {
  if (e.key === 'Escape' && $filter.value) {
    $filter.value = '';
    setFilterQuery('');
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

/** The connection indicator, and what the sidebar shows without a token or a connection. */
function onSidebarConnection(state) {
  if ($conn) {
    $conn.dataset.state = state === 'no-token' ? 'closed' : state;
    $conn.title = CONN_TEXT[state];
    $conn.setAttribute('aria-label', CONN_TEXT[state]);
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
  cardsMessage(msg);
  switch (msg.type) {
    case 'containers':
      renderTree();
      break;
    case 'dashboard':
      updateDashboardButton();
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
      renderTree();
      break;
    case 'agent_status':
      renderTree();
      break;
    case 'fetch_result':
    case 'pull_result':
    case 'result':
      if (onRepoGitDone(msg)) renderTree();
      break;
  }
}

/**
 * Mounts the sidebar into `root` (today's `aside.sidebar`: its header, and `#tree`), with the
 * Containers section in its bottom zone, and returns the tiling area's way in and In use's way in
 * for a Containers section on another page. `tileArea` is how the sidebar reaches the tiling area
 * (see `lib/view.js`). On `/sidebar`, `containers` is another page's Containers section, and
 * `onInUse` tells it In use's cards and pins as they change. With `containersExternal` (and
 * `containers`) the page draws no Containers section of its own: devc-desktop shows its own.
 *
 * @param {HTMLElement} root
 * @param {{tileArea: TileArea, containers?: ContainersIntents,
 *   containersExternal?: boolean,
 *   onInUse?: (state: {inUse: string[], pinned: string[]}) => void}} opts
 * @returns {{intents: SidebarIntents, onViewState: (state: ViewState) => void,
 *   inUse: {revealInUse: (key: string) => void, pin: (key: string, pinned: boolean) => void,
 *   state: () => {inUse: string[], pinned: string[]}}}}
 */
export function mountSidebar(root, opts) {
  tileArea = opts.tileArea;
  otherContainers = opts.containers ?? null;
  containersExternal = otherContainers !== null &&
    opts.containersExternal === true;
  onInUse = opts.onInUse ?? null;
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
      setFilterQuery($filter.value);
      renderTree();
    },
    onkeydown: filterKeydown,
  }));
  $tree.before(h('div', { class: 'sidebar-filter' }, $filter));
  mountCards({ tileArea, root: $tree, render: renderTree });
  containersSection = containersExternal
    ? { reveal: () => {}, setFold: () => {}, draw: () => {}, onViewState() {} }
    : mountContainers($zoneBrowse, {
      tileArea,
      inUse: inUseLink,
      standalone: false,
    });
  setMenuContext({
    tileArea,
    fileTreeOf: fileTree,
    filePinned: openPinnedSection,
  });
  setTaskContext({ tileArea, changed: renderTree, sent: foldTasksSection });
  $scopePicker?.addEventListener('click', (e) => {
    const option = /** @type {HTMLElement} */ (e.target).closest?.(
      '[data-scope]',
    );
    if (option) setScope(/** @type {any} */ (option).dataset.scope);
  });
  $scopePicker?.addEventListener('keydown', scopePickerKeydown);
  // The page's URL, token included: devc-desktop's window has no address bar, and a container or
  // another browser may need it. The toast names it without showing it, since it is the token.
  $dashboardButton = root.querySelector('#dashboard');
  $dashboardButton?.addEventListener('click', openDashboard);
  $dashboardButton?.addEventListener('contextmenu', (e) => {
    if (!dashboard) return;
    openMenu(e, [[LABELS.stopDashboard, () => setDashboard(null)]]);
  });
  updateDashboardButton();
  root.querySelector('#copy-url')?.addEventListener('click', () => {
    navigator.clipboard?.writeText(location.href).then(
      () => toast('Copied page URL'),
      (e) => errorToast(`Copy failed: ${e?.message ?? e}`),
    );
  });
  window.addEventListener('resize', applyZoneSizes);
  dragZoneDivider($dividerTasks, 'top');
  dragZoneDivider($dividerBrowse, 'bottom');

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
  return {
    intents: { revealInContainers, prViewed },
    onViewState,
    inUse: {
      revealInUse,
      pin: setCardPinned,
      state: () => inUseState(shownInUse, sidebarState.cardsPinned),
    },
  };
}
