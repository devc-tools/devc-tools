import { assertEquals } from 'jsr:@std/assert';
import {
  agentStatus,
  containerLabel,
  paneLabel,
  tabName,
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

Deno.test('tabName spells out numeric labels', () => {
  assertEquals(tabName({ label: '2', number: 2 }), 'tab 2');
  assertEquals(tabName({ number: 3 }), 'tab 3');
  assertEquals(tabName({ label: 'servers', number: 1 }), 'servers');
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
