// `devc web`'s **Push** (`push_repo`): a container's pinned branch, published under the
// container's own `gh-push` grant, with no confirmation. See `.plans/devc-web-granted-push.md`.
//
// It runs `devc-bridge gh-push --repo <target>` **in the container** (its `PrBackend.run`, as
// `pr_review.ts` runs `gh-pr-*`), so the page gains no reach: it can already type into a terminal
// there, and the agent can already run the same command. The bridge applies the grant and every
// agent-mode refusal (the default branch, workflow and action changes, LFS pointers, a
// non-fast-forward); the pushed object is the SHA it inspected.
//
// **The grant is read from the host-only policy (`readPolicy`, keyed by `projectKey`), never from
// the container**, and only read: devc web never writes a policy. A user push (the default branch,
// workflow changes) stays devc-desktop's **Push…**, confirmed in its HOST drawer.
//
// The output comes back through the container (it could shadow `devc-bridge` on its `PATH`), so
// it is untrusted: one line, capped, shown as text.

import type { PolicyLine } from '@devc-tools/core/bridge.ts';
import { projectKey } from '@devc-tools/core/merged_config.ts';
import { readPolicy } from '../bridge.ts';
import type { EnvironmentKind, PrBackend } from './environment.ts';
import { type GitReading, isGitProblem } from './git_status.ts';
import { bridgeMessage } from './pr_review.ts';

/** How long one `gh-push` may run: several network steps, each up to 300 s by default. */
export const PUSH_TIMEOUT_MS = 900_000;
/** The most output one `gh-push` may write. */
export const PUSH_MAX_OUTPUT = 65_536;
/** The longest `message` a successful push answers with. */
const MAX_LINE = 300;

export const NOT_GRANTED =
  'not granted: on the host, devc up --bridge-allow gh-push';
export const HOST_PROJECT =
  'push from a project on this machine: use Push… (devc-desktop)';
export const STATUS_UNKNOWN = 'git status unknown: try again soon';
export const PUSHED_MOMENTS_AGO = 'pushed moments ago: try again soon';
export const PUSH_TIMED_OUT = 'devc-bridge gh-push timed out';
export const PUSH_TOO_LARGE = 'bridge output too large';

/** How a push ended. */
export type PushOutcome =
  | { ok: true; message: string }
  | { ok: false; problem: string };

const dropSlash = (p: string) => p.length > 1 ? p.replace(/\/+$/, '') : p;

/** Reads a project's policy; injectable for tests. */
export type PolicyReader = (
  localFolder: string,
) => Promise<readonly PolicyLine[]>;

/**
 * The project's policy lines from `~/.config/devc-bridge/policy/<key>.conf` under `home`: none
 * when it is absent, malformed or unreadable. Never throws.
 */
export function policyReader(home: string): PolicyReader {
  return async (localFolder) => {
    try {
      const state = await readPolicy(await projectKey(localFolder), { home });
      return state.kind === 'present' ? state.record.repos : [];
    } catch {
      return [];
    }
  };
}

/** The line pinning `folder` that grants `gh-push`, or null. Each line's own grants decide. */
export function pushLine(
  lines: readonly PolicyLine[],
  folder: string,
): PolicyLine | null {
  const line = lines.find((l) => dropSlash(l.repo) === dropSlash(folder));
  return line !== undefined && line.grants.includes('gh-push') ? line : null;
}

/** The push running for each folder: a second request shares it. */
const pushing = new Map<string, Promise<PushOutcome>>();

/** Whether a push of `folder` is running. */
export function pushRunning(folder: string): boolean {
  return pushing.has(folder);
}

/**
 * Runs `devc-bridge gh-push --repo <target>` through `pr` (the container's backend). One push per
 * folder at a time: a call while one runs gets its outcome. Never throws.
 */
export function grantedPush(
  pr: Pick<PrBackend, 'run'>,
  folder: string,
  target: string,
): Promise<PushOutcome> {
  const current = pushing.get(folder);
  if (current) return current;
  const p = pushOnce(pr, target).finally(() => pushing.delete(folder));
  pushing.set(folder, p);
  return p;
}

async function pushOnce(
  pr: Pick<PrBackend, 'run'>,
  target: string,
): Promise<PushOutcome> {
  try {
    const run = await pr.run('gh-push', target, [], {
      timeoutMs: PUSH_TIMEOUT_MS,
      maxOutput: PUSH_MAX_OUTPUT,
    });
    if (run.kind === 'timeout') return { ok: false, problem: PUSH_TIMED_OUT };
    if (run.kind === 'too_large') return { ok: false, problem: PUSH_TOO_LARGE };
    if (run.code !== 0) {
      return { ok: false, problem: bridgeMessage(run.stderr, run.code) };
    }
    const lines = run.stdout.split('\n').map((l) => l.trim()).filter((l) => l);
    return {
      ok: true,
      message: (lines[lines.length - 1] ?? 'pushed').slice(0, MAX_LINE),
    };
  } catch (e) {
    return { ok: false, problem: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Which listed repo folders get **Push**: a running container project's repo whose policy line
 * grants `gh-push` and pins the branch checked out (`branchOf`, from the git watch). Absent
 * folders get no Push.
 */
export async function pushGrants(
  projects: readonly {
    localFolder: string;
    folders: readonly string[];
  }[],
  branchOf: (folder: string) => string | null,
  read: PolicyReader,
): Promise<Set<string>> {
  const out = new Set<string>();
  for (const p of projects) {
    const lines = await read(p.localFolder);
    if (lines.length === 0) continue;
    for (const folder of p.folders) {
      const line = pushLine(lines, folder);
      if (line !== null && branchOf(folder) === line.branch) out.add(folder);
    }
  }
  return out;
}

/** What {@link pushRepo} reads: the server's state, injectable for tests. */
export interface PushRepoDeps {
  /** The repo's running environment (`repoTarget`), or why there is none. */
  target: () => Promise<
    | { env: { kind: EnvironmentKind; pr: Pick<PrBackend, 'run'> } }
    | { problem: string }
  >;
  read: PolicyReader;
  /** The git watch's last reading of the folder. */
  status: (folder: string) => GitReading | undefined;
  /** The rate limit: whether a new push of `folder` may start now (and records it when it may). */
  startAllowed: (folder: string) => boolean;
}

/**
 * `push_repo`: every check from the host's own state, in order (the first failing one answers),
 * then {@link grantedPush}. The policy is read again here, never taken from the page or a cache.
 */
export async function pushRepo(
  msg: { localFolder: string; folder: string },
  deps: PushRepoDeps,
): Promise<PushOutcome> {
  const at = await deps.target();
  if ('problem' in at) return { ok: false, problem: at.problem };
  if (at.env.kind !== 'container') return { ok: false, problem: HOST_PROJECT };
  const line = pushLine(await deps.read(msg.localFolder), msg.folder);
  if (line === null) return { ok: false, problem: NOT_GRANTED };
  const status = deps.status(msg.folder);
  if (!status || isGitProblem(status)) {
    return { ok: false, problem: STATUS_UNKNOWN };
  }
  if (status.branch !== line.branch) {
    return {
      ok: false,
      problem:
        `${status.branch} is not the pinned branch ${line.branch}: use Push… (devc-desktop)`,
    };
  }
  if (!pushRunning(msg.folder) && !deps.startAllowed(msg.folder)) {
    return { ok: false, problem: PUSHED_MOMENTS_AGO };
  }
  return await grantedPush(at.env.pr, msg.folder, line.target);
}
