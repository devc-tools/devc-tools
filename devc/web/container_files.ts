// A running container's own filesystem for `devc web`'s Files node (`list_container_dir`,
// `read_container_file`): any absolute path inside the container, read with `docker exec` as the
// remote user, so what is listed is what that user can see. Unlike the repo trees (`files.ts`),
// nothing is confined: the container is the boundary. `create_file`, `rename_file` and
// `delete_file` write here too, for both trees, so an entry has the owner the editor's saves will
// have.
//
// The commands are GNU findutils and POSIX `sh`/`head`, as in devc-vscode's container file
// system. BusyBox `find` (Alpine) has no `-printf`, so listing fails there with find's own error.

import {
  type ContainerInfo,
  type ContainerMount,
  dockerExecArgv,
} from '@devc-tools/core/container.ts';
import { containerToHostPath } from '@devc-tools/core/mount_paths.ts';
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

/** The command that reads `path`, one byte past `max`. */
export function readArgv(path: string, max = MAX_READ_BYTES): string[] {
  return ['sh', '-c', READ_SCRIPT, 'sh', String(max + 1), path];
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
 * The remote user's `$HOME` in the container, for the Files node's home row: an absolute path,
 * or null when it can't be read or isn't one. Docker sets `HOME` from `/etc/passwd` for `-u`; a
 * `remoteEnv` `HOME` wins, as it does in that user's shells.
 */
export async function containerHome(
  info: ContainerInfo,
  run: DockerRun = runDocker,
): Promise<string | null> {
  try {
    const out = await run(
      dockerExecArgv(info, {
        cwd: '/',
        cmd: ['sh', '-c', 'printf %s "$HOME"'],
      }),
    );
    if (out.code !== 0) return null;
    const home = new TextDecoder().decode(out.stdout);
    return home.startsWith('/') && !/[\n\0]/.test(home) ? home : null;
  } catch {
    return null;
  }
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
 * `listing` of container directory `path` with where it is on the host, for the page's tooltips
 * and copied paths: `hostPath` when a bind mount covers `path`; otherwise `mounted`, the host path
 * of each entry that is itself a bind mount's destination (by name), when there is one.
 */
export function withHostPaths<T extends { entries: DirEntry[] }>(
  listing: T,
  path: string,
  mounts: ContainerMount[],
): T & { hostPath?: string; mounted?: Record<string, string> } {
  const hostPath = containerToHostPath(path, mounts);
  if (hostPath !== null) return { ...listing, hostPath };
  const mounted: Record<string, string> = {};
  for (const { name } of listing.entries) {
    const at = containerToHostPath(
      path === '/' ? `/${name}` : `${path}/${name}`,
      mounts,
    );
    if (at !== null) mounted[name] = at;
  }
  return Object.keys(mounted).length ? { ...listing, mounted } : listing;
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
  return fileText(
    await readContainerBytes(info, path, MAX_READ_BYTES, run),
    path,
  );
}

/**
 * A container file's bytes, `path` absolute: up to one past `max`, which the caller refuses.
 * Throws {@link FilesError}, or an `Error` carrying the command's stderr.
 */
export async function readContainerBytes(
  info: ContainerInfo,
  path: string,
  max: number,
  run: DockerRun = runDocker,
): Promise<Uint8Array> {
  const out = await run(
    dockerExecArgv(info, { cwd: '/', cmd: readArgv(path, max) }),
  );
  switch (out.code) {
    case 0:
      return out.stdout;
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

/**
 * The command that creates `path`: an empty file with noclobber (`set -C`: the shell opens it
 * `O_EXCL`, so anything already there fails it), or a folder with `mkdir` (no `-p`). The path
 * rides in as an argument, never spliced into the script.
 */
export function createArgv(path: string, kind: 'file' | 'dir'): string[] {
  return kind === 'file'
    ? ['sh', '-c', 'set -C; : > "$1"', 'sh', path]
    : ['mkdir', '--', path];
}

/** A failed {@link createArgv} (or the `docker exec` around it) as an error with its `code`. */
export function createError(path: string, out: ExecOutput): Error {
  const msg = out.stderr.trim();
  // dash says "File exists", bash "cannot overwrite existing file"; a folder in the way of a
  // file is "Is a directory".
  if (/file exists|cannot overwrite existing file|is a directory/i.test(msg)) {
    return new FilesError('exists', `${path} already exists`);
  }
  // dash says "Directory nonexistent" for a missing folder.
  if (
    /no such file or directory|directory nonexistent|not a directory/i.test(msg)
  ) {
    return new FilesError('not_found', `${path}'s folder does not exist`);
  }
  if (/permission denied|read-only file system/i.test(msg)) {
    return new FilesError('forbidden', `${path} can't be created here`);
  }
  if (/is not running|no such container/i.test(msg)) {
    return new FilesError('not_running', 'the container is not running');
  }
  return new Error(msg || 'creating failed');
}

/**
 * Creates a file or folder at `path` (absolute) in the container, as the remote user. Its parent
 * must exist. Resolves with the path; throws {@link FilesError} (`exists`, `not_found`,
 * `forbidden`, `not_running`), or an `Error` carrying the command's stderr.
 */
export async function createContainerEntry(
  info: ContainerInfo,
  path: string,
  kind: 'file' | 'dir',
  run: DockerRun = runDocker,
): Promise<{ path: string }> {
  const out = await run(
    dockerExecArgv(info, { cwd: '/', cmd: createArgv(path, kind) }),
  );
  if (out.code !== 0) throw createError(path, out);
  return { path };
}

/**
 * The command that renames `from` to `to` (the same folder, a new name): refused when anything,
 * a broken link included, is already at `to`, and `mv -T` so a folder named `to` is never
 * moved into. Both paths ride in as arguments.
 */
export function renameArgv(from: string, to: string): string[] {
  return [
    'sh',
    '-c',
    'if [ -e "$2" ] || [ -L "$2" ]; then echo "$2: File exists" >&2; exit 1; fi; exec mv -T -- "$1" "$2"',
    'sh',
    from,
    to,
  ];
}

/** The command that deletes `path`: a file, a link (never what it points to), or a whole folder. */
export function deleteArgv(path: string): string[] {
  return ['rm', '-r', '--', path];
}

/**
 * A failed rename or delete of `path` as an error with its `code`: `exists` (the new name is
 * taken), `not_found`, `forbidden` or `not_running`, else an `Error` carrying stderr.
 */
export function changeError(
  path: string,
  out: ExecOutput,
  what: string,
): Error {
  const msg = out.stderr.trim();
  if (/file exists/i.test(msg)) {
    return new FilesError(
      'exists',
      `${msg.replace(/: File exists$/i, '')} already exists`,
    );
  }
  if (/no such file or directory|not a directory/i.test(msg)) {
    return new FilesError('not_found', `${path} does not exist`);
  }
  if (
    /permission denied|read-only file system|operation not permitted/i.test(msg)
  ) {
    return new FilesError('forbidden', `${path} can't be ${what} here`);
  }
  if (/is not running|no such container/i.test(msg)) {
    return new FilesError('not_running', 'the container is not running');
  }
  return new Error(
    msg || `${what === 'renamed' ? 'renaming' : 'deleting'} failed`,
  );
}

/**
 * Renames `from` to `to` (both absolute, in the same folder) in the container, as the remote
 * user. Resolves with the new path; throws {@link FilesError} (`exists`, `not_found`,
 * `forbidden`, `not_running`), or an `Error` carrying the command's stderr.
 */
export async function renameContainerEntry(
  info: ContainerInfo,
  from: string,
  to: string,
  run: DockerRun = runDocker,
): Promise<{ path: string }> {
  const out = await run(
    dockerExecArgv(info, { cwd: '/', cmd: renameArgv(from, to) }),
  );
  if (out.code !== 0) throw changeError(from, out, 'renamed');
  return { path: to };
}

/**
 * Deletes `path` (absolute) in the container, as the remote user: a folder with everything in
 * it. Throws as {@link renameContainerEntry} does, `exists` aside.
 */
export async function deleteContainerEntry(
  info: ContainerInfo,
  path: string,
  run: DockerRun = runDocker,
): Promise<Record<string, never>> {
  const out = await run(
    dockerExecArgv(info, { cwd: '/', cmd: deleteArgv(path) }),
  );
  if (out.code !== 0) throw changeError(path, out, 'deleted');
  return {};
}

/** Runs `docker args…` with `input` as its stdin. */
export type DockerRunInput = (
  args: string[],
  input: Uint8Array,
) => Promise<ExecOutput>;

/** `docker args…` to completion with `input` piped to stdin, killed after the same timeout. */
export const runDockerInput: DockerRunInput = async (args, input) => {
  const child = new Deno.Command('docker', {
    args,
    stdin: 'piped',
    stdout: 'piped',
    stderr: 'piped',
    signal: AbortSignal.timeout(EXEC_TIMEOUT_MS),
  }).spawn();
  const writer = child.stdin.getWriter();
  try {
    await writer.write(input);
    await writer.close();
  } catch { /* the child exited first: its status says why */ }
  const out = await child.output();
  return {
    code: out.code,
    stdout: out.stdout,
    stderr: new TextDecoder().decode(out.stderr),
  };
};

/**
 * The command that writes stdin to `file`, making folder `dir` first. Both ride in as
 * arguments, never spliced into the script.
 */
export function writeArgv(dir: string, file: string): string[] {
  return ['sh', '-c', 'mkdir -p "$1" && cat > "$2"', 'sh', dir, file];
}

/**
 * Writes `text` to `file` (absolute) in the container, as the remote user, making `dir` first.
 * Throws {@link FilesError} `not_running`, or an `Error` carrying the command's stderr.
 */
export async function writeContainerFile(
  info: ContainerInfo,
  dir: string,
  file: string,
  text: string,
  run: DockerRunInput = runDockerInput,
): Promise<void> {
  const out = await run(
    dockerExecArgv(info, {
      interactive: true,
      cwd: '/',
      cmd: writeArgv(dir, file),
    }),
    new TextEncoder().encode(text),
  );
  if (out.code === 0) return;
  const msg = out.stderr.trim();
  if (/is not running|no such container/i.test(msg)) {
    throw new FilesError('not_running', 'the container is not running');
  }
  throw new Error(msg || `writing ${file} failed`);
}
