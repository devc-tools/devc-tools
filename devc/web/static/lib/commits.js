// The repo card's Commits section as rows, from a `git_history` answer (`web/git_history.ts`):
// commits to pull, then local ones, then a line where pushed history starts, newest first. Pure (no
// DOM), shared with the Deno tests (`devc/tests/web_commits_test.ts`); `cards.js` draws it.

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
