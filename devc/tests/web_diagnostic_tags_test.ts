import { assertEquals } from 'jsr:@std/assert';
import {
  SUPPORTED_TAGS,
  tagClasses,
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
