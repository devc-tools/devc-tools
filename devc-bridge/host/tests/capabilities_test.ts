// Built-in capabilities: materialized on start, never seeded, run only for a caller whose policy
// grants them — checked by the server on every request, before anything runs — and never
// shadowed by a same-named file in commands/.

import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { join } from '@std/path';
import { listBuiltins, materializeBuiltins, seedCommands } from '../config.ts';
import { type RunningServer, startServer } from '../core.ts';
import { resetToken } from '../token.ts';

const KEY = 'app-11111111';

interface Env {
  dir: string;
  port: number;
  shared: string;
  token: string;
  policyFile: string;
  logs: string[];
  server: RunningServer;
}

function freePort(): number {
  const listener = Deno.listen({ hostname: '127.0.0.1', port: 0 });
  const { port } = listener.addr as Deno.NetAddr;
  listener.close();
  return port;
}

async function script(path: string, body: string): Promise<void> {
  await Deno.writeTextFile(path, `#!/bin/sh\n${body}\n`);
  await Deno.chmod(path, 0o755);
}

/**
 * A server over a temp tree with one keyed container, stub built-ins (each echoes `builtin
 * <name>`), and a `commands/git-push` that must never run. `policy` is the key's policy file
 * contents, or null for none.
 */
async function withServer(
  policy: string | null,
  fn: (env: Env) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: 'devc-bridge-caps-' });
  const keysDir = join(dir, 'keys');
  const commandsDir = join(dir, 'commands');
  const builtinDir = join(dir, 'builtin');
  const policyDir = join(dir, 'policy');
  for (const d of [join(keysDir, KEY), commandsDir, builtinDir, policyDir]) {
    await Deno.mkdir(d, { recursive: true });
  }
  for (const name of await listBuiltins()) {
    await script(
      join(builtinDir, name),
      `echo "builtin ${name} key=$DEVC_BRIDGE_KEY"`,
    );
  }
  await script(join(commandsDir, 'git-push'), 'echo shadow');
  await script(join(commandsDir, 'echo'), 'echo ok');
  const policyFile = join(policyDir, `${KEY}.conf`);
  if (policy !== null) await Deno.writeTextFile(policyFile, policy);

  const logs: string[] = [];
  const port = freePort();
  const shared = await resetToken(join(dir, 'run', 'token'));
  const server = await startServer({
    hostname: '127.0.0.1',
    port,
    token: shared,
    keysDir,
    commandsDir,
    builtinDir,
    stateDir: join(dir, 'state'),
    policyDir,
    log: (m) => logs.push(m),
  });
  try {
    const token = (await Deno.readTextFile(join(keysDir, KEY, 'token'))).trim();
    await fn({ dir, port, shared, token, policyFile, logs, server });
  } finally {
    await server.close();
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

type Resp = { ok: boolean; stdout?: string; error?: string };

async function call(
  port: number,
  token: string,
  command: string,
): Promise<Resp> {
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

const policyLine = (grants: string) =>
  `/r\tgit@github.com:o/r.git\tfeat\t${grants}\n`;

// ── the grant check ─────────────────────────────────────────────────────────────────────────

Deno.test('a granted built-in runs from builtinDir, with the caller key', async () => {
  await withServer(
    policyLine('git-push,pr-review'),
    async ({ port, token }) => {
      const push = await call(port, token, 'git-push');
      assertEquals(push, {
        ok: true,
        exitCode: 0,
        stdout: `builtin git-push key=${KEY}\n`,
        stderr: '',
      } as Resp);
      assertEquals((await call(port, token, 'git-doctor')).ok, true);
      assertEquals((await call(port, token, 'pr-comments')).ok, true);
      assertEquals((await call(port, token, 'pr-reply')).ok, true);
    },
  );
});

Deno.test('a built-in is refused, with the exact message, for each ungranted case', async () => {
  await withServer(null, async ({ port, shared, token, policyFile }) => {
    assertEquals(await call(port, shared, 'git-push'), {
      ok: false,
      error:
        'git-push needs a per-container token — the shared token has no capabilities',
    });
    assertEquals(await call(port, token, 'git-push'), {
      ok: false,
      error:
        'no capabilities granted to this container — on the host: devc up --bridge-allow git-push',
    });
    assertEquals(await call(port, token, 'pr-resolve'), {
      ok: false,
      error:
        'no capabilities granted to this container — on the host: devc up --bridge-allow pr-review,pr-resolve',
    });

    // A policy from before grants existed: three fields.
    await Deno.writeTextFile(policyFile, '/r\tgit@github.com:o/r.git\tfeat\n');
    assertEquals(await call(port, token, 'git-push'), {
      ok: false,
      error:
        "this container's policy is malformed and grants nothing — on the host: devc up --bridge-allow git-push",
    });

    await Deno.writeTextFile(policyFile, policyLine('git-push'));
    assertEquals(await call(port, token, 'pr-comments'), {
      ok: false,
      error:
        'pr-comments needs capability pr-review, which this container was not granted (it has: git-push) — on the host: devc up --bridge-allow git-push,pr-review',
    });
    assertEquals(await call(port, token, 'pr-resolve'), {
      ok: false,
      error:
        'pr-resolve needs capability pr-resolve, which this container was not granted (it has: git-push) — on the host: devc up --bridge-allow git-push,pr-review,pr-resolve',
    });
  });
});

Deno.test('the policy is read per request: deleting it revokes without a restart', async () => {
  await withServer(
    policyLine('git-push'),
    async ({ port, token, policyFile }) => {
      assertEquals((await call(port, token, 'git-push')).ok, true);
      await Deno.remove(policyFile);
      const after = await call(port, token, 'git-push');
      assertEquals(after.ok, false);
      assertStringIncludes(after.error!, 'no capabilities granted');
    },
  );
});

Deno.test('a commands/ file named like a built-in is never run, and is reported on start', async () => {
  await withServer(policyLine('git-push'), async ({ port, token, logs }) => {
    assertEquals(
      (await call(port, token, 'git-push')).stdout,
      `builtin git-push key=${KEY}\n`,
    );
    assert(
      logs.includes(
        'commands/git-push is shadowed by the built-in git-push — remove it',
      ),
      logs.join('\n'),
    );
  });
});

Deno.test('ordinary commands are unaffected by grants', async () => {
  await withServer(null, async ({ port, shared, token }) => {
    assertEquals((await call(port, token, 'echo')).stdout, 'ok\n');
    assertEquals((await call(port, shared, 'echo')).stdout, 'ok\n');
  });
});

// ── materialization and seeding ─────────────────────────────────────────────────────────────

Deno.test('materializeBuiltins writes every built-in and replaces a stale set whole', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'devc-bridge-mat-' });
  try {
    const target = join(dir, 'state', 'builtin');
    await Deno.mkdir(target, { recursive: true });
    await Deno.writeTextFile(join(target, 'git-push'), 'stale');
    await Deno.writeTextFile(join(target, 'retired-verb'), 'stale');

    const names = await materializeBuiltins(target);
    assertEquals(names, [
      'git-doctor',
      'git-push',
      'pr-comments',
      'pr-reply',
      'pr-resolve',
    ]);
    const present = [...Deno.readDirSync(target)].map((e) => e.name).sort();
    assertEquals(present, names);
    for (const name of names) {
      assertEquals(
        await Deno.readFile(join(target, name)),
        await Deno.readFile(new URL(`../../builtin/${name}`, import.meta.url)),
      );
      assertEquals((await Deno.stat(join(target, name))).mode! & 0o777, 0o755);
    }
    assertEquals((await Deno.stat(target)).mode! & 0o777, 0o700);
    const leftovers = [...Deno.readDirSync(join(dir, 'state'))].map((e) =>
      e.name
    );
    assertEquals(leftovers, ['builtin']);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test('a freshly seeded commands dir holds no built-in', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'devc-bridge-seed-' });
  try {
    const written = await seedCommands(dir);
    assert(written.length > 0, 'seeding wrote nothing at all');
    const present = [...Deno.readDirSync(dir)].map((e) => e.name);
    for (const name of await listBuiltins()) {
      assert(!present.includes(name), `${name} was seeded`);
    }
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test('install-command is gone, and says what replaced it', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'devc-bridge-ic-' });
  try {
    const out = await new Deno.Command(Deno.execPath(), {
      args: [
        'run',
        '-A',
        new URL('../main.ts', import.meta.url).pathname,
        'install-command',
        'git-push',
      ],
      env: { HOME: dir, DEVC_BRIDGE_BASE: join(dir, 'base') },
      stdout: 'piped',
      stderr: 'piped',
    }).output();
    assertEquals(out.code, 1);
    assertStringIncludes(
      new TextDecoder().decode(out.stderr),
      'install-command was removed: capabilities are built in — grant them per container with devc up --bridge-allow',
    );
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
