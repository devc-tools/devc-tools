// Git repository identity, read straight from the filesystem.
//
// A repo overlay (`~/.config/devc/repos/<key>/devc.jsonc`) applies to a primary checkout and every
// linked worktree of it, so the identity has to be something they all share: the **common git
// dir**. A primary checkout's `.git` directory is it; a linked worktree's `.git` file points at
// `<common>/worktrees/<name>`, whose `commondir` file points back at `<common>`. A submodule's git
// dir (`.git/modules/<name>`) has no `commondir`, so it is a repo of its own; a worktree of a bare
// repo resolves to the bare repo's directory.
//
// No `git` subprocess, for the same reason as {@link findRepoRoot}: `git -C <repo>` on the host
// fires `core.fsmonitor`. Nothing here asks whether a worktree is *mountable* — that is
// `worktree.ts`'s question, and an absolute `gitdir:` identifies a repo perfectly well.

import { readFile, realpath, stat } from 'node:fs/promises';
import { isNotADirectory, isNotFound } from './errors.ts';
import {
  basenamePosix,
  dirnamePosix,
  isAbsolutePosix,
  resolvePosix,
} from './posix.ts';

/** What a path is, for the `.git` walk. A permissions failure throws rather than guessing. */
export async function statKind(
  path: string,
): Promise<'dir' | 'file' | 'none'> {
  try {
    const info = await stat(path);
    return info.isDirectory() ? 'dir' : 'file';
  } catch (err) {
    if (isNotFound(err) || isNotADirectory(err)) return 'none';
    // A permissions failure on a host path is not "no repo here" — it is a host devc cannot read,
    // and guessing either way would be wrong. Surface it.
    throw err;
  }
}

/**
 * The repo root devc should protect for a project folder: the nearest ancestor of `localFolder`
 * (itself included) holding a `.git`, or null when there is none.
 *
 * This mirrors what the devcontainer CLI actually binds, which is **not** `localFolder**: with
 * `--mount-workspace-git-root` — on by default, and devc does not turn it off — the CLI resolves
 * the workspace mount's source to the git toplevel and targets it at
 * `/workspaces/<basename(root)>`, leaving `workspaceFolder` to point at the sub-path inside.
 * A project in a repo subdirectory therefore has its *whole repo* bind-mounted, `.git` included,
 * and that is the thing to freeze.
 *
 * Walked here rather than shelled out to `git rev-parse`, deliberately: `git -C <repo>` on the
 * host fires `core.fsmonitor`, which is one of the two payloads this whole control exists to
 * disarm. devc must not trip it while deciding whether to defuse it.
 */
export async function findRepoRoot(
  localFolder: string,
): Promise<string | null> {
  // Not a plain strip of every trailing slash: that would turn the filesystem root into '' and
  // send the walk relative to the process cwd.
  let dir = localFolder.length > 1
    ? localFolder.replace(/(?!^)\/+$/, '')
    : localFolder;
  for (;;) {
    if (await statKind(`${dir}/.git`) !== 'none') return dir;
    const parent = dirnamePosix(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** A checkout's git identity. All three paths are absolute. */
export interface RepoIdentity {
  /** The nearest ancestor holding `.git` ({@link findRepoRoot}). */
  checkoutRoot: string;
  /** This checkout's own git dir — `<root>/.git`, or what its `.git` file points at. */
  gitDir: string;
  /** The git dir every checkout of the repo shares, canonicalized with `realpath`. */
  commonDir: string;
}

/**
 * The folder is in a repo, but its git metadata cannot be read: an unreadable `.git`, a `.git`
 * file with no `gitdir:` line, an unreadable `commondir`, or a git dir that does not exist.
 * `message` is the bare reason, for `devc: no repo overlay for <folder> — <reason>`.
 */
export class RepoMetadataError extends Error {
  override name = 'RepoMetadataError';
}

function errText(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    return typeof code === 'string' ? code : err.message;
  }
  return String(err);
}

/**
 * The repo `localFolder` belongs to, or null when it is in none. Throws
 * {@link RepoMetadataError} — never anything else — when the folder is in a repo whose metadata
 * cannot be read.
 */
export async function resolveRepo(
  localFolder: string,
): Promise<RepoIdentity | null> {
  let root: string | null;
  try {
    root = await findRepoRoot(localFolder);
  } catch (err) {
    throw new RepoMetadataError(
      `cannot look for .git above ${localFolder} (${errText(err)})`,
    );
  }
  if (root === null) return null;

  const dotGit = `${root}/.git`;
  let gitDir: string;
  if (await statKind(dotGit).catch(() => 'none') === 'dir') {
    gitDir = dotGit;
  } else {
    let text: string;
    try {
      text = await readFile(dotGit, 'utf8');
    } catch (err) {
      throw new RepoMetadataError(`cannot read ${dotGit} (${errText(err)})`);
    }
    const m = text.match(/^gitdir:\s*(.+?)\s*$/m);
    if (!m) throw new RepoMetadataError(`${dotGit} has no "gitdir:" line`);
    gitDir = isAbsolutePosix(m[1]) ? m[1] : resolvePosix(root, m[1]);
  }

  let commonDir = gitDir;
  try {
    const raw = (await readFile(`${gitDir}/commondir`, 'utf8')).trim();
    if (raw !== '') {
      commonDir = isAbsolutePosix(raw) ? raw : resolvePosix(gitDir, raw);
    }
  } catch (err) {
    if (!isNotFound(err) && !isNotADirectory(err)) {
      throw new RepoMetadataError(
        `cannot read ${gitDir}/commondir (${errText(err)})`,
      );
    }
  }

  try {
    commonDir = await realpath(commonDir);
  } catch (err) {
    throw new RepoMetadataError(
      isNotFound(err) || isNotADirectory(err)
        ? `git dir ${commonDir} not found`
        : `cannot resolve ${commonDir} (${errText(err)})`,
    );
  }
  return { checkoutRoot: root, gitDir, commonDir };
}

/**
 * The directory name for a repo's overlay: `<name>-<hash>`. `<name>` is the folder holding a
 * `.git` common dir, or a bare repo's name without `.git`; `<hash>` is the first 8 hex of SHA-256
 * over the lowercased common dir — {@link import("./merged_config.ts").projectKey}'s scheme, with
 * its case-folding tradeoff. The hash is of the *path*: moving the repo changes the key.
 */
export async function repoKey(commonDir: string): Promise<string> {
  const base = basenamePosix(commonDir);
  const raw = base === '.git'
    ? basenamePosix(dirnamePosix(commonDir))
    : base.replace(/\.git$/, '');
  const name = raw.replace(/[^a-zA-Z0-9_.-]/g, '-') || 'repo';
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(commonDir.toLowerCase()),
  );
  const hash = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 8);
  return `${name}-${hash}`;
}

/** `<configDir>/repos/<repoKey>` — where `commonDir`'s repo overlay lives. */
export async function repoOverlayDir(
  commonDir: string,
  configDir: string,
): Promise<string> {
  return `${configDir}/repos/${await repoKey(commonDir)}`;
}
