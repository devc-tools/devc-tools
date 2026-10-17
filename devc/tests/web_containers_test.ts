import { assertEquals } from 'jsr:@std/assert';
import {
  parseEventLine,
  parsePsLine,
  resolveRemoteUser,
} from '../web/containers.ts';

const labels = (metadata: unknown) =>
  JSON.stringify({
    'devcontainer.local_folder': '/src/app',
    'devcontainer.metadata': JSON.stringify(metadata),
  });

Deno.test('resolveRemoteUser takes the last array entry that has a remoteUser', () => {
  assertEquals(
    resolveRemoteUser(
      labels([
        { remoteUser: 'first' },
        { id: 'feature' },
        { remoteUser: 'vscode' },
        { customizations: {} },
      ]),
      'imageuser',
    ),
    'vscode',
  );
});

Deno.test('resolveRemoteUser accepts a single metadata object', () => {
  assertEquals(resolveRemoteUser(labels({ remoteUser: 'node' }), ''), 'node');
});

Deno.test('resolveRemoteUser falls back to Config.User, then root', () => {
  assertEquals(
    resolveRemoteUser(labels([{ id: 'x' }]), 'imageuser'),
    'imageuser',
  );
  assertEquals(resolveRemoteUser(labels([{ id: 'x' }]), ''), 'root');
  assertEquals(resolveRemoteUser(labels([{ remoteUser: 42 }]), ' '), 'root');
  assertEquals(resolveRemoteUser('{}', ''), 'root');
  assertEquals(resolveRemoteUser('null', 'u'), 'u');
});

Deno.test('resolveRemoteUser falls back on malformed JSON', () => {
  assertEquals(resolveRemoteUser('not json', 'imageuser'), 'imageuser');
  assertEquals(
    resolveRemoteUser(
      JSON.stringify({ 'devcontainer.metadata': '[{"remoteUser":' }),
      '',
    ),
    'root',
  );
});

Deno.test('parsePsLine splits id and local folder on the first tab', () => {
  assertEquals(parsePsLine('abc123\t/Users/me/src/my app'), {
    id: 'abc123',
    localFolder: '/Users/me/src/my app',
  });
  assertEquals(parsePsLine(''), null);
  assertEquals(parsePsLine('no-tab'), null);
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
