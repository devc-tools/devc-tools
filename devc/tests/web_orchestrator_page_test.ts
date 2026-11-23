import { assert, assertEquals } from 'jsr:@std/assert';
import {
  clampOrchestratorWidth,
  isOrchestratorPane,
  ORCHESTRATOR_DEFAULT_WIDTH,
  ORCHESTRATOR_MIN_WIDTH,
  orchestratorOverlays,
  orchestratorToggleFromHash,
  orchestratorWaiting,
  pickOrchestratorContainer,
  withoutOrchestratorToggle,
} from '../web/static/lib/orchestrator.js';
import { isOrchestratorCwd } from '../web/orchestrator.ts';

Deno.test('isOrchestratorPane: the shell cwd is the orchestrator folder, as the server tells', () => {
  for (
    const cwd of [
      '/home/vscode/.local/share/devc-orchestrator',
      '/root/.local/share/devc-orchestrator',
      '/home/vscode/.local/share/devc-orchestrator-old',
      '/workspaces/x',
    ]
  ) {
    assertEquals(isOrchestratorPane({ cwd }), isOrchestratorCwd(cwd), cwd);
  }
  assert(
    isOrchestratorPane({ cwd: '/home/vscode/.local/share/devc-orchestrator' }),
  );
  assert(
    !isOrchestratorPane({
      cwd: '/home/vscode/.local/share/devc-orchestrator-old',
    }),
  );
  // A foreground_cwd match alone is not it.
  const pane = {
    cwd: '/workspaces/x',
    foreground_cwd: '/home/vscode/.local/share/devc-orchestrator',
  };
  assert(!isOrchestratorPane(pane));
  assert(!isOrchestratorPane(null));
});

Deno.test('clampOrchestratorWidth: the minimum, and room left for the tiles', () => {
  assertEquals(clampOrchestratorWidth(100, 2000), ORCHESTRATOR_MIN_WIDTH);
  assertEquals(clampOrchestratorWidth(NaN, 2000), ORCHESTRATOR_DEFAULT_WIDTH);
  assertEquals(clampOrchestratorWidth(1800, 2000), 2000 - 480);
  assertEquals(clampOrchestratorWidth(500, 600), ORCHESTRATOR_MIN_WIDTH);
});

Deno.test('orchestratorOverlays: when the tiles would be narrower than 480', () => {
  assert(!orchestratorOverlays(420, 1200));
  assert(orchestratorOverlays(420, 800));
});

Deno.test('pickOrchestratorContainer: saved, else focused, else first; never a host session', () => {
  const a = { id: 'a', localFolder: '/a' };
  const b = { id: 'b', localFolder: '/b' };
  const host = { id: 'h', kind: 'host', localFolder: '/h' };
  assertEquals(pickOrchestratorContainer([a, b], '/b', '/a'), b);
  assertEquals(pickOrchestratorContainer([a, b], '/gone', '/b'), b);
  assertEquals(pickOrchestratorContainer([a, b], null, null), a);
  assertEquals(pickOrchestratorContainer([host], '/h', '/h'), null);
  assertEquals(pickOrchestratorContainer([], null, null), null);
});

Deno.test('orchestratorWaiting: blocked or done', () => {
  assert(orchestratorWaiting({ agent_status: 'blocked' }));
  assert(orchestratorWaiting({ agent_status: 'done' }));
  assert(!orchestratorWaiting({ agent_status: 'working' }));
  assert(!orchestratorWaiting(null));
});

Deno.test('the orchestrator hash parameter is read and taken out', () => {
  const hash = '#view=v1&orchestrator=lq3x&theme=blue';
  assertEquals(orchestratorToggleFromHash(hash), 'lq3x');
  assertEquals(withoutOrchestratorToggle(hash), '#view=v1&theme=blue');
  assertEquals(orchestratorToggleFromHash('#view=v1'), null);
  assertEquals(withoutOrchestratorToggle('#orchestrator=x'), '');
});
