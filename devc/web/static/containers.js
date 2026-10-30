// The `devc web` Containers section: every running container's card (its row, Start / Stop /
// Remove, its repo cards, its Files row), the projects not running under "Not running" (their
// rows, where they run, Start on this machine / Start in a container), and the "Add project…"
// folder picker. The repo cards it draws are `cards.js`'s, shared with In use; a card In use
// shows is only a stand-in here, linking to it there. What it reaches of In use is the
// `InUseLink` it is mounted with (`lib/view.js`), and what In use reaches of it is what
// `mountContainers` returns: in one page (`/`, `/sidebar`) both are direct, and across pages
// (`/containers` beside `/sidebar`) the server relays them (`remote.js`).

import {
  agentStatus,
  byName,
  collapseContainersState,
  containerLabel,
  gitRollup,
  paneTitle,
  projectActions,
  repoCardKey,
  statusCounts,
} from './lib/sidebar.js';
import {
  createDirTree,
  isHiddenName,
  isWithin,
  parentDir,
} from './lib/files.js';
import {
  chevron,
  errorToast,
  h,
  hoverActions,
  iconButton,
  LABELS,
  openMenu,
  openMenuAt,
  rowTrail,
  svgIcon,
  toast,
} from './ui.js';
import {
  call,
  containerByFolder,
  containers,
  displayName,
  environments,
  list,
  nextId,
  onConnectionChange,
  onServerMessage,
  paneKey,
  pendingRequests,
  projectOutput,
  projectRepos,
  projects,
  projectStarts,
  send,
  snapshots,
  socket,
} from './client.js';
import {
  canStartProjects,
  closeOutput,
  containerRoot,
  downProject,
  followOutput,
  projectMenuItems,
  projectRequest,
  setMenuContext,
  startProject,
  stopProject,
} from './menus.js';
import {
  applyFilter,
  cardMatchesFilter,
  cardsMessage,
  containerNameOf,
  dirMenuItems,
  fileTree,
  fileTrees,
  filterHas,
  focusedTreeKey,
  gitMark,
  holdSections,
  keepSectionHeights,
  mountCards,
  newTerminalMenuItems,
  onCardsViewState,
  onRepoGitDone,
  paneRows,
  pathTitle,
  pinnedCardItem,
  refocusTreeKey,
  renderPass,
  renderTree,
  repoCard,
  repoGroupName,
  repoNameParts,
  restoringFiles,
  rootEntryRows,
  saveSidebarState,
  sectionRow,
  sidebarState,
  treeId,
  treeKeydown,
  treeRow,
  treeRows,
} from './cards.js';
import { setTaskContext } from './task-dialog.js';

/** @typedef {import('./lib/view.js').TileArea} TileArea */
/** @typedef {import('./lib/view.js').ViewState} ViewState */
/** @typedef {import('./lib/view.js').InUseLink} InUseLink */
/** @typedef {import('./lib/view.js').ContainersIntents} ContainersIntents */
/** @typedef {import('./lib/layout_state.js').PaneRef} PaneRef */
/** @typedef {import('./cards.js').CardSide} CardSide */

// ---------------------------------------------------------------------------------------------
// The section: mounting, and drawing it
// ---------------------------------------------------------------------------------------------

/** The element the section is drawn in (its zone): set by {@link mountContainers}. */
let $root = /** @type {HTMLElement} */ (null);
/** How the section reaches In use: set by {@link mountContainers}. */
let link = /** @type {InUseLink} */ (null);
/** Whether the section is a page of its own (`/containers`), drawing itself. */
let standalone = false;
/**
 * Told each time the section folds or opens, and once at mount, when it is a page of its own
 * that folds (devc-desktop's Containers pane, which shrinks to the heading): see
 * {@link mountContainers}. `null`: the heading folds only in a page with In use.
 *
 * @type {((open: boolean) => void) | null}
 */
let onFold = null;
/**
 * The section's side of its repo cards: their pins go to In use through the link. A card here
 * is not in use, so its open parts are its own.
 *
 * @type {CardSide}
 */
const side = {
  pinned: (key) => link.pinned(key),
  pin: (key, pinned) => link.pin(key, pinned),
  folded: () => {},
};

/**
 * Mounts the Containers section in `root`, its zone (`.zone-browse`). In a page with In use
 * (`standalone` false: `/`, `/sidebar`), the sidebar's render draws it with the rest
 * (`draw`), and the sidebar takes its server messages and view states; on `/containers`
 * (`standalone` true) it is the page: it draws itself, under a heading that doesn't fold unless
 * `onFold` is given, which is then told whether it is open, at mount and on each fold.
 *
 * @param {HTMLElement} root
 * @param {{tileArea: TileArea, inUse: InUseLink, standalone: boolean,
 *   onFold?: (open: boolean) => void}} opts
 * @returns {ContainersIntents & {onViewState: (state: ViewState) => void,
 *   draw: (cards: Map<string, any>) => void}}
 */
export function mountContainers(root, opts) {
  $root = root;
  link = opts.inUse;
  standalone = opts.standalone;
  onFold = standalone ? opts.onFold ?? null : null;
  if (standalone) {
    mountCards({ tileArea: opts.tileArea, root, render: renderStandalone });
    setMenuContext({ tileArea: opts.tileArea, fileTreeOf: fileTree });
    setTaskContext({ tileArea: opts.tileArea, changed: renderTree });
    link.onInUseChange(renderTree);
    onConnectionChange(onStandaloneConnection);
  }
  onServerMessage(onContainersMessage);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeOutput();
  }, true);
  if (standalone) renderTree();
  onFold?.(sidebarState.containersOpen);
  return {
    reveal,
    setFold,
    draw,
    onViewState: (state) => {
      if (standalone) onCardsViewState(state);
    },
  };
}

/** Draws the section in its zone from the repo cards' model, inside a `renderPass`. */
function draw(cards) {
  $root.replaceChildren(...sectionRows(cards));
}

/** `/containers`' render: the section alone, in a pass of its own. */
function renderStandalone() {
  renderPass((cards) => {
    const scroll = $root.scrollTop;
    draw(cards);
    applyFilter([$root]);
    holdSections();
    keepSectionHeights();
    $root.scrollTop = scroll;
  });
}

/**
 * The section's rows: its heading (Add project, Refresh, Collapse all), then while it is open
 * each running container's card, and the projects with no running container under "Not running".
 * Herdr tabs group nothing here: a pane the Herdr TUI split into a shared tab is just another
 * pane. Every running container is listed, Herdr or not.
 */
function sectionRows(cards) {
  const folds = !standalone || onFold !== null;
  const open = !folds || sidebarState.containersOpen;
  const rows = [
    sectionRow(
      'Containers',
      folds ? sidebarState.containersOpen : undefined,
      folds ? toggleContainersSection : undefined,
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
  // Projects with no running container: stopped, never created, or just added.
  const idle = [...projects.values()].filter((p) =>
    p.container !== 'running' && !containerByFolder(p.localFolder)
  ).sort(byName);
  if (open && containers.size === 0 && idle.length === 0) {
    rows.push(
      h(
        'div',
        { class: 'empty' },
        socket ? 'No running dev containers.' : 'Waiting for devc web…',
      ),
    );
  }
  if (open) {
    const inUse = link.inUseKeys();
    for (const c of containers.values()) {
      rows.push(...containerRows(c, cards, inUse));
    }
    if (idle.length > 0) rows.push(...inactiveRows(idle));
  }
  return rows;
}

/**
 * In use's `ContainersIntents.setFold`: a card In use shows opened or closed its past sessions
 * (`'history'`, by card key) or its pull request (`'pr'`, by `prKey`), so it shows the same here
 * once it is no longer in use. In the same page the two share the state: nothing to do.
 *
 * @param {'history' | 'pr'} part @param {string} key @param {boolean} open
 */
function setFold(part, key, open) {
  const set = part === 'history'
    ? sidebarState.cardHistoryOpen
    : part === 'pr'
    ? sidebarState.prOpen
    : null;
  if (!set || typeof key !== 'string' || set.has(key) === !!open) return;
  if (open) set.add(key);
  else set.delete(key);
  saveSidebarState();
  renderTree();
}

/** A server message, as the section takes it once `client.js` has applied it. */
function onContainersMessage(msg) {
  if (msg.type === 'hello') {
    for (const top of picker?.tops ?? []) picker?.tree.refresh(top);
  }
  if (msg.type === 'project_output') {
    showProjectOutput(msg.localFolder, msg.line);
  }
  if (!standalone) return;
  // On its own page, the section is the cards' page too.
  cardsMessage(msg);
  switch (msg.type) {
    case 'containers':
    case 'projects':
    case 'snapshot':
    case 'pane_updated':
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

/** On its own page: what the section shows without a token or a connection. */
function onStandaloneConnection(state) {
  if (state === 'no-token') {
    $root.replaceChildren(
      h(
        'div',
        { class: 'empty' },
        'This page needs the URL devc web printed, including its #token=… part.',
      ),
    );
  } else if (state === 'closed') renderTree();
}

// ---------------------------------------------------------------------------------------------
// Containers and projects
// ---------------------------------------------------------------------------------------------

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
  unsupported: 'herdr too old',
  error: 'error',
};

function toggleContainer(c) {
  if (!sidebarState.collapsed.delete(c.localFolder)) {
    sidebarState.collapsed.add(c.localFolder);
  }
  saveSidebarState();
  renderTree();
}

function toggleContainersSection() {
  sidebarState.containersOpen = !sidebarState.containersOpen;
  saveSidebarState();
  renderTree();
  onFold?.(sidebarState.containersOpen);
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

/** Lists the devcontainers and projects again, for what the server's `docker events` missed. */
function refreshContainers() {
  const id = nextId('r');
  pendingRequests.set(id, 'Refresh');
  send({ type: 'refresh_containers', id });
}

/**
 * Expands the pane's container and scrolls its row into view, briefly flashed: In use's
 * `ContainersIntents.reveal`, for a tile's **Reveal in Containers**
 * (`SidebarIntents.revealInContainers`).
 *
 * @param {PaneRef} ref
 */
function reveal(ref) {
  if (typeof ref?.localFolder !== 'string') return;
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

/**
 * A container's card in Containers: its row, then while it is expanded its repo cards but those
 * of a worktree whose repo's card hides them, in card order, and its Files row. A card In use
 * shows (`inUse`, by key: see `InUseLink.inUseKeys`) is only a link to it there (see
 * `inUseLinkCard`).
 *
 * @param {Set<string>} inUse
 */
function containerRows(c, cards, inUse) {
  const snap = c.state === 'connected' ? snapshots.get(c.id) : undefined;
  const panes = list(snap?.panes);
  const shown = [...cards.values()].filter((card) =>
    card.localFolder === c.localFolder
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
      envKindMark(c.kind),
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
  // A worktree's card goes under its repo's when that one is here too (as a card or its In use
  // link), else as a repo's.
  const mainOf = (card) => {
    const main = card.repo?.worktreeOf;
    const key = main ? repoCardKey(c.localFolder, main) : null;
    return key && cards.get(key) ? key : null;
  };
  shown.forEach((card, i) => {
    const main = mainOf(card);
    if (main) {
      if (
        sidebarState.worktreesClosed.has(main) && !cardMatchesFilter(card)
      ) return;
      const el = inUse.has(card.key)
        ? inUseLinkCard(card)
        : repoCard(card, side);
      el.classList.add('worktree');
      // The rail on its left runs on to the next worktree's card under the same repo's.
      if (shown[i + 1] && mainOf(shown[i + 1]) === main) {
        el.classList.add('worktree-continues');
      }
      rows.push(el);
      return;
    }
    const worktrees = shown.filter((w) => mainOf(w) === card.key).length;
    rows.push(
      inUse.has(card.key)
        ? inUseLinkCard(card, worktrees)
        : repoCard(card, side, worktrees),
    );
  });
  rows.push(...containerFilesRows(c));
  return [containerCard(rows, true)];
}

/**
 * Where an In use card is in its container's card under Containers: its name and branch, muted,
 * and an **In use** link, whose click scrolls to the card in In use and flashes it
 * (`revealInUse`). The row's click does the same, but on a repo's with worktrees' cards under it,
 * where it hides or shows them, as the card's header does.
 */
function inUseLinkCard(card, worktrees = 0) {
  const { key, localFolder, repo } = card;
  const branch = repo?.git?.branch;
  const worktreesHidden = worktrees > 0 &&
    sidebarState.worktreesClosed.has(key);
  const head = treeRow(
    `${key}\n\nin-use-link`,
    0,
    worktrees > 0 ? !worktreesHidden : undefined,
    {
      class: 'repo-card-head in-use-link-head',
      title: [
        worktrees > 0 ? '' : LABELS.showInUse,
        worktreesHidden ? LABELS.worktreesHidden(worktrees) : '',
      ].filter((t) => t).join('\n'),
      onclick: worktrees > 0
        ? () => {
          if (!sidebarState.worktreesClosed.delete(key)) {
            sidebarState.worktreesClosed.add(key);
          }
          saveSidebarState();
          renderTree();
        }
        : () => link.revealInUse(key),
      oncontextmenu: (e) => openMenu(e, [pinnedCardItem(key, side)]),
    },
    ...(repo
      ? [
        ...repoNameParts(repoGroupName(localFolder, repo)),
        branch ? h('span', { class: 'repo-branch' }, branch) : '',
      ]
      : [h('span', { class: 'repo-base' }, containerNameOf(localFolder))]),
  );
  head.append(h('span', {
    class: 'in-use-link',
    title: LABELS.showInUse,
    onclick: (e) => {
      e.stopPropagation();
      link.revealInUse(key);
    },
  }, LABELS.inUse));
  return h('div', { class: 'repo-card in-use-link-card' }, head);
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

/** A container row's Stop button, when its project is known to be running. */
function stopButton(c) {
  const p = projects.get(c.localFolder);
  return p?.container === 'running'
    ? iconButton(
      'stop',
      projectActions(p.environment).stop,
      () => stopProject(p),
    )
    : '';
}

/**
 * A container row's Remove button (`devc down`), beside Stop: only while Stop is shown, and never
 * on this machine, where there is no container to remove.
 */
function downButton(c) {
  const p = projects.get(c.localFolder);
  const remove = projectActions(p?.environment).remove;
  return p?.container === 'running' && remove !== null
    ? iconButton('trash', remove, () => downProject(p))
    : '';
}

/** Where a project or environment runs, after its name: a laptop on this machine, else a cube. */
function envKindMark(kind) {
  const host = kind === 'host';
  const mark = h('span', {
    class: 'env-mark',
    'data-kind': host ? 'host' : 'container',
    title: host ? 'Runs on this machine' : 'Runs in a container',
  });
  mark.append(svgIcon(host ? 'machine' : 'project'));
  return mark;
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
      envKindMark(p.environment),
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
      p.starting || !canStartProjects() ? '' : hoverActions(
        iconButton(
          'play',
          projectActions(p.environment).start,
          () => startProject(p.localFolder),
        ),
      ),
    ),
  );
}

function addProject() {
  openPicker();
}

/** One line of a container start's output (kept by `client.js`): on its row, and in an open dialog. */
function showProjectOutput(localFolder, line) {
  for (const row of $root.querySelectorAll('[data-project]')) {
    const el = /** @type {HTMLElement} */ (row);
    if (el.dataset.project === localFolder) {
      el.title = `${localFolder}\n${line}`;
    }
  }
  followOutput(localFolder);
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
  }, 'Add this folder'));
  // Only when this server runs both kinds. It follows the selected folder (a container when it
  // has a dev container config) until the user picks one.
  const $env = environments.includes('container') &&
      environments.includes('host')
    ? /** @type {HTMLSelectElement} */ (h(
      'select',
      {
        class: 'new-note-project',
        'aria-label': 'Where it runs',
        onchange: () => {
          if (picker) picker.envChosen = true;
        },
      },
      h('option', { value: 'container' }, 'In a container'),
      h('option', { value: 'host' }, 'On this machine'),
    ))
    : null;
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
        'has a dev container config, or is a project',
      ),
      h('span', { class: 'picker-actions' }, $env ?? '', $pin),
    ),
  ));
  picker = {
    el,
    tree,
    $list,
    $path,
    $pin,
    $env,
    envChosen: false,
    tops: null,
    selected: null,
  };
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
    if (row.dataset.path === path && picker.$env && !picker.envChosen) {
      picker.$env.value = row.hasAttribute('data-project')
        ? 'container'
        : 'host';
    }
  }
}

/** Adds `path` as a project (`add_project`) and closes the picker. */
function pinFolder(path) {
  if (!picker || !path) return;
  projectRequest(
    'add_project',
    path,
    'Add project',
    picker.$env ? { environment: picker.$env.value } : {},
  );
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
      'data-project': project || undefined,
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
        title: 'Has a dev container config, or is already a project',
      }, svgIcon('project'))
      : '',
  );
}

function startSession(containerId) {
  const id = nextId('r');
  pendingRequests.set(id, 'Start session');
  send({ type: 'start_session', id, container: containerId });
}
