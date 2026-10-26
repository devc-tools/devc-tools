// `devc web`'s activity log: how time is spent, by the user and by agents, per Herdr pane. The
// server appends state changes to `~/.config/devc/activity/YYYY-MM-DD.jsonl` (the raw log), and
// `rollupDay` turns a day of them into rows of time per container, repo, branch and agent, kept in
// `~/.config/devc/activity/rollup/YYYY-MM-DD.json` for other tools (`devc time`, the cockpit).
// See `.plans/archived/devc-web-activity-tracking.md`.
//
// Not `usage.ts`: "usage" in devc web means account rate limits. Code here says `activity`. Local
// only: titles can hold task text, and nothing is sent anywhere.

import { dirname } from 'jsr:@std/path';
import { CONFIG_DIR } from '@devc-tools/core/default_config.ts';

/** The raw logs' folder. */
export const ACTIVITY_DIR = `${CONFIG_DIR}/activity`;
/** No input for this long and the user is idle. */
export const IDLE_MS = 300_000;
/** At most one `input` event per pane per client this often. */
export const INPUT_THROTTLE_MS = 30_000;
/** How often the server rewrites today's rollup. */
export const ROLLUP_EVERY_MS = 300_000;
/** Raw logs older than this many days are deleted, once their day's rollup is complete. */
export const RAW_RETENTION_DAYS = 90;

/** The rollups' folder for raw logs in `dir`. */
export function rollupDir(dir = ACTIVITY_DIR): string {
  return `${dir}/rollup`;
}

// ---------------------------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------------------------

/** What a pane is doing, as the log has it: Herdr's own values. */
export interface PaneFacts {
  container: string;
  pane: string;
  terminal: string | null;
  agent: string | null;
  title: string | null;
  cwd: string | null;
  /** The host folder of the repo the pane's folder is in. */
  repo: string | null;
  branch: string | null;
  /** The task's session id, for a pane a sent task started. */
  sessionId?: string;
}

export type ActivityEvent =
  & { t: string }
  & (
    | { e: 'server'; state: 'start' | 'stop' }
    | {
      e: 'agent';
      container: string;
      pane: string;
      terminal: string | null;
      agent: string | null;
      /** Herdr's: `working`, `blocked`, `idle`, `unknown` (and `done`). */
      status: string;
    }
    | ({ e: 'pane' } & PaneFacts)
    | { e: 'input'; container: string; pane: string; client: string }
    | {
      e: 'focus';
      client: string;
      visible: boolean;
      focused: boolean;
      container?: string;
      pane?: string;
    }
  );

/** An event without its time: what the recorder is given. */
export type ActivityRecord = ActivityEvent extends infer E
  ? E extends { t: string } ? Omit<E, 't'> : never
  : never;

const pad = (n: number, w = 2) => String(Math.abs(n)).padStart(w, '0');

/** `d`'s local date, `YYYY-MM-DD`. */
export function localDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** `d` as ISO 8601 in local time, with its offset (`2026-10-25T09:30:00.000-05:00`). */
export function localIso(d: Date): string {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return `${localDate(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${
    pad(d.getSeconds())
  }.${pad(d.getMilliseconds(), 3)}${sign}${pad(Math.trunc(off / 60))}:${
    pad(off % 60)
  }`;
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Local midnight at the start of `date` (`YYYY-MM-DD`). */
function midnight(date: string, plusDays = 0): Date {
  const m = date.match(DATE);
  if (!m) throw new Error(`not a date: ${date}`);
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + plusDays);
}

/** `date` moved by `n` days. */
export function addDays(date: string, n: number): string {
  return localDate(midnight(date, n));
}

const isStr = (v: unknown): v is string => typeof v === 'string';
const strOrNull = (v: unknown): v is string | null => v === null || isStr(v);

function isEvent(v: unknown): v is ActivityEvent {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  if (!isStr(o.t) || !Number.isFinite(Date.parse(o.t))) return false;
  switch (o.e) {
    case 'server':
      return o.state === 'start' || o.state === 'stop';
    case 'agent':
      return isStr(o.container) && isStr(o.pane) && isStr(o.status) &&
        strOrNull(o.agent ?? null) && strOrNull(o.terminal ?? null);
    case 'pane':
      return isStr(o.container) && isStr(o.pane) &&
        strOrNull(o.repo ?? null) && strOrNull(o.branch ?? null) &&
        strOrNull(o.title ?? null) && strOrNull(o.agent ?? null);
    case 'input':
      return isStr(o.container) && isStr(o.pane) && isStr(o.client);
    case 'focus':
      return isStr(o.client) && typeof o.visible === 'boolean' &&
        typeof o.focused === 'boolean';
    default:
      return false;
  }
}

/** A raw log's events. A line that is cut off, isn't JSON or isn't an event is skipped. */
export function parseEvents(text: string): ActivityEvent[] {
  const out: ActivityEvent[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line);
      if (isEvent(v)) out.push(v);
    } catch { /* a cut-off or broken line */ }
  }
  return out;
}

/** The raw log of `date`. */
export function rawLogPath(date: string, dir = ACTIVITY_DIR): string {
  return `${dir}/${date}.jsonl`;
}

/** `date`'s events; none when there is no log. */
export async function readDayEvents(
  date: string,
  dir = ACTIVITY_DIR,
): Promise<ActivityEvent[]> {
  try {
    return parseEvents(await Deno.readTextFile(rawLogPath(date, dir)));
  } catch {
    return [];
  }
}

/**
 * What `rollupDay(date, …)` needs: the day before (what was going on at midnight), the day, and
 * the day after (where a span running past midnight ends).
 */
export async function eventsAround(
  date: string,
  dir = ACTIVITY_DIR,
): Promise<ActivityEvent[]> {
  const days = await Promise.all(
    [-1, 0, 1].map((n) => readDayEvents(addDays(date, n), dir)),
  );
  return days.flat();
}

// ---------------------------------------------------------------------------------------------
// Rollups
// ---------------------------------------------------------------------------------------------

export interface ActivityRow {
  date: string; // YYYY-MM-DD
  container: string; // localFolder
  repo: string | null;
  branch: string | null;
  agent: string | null; // null on a user row
  title: string | null; // the title with the most time in this row's group (for display)
  userActiveMs: number;
  agentWorkingMs: number;
  agentBlockedMs: number;
}

export interface RollupFile {
  version: 1;
  date: string;
  complete: boolean;
  rows: ActivityRow[];
}

type Field = 'userActiveMs' | 'agentWorkingMs' | 'agentBlockedMs';

/**
 * A day's time, by (container, repo, branch, agent), from the events around it (any order; see
 * {@link eventsAround}).
 *
 * - User time: from an `input` to the client's next one or `idleMs` after it, only while that
 *   client's latest `focus` is visible and focused (losing either ends it), attributed to the
 *   pane's repo and branch then. A switch to another pane (a visible, focused `focus` on a pane
 *   other than the one the client was last focused on) is a move to another task: it ends the
 *   old pane's span and starts one on the new pane, as an `input` there would. Clients on the
 *   same pane at once count once.
 * - Agent time: from an `agent` event to the pane's next one; `working` and `blocked` count.
 * - A `server` event ends everything. A missing `stop` is one at the last event before the next
 *   `start` (or the last event of all): nothing counts in between.
 * - Spans are cut at the day's local midnights.
 */
export function rollupDay(
  date: string,
  events: ActivityEvent[],
  idleMs = IDLE_MS,
): ActivityRow[] {
  const dayStart = midnight(date).getTime();
  const dayEnd = midnight(date, 1).getTime();
  const sorted = events
    .map((e, i) => ({ e, ms: Date.parse(e.t), i }))
    .filter((x) => Number.isFinite(x.ms))
    .sort((a, b) => a.ms - b.ms || a.i - b.i);

  const paneKey = (container: string, pane: string) => `${container}\n${pane}`;
  const panes = new Map<string, PaneFacts>();
  const agents = new Map<string, { agent: string | null; status: string }>();
  const clients = new Map<
    string,
    {
      visible: boolean;
      focused: boolean;
      input: { pane: string; container: string; until: number } | null;
      /** The pane the client was last visible and focused on (`paneKey`). */
      on: string | null;
    }
  >();
  const clientOf = (id: string) => {
    let c = clients.get(id);
    if (!c) {
      c = { visible: false, focused: false, input: null, on: null };
      clients.set(id, c);
    }
    return c;
  };
  const groups = new Map<
    string,
    { row: ActivityRow; titles: Map<string, number> }
  >();

  const add = (
    from: number,
    to: number,
    container: string,
    pane: string,
    agent: string | null,
    field: Field,
  ) => {
    const ms = Math.min(to, dayEnd) - Math.max(from, dayStart);
    if (ms <= 0) return;
    const facts = panes.get(paneKey(container, pane));
    const repo = facts?.repo ?? null;
    const branch = facts?.branch ?? null;
    const key = JSON.stringify([container, repo, branch, agent]);
    let g = groups.get(key);
    if (!g) {
      g = {
        row: {
          date,
          container,
          repo,
          branch,
          agent,
          title: null,
          userActiveMs: 0,
          agentWorkingMs: 0,
          agentBlockedMs: 0,
        },
        titles: new Map(),
      };
      groups.set(key, g);
    }
    g.row[field] += ms;
    if (facts?.title) {
      g.titles.set(facts.title, (g.titles.get(facts.title) ?? 0) + ms);
    }
  };

  const accumulate = (a: number, b: number) => {
    if (b <= a) return;
    for (const [k, s] of agents) {
      if (s.status !== 'working' && s.status !== 'blocked') continue;
      const [container, pane] = k.split('\n');
      const agent = s.agent ?? panes.get(k)?.agent ?? 'unknown';
      add(
        a,
        b,
        container,
        pane,
        agent,
        s.status === 'working' ? 'agentWorkingMs' : 'agentBlockedMs',
      );
    }
    // Every active client's span starts at `a`: their union on a pane ends at the latest end.
    const ends = new Map<string, number>();
    for (const c of clients.values()) {
      if (!c.visible || !c.focused || !c.input) continue;
      const end = Math.min(b, c.input.until);
      if (end <= a) continue;
      const k = paneKey(c.input.container, c.input.pane);
      ends.set(k, Math.max(ends.get(k) ?? a, end));
    }
    for (const [k, end] of ends) {
      const [container, pane] = k.split('\n');
      add(a, end, container, pane, null, 'userActiveMs');
    }
  };

  let prev: number | null = null;
  for (const { e, ms } of sorted) {
    // A `start` with no `stop` before it: the last server stopped at the event before this one.
    if (prev !== null && !(e.e === 'server' && e.state === 'start')) {
      accumulate(prev, ms);
    }
    prev = ms;
    switch (e.e) {
      case 'server':
        agents.clear();
        clients.clear();
        break;
      case 'agent':
        agents.set(paneKey(e.container, e.pane), {
          agent: e.agent ?? null,
          status: e.status,
        });
        break;
      case 'pane':
        panes.set(paneKey(e.container, e.pane), {
          container: e.container,
          pane: e.pane,
          terminal: e.terminal ?? null,
          agent: e.agent ?? null,
          title: e.title ?? null,
          cwd: e.cwd ?? null,
          repo: e.repo ?? null,
          branch: e.branch ?? null,
        });
        break;
      case 'input':
        clientOf(e.client).input = {
          container: e.container,
          pane: e.pane,
          until: ms + idleMs,
        };
        break;
      case 'focus': {
        const c = clientOf(e.client);
        c.visible = e.visible;
        c.focused = e.focused;
        // A hidden or unfocused page is idle at once.
        if (!e.visible || !e.focused) {
          c.input = null;
          break;
        }
        if (e.container === undefined || e.pane === undefined) break;
        const k = paneKey(e.container, e.pane);
        // A switch from another pane: work moved here. Not on the client's first pane or on
        // coming back to the same one.
        if (c.on !== null && c.on !== k) {
          c.input = {
            container: e.container,
            pane: e.pane,
            until: ms + idleMs,
          };
        }
        c.on = k;
        break;
      }
    }
  }

  const rows = [...groups.values()].map(({ row, titles }) => {
    let best: string | null = null;
    let bestMs = -1;
    for (const [title, ms] of titles) {
      if (ms > bestMs) [best, bestMs] = [title, ms];
    }
    return { ...row, title: best };
  });
  const s = (v: string | null) => v ?? '';
  return rows.sort((a, b) =>
    a.container.localeCompare(b.container) ||
    s(a.repo).localeCompare(s(b.repo)) ||
    s(a.branch).localeCompare(s(b.branch)) ||
    s(a.agent).localeCompare(s(b.agent))
  );
}

/** The rollup file of `date`. */
export function rollupPath(date: string, dir = ACTIVITY_DIR): string {
  return `${rollupDir(dir)}/${date}.json`;
}

function isRow(v: unknown): v is ActivityRow {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  const num = (k: string) => typeof r[k] === 'number';
  return isStr(r.date) && isStr(r.container) && strOrNull(r.repo) &&
    strOrNull(r.branch) && strOrNull(r.agent) && strOrNull(r.title) &&
    num('userActiveMs') && num('agentWorkingMs') && num('agentBlockedMs');
}

/** `date`'s rollup; null when there is none or it can't be read. */
export async function readRollup(
  date: string,
  dir = ACTIVITY_DIR,
): Promise<RollupFile | null> {
  let data: unknown;
  try {
    data = JSON.parse(await Deno.readTextFile(rollupPath(date, dir)));
  } catch {
    return null;
  }
  const f = data as Partial<RollupFile> | null;
  if (
    f?.version !== 1 || f.date !== date || typeof f.complete !== 'boolean' ||
    !Array.isArray(f.rows)
  ) {
    return null;
  }
  return { version: 1, date, complete: f.complete, rows: f.rows.filter(isRow) };
}

/** Writes a rollup atomically (a temp file renamed over the old one), as `pinned_files.ts` does. */
export async function writeRollup(
  file: RollupFile,
  dir = ACTIVITY_DIR,
): Promise<void> {
  const path = rollupPath(file.date, dir);
  const folder = dirname(path);
  await Deno.mkdir(folder, { recursive: true });
  const tmp = await Deno.makeTempFile({ dir: folder, prefix: '.rollup-' });
  try {
    await Deno.writeTextFile(tmp, JSON.stringify(file, null, 2) + '\n');
    await Deno.rename(tmp, path);
  } catch (e) {
    await Deno.remove(tmp).catch(() => {});
    throw e;
  }
}

/**
 * Rolls `date` up from its raw logs and writes it. `until`: the server is running, so what is
 * still going on counts up to then (a `stop` at `until`, not written to the log).
 */
export async function writeDayRollup(
  date: string,
  opts: { complete: boolean; until?: Date; dir?: string },
): Promise<RollupFile> {
  const dir = opts.dir ?? ACTIVITY_DIR;
  const events = await eventsAround(date, dir);
  if (opts.until) {
    events.push({ t: localIso(opts.until), e: 'server', state: 'stop' });
  }
  const file: RollupFile = {
    version: 1,
    date,
    complete: opts.complete,
    rows: rollupDay(date, events),
  };
  await writeRollup(file, dir);
  return file;
}

/** The dates that have a raw log in `dir`, oldest first. */
export async function rawLogDates(dir = ACTIVITY_DIR): Promise<string[]> {
  const dates: string[] = [];
  try {
    for await (const e of Deno.readDir(dir)) {
      const m = e.isFile ? e.name.match(/^(\d{4}-\d{2}-\d{2})\.jsonl$/) : null;
      if (m) dates.push(m[1]);
    }
  } catch { /* no folder yet */ }
  return dates.sort();
}

/**
 * At startup: writes every past day's rollup that is missing or incomplete (`complete: true`),
 * then deletes raw logs older than `retentionDays` whose rollup is complete.
 */
export async function catchUpRollups(
  today: string,
  dir = ACTIVITY_DIR,
  retentionDays = RAW_RETENTION_DAYS,
): Promise<void> {
  const dates = await rawLogDates(dir);
  for (const date of dates) {
    if (date >= today) continue;
    if ((await readRollup(date, dir))?.complete) continue;
    await writeDayRollup(date, { complete: true, dir });
  }
  const oldest = addDays(today, -retentionDays);
  for (const date of dates) {
    if (date >= oldest) continue;
    if (!(await readRollup(date, dir))?.complete) continue;
    await Deno.remove(rawLogPath(date, dir)).catch(() => {});
  }
}

// ---------------------------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------------------------

/** A repo a container has, as far as the log needs it (`git_repo.ts`'s `MountedRepo`). */
export interface RepoAt {
  folder: string;
  containerFolder: string | null;
}

/**
 * A snapshot pane's facts for the log: its folder (`foreground_cwd`, else `cwd`, as the page's
 * tab shows its repo) mapped to the deepest repo whose container folder holds it, and that repo's
 * branch from `branchOf`. Null without a `pane_id`.
 */
export function paneFacts(
  container: string,
  pane: Record<string, unknown>,
  repos: readonly RepoAt[],
  branchOf: (folder: string) => string | null,
): PaneFacts | null {
  if (!isStr(pane.pane_id) || pane.pane_id === '') return null;
  const str = (v: unknown) => isStr(v) && v !== '' ? v : null;
  const cwd = str(pane.foreground_cwd) ?? str(pane.cwd);
  let repo: string | null = null;
  let depth = -1;
  for (const r of repos) {
    const dir = r.containerFolder?.replace(/\/+$/, '');
    if (!dir || !cwd) continue;
    if ((cwd === dir || cwd.startsWith(`${dir}/`)) && dir.length > depth) {
      repo = r.folder;
      depth = dir.length;
    }
  }
  return {
    container,
    pane: pane.pane_id,
    terminal: str(pane.terminal_id),
    agent: str(pane.agent),
    title: str(pane.terminal_title_stripped) ?? str(pane.label),
    cwd,
    repo,
    branch: repo === null ? null : branchOf(repo),
  };
}

/** The `pane` event's compared fields. */
const sameFacts = (a: PaneFacts, b: PaneFacts) =>
  a.title === b.title && a.cwd === b.cwd && a.repo === b.repo &&
  a.branch === b.branch && a.agent === b.agent &&
  a.sessionId === b.sessionId;

/** A page's state, as its `focus` events say. */
interface ClientFocus {
  visible: boolean;
  focused: boolean;
  container?: string;
  pane?: string;
}

/**
 * Turns what the server observes into log events: only changes, with `input` throttled. Writes go
 * through `append` in order; `now` is the clock.
 */
export class ActivityRecorder {
  #append: (line: string, date: string) => Promise<void>;
  #now: () => Date;
  #onError: (e: unknown) => void;
  #queue: Promise<void> = Promise.resolve();
  #panes = new Map<string, PaneFacts>();
  #agents = new Map<
    string,
    { agent: string | null; status: string; terminal: string | null }
  >();
  #inputs = new Map<string, number>();
  #focus = new Map<string, ClientFocus>();

  constructor(opts: {
    /** Appends one line to `date`'s raw log. Default: the file in {@link ACTIVITY_DIR}. */
    append?: (line: string, date: string) => Promise<void>;
    now?: () => Date;
    onError?: (e: unknown) => void;
    dir?: string;
  } = {}) {
    const dir = opts.dir ?? ACTIVITY_DIR;
    this.#append = opts.append ?? (async (line, date) => {
      await Deno.mkdir(dir, { recursive: true });
      await Deno.writeTextFile(rawLogPath(date, dir), line, { append: true });
    });
    this.#now = opts.now ?? (() => new Date());
    this.#onError = opts.onError ?? (() => {});
  }

  #write(ev: ActivityRecord): void {
    const now = this.#now();
    const line = JSON.stringify({ t: localIso(now), ...ev }) + '\n';
    const date = localDate(now);
    this.#queue = this.#queue
      .then(() => this.#append(line, date))
      .catch(this.#onError);
  }

  /** Waits for every event recorded so far to be written. */
  flush(): Promise<void> {
    return this.#queue;
  }

  server(state: 'start' | 'stop'): void {
    this.#write({ e: 'server', state });
  }

  /** A pane seen in a snapshot or a `pane_updated`: a `pane` event on first sight or a change. */
  pane(facts: PaneFacts, status?: unknown): void {
    const k = `${facts.container}\n${facts.pane}`;
    const prev = this.#panes.get(k);
    if (!prev || !sameFacts(prev, facts)) {
      this.#panes.set(k, facts);
      this.#write({ e: 'pane', ...facts });
    }
    // An agent's status from a snapshot: once per agent pane (startup, a new agent), and when
    // its agent goes. Herdr's status events cover the rest.
    const known = this.#agents.get(k);
    if (facts.agent !== null && isStr(status)) {
      if (!known || known.agent !== facts.agent) {
        this.agentStatus(
          facts.container,
          facts.pane,
          facts.terminal,
          facts.agent,
          status,
        );
      }
    } else if (facts.agent === null && known) {
      this.#agentGone(k, known, facts.container, facts.pane);
    }
  }

  /**
   * A container's snapshot: each pane as {@link pane}, then the panes it no longer has are
   * forgotten (an agent's ends as `unknown`).
   */
  snapshot(
    container: string,
    panes: { facts: PaneFacts; status?: unknown }[],
  ): void {
    for (const p of panes) this.pane(p.facts, p.status);
    const live = new Set(panes.map((p) => p.facts.pane));
    this.#forget(container, (pane) => !live.has(pane));
  }

  /** The container stopped, or its session went: every pane of it is forgotten. */
  containerGone(container: string): void {
    this.#forget(container, () => true);
  }

  #forget(container: string, gone: (pane: string) => boolean): void {
    for (const k of [...this.#panes.keys(), ...this.#agents.keys()]) {
      const [c, pane] = k.split('\n');
      if (c !== container || !gone(pane)) continue;
      this.#panes.delete(k);
      const known = this.#agents.get(k);
      if (known) this.#agentGone(k, known, c, pane);
    }
  }

  #agentGone(
    k: string,
    known: { agent: string | null; terminal: string | null },
    container: string,
    pane: string,
  ): void {
    this.#agents.delete(k);
    this.#write({
      e: 'agent',
      container,
      pane,
      terminal: known.terminal,
      agent: known.agent,
      status: 'unknown',
    });
  }

  /** Herdr's `pane.agent_status_changed`. A repeat of the last status writes nothing. */
  agentStatus(
    container: string,
    pane: string,
    terminal: string | null,
    agent: string | null,
    status: string,
  ): void {
    const k = `${container}\n${pane}`;
    const known = this.#agents.get(k);
    const term = terminal ?? known?.terminal ??
      this.#panes.get(k)?.terminal ?? null;
    if (known && known.agent === agent && known.status === status) return;
    this.#agents.set(k, { agent, status, terminal: term });
    this.#write({ e: 'agent', container, pane, terminal: term, agent, status });
  }

  /** A page's `input`, `mouse` or `scroll` for a pane: at most one event per throttle window. */
  input(client: string, container: string, pane: string): void {
    const k = `${client}\n${container}\n${pane}`;
    const now = this.#now().getTime();
    const last = this.#inputs.get(k);
    if (last !== undefined && now - last < INPUT_THROTTLE_MS) return;
    this.#inputs.set(k, now);
    this.#write({ e: 'input', container, pane, client });
  }

  /**
   * A page's `page_state` (`visible`, `focused`) or `active_pane` (`active`; null: none). A
   * `focus` event when what the client's page is in changes.
   */
  focus(
    client: string,
    change: {
      visible?: boolean;
      focused?: boolean;
      active?: { container: string; pane: string } | null;
    },
  ): void {
    const prev = this.#focus.get(client) ?? { visible: false, focused: false };
    const next: ClientFocus = {
      visible: change.visible ?? prev.visible,
      focused: change.focused ?? prev.focused,
    };
    const active = change.active === undefined
      ? (prev.container !== undefined
        ? { container: prev.container, pane: prev.pane! }
        : null)
      : change.active;
    if (active) {
      next.container = active.container;
      next.pane = active.pane;
    }
    const had = this.#focus.has(client);
    this.#focus.set(client, next);
    if (
      had && prev.visible === next.visible && prev.focused === next.focused &&
      prev.container === next.container && prev.pane === next.pane
    ) {
      return;
    }
    this.#write({ e: 'focus', client, ...next });
  }

  /** The client disconnected: not visible, not focused, and forgotten. */
  clientGone(client: string): void {
    for (const k of this.#inputs.keys()) {
      if (k.startsWith(`${client}\n`)) this.#inputs.delete(k);
    }
    if (!this.#focus.delete(client)) return;
    this.#write({ e: 'focus', client, visible: false, focused: false });
  }
}
