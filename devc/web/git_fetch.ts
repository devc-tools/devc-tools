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

import type { Environment } from './environment.ts';
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
