// devc-bridge's state, as `devc web` shows it: whether the bridge is running, and which active
// markers its state dir holds (`caffeinate` while keepawake holds the host awake).
//
// Read straight from devc-bridge's files on this host, the same way its tray and `devc-bridge
// status` do: every regular file in the state dir is an active marker (`scanActive` in
// devc-bridge/host/core.ts), and the bridge is running when its pidfile names a live pid
// (`status()` in devc-bridge/host/main.ts). No bridge endpoint, no token.
//
// Not to be confused with `herdr_bridge.ts`, which is Herdr's remote-api-bridge, nor with
// `../bridge.ts`, devc's devc-bridge policy and pin integration. This module only reads, and never
// creates devc-bridge's directories.

import { basename, dirname, join } from 'jsr:@std/path';
import { BRIDGE_BASE_SUBPATH } from '@devc-tools/core/bridge.ts';

export interface BridgeStatus {
  /** Pidfile present and its pid alive. */
  running: boolean;
  /** Sorted names of regular files in the state dir, e.g. ["caffeinate"]. [] when none or no dir. */
  active: string[];
}

export interface BridgeStatusPaths {
  /** The active-marker dir (`DEVC_BRIDGE_STATE`, default `<base>/state`). */
  stateDir: string;
  /** The daemon's pidfile, `<base>/tray.pid`. */
  pidfile: string;
}

/** The paths devc-bridge's `loadConfig()` would use, honouring the same overrides. */
export function bridgeStatePaths(
  env: { get(k: string): string | undefined },
  home: string,
): BridgeStatusPaths {
  const base = env.get('DEVC_BRIDGE_BASE') ?? join(home, BRIDGE_BASE_SUBPATH);
  return {
    stateDir: env.get('DEVC_BRIDGE_STATE') ?? join(base, 'state'),
    pidfile: join(base, 'tray.pid'),
  };
}

async function readPid(pidfile: string): Promise<number | null> {
  try {
    const pid = Number((await Deno.readTextFile(pidfile)).trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  try {
    Deno.kill(pid, 'SIGCONT');
    return true;
  } catch {
    return false;
  }
}

async function scanActive(stateDir: string): Promise<string[]> {
  const active: string[] = [];
  try {
    for await (const entry of Deno.readDir(stateDir)) {
      if (entry.isFile) active.push(entry.name);
    }
  } catch { /* no state dir yet: nothing active */ }
  return active.sort();
}

/** The bridge's status now. Never throws. */
export async function readBridgeStatus(
  paths: BridgeStatusPaths,
): Promise<BridgeStatus> {
  const pid = await readPid(paths.pidfile);
  return {
    running: pid !== null && pidAlive(pid),
    active: await scanActive(paths.stateDir),
  };
}

/** Whether two statuses say the same thing. */
export function sameBridgeStatus(a: BridgeStatus, b: BridgeStatus): boolean {
  return a.running === b.running && a.active.length === b.active.length &&
    a.active.every((name, i) => name === b.active[i]);
}

/** How long the watched dirs must be quiet before the status is re-read. */
const DEBOUNCE_MS = 200;
/**
 * The slow cadence: re-read anyway (a bridge killed with `kill -9` leaves its pidfile and
 * markers behind, so only a re-read notices its pid is gone) and retry watching a dir that did
 * not exist yet.
 */
export const BRIDGE_STATUS_POLL_MS = 30_000;

/**
 * Calls `onChange` whenever the bridge's status changes: on events in the state dir (markers)
 * and the pidfile's dir (the bridge starting or stopping), debounced, and on a slow re-read.
 * Only a status that differs from the last one reported is passed on; the first read is always
 * reported. Never throws, and never creates a directory: one that is missing is retried on the
 * slow timer.
 */
export function watchBridgeStatus(
  paths: BridgeStatusPaths,
  onChange: (s: BridgeStatus) => void,
  opts: { debounceMs?: number; pollMs?: number } = {},
): { stop(): void } {
  const debounceMs = opts.debounceMs ?? DEBOUNCE_MS;
  const pollMs = opts.pollMs ?? BRIDGE_STATUS_POLL_MS;
  const pidDir = dirname(paths.pidfile);
  const pidName = basename(paths.pidfile);
  let stopped = false;
  let last: BridgeStatus | null = null;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let reading = false;
  let again = false;

  const refresh = async () => {
    if (reading) {
      again = true;
      return;
    }
    reading = true;
    try {
      do {
        again = false;
        const status = await readBridgeStatus(paths);
        if (stopped) return;
        if (last === null || !sameBridgeStatus(last, status)) {
          last = status;
          try {
            onChange(status);
          } catch { /* the listener's problem */ }
        }
      } while (again && !stopped);
    } finally {
      reading = false;
    }
  };
  const schedule = () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => void refresh(), debounceMs);
  };

  // One watcher per dir; `null` means not watching (missing dir, or the watch ended), retried
  // on each poll.
  const watchers = new Map<string, Deno.FsWatcher | null>();
  const watch = (dir: string, relevant: (path: string) => boolean) => {
    if (stopped || watchers.get(dir)) return;
    let watcher: Deno.FsWatcher;
    try {
      watcher = Deno.watchFs(dir, { recursive: false });
    } catch {
      watchers.set(dir, null);
      return;
    }
    watchers.set(dir, watcher);
    (async () => {
      try {
        for await (const ev of watcher) {
          if (ev.paths.some(relevant)) schedule();
        }
      } catch { /* the watch ended: retried on the next poll */ }
      if (watchers.get(dir) === watcher) watchers.set(dir, null);
    })();
  };
  const watchAll = () => {
    watch(paths.stateDir, () => true);
    if (pidDir !== paths.stateDir) {
      // The pidfile's dir: the pidfile itself, and the state dir appearing when it lives there.
      watch(pidDir, (p) => {
        if (p === paths.stateDir) watchAll();
        return basename(p) === pidName || p === paths.stateDir;
      });
    }
  };

  watchAll();
  void refresh();
  // Retry any dir not yet watched, and re-read: one that just became watchable may have changed
  // while it was not.
  const poll = setInterval(() => {
    watchAll();
    void refresh();
  }, pollMs);

  return {
    stop() {
      stopped = true;
      clearTimeout(debounce);
      clearInterval(poll);
      for (const w of watchers.values()) {
        try {
          w?.close();
        } catch { /* already closed */ }
      }
      watchers.clear();
    },
  };
}
