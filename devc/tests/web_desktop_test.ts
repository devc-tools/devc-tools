// devc-desktop's channel: the desktop token's routes, the page's requests and their queue.
// Pure checks only: nothing here opens a socket.
import { assert, assertEquals } from 'jsr:@std/assert';
import {
  authorize,
  desktopProjectRefusal,
  desktopTokenPath,
  parseDesktopProject,
} from '../web/server.ts';
import {
  DesktopRequests,
  MAX_PENDING,
  RATE_LIMIT,
  RATE_WINDOW_MS,
  REQUEST_TTL_MS,
} from '../web/desktop_requests.ts';
import { parseClientMessage } from '../web/protocol.ts';
import { desktopLine, readTokenLine } from '../web/token.ts';
import { parseWebArgs } from '../args.ts';

const PORT = 48228;
const PAGE = 'a'.repeat(64);
const DESKTOP = 'd'.repeat(64);
const host = `127.0.0.1:${PORT}`;

function check(
  path: string,
  headers: Record<string, string>,
  desktop: string | null = DESKTOP,
): 401 | 403 | null {
  return authorize(
    new Headers(headers),
    new URL(`http://127.0.0.1:${PORT}${path}`),
    PORT,
    PAGE,
    desktop,
  );
}

const bearer = (t: string) => ({ host, authorization: `Bearer ${t}` });

Deno.test('authorize: the desktop routes take the desktop token, never the page token', () => {
  for (
    const path of [
      '/desktop/requests',
      '/desktop/requests?after=3',
      '/desktop/requests/0123abcd/dismiss',
      '/desktop/project',
    ]
  ) {
    assertEquals(check(path, bearer(DESKTOP)), null, path);
    assertEquals(check(path, bearer(PAGE)), 401, path);
    assertEquals(check(path, { host }), 401, path);
    // No Origin, ever: not even this page's own.
    assertEquals(
      check(path, { ...bearer(DESKTOP), origin: `http://${host}` }),
      403,
      path,
    );
    // Without --desktop-channel nothing opens them.
    assertEquals(check(path, bearer(DESKTOP), null), 401, path);
    assertEquals(check(path, bearer(PAGE), null), 401, path);
  }
  // The token only as a Bearer header, never in the URL.
  assertEquals(check(`/desktop/requests?token=${DESKTOP}`, { host }), 401);
});

Deno.test('authorize: the page token keeps its routes, and the desktop token opens none of them', () => {
  assertEquals(check('/desktop/active-folder', bearer(PAGE)), null);
  assertEquals(check('/desktop/active-folder', bearer(DESKTOP)), 401);
  const ws = { host, upgrade: 'websocket' };
  assertEquals(check(`/ws?token=${PAGE}`, ws), null);
  assertEquals(check(`/ws?token=${DESKTOP}`, ws), 401);
  assertEquals(
    check('/ws', { ...ws, authorization: `Bearer ${DESKTOP}` }),
    401,
  );
});

Deno.test('desktopTokenPath names exactly the desktop routes', () => {
  assert(desktopTokenPath('/desktop/requests'));
  assert(desktopTokenPath('/desktop/requests/x/dismiss'));
  assert(desktopTokenPath('/desktop/project'));
  assert(!desktopTokenPath('/desktop/active-folder'));
  assert(!desktopTokenPath('/desktop/projects'));
  assert(!desktopTokenPath('/desktop/requestsx'));
  assert(!desktopTokenPath('/ws'));
});

Deno.test('parseClientMessage: request_push and request_project', () => {
  const ok = (m: Record<string, unknown>) => {
    const r = parseClientMessage(JSON.stringify(m));
    assert(r.ok, JSON.stringify(m));
    assertEquals(r.msg, m);
  };
  const bad = (m: Record<string, unknown>) => {
    const r = parseClientMessage(JSON.stringify(m));
    assert(!r.ok, JSON.stringify(m));
    assertEquals(r.rejection.code, 'bad_request');
  };
  ok({
    type: 'request_push',
    id: 'p1',
    localFolder: '/src/a',
    folder: '/src/a',
  });
  bad({ type: 'request_push', id: 'p2', localFolder: '/src/a' });
  bad({ type: 'request_push', id: 'p3', localFolder: '/src/a', folder: 'rel' });
  bad({ type: 'request_push', localFolder: '/src/a', folder: '/src/a' });
  for (const action of ['start', 'stop', 'down']) {
    ok({ type: 'request_project', id: 'q', action, localFolder: '/src/a' });
  }
  bad({ type: 'request_project', id: 'q', action: 'push', localFolder: '/a' });
  bad({ type: 'request_project', id: 'q', localFolder: '/a' });
  bad({ type: 'request_project', id: 'q', action: 'start', localFolder: 'a' });
});

function queue(start = 1_000_000) {
  let now = start;
  let n = 0;
  const q = new DesktopRequests({
    now: () => now,
    mintId: () => `id${++n}`,
  });
  return { q, tick: (ms: number) => now += ms };
}

Deno.test('DesktopRequests: one per kind and folder, asking again answers with it', () => {
  const { q } = queue();
  const a = q.add('push', '/p', '/p/repo');
  assertEquals(a, { ok: true, id: 'id1' });
  assertEquals(q.add('push', '/p', '/p/repo'), { ok: true, id: 'id1' });
  // Another repo, or another kind for the same project, is its own request.
  assertEquals(q.add('push', '/p', '/p/lib'), { ok: true, id: 'id2' });
  assertEquals(q.add('start', '/p', null), { ok: true, id: 'id3' });
  assertEquals(q.add('stop', '/p', null), { ok: true, id: 'id4' });
  assertEquals(q.add('start', '/p', null), { ok: true, id: 'id3' });
  const { seq, requests } = q.list();
  assertEquals(seq, 4);
  assertEquals(requests.map((r) => [r.id, r.kind, r.folder]), [
    ['id1', 'push', '/p/repo'],
    ['id2', 'push', '/p/lib'],
    ['id3', 'start', null],
    ['id4', 'stop', null],
  ]);
});

Deno.test('DesktopRequests: the rate limit counts every ask, and lifts after its window', () => {
  const { q, tick } = queue();
  for (let i = 0; i < RATE_LIMIT; i++) assert(q.add('push', '/p', '/p').ok);
  const refused = q.add('push', '/p', '/p');
  assert(!refused.ok);
  assertEquals(q.list().requests.length, 1);
  tick(RATE_WINDOW_MS);
  assert(q.add('push', '/p', '/p').ok);
});

Deno.test('DesktopRequests: at most MAX_PENDING, and names it cannot show are refused', () => {
  const { q, tick } = queue();
  for (let i = 0; i < MAX_PENDING; i++) {
    if (i % RATE_LIMIT === 0) tick(RATE_WINDOW_MS);
    assert(q.add('start', `/p${i}`, null).ok);
  }
  tick(RATE_WINDOW_MS);
  const full = q.add('start', '/more', null);
  assert(!full.ok && full.problem.includes(`${MAX_PENDING}`));
  assert(!q.add('push', '/p0', '/p0/a‮b').ok);
  assert(!q.add('start', '/p\n0', null).ok);
});

Deno.test('DesktopRequests: dismissed and expired requests go, each a change', () => {
  const { q, tick } = queue();
  q.add('push', '/p', '/p');
  tick(1000);
  q.add('start', '/p', null);
  assert(q.dismiss('id1'));
  assert(!q.dismiss('id1'));
  assertEquals(q.list().requests.map((r) => r.id), ['id2']);
  const seq = q.list().seq;
  tick(REQUEST_TTL_MS);
  assertEquals(q.list(), { seq: seq + 1, requests: [] });
});

Deno.test('DesktopRequests.wait answers at once when behind, else on the next change', async () => {
  const q = new DesktopRequests();
  assertEquals((await q.wait(-1, 10)).seq, 0);
  const waiting = q.wait(0, 5000);
  q.add('start', '/p', null);
  const got = await waiting;
  assertEquals([got.seq, got.requests.length], [1, 1]);
  // Times out with the list as it is.
  assertEquals((await q.wait(1, 10)).seq, 1);
  // An abort, or the server closing, ends a wait.
  const ac = new AbortController();
  const aborted = q.wait(1, 5000, ac.signal);
  ac.abort();
  assertEquals((await aborted).seq, 1);
  const closing = q.wait(1, 5000);
  q.close();
  assertEquals((await closing).seq, 1);
});

Deno.test('desktopProjectRefusal: 409 under --live-yolo, then the body and the project', () => {
  const body = parseDesktopProject('{"action":"start","localFolder":"/p"}');
  assertEquals(body, { action: 'start', localFolder: '/p' });
  assertEquals(desktopProjectRefusal(false, body, true)?.status, 409);
  assertEquals(desktopProjectRefusal(false, null, false)?.problem, 'live-yolo');
  // --live (no project starts for the page) is no refusal here.
  assertEquals(desktopProjectRefusal(true, body, true), null);
  assertEquals(desktopProjectRefusal(true, null, false)?.status, 400);
  assertEquals(desktopProjectRefusal(true, body, false)?.status, 404);
  for (
    const bad of [
      '',
      'null',
      '[]',
      '{"action":"start"}',
      '{"action":"push","localFolder":"/p"}',
      '{"action":"stop","localFolder":"p"}',
      JSON.stringify({ action: 'stop', localFolder: `/${'x'.repeat(9000)}` }),
    ]
  ) {
    assertEquals(parseDesktopProject(bad), null, bad.slice(0, 40));
  }
});

Deno.test('--desktop-channel, its stdout line and the stdin hand-off', async () => {
  assertEquals(parseWebArgs(['--desktop-channel']).desktopChannel, true);
  assertEquals(parseWebArgs([]).desktopChannel, false);
  assertEquals(
    desktopLine(DESKTOP),
    `devc web: desktop ${DESKTOP}`,
  );
  const stream = (s: string) =>
    new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(s));
        c.close();
      },
    });
  assertEquals(await readTokenLine(stream(`${DESKTOP}\nmore`)), DESKTOP);
  assertEquals(await readTokenLine(stream(DESKTOP)), undefined);
  assertEquals(await readTokenLine(stream(`${'x'.repeat(200)}\n`)), undefined);
});
