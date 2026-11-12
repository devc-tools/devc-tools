// The New worktree dialog's rules (`worktree-dialog.js`), kept apart from the DOM so they are
// tested: see `.plans/devc-web-worktrees.md`. The server (`git_worktree.ts`) checks them again.

/** The folder name a branch suggests: every `/` becomes `-` (as `git_worktree.ts`'s does). */
export function folderNameFor(branch) {
  return branch.replaceAll('/', '-');
}

/**
 * The note under the New worktree form, and whether Create is blocked, for its current choice.
 *
 * @param {{kind: 'pr' | 'remote' | 'new', branch: string, name: string,
 *   localBranches: string[], checkedOut: string[], folders: string[]}} s
 * @returns {{note: string, blocked: boolean}}
 */
export function worktreeNote(s) {
  if (s.branch === '' || s.name === '') return { note: '', blocked: true };
  if (s.folders.includes(s.name)) {
    return { note: 'folder already exists', blocked: true };
  }
  if (s.checkedOut.includes(s.branch)) {
    return { note: 'checked out in another worktree', blocked: true };
  }
  if (s.localBranches.includes(s.branch)) {
    return s.kind === 'new'
      ? { note: 'branch already exists', blocked: true }
      : { note: 'uses the existing local branch as is', blocked: false };
  }
  return { note: '', blocked: false };
}
