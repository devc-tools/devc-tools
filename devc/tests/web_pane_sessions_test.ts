import { assertEquals } from 'jsr:@std/assert';
import {
  findListed,
  paneSessionMap,
  ResumeGate,
  type ResumeOutcome,
  unmappedClaudePanes,
} from '../web/pane_sessions.ts';

const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';
const S3 = '33333333-3333-4333-8333-333333333333';

Deno.test('paneSessionMap: resumed over sent over running, live panes only, in pane order', () => {
  const resumed = [{
    pane_id: 'w1:p2',
    agent: 'copilot' as const,
    session: S1,
  }];
  const sent = [
    { pane_id: 'w1:p2', agent: 'pi' as const, session: S2 },
    { pane_id: 'w1:p1', agent: 'pi' as const, session: S2 },
    { pane_id: 'w9:p9', agent: 'pi' as const, session: S3 },
  ];
  const running = [
    { pane_id: 'w1:p1', agent: 'claude' as const, session: S3 },
    { pane_id: 'w1:p3', agent: 'claude' as const, session: S3 },
  ];
  assertEquals(
    paneSessionMap(['w1:p1', 'w1:p2', 'w1:p3', 'w1:p4'], [
      resumed,
      sent,
      running,
    ]),
    [
      { pane_id: 'w1:p1', agent: 'pi', session: S2 },
      { pane_id: 'w1:p2', agent: 'copilot', session: S1 },
      { pane_id: 'w1:p3', agent: 'claude', session: S3 },
    ],
  );
  assertEquals(paneSessionMap([], [resumed, sent, running]), []);
});

Deno.test('unmappedClaudePanes: Claude panes with no session, not missed lately', () => {
  const panes = [
    { pane_id: 'a', agent: 'claude' },
    { pane_id: 'b', agent: 'claude' },
    { pane_id: 'c', agent: 'claude' },
    { pane_id: 'd', agent: 'copilot' },
    { pane_id: 'e' },
    { agent: 'claude' },
  ];
  const mapped = [{ pane_id: 'a', agent: 'claude' as const, session: S1 }];
  const misses = new Map([['b', 1000], ['c', 100]]);
  assertEquals(unmappedClaudePanes(panes, mapped, misses, 1500, 1000), ['c']);
  assertEquals(unmappedClaudePanes(panes, mapped, misses, 2000, 1000), [
    'b',
    'c',
  ]);
});

Deno.test('ResumeGate: concurrent resumes of one key run once and share its pane', async () => {
  const gate = new ResumeGate(() => 'herdr_error');
  let runs = 0;
  let release!: () => void;
  const started = new Promise<void>((r) => (release = r));
  const run = async (): Promise<ResumeOutcome> => {
    runs++;
    await started;
    return {
      ok: true,
      pane: { pane_id: 'w1:p7', tab_id: 'w1' },
      reused: false,
    };
  };
  const first = gate.once('c\nclaude\n' + S1, run);
  const second = gate.once('c\nclaude\n' + S1, run);
  const other = gate.once('c\nclaude\n' + S2, run);
  release();
  assertEquals(await first, {
    ok: true,
    pane: { pane_id: 'w1:p7', tab_id: 'w1' },
    reused: false,
  });
  assertEquals(await second, {
    ok: true,
    pane: { pane_id: 'w1:p7', tab_id: 'w1' },
    reused: true,
  });
  await other;
  assertEquals(runs, 2);
  // Settled: the next resume of the key runs again (and checks for the pane itself).
  await gate.once('c\nclaude\n' + S1, run);
  assertEquals(runs, 3);
});

Deno.test('ResumeGate: a failure, thrown or returned, reaches every waiter', async () => {
  const gate = new ResumeGate((e) => e instanceof RangeError ? 'range' : 'x');
  const thrown = gate.once('k', () => Promise.reject(new RangeError('boom')));
  const waiter = gate.once('k', () => Promise.reject(new Error('never run')));
  assertEquals((await thrown).ok, false);
  const w = await waiter;
  assertEquals(w.ok ? null : w.code, 'range');
  const returned = await gate.once(
    'k',
    () => Promise.resolve({ ok: false, code: 'not_installed', error: 'no' }),
  );
  assertEquals(returned, { ok: false, code: 'not_installed', error: 'no' });
});

Deno.test('findListed: the cached entry, else a fresh listing, else undefined', async () => {
  let refreshes = 0;
  const find = (l: readonly string[]) => l.find((s) => s === 'b');
  assertEquals(
    await findListed(['a', 'b'], find, () => {
      refreshes++;
      return Promise.resolve([]);
    }),
    'b',
  );
  assertEquals(refreshes, 0);
  assertEquals(
    await findListed(['a'], find, () => {
      refreshes++;
      return Promise.resolve(['b']);
    }),
    'b',
  );
  assertEquals(
    await findListed(undefined, find, () => Promise.resolve(['a'])),
    undefined,
  );
  assertEquals(
    await findListed(['a'], find, () => Promise.reject(new Error('exec'))),
    undefined,
  );
  assertEquals(refreshes, 1);
});
