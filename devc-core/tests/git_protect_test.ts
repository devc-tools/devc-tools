// Git protection: the derivation (`mounts.ts`), the row selection and opt-out (`overlay.ts`),
// the Compose refusal, and the runtime verification `devc status` reports.

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from 'jsr:@std/assert@^1';
import { gitProtectMounts, parseMountSpec, unfoldHome } from '../mounts.ts';
import {
  assertGitProtectSupported,
  findRepoRoot,
  gitProtectLayer,
  gitProtectRows,
  gitProtectState,
  readGitProtect,
  stripDevcOnlyKeys,
} from '../overlay.ts';
import { ensureMergedConfig } from '../merged_config.ts';
import { withTemp } from './helpers.ts';

/** Write `text` to `path`, creating parent directories. */
async function write(path: string, text: string): Promise<void> {
  await Deno.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true });
  await Deno.writeTextFile(path, text);
}

/** A host directory that looks like a primary git repo to the derivation's rule 1. */
async function repo(path: string): Promise<string> {
  await Deno.mkdir(`${path}/.git/hooks`, { recursive: true });
  await Deno.writeTextFile(`${path}/.git/config`, '[core]\n');
  return path;
}

// ── the derivation (mounts.ts) ──────────────────────────────────────────────────────────────

Deno.test('a repo row derives three mounts: .git rw, config and hooks readonly', () => {
  assertEquals(
    gitProtectMounts(
      { source: '/Users/me/code/app', target: '/workspaces/app' },
      '/Users/me',
    ),
    [
      'type=bind,source=${localEnv:HOME}/code/app/.git,target=/workspaces/app/.git',
      'type=bind,source=${localEnv:HOME}/code/app/.git/config,target=/workspaces/app/.git/config,readonly',
      'type=bind,source=${localEnv:HOME}/code/app/.git/hooks,target=/workspaces/app/.git/hooks,readonly',
    ],
  );
});

// Parent before child: Docker sorts by destination anyway, but a config that reads in the wrong
// order is a config nobody can check by eye.
Deno.test('the .git mount comes first, and it is the only writable one', () => {
  const [first, ...rest] = gitProtectMounts(
    { source: '/src', target: '/workspaces/app' },
    '/Users/me',
  );
  assert(first.endsWith('target=/workspaces/app/.git'));
  assert(!first.includes('readonly'));
  for (const spec of rest) assertStringIncludes(spec, ',readonly');
});

// `${localEnv:HOME}` is never re-folded, so a row already written that way round-trips.
Deno.test('an already-folded source is left alone', () => {
  const [first] = gitProtectMounts(
    { source: '${localEnv:HOME}/code/app', target: '/workspaces/app' },
    '/Users/me',
  );
  assertEquals(
    first,
    'type=bind,source=${localEnv:HOME}/code/app/.git,target=/workspaces/app/.git',
  );
});

Deno.test('unfoldHome is foldHome inverted, and leaves other variables alone', () => {
  assertEquals(
    unfoldHome('${localEnv:HOME}/code', '/Users/me'),
    '/Users/me/code',
  );
  assertEquals(unfoldHome('~/code', '/Users/me'), '/Users/me/code');
  assertEquals(unfoldHome('${localEnv:HOME}', '/Users/me'), '/Users/me');
  assertEquals(unfoldHome('/abs/code', '/Users/me'), '/abs/code');
  assertEquals(
    unfoldHome('${localWorkspaceFolder}/x', '/Users/me'),
    '${localWorkspaceFolder}/x',
  );
});

Deno.test('parseMountSpec reads both entry forms, and every spelling of read-only', () => {
  assertEquals(parseMountSpec('type=bind,source=/a,target=/b'), {
    type: 'bind',
    source: '/a',
    target: '/b',
    readonly: false,
  });
  assertEquals(
    parseMountSpec('type=bind,source=/a,target=/b,readonly')?.readonly,
    true,
  );
  assertEquals(parseMountSpec('type=bind,source=/a,dst=/b,ro')?.readonly, true);
  assertEquals(
    parseMountSpec('type=bind,source=/a,target=/b,readonly=true')?.readonly,
    true,
  );
  assertEquals(parseMountSpec('type=volume,target=/b')?.type, 'volume');
  assertEquals(
    parseMountSpec({
      type: 'bind',
      source: '/a',
      target: '/b',
      readonly: true,
    }),
    { type: 'bind', source: '/a', target: '/b', readonly: true },
  );
  // No target at all is not a mount this can derive from.
  assertEquals(parseMountSpec('type=bind,source=/a'), null);
  assertEquals(parseMountSpec(42), null);
});

// ── row selection (overlay.ts) ──────────────────────────────────────────────────────────────

Deno.test('a normal repo row is kept; .worktrees, worktree and non-repo rows are not', async () => {
  await withTemp(async (dir) => {
    await repo(`${dir}/app`);
    await Deno.mkdir(`${dir}/app.worktrees/feature`, { recursive: true });
    // A linked worktree: `.git` is a *file*, and nothing can be mounted beneath a file.
    await Deno.mkdir(`${dir}/wt`, { recursive: true });
    await Deno.writeTextFile(
      `${dir}/wt/.git`,
      'gitdir: ../app/.git/worktrees/wt\n',
    );
    await Deno.mkdir(`${dir}/plain`, { recursive: true });

    const rows = await gitProtectRows({
      mounts: [
        `type=bind,source=${dir}/app,target=/workspaces/app`,
        `type=bind,source=${dir}/app.worktrees,target=/workspaces/app.worktrees`,
        `type=bind,source=${dir}/wt,target=/workspaces/wt`,
        `type=bind,source=${dir}/plain,target=/workspaces/plain`,
      ],
    }, `${dir}/nowhere`);

    assertEquals(rows.map((r) => r.target), ['/workspaces/app']);
  });
});

Deno.test('a volume row and an already-readonly repo row derive nothing', async () => {
  await withTemp(async (dir) => {
    await repo(`${dir}/frozen`);
    const rows = await gitProtectRows({
      mounts: [
        `type=bind,source=${dir}/frozen,target=/workspaces/frozen,readonly`,
        'type=volume,source=cache,target=/workspaces/cache',
      ],
    }, `${dir}/nowhere`);
    assertEquals(rows, []);
  });
});

Deno.test("the project's own repo is a row, even though it is no devc:source entry", async () => {
  await withTemp(async (dir) => {
    await repo(`${dir}/myproj`);
    const rows = await gitProtectRows({}, `${dir}/myproj`);
    assertEquals(rows, [{
      source: `${dir}/myproj`,
      target: '/workspaces/myproj',
      kind: 'repo',
    }]);
  });
});

// The CLI mounts the *git root* (`--mount-workspace-git-root`, on by default), not the folder
// you pointed at — so a project in a subdirectory has its whole repo bound, `.git` included.
Deno.test('a project inside a repo subdirectory protects the repo root', async () => {
  await withTemp(async (dir) => {
    await repo(`${dir}/monorepo`);
    await Deno.mkdir(`${dir}/monorepo/packages/web`, { recursive: true });
    const rows = await gitProtectRows({}, `${dir}/monorepo/packages/web`);
    assertEquals(rows, [{
      source: `${dir}/monorepo`,
      target: '/workspaces/monorepo',
      kind: 'repo',
    }]);
  });
});

Deno.test('an explicit workspaceMount replaces the derived workspace row', async () => {
  await withTemp(async (dir) => {
    await repo(`${dir}/myproj`);
    await repo(`${dir}/elsewhere`);
    const rows = await gitProtectRows({
      workspaceMount: `type=bind,source=${dir}/elsewhere,target=/src`,
    }, `${dir}/myproj`);
    assertEquals(rows, [{
      source: `${dir}/elsewhere`,
      target: '/src',
      kind: 'repo',
    }]);
  });
});

Deno.test('a project listed as its own source row is not derived twice', async () => {
  await withTemp(async (dir) => {
    await repo(`${dir}/myproj`);
    const rows = await gitProtectRows({
      mounts: [`type=bind,source=${dir}/myproj,target=/workspaces/myproj`],
    }, `${dir}/myproj`);
    assertEquals(rows.length, 1);
  });
});

// ── the opt-out ─────────────────────────────────────────────────────────────────────────────

Deno.test('gitProtect: false derives nothing at all', async () => {
  await withTemp(async (dir) => {
    await repo(`${dir}/app`);
    const rows = await gitProtectRows({
      gitProtect: false,
      mounts: [`type=bind,source=${dir}/app,target=/workspaces/app`],
    }, `${dir}/nowhere`);
    assertEquals(rows, []);
  });
});

Deno.test('gitProtect.exclude drops the named target and keeps the rest', async () => {
  await withTemp(async (dir) => {
    await repo(`${dir}/a`);
    await repo(`${dir}/b`);
    const rows = await gitProtectRows({
      gitProtect: { exclude: ['/workspaces/a'] },
      mounts: [
        `type=bind,source=${dir}/a,target=/workspaces/a`,
        `type=bind,source=${dir}/b,target=/workspaces/b`,
      ],
    }, `${dir}/nowhere`);
    assertEquals(rows.map((r) => r.target), ['/workspaces/b']);
  });
});

// An unrecognized shape is an error, not a silent `true`: a security control that reads as
// enabled while doing nothing is the one failure mode worth refusing to start over.
Deno.test('an unrecognized gitProtect shape is an error', () => {
  for (
    const bad of ['false', 0, [], { exclude: '/workspaces/a' }, {
      exclude: [1],
    }, {
      excludes: [],
    }]
  ) {
    assertThrows(
      () => readGitProtect(bad, 'devc.jsonc'),
      Error,
      'gitProtect',
    );
  }
  assertEquals(readGitProtect(undefined, 'devc.jsonc'), true);
  assertEquals(readGitProtect(true, 'devc.jsonc'), true);
  assertEquals(readGitProtect(false, 'devc.jsonc'), false);
  assertEquals(readGitProtect({ exclude: ['/a'] }, 'devc.jsonc'), {
    exclude: ['/a'],
  });
});

Deno.test('gitProtect never reaches the config the devcontainer CLI is handed', () => {
  assertEquals(stripDevcOnlyKeys({ image: 'x', gitProtect: false }), {
    image: 'x',
  });
});

// ── the Compose refusal ─────────────────────────────────────────────────────────────────────

Deno.test('Compose + git protection on is refused, naming compose and the acknowledgement', () => {
  const err = assertThrows(
    () =>
      assertGitProtectSupported({
        dockerComposeFile: 'docker-compose.yml',
        service: 'app',
      }),
    Error,
  );
  assertStringIncludes(err.message, 'Compose');
  assertStringIncludes(err.message, '"gitProtect": false');
});

Deno.test('Compose + gitProtect: false proceeds', () => {
  assertGitProtectSupported({
    dockerComposeFile: 'docker-compose.yml',
    gitProtect: false,
  });
});

Deno.test('ensureMergedConfig refuses a Compose project and proceeds once acknowledged', async () => {
  await withTemp(async (dir) => {
    const project = await repo(`${dir}/proj`);
    const opts = {
      cacheRoot: `${dir}/cache`,
      templatesDir: `${dir}/no-templates`,
      configDir: `${dir}/config`,
    };
    await write(
      `${project}/.devcontainer/devcontainer.json`,
      '{"dockerComposeFile":"docker-compose.yml","service":"app","workspaceFolder":"/src"}',
    );

    const err = await assertRejects(
      () => ensureMergedConfig(project, opts),
      Error,
    );
    assertStringIncludes(err.message, 'Compose');
    assertStringIncludes(err.message, '"gitProtect": false');

    await write(`${project}/.devc/devc.jsonc`, '{"gitProtect": false}');
    const merged = await ensureMergedConfig(project, opts);
    assertEquals(merged.gitProtect, false);
    assertEquals(merged.protectedRows, []);
    assertEquals(merged.config.gitProtect, undefined);
  });
});

// ── the merged layer ────────────────────────────────────────────────────────────────────────

Deno.test('ensureMergedConfig contributes the three mounts, overridable by the user', async () => {
  await withTemp(async (dir) => {
    const project = await repo(`${dir}/proj`);
    const opts = {
      cacheRoot: `${dir}/cache`,
      templatesDir: `${dir}/no-templates`,
      configDir: `${dir}/config`,
    };
    await write(
      `${project}/.devcontainer/devcontainer.json`,
      '{"image":"ubuntu"}',
    );

    const merged = await ensureMergedConfig(project, opts);
    assertEquals(merged.protectedRows.map((r) => r.target), [
      '/workspaces/proj',
    ]);
    const mounts = merged.config.mounts as string[];
    assert(
      mounts.includes(
        `type=bind,source=${project}/.git/config,target=/workspaces/proj/.git/config,readonly`,
      ),
      `derived config mount missing from ${JSON.stringify(mounts)}`,
    );

    // The merge's target dedupe is the per-mount escape hatch: a user mount on a derived target
    // replaces it in place rather than colliding with it.
    await write(
      `${project}/.devc/devc.jsonc`,
      `{"mounts":["type=bind,source=${project}/.git/config,target=/workspaces/proj/.git/config"]}`,
    );
    const overridden = await ensureMergedConfig(project, opts);
    const after = overridden.config.mounts as string[];
    assert(
      after.includes(
        `type=bind,source=${project}/.git/config,target=/workspaces/proj/.git/config`,
      ),
    );
    assertEquals(
      after.filter((m) => m.includes('target=/workspaces/proj/.git/config'))
        .length,
      1,
    );
  });
});

Deno.test('gitProtectLayer contributes nothing when there is nothing to protect', () => {
  assertEquals(gitProtectLayer([]), {});
});

// ── runtime verification ────────────────────────────────────────────────────────────────────

const row = { source: '/src', target: '/workspaces/app' };

Deno.test('gitProtectState: all three mounts present and correctly flagged', () => {
  assertEquals(
    gitProtectState(row, [
      { destination: '/workspaces/app/.git', rw: true },
      { destination: '/workspaces/app/.git/config', rw: false },
      { destination: '/workspaces/app/.git/hooks', rw: false },
    ]),
    { target: '/workspaces/app', state: 'protected', problems: [] },
  );
});

Deno.test('gitProtectState: a read-write config mount is a MISMATCH', () => {
  const result = gitProtectState(row, [
    { destination: '/workspaces/app/.git', rw: true },
    { destination: '/workspaces/app/.git/config', rw: true },
    { destination: '/workspaces/app/.git/hooks', rw: false },
  ]);
  assertEquals(result.state, 'MISMATCH');
  assertEquals(result.problems, [
    '/workspaces/app/.git/config is mounted read-write',
  ]);
});

// The `.git` mount is what makes `mv .git .git-old` fail — without it the two read-only mounts
// are stranded on a path nothing reads.
Deno.test('gitProtectState: .git not being a mountpoint is a MISMATCH', () => {
  const result = gitProtectState(row, [
    { destination: '/workspaces/app/.git/config', rw: false },
    { destination: '/workspaces/app/.git/hooks', rw: false },
  ]);
  assertEquals(result.state, 'MISMATCH');
  assertStringIncludes(result.problems[0], 'is not a mountpoint');
});

Deno.test('gitProtectState: a container with none of the mounts is a MISMATCH', () => {
  const result = gitProtectState(row, [
    { destination: '/workspaces/app', rw: true },
  ]);
  assertEquals(result.state, 'MISMATCH');
  assertEquals(result.problems.length, 3);
});

// The walk must terminate at the filesystem root rather than falling through to a relative
// path, which would make it stat `./.git` against the process cwd.
Deno.test('findRepoRoot terminates at / and does not go relative', async () => {
  assertEquals(await findRepoRoot('/'), null);
  assertEquals(await findRepoRoot('/nonexistent-xyz/deep/deeper'), null);
});
