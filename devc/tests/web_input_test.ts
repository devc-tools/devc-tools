import { assertEquals } from 'jsr:@std/assert';
import {
  decodeBase64,
  encodeInput,
  mouseButton,
  pixelToCell,
  selectionSpan,
  wheelToScroll,
  wrapPaste,
} from '../web/static/lib/input.js';

Deno.test('wrapPaste leaves a single line unchanged', () => {
  assertEquals(wrapPaste('echo hi'), 'echo hi');
  assertEquals(wrapPaste(''), '');
});

Deno.test('wrapPaste brackets and normalizes a multi-line paste', () => {
  assertEquals(wrapPaste('a\nb'), '\x1b[200~a\rb\x1b[201~');
  assertEquals(wrapPaste('a\r\nb'), '\x1b[200~a\rb\x1b[201~');
  assertEquals(wrapPaste('a\rb'), '\x1b[200~a\rb\x1b[201~');
  assertEquals(wrapPaste('a\nb\n'), '\x1b[200~a\rb\r\x1b[201~');
});

Deno.test('pixelToCell is zero-based and clamped to the grid', () => {
  assertEquals(pixelToCell(0, 0, 8, 16, 80, 24), { column: 0, row: 0 });
  assertEquals(pixelToCell(7.9, 15.9, 8, 16, 80, 24), { column: 0, row: 0 });
  assertEquals(pixelToCell(24, 32, 8, 16, 80, 24), { column: 3, row: 2 });
  assertEquals(pixelToCell(-5, -5, 8, 16, 80, 24), { column: 0, row: 0 });
  assertEquals(pixelToCell(10000, 10000, 8, 16, 80, 24), {
    column: 79,
    row: 23,
  });
});

Deno.test('wheelToScroll clamps lines to 1..10', () => {
  assertEquals(wheelToScroll(-3, 16), { direction: 'up', lines: 1 });
  assertEquals(wheelToScroll(48, 16), { direction: 'down', lines: 3 });
  assertEquals(wheelToScroll(5000, 16), { direction: 'down', lines: 10 });
  assertEquals(wheelToScroll(-2, 16, 1), { direction: 'up', lines: 2 });
  assertEquals(wheelToScroll(1, 16, 2), { direction: 'down', lines: 10 });
  assertEquals(wheelToScroll(0, 16), null);
});

Deno.test('mouseButton maps 0/1/2 to left/middle/right', () => {
  assertEquals(mouseButton(0), 'left');
  assertEquals(mouseButton(1), 'middle');
  assertEquals(mouseButton(2), 'right');
  assertEquals(mouseButton(3), undefined);
});

Deno.test('encodeInput is UTF-8 then base64, and decodeBase64 inverts it', () => {
  assertEquals(encodeInput('\x1b[A'), btoa('\x1b[A'));
  const text = 'héllo ✓';
  assertEquals(
    new TextDecoder().decode(decodeBase64(encodeInput(text))),
    text,
  );
});

Deno.test('selectionSpan covers one row inclusively', () => {
  assertEquals(
    selectionSpan({ column: 2, row: 1 }, { column: 5, row: 1 }, 80),
    {
      column: 2,
      row: 1,
      length: 4,
    },
  );
});

Deno.test('selectionSpan wraps across rows and ignores order', () => {
  const span = { column: 70, row: 3, length: 15 };
  assertEquals(
    selectionSpan({ column: 70, row: 3 }, { column: 4, row: 4 }, 80),
    span,
  );
  assertEquals(
    selectionSpan({ column: 4, row: 4 }, { column: 70, row: 3 }, 80),
    span,
  );
  assertEquals(
    selectionSpan({ column: 9, row: 2 }, { column: 3, row: 2 }, 80),
    { column: 3, row: 2, length: 7 },
  );
});
