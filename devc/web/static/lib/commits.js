// The repo card's Commits section as rows, from a `git_history` answer (`web/git_history.ts`):
// commits to pull, then local ones, then a line where pushed history starts, newest first, and an
// open commit's changed files (`commit_files`, `web/git_commit.ts`) under it. Pure (no DOM), shared
// with the Deno tests (`devc/tests/web_commits_test.ts`); `cards.js` draws it.

/**
 * @typedef {{hash: string, subject: string, author: string, time: number, merge: boolean}} Commit
 * @typedef {{branch: string, compare: string | null, incoming: Commit[], incomingTotal: number,
 *   local: Commit[], localTotal: number, pushed: Commit[], morePushed: boolean}} CommitHistory
 * @typedef {'incoming' | 'local' | 'pushed'} CommitState
 * @typedef {{kind: 'commit', state: CommitState, commit: Commit, short: string, title: string}
 *   | {kind: 'divider', state: CommitState, text: string}
 *   | {kind: 'more', state: CommitState, text: string}} CommitRow
 */

const plural = (n) => `${n} commit${n === 1 ? '' : 's'}`;

/** A commit's tooltip: its hash, author and date, then its subject in full. */
export function commitTitle(c) {
  const date = c.time ? new Date(c.time * 1000).toLocaleString() : '';
  return [
    c.hash.slice(0, 12),
    [c.author, date].filter((t) => t).join(' · '),
    c.merge ? 'Merge commit' : '',
    c.subject,
  ].filter((t) => t).join('\n');
}

/**
 * The rows for `history`: a divider heads each group that has commits, so the Pushed line is where
 * pushed history starts. A repo with no remote branch says so on its Local only line.
 *
 * @param {CommitHistory} history
 * @returns {CommitRow[]}
 */
export function commitRows(history) {
  /** @type {CommitRow[]} */
  const rows = [];
  /** @param {CommitState} state @param {Commit[]} commits */
  const add = (state, commits) => {
    for (const commit of commits) {
      rows.push({
        kind: 'commit',
        state,
        commit,
        short: commit.hash.slice(0, 7),
        title: commitTitle(commit),
      });
    }
  };
  const { compare, incoming, incomingTotal, local, localTotal, pushed } =
    history;
  if (incomingTotal > 0) {
    rows.push({
      kind: 'divider',
      state: 'incoming',
      text: `To pull · ${plural(incomingTotal)} on ${compare}`,
    });
    add('incoming', incoming);
    if (incomingTotal > incoming.length) {
      rows.push({
        kind: 'more',
        state: 'incoming',
        text: `and ${incomingTotal - incoming.length} more`,
      });
    }
  }
  if (localTotal > 0) {
    rows.push({
      kind: 'divider',
      state: 'local',
      text: compare === null
        ? `Local only · ${plural(localTotal)}, no remote branch`
        : `Local only · ${plural(localTotal)}`,
    });
    add('local', local);
    if (localTotal > local.length) {
      rows.push({
        kind: 'more',
        state: 'local',
        text: `and ${localTotal - local.length} more`,
      });
    }
  }
  if (pushed.length > 0) {
    rows.push({
      kind: 'divider',
      state: 'pushed',
      text: `Pushed · ${compare}`,
    });
    add('pushed', pushed);
    if (history.morePushed) {
      rows.push({
        kind: 'more',
        state: 'pushed',
        text: `latest ${pushed.length} shown`,
      });
    }
  }
  return rows;
}

/**
 * A changed file as a commit's file list gives it (`commit_files`, `web/git_commit.ts`), or the
 * working tree's (`uncommitted_files`, `web/git_uncommitted.ts`), which alone has `conflicted`
 * and `untracked`.
 *
 * @typedef {{path: string, previousPath: string | null,
 *   status: 'added' | 'removed' | 'modified' | 'renamed' | 'conflicted', additions: number,
 *   deletions: number, binary: boolean, untracked?: true}} CommitFile
 * @typedef {{loading: boolean, files: CommitFile[] | null, truncated: boolean,
 *   error: string | null}} CommitFileList
 * @typedef {{kind: 'file', file: CommitFile, name: string, dir: string, title: string}
 *   | {kind: 'note', note: 'loading' | 'error' | 'empty' | 'more', text: string}} CommitFileRow
 */

/** The most commits' file lists kept: past it, the least recently read is dropped. */
export const MAX_COMMIT_FILE_LISTS = 50;

/** The files `commit_files` lists at most (`git_commit.ts`'s MAX_COMMIT_FILES). */
export const MAX_COMMIT_FILES = 1000;

/** A commit's file list's key: its repo and hash. A list never changes, so this is all it needs. */
export function commitFilesKey(
  /** @type {string} */ root,
  /** @type {string} */ hash,
) {
  return `${root}\n${hash}`;
}

/**
 * Puts `value` in `lists` as its newest entry, dropping the oldest past `max`.
 *
 * @template T
 * @param {Map<string, T>} lists @param {string} key @param {T} value
 */
export function keepList(lists, key, value, max = MAX_COMMIT_FILE_LISTS) {
  lists.delete(key);
  lists.set(key, value);
  while (lists.size > max) lists.delete(lists.keys().next().value);
}

/** A file row's tooltip: its path, both paths for a rename. @param {CommitFile} f */
export function commitFileTitle(f) {
  return f.previousPath ? `${f.previousPath} → ${f.path}` : f.path;
}

/**
 * The rows under an open commit: what its file list's read says, or a row per file (its name, its
 * folder dim beside it), then a note when the list was cut short.
 *
 * @param {CommitFileList | undefined} list
 * @returns {CommitFileRow[]}
 */
export function commitFileRows(list) {
  if (!list?.files) {
    return [
      list?.error
        ? {
          kind: 'note',
          note: 'error',
          text: `Couldn't list files: ${list.error}`,
        }
        : { kind: 'note', note: 'loading', text: 'Loading…' },
    ];
  }
  if (list.files.length === 0) {
    return [{ kind: 'note', note: 'empty', text: 'No files changed' }];
  }
  /** @type {CommitFileRow[]} */
  const rows = list.files.map((file) => {
    const cut = file.path.lastIndexOf('/');
    return {
      kind: 'file',
      file,
      name: file.path.slice(cut + 1),
      dir: cut < 0 ? '' : file.path.slice(0, cut),
      title: commitFileTitle(file),
    };
  });
  if (list.truncated) {
    rows.push({
      kind: 'note',
      note: 'more',
      text: `first ${MAX_COMMIT_FILES} files shown`,
    });
  }
  return rows;
}

/**
 * Whether a repo's working tree has changes to commit, from its `RepoView.changes`: what shows the
 * Commits section's Uncommitted row. Absent (not read, or its environment isn't running) is no.
 *
 * @param {{staged: number, unstaged: number, untracked: number, conflicted: number} | undefined}
 *   changes
 */
export function hasUncommitted(changes) {
  if (!changes) return false;
  return changes.staged + changes.unstaged + changes.untracked +
      changes.conflicted > 0;
}

/**
 * The Uncommitted row's count, once its list is read: `1 file`, `n files`, `1000+ files` when cut
 * short; '' before.
 *
 * @param {CommitFileList | undefined} list
 */
export function uncommittedCount(list) {
  if (!list?.files) return '';
  const n = list.files.length;
  if (list.truncated) return `${n}+ files`;
  return `${n} file${n === 1 ? '' : 's'}`;
}

/**
 * An uncommitted file's stat: `new` for an untracked file (git counts no lines for it), `binary`
 * for a binary one, else `+a −d`.
 *
 * @param {CommitFile} file
 */
export function fileStat(file) {
  if (file.untracked) return 'new';
  if (file.binary) return 'binary';
  return `+${file.additions} −${file.deletions}`;
}
