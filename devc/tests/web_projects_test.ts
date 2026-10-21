import { assertEquals } from 'jsr:@std/assert';
import {
  buildProjects,
  isProjectRepo,
  projectRefusal,
  repoFileFor,
  repoName,
} from '../web/projects_view.ts';
import type { GitReading } from '../web/git_status.ts';

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
      {
        folder: '/src/api',
        worktreeOf: null,
        containerFolder: '/workspaces/src/api',
        primaryFolder: null,
      },
      {
        folder: '/tools/lib',
        worktreeOf: null,
        containerFolder: '/src/lib',
        primaryFolder: null,
      },
      {
        folder: '/tools/lib.worktrees/x',
        worktreeOf: '/tools/lib',
        containerFolder: '/workspaces/lib.worktrees/x',
        primaryFolder: null,
      },
      {
        folder: '/tools/lib.worktrees/y',
        worktreeOf: '/tools/lib',
        containerFolder: null,
        primaryFolder: null,
      },
    ]]]),
    new Map<string, GitReading>([
      ['/src/api', git],
      ['/tools/lib', null],
      ['/tools/lib.worktrees/y', { problem: 'git fetch: timed out' }],
    ]),
  );
  assertEquals(api.repos, [
    {
      folder: '/src/api',
      worktreeOf: null,
      containerFolder: '/workspaces/src/api',
      primaryFolder: null,
      name: 'src/api',
      git,
    },
    {
      folder: '/tools/lib',
      worktreeOf: null,
      containerFolder: '/src/lib',
      primaryFolder: null,
      name: 'lib',
      git: null,
    },
    {
      folder: '/tools/lib.worktrees/x',
      worktreeOf: '/tools/lib',
      containerFolder: '/workspaces/lib.worktrees/x',
      primaryFolder: null,
      name: 'lib.worktrees/x',
    },
    {
      folder: '/tools/lib.worktrees/y',
      worktreeOf: '/tools/lib',
      containerFolder: null,
      primaryFolder: null,
      name: 'y',
      git: null,
      gitProblem: 'git fetch: timed out',
    },
  ]);
  // No container mounts known: just the folder itself, not read yet.
  assertEquals(blog.repos, [
    {
      folder: '/src/blog',
      worktreeOf: null,
      containerFolder: null,
      primaryFolder: null,
      name: 'blog',
    },
  ]);
});

Deno.test('buildProjects orders repos by name, the project folder first', () => {
  const repo = (
    folder: string,
    containerFolder: string | null,
    worktreeOf: string | null = null,
  ) => ({ folder, worktreeOf, containerFolder, primaryFolder: null });
  const [p] = buildProjects(
    [{ localFolder: '/src/zed', pinned: false, lastUsed: null }],
    ['/src/zed'],
    [],
    new Set(),
    // As mountedRepos lists them: by folder basename.
    new Map([['/src/zed', [
      repo('/src/zed', '/workspaces/zed'),
      repo('/src/zed.worktrees/b', '/workspaces/zed.worktrees/b', '/src/zed'),
      repo('/h/alpha', '/workspaces/x/alpha'),
      repo('/h/alpha.worktrees/m', '/workspaces/a/m', '/h/alpha'),
      repo('/h/alpha.worktrees/n', '/workspaces/0/n', '/h/alpha'),
      repo('/h/beta', '/workspaces/b/beta'),
      repo('/h/orphan.worktrees/o', '/workspaces/c/o', '/h/orphan'),
    ]]]),
  );
  assertEquals(p.repos.map((r) => r.name), [
    'zed',
    'zed.worktrees/b',
    'b/beta',
    'c/o',
    'x/alpha',
    '0/n',
    'a/m',
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
  for (
    const type of ['stop_project', 'down_project', 'forget_project', 'list_dir']
  ) {
    assertEquals(projectRefusal({ type }, false), null);
  }
});

Deno.test("isProjectRepo: only a listed project's own repo folders are roots", () => {
  const views = buildProjects(
    [],
    ['/src/api'],
    ['/src/web'],
    new Set(),
    new Map([['/src/api', [
      {
        folder: '/src/api',
        worktreeOf: null,
        containerFolder: null,
        primaryFolder: null,
      },
      {
        folder: '/src/shared-lib',
        worktreeOf: null,
        containerFolder: null,
        primaryFolder: null,
      },
      {
        folder: '/src/api.worktrees/fix',
        worktreeOf: '/src/api',
        containerFolder: null,
        primaryFolder: null,
      },
    ]]]),
  );
  assertEquals(isProjectRepo(views, '/src/api', '/src/api'), true);
  assertEquals(isProjectRepo(views, '/src/api', '/src/shared-lib'), true);
  assertEquals(
    isProjectRepo(views, '/src/api', '/src/api.worktrees/fix'),
    true,
  );
  assertEquals(isProjectRepo(views, '/src/web', '/src/web'), true);
  // Another project's folder, a folder no project has, a project not listed.
  assertEquals(isProjectRepo(views, '/src/api', '/src/web'), false);
  assertEquals(isProjectRepo(views, '/src/web', '/src/shared-lib'), false);
  assertEquals(isProjectRepo(views, '/src/api', '/etc'), false);
  assertEquals(isProjectRepo(views, '/src/nope', '/src/nope'), false);
});

Deno.test('repoFileFor: the innermost repo of that project holding the path', () => {
  const views = buildProjects(
    [],
    ['/src/api'],
    ['/src/web'],
    new Set(),
    new Map([['/src/api', [
      {
        folder: '/src/api',
        worktreeOf: null,
        containerFolder: null,
        primaryFolder: null,
      },
      {
        folder: '/src/shared-lib',
        worktreeOf: null,
        containerFolder: null,
        primaryFolder: null,
      },
      {
        folder: '/src/api/vendor/lib',
        worktreeOf: null,
        containerFolder: null,
        primaryFolder: null,
      },
    ]]]),
  );
  assertEquals(repoFileFor(views, '/src/api', '/src/api/src/a.ts'), {
    root: '/src/api',
    path: 'src/a.ts',
  });
  assertEquals(repoFileFor(views, '/src/api', '/src/shared-lib/x.go'), {
    root: '/src/shared-lib',
    path: 'x.go',
  });
  assertEquals(repoFileFor(views, '/src/api', '/src/api/vendor/lib/b.ts'), {
    root: '/src/api/vendor/lib',
    path: 'b.ts',
  });
  assertEquals(repoFileFor(views, '/src/api', '/src/api'), {
    root: '/src/api',
    path: '',
  });
  // A sibling sharing a prefix, another project's repo, a path in no repo.
  assertEquals(repoFileFor(views, '/src/api', '/src/api2/a.ts'), null);
  assertEquals(repoFileFor(views, '/src/api', '/src/web/a.ts'), null);
  assertEquals(repoFileFor(views, '/src/api', '/etc/passwd'), null);
});

Deno.test('repoName: the path under /workspaces, else the basename', () => {
  const cases: [string, string | null, string][] = [
    ['/h/devc-tools', '/workspaces/tools/devc-tools', 'tools/devc-tools'],
    ['/h/app', '/workspaces/app/', 'app'],
    ['/h/a.worktrees/fix', '/workspaces/a.worktrees/fix', 'a.worktrees/fix'],
    ['/h/ws', '/workspaces', 'ws'],
    ['/h/app', '/src/app', 'app'],
    ['/h/app', null, 'app'],
    ['/', null, '/'],
    ['/h/x', '/workspacesx/y', 'x'],
  ];
  for (const [folder, containerFolder, want] of cases) {
    assertEquals(repoName(folder, containerFolder), want, folder);
  }
});
