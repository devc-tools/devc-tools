import { assertEquals } from 'jsr:@std/assert';
import {
  branchChoices,
  folderNameFor,
  worktreeNote,
} from '../web/static/lib/worktree.js';

Deno.test('folderNameFor turns every / into -', () => {
  assertEquals(folderNameFor('feature/a/b'), 'feature-a-b');
  assertEquals(folderNameFor('plain'), 'plain');
});

Deno.test("branchChoices: the default branch's first, then by name, local before origin", () => {
  assertEquals(
    branchChoices({
      localBranches: ['zed', 'main', 'feature/a'],
      remoteBranches: ['feature/a', 'main', 'b'],
      checkedOut: ['main'],
      defaultBranch: 'main',
    }).map((c) => [c.label, c.kind, c.checkedOut]),
    [
      ['main', 'local', true],
      ['origin/main', 'remote', false],
      ['origin/b', 'remote', false],
      ['feature/a', 'local', false],
      ['origin/feature/a', 'remote', false],
      ['zed', 'local', false],
    ],
  );
});

const lists = {
  localBranches: ['main', 'feature/a'],
  checkedOut: ['main'],
  folders: ['old'],
};
const note = (
  base: Parameters<typeof worktreeNote>[0]['base'],
  branch: string,
  extra: Partial<Parameters<typeof worktreeNote>[0]> = {},
) =>
  worktreeNote({
    tab: 'branch',
    base,
    branch,
    name: folderNameFor(branch),
    ...lists,
    ...extra,
  });

Deno.test('worktreeNote: what Create will do from each base', () => {
  // origin/x under its own name: created tracking it.
  assertEquals(note({ kind: 'remote', name: 'feature/b' }, 'feature/b'), {
    note: 'creates feature/b tracking origin/feature/b',
    blocked: false,
  });
  // Another name: a new branch, no upstream.
  assertEquals(note({ kind: 'remote', name: 'main' }, 'mine'), {
    note: 'creates mine from origin/main, with no upstream',
    blocked: false,
  });
  assertEquals(note({ kind: 'local', name: 'feature/a' }, 'mine'), {
    note: 'creates mine from feature/a, with no upstream',
    blocked: false,
  });
  // A branch that exists locally is checked out as is, whatever the base.
  assertEquals(note({ kind: 'local', name: 'feature/a' }, 'feature/a'), {
    note: 'checks out feature/a as is',
    blocked: false,
  });
  assertEquals(note({ kind: 'remote', name: 'feature/a' }, 'feature/a'), {
    note: 'checks out feature/a as is',
    blocked: false,
  });
  // PRs: a same-repo one tracks its branch; a fork's has none.
  assertEquals(
    note({ kind: 'pr', number: 8, head: 'feature/b' }, 'feature/b', {
      tab: 'pr',
    }),
    { note: 'creates feature/b tracking origin/feature/b', blocked: false },
  );
  assertEquals(
    note({ kind: 'pr', number: 7, head: null }, 'pr-7', { tab: 'pr' }),
    {
      note: 'creates pr-7 from pull request #7, with no upstream',
      blocked: false,
    },
  );
});

Deno.test('worktreeNote: what blocks Create', () => {
  assertEquals(note(null, ''), {
    note: 'Pick a branch to start from',
    blocked: true,
  });
  assertEquals(note(null, '', { tab: 'pr' }), {
    note: 'Pick a pull request',
    blocked: true,
  });
  const main = { kind: 'remote' as const, name: 'main' };
  assertEquals(note(main, '', { name: 'f' }), {
    note: 'Name the branch',
    blocked: true,
  });
  assertEquals(note(main, 'x', { name: '' }), {
    note: 'Name the folder',
    blocked: true,
  });
  assertEquals(note(main, 'x', { name: 'old' }), {
    note: 'folder old already exists: give the folder another name',
    blocked: true,
  });
  assertEquals(note(main, 'main'), {
    note:
      'main is checked out in another worktree: give the branch another name',
    blocked: true,
  });
  // Every known problem at once, the branch's first.
  assertEquals(note(main, 'main', { name: 'old' }), {
    note:
      'main is checked out in another worktree: give the branch another name\n' +
      'folder old already exists: give the folder another name',
    blocked: true,
  });
  assertEquals(note(main, '', { name: '' }), {
    note: 'Name the branch\nName the folder',
    blocked: true,
  });
});
