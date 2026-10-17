import { assert, assertEquals } from 'jsr:@std/assert';
import { AGENT_COMMANDS, isAgentId } from '../web/agents.ts';
import { commandInstalled, type HerdrTarget } from '../web/herdr_bridge.ts';
import { parseClientMessage } from '../web/protocol.ts';
import {
  AGENT_IDS,
  AGENT_MARKS,
  terminalIconKind,
} from '../web/static/lib/agent_icons.js';

const target: HerdrTarget = {
  containerId: 'c1',
  user: 'vscode',
  herdrPath: '/usr/local/bin/herdr',
  session: 'devc',
};

Deno.test('isAgentId: the four agents, nothing else', () => {
  for (const id of ['claude', 'copilot', 'pi', 'opencode']) {
    assert(isAgentId(id));
  }
  for (
    const v of ['codex', 'Claude', '', 'toString', 'hasOwnProperty', 1, null]
  ) {
    assert(!isAgentId(v), String(v));
  }
});

Deno.test('the page offers exactly the agents the server can start', () => {
  assertEquals([...AGENT_IDS].sort(), Object.keys(AGENT_COMMANDS).sort());
  assertEquals(
    Object.keys(AGENT_MARKS).sort(),
    Object.keys(AGENT_COMMANDS).sort(),
  );
});

Deno.test('parseClientMessage: open_tab takes a known agent, only without reuse', () => {
  const base = {
    type: 'open_tab' as const,
    id: 't1',
    container: 'c1',
    root: '/src/app',
    path: '',
    reuse: false,
  };
  assertEquals(
    parseClientMessage(JSON.stringify({ ...base, agent: 'claude' })),
    { ok: true, msg: { ...base, agent: 'claude' } },
  );
  for (
    const bad of [
      { agent: 'codex' },
      { agent: 'rm -rf /' },
      { agent: 1 },
      { agent: 'claude', reuse: true },
    ]
  ) {
    const r = parseClientMessage(JSON.stringify({ ...base, ...bad }));
    assert(!r.ok, JSON.stringify(bad));
    assertEquals(r.rejection.code, 'bad_request');
  }
});

Deno.test('commandInstalled: command -v in a login shell, the command as an argument', async () => {
  const calls: string[][] = [];
  const run = (code: number) => (cmd: string, args: string[]) => {
    calls.push([cmd, ...args]);
    return Promise.resolve({ code, stdout: '', stderr: '' });
  };
  assert(await commandInstalled(target, 'claude', run(0)));
  assert(!(await commandInstalled(target, 'pi', run(1))));
  assertEquals(calls[0], [
    'docker',
    'exec',
    '-u',
    'vscode',
    'c1',
    'bash',
    '-lc',
    'command -v "$1" >/dev/null',
    '_',
    'claude',
  ]);
});

Deno.test('commandInstalled: docker failing to run counts as not installed', async () => {
  const run = () => Promise.reject(new Error('no docker'));
  assert(!(await commandInstalled(target, 'claude', run)));
});

Deno.test('terminalIconKind: the four marks, a generic agent, a shell', () => {
  assertEquals(terminalIconKind('claude'), 'claude');
  assertEquals(terminalIconKind('opencode'), 'opencode');
  assertEquals(terminalIconKind('codex'), 'agent');
  assertEquals(terminalIconKind('toString'), 'agent');
  assertEquals(terminalIconKind(undefined), 'terminal');
  assertEquals(terminalIconKind(''), 'terminal');
});

Deno.test('agent marks match the vendored Lobe Icons files', async () => {
  for (const [id, mark] of Object.entries(AGENT_MARKS)) {
    const svg = await Deno.readTextFile(
      new URL(`../web/static/vendor/agent-icons/${mark.file}`, import.meta.url),
    );
    const paths = [...svg.matchAll(/<path[^>]*\bd="([^"]*)"/g)].map((m) =>
      m[1]
    );
    assertEquals(mark.paths, paths, id);
  }
});
