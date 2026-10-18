import { assertEquals, assertThrows } from 'jsr:@std/assert';
import {
  childEnv,
  desktopWebArgsFromConfig,
  devcArgs,
  type FindDeps,
  findDevc,
  onPath,
  readyUrl,
  startDevcWeb,
} from '../launch.ts';

const TOKEN = 'ab'.repeat(32);

Deno.test("readyUrl: devc web's ready line, loopback and a 64-hex token only", () => {
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

Deno.test('desktopWebArgsFromConfig: absent means none; anything but strings throws', () => {
  assertEquals(desktopWebArgsFromConfig(null), []);
  assertEquals(desktopWebArgsFromConfig('{"codeRoots":[]}'), []);
  assertEquals(
    desktopWebArgsFromConfig('{"desktopWebArgs":["--live-yolo"]}'),
    ['--live-yolo'],
  );
  assertThrows(
    () => desktopWebArgsFromConfig('{"desktopWebArgs":"--live"}'),
    Error,
    'desktopWebArgs',
  );
  assertThrows(() => desktopWebArgsFromConfig('{"desktopWebArgs":[1]}'));
  assertThrows(() => desktopWebArgsFromConfig('{'));
});

Deno.test("devcArgs: --no-open first; the app's own args win over the config's", () => {
  assertEquals(devcArgs([], []), ['web', '--no-open']);
  assertEquals(devcArgs([], ['--live']), ['web', '--no-open', '--live']);
  assertEquals(
    devcArgs(['--live-yolo'], ['--live']),
    ['web', '--no-open', '--live-yolo'],
  );
});

Deno.test('childEnv: never DENO_SERVE_ADDRESS; PATH replaced only when given', () => {
  const env = {
    DENO_SERVE_ADDRESS: 'tcp:127.0.0.1:1',
    PATH: '/usr/bin',
    A: 'a',
  };
  assertEquals(childEnv(env, undefined), { PATH: '/usr/bin', A: 'a' });
  assertEquals(childEnv(env, '/opt/bin:/usr/bin'), {
    PATH: '/opt/bin:/usr/bin',
    A: 'a',
  });
  assertEquals(env.DENO_SERVE_ADDRESS, 'tcp:127.0.0.1:1');
});

function deps(
  env: Record<string, string>,
  bins: Record<string, string>,
  login: string | null,
): FindDeps & { loginCalls: number } {
  const d = {
    loginCalls: 0,
    env: (k: string) => env[k],
    onPath: (name: string, path: string) =>
      Promise.resolve(
        path.split(':').map((dir) => bins[dir] === name ? `${dir}/${name}` : '')
          .find((f) => f !== '') ?? null,
      ),
    loginPath: () => {
      d.loginCalls++;
      return Promise.resolve(login);
    },
  };
  return d;
}

Deno.test("findDevc: $DEVC_DESKTOP_DEVC, then the app's PATH, then the login shell's", async () => {
  const given = deps({ DEVC_DESKTOP_DEVC: '/x/devc', PATH: '/a' }, {
    '/a': 'devc',
  }, null);
  assertEquals(await findDevc(given), { devc: '/x/devc' });

  const own = deps({ PATH: '/usr/bin:/a' }, { '/a': 'devc' }, '/b');
  assertEquals(await findDevc(own), { devc: '/a/devc' });
  assertEquals(own.loginCalls, 0);

  const login = deps({ PATH: '/usr/bin' }, { '/b': 'devc' }, '/usr/bin:/b');
  assertEquals(await findDevc(login), { devc: '/b/devc', path: '/usr/bin:/b' });

  assertEquals(
    await findDevc(deps({ PATH: '/usr/bin' }, {}, '/usr/bin')),
    null,
  );
  assertEquals(await findDevc(deps({}, {}, null)), null);
});

Deno.test('onPath: the first executable file, skipping non-executables', async () => {
  const a = await Deno.makeTempDir();
  const b = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${a}/devc`, '');
    await Deno.chmod(`${a}/devc`, 0o644);
    await Deno.writeTextFile(`${b}/devc`, '');
    await Deno.chmod(`${b}/devc`, 0o755);
    assertEquals(await onPath('devc', `::${a}:${b}`), `${b}/devc`);
    assertEquals(await onPath('nope', `${a}:${b}`), null);
  } finally {
    await Deno.remove(a, { recursive: true });
    await Deno.remove(b, { recursive: true });
  }
});

/** A stand-in `devc`: a shell script given as the body after the shebang. */
async function stub(body: string): Promise<{ path: string; dir: string }> {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/devc`;
  await Deno.writeTextFile(path, `#!/bin/sh\n${body}\n`);
  await Deno.chmod(path, 0o755);
  return { path, dir };
}

Deno.test('startDevcWeb: ready on the printed line; args and env reach the child', async () => {
  const s = await stub(
    `echo "args: $*" >&2; echo "addr: \${DENO_SERVE_ADDRESS-unset}" >&2
echo 'listening'; echo "devc web: http://127.0.0.1:48228/#token=${TOKEN}"
exec sleep 30`,
  );
  try {
    const web = startDevcWeb(
      s.path,
      ['web', '--no-open'],
      childEnv(
        { PATH: Deno.env.get('PATH')!, DENO_SERVE_ADDRESS: 'x' },
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
    await Deno.remove(s.dir, { recursive: true });
  }
});

Deno.test('startDevcWeb: an early exit keeps the stderr tail and never readies', async () => {
  const s = await stub(
    `i=0; while [ $i -lt 50 ]; do echo "line $i" >&2; i=$((i+1)); done; exit 3`,
  );
  try {
    const web = startDevcWeb(s.path, [], { PATH: Deno.env.get('PATH')! });
    let readied = false;
    void web.ready.then(() => readied = true);
    assertEquals(await web.exited, '3');
    assertEquals(readied, false);
    const tail = web.stderr();
    assertEquals(tail.length, 40);
    assertEquals(tail[0], 'line 10');
    assertEquals(tail[39], 'line 49');
  } finally {
    await Deno.remove(s.dir, { recursive: true });
  }
});

Deno.test('startDevcWeb: stop escalates to SIGKILL when SIGTERM is ignored', async () => {
  const s = await stub(`trap '' TERM; while :; do sleep 0.1; done`);
  try {
    const web = startDevcWeb(s.path, [], { PATH: Deno.env.get('PATH')! });
    await new Promise((r) => setTimeout(r, 200));
    const t0 = Date.now();
    await web.stop();
    assertEquals(await web.exited, 'SIGKILL');
    assertEquals(Date.now() - t0 >= 4500, true);
  } finally {
    await Deno.remove(s.dir, { recursive: true });
  }
});
