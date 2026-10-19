// `devc web` opening a host file or folder in VS Code (`open_in_code`). The path goes in argv
// only, never through a shell.

/**
 * The commands that open `path` in VS Code on `os`, in the order to try them: the `code` CLI,
 * then on macOS the app itself by bundle id, for when `code` was never put on `PATH`.
 */
export function codeCommands(
  os: typeof Deno.build.os,
  path: string,
): string[][] {
  const cmds = [['code', path]];
  if (os === 'darwin') cmds.push(['open', '-b', 'com.microsoft.VSCode', path]);
  return cmds;
}

/**
 * Opens `path` (absolute) in VS Code without waiting for it. Throws when none of
 * {@link codeCommands} can be run.
 */
export function openInVSCode(path: string): void {
  for (const [cmd, ...args] of codeCommands(Deno.build.os, path)) {
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
  throw new Error("VS Code's `code` command is not on PATH");
}
