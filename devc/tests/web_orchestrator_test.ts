import { assert, assertEquals, assertThrows } from 'jsr:@std/assert';
import {
  ensureRoutingFile,
  isOrchestratorCwd,
  launchCommand,
  orchestratorDir,
  orchestratorPane,
  parseSessionId,
  readEmbedded,
  reposJson,
} from '../web/orchestrator.ts';
import { parseClientMessage } from '../web/protocol.ts';
import type { MountedRepo } from '../web/git_repo.ts';

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

Deno.test('launchCommand: Pi with its built-in tools, the extension, the system prompt and the session id', () => {
  assertEquals(
    launchCommand(ID),
    'exec pi --no-extensions --no-skills --no-prompt-templates --no-context-files --no-approve ' +
      '-e ./orchestrator.ts --system-prompt "$(cat SYSTEM.md)" ' +
      `--session-id ${ID} --name Orchestrator`,
  );
  assertThrows(() => launchCommand('x; rm -rf /'));
});

Deno.test('parseSessionId: a uuid, trimmed; anything else is none', () => {
  assertEquals(parseSessionId(`${ID}\n`), ID);
  assertEquals(parseSessionId(''), null);
  assertEquals(parseSessionId('not-a-uuid'), null);
});

Deno.test('orchestratorDir: under $HOME, never /workspaces', () => {
  assertEquals(
    orchestratorDir('/home/vscode/'),
    '/home/vscode/.local/share/devc-orchestrator',
  );
});

Deno.test('reposJson: card names and container folders, in order, unmounted left out', () => {
  const repo = (
    folder: string,
    containerFolder: string | null,
  ): MountedRepo => ({
    folder,
    containerFolder,
    worktreeOf: null,
    primaryFolder: folder,
  });
  const json = JSON.parse(reposJson([
    repo('/Users/me/src/tools/devc-tools', '/workspaces/tools/devc-tools/'),
    repo('/Users/me/src/lib', null),
    repo('/Users/me/elsewhere/notes', '/mnt/notes'),
  ]));
  assertEquals(json, {
    repos: [
      { name: 'tools/devc-tools', path: '/workspaces/tools/devc-tools' },
      { name: 'notes', path: '/mnt/notes' },
    ],
  });
});

Deno.test('orchestratorPane: by the shell cwd only', () => {
  const pane = (cwd: string, foreground_cwd = cwd) => ({
    pane_id: 'p',
    tab_id: 't',
    cwd,
    foreground_cwd,
  });
  assert(isOrchestratorCwd('/home/vscode/.local/share/devc-orchestrator'));
  assert(isOrchestratorCwd('/root/.local/share/devc-orchestrator/'));
  assert(!isOrchestratorCwd('/home/vscode/.local/share/devc-orchestrator-old'));
  assert(!isOrchestratorCwd('/workspaces/x'));
  assertEquals(
    orchestratorPane([
      pane('/workspaces/x', '/home/vscode/.local/share/devc-orchestrator'),
    ]),
    null,
  );
  assertEquals(
    orchestratorPane([pane('/home/vscode/.local/share/devc-orchestrator')])
      ?.pane_id,
    'p',
  );
});

Deno.test('ensureRoutingFile: writes the default only when missing, never over an edit', async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = `${dir}/orchestrator/routing.md`;
    const first = await ensureRoutingFile(path, `${dir}/orchestrator`);
    assertEquals(first, await readEmbedded('routing.md'));
    await Deno.writeTextFile(path, 'mine\n');
    assertEquals(
      await ensureRoutingFile(path, `${dir}/orchestrator`),
      'mine\n',
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('the embedded files are there', async () => {
  for (const name of ['orchestrator.ts', 'SYSTEM.md', 'routing.md']) {
    assert((await readEmbedded(name)).length > 0, name);
  }
});

Deno.test('orchestrator message: a container and a mode', () => {
  const parsed = (mode: string) =>
    parseClientMessage(JSON.stringify({
      type: 'orchestrator',
      id: '1',
      container: 'abc',
      mode,
    }));
  assertEquals(parsed('restart'), {
    ok: true,
    msg: { type: 'orchestrator', id: '1', container: 'abc', mode: 'restart' },
  });
  assertEquals(parsed('reset').ok, false);
});
