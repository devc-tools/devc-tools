// Built-in capabilities: materialized on start, never seeded, run only for a caller whose policy
// grants them — checked by the server on every request, before anything runs — and never
// shadowed by a same-named file in commands/.

import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { join } from '@std/path';
import { builtinCommandNames } from '@devc-tools/core/bridge.ts';
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
 * <name>`), and a `commands/gh-push` and `commands/gh-pr-comments` that must never run. `policy` is the key's policy file
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
  await script(join(commandsDir, 'gh-push'), 'echo shadow');
  await script(join(commandsDir, 'gh-pr-comments'), 'echo shadow');
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

type Resp = {
  ok: boolean;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  error?: string;
};

/** A grant refusal as the server sends it: a normal exit, so the client keeps the code. */
const refused = (exitCode: number, message: string): Resp => ({
  ok: true,
  exitCode,
  stdout: '',
  stderr: `devc-bridge: ${message}\n`,
});

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
  `/r\tgit@github.com:o/r.git\tfeat\t${grants}\t/workspaces/r\n`;

// ── the grant check ─────────────────────────────────────────────────────────────────────────

Deno.test('a granted built-in runs from builtinDir, with the caller key', async () => {
  await withServer(
    policyLine('gh-push,gh-pr-review'),
    async ({ port, token }) => {
      const push = await call(port, token, 'gh-push');
      assertEquals(push, {
        ok: true,
        exitCode: 0,
        stdout: `builtin gh-push key=${KEY}\n`,
        stderr: '',
      } as Resp);
      assertEquals((await call(port, token, 'gh-doctor')).ok, true);
      assertEquals((await call(port, token, 'gh-pr-comments')).ok, true);
      assertEquals((await call(port, token, 'gh-pr-reply')).ok, true);
    },
  );
});

Deno.test('gh-pr-comments runs under either gh-pr-read or gh-pr-review', async () => {
  for (const grants of ['gh-pr-read', 'gh-pr-review']) {
    await withServer(policyLine(grants), async ({ port, token }) => {
      assertEquals(await call(port, token, 'gh-pr-comments'), {
        ok: true,
        exitCode: 0,
        stdout: `builtin gh-pr-comments key=${KEY}\n`,
        stderr: '',
      } as Resp, grants);
    });
  }
  await withServer(
    policyLine('gh-pr-read,gh-pr-viewed'),
    async ({ port, token }) => {
      assertEquals((await call(port, token, 'gh-pr-files')).exitCode, 0);
      assertEquals((await call(port, token, 'gh-pr-viewed')).exitCode, 0);
      assertEquals((await call(port, token, 'gh-pr-reply')).exitCode, 1);
    },
  );
});

Deno.test('a built-in is refused, with the exact message, for each ungranted case', async () => {
  await withServer(null, async ({ port, shared, token, policyFile }) => {
    assertEquals(
      await call(port, shared, 'gh-push'),
      refused(
        1,
        'gh-push needs a per-container token — the shared token has no capabilities',
      ),
    );
    assertEquals(
      await call(port, token, 'gh-push'),
      refused(
        1,
        'no capabilities granted to this container — on the host: devc up --bridge-allow gh-push',
      ),
    );
    assertEquals(
      await call(port, token, 'gh-pr-resolve'),
      refused(
        1,
        'no capabilities granted to this container — on the host: devc up --bridge-allow gh-pr-review,gh-pr-resolve',
      ),
    );
    assertEquals(
      await call(port, token, 'gh-pr-request-review'),
      refused(
        1,
        'no capabilities granted to this container — on the host: devc up --bridge-allow gh-pr-review,gh-pr-request-review',
      ),
    );
    assertEquals(
      await call(port, token, 'gh-pr-comments'),
      refused(
        1,
        'no capabilities granted to this container — on the host: devc up --bridge-allow gh-pr-read',
      ),
    );
    assertEquals(
      await call(port, token, 'gh-pr-viewed'),
      refused(
        1,
        'no capabilities granted to this container — on the host: devc up --bridge-allow gh-pr-read,gh-pr-viewed',
      ),
    );

    await Deno.writeTextFile(policyFile, policyLine('gh-push'));
    assertEquals(
      await call(port, token, 'gh-pr-comments'),
      refused(
        1,
        'gh-pr-comments needs capability gh-pr-read or gh-pr-review, which this container was not granted (it has: gh-push) — on the host: devc up --bridge-allow gh-push,gh-pr-read',
      ),
    );
    assertEquals(
      await call(port, token, 'gh-pr-files'),
      refused(
        1,
        'gh-pr-files needs capability gh-pr-read, which this container was not granted (it has: gh-push) — on the host: devc up --bridge-allow gh-push,gh-pr-read',
      ),
    );
    assertEquals(
      await call(port, token, 'gh-pr-viewed'),
      refused(
        1,
        'gh-pr-viewed needs capability gh-pr-viewed, which this container was not granted (it has: gh-push) — on the host: devc up --bridge-allow gh-push,gh-pr-read,gh-pr-viewed',
      ),
    );
    assertEquals(
      await call(port, token, 'gh-pr-resolve'),
      refused(
        1,
        'gh-pr-resolve needs capability gh-pr-resolve, which this container was not granted (it has: gh-push) — on the host: devc up --bridge-allow gh-push,gh-pr-review,gh-pr-resolve',
      ),
    );

    await Deno.writeTextFile(
      policyFile,
      policyLine('gh-pr-review,gh-pr-resolve'),
    );
    assertEquals(
      await call(port, token, 'gh-pr-request-review'),
      refused(
        1,
        'gh-pr-request-review needs capability gh-pr-request-review, which this container was not granted (it has: gh-pr-review, gh-pr-resolve) — on the host: devc up --bridge-allow gh-pr-review,gh-pr-resolve,gh-pr-request-review',
      ),
    );
  });
});

Deno.test('a broken policy is refused with exit 2, the reason, and a whole-list hint', async () => {
  await withServer(null, async ({ port, token, policyFile }) => {
    const regrant =
      're-run devc up --bridge-allow <every capability this container needs>';

    // A policy from before grants existed: three fields.
    await Deno.writeTextFile(policyFile, '/r\tgit@github.com:o/r.git\tfeat\n');
    assertEquals(
      await call(port, token, 'gh-push'),
      refused(
        2,
        `this container's policy is malformed and grants nothing: line 1: want 5 tab-separated fields, found 3 (${policyFile}) — on the host: ${regrant}`,
      ),
    );

    // A v1 policy, from before targets existed: four fields. It fails closed.
    await Deno.writeTextFile(
      policyFile,
      '/r\tgit@github.com:o/r.git\tfeat\tgh-push\n',
    );
    assertEquals(
      await call(port, token, 'gh-push'),
      refused(
        2,
        `this container's policy is malformed and grants nothing: line 1: want 5 tab-separated fields, found 4 (${policyFile}) — on the host: ${regrant}`,
      ),
    );

    await Deno.writeTextFile(
      policyFile,
      '/r\tgit@github.com:o/r.git\t\tgh-push\t/workspaces/r\n',
    );
    assertEquals(
      await call(port, token, 'gh-pr-comments'),
      refused(
        2,
        `this container's policy is malformed and grants nothing: line 1: branch is empty (${policyFile}) — on the host: ${regrant}`,
      ),
    );

    // A capability this bridge does not know: likely a newer devc than the running bridge.
    await Deno.writeTextFile(policyFile, policyLine('gh-push,gh-nope'));
    assertEquals(
      await call(port, token, 'gh-doctor'),
      refused(
        2,
        `this container's policy is malformed and grants nothing: line 1: unknown capability "gh-nope" (${policyFile}) — on the host: if devc is newer than the running bridge, run devc-bridge restart; otherwise ${regrant}`,
      ),
    );

    for (
      const text of [
        '/r\tgit@github.com:o/r.git\tfeat\n',
        policyLine('gh-push,gh-nope'),
        policyLine('gh-pr-resolve'),
      ]
    ) {
      await Deno.writeTextFile(policyFile, text);
      for (const name of ['gh-push', 'gh-pr-resolve']) {
        const resp = await call(port, token, name);
        assertEquals(resp.exitCode, 2, `${name} ${JSON.stringify(text)}`);
        assert(!resp.stderr!.includes('--bridge-allow gh-'), resp.stderr);
      }
    }

    // Unreadable: a directory where the policy file should be.
    await Deno.remove(policyFile);
    await Deno.mkdir(policyFile);
    const unreadable = await call(port, token, 'gh-push');
    assertEquals(unreadable.ok, true);
    assertEquals(unreadable.exitCode, 2);
    assertEquals(unreadable.stdout, '');
    assertStringIncludes(
      unreadable.stderr!,
      "devc-bridge: this container's policy is unreadable and grants nothing: ",
    );
    assertStringIncludes(
      unreadable.stderr!,
      ` (${policyFile}) — on the host: ${regrant}\n`,
    );
  });
});

Deno.test('a multi-repo policy grants by its one shared grant list', async () => {
  const second =
    `/s\tgit@github.com:o/s.git\tfix\tgh-push,gh-pr-review\t/workspaces/s\n`;
  await withServer(
    policyLine('gh-push,gh-pr-review') + second,
    async ({ port, token, policyFile }) => {
      assertEquals((await call(port, token, 'gh-push')).ok, true);
      assertEquals((await call(port, token, 'gh-pr-reply')).ok, true);
      assertEquals(
        await call(port, token, 'gh-pr-resolve'),
        refused(
          1,
          'gh-pr-resolve needs capability gh-pr-resolve, which this container was not granted (it has: gh-push, gh-pr-review) — on the host: devc up --bridge-allow gh-push,gh-pr-review,gh-pr-resolve',
        ),
      );
      // Grants that differ between lines are malformed: one list for every repo, or none.
      await Deno.writeTextFile(
        policyFile,
        policyLine('gh-push,gh-pr-review') +
          second.replace(',gh-pr-review', ''),
      );
      const resp = await call(port, token, 'gh-push');
      assertEquals(resp.exitCode, 2);
      assertStringIncludes(resp.stderr!, "line 2: grants differ from line 1's");
    },
  );
});

Deno.test('the policy is read per request: deleting it revokes without a restart', async () => {
  await withServer(
    policyLine('gh-push'),
    async ({ port, token, policyFile }) => {
      assertEquals((await call(port, token, 'gh-push')).ok, true);
      await Deno.remove(policyFile);
      const after = await call(port, token, 'gh-push');
      assertEquals(after.exitCode, 1);
      assertStringIncludes(after.stderr!, 'no capabilities granted');
    },
  );
});

Deno.test('a commands/ file named like a built-in is never run, and is reported on start', async () => {
  await withServer(policyLine('gh-push'), async ({ port, token, logs }) => {
    assertEquals(
      (await call(port, token, 'gh-push')).stdout,
      `builtin gh-push key=${KEY}\n`,
    );
    assert(
      logs.includes(
        'commands/gh-push is shadowed by the built-in gh-push — remove it',
      ),
      logs.join('\n'),
    );
    // gh-pr-comments belongs to two capabilities, and is still reported once.
    assertEquals(
      logs.filter((l) =>
        l ===
          'commands/gh-pr-comments is shadowed by the built-in gh-pr-comments — remove it'
      ).length,
      1,
      logs.join('\n'),
    );
  });
});

Deno.test('a pre-rename command name is an unknown command, with no hint', async () => {
  await withServer(
    policyLine('gh-push,gh-pr-review'),
    async ({ port, token }) => {
      for (const old of ['git-push', 'git-doctor', 'pr-comments', 'pr-reply']) {
        assertEquals(await call(port, token, old), {
          ok: false,
          error: `unknown command: ${old}`,
        });
      }
    },
  );
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
    await Deno.writeTextFile(join(target, 'gh-push'), 'stale');
    await Deno.writeTextFile(join(target, 'retired-verb'), 'stale');
    await Deno.writeTextFile(join(target, 'git-push'), 'stale'); // a pre-rename name

    const names = await materializeBuiltins(target);
    assertEquals(names, [
      'gh-doctor',
      'gh-pr-comments',
      'gh-pr-files',
      'gh-pr-reply',
      'gh-pr-request-review',
      'gh-pr-resolve',
      'gh-pr-viewed',
      'gh-push',
    ]);
    // The bridge dispatches by file name: the built-ins are exactly the capability map's commands.
    assertEquals(builtinCommandNames().sort(), names);
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
        'gh-push',
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
