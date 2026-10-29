import { assertEquals } from 'jsr:@std/assert';
import type { ContainerMount } from '@devc-tools/core/container.ts';
import type { BridgeRun, EnvExec, RunLimits } from '../web/environment.ts';
import {
  CHANGES_ARGV,
  CHANGES_MAX_OUTPUT,
  type ChangesReading,
  GitChangesWatch,
  parseChanges,
  readChanges,
} from '../web/git_changes.ts';
import { runCapped } from '../web/proc.ts';

const bytes = (s: string) => new TextEncoder().encode(s);

const HEX = '0'.repeat(40);
const entry1 = (xy: string, path: string) =>
  `1 ${xy} N... 100644 100644 100644 ${HEX} ${HEX} ${path}\0`;

Deno.test('parseChanges counts each kind of porcelain v2 line', () => {
  const out = [
    '# branch.oid ' + HEX + '\0',
    '# branch.head main\0',
    entry1('M.', 'staged.txt'),
    entry1('.M', 'unstaged.txt'),
    entry1('MM', 'both.txt'),
    // A rename: its original path follows as its own NUL-ended field, which names a `?`-looking
    // file here so a parser that read it as a line would miscount.
    `2 R. N... 100644 100644 100644 ${HEX} ${HEX} R100 new.txt\0? old.txt\0`,
    `u UU N... 100644 100644 100644 100644 ${HEX} ${HEX} ${HEX} conflict.txt\0`,
    '? untracked.txt\0',
    // `-z` keeps a newline inside a path from starting a line of its own.
    '? odd\n? name.txt\0',
    '! ignored.txt\0',
  ].join('');
  assertEquals(parseChanges(bytes(out)), {
    staged: 3,
    unstaged: 2,
    untracked: 2,
    conflicted: 1,
  });
});

Deno.test('parseChanges on empty output counts nothing', () => {
  const none = { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 };
  assertEquals(parseChanges(new Uint8Array()), none);
  assertEquals(parseChanges(bytes('# branch.head main\0')), none);
});

/** An environment whose `runLimited` answers with `answer`, recording each call. */
function fakeEnv(answer: (x: EnvExec, limits: RunLimits) => BridgeRun) {
  const calls: { x: EnvExec; limits: RunLimits }[] = [];
  return {
    calls,
    env: {
      runLimited: (x: EnvExec, limits: RunLimits) => {
        calls.push({ x, limits });
        return Promise.resolve(answer(x, limits));
      },
    },
  };
}

Deno.test('readChanges runs git status at the path and parses its output', async () => {
  const { env, calls } = fakeEnv(() => ({
    kind: 'exit',
    code: 0,
    stdout: entry1('.M', 'a.ts') + '? b.ts\0',
    stderr: '',
  }));
  assertEquals(await readChanges(env, '/workspaces/app'), {
    staged: 0,
    unstaged: 1,
    untracked: 1,
    conflicted: 0,
  });
  assertEquals(calls[0].x, { cmd: CHANGES_ARGV, cwd: '/workspaces/app' });
  assertEquals(calls[0].x.cmd, [
    'git',
    '--no-optional-locks',
    'status',
    '--porcelain=v2',
    '-z',
    '--untracked-files=normal',
  ]);
  assertEquals(calls[0].limits, {
    timeoutMs: 10_000,
    maxOutput: CHANGES_MAX_OUTPUT,
  });
});

Deno.test('readChanges gives git’s first stderr line, the cap and the timeout as problems', async () => {
  const failed = fakeEnv(() => ({
    kind: 'exit',
    code: 128,
    stdout: '',
    stderr:
      '\nfatal: not a git repository (or any of the parent directories): .git\n',
  }));
  assertEquals(await readChanges(failed.env, '/x'), {
    problem:
      'git status: fatal: not a git repository (or any of the parent directories): .git',
  });
  const large = fakeEnv(() => ({ kind: 'too_large' }));
  assertEquals(await readChanges(large.env, '/x'), {
    problem: 'too many changes to count',
  });
  const slow = fakeEnv(() => ({ kind: 'timeout' }));
  assertEquals(await readChanges(slow.env, '/x'), {
    problem: 'git status: timed out',
  });
  const thrown = {
    runLimited: () => Promise.reject(new Error('no such container')),
  };
  assertEquals(await readChanges(thrown, '/x'), {
    problem: 'git status: no such container',
  });
});

Deno.test('readChanges against a real repo, run the way a host project runs it', async () => {
  const dir = await Deno.makeTempDir();
  try {
    const git = async (...args: string[]) => {
      const out = await new Deno.Command('git', {
        args: ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args],
        cwd: dir,
        stdout: 'null',
        stderr: 'piped',
      }).output();
      if (!out.success) throw new Error(new TextDecoder().decode(out.stderr));
    };
    await git('init', '-q');
    await Deno.writeTextFile(`${dir}/a.txt`, 'a\n');
    await Deno.writeTextFile(`${dir}/b.txt`, 'b\n');
    await git('add', '.');
    await git('commit', '-q', '-m', 'init');
    await Deno.writeTextFile(`${dir}/a.txt`, 'changed\n');
    await Deno.writeTextFile(`${dir}/b.txt`, 'staged\n');
    await git('add', 'b.txt');
    await Deno.writeTextFile(`${dir}/new\nline.txt`, 'x\n');
    const env = {
      runLimited: (x: EnvExec, limits: RunLimits) =>
        runCapped(x.cmd[0], x.cmd.slice(1), limits, { cwd: x.cwd }),
    };
    assertEquals(await readChanges(env, dir), {
      staged: 1,
      unstaged: 1,
      untracked: 1,
      conflicted: 0,
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

const identity: ContainerMount[] = [
  { type: 'bind', source: '/', destination: '/', rw: true },
];

Deno.test('GitChangesWatch reads each running environment’s repos at their path there', async () => {
  const mounts: ContainerMount[] = [
    {
      type: 'bind',
      source: '/host/app',
      destination: '/workspaces/app',
      rw: true,
    },
  ];
  const env = (id: string, m: ContainerMount[]) => ({
    id,
    mounts: () => Promise.resolve(m),
    runLimited: () => Promise.reject(new Error('unused')),
  });
  const reads: string[] = [];
  let changes = 0;
  const watch = new GitChangesWatch({
    targets: () => [
      // `/elsewhere` is in no mount: it gets no reading.
      { env: env('c1', mounts), folders: ['/host/app', '/elsewhere'] },
      { env: env('host-1', identity), folders: ['/home/me/proj'] },
    ],
    onChange: () => changes++,
    read: (e, path) => {
      reads.push(`${e.id}:${path}`);
      return Promise.resolve({
        staged: 0,
        unstaged: 1,
        untracked: 0,
        conflicted: 0,
      });
    },
  });
  await watch.refresh();
  assertEquals(reads.sort(), ['c1:/workspaces/app', 'host-1:/home/me/proj']);
  assertEquals(changes, 2);
  assertEquals([...watch.readings.get('c1')!.keys()], ['/host/app']);
  // The same readings again change nothing.
  await watch.refresh();
  assertEquals(changes, 2);
});

Deno.test('GitChangesWatch runs one pass per environment at a time, and drops a stopped one', async () => {
  let running = true;
  let inFlight = 0;
  let most = 0;
  let passes = 0;
  const release: (() => void)[] = [];
  const watch = new GitChangesWatch({
    targets: () =>
      running
        ? [{
          env: {
            id: 'c1',
            mounts: () => Promise.resolve(identity),
            runLimited: () => Promise.reject(new Error('unused')),
          },
          folders: ['/a'],
        }]
        : [],
    onChange: () => {},
    read: async (): Promise<ChangesReading> => {
      inFlight++;
      most = Math.max(most, inFlight);
      passes++;
      await new Promise<void>((r) => release.push(r));
      inFlight--;
      return { staged: passes, unstaged: 0, untracked: 0, conflicted: 0 };
    },
  });
  const first = watch.refreshEnvironment('c1');
  await new Promise((r) => setTimeout(r, 0));
  // An agent went idle twice during the pass: one more pass follows, not two at once.
  void watch.refreshEnvironment('c1');
  void watch.refreshEnvironment('c1');
  release.shift()!();
  await new Promise((r) => setTimeout(r, 0));
  assertEquals(passes, 2);
  assertEquals(most, 1);
  // It stops while git runs: the reading is not kept.
  running = false;
  release.shift()!();
  await first;
  assertEquals(watch.readings.has('c1'), false);
});
