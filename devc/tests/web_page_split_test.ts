import { assert, assertEquals } from 'jsr:@std/assert';

// The page's two halves stay apart (`.plans/archived/devc-web-split-entry-points.md`): the sidebar
// (`sidebar.js`) reaches the tiling area only through the `TileArea` it is given, and the tiling
// area (`tiles.js`) the sidebar only through `SidebarIntents`, so each can later run on a page of
// its own. `app.js`, the page at `/`, is the one file that puts them together.

const root = new URL('../web/static/', import.meta.url).pathname;

/** `source` without its comments, string and template contents kept. */
function code(source: string): string {
  return source.replace(
    /("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
    (_m, literal) => literal ?? '',
  );
}

/** The page modules `source` imports, as written (`./x.js`). */
function imports(source: string): string[] {
  return [...code(source).matchAll(/\bimport\b[^'"]*?from\s*['"]([^'"]+)['"]/g)]
    .map((m) => m[1]);
}

async function read(name: string): Promise<string> {
  return await Deno.readTextFile(`${root}${name}`);
}

Deno.test('sidebar.js names none of the tiling area’s own state', async () => {
  const src = code(await read('sidebar.js'));
  const found = [
    'tiling',
    'views',
    'fileViews',
    'diffViews',
    'focusSeq',
    'focusedTileId',
  ].filter((name) => new RegExp(`(?<![\\w$.'"\`])${name}(?![\\w$])`).test(src));
  assertEquals(found, []);
});

Deno.test('sidebar.js imports neither tiles.js nor layout.js', async () => {
  const found = imports(await read('sidebar.js')).filter((p) =>
    p === './tiles.js' || p === './layout.js'
  );
  assertEquals(found, []);
});

Deno.test('tiles.js does not import sidebar.js', async () => {
  assert(!imports(await read('tiles.js')).includes('./sidebar.js'));
});

Deno.test('only app.js imports both tiles.js and sidebar.js', async () => {
  const both: string[] = [];
  for await (const e of Deno.readDir(root)) {
    if (!e.isFile || !e.name.endsWith('.js')) continue;
    const found = imports(await read(e.name));
    if (found.includes('./tiles.js') && found.includes('./sidebar.js')) {
      both.push(e.name);
    }
  }
  assertEquals(both, ['app.js']);
});

Deno.test('menus.js, shared by both halves, imports neither', async () => {
  const found = imports(await read('menus.js')).filter((p) =>
    p === './tiles.js' || p === './sidebar.js'
  );
  assertEquals(found, []);
});
