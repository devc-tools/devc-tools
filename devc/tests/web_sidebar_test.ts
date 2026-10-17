import { assertEquals } from 'jsr:@std/assert';
import {
  agentStatus,
  clampSidebarWidth,
  containerLabel,
  gitRollup,
  gitSync,
  paneLabel,
  paneTitle,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MIN_WIDTH,
  topStatus,
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

Deno.test('paneLabel calls a shell in the container folder "shell"', () => {
  const c = container('devc-dev', '/Users/me/code/tools/devc-dev');
  assertEquals(
    paneLabel(c, {
      pane_id: 'p1',
      cwd: '/workspaces/devc-dev',
      terminal_title_stripped: 'devc-dev',
    }),
    'shell',
  );
  // No title at all: still a shell.
  assertEquals(
    paneLabel(c, { pane_id: 'p1', cwd: '/workspaces/devc-dev' }),
    'shell',
  );
});

Deno.test('paneLabel names the folder of a shell elsewhere', () => {
  const c = container('multi', '/Users/me/code/multi');
  assertEquals(
    paneLabel(c, {
      pane_id: 'p1',
      cwd: '/workspaces/multi',
      foreground_cwd: '/workspaces/multi/client',
      terminal_title_stripped: 'client',
    }),
    'shell · client',
  );
});

Deno.test('paneLabel keeps agent and command titles', () => {
  const c = container('devc-dev', '/Users/me/code/tools/devc-dev');
  assertEquals(
    paneLabel(c, {
      pane_id: 'p1',
      cwd: '/workspaces/devc-dev',
      terminal_title_stripped: 'devc-dev',
      agent: 'claude',
    }),
    'devc-dev',
  );
  assertEquals(
    paneLabel(c, {
      pane_id: 'p1',
      cwd: '/workspaces/devc-dev',
      terminal_title_stripped: 'npm run dev',
    }),
    'npm run dev',
  );
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
