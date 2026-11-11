import { assertEquals } from 'jsr:@std/assert';
import { MARK_HEIGHT, rulerMarks } from '../web/static/lib/ruler.js';

Deno.test('rulerMarks scales fractions to the track, top to bottom', () => {
  assertEquals(rulerMarks([0, 0.5, 1], 102), [
    { top: 0, height: MARK_HEIGHT },
    { top: 50, height: MARK_HEIGHT },
    { top: 100, height: MARK_HEIGHT },
  ]);
});

Deno.test('rulerMarks sorts, and merges touching or overlapping marks', () => {
  // 10, 11 and 12 overlap: one mark from 10 to 14.
  assertEquals(rulerMarks([0.5, 0.1, 0.11, 0.12, 0.3], 102), [
    { top: 10, height: 4 },
    { top: 30, height: 2 },
    { top: 50, height: 2 },
  ]);
  // 20 and 22 touch.
  assertEquals(rulerMarks([0.2, 0.22], 102), [{ top: 20, height: 4 }]);
  assertEquals(rulerMarks([0.2, 0.2, 0.2], 102), [{ top: 20, height: 2 }]);
});

Deno.test('rulerMarks clamps out-of-range fractions and skips non-numbers', () => {
  assertEquals(rulerMarks([-1, 2, NaN, Infinity], 52), [
    { top: 0, height: 2 },
    { top: 50, height: 2 },
  ]);
});

Deno.test('rulerMarks draws nothing on a track with no height', () => {
  assertEquals(rulerMarks([0.5], 0), []);
  assertEquals(rulerMarks([0.5], NaN), []);
  assertEquals(rulerMarks([], 100), []);
  // A track no taller than a mark puts every mark at the top.
  assertEquals(rulerMarks([0, 1], 2), [{ top: 0, height: 2 }]);
});
