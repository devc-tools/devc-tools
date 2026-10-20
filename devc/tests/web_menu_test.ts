import { assertEquals } from 'jsr:@std/assert';
import { trimDividers } from '../web/static/lib/menu.js';

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
