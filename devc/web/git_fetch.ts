// Fetch for the `devc web` sidebar: moves a repo's own `refs/remotes/<remote>/<branch>` to what
// its remote has now, on the page's request (the repo card's **Fetch**, a click on its ↓ mark).
//
// The host never runs git in the repo (see `git_status.ts`'s header): its hooks,
// `core.fsmonitor` or `core.sshCommand` would run as the host user. So the host fetches the remote
// into its own bare mirror (`fetchUpstreamProblem`, the host's credentials), writes a bundle of
// just that branch from the mirror (`upstreamBundle`), and the repo's own git fetches from the
// bundle **in the project's environment** (`Environment.run` with the bundle on stdin: a
// container's git under `docker exec`, a host project's directly). Nothing is mounted or written
// into the repo by the host. It is not `git pull`: no merge, no working-tree change. See
// `.plans/devc-web-git-fetch.md`.
//
// Pull (`pullRepo`) is a Fetch, then `git merge --ff-only` of the checked-out branch to its
// remote-tracking ref, also in the project's environment: never a merge commit, rebase or stash.

import type { Environment } from './environment.ts';
import { readBranch, readUpstream, resolveRepo } from './git_repo.ts';
import {
  defaultMirrorOpts,
  fetchUpstreamProblem,
  isGitProblem,
  type MirrorOpts,
  upstreamBundle,
} from './git_status.ts';

/** How a fetch ended. */
export type FetchOutcome =
  | { ok: true; updated: boolean } // updated: the remote-tracking ref moved
  | { ok: false; problem: string };

/**
 * Run in the repo by `sh -c SCRIPT fetch <remote> <branch> <bundle ref>`, the bundle on stdin:
 * writes it to a temp file, fetches its ref into `refs/remotes/<remote>/<branch>`, removes the
 * file, and prints the ref's commit before and after (empty when it had none).
 */
export const FETCH_SCRIPT = [
  'set -e',
  'tmp=$(mktemp)',
  `trap 'rm -f "$tmp"' EXIT`,
  'cat > "$tmp"',
  'ref="refs/remotes/$1/$2"',
  'old=$(git rev-parse -q --verify "$ref" || true)',
  'git fetch --quiet --no-tags --no-write-fetch-head --no-recurse-submodules "$tmp" "+$3:$ref"',
  'new=$(git rev-parse -q --verify "$ref" || true)',
  `printf '%s %s\\n' "$old" "$new"`,
].join('\n');

/** The argv that runs {@link FETCH_SCRIPT}. */
export function fetchArgv(remote: string, branch: string, ref: string) {
  return ['sh', '-c', FETCH_SCRIPT, 'fetch', remote, branch, ref];
}

/** How a pull ended. */
export type PullOutcome =
  | { ok: true; updated: boolean } // updated: HEAD moved
  | { ok: false; problem: string };

/**
 * Run in the repo by `sh -c SCRIPT pull <remote> <upstream branch> <local branch>`: fast-forwards
 * the checked-out branch to `refs/remotes/<remote>/<upstream branch>`, and prints HEAD before and
 * after. Exits 3 when the local branch is no longer the one checked out.
 */
export const PULL_SCRIPT = [
  'set -e',
  '[ "$(git symbolic-ref -q HEAD || true)" = "refs/heads/$3" ] || exit 3',
  'old=$(git rev-parse HEAD)',
  'git merge --ff-only --quiet "refs/remotes/$1/$2"',
  'new=$(git rev-parse HEAD)',
  `printf '%s %s\\n' "$old" "$new"`,
].join('\n');

/** The argv that runs {@link PULL_SCRIPT}. */
export function pullArgv(remote: string, branch: string, local: string) {
  return ['sh', '-c', PULL_SCRIPT, 'pull', remote, branch, local];
}

/** How long a pull's merge may take: a checkout of many files can pass `run`'s 15 s. */
const PULL_TIMEOUT_MS = 120_000;

/** Whether `name` may go into argv as a remote's name: letters, digits, `.`, `_`, `-`, not option-like. */
export function validRemote(name: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(name) && !name.startsWith('-') &&
    name !== '.' && name !== '..';
}

/**
 * Whether `name` may go into argv as a branch: `git check-ref-format --branch` accepts it, run
 * on the host with no repo (`cwd: /`, so it reads no repo's config). Never throws.
 */
export async function validBranch(name: string): Promise<boolean> {
  if (name === '' || name.startsWith('-')) return false;
  try {
    const out = await new Deno.Command('git', {
      args: ['check-ref-format', '--branch', name],
      cwd: '/',
      env: { GIT_CEILING_DIRECTORIES: '/' },
      stdin: 'null',
      stdout: 'piped',
      stderr: 'null',
      signal: AbortSignal.timeout(5000),
    }).output();
    return out.success &&
      new TextDecoder().decode(out.stdout).trim() === name;
  } catch {
    return false;
  }
}

/** The fetch running for each folder: a second request shares it. */
const running = new Map<string, Promise<FetchOutcome>>();

/** Whether a fetch of `folder` is running. */
export function fetchRunning(folder: string): boolean {
  return running.has(folder);
}

/**
 * Fetches `folder`'s upstream branch into its own remote-tracking ref: the remote into the mirror
 * on the host, then from a bundle by the repo's git in `env`, at `path` (the repo's path there).
 * One fetch per folder at a time: a call while one runs gets its outcome. Never throws.
 */
export function fetchRepo(
  env: Pick<Environment, 'run'>,
  folder: string,
  path: string,
  opts: MirrorOpts = defaultMirrorOpts(),
): Promise<FetchOutcome> {
  const current = running.get(folder);
  if (current) return current;
  const p = fetchOnce(env, folder, path, opts).finally(() =>
    running.delete(folder)
  );
  running.set(folder, p);
  return p;
}

async function fetchOnce(
  env: Pick<Environment, 'run'>,
  folder: string,
  path: string,
  opts: MirrorOpts,
): Promise<FetchOutcome> {
  try {
    const fetched = await fetchUpstreamProblem(folder, opts);
    if (fetched !== null) return { ok: false, problem: fetched.problem };
    const b = await upstreamBundle(folder, opts);
    if (isGitProblem(b)) return { ok: false, problem: b.problem };
    if (!validRemote(b.remote)) {
      return { ok: false, problem: `unusable remote name: ${b.remote}` };
    }
    if (!await validBranch(b.branch)) {
      return { ok: false, problem: `unusable branch name: ${b.branch}` };
    }
    if ('upToDate' in b) return { ok: true, updated: false };
    const out = await env.run({
      cmd: fetchArgv(b.remote, b.branch, b.ref),
      cwd: path,
      env: { GIT_TERMINAL_PROMPT: '0' },
    }, b.bundle);
    if (out.code !== 0) {
      const line = out.stderr.split('\n').map((l) => l.trim()).find((l) => l);
      return {
        ok: false,
        problem: line ? `git fetch: ${line}` : 'git fetch failed',
      };
    }
    const [before = '', after = ''] = new TextDecoder().decode(out.stdout)
      .replace(/\n$/, '').split(' ');
    return { ok: true, updated: before !== after };
  } catch (e) {
    return {
      ok: false,
      problem: `fetch: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/** The pull running for each folder: a second request shares it. */
const pulling = new Map<string, Promise<PullOutcome>>();

/** Whether a pull of `folder` is running. */
export function pullRunning(folder: string): boolean {
  return pulling.has(folder);
}

/**
 * Fetches `folder` ({@link fetchRepo}), then fast-forwards its checked-out branch to the fetched
 * ref in `env`, at `path`. One pull per folder at a time: a call while one runs gets its outcome.
 * Uncommitted changes stay; git refuses a fast-forward that would overwrite one. Never throws.
 */
export function pullRepo(
  env: Pick<Environment, 'run' | 'runLimited'>,
  folder: string,
  path: string,
  opts: MirrorOpts = defaultMirrorOpts(),
): Promise<PullOutcome> {
  const current = pulling.get(folder);
  if (current) return current;
  const p = pullOnce(env, folder, path, opts).finally(() =>
    pulling.delete(folder)
  );
  pulling.set(folder, p);
  return p;
}

async function pullOnce(
  env: Pick<Environment, 'run' | 'runLimited'>,
  folder: string,
  path: string,
  opts: MirrorOpts,
): Promise<PullOutcome> {
  try {
    const fetched = await fetchRepo(env, folder, path, opts);
    if (!fetched.ok) return fetched;
    const dirs = await resolveRepo(folder);
    if (dirs === null) return { ok: false, problem: 'not a git repo' };
    const local = await readBranch(dirs.gitDir);
    if (local === null) return { ok: false, problem: 'detached HEAD' };
    const upstream = await readUpstream(dirs.commonDir, local);
    if (upstream === null) {
      return { ok: false, problem: `${local} has no upstream` };
    }
    if (upstream.trackingRef === null) {
      return { ok: false, problem: `${local} tracks a URL, not a remote` };
    }
    if (!validRemote(upstream.remote)) {
      return { ok: false, problem: `unusable remote name: ${upstream.remote}` };
    }
    for (const b of [upstream.branch, local]) {
      if (!await validBranch(b)) {
        return { ok: false, problem: `unusable branch name: ${b}` };
      }
    }
    const out = await env.runLimited({
      cmd: pullArgv(upstream.remote, upstream.branch, local),
      cwd: path,
      env: { GIT_TERMINAL_PROMPT: '0', GIT_MERGE_AUTOEDIT: 'no' },
    }, { timeoutMs: PULL_TIMEOUT_MS, maxOutput: 4096 });
    if (out.kind === 'timeout') {
      return { ok: false, problem: 'git merge: timed out' };
    }
    if (out.kind === 'too_large') {
      return { ok: false, problem: 'git merge: unexpected output' };
    }
    if (out.code === 3) {
      return { ok: false, problem: 'the branch changed: try again' };
    }
    if (out.code !== 0) {
      const line = out.stderr.split('\n').map((l) => l.trim()).find((l) => l);
      return {
        ok: false,
        problem: line ? `git merge: ${line}` : 'git merge failed',
      };
    }
    const [before = '', after = ''] = out.stdout.replace(/\n$/, '').split(' ');
    return { ok: true, updated: before !== after };
  } catch (e) {
    return {
      ok: false,
      problem: `pull: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
