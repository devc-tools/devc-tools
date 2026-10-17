import { assertEquals } from 'jsr:@std/assert';
import { buildProjects, projectRefusal } from '../web/projects_view.ts';

Deno.test('buildProjects merges the list with running and stopped containers', () => {
  const views = buildProjects(
    [
      { localFolder: '/src/blog', pinned: true, lastUsed: null },
      {
        localFolder: '/src/api',
        pinned: false,
        lastUsed: '2026-10-16T00:00:00.000Z',
      },
    ],
    ['/src/api', '/src/web'],
    ['/src/old', '/src/api'],
    new Set(['/src/blog']),
  );
  assertEquals(views.map(({ repos: _, ...v }) => v), [
    {
      localFolder: '/src/api',
      name: 'api',
      pinned: false,
      lastUsed: '2026-10-16T00:00:00.000Z',
      container: 'running',
      starting: false,
    },
    {
      localFolder: '/src/blog',
      name: 'blog',
      pinned: true,
      lastUsed: null,
      container: 'missing',
      starting: true,
    },
    {
      localFolder: '/src/old',
      name: 'old',
      pinned: false,
      lastUsed: null,
      container: 'stopped',
      starting: false,
    },
    {
      localFolder: '/src/web',
      name: 'web',
      pinned: false,
      lastUsed: null,
      container: 'running',
      starting: false,
    },
  ]);
});

Deno.test("buildProjects lists each project's repos with their git state", () => {
  const git = {
    branch: 'main',
    upstream: 'origin/main',
    ahead: 2,
    behind: 0,
    gone: false,
  };
  const [api, blog] = buildProjects(
    [
      { localFolder: '/src/api', pinned: false, lastUsed: null },
      { localFolder: '/src/blog', pinned: false, lastUsed: null },
    ],
    ['/src/api'],
    [],
    new Set(),
    new Map([['/src/api', [
      { folder: '/src/api', worktreeOf: null },
      { folder: '/tools/lib', worktreeOf: null },
      { folder: '/tools/lib.worktrees/x', worktreeOf: '/tools/lib' },
    ]]]),
    new Map([['/src/api', git], ['/tools/lib', null]]),
  );
  assertEquals(api.repos, [
    { folder: '/src/api', worktreeOf: null, name: 'api', git },
    { folder: '/tools/lib', worktreeOf: null, name: 'lib', git: null },
    { folder: '/tools/lib.worktrees/x', worktreeOf: '/tools/lib', name: 'x' },
  ]);
  // No container mounts known: just the folder itself, not read yet.
  assertEquals(blog.repos, [
    { folder: '/src/blog', worktreeOf: null, name: 'blog' },
  ]);
});

Deno.test('buildProjects sorts same-named folders by path', () => {
  const views = buildProjects(
    [],
    ['/b/app', '/a/app'],
    [],
    new Set(),
  );
  assertEquals(views.map((v) => v.localFolder), ['/a/app', '/b/app']);
});

Deno.test('projectRefusal: with starts off, nothing starts, adds or pins', () => {
  for (const type of ['start_project', 'add_project', 'list_host_dir']) {
    assertEquals(projectRefusal({ type }, true), null);
    assertEquals(typeof projectRefusal({ type }, false), 'string');
  }
  const pin = { type: 'pin_project', pinned: true };
  const unpin = { type: 'pin_project', pinned: false };
  assertEquals(projectRefusal(pin, true), null);
  assertEquals(typeof projectRefusal(pin, false), 'string');
  assertEquals(projectRefusal(unpin, false), null);
  for (const type of ['stop_project', 'forget_project', 'list_dir']) {
    assertEquals(projectRefusal({ type }, false), null);
  }
});
