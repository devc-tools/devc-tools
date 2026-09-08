// `node:fs` reports "no such file", "already exists", "not a directory" and "directory not
// empty" as an `Error` with a `.code` string (`ENOENT` / `EEXIST` / `ENOTDIR` / `ENOTEMPTY`), the
// same on both hosts since the Deno runtime's `node:fs` shim raises the identical codes. These
// predicates replace the old `instanceof` checks against the runtime's own error-class
// namespace.

interface ErrnoException {
  code?: string;
}

function hasCode(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null &&
    (err as ErrnoException).code === code;
}

/**
 * True when `err` is a "no such file or directory" error — from `node:fs`, or from a
 * `child_process` spawn of a binary that is not on `PATH` (same `ENOENT` code).
 */
export function isNotFound(err: unknown): boolean {
  return hasCode(err, 'ENOENT');
}

/** True when `err` is a `node:fs` "file already exists" error. */
export function isAlreadyExists(err: unknown): boolean {
  return hasCode(err, 'EEXIST');
}

/**
 * True when `err` is a `node:fs` "directory not empty" error.
 *
 * The one caller is {@link ensureDefaultConfig}'s `rename` of a staging directory onto its keyed
 * target: a `rename` onto a directory that another process already populated fails this way
 * (`EEXIST` is the same event on some platforms), and both mean "someone else won", not "this
 * broke".
 */
export function isDirectoryNotEmpty(err: unknown): boolean {
  return hasCode(err, 'ENOTEMPTY');
}

/** True when `err` is a `node:fs` "not a directory" error. */
export function isNotADirectory(err: unknown): boolean {
  return hasCode(err, 'ENOTDIR');
}
