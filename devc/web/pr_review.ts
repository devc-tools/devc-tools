// `devc web`'s pull request review: the PR of a repo's pinned branch, its changed files with
// GitHub's Viewed state, each file's patch, and its review threads, plus marking Viewed, replying
// and resolving. See `.plans/devc-web-pr-review.md`.
//
// **Every GitHub call is a `devc-bridge` command run in the project's running container**
// (`docker exec … devc-bridge gh-pr-* --repo <target> …`, argv only, never a shell). devc web
// never runs `gh`: the page can already type into a terminal in that container, so running the
// same bridge commands adds no reach, where host `gh` would.
//
// **Grants are read from the host-only policy on every message** (`readPolicy`, keyed by
// `projectKey(localFolder)`), never cached and never taken from the container: they decide which
// commands are offered and which are refused here, ahead of the bridge's own check. Each line
// carries its own grants, so a repo is offered only what the line pinning it grants.
//
// **The bridge's output passes through the container, so it is untrusted** (a container could
// shadow `devc-bridge` on its own `PATH`). Every listing is parsed defensively, with caps, and
// the page shows it as text only.

import type { ContainerInfo } from '@devc-tools/core/container.ts';
import { dockerExecArgv } from '@devc-tools/core/container.ts';
import type { BridgeCapability } from '@devc-tools/core/bridge.ts';
import { projectKey } from '@devc-tools/core/merged_config.ts';
import {
  displayPath,
  resolveGlobalConfigPath,
} from '@devc-tools/core/config.ts';
import { readPolicy } from '../bridge.ts';

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
/** The longest stderr line a `bridge` result carries. */
const MAX_MESSAGE = 300;
/** How much stderr is kept, for its last line. */
const MAX_STDERR = 64 * 1024;

export const NOT_RUNNING_MESSAGE =
  'Start the container to see its pull request';
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
  author: string | null;
  body: string;
  createdAt: string;
  url: string;
}

export interface PrThread {
  id: string;
  path: string;
  line: number | null;
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
// deno-lint-ignore no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isCount = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0;

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
  const { author, body, createdAt, url } = v;
  if (author !== null && typeof author !== 'string') return null;
  if (typeof body !== 'string' || typeof createdAt !== 'string') return null;
  if (typeof url !== 'string') return null;
  return {
    author,
    body: body.slice(0, MAX_BODY_CHARS),
    createdAt,
    url: url.startsWith('https://github.com/') ? url : '',
  };
}

function parseThread(v: unknown): PrThread | null {
  if (!isObj(v)) return null;
  const { id, path, line, isResolved, isOutdated, copilot, comments } = v;
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

// ── running a bridge command ────────────────────────────────────────────────────────────────

export type BridgeRun =
  | { kind: 'exit'; code: number; stdout: string; stderr: string }
  | { kind: 'timeout' }
  | { kind: 'too_large' };

export interface RunLimits {
  timeoutMs: number;
  maxOutput: number;
}

/**
 * `docker args…` (`args` from `dockerExecArgv`), with no stdin: killed after `timeoutMs`, or as
 * soon as its stdout passes `maxOutput` bytes. `docker` is the command to run (tests stub it).
 */
export async function runBridge(
  args: string[],
  limits: RunLimits,
  docker = 'docker',
): Promise<BridgeRun> {
  const child = new Deno.Command(docker, {
    args,
    stdin: 'null',
    stdout: 'piped',
    stderr: 'piped',
  }).spawn();
  const out = child.stdout.getReader();
  const err = child.stderr.getReader();
  let ended: 'timeout' | 'too_large' | null = null;
  // Killed, the command's own children may still hold its pipes open: stop reading them.
  const kill = (why: 'timeout' | 'too_large') => {
    if (ended !== null) return;
    ended = why;
    try {
      child.kill('SIGKILL');
    } catch { /* already exited */ }
    out.cancel().catch(() => {});
    err.cancel().catch(() => {});
  };
  const timer = setTimeout(() => kill('timeout'), limits.timeoutMs);
  const readOut = async () => {
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await out.read().catch(() => ({
        done: true,
        value: undefined,
      }));
      if (done || value === undefined || ended !== null) break;
      size += value.length;
      if (size > limits.maxOutput) {
        kill('too_large');
        break;
      }
      chunks.push(value);
    }
    if (ended !== null) return '';
    const bytes = new Uint8Array(size);
    let at = 0;
    for (const c of chunks) {
      bytes.set(c, at);
      at += c.length;
    }
    return new TextDecoder().decode(bytes);
  };
  const readErr = async () => {
    let text = '';
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await err.read().catch(() => ({
        done: true,
        value: undefined,
      }));
      if (done || value === undefined) break;
      text += decoder.decode(value, { stream: true });
      if (text.length > MAX_STDERR) text = text.slice(-MAX_STDERR);
    }
    return text;
  };
  try {
    const [stdout, stderr, status] = await Promise.all([
      readOut(),
      readErr(),
      child.status,
    ]);
    if (ended !== null) return { kind: ended };
    return { kind: 'exit', code: status.code, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

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
  };

export interface PrReviewDeps {
  /** Whether `root` (no trailing `/`) is one of the repos of the project at `localFolder`. */
  isRepo(localFolder: string, root: string): boolean;
  /** The project's running container, `null` when none runs. */
  container(
    localFolder: string,
  ): Promise<{ info: ContainerInfo; name: string } | null>;
  /** Where `~/.config/devc-bridge/` is found (the policy). */
  home: string;
  /** The `docker` command (tests stub it). */
  docker?: string;
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

  constructor(deps: PrReviewDeps) {
    this.#deps = deps;
  }

  async handle(msg: PrMessage): Promise<PrAnswer> {
    const root = dropSlash(msg.root);
    if (!this.#deps.isRepo(msg.localFolder, root)) {
      return { ok: false, code: 'bad_request', message: 'unknown repo' };
    }
    const container = await this.#deps.container(msg.localFolder);
    if (container === null) {
      return unavailable('not_running', NOT_RUNNING_MESSAGE);
    }
    const line = await this.#grantLine(msg.localFolder, root);
    if (line === null) {
      const configPath = await resolveGlobalConfigPath(
        `${this.#deps.home}/.config/devc`,
      );
      return unavailable('no_grant', noGrantMessage(configPath));
    }
    const ctx: Ctx = {
      key: `${msg.localFolder}\n${root}`,
      info: container.info,
      name: container.name,
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
    }
  }

  /** The policy line pinning `root`, read now, when that line grants `gh-pr-read`. */
  async #grantLine(
    localFolder: string,
    root: string,
  ): Promise<{ target: string; grants: BridgeCapability[] } | null> {
    let policy;
    try {
      policy = await readPolicy(await projectKey(localFolder), {
        home: this.#deps.home,
      });
    } catch {
      return null;
    }
    if (policy.kind !== 'present') return null;
    // Grants are per line: the line pinning `root` decides, never another repo's.
    const pinned = policy.record.repos.find((r) => dropSlash(r.repo) === root);
    if (pinned === undefined || !pinned.grants.includes('gh-pr-read')) {
      return null;
    }
    return { target: pinned.target, grants: pinned.grants };
  }

  /** Runs `devc-bridge <command> --repo <target> …args` in the container. */
  async #run(
    ctx: Ctx,
    command: string,
    ...args: string[]
  ): Promise<{ ok: true; stdout: string } | { ok: false; answer: PrAnswer }> {
    const argv = dockerExecArgv(ctx.info, {
      cwd: '/',
      cmd: ['devc-bridge', command, '--repo', ctx.target, ...args],
    });
    let run: BridgeRun;
    try {
      run = await runBridge(argv, {
        timeoutMs: this.#deps.timeoutMs ?? BRIDGE_TIMEOUT_MS,
        maxOutput: this.#deps.maxOutput ?? MAX_BRIDGE_OUTPUT,
      }, this.#deps.docker);
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
    return {
      ok: true,
      result: {
        available: true,
        container: ctx.name,
        pr,
        file,
        fileUrl: await fileUrl(pr.url, path),
        ...offers(ctx.grants),
      },
    };
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
    const file = this.#stored.get(ctx.key)?.files.files.find((f) =>
      f.path === path
    );
    if (!file) return { ok: false, code: 'not_found', message: FILE_GONE };
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
    return { ok: true, result: { path, viewed: v.viewed } };
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
    const out = await this.#run(ctx, 'gh-pr-reply', thread, body);
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

interface Ctx {
  key: string;
  info: ContainerInfo;
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
