import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert';
import { runCapped } from '../web/proc.ts';
import type { EnvExec, RunLimits } from '../web/environment.ts';
import { hostFiles } from '../web/env_host.ts';
import {
  readUncommittedFiles,
  type UncommittedEnv,
} from '../web/git_uncommitted.ts';
import {
  claimRepo,
  commitProblem,
  commitStaged,
  stageFiles,
  unstageFiles,
} from '../web/git_stage.ts';
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

/** Runs commands here, as a host project's environment does. */
const hereEnv: UncommittedEnv = {
  runLimited: (x: EnvExec, limits: RunLimits) =>
    runCapped(x.cmd[0], x.cmd.slice(1), limits, { cwd: x.cwd, env: x.env }),
  files: hostFiles(),
};

async function withRepo(fn: (dir: string) => Promise<void>) {
  const dir = await Deno.makeTempDir();
  try {
    await git(dir, 'init', '-q', '-b', 'main');
    // The repo's own identity: `commitStaged` runs plain `git commit`.
    await git(dir, 'config', 'user.name', 't');
    await git(dir, 'config', 'user.email', 't@t');
    await git(dir, 'config', 'commit.gpgsign', 'false');
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const write = (dir: string, path: string, text: string) =>
  Deno.writeTextFile(`${dir}/${path}`, text);

async function lists(dir: string) {
  const r = await readUncommittedFiles(hereEnv, dir);
  assert(!isGitProblem(r), JSON.stringify(r));
  return {
    staged: r.staged.map((f) => `${f.status} ${f.path}`),
    unstaged: r.unstaged.map((f) => `${f.status} ${f.path}`),
  };
}

async function base(dir: string) {
  for (const f of ['mod.txt', 'gone.txt', 'old.txt']) {
    await write(dir, f, `${f}\n`);
  }
  await git(dir, 'add', '.');
  await git(dir, 'commit', '-q', '-m', 'one');
}

Deno.test('stageFiles stages each kind of change, and everything with null', async () => {
  await withRepo(async (dir) => {
    await base(dir);
    await write(dir, 'mod.txt', 'changed\n');
    await Deno.remove(`${dir}/gone.txt`);
    await write(dir, 'new é.txt', 'n\n');
    await write(dir, 'other.txt', 'o\n');
    assertEquals(
      await stageFiles(hereEnv, dir, ['mod.txt', 'gone.txt', 'new é.txt']),
      {},
    );
    assertEquals(await lists(dir), {
      staged: ['removed gone.txt', 'modified mod.txt', 'added new é.txt'],
      unstaged: ['added other.txt'],
    });
    assertEquals(await stageFiles(hereEnv, dir, null), {});
    assertEquals((await lists(dir)).unstaged, []);
  });
});

Deno.test('stageFiles marks a conflict resolved', async () => {
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
    assertEquals((await lists(dir)).unstaged, ['conflicted a']);
    await write(dir, 'a', '23\n');
    assertEquals(await stageFiles(hereEnv, dir, ['a']), {});
    assertEquals(await lists(dir), { staged: ['modified a'], unstaged: [] });
  });
});

Deno.test('unstageFiles undoes a new file, a rename, and everything', async () => {
  await withRepo(async (dir) => {
    await base(dir);
    await write(dir, 'new.txt', 'n\n');
    await git(dir, 'add', 'new.txt');
    await git(dir, 'mv', 'old.txt', 'moved.txt');
    await write(dir, 'mod.txt', 'changed\n');
    await git(dir, 'add', 'mod.txt');
    assertEquals(await unstageFiles(hereEnv, dir, ['new.txt']), {});
    assertEquals((await lists(dir)).unstaged, ['added new.txt']);
    assertEquals(await unstageFiles(hereEnv, dir, ['moved.txt']), {});
    assertEquals(await lists(dir), {
      staged: ['modified mod.txt'],
      unstaged: ['added moved.txt', 'added new.txt', 'removed old.txt'],
    });
    assertEquals(await unstageFiles(hereEnv, dir, null), {});
    assertEquals((await lists(dir)).staged, []);
  });
});

Deno.test('stage and unstage work on an unborn branch', async () => {
  await withRepo(async (dir) => {
    await write(dir, 'first.txt', 'hi\n');
    assertEquals(await stageFiles(hereEnv, dir, ['first.txt']), {});
    assertEquals((await lists(dir)).staged, ['added first.txt']);
    assertEquals(await unstageFiles(hereEnv, dir, ['first.txt']), {});
    assertEquals(await lists(dir), {
      staged: [],
      unstaged: ['added first.txt'],
    });
    await stageFiles(hereEnv, dir, null);
    assertEquals(await unstageFiles(hereEnv, dir, null), {});
    assertEquals((await lists(dir)).staged, []);
  });
});

Deno.test('a path not in the matching list is refused and nothing changes', async () => {
  await withRepo(async (dir) => {
    await base(dir);
    await write(dir, 'mod.txt', 'changed\n');
    await write(dir, 'u.txt', 'u\n');
    assertEquals(await stageFiles(hereEnv, dir, ['u.txt', 'nope.txt']), {
      problem: 'nope.txt has no unstaged changes',
    });
    assertEquals(await unstageFiles(hereEnv, dir, ['mod.txt']), {
      problem: 'mod.txt has no staged changes',
    });
    assertEquals(await lists(dir), {
      staged: [],
      unstaged: ['modified mod.txt', 'added u.txt'],
    });
  });
});

Deno.test('commitStaged commits only what is staged', async () => {
  await withRepo(async (dir) => {
    await base(dir);
    assertEquals(await commitStaged(hereEnv, dir, 'nothing'), {
      problem: 'nothing staged to commit',
    });
    await write(dir, 'mod.txt', 'changed\n');
    await write(dir, 'gone.txt', 'edited, not staged\n');
    await git(dir, 'add', 'mod.txt');
    const r = await commitStaged(hereEnv, dir, '  Change mod\n\nWhy.\n');
    assert(!isGitProblem(r), JSON.stringify(r));
    assertEquals(r.sha, await git(dir, 'rev-parse', 'HEAD'));
    assertEquals(r.subject, 'Change mod');
    assertEquals(
      await git(dir, 'log', '-1', '--format=%B'),
      'Change mod\n\nWhy.',
    );
    assertEquals(await lists(dir), {
      staged: [],
      unstaged: ['modified gone.txt'],
    });
  });
});

Deno.test('a failing pre-commit hook is the problem, and nothing is committed', async () => {
  await withRepo(async (dir) => {
    await base(dir);
    const head = await git(dir, 'rev-parse', 'HEAD');
    const hook = `${dir}/.git/hooks/pre-commit`;
    await Deno.writeTextFile(
      hook,
      '#!/bin/sh\necho checking\necho "lint failed" >&2\nexit 1\n',
    );
    await Deno.chmod(hook, 0o755);
    await write(dir, 'mod.txt', 'changed\n');
    await git(dir, 'add', 'mod.txt');
    const r = await commitStaged(hereEnv, dir, 'msg');
    assert(isGitProblem(r), JSON.stringify(r));
    assertStringIncludes(r.problem, 'lint failed');
    assertStringIncludes(r.problem, 'checking');
    assertEquals(await git(dir, 'rev-parse', 'HEAD'), head);
  });
});

Deno.test('commitProblem keeps the last lines', () => {
  const many = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
  const p = commitProblem(many, '');
  assert(p.startsWith('git commit: line 10\n'), p);
  assert(p.endsWith('line 29'), p);
  assertEquals(commitProblem('', ''), 'git commit: failed');
});

Deno.test('claimRepo lets one operation run per repo', () => {
  const running = new Set<string>();
  const release = claimRepo(running, '/r');
  assert(release);
  assertEquals(claimRepo(running, '/r'), null);
  assert(claimRepo(running, '/other'));
  release();
  assert(claimRepo(running, '/r'));
});
