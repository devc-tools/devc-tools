import { assertEquals } from 'jsr:@std/assert';
import { folderNameFor, worktreeNote } from '../web/static/lib/worktree.js';

const base = {
  kind: 'pr' as const,
  branch: 'feature/a',
  name: 'feature-a',
  localBranches: ['main'],
  checkedOut: ['main'],
  folders: ['old'],
};

Deno.test('folderNameFor turns every / into -', () => {
  assertEquals(folderNameFor('feature/a/b'), 'feature-a-b');
  assertEquals(folderNameFor('plain'), 'plain');
});

Deno.test('worktreeNote: what blocks Create, and what only notes', () => {
  assertEquals(worktreeNote(base), { note: '', blocked: false });
  assertEquals(worktreeNote({ ...base, branch: '' }), {
    note: '',
    blocked: true,
  });
  assertEquals(worktreeNote({ ...base, name: 'old' }), {
    note: 'folder already exists',
    blocked: true,
  });
  assertEquals(worktreeNote({ ...base, branch: 'main' }), {
    note:
      'checked out in another worktree: give the branch a new name to start a new branch from it',
    blocked: true,
  });
  const existing = { ...base, localBranches: ['main', 'feature/a'] };
  assertEquals(worktreeNote(existing), {
    note: 'uses the existing local branch as is',
    blocked: false,
  });
  assertEquals(worktreeNote({ ...existing, kind: 'remote' }).blocked, false);
  assertEquals(worktreeNote({ ...existing, kind: 'new' }), {
    note: 'branch already exists',
    blocked: true,
  });
});

Deno.test('worktreeNote: a renamed branch from a remote one, and the way round a checked-out one', () => {
  const remote = { ...base, kind: 'remote' as const, source: 'feature/a' };
  assertEquals(worktreeNote(remote), { note: '', blocked: false });
  assertEquals(worktreeNote({ ...remote, branch: 'mine' }), {
    note: 'a new branch from origin/feature/a, with no upstream',
    blocked: false,
  });
  assertEquals(worktreeNote({ ...remote, checkedOut: ['feature/a'] }), {
    note:
      'checked out in another worktree: give the branch a new name to start a new branch from it',
    blocked: true,
  });
  // A fork's PR has no branch on origin: nothing to say.
  assertEquals(
    worktreeNote({ ...base, kind: 'pr', branch: 'pr-7', source: null }),
    { note: '', blocked: false },
  );
  assertEquals(
    worktreeNote({ ...base, kind: 'new', checkedOut: ['feature/a'] }).note,
    'checked out in another worktree',
  );
});
