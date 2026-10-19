import { test } from 'node:test';
import { deepStrictEqual as assertEquals, throws } from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  childEnv,
  type DesktopConfig,
  desktopConfig,
  devcArgs,
  type FindDeps,
  findDevc,
  type LoginEnv,
  loginEnv,
  looked,
  onPath,
  readyUrl,
  startDevcWeb,
} from '../src/main/launch.ts';

const TOKEN = 'ab'.repeat(32);

test("readyUrl: devc web's ready line, loopback and a 64-hex token only", () => {
  const url = `http://127.0.0.1:48228/#token=${TOKEN}`;
  assertEquals(readyUrl(`devc web: ${url}`), url);
  assertEquals(readyUrl(`devc web: ${url}\r`), url);
  assertEquals(readyUrl(`devc web: http://127.0.0.1:48228/#token=abc`), null);
  assertEquals(
    readyUrl(`devc web: http://localhost:48228/#token=${TOKEN}`),
    null,
  );
  assertEquals(
    readyUrl(`devc web: http://evil.example:48228/#token=${TOKEN}`),
    null,
  );
  assertEquals(readyUrl(`note: devc web: ${url}`), null);
  assertEquals(readyUrl('devc web: server exited (1)'), null);
});

test('desktopConfig: defaults, desktopWebArgs, and desktopDevc', () => {
  const dflt: DesktopConfig = { webArgs: [], devc: { kind: 'installed' } };
  assertEquals(desktopConfig(null), dflt);
  assertEquals(desktopConfig('{"codeRoots":[]}'), dflt);
  assertEquals(
    desktopConfig('{"desktopWebArgs":["--live-yolo"],"desktopDevc":"devc2"}'),
    { webArgs: ['--live-yolo'], devc: { kind: 'devc2' } },
  );
  assertEquals(desktopConfig('{"desktopDevc":"installed"}').devc, {
    kind: 'installed',
  });
  assertEquals(desktopConfig('{"desktopDevc":"/opt/devc"}').devc, {
    kind: 'path',
    path: '/opt/devc',
  });
  throws(() => desktopConfig('{"desktopWebArgs":"--live"}'), /desktopWebArgs/);
  throws(() => desktopConfig('{"desktopWebArgs":[1]}'));
  throws(() => desktopConfig('{"desktopDevc":"devc3"}'), /desktopDevc/);
  throws(() => desktopConfig('{"desktopDevc":"bin/devc"}'));
  throws(() => desktopConfig('{'));
});

test("devcArgs: --no-open first; the app's own args win over the config's", () => {
  assertEquals(devcArgs([], []), ['web', '--no-open']);
  assertEquals(devcArgs([], ['--live']), ['web', '--no-open', '--live']);
  assertEquals(
    devcArgs(['--live-yolo'], ['--live']),
    ['web', '--no-open', '--live-yolo'],
  );
});

test('childEnv: never DENO_SERVE_ADDRESS or ELECTRON_*; PATH replaced only when given', () => {
  const env = {
    DENO_SERVE_ADDRESS: 'tcp:127.0.0.1:1',
    PATH: '/usr/bin',
    A: 'a',
  };
  assertEquals(childEnv(env, undefined), { PATH: '/usr/bin', A: 'a' });
  assertEquals(
    childEnv(
      { ELECTRON_RUN_AS_NODE: '1', ELECTRON_NO_ATTACH_CONSOLE: '1', B: 'b' },
      undefined,
    ),
    { B: 'b' },
  );
  assertEquals(childEnv(env, '/opt/bin:/usr/bin'), {
    PATH: '/opt/bin:/usr/bin',
    A: 'a',
  });
  assertEquals(env.DENO_SERVE_ADDRESS, 'tcp:127.0.0.1:1');
});

function deps(
  env: Record<string, string>,
  bins: Record<string, string>,
  login: LoginEnv | null,
): FindDeps & { loginCalls: number } {
  const d = {
    loginCalls: 0,
    env: (k: string) => env[k],
    onPath: (name: string, path: string) =>
      Promise.resolve(
        path.split(':').map((dir) =>
          bins[dir]?.split(' ').includes(name) ? `${dir}/${name}` : ''
        )
          .find((f) => f !== '') ?? null,
      ),
    loginEnv: () => {
      d.loginCalls++;
      return Promise.resolve(login);
    },
  };
  return d;
}

const DEVC_BIN = 'deno run --allow-read /src/devc/main.ts';
const BIN_WORDS = ['deno', 'run', '--allow-read', '/src/devc/main.ts'];

const INSTALLED = { kind: 'installed' } as const;
const DEVC2 = { kind: 'devc2' } as const;

test('findDevc: $DEVC_DESKTOP_DEVC overrides every choice', async () => {
  const choices = [
    INSTALLED,
    DEVC2,
    { kind: 'path', path: '/p/devc' } as const,
  ];
  for (const choice of choices) {
    const d = deps({ DEVC_DESKTOP_DEVC: '/x/devc', DEVC_BIN, PATH: '/a' }, {
      '/a': 'devc',
    }, null);
    assertEquals(await findDevc(d, choice), { cmd: ['/x/devc'] });
  }
});

test("findDevc installed: the app's PATH, then the login shell's; never $DEVC_BIN", async () => {
  const own = deps({ PATH: '/usr/bin:/a', DEVC_BIN }, { '/a': 'devc' }, null);
  assertEquals(await findDevc(own, INSTALLED), { cmd: ['/a/devc'] });
  assertEquals(own.loginCalls, 0);

  const login = deps({ PATH: '/usr/bin', DEVC_BIN }, { '/b': 'devc' }, {
    path: '/usr/bin:/b',
    devcBin: DEVC_BIN,
  });
  assertEquals(await findDevc(login, INSTALLED), {
    cmd: ['/b/devc'],
    path: '/usr/bin:/b',
  });

  const none = deps({ PATH: '/usr/bin', DEVC_BIN }, { '/opt/deno': 'deno' }, {
    path: '/usr/bin:/opt/deno',
    devcBin: DEVC_BIN,
  });
  assertEquals(await findDevc(none, INSTALLED), null);
  assertEquals(await findDevc(deps({}, {}, null), INSTALLED), null);
});

test('findDevc devc2: $DEVC_BIN from the app, then the login shell; never a PATH devc', async () => {
  const own = deps({ DEVC_BIN: `  ${DEVC_BIN} `, PATH: '/a' }, {
    '/a': 'devc',
  }, null);
  assertEquals(await findDevc(own, DEVC2), { cmd: BIN_WORDS });
  assertEquals(own.loginCalls, 0);

  const login = deps(
    { PATH: '/usr/bin' },
    { '/opt/deno': 'deno', '/b': 'devc' },
    { path: '/usr/bin:/opt/deno:/b', devcBin: DEVC_BIN },
  );
  assertEquals(await findDevc(login, DEVC2), {
    cmd: ['/opt/deno/deno', ...BIN_WORDS.slice(1)],
    path: '/usr/bin:/opt/deno:/b',
  });

  // $DEVC_BIN whose first word is not on the login PATH, or no $DEVC_BIN at all: not found,
  // even with a devc there.
  const noDeno = deps({ PATH: '/usr/bin' }, { '/b': 'devc' }, {
    path: '/usr/bin:/b',
    devcBin: DEVC_BIN,
  });
  assertEquals(await findDevc(noDeno, DEVC2), null);
  const unset = deps({ PATH: '/a' }, { '/a': 'devc' }, { path: '/a' });
  assertEquals(await findDevc(unset, DEVC2), null);
});

test('findDevc path: that binary as is', async () => {
  const d = deps({ DEVC_BIN, PATH: '/a' }, { '/a': 'devc' }, null);
  assertEquals(await findDevc(d, { kind: 'path', path: '/p/devc' }), {
    cmd: ['/p/devc'],
  });
  assertEquals(d.loginCalls, 0);
});

test('looked: names the places each choice looks', () => {
  assertEquals(looked(INSTALLED)[1], "devc on the app's PATH");
  assertEquals(looked(DEVC2)[1], "$DEVC_BIN in the app's environment");
  assertEquals(looked({ kind: 'path', path: '/p/devc' }), [
    '$DEVC_DESKTOP_DEVC',
    '/p/devc',
  ]);
});

test('onPath: the first executable file, skipping non-executables', async () => {
  const a = await tempDir();
  const b = await tempDir();
  try {
    await writeFile(`${a}/devc`, '');
    await chmod(`${a}/devc`, 0o644);
    await writeFile(`${b}/devc`, '');
    await chmod(`${b}/devc`, 0o755);
    assertEquals(await onPath('devc', `::${a}:${b}`), `${b}/devc`);
    assertEquals(await onPath('nope', `${a}:${b}`), null);
  } finally {
    await rm(a, { recursive: true });
    await rm(b, { recursive: true });
  }
});

/** A stand-in `devc`: a shell script given as the body after the shebang. */
async function stub(body: string): Promise<{ path: string; dir: string }> {
  const dir = await tempDir();
  const path = `${dir}/devc`;
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
  return { path, dir };
}

const tempDir = () => mkdtemp(join(tmpdir(), 'devc-desktop-'));

test('startDevcWeb: ready on the printed line; args and env reach the child', async () => {
  const s = await stub(
    `echo "args: $*" >&2; echo "addr: \${DENO_SERVE_ADDRESS-unset}" >&2
echo 'listening'; echo "devc web: http://127.0.0.1:48228/#token=${TOKEN}"
exec sleep 30`,
  );
  try {
    const web = startDevcWeb(
      [s.path],
      ['web', '--no-open'],
      childEnv(
        { PATH: process.env.PATH!, DENO_SERVE_ADDRESS: 'x' },
        undefined,
      ),
    );
    assertEquals(
      await web.ready,
      `http://127.0.0.1:48228/#token=${TOKEN}`,
    );
    await web.stop();
    assertEquals(await web.exited, 'SIGTERM');
    assertEquals(web.stderr(), ['args: web --no-open', 'addr: unset']);
  } finally {
    await rm(s.dir, { recursive: true });
  }
});

test('startDevcWeb: an early exit keeps the stderr tail and never readies', async () => {
  const s = await stub(
    `i=0; while [ $i -lt 50 ]; do echo "line $i" >&2; i=$((i+1)); done; exit 3`,
  );
  try {
    const web = startDevcWeb([s.path], [], { PATH: process.env.PATH! });
    let readied = false;
    void web.ready.then(() => readied = true);
    assertEquals(await web.exited, '3');
    assertEquals(readied, false);
    const tail = web.stderr();
    assertEquals(tail.length, 40);
    assertEquals(tail[0], 'line 10');
    assertEquals(tail[39], 'line 49');
  } finally {
    await rm(s.dir, { recursive: true });
  }
});

test('startDevcWeb: stop escalates to SIGKILL when SIGTERM is ignored', async () => {
  const s = await stub(`trap '' TERM; while :; do sleep 0.1; done`);
  try {
    const web = startDevcWeb([s.path], [], { PATH: process.env.PATH! });
    await new Promise((r) => setTimeout(r, 200));
    const t0 = Date.now();
    await web.stop();
    assertEquals(await web.exited, 'SIGKILL');
    assertEquals(Date.now() - t0 >= 4500, true);
  } finally {
    await rm(s.dir, { recursive: true });
  }
});

test('loginEnv: PATH and $DEVC_BIN from the login shell; null for a missing shell', async () => {
  const dir = await tempDir();
  try {
    const shell = `${dir}/sh`;
    // A shell whose rc output surrounds the answer, as a chatty .zshrc would.
    await writeFile(
      shell,
      `#!/bin/sh\necho 'welcome'\nPATH=/p1:/p2 DEVC_BIN='deno run x' exec /bin/sh -c "$2"\n`,
    );
    await chmod(shell, 0o755);
    assertEquals(await loginEnv(shell), {
      path: '/p1:/p2',
      devcBin: 'deno run x',
    });
    assertEquals(await loginEnv('/nonexistent'), null);
  } finally {
    await rm(dir, { recursive: true });
  }
});
