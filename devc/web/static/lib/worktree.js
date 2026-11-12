// The New worktree dialog's rules (`worktree-dialog.js`), kept apart from the DOM so they are
// tested: see `.plans/archived/devc-web-worktrees.md`. The server (`git_worktree.ts`) checks them
// again.

/** The folder name a branch suggests: every `/` becomes `-` (as `git_worktree.ts`'s does). */
export function folderNameFor(branch) {
  return branch.replaceAll('/', '-');
}

/**
 * @typedef {{kind: 'local' | 'remote', name: string, label: string, checkedOut: boolean}} BranchChoice
 * A base the Branch tab lists: a local branch (`name`), or `origin/<name>`.
 */

/**
 * The Branch tab's bases: the repo's local branches and origin's, the default branch's first (its
 * local one, then `origin/…`), then by name, a local branch before origin's of the same name.
 *
 * @param {{localBranches: string[], remoteBranches: string[], checkedOut: string[],
 *   defaultBranch: string | null}} o
 * @returns {BranchChoice[]}
 */
export function branchChoices(o) {
  const all = [
    ...o.localBranches.map((name) => ({
      kind: /** @type {const} */ ('local'),
      name,
      label: name,
      checkedOut: o.checkedOut.includes(name),
    })),
    ...o.remoteBranches.map((name) => ({
      kind: /** @type {const} */ ('remote'),
      name,
      label: `origin/${name}`,
      checkedOut: false,
    })),
  ];
  const rank = (c) => c.name === o.defaultBranch ? 0 : 1;
  return all.sort((a, b) =>
    rank(a) - rank(b) || a.name.localeCompare(b.name) ||
    (a.kind === 'local' ? -1 : 1)
  );
}

/**
 * @typedef {{kind: 'local' | 'remote', name: string}
 *   | {kind: 'pr', number: number, head: string | null}} WorktreeBase
 * What a worktree starts from: a local branch, `origin/<name>`, or a PR (`head`: its branch on
 * origin; null for a fork's).
 */

/** How a base reads in a note. @param {WorktreeBase} base */
function baseLabel(base) {
  return base.kind === 'pr'
    ? `pull request #${base.number}`
    : base.kind === 'remote'
    ? `origin/${base.name}`
    : base.name;
}

/**
 * What Create will do for the dialog's current choice, and every reason it can't, by the field it
 * belongs to (`errors.base`: the list; `errors.branch`, `errors.folder`), short, so the dialog
 * shows each under its field and all at once. `note` (what Create will do) only once nothing
 * blocks it. The target `branch` defaults to the base's name; another name is a new local branch
 * from the base. As the server decides: a branch that exists locally is checked out as is; a
 * remote branch (or a same-repo PR's) under its own name is created tracking it; anything else is
 * a new branch with no upstream.
 *
 * @param {{tab: 'pr' | 'branch', base: WorktreeBase | null, branch: string, name: string,
 *   localBranches: string[], checkedOut: string[], folders: string[]}} s
 * @returns {{errors: {base?: string, branch?: string, folder?: string}, note: string,
 *   blocked: boolean}}
 */
export function worktreeNote(s) {
  if (s.base === null) {
    return {
      errors: {
        base: s.tab === 'pr' ? 'Pick a pull request' : 'Pick a branch',
      },
      note: '',
      blocked: true,
    };
  }
  /** @type {{branch?: string, folder?: string}} */
  const errors = {};
  if (s.branch === '') errors.branch = 'Required';
  else if (s.checkedOut.includes(s.branch)) {
    errors.branch = 'Checked out in another worktree';
  }
  if (s.name === '') errors.folder = 'Required';
  else if (s.folders.includes(s.name)) errors.folder = 'Already exists';
  if (errors.branch || errors.folder) {
    return { errors, note: '', blocked: true };
  }
  const ok = (note) => ({ errors: {}, note, blocked: false });
  if (s.localBranches.includes(s.branch)) {
    return ok(`Checks out ${s.branch} as is`);
  }
  const tracked = s.base.kind === 'remote'
    ? s.base.name
    : s.base.kind === 'pr'
    ? s.base.head
    : null;
  if (tracked !== null && s.branch === tracked) {
    return ok(`Creates ${s.branch} tracking origin/${tracked}`);
  }
  return ok(`Creates ${s.branch} from ${baseLabel(s.base)}, no upstream`);
}
