// `devc git push-plan` and `devc git push`: the user's push of a repo's branch, from the host,
// through the same host-owned mirror as an agent's `devc-bridge gh-push` — the one recipe,
// `devc-bridge/builtin/gh-push`, in its user modes.
//
// **The host never runs git in the repo.** Its hooks, `core.fsmonitor`, `core.sshCommand` and
// `insteadOf` rewrites would run as the user. The branch and its remote are read here as files
// (`web/git_repo.ts`); the recipe only fetches *from* the repo into the mirror and does the rest
// there.
//
// The modes are chosen by `DEVC_PUSH_MODE` alone, which only this module sets and the bridge
// strips from every script it runs, so an agent's `devc-bridge gh-push` never reaches them. The
// user's push waives two of the agent's refusals — the default branch and workflow changes, which
// the plan reports so a confirming UI can warn — and pushes the SHA the plan showed, or nothing.
//
// The recipe reads its pinned line from a policy file, as the bridge's would: one is written
// before every run under `~/.cache/devc/push-policy/`, keyed by the repo folder, as
// `web/pr_host.ts` writes its own under `web-pr-policy/`.

import { createHash } from 'node:crypto';
import { dirname, fromFileUrl, join, resolve } from 'jsr:@std/path';
import {
  isGitHubRemote,
  parseOriginUrl,
  type PolicyLine,
  serializePolicy,
  targetProblem,
} from '@devc-tools/core/bridge.ts';
import { readBranch, readUpstream, resolveRepo } from './web/git_repo.ts';

/** `devc git`'s subcommands, parsed. */
export type GitArgs =
  | { command: 'push-plan'; folder: string }
  | { command: 'push'; folder: string; sha: string };

const GIT_USAGE = 'usage: devc git push-plan <folder> | ' +
  'devc git push <folder> --sha <sha>';

/** `devc git`'s arguments. Throws on anything else. */
export function parseGitArgs(args: string[]): GitArgs {
  const [command, ...rest] = args;
  if (command !== 'push-plan' && command !== 'push') {
    throw new Error(
      command === undefined
        ? GIT_USAGE
        : `unknown git command '${command}' — ${GIT_USAGE}`,
    );
  }
  let folder: string | undefined;
  let sha: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (command === 'push' && (arg === '--sha' || arg.startsWith('--sha='))) {
      if (sha !== undefined) throw new Error('--sha given twice');
      sha = arg === '--sha' ? rest[++i] : arg.slice('--sha='.length);
      if (sha === undefined || sha === '') {
        throw new Error('--sha needs a value');
      }
    } else if (arg.startsWith('-')) {
      throw new Error(`unknown argument '${arg}'`);
    } else if (folder === undefined) folder = arg;
    else throw new Error(`unexpected argument '${arg}'`);
  }
  if (folder === undefined) throw new Error(GIT_USAGE);
  if (command === 'push-plan') return { command, folder };
  if (sha === undefined) throw new Error('push needs --sha <sha>');
  // The full SHA a plan printed: a prefix, or a branch name, could name something else by now.
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(sha)) {
    throw new Error(`--sha wants the full commit SHA push-plan printed`);
  }
  return { command, folder, sha };
}

/** What `devc git push-plan` prints: what a push would send, and what it would warn about. */
export type PushPlan =
  | {
    ok: true;
    /** The repo folder as given, realpath'd. */
    folder: string;
    /** The remote's URL, as the repo's config names it. */
    remote: string;
    branch: string;
    /** The branch tip, fetched from the repo into the mirror: what `push --sha` must name. */
    sha: string;
    /** The remote branch's tip; null when it does not exist yet. */
    remoteSha: string | null;
    /** Newest first, at most 50. The subject and author are the repo's text: show them as text. */
    commits: { sha: string; subject: string; author: string }[];
    totalCommits: number;
    /** The remote's default branch: allowed, warn. */
    defaultBranch: boolean;
    /** Changed paths under `.github/workflows` or `.github/actions`: allowed, warn. */
    guarded: string[];
    /** Adds a Git LFS pointer: refused at push time. */
    lfs: boolean;
    /** False: refused at push time (never forced). */
    fastForward: boolean;
    upToDate: boolean;
  }
  | { ok: false; problem: string };

/** The most commits a plan lists. */
const MAX_PLAN_COMMITS = 50;

const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/** `text` (the recipe's stdout) as a {@link PushPlan}, or null when it is not one. */
export function parsePushPlan(text: string): PushPlan | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null) return null;
  const p = v as Record<string, unknown>;
  const str = (x: unknown): x is string => typeof x === 'string';
  const bool = (x: unknown): x is boolean => typeof x === 'boolean';
  const commits = p.commits;
  if (
    p.ok !== true || !str(p.folder) || !str(p.remote) || !str(p.branch) ||
    !str(p.sha) || !SHA.test(p.sha) ||
    !(p.remoteSha === null || (str(p.remoteSha) && SHA.test(p.remoteSha))) ||
    !Array.isArray(commits) || commits.length > MAX_PLAN_COMMITS ||
    !commits.every((c) =>
      typeof c === 'object' && c !== null && str(c.sha) && SHA.test(c.sha) &&
      str(c.subject) && str(c.author)
    ) ||
    !Number.isSafeInteger(p.totalCommits) ||
    (p.totalCommits as number) < commits.length ||
    !bool(p.defaultBranch) || !Array.isArray(p.guarded) ||
    !p.guarded.every(str) || !bool(p.lfs) || !bool(p.fastForward) ||
    !bool(p.upToDate)
  ) return null;
  return {
    ok: true,
    folder: p.folder,
    remote: p.remote,
    branch: p.branch,
    sha: p.sha,
    remoteSha: p.remoteSha as string | null,
    commits: commits.map((c) => ({
      sha: c.sha,
      subject: c.subject,
      author: c.author,
    })),
    totalCommits: p.totalCommits as number,
    defaultBranch: p.defaultBranch,
    guarded: [...p.guarded],
    lfs: p.lfs,
    fastForward: p.fastForward,
    upToDate: p.upToDate,
  };
}

/** The policy key for repo folder `root`: `push-` and 16 hex chars of its SHA-256. */
export function pushKey(root: string): string {
  return `push-${
    createHash('sha256').update(root, 'utf8').digest('hex').slice(0, 16)
  }`;
}

/** Where the synthesized policies go, under `home`: apart from the bridge's and devc web's. */
export function pushPolicyDir(home: string): string {
  return `${home}/.cache/devc/push-policy`;
}

/**
 * The policy line for repo folder `folder` (realpath'd: its repo and target), or why there is
 * none. The branch is the one checked out; the remote is its upstream's, or `origin`'s when it
 * tracks nothing yet. A branch that tracks one of another name is refused: the push publishes the
 * branch under its own name.
 */
export async function pushPin(
  folder: string,
): Promise<{ problem: string } | { line: PolicyLine }> {
  let root: string;
  try {
    root = await Deno.realPath(resolve(folder));
  } catch {
    return { problem: `${folder} does not exist` };
  }
  const dirs = await resolveRepo(root);
  if (dirs === null) {
    return { problem: `${root} is not a git repo, or its .git is not honest` };
  }
  const branch = await readBranch(dirs.gitDir);
  if (branch === null) {
    return { problem: `HEAD is detached in ${root} — check out the branch` };
  }
  const upstream = await readUpstream(dirs.commonDir, branch);
  let remote: string;
  if (upstream !== null) {
    if (upstream.branch !== branch) {
      return {
        problem:
          `${branch} tracks ${upstream.branch} on ${upstream.remote} — devc git pushes a branch under its own name`,
      };
    }
    remote = upstream.url;
  } else {
    let config: string;
    try {
      config = await Deno.readTextFile(join(dirs.commonDir, 'config'));
    } catch {
      return { problem: `cannot read ${join(dirs.commonDir, 'config')}` };
    }
    const origin = parseOriginUrl(config);
    if (!origin.ok) return { problem: origin.reason };
    remote = origin.url;
  }
  if (!isGitHubRemote(remote)) {
    return { problem: `${remote} is not a GitHub remote — only github.com` };
  }
  const target = targetProblem(root);
  if (target !== null) return { problem: `${root}: ${target}` };
  return {
    line: { repo: root, remote, branch, grants: ['gh-push'], target: root },
  };
}

/** Writes `text` to `path` (`0600`) through a temp file renamed over it. */
async function writePrivate(path: string, text: string): Promise<void> {
  const dir = dirname(path);
  await Deno.mkdir(dir, { recursive: true, mode: 0o700 });
  await Deno.chmod(dir, 0o700);
  const tmp = await Deno.makeTempFile({ dir, prefix: '.policy-' });
  try {
    await Deno.chmod(tmp, 0o600);
    await Deno.writeTextFile(tmp, text);
    await Deno.rename(tmp, path);
  } catch (e) {
    await Deno.remove(tmp).catch(() => {});
    throw e;
  }
}

/** The recipe embedded beside this module (a checkout's, or the binary's `--include`). */
const EMBEDDED_RECIPE = new URL(
  '../devc-bridge/builtin/gh-push',
  import.meta.url,
);

/**
 * The recipe's path: a checkout's own; in the compiled binary, a copy written to
 * `~/.cache/devc/push-builtin/gh-push` (`0755`, renamed in) on every run, since `bash` cannot
 * exec a file `deno compile` embedded.
 */
async function recipePath(home: string): Promise<string> {
  if (!Deno.build.standalone) return fromFileUrl(EMBEDDED_RECIPE);
  const dir = `${home}/.cache/devc/push-builtin`;
  await Deno.mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = await Deno.makeTempFile({ dir, prefix: '.gh-push-' });
  try {
    await Deno.writeFile(tmp, await Deno.readFile(EMBEDDED_RECIPE));
    await Deno.chmod(tmp, 0o755);
    const path = join(dir, 'gh-push');
    await Deno.rename(tmp, path);
    return path;
  } catch (e) {
    await Deno.remove(tmp).catch(() => {});
    throw e;
  }
}

/** Where a run's files go, and what it adds to the recipe's environment. For tests. */
export interface PushOptions {
  home?: string;
  /** The recipe to run instead of the embedded one. */
  recipe?: string;
  /** Added to the recipe's environment (a test's `PATH` with stub `git` and `gh`). */
  env?: Record<string, string>;
}

function homeOf(opts: PushOptions): string {
  const home = opts.home ?? Deno.env.get('HOME');
  if (!home) throw new Error('HOME is not set');
  return home;
}

/** The recipe's command for `line` in `mode`, after writing its policy. */
async function recipeCommand(
  line: PolicyLine,
  mode: 'plan' | 'user',
  args: string[],
  opts: PushOptions,
  io: 'piped' | 'inherit',
): Promise<Deno.Command> {
  const home = homeOf(opts);
  const policyDir = pushPolicyDir(home);
  const key = pushKey(line.target);
  await writePrivate(
    `${policyDir}/${key}.conf`,
    serializePolicy({ repos: [line] }),
  );
  return new Deno.Command(opts.recipe ?? await recipePath(home), {
    args: ['--repo', line.target, ...args],
    cwd: '/',
    env: {
      ...opts.env,
      DEVC_PUSH_MODE: mode,
      DEVC_BRIDGE_KEY: key,
      DEVC_BRIDGE_POLICY_DIR: policyDir,
    },
    stdin: 'null',
    stdout: io,
    stderr: io,
  });
}

/** The recipe's last stderr line, without its `gh-push: ` prefix. */
function problemOf(stderr: string, code: number): string {
  const last = stderr.trim().split('\n').at(-1)?.trim() ?? '';
  return last.replace(/^gh-push: /, '') || `gh-push exited ${code}`;
}

/** `devc git push-plan <folder>`: see {@link PushPlan}. Never throws. */
export async function pushPlan(
  folder: string,
  opts: PushOptions = {},
): Promise<PushPlan> {
  try {
    const pin = await pushPin(folder);
    if ('problem' in pin) return { ok: false, problem: pin.problem };
    const out = await (await recipeCommand(pin.line, 'plan', [], opts, 'piped'))
      .output();
    const decoder = new TextDecoder();
    if (out.code !== 0) {
      return {
        ok: false,
        problem: problemOf(decoder.decode(out.stderr), out.code),
      };
    }
    return parsePushPlan(decoder.decode(out.stdout)) ??
      { ok: false, problem: 'gh-push printed something that is not a plan' };
  } catch (e) {
    return { ok: false, problem: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * `devc git push <folder> --sha <sha>`: the recipe's own output and exit code (0 pushed or up to
 * date, 2 the branch moved or another argument/pin problem, 3 an LFS pointer, 4 not a
 * fast-forward or a transport failure). A pin problem is printed here, with exit 2.
 */
export async function gitPush(
  folder: string,
  sha: string,
  opts: PushOptions = {},
): Promise<number> {
  const pin = await pushPin(folder);
  if ('problem' in pin) {
    console.error(`devc: ${pin.problem}`);
    return 2;
  }
  const cmd = await recipeCommand(
    pin.line,
    'user',
    ['--sha', sha],
    opts,
    'inherit',
  );
  return (await cmd.spawn().status).code;
}
