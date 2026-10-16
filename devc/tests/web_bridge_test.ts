import { assert, assertEquals } from 'jsr:@std/assert';
import {
  herdrArgv,
  isNoSessionError,
  isStructuralEvent,
  normalizeEventName,
  snapshotPaneIds,
} from '../web/herdr_bridge.ts';
import { spawnLines, splitLines } from '../web/proc.ts';

Deno.test('normalizeEventName turns the first underscore into a dot', () => {
  assertEquals(normalizeEventName('pane_created'), 'pane.created');
  assertEquals(
    normalizeEventName('workspace_metadata_updated'),
    'workspace.metadata_updated',
  );
  assertEquals(
    normalizeEventName('pane_agent_detected'),
    'pane.agent_detected',
  );
});

Deno.test('normalizeEventName leaves dotted names alone', () => {
  assertEquals(
    normalizeEventName('pane.agent_status_changed'),
    'pane.agent_status_changed',
  );
});

Deno.test('isStructuralEvent: tree changes yes, pane updates and status no', () => {
  for (
    const name of [
      'workspace.created',
      'workspace.metadata_updated',
      'tab.renamed',
      'worktree.opened',
      'layout.updated',
      'pane.created',
      'pane.closed',
      'pane.moved',
      'pane.exited',
    ]
  ) {
    assert(isStructuralEvent(name), name);
  }
  for (
    const name of [
      'pane.updated',
      'pane.focused',
      'pane.agent_detected',
      'pane.agent_status_changed',
    ]
  ) {
    assert(!isStructuralEvent(name), name);
  }
});

Deno.test('isNoSessionError recognizes the bridge NotFound failure', () => {
  assert(isNoSessionError(
    'Error: Custom { kind: NotFound, error: "failed to connect to remote Herdr API socket /home/u/.config/herdr/sessions/devc/herdr.sock: No such file or directory (os error 2)" }',
  ));
  assert(!isNoSessionError('Error: permission denied'));
});

Deno.test('herdrArgv uses docker exec -i, never -t, and the absolute herdr path', () => {
  const argv = herdrArgv({
    containerId: 'c1',
    user: 'vscode',
    herdrPath: '/home/vscode/.local/bin/herdr',
    session: 'devc',
  }, ['remote-api-bridge']);
  assertEquals(argv, [
    'exec',
    '-i',
    '-u',
    'vscode',
    'c1',
    '/home/vscode/.local/bin/herdr',
    '--session',
    'devc',
    'remote-api-bridge',
  ]);
  assert(!argv.includes('-t') && !argv.includes('-it'));
});

Deno.test('snapshotPaneIds reads arrays and maps', () => {
  assertEquals(
    snapshotPaneIds({ panes: [{ pane_id: 'w1:p1' }, { pane_id: 'w1:p2' }] }),
    ['w1:p1', 'w1:p2'],
  );
  assertEquals(snapshotPaneIds({ panes: { a: { pane_id: 'w2:p1' } } }), [
    'w2:p1',
  ]);
  assertEquals(snapshotPaneIds({}), []);
});

async function* chunks(...parts: string[]) {
  for (const p of parts) yield p;
}

Deno.test('splitLines reassembles lines split across chunks', async () => {
  const out: string[] = [];
  for await (
    const line of splitLines(chunks('{"a":', '1}\n{"b"', ':2}\r\n\n', 'tail'))
  ) out.push(line);
  assertEquals(out, ['{"a":1}', '{"b":2}', '', 'tail']);
});

Deno.test('spawnLines: a reader that stops early leaves stdout undestroyed and drained', async () => {
  // Like bridgeRequest returning on its answer while the child still has output to write.
  const proc = spawnLines('sh', [
    '-c',
    'echo first; head -c 1000000 /dev/zero | tr "\\0" x; echo; echo last',
  ]);
  for await (const line of proc.lines) {
    assertEquals(line, 'first');
    break;
  }
  // Undrained, the child blocks on a full pipe and never exits.
  assertEquals(await proc.status, { code: 0 });
});
