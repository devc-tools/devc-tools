import { assert, assertEquals } from 'jsr:@std/assert';
import type { ContainerMount } from '@devc-tools/core/container.ts';
import { hostRun } from '../web/env_host.ts';
import { runCapped } from '../web/proc.ts';
import type { EnvExec, RunLimits } from '../web/environment.ts';
import { resolveRepo } from '../web/git_repo.ts';
import { type MirrorOpts, readGitStatus } from '../web/git_status.ts';
import {
  createWorktree,
  folderNameFor,
  forceRefusal,
  parseGitVersion,
  parsePrList,
  removeWorktree,
  validWorktreeName,
  worktreeOptions,
  worktreesFolderOf,
  worktreesStateOf,
  type WorktreeTarget,
  writeUpstream,
} from '../web/git_worktree.ts';

async function git(cwd: string, ...args: string[]): Promise<string> {
  const out = await new Deno.Command('git', {
    args: ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args],
    cwd,
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  if (!out.success) throw new Error(new TextDecoder().decode(out.stderr));
  return new TextDecoder().decode(out.stdout).trim();
}

/** An environment that runs commands here, as a host project's does. */
const hereEnv = {
  run: (x: EnvExec, input?: Uint8Array) => hostRun(x, '/', undefined, input),
  runLimited: (x: EnvExec, limits: RunLimits) =>
    runCapped(x.cmd[0], x.cmd.slice(1), limits, { cwd: x.cwd, env: x.env }),
};

const identity: ContainerMount[] = [
  { type: 'bind', source: '/', destination: '/', rw: true },
];

const GITHUB_URL = 'https://github.com/owner/name.git';

const exists = (path: string) => Deno.lstat(path).then(() => true, () => false);

/**
 * A bare remote with `main` and `feature/a`, a fork-only PR head at `refs/pull/7/head` and a
 * same-repo PR head at `refs/pull/8/head` (= `feature/a`); `repo` cloned from it with `origin`
 * named as a GitHub URL (rewritten to the remote for every git in this process), beside an empty
 * `repo.worktrees`; and a `gh` stub answering for both PRs.
 */
async function setUp(dir: string) {
  const remote = `${dir}/remote.git`;
  const repo = `${dir}/code/repo`;
  const seed = `${dir}/seed`;
  await git(dir, 'init', '-q', '--bare', '-b', 'main', remote);
  await git(dir, 'clone', '-q', remote, seed);
  await git(seed, 'commit', '-q', '--allow-empty', '-m', 'one');
  await git(seed, 'push', '-q', 'origin', 'main');
  await git(seed, 'checkout', '-q', '-b', 'feature/a');
  await git(seed, 'commit', '-q', '--allow-empty', '-m', 'feature');
  await git(seed, 'push', '-q', 'origin', 'feature/a');
  const featureSha = await git(seed, 'rev-parse', 'HEAD');
  await git(seed, 'checkout', '-q', '-b', 'fork', 'main');
  await git(seed, 'commit', '-q', '--allow-empty', '-m', 'from a fork');
  const forkSha = await git(seed, 'rev-parse', 'HEAD');
  await git(seed, 'push', '-q', 'origin', `${forkSha}:refs/pull/7/head`);
  await git(seed, 'push', '-q', 'origin', `${featureSha}:refs/pull/8/head`);
  await git(dir, 'clone', '-q', remote, repo);
  await git(repo, 'remote', 'set-url', 'origin', GITHUB_URL);
  await Deno.mkdir(`${repo}.worktrees`);
  Deno.env.set('GIT_CONFIG_COUNT', '1');
  Deno.env.set('GIT_CONFIG_KEY_0', `url.${remote}.insteadOf`);
  Deno.env.set('GIT_CONFIG_VALUE_0', GITHUB_URL);

  const gh = `${dir}/gh`;
  await Deno.writeTextFile(
    gh,
    `#!/bin/sh
case "$1 $2" in
  "pr list") echo '[{"number":8,"title":"Feature","author":{"login":"me"},"headRefName":"feature/a","isCrossRepository":false,"isDraft":false},{"number":7,"title":"Fork","author":{"login":"them"},"headRefName":"main","isCrossRepository":true,"isDraft":true},{"bad":1}]' ;;
  "pr view")
    case "$3" in
      7) echo '{"headRefName":"main","isCrossRepository":true,"state":"OPEN"}' ;;
      8) echo '{"headRefName":"feature/a","isCrossRepository":false,"state":"OPEN"}' ;;
      *) echo '{"headRefName":"x","isCrossRepository":false,"state":"MERGED"}' ;;
    esac ;;
esac
`,
  );
  await Deno.chmod(gh, 0o755);
  const mirror: MirrorOpts = { root: `${dir}/mirrors`, fetchable: () => true };
  const t: WorktreeTarget = { env: hereEnv, mounts: identity, folder: repo };
  return { remote, repo, featureSha, forkSha, deps: { mirror, gh }, t };
}

async function withRepo(
  f: (s: Awaited<ReturnType<typeof setUp>> & { dir: string }) => Promise<void>,
) {
  const dir = await Deno.realPath(await Deno.makeTempDir());
  try {
    await f({ ...(await setUp(dir)), dir });
  } finally {
    Deno.env.delete('GIT_CONFIG_COUNT');
    Deno.env.delete('GIT_CONFIG_KEY_0');
    Deno.env.delete('GIT_CONFIG_VALUE_0');
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test('parsers and names', () => {
  assertEquals(parseGitVersion('git version 2.52.0\n'), [2, 52]);
  assertEquals(parseGitVersion('git version 2.39.5 (Apple Git-154)'), [2, 39]);
  assertEquals(parseGitVersion('nope'), null);
  assertEquals(validWorktreeName('feature-a'), true);
  assertEquals(validWorktreeName('.hidden'), false);
  assertEquals(validWorktreeName('-x'), false);
  assertEquals(validWorktreeName('a/b'), false);
  assertEquals(validWorktreeName('x.lock'), false);
  assertEquals(validWorktreeName('a'.repeat(101)), false);
  assertEquals(folderNameFor('feature/a/b'), 'feature-a-b');
  assertEquals(parsePrList('nope'), []);
  assertEquals(
    parsePrList(
      '[{"number":1,"title":"t","author":null,"headRefName":"h","isCrossRepository":true},{"number":"2"}]',
    ),
    [{
      number: 1,
      title: 't',
      author: '',
      headRefName: 'h',
      crossRepository: true,
      draft: false,
    }],
  );
});

Deno.test('worktreeOptions lists branches, PRs, local branches and folders', async () => {
  await withRepo(async ({ t, deps, repo }) => {
    await Deno.mkdir(`${repo}.worktrees/taken`);
    const o = await worktreeOptions(t, deps);
    assert(o.ok, JSON.stringify(o));
    assertEquals(o.worktreesFolder, `${repo}.worktrees`);
    assertEquals(o.defaultBranch, 'main');
    assertEquals(o.currentBranch, 'main');
    assertEquals(o.remoteBranches, ['feature/a', 'main']);
    assertEquals(o.remoteProblem, null);
    assertEquals(o.prs.map((p) => [p.number, p.crossRepository, p.draft]), [
      [8, false, false],
      [7, true, true],
    ]);
    assertEquals(o.prs[0].author, 'me');
    assertEquals(o.prsProblem, null);
    assertEquals(o.localBranches, ['main']);
    assertEquals(o.checkedOut, ['main']);
    assertEquals(o.folders, ['taken']);
    assertEquals(await worktreesFolderOf(repo, identity), `${repo}.worktrees`);
  });
});

Deno.test('worktreeOptions without gh, and refusals of the layout', async () => {
  await withRepo(async ({ t, deps, repo, dir }) => {
    const o = await worktreeOptions(t, { ...deps, gh: `${dir}/no-such-gh` });
    assert(o.ok);
    assertEquals(o.prsProblem, 'gh not found on this machine');
    assertEquals(o.prs, []);

    // Not mounted: a container whose only bind is somewhere else.
    const elsewhere: ContainerMount[] = [
      { type: 'bind', source: repo, destination: '/workspaces/repo', rw: true },
    ];
    assertEquals(await worktreeOptions({ ...t, mounts: elsewhere }, deps), {
      ok: false,
      problem: 'repo.worktrees is not mounted here',
    });
    assertEquals(await worktreesFolderOf(repo, elsewhere), null);
    // Mounted, but not beside the repo in the container.
    const apart: ContainerMount[] = [
      ...elsewhere,
      {
        type: 'bind',
        source: `${repo}.worktrees`,
        destination: '/elsewhere/repo.worktrees',
        rw: true,
      },
    ];
    assertEquals(await worktreeOptions({ ...t, mounts: apart }, deps), {
      ok: false,
      problem: 'repo.worktrees is not beside repo in the container',
    });

    await Deno.remove(`${repo}.worktrees`);
    assertEquals(await worktreeOptions(t, deps), {
      ok: false,
      problem: 'create repo.worktrees beside repo and mount it here',
    });
    assertEquals(await worktreesFolderOf(repo, identity), null);
  });
});

Deno.test('createWorktree from a remote branch: relative pointers, tracking ref, upstream in place', async () => {
  await withRepo(async ({ t, deps, repo, featureSha, dir }) => {
    const config = `${repo}/.git/config`;
    // A hard link sees an in-place write; git's lock + rename would leave it on the old file
    // (an inode number alone can be reused between git's two rewrites).
    const link = `${dir}/config-link`;
    await Deno.link(config, link);
    const r = await createWorktree(
      t,
      {
        name: 'feature-a',
        branch: 'feature/a',
        source: { kind: 'remote', remoteBranch: 'feature/a' },
      },
      [repo],
      deps,
    );
    assertEquals(r, {
      ok: true,
      worktree: `${repo}.worktrees/feature-a`,
      branch: 'feature/a',
      upstream: 'origin/feature/a',
    });
    const wt = `${repo}.worktrees/feature-a`;
    const pointer = await Deno.readTextFile(`${wt}/.git`);
    assert(pointer.startsWith('gitdir: ../'), pointer);
    assert(await resolveRepo(wt) !== null);
    assertEquals(await git(wt, 'rev-parse', 'HEAD'), featureSha);
    assertEquals(
      await git(repo, 'rev-parse', 'refs/remotes/origin/feature/a'),
      featureSha,
    );
    assertEquals(
      await git(repo, 'config', 'branch.feature/a.merge'),
      'refs/heads/feature/a',
    );
    assertEquals(
      await git(repo, 'config', 'branch.feature/a.remote'),
      'origin',
    );
    assertEquals(
      await git(repo, 'config', 'extensions.relativeWorktrees'),
      'true',
    );
    assertEquals(
      await git(repo, 'config', 'core.repositoryformatversion'),
      '1',
    );
    assertEquals(
      await Deno.readTextFile(link),
      await Deno.readTextFile(config),
    );
    assertEquals(await exists(`${config}.lock`), false);

    // Taken folder, taken branch.
    assertEquals(
      await createWorktree(
        t,
        {
          name: 'feature-a',
          branch: 'other',
          source: { kind: 'local', base: 'main' },
        },
        [repo],
        deps,
      ),
      { ok: false, problem: 'repo.worktrees/feature-a already exists' },
    );
    assertEquals(
      await createWorktree(
        t,
        {
          name: 'again',
          branch: 'feature/a',
          source: { kind: 'remote', remoteBranch: 'feature/a' },
        },
        [repo],
        deps,
      ),
      {
        ok: false,
        problem: 'branch feature/a is checked out in another worktree',
      },
    );
  });
});

Deno.test('createWorktree from PRs: a fork gets no upstream, a same-repo PR does', async () => {
  await withRepo(async ({ t, deps, repo, forkSha, featureSha }) => {
    const fork = await createWorktree(
      t,
      {
        name: 'pr-7',
        branch: 'pr-7',
        source: { kind: 'pr', number: 7 },
      },
      [repo],
      deps,
    );
    assertEquals(fork, {
      ok: true,
      worktree: `${repo}.worktrees/pr-7`,
      branch: 'pr-7',
      upstream: null,
    });
    assertEquals(
      await git(`${repo}.worktrees/pr-7`, 'rev-parse', 'HEAD'),
      forkSha,
    );

    const same = await createWorktree(
      t,
      {
        name: 'feature-a',
        branch: 'feature/a',
        source: { kind: 'pr', number: 8 },
      },
      [repo, `${repo}.worktrees/pr-7`],
      deps,
    );
    assert(same.ok);
    assertEquals(same.upstream, 'origin/feature/a');
    assertEquals(
      await git(`${repo}.worktrees/feature-a`, 'rev-parse', 'HEAD'),
      featureSha,
    );

    assertEquals(
      await createWorktree(
        t,
        {
          name: 'gone',
          branch: 'gone',
          source: { kind: 'pr', number: 9 },
        },
        [repo],
        deps,
      ),
      { ok: false, problem: 'pull request #9 is not open' },
    );
  });
});

Deno.test('createWorktree: new branches, existing branches, refusals', async () => {
  await withRepo(async ({ t, deps, repo, featureSha }) => {
    const head = await git(repo, 'rev-parse', 'HEAD');
    // The git watch has read the repo into the mirror, so the mirror knows the repo has
    // origin/main: no bundle is made (git refuses an empty one), and none goes on stdin.
    assert(await readGitStatus(repo, deps.mirror) !== null);
    const inputs: number[] = [];
    const recording = {
      ...hereEnv,
      run: (x: EnvExec, input?: Uint8Array) => {
        if (x.cmd[0] === 'sh') inputs.push(input?.length ?? 0);
        return hereEnv.run(x, input);
      },
    };
    const d = await createWorktree(
      { ...t, env: recording },
      {
        name: 'from-default',
        branch: 'from-default',
        source: { kind: 'remote', remoteBranch: 'main' },
      },
      [repo],
      deps,
    );
    assertEquals(d, {
      ok: true,
      worktree: `${repo}.worktrees/from-default`,
      branch: 'from-default',
      upstream: null,
    });
    assertEquals(
      await git(`${repo}.worktrees/from-default`, 'rev-parse', 'HEAD'),
      head,
    );
    assertEquals(inputs, [0]);
    const c = await createWorktree(
      t,
      {
        name: 'from-current',
        branch: 'from-current',
        source: { kind: 'local', base: 'main' },
      },
      [repo],
      deps,
    );
    assert(c.ok);
    assertEquals(c.upstream, null);
    assertEquals(
      await git(repo, 'config', '--get', 'branch.from-current.merge').catch(
        () => null,
      ),
      null,
    );

    // An existing branch is checked out as is, not reset to the remote.
    await git(repo, 'branch', 'feature/a', head);
    const e = await createWorktree(
      t,
      {
        name: 'existing',
        branch: 'feature/a',
        source: { kind: 'remote', remoteBranch: 'feature/a' },
      },
      [repo],
      deps,
    );
    assert(e.ok, JSON.stringify(e));
    assertEquals(
      await git(`${repo}.worktrees/existing`, 'rev-parse', 'HEAD'),
      head,
    );
    assertEquals(
      await git(repo, 'rev-parse', 'refs/remotes/origin/feature/a'),
      featureSha,
    );

    const refuse = (
      name: string,
      branch: string,
      source: Parameters<typeof createWorktree>[1]['source'],
    ) => createWorktree(t, { name, branch, source }, [repo], deps);
    assertEquals(
      await refuse('x', 'from-current', { kind: 'local', base: 'main' }),
      {
        ok: false,
        problem: 'branch from-current is checked out in another worktree',
      },
    );
    assertEquals(await refuse('.x', 'y', { kind: 'local', base: 'main' }), {
      ok: false,
      problem: 'invalid folder name: .x',
    });
    assertEquals(
      await refuse('x', 'bad..name', { kind: 'local', base: 'main' }),
      {
        ok: false,
        problem: 'invalid branch name: bad..name',
      },
    );
    assertEquals(
      await createWorktree(
        { ...t, folder: `${repo}.worktrees/existing` },
        { name: 'x', branch: 'y', source: { kind: 'local', base: 'main' } },
        [repo],
        deps,
      ),
      {
        ok: false,
        problem: 'existing is a worktree: create worktrees from its main repo',
      },
    );
    await git(repo, 'remote', 'set-url', 'origin', '/a/local/path');
    assertEquals(
      await createWorktree(
        t,
        {
          name: 'x',
          branch: 'y',
          source: { kind: 'remote', remoteBranch: 'main' },
        },
        [repo],
        { ...deps, mirror: { ...deps.mirror, fetchable: undefined } },
      ),
      { ok: false, problem: 'origin is not an https or ssh remote' },
    );
  });
});

Deno.test('createWorktree in a container whose paths differ from the host', async () => {
  await withRepo(async ({ deps, repo, dir, featureSha }) => {
    // The "container" sees the host's `code` folder at `<dir>/ctr` (a symlink stands for the bind).
    await Deno.symlink(`${dir}/code`, `${dir}/ctr`);
    const mounts: ContainerMount[] = [
      {
        type: 'bind',
        source: `${dir}/code`,
        destination: `${dir}/ctr`,
        rw: true,
      },
    ];
    const r = await createWorktree(
      { env: hereEnv, mounts, folder: repo },
      {
        name: 'feature-a',
        branch: 'feature/a',
        source: { kind: 'remote', remoteBranch: 'feature/a' },
      },
      [repo],
      deps,
    );
    assert(r.ok, JSON.stringify(r));
    assert(await resolveRepo(`${repo}.worktrees/feature-a`) !== null);
    assertEquals(
      await git(`${repo}.worktrees/feature-a`, 'rev-parse', 'HEAD'),
      featureSha,
    );
  });
});

Deno.test('writeUpstream gives up while the config is locked', async () => {
  await withRepo(async ({ repo }) => {
    const config = `${repo}/.git/config`;
    const before = await Deno.readTextFile(config);
    await Deno.writeTextFile(`${config}.lock`, '');
    assertEquals(
      await writeUpstream(`${repo}/.git`, 'x', 'x'),
      'the repo config is locked',
    );
    assertEquals(await Deno.readTextFile(config), before);
    // Someone else's lock stays.
    assertEquals(await exists(`${config}.lock`), true);
  });
});

Deno.test('removeWorktree: clean, dirty, forced; the branch stays', async () => {
  await withRepo(async ({ t, deps, repo }) => {
    for (const name of ['clean', 'dirty']) {
      const r = await createWorktree(
        t,
        {
          name,
          branch: name,
          source: { kind: 'local', base: 'main' },
        },
        [repo],
        deps,
      );
      assert(r.ok);
    }
    const at = (name: string) => ({
      ...t,
      folder: `${repo}.worktrees/${name}`,
    });
    assertEquals(await removeWorktree(at('clean'), false), { ok: true });
    assertEquals(await exists(`${repo}.worktrees/clean`), false);
    assertEquals(await git(repo, 'branch', '--list', 'clean'), 'clean');

    await Deno.writeTextFile(`${repo}.worktrees/dirty/new.txt`, 'x');
    assertEquals(await removeWorktree(at('dirty'), false), {
      ok: false,
      problem: 'dirty has uncommitted changes',
      dirty: true,
    });
    assertEquals(await exists(`${repo}.worktrees/dirty`), true);
    assertEquals(await removeWorktree(at('dirty'), true), { ok: true });
    assertEquals(await exists(`${repo}.worktrees/dirty`), false);
    assertEquals(await git(repo, 'branch', '--list', 'dirty'), 'dirty');

    assertEquals(await removeWorktree(t, false), {
      ok: false,
      problem: 'repo is not a linked worktree',
      dirty: false,
    });
  });
});

Deno.test('forceRefusal: a page may not force under --live; the desktop always may', () => {
  const live = 'discarding changes is refused under --live';
  assertEquals(forceRefusal(true, 'page', true), live);
  assertEquals(forceRefusal(false, 'page', true), null);
  assertEquals(forceRefusal(true, 'page', false), null);
  assertEquals(forceRefusal(true, 'desktop', true), null);
});

Deno.test('worktreesFolderOf: only a primary repo with a mapped .worktrees folder', async () => {
  await withRepo(async ({ t, deps, repo }) => {
    assertEquals(await worktreesFolderOf(repo, identity), `${repo}.worktrees`);
    const r = await createWorktree(
      t,
      {
        name: 'wt',
        branch: 'wt',
        source: { kind: 'local', base: 'main' },
      },
      [repo],
      deps,
    );
    assert(r.ok);
    // A linked worktree has none, even beside a `.worktrees` folder of its own.
    await Deno.mkdir(`${repo}.worktrees/wt.worktrees`);
    assertEquals(
      await worktreesFolderOf(`${repo}.worktrees/wt`, identity),
      null,
    );
    assertEquals(await worktreesFolderOf(`${repo}/nope`, identity), null);
  });
});

Deno.test('createWorktree with the repo config locked', async () => {
  await withRepo(async ({ t, deps, repo, featureSha }) => {
    const config = `${repo}/.git/config`;
    const lock = `${config}.lock`;
    // Before the first worktree, relative worktrees can't be turned on: refused, nothing made.
    await Deno.writeTextFile(lock, '');
    const before = await Deno.readTextFile(config);
    assertEquals(
      await createWorktree(
        t,
        {
          name: 'first',
          branch: 'first',
          source: { kind: 'local', base: 'main' },
        },
        [repo],
        deps,
      ),
      {
        ok: false,
        problem:
          'could not enable relative worktrees in the repo config: the repo config is locked',
      },
    );
    assertEquals(await exists(`${repo}.worktrees/first`), false);
    assertEquals(await Deno.readTextFile(config), before);
    await Deno.remove(lock);

    // Once on, git leaves the config alone: a locked config only costs the upstream.
    assert(
      (await createWorktree(
        t,
        {
          name: 'first',
          branch: 'first',
          source: { kind: 'local', base: 'main' },
        },
        [repo],
        deps,
      )).ok,
    );
    await Deno.writeTextFile(lock, '');
    const on = await Deno.readTextFile(config);
    const r = await createWorktree(
      t,
      {
        name: 'feature-a',
        branch: 'feature/a',
        source: { kind: 'remote', remoteBranch: 'feature/a' },
      },
      [repo],
      deps,
    );
    assertEquals(r, {
      ok: true,
      worktree: `${repo}.worktrees/feature-a`,
      branch: 'feature/a',
      upstream: null,
    });
    assertEquals(
      await git(`${repo}.worktrees/feature-a`, 'rev-parse', 'HEAD'),
      featureSha,
    );
    assertEquals(await Deno.readTextFile(config), on);
  });
});

Deno.test('worktreesStateOf: why a primary has no New worktree here; nothing for others', async () => {
  await withRepo(async ({ repo, dir }) => {
    assertEquals(await worktreesStateOf(repo, identity), {
      worktreesFolder: `${repo}.worktrees`,
      worktreesProblem: null,
    });
    const onlyRepo: ContainerMount[] = [
      { type: 'bind', source: repo, destination: '/workspaces/repo', rw: true },
    ];
    assertEquals(await worktreesStateOf(repo, onlyRepo), {
      worktreesFolder: null,
      worktreesProblem: 'repo.worktrees is not mounted here',
    });
    assertEquals(
      await worktreesStateOf(repo, [...onlyRepo, {
        type: 'bind',
        source: `${repo}.worktrees`,
        destination: '/elsewhere/repo.worktrees',
        rw: true,
      }]),
      {
        worktreesFolder: null,
        worktreesProblem: 'repo.worktrees is not beside repo in the container',
      },
    );
    // A repo this environment doesn't map, and a folder that is no repo: no item at all.
    assertEquals(
      await worktreesStateOf(repo, [
        {
          type: 'bind',
          source: `${dir}/elsewhere`,
          destination: '/x',
          rw: true,
        },
      ]),
      { worktreesFolder: null, worktreesProblem: null },
    );
    assertEquals(await worktreesStateOf(`${dir}/nope`, identity), {
      worktreesFolder: null,
      worktreesProblem: null,
    });
    await Deno.remove(`${repo}.worktrees`);
    assertEquals(await worktreesStateOf(repo, identity), {
      worktreesFolder: null,
      worktreesProblem: 'create repo.worktrees beside repo and mount it here',
    });
  });
});

Deno.test("createWorktree: a new branch from a local branch (a worktree's)", async () => {
  await withRepo(async ({ t, deps, repo }) => {
    const a = await createWorktree(
      t,
      { name: 'a', branch: 'a', source: { kind: 'local', base: 'main' } },
      [repo],
      deps,
    );
    assert(a.ok);
    const wtA = `${repo}.worktrees/a`;
    await git(wtA, 'commit', '-q', '--allow-empty', '-m', 'on a');
    const headA = await git(wtA, 'rev-parse', 'HEAD');
    const b = await createWorktree(
      t,
      { name: 'b', branch: 'b', source: { kind: 'local', base: 'a' } },
      [repo, wtA],
      deps,
    );
    assertEquals(b, {
      ok: true,
      worktree: `${repo}.worktrees/b`,
      branch: 'b',
      upstream: null,
    });
    assertEquals(await git(`${repo}.worktrees/b`, 'rev-parse', 'HEAD'), headA);
    assertEquals(
      await createWorktree(
        t,
        { name: 'c', branch: 'c', source: { kind: 'local', base: 'nope' } },
        [repo],
        deps,
      ),
      { ok: false, problem: 'branch nope does not exist' },
    );
  });
});

Deno.test('createWorktree: a new name for a remote branch starts a new branch with no upstream', async () => {
  await withRepo(async ({ t, deps, repo, featureSha }) => {
    // From the Remote branch tab, renamed.
    const r = await createWorktree(
      t,
      {
        name: 'mine',
        branch: 'mine',
        source: { kind: 'remote', remoteBranch: 'feature/a' },
      },
      [repo],
      deps,
    );
    assertEquals(r, {
      ok: true,
      worktree: `${repo}.worktrees/mine`,
      branch: 'mine',
      upstream: null,
    });
    assertEquals(
      await git(`${repo}.worktrees/mine`, 'rev-parse', 'HEAD'),
      featureSha,
    );
    assertEquals(
      await git(repo, 'config', '--get', 'branch.mine.merge').catch(() => null),
      null,
    );
    // Again under another name; origin/feature/a's tracking ref moves too.
    const n = await createWorktree(
      t,
      {
        name: 'also-mine',
        branch: 'also-mine',
        source: { kind: 'remote', remoteBranch: 'feature/a' },
      },
      [repo],
      deps,
    );
    assertEquals(n, {
      ok: true,
      worktree: `${repo}.worktrees/also-mine`,
      branch: 'also-mine',
      upstream: null,
    });
    assertEquals(
      await git(`${repo}.worktrees/also-mine`, 'rev-parse', 'HEAD'),
      featureSha,
    );
    assertEquals(
      await git(repo, 'rev-parse', 'refs/remotes/origin/feature/a'),
      featureSha,
    );
    assertEquals(
      await createWorktree(
        t,
        {
          name: 'x',
          branch: 'x',
          source: { kind: 'remote', remoteBranch: 'bad..name' },
        },
        [repo],
        deps,
      ),
      { ok: false, problem: 'invalid branch name: bad..name' },
    );
  });
});
