// Which `devc web` server on this host does the host-wide background work: running the task
// queues and writing the activity log's container events and rollups. Several servers can run at
// once (the CLI or devc-desktop on the default port, each VS Code window's on its own), and they
// share `~/.config/devc`; done by each, a queued task would be sent once per server. The leader is
// the one holding an exclusive lock on `web-leader.lock`. The others try again every few seconds,
// so one takes over when the leader stops or dies (the OS drops a dead process's lock).

import { dirname } from 'jsr:@std/path';
import { CONFIG_DIR } from '@devc-tools/core/default_config.ts';

/** The lock file. Its contents are never read. */
export const LEADER_LOCK_PATH = `${CONFIG_DIR}/web-leader.lock`;
/** How often a server that isn't the leader tries to become it. */
export const LEADER_RETRY_MS = 2_000;

export interface Leadership {
  /** Whether this server holds the lock. Once true, true until `stop`. */
  leading(): boolean;
  /** Stops trying, and releases the lock when held. Idempotent. */
  stop(): void;
}

/**
 * Tries for the lock now and every `retryMs` until it is held, then calls `onLead` once. A lock
 * that can't be opened or tried (an unwritable config folder) is logged and treated as held: that
 * server then works as a lone server always did.
 */
export function lead(
  onLead: () => void,
  opts: {
    path?: string;
    retryMs?: number;
    onError?: (e: unknown) => void;
  } = {},
): Leadership {
  const path = opts.path ?? LEADER_LOCK_PATH;
  const retryMs = opts.retryMs ?? LEADER_RETRY_MS;
  let file: Deno.FsFile | null = null;
  let leading = false;
  let stopped = false;
  /** An attempt is awaiting the open or the lock: {@link close} waits for it to return. */
  let trying = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  // Closing the handle releases the lock.
  const close = () => {
    try {
      file?.close();
    } catch { /* already closed */ }
    file = null;
  };
  const attempt = async () => {
    timer = undefined;
    trying = true;
    let held: boolean;
    try {
      if (file === null) {
        await Deno.mkdir(dirname(path), { recursive: true });
        file = await Deno.open(path, { create: true, write: true });
      }
      held = await file.tryLock(true);
    } catch (e) {
      opts.onError?.(e);
      held = true;
    } finally {
      trying = false;
    }
    if (stopped) {
      close();
      return;
    }
    if (held) {
      leading = true;
      onLead();
    } else {
      timer = setTimeout(() => void attempt(), retryMs);
    }
  };
  void attempt();

  return {
    leading: () => leading,
    stop() {
      if (stopped) return;
      stopped = true;
      leading = false;
      clearTimeout(timer);
      if (!trying) close();
    },
  };
}
