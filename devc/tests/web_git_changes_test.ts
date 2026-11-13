import { assertEquals } from 'jsr:@std/assert';
import type { ContainerMount } from '@devc-tools/core/container.ts';
import type { BridgeRun, EnvExec, RunLimits } from '../web/environment.ts';
import {
  CHANGES_ARGV,
  CHANGES_MAX_OUTPUT,
  type ChangesClock,
  type ChangesReading,
  type ChangesTarget,
  type ChangesWatcher,
  GitChangesWatch,
  parseChanges,
  readChanges,
  reposForEvent,
  type TimerHandle,
  type WatchedFolder,
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
    '-c',
    'core.checkStat=minimal',
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

Deno.test('readChanges in a container runs git under timeout, with the host as backstop', async () => {
  const { env, calls } = fakeEnv(() => ({
    kind: 'exit',
    code: 0,
    stdout: '',
    stderr: '',
  }));
  await readChanges({ ...env, kind: 'container' }, '/workspaces/app');
  assertEquals(calls[0].x.cmd.slice(0, 9), [
    'timeout',
    '-k',
    '2',
    '10',
    'git',
    '-c',
    'core.checkStat=minimal',
    '--no-optional-locks',
    'status',
  ]);
  assertEquals(calls[0].x.cmd.slice(4), CHANGES_ARGV);
  assertEquals(calls[0].limits, {
    timeoutMs: 13_000,
    maxOutput: CHANGES_MAX_OUTPUT,
  });
  await readChanges({ ...env, kind: 'host' }, '/home/me/app');
  assertEquals(calls[1].x.cmd, CHANGES_ARGV);
  assertEquals(calls[1].limits.timeoutMs, 10_000);
});

Deno.test('readChanges in a container maps timeout’s exits to problems', async () => {
  const exit = (code: number, stderr = '') => ({
    kind: 'container' as const,
    ...fakeEnv(() => ({ kind: 'exit', code, stdout: '', stderr })).env,
  });
  const timedOut = { problem: 'git status: timed out' };
  assertEquals(await readChanges(exit(124), '/x'), timedOut);
  assertEquals(await readChanges(exit(137), '/x'), timedOut);
  assertEquals(
    await readChanges(
      { kind: 'container', ...fakeEnv(() => ({ kind: 'timeout' })).env },
      '/x',
    ),
    timedOut,
  );
  assertEquals(
    await readChanges(exit(127, 'sh: 1: timeout: not found\n'), '/x'),
    { problem: 'git status: no timeout command in the environment' },
  );
});

/** Lets every pending promise chain settle. */
async function flush() {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
}

/** A clock whose timers fire only on {@link advance}. */
class FakeClock implements ChangesClock {
  t = 0;
  #next = 1;
  #timers = new Map<number, { at: number; fn: () => void; every?: number }>();
  now() {
    return this.t;
  }
  setTimeout(fn: () => void, ms: number): TimerHandle {
    const id = this.#next++;
    this.#timers.set(id, { at: this.t + ms, fn });
    return id as unknown as TimerHandle;
  }
  clearTimeout(h: TimerHandle) {
    this.#timers.delete(h as unknown as number);
  }
  setInterval(fn: () => void, ms: number): TimerHandle {
    const id = this.#next++;
    this.#timers.set(id, { at: this.t + ms, fn, every: ms });
    return id as unknown as TimerHandle;
  }
  clearInterval(h: TimerHandle) {
    this.clearTimeout(h);
  }
  /** Moves time to `t`, firing every timer due on the way, in order. */
  async advanceTo(end: number) {
    for (;;) {
      await flush();
      let first:
        | [number, { at: number; fn: () => void; every?: number }]
        | undefined;
      for (const e of this.#timers) {
        if (e[1].at <= end && (!first || e[1].at < first[1].at)) first = e;
      }
      if (!first) break;
      const [id, timer] = first;
      this.t = Math.max(this.t, timer.at);
      if (timer.every) timer.at += timer.every;
      else this.#timers.delete(id);
      timer.fn();
    }
    this.t = Math.max(this.t, end);
    await flush();
  }
}

/** A watcher whose events a test sends. */
function fakeWatcher() {
  const queue: { paths: string[] }[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  const watcher: ChangesWatcher = {
    close() {
      closed = true;
      wake?.();
    },
    async *[Symbol.asyncIterator]() {
      while (!closed) {
        if (queue.length) yield queue.shift()!;
        else await new Promise<void>((r) => (wake = r));
      }
    },
  };
  return {
    watcher,
    send(...paths: string[]) {
      queue.push({ paths });
      wake?.();
    },
  };
}

const identity: ContainerMount[] = [
  { type: 'bind', source: '/', destination: '/', rw: true },
];
const unchanged = { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 };
const asIs = (folder: string): Promise<WatchedFolder> =>
  Promise.resolve({ folder, real: folder, linked: false });
const target = (id: string, folders: string[]): ChangesTarget => ({
  env: {
    id,
    mounts: () => Promise.resolve(identity),
    runLimited: () => Promise.reject(new Error('unused')),
  },
  folders,
});

/** A started watch over `targets` on a fake clock, recording each read as `[time, id:path]`. */
function harness(
  targets: ChangesTarget[],
  opts: {
    read?: (id: string, path: string) => Promise<ChangesReading>;
    connected?: () => boolean;
    visible?: (folder: string) => boolean;
    watch?: (paths: string[]) => ChangesWatcher;
    log?: (m: string) => void;
  } = {},
) {
  const clock = new FakeClock();
  const reads: [number, string][] = [];
  const w = fakeWatcher();
  const watch = new GitChangesWatch({
    targets: () => targets,
    onChange: () => {},
    read: (e, path) => {
      reads.push([clock.t, `${e.id}:${path}`]);
      return opts.read?.(e.id, path) ?? Promise.resolve(unchanged);
    },
    clientsConnected: opts.connected,
    visible: opts.visible,
    watch: opts.watch ?? (() => w.watcher),
    resolveFolder: asIs,
    clock,
    log: opts.log ?? (() => {}),
  });
  watch.start();
  return { clock, reads, watch, send: w.send };
}

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
  const clock = new FakeClock();
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
      return Promise.resolve({ ...unchanged, unstaged: 1 });
    },
    watch: () => fakeWatcher().watcher,
    resolveFolder: asIs,
    clock,
  });
  const done = watch.refresh();
  await clock.advanceTo(2_000);
  await done;
  assertEquals(reads.sort(), ['c1:/workspaces/app', 'host-1:/home/me/proj']);
  assertEquals(changes, 2);
  assertEquals([...watch.readings.get('c1')!.keys()], ['/host/app']);
  // The same readings again change nothing.
  const again = watch.refresh();
  await clock.advanceTo(20_000);
  await again;
  assertEquals(reads.length, 4);
  assertEquals(changes, 2);
  watch.stop();
});

Deno.test('GitChangesWatch with no marks reads only at the start and at each sweep', async () => {
  const h = harness([target('c1', ['/a', '/b'])]);
  await h.clock.advanceTo(10 * 60_000 + 3_000);
  assertEquals(h.reads, [
    [2_000, 'c1:/a'],
    [2_000, 'c1:/b'],
    [302_000, 'c1:/a'],
    [302_000, 'c1:/b'],
    [602_000, 'c1:/a'],
    [602_000, 'c1:/b'],
  ]);
  h.watch.stop();
});

Deno.test('GitChangesWatch reads once, 2 s after the last of two marks', async () => {
  const h = harness([target('c1', ['/a'])]);
  await h.clock.advanceTo(30_000);
  h.send('/a/src/x.ts');
  await h.clock.advanceTo(31_000);
  h.send('/a/src/y.ts');
  await h.clock.advanceTo(60_000);
  assertEquals(h.reads, [[2_000, 'c1:/a'], [33_000, 'c1:/a']]);
  h.watch.stop();
});

Deno.test('GitChangesWatch waits five times a slow read before the next', async () => {
  let first = true;
  const h = harness([target('c1', ['/a'])], {
    read: () => {
      if (first) h.clock.t += 10_000;
      first = false;
      return Promise.resolve(unchanged);
    },
  });
  await h.clock.advanceTo(13_000);
  h.send('/a/x');
  await h.clock.advanceTo(61_999);
  assertEquals(h.reads.length, 1);
  await h.clock.advanceTo(70_000);
  // The read took 2 s → 12 s: the next is 50 s after it ended.
  assertEquals(h.reads, [[2_000, 'c1:/a'], [62_000, 'c1:/a']]);
  h.watch.stop();
});

Deno.test('GitChangesWatch waits 65 s after a timed-out read', async () => {
  const h = harness([target('c1', ['/a'])], {
    read: () => Promise.resolve({ problem: 'git status: timed out' }),
  });
  await h.clock.advanceTo(3_000);
  h.send('/a/x');
  await h.clock.advanceTo(66_999);
  assertEquals(h.reads.length, 1);
  await h.clock.advanceTo(80_000);
  assertEquals(h.reads, [[2_000, 'c1:/a'], [67_000, 'c1:/a']]);
  h.watch.stop();
});

Deno.test('GitChangesWatch refreshFolder reads that repo at once, and no other', async () => {
  const h = harness([target('c1', ['/a', '/b'])]);
  await h.clock.advanceTo(5_000);
  h.send('/b/x');
  const done = h.watch.refreshFolder('c1', '/a');
  await h.clock.advanceTo(5_000);
  await done;
  assertEquals(h.reads.slice(2), [[5_000, 'c1:/a']]);
  h.watch.stop();
});

Deno.test('GitChangesWatch reads nothing with no client, and catches up when one connects', async () => {
  let connected = false;
  const h = harness([target('c1', ['/a', '/b'])], {
    connected: () => connected,
  });
  await h.clock.advanceTo(20_000);
  h.send('/a/x');
  await h.watch.refreshEnvironment('c1');
  await h.clock.advanceTo(400_000);
  assertEquals(h.reads, []);
  connected = true;
  h.watch.clientConnected();
  await h.clock.advanceTo(400_000);
  assertEquals(h.reads, [[400_000, 'c1:/a'], [400_000, 'c1:/b']]);
  await h.clock.advanceTo(500_000);
  assertEquals(h.reads.length, 2);
  h.watch.stop();
});

Deno.test('GitChangesWatch leaves a repo no page shows dirty until it is revealed, or devc acts in it', async () => {
  const shown = new Set(['/a']);
  const h = harness([target('c1', ['/a', '/b'])], {
    visible: (f) => shown.has(f),
  });
  await h.clock.advanceTo(20_000);
  h.send('/a/x', '/b/x');
  // An agent's turn ending waits only for the shown repo.
  const turn = h.watch.refreshEnvironment('c1');
  await h.clock.advanceTo(30_000);
  await turn;
  await h.clock.advanceTo(400_000);
  // The sweep at 300 s reads /a again, never /b.
  assertEquals(h.reads, [
    [2_000, 'c1:/a'],
    [22_000, 'c1:/a'],
    [302_000, 'c1:/a'],
  ]);
  // Shown: read at once, gaps skipped.
  shown.add('/b');
  h.watch.reveal(['/b']);
  await h.clock.advanceTo(400_000);
  assertEquals(h.reads.slice(3), [[400_000, 'c1:/b']]);
  // Hidden again: devc's own commit there is still read.
  shown.delete('/b');
  const done = h.watch.refreshFolder('c1', '/b');
  await h.clock.advanceTo(400_000);
  await done;
  assertEquals(h.reads.slice(4), [[400_000, 'c1:/b']]);
  // Revealing a clean repo reads nothing.
  shown.add('/b');
  h.watch.reveal(['/b']);
  await h.clock.advanceTo(410_000);
  assertEquals(h.reads.length, 5);
  h.watch.stop();
});

Deno.test('GitChangesWatch runs one read per environment at a time, environments side by side', async () => {
  const inFlight = new Map<string, number>();
  let most = 0;
  let mostTotal = 0;
  const release: (() => void)[] = [];
  const h = harness([target('c1', ['/a', '/b']), target('c2', ['/c', '/d'])], {
    read: async (id) => {
      inFlight.set(id, (inFlight.get(id) ?? 0) + 1);
      most = Math.max(most, inFlight.get(id)!);
      mostTotal = Math.max(
        mostTotal,
        [...inFlight.values()].reduce((a, b) => a + b, 0),
      );
      await new Promise<void>((r) => release.push(r));
      inFlight.set(id, inFlight.get(id)! - 1);
      return unchanged;
    },
  });
  await h.clock.advanceTo(2_000);
  assertEquals(release.length, 2);
  // A refreshFolder of the repo being read runs right after that read, before the next one.
  void h.watch.refreshFolder('c1', '/a');
  await h.clock.advanceTo(2_000);
  assertEquals(release.length, 2);
  while (release.length) {
    release.shift()!();
    await h.clock.advanceTo(h.clock.t);
  }
  assertEquals(most, 1);
  assertEquals(mostTotal, 2);
  assertEquals(h.reads.filter(([, r]) => r.startsWith('c1:')), [
    [2_000, 'c1:/a'],
    [2_000, 'c1:/a'],
    [2_000, 'c1:/b'],
  ]);
  h.watch.stop();
});

Deno.test('GitChangesWatch drops an environment that stops while git runs', async () => {
  let running = true;
  const release: (() => void)[] = [];
  const clock = new FakeClock();
  const watch = new GitChangesWatch({
    targets: () => (running ? [target('c1', ['/a'])] : []),
    onChange: () => {},
    read: async () => {
      await new Promise<void>((r) => release.push(r));
      return unchanged;
    },
    watch: () => fakeWatcher().watcher,
    resolveFolder: asIs,
    clock,
  });
  watch.start();
  await clock.advanceTo(2_000);
  running = false;
  release.shift()!();
  await clock.advanceTo(2_000);
  assertEquals(watch.readings.has('c1'), false);
  watch.stop();
});

Deno.test('reposForEvent maps an event path to the repos it makes dirty', () => {
  const folders: WatchedFolder[] = [
    { folder: '/w/app', real: '/r/app', linked: false },
    { folder: '/w/app/vendor/lib', real: '/r/app/vendor/lib', linked: false },
    {
      folder: '/w/app.worktrees/one',
      real: '/r/app.worktrees/one',
      linked: true,
    },
    {
      folder: '/w/app.worktrees/two',
      real: '/r/app.worktrees/two',
      linked: true,
    },
  ];
  assertEquals(reposForEvent('/r/app/src/main.ts', folders), ['/w/app']);
  assertEquals(reposForEvent('/r/app/vendor/lib/x.c', folders), [
    '/w/app/vendor/lib',
  ]);
  assertEquals(reposForEvent('/r/app/.git/objects/ab/cdef', folders), []);
  assertEquals(reposForEvent('/r/app/.git/index.lock', folders), []);
  assertEquals(reposForEvent('/r/app/.git/index', folders), ['/w/app']);
  assertEquals(reposForEvent('/r/app/.git/HEAD', folders), ['/w/app']);
  assertEquals(reposForEvent('/r/app/.git/refs/heads/x', folders), ['/w/app']);
  assertEquals(reposForEvent('/r/app/.git/worktrees/one/index', folders), [
    '/w/app.worktrees/one',
    '/w/app.worktrees/two',
  ]);
  assertEquals(
    reposForEvent('/r/app/.git/worktrees/one/logs/HEAD', folders),
    [],
  );
  assertEquals(reposForEvent('/r/application/x', folders), []);
  assertEquals(reposForEvent('/elsewhere/x', folders), []);
});

Deno.test('GitChangesWatch marks every 15 s when the watcher fails to start', async () => {
  const logs: string[] = [];
  const h = harness([target('c1', ['/a'])], {
    watch: () => {
      throw new Error('too many open files');
    },
    log: (m) => logs.push(m),
  });
  await h.clock.advanceTo(61_000);
  assertEquals(h.reads, [
    [2_000, 'c1:/a'],
    [17_000, 'c1:/a'],
    [32_000, 'c1:/a'],
    [47_000, 'c1:/a'],
  ]);
  assertEquals(logs.length, 1);
  h.watch.stop();
});

Deno.test('GitChangesWatch reads a repo after a file in it changes, through Deno.watchFs', async () => {
  const dir = await Deno.realPath(await Deno.makeTempDir());
  const clock = new FakeClock();
  const reads: [number, string][] = [];
  const watch = new GitChangesWatch({
    targets: () => [target('h', [dir])],
    onChange: () => {},
    read: (_e, path) => {
      reads.push([clock.t, path]);
      return Promise.resolve(unchanged);
    },
    clock,
  });
  try {
    watch.start();
    await clock.advanceTo(20_000);
    assertEquals(reads, [[2_000, dir]]);
    await Deno.writeTextFile(`${dir}/a.txt`, 'a');
    // The event arrives in real time; the debounce runs on the fake clock.
    await new Promise((r) => setTimeout(r, 500));
    await clock.advanceTo(23_000);
    assertEquals(reads, [[2_000, dir], [22_000, dir]]);
  } finally {
    watch.stop();
    await Deno.remove(dir, { recursive: true });
  }
});
