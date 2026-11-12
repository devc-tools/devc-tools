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
    note: 'checked out in another worktree',
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
