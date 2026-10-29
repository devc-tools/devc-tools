// `devc web` live mode: the token file, static generations, the last-good snapshot and the
// `/safe/` routes. Temp dirs only; the `test` task has no --allow-net, so nothing opens a socket.
import { assert, assertEquals, assertNotEquals } from 'jsr:@std/assert';
import { join, toFileUrl } from 'jsr:@std/path';
import {
  changedPaths,
  computeGeneration,
  LiveStatic,
  snapshotGeneration,
} from '../web/live.ts';
import { routeStatic, staticPathAllowed } from '../web/server.ts';
import { isServerCodePath } from '../web/supervisor.ts';

const PORT = 48228;

async function withTemp(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: 'devc-web-live-' });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

async function writeTree(
  root: string,
  files: Record<string, string>,
): Promise<void> {
  for (const [path, text] of Object.entries(files)) {
    const full = join(root, path);
    await Deno.mkdir(join(full, '..'), { recursive: true });
    await Deno.writeTextFile(full, text);
  }
}

const dirUrl = (dir: string) => toFileUrl(`${dir}/`);

Deno.test('computeGeneration is a stable content hash; changedPaths lists what moved', async () => {
  await withTemp(async (dir) => {
    const a = join(dir, 'a');
    const b = join(dir, 'b');
    const tree = {
      'index.html': '<p>hi</p>',
      'style.css': 'body{}',
      'lib/sidebar.js': 'export {}',
    };
    await writeTree(a, tree);
    await writeTree(b, tree);
    const ga = await computeGeneration(a);
    const gb = await computeGeneration(b);
    assert(/^[0-9a-f]{16}$/.test(ga.generation));
    assertEquals(ga.generation, gb.generation);
    assertEquals([...ga.files.keys()], [
      'index.html',
      'lib/sidebar.js',
      'style.css',
    ]);

    await Deno.writeTextFile(join(b, 'style.css'), 'body{ }');
    const byte = await computeGeneration(b);
    assertNotEquals(byte.generation, ga.generation);
    assertEquals(changedPaths(ga.files, byte.files), ['style.css']);

    await Deno.rename(join(b, 'lib/sidebar.js'), join(b, 'lib/tree.js'));
    const renamed = await computeGeneration(b);
    assertNotEquals(renamed.generation, byte.generation);
    assertEquals(changedPaths(byte.files, renamed.files), [
      'lib/sidebar.js',
      'lib/tree.js',
    ]);
  });
});

Deno.test('LiveStatic reports changes and snapshots only the current generation, once', async () => {
  await withTemp(async (dir) => {
    const staticDir = join(dir, 'static');
    const snapshotDir = join(dir, 'cache', 'last-good');
    await writeTree(staticDir, { 'index.html': 'v1', 'app.js': '1' });
    const changes: [string, string[]][] = [];
    const errors: string[] = [];
    const live = new LiveStatic({
      staticDir,
      snapshotDir,
      onChange: (g, paths) => changes.push([g, paths]),
      onError: (m) => errors.push(m),
    });
    await live.init();
    const g1 = live.generation;

    assertEquals(await live.clientReady('0000000000000000'), false);
    assertEquals(await snapshotGeneration(snapshotDir), null);

    assertEquals(await live.clientReady(g1), true);
    assertEquals(await snapshotGeneration(snapshotDir), g1);
    assertEquals(await Deno.readTextFile(join(snapshotDir, 'app.js')), '1');
    assertEquals(await live.clientReady(g1), false, 'at most once');

    await Deno.writeTextFile(join(staticDir, 'app.js'), '2');
    await live.recompute();
    const g2 = live.generation;
    assertNotEquals(g2, g1);
    assertEquals(changes, [[g2, ['app.js']]]);
    await live.recompute();
    assertEquals(changes.length, 1, 'no change, no broadcast');

    // A page still on g1 is stale now: it must not overwrite the snapshot.
    assertEquals(await live.clientReady(g1), false);
    assertEquals(await snapshotGeneration(snapshotDir), g1);

    assertEquals(await live.clientReady(g2), true);
    assertEquals(await snapshotGeneration(snapshotDir), g2);
    assertEquals(await Deno.readTextFile(join(snapshotDir, 'app.js')), '2');
    // The rename left no temp or old copies beside it.
    const siblings = [];
    for await (const e of Deno.readDir(join(dir, 'cache'))) {
      siblings.push(e.name);
    }
    assertEquals(siblings, ['last-good']);

    // A restarted child does not re-snapshot what is already there.
    const again = new LiveStatic({
      staticDir,
      snapshotDir,
      onChange: () => {},
      onError: (m) => errors.push(m),
    });
    await again.init();
    assertEquals(await again.clientReady(g2), false);
    assertEquals(errors, []);
  });
});

Deno.test('routeStatic serves /safe/ from the snapshot, or 404s without one', async () => {
  await withTemp(async (dir) => {
    const main = join(dir, 'static');
    const safe = join(dir, 'last-good');
    await writeTree(main, { 'index.html': 'live', 'x.js': 'live x' });
    await writeTree(safe, { 'index.html': 'good', 'x.js': 'good x' });

    const live = await routeStatic('/x.js', PORT, dirUrl(main), dirUrl(safe));
    assertEquals(await live.text(), 'live x');
    assertEquals(
      live.headers.get('Content-Type'),
      'text/javascript; charset=utf-8',
    );

    const good = await routeStatic(
      '/safe/x.js',
      PORT,
      dirUrl(main),
      dirUrl(safe),
    );
    assertEquals(good.status, 200);
    assertEquals(await good.text(), 'good x');
    assertEquals(good.headers.get('Cache-Control'), 'no-store');
    assert(
      good.headers.get('Content-Security-Policy')?.includes(
        "default-src 'self'",
      ),
    );

    const index = await routeStatic('/safe/', PORT, dirUrl(main), dirUrl(safe));
    assertEquals(await index.text(), 'good');

    const none = await routeStatic('/safe/', PORT, dirUrl(main), null);
    assertEquals(none.status, 404);
    assertEquals(await none.text(), 'no last-good snapshot yet');

    const traversal = await routeStatic(
      '/safe/../static/x.js',
      PORT,
      dirUrl(main),
      dirUrl(safe),
    );
    assertEquals(traversal.status, 404);
    await traversal.body?.cancel();
    assert(!staticPathAllowed('/safe/../x.js'));
    assert(!staticPathAllowed('/../x.js'));
  });
});

Deno.test('routeStatic serves /sidebar, /main, /containers and /host-status, live and under /safe/', async () => {
  await withTemp(async (dir) => {
    const main = join(dir, 'static');
    const safe = join(dir, 'last-good');
    await writeTree(main, {
      'index.html': 'live index',
      'sidebar.html': 'live sidebar',
      'main.html': 'live main',
      'containers.html': 'live containers',
      'host-status.html': 'live host status',
      'x.js': 'live x',
    });
    await writeTree(safe, {
      'index.html': 'good index',
      'sidebar.html': 'good sidebar',
      'main.html': 'good main',
      'containers.html': 'good containers',
      'host-status.html': 'good host status',
    });
    const get = (path: string) =>
      routeStatic(path, PORT, dirUrl(main), dirUrl(safe));
    for (
      const [path, body] of [
        ['/', 'live index'],
        ['/sidebar', 'live sidebar'],
        ['/main', 'live main'],
        ['/containers', 'live containers'],
        ['/host-status', 'live host status'],
        ['/safe/', 'good index'],
        ['/safe/sidebar', 'good sidebar'],
        ['/safe/main', 'good main'],
        ['/safe/containers', 'good containers'],
        ['/safe/host-status', 'good host status'],
      ]
    ) {
      const r = await get(path);
      assertEquals(r.status, 200, path);
      assertEquals(await r.text(), body, path);
      assertEquals(r.headers.get('Content-Type'), 'text/html; charset=utf-8');
      // Only the split pages' routes may be framed, and only by VS Code webviews.
      const framable = path.endsWith('/sidebar') || path.endsWith('/main') ||
        path.endsWith('/containers');
      const csp = r.headers.get('Content-Security-Policy') ?? '';
      assert(
        csp.endsWith(
          framable
            ? 'frame-ancestors vscode-webview: vscode-file:'
            : "frame-ancestors 'none'",
        ),
        `${path}: ${csp}`,
      );
      assert(csp.startsWith("default-src 'self'; "), path);
    }
    for (
      const path of ['/sidebar.html', '/main.html', '/containers.html', '/x.js']
    ) {
      const r = await get(path);
      assert(
        r.headers.get('Content-Security-Policy')?.endsWith(
          "frame-ancestors 'none'",
        ),
        path,
      );
      await r.body?.cancel();
    }
    for (const path of ['/sidebar/', '/main/x', '/Sidebar']) {
      const r = await get(path);
      assertEquals(r.status, 404, path);
      await r.body?.cancel();
    }
  });
});

Deno.test('isServerCodePath: .ts outside tests/, node_modules/ and web/static/', () => {
  const roots = ['/co/devc', '/co/devc-core'];
  assert(isServerCodePath('/co/devc/web/server.ts', roots));
  assert(isServerCodePath('/co/devc/main.ts', roots));
  assert(isServerCodePath('/co/devc-core/config.ts', roots));
  assert(!isServerCodePath('/co/devc/tests/web_server_test.ts', roots));
  assert(!isServerCodePath('/co/devc/web/static/app.ts', roots));
  assert(!isServerCodePath('/co/devc-core/node_modules/x/index.d.ts', roots));
  assert(!isServerCodePath('/co/devc/web/static/app.js', roots));
  assert(!isServerCodePath('/co/devc/README.md', roots));
  assert(!isServerCodePath('/elsewhere/main.ts', roots));
});
