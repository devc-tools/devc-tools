import { assertEquals } from 'jsr:@std/assert';
import {
  fetchUpstream,
  type GitReading,
  type GitStatus,
  GitStatusWatch,
  type MirrorOpts,
  readGitState,
  readGitStatus,
} from '../web/git_status.ts';

async function git(cwd: string, ...args: string[]) {
  const out = await new Deno.Command('git', {
    args: ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args],
    cwd,
    stdout: 'null',
    stderr: 'piped',
  }).output();
  if (!out.success) throw new Error(new TextDecoder().decode(out.stderr));
}

const counts = (s: GitStatus | null) =>
  s && [s.branch, s.upstream, s.ahead, s.behind, s.gone, s.toFetch];

Deno.test('readGitStatus counts in a mirror, and fetchUpstream brings in the remote', async () => {
  const dir = await Deno.makeTempDir();
  try {
    const remote = `${dir}/remote.git`;
    const work = `${dir}/work`;
    const other = `${dir}/other`;
    // The remote is a local path, which the host would never fetch; tests allow it.
    const opts: MirrorOpts = { root: `${dir}/mirrors`, fetchable: () => true };
    await git(dir, 'init', '-q', '--bare', '-b', 'main', remote);
    await git(dir, 'clone', '-q', remote, work);
    await git(work, 'commit', '-q', '--allow-empty', '-m', 'one');
    await git(work, 'push', '-q', '-u', 'origin', 'main');
    await git(dir, 'clone', '-q', remote, other);
    assertEquals(counts(await readGitStatus(work, opts)), [
      'main',
      'origin/main',
      0,
      0,
      false,
      false,
    ]);

    await git(other, 'commit', '-q', '--allow-empty', '-m', 'theirs');
    await git(other, 'push', '-q');
    await git(work, 'commit', '-q', '--allow-empty', '-m', 'mine');
    // Only the repo's own remote-tracking ref so far: nothing to pull yet.
    assertEquals((await readGitStatus(work, opts))?.ahead, 1);
    assertEquals((await readGitStatus(work, opts))?.behind, 0);
    // The mirror's fetch sees the remote's commit; the repo's own refs are untouched, so a
    // Fetch would move its remote-tracking ref.
    assertEquals(await fetchUpstream(work, opts), true);
    assertEquals(counts(await readGitStatus(work, opts)), [
      'main',
      'origin/main',
      1,
      1,
      false,
      true,
    ]);
    // The repo's own fetch brings it in: nothing left to Fetch, still one to pull.
    await git(work, 'fetch', '-q');
    assertEquals(counts(await readGitStatus(work, opts))?.slice(2), [
      1,
      1,
      false,
      false,
    ]);

    // A pull in the repo makes its own ref newer than the mirror's: that one counts.
    await git(work, 'pull', '-q', '--rebase');
    await git(work, 'push', '-q');
    assertEquals(counts(await readGitStatus(work, opts))?.slice(2), [
      0,
      0,
      false,
      false,
    ]);

    // A worktree reads its own branch through its primary's refs.
    await git(work, 'worktree', 'add', '-q', '-b', 'side', `${dir}/side`);
    assertEquals(counts(await readGitStatus(`${dir}/side`, opts)), [
      'side',
      null,
      0,
      0,
      false,
      false,
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('readGitStatus: no repo, a gone upstream, and a refused remote', async () => {
  const dir = await Deno.makeTempDir();
  try {
    const opts: MirrorOpts = { root: `${dir}/mirrors` };
    assertEquals(await readGitStatus(dir, opts), null);
    const work = `${dir}/work`;
    await git(dir, 'init', '-q', '-b', 'main', work);
    await git(work, 'commit', '-q', '--allow-empty', '-m', 'one');
    await git(work, 'remote', 'add', 'origin', 'ext::sh -c touch% /tmp/pwned');
    await git(work, 'config', 'branch.main.remote', 'origin');
    await git(work, 'config', 'branch.main.merge', 'refs/heads/main');
    assertEquals(counts(await readGitStatus(work, opts)), [
      'main',
      'origin/main',
      0,
      0,
      true,
      false,
    ]);
    assertEquals(await fetchUpstream(work, opts), false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('readGitState says why a repo has no status: a timeout, a detached HEAD, a failed fetch', async () => {
  const dir = await Deno.makeTempDir();
  try {
    const opts: MirrorOpts = { root: `${dir}/mirrors` };
    assertEquals(await readGitState(dir, opts), null);
    const work = `${dir}/work`;
    await git(dir, 'init', '-q', '-b', 'main', work);
    await git(work, 'commit', '-q', '--allow-empty', '-m', 'one');
    await git(work, 'remote', 'add', 'origin', `${dir}/remote.git`);
    await git(work, 'config', 'branch.main.remote', 'origin');
    await git(work, 'config', 'branch.main.merge', 'refs/heads/main');
    // Killed by its timeout, and not retried without the remote-tracking ref.
    assertEquals(
      await readGitState(work, { ...opts, localFetchTimeoutMs: 1 }),
      { problem: 'git fetch: timed out' },
    );
    assertEquals(counts(await readGitStatus(work, opts))?.[0], 'main');

    // A branch HEAD names but the repo lacks: git's own error line.
    await git(work, 'symbolic-ref', 'HEAD', 'refs/heads/ghost');
    await git(work, 'config', 'branch.ghost.remote', 'origin');
    await git(work, 'config', 'branch.ghost.merge', 'refs/heads/ghost');
    const failed = await readGitState(work, opts);
    assertEquals(
      failed !== null && 'problem' in failed &&
        failed.problem.startsWith('git fetch: ') &&
        failed.problem.length > 'git fetch: '.length &&
        !failed.problem.endsWith('timed out'),
      true,
      JSON.stringify(failed),
    );
    assertEquals(await readGitStatus(work, opts), null);

    await git(work, 'checkout', '-q', '--detach', 'main');
    assertEquals(await readGitState(work, opts), { problem: 'detached HEAD' });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("readGitStatus never runs the repo's hooks or fsmonitor", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const remote = `${dir}/remote.git`;
    const work = `${dir}/work`;
    const opts: MirrorOpts = { root: `${dir}/mirrors`, fetchable: () => true };
    await git(dir, 'init', '-q', '--bare', '-b', 'main', remote);
    await git(dir, 'clone', '-q', remote, work);
    await git(work, 'commit', '-q', '--allow-empty', '-m', 'one');
    await git(work, 'push', '-q', '-u', 'origin', 'main');
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
    await readGitStatus(work, opts);
    await fetchUpstream(work, opts);
    await readGitStatus(work, opts);
    assertEquals(await Deno.stat(planted).then(() => true, () => false), false);
    // The control: running git in the repo, as the editor does, would have run it.
    await git(work, 'status');
    assertEquals(await Deno.stat(planted).then(() => true, () => false), true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('GitStatusWatch reports only changes, and drops folders no longer listed', async () => {
  let folders = ['/a', '/b'];
  const statuses: Record<string, GitReading> = {
    '/a': {
      branch: 'main',
      upstream: 'origin/main',
      ahead: 1,
      behind: 0,
      gone: false,
      toFetch: false,
    },
    '/b': null,
  };
  let changes = 0;
  const watch = new GitStatusWatch({
    folders: () => folders,
    onChange: () => changes++,
    read: (f) => Promise.resolve(statuses[f] ?? null),
  });
  // One call per folder read for the first time.
  await watch.refresh();
  assertEquals(changes, 2);
  assertEquals(watch.statuses.get('/b'), null);
  await watch.refresh();
  assertEquals(changes, 2);
  statuses['/a'] = { ...(statuses['/a'] as GitStatus), behind: 2 };
  await watch.refresh();
  assertEquals(
    [changes, (watch.statuses.get('/a') as GitStatus).behind],
    [3, 2],
  );
  // A reason alone, or a new one, is a change.
  statuses['/b'] = { problem: 'detached HEAD' };
  await watch.refresh();
  assertEquals([changes, watch.statuses.get('/b')], [4, {
    problem: 'detached HEAD',
  }]);
  statuses['/b'] = { problem: 'git fetch: timed out' };
  await watch.refresh();
  assertEquals(changes, 5);
  folders = ['/a'];
  await watch.refresh();
  assertEquals([changes, watch.statuses.has('/b')], [6, false]);
});

Deno.test('GitStatusWatch.fetchAll fetches every folder, then reads them again', async () => {
  const fetched: string[] = [];
  let reads = 0;
  const watch = new GitStatusWatch({
    folders: () => ['/a', '/b'],
    onChange: () => {},
    read: () => {
      reads++;
      return Promise.resolve(null);
    },
    fetch: (f) => {
      fetched.push(f);
      return Promise.resolve(true);
    },
  });
  await watch.fetchAll();
  assertEquals([fetched, reads], [['/a', '/b'], 2]);
});
