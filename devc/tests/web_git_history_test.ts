import { assert, assertEquals } from 'jsr:@std/assert';
import {
  type CommitHistory,
  parseLog,
  PUSHED_SHOWN,
  readCommitHistory,
} from '../web/git_history.ts';
import { fetchUpstream, type MirrorOpts } from '../web/git_status.ts';
import { parseRemoteUrl } from '../web/git_repo.ts';

async function git(cwd: string, ...args: string[]) {
  const out = await new Deno.Command('git', {
    args: ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args],
    cwd,
    stdout: 'null',
    stderr: 'piped',
  }).output();
  if (!out.success) throw new Error(new TextDecoder().decode(out.stderr));
}

const commit = (cwd: string, message: string) =>
  git(cwd, 'commit', '-q', '--allow-empty', '-m', message);

const subjects = (h: CommitHistory) => ({
  incoming: h.incoming.map((c) => c.subject),
  local: h.local.map((c) => c.subject),
  pushed: h.pushed.map((c) => c.subject),
});

async function read(folder: string, opts: MirrorOpts) {
  const h = await readCommitHistory(folder, { ...opts, checkRemote: true });
  if ('problem' in h) throw new Error(h.problem);
  return h;
}

/** A bare remote and a clone with one pushed commit; the remote is a local path, which tests allow. */
async function withRepo(
  body: (dirs: {
    dir: string;
    remote: string;
    work: string;
    opts: MirrorOpts;
  }) => Promise<void>,
) {
  const dir = await Deno.makeTempDir();
  try {
    const remote = `${dir}/remote.git`;
    const work = `${dir}/work`;
    await git(dir, 'init', '-q', '--bare', '-b', 'main', remote);
    await git(dir, 'clone', '-q', remote, work);
    await commit(work, 'one');
    await git(work, 'push', '-q', '-u', 'origin', 'main');
    await body({
      dir,
      remote,
      work,
      opts: { root: `${dir}/mirrors`, fetchable: () => true },
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test('parseLog reads commits, marks merges and leaves out other lines', () => {
  const a = 'a'.repeat(40);
  const b = 'b'.repeat(40);
  assertEquals(
    parseLog(
      `${a}\0${b}\0Ann\x00100\0fix it\n${b}\0${a} ${b}\0Bo\x00200\0merge\nnoise\n`,
    ),
    [
      { hash: a, subject: 'fix it', author: 'Ann', time: 100, merge: false },
      { hash: b, subject: 'merge', author: 'Bo', time: 200, merge: true },
    ],
  );
});

Deno.test('parseLog keeps markup as plain text and caps a long subject', () => {
  const [c] = parseLog(
    `${'a'.repeat(40)}\0\0<b>\x00x\0<img src=x>${'y'.repeat(1000)}\n`,
  );
  assert(c.subject.startsWith('<img src=x>'));
  assertEquals(c.subject.length, 500);
  assertEquals(c.time, 0);
  assertEquals(c.merge, false);
});

Deno.test("parseRemoteUrl takes the named remote's first url", () => {
  const list = 'remote.a.url\nu1\0remote.a.url\nu2\0remote.b.url\nu3\0';
  assertEquals(parseRemoteUrl(list, 'a'), 'u1');
  assertEquals(parseRemoteUrl(list, 'b'), 'u3');
  assertEquals(parseRemoteUrl(list, 'origin'), null);
});

Deno.test('a branch with an upstream sorts commits as its counts do', async () => {
  await withRepo(async ({ dir, remote, work, opts }) => {
    const other = `${dir}/other`;
    await git(dir, 'clone', '-q', remote, other);
    await commit(other, 'theirs');
    await git(other, 'push', '-q');
    await commit(work, 'mine');
    await commit(work, 'mine too');
    const before = await read(work, opts);
    assertEquals(before.compare, 'origin/main');
    assertEquals(before.localTotal, 2);
    assertEquals(subjects(before), {
      incoming: [],
      local: ['mine too', 'mine'],
      pushed: ['one'],
    });

    // Only the host's fetch has "theirs": the repo's own refs don't, and it still shows.
    assertEquals(await fetchUpstream(work, opts), true);
    const after = await read(work, opts);
    assertEquals(after.incomingTotal, 1);
    assertEquals(subjects(after).incoming, ['theirs']);
    assertEquals(subjects(after).local, ['mine too', 'mine']);
  });
});

Deno.test("a push the repo's own refs never heard of counts as pushed", async () => {
  await withRepo(async ({ dir, work, remote, opts }) => {
    await git(work, 'switch', '-q', '-c', 'feat');
    await commit(work, 'feature');
    await commit(work, 'unpushed');
    // As `gh-push` does: to the remote from elsewhere, moving none of the repo's refs.
    // The push runs from a separate bare repo, not from `work`: some git versions
    // record refs/remotes/origin/feat when `work` pushes to a URL that is origin's.
    const tip = await new Deno.Command('git', {
      args: ['rev-parse', 'HEAD~1'],
      cwd: work,
    }).output();
    const sha = new TextDecoder().decode(tip.stdout).trim();
    const elsewhere = `${dir}/elsewhere.git`;
    await git(dir, 'init', '-q', '--bare', elsewhere);
    await git(elsewhere, 'fetch', '-q', work, 'feat');
    await git(elsewhere, 'push', '-q', remote, `${sha}:refs/heads/feat`);
    assertEquals(
      (await new Deno.Command('git', {
        args: ['for-each-ref', 'refs/remotes/origin/feat'],
        cwd: work,
        stdout: 'piped',
      }).output()).stdout.length,
      0,
    );
    const h = await read(work, opts);
    assertEquals(h.compare, 'origin/feat');
    assertEquals(subjects(h), {
      incoming: [],
      local: ['unpushed'],
      pushed: ['feature', 'one'],
    });

    // Without the look at the remote, what was seen last stands.
    const quiet = await readCommitHistory(work, opts);
    assert(!('problem' in quiet));
    assertEquals(subjects(quiet).local, ['unpushed']);

    // Deleted from the remote: its commits are local again, compared with what the repo tracks.
    await git(elsewhere, 'push', '-q', remote, ':refs/heads/feat');
    const gone = await read(work, opts);
    assertEquals(gone.compare, 'remote branches');
    assertEquals(subjects(gone), {
      incoming: [],
      local: ['unpushed', 'feature'],
      pushed: ['one'],
    });
  });
});

Deno.test('a new branch off main lists only its own commits as local', async () => {
  await withRepo(async ({ work, opts }) => {
    await git(work, 'switch', '-q', '-c', 'feat');
    await commit(work, 'feature');
    const h = await read(work, opts);
    assertEquals(h.compare, 'remote branches');
    assertEquals(subjects(h), {
      incoming: [],
      local: ['feature'],
      pushed: ['one'],
    });
  });
});

Deno.test('a repo with no remote is all local', async () => {
  const dir = await Deno.makeTempDir();
  try {
    await git(dir, 'init', '-q', '-b', 'main', 'work');
    const work = `${dir}/work`;
    await commit(work, 'one');
    const h = await read(work, { root: `${dir}/mirrors` });
    assertEquals(h.compare, null);
    assertEquals(subjects(h), { incoming: [], local: ['one'], pushed: [] });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('a long pushed history is cut short, and says so', async () => {
  await withRepo(async ({ work, opts }) => {
    for (let i = 0; i < PUSHED_SHOWN; i++) await commit(work, `c${i}`);
    await git(work, 'push', '-q');
    const h = await read(work, opts);
    assertEquals(h.pushed.length, PUSHED_SHOWN);
    assertEquals(h.morePushed, true);
    assertEquals(h.local, []);
  });
});

Deno.test("readCommitHistory never runs the repo's hooks or fsmonitor", async () => {
  await withRepo(async ({ dir, work, opts }) => {
    await git(work, 'switch', '-q', '-c', 'feat');
    await commit(work, 'feature');
    const planted = `${dir}/planted`;
    const script = `${dir}/payload.sh`;
    await Deno.writeTextFile(script, `#!/bin/sh\ntouch ${planted}\n`);
    await Deno.chmod(script, 0o755);
    await git(work, 'config', 'core.fsmonitor', script);
    await git(work, 'config', 'core.hooksPath', dir);
    await Deno.copyFile(script, `${dir}/reference-transaction`);
    await read(work, opts);
    assertEquals(await Deno.stat(planted).then(() => true, () => false), false);
    // The control: running git in the repo, as the editor does, would have run it.
    await git(work, 'status');
    assertEquals(await Deno.stat(planted).then(() => true, () => false), true);
  });
});

Deno.test('readCommitHistory gives a problem for no repo and a detached HEAD', async () => {
  const dir = await Deno.makeTempDir();
  try {
    const opts = { root: `${dir}/mirrors` };
    assertEquals(await readCommitHistory(dir, opts), {
      problem: 'not a git repo',
    });
    await git(dir, 'init', '-q', '-b', 'main', 'work');
    const work = `${dir}/work`;
    await commit(work, 'one');
    await git(work, 'switch', '-q', '--detach');
    assertEquals(await readCommitHistory(work, opts), {
      problem: 'detached HEAD',
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
