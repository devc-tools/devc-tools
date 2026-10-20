import { assertEquals } from 'jsr:@std/assert';
import { revealCommands } from '../web/reveal.ts';

Deno.test('revealCommands: open -R on macOS', () => {
  assertEquals(revealCommands('darwin', '/Users/me/app/a b.ts'), [
    ['open', '-R', '/Users/me/app/a b.ts'],
  ]);
});

Deno.test('revealCommands: explorer /select, on Windows', () => {
  assertEquals(revealCommands('windows', 'C:\\Users\\me\\app'), [
    ['explorer.exe', '/select,C:\\Users\\me\\app'],
  ]);
});

Deno.test('revealCommands: FileManager1 over D-Bus, then the containing folder', () => {
  assertEquals(revealCommands('linux', '/home/me/app/a b.ts'), [
    [
      'dbus-send',
      '--session',
      '--dest=org.freedesktop.FileManager1',
      '--type=method_call',
      '/org/freedesktop/FileManager1',
      'org.freedesktop.FileManager1.ShowItems',
      'array:string:file:///home/me/app/a%20b.ts',
      'string:',
    ],
    ['xdg-open', '/home/me/app'],
  ]);
});
