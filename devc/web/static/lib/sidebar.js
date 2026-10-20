// Pure naming and status helpers for the `devc web` sidebar, shared with the Deno tests
// (`devc/tests/web_sidebar_test.ts`). No DOM access here.

import { tileTitle } from './layout_state.js';

/** Agent statuses, most in need of attention first. */
export const STATUS_ORDER = ['blocked', 'working', 'done', 'unknown', 'idle'];

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

/** A label as one line of plain text, for places that can't style part of it. */
export function labelText({ name, title }) {
  return tileTitle(name, title);
}

/**
 * A folder's push/pull marks from its `git` field (see the `projects` message): `ahead` (↑N,
 * to push), `behind` (↓N, to pull) or `gone` (the upstream was deleted), with a tooltip naming
 * the branch. A branch level with its upstream gets a quiet `synced` mark (✓), and one with no
 * upstream a `local` mark (•). With no `git` but a `problem` (its `gitProblem`: a detached HEAD,
 * a timed-out or failed git call), a quiet `unknown` mark (?) whose tooltip gives the reason.
 * `null` only when there is no repo, or no status read yet.
 */
export function gitSync(git, problem) {
  if (!git) {
    if (!problem) return null;
    return {
      marks: [{ dir: 'unknown', text: '?' }],
      diverged: false,
      title: `git status unavailable: ${problem}`,
    };
  }
  if (!git.upstream) {
    return {
      marks: [{ dir: 'local', text: '•' }],
      diverged: false,
      title: `${git.branch}: no upstream`,
    };
  }
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

/** Mark `dir`s that mean "nothing to push or pull" (or nothing known). */
const QUIET_DIRS = ['synced', 'local', 'unknown'];

/**
 * One mark for several repos (a collapsed container's, say). When any repo has something to
 * push or pull (or a deleted upstream): their ↑ and ↓ counts summed, with every such repo listed
 * in the tooltip. Otherwise a quiet ✓ listing every repo's own tooltip, or • when no repo has
 * an upstream, or ? when no repo's status could be read. `null` when none of `repos` is a repo.
 */
export function gitRollup(repos) {
  const all = [...repos].map((r) => ({
    name: r.name,
    sync: gitSync(r.git, r.gitProblem),
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
          : any('local')
          ? { dir: 'local', text: '•' }
          : { dir: 'unknown', text: '?' },
      ],
      diverged: false,
      title: all.map((r) => `${r.name}: ${r.sync.title}`).join('\n'),
    };
  }
  const sum = (dir) =>
    busy.reduce((n, r) => {
      const m = r.sync.marks.find((x) => x.dir === dir);
      return n + (m ? Number(m.text.slice(1)) : 0);
    }, 0);
  const ahead = sum('ahead');
  const behind = sum('behind');
  const marks = [];
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
export const SIDEBAR_DEFAULT_WIDTH = 280;

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
 * Collapse all): each container in `folders` (every container and project there is now) and its
 * Terminals row, every Repos row, file tree and folder, Not running and the projects under it.
 * Folders already listed stay listed. `state` is not changed.
 *
 * @param {{collapsed: Set<string>, terminalsClosed: Set<string>}} state
 * @param {Iterable<string>} folders
 */
export function collapseContainersState(state, folders) {
  const known = [...folders];
  return {
    collapsed: new Set([...state.collapsed, ...known]),
    terminalsClosed: new Set([...state.terminalsClosed, ...known]),
    reposOpen: new Set(),
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
