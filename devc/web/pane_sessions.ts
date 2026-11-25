// Which agent session runs in each pane of a running container, for `devc web`'s `pane_sessions`
// message. The page keeps it on its terminal tiles' saved references (`PaneRef.session`), so a
// tile whose pane is gone after a container rebuild or restart can resume the session in a new
// pane. Pure; `server.ts` gathers the sources.

import type { SessionAgentId } from './agents.ts';

/** One pane's session, as `pane_sessions` lists it. */
export interface PaneSessionEntry {
  pane_id: string;
  agent: SessionAgentId;
  /** The agent's session id: a uuid. */
  session: string;
}

/**
 * The sessions of the panes in `paneIds`, in that order: per pane, the first source that names it
 * wins (`resumed`, the panes this server resumed a session in; then `sent`, the panes sent tasks
 * started; then `running`, the panes live Claude processes run in). Panes no source names, and
 * entries for panes not in `paneIds`, are left out.
 */
export function paneSessionMap(
  paneIds: readonly string[],
  sources: readonly (readonly PaneSessionEntry[])[],
): PaneSessionEntry[] {
  const byPane = new Map<string, PaneSessionEntry>();
  for (const source of sources) {
    for (const e of source) {
      if (!byPane.has(e.pane_id)) byPane.set(e.pane_id, e);
    }
  }
  return paneIds.flatMap((id) => {
    const e = byPane.get(id);
    return e ? [{ pane_id: id, agent: e.agent, session: e.session }] : [];
  });
}

/**
 * The Claude panes (`agent === 'claude'`) of `panes` that no entry of `mapped` names and that
 * were not probed in vain within `retryMs` before `now` (`misses`: pane id → time of the last
 * probe that didn't find it): the panes worth probing for their live Claude session.
 */
export function unmappedClaudePanes(
  panes: readonly { pane_id?: unknown; agent?: unknown }[],
  mapped: readonly PaneSessionEntry[],
  misses: ReadonlyMap<string, number>,
  now: number,
  retryMs: number,
): string[] {
  const known = new Set(mapped.map((e) => e.pane_id));
  return panes.flatMap((p) => {
    if (p.agent !== 'claude' || typeof p.pane_id !== 'string') return [];
    if (known.has(p.pane_id)) return [];
    const missed = misses.get(p.pane_id);
    if (missed !== undefined && now - missed < retryMs) return [];
    return [p.pane_id];
  });
}

/** A session resume's outcome, shared by every request that waited for it. */
export type ResumeOutcome =
  | { ok: true; pane: { pane_id: string; tab_id: string }; reused: boolean }
  | { ok: false; code: string; error: unknown };

/**
 * One resume per key at a time: {@link ResumeGate.once} runs `run` unless a run for the same key
 * is in flight, and then answers with that run's outcome instead, its pane marked `reused`. The
 * check and the registration happen with no await between them, so two requests arriving
 * together never both run. A run that throws is an outcome too (`code`: `errorCode(e)`).
 */
export class ResumeGate {
  readonly #inflight = new Map<string, Promise<ResumeOutcome>>();
  readonly #errorCode: (e: unknown) => string;

  constructor(errorCode: (e: unknown) => string) {
    this.#errorCode = errorCode;
  }

  once(key: string, run: () => Promise<ResumeOutcome>): Promise<ResumeOutcome> {
    const inflight = this.#inflight.get(key);
    if (inflight) {
      return inflight.then((o) => o.ok ? { ...o, reused: true } : o);
    }
    const p = run()
      .catch((e): ResumeOutcome => ({
        ok: false,
        code: this.#errorCode(e),
        error: e,
      }))
      .finally(() => this.#inflight.delete(key));
    this.#inflight.set(key, p);
    return p;
  }
}

/**
 * The entry `find` picks from `cached`; when it picks none, from a fresh listing (`refresh`,
 * which also keeps it). Undefined when neither has it, or the refresh throws.
 */
export async function findListed<T>(
  cached: readonly T[] | undefined,
  find: (list: readonly T[]) => T | undefined,
  refresh: () => Promise<readonly T[]>,
): Promise<T | undefined> {
  const hit = cached ? find(cached) : undefined;
  if (hit !== undefined) return hit;
  try {
    return find(await refresh());
  } catch {
    return undefined;
  }
}
