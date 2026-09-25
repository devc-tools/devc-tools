// Per-workspace tokens, end to end against a real server: one token per `keys/<key>/`, minted on
// start and on watch, never adopted from disk, never written through a symlink — and the shared
// legacy token in `run/` still accepted alongside them.

import { assert, assertEquals, assertNotEquals } from '@std/assert';
import { join } from '@std/path';
import { type RunningServer, startServer } from '../core.ts';
import { resetToken } from '../token.ts';

interface Env {
  dir: string;
  keysDir: string;
  port: number;
  shared: string;
  server: RunningServer;
}

function freePort(): number {
  const listener = Deno.listen({ hostname: '127.0.0.1', port: 0 });
  const { port } = listener.addr as Deno.NetAddr;
  listener.close();
  return port;
}

/** Start a server over a temp tree, after `prepare` has laid out `keys/`. */
async function withServer(
  prepare: (keysDir: string) => Promise<void>,
  fn: (env: Env) => Promise<void> | void,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: 'devc-bridge-keys-' });
  const keysDir = join(dir, 'keys');
  const commandsDir = join(dir, 'commands');
  await Deno.mkdir(keysDir, { recursive: true });
  await Deno.mkdir(commandsDir, { recursive: true });
  const echo = join(commandsDir, 'echo');
  await Deno.writeTextFile(echo, '#!/bin/sh\necho ok\n');
  await Deno.chmod(echo, 0o755);
  // Reports what dispatch told it about the caller; `-` marks a variable that is unset.
  const whoami = join(commandsDir, 'whoami');
  await Deno.writeTextFile(
    whoami,
    '#!/bin/sh\necho "key=${DEVC_BRIDGE_KEY--} policy=${DEVC_BRIDGE_POLICY_DIR--}"\n',
  );
  await Deno.chmod(whoami, 0o755);
  await prepare(keysDir);

  const port = freePort();
  const shared = await resetToken(join(dir, 'run', 'token'));
  const server = await startServer({
    hostname: '127.0.0.1',
    port,
    token: shared,
    keysDir,
    commandsDir,
    stateDir: join(dir, 'state'),
    policyDir: join(dir, 'policy'),
    log: () => {},
  });
  try {
    await fn({ dir, keysDir, port, shared, server });
  } finally {
    await server.close();
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

/** Send one request and return the parsed response. */
async function call(
  port: number,
  token: string,
  command = 'echo',
): Promise<{ ok: boolean; stdout?: string }> {
  const conn = await Deno.connect({ hostname: '127.0.0.1', port });
  try {
    await conn.write(
      new TextEncoder().encode(
        JSON.stringify({ token, command, args: [] }) + '\n',
      ),
    );
    const buf = new Uint8Array(4096);
    let text = '';
    while (!text.includes('\n')) {
      const n = await conn.read(buf);
      if (n === null) break;
      text += new TextDecoder().decode(buf.subarray(0, n));
    }
    return JSON.parse(text);
  } finally {
    conn.close();
  }
}

async function tokenAt(keysDir: string, key: string): Promise<string> {
  return (await Deno.readTextFile(join(keysDir, key, 'token'))).trim();
}

/** Poll until `check` holds — for the watch path, which must not be driven by `settled()`. */
async function eventually(
  check: () => Promise<boolean>,
  ms = 5000,
): Promise<boolean> {
  const deadline = performance.now() + ms;
  while (performance.now() < deadline) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return await check();
}

Deno.test('start mints a token into every existing key directory', async () => {
  await withServer(async (keysDir) => {
    await Deno.mkdir(join(keysDir, 'app-11111111'));
    await Deno.mkdir(join(keysDir, 'app-22222222'));
  }, async ({ keysDir, port, server }) => {
    assertEquals(server.keys(), ['app-11111111', 'app-22222222']);
    const a = await tokenAt(keysDir, 'app-11111111');
    const b = await tokenAt(keysDir, 'app-22222222');
    assertNotEquals(a, b);
    assertEquals((await call(port, a)).ok, true);
    assertEquals((await call(port, b)).ok, true);
  });
});

Deno.test('a key directory created while running is minted via the watcher', async () => {
  await withServer(async () => {}, async ({ keysDir, port }) => {
    await Deno.mkdir(join(keysDir, 'late-33333333'));
    const path = join(keysDir, 'late-33333333', 'token');
    assert(
      await eventually(async () => {
        try {
          await Deno.stat(path);
          return true;
        } catch {
          return false;
        }
      }),
      'the watcher never minted the new key directory',
    );
    assertEquals(
      (await call(port, await tokenAt(keysDir, 'late-33333333'))).ok,
      true,
    );
  });
});

Deno.test('a token found on disk is never adopted', async () => {
  const planted = 'b'.repeat(64);
  await withServer(async (keysDir) => {
    await Deno.mkdir(join(keysDir, 'app-44444444'));
    await Deno.writeTextFile(
      join(keysDir, 'app-44444444', 'token'),
      planted + '\n',
    );
  }, async ({ keysDir, port }) => {
    assertNotEquals(await tokenAt(keysDir, 'app-44444444'), planted);
    assertEquals(await call(port, planted), {
      ok: false,
      error: 'unauthorized',
    } as unknown as { ok: boolean });
  });
});

Deno.test('a symlink planted at a key token path is replaced, not followed', async () => {
  let victim = '';
  await withServer(async (keysDir) => {
    victim = join(keysDir, '..', 'precious');
    await Deno.writeTextFile(victim, 'do not clobber me\n');
    await Deno.mkdir(join(keysDir, 'app-55555555'));
    await Deno.symlink(victim, join(keysDir, 'app-55555555', 'token'));
  }, async ({ keysDir }) => {
    assertEquals(await Deno.readTextFile(victim), 'do not clobber me\n');
    const info = await Deno.lstat(join(keysDir, 'app-55555555', 'token'));
    assert(info.isFile && !info.isSymlink);
  });
});

Deno.test('a symlinked key directory is not minted into', async () => {
  let elsewhere = '';
  await withServer(async (keysDir) => {
    elsewhere = join(keysDir, '..', 'elsewhere');
    await Deno.mkdir(elsewhere);
    await Deno.symlink(elsewhere, join(keysDir, 'link-66666666'));
  }, ({ server }) => {
    assertEquals(server.keys(), []);
    assertEquals([...Deno.readDirSync(elsewhere)], []);
  });
});

Deno.test('the shared legacy token keeps working beside the per-key ones', async () => {
  await withServer(async (keysDir) => {
    await Deno.mkdir(join(keysDir, 'app-77777777'));
  }, async ({ port, shared }) => {
    assertEquals((await call(port, shared)).ok, true);
    assertEquals((await call(port, 'c'.repeat(64))).ok, false);
  });
});

Deno.test('removing a key directory revokes its token', async () => {
  await withServer(async (keysDir) => {
    await Deno.mkdir(join(keysDir, 'app-88888888'));
  }, async ({ keysDir, port, server }) => {
    const token = await tokenAt(keysDir, 'app-88888888');
    await Deno.remove(join(keysDir, 'app-88888888'), { recursive: true });
    await server.settled();
    assertEquals(server.keys(), []);
    assertEquals((await call(port, token)).ok, false);
  });
});

Deno.test('a restart re-mints every key', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'devc-bridge-restart-' });
  const keysDir = join(dir, 'keys');
  await Deno.mkdir(join(keysDir, 'app-99999999'), { recursive: true });
  const start = async () =>
    await startServer({
      hostname: '127.0.0.1',
      port: freePort(),
      token: 'shared',
      keysDir,
      commandsDir: join(dir, 'commands'),
      stateDir: join(dir, 'state'),
      log: () => {},
    });
  try {
    const first = await start();
    const before = await tokenAt(keysDir, 'app-99999999');
    await first.close();
    const second = await start();
    const after = await tokenAt(keysDir, 'app-99999999');
    await second.close();
    assertNotEquals(before, after);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("a script is told its caller's key, and the shared token is told none", async () => {
  // Set in the daemon's own environment, as if the shell that started it had them: dispatch must
  // replace both, never pass them through.
  Deno.env.set('DEVC_BRIDGE_KEY', 'forged-key');
  Deno.env.set('DEVC_BRIDGE_POLICY_DIR', '/forged/policy');
  try {
    await withServer(async (keysDir) => {
      await Deno.mkdir(join(keysDir, 'app-99999999'));
    }, async ({ dir, keysDir, port, shared }) => {
      const policy = join(dir, 'policy');
      const keyed = await call(
        port,
        await tokenAt(keysDir, 'app-99999999'),
        'whoami',
      );
      assertEquals(keyed.stdout, `key=app-99999999 policy=${policy}\n`);
      const legacy = await call(port, shared, 'whoami');
      assertEquals(legacy.stdout, `key= policy=${policy}\n`);
    });
  } finally {
    Deno.env.delete('DEVC_BRIDGE_KEY');
    Deno.env.delete('DEVC_BRIDGE_POLICY_DIR');
  }
});
