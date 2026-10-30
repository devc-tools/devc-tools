import { assertEquals } from 'jsr:@std/assert';
import {
  agentStatus,
  clampSidebarWidth,
  collapseContainersState,
  collapseTasksState,
  containerLabel,
  dragZones,
  environmentItem,
  filterMatches,
  filterOutline,
  gitRollup,
  gitSync,
  inUseLabel,
  isSidebarToggleShortcut,
  isZenShortcut,
  labelText,
  paneLabel,
  paneTitle,
  projectActions,
  repoAt,
  repoCardActive,
  repoCardKey,
  savedScope,
  savedZen,
  settleZones,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MIN_WIDTH,
  splitRepoName,
  STATUS_ORDER,
  statusCounts,
  statusRank,
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

Deno.test('statusRank: the most urgent status first, no agent last', () => {
  const rank = (...statuses: (string | null)[]) =>
    statusRank(
      statuses.map((s) =>
        s === null ? {} : { agent: 'claude', agent_status: s }
      ),
    );
  assertEquals(rank('blocked'), 0);
  assertEquals(rank('idle', 'done', 'working'), 1);
  assertEquals(rank('idle', 'working'), 2);
  assertEquals(rank('bogus'), 3);
  assertEquals(rank('idle'), 4);
  assertEquals(rank(null), STATUS_ORDER.length);
  assertEquals(rank(), STATUS_ORDER.length);
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
  assertEquals(gitSync({ ...git, upstream: null, ahead: 3 }), null);
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

Deno.test('gitSync splits ↓ into fetched (to pull) and unfetched (faded, to fetch)', () => {
  const git = {
    branch: 'main',
    upstream: 'origin/main',
    ahead: 0,
    behind: 3,
    gone: false,
    unfetched: 0,
  };
  assertEquals(gitSync(git), {
    marks: [{ dir: 'behind', text: '↓3' }],
    diverged: false,
    title:
      'main → origin/main: 3 behind origin/main: pull to fast-forward (as of the last fetch)',
  });
  assertEquals(gitSync({ ...git, unfetched: 3 }), {
    marks: [{ dir: 'unfetched', text: '↓3' }],
    diverged: false,
    title:
      'main → origin/main: 3 new on origin/main: fetch to bring them in (as of the last fetch)',
  });
  assertEquals(gitSync({ ...git, behind: 5, unfetched: 2 }), {
    marks: [
      { dir: 'behind', text: '↓3' },
      { dir: 'unfetched', text: '+2' },
    ],
    diverged: false,
    title:
      'main → origin/main: 3 behind origin/main; 2 more on origin/main to fetch (as of the last fetch)',
  });
  assertEquals(gitSync({ ...git, ahead: 1 }), {
    marks: [
      { dir: 'ahead', text: '↑1' },
      { dir: 'behind', text: '↓3' },
    ],
    diverged: true,
    title:
      'main → origin/main: 1 to push, 3 behind origin/main: merge or rebase in the project (as of the last fetch)',
  });
  // Collapsed: one plain ↓ for fetched and unfetched alike.
  assertEquals(
    gitRollup([
      { name: 'a', git: { ...git, unfetched: 1 } },
      { name: 'b', git: { ...git, behind: 1 } },
    ])?.marks,
    [{ dir: 'behind', text: '↓4' }],
  );
});

Deno.test('gitRollup shows a quiet ✓ when none has anything to sync, nothing when none has an upstream', () => {
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
  assertEquals(local, null);
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
    [{ dir: 'unknown', text: '?' }],
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
  const state = { collapsed: new Set(['/a']) };
  const out = collapseContainersState(state, ['/b', '/c']);
  assertEquals(out, {
    collapsed: new Set(['/a', '/b', '/c']),
    cardHistoryOpen: new Set(),
    containerFilesOpen: new Set(),
    projectsOpen: new Set(),
    filesOpen: {},
    inactiveOpen: false,
  });
  assertEquals(state.collapsed, new Set(['/a']));
  assertEquals(out.collapsed === state.collapsed, false);
  assertEquals(
    collapseContainersState({ collapsed: new Set() }, []).collapsed,
    new Set(),
  );
});

// It once kept writing (and reading) fields the sidebar's state had dropped, and threw.
Deno.test('collapseContainersState sets only fields the saved sidebar state has', async () => {
  const cards = await Deno.readTextFile(
    new URL('../web/static/cards.js', import.meta.url),
  );
  const load = cards.slice(cards.indexOf('function loadSidebarState('));
  for (
    const key of Object.keys(
      collapseContainersState({ collapsed: new Set() }, []),
    )
  ) {
    assertEquals(new RegExp(`\\n    ${key}:`).test(load), true, key);
  }
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

Deno.test('isZenShortcut is Ctrl+Alt+Z, Cmd+Alt+Z on a Mac', () => {
  const key = (mods: Partial<Record<string, boolean>>, code = 'KeyZ') => ({
    code,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    shiftKey: false,
    ...mods,
  });
  assertEquals(
    isZenShortcut(key({ ctrlKey: true, altKey: true }), false),
    true,
  );
  assertEquals(isZenShortcut(key({ metaKey: true, altKey: true }), true), true);
  assertEquals(
    isZenShortcut(key({ metaKey: true, altKey: true }), false),
    false,
  );
  assertEquals(
    isZenShortcut(key({ ctrlKey: true, altKey: true }), true),
    false,
  );
  assertEquals(isZenShortcut(key({ ctrlKey: true }), false), false);
  assertEquals(
    isZenShortcut(key({ ctrlKey: true, altKey: true, shiftKey: true }), false),
    false,
  );
  assertEquals(
    isZenShortcut(key({ ctrlKey: true, altKey: true }, 'KeyN'), false),
    false,
  );
});

Deno.test('savedScope reads the scope, else the scope zen mode was on in', () => {
  assertEquals(savedScope({ scope: 'all' }), 'all');
  assertEquals(savedScope({ scope: 'container', zen: 'repo' }), 'container');
  assertEquals(savedScope({ scope: 'repo' }), 'repo');
  assertEquals(savedScope(null), 'all');
  assertEquals(savedScope({ scope: 'x' }), 'all');
  // Saved while zen mode held the scope: on was its scope, off was everything.
  assertEquals(savedScope({ zen: true, zenScope: 'container' }), 'container');
  assertEquals(savedScope({ zen: true }), 'repo');
  assertEquals(savedScope({ zen: false, zenScope: 'container' }), 'all');
  assertEquals(savedScope({ zen: 'container' }), 'container');
  assertEquals(savedScope({ zen: 'repo' }), 'repo');
  assertEquals(savedScope({ zen: 'off' }), 'all');
});

Deno.test('savedZen reads its own setting, else the page default', () => {
  assertEquals(savedZen(true, false), true);
  assertEquals(savedZen(false, true), false);
  assertEquals(savedZen(null, true), true);
  assertEquals(savedZen(null, false), false);
  assertEquals(savedZen('on', false), false);
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

Deno.test('repoCardActive: a tile, an untiled agent or a pin', () => {
  const card = { tiles: 0, agents: 0 };
  assertEquals(repoCardActive({ ...card, tiles: 1 }), true);
  assertEquals(repoCardActive({ ...card, agents: 1 }), true);
  assertEquals(repoCardActive({ ...card, pinned: true }), true);
  assertEquals(repoCardActive({ ...card, pinned: false }), false);
  assertEquals(repoCardActive(card), false);
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

type Node = {
  name: string;
  depth: number;
  matches: boolean;
  keep?: boolean;
  children?: Node[];
  shown?: boolean;
};

const outlineRow = (
  name: string,
  depth: number,
  matches = false,
  children?: Node[],
): Node => ({ name, depth, matches, children });

const shownNames = (nodes: Node[]): string[] =>
  nodes.flatMap((n) => [
    ...(n.shown ? [n.name] : []),
    ...shownNames(n.children ?? []),
  ]);

Deno.test('filterOutline shows a match with its subtree and the rows above it', () => {
  const nodes = [
    outlineRow('a', 0),
    outlineRow('a/b', 1, true),
    outlineRow('a/b/c', 2),
    outlineRow('a/d', 1),
    outlineRow('e', 0),
    outlineRow('e/f', 1),
  ];
  assertEquals(filterOutline(nodes), true);
  assertEquals(shownNames(nodes), ['a', 'a/b', 'a/b/c']);
});

Deno.test('filterOutline shows nothing but kept headings when nothing matches', () => {
  const nodes = [
    { ...outlineRow('Tasks', 0), keep: true, matches: true },
    outlineRow('group', 1),
    outlineRow('task', 2),
  ];
  assertEquals(filterOutline(nodes), false);
  assertEquals(shownNames(nodes), ['Tasks']);
});

Deno.test('filterOutline treats what a node holds as its subtree', () => {
  const head = outlineRow('container', 0, false, [
    outlineRow('repo', 0),
    outlineRow('Files', 0),
    outlineRow('Files/src', 1, true),
  ]);
  const box = outlineRow('card', 0, false, [head]);
  const other = outlineRow('other card', 0, false, [outlineRow('x', 0)]);
  const nodes = [box, other];
  filterOutline(nodes);
  assertEquals(shownNames(nodes), ['card', 'container', 'Files', 'Files/src']);
});

Deno.test('filterOutline shows all a matching heading holds', () => {
  const head = outlineRow('repo', 0, true, [
    outlineRow('tile', 1),
    outlineRow('section', 1, false, [outlineRow('session', 1)]),
  ]);
  const nodes = [outlineRow('card', 0, false, [head])];
  filterOutline(nodes);
  assertEquals(shownNames(nodes), [
    'card',
    'repo',
    'tile',
    'section',
    'session',
  ]);
});

Deno.test('filterMatches needs every word, in any order and case', () => {
  assertEquals(filterMatches('devc-tools main ↑1', 'MAIN devc'), true);
  assertEquals(filterMatches('devc-tools main', 'devc feature'), false);
  assertEquals(filterMatches('anything', '  '), true);
});

Deno.test('projectActions: a host project starts and stops its session, and has nothing to remove', () => {
  const host = projectActions('host');
  assertEquals([host.start, host.stop, host.stopOk, host.remove], [
    'Start session',
    'Stop session…',
    'Stop session',
    null,
  ]);
  assertEquals(
    host.stopBody('app'),
    'Stops the Herdr session for app: every terminal in it closes.',
  );
  const container = projectActions('container');
  assertEquals([container.start, container.stop, container.remove], [
    'Start container',
    'Stop container…',
    'Remove container…',
  ]);
  assertEquals(projectActions(undefined).start, 'Start container');
});

Deno.test('environmentItem: offered only with both kinds, never for a project a container carries', () => {
  const both = ['container', 'host'];
  assertEquals(
    environmentItem({ environment: 'container', container: 'missing' }, both),
    {
      label: 'Run on this machine',
      start: 'Start on this machine',
      environment: 'host',
    },
  );
  assertEquals(
    environmentItem({ environment: 'host', container: 'stopped' }, both),
    {
      label: 'Run in a container',
      start: 'Start in a container',
      environment: 'container',
    },
  );
  assertEquals(
    environmentItem({ environment: 'container', container: 'stopped' }, both),
    null,
  );
  assertEquals(
    environmentItem({ environment: 'container', container: 'missing' }, [
      'container',
    ]),
    null,
  );
  assertEquals(
    environmentItem({ environment: 'host', container: 'missing' }, ['host']),
    null,
  );
});

Deno.test('gitSync puts changes to commit before push and pull, conflicts apart', () => {
  const git = {
    branch: 'main',
    upstream: 'origin/main',
    ahead: 0,
    behind: 0,
    gone: false,
  };
  const clean = { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 };
  const some = { staged: 1, unstaged: 2, untracked: 3, conflicted: 0 };
  // Nothing to commit: just the push/pull mark.
  assertEquals(gitSync(git, undefined, clean), gitSync(git));
  assertEquals(gitSync(null, undefined, clean), null);
  // The ✓ gives way; the counts lead the tooltip.
  assertEquals(gitSync(git, undefined, some), {
    marks: [{ dir: 'changes', text: '● 6' }],
    diverged: false,
    title: 'to commit: 1 staged, 2 unstaged, 3 untracked, 0 in conflict\n' +
      'main → origin/main: in sync (as of the last fetch)',
  });
  assertEquals(
    gitSync({ ...git, ahead: 1, behind: 2 }, undefined, some)?.marks.map((m) =>
      m.text
    ),
    ['● 6', '↑1', '↓2'],
  );
  // A branch with no upstream still shows its changes.
  assertEquals(gitSync({ ...git, upstream: null }, undefined, some)?.marks, [
    { dir: 'changes', text: '● 6' },
  ]);
  assertEquals(
    gitSync(git, undefined, { ...clean, conflicted: 1 })?.marks,
    [{ dir: 'conflicted', text: '● 1' }],
  );
  // Why the changes can't be read goes in the tooltip, and alone is a quiet ?.
  assertEquals(gitSync(git, undefined, undefined, 'git status: timed out'), {
    marks: [{ dir: 'synced', text: '✓' }],
    diverged: false,
    title: 'main → origin/main: in sync (as of the last fetch)\n' +
      'changes unavailable: git status: timed out',
  });
  assertEquals(
    gitSync(null, undefined, undefined, 'too many changes to count'),
    {
      marks: [{ dir: 'unknown', text: '?' }],
      diverged: false,
      title: 'changes unavailable: too many changes to count',
    },
  );
});

Deno.test('gitRollup sums changes to commit, in conflict colors when any repo has one', () => {
  const git = {
    branch: 'main',
    upstream: 'origin/main',
    ahead: 1,
    behind: 0,
    gone: false,
  };
  const changes = (n: number, conflicted = 0) => ({
    staged: n,
    unstaged: 0,
    untracked: 0,
    conflicted,
  });
  const r = gitRollup([
    { name: 'a', git, changes: changes(2) },
    { name: 'b', git: null, changes: changes(1) },
    { name: 'c', git: { ...git, ahead: 0 }, changes: changes(0) },
  ]);
  assertEquals(r?.marks, [
    { dir: 'changes', text: '● 3' },
    { dir: 'ahead', text: '↑1' },
  ]);
  assertEquals(
    r?.title.split('\n').filter((l) => /^\w:/.test(l)).map((l) => l[0]),
    ['a', 'b'],
  );
  assertEquals(
    gitRollup([
      { name: 'a', git: null, changes: changes(1) },
      { name: 'b', git: null, changes: changes(0, 2) },
    ])?.marks,
    [{ dir: 'conflicted', text: '● 3' }],
  );
});
