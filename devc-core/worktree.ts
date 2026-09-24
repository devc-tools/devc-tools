// Worktree resolution for the `devc config` wizard.
//
// When a picked source folder is a git *worktree*, its `.git` file points at the primary
// repo's git dir (`<primary>/.git/worktrees/<name>`). For git to work inside the container the
// primary git dir must be mounted where that link still resolves, which needs two things:
//   1. a *relative* `gitdir:` — an absolute one names a host path that does not exist in the
//      container, and nothing we mount can fix that; and
//   2. both container targets mirrored from one shared **base** directory, so the host offset
//      between the worktree and the primary is preserved.
// Any directory holding both can serve as that base. We prefer the configured code root (shallow,
// stable container paths) and fall back to their common ancestor — the same choice the devcontainer
// CLI makes for a worktree opened as the project folder itself.
//
// All of it is readable straight from the worktree's `.git` file, so this stays pure given an
// injected `FsProbe` (no `git` subprocess) — fast enough to run per-entry in the picker and
// identical to the decision the mount builder makes.

import { readFile, stat } from 'node:fs/promises';
import {
  basenamePosix,
  commonAncestorPosix,
  dirnamePosix,
  isAbsolutePosix,
  relativeUnderPosix,
  resolvePosix,
} from './posix.ts';

/** Minimal filesystem access the resolver needs, injected so tests can drive it headlessly. */
export interface FsProbe {
  /** True when `path` exists and is a regular file (a worktree's `.git` is a file). */
  statIsFile(path: string): Promise<boolean>;
  /** The file's text, or null when missing/unreadable. */
  readText(path: string): Promise<string | null>;
}

/** The real filesystem-backed probe used outside tests. */
export const realFsProbe: FsProbe = {
  async statIsFile(path) {
    try {
      return (await stat(path)).isFile();
    } catch {
      return false;
    }
  },
  async readText(path) {
    try {
      return await readFile(path, 'utf8');
    } catch {
      return null;
    }
  },
};

/** The outcome of probing a picked folder for worktree-ness. */
export type WorktreeInfo =
  | { isWorktree: false }
  | {
    isWorktree: true;
    /** Whether the primary `.git` can be mounted, i.e. the `gitdir:` link is relative. */
    valid: boolean;
    /** Human-readable reason when `!valid`, for the picker flag. */
    reason?: string;
    /** Absolute host path of the primary repo's git dir (e.g. `.../myproject/.git`). */
    primaryGitDir?: string;
    /** Absolute host path of the primary repo's working tree (e.g. `.../myproject`). */
    primaryRoot?: string;
    /** Container target for the primary `.git` mount (only set when `valid`). */
    primaryGitTarget?: string;
    /**
     * Host directory both this worktree's own target and `primaryGitTarget` mirror from (only set
     * when `valid`). The worktree's source row must use it, or the offsets won't match.
     */
    mountBase?: string;
  };

/**
 * The longest root in `roots` that is `absPath` itself or an ancestor of it, or null when none
 * apply. Longest wins so nested roots (`~/code` and `~/code/team`) resolve to the most specific.
 */
export function longestRootAncestor(
  absPath: string,
  roots: string[],
): string | null {
  let best: string | null = null;
  for (const r of roots) {
    if (absPath === r || absPath.startsWith(r + '/')) {
      if (best === null || r.length > best.length) best = r;
    }
  }
  return best;
}

/**
 * Probe `pickedAbs` for worktree-ness and, if it is one, whether its primary `.git` can be
 * mounted given the code `root` it falls under (from `longestRootAncestor`). Pure given `fs`.
 */
export async function resolveWorktree(
  pickedAbs: string,
  root: string | null,
  fs: FsProbe,
): Promise<WorktreeInfo> {
  const gitFile = pickedAbs + '/.git';
  // A plain repo has a `.git` *directory*; a non-repo has neither. Only a worktree (or
  // submodule) has a `.git` *file*.
  if (!(await fs.statIsFile(gitFile))) return { isWorktree: false };

  const text = await fs.readText(gitFile);
  const m = text?.match(/^gitdir:\s*(.+?)\s*$/m);
  if (!m) return { isWorktree: false };
  const raw = m[1];

  const gitdirAbs = isAbsolutePosix(raw) ? raw : resolvePosix(pickedAbs, raw);
  // A worktree's git dir ends `.../worktrees/<name>`; a submodule's is `.../modules/<name>`.
  if (!/\/worktrees\/[^/]+\/?$/.test(gitdirAbs)) return { isWorktree: false };

  const primaryGitDir = gitdirAbs.slice(0, gitdirAbs.indexOf('/worktrees/'));
  const primaryRoot = dirnamePosix(primaryGitDir);

  // An absolute `gitdir:` is the only thing we cannot mount around (see the module header).
  const valid = !isAbsolutePosix(raw);
  // Prefer the configured root when it holds the primary too: container paths stay shallow, and this
  // is the case that produces the same targets it always has. Otherwise mirror from the common
  // ancestor, which by construction holds both.
  const rootHoldsPrimary = root !== null &&
    (primaryRoot === root || primaryRoot.startsWith(root + '/'));
  const mountBase = rootHoldsPrimary
    ? root
    : commonAncestorPosix(pickedAbs, primaryRoot);
  const rel = valid ? relativeUnderPosix(mountBase, primaryGitDir) : null;

  return {
    isWorktree: true,
    valid,
    reason: valid ? undefined : 'worktree uses absolute paths',
    primaryGitDir,
    primaryRoot,
    primaryGitTarget: rel === null ? undefined : `/workspaces/${rel}`,
    mountBase: rel === null ? undefined : mountBase,
  };
}

/** How one picked path should be mounted, plus whatever it drags in. */
export interface PickedMount {
  /** The picked absolute host path. */
  path: string;
  /** Directory its container target mirrors from; undefined ⇒ the `/workspaces/<basename>` fallback. */
  base?: string;
  /**
   * Absolute host path of the primary repo's working tree this pick belongs to — set on mountable
   * worktrees only. It is what groups a repo's mounts together in the fence, and it is deliberately
   * the working tree rather than the git dir: a pick *of* the primary itself has that same path, so
   * its worktrees group under it whether or not a separate `.git` mount was needed.
   */
  repo?: string;
  /**
   * The primary repo `.git` this pick drags in — set on the *first* pick of a repo that needs one,
   * so a shared primary is mounted once (later picks of the same repo carry only `repo`).
   */
  primary?: {
    /** Absolute host path of the primary repo's git dir. */
    gitDir: string;
    /** Container target it is mounted at. */
    target: string;
  };
}

/**
 * Resolve each picked path to the base its container target mirrors from, the repo it belongs to,
 * and the primary `.git` it drags in — one entry per input, in order.
 *
 * Single source of truth on purpose: the picker shows these while you pick and the mount builder
 * writes them, so both call this rather than each deciding for itself. The base has to travel with
 * the primary mount, because a worktree's *own* target moves with it.
 */
export async function resolvePickedMounts(
  paths: string[],
  codeRoots: string[],
  fs: FsProbe,
): Promise<PickedMount[]> {
  const picked = new Set(paths);
  const seen = new Set<string>();
  const mounts: PickedMount[] = [];
  for (const path of paths) {
    const root = longestRootAncestor(path, codeRoots);
    const wt = await resolveWorktree(path, root, fs);
    if (!wt.isWorktree || !wt.valid || wt.mountBase === undefined) {
      mounts.push({ path, base: root ?? undefined });
      continue;
    }

    const mount: PickedMount = {
      path,
      base: wt.mountBase,
      repo: wt.primaryRoot,
    };
    // Nothing to add when the primary's whole working tree is picked (that mount already carries its
    // `.git`), or when an earlier pick brought the same target in — worktrees sharing one primary.
    if (
      wt.primaryGitTarget !== undefined && !picked.has(wt.primaryRoot!) &&
      !seen.has(wt.primaryGitTarget)
    ) {
      seen.add(wt.primaryGitTarget);
      mount.primary = {
        gitDir: wt.primaryGitDir!,
        target: wt.primaryGitTarget,
      };
    }
    mounts.push(mount);
  }
  return mounts;
}

/** Where the devcontainer CLI mounts a linked worktree project folder, and its primary's git dir. */
export interface CliWorktreeMounts {
  /** Container target of the workspace mount itself, e.g. `/workspaces/app.worktrees/feat`. */
  workspaceTarget: string;
  /** Host path the CLI bind-mounts as the common git dir, e.g. `/code/app/.git`. */
  commonDirSource: string;
  /** Container target of that mount, e.g. `/workspaces/app/.git`. */
  commonDirTarget: string;
}

/**
 * The two mounts `@devcontainers/cli` 0.88.0 makes for a workspace whose git root `root` is a
 * **linked worktree**, under `--mount-git-worktree-common-dir` — or null when it makes none (the
 * `.git` is not a file, has no `gitdir:` line, or the pointer is absolute).
 *
 * A transcription of the CLI's own workspace-mount defaulting (`devContainersSpecCLI.js`), kept
 * literal on purpose — devc has to name these targets *before* `up` so it can freeze the common
 * dir's `config` and `hooks`, and any divergence from the CLI leaves the real mount unprotected:
 *
 * ```
 * c   = /^gitdir:\s*(.+)$/m on <root>/.git     (not trimmed: the CLI does not trim either)
 * u   = path.resolve(root, c, '..', '..')
 * seg = basename of F for F = root, dirname(root), … while !u.startsWith(F + '/'), root-first
 * E   = posix.join('/workspaces', ...seg)
 * d   = posix.resolve(E, c, '..', '..')
 * ```
 *
 * The CLI resolves `u` with the host `path` module and `d` with `posix`; devc's hosts are POSIX,
 * so both use the posix helpers here. The walk also stops at the filesystem root, as the CLI's
 * does (`F !== dirname(F)`).
 */
export async function cliWorktreeMounts(
  root: string,
  fs: FsProbe = realFsProbe,
): Promise<CliWorktreeMounts | null> {
  const dotGit = `${root}/.git`;
  if (!(await fs.statIsFile(dotGit))) return null;
  const m = /^gitdir:\s*(.+)$/m.exec(await fs.readText(dotGit) ?? '');
  if (m === null) return null;
  const c = m[1];
  if (isAbsolutePosix(c)) return null;

  const u = resolvePosix(resolvePosix(root, c), '../..');
  const seg: string[] = [];
  for (
    let f = root;
    !u.startsWith(f + '/') && f !== dirnamePosix(f);
    f = dirnamePosix(f)
  ) {
    seg.unshift(basenamePosix(f));
  }
  const workspaceTarget = ['/workspaces', ...seg].join('/');
  return {
    workspaceTarget,
    commonDirSource: u,
    commonDirTarget: resolvePosix(resolvePosix(workspaceTarget, c), '../..'),
  };
}
