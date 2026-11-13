import { assertEquals } from 'jsr:@std/assert';
import {
  fetchUpstream,
  type GitReading,
  type GitStatus,
  GitStatusWatch,
  type MirrorOpts,
  readGitState,
  readGitStatus,
  refreshRemote,
} from '../web/git_status.ts';
import { readCommitHistory } from '../web/git_history.ts';

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
  s && [s.branch, s.upstream, s.ahead, s.behind, s.gone, s.unfetched];

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
      0,
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
      1,
    ]);
    // The repo's own fetch brings it in: nothing left to Fetch, still one to pull.
    await git(work, 'fetch', '-q');
    assertEquals(counts(await readGitStatus(work, opts))?.slice(2), [
      1,
      1,
      false,
      0,
    ]);

    // A pull in the repo makes its own ref newer than the mirror's: that one counts.
    await git(work, 'pull', '-q', '--rebase');
    await git(work, 'push', '-q');
    assertEquals(counts(await readGitStatus(work, opts))?.slice(2), [
      0,
      0,
      false,
      0,
    ]);

    // A worktree reads its own branch through its primary's refs.
    await git(work, 'worktree', 'add', '-q', '-b', 'side', `${dir}/side`);
    assertEquals(counts(await readGitStatus(`${dir}/side`, opts)), [
      'side',
      null,
      0,
      0,
      false,
      0,
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('readGitStatus: unfetched counts what only the mirror has', async () => {
  const dir = await Deno.makeTempDir();
  try {
    const remote = `${dir}/remote.git`;
    const work = `${dir}/work`;
    const other = `${dir}/other`;
    const opts: MirrorOpts = { root: `${dir}/mirrors`, fetchable: () => true };
    await git(dir, 'init', '-q', '--bare', '-b', 'main', remote);
    await git(dir, 'clone', '-q', remote, work);
    await git(work, 'commit', '-q', '--allow-empty', '-m', 'one');
    await git(work, 'push', '-q', '-u', 'origin', 'main');
    await git(dir, 'clone', '-q', remote, other);
    const pull = async () => {
      const s = await readGitStatus(work, opts);
      return s && [s.behind, s.unfetched];
    };
    const push = async (n: number) => {
      for (let i = 0; i < n; i++) {
        await git(other, 'commit', '-q', '--allow-empty', '-m', `theirs ${i}`);
      }
      await git(other, 'push', '-q');
    };

    await push(2);
    await fetchUpstream(work, opts);
    assertEquals(await pull(), [2, 2]);
    await git(work, 'fetch', '-q');
    assertEquals(await pull(), [2, 0]);
    await push(1);
    await fetchUpstream(work, opts);
    assertEquals(await pull(), [3, 1]);
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
      0,
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
      unfetched: 0,
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

Deno.test('GitStatusWatch.refresh(folder) reads just that folder, ahead of a running pass', async () => {
  const reads: string[] = [];
  let release!: () => void;
  const held = new Promise<void>((r) => release = r);
  let hold = true;
  const watch = new GitStatusWatch({
    folders: () => ['/a', '/b', '/c'],
    onChange: () => {},
    read: async (f) => {
      reads.push(f);
      if (hold && f === '/a') {
        hold = false;
        await held;
      }
      return null;
    },
  });
  const pass = watch.refresh();
  // /a's read is under way: /c goes next, then the rest of the pass, once each.
  const asked = watch.refresh('/c');
  await asked;
  release();
  await pass;
  assertEquals(reads, ['/a', '/c', '/b']);
  reads.length = 0;
  await watch.refresh('/b');
  assertEquals(reads, ['/b']);
  // A folder no longer listed is not read.
  reads.length = 0;
  await watch.refresh('/gone');
  assertEquals(reads, []);
});

Deno.test('GitStatusWatch reads idle folders only every idlePollMs, but always when asked or after a fetch', async () => {
  const reads: string[] = [];
  let now = 0;
  const watch = new GitStatusWatch({
    folders: () => ['/run', '/stopped'],
    idle: () => new Set(['/stopped']),
    onChange: () => {},
    read: (f) => {
      reads.push(f);
      return Promise.resolve(null);
    },
    fetch: () => Promise.resolve(true),
    idlePollMs: 120_000,
    now: () => now,
  });
  // Never read: read now, idle or not.
  await watch.refresh();
  assertEquals(reads, ['/run', '/stopped']);
  reads.length = 0;
  now = 60_000;
  await watch.refresh();
  assertEquals(reads, ['/run']);
  reads.length = 0;
  await watch.refresh('/stopped');
  assertEquals(reads, ['/stopped']);
  reads.length = 0;
  now = 150_000;
  await watch.refresh();
  assertEquals(reads, ['/run']);
  reads.length = 0;
  now = 180_000;
  await watch.refresh();
  assertEquals(reads, ['/run', '/stopped']);
  reads.length = 0;
  now = 190_000;
  await watch.fetchAll();
  assertEquals(reads, ['/run', '/stopped']);
});

Deno.test('readGitStatus: no upstream counts commits on no remote branch, as Commits does', async () => {
  const dir = await Deno.makeTempDir();
  try {
    const remote = `${dir}/remote.git`;
    const work = `${dir}/work`;
    const opts: MirrorOpts = { root: `${dir}/mirrors`, fetchable: () => true };
    await git(dir, 'init', '-q', '--bare', '-b', 'main', remote);
    await git(dir, 'clone', '-q', remote, work);
    await git(work, 'commit', '-q', '--allow-empty', '-m', 'one');
    await git(work, 'push', '-q', '-u', 'origin', 'main');
    // A branch never pushed, with no upstream: the usual gh-push branch.
    await git(work, 'switch', '-q', '-c', 'feat');
    await git(work, 'commit', '-q', '--allow-empty', '-m', 'two');
    await git(work, 'commit', '-q', '--allow-empty', '-m', 'three');
    assertEquals(counts(await readGitStatus(work, opts)), [
      'feat',
      null,
      2,
      0,
      false,
      0,
    ]);
    // Never on origin: a push would create origin/feat.
    assertEquals((await readGitStatus(work, opts))?.pushCreates, true);
    const history = await readCommitHistory(work, opts);
    assertEquals(
      'localTotal' in history ? history.localTotal : history,
      2,
    );

    // Published from elsewhere (as gh-push does: the repo's refs never hear of it): the remote
    // check finds it, and nothing is left to push.
    await git(work, 'push', '-q', remote, 'feat:refs/heads/feat');
    await git(work, 'update-ref', '-d', 'refs/remotes/origin/feat');
    assertEquals((await readGitStatus(work, opts))?.ahead, 2);
    assertEquals(await refreshRemote(work, opts), true);
    assertEquals((await readGitStatus(work, opts))?.ahead, 0);
    const after = await readCommitHistory(work, opts);
    // On origin, one more commit: a push updates origin/feat rather than creating it.
    await git(work, 'commit', '-q', '--allow-empty', '-m', 'four');
    const more = await readGitStatus(work, opts);
    assertEquals([more?.ahead, more?.pushCreates], [1, false]);
    assertEquals('localTotal' in after ? after.localTotal : after, 0);

    // No origin: nowhere to push, so nothing counts.
    const lone = `${dir}/lone`;
    await git(dir, 'init', '-q', '-b', 'main', lone);
    await git(lone, 'commit', '-q', '--allow-empty', '-m', 'one');
    assertEquals((await readGitStatus(lone, opts))?.ahead, 0);
    assertEquals(await refreshRemote(lone, opts), false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
