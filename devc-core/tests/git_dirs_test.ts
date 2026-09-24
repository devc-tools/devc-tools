// Git protection for the shapes plan 13's `<source>/.git`-is-a-directory rule missed: a row whose
// source *is* a git dir (a primary's `.git` mounted alone, a bare repo, the devcontainer CLI's
// worktree common-dir mount), and umbrella mounts of a folder of repos, which are reported and
// never protected. See .plans/pending/devc-git-protect-git-dirs.md in devc-dev.

import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert@^1';
import { createNodeDevcontainerRunner } from '../devcontainer.ts';
import { ensureMergedConfig } from '../merged_config.ts';
import { gitDirProtectMounts, gitProtectMounts } from '../mounts.ts';
import {
  classifyGitRows,
  gitProtectLayer,
  gitProtectState,
  unprotectedRowStatus,
  unprotectedRowWarning,
  workspaceMountRow,
} from '../overlay.ts';
import { cliWorktreeMounts } from '../worktree.ts';
import { withTemp } from './helpers.ts';

function git(cwd: string, ...args: string[]): void {
  const out = new Deno.Command('git', {
    args: ['-c', 'init.defaultBranch=main', ...args],
    cwd,
    stdout: 'null',
    stderr: 'piped',
    env: {
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  }).outputSync();
  if (!out.success) {
    throw new Error(
      `git ${args.join(' ')}: ${new TextDecoder().decode(out.stderr)}`,
    );
  }
}

/** A real repo with one commit, at `path`. */
function repoAt(path: string): string {
  Deno.mkdirSync(path, { recursive: true });
  git(path, 'init', '-q');
  git(path, 'commit', '-q', '--allow-empty', '-m', 'init');
  return path;
}

/**
 * A linked worktree of `primary` at `path`, with **relative** pointers both ways — what
 * `git worktree add --relative-paths` (git 2.48+) writes, done by hand so the test runs on older
 * git too. The CLI mounts a common dir only for a relative `gitdir:`.
 */
function worktreeAt(primary: string, path: string, branch: string): string {
  git(primary, 'worktree', 'add', '-q', '-b', branch, path);
  const name = Deno.readTextFileSync(`${path}/.git`).trim().split('/').pop()!;
  const gitDir = `${primary}/.git/worktrees/${name}`;
  Deno.writeTextFileSync(
    `${path}/.git`,
    `gitdir: ${relative(path, gitDir)}\n`,
  );
  Deno.writeTextFileSync(
    `${gitDir}/gitdir`,
    `${relative(gitDir, `${path}/.git`)}\n`,
  );
  return path;
}

/** `to` relative to the directory `from`, both absolute. */
function relative(from: string, to: string): string {
  const a = from.split('/').filter(Boolean);
  const b = to.split('/').filter(Boolean);
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return [...a.slice(i).map(() => '..'), ...b.slice(i)].join('/');
}

const bind = (source: string, target: string) =>
  `type=bind,source=${source},target=${target}`;

// ── the eight shapes ────────────────────────────────────────────────────────────────────────

Deno.test('the eight shapes: 1/2/5/7 unchanged, 3/6/8 gitdir, 4 umbrella', async () => {
  await withTemp(async (dir) => {
    const c = `${dir}/code`;
    const app = repoAt(`${c}/app`);
    const lib = repoAt(`${c}/lib`);
    worktreeAt(app, `${c}/app.worktrees/feat`, 'feat');
    Deno.mkdirSync(`${c}/bare`, { recursive: true });
    git(`${c}/bare`, 'init', '-q', '--bare', 'x.git');
    const nowhere = `${dir}/nowhere`;

    const classify = async (mounts: string[], local = nowhere) =>
      await classifyGitRows({ mounts }, local);

    // Shapes 1, 2, 5, 7 — exactly what plan 13 derived, byte for byte.
    const s1 = await classify([bind(app, '/workspaces/app')]);
    const s2 = await classify([
      bind(app, '/workspaces/app'),
      bind(lib, '/workspaces/lib'),
    ]);
    const s5 = await classify([
      bind(`${c}/app.worktrees`, '/workspaces/app.worktrees'),
      bind(app, '/workspaces/app'),
    ]);
    const s7 = await classify([
      bind(app, '/workspaces/app'),
      bind(app, '/workspaces/app-again'),
    ]);
    const plan13 = (...targets: [string, string][]) =>
      targets.flatMap(([source, target]) =>
        gitProtectMounts({ source, target })
      );
    assertEquals(
      gitProtectLayer(s1.protectedRows).mounts,
      plan13([app, '/workspaces/app']),
    );
    assertEquals(
      gitProtectLayer(s2.protectedRows).mounts,
      plan13([app, '/workspaces/app'], [lib, '/workspaces/lib']),
    );
    assertEquals(
      gitProtectLayer(s5.protectedRows).mounts,
      plan13([app, '/workspaces/app']),
    );
    assertEquals(
      gitProtectLayer(s7.protectedRows).mounts,
      plan13([app, '/workspaces/app'], [app, '/workspaces/app-again']),
    );
    for (const s of [s1, s2, s5, s7]) assertEquals(s.unprotectedRows, []);

    // Shape 3 — the wizard's worktree row plus a row for its primary `.git`.
    const s3 = await classify([
      bind(`${c}/app.worktrees/feat`, '/workspaces/app.worktrees/feat'),
      bind(`${app}/.git`, '/workspaces/app/.git'),
    ]);
    assertEquals(s3.protectedRows, [{
      source: `${app}/.git`,
      target: '/workspaces/app/.git',
      kind: 'gitdir',
    }]);

    // Shape 6 — a bare repo mounted directly.
    const s6 = await classify([bind(`${c}/bare/x.git`, '/workspaces/x.git')]);
    assertEquals(s6.protectedRows.map((r) => r.kind), ['gitdir']);

    // Shape 8 — the project folder is the worktree: the CLI's own common-dir mount.
    const s8 = await classify([], `${c}/app.worktrees/feat`);
    assertEquals(s8.protectedRows, [{
      source: `${app}/.git`,
      target: '/workspaces/app/.git',
      kind: 'gitdir',
    }]);

    // Shape 4 — an umbrella: no mounts, reported.
    const s4 = await classify([bind(c, '/workspaces/code')]);
    assertEquals(s4.protectedRows, []);
    assertEquals(s4.unprotectedRows, [{
      source: c,
      target: '/workspaces/code',
      kind: 'umbrella',
      // Not `bare/` (its git dir is one level further down, at bare/x.git) and not
      // `app.worktrees/` (a folder of worktrees, whose config lives in the primary).
      repos: ['app', 'lib'],
    }]);
  });
});

Deno.test('a gitdir row derives exactly two mounts, and never a <target>/.git mount', () => {
  const mounts = gitDirProtectMounts({
    source: '/code/app/.git',
    target: '/workspaces/app/.git',
  });
  assertEquals(mounts, [
    'type=bind,source=/code/app/.git/config,target=/workspaces/app/.git/config,readonly',
    'type=bind,source=/code/app/.git/hooks,target=/workspaces/app/.git/hooks,readonly',
  ]);
  assert(!mounts.some((m) => m.includes('target=/workspaces/app/.git/.git')));
  assertEquals(
    gitProtectLayer([{
      source: '/code/app/.git',
      target: '/workspaces/app/.git',
      kind: 'gitdir',
    }]).mounts,
    mounts,
  );
});

// ── umbrellas ───────────────────────────────────────────────────────────────────────────────

Deno.test('an umbrella names its repo and git-dir children only', async () => {
  await withTemp(async (dir) => {
    const u = `${dir}/umbrella`;
    const a = repoAt(`${u}/a`);
    Deno.mkdirSync(`${u}/b`, { recursive: true });
    git(`${u}/b`, 'init', '-q', '--bare', '.');
    worktreeAt(a, `${u}/c`, 'c'); // a worktree child: `.git` is a file
    Deno.mkdirSync(`${u}/d`); // plain
    repoAt(`${u}/.hidden`);

    const { unprotectedRows } = await classifyGitRows(
      { mounts: [bind(u, '/workspaces/u')] },
      `${dir}/nowhere`,
    );
    assertEquals(unprotectedRows.length, 1);
    assert(unprotectedRows[0].kind === 'umbrella');
    assertEquals(unprotectedRows[0].repos, ['a', 'b']);
  });
});

Deno.test('a folder of only worktrees and plain dirs is not an umbrella', async () => {
  await withTemp(async (dir) => {
    const primary = repoAt(`${dir}/app`);
    worktreeAt(primary, `${dir}/app.worktrees/c`, 'c');
    Deno.mkdirSync(`${dir}/app.worktrees/d`);
    const rows = await classifyGitRows(
      { mounts: [bind(`${dir}/app.worktrees`, '/workspaces/app.worktrees')] },
      `${dir}/nowhere`,
    );
    assertEquals(rows, { protectedRows: [], unprotectedRows: [] });
  });
});

Deno.test('umbrella warning and status text, capped at five', () => {
  const row = {
    source: '/Users/me/code',
    target: '/workspaces/code',
    kind: 'umbrella' as const,
    repos: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
  };
  assertEquals(
    unprotectedRowWarning(row, '~/code'),
    'devc: git protection does not cover repos inside /workspaces/code (from ~/code): ' +
      'a, b, c, d, e, … (+2 more) — bind each repo as its own mount',
  );
  assertEquals(
    unprotectedRowStatus({ ...row, repos: ['app', 'lib'] }),
    '/workspaces/code: UNSUPPORTED — repos inside an umbrella mount are not protected: app, lib',
  );
});

Deno.test('an umbrella warns on stderr through ensureMergedConfig callers, and does not fail', async () => {
  await withTemp(async (dir) => {
    const project = repoAt(`${dir}/proj`);
    repoAt(`${dir}/code/app`);
    await Deno.mkdir(`${project}/.devcontainer`, { recursive: true });
    await Deno.writeTextFile(
      `${project}/.devcontainer/devcontainer.json`,
      JSON.stringify({
        image: 'ubuntu',
        mounts: [bind(`${dir}/code`, '/workspaces/code')],
      }),
    );
    const merged = await ensureMergedConfig(project, {
      cacheRoot: `${dir}/cache`,
      templatesDir: `${dir}/no-templates`,
      configDir: `${dir}/config`,
    });
    assertEquals(merged.unprotectedRows.map((r) => r.kind), ['umbrella']);
    // Nothing derived for it — the umbrella itself is still mounted, unprotected.
    const mounts = merged.config.mounts as string[];
    assert(
      !mounts.some((m) => m.includes('/workspaces/code/')),
      mounts.join('\n'),
    );
  });
});

// ── worktree project folders (shape 8) ──────────────────────────────────────────────────────

Deno.test('workspaceMountRow targets a worktree where the CLI mounts it', async () => {
  await withTemp(async (dir) => {
    const app = repoAt(`${dir}/app`);
    worktreeAt(app, `${dir}/app.worktrees/feat`, 'feat');
    assertEquals(await workspaceMountRow({}, `${dir}/app.worktrees/feat`), {
      source: `${dir}/app.worktrees/feat`,
      target: '/workspaces/app.worktrees/feat',
    });
  });
});

Deno.test('an absolute gitdir: derives no gitdir row', async () => {
  await withTemp(async (dir) => {
    const app = repoAt(`${dir}/app`);
    worktreeAt(app, `${dir}/wt`, 'abs');
    // Rewrite the pointer absolute by hand: git's default depends on `worktree.useRelativePaths`,
    // which a user's global config can set either way.
    const name = (await Deno.readTextFile(`${dir}/wt/.git`)).trim().split('/')
      .pop();
    await Deno.writeTextFile(
      `${dir}/wt/.git`,
      `gitdir: ${app}/.git/worktrees/${name}\n`,
    );
    assertEquals(await cliWorktreeMounts(`${dir}/wt`), null);
    const rows = await classifyGitRows({}, `${dir}/wt`);
    assertEquals(rows.protectedRows, []);
  });
});

Deno.test('the CLI common dir and a wizard row for the same primary .git derive once', async () => {
  await withTemp(async (dir) => {
    const app = repoAt(`${dir}/app`);
    worktreeAt(app, `${dir}/app.worktrees/feat`, 'feat');
    const rows = await classifyGitRows(
      { mounts: [bind(`${app}/.git`, '/workspaces/app/.git')] },
      `${dir}/app.worktrees/feat`,
    );
    assertEquals(rows.protectedRows.map((r) => r.target), [
      '/workspaces/app/.git',
    ]);
  });
});

Deno.test('a repo row whose .git lands on the CLI common-dir target is not derived twice', async () => {
  await withTemp(async (dir) => {
    const app = repoAt(`${dir}/app`);
    worktreeAt(app, `${dir}/app.worktrees/feat`, 'feat');
    const rows = await classifyGitRows(
      { mounts: [bind(app, '/workspaces/app')] },
      `${dir}/app.worktrees/feat`,
    );
    // The gitdir row claims /workspaces/app/.git first; the repo row would derive a second,
    // read-write mount on the same target.
    assertEquals(rows.protectedRows, [{
      source: `${app}/.git`,
      target: '/workspaces/app/.git',
      kind: 'gitdir',
    }]);
  });
});

Deno.test('excluding the worktree workspace target also excludes its common dir', async () => {
  await withTemp(async (dir) => {
    const app = repoAt(`${dir}/app`);
    worktreeAt(app, `${dir}/app.worktrees/feat`, 'feat');
    const rows = await classifyGitRows(
      { gitProtect: { exclude: ['/workspaces/app.worktrees/feat'] } },
      `${dir}/app.worktrees/feat`,
    );
    assertEquals(rows.protectedRows, []);
  });
});

Deno.test('a gitdir with no hooks directory is reported, not derived, and does not fail', async () => {
  await withTemp(async (dir) => {
    const app = repoAt(`${dir}/app`);
    await Deno.remove(`${app}/.git/hooks`, { recursive: true });
    const rows = await classifyGitRows(
      { mounts: [bind(`${app}/.git`, '/workspaces/app/.git')] },
      `${dir}/nowhere`,
    );
    assertEquals(rows.protectedRows, []);
    assertEquals(rows.unprotectedRows.map((r) => r.kind), ['no-hooks']);
    assertStringIncludes(
      unprotectedRowStatus(rows.unprotectedRows[0]),
      'UNPROTECTED',
    );
  });
});

Deno.test('gitProtectState checks a gitdir row at its own target', () => {
  const row = {
    source: '/code/app/.git',
    target: '/workspaces/app/.git',
    kind: 'gitdir' as const,
  };
  const good = [
    { destination: '/workspaces/app/.git', rw: true },
    { destination: '/workspaces/app/.git/config', rw: false },
    { destination: '/workspaces/app/.git/hooks', rw: false },
  ];
  assertEquals(gitProtectState(row, good).state, 'protected');
  const bad = gitProtectState(row, good.slice(0, 2));
  assertEquals(bad.state, 'MISMATCH');
  assertEquals(bad.problems, ['/workspaces/app/.git/hooks is not mounted']);
});

// ── the formula agrees with the CLI ─────────────────────────────────────────────────────────

Deno.test('cliWorktreeMounts matches what the pinned devcontainer CLI computes', async () => {
  // Driven through the CLI's own `read-configuration --mount-git-worktree-common-dir`, which
  // reports both the workspace mount and the common-dir mount (`additionalMountString`) without
  // Docker. A copy of the formula checked against itself would prove nothing.
  await withTemp(async (dir) => {
    const primary = repoAt(`${dir}/repos/app`);
    const cases = [
      worktreeAt(primary, `${dir}/repos/app-sibling`, 'sib'),
      worktreeAt(primary, `${dir}/repos/app.worktrees/feat`, 'feat'),
      worktreeAt(primary, `${dir}/elsewhere/deep/wt`, 'far'),
    ];
    const runner = createNodeDevcontainerRunner({ onStderr: () => {} });
    for (const wt of cases) {
      await Deno.mkdir(`${wt}/.devcontainer`, { recursive: true });
      await Deno.writeTextFile(
        `${wt}/.devcontainer/devcontainer.json`,
        '{"image":"ubuntu"}',
      );
      const { code, stdout } = await runner.run([
        'read-configuration',
        '--workspace-folder',
        wt,
        '--mount-git-worktree-common-dir',
      ]);
      assertEquals(code, 0, stdout);
      const workspace = JSON.parse(stdout.trim().split('\n').pop()!).workspace;
      const target = (spec: string) => /target=([^,]+)/.exec(spec)![1];
      const source = (spec: string) => /source=([^,]+)/.exec(spec)![1];

      const ours = await cliWorktreeMounts(wt);
      assert(ours !== null, wt);
      assertEquals(ours.workspaceTarget, target(workspace.workspaceMount), wt);
      assertEquals(
        ours.commonDirTarget,
        target(workspace.additionalMountString),
        wt,
      );
      assertEquals(
        ours.commonDirSource,
        source(workspace.additionalMountString),
        wt,
      );
    }
  });
});

// ── never git ───────────────────────────────────────────────────────────────────────────────

Deno.test('classifying rows never runs git in a repo (fsmonitor tripwire)', async () => {
  await withTemp(async (dir) => {
    const app = repoAt(`${dir}/app`);
    worktreeAt(app, `${dir}/app.worktrees/feat`, 'feat');
    const marker = `${dir}/fired`;
    const hook = `${dir}/fsmonitor.sh`;
    await Deno.writeTextFile(hook, `#!/bin/sh\ntouch '${marker}'\n`);
    await Deno.chmod(hook, 0o755);
    git(app, 'config', 'core.fsmonitor', hook);

    await classifyGitRows(
      {
        mounts: [
          bind(`${app}/.git`, '/workspaces/app/.git'),
          bind(dir, '/workspaces/all'),
        ],
      },
      `${dir}/app.worktrees/feat`,
    );
    let fired = true;
    try {
      await Deno.lstat(marker);
    } catch {
      fired = false;
    }
    assertEquals(fired, false, 'something ran git in the repo');
  });
});
