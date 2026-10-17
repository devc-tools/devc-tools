import { assertEquals } from 'jsr:@std/assert';
import {
  bridgeStatePaths,
  type BridgeStatus,
  readBridgeStatus,
  sameBridgeStatus,
  watchBridgeStatus,
} from '../web/bridge_status.ts';

const env = (vars: Record<string, string>) => ({
  get: (k: string) => vars[k],
});

/** A pid nothing has: above Linux's and macOS's pid ceilings. */
const DEAD_PID = 2 ** 30;

Deno.test('bridgeStatePaths defaults under ~/.config/devc-bridge', () => {
  assertEquals(bridgeStatePaths(env({}), '/home/u'), {
    stateDir: '/home/u/.config/devc-bridge/state',
    pidfile: '/home/u/.config/devc-bridge/tray.pid',
  });
});

Deno.test('bridgeStatePaths honours DEVC_BRIDGE_BASE and DEVC_BRIDGE_STATE', () => {
  assertEquals(bridgeStatePaths(env({ DEVC_BRIDGE_BASE: '/b' }), '/home/u'), {
    stateDir: '/b/state',
    pidfile: '/b/tray.pid',
  });
  assertEquals(
    bridgeStatePaths(
      env({ DEVC_BRIDGE_BASE: '/b', DEVC_BRIDGE_STATE: '/s' }),
      '/home/u',
    ),
    { stateDir: '/s', pidfile: '/b/tray.pid' },
  );
});

Deno.test('readBridgeStatus: no bridge tree at all is not running, nothing active', async () => {
  const base = await Deno.makeTempDir();
  try {
    assertEquals(
      await readBridgeStatus({
        stateDir: `${base}/missing/state`,
        pidfile: `${base}/missing/tray.pid`,
      }),
      { running: false, active: [] },
    );
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});

Deno.test('readBridgeStatus: live pid, sorted regular files only', async () => {
  const base = await Deno.makeTempDir();
  try {
    const paths = { stateDir: `${base}/state`, pidfile: `${base}/tray.pid` };
    await Deno.mkdir(`${base}/state/subdir`, { recursive: true });
    await Deno.writeTextFile(`${base}/state/zeta`, '1');
    await Deno.writeTextFile(`${base}/state/caffeinate`, '123');
    await Deno.writeTextFile(paths.pidfile, `${Deno.pid}\n`);
    assertEquals(await readBridgeStatus(paths), {
      running: true,
      active: ['caffeinate', 'zeta'],
    });
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});

Deno.test('readBridgeStatus: a dead or garbage pid is not running', async () => {
  const base = await Deno.makeTempDir();
  try {
    const paths = { stateDir: `${base}/state`, pidfile: `${base}/tray.pid` };
    await Deno.writeTextFile(paths.pidfile, `${DEAD_PID}`);
    assertEquals((await readBridgeStatus(paths)).running, false);
    await Deno.writeTextFile(paths.pidfile, 'not a pid');
    assertEquals((await readBridgeStatus(paths)).running, false);
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});

Deno.test('sameBridgeStatus compares running and the marker list', () => {
  const a: BridgeStatus = { running: true, active: ['caffeinate'] };
  assertEquals(
    sameBridgeStatus(a, { running: true, active: ['caffeinate'] }),
    true,
  );
  assertEquals(
    sameBridgeStatus(a, { running: false, active: ['caffeinate'] }),
    false,
  );
  assertEquals(sameBridgeStatus(a, { running: true, active: [] }), false);
  assertEquals(
    sameBridgeStatus(a, { running: true, active: ['other'] }),
    false,
  );
});

/** Resolves with the next status `next()` is handed, or rejects after `ms`. */
function statusFeed() {
  const seen: BridgeStatus[] = [];
  let waiter: ((s: BridgeStatus) => void) | null = null;
  return {
    seen,
    onChange(s: BridgeStatus) {
      seen.push(s);
      waiter?.(s);
      waiter = null;
    },
    next(ms = 3000): Promise<BridgeStatus> {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('no status change')),
          ms,
        );
        waiter = (s) => {
          clearTimeout(timer);
          resolve(s);
        };
      });
    },
  };
}

Deno.test('watchBridgeStatus reports the first read, then each change once', async () => {
  const base = await Deno.makeTempDir();
  const paths = { stateDir: `${base}/state`, pidfile: `${base}/tray.pid` };
  await Deno.mkdir(paths.stateDir);
  const feed = statusFeed();
  const first = feed.next();
  const w = watchBridgeStatus(paths, (s) => feed.onChange(s), {
    debounceMs: 20,
  });
  try {
    assertEquals(await first, { running: false, active: [] });

    let next = feed.next();
    await Deno.writeTextFile(`${paths.stateDir}/caffeinate`, '42');
    assertEquals(await next, { running: false, active: ['caffeinate'] });

    next = feed.next();
    await Deno.writeTextFile(paths.pidfile, `${Deno.pid}`);
    assertEquals(await next, { running: true, active: ['caffeinate'] });

    next = feed.next();
    await Deno.remove(`${paths.stateDir}/caffeinate`);
    assertEquals(await next, { running: true, active: [] });

    // A file in the base dir that is not the pidfile (the bridge's log) changes nothing.
    await Deno.writeTextFile(`${base}/devc-bridge.log`, 'line\n');
    await new Promise((r) => setTimeout(r, 150));
    assertEquals(feed.seen.length, 4);
  } finally {
    w.stop();
    await Deno.remove(base, { recursive: true });
  }
});

Deno.test('watchBridgeStatus picks up dirs created after it starts, without creating them', async () => {
  const root = await Deno.makeTempDir();
  const base = `${root}/devc-bridge`;
  const paths = { stateDir: `${base}/state`, pidfile: `${base}/tray.pid` };
  const feed = statusFeed();
  const first = feed.next();
  const w = watchBridgeStatus(paths, (s) => feed.onChange(s), {
    debounceMs: 20,
    pollMs: 100,
  });
  try {
    assertEquals(await first, { running: false, active: [] });
    // It must not have made devc-bridge's tree.
    assertEquals(
      await Deno.stat(base).then(() => true, () => false),
      false,
    );

    await Deno.mkdir(paths.stateDir, { recursive: true });
    await Deno.writeTextFile(`${paths.stateDir}/caffeinate`, '1');
    assertEquals(await feed.next(), { running: false, active: ['caffeinate'] });

    // Later changes keep arriving once the dir exists.
    await new Promise((r) => setTimeout(r, 250));
    const next = feed.next(1000);
    await Deno.remove(`${paths.stateDir}/caffeinate`);
    assertEquals(await next, { running: false, active: [] });
  } finally {
    w.stop();
    await Deno.remove(root, { recursive: true });
  }
});
