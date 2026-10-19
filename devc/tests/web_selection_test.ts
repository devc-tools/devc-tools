import { assertEquals } from 'jsr:@std/assert';
import { paneScroll, toTextPoint } from '../web/selection.ts';

// Measured: 61 content rows in a 40-row viewport at the bottom; viewport row 0 is content row 21.
const atBottom = {
  offset_from_bottom: 0,
  max_offset_from_bottom: 21,
  viewport_rows: 40,
};

Deno.test('toTextPoint maps viewport rows onto content rows at the bottom', () => {
  assertEquals(toTextPoint(atBottom, { column: 0, row: 0 }), {
    row: 21,
    col: 0,
  });
  assertEquals(toTextPoint(atBottom, { column: 7, row: 39 }), {
    row: 60,
    col: 7,
  });
});

Deno.test('toTextPoint moves up by the scroll offset', () => {
  assertEquals(
    toTextPoint({ ...atBottom, offset_from_bottom: 5 }, { column: 3, row: 2 }),
    { row: 18, col: 3 },
  );
  assertEquals(
    toTextPoint({ ...atBottom, offset_from_bottom: 21 }, { column: 0, row: 0 }),
    { row: 0, col: 0 },
  );
});

Deno.test('toTextPoint with no scrollback is the viewport row', () => {
  const none = {
    offset_from_bottom: 0,
    max_offset_from_bottom: 0,
    viewport_rows: 24,
  };
  assertEquals(toTextPoint(none, { column: 1, row: 4 }), { row: 4, col: 1 });
});

Deno.test('paneScroll reads a pane.get reply', () => {
  assertEquals(
    paneScroll({
      type: 'pane_info',
      pane: { pane_id: 'w1:p1', scroll: atBottom },
    }),
    atBottom,
  );
});

Deno.test('paneScroll refuses missing or malformed scroll', () => {
  assertEquals(paneScroll(null), null);
  assertEquals(paneScroll({ pane: {} }), null);
  assertEquals(
    paneScroll({ pane: { scroll: { ...atBottom, viewport_rows: -1 } } }),
    null,
  );
  assertEquals(
    paneScroll({ pane: { scroll: { ...atBottom, offset_from_bottom: 1.5 } } }),
    null,
  );
  assertEquals(
    paneScroll({ pane: { scroll: { ...atBottom, offset_from_bottom: 22 } } }),
    null,
  );
});
