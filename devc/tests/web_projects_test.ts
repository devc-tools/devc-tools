import { assertEquals } from 'jsr:@std/assert';
import { buildProjects } from '../web/projects_view.ts';

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
  assertEquals(views, [
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

Deno.test('buildProjects sorts same-named folders by path', () => {
  const views = buildProjects(
    [],
    ['/b/app', '/a/app'],
    [],
    new Set(),
  );
  assertEquals(views.map((v) => v.localFolder), ['/a/app', '/b/app']);
});
