// Staging, unstaging and committing a repo's changes from the `devc web` repo card's Uncommitted
// row. Like `git_uncommitted.ts`, git runs **in the project's environment**
// (`Environment.runLimited`): a container's own git under `docker exec`, a host project's directly,
// never the host's git in a container's repo. These write the index (and a commit), so they run
// without `--no-optional-locks`, with nothing that may wait on a terminal or an editor. A path from
// the page is never passed to git as sent: it is found in a fresh listing first.
// See `.plans/devc-web-stage-commit.md`.

import { type GitProblem, isGitProblem } from './git_status.ts';
import type { Listed } from './git_commit.ts';
import {
  git,
  listSplit,
  noChanges,
  type UncommittedEnv,
} from './git_uncommitted.ts';

/** How long a stage or unstage may take. */
const STAGE_TIMEOUT_MS = 30_000;
/** How long a commit may take: the repo's hooks run. */
export const COMMIT_TIMEOUT_MS = 120_000;
const COMMIT_MAX_OUTPUT = 1024 * 1024;
/** The most a commit's failure keeps of git's output, from its end. */
const COMMIT_PROBLEM_MAX = 4096;
const COMMIT_PROBLEM_LINES = 20;

export interface Committed {
  sha: string;
  subject: string;
}

/**
 * The paths' entries in `list`, or the first path missing from it. `null` is everything (no
 * check: git takes `:/`).
 */
function pick(
  list: Listed[],
  paths: string[],
  stage: 'staged' | 'unstaged',
): Listed[] | GitProblem {
  const byPath = new Map(list.map((f) => [f.path, f]));
  const out: Listed[] = [];
  for (const p of paths) {
    const f = byPath.get(p);
    if (f === undefined) return { problem: noChanges(p, stage) };
    out.push(f);
  }
  return out;
}

/** Runs a stage or unstage command; `{}` when it worked. */
async function run(
  env: UncommittedEnv,
  cwd: string,
  args: string[],
): Promise<Record<never, never> | GitProblem> {
  const r = await git(env, cwd, args, {
    maxOutput: 1024 * 1024,
    timeoutMs: STAGE_TIMEOUT_MS,
    write: true,
    tooLarge: `git ${args[0]}: too much output`,
  });
  if (r === 'too_large') return { problem: `git ${args[0]} failed` };
  if (isGitProblem(r)) return r;
  return {};
}

/**
 * Stages `paths` (each in the working tree's unstaged list: edits, new files, removals, and a
 * conflict, which this marks resolved), or everything for `null`. Never throws.
 */
export async function stageFiles(
  env: UncommittedEnv,
  cwd: string,
  paths: string[] | null,
): Promise<Record<never, never> | GitProblem> {
  if (paths === null) return await run(env, cwd, ['add', '-A', '--', ':/']);
  const listed = await listSplit(env, cwd);
  if (isGitProblem(listed)) return listed;
  const files = pick(listed.unstaged, paths, 'unstaged');
  if (isGitProblem(files)) return files;
  return await run(env, cwd, [
    'add',
    '-A',
    '--',
    ...files.map((f) => `:(literal)${f.path}`),
  ]);
}

/**
 * Unstages `paths` (each in the staged list; a rename takes its old path with it), or everything
 * for `null`. Works on an unborn branch. Never throws.
 */
export async function unstageFiles(
  env: UncommittedEnv,
  cwd: string,
  paths: string[] | null,
): Promise<Record<never, never> | GitProblem> {
  if (paths === null) return await run(env, cwd, ['reset', '-q', '--', ':/']);
  const listed = await listSplit(env, cwd);
  if (isGitProblem(listed)) return listed;
  const files = pick(listed.staged, paths, 'staged');
  if (isGitProblem(files)) return files;
  const specs = files.flatMap((f) =>
    f.status === 'renamed' && f.previousPath !== null
      ? [`:(literal)${f.previousPath}`, `:(literal)${f.path}`]
      : [`:(literal)${f.path}`]
  );
  return await run(env, cwd, ['reset', '-q', '--', ...specs]);
}

/** A commit's failure: the end of what git and its hooks printed, where the reason is. */
export function commitProblem(stderr: string, stdout: string): string {
  const lines = `${stderr}\n${stdout}`.split('\n').map((l) => l.trimEnd())
    .filter((l) => l.trim() !== '');
  let text = lines.slice(-COMMIT_PROBLEM_LINES).join('\n');
  if (text.length > COMMIT_PROBLEM_MAX) text = text.slice(-COMMIT_PROBLEM_MAX);
  return `git commit: ${text || 'failed'}`;
}

/**
 * Commits what is staged (no `-a`) with `message`, the repo's hooks run as for anyone committing
 * there. Never throws.
 */
export async function commitStaged(
  env: UncommittedEnv,
  cwd: string,
  message: string,
): Promise<Committed | GitProblem> {
  const listed = await listSplit(env, cwd);
  if (isGitProblem(listed)) return listed;
  if (listed.staged.length === 0) {
    return { problem: 'nothing staged to commit' };
  }
  let r;
  try {
    r = await env.runLimited({
      cmd: ['git', '-c', 'core.quotePath=false', 'commit', '-m', message],
      cwd,
      env: { GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true' },
    }, { timeoutMs: COMMIT_TIMEOUT_MS, maxOutput: COMMIT_MAX_OUTPUT });
  } catch (e) {
    return {
      problem: `git commit: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  if (r.kind === 'timeout') {
    return {
      problem: `git commit: timed out after ${
        COMMIT_TIMEOUT_MS / 1000
      } s (a hook may be waiting)`,
    };
  }
  if (r.kind === 'too_large') {
    // The output was cut, not the commit: whether it was made is read below.
  } else if (r.code !== 0) {
    return { problem: commitProblem(r.stderr, r.stdout) };
  }
  const head = await git(env, cwd, ['rev-parse', '--verify', '-q', 'HEAD'], {
    maxOutput: 4096,
  });
  if (head === 'too_large') return { problem: 'git rev-parse failed' };
  if (isGitProblem(head)) return head;
  return {
    sha: head.out.trim(),
    subject: message.trim().split('\n')[0].trim(),
  };
}

/** The answer while a stage, unstage or commit already runs in the same repo. */
export const BUSY = 'busy: try again when the last one ends';

/**
 * Claims `folder` for one stage, unstage or commit: a release function, or `null` while one
 * already runs there. One at a time per repo, so two never race for the index.
 */
export function claimRepo(
  running: Set<string>,
  folder: string,
): (() => void) | null {
  if (running.has(folder)) return null;
  running.add(folder);
  return () => running.delete(folder);
}
