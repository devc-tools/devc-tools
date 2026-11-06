// Each repo folder's push/pull state for the `devc web` sidebar: how far its checked-out branch
// is ahead of (to push) and behind (to pull) its upstream, with a periodic fetch so the second
// count stays current.
//
// The folders are on the host, but agents in containers can write to them. A hook,
// `core.fsmonitor`, `core.sshCommand` or `insteadOf` planted in a repo runs on any
// `git -C <repo> …`, and devc's read-only `.git/config` mount can silently stop covering a
// file the host rewrites. So, as devc-bridge's `gh-push` does, **the host never runs git in a
// repo**. `git_repo.ts` reads its HEAD and upstream as data. Its branch and remote-tracking ref
// are *fetched from it* into a host-owned bare mirror, one per remote URL (git trusts nothing
// in the config of a repo it fetches from). The remote is fetched into the same mirror, and
// every count runs there. A Fetch from the page (`git_fetch.ts`) hands the repo a bundle of the
// mirror's upstream branch, which the repo's own git fetches inside its environment.

import { join } from 'jsr:@std/path';
import {
  isFetchableRemote,
  readBranch,
  readRemoteUrl,
  readUpstream,
  resolveRepo,
  type Upstream,
} from './git_repo.ts';

/** A folder's branch and how it compares with its upstream. */
export interface GitStatus {
  branch: string;
  /** `<remote>/<branch>`; `null` when the branch tracks nothing. */
  upstream: string | null;
  /** Commits to push. */
  ahead: number;
  /** Commits to pull: on the newer upstream copy (the repo's or the mirror's), not in the branch. */
  behind: number;
  /** The upstream is configured but neither the repo nor a fetch has its branch. */
  gone: boolean;
  /**
   * Of `behind`, those the repo's own remote-tracking ref lacks: a Fetch (`git_fetch.ts`) brings
   * them in. `behind - unfetched` are in the repo, ready to pull.
   */
  unfetched: number;
  /**
   * A push would create its remote branch: the branch tracks nothing and `origin/<branch>` is
   * neither in the repo's remote-tracking refs nor on the remote as last looked. Absent: `false`.
   */
  pushCreates?: boolean;
}

/**
 * Why a folder that is a repo has no {@link GitStatus}: `detached HEAD`, `git fetch: timed out`,
 * or `git <subcommand>: <git's first stderr line>`. Shown in the sidebar's tooltip.
 */
export interface GitProblem {
  problem: string;
}

/** What a read of one folder gives: its status, why it has none, or `null` when it is no repo. */
export type GitReading = GitStatus | GitProblem | null;

export function isGitProblem(r: object | null | undefined): r is GitProblem {
  return r != null && 'problem' in r;
}

/**
 * Where the mirrors live, and which remotes may be fetched (tests widen it to local paths).
 * `localFetchTimeoutMs` bounds each fetch from the folder (tests shorten it).
 */
export interface MirrorOpts {
  root: string;
  fetchable?: (url: string) => boolean;
  localFetchTimeoutMs?: number;
}

export function defaultMirrorOpts(): MirrorOpts {
  const home = Deno.env.get('HOME') ?? '';
  return { root: `${home}/.cache/devc/web/git` };
}

const GIT_ENV = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  SSH_ASKPASS_REQUIRE: 'never',
};

/** A git call's output, or why it failed, as a {@link GitProblem}'s text. */
export type GitRun = { out: string } | { failed: string };

/** Runs git with no repo of its own (`cwd: /`). Never throws. */
export async function run(
  args: string[],
  timeoutMs = 10_000,
): Promise<GitRun> {
  const sub = args.find((a) => !a.startsWith('--git-dir=')) ?? '';
  const signal = AbortSignal.timeout(timeoutMs);
  const timedOut = { failed: `git ${sub}: timed out` };
  try {
    const out = await new Deno.Command('git', {
      args,
      cwd: '/',
      env: GIT_ENV,
      stdin: 'null',
      stdout: 'piped',
      stderr: 'piped',
      signal,
    }).output();
    if (out.success) return { out: new TextDecoder().decode(out.stdout) };
    // The timeout kills git, and `output()` resolves with that failure rather than throwing.
    if (signal.aborted) return timedOut;
    const line = new TextDecoder().decode(out.stderr).split('\n')
      .map((l) => l.trim()).find((l) => l);
    return { failed: line ? `git ${sub}: ${line}` : `git ${sub} failed` };
  } catch {
    return signal.aborted ? timedOut : { failed: `git ${sub} failed` };
  }
}

/** Runs git with no repo of its own (`cwd: /`); `null` when it fails. Never throws. */
async function git(args: string[], timeoutMs = 10_000): Promise<string | null> {
  const r = await run(args, timeoutMs);
  return 'out' in r ? r.out : null;
}

export async function hash(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest).slice(0, 8)]
    .map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The bare mirror for `url`, created (with no hooks) if missing. */
export async function mirrorFor(
  opts: MirrorOpts,
  url: string,
): Promise<string | null> {
  const dir = join(opts.root, `${await hash(url)}.git`);
  try {
    if ((await Deno.stat(dir)).isDirectory) return dir;
  } catch { /* create it */ }
  // Built under a temp name and renamed in, so an interrupted setup leaves no half-made mirror.
  const staging = `${dir}.tmp.${crypto.randomUUID()}`;
  try {
    await Deno.mkdir(opts.root, { recursive: true });
    if (await git(['init', '-q', '--bare', '--template=', staging]) === null) {
      return null;
    }
    await Deno.rename(staging, dir);
  } catch {
    await Deno.remove(staging, { recursive: true }).catch(() => {});
    try {
      if ((await Deno.stat(dir)).isDirectory) return dir;
    } catch { /* fall through */ }
    return null;
  }
  return dir;
}

/** What one folder's branch needs in its mirror. */
export interface Located {
  branch: string;
  /** The repo's git common dir: its config and refs. */
  commonDir: string;
  upstream: Upstream | null;
  mirror: string | null;
  /** This folder and branch's refs in the mirror. */
  prefix: string;
}

export async function locate(
  folder: string,
  opts: MirrorOpts,
): Promise<Located | GitProblem | null> {
  const dirs = await resolveRepo(folder);
  if (dirs === null) return null;
  const branch = await readBranch(dirs.gitDir);
  if (branch === null) return { problem: 'detached HEAD' };
  const upstream = await readUpstream(dirs.commonDir, branch);
  return {
    branch,
    commonDir: dirs.commonDir,
    upstream,
    mirror: upstream === null ? null : await mirrorFor(opts, upstream.url),
    prefix: `refs/devc/${await hash(`${folder}\0${branch}`)}`,
  };
}

export const FETCH_FLAGS = [
  'fetch',
  '--quiet',
  '--no-tags',
  '--no-write-fetch-head',
  '--no-recurse-submodules',
];

/**
 * How long a fetch from the folder may take. Into a cold mirror it copies the branch's whole
 * history, and a killed fetch keeps nothing, so a short limit would fail on every pass. A local
 * fetch has no network or prompt to wait on: this only guards against a hang.
 */
export const LOCAL_FETCH_TIMEOUT_MS = 10 * 60_000;

/**
 * The mirror's copies of a branch's upstream: `fetched` from the remote, `tracked` from the repo's
 * own remote-tracking ref, and `against`, the newer of the two, which the counts compare with.
 */
export async function upstreamCopies(mirror: string, prefix: string) {
  const inMirror = (...args: string[]) => git([`--git-dir=${mirror}`, ...args]);
  const refs = new Set(
    (await inMirror('for-each-ref', '--format=%(refname)', `${prefix}/`) ?? '')
      .split('\n').filter((r) => r),
  );
  const fetched = refs.has(`${prefix}/upstream`) ? `${prefix}/upstream` : null;
  const tracked = refs.has(`${prefix}/tracking`) ? `${prefix}/tracking` : null;
  let against = fetched ?? tracked;
  if (fetched !== null && tracked !== null) {
    const fetchedIsOlder =
      await inMirror('merge-base', '--is-ancestor', fetched, tracked) !== null;
    against = fetchedIsOlder ? tracked : fetched;
  }
  return { against, fetched, tracked };
}

/**
 * `folder`'s status, or `null` when it is no repo. A detached HEAD, or a branch that can't be
 * fetched from the folder or counted, gives a {@link GitProblem} instead. Fetches the branch and its remote-tracking ref from the
 * folder into the mirror, then counts against whichever upstream copy is newer: the repo's own
 * (after a push or the editor's fetch) or the mirror's (after {@link fetchUpstream}). Never
 * throws.
 */
export async function readGitState(
  folder: string,
  opts: MirrorOpts = defaultMirrorOpts(),
): Promise<GitReading> {
  const at = await locate(folder, opts);
  if (at === null || isGitProblem(at)) return at;
  const { branch, upstream, mirror, prefix } = at;
  if (upstream === null) {
    // `ahead`: what a push would send, so the ↑ mark shows on a `gh-push` branch too.
    const unpushed = await unpushedCount(folder, at, opts);
    if ('problem' in unpushed) return unpushed;
    return {
      branch,
      upstream: null,
      ahead: unpushed.ahead,
      behind: 0,
      gone: false,
      unfetched: 0,
      pushCreates: unpushed.ahead > 0 && !unpushed.onRemote,
    };
  }
  if (mirror === null) return { problem: 'could not create the git mirror' };
  const inMirror = (...args: string[]) => git([`--git-dir=${mirror}`, ...args]);
  const fetchFrom = (...refspecs: string[]) =>
    run(
      [`--git-dir=${mirror}`, ...FETCH_FLAGS, folder, ...refspecs],
      opts.localFetchTimeoutMs ?? LOCAL_FETCH_TIMEOUT_MS,
    );
  const local = `+refs/heads/${branch}:${prefix}/local`;
  const tracking = upstream.trackingRef === null
    ? null
    : `+${upstream.trackingRef}:${prefix}/tracking`;
  const both = tracking === null ? null : await fetchFrom(local, tracking);
  if (
    both !== null && 'failed' in both && both.failed.endsWith(': timed out')
  ) {
    // It would time out again: retrying only doubles the wait.
    return { problem: both.failed };
  }
  if (both === null || 'failed' in both) {
    // No remote-tracking ref in the repo (never fetched, or the branch was deleted): fetch
    // just the branch, and forget a stale copy of the ref.
    const alone = await fetchFrom(local);
    if ('failed' in alone) return { problem: alone.failed };
    await inMirror('update-ref', '-d', `${prefix}/tracking`);
  }
  const name = `${upstream.remote}/${upstream.branch}`;
  const { against, fetched, tracked } = await upstreamCopies(mirror, prefix);
  if (against === null) {
    return {
      branch,
      upstream: name,
      ahead: 0,
      behind: 0,
      gone: true,
      unfetched: 0,
    };
  }
  const counts = await run([
    `--git-dir=${mirror}`,
    'rev-list',
    '--left-right',
    '--count',
    `${prefix}/local...${against}`,
  ]);
  if ('failed' in counts) return { problem: counts.failed };
  const [ahead, behind] = counts.out.trim().split(/\s+/).map(Number);
  if (!Number.isInteger(ahead) || !Number.isInteger(behind)) {
    return { problem: 'git rev-list: unexpected output' };
  }
  // Counted only when the mirror's copy is the newer one; a branch that tracks a URL has no
  // remote-tracking ref to fetch into.
  let unfetched = 0;
  if (against === fetched && upstream.trackingRef !== null && behind > 0) {
    const n = await run([
      `--git-dir=${mirror}`,
      'rev-list',
      '--count',
      against,
      `^${prefix}/local`,
      ...(tracked === null ? [] : [`^${tracked}`]),
    ]);
    if ('failed' in n) return { problem: n.failed };
    unfetched = Number(n.out.trim());
    if (!Number.isInteger(unfetched)) {
      return { problem: 'git rev-list: unexpected output' };
    }
  }
  return { branch, upstream: name, ahead, behind, gone: false, unfetched };
}

/** {@link readGitState} without the reason: `null` for no status at all. Never throws. */
export async function readGitStatus(
  folder: string,
  opts: MirrorOpts = defaultMirrorOpts(),
): Promise<GitStatus | null> {
  const r = await readGitState(folder, opts);
  return isGitProblem(r) ? null : r;
}

const FETCH_TIMEOUT_MS = 60_000;

/** How long one look at the remote may hold back the answer. */
const REMOTE_CHECK_TIMEOUT_MS = 15_000;

/**
 * For a branch with nothing upstream to compare with: copies the repo's remote-tracking refs into
 * the mirror, and looks for the branch on the remote, which is how a `gh-push` shows, as the repo's
 * own refs never hear of it. Returns the refs to exclude and the label for them.
 */
export async function pushedRefs(
  folder: string,
  mirror: string,
  prefix: string,
  upstream: Upstream | null,
  originUrl: string | null,
  branch: string,
  opts: MirrorOpts & { checkRemote?: boolean },
): Promise<{ excludes: string[]; compare: string | null; onRemote: boolean }> {
  const inMirror = (...args: string[]) => [`--git-dir=${mirror}`, ...args];
  const copies = `${prefix}/remotes`;
  const pushedRef = `${prefix}/pushed`;
  // Prunes only under its own refspec, so a remote branch deleted from the repo goes here too.
  await run(
    inMirror(...FETCH_FLAGS, '--prune', folder, `+refs/remotes/*:${copies}/*`),
    opts.localFetchTimeoutMs ?? LOCAL_FETCH_TIMEOUT_MS,
  );
  const remoteBranch = upstream?.branch ?? branch;
  if (
    opts.checkRemote && originUrl !== null &&
    (opts.fetchable ?? isFetchableRemote)(originUrl)
  ) {
    const r = await run(
      inMirror(
        ...FETCH_FLAGS,
        originUrl,
        `+refs/heads/${remoteBranch}:${pushedRef}`,
      ),
      REMOTE_CHECK_TIMEOUT_MS,
    );
    // Off the remote now, so no longer pushed there. Any other failure (no network) says nothing,
    // so what was seen last stands.
    if ('failed' in r && /couldn't find remote ref/.test(r.failed)) {
      await run(inMirror('update-ref', '-d', pushedRef));
    }
  }
  const listed = await run(
    inMirror('for-each-ref', '--format=%(refname)', `${prefix}/`),
  );
  const refs = 'out' in listed ? listed.out.split('\n').filter((r) => r) : [];
  const excludes = refs.filter((r) =>
    r === pushedRef || r.startsWith(`${copies}/`)
  );
  const compare = refs.includes(pushedRef)
    ? `${upstream?.remote ?? 'origin'}/${remoteBranch}`
    : excludes.length
    ? 'remote branches'
    : null;
  const remote = upstream?.remote ?? 'origin';
  const onRemote = refs.includes(pushedRef) ||
    refs.includes(`${copies}/${remote}/${remoteBranch}`);
  return { excludes, compare, onRemote };
}

/**
 * A branch with no upstream: its commits on no remote branch the host knows of (the repo's own
 * remote-tracking refs, and `origin/<branch>` as last found on the remote), counted in the mirror
 * named for `origin`. The Commits section's `localTotal` for the same branch. `0` with no `origin`:
 * there is nowhere to push. `checkRemote` allows the look at the remote (a network call).
 * `onRemote`: `origin/<branch>` exists, so a push updates it rather than creating it.
 */
async function unpushedCount(
  folder: string,
  at: Located,
  opts: MirrorOpts & { checkRemote?: boolean },
): Promise<{ ahead: number; onRemote: boolean } | GitProblem> {
  const originUrl = await readRemoteUrl(at.commonDir, 'origin');
  if (originUrl === null) return { ahead: 0, onRemote: false };
  const mirror = await mirrorFor(opts, originUrl);
  if (mirror === null) return { problem: 'could not create the git mirror' };
  const local = `${at.prefix}/local`;
  const fetched = await run(
    [
      `--git-dir=${mirror}`,
      ...FETCH_FLAGS,
      folder,
      `+refs/heads/${at.branch}:${local}`,
    ],
    opts.localFetchTimeoutMs ?? LOCAL_FETCH_TIMEOUT_MS,
  );
  if ('failed' in fetched) return { problem: fetched.failed };
  const { excludes, onRemote } = await pushedRefs(
    folder,
    mirror,
    at.prefix,
    null,
    originUrl,
    at.branch,
    opts,
  );
  const r = await run([
    `--git-dir=${mirror}`,
    'rev-list',
    '--count',
    local,
    ...(excludes.length ? ['--not', ...excludes] : []),
  ]);
  if ('failed' in r) return { problem: r.failed };
  const n = Number(r.out.trim());
  return Number.isInteger(n)
    ? { ahead: n, onRemote }
    : { problem: 'git rev-list: unexpected output' };
}

/**
 * Refreshes what the mirror knows of `folder`'s branch on the remote: its upstream
 * ({@link fetchUpstream}), or for a branch with none, `origin/<branch>` as the remote has it now
 * (the look {@link pushedRefs} takes). The git watch's periodic fetch, and the server's after a
 * Push. Returns whether it looked. Never throws.
 */
export async function refreshRemote(
  folder: string,
  opts: MirrorOpts = defaultMirrorOpts(),
): Promise<boolean> {
  const at = await locate(folder, opts);
  if (at === null || isGitProblem(at)) return false;
  if (at.upstream !== null) return await fetchUpstream(folder, opts);
  const originUrl = await readRemoteUrl(at.commonDir, 'origin');
  if (originUrl === null || !(opts.fetchable ?? isFetchableRemote)(originUrl)) {
    return false;
  }
  const n = await unpushedCount(folder, at, { ...opts, checkRemote: true });
  return !('problem' in n);
}

/**
 * Fetches `folder`'s upstream branch from its remote into the mirror, when the remote is one
 * the host may fetch ({@link isFetchableRemote}). Only the host's own git config applies:
 * its credential helper and ssh setup, never the repo's. Returns whether it fetched.
 */
export async function fetchUpstream(
  folder: string,
  opts: MirrorOpts = defaultMirrorOpts(),
): Promise<boolean> {
  return await fetchUpstreamProblem(folder, opts) === null;
}

/** {@link fetchUpstream} with the reason: `null` once fetched, else why not. Never throws. */
export async function fetchUpstreamProblem(
  folder: string,
  opts: MirrorOpts = defaultMirrorOpts(),
): Promise<GitProblem | null> {
  const at = await locate(folder, opts);
  if (at === null) return { problem: 'not a git repo' };
  if (isGitProblem(at)) return at;
  if (at.upstream === null) return { problem: `${at.branch} has no upstream` };
  if (at.mirror === null) return { problem: 'could not create the git mirror' };
  if (!(opts.fetchable ?? isFetchableRemote)(at.upstream.url)) {
    return { problem: 'devc web fetches only https and ssh remotes' };
  }
  const r = await run([
    `--git-dir=${at.mirror}`,
    ...FETCH_FLAGS,
    at.upstream.url,
    `+refs/heads/${at.upstream.branch}:${at.prefix}/upstream`,
  ], FETCH_TIMEOUT_MS);
  return 'failed' in r ? { problem: r.failed } : null;
}

/** The largest bundle {@link upstreamBundle} makes by default. */
export const MAX_BUNDLE_BYTES = 256 * 1024 * 1024;

/** How long writing a bundle may take. */
const BUNDLE_TIMEOUT_MS = 2 * 60_000;

/** What {@link upstreamBundle} gives when there is something to fetch. */
export interface UpstreamBundle {
  bundle: Uint8Array;
  /** The bundle's one ref, `<prefix>/upstream`. */
  ref: string;
  /** The repo's remote and its upstream branch: `refs/remotes/<remote>/<branch>` is the ref to move. */
  remote: string;
  branch: string;
}

/** The repo's own `<remote>/<branch>` already has (or is ahead of) what the mirror fetched. */
export interface UpToDate {
  upToDate: true;
  remote: string;
  branch: string;
}

/**
 * A git bundle (bytes) holding `folder`'s upstream branch as fetched into its mirror (by
 * {@link fetchUpstream}), for the repo's own git to fetch from in its environment. Reads the
 * folder first ({@link readGitState}), so the mirror's copy of its remote-tracking ref is current:
 * the bundle leaves out what that ref already has (its commits are the bundle's prerequisites),
 * and when it already contains the fetched commit there is nothing to bundle ({@link UpToDate}),
 * so a fetch never moves the ref back. Over `maxBytes`, a {@link GitProblem}. Never throws.
 */
export async function upstreamBundle(
  folder: string,
  opts: MirrorOpts = defaultMirrorOpts(),
  maxBytes = MAX_BUNDLE_BYTES,
): Promise<UpstreamBundle | UpToDate | GitProblem> {
  const state = await readGitState(folder, opts);
  if (state === null) return { problem: 'not a git repo' };
  if (isGitProblem(state)) return state;
  const at = await locate(folder, opts);
  if (at === null) return { problem: 'not a git repo' };
  if (isGitProblem(at)) return at;
  const { upstream, mirror, prefix } = at;
  if (upstream === null) return { problem: `${at.branch} has no upstream` };
  if (upstream.trackingRef === null) {
    return { problem: `${at.branch} tracks a URL, not a remote` };
  }
  if (mirror === null) return { problem: 'could not create the git mirror' };
  const ref = `${prefix}/upstream`;
  const tracking = `${prefix}/tracking`;
  const has = async (r: string) =>
    await git([`--git-dir=${mirror}`, 'rev-parse', '-q', '--verify', r]) !==
      null;
  if (!await has(ref)) return { problem: 'nothing fetched from the remote' };
  const { remote, branch } = upstream;
  const tracked = await has(tracking);
  if (
    tracked &&
    await git([
        `--git-dir=${mirror}`,
        'merge-base',
        '--is-ancestor',
        ref,
        tracking,
      ]) !== null
  ) {
    return { upToDate: true, remote, branch };
  }
  const bundle = await runCapped(
    [
      `--git-dir=${mirror}`,
      'bundle',
      'create',
      '--quiet',
      '-',
      ref,
      ...(tracked ? [`^${tracking}`] : []),
    ],
    maxBytes,
    BUNDLE_TIMEOUT_MS,
  );
  if (bundle === 'too_large') {
    return {
      problem: 'fetch too large for devc web: run git fetch in the project',
    };
  }
  if ('failed' in bundle) return { problem: bundle.failed };
  return { bundle: bundle.out, ref, remote, branch };
}

/**
 * Runs git with no repo of its own (`cwd: /`), keeping stdout as bytes up to `max`: past it,
 * git is killed and the answer is `too_large`. Never throws.
 */
export async function runCapped(
  args: string[],
  max: number,
  timeoutMs: number,
): Promise<{ out: Uint8Array } | { failed: string } | 'too_large'> {
  const sub = args.find((a) => !a.startsWith('--git-dir=')) ?? '';
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  let tooLarge = false;
  try {
    const child = new Deno.Command('git', {
      args,
      cwd: '/',
      env: GIT_ENV,
      stdin: 'null',
      stdout: 'piped',
      stderr: 'piped',
      signal: ctl.signal,
    }).spawn();
    const stderr = new Response(child.stderr).text();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of child.stdout) {
      size += chunk.length;
      if (size > max) {
        tooLarge = true;
        ctl.abort();
        break;
      }
      chunks.push(chunk);
    }
    const status = await child.status;
    const err = await stderr.catch(() => '');
    if (tooLarge) return 'too_large';
    if (ctl.signal.aborted) return { failed: `git ${sub}: timed out` };
    if (!status.success) {
      const line = err.split('\n').map((l) => l.trim()).find((l) => l);
      return { failed: line ? `git ${sub}: ${line}` : `git ${sub} failed` };
    }
    const out = new Uint8Array(size);
    let at = 0;
    for (const c of chunks) {
      out.set(c, at);
      at += c.length;
    }
    return { out };
  } catch {
    if (tooLarge) return 'too_large';
    return ctl.signal.aborted
      ? { failed: `git ${sub}: timed out` }
      : { failed: `git ${sub} failed` };
  } finally {
    clearTimeout(timer);
  }
}

/** How often every folder's upstream is fetched. */
export const GIT_FETCH_MS = 5 * 60_000;

/** How often every folder is read again: a commit or push shows within this long. */
export const GIT_POLL_MS = 15_000;

/**
 * Keeps every folder's {@link GitReading} current by reading them all every {@link GIT_POLL_MS}
 * and fetching their upstreams every {@link GIT_FETCH_MS}, and sooner on {@link refresh}.
 * Calls `onChange` after each folder whose reading changed, so a slow one (a cold mirror) holds
 * back none read before it, and once after dropping folders no longer listed.
 */
// An SSH environment would need these reads to go through `env.run`: they read the host's FS.
export class GitStatusWatch {
  #statuses = new Map<string, GitReading>();
  #timer: ReturnType<typeof setInterval> | undefined;
  #fetchTimer: ReturnType<typeof setInterval> | undefined;
  #fetching = false;
  #running = false;
  #again = false;

  constructor(
    private readonly opts: {
      folders: () => Iterable<string>;
      onChange: () => void;
      /** After every pass, changed or not. */
      onPass?: () => void;
      read?: (folder: string) => Promise<GitReading>;
      fetch?: (folder: string) => Promise<boolean>;
      pollMs?: number;
      fetchMs?: number;
    },
  ) {}

  /** Every folder's last reading; a folder not read yet is absent. */
  get statuses(): ReadonlyMap<string, GitReading> {
    return this.#statuses;
  }

  start() {
    // Read first: the branch's objects reach the mirror from the folder, so the first fetch
    // from the remote brings only what the folder lacks.
    void this.refresh().then(() => this.fetchAll());
    this.#timer = setInterval(
      () => void this.refresh(),
      this.opts.pollMs ?? GIT_POLL_MS,
    );
    this.#fetchTimer = setInterval(
      () => void this.fetchAll(),
      this.opts.fetchMs ?? GIT_FETCH_MS,
    );
  }

  stop() {
    clearInterval(this.#timer);
    clearInterval(this.#fetchTimer);
  }

  /** Fetches every folder's upstream, one at a time, then reads them all again. Skipped while one runs. */
  async fetchAll(): Promise<void> {
    if (this.#fetching) return;
    this.#fetching = true;
    try {
      const fetch = this.opts.fetch ?? ((f: string) => refreshRemote(f));
      for (const folder of new Set(this.opts.folders())) await fetch(folder);
      await this.refresh();
    } finally {
      this.#fetching = false;
    }
  }

  /** Reads every folder now; a call during a pass runs one more pass after it. */
  async refresh(): Promise<void> {
    if (this.#running) {
      this.#again = true;
      return;
    }
    this.#running = true;
    try {
      do {
        this.#again = false;
        await this.#pass();
        this.opts.onPass?.();
      } while (this.#again);
    } finally {
      this.#running = false;
    }
  }

  async #pass() {
    const read = this.opts.read ?? ((f: string) => readGitState(f));
    const folders = new Set(this.opts.folders());
    let dropped = false;
    for (const folder of this.#statuses.keys()) {
      if (!folders.has(folder)) {
        this.#statuses.delete(folder);
        dropped = true;
      }
    }
    if (dropped) this.opts.onChange();
    for (const folder of folders) {
      const next = await read(folder);
      const prev = this.#statuses.get(folder);
      if (!this.#statuses.has(folder) || !sameStatus(prev ?? null, next)) {
        this.#statuses.set(folder, next);
        this.opts.onChange();
      }
    }
  }
}

function sameStatus(a: GitReading, b: GitReading): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
