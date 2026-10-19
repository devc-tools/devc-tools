// Account-wide agent usage limits, as `devc web` shows them: the newest observation of each
// agent's rate-limit windows (Claude's 5-hour and 7-day), read from the usage file a status-line
// reporter (`scripts/devc-usage-tap`) writes into the agent's home.
//
// The numbers are account-wide, so every session's report is an observation of the same thing at
// a different time: the newest one is the truth. Each reporter replaces its file atomically
// (temp file, then rename), and when several files belong to one agent (the shared devc
// containers' Claude home and the host's own), the one observed last wins.
//
// "usage" here is rate-limit usage (`rate_limits.*.used_percentage`), not the per-session context
// window, nor the token counts an API response calls `usage`. This module only reads, and never
// creates a directory.

import { basename, dirname, join } from 'jsr:@std/path';
import { CLAUDE_HOME_HOST_DIR } from '@devc-tools/core/default_config.ts';

export interface UsageWindow {
  /** The source's key, e.g. `five_hour`. Never used to pick a rendering. */
  id: string;
  /** Short display label, e.g. `5h`. */
  label: string;
  /** Share of this window's limit already used, 0–100 (100 = limited). */
  usedPercentage: number;
  /** When the window resets, epoch seconds; null when unknown. */
  resetsAt: number | null;
}

export interface UsageSource {
  /** Who wrote the file, e.g. `claude`. Not joined to Herdr's per-pane agent detection. */
  agent: string;
  /** When the reporter saw these numbers, epoch seconds. */
  observedAt: number;
  windows: UsageWindow[];
}

/** The file every reporter writes, in its agent's home. */
export const USAGE_FILE_NAME = 'devc-usage.json';

/**
 * The usage files `devc web` watches on this host, for v1 Claude's: the Claude home devc
 * bind-mounts into every container (`~/.config/devc/.claude`), then the host's own
 * (`$CLAUDE_CONFIG_DIR`, default `~/.claude`). The list is the extension point for other agents.
 */
export function usageFiles(
  env: { get(k: string): string | undefined },
  home: string,
  devcClaudeHome: string = CLAUDE_HOME_HOST_DIR,
): string[] {
  const files = [
    join(devcClaudeHome, USAGE_FILE_NAME),
    join(
      env.get('CLAUDE_CONFIG_DIR') || join(home, '.claude'),
      USAGE_FILE_NAME,
    ),
  ];
  return [...new Set(files)];
}

const isFiniteNumber = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v);
const isNonEmptyString = (v: unknown): v is string =>
  typeof v === 'string' && v !== '';

/** Validates a parsed file; null for anything malformed or with an unknown `v`. */
export function parseUsageFile(json: unknown): UsageSource | null {
  if (typeof json !== 'object' || json === null) return null;
  const f = json as Record<string, unknown>;
  if (
    f.v !== 1 || !isNonEmptyString(f.agent) ||
    !isFiniteNumber(f.observed_at) || !Array.isArray(f.windows)
  ) {
    return null;
  }
  const windows: UsageWindow[] = [];
  for (const raw of f.windows) {
    if (typeof raw !== 'object' || raw === null) return null;
    const w = raw as Record<string, unknown>;
    const resetsAt = w.resets_at ?? null;
    if (
      !isNonEmptyString(w.id) || !isNonEmptyString(w.label) ||
      !isFiniteNumber(w.used_percentage) ||
      (resetsAt !== null && !isFiniteNumber(resetsAt))
    ) {
      return null;
    }
    windows.push({
      id: w.id,
      label: w.label,
      usedPercentage: w.used_percentage,
      resetsAt,
    });
  }
  return { agent: f.agent, observedAt: f.observed_at, windows };
}

/** One file's source now; null when it is missing, unreadable or malformed. Never throws. */
export async function readUsageFile(path: string): Promise<UsageSource | null> {
  try {
    return parseUsageFile(JSON.parse(await Deno.readTextFile(path)));
  } catch {
    return null;
  }
}

/**
 * The sources to show from each file's read (in `files` order, nulls skipped): one per agent, the
 * newest observation (`observedAt`) winning, in the order each agent first appears.
 */
export function mergeUsageSources(
  read: (UsageSource | null)[],
): UsageSource[] {
  const byAgent = new Map<string, UsageSource>();
  for (const s of read) {
    if (s === null) continue;
    const prev = byAgent.get(s.agent);
    if (prev === undefined || s.observedAt > prev.observedAt) {
      byAgent.set(s.agent, s);
    }
  }
  return [...byAgent.values()];
}

/** The sources now, from every file. Never throws. */
export async function readUsage(files: string[]): Promise<UsageSource[]> {
  return mergeUsageSources(await Promise.all(files.map(readUsageFile)));
}

/** How long a watched dir must be quiet before the files are re-read. */
const DEBOUNCE_MS = 200;
/**
 * The slow cadence: re-read anyway (a change the watcher missed, e.g. through a bind mount that
 * delivers no events) and retry watching a dir that did not exist yet.
 */
export const USAGE_POLL_MS = 30_000;

/**
 * Calls `onChange` with every file's sources whenever they change: on events for the files in
 * their dirs (a reporter replaces its file by rename, and the file may not exist yet), debounced,
 * and on a slow re-read. Only sources that differ from the last ones reported are passed on; the
 * first read is always reported. Never throws, and never creates a directory: one that is missing
 * is retried on the slow timer. Malformed or missing files are simply absent from the sources.
 */
export function watchUsage(
  files: string[],
  onChange: (sources: UsageSource[]) => void,
  opts: { debounceMs?: number; pollMs?: number } = {},
): { stop(): void } {
  const debounceMs = opts.debounceMs ?? DEBOUNCE_MS;
  const pollMs = opts.pollMs ?? USAGE_POLL_MS;
  let stopped = false;
  let last: string | null = null;
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
        const sources = await readUsage(files);
        if (stopped) return;
        const key = JSON.stringify(sources);
        if (key !== last) {
          last = key;
          try {
            onChange(sources);
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

  // The file names to listen for, per dir.
  const names = new Map<string, Set<string>>();
  for (const f of files) {
    const dir = dirname(f);
    if (!names.has(dir)) names.set(dir, new Set());
    names.get(dir)!.add(basename(f));
  }
  // One watcher per dir; `null` means not watching (missing dir, or the watch ended), retried on
  // each poll.
  const watchers = new Map<string, Deno.FsWatcher | null>();
  const watch = (dir: string, wanted: Set<string>) => {
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
          if (ev.paths.some((p) => wanted.has(basename(p)))) schedule();
        }
      } catch { /* the watch ended: retried on the next poll */ }
      if (watchers.get(dir) === watcher) watchers.set(dir, null);
    })();
  };
  const watchAll = () => {
    for (const [dir, wanted] of names) watch(dir, wanted);
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
