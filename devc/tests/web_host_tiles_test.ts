import { assertEquals } from 'jsr:@std/assert';
import {
  hostTilesMessage,
  MAX_HOST_TILES,
  parseHostTiles,
} from '../web/host_tiles.ts';

const SLOT = 'a'.repeat(32);
const facts = (over: Record<string, unknown> = {}) => ({
  cwd: '/Users/me/code/app',
  foreground_cwd: '/Users/me/code/app/src',
  title: 'Fix the tests',
  agent: 'claude',
  agent_status: 'working',
  ...over,
});
const body = (tiles: unknown) => JSON.stringify({ tiles });

Deno.test('parseHostTiles: the facts by slot id', () => {
  assertEquals(parseHostTiles(body({ [SLOT]: facts() })), {
    [SLOT]: facts(),
  });
  assertEquals(parseHostTiles(body({})), {});
  // Extra fields are dropped.
  assertEquals(
    parseHostTiles(body({ [SLOT]: facts({ pane_id: 'p1' }) })),
    { [SLOT]: facts() },
  );
});

Deno.test('parseHostTiles: anything else is null', () => {
  for (
    const text of [
      'not json',
      'null',
      JSON.stringify({}),
      body([]),
      body({ ['A'.repeat(32)]: facts() }),
      body({ abc: facts() }),
      body({ [SLOT]: null }),
      body({ [SLOT]: facts({ agent: 3 }) }),
      body({ [SLOT]: { cwd: '/x' } }),
      body({ [SLOT]: facts({ title: 'x'.repeat(513) }) }),
      body({ [SLOT]: facts({ agent_status: 'x'.repeat(33) }) }),
      body(Object.fromEntries(
        Array.from(
          { length: MAX_HOST_TILES + 1 },
          (_, i) => [i.toString(16).padStart(32, '0'), facts()],
        ),
      )),
    ]
  ) assertEquals(parseHostTiles(text), null, text.slice(0, 60));
});

Deno.test('parseHostTiles: controls, bidi overrides and zero-width characters become U+FFFD', () => {
  const got = parseHostTiles(
    body({ [SLOT]: facts({ title: 'a\u001b]0;x\u0007b‮c​d' }) }),
  );
  assertEquals(got?.[SLOT].title, 'a�]0;x�b�c�d');
});

Deno.test('hostTilesMessage', () => {
  assertEquals(hostTilesMessage({ [SLOT]: facts() }), {
    type: 'host_tiles',
    tiles: { [SLOT]: facts() },
  });
});
