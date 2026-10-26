import { assert, assertEquals } from 'jsr:@std/assert';
import {
  BATCH_MS,
  ChangeBatcher,
  CHANGED,
  CREATED,
  DELETED,
  eventChanges,
  type FileEvent,
  globMatches,
  MAX_BATCH,
  RootWatcher,
  watched,
} from '../web/lsp_watch.ts';
import type { Clock } from '../web/lsp_session.ts';

class FakeClock implements Clock {
  now = 0;
  #next = 1;
  #timers = new Map<number, { at: number; fn: () => void }>();
  setTimeout(fn: () => void, ms: number): number {
    const h = this.#next++;
    this.#timers.set(h, { at: this.now + ms, fn });
    return h;
  }
  clearTimeout(h: unknown) {
    this.#timers.delete(h as number);
  }
  advance(ms: number) {
    this.now += ms;
    for (const [h, t] of [...this.#timers]) {
      if (t.at <= this.now) {
        this.#timers.delete(h);
        t.fn();
      }
    }
  }
}

const ROOT = '/workspaces/app';

Deno.test('globMatches: **/*.ts against the absolute path', () => {
  assert(globMatches('**/*.ts', `${ROOT}/src/a.ts`, ROOT));
  assert(globMatches('**/*.ts', `${ROOT}/a.ts`, ROOT));
  assert(!globMatches('**/*.ts', `${ROOT}/a.tsx`, ROOT));
  assert(globMatches('**/*.{ts,tsx}', `${ROOT}/a.tsx`, ROOT));
  assert(globMatches('**/package.json', `${ROOT}/pkg/package.json`, ROOT));
  assert(globMatches('**/[ab].py', `${ROOT}/x/b.py`, ROOT));
  assert(!globMatches('**/[ab].py', `${ROOT}/x/c.py`, ROOT));
  assert(globMatches('**/?.py', `${ROOT}/x/c.py`, ROOT));
});

Deno.test('globMatches: {src,lib}/** relative to the root', () => {
  assert(globMatches('{src,lib}/**', `${ROOT}/src/a/b.ts`, ROOT));
  assert(globMatches('{src,lib}/**', `${ROOT}/lib/c.ts`, ROOT));
  assert(!globMatches('{src,lib}/**', `${ROOT}/test/c.ts`, ROOT));
  assert(!globMatches('{src,lib}/**', `/elsewhere/src/c.ts`, ROOT));
});

Deno.test('globMatches: a RelativePattern resolves against its baseUri', () => {
  const rp = {
    baseUri: 'file:///workspaces/app/py%20server',
    pattern: '**/*.py',
  };
  assert(globMatches(rp, '/workspaces/app/py server/m/x.py', ROOT));
  assert(!globMatches(rp, '/workspaces/app/client/x.py', ROOT));
  // A workspace folder as the base.
  const wf = {
    baseUri: { uri: 'file:///workspaces/app', name: 'app' },
    pattern: '*.json',
  };
  assert(globMatches(wf, '/workspaces/app/tsconfig.json', ROOT));
  assert(!globMatches(wf, '/workspaces/app/sub/tsconfig.json', ROOT));
  assert(!globMatches({ baseUri: 'untitled:x', pattern: '**' }, '/x', ROOT));
  assert(!globMatches(42, '/x', ROOT));
});

Deno.test('watched: the kind mask filters event types (default all)', () => {
  const all = [{ globPattern: '**/*.ts' }];
  for (const t of [CREATED, CHANGED, DELETED] as const) {
    assert(watched(all, `${ROOT}/a.ts`, t, ROOT));
  }
  const createDelete = [{ globPattern: '**/*.ts', kind: 1 | 4 }];
  assert(watched(createDelete, `${ROOT}/a.ts`, CREATED, ROOT));
  assert(!watched(createDelete, `${ROOT}/a.ts`, CHANGED, ROOT));
  assert(watched(createDelete, `${ROOT}/a.ts`, DELETED, ROOT));
  const changeOnly = [{ globPattern: '**/*.ts', kind: 2 }];
  assert(!watched(changeOnly, `${ROOT}/a.ts`, CREATED, ROOT));
  assert(watched(changeOnly, `${ROOT}/a.ts`, CHANGED, ROOT));
  assert(!watched([], `${ROOT}/a.ts`, CHANGED, ROOT));
});

Deno.test('eventChanges: kinds to change types, rename as remove plus create', () => {
  assertEquals(eventChanges({ kind: 'create', paths: ['/a'] }), [{
    path: '/a',
    type: CREATED,
  }]);
  assertEquals(eventChanges({ kind: 'modify', paths: ['/a', '/b'] }), [
    { path: '/a', type: CHANGED },
    { path: '/b', type: CHANGED },
  ]);
  assertEquals(eventChanges({ kind: 'remove', paths: ['/a'] }), [{
    path: '/a',
    type: DELETED,
  }]);
  assertEquals(eventChanges({ kind: 'rename', paths: ['/old', '/new'] }), [
    { path: '/old', type: DELETED },
    { path: '/new', type: CREATED },
  ]);
  assertEquals(eventChanges({ kind: 'access', paths: ['/a'] }), []);
  assertEquals(eventChanges({ kind: 'other', paths: ['/a'] }), []);
});

Deno.test('ChangeBatcher: one batch 200 ms after the first event, de-duplicated by URI', () => {
  const clock = new FakeClock();
  const sent: FileEvent[][] = [];
  const b = new ChangeBatcher((c) => sent.push(c), clock);
  b.add('file:///a', CHANGED);
  clock.advance(100);
  b.add('file:///b', CREATED);
  b.add('file:///a', DELETED);
  clock.advance(BATCH_MS - 101);
  assertEquals(sent, []);
  clock.advance(1);
  assertEquals(sent, [[
    { uri: 'file:///b', type: CREATED },
    { uri: 'file:///a', type: DELETED },
  ]]);
  // Create then remove drops it; remove then create is a create.
  b.add('file:///c', CREATED);
  b.add('file:///c', CHANGED);
  b.add('file:///c', DELETED);
  b.add('file:///d', DELETED);
  b.add('file:///d', CREATED);
  clock.advance(BATCH_MS);
  assertEquals(sent[1], [{ uri: 'file:///d', type: CREATED }]);
  // Nothing pending: nothing sent.
  clock.advance(BATCH_MS * 3);
  assertEquals(sent.length, 2);
});

Deno.test('ChangeBatcher: at most 1,000 changes per notification', () => {
  const clock = new FakeClock();
  const sent: FileEvent[][] = [];
  const b = new ChangeBatcher((c) => sent.push(c), clock);
  for (let i = 0; i < 2500; i++) b.add(`file:///f${i}`, CHANGED);
  clock.advance(BATCH_MS);
  assertEquals(sent.map((c) => c.length), [MAX_BATCH, MAX_BATCH, 500]);
  assertEquals(sent[2][499].uri, 'file:///f2499');
});

Deno.test('RootWatcher: host paths mapped to the container root, filtered, batched; rename as remove plus create', () => {
  const clock = new FakeClock();
  const sent: FileEvent[][] = [];
  let watching: string | null = null;
  const w = new RootWatcher({
    hostRoot: '/Users/me/src/app',
    root: ROOT,
    notify: (c) => sent.push(c),
    onFailure: () => {},
    clock,
    watchFs: ((path: string) => {
      watching = path;
      return {
        close() {},
        [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }),
      };
    }) as unknown as typeof Deno.watchFs,
  });
  assertEquals(
    w.containerPath('/Users/me/src/app/src/x.ts'),
    `${ROOT}/src/x.ts`,
  );
  assertEquals(w.containerPath('/Users/me/src/apple/x.ts'), null);
  assertEquals(watching, null, 'no watch before a registration');
  w.setWatchers([{ globPattern: '**/*.ts' }]);
  assertEquals(watching, '/Users/me/src/app');
  w.event({ kind: 'modify', paths: ['/Users/me/src/app/src/x.ts'] });
  w.event({ kind: 'modify', paths: ['/Users/me/src/app/README.md'] });
  w.event({
    kind: 'rename',
    paths: ['/Users/me/src/app/a.ts', '/Users/me/src/app/b b.ts'],
  });
  clock.advance(BATCH_MS);
  assertEquals(sent, [[
    { uri: 'file:///workspaces/app/src/x.ts', type: CHANGED },
    { uri: 'file:///workspaces/app/a.ts', type: DELETED },
    { uri: 'file:///workspaces/app/b%20b.ts', type: CREATED },
  ]]);
  w.stop();
  w.event({ kind: 'modify', paths: ['/Users/me/src/app/src/x.ts'] });
  clock.advance(BATCH_MS);
  assertEquals(sent.length, 1);
});

Deno.test('RootWatcher: a watch that fails (ENOSPC) is reported once', () => {
  const failures: unknown[] = [];
  const w = new RootWatcher({
    hostRoot: '/h',
    root: '/c',
    notify: () => {},
    onFailure: (e) => failures.push(e),
    watchFs: (() => {
      throw new Error('No space left on device (os error 28)');
    }) as unknown as typeof Deno.watchFs,
  });
  w.setWatchers([{ globPattern: '**' }]);
  w.setWatchers([{ globPattern: '**/*.ts' }]);
  assertEquals(failures.length, 1);
});

Deno.test('RootWatcher: real Deno.watchFs sees a file written on the host', async () => {
  const dir = await Deno.makeTempDir();
  try {
    const sent: FileEvent[][] = [];
    const got = Promise.withResolvers<void>();
    const w = new RootWatcher({
      hostRoot: dir,
      root: '/c',
      notify: (c) => {
        sent.push(c);
        got.resolve();
      },
      onFailure: (e) => got.reject(e),
    });
    w.setWatchers([{ globPattern: '**/*.py' }]);
    // Let the watch start before the write.
    await new Promise((r) => setTimeout(r, 100));
    await Deno.writeTextFile(`${dir}/m.py`, 'x = 1\n');
    await Deno.writeTextFile(`${dir}/notes.txt`, 'no');
    const timer = setTimeout(() => got.reject(new Error('no event')), 5000);
    await got.promise;
    clearTimeout(timer);
    w.stop();
    const uris = sent.flat().map((c) => c.uri);
    assert(uris.includes('file:///c/m.py'), JSON.stringify(sent));
    assert(!uris.some((u) => u.endsWith('notes.txt')));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
