// One commit's changed files and their diffs, for the `devc web` repo card's Commits section: a
// commit row expands to its files, and a file opens in the diff tile, read-only.
//
// It reads the same host-owned mirror as the section (`git_history.ts`), never the repo: see
// `git_status.ts`'s header. These reads fetch nothing, so they never reach a remote, and they run
// whether or not the project's container does. The host's global git config still applies in the
// mirror, so every command that makes a diff says what it needs (`DIFF_FLAGS`) rather than trusting
// defaults.

import { historyMirror } from './git_history.ts';
import {
  defaultMirrorOpts,
  type GitProblem,
  isGitProblem,
  locate,
  type MirrorOpts,
  run,
  runCapped,
} from './git_status.ts';

export interface CommitFile {
  path: string;
  /** The old path of a rename; otherwise null. */
  previousPath: string | null;
  /**
   * The strings `statusLetter` already reads. A type change counts as `modified`. `conflicted`
   * only in a working tree's list (`git_uncommitted.ts`), for a path with a merge conflict.
   */
  status: 'added' | 'removed' | 'modified' | 'renamed' | 'conflicted';
  additions: number;
  deletions: number;
  binary: boolean;
  /** Only in a working tree's list: a file git doesn't track yet, with no line counts. */
  untracked?: true;
}

export interface CommitFiles {
  hash: string;
  /** In path order, at most {@link MAX_COMMIT_FILES}. */
  files: CommitFile[];
  truncated: boolean;
}

/** What a diff tile needs. `available` and `file` have the shape `pr_diff` answers with; no `pr`. */
export interface CommitDiff {
  available: true;
  commit: {
    hash: string;
    subject: string;
    author: string;
    time: number;
    /** What it is compared with; null for a root commit. */
    parent: string | null;
  };
  file: CommitFile & {
    /** Starts at the first `@@` line. Null for a binary file, or one past MAX_COMMIT_PATCH. */
    patch: string | null;
    tooLarge: boolean;
  };
}

/** The same shape as a `pr_file_at` answer, so the diff tile's `readHead` handles both. */
export type CommitFileAt =
  | { available: true; text: string }
  | { available: false; message: string };

export const MAX_COMMIT_FILES = 1000;
export const MAX_COMMIT_PATCH = 1024 * 1024;
/** The same limit as `pr_review.ts`'s MAX_FILE_CHARS. */
export const MAX_COMMIT_TEXT = 4 * 1024 * 1024;

/** A commit id as the page may send one: a full SHA-1 or SHA-256, lowercase. */
export const COMMIT_SHA = /^([0-9a-f]{40}|[0-9a-f]{64})$/;

const MISSING = 'this commit is no longer available';
/** The most a commit's raw listing may give before it is refused: well past 1000 files' worth. */
export const LIST_MAX_OUTPUT = 32 * 1024 * 1024;
const TIMEOUT_MS = 15_000;
const SUBJECT_MAX = 500;
const AUTHOR_MAX = 200;
/** Room for git's own `diff --git`/`index`/`---`/`+++` lines above the patch. */
const HEADER_ROOM = 64 * 1024;

/** On every command that makes a diff: the host's config and the mirror's attributes stay out. */
export const DIFF_FLAGS = [
  '--no-ext-diff',
  '--no-textconv',
  '--no-color',
  '--no-relative',
  '--src-prefix=a/',
  '--dst-prefix=b/',
];

interface Header {
  hash: string;
  /** The first parent, or null for a root commit. */
  parent: string | null;
  author: string;
  time: number;
  subject: string;
}

/** A listed file with the blob ids its diff needs. */
export interface Listed extends CommitFile {
  oldBlob: string;
  newBlob: string;
}

/** The mirror holding `folder`'s Commits section, or why there is none. */
async function mirrorOf(
  folder: string,
  opts: MirrorOpts,
): Promise<string | GitProblem> {
  const at = await locate(folder, opts);
  if (at === null) return { problem: 'not a git repo' };
  if (isGitProblem(at)) return at;
  const mirror = await historyMirror(at, folder, opts);
  return mirror ?? { problem: 'could not create the git mirror' };
}

async function readHeader(
  mirror: string,
  sha: string,
): Promise<Header | GitProblem> {
  const r = await run(
    [
      `--git-dir=${mirror}`,
      'log',
      '-1',
      '--no-show-signature',
      '--no-color',
      '--encoding=UTF-8',
      '--format=%H%x00%P%x00%an%x00%at%x00%s',
      // `<sha>^{commit}` refuses a blob or tree id; a missing one fails the same way.
      `${sha}^{commit}`,
      '--',
    ],
    TIMEOUT_MS,
  );
  if ('failed' in r) {
    return /timed out/.test(r.failed) ? { problem: r.failed } : {
      problem: MISSING,
    };
  }
  const fields = r.out.replace(/\n$/, '').split('\0');
  if (fields.length !== 5 || fields[0] !== sha) return { problem: MISSING };
  const [hash, parents, author, time, subject] = fields;
  return {
    hash,
    parent: parents.split(' ').find((p) => p) ?? null,
    author: author.slice(0, AUTHOR_MAX),
    time: Number(time) || 0,
    subject: subject.slice(0, SUBJECT_MAX),
  };
}

/** What `diff-tree` compares: the first parent with the commit, or a root commit with nothing. */
function treeArgs(h: Header): string[] {
  return h.parent === null ? ['--root', h.hash] : [h.parent, h.hash];
}

const STATUS: Record<string, CommitFile['status']> = {
  A: 'added',
  D: 'removed',
  M: 'modified',
  T: 'modified',
  R: 'renamed',
};

/**
 * Parses `diff-tree -r -z -M --raw --numstat` output: every raw entry
 * (`:<mode> <mode> <blob> <blob> <status>\0<path>\0[<path>\0]`), then a numstat entry for each in
 * the same order (`<add>\t<del>\t<path>\0`, or `<add>\t<del>\t\0<old>\0<new>\0` for a rename,
 * `-\t-\t` for a binary file). Returned in path order.
 */
export function parseDiffTree(out: string): Listed[] {
  const tokens = out.split('\0');
  const files: Listed[] = [];
  let i = 0;
  while (i < tokens.length && tokens[i].startsWith(':')) {
    const fields = tokens[i++].slice(1).split(' ');
    const code = (fields[4] ?? '')[0];
    const two = code === 'R' || code === 'C';
    const first = tokens[i++] ?? '';
    const second = two ? tokens[i++] ?? '' : null;
    files.push({
      path: second ?? first,
      previousPath: code === 'R' ? first : null,
      // A copy (only with copy detection, never asked for) is shown as the file it added.
      status: STATUS[code] ?? (code === 'C' ? 'added' : 'modified'),
      additions: 0,
      deletions: 0,
      binary: false,
      oldBlob: fields[2] ?? '',
      newBlob: fields[3] ?? '',
    });
  }
  for (const f of files) {
    const stat = tokens[i++];
    if (stat === undefined) break;
    const [add, del, rest] = stat.split('\t');
    // A rename's paths follow as their own tokens.
    if (rest === '') i += 2;
    if (add === '-' && del === '-') f.binary = true;
    else {
      f.additions = Number(add) || 0;
      f.deletions = Number(del) || 0;
    }
  }
  return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

async function listFiles(
  mirror: string,
  h: Header,
): Promise<Listed[] | GitProblem> {
  const r = await runCapped(
    [
      `--git-dir=${mirror}`,
      'diff-tree',
      '-r',
      '-z',
      '-M',
      '--no-commit-id',
      '--raw',
      '--numstat',
      ...DIFF_FLAGS,
      ...treeArgs(h),
    ],
    LIST_MAX_OUTPUT,
    TIMEOUT_MS,
  );
  if (r === 'too_large') return { problem: 'too many files changed to list' };
  if ('failed' in r) return { problem: r.failed };
  return parseDiffTree(new TextDecoder().decode(r.out));
}

export function publicFile(f: Listed): CommitFile {
  const { oldBlob: _o, newBlob: _n, ...file } = f;
  return file;
}

/** `sha`'s changed files, compared with its first parent. Never throws. */
export async function readCommitFiles(
  folder: string,
  sha: string,
  opts: MirrorOpts = defaultMirrorOpts(),
): Promise<CommitFiles | GitProblem> {
  if (!COMMIT_SHA.test(sha)) return { problem: MISSING };
  const mirror = await mirrorOf(folder, opts);
  if (typeof mirror !== 'string') return mirror;
  const h = await readHeader(mirror, sha);
  if (isGitProblem(h)) return h;
  const listed = await listFiles(mirror, h);
  if (isGitProblem(listed)) return listed;
  return {
    hash: h.hash,
    files: listed.slice(0, MAX_COMMIT_FILES).map(publicFile),
    truncated: listed.length > MAX_COMMIT_FILES,
  };
}

/** Drops git's `diff --git`, `index`, `---` and `+++` lines: `parsePatch` starts at the first `@@`. */
export function patchBody(out: string): string {
  if (out.startsWith('@@')) return out;
  const at = out.indexOf('\n@@');
  return at === -1 ? '' : out.slice(at + 1);
}

/** `path`'s diff in `sha`, compared with its first parent. Never throws. */
export async function readCommitDiff(
  folder: string,
  sha: string,
  path: string,
  opts: MirrorOpts = defaultMirrorOpts(),
): Promise<CommitDiff | GitProblem> {
  if (!COMMIT_SHA.test(sha)) return { problem: MISSING };
  const mirror = await mirrorOf(folder, opts);
  if (typeof mirror !== 'string') return mirror;
  const h = await readHeader(mirror, sha);
  if (isGitProblem(h)) return h;
  const listed = await listFiles(mirror, h);
  if (isGitProblem(listed)) return listed;
  // Found by listing, never from the page: a rename's old path comes from git.
  const f = listed.find((l) => l.path === path);
  if (f === undefined) {
    return { problem: `${path} is not changed in this commit` };
  }

  let patch: string | null = null;
  let tooLarge = false;
  if (!f.binary) {
    // A rename compares its two blobs, so the patch shows only the changed lines. Anything else is
    // the one path in the commit's tree diff, with no rename detection to pair it elsewhere.
    const args = f.status === 'renamed'
      ? ['diff', ...DIFF_FLAGS, '-U3', f.oldBlob, f.newBlob]
      : [
        'diff-tree',
        '-p',
        '-r',
        '--no-commit-id',
        ...DIFF_FLAGS,
        '-U3',
        ...treeArgs(h),
        '--',
        // Literal, so a path holding `*` or `:` names only itself.
        `:(literal)${path}`,
      ];
    const r = await runCapped(
      [`--git-dir=${mirror}`, ...args],
      MAX_COMMIT_PATCH + HEADER_ROOM,
      TIMEOUT_MS,
    );
    if (r === 'too_large') tooLarge = true;
    else if ('failed' in r) return { problem: r.failed };
    else {
      const body = patchBody(new TextDecoder().decode(r.out));
      if (body.length > MAX_COMMIT_PATCH) tooLarge = true;
      else patch = body;
    }
  }
  return {
    available: true,
    commit: {
      hash: h.hash,
      subject: h.subject,
      author: h.author,
      time: h.time,
      parent: h.parent,
    },
    file: { ...publicFile(f), patch, tooLarge },
  };
}

/** {@link readMirrorFileAt}'s answer: the shape `gh-pr-file-at` prints, without path and sha. */
export type MirrorFileAt =
  | { content: string }
  | { missing: true }
  | { binary: true }
  | { tooLarge: true };

/** `gh-pr-file-at`'s own limit: a larger file is `tooLarge`, as GitHub's contents API has it. */
export const MAX_PR_FILE_BYTES = 1024 * 1024;

/**
 * `path` at `sha` from the host mirror, answered as `gh-pr-file-at` would answer it, or null when
 * the mirror can't say: the commit isn't in it (not fetched yet, a fork's, force-pushed away), the
 * path is a symlink or the mirror failed. A commit's id fixes every file in it, so whatever the
 * mirror has is what GitHub has. The commit present, a path not in it (or a directory, or a
 * submodule) is `missing`, as GitHub's 404 or non-file is. Never throws.
 */
export async function readMirrorFileAt(
  folder: string,
  sha: string,
  path: string,
  opts: MirrorOpts = defaultMirrorOpts(),
): Promise<MirrorFileAt | null> {
  if (!COMMIT_SHA.test(sha) || path === '' || path.includes('\0')) return null;
  const mirror = await mirrorOf(folder, opts);
  if (typeof mirror !== 'string') return null;
  // Fails when the commit isn't in the mirror. `ls-tree` paths match literally (no globs); the
  // entry naming `path` itself is the one wanted, so a directory gives its own entry.
  const listed = await runCapped(
    [
      `--git-dir=${mirror}`,
      'ls-tree',
      '-l',
      '-z',
      `${sha}^{commit}`,
      '--',
      path,
    ],
    LIST_MAX_OUTPUT,
    TIMEOUT_MS,
  );
  if (listed === 'too_large' || 'failed' in listed) return null;
  // `<mode> <type> <object> <size>\t<path>`, size padded, `-` for a non-blob.
  const entry = new TextDecoder().decode(listed.out).split('\0')
    .map((e) => e.match(/^(\d+) (\w+) ([0-9a-f]+) +(\S+)\t(.*)$/s))
    .find((m) => m !== null && m[5] === path);
  if (!entry) return { missing: true };
  const [, mode, type, object, size] = entry;
  // GitHub answers a symlink by its target's content when that is a file: left to the bridge.
  if (mode === '120000') return null;
  if (type !== 'blob') return { missing: true };
  if (Number(size) > MAX_PR_FILE_BYTES) return { tooLarge: true };
  const r = await runCapped(
    [`--git-dir=${mirror}`, 'cat-file', 'blob', object],
    MAX_PR_FILE_BYTES,
    TIMEOUT_MS,
  );
  if (r === 'too_large') return { tooLarge: true };
  if ('failed' in r) return null;
  if (r.out.includes(0)) return { binary: true };
  try {
    return { content: new TextDecoder('utf-8', { fatal: true }).decode(r.out) };
  } catch {
    return { binary: true };
  }
}

/** `path`'s text as `sha` has it, for Whole file. Never throws. */
export async function readCommitFileAt(
  folder: string,
  sha: string,
  path: string,
  opts: MirrorOpts = defaultMirrorOpts(),
): Promise<CommitFileAt | GitProblem> {
  if (!COMMIT_SHA.test(sha)) return { problem: MISSING };
  const mirror = await mirrorOf(folder, opts);
  if (typeof mirror !== 'string') return mirror;
  const h = await readHeader(mirror, sha);
  if (isGitProblem(h)) return h;
  const r = await runCapped(
    [`--git-dir=${mirror}`, 'cat-file', 'blob', `${h.hash}:${path}`],
    MAX_COMMIT_TEXT,
    TIMEOUT_MS,
  );
  if (r === 'too_large') return { available: false, message: 'file too large' };
  if ('failed' in r) {
    return /timed out/.test(r.failed)
      ? { problem: r.failed }
      : { available: false, message: 'file not in this commit' };
  }
  if (r.out.includes(0)) return { available: false, message: 'binary file' };
  return { available: true, text: new TextDecoder().decode(r.out) };
}
