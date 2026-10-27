import { assert, assertEquals } from 'jsr:@std/assert';
import { lead } from '../web/leader.ts';

/** Resolves once `cond` holds, polling every few ms; fails after `ms`. */
async function until(cond: () => boolean, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    assert(Date.now() < deadline, 'timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

Deno.test('lead: one server leads; another takes over when it stops', async () => {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/sub/web-leader.lock`;
  const led: string[] = [];
  const a = lead(() => led.push('a'), { path, retryMs: 20 });
  await until(() => a.leading());
  const b = lead(() => led.push('b'), { path, retryMs: 20 });
  try {
    // b keeps trying while a holds the lock.
    await new Promise((r) => setTimeout(r, 100));
    assertEquals(led, ['a']);
    assert(!b.leading());

    a.stop();
    assert(!a.leading());
    await until(() => b.leading());
    assertEquals(led, ['a', 'b']);
  } finally {
    a.stop();
    b.stop();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('lead: stopped before its first try returns, it never leads and frees the lock', async () => {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/web-leader.lock`;
  let called = false;
  const a = lead(() => called = true, { path, retryMs: 20 });
  a.stop();
  const b = lead(() => {}, { path, retryMs: 20 });
  try {
    await until(() => b.leading());
    assert(!called);
    assert(!a.leading());
  } finally {
    b.stop();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('lead: a lock that cannot be opened leads anyway, and says why', async () => {
  const dir = await Deno.makeTempDir();
  // A file where its folder should be: the open fails.
  await Deno.writeTextFile(`${dir}/file`, '');
  const errors: unknown[] = [];
  const a = lead(() => {}, {
    path: `${dir}/file/web-leader.lock`,
    onError: (e) => errors.push(e),
  });
  try {
    await until(() => a.leading());
    assertEquals(errors.length, 1);
  } finally {
    a.stop();
    await Deno.remove(dir, { recursive: true });
  }
});
