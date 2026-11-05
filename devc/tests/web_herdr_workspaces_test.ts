import { assertEquals } from 'jsr:@std/assert@^1';
import type { MountedRepo } from '../web/git_repo.ts';
import {
  workspaceByLabel,
  workspaceLabel,
  workspaceRepo,
} from '../web/herdr_workspaces.ts';

const repo = (
  folder: string,
  containerFolder: string | null,
): MountedRepo => ({
  folder,
  containerFolder,
  worktreeOf: null,
  primaryFolder: null,
});

const PRIMARY = repo('/host/a', '/workspaces/a');
const NESTED = repo('/host/a/b', '/workspaces/a/b');
const OTHER = repo('/host/c', '/workspaces/c');
const REPOS = [PRIMARY, NESTED, OTHER];

Deno.test('workspaceRepo: the deepest repo holding the cwd', () => {
  assertEquals(workspaceRepo('/workspaces/a/b/src', REPOS, '/host/a'), NESTED);
  assertEquals(workspaceRepo('/workspaces/a/src', REPOS, '/host/a'), PRIMARY);
  assertEquals(workspaceRepo('/workspaces/c', REPOS, '/host/a'), OTHER);
});

Deno.test('workspaceRepo: a sibling prefix is not inside', () => {
  // `/workspaces/ab` is not in `/workspaces/a`: no match, so the primary repo.
  assertEquals(
    workspaceRepo('/workspaces/ab', [OTHER, PRIMARY], '/host/a'),
    PRIMARY,
  );
  assertEquals(
    workspaceRepo('/workspaces/cd', [OTHER], '/host/a'),
    null,
  );
});

Deno.test('workspaceRepo: a cwd in no repo, or none, goes to the primary repo', () => {
  assertEquals(workspaceRepo('/', REPOS, '/host/a'), PRIMARY);
  assertEquals(workspaceRepo(undefined, REPOS, '/host/a'), PRIMARY);
});

Deno.test('workspaceRepo: an unmounted primary means no repo', () => {
  const unmounted = repo('/host/a', null);
  assertEquals(workspaceRepo('/', [unmounted, OTHER], '/host/a'), null);
  assertEquals(workspaceRepo('/', [], '/host/a'), null);
  // A repo with no container folder never matches a cwd either.
  assertEquals(
    workspaceRepo('/host/a', [unmounted, OTHER], '/host/a'),
    null,
  );
});

Deno.test('workspaceRepo: a trailing-slash container folder matches its own folder', () => {
  const slashed = repo('/host/d', '/workspaces/d/');
  assertEquals(workspaceRepo('/workspaces/d', [slashed], '/x'), slashed);
  assertEquals(workspaceRepo('/workspaces/d/e', [slashed], '/x'), slashed);
});

Deno.test('workspaceLabel: the card name', () => {
  assertEquals(
    workspaceLabel(repo('/h/devc-tools', '/workspaces/tools/devc-tools')),
    'tools/devc-tools',
  );
  assertEquals(workspaceLabel(repo('/h/proj', '/home/me/proj')), 'proj');
});

Deno.test('workspaceByLabel: the lowest number of an exact match', () => {
  const listed = {
    workspaces: [
      { workspace_id: 'w3', label: 'tools/devc-tools', number: 3 },
      { workspace_id: 'w1', label: 'other', number: 1 },
      { workspace_id: 'w2', label: 'tools/devc-tools', number: 2 },
    ],
  };
  assertEquals(workspaceByLabel(listed, 'tools/devc-tools'), 'w2');
  assertEquals(workspaceByLabel(listed, 'Tools/devc-tools'), null);
  assertEquals(workspaceByLabel(listed, 'missing'), null);
  assertEquals(workspaceByLabel(undefined, 'other'), null);
  assertEquals(workspaceByLabel({ workspaces: 'x' }, 'other'), null);
});
