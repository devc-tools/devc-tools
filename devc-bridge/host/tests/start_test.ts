// `devc-bridge start`'s contract, end to end against a real background process:
// spawn detached, wait for the pidfile, and leave something listening behind that
// outlives the command you typed.
//
// This is an integration test on purpose. The interesting failure — `start`
// returning while nothing is actually running, or the child dying with its output
// nowhere — is invisible to a unit test of any one piece. It needs no GUI and no
// macOS: the bridge is headless now, which is the whole point of the change.

import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { join } from '@std/path';
import { relaunchArgv } from '../main.ts';

const decoder = new TextDecoder();

interface Cli {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run the CLI from source, against an isolated config base. */
async function cli(
  base: string,
  port: number,
  ...args: string[]
): Promise<Cli> {
  const [command, ...argv] = relaunchArgv(args, {
    standalone: false,
    execPath: Deno.execPath(),
    mainModule: new URL('../main.ts', import.meta.url).href,
  });
  const out = await new Deno.Command(command, {
    args: argv,
    env: {
      // HOME too: every start materializes the built-ins under ~/.local/state/devc-bridge.
      HOME: base,
      DEVC_BRIDGE_BASE: base,
      DEVC_BRIDGE_HOST: '127.0.0.1',
      DEVC_BRIDGE_PORT: String(port),
    },
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  return {
    code: out.code,
    stdout: decoder.decode(out.stdout),
    stderr: decoder.decode(out.stderr),
  };
}

/** A port nothing is listening on right now. */
function freePort(): number {
  const listener = Deno.listen({ hostname: '127.0.0.1', port: 0 });
  const { port } = listener.addr as Deno.NetAddr;
  listener.close();
  return port;
}

function alive(pid: number): boolean {
  try {
    Deno.kill(pid, 'SIGCONT'); // benign to a live process; ESRCH when gone
    return true;
  } catch {
    return false;
  }
}

function pidOf(out: string): number {
  const m = out.match(/\(pid (\d+)\)/);
  assert(m, `no pid in ${JSON.stringify(out)}`);
  return Number(m[1]);
}

Deno.test('start: detaches, comes up, and stop takes it down', async () => {
  const base = await Deno.makeTempDir({ prefix: 'devc-bridge-start-' });
  const port = freePort();
  let pid = 0;
  try {
    const started = await cli(base, port, 'start');
    assertEquals(started.code, 0, started.stderr);
    assertStringIncludes(started.stdout, 'started (pid ');
    pid = pidOf(started.stdout);

    // The child outlives `start`: this process already reaped the command above.
    assert(alive(pid), 'the started bridge is not running');
    assertEquals(
      (await Deno.readTextFile(join(base, 'tray.pid'))).trim(),
      String(pid),
    );

    // It is a bridge, not just a process: the port answers.
    const conn = await Deno.connect({ hostname: '127.0.0.1', port });
    conn.close();

    // Closing the terminal that ran `start` must not take the bridge with it —
    // the child is still in that terminal's process group.
    Deno.kill(pid, 'SIGHUP');
    await new Promise((r) => setTimeout(r, 300));
    assert(alive(pid), 'the bridge died on SIGHUP');

    // Its stdout went to the log file — that redirect is what `start` tails when a
    // launch fails, so an empty log would make every future failure unreadable.
    const log = await Deno.readTextFile(join(base, 'devc-bridge.log'));
    assertStringIncludes(log, `listening on 127.0.0.1:${port}`);

    // Config seeding still happens on the way through.
    const seeded = [...Deno.readDirSync(join(base, 'commands'))].map((e) =>
      e.name
    );
    assert(seeded.includes('caffeinate'), `seeded: ${seeded}`);

    // A second start must report the running one, never race it for the port.
    const again = await cli(base, port, 'start');
    assertEquals(again.code, 0, again.stderr);
    assertStringIncludes(again.stdout, `already running (pid ${pid})`);

    const status = await cli(base, port, 'status');
    assertEquals(status.code, 0, status.stderr);
    assertStringIncludes(status.stdout, `running (pid ${pid})`);
    assertStringIncludes(status.stdout, 'idle');
    // The dev-override client, which is all this directory reports now — containers get
    // their client from the Feature, not from the host.
    assertStringIncludes(status.stdout, 'client override: none');

    const stopped = await cli(base, port, 'stop');
    assertEquals(stopped.code, 0, stopped.stderr);
    assertStringIncludes(stopped.stdout, 'stopped');
    assert(!alive(pid), 'the bridge survived stop');
    assertEquals(await exists(join(base, 'tray.pid')), false);
    pid = 0;

    // And `status` agrees, with the exit code scripts key off.
    const after = await cli(base, port, 'status');
    assertEquals(after.code, 1);
    assertStringIncludes(after.stdout, 'stopped');
  } finally {
    if (pid !== 0) {
      try {
        Deno.kill(pid, 'SIGKILL');
      } catch { /* already gone */ }
    }
    await Deno.remove(base, { recursive: true });
  }
});

Deno.test('start: refuses when the port is taken but no pidfile explains it', async () => {
  const base = await Deno.makeTempDir({ prefix: 'devc-bridge-port-' });
  const port = freePort();
  const squatter = Deno.listen({ hostname: '127.0.0.1', port });
  try {
    const out = await cli(base, port, 'start');
    assertEquals(out.code, 1);
    assertStringIncludes(out.stderr, 'is already in use');
    assertStringIncludes(out.stderr, `lsof -i :${port}`);
    // Nothing was launched, so nothing wrote a pidfile.
    assertEquals(await exists(join(base, 'tray.pid')), false);
  } finally {
    squatter.close();
    await Deno.remove(base, { recursive: true });
  }
});

Deno.test('run: rejects an unknown option instead of serving', async () => {
  const base = await Deno.makeTempDir({ prefix: 'devc-bridge-run-' });
  const port = freePort();
  try {
    const out = await cli(base, port, 'run', '--nope');
    assertEquals(out.code, 2);
    assertStringIncludes(out.stderr, 'unknown run option "--nope"');
    assertStringIncludes(out.stderr, 'run [--tray]');
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch {
    return false;
  }
}
