// Pure naming and status helpers for the `devc web` sidebar, shared with the Deno tests
// (`devc/tests/web_sidebar_test.ts`). No DOM access here.

import { tileTitle } from './layout_state.js';

/** Agent statuses, most in need of attention first. */
export const STATUS_ORDER = ['blocked', 'done', 'working', 'unknown', 'idle'];

function basename(path) {
  const parts = String(path ?? '').split('/').filter(Boolean);
  return parts[parts.length - 1] ?? '';
}

function dirname(path) {
  return String(path ?? '').replace(/\/+$/, '').split('/').slice(0, -1).join(
    '/',
  );
}

/** Each status's badge text: four letters, so a badge keeps its width as the status changes. */
const STATUS_SHORT = {
  blocked: 'wait',
  working: 'work',
  done: 'done',
  unknown: 'unkn',
  idle: 'idle',
};

/** A status's four-letter badge text; tooltips keep the full word. */
export function statusShort(status) {
  return STATUS_SHORT[status] ?? STATUS_SHORT.unknown;
}

/** A pane's agent status, `unknown` when Herdr sent none or one this page doesn't know. */
export function agentStatus(pane) {
  return STATUS_ORDER.includes(pane?.agent_status)
    ? pane.agent_status
    : 'unknown';
}

/**
 * The agent status most in need of attention among `panes`, and how many agents have it;
 * `null` when no pane runs an agent.
 */
export function topStatus(panes) {
  const agents = panes.filter((p) => p.agent);
  if (agents.length === 0) return null;
  const status = STATUS_ORDER.find((s) =>
    agents.some((p) => agentStatus(p) === s)
  );
  return {
    status,
    count: agents.filter((p) => agentStatus(p) === status).length,
  };
}

/**
 * Where a card with `panes` sorts by its agents: its most urgent status's place in
 * {@link STATUS_ORDER}, after them all when no pane runs an agent.
 */
export function statusRank(panes) {
  const top = topStatus(panes);
  return top ? STATUS_ORDER.indexOf(top.status) : STATUS_ORDER.length;
}

/**
 * How many of `panes`' agents have each status, most in need of attention first, statuses no
 * agent has left out: a container row's summary.
 *
 * @returns {{status: string, count: number}[]}
 */
export function statusCounts(panes) {
  const agents = panes.filter((p) => p.agent);
  return STATUS_ORDER.map((status) => ({
    status,
    count: agents.filter((p) => agentStatus(p) === status).length,
  })).filter((s) => s.count > 0);
}

/**
 * A repo's sidebar name (`tools/devc-tools`) as its parent path, shown muted, and its own name
 * (`tools/`, `devc-tools`); `prefix` is '' for a name with no slash.
 */
export function splitRepoName(name) {
  const i = String(name ?? '').replace(/\/+$/, '').lastIndexOf('/');
  return i < 0
    ? { prefix: '', base: String(name ?? '') }
    : { prefix: name.slice(0, i + 1), base: name.slice(i + 1) };
}

/** A pane's name: the one it was renamed to, else its title as Herdr reports it, else its folder, else its id. */
export function paneTitle(pane) {
  return pane?.label || pane?.terminal_title_stripped || basename(pane?.cwd) ||
    pane?.pane_id ||
    '';
}

/**
 * The window title for the active tile: `<repo>:<branch> — <pane title> — devcd`, `<repo>`
 * being the repo it is in (or its project's name outside any), `<branch>` that repo's branch and
 * `<pane title>` the title its pane's program (an agent, say) sets. Each part is left out when
 * empty or missing: `<repo> — devcd` without a branch or pane title, `devcd` with nothing.
 */
export function windowTitle(repo, branch, paneTitle) {
  const head = repo && branch ? `${repo}:${branch}` : repo;
  return [head, paneTitle, 'devcd'].filter((s) => s).join(' — ');
}

/**
 * The repo (of a project's `repos`) whose container folder holds container path `path`, the
 * innermost when they nest; null when none does.
 */
export function repoAt(repos, path) {
  let best = null;
  for (const r of repos) {
    const dir = r.containerFolder?.replace(/\/+$/, '');
    if (!dir || !path) continue;
    const inside = path === dir || path.startsWith(`${dir}/`);
    if (inside && (!best || dir.length > best.dir.length)) best = { r, dir };
  }
  return best?.r ?? null;
}

/** The least a sidebar zone with rows keeps when dragged: its section heading. */
export const ZONE_MIN_HEIGHT = 32;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * @typedef {{total: number, top: number, mid: number, topMin: number, topMax: number,
 *   midMin: number, midMax: number, botMin: number, botMax: number}} Zones
 *   Three stacked zones' heights now (`top`, `mid`; the bottom one takes the rest of `total`)
 *   and each one's limits.
 */

/**
 * The sidebar's zones after a divider is dragged to `y` (pixels from the top of the zones, the
 * dividers left out). The `top` divider sizes the top zone; the middle zone keeps its height,
 * so the other divider moves with it, unless that would leave the bottom zone outside its
 * limits. The `bottom` divider sizes the middle zone while it can, then carries the top divider
 * along: the whole middle zone moves.
 *
 * @param {Zones} z @param {'top' | 'bottom'} line @param {number} y
 * @returns {{top: number, mid: number}}
 */
export function dragZones(z, line, y) {
  let top, mid;
  if (line === 'top') {
    top = clamp(Math.round(y), z.topMin, z.topMax);
    mid = z.mid;
  } else {
    // Never past the bottom zone's heading: there the divider stops, rather than counting as
    // the middle zone being full.
    const at = Math.min(Math.round(y), z.total - z.botMin);
    mid = clamp(at - z.top, z.midMin, z.midMax);
    top = clamp(at - mid, z.topMin, z.topMax);
  }
  return settleZones({ ...z, top, mid });
}

/**
 * Heights kept to their limits: each zone's own, then the bottom zone's, which the middle zone
 * makes up first and the top zone after it. Used after a drag, and when the window or a zone's
 * rows changed size.
 *
 * @param {Zones} z
 * @returns {{top: number, mid: number}}
 */
export function settleZones(z) {
  let top = clamp(z.top, z.topMin, Math.max(z.topMin, z.topMax));
  let mid = clamp(z.mid, z.midMin, Math.max(z.midMin, z.midMax));
  const bot = z.total - top - mid;
  // Too little left at the bottom: the middle zone gives first, then the top one; too much
  // (a folded bottom zone is exactly its heading): the middle zone takes it first.
  const need = bot < z.botMin
    ? z.botMin - bot
    : bot > z.botMax
    ? z.botMax - bot
    : 0;
  if (need > 0) {
    const fromMid = Math.min(need, mid - z.midMin);
    mid -= fromMid;
    top = Math.max(z.topMin, top - (need - fromMid));
  } else if (need < 0) {
    const toMid = Math.min(-need, Math.max(0, z.midMax - mid));
    mid += toMid;
    top = Math.min(z.topMax, top + (-need - toMid));
  }
  return { top: Math.round(top), mid: Math.round(mid) };
}

/**
 * A repo card's key: one card per repo or worktree (`repoFolder`, its host folder) per container
 * (`localFolder`); `repoFolder` null for the container's card of what is outside every repo.
 *
 * @param {string} localFolder
 * @param {string | null} repoFolder
 */
export function repoCardKey(localFolder, repoFolder) {
  return `card\n${localFolder}\n${repoFolder ?? ''}`;
}

/**
 * Whether a repo card is active (shown in In use, else in Containers): it has a tile or an agent no
 * tile shows, or it is pinned there. A plain shell no tile shows doesn't count, nor do past sessions.
 *
 * @param {{tiles: number, agents: number, pinned?: boolean}} card
 */
export function repoCardActive({ tiles, agents, pinned = false }) {
  return tiles > 0 || agents > 0 || pinned;
}

/**
 * Projects by name, then folder: how the sidebar lists the projects not running, and the task
 * dialog its projects.
 *
 * @param {{name: string, localFolder: string}} a @param {{name: string, localFolder: string}} b
 */
export function byName(a, b) {
  return a.name.localeCompare(b.name) ||
    a.localFolder.localeCompare(b.localFolder);
}

/**
 * A container's name in the sidebar and tile headers, `all` being every container listed.
 * Containers sharing a name (two `feature1` worktrees, say) get their parent folder appended,
 * and the full folder when even that is shared.
 */
export function containerLabel(c, all) {
  const twins = [...all].filter((o) => o.name === c.name);
  if (twins.length < 2) return c.name;
  const parent = basename(dirname(c.localFolder));
  const parentShared =
    twins.filter((o) => basename(dirname(o.localFolder)) === parent).length >
      1;
  return `${c.name} · ${parentShared || !parent ? c.localFolder : parent}`;
}

/**
 * The start and stop labels for a project, by where it runs (its `environment`): a container's
 * container, a host project's own Herdr session. `remove` is null on this machine: there is no
 * container to remove.
 *
 * @param {'container' | 'host' | undefined} environment
 */
export function projectActions(environment) {
  return environment === 'host'
    ? {
      start: 'Start session',
      stop: 'Stop session…',
      stopOk: 'Stop session',
      stopBody: (/** @type {string} */ name) =>
        `Stops the Herdr session for ${name}: every terminal in it closes.`,
      remove: null,
      notRunning: 'Start the session first',
    }
    : {
      start: 'Start container',
      stop: 'Stop container…',
      stopOk: 'Stop container',
      stopBody: (/** @type {string} */ name) =>
        `Stop the container for ${name}? Its panes end with it.`,
      remove: 'Remove container…',
      notRunning: 'Start the container first',
    };
}

/**
 * A project's **Run on this machine** or **Run in a container** item (whichever it doesn't do
 * now), or null: only when the server runs both kinds (`environments`), and never for a project
 * a devcontainer carries — it runs in that container. `start` is the same move as one step with
 * the start, for a project that isn't running.
 *
 * @param {{environment?: 'container' | 'host', container: string}} p
 * @param {readonly string[]} environments
 * @returns {{label: string, start: string, environment: 'container' | 'host'} | null}
 */
export function environmentItem(p, environments) {
  if (!environments.includes('container') || !environments.includes('host')) {
    return null;
  }
  if (p.environment !== 'host' && p.container !== 'missing') return null;
  return p.environment === 'host'
    ? {
      label: 'Run in a container',
      start: 'Start in a container',
      environment: 'container',
    }
    : {
      label: 'Run on this machine',
      start: 'Start on this machine',
      environment: 'host',
    };
}

/**
 * A pane's label wherever it is listed: `name` is the name it was renamed to, else the base name
 * of the folder it is in (`client`); `title` is an agent's or command's own title
 * (`Claude Code`, `npm run dev`), or `''` for a shell, whose title is just its folder.
 * @returns {{name: string, title: string}}
 */
export function paneLabel(pane) {
  const dir = basename(pane.foreground_cwd || pane.cwd);
  const name = pane.label || dir || paneTitle(pane);
  const title = pane.terminal_title_stripped || '';
  const folders = [basename(pane.cwd), basename(pane.foreground_cwd)];
  return {
    name,
    title: title === name || (!pane.agent && folders.includes(title))
      ? ''
      : title,
  };
}

/**
 * What an agent's row in an In use group says: what it is doing (its title), else its name. The
 * folder name a label starts with is left out there, since the group's own row names the folder.
 *
 * @param {{name: string, title: string}} label  see {@link paneLabel}
 */
export function inUseLabel({ name, title }) {
  return title || name;
}

/** A label as one line of plain text, for places that can't style part of it. */
export function labelText({ name, title }) {
  return tileTitle(name, title);
}

/**
 * A folder's push/pull marks from its `git` field (see the `projects` message): `ahead` (↑N,
 * to push), `behind` (↓N, to pull) or `gone` (the upstream was deleted), with a tooltip naming
 * the branch. A branch level with its upstream gets a quiet `synced` mark (✓). With no `git` but
 * a `problem` (its `gitProblem`: a detached HEAD, a timed-out or failed git call), a quiet
 * `unknown` mark (?) whose tooltip gives the reason. `null` when there is no repo, no status
 * read yet, or a branch with no upstream (nothing to compare with, so nothing to say).
 */
function pushPull(git, problem) {
  if (!git) {
    if (!problem) return null;
    return {
      marks: [{ dir: 'unknown', text: '?' }],
      diverged: false,
      title: `git status unavailable: ${problem}`,
    };
  }
  if (!git.upstream) return null;
  const marks = [];
  if (git.ahead > 0) marks.push({ dir: 'ahead', text: `↑${git.ahead}` });
  if (git.behind > 0) marks.push({ dir: 'behind', text: `↓${git.behind}` });
  if (git.gone) marks.push({ dir: 'gone', text: 'gone' });
  if (marks.length === 0) {
    return {
      marks: [{ dir: 'synced', text: '✓' }],
      diverged: false,
      title: `${git.branch} → ${git.upstream}: in sync (as of the last fetch)`,
    };
  }
  const counts = [
    git.ahead > 0 ? `${git.ahead} to push` : '',
    git.behind > 0 ? `${git.behind} to pull` : '',
    git.gone ? 'upstream deleted' : '',
  ].filter((s) => s);
  return {
    marks,
    diverged: git.ahead > 0 && git.behind > 0,
    title: `${git.branch} → ${git.upstream}: ${
      counts.join(', ')
    } (as of the last fetch)`,
  };
}

/** @typedef {{staged: number, unstaged: number, untracked: number, conflicted: number}} GitChanges */

/** All of a repo's {@link GitChanges}' entries; 0 with none. */
function changesCount(changes) {
  if (!changes) return 0;
  return changes.staged + changes.unstaged + changes.untracked +
    changes.conflicted;
}

/**
 * A repo's git mark: its changes to commit (`changes`, see the `projects` message) as `● N`
 * (`conflicted` while any are in conflict, else `changes`) before its push/pull marks (see
 * {@link pushPull}), a ✓ dropped beside it. The tooltip lists the four counts, then the push/pull
 * text, then `changesProblem` (why its changes can't be read), which alone gives a quiet `?`.
 * `null` when there is nothing to say.
 *
 * @param {{branch: string, upstream: string | null, ahead: number, behind: number, gone: boolean} | null} [git]
 * @param {string} [problem]
 * @param {GitChanges} [changes]
 * @param {string} [changesProblem]
 */
export function gitSync(git, problem, changes, changesProblem) {
  const sync = pushPull(git, problem);
  const n = changesCount(changes);
  if (n === 0 && !changesProblem) return sync;
  const marks = sync?.marks.filter((m) => n === 0 || m.dir !== 'synced') ?? [];
  if (n > 0) {
    marks.unshift({
      dir: changes.conflicted > 0 ? 'conflicted' : 'changes',
      text: `● ${n}`,
    });
  }
  if (marks.length === 0) marks.push({ dir: 'unknown', text: '?' });
  return {
    marks,
    diverged: sync?.diverged ?? false,
    title: [
      n > 0
        ? `to commit: ${changes.staged} staged, ${changes.unstaged} unstaged, ` +
          `${changes.untracked} untracked, ${changes.conflicted} in conflict`
        : '',
      sync?.title ?? '',
      changesProblem ? `changes unavailable: ${changesProblem}` : '',
    ].filter((s) => s).join('\n'),
  };
}

/** Mark `dir`s that mean "nothing to push or pull" (or nothing known). */
const QUIET_DIRS = ['synced', 'unknown'];

/**
 * One mark for several repos (a collapsed container's, say). When any repo has changes to commit,
 * something to push or pull (or a deleted upstream): their ●, ↑ and ↓ counts summed (● in
 * conflict colors when any repo's is), with every such repo listed
 * in the tooltip. Otherwise a quiet ✓ listing every repo's own tooltip, or ? when no repo's
 * status could be read. `null` when none of `repos` has a mark (no repo, or none with an
 * upstream).
 */
export function gitRollup(repos) {
  const all = [...repos].map((r) => ({
    name: r.name,
    sync: gitSync(r.git, r.gitProblem, r.changes, r.changesProblem),
  }))
    .filter((r) => r.sync);
  if (all.length === 0) return null;
  const busy = all.filter((r) =>
    r.sync.marks.some((m) => !QUIET_DIRS.includes(m.dir))
  );
  if (busy.length === 0) {
    const any = (dir) =>
      all.some((r) => r.sync.marks.some((m) => m.dir === dir));
    return {
      marks: [
        any('synced')
          ? { dir: 'synced', text: '✓' }
          : { dir: 'unknown', text: '?' },
      ],
      diverged: false,
      title: all.map((r) => `${r.name}: ${r.sync.title}`).join('\n'),
    };
  }
  const sum = (dir) =>
    busy.reduce((n, r) => {
      const m = r.sync.marks.find((x) => x.dir === dir);
      return n + (m ? Number(m.text.replace(/\D/g, '')) : 0);
    }, 0);
  const ahead = sum('ahead');
  const behind = sum('behind');
  const changed = sum('changes') + sum('conflicted');
  const marks = [];
  if (changed > 0) {
    const conflicted = busy.some((r) =>
      r.sync.marks.some((m) => m.dir === 'conflicted')
    );
    marks.push({
      dir: conflicted ? 'conflicted' : 'changes',
      text: `● ${changed}`,
    });
  }
  if (ahead > 0) marks.push({ dir: 'ahead', text: `↑${ahead}` });
  if (behind > 0) marks.push({ dir: 'behind', text: `↓${behind}` });
  if (marks.length === 0) marks.push({ dir: 'gone', text: 'gone' });
  return {
    marks,
    diverged: busy.some((r) => r.sync.diverged),
    title: busy.map((r) => `${r.name}: ${r.sync.title}`).join('\n'),
  };
}

/** Sidebar bounds in CSS px. */
export const SIDEBAR_MIN_WIDTH = 160;
export const SIDEBAR_DEFAULT_WIDTH = 350;

/**
 * Clamps a sidebar width to [SIDEBAR_MIN_WIDTH, max(SIDEBAR_MIN_WIDTH, 60% of the viewport)].
 * A non-finite `width` gives SIDEBAR_DEFAULT_WIDTH, clamped the same way.
 *
 * @param {number} width
 * @param {number} viewportWidth  window.innerWidth
 * @returns {number} an integer
 */
export function clampSidebarWidth(width, viewportWidth) {
  const max = Math.max(SIDEBAR_MIN_WIDTH, Math.floor(viewportWidth * 0.6));
  const w = Number.isFinite(width) ? Math.round(width) : SIDEBAR_DEFAULT_WIDTH;
  return Math.min(max, Math.max(SIDEBAR_MIN_WIDTH, w));
}

/**
 * The Tasks section's open/closed fields with every row in it closed (its Collapse all): each
 * task group in `taskGroups` (the ones there are now) and Sent. Groups already closed stay so.
 * `state` is not changed.
 *
 * @param {{taskGroupsClosed: Set<string>}} state
 * @param {Iterable<string>} taskGroups
 */
export function collapseTasksState(state, taskGroups) {
  return {
    taskGroupsClosed: new Set([...state.taskGroupsClosed, ...taskGroups]),
    sentOpen: false,
  };
}

/**
 * The Containers section's open/closed fields with every row in it closed, at every level (its
 * Collapse all): each container and project in `folders` (every one there is now), its Files row,
 * its repo cards' Past sessions, every file tree and folder, Not running and the projects under it.
 * Folders already collapsed stay collapsed. `state` is not changed. Every field returned is one
 * the sidebar's saved state has (`cards.js`'s `loadSidebarState`); a test holds that.
 *
 * @param {{collapsed: Set<string>}} state
 * @param {Iterable<string>} folders
 */
export function collapseContainersState(state, folders) {
  return {
    collapsed: new Set([...state.collapsed, ...folders]),
    cardHistoryOpen: new Set(),
    containerFilesOpen: new Set(),
    projectsOpen: new Set(),
    /** @type {Record<string, string[]>} */
    filesOpen: {},
    inactiveOpen: false,
  };
}

/**
 * Whether a keydown is the shortcut that shows or hides the sidebar: Cmd+B on a Mac. There is
 * none elsewhere, since Ctrl+B belongs to the terminals (tmux's prefix, readline's back a char).
 *
 * @param {{code: string, ctrlKey: boolean, altKey: boolean, metaKey: boolean, shiftKey: boolean}} e
 * @param {boolean} isMac
 */
export function isSidebarToggleShortcut(e, isMac) {
  return isMac && e.code === 'KeyB' && e.metaKey && !e.ctrlKey && !e.altKey &&
    !e.shiftKey;
}

/**
 * Whether a keydown is the shortcut that turns zen mode on or off: Ctrl+Alt+Z, Cmd+Alt+Z on a
 * Mac, like the pinned file's Ctrl+Alt+N. Matched on `code`, since a Mac's Option changes `key`.
 *
 * @param {{code: string, ctrlKey: boolean, altKey: boolean, metaKey: boolean, shiftKey: boolean}} e
 * @param {boolean} isMac
 */
export function isZenShortcut(e, isMac) {
  return e.code === 'KeyZ' && e.altKey && !e.shiftKey &&
    (isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey);
}

/**
 * What the sidebar shows (its scope picker): `all`, everything; `container`, Tasks and the focused
 * tile's container's in-use repo cards; `repo`, Tasks and the focused tile's repo card alone.
 *
 * @typedef {'all' | 'container' | 'repo'} SidebarScope
 */

/** The sidebar's scopes, in the picker's order. @type {readonly SidebarScope[]} */
export const SIDEBAR_SCOPES = Object.freeze(['all', 'container', 'repo']);

/** @returns {v is SidebarScope} */
export function isSidebarScope(v) {
  return SIDEBAR_SCOPES.includes(/** @type {any} */ (v));
}

/**
 * The sidebar's scope from what was saved: `scope`, else what was saved while zen mode held it
 * (zen mode on, `zen` true or a scope, was that scope: `zenScope`, else `repo`; off was `all`).
 *
 * @param {{scope?: unknown, zen?: unknown, zenScope?: unknown} | null | undefined} saved
 * @returns {SidebarScope}
 */
export function savedScope(saved) {
  if (isSidebarScope(saved?.scope)) return saved.scope;
  const old = saved?.zen;
  const isOld = (v) => v === 'container' || v === 'repo';
  if (!(old === true || isOld(old))) return 'all';
  return isOld(saved?.zenScope) ? saved.zenScope : isOld(old) ? old : 'repo';
}

/**
 * Zen mode as saved: its own setting, `true` or `false`, else the page's default (on for `/main`
 * alone, off where the sidebar shares the page).
 *
 * @param {unknown} own
 * @param {boolean} byDefault
 */
export function savedZen(own, byDefault) {
  return typeof own === 'boolean' ? own : byDefault;
}

/**
 * A sidebar row, or a box of them, as {@link filterOutline} sees it: its indent (`--depth`),
 * whether its own text matches, whether it always shows (a section heading), and the nodes it
 * holds itself (a box's, or a box's heading's: the rest of its box). A node's subtree is what it
 * holds and the deeper nodes right after it among its siblings.
 *
 * @typedef {{depth: number, matches: boolean, keep?: boolean, children?: OutlineNode[],
 *   shown?: boolean}} OutlineNode
 */

/**
 * The sidebar filter: sets each node's `shown` — a node shows when it or something it is under
 * matches (its whole subtree shows), or when something in its subtree does (the path down to it
 * shows). A kept node (a section heading) always shows, and a match in it shows nothing more.
 *
 * @param {OutlineNode[]} nodes siblings, in order
 * @param {boolean} [inherited] whether something they are under matched
 * @returns {boolean} whether any of them (kept ones aside) shows
 */
export function filterOutline(nodes, inherited = false) {
  let any = false;
  for (let i = 0; i < nodes.length;) {
    const node = nodes[i];
    let end = i + 1;
    while (end < nodes.length && nodes[end].depth > node.depth) end++;
    const self = inherited || (!node.keep && node.matches);
    const inner = filterOutline(node.children ?? [], self);
    const below = filterOutline(nodes.slice(i + 1, end), self);
    const shown = self || inner || below;
    node.shown = !!node.keep || shown;
    any ||= shown;
    i = end;
  }
  return any;
}

/**
 * Whether a row's text matches the sidebar filter: every word of `query`, in any order and case.
 *
 * @param {string} text
 * @param {string} query
 */
export function filterMatches(text, query) {
  const lower = text.toLowerCase();
  return query.toLowerCase().split(/\s+/).filter((w) => w)
    .every((w) => lower.includes(w));
}
