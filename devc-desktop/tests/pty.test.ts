import { test } from 'node:test';
import { deepStrictEqual as assertEquals } from 'node:assert/strict';
import { hostShell } from '../src/main/pty.ts';

test('hostShell: $SHELL, else the account shell, else the platform default', () => {
  assertEquals(
    hostShell({ SHELL: '/bin/fish' }, 'darwin', '/bin/zsh'),
    '/bin/fish',
  );
  assertEquals(hostShell({}, 'linux', '/usr/bin/zsh'), '/usr/bin/zsh');
  assertEquals(hostShell({ SHELL: '' }, 'darwin', null), '/bin/zsh');
  assertEquals(hostShell({}, 'linux', null), '/bin/bash');
});
