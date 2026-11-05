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
    assertEquals(
      r.files.map((f) => [f.path, f.status, f.additions, f.deletions]),
      [
        ['fresh/u.txt', 'added', 0, 0],
        ['gone.txt', 'removed', 0, 1],
        ['mod.txt', 'modified', 2, 1],
        ['new é.txt', 'renamed', 1, 1],
        ['staged*.txt', 'added', 1, 0],
      ],
    );
    assertEquals(r.files[0].untracked, true);
    assertEquals(r.files[3].previousPath, 'old name.txt');
    assertEquals(r.files[4].untracked, undefined);
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
    assertEquals(r.files.map((f) => [f.path, f.status]), [['a', 'conflicted']]);
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
    assertEquals(r.files.map((f) => [f.path, f.status]), [[
      'first.txt',
      'added',
    ]]);
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
