import { assert, assertEquals } from 'jsr:@std/assert';
import {
  type CommitDiff,
  type CommitFiles,
  MAX_COMMIT_FILES,
  MAX_COMMIT_PATCH,
  MAX_COMMIT_TEXT,
  parseDiffTree,
  patchBody,
  readCommitDiff,
  readCommitFileAt,
  readCommitFiles,
} from '../web/git_commit.ts';
import { readCommitHistory } from '../web/git_history.ts';
import { fetchUpstream, type MirrorOpts } from '../web/git_status.ts';

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

const commit = (cwd: string, message: string) =>
  git(cwd, 'commit', '-q', '--allow-empty', '-m', message);
const head = (cwd: string, rev = 'HEAD') => git(cwd, 'rev-parse', rev);

/** Brings the branch into the mirror, as an open Commits section does. */
async function sync(work: string, opts: MirrorOpts) {
  const h = await readCommitHistory(work, opts);
  if ('problem' in h) throw new Error(h.problem);
}

async function files(work: string, sha: string, opts: MirrorOpts) {
  const r = await readCommitFiles(work, sha, opts);
  if ('problem' in r) throw new Error(r.problem);
  return r;
}

async function diff(work: string, sha: string, path: string, opts: MirrorOpts) {
  const r = await readCommitDiff(work, sha, path, opts);
  if ('problem' in r) throw new Error(r.problem);
  return r;
}

const brief = (r: CommitFiles) =>
  r.files.map((
    f,
  ) => [f.status, f.path, f.previousPath, f.additions, f.deletions, f.binary]);

/** A repo with no remote and one commit, its mirror under the temp dir. */
async function withRepo(
  body: (d: { dir: string; work: string; opts: MirrorOpts }) => Promise<void>,
) {
  const dir = await Deno.makeTempDir();
  try {
    const work = `${dir}/work`;
    await git(dir, 'init', '-q', '-b', 'main', work);
    await Deno.writeTextFile(
      `${work}/a.txt`,
      'one\ntwo\nthree\nfour\nfive\nsix\nseven\n',
    );
    await Deno.writeTextFile(`${work}/gone.txt`, 'bye\n');
    await Deno.writeTextFile(`${work}/link`, 'was a file\n');
    await Deno.writeTextFile(
      `${work}/old.txt`,
      Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n') + '\n',
    );
    await git(work, 'add', '-A');
    await commit(work, 'root');
    await body({
      dir,
      work,
      opts: { root: `${dir}/mirrors`, fetchable: () => true },
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test('parseDiffTree pairs raw entries with their numstat, in path order', () => {
  const z = 'f'.repeat(40);
  const o = '0'.repeat(40);
  const out = [
    `:000000 100644 ${o} ${z} A`,
    'z.bin',
    `:100644 100644 ${z} ${z} R087`,
    'a\nb',
    'm.txt',
    `:100644 120000 ${z} ${z} T`,
    'link',
    '-\t-\tz.bin',
    '1\t0\t',
    'a\nb',
    'm.txt',
    '2\t3\tlink',
    '',
  ].join('\0');
  assertEquals(
    parseDiffTree(out).map((
      f,
    ) => [
      f.status,
      f.path,
      f.previousPath,
      f.additions,
      f.deletions,
      f.binary,
    ]),
    [
      ['modified', 'link', null, 2, 3, false],
      ['renamed', 'm.txt', 'a\nb', 1, 0, false],
      ['added', 'z.bin', null, 0, 0, true],
    ],
  );
});

Deno.test('patchBody starts at the first hunk', () => {
  assertEquals(
    patchBody(
      'diff --git a/x b/x\nindex 1..2\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n',
    ),
    '@@ -1 +1 @@\n-a\n+b\n',
  );
  assertEquals(patchBody('@@ -1 +1 @@\n'), '@@ -1 +1 @@\n');
  assertEquals(
    patchBody('diff --git a/x b/x\nold mode 100644\nnew mode 100755\n'),
    '',
  );
});

Deno.test('a commit lists modified, added, removed, renamed, type-changed and binary files', async () => {
  await withRepo(async ({ work, opts }) => {
    await Deno.writeTextFile(
      `${work}/a.txt`,
      'one\ntwo\nTHREE\nfour\nfive\nsix\nseven\n',
    );
    await Deno.writeFile(`${work}/new.bin`, new Uint8Array([0, 1, 2, 0]));
    await Deno.writeTextFile(`${work}/odd\nname.txt`, 'x\n');
    await Deno.remove(`${work}/gone.txt`);
    await Deno.remove(`${work}/link`);
    await Deno.symlink('a.txt', `${work}/link`);
    await git(work, 'mv', 'old.txt', 'renamed.txt');
    await Deno.writeTextFile(
      `${work}/renamed.txt`,
      Array.from({ length: 40 }, (_, i) => i === 20 ? 'changed' : `line ${i}`)
        .join('\n') +
        '\n',
    );
    await git(work, 'add', '-A');
    await commit(work, 'change things');
    await sync(work, opts);
    const sha = await head(work);

    const r = await files(work, sha, opts);
    assertEquals(r.hash, sha);
    assertEquals(r.truncated, false);
    assertEquals(brief(r), [
      ['modified', 'a.txt', null, 1, 1, false],
      ['removed', 'gone.txt', null, 0, 1, false],
      ['modified', 'link', null, 1, 1, false],
      ['added', 'new.bin', null, 0, 0, true],
      ['added', 'odd\nname.txt', null, 1, 0, false],
      ['renamed', 'renamed.txt', 'old.txt', 1, 1, false],
    ]);

    const a = await diff(work, sha, 'a.txt', opts);
    assertEquals(a.available, true);
    assertEquals(a.commit.subject, 'change things');
    assertEquals(a.commit.author, 't');
    assertEquals(a.commit.parent, await head(work, 'HEAD~1'));
    assert(a.file.patch!.startsWith('@@ '), a.file.patch!);
    assert(a.file.patch!.includes('-three\n+THREE\n'));

    // A rename's patch shows only the changed lines, not the whole file added.
    const ren = await diff(work, sha, 'renamed.txt', opts);
    assertEquals(ren.file.previousPath, 'old.txt');
    assert(ren.file.patch!.startsWith('@@ '));
    assert(ren.file.patch!.includes('-line 20\n+changed\n'));
    assert(!ren.file.patch!.includes('+line 1\n'));

    const bin = await diff(work, sha, 'new.bin', opts);
    assertEquals([bin.file.binary, bin.file.patch, bin.file.tooLarge], [
      true,
      null,
      false,
    ]);

    const odd = await diff(work, sha, 'odd\nname.txt', opts);
    assertEquals(odd.file.patch, '@@ -0,0 +1 @@\n+x\n');

    const gone = await diff(work, sha, 'gone.txt', opts);
    assertEquals(gone.file.patch, '@@ -1 +0,0 @@\n-bye\n');

    // Text at the commit, for Whole file.
    assertEquals(await readCommitFileAt(work, sha, 'odd\nname.txt', opts), {
      available: true,
      text: 'x\n',
    });
    assertEquals(await readCommitFileAt(work, sha, 'new.bin', opts), {
      available: false,
      message: 'binary file',
    });
    assertEquals(await readCommitFileAt(work, sha, 'gone.txt', opts), {
      available: false,
      message: 'file not in this commit',
    });
  });
});

Deno.test('a root commit adds every file, and an empty commit lists none', async () => {
  await withRepo(async ({ work, opts }) => {
    await commit(work, 'empty');
    await sync(work, opts);
    const root = await head(work, 'HEAD~1');
    const r = await files(work, root, opts);
    assertEquals(r.files.map((f) => [f.status, f.path]), [
      ['added', 'a.txt'],
      ['added', 'gone.txt'],
      ['added', 'link'],
      ['added', 'old.txt'],
    ]);
    const d = await diff(work, root, 'gone.txt', opts);
    assertEquals(d.commit.parent, null);
    assertEquals(d.file.patch, '@@ -0,0 +1 @@\n+bye\n');
    assertEquals((await files(work, await head(work), opts)).files, []);
  });
});

Deno.test('a merge is compared with its first parent', async () => {
  await withRepo(async ({ work, opts }) => {
    await git(work, 'switch', '-q', '-c', 'side');
    await Deno.writeTextFile(`${work}/side.txt`, 'side\n');
    await git(work, 'add', '-A');
    await commit(work, 'side');
    await git(work, 'switch', '-q', 'main');
    await Deno.writeTextFile(`${work}/main.txt`, 'main\n');
    await git(work, 'add', '-A');
    await commit(work, 'main');
    await git(work, 'merge', '-q', '--no-ff', '-m', 'merge side', 'side');
    await sync(work, opts);
    const sha = await head(work);
    const r = await files(work, sha, opts);
    // What the merge brought into main: side's file, not main's own.
    assertEquals(r.files.map((f) => f.path), ['side.txt']);
    const d = await diff(work, sha, 'side.txt', opts);
    assertEquals(d.commit.parent, await head(work, 'HEAD^1'));
  });
});

Deno.test('past the limits: truncated lists, too-large patches and text', async () => {
  await withRepo(async ({ work, opts }) => {
    await Deno.mkdir(`${work}/many`);
    for (let i = 0; i <= MAX_COMMIT_FILES; i++) {
      await Deno.writeTextFile(
        `${work}/many/${String(i).padStart(4, '0')}`,
        `${i}\n`,
      );
    }
    // Past the patch cap, with text past the text cap.
    const line = 'x'.repeat(99) + '\n';
    await Deno.writeTextFile(
      `${work}/big.txt`,
      line.repeat(Math.ceil((MAX_COMMIT_TEXT + 1) / line.length)),
    );
    await git(work, 'add', '-A');
    await commit(work, 'lots');
    await sync(work, opts);
    const sha = await head(work);
    const r = await files(work, sha, opts);
    assertEquals(r.files.length, MAX_COMMIT_FILES);
    assertEquals(r.truncated, true);
    // A file past the listed ones still opens: the diff lists the whole commit itself.
    const last = await diff(work, sha, `many/${MAX_COMMIT_FILES}`, opts);
    assertEquals(last.file.patch, `@@ -0,0 +1 @@\n+${MAX_COMMIT_FILES}\n`);
    const big = await diff(work, sha, 'big.txt', opts);
    assert(MAX_COMMIT_TEXT > MAX_COMMIT_PATCH);
    assertEquals([big.file.patch, big.file.tooLarge], [null, true]);
    assertEquals(await readCommitFileAt(work, sha, 'big.txt', opts), {
      available: false,
      message: 'file too large',
    });
  });
});

Deno.test('a missing commit, a path it did not change, and a non-commit id are problems', async () => {
  await withRepo(async ({ work, opts }) => {
    await sync(work, opts);
    const sha = await head(work);
    const missing = { problem: 'this commit is no longer available' };
    assertEquals(await readCommitFiles(work, 'a'.repeat(40), opts), missing);
    assertEquals(
      await readCommitDiff(work, 'a'.repeat(40), 'a.txt', opts),
      missing,
    );
    assertEquals(
      await readCommitFileAt(work, 'a'.repeat(40), 'a.txt', opts),
      missing,
    );
    // A tree's id is not a commit.
    assertEquals(
      await readCommitFiles(work, await head(work, 'HEAD^{tree}'), opts),
      missing,
    );
    assertEquals(await readCommitFiles(work, 'HEAD', opts), missing);
    assertEquals(await readCommitDiff(work, sha, 'nope.txt', opts), {
      problem: 'nope.txt is not changed in this commit',
    });
    // A pathspec's magic is no magic: `*` names a file called `*`.
    assertEquals(await readCommitDiff(work, sha, '*', opts), {
      problem: '* is not changed in this commit',
    });
  });
});

Deno.test('a commit on the upstream the repo has not fetched is read from the mirror', async () => {
  const dir = await Deno.makeTempDir();
  try {
    const remote = `${dir}/remote.git`;
    const work = `${dir}/work`;
    const other = `${dir}/other`;
    const opts = { root: `${dir}/mirrors`, fetchable: () => true };
    await git(dir, 'init', '-q', '--bare', '-b', 'main', remote);
    await git(dir, 'clone', '-q', remote, work);
    await commit(work, 'one');
    await git(work, 'push', '-q', '-u', 'origin', 'main');
    await git(dir, 'clone', '-q', remote, other);
    await Deno.writeTextFile(`${other}/theirs.txt`, 'theirs\n');
    await git(other, 'add', '-A');
    await commit(other, 'theirs');
    await git(other, 'push', '-q');
    const sha = await head(other);
    assertEquals(await fetchUpstream(work, opts), true);
    // Not in the repo itself.
    await assertRejects(() => git(work, 'cat-file', '-e', sha));
    const r = await files(work, sha, opts);
    assertEquals(r.files.map((f) => f.path), ['theirs.txt']);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

async function assertRejects(f: () => Promise<unknown>) {
  let threw = false;
  try {
    await f();
  } catch {
    threw = true;
  }
  assert(threw, 'expected a rejection');
}

Deno.test("commit reads never run the repo's hooks, fsmonitor or textconv", async () => {
  await withRepo(async ({ dir, work, opts }) => {
    const planted = `${dir}/planted`;
    const script = `${dir}/payload.sh`;
    await Deno.writeTextFile(script, `#!/bin/sh\ntouch ${planted}\ncat "$1"\n`);
    await Deno.chmod(script, 0o755);
    await git(work, 'config', 'core.fsmonitor', script);
    await git(work, 'config', 'core.hooksPath', dir);
    await git(work, 'config', 'diff.evil.textconv', script);
    await git(work, 'config', 'diff.evil.command', script);
    await Deno.writeTextFile(`${work}/.gitattributes`, '* diff=evil\n');
    await Deno.writeTextFile(`${work}/a.txt`, 'changed\n');
    await git(work, 'add', '-A');
    await commit(work, 'attrs');
    await sync(work, opts);
    await Deno.remove(planted).catch(() => {});
    const sha = await head(work);
    await files(work, sha, opts);
    const d: CommitDiff = await diff(work, sha, 'a.txt', opts);
    assert(d.file.patch!.includes('+changed\n'));
    await readCommitFileAt(work, sha, 'a.txt', opts);
    assertEquals(await Deno.stat(planted).then(() => true, () => false), false);
    // The control: a diff run in the repo, as the editor's would be, runs it.
    await git(work, 'diff', 'HEAD~1', '--', 'a.txt');
    assertEquals(await Deno.stat(planted).then(() => true, () => false), true);
  });
});
