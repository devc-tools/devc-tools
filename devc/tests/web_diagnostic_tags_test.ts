import { assertEquals } from 'jsr:@std/assert';
import {
  SUPPORTED_TAGS,
  tagClasses,
  tagMarks,
} from '../web/static/lib/diagnostic_tags.js';

Deno.test('tagClasses maps Deprecated and Unnecessary to their classes', () => {
  assertEquals(tagClasses([2]), 'cm-lsp-deprecated');
  assertEquals(tagClasses([1]), 'cm-lsp-unnecessary');
  assertEquals(tagClasses([1, 2]), 'cm-lsp-deprecated cm-lsp-unnecessary');
});

Deno.test('tagClasses ignores missing, empty, malformed and unknown tags', () => {
  assertEquals(tagClasses(undefined), undefined);
  assertEquals(tagClasses(null), undefined);
  assertEquals(tagClasses([]), undefined);
  assertEquals(tagClasses('2'), undefined);
  assertEquals(tagClasses([3, '2']), undefined);
});

Deno.test('the page asks for both tags', () => {
  assertEquals(SUPPORTED_TAGS, [1, 2]);
});

const range = (l1: number, c1: number, l2: number, c2: number) => ({
  start: { line: l1, character: c1 },
  end: { line: l2, character: c2 },
});

Deno.test('tagMarks: tagged diagnostics by line, untagged ones left out', () => {
  const marks = tagMarks([
    { range: range(2, 4, 2, 12), tags: [2], severity: 4 },
    { range: range(2, 0, 2, 3), severity: 1 },
    { range: range(5, 2, 5, 8), tags: [1] },
    { range: range(7, 0, 7, 1), tags: [1, 2] },
  ]);
  assertEquals([...marks.keys()], [2, 5, 7]);
  assertEquals(marks.get(2), [{ from: 4, to: 12, tag: 'deprecated' }]);
  assertEquals(marks.get(5), [{ from: 2, to: 8, tag: 'unnecessary' }]);
  assertEquals(marks.get(7), [
    { from: 0, to: 1, tag: 'deprecated' },
    { from: 0, to: 1, tag: 'unnecessary' },
  ]);
});

Deno.test('tagMarks: a range over lines marks each line its part', () => {
  const marks = tagMarks([{ range: range(1, 6, 3, 2), tags: [1] }]);
  assertEquals(marks.get(1), [{ from: 6, to: null, tag: 'unnecessary' }]);
  assertEquals(marks.get(2), [{ from: 0, to: null, tag: 'unnecessary' }]);
  assertEquals(marks.get(3), [{ from: 0, to: 2, tag: 'unnecessary' }]);
  // Ending at a line's start leaves that line out.
  assertEquals(
    [...tagMarks([{ range: range(1, 6, 2, 0), tags: [2] }]).keys()],
    [1],
  );
});

Deno.test('tagMarks: empty, reversed and malformed diagnostics give nothing', () => {
  assertEquals(tagMarks(null).size, 0);
  assertEquals(tagMarks([null, {}, { tags: [2] }]).size, 0);
  assertEquals(tagMarks([{ range: range(1, 3, 1, 3), tags: [2] }]).size, 0);
  assertEquals(tagMarks([{ range: range(2, 0, 1, 3), tags: [2] }]).size, 0);
  assertEquals(
    tagMarks([{
      range: {
        start: { line: -1, character: 0 },
        end: { line: 0, character: 1 },
      },
      tags: [2],
    }]).size,
    0,
  );
});
