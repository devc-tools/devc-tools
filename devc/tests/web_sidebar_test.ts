import { assertEquals } from 'jsr:@std/assert';
import {
  agentStatus,
  clampSidebarWidth,
  collapseContainersState,
  collapseTasksState,
  containerLabel,
  dragZones,
  gitRollup,
  gitSync,
  inUseLabel,
  isSidebarToggleShortcut,
  labelText,
  paneLabel,
  paneTitle,
  repoAt,
  repoCardActive,
  repoCardKey,
  settleZones,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MIN_WIDTH,
  splitRepoName,
  STATUS_ORDER,
  statusCounts,
  statusShort,
  topStatus,
  windowTitle,
} from '../web/static/lib/sidebar.js';

const container = (name: string, localFolder: string) => ({
  name,
  localFolder,
});

Deno.test('containerLabel leaves a unique name alone', () => {
  const c = container('devc-dev', '/Users/me/code/tools/devc-dev');
  assertEquals(containerLabel(c, [c]), 'devc-dev');
});

Deno.test('containerLabel tells same-named containers apart by parent folder', () => {
  const a = container('feature1', '/Users/me/code/demos/feature1');
  const b = container('feature1', '/Users/me/code/tools/feature1');
  assertEquals(containerLabel(a, [a, b]), 'feature1 · demos');
  assertEquals(containerLabel(b, [a, b]), 'feature1 · tools');
});

Deno.test('containerLabel falls back to the full folder when the parent is shared too', () => {
  const a = container('app', '/Users/me/one/x/app');
  const b = container('app', '/Users/me/two/x/app');
  assertEquals(containerLabel(a, [a, b]), 'app · /Users/me/one/x/app');
});

Deno.test('paneLabel names a shell after its folder alone', () => {
  assertEquals(
    paneLabel({
      pane_id: 'p1',
      cwd: '/workspaces/devc-dev',
      terminal_title_stripped: 'devc-dev',
    }),
    { name: 'devc-dev', title: '' },
  );
  assertEquals(
    paneLabel({ pane_id: 'p1', cwd: '/workspaces/devc-dev' }),
    { name: 'devc-dev', title: '' },
  );
});

Deno.test('paneLabel keeps agent and command titles next to the folder', () => {
  assertEquals(
    paneLabel({
      pane_id: 'p1',
      cwd: '/workspaces/devc-dev',
      terminal_title_stripped: 'Claude Code',
      agent: 'claude',
    }),
    { name: 'devc-dev', title: 'Claude Code' },
  );
  assertEquals(
    paneLabel({
      pane_id: 'p1',
      cwd: '/workspaces/devc-dev',
      terminal_title_stripped: 'npm run dev',
    }),
    { name: 'devc-dev', title: 'npm run dev' },
  );
});

Deno.test('paneLabel prefers where the foreground process is', () => {
  assertEquals(
    paneLabel({
      pane_id: 'p1',
      cwd: '/workspaces/multi',
      foreground_cwd: '/workspaces/multi/client',
      terminal_title_stripped: 'multi',
    }),
    { name: 'client', title: '' },
  );
});

Deno.test('paneLabel keeps a rename, and falls back to the title without a folder', () => {
  assertEquals(
    paneLabel({
      pane_id: 'p1',
      label: 'logs',
      cwd: '/workspaces/app',
      terminal_title_stripped: 'app',
    }),
    { name: 'logs', title: '' },
  );
  assertEquals(
    paneLabel({ pane_id: 'p1', terminal_title_stripped: 'zsh' }),
    { name: 'zsh', title: '' },
  );
});

Deno.test('labelText joins a label into one line', () => {
  assertEquals(
    labelText({ name: 'multi · client', title: 'Claude Code' }),
    'multi · client · Claude Code',
  );
  assertEquals(labelText({ name: 'multi', title: '' }), 'multi');
});

Deno.test('paneTitle prefers a rename, then the terminal title, folder and id', () => {
  assertEquals(
    paneTitle({ pane_id: 'p1', label: 'logs', terminal_title_stripped: 'zsh' }),
    'logs',
  );
  assertEquals(
    paneTitle({ pane_id: 'p1', label: null, terminal_title_stripped: 'zsh' }),
    'zsh',
  );
  assertEquals(paneTitle({ pane_id: 'p1', cwd: '/workspaces/app' }), 'app');
  assertEquals(paneTitle({ pane_id: 'p1' }), 'p1');
});

Deno.test('agentStatus maps missing or unknown statuses to unknown', () => {
  assertEquals(agentStatus({ agent_status: 'working' }), 'working');
  assertEquals(agentStatus({}), 'unknown');
  assertEquals(agentStatus({ agent_status: 'sleeping' }), 'unknown');
});

Deno.test('topStatus picks the status most in need of attention and counts it', () => {
  assertEquals(topStatus([{ pane_id: 'p1' }]), null);
  assertEquals(
    topStatus([
      { agent: 'claude', agent_status: 'idle' },
      { agent: 'claude', agent_status: 'working' },
      { agent: 'pi', agent_status: 'working' },
      { agent: 'claude', agent_status: 'done' },
    ]),
    { status: 'done', count: 1 },
  );
  assertEquals(
    topStatus([
      { agent: 'claude', agent_status: 'idle' },
      { agent: 'claude', agent_status: 'working' },
      { agent: 'pi', agent_status: 'working' },
    ]),
    { status: 'working', count: 2 },
  );
  assertEquals(
    topStatus([
      { agent: 'claude', agent_status: 'working' },
      { agent: 'claude', agent_status: 'blocked' },
    ]),
    { status: 'blocked', count: 1 },
  );
});

Deno.test('clampSidebarWidth keeps a width in range, rounded', () => {
  assertEquals(clampSidebarWidth(320.4, 1600), 320);
});

Deno.test('clampSidebarWidth raises a width below the minimum', () => {
  assertEquals(clampSidebarWidth(40, 1600), SIDEBAR_MIN_WIDTH);
});

Deno.test('clampSidebarWidth caps a width at 60% of the viewport', () => {
  assertEquals(clampSidebarWidth(1200, 1000), 600);
});

Deno.test('clampSidebarWidth lets the minimum win in a tiny viewport', () => {
  assertEquals(clampSidebarWidth(200, 100), SIDEBAR_MIN_WIDTH);
});

Deno.test('clampSidebarWidth uses the default for a non-finite width', () => {
  assertEquals(clampSidebarWidth(NaN, 1600), SIDEBAR_DEFAULT_WIDTH);
  assertEquals(clampSidebarWidth(Infinity, 1600), SIDEBAR_DEFAULT_WIDTH);
  assertEquals(clampSidebarWidth(NaN, 300), 180);
});

Deno.test('gitSync shows commits to push and pull, a quiet mark when in sync', () => {
  const git = {
    branch: 'feature',
    upstream: 'origin/feature',
    ahead: 0,
    behind: 0,
    gone: false,
  };
  assertEquals(gitSync(git), {
    marks: [{ dir: 'synced', text: '✓' }],
    diverged: false,
    title: 'feature → origin/feature: in sync (as of the last fetch)',
  });
  assertEquals(gitSync({ ...git, upstream: null, ahead: 3 }), {
    marks: [{ dir: 'local', text: '•' }],
    diverged: false,
    title: 'feature: no upstream',
  });
  assertEquals(gitSync(null), null);
  assertEquals(gitSync(undefined), null);
  assertEquals(gitSync(undefined, ''), null);
  assertEquals(gitSync(null, 'detached HEAD'), {
    marks: [{ dir: 'unknown', text: '?' }],
    diverged: false,
    title: 'git status unavailable: detached HEAD',
  });
  // A status wins over a stale problem.
  assertEquals(gitSync(git, 'detached HEAD')?.marks, [
    { dir: 'synced', text: '✓' },
  ]);
  assertEquals(gitSync({ ...git, ahead: 2 }), {
    marks: [{ dir: 'ahead', text: '↑2' }],
    diverged: false,
    title: 'feature → origin/feature: 2 to push (as of the last fetch)',
  });
  const both = gitSync({ ...git, ahead: 1, behind: 4 });
  assertEquals(both?.marks.map((m) => m.text), ['↑1', '↓4']);
  assertEquals(both?.diverged, true);
  assertEquals(gitSync({ ...git, gone: true })?.marks, [
    { dir: 'gone', text: 'gone' },
  ]);
});

Deno.test('gitRollup sums every repo and lists the ones with something to do', () => {
  const git = (ahead: number, behind: number) => ({
    branch: 'main',
    upstream: 'origin/main',
    ahead,
    behind,
    gone: false,
  });
  assertEquals(
    gitRollup([{ name: 'b', git: null }, { name: 'c' }]),
    null,
  );
  const r = gitRollup([
    { name: 'app', git: git(1, 0) },
    { name: 'lib', git: git(2, 3) },
    { name: 'docs', git: git(0, 0) },
  ]);
  assertEquals(r?.marks, [
    { dir: 'ahead', text: '↑3' },
    { dir: 'behind', text: '↓3' },
  ]);
  assertEquals(r?.diverged, true);
  assertEquals(r?.title.split('\n').map((l) => l.split(':')[0]), [
    'app',
    'lib',
  ]);
});

Deno.test('gitRollup shows a quiet ✓ (or • when no repo has an upstream) when none has anything to sync', () => {
  const git = (upstream: string | null) => ({
    branch: 'main',
    upstream,
    ahead: 0,
    behind: 0,
    gone: false,
  });
  const synced = gitRollup([
    { name: 'a', git: git('origin/main') },
    { name: 'b', git: null },
    { name: 'c', git: git('origin/main') },
  ]);
  assertEquals(synced?.marks, [{ dir: 'synced', text: '✓' }]);
  assertEquals(synced?.diverged, false);
  assertEquals(synced?.title.split('\n'), [
    'a: main → origin/main: in sync (as of the last fetch)',
    'c: main → origin/main: in sync (as of the last fetch)',
  ]);
  const local = gitRollup([
    { name: 'a', git: git(null) },
    { name: 'b', git: git(null) },
  ]);
  assertEquals(local?.marks, [{ dir: 'local', text: '•' }]);
  assertEquals(local?.title, 'a: main: no upstream\nb: main: no upstream');
  const localAndSynced = gitRollup([
    { name: 'a', git: git(null) },
    { name: 'b', git: git('origin/main') },
  ]);
  assertEquals(localAndSynced?.marks, [{ dir: 'synced', text: '✓' }]);
  const mixed = gitRollup([
    { name: 'a', git: git('origin/main') },
    { name: 'b', git: { ...git('origin/main'), ahead: 2 } },
    { name: 'c', git: git(null) },
  ]);
  assertEquals(mixed?.marks, [{ dir: 'ahead', text: '↑2' }]);
  assertEquals(mixed?.title.split('\n').map((l) => l.split(':')[0]), ['b']);
});

Deno.test('gitRollup counts a repo whose status is unreadable as quiet, ? when all are', () => {
  const git = (upstream: string | null, ahead = 0) => ({
    branch: 'main',
    upstream,
    ahead,
    behind: 0,
    gone: false,
  });
  const unknown = { name: 'u', git: null, gitProblem: 'git fetch: timed out' };
  assertEquals(
    gitRollup([unknown, { name: 'l', git: git(null) }])?.marks,
    [{ dir: 'local', text: '•' }],
  );
  const only = gitRollup([unknown]);
  assertEquals(only?.marks, [{ dir: 'unknown', text: '?' }]);
  assertEquals(only?.title, 'u: git status unavailable: git fetch: timed out');
  assertEquals(
    gitRollup([unknown, { name: 'a', git: git('origin/main', 2) }])?.marks,
    [{ dir: 'ahead', text: '↑2' }],
  );
});

Deno.test('statusShort gives every status four letters, unknown for the rest', () => {
  for (const s of STATUS_ORDER) assertEquals(statusShort(s).length, 4);
  assertEquals(statusShort('working'), 'work');
  assertEquals(statusShort('sleeping'), 'unkn');
});

Deno.test('collapseTasksState closes Sent and adds the known task groups', () => {
  const state = { taskGroupsClosed: new Set(['k1']) };
  const out = collapseTasksState(state, ['k2', '']);
  assertEquals(out, {
    taskGroupsClosed: new Set(['k1', 'k2', '']),
    sentOpen: false,
  });
  assertEquals(state.taskGroupsClosed, new Set(['k1']));
  assertEquals(out.taskGroupsClosed === state.taskGroupsClosed, false);
});

Deno.test('collapseContainersState closes every row and adds the known folders', () => {
  const state = {
    collapsed: new Set(['/a']),
    terminalsClosed: new Set<string>(),
  };
  const out = collapseContainersState(state, ['/b', '/c']);
  assertEquals(out, {
    collapsed: new Set(['/a', '/b', '/c']),
    terminalsClosed: new Set(['/b', '/c']),
    sessionsOpen: new Set(),
    reposOpen: new Set(),
    projectsOpen: new Set(),
    filesOpen: {},
    inactiveOpen: false,
  });
  assertEquals(state.collapsed, new Set(['/a']));
  assertEquals(state.terminalsClosed, new Set());
  assertEquals(out.collapsed === state.collapsed, false);
  assertEquals(out.terminalsClosed === state.terminalsClosed, false);
});

Deno.test('collapseContainersState with nothing known still closes everything', () => {
  assertEquals(
    collapseContainersState(
      { collapsed: new Set(), terminalsClosed: new Set() },
      [],
    ),
    {
      collapsed: new Set<string>(),
      terminalsClosed: new Set<string>(),
      sessionsOpen: new Set(),
      reposOpen: new Set(),
      projectsOpen: new Set(),
      filesOpen: {},
      inactiveOpen: false,
    },
  );
});

Deno.test('windowTitle: repo:branch — pane title — devcd, leaving out what is missing', () => {
  assertEquals(
    windowTitle('devc-tools', 'main', '✳ Fixing the title'),
    'devc-tools:main — ✳ Fixing the title — devcd',
  );
  assertEquals(windowTitle('devc-tools', 'main'), 'devc-tools:main — devcd');
  assertEquals(
    windowTitle('devc-tools', 'main', ''),
    'devc-tools:main — devcd',
  );
  assertEquals(
    windowTitle('app', 'feature/x'),
    'app:feature/x — devcd',
  );
  assertEquals(
    windowTitle('app', undefined, 'Claude Code'),
    'app — Claude Code — devcd',
  );
  assertEquals(windowTitle('app', ''), 'app — devcd');
  assertEquals(windowTitle(undefined, 'main'), 'devcd');
  assertEquals(windowTitle(undefined, undefined, 'vim'), 'vim — devcd');
  assertEquals(windowTitle(), 'devcd');
});

Deno.test('repoAt: the innermost repo whose container folder holds the path', () => {
  const app = { name: 'app', containerFolder: '/workspaces/app' };
  const wt = { name: 'app/wt', containerFolder: '/workspaces/app/wt/' };
  const lib = { name: 'lib', containerFolder: '/src/lib' };
  const unread = { name: 'x', containerFolder: null };
  const repos = [unread, app, wt, lib];
  assertEquals(repoAt(repos, '/workspaces/app'), app);
  assertEquals(repoAt(repos, '/workspaces/app/src'), app);
  assertEquals(repoAt(repos, '/workspaces/app/wt/src'), wt);
  assertEquals(repoAt(repos, '/src/lib'), lib);
  assertEquals(repoAt(repos, '/workspaces/application'), null);
  assertEquals(repoAt(repos, '/tmp'), null);
  assertEquals(repoAt(repos, ''), null);
  assertEquals(repoAt([], '/workspaces/app'), null);
});

Deno.test('isSidebarToggleShortcut is Cmd+B on a Mac only', () => {
  const key = (mods: Partial<Record<string, boolean>>, code = 'KeyB') => ({
    code,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    shiftKey: false,
    ...mods,
  });
  assertEquals(isSidebarToggleShortcut(key({ metaKey: true }), true), true);
  assertEquals(isSidebarToggleShortcut(key({ metaKey: true }), false), false);
  assertEquals(isSidebarToggleShortcut(key({ ctrlKey: true }), true), false);
  assertEquals(isSidebarToggleShortcut(key({ ctrlKey: true }), false), false);
  assertEquals(
    isSidebarToggleShortcut(key({ metaKey: true, shiftKey: true }), true),
    false,
  );
  assertEquals(
    isSidebarToggleShortcut(key({ metaKey: true }, 'KeyN'), true),
    false,
  );
});

Deno.test('statusCounts: each status with its count, most urgent first, agents only', () => {
  assertEquals(
    statusCounts([
      { agent: 'claude', agent_status: 'idle' },
      { agent: 'claude', agent_status: 'working' },
      { agent: 'pi', agent_status: 'idle' },
      { agent: 'claude', agent_status: 'nonsense' },
      {},
    ]),
    [
      { status: 'working', count: 1 },
      { status: 'unknown', count: 1 },
      { status: 'idle', count: 2 },
    ],
  );
  assertEquals(statusCounts([{}]), []);
});

Deno.test('splitRepoName: the parent path apart from the repo own name', () => {
  assertEquals(splitRepoName('tools/devc-tools'), {
    prefix: 'tools/',
    base: 'devc-tools',
  });
  assertEquals(splitRepoName('.plans/deephaven-core'), {
    prefix: '.plans/',
    base: 'deephaven-core',
  });
  assertEquals(splitRepoName('deephaven-core'), {
    prefix: '',
    base: 'deephaven-core',
  });
});

Deno.test('repoCardKey: one card per repo per container', () => {
  assertEquals(repoCardKey('/p', '/p/a'), 'card\n/p\n/p/a');
  assertEquals(repoCardKey('/p', null), 'card\n/p\n');
  assertEquals(
    repoCardKey('/p', '/src/wt') === repoCardKey('/q', '/src/wt'),
    false,
  );
});

Deno.test('repoCardActive: a tile, an untiled agent or a session in the last day', () => {
  const now = Date.parse('2026-10-21T12:00:00Z');
  const hoursAgo = (n: number) => new Date(now - n * 3600_000).toISOString();
  const card = { tiles: 0, agents: 0, lastSessionAt: null };
  assertEquals(repoCardActive({ ...card, tiles: 1 }, now), true);
  assertEquals(repoCardActive({ ...card, agents: 1 }, now), true);
  assertEquals(
    repoCardActive({ ...card, lastSessionAt: hoursAgo(23) }, now),
    true,
  );
  assertEquals(
    repoCardActive({ ...card, lastSessionAt: hoursAgo(25) }, now),
    false,
  );
  assertEquals(
    repoCardActive({ ...card, lastSessionAt: 'nonsense' }, now),
    false,
  );
  assertEquals(repoCardActive(card, now), false);
});

// Tasks on top (rows: 40–200px), In use in the middle (32–500), Containers the rest (≥ 32).
const zones = {
  total: 900,
  top: 100,
  mid: 300,
  topMin: 40,
  topMax: 200,
  midMin: 32,
  midMax: 500,
  botMin: 32,
  botMax: Infinity,
};

Deno.test('dragZones: the top divider sizes the top zone, the middle zone moving with it', () => {
  assertEquals(dragZones(zones, 'top', 150), { top: 150, mid: 300 });
  // Past the top zone's own limits it stops.
  assertEquals(dragZones(zones, 'top', 600), { top: 200, mid: 300 });
  assertEquals(dragZones(zones, 'top', 0), { top: 40, mid: 300 });
});

Deno.test('dragZones: the bottom divider sizes the middle zone, then moves the whole of it', () => {
  assertEquals(dragZones(zones, 'bottom', 450), { top: 100, mid: 350 });
  // Shrunk to its heading, the middle zone pushes the top divider up.
  assertEquals(dragZones(zones, 'bottom', 100), { top: 68, mid: 32 });
  // At all of its rows, it pulls the top divider down, as far as the top zone may grow.
  assertEquals(dragZones(zones, 'bottom', 650), { top: 150, mid: 500 });
  assertEquals(dragZones(zones, 'bottom', 800), { top: 200, mid: 500 });
  // A middle zone that cannot change size (min = max) just moves.
  const fixed = { ...zones, midMin: 300, midMax: 300 };
  assertEquals(dragZones(fixed, 'bottom', 450), { top: 150, mid: 300 });
});

Deno.test('dragZones keeps the bottom zone its heading, the middle zone giving first', () => {
  const big = { ...zones, midMax: 2000 };
  assertEquals(dragZones(big, 'bottom', 2000), { top: 100, mid: 768 });
  // Stopping at the bottom zone's heading is not the middle zone being full: the top stays.
  assertEquals(dragZones({ ...big, midMax: 1300 }, 'bottom', 2000), {
    top: 100,
    mid: 768,
  });
  assertEquals(dragZones({ ...big, mid: 780 }, 'top', 200), {
    top: 200,
    mid: 668,
  });
});

Deno.test('settleZones: a folded bottom zone is its heading, the middle zone filling the rest', () => {
  const folded = { ...zones, midMax: Infinity, botMin: 32, botMax: 32 };
  assertEquals(settleZones(folded), { top: 100, mid: 768 });
  // A window too short for everything: the middle zone gives, then the top one.
  assertEquals(settleZones({ ...zones, total: 150 }), { top: 86, mid: 32 });
});

Deno.test('inUseLabel: what the agent is doing, else its name', () => {
  assertEquals(
    inUseLabel({ name: 'devc-tools', title: 'Fix the tabs' }),
    'Fix the tabs',
  );
  assertEquals(inUseLabel({ name: 'Fix the tabs', title: '' }), 'Fix the tabs');
});
