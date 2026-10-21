import { assertEquals } from 'jsr:@std/assert';
import {
  parseSessions,
  sessionAge,
  sessionTooltip,
} from '../web/static/lib/sessions.js';

const U1 = '11111111-1111-4111-8111-111111111111';

const session = {
  agent: 'claude' as const,
  session: U1,
  title: 'Fix the thing',
  cwd: '/workspaces/app',
  root: '/src/app',
  updatedAt: '2026-10-20T10:00:00.000Z',
};

Deno.test('parseSessions keeps well-formed sessions in order, drops the rest', () => {
  assertEquals(
    parseSessions({
      sessions: [
        session,
        { ...session, agent: 'opencode' },
        { ...session, title: 3 },
        null,
        { ...session, agent: 'pi', session: 'x' },
      ],
    }),
    [session, { ...session, agent: 'pi', session: 'x' }],
  );
  assertEquals(parseSessions(null), []);
  assertEquals(parseSessions({ sessions: 'no' }), []);
});

Deno.test('parseSessions keeps a string pane_id, drops any other', () => {
  assertEquals(
    parseSessions({
      sessions: [
        { ...session, pane_id: 'w1:pG' },
        { ...session, pane_id: 7 },
      ],
    }),
    [{ ...session, pane_id: 'w1:pG' }, session],
  );
});

Deno.test('sessionAge: now, minutes, hours, days', () => {
  const t = Date.parse(session.updatedAt);
  assertEquals(sessionAge(session.updatedAt, t + 30_000), 'now');
  assertEquals(sessionAge(session.updatedAt, t + 5 * 60_000), '5m');
  assertEquals(sessionAge(session.updatedAt, t + 3 * 3600_000), '3h');
  assertEquals(sessionAge(session.updatedAt, t + 2 * 86400_000), '2d');
  assertEquals(sessionAge(session.updatedAt, t - 60_000), 'now');
  assertEquals(sessionAge('not a date', t), '');
});

Deno.test('sessionTooltip: title, agent and time, cwd, id', () => {
  const lines = sessionTooltip(session, 'Claude').split('\n');
  assertEquals(lines[0], 'Fix the thing');
  assertEquals(lines[1], '');
  assertEquals(
    lines[2],
    `Claude · ${new Date(session.updatedAt).toLocaleString()}`,
  );
  assertEquals(lines.slice(3), [
    '/workspaces/app',
    U1,
    'Click to resume',
  ]);
});
