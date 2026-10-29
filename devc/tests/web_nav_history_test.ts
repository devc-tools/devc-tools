import { assertEquals } from 'jsr:@std/assert';
import {
  createNavHistory,
  navButton,
  navKey,
} from '../web/static/lib/nav_history.js';

Deno.test('createNavHistory: back and forward step through the places jumped from', () => {
  const nav = createNavHistory<string>();
  assertEquals(nav.canBack, false);
  assertEquals(nav.back('a'), null);
  // Nothing to go back to: the current place isn't kept.
  assertEquals(nav.canForward, false);
  nav.push('a');
  nav.push('b');
  assertEquals(nav.back('c'), 'b');
  assertEquals(nav.back('b'), 'a');
  assertEquals(nav.canBack, false);
  assertEquals(nav.forward('a'), 'b');
  assertEquals(nav.forward('b'), 'c');
  assertEquals(nav.canForward, false);
  assertEquals(nav.back('c'), 'b');
});

Deno.test('createNavHistory: a jump clears forward', () => {
  const nav = createNavHistory<string>();
  nav.push('a');
  assertEquals(nav.back('b'), 'a');
  assertEquals(nav.canForward, true);
  nav.push('a');
  assertEquals(nav.canForward, false);
  assertEquals(nav.back('x'), 'a');
});

Deno.test('createNavHistory: a place equal to the top is kept once', () => {
  const nav = createNavHistory<{ line: number }>();
  nav.push({ line: 3 });
  nav.push({ line: 3 });
  assertEquals(nav.back(null), { line: 3 });
  assertEquals(nav.canBack, false);
  // Going back without a current place keeps nothing for forward.
  assertEquals(nav.canForward, false);
});

Deno.test('createNavHistory: only the newest `limit` places are kept', () => {
  const nav = createNavHistory<number>(2);
  nav.push(1);
  nav.push(2);
  nav.push(3);
  assertEquals(nav.back(null), 3);
  assertEquals(nav.back(null), 2);
  assertEquals(nav.back(null), null);
});

const key = (k: string, code: string, mods: string) => ({
  key: k,
  code,
  metaKey: mods.includes('meta'),
  ctrlKey: mods.includes('ctrl'),
  altKey: mods.includes('alt'),
  shiftKey: mods.includes('shift'),
});

Deno.test('navKey: Ctrl+- and Ctrl+Shift+- on a Mac, Alt+arrows elsewhere', () => {
  assertEquals(navKey(key('-', 'Minus', 'ctrl'), true), 'back');
  assertEquals(navKey(key('_', 'Minus', 'ctrl shift'), true), 'forward');
  // Cmd+- is the browser's zoom out.
  assertEquals(navKey(key('-', 'Minus', 'meta'), true), null);
  assertEquals(navKey(key('-', 'Minus', 'ctrl alt'), true), null);
  assertEquals(navKey(key('ArrowLeft', 'ArrowLeft', 'alt'), true), null);
  assertEquals(navKey(key('ArrowLeft', 'ArrowLeft', 'alt'), false), 'back');
  assertEquals(
    navKey(key('ArrowRight', 'ArrowRight', 'alt'), false),
    'forward',
  );
  assertEquals(navKey(key('ArrowLeft', 'ArrowLeft', 'alt shift'), false), null);
  assertEquals(navKey(key('ArrowLeft', 'ArrowLeft', 'ctrl alt'), false), null);
  assertEquals(navKey(key('ArrowLeft', 'ArrowLeft', ''), false), null);
  assertEquals(navKey(key('-', 'Minus', 'ctrl'), false), null);
});

Deno.test('navButton: the side buttons', () => {
  assertEquals(navButton({ button: 3 }), 'back');
  assertEquals(navButton({ button: 4 }), 'forward');
  assertEquals(navButton({ button: 0 }), null);
  assertEquals(navButton({ button: 1 }), null);
});
