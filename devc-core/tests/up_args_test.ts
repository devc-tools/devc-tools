import { assertEquals } from 'jsr:@std/assert@^1';
import { buildUpArgs } from '../container.ts';

const BASE = {
  localFolder: '/home/me/src/p',
  worktree: false,
  rebuild: false,
  noCache: false,
  mergedConfigPath:
    '/home/me/.cache/devc/projects/p-0badf00d/devcontainer.json',
  mode: 'project' as const,
};

// The whole point of merging rather than translating: everything the overlay contributes is
// inside the config file now, so there is nothing per-mount, per-env or per-Feature on the
// command line to get wrong.
Deno.test('no per-mount, per-env or per-Feature args are ever emitted', () => {
  const args = buildUpArgs({
    ...BASE,
    worktree: true,
    rebuild: true,
    noCache: true,
  });
  for (const flag of ['--mount', '--remote-env', '--additional-features']) {
    assertEquals(args.includes(flag), false, `${flag} should be gone`);
  }
});

Deno.test('project mode delivers the merged config as --override-config', () => {
  assertEquals(buildUpArgs(BASE), [
    'up',
    '--workspace-folder',
    '/home/me/src/p',
    '--no-lockfile',
    '--override-config',
    '/home/me/.cache/devc/projects/p-0badf00d/devcontainer.json',
  ]);
});

// Not --override-config: that would record `<project>/.devcontainer/devcontainer.json` as the
// config path, which is the same container identity a later `devc init` produces — so devc
// would silently reuse this container for a project that had since gained its own config.
Deno.test('zero-config mode delivers the merged config as --config', () => {
  assertEquals(buildUpArgs({ ...BASE, mode: 'zero-config' }), [
    'up',
    '--workspace-folder',
    '/home/me/src/p',
    '--no-lockfile',
    '--config',
    '/home/me/.cache/devc/projects/p-0badf00d/devcontainer.json',
  ]);
});

// Not optional, and not mode-dependent. A Feature lockfile beside the merged config pins every
// floating reference to the digest it first resolved and honours it forever after: in
// zero-config mode that file sits in devc's cache where nobody sees it (which is how `agents`
// and `node-nvmrc` stayed at 0.1.0 long after they declared their volumes), and in project mode
// the CLI writes it into the user's own `.devcontainer/`. See buildUpArgs' doc comment.
Deno.test('--no-lockfile is passed in both modes, always', () => {
  for (const mode of ['project', 'zero-config'] as const) {
    for (const worktree of [false, true]) {
      for (const rebuild of [false, true]) {
        assertEquals(
          buildUpArgs({ ...BASE, mode, worktree, rebuild }).includes(
            '--no-lockfile',
          ),
          true,
          `${mode}/worktree=${worktree}/rebuild=${rebuild}`,
        );
      }
    }
  }
});

Deno.test("devc's own flags come before the config, in a fixed order", () => {
  assertEquals(
    buildUpArgs({
      ...BASE,
      worktree: true,
      rebuild: true,
      noCache: true,
      mode: 'zero-config',
    }),
    [
      'up',
      '--workspace-folder',
      '/home/me/src/p',
      '--no-lockfile',
      '--mount-git-worktree-common-dir',
      '--remove-existing-container',
      '--build-no-cache',
      '--config',
      '/home/me/.cache/devc/projects/p-0badf00d/devcontainer.json',
    ],
  );
});

Deno.test('each optional flag appears only when asked for', () => {
  assertEquals(
    buildUpArgs({ ...BASE, worktree: true }).includes(
      '--mount-git-worktree-common-dir',
    ),
    true,
  );
  assertEquals(
    buildUpArgs(BASE).includes('--mount-git-worktree-common-dir'),
    false,
  );
  assertEquals(
    buildUpArgs({ ...BASE, rebuild: true }).includes(
      '--remove-existing-container',
    ),
    true,
  );
  assertEquals(
    buildUpArgs(BASE).includes('--remove-existing-container'),
    false,
  );
  assertEquals(
    buildUpArgs({ ...BASE, noCache: true }).includes('--build-no-cache'),
    true,
  );
  assertEquals(buildUpArgs(BASE).includes('--build-no-cache'), false);
});
