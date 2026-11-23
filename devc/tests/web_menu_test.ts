import { assertEquals } from 'jsr:@std/assert';
import { menuOf, trimDividers } from '../web/static/lib/menu.js';

Deno.test('trimDividers: keeps dividers between groups only', () => {
  assertEquals(trimDividers(['a', null, 'b']), ['a', null, 'b']);
  assertEquals(trimDividers([null, 'a', null, null, 'b', null]), [
    'a',
    null,
    'b',
  ]);
  assertEquals(trimDividers([null, null]), []);
  assertEquals(trimDividers([]), []);
  assertEquals(trimDividers(['a', 'b']), ['a', 'b']);
});

Deno.test('menuOf: groups in a fixed order, parts merged per group', () => {
  assertEquals(
    menuOf(
      { close: ['Delete…'], open: ['Open'], copy: [] },
      { open: ['Open in Code'], act: ['Reload'], rename: ['Rename…'] },
      null,
      { preview: ['Preview'], organize: ['Pin file'] },
    ),
    [
      'Preview',
      null,
      'Open',
      'Open in Code',
      null,
      'Reload',
      null,
      'Pin file',
      null,
      'Rename…',
      null,
      'Delete…',
    ],
  );
  assertEquals(menuOf({ open: ['a', null, 'b'] }, {}), ['a', null, 'b']);
  assertEquals(menuOf(), []);
});
