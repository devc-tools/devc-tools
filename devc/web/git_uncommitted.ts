// A repo's uncommitted files and their diffs, for the `devc web` repo card's Commits section: an
// Uncommitted row expands to the working tree's changed files, and a file opens in the diff tile
// against `HEAD`.
//
// Unlike `git_commit.ts`, which reads the host's mirror, this reads the working tree, so it runs
// **in the project's environment** (`Environment.runLimited`): a container's own git under
// `docker exec`, a host project's directly. `git diff` against a working tree runs the repo's own
// config, which the host never does in a container's repo (`git_changes.ts`'s header). Every diff
// still names what it needs (`DIFF_FLAGS`), so the output has the shape the tile parses. A path
// from the page is never passed to git: it is found in a fresh listing first.
// See `.plans/devc-web-uncommitted-files.md`.

import {
  type CommitFile,
  type CommitFileAt,
  DIFF_FLAGS,
  LIST_MAX_OUTPUT,
  type Listed,
  MAX_COMMIT_FILES,
  MAX_COMMIT_PATCH,
  parseDiffTree,
  patchBody,
  publicFile,
} from './git_commit.ts';
import type { Environment } from './environment.ts';
import { FilesError } from './files.ts';
import { type GitProblem, isGitProblem } from './git_status.ts';

export interface UncommittedFiles {
  /** What the working tree is compared with: `HEAD`'s id, or null for the empty tree. */
  base: string | null;
  /** In path order, at most {@link MAX_COMMIT_FILES}. */
  files: CommitFile[];
  truncated: boolean;
}

/** What a diff tile needs: `commit_diff`'s shape, with `changes` in place of `commit`. */
export interface UncommittedDiff {
  available: true;
  changes: { base: string | null };
  file: CommitFile & { patch: string | null; tooLarge: boolean };
}

/** What these reads use of an environment. */
export type UncommittedEnv = Pick<Environment, 'runLimited' | 'files'>;

const GIT = ['git', '--no-optional-locks', '-c', 'core.quotePath=false'];
const TIMEOUT_MS = 15_000;
/** Room for git's own `diff --git`/`index`/`---`/`+++` lines above the patch. */
const HEADER_ROOM = 64 * 1024;
const TOO_MANY = 'too many files changed to list';

/** Runs `git <args>` at `cwd` in `env`; an exit outside `ok` is a problem. Never throws. */
async function git(
  env: UncommittedEnv,
  cwd: string,
  args: string[],
  opts: { maxOutput: number; ok?: number[]; tooLarge?: string },
): Promise<{ out: string; code: number } | GitProblem | 'too_large'> {
  const name = `git ${args[0]}`;
  try {
    const r = await env.runLimited({ cmd: [...GIT, ...args], cwd }, {
      timeoutMs: TIMEOUT_MS,
      maxOutput: opts.maxOutput,
    });
    if (r.kind === 'timeout') return { problem: `${name}: timed out` };
    if (r.kind === 'too_large') {
      return opts.tooLarge ? { problem: opts.tooLarge } : 'too_large';
    }
    if (!(opts.ok ?? [0]).includes(r.code)) {
      const line = r.stderr.split('\n').map((l) => l.trim()).find((l) => l);
      return { problem: line ? `${name}: ${line}` : `${name} failed` };
    }
    return { out: r.stdout, code: r.code };
  } catch (e) {
    return {
      problem: `${name}: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/** `HEAD`'s id, or for an unborn branch the empty tree's (SHA-1 or SHA-256, as the repo is). */
async function readBase(
  env: UncommittedEnv,
  cwd: string,
): Promise<{ base: string | null; tree: string } | GitProblem> {
  const head = await git(
    env,
    cwd,
    ['rev-parse', '--verify', '-q', 'HEAD^{commit}'],
    { maxOutput: 4096, ok: [0, 1] },
  );
  if (head === 'too_large') return { problem: 'git rev-parse failed' };
  if (isGitProblem(head)) return head;
  const id = head.out.trim();
  if (head.code === 0 && id) return { base: id, tree: id };
  const empty = await git(
    env,
    cwd,
    ['hash-object', '-t', 'tree', '/dev/null'],
    { maxOutput: 4096 },
  );
  if (empty === 'too_large') return { problem: 'git hash-object failed' };
  if (isGitProblem(empty)) return empty;
  return { base: null, tree: empty.out.trim() };
}

/** NUL-ended fields, without the empty one after the last NUL. */
const nulFields = (out: string) => out.split('\0').filter((f) => f !== '');

/**
 * Every changed file in the working tree against the base: tracked changes staged or not (one
 * `git diff <base>`), untracked files one per file, and conflicts marked (`git diff <base>` lists
 * them as `M`; only `--diff-filter=U` with no base says they are unmerged). In path order.
 */
async function listChanges(
  env: UncommittedEnv,
  cwd: string,
): Promise<
  { base: string | null; tree: string; files: Listed[] } | GitProblem
> {
  const base = await readBase(env, cwd);
  if (isGitProblem(base)) return base;
  const listOpts = { maxOutput: LIST_MAX_OUTPUT, tooLarge: TOO_MANY };
  const [tracked, others, unmerged] = await Promise.all([
    git(env, cwd, [
      'diff',
      base.tree,
      '-z',
      '-M',
      '--raw',
      '--numstat',
      ...DIFF_FLAGS,
    ], listOpts),
    git(
      env,
      cwd,
      ['ls-files', '--others', '--exclude-standard', '-z'],
      listOpts,
    ),
    git(env, cwd, ['diff', '--name-only', '-z', '--diff-filter=U'], listOpts),
  ]);
  for (const r of [tracked, others, unmerged]) {
    if (r === 'too_large') return { problem: TOO_MANY };
    if (isGitProblem(r)) return r;
  }
  const t = tracked as { out: string };
  const files = parseDiffTree(t.out);
  const conflicted = new Set(nulFields((unmerged as { out: string }).out));
  for (const f of files) if (conflicted.has(f.path)) f.status = 'conflicted';
  const seen = new Set(files.map((f) => f.path));
  for (const path of nulFields((others as { out: string }).out)) {
    if (seen.has(path)) continue;
    files.push({
      path,
      previousPath: null,
      status: 'added',
      untracked: true,
      additions: 0,
      deletions: 0,
      binary: false,
      oldBlob: '',
      newBlob: '',
    });
  }
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { base: base.base, tree: base.tree, files };
}

/** The working tree's changed files at `cwd` (the repo's path in `env`). Never throws. */
export async function readUncommittedFiles(
  env: UncommittedEnv,
  cwd: string,
): Promise<UncommittedFiles | GitProblem> {
  const listed = await listChanges(env, cwd);
  if (isGitProblem(listed)) return listed;
  return {
    base: listed.base,
    files: listed.files.slice(0, MAX_COMMIT_FILES).map(publicFile),
    truncated: listed.files.length > MAX_COMMIT_FILES,
  };
}

/** `path`'s uncommitted diff against `HEAD` (or the empty tree). Never throws. */
export async function readUncommittedDiff(
  env: UncommittedEnv,
  cwd: string,
  path: string,
): Promise<UncommittedDiff | GitProblem> {
  const listed = await listChanges(env, cwd);
  if (isGitProblem(listed)) return listed;
  // Found by listing, never from the page: a rename's old path comes from git.
  const f = listed.files.find((l) => l.path === path);
  if (f === undefined) return { problem: `${path} has no uncommitted changes` };

  let patch: string | null = null;
  let tooLarge = false;
  let binary = f.binary;
  if (!binary) {
    const args = f.untracked
      // `--no-index` takes plain paths, not pathspecs; exit 1 means they differ.
      ? ['diff', '--no-index', ...DIFF_FLAGS, '-U3', '--', '/dev/null', f.path]
      : f.status === 'renamed' && f.previousPath !== null
      ? [
        'diff',
        listed.tree,
        '-M',
        ...DIFF_FLAGS,
        '-U3',
        '--',
        `:(literal)${f.previousPath}`,
        `:(literal)${f.path}`,
      ]
      : [
        'diff',
        listed.tree,
        ...DIFF_FLAGS,
        '-U3',
        '--',
        `:(literal)${f.path}`,
      ];
    const r = await git(env, cwd, args, {
      maxOutput: MAX_COMMIT_PATCH + HEADER_ROOM,
      ok: f.untracked ? [0, 1] : [0],
    });
    if (r === 'too_large') tooLarge = true;
    else if (isGitProblem(r)) return r;
    else {
      const body = patchBody(r.out);
      if (body === '' && /^Binary files /m.test(r.out)) binary = true;
      else if (body.length > MAX_COMMIT_PATCH) tooLarge = true;
      else patch = body;
    }
  }
  return {
    available: true,
    changes: { base: listed.base },
    file: { ...publicFile(f), binary, patch, tooLarge },
  };
}

/** `path`'s text in the working tree, for Whole file. Never throws. */
export async function readUncommittedFileAt(
  env: UncommittedEnv,
  cwd: string,
  path: string,
): Promise<CommitFileAt | GitProblem> {
  const listed = await listChanges(env, cwd);
  if (isGitProblem(listed)) return listed;
  const f = listed.files.find((l) => l.path === path);
  if (f === undefined) return { problem: `${path} has no uncommitted changes` };
  const missing = {
    available: false,
    message: 'file not in the working tree',
  } as const;
  if (f.status === 'removed') return missing;
  try {
    const { text } = await env.files.read(
      `${cwd.replace(/\/+$/, '')}/${f.path}`,
    );
    return { available: true, text };
  } catch (e) {
    if (e instanceof FilesError) {
      if (e.code === 'too_large') {
        return { available: false, message: 'file too large' };
      }
      if (e.code === 'binary') {
        return { available: false, message: 'binary file' };
      }
      if (e.code === 'not_found') return missing;
    }
    return { problem: e instanceof Error ? e.message : String(e) };
  }
}
