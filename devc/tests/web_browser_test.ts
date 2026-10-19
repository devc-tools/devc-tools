import { assertEquals } from 'jsr:@std/assert';
import { openCommand, openPath, openRedirect } from '../web/browser.ts';

Deno.test('openRedirect: the link redirects to the token once, then 404s', () => {
  const answer = openRedirect('n1', 'tok');
  assertEquals(answer('/index.html'), null);
  assertEquals(answer('/open/wrong')?.status, 404);
  const first = answer(openPath('n1'));
  assertEquals(first?.status, 303);
  assertEquals(first?.headers.get('location'), '/#token=tok');
  assertEquals(answer(openPath('n1'))?.status, 404);
});

Deno.test('openRedirect: without a nonce, /open/ is never a redirect', () => {
  const answer = openRedirect(undefined, 'tok');
  assertEquals(answer('/open/undefined')?.status, 404);
  assertEquals(answer('/'), null);
});

Deno.test('openCommand per OS, and none on Linux without a display', () => {
  const none = () => undefined;
  assertEquals(openCommand('darwin', 'u', none), ['open', 'u']);
  assertEquals(openCommand('windows', 'u', none), [
    'cmd',
    '/c',
    'start',
    '',
    'u',
  ]);
  assertEquals(openCommand('linux', 'u', none), null);
  assertEquals(
    openCommand('linux', 'u', (k) => k === 'WAYLAND_DISPLAY' ? 'w' : undefined),
    ['xdg-open', 'u'],
  );
});
