// The New worktree dialog's rules (`worktree-dialog.js`), kept apart from the DOM so they are
// tested: see `.plans/devc-web-worktrees.md`. The server (`git_worktree.ts`) checks them again.

/** The folder name a branch suggests: every `/` becomes `-` (as `git_worktree.ts`'s does). */
export function folderNameFor(branch) {
  return branch.replaceAll('/', '-');
}

/**
 * The note under the New worktree form, and whether Create is blocked, for its current choice.
 * `source` is the remote branch the Pull request or Remote branch tab picked (a fork's PR: null):
 * under another name, the new branch starts from it with no upstream, which the note says, and a
 * branch checked out elsewhere says that a new name gets round it.
 *
 * @param {{kind: 'pr' | 'remote' | 'new', branch: string, name: string, source?: string | null,
 *   localBranches: string[], checkedOut: string[], folders: string[]}} s
 * @returns {{note: string, blocked: boolean}}
 */
export function worktreeNote(s) {
  if (s.branch === '' || s.name === '') return { note: '', blocked: true };
  if (s.folders.includes(s.name)) {
    return { note: 'folder already exists', blocked: true };
  }
  if (s.checkedOut.includes(s.branch)) {
    return {
      note: s.kind === 'new'
        ? 'checked out in another worktree'
        : 'checked out in another worktree: give the branch a new name to start a new branch from it',
      blocked: true,
    };
  }
  if (s.localBranches.includes(s.branch)) {
    return s.kind === 'new'
      ? { note: 'branch already exists', blocked: true }
      : { note: 'uses the existing local branch as is', blocked: false };
  }
  if (s.kind !== 'new' && s.source && s.branch !== s.source) {
    return {
      note: `a new branch from origin/${s.source}, with no upstream`,
      blocked: false,
    };
  }
  return { note: '', blocked: false };
}
