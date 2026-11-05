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
import { type GitReading, type GitStatus, isGitProblem } from './git_status.ts';
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

/** How a push ended: a failed `gh-push` run carries its exit `code` (3: a content refusal). */
export type PushOutcome =
  | { ok: true; message: string }
  | { ok: false; problem: string; code?: number };

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
      return {
        ok: false,
        problem: bridgeMessage(run.stderr, run.code),
        code: run.code,
      };
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
 * What a repo card's Push does (`RepoView.push`): `now` runs the container's own `gh-push`
 * (escalating a refusal to devc-desktop), `confirm` asks devc-desktop. Or why there is no Push
 * although there is something to push (`pushUnavailable`). Neither when there is nothing to push.
 */
export type PushRoute =
  | { push: 'now' | 'confirm' }
  | { pushUnavailable: string }
  | Record<never, never>;

export const NEEDS_GRANT =
  'needs a gh-push grant (on the host: devc up --bridge-allow gh-push) or devc-desktop';
export const START_TO_PUSH = 'start the container to push';

/**
 * The rules for one repo, in order (see `.plans/devc-web-push-arrow.md`). `line` is the policy
 * line pinning the repo that grants `gh-push` ({@link pushLine}), whatever its branch; `running`
 * whether its container runs; `desktop` whether devc-desktop is connected.
 */
export function pushRoute(
  git: GitStatus | null | undefined,
  line: PolicyLine | null,
  running: boolean,
  desktop: boolean,
): PushRoute {
  if (!git || git.ahead === 0) return {};
  if (git.upstream !== null && git.upstream !== `origin/${git.branch}`) {
    return {
      pushUnavailable:
        `tracks ${git.upstream}; Push publishes origin/${git.branch}`,
    };
  }
  if (line !== null && running && line.branch === git.branch) {
    return { push: 'now' };
  }
  if (desktop) return { push: 'confirm' };
  if (line !== null && !running) return { pushUnavailable: START_TO_PUSH };
  if (line !== null) {
    return {
      pushUnavailable: `${git.branch} is not the pinned branch ${line.branch}`,
    };
  }
  return { pushUnavailable: NEEDS_GRANT };
}

/**
 * Every listed repo's {@link PushRoute}, by folder: a container project's policy read from the
 * host (never the container), a host project's never (it has no grant). Repos with nothing to
 * push are left out.
 */
export async function pushRoutes(
  projects: readonly {
    localFolder: string;
    /** Its policy applies: a container project. */
    container: boolean;
    /** Its container runs. */
    running: boolean;
    folders: readonly string[];
  }[],
  gitOf: (folder: string) => GitReading | undefined,
  read: PolicyReader,
  desktop: boolean,
): Promise<Map<string, PushRoute>> {
  const out = new Map<string, PushRoute>();
  for (const p of projects) {
    const lines = p.container ? await read(p.localFolder) : [];
    for (const folder of p.folders) {
      const g = gitOf(folder);
      const route = pushRoute(
        g && !isGitProblem(g) ? g : null,
        pushLine(lines, folder),
        p.running,
        desktop,
      );
      if (Object.keys(route).length > 0) out.set(folder, route);
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

/** What `push_result` carries for a finished push. */
export type PushAnswer =
  | { ok: true; message: string }
  | { ok: false; problem: string; asked?: true };

/**
 * A push's answer, escalating a `gh-push` exit 3 (a refusal only the user may waive) to a
 * devc-desktop push request through `ask` (`DesktopRequests.add`), when devc-desktop is connected
 * (`ask` non-null). Every other outcome is answered as it is.
 */
export function escalate(
  outcome: PushOutcome,
  ask:
    | (() => { ok: true } | { ok: false; problem: string })
    | null,
): PushAnswer {
  if (outcome.ok) return outcome;
  if (outcome.code !== 3 || ask === null) {
    return { ok: false, problem: outcome.problem };
  }
  const added = ask();
  return added.ok ? { ok: false, problem: outcome.problem, asked: true } : {
    ok: false,
    problem:
      `${outcome.problem}; and devc-desktop could not be asked: ${added.problem}`,
  };
}
