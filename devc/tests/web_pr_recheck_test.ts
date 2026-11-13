import { assertEquals } from 'jsr:@std/assert';
import {
  changedRepos,
  gitSignatures,
  prRepoKey,
} from '../web/static/lib/pr_recheck.js';

const git = (ahead: number, behind = 0) => ({
  branch: 'feat',
  upstream: 'origin/feat',
  ahead,
  behind,
  gone: false,
  unfetched: 0,
});

const projects = (repos: { folder: string; git: unknown }[]) => [
  { localFolder: '/w/app', repos },
  { localFolder: '/w/bad' },
  null,
];

Deno.test('pr recheck: each repo by localFolder and root, skipping malformed entries', () => {
  const sigs = gitSignatures(
    projects([{ folder: '/w/app', git: git(1) }, {
      folder: '/w/app/lib',
      git: null,
    }]),
  );
  assertEquals([...sigs.keys()], [
    prRepoKey('/w/app', '/w/app'),
    prRepoKey('/w/app', '/w/app/lib'),
  ]);
  assertEquals(gitSignatures(undefined).size, 0);
});

Deno.test('pr recheck: a push (ahead drops), a fetch (behind rises) or a branch switch changes a repo; a new repo does not', () => {
  const before = gitSignatures(projects([{ folder: '/w/app', git: git(2) }]));
  const same = gitSignatures(projects([{ folder: '/w/app', git: git(2) }]));
  assertEquals(changedRepos(before, same), new Set());
  const key = prRepoKey('/w/app', '/w/app');
  for (const g of [git(0), git(2, 1), { ...git(2), branch: 'other' }]) {
    assertEquals(
      changedRepos(
        before,
        gitSignatures(projects([{ folder: '/w/app', git: g }])),
      ),
      new Set([key]),
    );
  }
  assertEquals(
    changedRepos(
      new Map(),
      gitSignatures(projects([{ folder: '/w/app', git: git(0) }])),
    ),
    new Set(),
  );
});
