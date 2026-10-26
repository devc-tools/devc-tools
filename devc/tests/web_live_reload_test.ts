import { assertEquals } from 'jsr:@std/assert';
import {
  liveReloadItem,
  loadedPaths,
  pageFile,
  planStaticChange,
} from '../web/static/lib/live_reload.js';

const ORIGIN = 'http://127.0.0.1:7681';

Deno.test('pageFile names the html file a page path serves', () => {
  assertEquals(pageFile(''), 'index.html');
  assertEquals(pageFile('sidebar'), 'sidebar.html');
  assertEquals(pageFile('main'), 'main.html');
});

Deno.test('loadedPaths keeps this origin and base, drops queries, adds the page', () => {
  assertEquals(
    [
      ...loadedPaths(
        [
          `${ORIGIN}/sidebar-page.js`,
          `${ORIGIN}/lib/diff.js`,
          `${ORIGIN}/style.css?g=abc`,
          'https://fonts.example.com/x.woff2',
          'not a url',
        ],
        ORIGIN,
        '/',
        'sidebar',
      ),
    ].sort(),
    ['lib/diff.js', 'sidebar-page.js', 'sidebar.html', 'style.css'],
  );
});

Deno.test('loadedPaths leaves out paths outside the base', () => {
  assertEquals(
    [...loadedPaths(
      [`${ORIGIN}/other/a.js`, `${ORIGIN}/app/a.js`],
      ORIGIN,
      '/app/',
      '',
    )]
      .sort(),
    ['a.js', 'index.html'],
  );
});

Deno.test('planStaticChange reloads for a script the page loaded', () => {
  const loaded = new Set(['sidebar.html', 'sidebar.js', 'style.css']);
  assertEquals(planStaticChange(['sidebar.js'], loaded), {
    reload: true,
    css: [],
  });
  assertEquals(planStaticChange(['style.css', 'sidebar.js'], loaded), {
    reload: true,
    css: [],
  });
  assertEquals(planStaticChange(['sidebar.html'], loaded), {
    reload: true,
    css: [],
  });
});

Deno.test('planStaticChange ignores files the page never loaded', () => {
  const loaded = new Set(['sidebar.html', 'sidebar.js', 'style.css']);
  assertEquals(planStaticChange(['tiles.js', 'lib/diff.js'], loaded), {
    reload: false,
    css: [],
  });
  assertEquals(planStaticChange(['tiles.js', 'style.css'], loaded), {
    reload: false,
    css: ['style.css'],
  });
});

Deno.test('planStaticChange reloads when it does not know what changed', () => {
  assertEquals(planStaticChange([], new Set(['index.html'])), {
    reload: true,
    css: [],
  });
});

Deno.test('liveReloadItem: on, paused, and paused with an edit held', () => {
  const on = liveReloadItem({ paused: false, held: false });
  assertEquals([on.key, on.state, on.text], ['live', 'on', 'live']);
  // `held` only counts while paused.
  assertEquals(liveReloadItem({ paused: false, held: true }), on);
  const paused = liveReloadItem({ paused: true, held: false });
  assertEquals([paused.state, paused.text], ['paused', 'live ⏸ paused']);
  const held = liveReloadItem({ paused: true, held: true });
  assertEquals([held.state, held.text], ['held', 'live ⏸ UI changed']);
  for (const item of [on, paused, held]) {
    assertEquals(item.title.includes('Click to'), true);
  }
});
