import { assert, assertEquals } from 'jsr:@std/assert';
import { FilesError, readProjectBytes } from '../web/files.ts';
import {
  parsePreviewPath,
  previewPath,
  previews,
  previewType,
} from '../web/preview.ts';

const NONCE = '0123456789abcdef0123456789abcdef';

Deno.test('previewPath and parsePreviewPath round-trip, segments encoded', () => {
  const path = previewPath(NONCE, '/srv/my site/a#b?.html');
  assertEquals(path, `/preview/${NONCE}/srv/my%20site/a%23b%3F.html`);
  assertEquals(parsePreviewPath(path), {
    nonce: NONCE,
    path: 'srv/my site/a#b?.html',
  });
  assertEquals(
    previewPath(NONCE, 'docs/index.html'),
    `/preview/${NONCE}/docs/index.html`,
  );
});

Deno.test('parsePreviewPath refuses odd segments and short nonces', () => {
  for (
    const p of [
      `/preview/${NONCE}/`,
      `/preview/${NONCE}/a//b`,
      `/preview/${NONCE}/a/../b`,
      `/preview/${NONCE}/a/%2e%2e/b`,
      `/preview/${NONCE}/./a`,
      `/preview/${NONCE}/a%2Fb`,
      `/preview/${NONCE}/%E0%A4%A`,
      '/preview/abc/a.html',
      '/preview/a.html',
    ]
  ) {
    assertEquals(parsePreviewPath(p), null, p);
  }
});

Deno.test('previewType: by extension, any case, else bytes', () => {
  assertEquals(previewType('a/INDEX.HTML'), 'text/html; charset=utf-8');
  assertEquals(previewType('logo.svg'), 'image/svg+xml');
  assertEquals(previewType('Makefile'), 'application/octet-stream');
});

Deno.test('previews: serves through the minted source, sandboxed', async () => {
  const list = previews();
  const nonce = list.mint(
    'repo\n/r',
    (path) => Promise.resolve(new TextEncoder().encode(`<p>${path}</p>`)),
  );
  const res = await list.serve(previewPath(nonce, 'docs/index.html'));
  assertEquals(res.status, 200);
  assertEquals(res.headers.get('content-type'), 'text/html; charset=utf-8');
  const csp = res.headers.get('content-security-policy') ?? '';
  assert(csp.startsWith('sandbox '), csp);
  assert(!csp.includes('allow-same-origin'), csp);
  assertEquals(await res.text(), '<p>docs/index.html</p>');

  // The same source keeps its nonce; the newest reader serves it.
  const again = list.mint(
    'repo\n/r',
    () => Promise.resolve(new TextEncoder().encode('new')),
  );
  assertEquals(again, nonce);
  assertEquals(
    await (await list.serve(previewPath(nonce, 'a.html'))).text(),
    'new',
  );

  assertEquals((await list.serve(`/preview/${NONCE}/a.html`)).status, 404);
  assertEquals((await list.serve(`/preview/${nonce}/a/../b`)).status, 404);
  const head = await list.serve(previewPath(nonce, 'a.css'), true);
  assertEquals(head.status, 200);
  assertEquals(head.body, null);
});

Deno.test('previews: errors map to statuses', async () => {
  const list = previews();
  const nonce = list.mint('k', (path) =>
    Promise.reject(
      new FilesError(
        path === 'big'
          ? 'too_large'
          : path === 'secret'
          ? 'forbidden'
          : 'not_found',
        path,
      ),
    ));
  assertEquals((await list.serve(previewPath(nonce, 'big'))).status, 413);
  assertEquals((await list.serve(previewPath(nonce, 'secret'))).status, 403);
  const missing = await list.serve(previewPath(nonce, 'gone'));
  assertEquals(missing.status, 404);
  assert(missing.headers.get('content-security-policy')?.startsWith('sandbox'));
});

Deno.test('previews: the oldest source is forgotten past the cap', async () => {
  const read = () => Promise.resolve(new Uint8Array([1]));
  const list = previews(2);
  const a = list.mint('a', read);
  const b = list.mint('b', read);
  list.mint('a', read); // refreshed: b is now the oldest
  list.mint('c', read);
  assertEquals((await list.serve(previewPath(a, 'x'))).status, 200);
  assertEquals((await list.serve(previewPath(b, 'x'))).status, 404);
});

Deno.test('readProjectBytes: confined to the root, capped at max', async () => {
  const root = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${root}/docs`);
    await Deno.writeTextFile(`${root}/docs/index.html`, '<p>hi</p>');
    const { bytes } = await readProjectBytes(root, 'docs/index.html', 100);
    assertEquals(new TextDecoder().decode(bytes), '<p>hi</p>');
    for (
      const [rel, max, code] of [
        ['docs/index.html', 3, 'too_large'],
        ['../x', 100, 'forbidden'],
        ['docs', 100, 'bad_request'],
        ['nope.html', 100, 'not_found'],
      ] as const
    ) {
      const err = await readProjectBytes(root, rel, max).then(
        () => null,
        (e) => e,
      );
      assert(err instanceof FilesError, rel);
      assertEquals(err.code, code, rel);
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
