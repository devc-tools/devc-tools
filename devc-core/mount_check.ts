// Mount checks that run before the image build, so a bad bind mount fails in seconds instead of
// after `devcontainer up` has spent minutes building an image (and, under `devc build`, after it
// has already removed the working container).
//
// Order inside one `devcontainer up` (0.88.0): config read → `initializeCommand` on the host →
// container lookup (removed under `--remove-existing-container`) → image build → container
// create, which is where a bad bind mount fails. So the two checks sit at the two points where
// their answers are final:
//
// - **Spec problems** ({@link mountSpecProblems}) are decidable from the config alone, and are
//   refused before `up` runs at all.
// - **Missing sources** are only decidable after `initializeCommand`, which is what creates them
//   (the bundled default's `initialize-command.sh` creates every `~/.config/devc/*` source). So
//   devc appends a shell check to the merged config's `initializeCommand`
//   ({@link withMountSourceCheck}); a missing path then stops `up` right after init.
//   {@link missingMountSources} is the same check in-process, for naming the cause after a
//   failed `up`.
//
// The entries are parsed here, not with `mounts.ts`'s `parseMountSpec`: git protection depends
// on that function's exact behavior.

import { existsSync } from 'node:fs';
import process from 'node:process';
import { substituteVars } from './default_config.ts';
import { basenamePosix } from './posix.ts';

/** One mount entry devc refuses, with the reason. */
export interface MountProblem {
  /** The entry as written: the string itself, or `JSON.stringify` of any other form. */
  entry: string;
  reason: string;
}

/** A well-formed bind mount whose source devc can check, both values substituted. */
export interface BindMount {
  source: string;
  target: string;
}

const MOUNT_TYPES = new Set(['bind', 'volume', 'tmpfs', 'image']);

interface ParsedMount {
  type: string;
  source: string | undefined;
  target: string | undefined;
}

/** `type`/`source`/`target` of one entry, or `null` when it is neither a string nor an object. */
function parseEntry(entry: unknown): ParsedMount | null {
  if (typeof entry === 'string') {
    const out: ParsedMount = {
      type: 'bind',
      source: undefined,
      target: undefined,
    };
    for (const part of entry.split(',')) {
      const eq = part.indexOf('=');
      // A bare flag (`readonly`) — nothing this module checks.
      if (eq === -1) continue;
      const key = part.slice(0, eq).trim();
      const value = part.slice(eq + 1);
      if (key === 'type') out.type = value;
      else if (key === 'source' || key === 'src') out.source = value;
      else if (key === 'target' || key === 'destination' || key === 'dst') {
        out.target = value;
      }
      // Any other key is ignored: Docker's key set grows, and an unknown key is not a problem
      // devc can see.
    }
    return out;
  }
  if (typeof entry === 'object' && entry !== null && !Array.isArray(entry)) {
    const obj = entry as Record<string, unknown>;
    return {
      type: typeof obj.type === 'string' ? obj.type : 'bind',
      source: typeof obj.source === 'string' ? obj.source : undefined,
      target: typeof obj.target === 'string' ? obj.target : undefined,
    };
  }
  return null;
}

/** The `mounts` entries plus a non-empty string `workspaceMount`, in that order. */
function mountEntries(config: Record<string, unknown>): unknown[] {
  const entries = Array.isArray(config.mounts) ? [...config.mounts] : [];
  if (
    typeof config.workspaceMount === 'string' && config.workspaceMount !== ''
  ) {
    entries.push(config.workspaceMount);
  }
  return entries;
}

/**
 * Substitute the variables devc can resolve. `${containerWorkspaceFolder}` becomes
 * `/workspaces/<basename>` only so a target using it reads as absolute — the CLI's real value is
 * absolute too.
 */
function substitute(value: string, localFolder: string): string {
  return substituteVars(
    value,
    `/workspaces/${basenamePosix(localFolder)}`,
    localFolder,
  );
}

/** A value with a `${` still in it after substitution: devc cannot know what it will be. */
function unresolved(value: string): boolean {
  return value.includes('${');
}

function stripTrailingSlash(path: string): string {
  return path.replace(/\/+$/, '') || '/';
}

interface CheckedEntry {
  entry: unknown;
  problem: string | null;
  parsed: ParsedMount | null;
  source: string | undefined;
  target: string | undefined;
}

function checkEntries(
  config: Record<string, unknown>,
  localFolder: string,
): CheckedEntry[] {
  const seenTargets = new Set<string>();
  return mountEntries(config).map((entry) => {
    const parsed = parseEntry(entry);
    if (parsed === null) {
      return {
        entry,
        problem: 'not a mount spec',
        parsed,
        source: undefined,
        target: undefined,
      };
    }
    const source = parsed.source === undefined
      ? undefined
      : substitute(parsed.source, localFolder);
    const target = parsed.target === undefined
      ? undefined
      : substitute(parsed.target, localFolder);
    const problem = entryProblem(parsed, source, target, seenTargets);
    if (target !== undefined && target !== '') {
      seenTargets.add(stripTrailingSlash(target));
    }
    return { entry, problem, parsed, source, target };
  });
}

/** The first reason in table order, or `null`. */
function entryProblem(
  parsed: ParsedMount,
  source: string | undefined,
  target: string | undefined,
  seenTargets: Set<string>,
): string | null {
  if (target === undefined || target === '') return 'no target';
  if (!unresolved(target) && !target.startsWith('/')) {
    return 'target is not an absolute path';
  }
  if (!MOUNT_TYPES.has(parsed.type)) {
    return `unsupported type "${parsed.type}"`;
  }
  if (parsed.type === 'bind') {
    if (source === undefined || source === '') {
      return 'bind mount has no source';
    }
    if (!unresolved(source) && !source.startsWith('/')) {
      return 'bind source is not an absolute path';
    }
  }
  if (parsed.type === 'tmpfs' && source !== undefined && source !== '') {
    return 'tmpfs mount takes no source';
  }
  if (seenTargets.has(stripTrailingSlash(target))) {
    return `duplicate target ${target}`;
  }
  return null;
}

/**
 * Every malformed entry among `config`'s `mounts` and `workspaceMount`, in config order, each
 * with the first reason that applies. Decidable before anything runs.
 */
export function mountSpecProblems(
  config: Record<string, unknown>,
  localFolder: string,
): MountProblem[] {
  return checkEntries(config, localFolder)
    .filter((c) => c.problem !== null)
    .map((c) => ({
      entry: typeof c.entry === 'string' ? c.entry : JSON.stringify(c.entry),
      reason: c.problem!,
    }));
}

/**
 * The well-formed bind mounts whose substituted source has no `${` left in it — the ones whose
 * source devc can check — in config order.
 */
export function checkableBindMounts(
  config: Record<string, unknown>,
  localFolder: string,
): BindMount[] {
  return checkEntries(config, localFolder)
    .filter((c) =>
      c.problem === null && c.parsed?.type === 'bind' &&
      !unresolved(c.source!)
    )
    .map((c) => ({ source: c.source!, target: c.target! }));
}

/**
 * {@link checkableBindMounts} whose source does not exist on this host. `existsSync` follows
 * symlinks, so a dangling link counts as missing — as it does for Docker.
 */
export function missingMountSources(
  config: Record<string, unknown>,
  localFolder: string,
): BindMount[] {
  return checkableBindMounts(config, localFolder).filter((m) =>
    !existsSync(m.source)
  );
}

/** `value` single-quoted for `/bin/sh`, each `'` written as `'\''`. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * `initializeCommand` with a source-existence check for `binds` appended, as one `/bin/sh -c`
 * string; `original` unchanged when there is nothing to check, on win32 (the CLI runs
 * `cmd.exe`), and for an object-form command (its entries run in parallel, so there is no "after
 * all of them" to append to) or any other form the CLI would not run through a shell.
 *
 * A string original runs in a subshell, so an `exit 0` inside it cannot skip the check, and its
 * failure still stops `up` with its own status. `${…}` in the original is left for the CLI, which
 * substitutes the whole command text; `binds` are already substituted.
 */
export function withMountSourceCheck(
  original: unknown,
  binds: readonly BindMount[],
  platform: string = process.platform,
): unknown {
  if (binds.length === 0 || platform === 'win32') return original;
  let prefix: string[];
  if (
    original === undefined || original === null || original === '' ||
    (Array.isArray(original) && original.length === 0)
  ) {
    prefix = [];
  } else if (typeof original === 'string') {
    prefix = ['(', original, ') || exit $?'];
  } else if (
    Array.isArray(original) && original.every((a) => typeof a === 'string')
  ) {
    prefix = [`${original.map(shellQuote).join(' ')} || exit $?`];
  } else {
    return original;
  }
  return [
    ...prefix,
    'devc_missing=0',
    ...binds.map(({ source, target }) =>
      `[ -e ${
        shellQuote(source)
      } ] || { printf 'devc: bind mount source does not exist: %s (target %s)\\n' ${
        shellQuote(source)
      } ${shellQuote(target)} >&2; devc_missing=1; }`
    ),
    `[ "$devc_missing" -eq 0 ] || { printf '%s\\n' ${
      shellQuote(
        'devc: stopping before the image build - create the missing path(s) or fix the mount, then run devc again',
      )
    } >&2; exit 1; }`,
  ].join('\n');
}
