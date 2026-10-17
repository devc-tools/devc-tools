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
// every count runs there.

import { join } from 'jsr:@std/path';
import {
  isFetchableRemote,
  readBranch,
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
  /** Commits to pull. */
  behind: number;
  /** The upstream is configured but neither the repo nor a fetch has its branch. */
  gone: boolean;
}

/** Where the mirrors live, and which remotes may be fetched (tests widen it to local paths). */
export interface MirrorOpts {
  root: string;
  fetchable?: (url: string) => boolean;
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

/** Runs git with no repo of its own (`cwd: /`); `null` when it fails. Never throws. */
async function git(args: string[], timeoutMs = 10_000): Promise<string | null> {
  try {
    const out = await new Deno.Command('git', {
      args,
      cwd: '/',
      env: GIT_ENV,
      stdin: 'null',
      stdout: 'piped',
      stderr: 'null',
      signal: AbortSignal.timeout(timeoutMs),
    }).output();
    return out.success ? new TextDecoder().decode(out.stdout) : null;
  } catch {
    return null;
  }
}

async function hash(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest).slice(0, 8)]
    .map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The bare mirror for `url`, created (with no hooks) if missing. */
async function mirrorFor(
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
interface Located {
  branch: string;
  upstream: Upstream | null;
  mirror: string | null;
  /** This folder and branch's refs in the mirror. */
  prefix: string;
}

async function locate(
  folder: string,
  opts: MirrorOpts,
): Promise<Located | null> {
  const dirs = await resolveRepo(folder);
  if (dirs === null) return null;
  const branch = await readBranch(dirs.gitDir);
  if (branch === null) return null;
  const upstream = await readUpstream(dirs.commonDir, branch);
  return {
    branch,
    upstream,
    mirror: upstream === null ? null : await mirrorFor(opts, upstream.url),
    prefix: `refs/devc/${await hash(`${folder}\0${branch}`)}`,
  };
}

const FETCH_FLAGS = [
  'fetch',
  '--quiet',
  '--no-tags',
  '--no-write-fetch-head',
  '--no-recurse-submodules',
];

/**
 * `folder`'s status, or `null` when it is no repo, is detached, or its branch can't be
 * fetched from it. Fetches the branch and its remote-tracking ref from the folder into the
 * mirror, then counts against whichever upstream copy is newer: the repo's own (after a push
 * or the editor's fetch) or the mirror's (after {@link fetchUpstream}). Never throws.
 */
export async function readGitStatus(
  folder: string,
  opts: MirrorOpts = defaultMirrorOpts(),
): Promise<GitStatus | null> {
  const at = await locate(folder, opts);
  if (at === null) return null;
  const { branch, upstream, mirror, prefix } = at;
  if (upstream === null) {
    return { branch, upstream: null, ahead: 0, behind: 0, gone: false };
  }
  if (mirror === null) return null;
  const inMirror = (...args: string[]) => git([`--git-dir=${mirror}`, ...args]);
  const local = `+refs/heads/${branch}:${prefix}/local`;
  const tracking = upstream.trackingRef === null
    ? null
    : `+${upstream.trackingRef}:${prefix}/tracking`;
  if (
    tracking === null ||
    await inMirror(...FETCH_FLAGS, folder, local, tracking) === null
  ) {
    // No remote-tracking ref in the repo (never fetched, or the branch was deleted): fetch
    // just the branch, and forget a stale copy of the ref.
    if (await inMirror(...FETCH_FLAGS, folder, local) === null) return null;
    await inMirror('update-ref', '-d', `${prefix}/tracking`);
  }
  const refs = new Set(
    (await inMirror('for-each-ref', '--format=%(refname)', `${prefix}/`) ?? '')
      .split('\n').filter((r) => r),
  );
  const fetched = refs.has(`${prefix}/upstream`) ? `${prefix}/upstream` : null;
  const tracked = refs.has(`${prefix}/tracking`) ? `${prefix}/tracking` : null;
  const name = `${upstream.remote}/${upstream.branch}`;
  let against = fetched ?? tracked;
  if (fetched !== null && tracked !== null) {
    const fetchedIsOlder =
      await inMirror('merge-base', '--is-ancestor', fetched, tracked) !== null;
    against = fetchedIsOlder ? tracked : fetched;
  }
  if (against === null) {
    return { branch, upstream: name, ahead: 0, behind: 0, gone: true };
  }
  const counts = await inMirror(
    'rev-list',
    '--left-right',
    '--count',
    `${prefix}/local...${against}`,
  );
  const [ahead, behind] = (counts ?? '').trim().split(/\s+/).map(Number);
  if (!Number.isInteger(ahead) || !Number.isInteger(behind)) return null;
  return { branch, upstream: name, ahead, behind, gone: false };
}

const FETCH_TIMEOUT_MS = 60_000;

/**
 * Fetches `folder`'s upstream branch from its remote into the mirror, when the remote is one
 * the host may fetch ({@link isFetchableRemote}). Only the host's own git config applies:
 * its credential helper and ssh setup, never the repo's. Returns whether it fetched.
 */
export async function fetchUpstream(
  folder: string,
  opts: MirrorOpts = defaultMirrorOpts(),
): Promise<boolean> {
  const at = await locate(folder, opts);
  if (at?.upstream == null || at.mirror === null) return false;
  if (!(opts.fetchable ?? isFetchableRemote)(at.upstream.url)) return false;
  return await git([
    `--git-dir=${at.mirror}`,
    ...FETCH_FLAGS,
    at.upstream.url,
    `+refs/heads/${at.upstream.branch}:${at.prefix}/upstream`,
  ], FETCH_TIMEOUT_MS) !== null;
}

/** How often every folder's upstream is fetched. */
export const GIT_FETCH_MS = 5 * 60_000;

/** How often every folder is read again: a commit or push shows within this long. */
export const GIT_POLL_MS = 15_000;

/**
 * Keeps every folder's {@link GitStatus} current by reading them all every {@link GIT_POLL_MS}
 * and fetching their upstreams every {@link GIT_FETCH_MS}, and sooner on {@link refresh}.
 * Calls `onChange` after a pass that changed any of them.
 */
export class GitStatusWatch {
  #statuses = new Map<string, GitStatus | null>();
  #timer: ReturnType<typeof setInterval> | undefined;
  #fetchTimer: ReturnType<typeof setInterval> | undefined;
  #fetching = false;
  #running = false;
  #again = false;

  constructor(
    private readonly opts: {
      folders: () => Iterable<string>;
      onChange: () => void;
      read?: (folder: string) => Promise<GitStatus | null>;
      fetch?: (folder: string) => Promise<boolean>;
      pollMs?: number;
      fetchMs?: number;
    },
  ) {}

  /** Every folder's last-read status; a folder not read yet is absent. */
  get statuses(): ReadonlyMap<string, GitStatus | null> {
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
      const fetch = this.opts.fetch ?? ((f: string) => fetchUpstream(f));
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
      } while (this.#again);
    } finally {
      this.#running = false;
    }
  }

  async #pass() {
    const read = this.opts.read ?? ((f: string) => readGitStatus(f));
    const folders = new Set(this.opts.folders());
    let changed = false;
    for (const folder of this.#statuses.keys()) {
      if (!folders.has(folder)) {
        this.#statuses.delete(folder);
        changed = true;
      }
    }
    for (const folder of folders) {
      const next = await read(folder);
      const prev = this.#statuses.get(folder);
      if (!this.#statuses.has(folder) || !sameStatus(prev ?? null, next)) {
        this.#statuses.set(folder, next);
        changed = true;
      }
    }
    if (changed) this.opts.onChange();
  }
}

function sameStatus(a: GitStatus | null, b: GitStatus | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
