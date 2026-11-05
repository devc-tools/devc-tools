// A repo's commits for the `devc web` repo card's Commits section, sorted into what is only local,
// what is pushed, and what is on the remote waiting to be pulled.
//
// It reads the host's mirror (`git_status.ts`), not the repo, for two reasons. The host never runs
// git in a repo (see that file's header). And the repo's own remote-tracking refs can't say what is
// pushed: `gh-push` publishes from a mirror of its own and never writes to the repo, so they stay
// where they were. The mirror also holds what the host fetched from the remote.
//
// A branch with an upstream is compared with it exactly as its ↑↓ counts are, so the section always
// agrees with them. A branch with none (the usual `gh-push` branch) is compared with every
// remote-tracking ref the repo has, and with `origin/<branch>` as the host finds it on the remote.

import { readRemoteUrl } from './git_repo.ts';
import {
  defaultMirrorOpts,
  FETCH_FLAGS,
  type GitProblem,
  isGitProblem,
  LOCAL_FETCH_TIMEOUT_MS,
  locate,
  type Located,
  mirrorFor,
  type MirrorOpts,
  pushedRefs,
  readGitState,
  run,
  runCapped,
  upstreamCopies,
} from './git_status.ts';

/** One commit as the section shows it. Its text comes from the repo: shown as text, never HTML. */
export interface HistoryCommit {
  hash: string;
  subject: string;
  author: string;
  /** Author date, epoch seconds. */
  time: number;
  merge: boolean;
}

export interface CommitHistory {
  branch: string;
  /** What "pushed" is measured against, for its label; `null` when the repo knows no remote branch. */
  compare: string | null;
  /** On the upstream, not in the branch: `behind` in the ↑↓ counts. Newest first. */
  incoming: HistoryCommit[];
  incomingTotal: number;
  /** In the branch, not on what it is compared with: `ahead` in the counts. Newest first. */
  local: HistoryCommit[];
  localTotal: number;
  /** In the branch and pushed. Newest first, the latest {@link PUSHED_SHOWN}. */
  pushed: HistoryCommit[];
  morePushed: boolean;
}

export type HistoryReading = CommitHistory | GitProblem;

/** The most commits listed to pull, and local: past it, the section gives the total. */
export const UNPUSHED_SHOWN = 100;
export const PUSHED_SHOWN = 50;

/** The most output one `git log` may give: commit subjects are the repo's, and any length. */
const LOG_MAX_OUTPUT = 4 * 1024 * 1024;
const LOG_TIMEOUT_MS = 15_000;
/** The longest subject kept: more than any row or tooltip shows. */
const SUBJECT_MAX = 500;
const AUTHOR_MAX = 200;

// `%s` and `%an` hold no NUL or newline: git folds a subject's lines and cleans a name.
const LOG_ARGS = [
  'log',
  '--no-show-signature',
  '--no-color',
  '--encoding=UTF-8',
  '--topo-order',
  '--format=%H%x00%P%x00%an%x00%at%x00%s',
];

/** Parses {@link LOG_ARGS}' output; a line that isn't a commit is left out. */
export function parseLog(out: string): HistoryCommit[] {
  const commits: HistoryCommit[] = [];
  for (const line of out.split('\n')) {
    const fields = line.split('\0');
    if (fields.length !== 5 || !/^[0-9a-f]{40,64}$/.test(fields[0])) continue;
    const [hash, parents, author, time, subject] = fields;
    commits.push({
      hash,
      subject: subject.slice(0, SUBJECT_MAX),
      author: author.slice(0, AUTHOR_MAX),
      time: Number(time) || 0,
      merge: parents.split(' ').length > 1,
    });
  }
  return commits;
}

/**
 * The mirror a folder's Commits section reads, created if missing. A no-upstream repo's included:
 * one with no remote still has commits to list, so its mirror is named for the folder.
 */
export async function historyMirror(
  at: Located,
  folder: string,
  opts: MirrorOpts,
  originUrl?: string | null,
): Promise<string | null> {
  if (at.mirror !== null) return at.mirror;
  const url = originUrl !== undefined
    ? originUrl
    : at.upstream?.url ?? await readRemoteUrl(at.commonDir, 'origin');
  return await mirrorFor(opts, url ?? `local:${folder}`);
}

/**
 * `folder`'s commits on its checked-out branch. `checkRemote` allows a look at the remote for a
 * branch with no upstream to compare with: a network call, so callers limit how often. Never
 * throws.
 */
export async function readCommitHistory(
  folder: string,
  opts: MirrorOpts & { checkRemote?: boolean } = defaultMirrorOpts(),
): Promise<HistoryReading> {
  const at = await locate(folder, opts);
  if (at === null) return { problem: 'not a git repo' };
  if (isGitProblem(at)) return at;
  const { branch, upstream, prefix, commonDir } = at;
  const originUrl = upstream?.url ?? await readRemoteUrl(commonDir, 'origin');
  const mirror = await historyMirror(at, folder, opts, originUrl);
  if (mirror === null) return { problem: 'could not create the git mirror' };

  if (upstream !== null) {
    // Brings the branch and its remote-tracking ref into the mirror, as the counts do.
    const state = await readGitState(folder, opts);
    if (state === null) return { problem: 'not a git repo' };
    if (isGitProblem(state)) return state;
  } else {
    const r = await run(
      [
        `--git-dir=${mirror}`,
        ...FETCH_FLAGS,
        folder,
        `+refs/heads/${branch}:${prefix}/local`,
      ],
      opts.localFetchTimeoutMs ?? LOCAL_FETCH_TIMEOUT_MS,
    );
    if ('failed' in r) return { problem: r.failed };
  }

  const inMirror = (...args: string[]) => [`--git-dir=${mirror}`, ...args];
  const local = `${prefix}/local`;
  const { against } = upstream === null
    ? { against: null }
    : await upstreamCopies(mirror, prefix);

  let excludes: string[];
  let compare: string | null;
  if (against !== null) {
    excludes = [against];
    compare = `${upstream!.remote}/${upstream!.branch}`;
  } else {
    const seen = await pushedRefs(
      folder,
      mirror,
      prefix,
      upstream,
      originUrl,
      branch,
      opts,
    );
    excludes = seen.excludes;
    compare = seen.compare;
  }

  const readLog = async (
    limit: number,
    ...revs: string[]
  ): Promise<HistoryCommit[] | GitProblem> => {
    const r = await runCapped(
      inMirror(...LOG_ARGS, `--max-count=${limit}`, ...revs),
      LOG_MAX_OUTPUT,
      LOG_TIMEOUT_MS,
    );
    if (r === 'too_large') {
      return { problem: 'commit history too large to show' };
    }
    if ('failed' in r) return { problem: r.failed };
    return parseLog(new TextDecoder().decode(r.out));
  };
  const count = async (...revs: string[]): Promise<number | GitProblem> => {
    const r = await run(inMirror('rev-list', '--count', ...revs));
    if ('failed' in r) return { problem: r.failed };
    const n = Number(r.out.trim());
    return Number.isInteger(n)
      ? n
      : { problem: 'git rev-list: unexpected output' };
  };

  const not = excludes.length ? ['--not', ...excludes] : [];
  const localTotal = await count(local, ...not);
  if (typeof localTotal !== 'number') return localTotal;
  const localCommits = await readLog(UNPUSHED_SHOWN, local, ...not);
  if (isGitProblem(localCommits)) return localCommits;

  let incoming: HistoryCommit[] = [];
  let incomingTotal = 0;
  if (against !== null) {
    const n = await count(against, '--not', local);
    if (typeof n !== 'number') return n;
    incomingTotal = n;
    const listed = await readLog(UNPUSHED_SHOWN, against, '--not', local);
    if (isGitProblem(listed)) return listed;
    incoming = listed;
  }

  // Pushed commits are the branch's others. Past the cap the local list isn't whole, so they
  // can't be told apart: those many local commits fill the section anyway.
  let pushed: HistoryCommit[] = [];
  let morePushed = false;
  if (excludes.length && localTotal <= UNPUSHED_SHOWN) {
    const mine = new Set(localCommits.map((c) => c.hash));
    const listed = await readLog(localTotal + PUSHED_SHOWN + 1, local);
    if (isGitProblem(listed)) return listed;
    const others = listed.filter((c) => !mine.has(c.hash));
    pushed = others.slice(0, PUSHED_SHOWN);
    morePushed = others.length > PUSHED_SHOWN;
  }

  return {
    branch,
    compare,
    incoming,
    incomingTotal,
    local: localCommits,
    localTotal,
    pushed,
    morePushed,
  };
}
