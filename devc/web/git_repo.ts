// What `devc web` knows about a repo folder without running git in it: its git dirs, its
// checked-out branch, that branch's upstream, and which repos a container mounts.
//
// Agents in containers can write these folders, `.git/config` and the `.git` pointer file
// included, so everything here reads them as data. The one git call, `git config --file`,
// parses a config file and runs nothing it names. See `git_status.ts` for why that matters.

import { basename, dirname, join, resolve } from 'jsr:@std/path';

/** A repo's git dirs: `gitDir` holds its HEAD, `commonDir` its config, refs and objects. */
export interface RepoDirs {
  gitDir: string;
  commonDir: string;
}

async function real(path: string): Promise<string | null> {
  try {
    return await Deno.realPath(path);
  } catch {
    return null;
  }
}

async function firstLine(path: string): Promise<string | null> {
  try {
    return (await Deno.readTextFile(path)).split('\n')[0].replace(/\r$/, '');
  } catch {
    return null;
  }
}

/**
 * `folder`'s git dirs, or `null` when it is no repo or its `.git` is not honest. A primary's
 * `.git` is a directory with no `commondir` (which would borrow another repo's refs). A linked
 * worktree's `.git` file must point at `<primary>/.git/worktrees/<name>`, whose `gitdir` points
 * back at it and whose `commondir` is `<primary>/.git`: devc-bridge's `gh-push` checks the same.
 */
export async function resolveRepo(folder: string): Promise<RepoDirs | null> {
  const dotGit = join(folder, '.git');
  let info: Deno.FileInfo;
  try {
    info = await Deno.lstat(dotGit);
  } catch {
    return null;
  }
  if (info.isDirectory) {
    const gitDir = await real(dotGit);
    if (gitDir === null || await real(join(gitDir, 'commondir')) !== null) {
      return null;
    }
    return { gitDir, commonDir: gitDir };
  }
  if (!info.isFile) return null;
  const pointer = await firstLine(dotGit);
  if (!pointer?.startsWith('gitdir: ')) return null;
  const gitDir = await real(resolve(folder, pointer.slice('gitdir: '.length)));
  if (
    gitDir === null || basename(dirname(gitDir)) !== 'worktrees' ||
    basename(dirname(dirname(gitDir))) !== '.git'
  ) return null;
  const back = await firstLine(join(gitDir, 'gitdir'));
  const here = await real(folder);
  if (!back || here === null) return null;
  const backPath = resolve(gitDir, back);
  const backDir = await real(dirname(backPath));
  if (
    backDir === null || join(backDir, basename(backPath)) !== join(here, '.git')
  ) {
    return null;
  }
  const common = await firstLine(join(gitDir, 'commondir'));
  if (!common) return null;
  const commonDir = await real(resolve(gitDir, common));
  if (commonDir === null || commonDir !== dirname(dirname(gitDir))) return null;
  return { gitDir, commonDir };
}

/** The branch `gitDir`'s HEAD has checked out; `null` when detached or unreadable. */
export async function readBranch(gitDir: string): Promise<string | null> {
  const head = await firstLine(join(gitDir, 'HEAD'));
  const prefix = 'ref: refs/heads/';
  return head?.startsWith(prefix) ? head.slice(prefix.length) || null : null;
}

/** A branch's upstream, as its repo's config names it. */
export interface Upstream {
  /** The remote's name, or its URL when the branch names one directly. */
  remote: string;
  url: string;
  /** The upstream branch, without `refs/heads/`. */
  branch: string;
  /** Its remote-tracking ref in the repo (`refs/remotes/<remote>/<branch>`); `null` for a URL remote. */
  trackingRef: string | null;
}

/**
 * Picks `branch`'s upstream out of `git config -z --list` output: `branch.<b>.remote` and
 * `.merge`, and the remote's first `url`. `null` when it tracks nothing, tracks a local branch
 * (`remote = .`), or tracks something other than a branch.
 */
export function parseUpstream(list: string, branch: string): Upstream | null {
  const values = new Map<string, string[]>();
  for (const entry of list.split('\0')) {
    const nl = entry.indexOf('\n');
    const key = nl === -1 ? entry : entry.slice(0, nl);
    if (!key) continue;
    values.set(key, [
      ...(values.get(key) ?? []),
      nl === -1 ? '' : entry.slice(nl + 1),
    ]);
  }
  const last = (key: string) => values.get(key)?.at(-1);
  const remote = last(`branch.${branch}.remote`);
  const merge = last(`branch.${branch}.merge`);
  if (!remote || remote === '.' || !merge?.startsWith('refs/heads/')) {
    return null;
  }
  const upstreamBranch = merge.slice('refs/heads/'.length);
  const named = values.get(`remote.${remote}.url`)?.[0];
  if (named === undefined && !remote.includes(':') && !remote.startsWith('/')) {
    return null;
  }
  return {
    remote,
    url: named ?? remote,
    branch: upstreamBranch,
    trackingRef: named === undefined
      ? null
      : `refs/remotes/${remote}/${upstreamBranch}`,
  };
}

/** `branch`'s upstream, read from `commonDir`'s config as a file (no includes). Never throws. */
export async function readUpstream(
  commonDir: string,
  branch: string,
): Promise<Upstream | null> {
  try {
    const out = await new Deno.Command('git', {
      args: [
        'config',
        '--file',
        join(commonDir, 'config'),
        '--no-includes',
        '-z',
        '--list',
      ],
      cwd: '/',
      stdin: 'null',
      stdout: 'piped',
      stderr: 'null',
      signal: AbortSignal.timeout(5000),
    }).output();
    if (!out.success) return null;
    return parseUpstream(new TextDecoder().decode(out.stdout), branch);
  } catch {
    return null;
  }
}

/**
 * Whether the host may fetch `url`: `https://`, `ssh://` or scp-style `user@host:path`, with no
 * option-like host. Everything else (`ext::`, `file://`, a local path) a repo's config could name
 * to make git run something or read the host's own repos.
 */
export function isFetchableRemote(url: string): boolean {
  if (/\s/.test(url)) return false;
  const m = /^(?:https|ssh):\/\/(?:[^@/]+@)?([^/]+)\/./.exec(url) ??
    /^[A-Za-z0-9._-]+@([^/:]+):./.exec(url);
  return m !== null && !m[1].startsWith('-') && !url.startsWith('-');
}

/** A repo a container has, for the sidebar. */
export interface MountedRepo {
  folder: string;
  /** The folder of the repo it is a linked worktree of, when that repo is listed too. */
  worktreeOf: string | null;
  /** Its path inside the container; null when no mount covers it or the mounts aren't read. */
  containerFolder: string | null;
}

/**
 * The repos a container has: `primary` (its project folder) first, then every other bind
 * mount `sources` (host paths) that is a repo, and the worktrees in any `<repo>.worktrees`
 * mount. A worktree follows the repo it belongs to; the rest go by name. Mounts inside the
 * primary or inside a `.git` (devc's git protection) are skipped. `containerFolder` is left
 * null: the caller has the mount table.
 */
export async function mountedRepos(
  primary: string,
  sources: readonly string[],
): Promise<MountedRepo[]> {
  const inside = (p: string, dir: string) =>
    p === dir || p.startsWith(`${dir}/`);
  const folders: string[] = [];
  for (const source of new Set(sources)) {
    if (inside(source, primary) || /(^|\/)\.git(\/|$)/.test(source)) continue;
    if (await resolveRepo(source) !== null) {
      folders.push(source);
    } else if (basename(source).endsWith('.worktrees')) {
      try {
        for await (const e of Deno.readDir(source)) {
          if (e.isDirectory) folders.push(join(source, e.name));
        }
      } catch { /* unreadable: no worktrees */ }
    }
  }
  const repos = [primary, ...folders];
  const commonOf = new Map<string, string | null>();
  for (const f of repos) {
    commonOf.set(f, (await resolveRepo(f))?.commonDir ?? null);
  }
  // A primary's own commonDir is `<folder>/.git`; a worktree's points at its primary's.
  const primaryByCommon = new Map<string, string>();
  for (const f of repos) {
    const common = commonOf.get(f);
    if (
      common !== null && common !== undefined &&
      dirname(common) === (await real(f))
    ) {
      primaryByCommon.set(common, f);
    }
  }
  const listed = repos.filter((f) => f === primary || commonOf.get(f) !== null);
  const parentOf = (f: string) => {
    const owner = primaryByCommon.get(commonOf.get(f) ?? '');
    return owner !== undefined && owner !== f ? owner : null;
  };
  const byName = (a: string, b: string) =>
    basename(a).localeCompare(basename(b)) || a.localeCompare(b);
  const tops = listed.filter((f) => f !== primary && parentOf(f) === null).sort(
    byName,
  );
  const out: MountedRepo[] = [];
  for (const top of [primary, ...tops]) {
    out.push({ folder: top, worktreeOf: null, containerFolder: null });
    for (const wt of listed.filter((f) => parentOf(f) === top).sort(byName)) {
      out.push({ folder: wt, worktreeOf: top, containerFolder: null });
    }
  }
  return out;
}
