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

const ok = (note: string) => ({ errors: {}, note, blocked: false });
const blocked = (
  errors: { base?: string; branch?: string; folder?: string },
) => ({ errors, note: '', blocked: true });

Deno.test('worktreeNote: what Create will do from each base', () => {
  // origin/x under its own name: created tracking it.
  assertEquals(
    note({ kind: 'remote', name: 'feature/b' }, 'feature/b'),
    ok('Creates feature/b tracking origin/feature/b'),
  );
  // Another name: a new branch, no upstream.
  assertEquals(
    note({ kind: 'remote', name: 'main' }, 'mine'),
    ok('Creates mine from origin/main, no upstream'),
  );
  assertEquals(
    note({ kind: 'local', name: 'feature/a' }, 'mine'),
    ok('Creates mine from feature/a, no upstream'),
  );
  // A branch that exists locally is checked out as is, whatever the base.
  assertEquals(
    note({ kind: 'local', name: 'feature/a' }, 'feature/a'),
    ok('Checks out feature/a as is'),
  );
  assertEquals(
    note({ kind: 'remote', name: 'feature/a' }, 'feature/a'),
    ok('Checks out feature/a as is'),
  );
  // PRs: a same-repo one tracks its branch; a fork's has none.
  assertEquals(
    note({ kind: 'pr', number: 8, head: 'feature/b' }, 'feature/b', {
      tab: 'pr',
    }),
    ok('Creates feature/b tracking origin/feature/b'),
  );
  assertEquals(
    note({ kind: 'pr', number: 7, head: null }, 'pr-7', { tab: 'pr' }),
    ok('Creates pr-7 from pull request #7, no upstream'),
  );
});

Deno.test('worktreeNote: each problem under its own field, all at once', () => {
  assertEquals(note(null, ''), blocked({ base: 'Pick a branch' }));
  assertEquals(
    note(null, '', { tab: 'pr' }),
    blocked({ base: 'Pick a pull request' }),
  );
  const main = { kind: 'remote' as const, name: 'main' };
  assertEquals(
    note(main, '', { name: 'f' }),
    blocked({ branch: 'Required' }),
  );
  assertEquals(note(main, 'x', { name: '' }), blocked({ folder: 'Required' }));
  assertEquals(
    note(main, 'x', { name: 'old' }),
    blocked({ folder: 'Already exists' }),
  );
  assertEquals(
    note(main, 'main'),
    blocked({ branch: 'Checked out in another worktree' }),
  );
  assertEquals(
    note(main, 'main', { name: 'old' }),
    blocked({
      branch: 'Checked out in another worktree',
      folder: 'Already exists',
    }),
  );
  assertEquals(
    note(main, '', { name: '' }),
    blocked({ branch: 'Required', folder: 'Required' }),
  );
});
