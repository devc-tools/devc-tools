import { assertEquals } from 'jsr:@std/assert';
import { codeCommands } from '../web/vscode.ts';

Deno.test('codeCommands: the code CLI, then on macOS the app by bundle id', () => {
  assertEquals(codeCommands('linux', '/home/me/app'), [
    ['code', '/home/me/app'],
  ]);
  assertEquals(codeCommands('darwin', '/Users/me/app/a b.ts'), [
    ['code', '/Users/me/app/a b.ts'],
    ['open', '-b', 'com.microsoft.VSCode', '/Users/me/app/a b.ts'],
  ]);
});
