import { assert, assertEquals } from 'jsr:@std/assert';
import {
  type ActivityEvent,
  ActivityRecorder,
  type ActivityRow,
  addDays,
  catchUpRollups,
  localDate,
  localIso,
  type PaneFacts,
  paneFacts,
  parseEvents,
  rawLogPath,
  readRollup,
  rollupDay,
  rollupPath,
  writeDayRollup,
  writeRollup,
} from '../web/activity.ts';

const DAY = '2026-10-20';
const MIN = 60_000;

/** Local time on DAY (or `day`), as the log writes it. */
const at = (h: number, m = 0, s = 0, day = DAY) => {
  const [y, mo, d] = day.split('-').map(Number);
  return localIso(new Date(y, mo - 1, d, h, m, s));
};

const C = '/src/app';
const pane = (
  t: string,
  p = 'w1:p1',
  extra: Partial<PaneFacts> = {},
): ActivityEvent => ({
  t,
  e: 'pane',
  container: C,
  pane: p,
  terminal: `term_${p}`,
  agent: null,
  title: 'shell',
  cwd: '/workspaces/app',
  repo: '/src/app',
  branch: 'main',
  ...extra,
});
const start = (t: string): ActivityEvent => ({
  t,
  e: 'server',
  state: 'start',
});
const stop = (t: string): ActivityEvent => ({ t, e: 'server', state: 'stop' });
const focus = (t: string, client = 'c1', on = true): ActivityEvent => ({
  t,
  e: 'focus',
  client,
  visible: on,
  focused: on,
});
const input = (t: string, client = 'c1', p = 'w1:p1'): ActivityEvent => ({
  t,
  e: 'input',
  container: C,
  pane: p,
  client,
});
const agent = (t: string, status: string, p = 'w1:p2'): ActivityEvent => ({
  t,
  e: 'agent',
  container: C,
  pane: p,
  terminal: `term_${p}`,
  agent: 'claude',
  status,
});

const userMs = (rows: ActivityRow[]) =>
  rows.filter((r) => r.agent === null).reduce((s, r) => s + r.userActiveMs, 0);

Deno.test('localIso: local time with its offset, parsed back to the same instant', () => {
  const d = new Date(2026, 9, 20, 9, 5, 7, 12);
  const iso = localIso(d);
  assert(/^2026-10-20T09:05:07\.012[+-]\d{2}:\d{2}$/.test(iso), iso);
  assertEquals(Date.parse(iso), d.getTime());
  assertEquals(localDate(d), '2026-10-20');
  assertEquals(addDays('2026-10-31', 1), '2026-11-01');
  assertEquals(addDays('2026-03-01', -1), '2026-02-28');
});

Deno.test('parseEvents: skips a cut-off last line and lines that are not events', () => {
  const text = [
    JSON.stringify(start(at(9))),
    'not json',
    JSON.stringify({ t: at(9), e: 'nope' }),
    JSON.stringify({ e: 'server', state: 'start' }),
    JSON.stringify(input(at(9, 1))),
    '{"t":"2026-10-20T09:02:00.000-05:00","e":"inp',
  ].join('\n');
  assertEquals(parseEvents(text).map((e) => e.e), ['server', 'input']);
});

Deno.test('rollupDay: user time runs to the next input, or the idle timeout after it', () => {
  const rows = rollupDay(DAY, [
    start(at(9)),
    pane(at(9)),
    focus(at(9)),
    input(at(9, 0)),
    input(at(9, 2)), // 2 min after the first: that span ends here
    // nothing for 20 min: this span stops 5 min after its input
    input(at(9, 22)),
    stop(at(10)),
  ]);
  assertEquals(userMs(rows), (2 + 5 + 5) * MIN);
  assertEquals(rows, [{
    date: DAY,
    container: C,
    repo: '/src/app',
    branch: 'main',
    agent: null,
    title: 'shell',
    userActiveMs: 12 * MIN,
    agentWorkingMs: 0,
    agentBlockedMs: 0,
  }]);
});

Deno.test('rollupDay: only focused time counts, and a page hidden mid-span ends the span', () => {
  const rows = rollupDay(DAY, [
    start(at(9)),
    input(at(9)), // no focus event yet: not visible until 9:01
    focus(at(9, 1)),
    input(at(9, 2)),
    focus(at(9, 3), 'c1', false), // hidden after 1 min
    focus(at(9, 4)), // back, but no new input: still idle
    stop(at(10)),
  ]);
  // 9:01–9:02 (the first input's span, once focused) and 9:02–9:03.
  assertEquals(userMs(rows), 2 * MIN);
});

Deno.test('rollupDay: two clients active on one pane at once count once', () => {
  const rows = rollupDay(DAY, [
    start(at(9)),
    focus(at(9), 'a'),
    focus(at(9), 'b'),
    input(at(9, 0), 'a'),
    input(at(9, 1), 'b'),
    stop(at(10)),
  ]);
  // a: 9:00–9:05, b: 9:01–9:06 → union 9:00–9:06.
  assertEquals(userMs(rows), 6 * MIN);
  // On different panes, both count.
  const two = rollupDay(DAY, [
    start(at(9)),
    focus(at(9), 'a'),
    focus(at(9), 'b'),
    input(at(9, 0), 'a', 'w1:p1'),
    input(at(9, 1), 'b', 'w1:p3'),
    stop(at(10)),
  ]);
  assertEquals(userMs(two), 10 * MIN);
});

Deno.test('rollupDay: agent working and blocked time, attributed to the pane and its agent', () => {
  const rows = rollupDay(DAY, [
    start(at(9)),
    pane(at(9), 'w1:p2', {
      agent: 'claude',
      title: 'Fix the thing',
      branch: 'feat',
    }),
    agent(at(9), 'working'),
    agent(at(9, 30), 'blocked'),
    agent(at(9, 40), 'working'),
    agent(at(10), 'idle'),
    stop(at(11)),
  ]);
  assertEquals(rows, [{
    date: DAY,
    container: C,
    repo: '/src/app',
    branch: 'feat',
    agent: 'claude',
    title: 'Fix the thing',
    userActiveMs: 0,
    agentWorkingMs: 50 * MIN,
    agentBlockedMs: 10 * MIN,
  }]);
});

Deno.test('rollupDay: unknown counts as idle', () => {
  const rows = rollupDay(DAY, [
    start(at(9)),
    agent(at(9), 'working'),
    agent(at(9, 10), 'unknown'),
    agent(at(9, 50), 'working'),
    stop(at(10)),
  ]);
  assertEquals(rows.map((r) => r.agentWorkingMs), [20 * MIN]);
});

Deno.test('rollupDay: a missing stop is one at the last event', () => {
  const rows = rollupDay(DAY, [
    start(at(9)),
    agent(at(9), 'working'),
    focus(at(9, 30)),
    input(at(9, 59)), // the last event of the crashed server
    start(at(14)), // nothing counts from 9:59 to 14:00
    agent(at(14), 'working'),
    stop(at(14, 10)),
  ]);
  assertEquals(
    rows.map((r) => r.agentWorkingMs).reduce((a, b) => a + b),
    69 * MIN,
  );
  assertEquals(userMs(rows), 0);
  // At the end of the log too: the span stops at the last event.
  const tail = rollupDay(DAY, [
    start(at(9)),
    agent(at(9), 'working'),
    input(at(9, 20)),
  ]);
  assertEquals(tail.map((r) => r.agentWorkingMs), [20 * MIN]);
});

Deno.test('rollupDay: spans crossing midnight split at local midnight', () => {
  const next = addDays(DAY, 1);
  const events = [
    start(at(23)),
    focus(at(23)),
    agent(at(23, 30), 'working'),
    input(at(23, 58)),
    agent(at(0, 30, 0, next), 'idle'),
    stop(at(1, 0, 0, next)),
  ];
  const before = rollupDay(DAY, events);
  const after = rollupDay(next, events);
  assertEquals(before.find((r) => r.agent)?.agentWorkingMs, 30 * MIN);
  assertEquals(userMs(before), 2 * MIN);
  assertEquals(after.find((r) => r.agent)?.agentWorkingMs, 30 * MIN);
  assertEquals(userMs(after), 3 * MIN);
  assertEquals(after.every((r) => r.date === next), true);
});

Deno.test('rollupDay: a repo change mid-span splits the time, and the title is the longest one', () => {
  const rows = rollupDay(DAY, [
    start(at(9)),
    pane(at(9), 'w1:p2', { agent: 'claude', title: 'a' }),
    agent(at(9), 'working'),
    pane(at(9, 10), 'w1:p2', { agent: 'claude', title: 'b' }),
    pane(at(9, 30), 'w1:p2', {
      agent: 'claude',
      title: 'c',
      repo: '/src/lib',
    }),
    stop(at(9, 40)),
  ]);
  assertEquals(
    rows.map((r) => [r.repo, r.title, r.agentWorkingMs]),
    [['/src/app', 'b', 30 * MIN], ['/src/lib', 'c', 10 * MIN]],
  );
});

Deno.test('paneFacts: the deepest repo holding the pane folder, its branch, and the title', () => {
  const repos = [
    { folder: '/h/app', containerFolder: '/workspaces/app' },
    { folder: '/h/lib', containerFolder: '/workspaces/app/vendor/lib' },
    { folder: '/h/x', containerFolder: null },
  ];
  const branch = (f: string) => f === '/h/lib' ? 'dev' : null;
  assertEquals(
    paneFacts(
      '/h/app',
      {
        pane_id: 'w1:p1',
        terminal_id: 't1',
        agent: 'claude',
        cwd: '/workspaces/app',
        foreground_cwd: '/workspaces/app/vendor/lib/src',
        terminal_title_stripped: 'Working',
      },
      repos,
      branch,
    ),
    {
      container: '/h/app',
      pane: 'w1:p1',
      terminal: 't1',
      agent: 'claude',
      title: 'Working',
      cwd: '/workspaces/app/vendor/lib/src',
      repo: '/h/lib',
      branch: 'dev',
    },
  );
  assertEquals(
    paneFacts('/h/app', { pane_id: 'w1:p2', cwd: '/tmp' }, repos, branch)
      ?.repo,
    null,
  );
  assertEquals(paneFacts('/h/app', { cwd: '/tmp' }, repos, branch), null);
});

/** A recorder writing to memory, on a clock the test moves. */
function recorder() {
  const lines: Record<string, unknown>[] = [];
  let now = new Date(2026, 9, 20, 9, 0, 0);
  const r = new ActivityRecorder({
    append: (line) => {
      lines.push(JSON.parse(line));
      return Promise.resolve();
    },
    now: () => now,
  });
  return {
    r,
    lines,
    tick: (ms: number) => now = new Date(now.getTime() + ms),
    kinds: async () => {
      await r.flush();
      return lines.map((l) => {
        const { t: _, ...rest } = l;
        return rest;
      });
    },
  };
}

const facts = (extra: Partial<PaneFacts> = {}): PaneFacts => ({
  container: C,
  pane: 'w1:p1',
  terminal: 't1',
  agent: null,
  title: 'shell',
  cwd: '/workspaces/app',
  repo: C,
  branch: 'main',
  ...extra,
});

Deno.test('ActivityRecorder: pane events on first sight and on change only', async () => {
  const { r, kinds } = recorder();
  r.pane(facts());
  r.pane(facts());
  r.pane(facts({ title: 'vim' }));
  assertEquals((await kinds()).map((l) => [l.e, l.title]), [
    ['pane', 'shell'],
    ['pane', 'vim'],
  ]);
});

Deno.test('ActivityRecorder: an agent pane status once from a snapshot, then from events; a closed one ends unknown', async () => {
  const { r, kinds } = recorder();
  const claude = facts({ pane: 'w1:p2', agent: 'claude' });
  r.snapshot(C, [{ facts: claude, status: 'working' }]);
  r.snapshot(C, [{ facts: claude, status: 'idle' }]); // a snapshot's status: ignored
  r.agentStatus(C, 'w1:p2', null, 'claude', 'blocked');
  r.agentStatus(C, 'w1:p2', null, 'claude', 'blocked'); // a repeat
  r.snapshot(C, []);
  assertEquals(
    (await kinds()).filter((l) => l.e === 'agent').map((l) => [
      l.status,
      l.terminal,
    ]),
    [['working', 't1'], ['blocked', 't1'], ['unknown', 't1']],
  );
});

Deno.test('ActivityRecorder: input throttled per pane per client', async () => {
  const { r, tick, kinds } = recorder();
  r.input('a', C, 'w1:p1');
  tick(10_000);
  r.input('a', C, 'w1:p1'); // throttled
  r.input('b', C, 'w1:p1'); // another client
  r.input('a', C, 'w1:p3'); // another pane
  tick(25_000);
  r.input('a', C, 'w1:p1'); // 35 s after the first
  assertEquals(
    (await kinds()).map((l) => `${l.client} ${l.pane}`),
    ['a w1:p1', 'b w1:p1', 'a w1:p3', 'a w1:p1'],
  );
});

Deno.test('ActivityRecorder: focus events on change, and a disconnect is hidden', async () => {
  const { r, kinds } = recorder();
  r.focus('a', { visible: true, focused: true });
  r.focus('a', { visible: true, focused: true }); // no change
  r.focus('a', { active: { container: C, pane: 'w1:p1' } });
  r.focus('a', { focused: false });
  r.clientGone('a');
  r.clientGone('b'); // never seen: nothing
  assertEquals(await kinds(), [
    { e: 'focus', client: 'a', visible: true, focused: true },
    {
      e: 'focus',
      client: 'a',
      visible: true,
      focused: true,
      container: C,
      pane: 'w1:p1',
    },
    {
      e: 'focus',
      client: 'a',
      visible: true,
      focused: false,
      container: C,
      pane: 'w1:p1',
    },
    { e: 'focus', client: 'a', visible: false, focused: false },
  ]);
});

Deno.test('rollup files: written atomically, past days caught up, old raw logs pruned once rolled up', async () => {
  const dir = await Deno.makeTempDir();
  try {
    const today = '2026-10-20';
    const old = addDays(today, -100);
    const yesterday = addDays(today, -1);
    for (const date of [old, yesterday, today]) {
      const [y, m, d] = date.split('-').map(Number);
      const t = (h: number) => localIso(new Date(y, m - 1, d, h));
      await Deno.writeTextFile(
        rawLogPath(date, dir),
        [start(t(9)), agent(t(9), 'working'), stop(t(10))]
          .map((e) => JSON.stringify(e)).join('\n') + '\n',
      );
    }
    // Yesterday's rollup was left incomplete by a server that stopped at midnight.
    await writeRollup(
      { version: 1, date: yesterday, complete: false, rows: [] },
      dir,
    );
    await catchUpRollups(today, dir, 90);
    const y = await readRollup(yesterday, dir);
    assertEquals(y?.complete, true);
    assertEquals(y?.rows.map((r) => r.agentWorkingMs), [60 * MIN]);
    assertEquals((await readRollup(old, dir))?.complete, true);
    assertEquals(await readRollup(today, dir), null); // today is not a past day
    // The 100-day-old raw log went; its rollup stays.
    await Deno.stat(rollupPath(old, dir));
    let gone = false;
    try {
      await Deno.stat(rawLogPath(old, dir));
    } catch {
      gone = true;
    }
    assert(gone);
    await Deno.stat(rawLogPath(yesterday, dir));

    // Today, while the server runs: what is still going on counts up to `until`.
    await Deno.writeTextFile(
      rawLogPath(today, dir),
      JSON.stringify(agent(localIso(new Date(2026, 9, 20, 11)), 'working')) +
        '\n',
      { append: true },
    );
    const live = await writeDayRollup(today, {
      complete: false,
      until: new Date(2026, 9, 20, 11, 30),
      dir,
    });
    assertEquals(live.rows.map((r) => r.agentWorkingMs), [90 * MIN]);
    assertEquals((await readRollup(today, dir))?.complete, false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
