// Git worktrees for the `devc web` sidebar: a primary repo card's **New worktree…** and a linked
// worktree card's **Delete worktree…**, by the `<repo>` + `<repo>.worktrees/<name>` convention.
// See `.plans/devc-web-worktrees.md`.
//
// As for Fetch (`git_fetch.ts`), **the host never runs git in the repo**. The remote's commits
// are fetched into the host's bare mirror (host credentials), handed over as a bundle on stdin,
// and `git worktree add` / `remove` run **in the project's environment** that has both `<repo>`
// and `<repo>.worktrees` (a container's git under `docker exec`, a host project's directly).
// Worktrees are made with `--relative-paths`: container paths differ from host paths, and a
// relative `gitdir:` resolves on both sides when the two folders sit side by side in both.
//
// Git protection freezes `.git/config` in a container, so the branch's upstream is written by the
// host, in place: see {@link writeUpstream}. Open PRs and `origin`'s branches are read on the host
// (`gh pr list`, `git ls-remote`), with no repo. A worktree is never added to `projects.json`, no
// container is started or removed, and Delete never deletes the branch.

import { basename, dirname, join } from 'jsr:@std/path';
import { gitHubRepoOf } from '@devc-tools/core/bridge.ts';
import type { ContainerMount } from '@devc-tools/core/container.ts';
import { hostToContainerPath } from '@devc-tools/core/mount_paths.ts';
import type { Environment } from './environment.ts';
import { validBranch } from './git_fetch.ts';
import {
  isFetchableRemote,
  readBranch,
  readRemoteUrl,
  resolveRepo,
} from './git_repo.ts';
import {
  defaultMirrorOpts,
  FETCH_FLAGS,
  FETCH_TIMEOUT_MS,
  hash,
  MAX_BUNDLE_BYTES,
  mirrorFor,
  type MirrorOpts,
  run,
  runCapped,
} from './git_status.ts';

/** The oldest git with `git worktree add --relative-paths`. */
export const MIN_GIT: readonly [number, number] = [2, 48];

/** At most this many of `origin`'s branches are listed. */
export const MAX_REMOTE_BRANCHES = 5000;

/** At most this many open PRs are listed. */
export const MAX_PRS = 100;

/** How long `gh` may take. */
const GH_TIMEOUT_MS = 15_000;

/** How long `git worktree remove` may take. */
const REMOVE_TIMEOUT_MS = 60_000;

/** An open pull request, as the dialog lists it. */
export interface WorktreePr {
  number: number;
  title: string;
  author: string;
  headRefName: string;
  crossRepository: boolean;
  draft: boolean;
}

/** What the New worktree dialog offers. */
export interface WorktreeOptions {
  worktreesFolder: string;
  defaultBranch: string | null;
  currentBranch: string | null;
  remoteBranches: string[];
  remoteProblem: string | null;
  prs: WorktreePr[];
  prsProblem: string | null;
  localBranches: string[];
  checkedOut: string[];
  folders: string[];
}

/** Where a new worktree's commit comes from. */
export type WorktreeSource =
  | { kind: 'pr'; number: number }
  | { kind: 'remote'; remoteBranch: string }
  /**
   * A new branch from `origin/<default>`, the main checkout's HEAD (`current`), the HEAD of
   * `from`, a linked worktree of the same repo in the same environment (`worktree`), or
   * `origin/<remoteBranch>` (`remote`), with no upstream.
   */
  | { kind: 'new'; base: 'default' | 'current' }
  | { kind: 'new'; base: 'worktree'; from: string }
  | { kind: 'new'; base: 'remote'; remoteBranch: string };

export type Problem = { ok: false; problem: string };

/** A repo in an environment: the environment, its path map, and the repo's host folder. */
export interface WorktreeTarget {
  env: Pick<Environment, 'run' | 'runLimited'>;
  mounts: ContainerMount[];
  folder: string;
}

/** What the host-side steps use: the mirrors, and the `gh` to run (tests stub it). */
export interface WorktreeDeps {
  mirror?: MirrorOpts;
  gh?: string;
}

const fail = (problem: string): Problem => ({ ok: false, problem });

/** The first non-empty line of `text`, trimmed, or `''`. */
function firstLine(text: string): string {
  return text.split('\n').map((l) => l.trim()).find((l) => l) ?? '';
}

/** `[major, minor]` out of `git version` output, or null. */
export function parseGitVersion(out: string): [number, number] | null {
  const m = /^git version (\d+)\.(\d+)/.exec(out.trim());
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/** Whether `name` may be a folder under `<repo>.worktrees`. */
export function validWorktreeName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name) &&
    !name.endsWith('.lock');
}

/** The folder name a branch suggests: every `/` becomes `-`. */
export function folderNameFor(branch: string): string {
  return branch.replaceAll('/', '-');
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isDirectory;
  } catch {
    return false;
  }
}

/** Whether a repo card offers **New worktree…**, and why not. */
export interface WorktreesState {
  /** `<folder>.worktrees` when a worktree can be made there from this environment. */
  worktreesFolder: string | null;
  /** Why not, for a primary repo whose `.worktrees` can't be used here; the menu shows it. */
  worktreesProblem: string | null;
}

/**
 * For a primary repo `folder` (its `.git` a directory): `worktreesFolder` when `<folder>.worktrees`
 * is a directory on the host that `mounts` map into the environment beside `folder`, else
 * `worktreesProblem` saying which of those fails, in a create's words. Both null for anything
 * else (a linked worktree, no repo, a repo not mapped): its card offers no New worktree.
 */
export async function worktreesStateOf(
  folder: string,
  mounts: ContainerMount[],
): Promise<WorktreesState> {
  const none = { worktreesFolder: null, worktreesProblem: null };
  const dirs = await resolveRepo(folder);
  if (dirs === null || dirs.gitDir !== dirs.commonDir) return none;
  const at = await layoutOf(folder, dirs, mounts);
  if ('problem' in at) {
    return at.problem === 'unknown repo'
      ? none
      : { worktreesFolder: null, worktreesProblem: at.problem };
  }
  return { worktreesFolder: at.worktreesFolder, worktreesProblem: null };
}

/** {@link worktreesStateOf}'s folder alone. */
export async function worktreesFolderOf(
  folder: string,
  mounts: ContainerMount[],
): Promise<string | null> {
  return (await worktreesStateOf(folder, mounts)).worktreesFolder;
}

/** A primary repo laid out for worktrees: its git dirs and both folders' paths in the environment. */
interface Layout {
  commonDir: string;
  gitDir: string;
  /** The primary's path in the environment. */
  path: string;
  worktreesFolder: string;
  /** `<folder>.worktrees`' path in the environment. */
  worktreesPath: string;
}

/**
 * Checks that `folder` is a primary repo whose `<folder>.worktrees` exists on the host and sits
 * beside it, under the same names, in the environment too (what a relative `gitdir:` needs).
 */
async function primaryLayout(t: WorktreeTarget): Promise<Layout | Problem> {
  const name = basename(t.folder);
  const dirs = await resolveRepo(t.folder);
  if (dirs === null) return fail('unknown repo');
  if (dirs.gitDir !== dirs.commonDir) {
    return fail(`${name} is a worktree: create worktrees from its main repo`);
  }
  return await layoutOf(t.folder, dirs, t.mounts);
}

/** {@link primaryLayout} for a primary repo whose git dirs are known. */
async function layoutOf(
  folder: string,
  dirs: { gitDir: string; commonDir: string },
  mounts: ContainerMount[],
): Promise<Layout | Problem> {
  const name = basename(folder);
  const path = hostToContainerPath(folder, mounts);
  if (path === null) return fail('unknown repo');
  const worktreesFolder = `${folder}.worktrees`;
  if (!await isDir(worktreesFolder)) {
    return fail(`create ${name}.worktrees beside ${name} and mount it here`);
  }
  const worktreesPath = hostToContainerPath(worktreesFolder, mounts);
  if (worktreesPath === null) {
    return fail(`${name}.worktrees is not mounted here`);
  }
  if (
    dirname(path) !== dirname(worktreesPath) || basename(path) !== name ||
    basename(worktreesPath) !== `${name}.worktrees`
  ) {
    return fail(`${name}.worktrees is not beside ${name} in the container`);
  }
  return {
    commonDir: dirs.commonDir,
    gitDir: dirs.gitDir,
    path,
    worktreesFolder,
    worktreesPath,
  };
}

/**
 * Runs `git <args>` in the environment at `cwd`; stdout as text, or why it failed. With
 * `timeoutMs`, under `runLimited` (killed past it).
 */
async function envGit(
  env: Pick<Environment, 'run' | 'runLimited'>,
  cwd: string,
  args: string[],
  timeoutMs?: number,
): Promise<{ out: string } | { failed: string; stderr: string }> {
  const x = { cmd: ['git', ...args], cwd, env: { GIT_TERMINAL_PROMPT: '0' } };
  try {
    if (timeoutMs !== undefined) {
      const r = await env.runLimited(x, { timeoutMs, maxOutput: 64 * 1024 });
      if (r.kind === 'timeout') {
        return { failed: `git ${args[0]}: timed out`, stderr: '' };
      }
      if (r.kind === 'too_large') {
        return { failed: `git ${args[0]}: unexpected output`, stderr: '' };
      }
      if (r.code === 0) return { out: r.stdout };
      const line = firstLine(r.stderr);
      return {
        failed: line ? `git ${args[0]}: ${line}` : `git ${args[0]} failed`,
        stderr: r.stderr,
      };
    }
    const r = await env.run(x);
    if (r.code === 0) return { out: new TextDecoder().decode(r.stdout) };
    const line = firstLine(r.stderr);
    return {
      failed: line ? `git ${args[0]}: ${line}` : `git ${args[0]} failed`,
      stderr: r.stderr,
    };
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    return { failed: `git ${args[0]}: ${m}`, stderr: m };
  }
}

/** The repo's local branches and those checked out in any of its worktrees, read in the environment. */
async function localBranches(
  env: Pick<Environment, 'run' | 'runLimited'>,
  path: string,
): Promise<{ local: string[]; checkedOut: string[] } | Problem> {
  const refs = await envGit(env, path, [
    'for-each-ref',
    '--format=%(refname)',
    'refs/heads/',
  ]);
  if ('failed' in refs) return fail(refs.failed);
  const list = await envGit(env, path, ['worktree', 'list', '--porcelain']);
  if ('failed' in list) return fail(list.failed);
  const strip = (r: string) => r.slice('refs/heads/'.length);
  return {
    local: refs.out.split('\n').filter((r) => r.startsWith('refs/heads/'))
      .map(strip).sort(),
    checkedOut: list.out.split('\n')
      .filter((l) => l.startsWith('branch refs/heads/'))
      .map((l) => strip(l.slice('branch '.length))),
  };
}

/** `git version` in the environment, refused when older than {@link MIN_GIT}. */
async function gitVersionProblem(
  env: Pick<Environment, 'run' | 'runLimited'>,
  path: string,
): Promise<Problem | null> {
  const out = await envGit(env, path, ['version']);
  const v = 'out' in out ? parseGitVersion(out.out) : null;
  if (
    v === null || v[0] < MIN_GIT[0] ||
    (v[0] === MIN_GIT[0] && v[1] < MIN_GIT[1])
  ) {
    return fail(
      `needs git ${MIN_GIT.join('.')} or newer here (found ${
        v ? v.join('.') : 'none'
      })`,
    );
  }
  return null;
}

/** `origin`'s URL when the host may fetch it, else null. */
async function fetchableOrigin(
  commonDir: string,
  opts: MirrorOpts,
): Promise<string | null> {
  const url = await readRemoteUrl(commonDir, 'origin');
  return url !== null && (opts.fetchable ?? isFetchableRemote)(url)
    ? url
    : null;
}

/** The branch `url`'s HEAD names (`git ls-remote --symref`, no repo), or null. */
export async function remoteDefaultBranch(url: string): Promise<string | null> {
  const r = await run(['ls-remote', '--symref', url, 'HEAD'], FETCH_TIMEOUT_MS);
  if ('failed' in r) return null;
  const m = /^ref: refs\/heads\/(.+)\tHEAD$/m.exec(r.out);
  return m ? m[1] : null;
}

/** `url`'s branches (`git ls-remote --heads`, no repo), sorted, at most {@link MAX_REMOTE_BRANCHES}. */
export async function remoteBranchList(
  url: string,
): Promise<{ branches: string[] } | Problem> {
  const r = await run(['ls-remote', '--heads', url], FETCH_TIMEOUT_MS);
  if ('failed' in r) return fail(r.failed);
  const names = r.out.split('\n')
    .map((l) => /^[0-9a-f]+\trefs\/heads\/(.+)$/.exec(l)?.[1])
    .filter((n): n is string => n !== undefined);
  const valid: string[] = [];
  for (const n of names.sort()) {
    if (valid.length >= MAX_REMOTE_BRANCHES) break;
    if (await validBranch(n)) valid.push(n);
  }
  return { branches: valid };
}

/** Runs `gh` on the host with no repo (`cwd: /`); stdout, or the problem text. */
async function runGh(
  gh: string,
  args: string[],
): Promise<{ out: string } | Problem> {
  try {
    const out = await new Deno.Command(gh, {
      args,
      cwd: '/',
      env: { GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' },
      stdin: 'null',
      stdout: 'piped',
      stderr: 'piped',
      signal: AbortSignal.timeout(GH_TIMEOUT_MS),
    }).output();
    if (out.success) return { out: new TextDecoder().decode(out.stdout) };
    const line = firstLine(new TextDecoder().decode(out.stderr));
    return fail(line ? `gh: ${line}` : 'gh failed');
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      return fail('gh not found on this machine');
    }
    return fail(`gh: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Picks the PRs out of `gh pr list --json …` output, dropping any entry of the wrong shape. */
export function parsePrList(out: string): WorktreePr[] {
  let data: unknown;
  try {
    data = JSON.parse(out);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const prs: WorktreePr[] = [];
  for (const e of data) {
    if (typeof e !== 'object' || e === null) continue;
    const p = e as Record<string, unknown>;
    const author = (p.author as { login?: unknown } | null)?.login;
    if (
      typeof p.number !== 'number' || !Number.isInteger(p.number) ||
      p.number < 1 || typeof p.title !== 'string' ||
      typeof p.headRefName !== 'string' ||
      typeof p.isCrossRepository !== 'boolean'
    ) continue;
    prs.push({
      number: p.number,
      title: p.title,
      author: typeof author === 'string' ? author : '',
      headRefName: p.headRefName,
      crossRepository: p.isCrossRepository,
      draft: p.isDraft === true,
    });
    if (prs.length >= MAX_PRS) break;
  }
  return prs;
}

/** `origin`'s open PRs, newest first, or why there are none to show. */
async function openPrs(
  url: string,
  gh: string,
): Promise<{ prs: WorktreePr[] } | Problem> {
  const repo = gitHubRepoOf(url);
  if (repo === null) return fail('origin is not a GitHub repo');
  const out = await runGh(gh, [
    'pr',
    'list',
    '--repo',
    repo,
    '--state',
    'open',
    '--limit',
    String(MAX_PRS),
    '--json',
    'number,title,author,headRefName,isCrossRepository,isDraft',
  ]);
  if ('problem' in out) return out;
  return { prs: parsePrList(out.out) };
}

/** What the New worktree dialog offers for the primary repo `t.folder`. Never throws. */
export async function worktreeOptions(
  t: WorktreeTarget,
  deps: WorktreeDeps = {},
): Promise<({ ok: true } & WorktreeOptions) | Problem> {
  const opts = deps.mirror ?? defaultMirrorOpts();
  const at = await primaryLayout(t);
  if ('problem' in at) return at;
  const url = await fetchableOrigin(at.commonDir, opts);
  const noOrigin = 'origin is not an https or ssh remote';
  const [defaultBranch, remote, prs, local, folders, currentBranch] =
    await Promise.all([
      url === null ? null : remoteDefaultBranch(url),
      url === null ? fail(noOrigin) : remoteBranchList(url),
      url === null ? fail(noOrigin) : openPrs(url, deps.gh ?? 'gh'),
      localBranches(t.env, at.path),
      (async () => {
        const names: string[] = [];
        try {
          for await (const e of Deno.readDir(at.worktreesFolder)) {
            names.push(e.name);
          }
        } catch { /* unreadable: none */ }
        return names.sort();
      })(),
      readBranch(at.gitDir),
    ]);
  if ('problem' in local) return local;
  return {
    ok: true,
    worktreesFolder: at.worktreesFolder,
    defaultBranch,
    currentBranch,
    remoteBranches: 'branches' in remote ? remote.branches : [],
    remoteProblem: 'problem' in remote ? remote.problem : null,
    prs: 'prs' in prs ? prs.prs : [],
    prsProblem: 'problem' in prs ? prs.problem : null,
    localBranches: local.local,
    checkedOut: local.checkedOut,
    folders,
  };
}

/**
 * Run in the primary by `sh -c SCRIPT worktree-add <bundle ref> <commit> <tracking ref> <branch>
 * <path> <mode>`, a bundle on stdin when `<bundle ref>` is non-empty: fetches it (no ref moves),
 * checks the commit is there (exit 4), points `<tracking ref>` at it when one is given, and adds
 * the worktree with relative paths: `existing` checks the branch out as is, `new-at-commit`
 * creates it at the commit.
 */
export const WORKTREE_ADD_SCRIPT = [
  'set -e',
  'if [ -n "$1" ]; then',
  '  tmp=$(mktemp)',
  `  trap 'rm -f "$tmp"' EXIT`,
  '  cat > "$tmp"',
  '  git fetch --quiet --no-tags --no-write-fetch-head --no-recurse-submodules "$tmp" "$1"',
  'fi',
  'git cat-file -e "$2^{commit}" 2>/dev/null || exit 4',
  'if [ -n "$3" ]; then git update-ref "$3" "$2"; fi',
  'case "$6" in',
  '  existing) git worktree add --quiet --relative-paths "$5" "$4" ;;',
  '  new-at-commit) git worktree add --quiet --relative-paths --no-track -b "$4" "$5" "$2" ;;',
  '  *) exit 5 ;;',
  'esac',
].join('\n');

/** The argv that runs {@link WORKTREE_ADD_SCRIPT}. */
export function worktreeAddArgv(a: {
  bundleRef: string;
  commit: string;
  trackingRef: string;
  branch: string;
  path: string;
  mode: 'existing' | 'new-at-commit';
}): string[] {
  return [
    'sh',
    '-c',
    WORKTREE_ADD_SCRIPT,
    'worktree-add',
    a.bundleRef,
    a.commit,
    a.trackingRef,
    a.branch,
    a.path,
    a.mode,
  ];
}

/** Runs `git config --file <file> …` on the host with no repo and no other config. */
async function configFile(file: string, args: string[]) {
  return await new Deno.Command('git', {
    args: ['config', '--file', file, ...args],
    cwd: '/',
    env: {
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CEILING_DIRECTORIES: '/',
    },
    stdin: 'null',
    stdout: 'piped',
    stderr: 'piped',
    signal: AbortSignal.timeout(5000),
  }).output();
}

/** Whether `commonDir`'s config already gives `branch` a `merge`. */
async function hasMerge(commonDir: string, branch: string): Promise<boolean> {
  try {
    const out = await configFile(join(commonDir, 'config'), [
      '--no-includes',
      '--get',
      `branch.${branch}.merge`,
    ]);
    return out.success;
  } catch {
    return false;
  }
}

/**
 * Sets each `[key, value]` in `<commonDir>/config`, **in place**. A container's read-only bind
 * mount of that file follows its inode, and git's own lock + rename would replace it, leaving the
 * container's mount on the old file. So: take git's own `config.lock` (exclusive; given up when it
 * exists), let `git config --file` edit a copy, then write the copy's bytes over the original
 * without a rename. `null` once written, else why not. Never throws.
 */
export async function writeConfigInPlace(
  commonDir: string,
  entries: [string, string][],
): Promise<string | null> {
  const config = join(commonDir, 'config');
  const lock = `${config}.lock`;
  let held: Deno.FsFile;
  try {
    held = await Deno.open(lock, { createNew: true, write: true });
  } catch (e) {
    return e instanceof Deno.errors.AlreadyExists
      ? 'the repo config is locked'
      : `could not lock the repo config: ${
        e instanceof Error ? e.message : String(e)
      }`;
  }
  let tmp: string | null = null;
  try {
    tmp = await Deno.makeTempFile({ prefix: 'devc-worktree-config-' });
    await Deno.writeFile(tmp, await Deno.readFile(config));
    for (const [k, v] of entries) {
      const out = await configFile(tmp, [k, v]);
      if (!out.success) {
        return `git config: ${
          firstLine(new TextDecoder().decode(out.stderr)) || 'failed'
        }`;
      }
    }
    // Truncate and write: the same inode, so a read-only bind mount of it stays on it.
    await Deno.writeFile(config, await Deno.readFile(tmp));
    return null;
  } catch (e) {
    return `could not write the repo config: ${
      e instanceof Error ? e.message : String(e)
    }`;
  } finally {
    held.close();
    await Deno.remove(lock).catch(() => {});
    if (tmp !== null) await Deno.remove(tmp).catch(() => {});
  }
}

/** {@link writeConfigInPlace} of `branch`'s upstream: `origin`'s `remoteBranch`. */
export function writeUpstream(
  commonDir: string,
  branch: string,
  remoteBranch: string,
): Promise<string | null> {
  return writeConfigInPlace(commonDir, [
    [`branch.${branch}.remote`, 'origin'],
    [`branch.${branch}.merge`, `refs/heads/${remoteBranch}`],
  ]);
}

/** A key's value in `commonDir`'s config, read as a file (no includes); null when unset. */
async function configValue(
  commonDir: string,
  key: string,
): Promise<string | null> {
  try {
    const out = await configFile(join(commonDir, 'config'), [
      '--no-includes',
      '--get',
      key,
    ]);
    return out.success ? new TextDecoder().decode(out.stdout).trim() : null;
  } catch {
    return null;
  }
}

/**
 * Turns on what `git worktree add --relative-paths` needs in the repo config before it runs:
 * `core.repositoryformatversion = 1` and `extensions.relativeWorktrees = true`. Git writes them
 * itself on the first relative add, by lock + rename, which a protected container's read-only
 * `.git/config` refuses; once they are set it leaves the config alone. Written by the host, in
 * place ({@link writeConfigInPlace}), and only when missing. A git older than 2.48 refuses a repo
 * with that extension. `null` when set, else why not. Never throws.
 */
export async function enableRelativeWorktrees(
  commonDir: string,
): Promise<string | null> {
  const version = await configValue(commonDir, 'core.repositoryformatversion');
  const ext = await configValue(commonDir, 'extensions.relativeWorktrees');
  if (version === '1' && ext === 'true') return null;
  return await writeConfigInPlace(commonDir, [
    ['core.repositoryformatversion', '1'],
    ['extensions.relativeWorktrees', 'true'],
  ]);
}

/** The worktree change running for each primary folder. */
const busy = new Set<string>();

/** Whether a worktree change is running for primary `folder`. */
export function worktreeBusy(folder: string): boolean {
  return busy.has(folder);
}

/** Runs `f` holding `primary`'s lock, or refuses while another change holds it. */
async function exclusive<T>(
  primary: string,
  f: () => Promise<T | Problem>,
): Promise<T | Problem> {
  if (busy.has(primary)) {
    return fail(
      `a worktree change is already running for ${basename(primary)}`,
    );
  }
  busy.add(primary);
  try {
    return await f();
  } catch (e) {
    return fail(`worktree: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    busy.delete(primary);
  }
}

/** The mirror refs this repo's folders were fetched into: commits the repo has (bundle prerequisites). */
async function prerequisites(
  mirror: string,
  repoFolders: readonly string[],
): Promise<string[]> {
  const out: string[] = [];
  for (const f of repoFolders) {
    const dirs = await resolveRepo(f);
    const branch = dirs ? await readBranch(dirs.gitDir) : null;
    if (branch === null) continue;
    const prefix = `refs/devc/${await hash(`${f}\0${branch}`)}`;
    for (const r of [`${prefix}/local`, `${prefix}/tracking`]) {
      const ok = await run([
        `--git-dir=${mirror}`,
        'rev-parse',
        '-q',
        '--verify',
        r,
      ]);
      if ('out' in ok) out.push(r);
    }
  }
  return out;
}

/**
 * The commit linked worktree `from` (a host folder) has checked out, read by git in the
 * environment: refused unless it is a worktree of the same repo that the environment maps.
 */
async function worktreeHead(
  t: WorktreeTarget,
  at: Layout,
  from: string,
): Promise<{ commit: string } | Problem> {
  const name = basename(from);
  const dirs = await resolveRepo(from);
  if (
    dirs === null || dirs.gitDir === dirs.commonDir ||
    dirs.commonDir !== at.commonDir
  ) {
    return fail(`${name} is not a worktree of ${basename(t.folder)}`);
  }
  const path = hostToContainerPath(from, t.mounts);
  if (path === null) return fail(`${name} is not mounted here`);
  const out = await envGit(t.env, path, [
    'rev-parse',
    '--verify',
    'HEAD^{commit}',
  ]);
  if ('failed' in out) return fail(out.failed);
  const commit = out.out.trim();
  if (!/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(commit)) {
    return fail('git rev-parse: unexpected output');
  }
  return { commit };
}

/** A new worktree's result. */
export interface Created {
  ok: true;
  worktree: string;
  branch: string;
  upstream: string | null;
}

/**
 * Creates `<t.folder>.worktrees/<name>` on `branch` from `source` (see the module header).
 * `repoFolders` are the folders of this repo the environment lists (the primary and its
 * worktrees), whose mirror refs make the bundle smaller. Never throws.
 */
export function createWorktree(
  t: WorktreeTarget,
  req: { name: string; branch: string; source: WorktreeSource },
  repoFolders: readonly string[],
  deps: WorktreeDeps = {},
): Promise<Created | Problem> {
  return exclusive(t.folder, () => createOnce(t, req, repoFolders, deps));
}

async function createOnce(
  t: WorktreeTarget,
  { name, branch, source }: {
    name: string;
    branch: string;
    source: WorktreeSource;
  },
  repoFolders: readonly string[],
  deps: WorktreeDeps,
): Promise<Created | Problem> {
  const opts = deps.mirror ?? defaultMirrorOpts();
  const at = await primaryLayout(t);
  if ('problem' in at) return at;
  const repoName = basename(t.folder);
  if (!validWorktreeName(name)) return fail(`invalid folder name: ${name}`);
  const host = join(at.worktreesFolder, name);
  try {
    await Deno.lstat(host);
    return fail(`${repoName}.worktrees/${name} already exists`);
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) {
      return fail(`${repoName}.worktrees/${name} can't be checked`);
    }
  }
  if (!await validBranch(branch)) return fail(`invalid branch name: ${branch}`);
  if (
    'remoteBranch' in source && !await validBranch(source.remoteBranch)
  ) {
    return fail(`invalid branch name: ${source.remoteBranch}`);
  }
  const old = await gitVersionProblem(t.env, at.path);
  if (old) return old;
  const local = await localBranches(t.env, at.path);
  if ('problem' in local) return local;
  const exists = local.local.includes(branch);
  if (source.kind === 'new' && exists) {
    return fail(`branch ${branch} already exists`);
  }
  if (local.checkedOut.includes(branch)) {
    return fail(`branch ${branch} is checked out in another worktree`);
  }
  const path = `${at.worktreesPath}/${name}`;

  // Where the commit comes from: the remote (through the mirror), or the primary's HEAD.
  let fetchRef: string | null = null;
  /** The remote branch it tracks: `remote` and a same-repo PR. */
  /**
   * The remote branch fetched: its `refs/remotes/origin/<it>` moves to the commit. The new branch
   * takes it as upstream only under its own name (`remote` and a same-repo PR), since Push
   * publishes `origin/<branch>`; under another name it is a new branch with none.
   */
  let tracks: string | null = null;
  /** Branched from a commit the repo has: no remote, no fetch. */
  const inRepo = source.kind === 'new' &&
    (source.base === 'current' || source.base === 'worktree');
  const url = inRepo ? null : await fetchableOrigin(at.commonDir, opts);
  if (url === null && !inRepo) {
    return fail('origin is not an https or ssh remote');
  }
  if (source.kind === 'remote') {
    fetchRef = `refs/heads/${source.remoteBranch}`;
    tracks = source.remoteBranch;
  } else if (source.kind === 'pr') {
    const repo = gitHubRepoOf(url!);
    if (repo === null) return fail('origin is not a GitHub repo');
    const view = await runGh(deps.gh ?? 'gh', [
      'pr',
      'view',
      String(source.number),
      '--repo',
      repo,
      '--json',
      'headRefName,isCrossRepository,state',
    ]);
    if ('problem' in view) return view;
    let pr: Record<string, unknown>;
    try {
      pr = JSON.parse(view.out);
    } catch {
      return fail('gh: unexpected output');
    }
    if (pr?.state !== 'OPEN') {
      return fail(`pull request #${source.number} is not open`);
    }
    fetchRef = `refs/pull/${source.number}/head`;
    if (pr.isCrossRepository === false && typeof pr.headRefName === 'string') {
      if (!await validBranch(pr.headRefName)) {
        return fail(`invalid branch name: ${pr.headRefName}`);
      }
      tracks = pr.headRefName;
    }
  } else if (source.base === 'remote') {
    fetchRef = `refs/heads/${source.remoteBranch}`;
    tracks = source.remoteBranch;
  } else if (source.base === 'default') {
    const def = await remoteDefaultBranch(url!);
    if (def === null || !await validBranch(def)) {
      return fail("could not read origin's default branch");
    }
    fetchRef = `refs/heads/${def}`;
  }

  let commit = 'HEAD';
  if (source.kind === 'new' && source.base === 'worktree') {
    const from = await worktreeHead(t, at, source.from);
    if ('problem' in from) return from;
    commit = from.commit;
  }
  let bundleRef = '';
  let bundle: Uint8Array | undefined;
  if (fetchRef !== null) {
    const mirror = await mirrorFor(opts, url!);
    if (mirror === null) return fail('could not create the git mirror');
    const ref = `refs/devc/worktree/${await hash(
      `${t.folder}\0${branch}`,
    )}/head`;
    const fetched = await run([
      `--git-dir=${mirror}`,
      ...FETCH_FLAGS,
      url!,
      `+${fetchRef}:${ref}`,
    ], FETCH_TIMEOUT_MS);
    if ('failed' in fetched) return fail(fetched.failed);
    const sha = await run([`--git-dir=${mirror}`, 'rev-parse', ref]);
    if ('failed' in sha) return fail(sha.failed);
    commit = sha.out.trim();
    const prereqs = await prerequisites(mirror, repoFolders);
    let has = false;
    for (const p of prereqs) {
      const anc = await run([
        `--git-dir=${mirror}`,
        'merge-base',
        '--is-ancestor',
        ref,
        p,
      ]);
      if ('out' in anc) {
        has = true;
        break;
      }
    }
    // A bundle of nothing is refused by git: the repo already has the commit then.
    if (!has) {
      const b = await runCapped(
        [
          `--git-dir=${mirror}`,
          'bundle',
          'create',
          '--quiet',
          '-',
          ref,
          ...prereqs.map((p) => `^${p}`),
        ],
        MAX_BUNDLE_BYTES,
        2 * 60_000,
      );
      if (b === 'too_large') {
        return fail(
          'worktree fetch too large for devc web: fetch the branch in the project',
        );
      }
      if ('failed' in b) return fail(b.failed);
      bundle = b.out;
      bundleRef = ref;
    }
  }

  const relative = await enableRelativeWorktrees(at.commonDir);
  if (relative !== null) {
    return fail(
      `could not enable relative worktrees in the repo config: ${relative}`,
    );
  }
  const out = await t.env.run({
    cmd: worktreeAddArgv({
      bundleRef,
      commit,
      trackingRef: tracks === null ? '' : `refs/remotes/origin/${tracks}`,
      branch,
      path,
      mode: exists ? 'existing' : 'new-at-commit',
    }),
    cwd: at.path,
    env: { GIT_TERMINAL_PROMPT: '0' },
  }, bundle ?? new Uint8Array());
  if (out.code === 4) {
    return fail(
      'the fetched commit is missing: fetch in the project and retry',
    );
  }
  if (out.code !== 0) {
    const line = firstLine(out.stderr);
    return fail(
      line ? `git worktree add: ${line}` : 'git worktree add failed',
    );
  }

  let upstream: string | null = null;
  if (tracks === branch && source.kind !== 'new') {
    if (await hasMerge(at.commonDir, branch)) {
      upstream = null;
    } else {
      const problem = await writeUpstream(at.commonDir, branch, tracks);
      if (problem === null) upstream = `origin/${tracks}`;
      else console.error(`devc web: worktree ${name}: upstream: ${problem}`);
    }
  }
  if (await resolveRepo(host) === null) {
    return fail(`created ${name}, but its .git does not resolve on the host`);
  }
  return { ok: true, worktree: host, branch, upstream };
}

/** A removal's refusal: `dirty` when only its local changes stopped it. */
export type RemoveProblem = Problem & { dirty: boolean };

/**
 * Removes linked worktree `t.folder` (`git worktree remove`, `--force` with `force`) in the
 * environment, from its primary. The branch stays. A worktree made with absolute paths elsewhere
 * (the host's) is repaired to relative ones once and removed again. Never throws.
 */
export async function removeWorktree(
  t: WorktreeTarget,
  force: boolean,
): Promise<{ ok: true } | RemoveProblem> {
  const name = basename(t.folder);
  const dirs = await resolveRepo(t.folder);
  if (dirs === null) return { ...fail('unknown repo'), dirty: false };
  if (dirs.gitDir === dirs.commonDir) {
    return { ...fail(`${name} is not a linked worktree`), dirty: false };
  }
  const primary = dirname(dirs.commonDir);
  const r = await exclusive<{ ok: true }>(primary, async () => {
    const primaryPath = hostToContainerPath(primary, t.mounts);
    const path = hostToContainerPath(t.folder, t.mounts);
    if (primaryPath === null || path === null) {
      return fail(`${basename(primary)} is not mounted here`);
    }
    const remove = () =>
      envGit(t.env, primaryPath, [
        'worktree',
        'remove',
        ...(force ? ['--force'] : []),
        path,
      ], REMOVE_TIMEOUT_MS);
    let out = await remove();
    if ('failed' in out && out.stderr.includes('is not a working tree')) {
      const repaired = await envGit(t.env, primaryPath, [
        'worktree',
        'repair',
        '--relative-paths',
        path,
      ], REMOVE_TIMEOUT_MS);
      if ('out' in repaired) out = await remove();
    }
    if ('failed' in out) {
      if (out.stderr.includes('contains modified or untracked files')) {
        return { ...fail(`${name} has uncommitted changes`), dirty: true };
      }
      const line = firstLine(out.stderr);
      return fail(
        line ? `git worktree remove: ${line}` : 'git worktree remove failed',
      );
    }
    return { ok: true as const };
  });
  if ('problem' in r) return { dirty: false, ...r };
  return r;
}

/**
 * Why a `worktree_remove` with `force` is refused, or null. A page's code comes from a checkout
 * agents can edit under `--live` (and `--live-yolo`), and a forced removal discards work, so the
 * page role may not force there. The desktop role (the user's clicks in devc-desktop) always may.
 */
export function forceRefusal(
  force: boolean,
  role: 'page' | 'desktop',
  live: boolean,
): string | null {
  return force && role === 'page' && live
    ? 'discarding changes is refused under --live'
    : null;
}
