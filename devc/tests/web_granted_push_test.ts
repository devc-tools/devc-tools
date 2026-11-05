import { assertEquals } from 'jsr:@std/assert';
import {
  bridgePaths,
  type PolicyLine,
  serializePolicy,
} from '@devc-tools/core/bridge.ts';
import { projectKey } from '@devc-tools/core/merged_config.ts';
import type { BridgeRun } from '../web/environment.ts';
import type { GitReading } from '../web/git_status.ts';
import {
  HOST_PROJECT,
  NOT_GRANTED,
  policyReader,
  PUSH_TIMED_OUT,
  PUSHED_MOMENTS_AGO,
  pushGrants,
  pushLine,
  pushRepo,
  type PushRepoDeps,
  STATUS_UNKNOWN,
} from '../web/granted_push.ts';

const line = (over: Partial<PolicyLine> = {}): PolicyLine => ({
  repo: '/src/app',
  remote: 'https://github.com/o/app.git',
  branch: 'feat',
  target: '/workspaces/app',
  grants: ['gh-push'],
  ...over,
});

const status = (branch: string): GitReading => ({
  branch,
  upstream: null,
  ahead: 0,
  behind: 0,
  gone: false,
  unfetched: 0,
});

/** A fake container backend: records each run, answers with `result`. */
function fakePr(result: BridgeRun | Error) {
  const calls: { command: string; target: string; args: string[] }[] = [];
  return {
    calls,
    pr: {
      run(command: string, target: string, args: string[]) {
        calls.push({ command, target, args });
        return result instanceof Error
          ? Promise.reject(result)
          : Promise.resolve(result);
      },
    },
  };
}

const exit = (code: number, stdout = '', stderr = ''): BridgeRun => ({
  kind: 'exit',
  code,
  stdout,
  stderr,
});

/** Each test uses its own folder: grantedPush shares a running push per folder. */
let n = 0;
function setup(
  over: Partial<PushRepoDeps> & { lines?: PolicyLine[] } = {},
  result: BridgeRun | Error = exit(0, 'pushed: feat at abc to r (x)\n'),
) {
  const folder = `/src/app${n++}`;
  const fake = fakePr(result);
  const deps: PushRepoDeps = {
    target: () => Promise.resolve({ env: { kind: 'container', pr: fake.pr } }),
    read: () => Promise.resolve(over.lines ?? [line({ repo: folder })]),
    status: () => status('feat'),
    startAllowed: () => true,
    ...over,
  };
  return { folder, calls: fake.calls, deps };
}

Deno.test('pushLine: the line pinning the folder, only when it grants gh-push', () => {
  assertEquals(pushLine([line()], '/src/app')?.target, '/workspaces/app');
  assertEquals(
    pushLine([line({ repo: '/src/app/' })], '/src/app')?.branch,
    'feat',
  );
  assertEquals(pushLine([line({ grants: ['gh-pr-read'] })], '/src/app'), null);
  assertEquals(pushLine([line()], '/src/other'), null);
  // Another repo's grant never counts.
  assertEquals(
    pushLine([
      line({ repo: '/src/lib', target: '/workspaces/lib' }),
      line({ grants: ['gh-pr-read'] }),
    ], '/src/app'),
    null,
  );
  assertEquals(pushLine([], '/src/app'), null);
});

Deno.test('pushGrants: a granted line whose pinned branch is checked out', async () => {
  const lines = new Map<string, PolicyLine[]>([
    ['/p1', [
      line({ repo: '/p1' }),
      line({ repo: '/p1/lib', target: '/w/lib', grants: ['gh-pr-read'] }),
      line({ repo: '/p1/other', target: '/w/other', branch: 'x' }),
    ]],
    ['/p2', []],
  ]);
  const got = await pushGrants(
    [
      { localFolder: '/p1', folders: ['/p1', '/p1/lib', '/p1/other'] },
      { localFolder: '/p2', folders: ['/p2'] },
    ],
    (f) => f === '/p1/other' ? 'main' : 'feat',
    (p) => Promise.resolve(lines.get(p) ?? []),
  );
  assertEquals([...got], ['/p1']);
});

Deno.test('policyReader: present, absent and malformed policies', async () => {
  const home = await Deno.makeTempDir();
  try {
    const read = policyReader(home);
    assertEquals(await read('/src/none'), []);
    const file = bridgePaths(home, await projectKey('/src/app')).policyFile;
    await Deno.mkdir(file.replace(/\/[^/]+$/, ''), { recursive: true });
    await Deno.writeTextFile(file, serializePolicy({ repos: [line()] }));
    assertEquals((await read('/src/app')).map((l) => l.branch), ['feat']);
    await Deno.writeTextFile(file, 'not a policy');
    assertEquals(await read('/src/app'), []);
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test('pushRepo: each refusal, in order, never runs the bridge', async () => {
  const cases: [Partial<PushRepoDeps> & { lines?: PolicyLine[] }, string][] = [
    [
      { target: () => Promise.resolve({ problem: 'not running' }) },
      'not running',
    ],
    [{
      target: () =>
        Promise.resolve({
          env: { kind: 'host', pr: { run: () => Promise.reject() } },
        }),
    }, HOST_PROJECT],
    [{ lines: [] }, NOT_GRANTED],
    [{ lines: [line({ grants: ['gh-pr-read'] })] }, NOT_GRANTED],
    [{ status: () => undefined }, STATUS_UNKNOWN],
    [{ status: () => ({ problem: 'detached HEAD' }) }, STATUS_UNKNOWN],
    [
      { status: () => status('main') },
      'main is not the pinned branch feat: use Push… (devc-desktop)',
    ],
    [{ startAllowed: () => false }, PUSHED_MOMENTS_AGO],
  ];
  for (const [over, problem] of cases) {
    const s = setup(over);
    // A `lines` override names /src/app: point it at this case's folder.
    if (over.lines) {
      s.deps.read = () =>
        Promise.resolve(over.lines!.map((l) => ({ ...l, repo: s.folder })));
    }
    assertEquals(
      await pushRepo({ localFolder: '/src', folder: s.folder }, s.deps),
      { ok: false, problem },
    );
    assertEquals(s.calls, []);
  }
});

Deno.test('pushRepo: gh-push only, no gh-pr-read needed; its last stdout line', async () => {
  const s = setup();
  assertEquals(
    await pushRepo({ localFolder: '/src', folder: s.folder }, s.deps),
    { ok: true, message: 'pushed: feat at abc to r (x)' },
  );
  assertEquals(s.calls, [{
    command: 'gh-push',
    target: '/workspaces/app',
    args: [],
  }]);
});

Deno.test('pushRepo: up to date, empty stdout, a refusal, a timeout, a throw', async () => {
  const run = async (result: BridgeRun | Error) => {
    const s = setup({}, result);
    return await pushRepo({ localFolder: '/src', folder: s.folder }, s.deps);
  };
  assertEquals(
    await run(exit(0, 'up to date: feat is already abc on r (x)\n')),
    {
      ok: true,
      message: 'up to date: feat is already abc on r (x)',
    },
  );
  assertEquals(await run(exit(0)), { ok: true, message: 'pushed' });
  assertEquals(
    await run(
      exit(
        3,
        '',
        'noise\ngh-push: refused: b changes .github/workflows/x.yml relative to main\n',
      ),
    ),
    {
      ok: false,
      problem:
        'gh-push: refused: b changes .github/workflows/x.yml relative to main',
    },
  );
  assertEquals(await run({ kind: 'timeout' }), {
    ok: false,
    problem: PUSH_TIMED_OUT,
  });
  assertEquals(await run(new Error('docker gone')), {
    ok: false,
    problem: 'docker gone',
  });
});

Deno.test('pushRepo: a second request while one runs shares it, past the rate limit', async () => {
  let release!: (r: BridgeRun) => void;
  const calls: string[] = [];
  const pr = {
    run: (command: string) => {
      calls.push(command);
      return new Promise<BridgeRun>((r) => release = r);
    },
  };
  const s = setup({
    target: () => Promise.resolve({ env: { kind: 'container', pr } }),
  });
  let allowed = true;
  s.deps.startAllowed = () => {
    const was = allowed;
    allowed = false;
    return was;
  };
  const msg = { localFolder: '/src', folder: s.folder };
  const first = pushRepo(msg, s.deps);
  await new Promise((r) => setTimeout(r, 0));
  const second = pushRepo(msg, s.deps);
  await new Promise((r) => setTimeout(r, 0));
  release(exit(0, 'pushed: x\n'));
  assertEquals(await first, { ok: true, message: 'pushed: x' });
  assertEquals(await second, { ok: true, message: 'pushed: x' });
  assertEquals(calls, ['gh-push']);
});
