// `devc time`: where time went, from `devc web`'s activity log (`web/activity.ts`). Past days come
// from their rollups; today, and any day without a complete rollup, from the raw log, so it works
// whether or not devc web is running.

import {
  ACTIVITY_DIR,
  type ActivityRow,
  addDays,
  eventsAround,
  localDate,
  readRollup,
  rollupDay,
} from './web/activity.ts';

export type TimeGrouping = 'repo' | 'branch' | 'agent';

export interface TimeArgs {
  days: number;
  by: TimeGrouping;
  json: boolean;
}

/** `devc time`'s flags. Throws on an unknown flag or a bad value. */
export function parseTimeArgs(args: string[]): TimeArgs {
  const out: TimeArgs = { days: 7, by: 'repo', json: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const eq = arg.indexOf('=');
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const value = () => {
      const v = eq === -1 ? args[++i] : arg.slice(eq + 1);
      if (v === undefined || v === '') throw new Error(`${flag} needs a value`);
      return v;
    };
    if (flag === '--json' && eq === -1) out.json = true;
    else if (flag === '--days') {
      const v = value();
      const n = Number(v);
      if (!/^\d+$/.test(v) || n < 1 || n > 3650) {
        throw new Error(`--days must be a whole number from 1 to 3650`);
      }
      out.days = n;
    } else if (flag === '--by') {
      const v = value();
      if (v !== 'repo' && v !== 'branch' && v !== 'agent') {
        throw new Error(`--by must be repo, branch or agent`);
      }
      out.by = v;
    } else throw new Error(`unknown argument '${arg}'`);
  }
  return out;
}

/** The `days` dates ending with `today`, oldest first. */
export function lastDays(today: string, days: number): string[] {
  return Array.from({ length: days }, (_, i) => addDays(today, i - days + 1));
}

/** The rows of the `days` days ending today: a complete rollup when there is one, else the log. */
export async function readActivityRows(
  days: number,
  today = localDate(new Date()),
  dir = ACTIVITY_DIR,
): Promise<ActivityRow[]> {
  const rows: ActivityRow[] = [];
  for (const date of lastDays(today, days)) {
    const rollup = date < today ? await readRollup(date, dir) : null;
    rows.push(
      ...(rollup?.complete
        ? rollup.rows
        : rollupDay(date, await eventsAround(date, dir))),
    );
  }
  return rows;
}

/** `ms` as hours and minutes: `3h 05m`. */
export function formatMs(ms: number): string {
  const min = Math.round(ms / 60_000);
  return `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, '0')}m`;
}

interface Line {
  label: string;
  you: number;
  working: number;
  blocked: number;
}

/** A path with `home` shown as `~`. */
function tilde(path: string, home: string | undefined): string {
  return home && (path === home || path.startsWith(`${home}/`))
    ? `~${path.slice(home.length)}`
    : path;
}

/** The text table: one line per group, most time first, and a total. */
export function timeTable(
  rows: ActivityRow[],
  by: TimeGrouping,
  home?: string,
): string {
  const lines = new Map<string, Line>();
  const repoLabel = (r: ActivityRow) =>
    r.repo !== null
      ? tilde(r.repo, home)
      : `${tilde(r.container, home)} (no repo)`;
  for (const r of rows) {
    const label = by === 'repo'
      ? repoLabel(r)
      : by === 'branch'
      ? `${repoLabel(r)} @ ${r.branch ?? '-'}`
      : r.agent ?? 'you';
    let line = lines.get(label);
    if (!line) {
      line = { label, you: 0, working: 0, blocked: 0 };
      lines.set(label, line);
    }
    line.you += r.userActiveMs;
    line.working += r.agentWorkingMs;
    line.blocked += r.agentBlockedMs;
  }
  const sorted = [...lines.values()].sort((a, b) =>
    b.you + b.working + b.blocked - (a.you + a.working + a.blocked) ||
    a.label.localeCompare(b.label)
  );
  const total: Line = { label: 'Total', you: 0, working: 0, blocked: 0 };
  for (const l of sorted) {
    total.you += l.you;
    total.working += l.working;
    total.blocked += l.blocked;
  }
  const head = [by.toUpperCase(), 'YOU', 'AGENT WORKING', 'AGENT BLOCKED'];
  const cells = [...sorted, total].map((l) => [
    l.label,
    formatMs(l.you),
    formatMs(l.working),
    formatMs(l.blocked),
  ]);
  const widths = head.map((h, i) =>
    Math.max(h.length, ...cells.map((c) => c[i].length))
  );
  const fmt = (c: string[]) =>
    c.map((v, i) => i === 0 ? v.padEnd(widths[i]) : v.padStart(widths[i]))
      .join('  ');
  return [fmt(head), ...cells.slice(0, -1).map(fmt), fmt(cells.at(-1)!)]
    .join('\n');
}

/** `devc time [--days N] [--by repo|branch|agent] [--json]`. */
export async function runTime(args: TimeArgs): Promise<void> {
  const today = localDate(new Date());
  const rows = await readActivityRows(args.days, today);
  if (args.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  const dates = lastDays(today, args.days);
  console.log(
    `Last ${args.days} day${args.days === 1 ? '' : 's'} (${dates[0]} to ${
      dates.at(-1)
    }), by ${args.by}`,
  );
  if (!rows.length) {
    console.log(
      'No activity recorded. devc web records it while it runs (see `devc web`).',
    );
    return;
  }
  console.log('');
  console.log(timeTable(rows, args.by, Deno.env.get('HOME')));
}
