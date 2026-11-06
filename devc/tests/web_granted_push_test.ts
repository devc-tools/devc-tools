import { assertEquals } from 'jsr:@std/assert';
import {
  bridgePaths,
  type PolicyLine,
  serializePolicy,
} from '@devc-tools/core/bridge.ts';
import { projectKey } from '@devc-tools/core/merged_config.ts';
import type { BridgeRun } from '../web/environment.ts';
import type { GitReading, GitStatus } from '../web/git_status.ts';
import {
  escalate,
  HOST_PROJECT,
  NEEDS_GRANT,
  NOT_GRANTED,
  policyReader,
  PUSH_TIMED_OUT,
  PUSHED_MOMENTS_AGO,
  pushLine,
  pushRepo,
  type PushRepoDeps,
  pushRoute,
  pushRoutes,
  START_TO_PUSH,
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

Deno.test('pushRoute: each rule, in order', () => {
  const g = (over: Partial<GitStatus> = {}): GitStatus => ({
    ...(status('feat') as GitStatus),
    ahead: 2,
    ...over,
  });
  // Nothing to push: neither.
  assertEquals(pushRoute(g({ ahead: 0 }), line(), true, true), {});
  assertEquals(pushRoute(null, line(), true, true), {});
  // 1. The upstream is not origin/<branch>.
  assertEquals(pushRoute(g({ upstream: 'origin/main' }), line(), true, true), {
    pushUnavailable: 'tracks origin/main; Push goes to origin/feat',
  });
  assertEquals(
    pushRoute(g({ upstream: 'origin/feat' }), line(), true, false),
    { push: 'now' },
  );
  // 2. The grant applies.
  assertEquals(pushRoute(g(), line(), true, false), { push: 'now' });
  // 3. devc-desktop.
  assertEquals(pushRoute(g(), null, true, true), { push: 'confirm' });
  assertEquals(pushRoute(g(), line(), false, true), { push: 'confirm' });
  assertEquals(pushRoute(g({ branch: 'x' }), line(), true, true), {
    push: 'confirm',
  });
  // 4. The reasons.
  assertEquals(pushRoute(g(), line(), false, false), {
    pushUnavailable: START_TO_PUSH,
  });
  assertEquals(pushRoute(g({ branch: 'x' }), line(), true, false), {
    pushUnavailable: 'x is not the pinned branch feat',
  });
  assertEquals(pushRoute(g(), null, true, false), {
    pushUnavailable: NEEDS_GRANT,
  });
});

Deno.test('pushRoutes: a container project reads its policy, a host project never', async () => {
  const read: string[] = [];
  const ahead = (branch: string): GitReading => ({
    ...(status(branch) as GitStatus),
    ahead: 1,
  });
  const got = await pushRoutes(
    [
      {
        localFolder: '/p1',
        container: true,
        running: true,
        folders: ['/p1', '/p1/lib'],
      },
      { localFolder: '/h', container: false, running: false, folders: ['/h'] },
    ],
    (f) => f === '/p1/lib' ? status('feat') : ahead('feat'),
    (p) => {
      read.push(p);
      return Promise.resolve([line({ repo: '/p1' })]);
    },
    false,
  );
  assertEquals(read, ['/p1']);
  assertEquals([...got], [
    ['/p1', { push: 'now' }],
    ['/h', { pushUnavailable: NEEDS_GRANT }],
  ]);
});

Deno.test('escalate: exit 3 asks devc-desktop when it is connected', () => {
  const refusal = { ok: false as const, problem: 'refused: x', code: 3 };
  let asked = 0;
  const ask = () => {
    asked++;
    return { ok: true as const };
  };
  assertEquals(escalate(refusal, ask), {
    ok: false,
    problem: 'refused: x',
    asked: true,
  });
  assertEquals(asked, 1);
  assertEquals(escalate(refusal, null), { ok: false, problem: 'refused: x' });
  assertEquals(escalate({ ...refusal, code: 4 }, ask), {
    ok: false,
    problem: 'refused: x',
  });
  assertEquals(asked, 1);
  assertEquals(
    escalate(refusal, () => ({ ok: false, problem: 'too many requests' })),
    {
      ok: false,
      problem:
        'refused: x; and devc-desktop could not be asked: too many requests',
    },
  );
  assertEquals(escalate({ ok: true, message: 'pushed' }, ask), {
    ok: true,
    message: 'pushed',
  });
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
      code: 3,
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
