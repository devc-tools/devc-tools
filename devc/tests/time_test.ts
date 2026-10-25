import { assertEquals, assertThrows } from 'jsr:@std/assert';
import {
  formatMs,
  lastDays,
  parseTimeArgs,
  readActivityRows,
  timeTable,
} from '../time.ts';
import {
  type ActivityRow,
  localIso,
  rawLogPath,
  writeRollup,
} from '../web/activity.ts';

Deno.test('parseTimeArgs: defaults, values in both forms, and refusals', () => {
  assertEquals(parseTimeArgs([]), { days: 7, by: 'repo', json: false });
  assertEquals(parseTimeArgs(['--days', '14', '--by=branch', '--json']), {
    days: 14,
    by: 'branch',
    json: true,
  });
  for (
    const bad of [
      ['--days', '0'],
      ['--days', 'x'],
      ['--days'],
      ['--by', 'pane'],
      ['--nope'],
      ['--json=1'],
    ]
  ) {
    assertThrows(() => parseTimeArgs(bad), Error, undefined, bad.join(' '));
  }
});

Deno.test('formatMs and lastDays', () => {
  assertEquals(formatMs(0), '0h 00m');
  assertEquals(formatMs(185 * 60_000), '3h 05m');
  assertEquals(lastDays('2026-10-02', 3), [
    '2026-09-30',
    '2026-10-01',
    '2026-10-02',
  ]);
});

const row = (r: Partial<ActivityRow>): ActivityRow => ({
  date: '2026-10-20',
  container: '/home/me/app',
  repo: '/home/me/app',
  branch: 'main',
  agent: null,
  title: null,
  userActiveMs: 0,
  agentWorkingMs: 0,
  agentBlockedMs: 0,
  ...r,
});

Deno.test('timeTable: grouped, most time first, with a total', () => {
  const rows = [
    row({ userActiveMs: 60 * 60_000 }),
    row({ agent: 'claude', agentWorkingMs: 120 * 60_000 }),
    row({ repo: '/home/me/lib', branch: 'x', userActiveMs: 5 * 60_000 }),
    row({ repo: null, branch: null, agentBlockedMs: 60_000, agent: 'pi' }),
  ];
  assertEquals(
    timeTable(rows, 'repo', '/home/me'),
    [
      'REPO                YOU  AGENT WORKING  AGENT BLOCKED',
      '~/app            1h 00m         2h 00m         0h 00m',
      '~/lib            0h 05m         0h 00m         0h 00m',
      '~/app (no repo)  0h 00m         0h 00m         0h 01m',
      'Total            1h 05m         2h 00m         0h 01m',
    ].join('\n'),
  );
  const byAgent = timeTable(rows, 'agent').split('\n').map((l) =>
    l.split(/\s{2,}/)[0]
  );
  assertEquals(byAgent, ['AGENT', 'claude', 'you', 'pi', 'Total']);
  assertEquals(
    timeTable(rows, 'branch', '/home/me').split('\n')[1].startsWith(
      '~/app @ main',
    ),
    true,
  );
});

Deno.test('readActivityRows: complete rollups for past days, the raw log for today and the rest', async () => {
  const dir = await Deno.makeTempDir();
  try {
    await writeRollup({
      version: 1,
      date: '2026-10-18',
      complete: true,
      rows: [row({ date: '2026-10-18', userActiveMs: 1 })],
    }, dir);
    // An incomplete rollup is computed again from the log.
    await writeRollup({
      version: 1,
      date: '2026-10-19',
      complete: false,
      rows: [row({ date: '2026-10-19', userActiveMs: 999 })],
    }, dir);
    const log = (date: string, h0: number, h1: number) => {
      const [y, m, d] = date.split('-').map(Number);
      const t = (h: number) => localIso(new Date(y, m - 1, d, h));
      return Deno.writeTextFile(
        rawLogPath(date, dir),
        [
          { t: t(h0), e: 'server', state: 'start' },
          {
            t: t(h0),
            e: 'agent',
            container: '/c',
            pane: 'p',
            terminal: null,
            agent: 'claude',
            status: 'working',
          },
          { t: t(h1), e: 'server', state: 'stop' },
        ].map((e) => JSON.stringify(e)).join('\n') + '\n',
      );
    };
    await log('2026-10-19', 9, 10);
    await log('2026-10-20', 9, 11);
    const rows = await readActivityRows(3, '2026-10-20', dir);
    assertEquals(
      rows.map((r) => [r.date, r.userActiveMs, r.agentWorkingMs]),
      [
        ['2026-10-18', 1, 0],
        ['2026-10-19', 0, 3_600_000],
        ['2026-10-20', 0, 7_200_000],
      ],
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
