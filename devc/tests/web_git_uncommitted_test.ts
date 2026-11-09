import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert';
import { runCapped } from '../web/proc.ts';
import type { EnvExec, RunLimits } from '../web/environment.ts';
import { hostFiles } from '../web/env_host.ts';
import {
  readUncommittedDiff,
  readUncommittedFileAt,
  readUncommittedFiles,
  type UncommittedEnv,
} from '../web/git_uncommitted.ts';
import { isGitProblem } from '../web/git_status.ts';

async function git(cwd: string, ...args: string[]): Promise<string> {
  const out = await new Deno.Command('git', {
    args: ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args],
    cwd,
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  if (!out.success) {
    throw new Error(new TextDecoder().decode(out.stderr));
  }
  return new TextDecoder().decode(out.stdout).trim();
}

/** An environment that runs commands and reads files here, as a host project's does. */
const hereEnv: UncommittedEnv = {
  runLimited: (x: EnvExec, limits: RunLimits) =>
    runCapped(x.cmd[0], x.cmd.slice(1), limits, { cwd: x.cwd, env: x.env }),
  files: hostFiles(),
};

async function withRepo(fn: (dir: string) => Promise<void>) {
  const dir = await Deno.makeTempDir();
  try {
    await git(dir, 'init', '-q', '-b', 'main');
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const write = (dir: string, path: string, text: string) =>
  Deno.writeTextFile(`${dir}/${path}`, text);

/** A repo with a modified, a removed, a renamed, a staged new and an untracked file. */
async function mixed(dir: string) {
  await write(dir, 'mod.txt', 'one\ntwo\n');
  await write(dir, 'gone.txt', 'bye\n');
  await write(dir, 'old name.txt', 'a\nb\nc\nd\ne\nf\n');
  await git(dir, 'add', '.');
  await git(dir, 'commit', '-q', '-m', 'one');
  await write(dir, 'mod.txt', 'one\nTWO\nthree\n');
  await Deno.remove(`${dir}/gone.txt`);
  await git(dir, 'mv', 'old name.txt', 'new é.txt');
  await write(dir, 'new é.txt', 'a\nb\nc\nd\ne\nF\n');
  await write(dir, 'staged*.txt', 'staged\n');
  await git(dir, 'add', 'staged*.txt');
  await Deno.mkdir(`${dir}/fresh`);
  await write(dir, 'fresh/u.txt', 'x\ny\n');
}

Deno.test('readUncommittedFiles lists each kind of change', async () => {
  await withRepo(async (dir) => {
    await mixed(dir);
    const r = await readUncommittedFiles(hereEnv, dir);
    assert(!isGitProblem(r), JSON.stringify(r));
    assertEquals(r.base, await git(dir, 'rev-parse', 'HEAD'));
    assertEquals(r.truncated, false);
    const rows = (fs: typeof r.staged) =>
      fs.map((f) => [f.path, f.status, f.additions, f.deletions]);
    // The rename is staged as `git mv` made it; its edit after is not.
    assertEquals(rows(r.staged), [
      ['new é.txt', 'renamed', 0, 0],
      ['staged*.txt', 'added', 1, 0],
    ]);
    assertEquals(rows(r.unstaged), [
      ['fresh/u.txt', 'added', 0, 0],
      ['gone.txt', 'removed', 0, 1],
      ['mod.txt', 'modified', 2, 1],
      ['new é.txt', 'modified', 1, 1],
    ]);
    assertEquals(r.unstaged[0].untracked, true);
    assertEquals(r.staged[0].previousPath, 'old name.txt');
    assertEquals(r.staged[1].untracked, undefined);
  });
});

Deno.test('readUncommittedFiles marks a merge conflict', async () => {
  await withRepo(async (dir) => {
    await write(dir, 'a', '1\n');
    await git(dir, 'add', '.');
    await git(dir, 'commit', '-q', '-m', '1');
    await git(dir, 'checkout', '-q', '-b', 'o');
    await write(dir, 'a', '2\n');
    await git(dir, 'commit', '-q', '-am', '2');
    await git(dir, 'checkout', '-q', 'main');
    await write(dir, 'a', '3\n');
    await git(dir, 'commit', '-q', '-am', '3');
    await git(dir, 'merge', 'o').catch(() => {});
    const r = await readUncommittedFiles(hereEnv, dir);
    assert(!isGitProblem(r), JSON.stringify(r));
    assertEquals(r.staged, []);
    assertEquals(r.unstaged.map((f) => [f.path, f.status, f.additions]), [[
      'a',
      'conflicted',
      4,
    ]]);
    const d = await readUncommittedDiff(hereEnv, dir, 'a');
    assert(!isGitProblem(d), JSON.stringify(d));
    assertStringIncludes(d.file.patch ?? '', '+<<<<<<< HEAD');
  });
});

Deno.test('an unborn branch compares with the empty tree', async () => {
  await withRepo(async (dir) => {
    await write(dir, 'first.txt', 'hi\n');
    await git(dir, 'add', '.');
    const r = await readUncommittedFiles(hereEnv, dir);
    assert(!isGitProblem(r), JSON.stringify(r));
    assertEquals(r.base, null);
    assertEquals(r.staged.map((f) => [f.path, f.status]), [[
      'first.txt',
      'added',
    ]]);
    assertEquals(r.unstaged, []);
    const d = await readUncommittedDiff(hereEnv, dir, 'first.txt');
    assert(!isGitProblem(d), JSON.stringify(d));
    assertEquals(d.changes.base, null);
    assertEquals(d.file.patch, '@@ -0,0 +1 @@\n+hi\n');
  });
});

Deno.test('readUncommittedDiff gives each kind its patch', async () => {
  await withRepo(async (dir) => {
    await mixed(dir);
    const patch = async (path: string) => {
      const d = await readUncommittedDiff(hereEnv, dir, path);
      assert(!isGitProblem(d), `${path}: ${JSON.stringify(d)}`);
      assertEquals(d.available, true);
      assertEquals(d.file.path, path);
      return d.file.patch;
    };
    assertEquals(
      await patch('mod.txt'),
      '@@ -1,2 +1,3 @@\n one\n-two\n+TWO\n+three\n',
    );
    assertEquals(await patch('gone.txt'), '@@ -1 +0,0 @@\n-bye\n');
    assertEquals(await patch('staged*.txt'), '@@ -0,0 +1 @@\n+staged\n');
    assertEquals(await patch('fresh/u.txt'), '@@ -0,0 +1,2 @@\n+x\n+y\n');
    // Only the changed line, not the whole file as removed and added.
    assertEquals(
      await patch('new é.txt'),
      '@@ -3,4 +3,4 @@ b\n c\n d\n e\n-f\n+F\n',
    );
  });
});

Deno.test('a pure rename gives an empty patch', async () => {
  await withRepo(async (dir) => {
    await write(dir, 'a.txt', 'same\n');
    await git(dir, 'add', '.');
    await git(dir, 'commit', '-q', '-m', '1');
    await git(dir, 'mv', 'a.txt', 'b.txt');
    const d = await readUncommittedDiff(hereEnv, dir, 'b.txt');
    assert(!isGitProblem(d), JSON.stringify(d));
    assertEquals(d.file.status, 'renamed');
    assertEquals(d.file.patch, '');
  });
});

Deno.test('a path not in the listing is refused', async () => {
  await withRepo(async (dir) => {
    await mixed(dir);
    const d = await readUncommittedDiff(hereEnv, dir, '*');
    assertEquals(d, { problem: '* has no uncommitted changes' });
    const f = await readUncommittedFileAt(hereEnv, dir, '../etc/passwd');
    assertEquals(f, { problem: '../etc/passwd has no uncommitted changes' });
  });
});

Deno.test('readUncommittedFileAt reads the working tree', async () => {
  await withRepo(async (dir) => {
    await mixed(dir);
    await write(dir, 'bin.dat', 'a\0b');
    assertEquals(await readUncommittedFileAt(hereEnv, dir, 'mod.txt'), {
      available: true,
      text: 'one\nTWO\nthree\n',
    });
    assertEquals(await readUncommittedFileAt(hereEnv, dir, 'new é.txt'), {
      available: true,
      text: 'a\nb\nc\nd\ne\nF\n',
    });
    assertEquals(await readUncommittedFileAt(hereEnv, dir, 'gone.txt'), {
      available: false,
      message: 'file not in the working tree',
    });
    assertEquals(await readUncommittedFileAt(hereEnv, dir, 'bin.dat'), {
      available: false,
      message: 'binary file',
    });
    const d = await readUncommittedDiff(hereEnv, dir, 'bin.dat');
    assert(!isGitProblem(d), JSON.stringify(d));
    assertEquals(d.file.binary, true);
    assertEquals(d.file.patch, null);
  });
});

Deno.test('a folder that is no repo is a problem', async () => {
  const dir = await Deno.makeTempDir();
  try {
    const r = await readUncommittedFiles(hereEnv, dir);
    assert(isGitProblem(r));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('a file staged then edited is in both lists, each with its own diff', async () => {
  await withRepo(async (dir) => {
    await write(dir, 'f.txt', 'a\nb\n');
    await git(dir, 'add', '.');
    await git(dir, 'commit', '-q', '-m', '1');
    await write(dir, 'f.txt', 'a\nB\n');
    await git(dir, 'add', 'f.txt');
    await write(dir, 'f.txt', 'a\nB\nc\n');
    const r = await readUncommittedFiles(hereEnv, dir);
    assert(!isGitProblem(r), JSON.stringify(r));
    assertEquals(r.staged.map((f) => [f.path, f.additions, f.deletions]), [[
      'f.txt',
      1,
      1,
    ]]);
    assertEquals(r.unstaged.map((f) => [f.path, f.additions, f.deletions]), [[
      'f.txt',
      1,
      0,
    ]]);
    const staged = await readUncommittedDiff(hereEnv, dir, 'f.txt', 'staged');
    assert(!isGitProblem(staged), JSON.stringify(staged));
    assertEquals(staged.changes.stage, 'staged');
    assertEquals(staged.file.patch, '@@ -1,2 +1,2 @@\n a\n-b\n+B\n');
    const unstaged = await readUncommittedDiff(
      hereEnv,
      dir,
      'f.txt',
      'unstaged',
    );
    assert(!isGitProblem(unstaged), JSON.stringify(unstaged));
    assertEquals(unstaged.file.patch, '@@ -1,2 +1,3 @@\n a\n B\n+c\n');
    // No stage: the working tree against HEAD, as before.
    const whole = await readUncommittedDiff(hereEnv, dir, 'f.txt');
    assert(!isGitProblem(whole), JSON.stringify(whole));
    assertEquals(whole.changes, { base: r.base });
    assertEquals(whole.file.patch, '@@ -1,2 +1,3 @@\n a\n-b\n+B\n+c\n');
    const index = await readUncommittedFileAt(hereEnv, dir, 'f.txt', 'staged');
    assertEquals(index, { available: true, text: 'a\nB\n' });
    const tree = await readUncommittedFileAt(hereEnv, dir, 'f.txt', 'unstaged');
    assertEquals(tree, { available: true, text: 'a\nB\nc\n' });
  });
});

Deno.test('a staged removal has no index text; a wrong stage is refused', async () => {
  await withRepo(async (dir) => {
    await write(dir, 'gone.txt', 'x\n');
    await write(dir, 'u.txt', 'u\n');
    await git(dir, 'add', 'gone.txt');
    await git(dir, 'commit', '-q', '-m', '1');
    await git(dir, 'rm', '-q', 'gone.txt');
    assertEquals(
      await readUncommittedFileAt(hereEnv, dir, 'gone.txt', 'staged'),
      { available: false, message: 'file not in the index' },
    );
    assertEquals(
      await readUncommittedDiff(hereEnv, dir, 'gone.txt', 'unstaged'),
      { problem: 'gone.txt has no unstaged changes' },
    );
    assertEquals(
      await readUncommittedDiff(hereEnv, dir, 'u.txt', 'staged'),
      { problem: 'u.txt has no staged changes' },
    );
    const u = await readUncommittedDiff(hereEnv, dir, 'u.txt', 'unstaged');
    assert(!isGitProblem(u), JSON.stringify(u));
    assertEquals(u.file.patch, '@@ -0,0 +1 @@\n+u\n');
  });
});

Deno.test('a conflicted file diffs against HEAD under unstaged', async () => {
  await withRepo(async (dir) => {
    await write(dir, 'a', '1\n');
    await git(dir, 'add', '.');
    await git(dir, 'commit', '-q', '-m', '1');
    await git(dir, 'checkout', '-q', '-b', 'o');
    await write(dir, 'a', '2\n');
    await git(dir, 'commit', '-q', '-am', '2');
    await git(dir, 'checkout', '-q', 'main');
    await write(dir, 'a', '3\n');
    await git(dir, 'commit', '-q', '-am', '3');
    await git(dir, 'merge', 'o').catch(() => {});
    const d = await readUncommittedDiff(hereEnv, dir, 'a', 'unstaged');
    assert(!isGitProblem(d), JSON.stringify(d));
    assertEquals(d.file.status, 'conflicted');
    assertStringIncludes(d.file.patch ?? '', '+<<<<<<< HEAD');
  });
});
