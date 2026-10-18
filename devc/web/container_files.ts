// A running container's own filesystem for `devc web`'s Files node (`list_container_dir`,
// `read_container_file`): any absolute path inside the container, read with `docker exec` as the
// remote user, so what is listed is what that user can see. Unlike the repo trees (`files.ts`),
// nothing is confined: the container is the boundary.
//
// The commands are GNU findutils and POSIX `sh`/`head`, as in devc-vscode's container file
// system. BusyBox `find` (Alpine) has no `-printf`, so listing fails there with find's own error.

import {
  type ContainerInfo,
  dockerExecArgv,
} from '@devc-tools/core/container.ts';
import {
  type DirEntry,
  FilesError,
  fileText,
  MAX_ENTRIES,
  MAX_READ_BYTES,
  sortEntries,
} from './files.ts';

/** One finished `docker` run, stdout as bytes. */
export interface ExecOutput {
  code: number;
  stdout: Uint8Array;
  stderr: string;
}

/** Runs `docker args…`. */
export type DockerRun = (args: string[]) => Promise<ExecOutput>;

/** How long one listing or read may take before it is given up on. */
const EXEC_TIMEOUT_MS = 15_000;

/** `docker args…` to completion, killed after {@link EXEC_TIMEOUT_MS}. */
export const runDocker: DockerRun = async (args) => {
  const out = await new Deno.Command('docker', {
    args,
    stdin: 'null',
    stdout: 'piped',
    stderr: 'piped',
    signal: AbortSignal.timeout(EXEC_TIMEOUT_MS),
  }).output();
  return {
    code: out.code,
    stdout: out.stdout,
    stderr: new TextDecoder().decode(out.stderr),
  };
};

/**
 * The entries of directory `path`, NUL-separated: own type (`%y`), type after following a link
 * (`%Y`: `N` broken, `L` a loop), size, name. `-H` follows `path` itself when it is a link (`/lib`
 * on a merged-/usr image). find reads `\0` in its format as NUL; a real NUL can't go in argv.
 */
export function listArgv(path: string): string[] {
  return [
    'find',
    '-H',
    path,
    '-mindepth',
    '1',
    '-maxdepth',
    '1',
    '-printf',
    '%y\\0%Y\\0%s\\0%f\\0',
  ];
}

/** {@link listArgv}'s output as entries, unsorted. */
export function parseListing(stdout: Uint8Array): DirEntry[] {
  const parts = new TextDecoder().decode(stdout).split('\0');
  const entries: DirEntry[] = [];
  for (let i = 0; i + 3 < parts.length; i += 4) {
    const [own, target, size, name] = parts.slice(i, i + 4);
    if (!name) continue;
    if (own === 'd') entries.push({ name, kind: 'dir' });
    else if (own === 'f') {
      entries.push({ name, kind: 'file', size: Number(size) || 0 });
    } else if (own === 'l') {
      entries.push({
        name,
        kind: 'symlink',
        ...(target === 'd'
          ? { to: 'dir' }
          : target === 'f'
          ? { to: 'file' }
          : {}),
      });
    } // Sockets, FIFOs and devices are listed as files that don't open.
    else entries.push({ name, kind: 'file' });
  }
  return entries;
}

/** Exit codes of {@link READ_SCRIPT}'s own refusals. */
const READ_NOT_FOUND = 3;
const READ_NOT_FILE = 4;
const READ_FORBIDDEN = 5;

/**
 * Prints the first `$1` bytes of file `$2`. The checks come first: reading a FIFO would wait for a
 * writer. The path rides in as an argument, never spliced into the script.
 */
const READ_SCRIPT = [
  `[ -e "$2" ] || exit ${READ_NOT_FOUND}`,
  `[ -f "$2" ] || exit ${READ_NOT_FILE}`,
  `[ -r "$2" ] || exit ${READ_FORBIDDEN}`,
  'exec head -c "$1" -- "$2"',
].join('\n');

/** The command that reads `path`, one byte past {@link MAX_READ_BYTES}. */
export function readArgv(path: string): string[] {
  return ['sh', '-c', READ_SCRIPT, 'sh', String(MAX_READ_BYTES + 1), path];
}

/** A failed command as a {@link FilesError} where its stderr says what went wrong. */
export function execError(
  path: string,
  out: ExecOutput,
  fallback: string,
): Error {
  const msg = out.stderr.trim();
  if (/no such file or directory/i.test(msg)) {
    return new FilesError('not_found', `${path} does not exist`);
  }
  if (/not a directory/i.test(msg)) {
    return new FilesError('not_found', `${path} is not a directory`);
  }
  if (/permission denied/i.test(msg)) {
    return new FilesError('forbidden', `${path} is not readable`);
  }
  return new Error(msg || fallback);
}

/**
 * One directory in the container: `path` absolute. Sorted, capped at {@link MAX_ENTRIES}. Throws
 * {@link FilesError}, or an `Error` carrying the command's stderr.
 */
export async function listContainerDir(
  info: ContainerInfo,
  path: string,
  run: DockerRun = runDocker,
): Promise<{ entries: DirEntry[]; truncated: boolean }> {
  const out = await run(
    dockerExecArgv(info, { cwd: '/', cmd: listArgv(path) }),
  );
  if (out.code !== 0) throw execError(path, out, 'listing failed');
  const sorted = sortEntries(parseListing(out.stdout));
  return {
    entries: sorted.slice(0, MAX_ENTRIES),
    truncated: sorted.length > MAX_ENTRIES,
  };
}

/**
 * A container file's text, for the page's file viewer: `path` absolute. The same limits as a
 * repo file (see {@link fileText}). Throws {@link FilesError}, or an `Error` carrying the
 * command's stderr.
 */
export async function readContainerFile(
  info: ContainerInfo,
  path: string,
  run: DockerRun = runDocker,
): Promise<{ text: string; size: number }> {
  const out = await run(
    dockerExecArgv(info, { cwd: '/', cmd: readArgv(path) }),
  );
  switch (out.code) {
    case 0:
      return fileText(out.stdout, path);
    case READ_NOT_FOUND:
      throw new FilesError('not_found', `${path} does not exist`);
    case READ_NOT_FILE:
      throw new FilesError('bad_request', `${path} is not a file`);
    case READ_FORBIDDEN:
      throw new FilesError('forbidden', `${path} is not readable`);
    default:
      throw execError(path, out, 'reading failed');
  }
}
