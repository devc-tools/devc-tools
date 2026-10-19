import { assertEquals } from 'jsr:@std/assert';
import { parseEventLine, parsePsLine } from '../web/containers.ts';

Deno.test('parsePsLine splits id, state and local folder on the first two tabs', () => {
  assertEquals(parsePsLine('abc123\trunning\t/Users/me/src/my app'), {
    id: 'abc123',
    running: true,
    localFolder: '/Users/me/src/my app',
  });
  assertEquals(parsePsLine('abc123\texited\t/src/a\tb'), {
    id: 'abc123',
    running: false,
    localFolder: '/src/a\tb',
  });
  assertEquals(parsePsLine('abc123\tpaused\t/src/a')?.running, false);
  assertEquals(parsePsLine(''), null);
  assertEquals(parsePsLine('no-tab'), null);
  assertEquals(parsePsLine('abc123\t/src/a'), null);
});

Deno.test('parseEventLine reads start, die and exec_start, and ignores everything else', () => {
  const line = (Action: string) =>
    JSON.stringify({
      Action,
      Actor: {
        ID: 'f00d',
        Attributes: { 'devcontainer.local_folder': '/src/app' },
      },
    });
  assertEquals(parseEventLine(line('start')), {
    action: 'start',
    id: 'f00d',
    localFolder: '/src/app',
  });
  assertEquals(parseEventLine(line('die'))?.action, 'die');
  assertEquals(parseEventLine(line('destroy'))?.action, 'destroy');
  assertEquals(parseEventLine(line('exec_start: sh -lc command -v herdr')), {
    action: 'exec',
    id: 'f00d',
    localFolder: '/src/app',
    command: 'sh -lc command -v herdr',
  });
  assertEquals(parseEventLine(line('exec_die')), null);
  assertEquals(parseEventLine(line('kill')), null);
  assertEquals(parseEventLine('garbage'), null);
  assertEquals(parseEventLine(JSON.stringify({ Action: 'start' })), null);
});
