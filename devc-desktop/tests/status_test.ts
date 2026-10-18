import { assertEquals, assertStringIncludes } from 'jsr:@std/assert';
import { RESTART_HEADER, type Status, statusHandler } from '../status.ts';

const STATUS: Status = {
  phase: 'failed',
  message: 'devc web exited (1)',
  stderr: ['docker not found on PATH'],
};

function handler() {
  let restarts = 0;
  const h = statusHandler(() => STATUS, () => restarts++);
  return { h, restarts: () => restarts };
}

const req = (path: string, init: RequestInit & { host?: string } = {}) =>
  new Request(`http://127.0.0.1:5555${path}`, {
    ...init,
    headers: { host: init.host ?? '127.0.0.1:5555', ...init.headers },
  });

Deno.test('statusHandler: the page and its state', async () => {
  const { h } = handler();
  const page = h(req('/'));
  assertEquals(page.status, 200);
  assertStringIncludes(await page.text(), '<title>devc web</title>');
  assertEquals(await h(req('/state')).json(), STATUS);
  assertEquals(h(req('/state', { host: 'localhost:5555' })).status, 200);
  assertEquals(h(req('/nope')).status, 404);
});

Deno.test('statusHandler: a foreign Host is refused (DNS rebinding)', () => {
  const { h } = handler();
  assertEquals(h(req('/state', { host: 'evil.example:5555' })).status, 403);
});

Deno.test('statusHandler: restart needs POST and the custom header', () => {
  const { h, restarts } = handler();
  assertEquals(h(req('/restart', { method: 'POST' })).status, 403);
  assertEquals(h(req('/restart')).status, 404);
  assertEquals(restarts(), 0);
  const ok = h(
    req('/restart', { method: 'POST', headers: { [RESTART_HEADER]: '1' } }),
  );
  assertEquals(ok.status, 204);
  assertEquals(restarts(), 1);
});
