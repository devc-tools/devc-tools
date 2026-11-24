import { assert, assertEquals } from 'jsr:@std/assert';
import { hostRun } from '../web/env_host.ts';
import { runCapped } from '../web/proc.ts';
import type {
  BridgeRun,
  EnvExec,
  ExecOutput,
  RunLimits,
} from '../web/environment.ts';
import {
  fetchRepo,
  fetchRunning,
  moveArgv,
  pullRepo,
  pullRunning,
  resetRefusal,
  resetRepo,
  validBranch,
  validRemote,
} from '../web/git_fetch.ts';
import {
  fetchUpstream,
  isGitProblem,
  type MirrorOpts,
  readGitState,
  upstreamBundle,
} from '../web/git_status.ts';

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

/** A remote, `work` cloned from it, and `other` that pushes to it. */
async function setUp(dir: string) {
  const remote = `${dir}/remote.git`;
  const work = `${dir}/work`;
  const other = `${dir}/other`;
  await git(dir, 'init', '-q', '--bare', '-b', 'main', remote);
  await git(dir, 'clone', '-q', remote, work);
  await git(work, 'commit', '-q', '--allow-empty', '-m', 'one');
  await git(work, 'push', '-q', '-u', 'origin', 'main');
  await git(dir, 'clone', '-q', remote, other);
  // The remote is a local path, which the host would never fetch; tests allow it.
  const opts: MirrorOpts = { root: `${dir}/mirrors`, fetchable: () => true };
  return { remote, work, other, opts };
}

const exists = (path: string) => Deno.stat(path).then(() => true, () => false);

Deno.test("fetchRepo moves the repo's remote-tracking ref, and only that", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const { work, other, opts } = await setUp(dir);
    const head = await git(work, 'rev-parse', 'HEAD');
    // Nothing new: the repo's ref already has it.
    assertEquals(await fetchRepo(hereEnv, work, work, opts), {
      ok: true,
      updated: false,
    });

    await git(other, 'commit', '-q', '--allow-empty', '-m', 'theirs');
    await git(other, 'push', '-q');
    const theirs = await git(other, 'rev-parse', 'HEAD');
    assertEquals(await fetchRepo(hereEnv, work, work, opts), {
      ok: true,
      updated: true,
    });
    assertEquals(
      await git(work, 'rev-parse', 'refs/remotes/origin/main'),
      theirs,
    );
    // Not a pull: the branch and the working tree stay.
    assertEquals(await git(work, 'rev-parse', 'HEAD'), head);
    // No FETCH_HEAD, and no temp file left in the repo.
    assertEquals(await exists(`${work}/.git/FETCH_HEAD`), false);
    assertEquals(await git(work, 'status', '--porcelain'), '');

    // Again: up to date.
    assertEquals(await fetchRepo(hereEnv, work, work, opts), {
      ok: true,
      updated: false,
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('fetchRepo: a force-push upstream moves the ref; a newer repo ref is never moved back', async () => {
  const dir = await Deno.makeTempDir();
  try {
    const { work, other, opts } = await setUp(dir);
    await git(other, 'commit', '-q', '--allow-empty', '-m', 'two');
    await git(other, 'push', '-q');
    assertEquals((await fetchRepo(hereEnv, work, work, opts)).ok, true);
    await git(other, 'reset', '-q', '--hard', 'HEAD~1');
    await git(other, 'commit', '-q', '--allow-empty', '-m', 'rewritten');
    await git(other, 'push', '-q', '--force');
    assertEquals(await fetchRepo(hereEnv, work, work, opts), {
      ok: true,
      updated: true,
    });
    assertEquals(
      await git(work, 'rev-parse', 'refs/remotes/origin/main'),
      await git(other, 'rev-parse', 'HEAD'),
    );

    // The repo fetched by itself after the host's mirror last did, and the remote is gone from
    // the host's reach: the mirror's older copy must not win.
    await git(other, 'commit', '-q', '--allow-empty', '-m', 'three');
    await git(other, 'push', '-q');
    await git(work, 'fetch', '-q');
    const newest = await git(work, 'rev-parse', 'refs/remotes/origin/main');
    const b = await upstreamBundle(work, opts);
    assert(!isGitProblem(b) && 'upToDate' in b);
    assertEquals(
      await git(work, 'rev-parse', 'refs/remotes/origin/main'),
      newest,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("fetchRepo's host steps never run the repo's hooks or fsmonitor", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const { work, other, opts } = await setUp(dir);
    const planted = `${dir}/planted`;
    const script = `${dir}/payload.sh`;
    await Deno.writeTextFile(script, `#!/bin/sh\ntouch ${planted}\n`);
    await Deno.chmod(script, 0o755);
    await git(work, 'config', 'core.fsmonitor', script);
    await git(work, 'config', 'core.hooksPath', dir);
    for (
      const hook of ['reference-transaction', 'pre-auto-gc', 'post-checkout']
    ) {
      await Deno.copyFile(script, `${dir}/${hook}`);
    }
    await git(other, 'commit', '-q', '--allow-empty', '-m', 'theirs');
    await git(other, 'push', '-q');

    // The environment only records: everything that ran, ran on the host.
    const runs: { x: EnvExec; input?: Uint8Array }[] = [];
    const recording = {
      run: (x: EnvExec, input?: Uint8Array): Promise<ExecOutput> => {
        runs.push({ x, input });
        return Promise.resolve({
          code: 0,
          stdout: new TextEncoder().encode('a b\n'),
          stderr: '',
        });
      },
    };
    assertEquals(await fetchRepo(recording, work, work, opts), {
      ok: true,
      updated: true,
    });
    assertEquals(await exists(planted), false);
    assertEquals(runs.length, 1);
    assertEquals(runs[0].x.cwd, work);
    assertEquals(runs[0].x.cmd.slice(0, 2), ['sh', '-c']);
    assertEquals(runs[0].x.cmd.slice(3, 6), ['fetch', 'origin', 'main']);

    // The control: the same command run in the repo, as its environment does, runs its hooks.
    await hereEnv.run(runs[0].x, runs[0].input);
    assertEquals(await exists(planted), true);
    assertEquals(
      await git(work, 'rev-parse', 'refs/remotes/origin/main'),
      await git(other, 'rev-parse', 'HEAD'),
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('fetchRepo: one at a time per folder; problems are outcomes', async () => {
  const dir = await Deno.makeTempDir();
  try {
    const { work, other, opts } = await setUp(dir);
    await git(other, 'commit', '-q', '--allow-empty', '-m', 'theirs');
    await git(other, 'push', '-q');
    const first = fetchRepo(hereEnv, work, work, opts);
    assertEquals(fetchRunning(work), true);
    assert(fetchRepo(hereEnv, work, work, opts) === first);
    assertEquals(await first, { ok: true, updated: true });
    assertEquals(fetchRunning(work), false);

    // Over the size limit.
    await git(other, 'commit', '-q', '--allow-empty', '-m', 'more');
    await git(other, 'push', '-q');
    await fetchUpstream(work, opts);
    assertEquals(await upstreamBundle(work, opts, 10), {
      problem: 'fetch too large for devc web: run git fetch in the project',
    });

    // A remote the host may not fetch.
    assertEquals(
      await fetchRepo(hereEnv, work, work, { ...opts, fetchable: () => false }),
      { ok: false, problem: 'devc web fetches only https and ssh remotes' },
    );
    // No upstream, and no repo.
    await git(work, 'checkout', '-q', '-b', 'side');
    assertEquals(await fetchRepo(hereEnv, work, work, opts), {
      ok: false,
      problem: 'side has no upstream',
    });
    assertEquals(await fetchRepo(hereEnv, dir, dir, opts), {
      ok: false,
      problem: 'not a git repo',
    });
    // The environment's git failing.
    await git(work, 'checkout', '-q', 'main');
    const failing = {
      run: () =>
        Promise.resolve({
          code: 1,
          stdout: new Uint8Array(),
          stderr: 'fatal: nope\n',
        }),
    };
    assertEquals(await fetchRepo(failing, work, work, opts), {
      ok: false,
      problem: 'git fetch: fatal: nope',
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('remote and branch names are validated before they reach argv', async () => {
  for (const bad of ['-x', 'a b', '..', '.', '', 'a/b', 'a;b']) {
    assertEquals(validRemote(bad), false, bad);
  }
  for (const good of ['origin', 'up-stream', 'my.remote_2']) {
    assertEquals(validRemote(good), true, good);
  }
  for (const bad of ['-x', 'a b', '..', '', 'a..b', 'x.lock', '@{-1}']) {
    assertEquals(await validBranch(bad), false, bad);
  }
  for (const good of ['main', 'feature/x', 'v1.2']) {
    assertEquals(await validBranch(good), true, good);
  }
});

/** `other` commits `file` with `text` and pushes it. */
async function pushFile(other: string, file: string, text: string) {
  await Deno.writeTextFile(`${other}/${file}`, text);
  await git(other, 'add', file);
  await git(other, 'commit', '-q', '-m', `${file}: ${text}`);
  await git(other, 'push', '-q');
}

Deno.test('pullRepo fast-forwards the branch and its working tree', async () => {
  const dir = await Deno.makeTempDir();
  try {
    const { work, other, opts } = await setUp(dir);
    await pushFile(other, 'f.txt', 'theirs');
    const first = pullRepo(hereEnv, work, work, opts);
    assertEquals(pullRunning(work), true);
    assert(pullRepo(hereEnv, work, work, opts) === first);
    assertEquals(await first, { ok: true, updated: true });
    assertEquals(pullRunning(work), false);
    assertEquals(
      await git(work, 'rev-parse', 'HEAD'),
      await git(other, 'rev-parse', 'HEAD'),
    );
    assertEquals(await Deno.readTextFile(`${work}/f.txt`), 'theirs');
    assertEquals(await pullRepo(hereEnv, work, work, opts), {
      ok: true,
      updated: false,
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('pullRepo refuses what is not a fast-forward, and a changed file it would overwrite', async () => {
  const dir = await Deno.makeTempDir();
  try {
    const { work, other, opts } = await setUp(dir);
    await pushFile(other, 'f.txt', 'theirs');

    // A modified file the incoming commit also changes: untouched.
    await Deno.writeTextFile(`${work}/f.txt`, 'mine');
    const head = await git(work, 'rev-parse', 'HEAD');
    let out = await pullRepo(hereEnv, work, work, opts);
    assert(
      !out.ok && out.problem.startsWith('git merge: '),
      out.ok ? '' : out.problem,
    );
    assertEquals(await Deno.readTextFile(`${work}/f.txt`), 'mine');
    assertEquals(await git(work, 'rev-parse', 'HEAD'), head);
    await Deno.remove(`${work}/f.txt`);

    // A local commit: diverged.
    await git(work, 'commit', '-q', '--allow-empty', '-m', 'mine');
    const local = await git(work, 'rev-parse', 'HEAD');
    out = await pullRepo(hereEnv, work, work, opts);
    assert(
      !out.ok && out.problem.startsWith('git merge: '),
      out.ok ? '' : out.problem,
    );
    assertEquals(await git(work, 'rev-parse', 'HEAD'), local);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('pullRepo: a branch switched since it was read is refused', async () => {
  const dir = await Deno.makeTempDir();
  try {
    const { work, opts } = await setUp(dir);
    const run = await hereEnv.runLimited(
      { cmd: moveArgv('pull', 'refs/remotes/origin/main', 'side'), cwd: work },
      { timeoutMs: 10_000, maxOutput: 4096 },
    );
    assertEquals(run.kind === 'exit' && run.code, 3);
    const switched = {
      run: hereEnv.run,
      runLimited: (): Promise<BridgeRun> =>
        Promise.resolve({ kind: 'exit', code: 3, stdout: '', stderr: '' }),
    };
    assertEquals(await pullRepo(switched, work, work, opts), {
      ok: false,
      problem: 'the branch changed: try again',
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("pullRepo's host steps never run the repo's hooks or fsmonitor", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const { work, other, opts } = await setUp(dir);
    const planted = `${dir}/planted`;
    const script = `${dir}/payload.sh`;
    await Deno.writeTextFile(script, `#!/bin/sh\ntouch ${planted}\n`);
    await Deno.chmod(script, 0o755);
    await git(work, 'config', 'core.fsmonitor', script);
    await git(work, 'config', 'core.hooksPath', dir);
    for (const hook of ['reference-transaction', 'post-merge']) {
      await Deno.copyFile(script, `${dir}/${hook}`);
    }
    await pushFile(other, 'f.txt', 'theirs');

    // The environment only records: everything that ran, ran on the host.
    const limited: EnvExec[] = [];
    const recording = {
      run: (): Promise<ExecOutput> =>
        Promise.resolve({
          code: 0,
          stdout: new TextEncoder().encode('a b\n'),
          stderr: '',
        }),
      runLimited: (x: EnvExec): Promise<BridgeRun> => {
        limited.push(x);
        return Promise.resolve({
          kind: 'exit',
          code: 0,
          stdout: 'a b\n',
          stderr: '',
        });
      },
    };
    assertEquals(await pullRepo(recording, work, work, opts), {
      ok: true,
      updated: true,
    });
    assertEquals(await exists(planted), false);
    assertEquals(limited.length, 1);
    assertEquals(limited[0].cwd, work);
    assertEquals(limited[0].cmd.slice(3), [
      'pull',
      'refs/remotes/origin/main',
      'main',
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

/**
 * A fork (`fork.git`, a local path: a URL remote to git_repo.ts) with branch `feat` and its
 * author's clone, and `work` on `pr-1` tracking it as `gh pr checkout` sets up a fork's PR.
 * `x.txt` changes in the PR; `keep.txt` never does.
 */
async function setUpFork(dir: string) {
  const { work, opts } = await setUp(dir);
  const fork = `${dir}/fork.git`;
  const author = `${dir}/author`;
  await git(dir, 'clone', '-q', '--bare', `${dir}/remote.git`, fork);
  await git(dir, 'clone', '-q', fork, author);
  await Deno.writeTextFile(`${author}/keep.txt`, 'keep\n');
  await Deno.writeTextFile(`${author}/x.txt`, 'one\n');
  await git(author, 'add', '.');
  await git(author, 'commit', '-q', '-m', 'files');
  await git(author, 'push', '-q', 'origin', 'HEAD:main');
  await git(author, 'checkout', '-q', '-b', 'feat');
  await Deno.writeTextFile(`${author}/x.txt`, 'two\n');
  await git(author, 'commit', '-q', '-am', 'pr: two');
  await git(author, 'push', '-q', '-u', 'origin', 'feat');
  await git(work, 'fetch', '-q', fork, 'feat');
  await git(work, 'checkout', '-q', '-b', 'pr-1', 'FETCH_HEAD');
  await git(work, 'config', 'branch.pr-1.remote', fork);
  await git(work, 'config', 'branch.pr-1.merge', 'refs/heads/feat');
  return { work, opts, fork, author };
}

/** Every ref in `repo` but `refs/heads/pr-1`, with its commit. */
const otherRefs = async (repo: string) =>
  (await git(repo, 'for-each-ref', '--format=%(refname) %(objectname)'))
    .split('\n').filter((l) => !l.startsWith('refs/heads/pr-1 ')).join('\n');

Deno.test('a branch that tracks a URL: Fetch on the host, Pull by bundle, no refs written', async () => {
  const dir = await Deno.realPath(await Deno.makeTempDir());
  try {
    const { work, opts, fork, author } = await setUpFork(dir);
    const state = await readGitState(work, opts);
    assert(state !== null && !isGitProblem(state));
    assertEquals(state.upstream, `${fork} feat`);
    assertEquals(state.foreign, true);

    await Deno.writeTextFile(`${author}/x.txt`, 'three\n');
    await git(author, 'commit', '-q', '-am', 'pr: three');
    await git(author, 'push', '-q');
    const tip = await git(author, 'rev-parse', 'HEAD');
    const before = await otherRefs(work);
    assertEquals(await fetchRepo(hereEnv, work, work, opts), {
      ok: true,
      updated: true,
    });
    assertEquals(await fetchRepo(hereEnv, work, work, opts), {
      ok: true,
      updated: false,
    });
    const behind = await readGitState(work, opts);
    assert(behind !== null && !isGitProblem(behind));
    assertEquals([behind.ahead, behind.behind], [0, 1]);

    assertEquals(await pullRepo(hereEnv, work, work, opts), {
      ok: true,
      updated: true,
    });
    assertEquals(await git(work, 'rev-parse', 'HEAD'), tip);
    assertEquals(await otherRefs(work), before);
    assertEquals(await pullRepo(hereEnv, work, work, opts), {
      ok: true,
      updated: false,
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('resetRepo after the author rebases: moves the branch, keeps unrelated changes', async () => {
  const dir = await Deno.realPath(await Deno.makeTempDir());
  try {
    const { work, opts, author } = await setUpFork(dir);
    const old = await git(work, 'rev-parse', 'HEAD');
    // The author rewrites the PR and force-pushes.
    await git(author, 'reset', '-q', '--hard', 'HEAD~1');
    await Deno.writeTextFile(`${author}/x.txt`, 'rebased\n');
    await git(author, 'commit', '-q', '-am', 'pr: rebased');
    await git(author, 'push', '-q', '--force');
    const tip = await git(author, 'rev-parse', 'HEAD');

    // Pull can't: the branch diverged.
    const diverged = await pullRepo(hereEnv, work, work, opts);
    assert(!diverged.ok && diverged.problem.startsWith('git merge: '));

    // An edit in a file the reset changes: git stops, nothing moves.
    await Deno.writeTextFile(`${work}/x.txt`, 'mine\n');
    const refused = await resetRepo(hereEnv, work, work, opts);
    assert(
      !refused.ok && refused.problem.startsWith('git reset: '),
      JSON.stringify(refused),
    );
    assertEquals(await git(work, 'rev-parse', 'HEAD'), old);
    assertEquals(await Deno.readTextFile(`${work}/x.txt`), 'mine\n');

    await git(work, 'checkout', '-q', '--', 'x.txt');
    await Deno.writeTextFile(`${work}/keep.txt`, 'mine\n');
    assertEquals(await resetRepo(hereEnv, work, work, opts), {
      ok: true,
      updated: true,
    });
    assertEquals(await git(work, 'rev-parse', 'HEAD'), tip);
    assertEquals(await Deno.readTextFile(`${work}/x.txt`), 'rebased\n');
    assertEquals(await Deno.readTextFile(`${work}/keep.txt`), 'mine\n');
    assert((await git(work, 'reflog', '--format=%H')).includes(old));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('resetRepo on a named remote; refused for a branch Push updates', async () => {
  const dir = await Deno.realPath(await Deno.makeTempDir());
  try {
    const { work, other, opts } = await setUp(dir);
    assertEquals(await resetRepo(hereEnv, work, work, opts), {
      ok: false,
      problem: "not a PR branch: reset is for branches you don't push",
    });
    // `review` tracks origin/main under another name: Push never updates it.
    await git(work, 'checkout', '-q', '-b', 'review', '--track', 'origin/main');
    await git(work, 'commit', '-q', '--allow-empty', '-m', 'mine');
    await git(other, 'commit', '-q', '--allow-empty', '-m', 'theirs');
    await git(other, 'push', '-q');
    const theirs = await git(other, 'rev-parse', 'HEAD');
    const state = await readGitState(work, opts);
    assert(state !== null && !isGitProblem(state));
    assertEquals(state.foreign, true);
    assertEquals(await resetRepo(hereEnv, work, work, opts), {
      ok: true,
      updated: true,
    });
    assertEquals(await git(work, 'rev-parse', 'HEAD'), theirs);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('resetRefusal: a PR branch with something newer; never a page under --live', () => {
  const pr = { foreign: true as const, behind: 2 };
  assertEquals(resetRefusal(pr, 'page', false), null);
  assertEquals(resetRefusal(pr, 'desktop', true), null);
  assertEquals(
    resetRefusal(pr, 'page', true),
    'resetting a branch is refused under --live',
  );
  assertEquals(
    resetRefusal({ behind: 2 }, 'page', false),
    "not a PR branch: reset is for branches you don't push",
  );
  assertEquals(
    resetRefusal({ ...pr, behind: 0 }, 'page', false),
    'nothing to reset to',
  );
});
