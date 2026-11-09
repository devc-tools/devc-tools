// A repo's uncommitted files and their diffs, for the `devc web` repo card's Commits section: an
// Uncommitted row expands to the working tree's changed files, split into staged (index vs `HEAD`)
// and unstaged (working tree vs index), and a file opens in the diff tile.
//
// Unlike `git_commit.ts`, which reads the host's mirror, this reads the working tree, so it runs
// **in the project's environment** (`Environment.runLimited`): a container's own git under
// `docker exec`, a host project's directly. `git diff` against a working tree runs the repo's own
// config, which the host never does in a container's repo (`git_changes.ts`'s header). Every diff
// still names what it needs (`DIFF_FLAGS`), so the output has the shape the tile parses. A path
// from the page is never passed to git: it is found in a fresh listing first.
// See `.plans/devc-web-uncommitted-files.md` and `.plans/devc-web-stage-commit.md`.

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
import { FilesError, MAX_READ_BYTES } from './files.ts';
import { type GitProblem, isGitProblem } from './git_status.ts';

export interface UncommittedFiles {
  /** What the index is compared with: `HEAD`'s id, or null for the empty tree. */
  base: string | null;
  /** Index vs base, in path order, at most {@link MAX_COMMIT_FILES}. */
  staged: CommitFile[];
  /** Working tree vs index (untracked and conflicted files included), as `staged`. */
  unstaged: CommitFile[];
  /** Either list was cut. */
  truncated: boolean;
}

/** Which side of the index a diff shows: what is staged, or what is not yet. */
export type Stage = 'staged' | 'unstaged';

/** What a diff tile needs: `commit_diff`'s shape, with `changes` in place of `commit`. */
export interface UncommittedDiff {
  available: true;
  changes: { base: string | null; stage?: Stage };
  file: CommitFile & { patch: string | null; tooLarge: boolean };
}

/** What these reads use of an environment. */
export type UncommittedEnv = Pick<Environment, 'runLimited' | 'files'>;

const GIT = ['git', '--no-optional-locks', '-c', 'core.quotePath=false'];
/** For commands that write the index (`git_stage.ts`): no `--no-optional-locks`. */
export const GIT_WRITE = ['git', '-c', 'core.quotePath=false'];
const TIMEOUT_MS = 15_000;
/** Room for git's own `diff --git`/`index`/`---`/`+++` lines above the patch. */
const HEADER_ROOM = 64 * 1024;
const TOO_MANY = 'too many files changed to list';
/** Nothing a write runs may wait on a terminal or open an editor. */
export const NO_PROMPT = { GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true' };

/** Runs `git <args>` at `cwd` in `env`; an exit outside `ok` is a problem. Never throws. */
export async function git(
  env: UncommittedEnv,
  cwd: string,
  args: string[],
  opts: {
    maxOutput: number;
    ok?: number[];
    tooLarge?: string;
    timeoutMs?: number;
    /** Writes the index: {@link GIT_WRITE}, and nothing may wait on a terminal or an editor. */
    write?: boolean;
  },
): Promise<{ out: string; code: number } | GitProblem | 'too_large'> {
  const name = `git ${args[0]}`;
  try {
    const r = await env.runLimited({
      cmd: [...(opts.write ? GIT_WRITE : GIT), ...args],
      cwd,
      ...(opts.write ? { env: NO_PROMPT } : {}),
    }, {
      timeoutMs: opts.timeoutMs ?? TIMEOUT_MS,
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
    files.push(untrackedFile(path));
  }
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { base: base.base, tree: base.tree, files };
}

/** The listing split at the index: what is staged, and what is not yet. */
export interface SplitListing {
  base: string | null;
  tree: string;
  staged: Listed[];
  unstaged: Listed[];
}

/**
 * The staged changes (index vs base) and the unstaged ones (working tree vs index, untracked
 * files one per file). A conflicted path is listed by git in both diffs (`U`, and in the working
 * tree's also as `M`): it is dropped from both and listed once in `unstaged` as `conflicted`. In
 * path order.
 */
export async function listSplit(
  env: UncommittedEnv,
  cwd: string,
): Promise<SplitListing | GitProblem> {
  const base = await readBase(env, cwd);
  if (isGitProblem(base)) return base;
  const listOpts = { maxOutput: LIST_MAX_OUTPUT, tooLarge: TOO_MANY };
  const raw = ['-z', '--raw', '--numstat', ...DIFF_FLAGS];
  const results = await Promise.all([
    git(env, cwd, ['diff', '--cached', base.tree, '-M', ...raw], listOpts),
    git(env, cwd, ['diff', ...raw], listOpts),
    git(
      env,
      cwd,
      ['ls-files', '--others', '--exclude-standard', '-z'],
      listOpts,
    ),
    git(env, cwd, ['diff', '--name-only', '-z', '--diff-filter=U'], listOpts),
  ]);
  for (const r of results) {
    if (r === 'too_large') return { problem: TOO_MANY };
    if (isGitProblem(r)) return r;
  }
  const [cached, worktree, others, unmerged] = results.map((r) =>
    (r as { out: string }).out
  );
  const conflicted = new Set(nulFields(unmerged));
  const staged = parseDiffTree(cached).filter((f) => !conflicted.has(f.path));
  const unstaged: Listed[] = [];
  const conflicts = new Map<string, Listed>();
  // Parsed whole first: its numstat lines pair with its raw lines by count.
  for (const f of parseDiffTree(worktree)) {
    if (!conflicted.has(f.path)) {
      unstaged.push(f);
      continue;
    }
    const c = conflicts.get(f.path);
    if (c) {
      c.additions += f.additions;
      c.deletions += f.deletions;
      c.binary ||= f.binary;
    } else {
      conflicts.set(f.path, { ...f, status: 'conflicted' });
    }
  }
  for (const path of conflicted) {
    if (!conflicts.has(path)) {
      conflicts.set(path, {
        path,
        previousPath: null,
        status: 'conflicted',
        additions: 0,
        deletions: 0,
        binary: false,
        oldBlob: '',
        newBlob: '',
      });
    }
  }
  unstaged.push(...conflicts.values());
  const seen = new Set(unstaged.map((f) => f.path));
  for (const path of nulFields(others)) {
    if (seen.has(path)) continue;
    unstaged.push(untrackedFile(path));
  }
  const byPath = (a: Listed, b: Listed) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  staged.sort(byPath);
  unstaged.sort(byPath);
  return { base: base.base, tree: base.tree, staged, unstaged };
}

/** An untracked file's entry: git counts no lines for it. */
function untrackedFile(path: string): Listed {
  return {
    path,
    previousPath: null,
    status: 'added',
    untracked: true,
    additions: 0,
    deletions: 0,
    binary: false,
    oldBlob: '',
    newBlob: '',
  };
}

/** The working tree's changed files at `cwd` (the repo's path in `env`). Never throws. */
export async function readUncommittedFiles(
  env: UncommittedEnv,
  cwd: string,
): Promise<UncommittedFiles | GitProblem> {
  const listed = await listSplit(env, cwd);
  if (isGitProblem(listed)) return listed;
  return {
    base: listed.base,
    staged: listed.staged.slice(0, MAX_COMMIT_FILES).map(publicFile),
    unstaged: listed.unstaged.slice(0, MAX_COMMIT_FILES).map(publicFile),
    truncated: listed.staged.length > MAX_COMMIT_FILES ||
      listed.unstaged.length > MAX_COMMIT_FILES,
  };
}

/** `path`'s entry in `stage`'s list of a fresh listing, or why there is none. */
async function findStaged(
  env: UncommittedEnv,
  cwd: string,
  path: string,
  stage: Stage,
): Promise<{ listed: SplitListing; f: Listed } | GitProblem> {
  const listed = await listSplit(env, cwd);
  if (isGitProblem(listed)) return listed;
  const f = listed[stage].find((l) => l.path === path);
  if (f === undefined) return { problem: noChanges(path, stage) };
  return { listed, f };
}

/** The answer for a path not in `stage`'s list. */
export const noChanges = (path: string, stage: Stage) =>
  `${path} has no ${stage} changes`;

/**
 * `path`'s uncommitted diff: with no `stage`, the working tree against `HEAD` (or the empty tree);
 * `staged`, the index against it; `unstaged`, the working tree against the index (a conflicted
 * file against `HEAD`: git's own diff of one is a combined `diff --cc`). Never throws.
 */
export async function readUncommittedDiff(
  env: UncommittedEnv,
  cwd: string,
  path: string,
  stage?: Stage,
): Promise<UncommittedDiff | GitProblem> {
  let f: Listed;
  let base: string | null;
  let args: string[];
  if (stage === undefined) {
    const listed = await listChanges(env, cwd);
    if (isGitProblem(listed)) return listed;
    // Found by listing, never from the page: a rename's old path comes from git.
    const found = listed.files.find((l) => l.path === path);
    if (found === undefined) {
      return { problem: `${path} has no uncommitted changes` };
    }
    f = found;
    base = listed.base;
    args = f.untracked
      ? untrackedDiff(f)
      : ['diff', listed.tree, ...pathArgs(f, true)];
  } else {
    const found = await findStaged(env, cwd, path, stage);
    if (isGitProblem(found)) return found;
    f = found.f;
    base = found.listed.base;
    const tree = found.listed.tree;
    args = stage === 'staged'
      ? ['diff', '--cached', tree, ...pathArgs(f, true)]
      : f.untracked
      ? untrackedDiff(f)
      : f.status === 'conflicted'
      ? ['diff', tree, ...pathArgs(f, false)]
      : ['diff', ...pathArgs(f, false)];
  }

  let patch: string | null = null;
  let tooLarge = false;
  let binary = f.binary;
  if (!binary) {
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
    changes: stage === undefined ? { base } : { base, stage },
    file: { ...publicFile(f), binary, patch, tooLarge },
  };
}

/** An untracked file's diff: every line added. `--no-index` takes plain paths, not pathspecs. */
const untrackedDiff = (f: Listed) => [
  'diff',
  '--no-index',
  ...DIFF_FLAGS,
  '-U3',
  '--',
  '/dev/null',
  f.path,
];

/** The flags and pathspecs after a diff's revisions: a rename names both paths (with `-M`). */
function pathArgs(f: Listed, renames: boolean): string[] {
  const rename = renames && f.status === 'renamed' && f.previousPath !== null;
  return [
    ...(rename ? ['-M'] : []),
    ...DIFF_FLAGS,
    '-U3',
    '--',
    ...(rename ? [`:(literal)${f.previousPath}`] : []),
    `:(literal)${f.path}`,
  ];
}

/**
 * `path`'s text for Whole file: in the index for `staged`, else in the working tree. Never
 * throws.
 */
export async function readUncommittedFileAt(
  env: UncommittedEnv,
  cwd: string,
  path: string,
  stage?: Stage,
): Promise<CommitFileAt | GitProblem> {
  let f: Listed;
  if (stage === undefined) {
    const listed = await listChanges(env, cwd);
    if (isGitProblem(listed)) return listed;
    const found = listed.files.find((l) => l.path === path);
    if (found === undefined) {
      return { problem: `${path} has no uncommitted changes` };
    }
    f = found;
  } else {
    const found = await findStaged(env, cwd, path, stage);
    if (isGitProblem(found)) return found;
    f = found.f;
  }
  if (stage === 'staged') return await readIndexText(env, cwd, f);
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

/** A staged file's text in the index (`git cat-file`, never `git show`, which may textconv). */
async function readIndexText(
  env: UncommittedEnv,
  cwd: string,
  f: Listed,
): Promise<CommitFileAt | GitProblem> {
  if (f.status === 'removed') {
    return { available: false, message: 'file not in the index' };
  }
  // `:<path>` is a revision, not a pathspec: from the root, as the cwd is the repo's.
  const r = await git(env, cwd, ['cat-file', 'blob', `:${f.path}`], {
    maxOutput: MAX_READ_BYTES + 1,
  });
  if (r === 'too_large') return { available: false, message: 'file too large' };
  if (isGitProblem(r)) return r;
  if (r.out.length > MAX_READ_BYTES) {
    return { available: false, message: 'file too large' };
  }
  if (r.out.slice(0, 8000).includes('\0')) {
    return { available: false, message: 'binary file' };
  }
  return { available: true, text: r.out };
}
