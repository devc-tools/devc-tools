import { assertEquals } from 'jsr:@std/assert';
import {
  MARK_HEIGHT,
  rulerMarks,
  rulerSpans,
} from '../web/static/lib/ruler.js';

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

Deno.test('rulerSpans scales runs to the track, at least a mark tall', () => {
  assertEquals(
    rulerSpans([{ from: 0.1, to: 0.3 }, { from: 0.5, to: 0.5 }], 100),
    [
      { top: 10, height: 20 },
      { top: 50, height: MARK_HEIGHT },
    ],
  );
  // A run at the very bottom stays on the track.
  assertEquals(rulerSpans([{ from: 1, to: 1 }], 100), [{ top: 98, height: 2 }]);
});

Deno.test('rulerSpans sorts and merges touching or overlapping runs', () => {
  assertEquals(
    rulerSpans([
      { from: 0.6, to: 0.7 },
      { from: 0.1, to: 0.2 },
      { from: 0.2, to: 0.25 },
      { from: 0.15, to: 0.18 },
    ], 100),
    [{ top: 10, height: 15 }, { top: 60, height: 10 }],
  );
});

Deno.test('rulerSpans clamps, skips non-numbers, and draws nothing on no track', () => {
  assertEquals(rulerSpans([{ from: -1, to: 2 }, { from: NaN, to: 1 }], 50), [
    { top: 0, height: 50 },
  ]);
  assertEquals(rulerSpans([{ from: 0.2, to: 0.4 }], 0), []);
});
