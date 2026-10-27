// `devc web`'s pull request review: the PR of a repo's pinned branch, its changed files with
// GitHub's Viewed state, each file's patch, and its review threads, plus marking Viewed, replying
// and resolving; each file at a commit (changes since viewed, against the viewed history devc
// web records); and a pending review to add comments to and submit. See
// `.plans/devc-web-pr-review.md` and `.plans/devc-web-pr-review-depth.md`.
//
// **Every GitHub call is a built-in `devc-bridge` recipe** (`gh-pr-* --repo <target> …`, argv
// only, never a shell), run by the project's environment's `PrBackend` (`environment.ts`). In a
// container it is `devc-bridge` there (`containers.ts`): devc web never runs `gh` for it, since
// the page can already type into a terminal in that container, so running the same bridge
// commands adds no reach, where host `gh` would. A project on this machine runs the same recipes
// with the host's own `gh` (`pr_host.ts`): its page already has a host shell.
//
// **Grants come from the backend's `pin`, read on every message**, never cached: a container's
// from the host-only policy (`readPolicy`, keyed by `projectKey(localFolder)`), never from the
// container. They decide which commands are offered and which are refused here, ahead of the
// bridge's own check. Each line carries its own grants, so a repo is offered only what the line
// pinning it grants.
//
// **The bridge's output may pass through a container, so it is untrusted** (a container could
// shadow `devc-bridge` on its own `PATH`), and a host recipe prints what GitHub sent. Every
// listing is parsed defensively, with caps, and the page shows it as text only.
//
// **Every posting command runs `--as human`**: the page is driven by a person, so what it posts
// carries no `🤖` prefix. It is a label the bridge cannot check, not a grant.

import type { BridgeCapability } from '@devc-tools/core/bridge.ts';
import { displayPath } from '@devc-tools/core/config.ts';
import type {
  BridgeRun,
  EnvironmentKind,
  PrBackend,
  RunLimits,
} from './environment.ts';

// ── limits ──────────────────────────────────────────────────────────────────────────────────

/** How long one bridge command may run before it is killed. */
export const BRIDGE_TIMEOUT_MS = 120_000;
/** The most stdout one bridge command may write: over it, the command is killed. */
export const MAX_BRIDGE_OUTPUT = 64 * 1024 * 1024;
/** How many repos' listings are kept, the oldest dropped first. */
export const MAX_LISTINGS = 32;
export const MAX_FILES = 3000;
export const MAX_PATCH_BYTES = 4 * 1024 * 1024;
export const MAX_THREADS = 500;
export const MAX_COMMENTS = 100;
export const MAX_BODY_CHARS = 65_536;
export const MAX_TITLE = 1024;
export const MAX_REF = 255;
export const MAX_PATH = 4096;
/** A reply's most UTF-8 bytes: the bridge's own limit. */
export const MAX_REPLY_BYTES = 4000;
/** The most of a thread's `diffHunk` kept. */
export const MAX_HUNK_CHARS = 20_000;
/** The most characters of a file read at a commit (`pr_file_at`). */
export const MAX_FILE_CHARS = 4 * 1024 * 1024;
/** A viewed history file keeps its last this many marks. */
export const MAX_HISTORY_LINES = 5000;
/** The most of a file's marks `pr_diff` returns. */
export const MAX_HISTORY_ENTRIES = 50;
/** The longest stderr line a `bridge` result carries. */
const MAX_MESSAGE = 300;

export const NOT_RUNNING_MESSAGE =
  'Start the container to see its pull request';
/** {@link NOT_RUNNING_MESSAGE} for a project on this machine. */
export const HOST_NOT_RUNNING_MESSAGE =
  'Start the session to see its pull request';
/** The `no_grant` message, naming the global config file in use (`configPath`). */
export function noGrantMessage(configPath: string): string {
  return `Needs a grant on this repo: devc up --bridge-allow gh-pr-read, or "bridgeDefaultAllow" in ${
    displayPath(configPath)
  }`;
}
export const UNEXPECTED_OUTPUT = 'unexpected bridge output';
export const OUTPUT_TOO_LARGE = 'bridge output too large';
export const FILE_GONE = 'This file is not in the pull request any more';
export const THREAD_GONE = 'This thread is resolved or gone';
export const FILE_AT_MISSING = 'That commit no longer has this file on GitHub';
export const FILE_AT_BINARY = 'Binary file';
export const FILE_AT_TOO_LARGE = 'Larger than 1 MB';

// ── the listing ─────────────────────────────────────────────────────────────────────────────

export interface PrInfo {
  repo: string;
  number: number;
  url: string;
  headSha: string;
  title: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  isDraft: boolean;
  author: string | null;
  baseRef: string;
  headRef: string;
  changedFiles: number;
}

export type FileStatus =
  | 'added'
  | 'removed'
  | 'modified'
  | 'renamed'
  | 'copied'
  | 'changed'
  | 'unchanged';
export type ViewedState = 'VIEWED' | 'UNVIEWED' | 'DISMISSED';

export interface PrFile {
  path: string;
  previousPath: string | null;
  status: FileStatus;
  additions: number;
  deletions: number;
  patch: string | null;
  viewed: ViewedState;
}

export interface PrFiles {
  pr: PrInfo;
  files: PrFile[];
  truncated: boolean;
}

export interface PrComment {
  /** Its node id; `''` from a bridge that predates it. */
  id: string;
  author: string | null;
  body: string;
  createdAt: string;
  url: string;
  /** In the viewer's own pending review, not yet submitted. */
  pending: boolean;
}

export type DiffSide = 'LEFT' | 'RIGHT';

export interface PrThread {
  id: string;
  path: string;
  line: number | null;
  /** A block's first line (`line` is its last); null on a one-line thread, and from a bridge
   * that predates it. */
  startLine: number | null;
  /** The side `line` counts on: `LEFT` the old file's numbers, `RIGHT` the new file's. */
  diffSide: DiffSide;
  /** `startLine`'s side; null without one. */
  startDiffSide: DiffSide | null;
  /** Where the thread was when written: kept on an outdated thread, whose `line` is null. */
  originalLine: number | null;
  originalStartLine: number | null;
  /** `FILE` for a comment on the whole file. */
  subjectType: 'LINE' | 'FILE';
  /** The first comment's hunk, ending at its line; `''` when none. */
  diffHunk: string;
  isResolved: boolean;
  isOutdated: boolean;
  copilot: boolean;
  comments: PrComment[];
}

export interface PrThreads {
  prUrl: string;
  threads: PrThread[];
}

const STATUSES: readonly FileStatus[] = [
  'added',
  'removed',
  'modified',
  'renamed',
  'copied',
  'changed',
  'unchanged',
];
const VIEWED: readonly ViewedState[] = ['VIEWED', 'UNVIEWED', 'DISMISSED'];
const PR_URL =
  /^https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/pull\/[0-9]+$/;
const THREAD_ID = /^PRRT_[A-Za-z0-9_-]+$/;
/** A node id the bridge checks the same way: a pending comment or review. */
export const NODE_ID = /^[A-Za-z0-9_=-]{1,200}$/;
/** A full commit id, as the bridge prints and takes it. */
export const COMMIT_SHA = /^[0-9a-f]{40}$/;
// deno-lint-ignore no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isCount = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0;

const isLine = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 1;

const side = (v: unknown): DiffSide | null =>
  v === 'LEFT' || v === 'RIGHT' ? v : null;

/** An owner or repo name, as a PR ref names them: `[A-Za-z0-9._-]`, not `.` or `..`. */
function repoName(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  const parts = v.split('/');
  return parts.length === 2 &&
    parts.every((p) => p !== '.' && p !== '..' && /^[A-Za-z0-9._-]+$/.test(p));
}

/** A path in the PR: 1 to {@link MAX_PATH} characters, no NUL and no other control character. */
export function isPrPath(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= MAX_PATH &&
    !CONTROL.test(v);
}

/** Whether `s` is over `max` UTF-8 bytes, without encoding the short ones. */
function overBytes(s: string, max: number): boolean {
  if (s.length > max) return true;
  if (s.length * 3 <= max) return false;
  return new TextEncoder().encode(s).length > max;
}

function parsePr(v: unknown): PrInfo | null {
  if (!isObj(v)) return null;
  const { repo, number, url, headSha, title, state, isDraft, author } = v;
  if (!repoName(repo)) return null;
  if (
    typeof number !== 'number' || !Number.isInteger(number) || number < 1 ||
    number > 9_999_999_999
  ) return null;
  if (typeof url !== 'string' || !PR_URL.test(url)) return null;
  if (typeof headSha !== 'string' || !/^[0-9a-fA-F]{40}$/.test(headSha)) {
    return null;
  }
  if (typeof title !== 'string') return null;
  if (state !== 'OPEN' && state !== 'CLOSED' && state !== 'MERGED') {
    return null;
  }
  if (typeof isDraft !== 'boolean') return null;
  if (author !== null && typeof author !== 'string') return null;
  for (const ref of [v.baseRef, v.headRef]) {
    if (typeof ref !== 'string' || ref.length > MAX_REF) return null;
  }
  if (!isCount(v.changedFiles)) return null;
  return {
    repo,
    number,
    url,
    headSha,
    title: title.slice(0, MAX_TITLE),
    state,
    isDraft,
    author,
    baseRef: v.baseRef as string,
    headRef: v.headRef as string,
    changedFiles: v.changedFiles,
  };
}

function parseFile(v: unknown): PrFile | null {
  if (!isObj(v)) return null;
  const { path, previousPath, additions, deletions, patch } = v;
  if (!isPrPath(path)) return null;
  if (previousPath !== null && !isPrPath(previousPath)) return null;
  if (!isCount(additions) || !isCount(deletions)) return null;
  return {
    path,
    previousPath,
    status: STATUSES.includes(v.status as FileStatus)
      ? v.status as FileStatus
      : 'modified',
    additions,
    deletions,
    patch: typeof patch === 'string' && !overBytes(patch, MAX_PATCH_BYTES)
      ? patch
      : null,
    viewed: VIEWED.includes(v.viewed as ViewedState)
      ? v.viewed as ViewedState
      : 'UNVIEWED',
  };
}

/** `gh-pr-files`' output, keeping only what the page uses; `null` when its `pr` is unusable. */
export function parsePrFiles(text: string): PrFiles | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObj(v) || !Array.isArray(v.files)) return null;
  const pr = parsePr(v.pr);
  if (pr === null) return null;
  const files: PrFile[] = [];
  const seen = new Set<string>();
  for (const raw of v.files) {
    if (files.length >= MAX_FILES) break;
    const file = parseFile(raw);
    if (file === null || seen.has(file.path)) continue;
    seen.add(file.path);
    files.push(file);
  }
  return { pr, files, truncated: v.truncated === true };
}

function parseComment(v: unknown): PrComment | null {
  if (!isObj(v)) return null;
  const { id, author, body, createdAt, url } = v;
  if (author !== null && typeof author !== 'string') return null;
  if (typeof body !== 'string' || typeof createdAt !== 'string') return null;
  if (typeof url !== 'string') return null;
  return {
    id: typeof id === 'string' && NODE_ID.test(id) ? id : '',
    author,
    body: body.slice(0, MAX_BODY_CHARS),
    createdAt,
    url: url.startsWith('https://github.com/') ? url : '',
    pending: v.pending === true,
  };
}

function parseThread(v: unknown): PrThread | null {
  if (!isObj(v)) return null;
  const {
    id,
    path,
    line,
    startLine,
    isResolved,
    isOutdated,
    copilot,
    comments,
  } = v;
  if (typeof id !== 'string' || !THREAD_ID.test(id)) return null;
  if (!isPrPath(path)) return null;
  if (
    line !== null &&
    (typeof line !== 'number' || !Number.isInteger(line) || line < 1)
  ) return null;
  if (
    typeof isResolved !== 'boolean' || typeof isOutdated !== 'boolean' ||
    typeof copilot !== 'boolean' || !Array.isArray(comments)
  ) return null;
  // Kept only as a block's start: a whole number before `line`. Anything else is a one-line
  // thread, so a bridge without the field still lists its threads.
  const start = typeof line === 'number' && isLine(startLine) &&
      startLine < line
    ? startLine
    : null;
  // The fields after `startLine` are as lenient: a bridge that predates them lists RIGHT-side,
  // one-line LINE threads with no original place.
  const originalLine = isLine(v.originalLine) ? v.originalLine : null;
  const originalStart = originalLine !== null &&
      isLine(v.originalStartLine) && v.originalStartLine < originalLine
    ? v.originalStartLine
    : null;
  const kept: PrComment[] = [];
  for (const raw of comments) {
    if (kept.length >= MAX_COMMENTS) break;
    const c = parseComment(raw);
    if (c !== null) kept.push(c);
  }
  return {
    id,
    path,
    line,
    startLine: start,
    diffSide: side(v.diffSide) ?? 'RIGHT',
    startDiffSide: start === null ? null : side(v.startDiffSide),
    originalLine,
    originalStartLine: originalStart,
    subjectType: v.subjectType === 'FILE' ? 'FILE' : 'LINE',
    diffHunk: typeof v.diffHunk === 'string'
      ? v.diffHunk.slice(0, MAX_HUNK_CHARS)
      : '',
    isResolved,
    isOutdated,
    copilot,
    comments: kept,
  };
}

/** `gh-pr-comments`' output: its PR's URL and the threads; `null` when its `pr` is unusable. */
export function parsePrThreads(text: string): PrThreads | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObj(v) || !isObj(v.pr) || !Array.isArray(v.threads)) return null;
  const url = v.pr.url;
  if (typeof url !== 'string' || !PR_URL.test(url)) return null;
  const threads: PrThread[] = [];
  const seen = new Set<string>();
  for (const raw of v.threads) {
    if (threads.length >= MAX_THREADS) break;
    const t = parseThread(raw);
    if (t === null || seen.has(t.id)) continue;
    seen.add(t.id);
    threads.push(t);
  }
  return { prUrl: url, threads };
}

/** Why `body` can't be a reply (the bridge's own rules), or null when it can. */
export function replyBodyProblem(body: string): string | null {
  if (body.trim() === '') return 'The reply is empty';
  if (new TextEncoder().encode(body).length > MAX_REPLY_BYTES) {
    return `The reply is over ${MAX_REPLY_BYTES} bytes`;
  }
  // deno-lint-ignore no-control-regex
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(body)) {
    return 'The reply has a control character other than newline and tab';
  }
  return null;
}

/** `pr.url + '/files#diff-' + sha256hex(path)`: GitHub's anchor for one file of the PR. */
export async function fileUrl(prUrl: string, path: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(path),
  );
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `${prUrl}/files#diff-${hex}`;
}

// ── the viewed history ──────────────────────────────────────────────────────────────────────

/**
 * One Viewed mark devc web made, with the PR's head when it was made: GitHub keeps only a file's
 * state, never the commit it was viewed at.
 */
export interface ViewedMark {
  path: string;
  viewed: 'VIEWED' | 'UNVIEWED';
  headSha: string;
  /** `new Date().toISOString()` when it was made. */
  at: string;
}

/**
 * Where a PR's marks are kept: `<configDir>/pr-viewed/<owner>/<name>/<number>.jsonl`, one
 * {@link ViewedMark} per line, oldest first. Keyed by the PR, so every worktree and container of
 * it shares one file. `repo` is a checked `owner/name` (no `.` or `..` segment).
 */
export function viewedHistoryFile(
  configDir: string,
  repo: string,
  number: number,
): string {
  return `${configDir}/pr-viewed/${repo}/${number}.jsonl`;
}

function parseMark(line: string): ViewedMark | null {
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isObj(v)) return null;
  const { path, viewed, headSha, at } = v;
  if (!isPrPath(path) || (viewed !== 'VIEWED' && viewed !== 'UNVIEWED')) {
    return null;
  }
  if (typeof headSha !== 'string' || !COMMIT_SHA.test(headSha)) return null;
  if (typeof at !== 'string' || Number.isNaN(Date.parse(at))) return null;
  return { path, viewed, headSha, at };
}

/** A history file's marks, oldest first; lines that aren't marks are skipped. */
export async function readViewedHistory(file: string): Promise<ViewedMark[]> {
  let text: string;
  try {
    text = await Deno.readTextFile(file);
  } catch {
    return [];
  }
  const out: ViewedMark[] = [];
  for (const line of text.split('\n')) {
    const mark = line.trim() === '' ? null : parseMark(line);
    if (mark !== null) out.push(mark);
  }
  return out;
}

/**
 * Appends `mark` to `file`, creating its directories (0700) and the file (0600). Past
 * {@link MAX_HISTORY_LINES} lines it is rewritten through a temp file, keeping the last ones.
 */
export async function appendViewedMark(
  file: string,
  mark: ViewedMark,
): Promise<void> {
  const dir = file.slice(0, file.lastIndexOf('/'));
  await Deno.mkdir(dir, { recursive: true, mode: 0o700 });
  const line = JSON.stringify({
    path: mark.path,
    viewed: mark.viewed,
    headSha: mark.headSha,
    at: mark.at,
  }) + '\n';
  await Deno.writeTextFile(file, line, { append: true, mode: 0o600 });
  const lines = (await Deno.readTextFile(file)).split('\n').filter((l) =>
    l !== ''
  );
  if (lines.length <= MAX_HISTORY_LINES) return;
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    await Deno.writeTextFile(
      tmp,
      lines.slice(-MAX_HISTORY_LINES).join('\n') + '\n',
      { mode: 0o600 },
    );
    await Deno.rename(tmp, file);
  } catch (e) {
    await Deno.remove(tmp).catch(() => {});
    throw e;
  }
}

/** `marks`' entries for a file at `path` (or renamed from `previousPath`), newest first. */
export function fileHistory(
  marks: readonly ViewedMark[],
  path: string,
  previousPath: string | null,
): ViewedMark[] {
  return marks.filter((m) => m.path === path || m.path === previousPath)
    .reverse().slice(0, MAX_HISTORY_ENTRIES);
}

// ── running a bridge command ────────────────────────────────────────────────────────────────

export type { BridgeRun, RunLimits };

/** A failed command's message: its last non-empty stderr line, at most {@link MAX_MESSAGE}. */
export function bridgeMessage(stderr: string, code: number): string {
  const lines = stderr.split('\n').map((l) => l.trim()).filter((l) => l);
  const last = lines[lines.length - 1];
  return (last ?? `devc-bridge exited ${code}`).slice(0, MAX_MESSAGE);
}

// ── the messages ────────────────────────────────────────────────────────────────────────────

/** A message's answer: `ok` with its `result`, or an error `code` and `message`. */
export type PrAnswer =
  | { ok: true; result: Record<string, unknown> }
  | { ok: false; code: 'bad_request' | 'not_found'; message: string };

export type PrMessage =
  | { type: 'pr_files'; localFolder: string; root: string }
  | { type: 'pr_diff'; localFolder: string; root: string; path: string }
  | { type: 'pr_threads'; localFolder: string; root: string; path: string }
  | {
    type: 'pr_viewed';
    localFolder: string;
    root: string;
    path: string;
    viewed: boolean;
  }
  | {
    type: 'pr_reply';
    localFolder: string;
    root: string;
    path: string;
    thread: string;
    body: string;
  }
  | {
    type: 'pr_resolve';
    localFolder: string;
    root: string;
    path: string;
    thread: string;
  }
  | {
    type: 'pr_file_at';
    localFolder: string;
    root: string;
    path: string;
    sha: string;
  }
  | { type: 'pr_pending_show'; localFolder: string; root: string }
  | {
    type: 'pr_pending_comment';
    localFolder: string;
    root: string;
    path: string;
    line: number;
    side: DiffSide;
    startLine: number | null;
    body: string;
  }
  | {
    type: 'pr_pending_reply';
    localFolder: string;
    root: string;
    thread: string;
    body: string;
  }
  | {
    type: 'pr_pending_edit';
    localFolder: string;
    root: string;
    comment: string;
    body: string;
  }
  | {
    type: 'pr_pending_delete';
    localFolder: string;
    root: string;
    comment: string;
  }
  | {
    type: 'pr_pending_submit';
    localFolder: string;
    root: string;
    body: string;
  }
  | { type: 'pr_pending_discard'; localFolder: string; root: string };

/** Every {@link PrMessage} type: what the server hands to {@link PrReview}. */
export const PR_MESSAGE_TYPES: readonly PrMessage['type'][] = [
  'pr_files',
  'pr_diff',
  'pr_threads',
  'pr_viewed',
  'pr_reply',
  'pr_resolve',
  'pr_file_at',
  'pr_pending_show',
  'pr_pending_comment',
  'pr_pending_reply',
  'pr_pending_edit',
  'pr_pending_delete',
  'pr_pending_submit',
  'pr_pending_discard',
];

export interface PrReviewDeps {
  /** Whether `root` (no trailing `/`) is one of the repos of the project at `localFolder`. */
  isRepo(localFolder: string, root: string): boolean;
  /**
   * The project's environment: its kind, and its PR backend while it runs (`pr: null` when it
   * doesn't).
   */
  environment(
    localFolder: string,
  ): Promise<{ kind: EnvironmentKind; name: string; pr: PrBackend | null }>;
  /** Where `~/.config/devc/` (the viewed history, `CONFIG_DIR`) is found. */
  home: string;
  timeoutMs?: number;
  maxOutput?: number;
}

/** One repo's stored listing, and its last thread listing. */
interface Stored {
  files: PrFiles;
  threads: PrThreads | null;
}

/** What a grant line allows, for the page. */
function offers(grants: readonly BridgeCapability[]) {
  return {
    canViewed: grants.includes('gh-pr-viewed'),
    canReply: grants.includes('gh-pr-reply'),
    canReview: grants.includes('gh-pr-pending-review'),
    resolveScope: grants.includes('gh-pr-resolve')
      ? 'any'
      : grants.includes('gh-pr-resolve-copilot')
      ? 'copilot'
      : null,
  };
}

const unavailable = (reason: string, message: string): PrAnswer => ({
  ok: true,
  result: { available: false, reason, message },
});

const dropSlash = (p: string) => p.length > 1 ? p.replace(/\/+$/, '') : p;

/** The PR review messages' state: each repo's last listing, kept while the server runs. */
export class PrReview {
  readonly #deps: PrReviewDeps;
  readonly #stored = new Map<string, Stored>();
  /** Each history file's last append, so two marks never interleave a rewrite. */
  readonly #appending = new Map<string, Promise<void>>();

  constructor(deps: PrReviewDeps) {
    this.#deps = deps;
  }

  async handle(msg: PrMessage): Promise<PrAnswer> {
    const root = dropSlash(msg.root);
    if (!this.#deps.isRepo(msg.localFolder, root)) {
      return { ok: false, code: 'bad_request', message: 'unknown repo' };
    }
    const env = await this.#deps.environment(msg.localFolder);
    if (env.pr === null) {
      return unavailable(
        'not_running',
        env.kind === 'host' ? HOST_NOT_RUNNING_MESSAGE : NOT_RUNNING_MESSAGE,
      );
    }
    const line = await env.pr.pin(root);
    if ('problem' in line) return unavailable('no_grant', line.problem);
    const ctx: Ctx = {
      key: `${msg.localFolder}\n${root}`,
      pr: env.pr,
      name: env.name,
      target: line.target,
      grants: line.grants,
    };
    switch (msg.type) {
      case 'pr_files':
        return await this.#files(ctx);
      case 'pr_diff':
        return await this.#diff(ctx, msg.path);
      case 'pr_threads':
        return await this.#threads(ctx, msg.path);
      case 'pr_viewed':
        return await this.#viewed(ctx, msg.path, msg.viewed);
      case 'pr_reply':
        return await this.#reply(ctx, msg.thread, msg.body);
      case 'pr_resolve':
        return await this.#resolve(ctx, msg.thread);
      case 'pr_file_at':
        return await this.#fileAt(ctx, msg.path, msg.sha);
      default:
        return await this.#pending(ctx, msg);
    }
  }

  /** Runs `<command> --repo <target> …args` through the environment's PR backend. */
  async #run(
    ctx: Ctx,
    command: string,
    ...args: string[]
  ): Promise<{ ok: true; stdout: string } | { ok: false; answer: PrAnswer }> {
    let run: BridgeRun;
    try {
      run = await ctx.pr.run(command, ctx.target, args, {
        timeoutMs: this.#deps.timeoutMs ?? BRIDGE_TIMEOUT_MS,
        maxOutput: this.#deps.maxOutput ?? MAX_BRIDGE_OUTPUT,
      });
    } catch (e) {
      return {
        ok: false,
        answer: unavailable(
          'bridge',
          e instanceof Error ? e.message : String(e),
        ),
      };
    }
    if (run.kind === 'timeout') {
      return {
        ok: false,
        answer: unavailable('bridge', `devc-bridge ${command} timed out`),
      };
    }
    if (run.kind === 'too_large') {
      return { ok: false, answer: unavailable('bridge', OUTPUT_TOO_LARGE) };
    }
    if (run.code !== 0) {
      return {
        ok: false,
        answer: unavailable('bridge', bridgeMessage(run.stderr, run.code)),
      };
    }
    return { ok: true, stdout: run.stdout };
  }

  /** Lists the PR's files again and stores the listing. */
  async #fetch(
    ctx: Ctx,
  ): Promise<{ ok: true; stored: Stored } | { ok: false; answer: PrAnswer }> {
    const out = await this.#run(ctx, 'gh-pr-files');
    if (!out.ok) return out;
    const files = parsePrFiles(out.stdout);
    if (files === null) {
      return { ok: false, answer: unavailable('bridge', UNEXPECTED_OUTPUT) };
    }
    const old = this.#stored.get(ctx.key);
    const stored: Stored = {
      files,
      threads: old?.threads?.prUrl === files.pr.url ? old.threads : null,
    };
    this.#stored.delete(ctx.key);
    this.#stored.set(ctx.key, stored);
    while (this.#stored.size > MAX_LISTINGS) {
      this.#stored.delete(this.#stored.keys().next().value!);
    }
    return { ok: true, stored };
  }

  async #listing(
    ctx: Ctx,
  ): Promise<{ ok: true; stored: Stored } | { ok: false; answer: PrAnswer }> {
    const stored = this.#stored.get(ctx.key);
    return stored ? { ok: true, stored } : await this.#fetch(ctx);
  }

  async #files(ctx: Ctx): Promise<PrAnswer> {
    const got = await this.#fetch(ctx);
    if (!got.ok) return got.answer;
    const { pr, files, truncated } = got.stored.files;
    return {
      ok: true,
      result: {
        available: true,
        container: ctx.name,
        pr,
        files: files.map(({ patch: _, ...f }) => f),
        truncated,
        ...offers(ctx.grants),
      },
    };
  }

  async #diff(ctx: Ctx, path: string): Promise<PrAnswer> {
    const got = await this.#listing(ctx);
    if (!got.ok) return got.answer;
    const { pr, files } = got.stored.files;
    const file = files.find((f) => f.path === path);
    if (!file) return { ok: false, code: 'not_found', message: FILE_GONE };
    const marks = await readViewedHistory(this.#historyFile(pr));
    return {
      ok: true,
      result: {
        available: true,
        container: ctx.name,
        pr,
        file,
        fileUrl: await fileUrl(pr.url, path),
        viewedHistory: fileHistory(marks, file.path, file.previousPath),
        ...offers(ctx.grants),
      },
    };
  }

  #historyFile(pr: PrInfo): string {
    return viewedHistoryFile(
      `${this.#deps.home}/.config/devc`,
      pr.repo,
      pr.number,
    );
  }

  /** Records a mark; a failure to write it is logged, never the mark's failure. */
  async #record(pr: PrInfo, mark: ViewedMark): Promise<void> {
    const file = this.#historyFile(pr);
    const next = (this.#appending.get(file) ?? Promise.resolve())
      .then(() => appendViewedMark(file, mark))
      .catch((e) =>
        console.error(`devc web: recording a Viewed mark in ${file}: ${e}`)
      );
    this.#appending.set(file, next);
    await next;
    if (this.#appending.get(file) === next) this.#appending.delete(file);
  }

  async #threads(ctx: Ctx, path: string): Promise<PrAnswer> {
    const got = await this.#listing(ctx);
    if (!got.ok) return got.answer;
    const out = await this.#run(ctx, 'gh-pr-comments', '--state', 'all');
    if (!out.ok) return out.answer;
    const threads = parsePrThreads(out.stdout);
    if (threads === null) return unavailable('bridge', UNEXPECTED_OUTPUT);
    if (threads.prUrl !== got.stored.files.pr.url) {
      return unavailable(
        'other_pr',
        `The bridge reports a different PR: ${threads.prUrl}`,
      );
    }
    got.stored.threads = threads;
    return {
      ok: true,
      result: {
        available: true,
        container: ctx.name,
        threads: threads.threads.filter((t) => t.path === path),
      },
    };
  }

  async #viewed(ctx: Ctx, path: string, viewed: boolean): Promise<PrAnswer> {
    const missing = needs(ctx, 'gh-pr-viewed');
    if (missing) return missing;
    const listing = this.#stored.get(ctx.key)?.files;
    const file = listing?.files.find((f) => f.path === path);
    if (!listing || !file) {
      return { ok: false, code: 'not_found', message: FILE_GONE };
    }
    const out = await this.#run(
      ctx,
      'gh-pr-viewed',
      viewed ? 'viewed' : 'unviewed',
      path,
    );
    if (!out.ok) return out.answer;
    let v: unknown;
    try {
      v = JSON.parse(out.stdout);
    } catch { /* checked below */ }
    if (
      !isObj(v) || v.path !== path ||
      (v.viewed !== 'VIEWED' && v.viewed !== 'UNVIEWED')
    ) return unavailable('bridge', UNEXPECTED_OUTPUT);
    file.viewed = v.viewed;
    // A bridge that predates headSha still marks: there is just nothing to record.
    if (typeof v.headSha === 'string' && COMMIT_SHA.test(v.headSha)) {
      await this.#record(listing.pr, {
        path,
        viewed: v.viewed,
        headSha: v.headSha,
        at: new Date().toISOString(),
      });
    }
    return { ok: true, result: { path, viewed: v.viewed } };
  }

  /** The file at a commit (`gh-pr-file-at`): `path` is a listed file's path or previous path. */
  async #fileAt(ctx: Ctx, path: string, sha: string): Promise<PrAnswer> {
    if (!COMMIT_SHA.test(sha)) {
      return { ok: false, code: 'bad_request', message: 'bad commit id' };
    }
    const got = await this.#listing(ctx);
    if (!got.ok) return got.answer;
    const known = got.stored.files.files.some((f) =>
      f.path === path || f.previousPath === path
    );
    if (!known) return { ok: false, code: 'not_found', message: FILE_GONE };
    const out = await this.#run(ctx, 'gh-pr-file-at', sha, path);
    if (!out.ok) return out.answer;
    return fileAtAnswer(out.stdout, path, sha);
  }

  /** The `pr_pending_*` messages: one `gh-pr-pending-review` subcommand each. */
  async #pending(
    ctx: Ctx,
    msg: Exclude<
      PrMessage,
      {
        type:
          | 'pr_files'
          | 'pr_diff'
          | 'pr_threads'
          | 'pr_viewed'
          | 'pr_reply'
          | 'pr_resolve'
          | 'pr_file_at';
      }
    >,
  ): Promise<PrAnswer> {
    const missing = needs(ctx, 'gh-pr-pending-review');
    if (missing) return missing;
    const bad = (message: string): PrAnswer => ({
      ok: false,
      code: 'bad_request',
      message,
    });
    const body = 'body' in msg ? msg.body : '';
    if (msg.type !== 'pr_pending_submit' || body !== '') {
      const problem = 'body' in msg ? replyBodyProblem(body) : null;
      if (problem) return bad(problem);
    }
    let args: string[];
    switch (msg.type) {
      case 'pr_pending_show':
        args = ['show'];
        break;
      case 'pr_pending_comment': {
        const got = await this.#listing(ctx);
        if (!got.ok) return got.answer;
        if (!got.stored.files.files.some((f) => f.path === msg.path)) {
          return { ok: false, code: 'not_found', message: FILE_GONE };
        }
        if (!isLine(msg.line)) return bad('bad line');
        if (
          msg.startLine !== null &&
          (!isLine(msg.startLine) || msg.startLine >= msg.line)
        ) return bad('bad start line');
        args = [
          '--as',
          'human',
          'comment',
          msg.path,
          String(msg.line),
          msg.side,
          ...(msg.startLine === null ? [] : ['--start', String(msg.startLine)]),
          body,
        ];
        break;
      }
      case 'pr_pending_reply':
        if (!this.#thread(ctx, msg.thread)) {
          return { ok: false, code: 'not_found', message: THREAD_GONE };
        }
        args = ['--as', 'human', 'reply', msg.thread, body];
        break;
      case 'pr_pending_edit':
        if (!NODE_ID.test(msg.comment)) return bad('bad comment id');
        args = ['--as', 'human', 'edit', msg.comment, body];
        break;
      case 'pr_pending_delete':
        if (!NODE_ID.test(msg.comment)) return bad('bad comment id');
        args = ['delete', msg.comment];
        break;
      case 'pr_pending_submit':
        args = [
          '--as',
          'human',
          'submit',
          ...(body === '' ? [] : ['--body', body]),
        ];
        break;
      case 'pr_pending_discard':
        args = ['discard'];
        break;
    }
    const out = await this.#run(ctx, 'gh-pr-pending-review', ...args);
    return out.ok ? pendingAnswer(out.stdout) : out.answer;
  }

  #thread(ctx: Ctx, id: string): PrThread | null {
    return this.#stored.get(ctx.key)?.threads?.threads.find((t) =>
      t.id === id
    ) ?? null;
  }

  async #reply(ctx: Ctx, thread: string, body: string): Promise<PrAnswer> {
    const missing = needs(ctx, 'gh-pr-reply');
    if (missing) return missing;
    const problem = replyBodyProblem(body);
    if (problem) return { ok: false, code: 'bad_request', message: problem };
    if (!this.#thread(ctx, thread)) {
      return { ok: false, code: 'not_found', message: THREAD_GONE };
    }
    const out = await this.#run(
      ctx,
      'gh-pr-reply',
      '--as',
      'human',
      thread,
      body,
    );
    return out.ok ? { ok: true, result: {} } : out.answer;
  }

  async #resolve(ctx: Ctx, id: string): Promise<PrAnswer> {
    const any = ctx.grants.includes('gh-pr-resolve');
    if (!any && !ctx.grants.includes('gh-pr-resolve-copilot')) {
      return needs(ctx, 'gh-pr-resolve')!;
    }
    const thread = this.#thread(ctx, id);
    if (!thread) return { ok: false, code: 'not_found', message: THREAD_GONE };
    if (thread.isResolved) {
      return { ok: false, code: 'bad_request', message: 'Already resolved' };
    }
    if (!any && !thread.copilot) {
      return {
        ok: false,
        code: 'bad_request',
        message:
          "This container may resolve only Copilot's threads (gh-pr-resolve-copilot)",
      };
    }
    const out = await this.#run(ctx, 'gh-pr-resolve', id);
    if (!out.ok) return out.answer;
    thread.isResolved = true;
    return { ok: true, result: {} };
  }
}

/** A `gh-pr-file-at` answer: the text, or why there is none. */
function fileAtAnswer(
  stdout: string,
  path: string,
  sha: string,
): PrAnswer {
  let v: unknown;
  try {
    v = JSON.parse(stdout);
  } catch { /* checked below */ }
  if (!isObj(v) || v.path !== path || v.sha !== sha) {
    return unavailable('bridge', UNEXPECTED_OUTPUT);
  }
  if (typeof v.content === 'string') {
    if (v.content.length > MAX_FILE_CHARS) {
      return unavailable('too_large', FILE_AT_TOO_LARGE);
    }
    return {
      ok: true,
      result: { available: true, path, sha, text: v.content },
    };
  }
  if (v.missing === true) return unavailable('missing', FILE_AT_MISSING);
  if (v.binary === true) return unavailable('binary', FILE_AT_BINARY);
  if (v.tooLarge === true) return unavailable('too_large', FILE_AT_TOO_LARGE);
  return unavailable('bridge', UNEXPECTED_OUTPUT);
}

/** A `gh-pr-pending-review` answer passed through: one object of ids (and a url). */
function pendingAnswer(stdout: string): PrAnswer {
  let v: unknown;
  try {
    v = JSON.parse(stdout);
  } catch { /* checked below */ }
  if (!isObj(v)) return unavailable('bridge', UNEXPECTED_OUTPUT);
  const result: Record<string, unknown> = { available: true };
  for (const key of ['review', 'thread', 'comment'] as const) {
    if (!(key in v)) continue;
    const id = v[key];
    if (key === 'review' && id === null) result.review = null;
    else if (key === 'review' && isObj(id)) {
      if (
        typeof id.id !== 'string' || !NODE_ID.test(id.id) ||
        !isCount(id.comments)
      ) return unavailable('bridge', UNEXPECTED_OUTPUT);
      result.review = { id: id.id, comments: id.comments };
    } else if (typeof id === 'string' && NODE_ID.test(id)) result[key] = id;
    else return unavailable('bridge', UNEXPECTED_OUTPUT);
  }
  if ('url' in v) {
    if (typeof v.url !== 'string' || !v.url.startsWith('https://github.com/')) {
      return unavailable('bridge', UNEXPECTED_OUTPUT);
    }
    result.url = v.url;
  }
  return { ok: true, result };
}

interface Ctx {
  key: string;
  pr: PrBackend;
  name: string;
  target: string;
  grants: BridgeCapability[];
}

/** The backstop refusal for a write whose grant is missing, or null when it is there. */
function needs(ctx: Ctx, cap: BridgeCapability): PrAnswer | null {
  return ctx.grants.includes(cap) ? null : {
    ok: false,
    code: 'bad_request',
    message: `Needs --bridge-allow ${cap} on this repo`,
  };
}
