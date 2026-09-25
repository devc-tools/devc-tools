// Recipes: never seeded, installed one at a time on purpose, never over an existing file.

import { assert, assertEquals, assertRejects } from '@std/assert';
import { join } from '@std/path';
import { installCommand, listRecipes, seedCommands } from '../config.ts';

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: 'devc-bridge-install-' });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

const recipe = (name: string) =>
  Deno.readFile(new URL(`../../recipes/${name}`, import.meta.url));

Deno.test('the git and PR review recipes exist', async () => {
  const names = await listRecipes();
  const want = [
    'git-push',
    'git-doctor',
    'pr-comments',
    'pr-reply',
    'pr-resolve',
  ];
  for (const name of want) assert(names.includes(name), `recipes: ${names}`);
});

Deno.test('a freshly seeded commands dir holds no recipe', async () => {
  await withDir(async (dir) => {
    const written = await seedCommands(dir);
    assert(written.length > 0, 'seeding wrote nothing at all');
    const present = [...Deno.readDirSync(dir)].map((e) => e.name);
    for (const name of await listRecipes()) {
      assert(!present.includes(name), `${name} was seeded`);
    }
  });
});

Deno.test('install-command copies the recipe in, executable', async () => {
  await withDir(async (dir) => {
    const commands = join(dir, 'commands'); // created on demand
    const path = await installCommand(commands, 'git-push');
    assertEquals(path, join(commands, 'git-push'));
    assertEquals(await Deno.readFile(path), await recipe('git-push'));
    assertEquals((await Deno.stat(path)).mode! & 0o777, 0o755);
  });
});

Deno.test('install-command never overwrites', async () => {
  await withDir(async (dir) => {
    const target = join(dir, 'git-push');
    await Deno.writeTextFile(target, '#!/bin/sh\necho mine\n');
    await assertRejects(
      () => installCommand(dir, 'git-push'),
      Error,
      'already exists',
    );
    assertEquals(await Deno.readTextFile(target), '#!/bin/sh\necho mine\n');
  });
});

Deno.test('install-command refuses to write through a dangling symlink', async () => {
  await withDir(async (dir) => {
    const victim = join(dir, 'victim');
    await Deno.symlink(victim, join(dir, 'git-push'));
    await assertRejects(
      () => installCommand(dir, 'git-push'),
      Error,
      'already exists',
    );
    await assertRejects(() => Deno.stat(victim), Deno.errors.NotFound);
  });
});

Deno.test('install-command refuses a name that is not a recipe', async () => {
  await withDir(async (dir) => {
    for (const name of ['nope', '../host/commands/echo', 'echo', '']) {
      await assertRejects(
        () => installCommand(dir, name),
        Error,
        'no recipe named',
      );
    }
    assertEquals([...Deno.readDirSync(dir)], []);
  });
});
