// The repo card's Commits section as rows, from a `git_history` answer (`web/git_history.ts`):
// commits to pull, then local ones, then pushed history, each group under a heading that opens
// and closes it, newest first, and an open commit's changed files (`commit_files`, `web/git_commit.ts`) under it. Pure (no DOM), shared
// with the Deno tests (`devc/tests/web_commits_test.ts`); `cards.js` draws it.

/**
 * @typedef {{hash: string, subject: string, author: string, time: number, merge: boolean}} Commit
 * @typedef {{branch: string, compare: string | null, incoming: Commit[], incomingTotal: number,
 *   local: Commit[], localTotal: number, pushed: Commit[], morePushed: boolean}} CommitHistory
 * @typedef {'incoming' | 'local' | 'pushed'} CommitState
 * @typedef {{kind: 'commit', state: CommitState, commit: Commit, short: string, title: string}
 *   | {kind: 'divider', state: CommitState, text: string, count: string, title: string,
 *     open: boolean}
 *   | {kind: 'more', state: CommitState, text: string}} CommitRow
 * @typedef {'staged' | 'unstaged' | CommitState} CommitGroup
 */

/**
 * Whether a Commits section's group (a heading: Staged, Changes, To pull, Local only, Pushed)
 * is open until the user opens or closes it: all but Pushed.
 *
 * @param {CommitGroup} group
 */
export function commitGroupOpenByDefault(group) {
  return group !== 'pushed';
}

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
 * The rows for `history`: a heading (`divider`) for each group that has commits, its commits
 * under it while `isOpen(state)`, so a closed group is its heading alone. A repo with no remote
 * branch says so on its Local only heading.
 *
 * @param {CommitHistory} history
 * @param {(state: CommitState) => boolean} [isOpen]
 * @returns {CommitRow[]}
 */
export function commitRows(history, isOpen = () => true) {
  /** @type {CommitRow[]} */
  const rows = [];
  /**
   * @param {CommitState} state @param {string} text @param {string} count @param {string} title
   * @param {Commit[]} commits @param {string} more what was left out, '' for nothing
   */
  const add = (state, text, count, title, commits, more) => {
    const open = isOpen(state);
    rows.push({ kind: 'divider', state, text, count, title, open });
    if (!open) return;
    for (const commit of commits) {
      rows.push({
        kind: 'commit',
        state,
        commit,
        short: commit.hash.slice(0, 7),
        title: commitTitle(commit),
      });
    }
    if (more) rows.push({ kind: 'more', state, text: more });
  };
  const { compare, incoming, incomingTotal, local, localTotal, pushed } =
    history;
  if (incomingTotal > 0) {
    add(
      'incoming',
      `To pull · ${compare}`,
      String(incomingTotal),
      `${plural(incomingTotal)} on ${compare} to pull`,
      incoming,
      incomingTotal > incoming.length
        ? `and ${incomingTotal - incoming.length} more`
        : '',
    );
  }
  if (localTotal > 0) {
    add(
      'local',
      compare === null ? 'Local only · no remote branch' : 'Local only',
      String(localTotal),
      compare === null
        ? `${plural(localTotal)}, no remote branch`
        : `${plural(localTotal)} not pushed to ${compare}`,
      local,
      localTotal > local.length ? `and ${localTotal - local.length} more` : '',
    );
  }
  if (pushed.length > 0) {
    add(
      'pushed',
      `Pushed · ${compare}`,
      `${pushed.length}${history.morePushed ? '+' : ''}`,
      history.morePushed
        ? `On ${compare}: the latest ${pushed.length} commits`
        : `${plural(pushed.length)} on ${compare}`,
      pushed,
      history.morePushed ? `latest ${pushed.length} shown` : '',
    );
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
 * Commits section's commit box and its Staged and Changes groups. Absent (not read, or its environment isn't running) is no.
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
 * The working tree's changes as `uncommitted_files` answers (`web/git_uncommitted.ts`): what is
 * staged (index vs `HEAD`) and what is not yet (working tree vs index). A file staged then edited
 * again is in both.
 *
 * @typedef {{loading: boolean, staged: CommitFile[] | null, unstaged: CommitFile[] | null,
 *   truncated: boolean, error: string | null}} UncommittedList
 * @typedef {'staged' | 'unstaged'} Stage
 * @typedef {{kind: 'group', stage: Stage, label: string, count: number, open: boolean}
 *   | (CommitFileRow & {kind: 'file', stage: Stage})
 *   | {kind: 'note', note: 'loading' | 'error' | 'empty' | 'more', text: string}} UncommittedRow
 */

/**
 * How many files the working tree changed, once its list is read: the files with any change, staged or not
 * (`1 file`, `n files`, `1000+ files` when cut short); '' before.
 *
 * @param {UncommittedList | undefined} list
 */
export function uncommittedCount(list) {
  if (!list?.staged || !list.unstaged) return '';
  const n = new Set([...list.staged, ...list.unstaged].map((f) => f.path)).size;
  if (list.truncated) return `${n}+ files`;
  return `${n} file${n === 1 ? '' : 's'}`;
}

/**
 * The working tree's rows in the Commits section, after its commit box: what the list's read
 * says, or a **Staged** group and a **Changes** group, each only when it has files, each file
 * under its group while `isOpen(stage)`, then a note when a list was cut short.
 *
 * @param {UncommittedList | undefined} list
 * @param {(stage: Stage) => boolean} [isOpen]
 * @returns {UncommittedRow[]}
 */
export function uncommittedRows(list, isOpen = () => true) {
  if (!list?.staged || !list.unstaged) {
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
  /** @type {UncommittedRow[]} */
  const rows = [];
  /** @type {[Stage, string, CommitFile[]][]} */
  const groups = [
    ['staged', 'Staged', list.staged],
    ['unstaged', 'Changes', list.unstaged],
  ];
  for (const [stage, label, files] of groups) {
    if (files.length === 0) continue;
    const open = isOpen(stage);
    rows.push({ kind: 'group', stage, label, count: files.length, open });
    if (!open) continue;
    for (const r of commitFileRows({ ...list, files })) {
      if (r.kind === 'file') rows.push({ ...r, stage });
    }
  }
  if (rows.length === 0) {
    rows.push({ kind: 'note', note: 'empty', text: 'No files changed' });
  }
  if (list.truncated) {
    rows.push({
      kind: 'note',
      note: 'more',
      text: `first ${MAX_COMMIT_FILES} files of each shown`,
    });
  }
  return rows;
}

/**
 * The commit box's **Commit** button: disabled, with its `title` saying why, until the list is
 * read, something is staged, a message is typed, and nothing runs in the repo.
 *
 * @param {UncommittedList | undefined} list
 * @param {string} message
 * @param {'commit' | 'stage' | null} busy what runs in the repo now
 * @returns {{disabled: boolean, label: string, title: string}}
 */
export function commitButton(list, message, busy) {
  const n = list?.staged?.length ?? 0;
  const label = n > 0 ? `Commit (${n})` : 'Commit';
  if (busy === 'commit') {
    return { disabled: true, label: 'Committing…', title: 'Committing…' };
  }
  if (busy === 'stage') return { disabled: true, label, title: 'Staging…' };
  if (!list?.staged) return { disabled: true, label, title: 'Loading…' };
  if (n === 0) {
    return {
      disabled: true,
      label,
      title: 'Nothing staged: stage files first',
    };
  }
  if (message.trim() === '') {
    return { disabled: true, label, title: 'Type a commit message' };
  }
  return {
    disabled: false,
    label,
    title: `Commit ${n} staged file${n === 1 ? '' : 's'}`,
  };
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
