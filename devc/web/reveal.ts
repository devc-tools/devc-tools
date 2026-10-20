// `devc web` revealing a host file or folder in the host's file manager (`reveal_path`): the
// entry is selected, never opened. The path goes in argv only, never through a shell.

import { dirname, toFileUrl } from 'jsr:@std/path';

/**
 * The commands that reveal `path` on `os`, in the order to try them. On Linux there is no
 * portable "select", so after the FileManager1 D-Bus call the fallback opens the containing
 * folder.
 */
export function revealCommands(
  os: typeof Deno.build.os,
  path: string,
): string[][] {
  if (os === 'darwin') return [['open', '-R', path]];
  // explorer.exe exits 1 on success, so its status is never read.
  if (os === 'windows') return [['explorer.exe', '/select,' + path]];
  return [
    [
      'dbus-send',
      '--session',
      '--dest=org.freedesktop.FileManager1',
      '--type=method_call',
      '/org/freedesktop/FileManager1',
      'org.freedesktop.FileManager1.ShowItems',
      'array:string:' + toFileUrl(path).href,
      'string:',
    ],
    ['xdg-open', dirname(path)],
  ];
}

/**
 * Reveals `path` (absolute) in the host's file manager without waiting for it. Throws when none
 * of {@link revealCommands} can be run.
 */
export function revealOnHost(path: string): void {
  for (const [cmd, ...args] of revealCommands(Deno.build.os, path)) {
    let proc: Deno.ChildProcess;
    try {
      proc = new Deno.Command(cmd, {
        args,
        stdin: 'null',
        stdout: 'null',
        stderr: 'null',
      }).spawn();
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) continue;
      throw e;
    }
    proc.status.catch(() => {});
    proc.unref();
    return;
  }
  throw new Error('no file manager command is on PATH');
}
