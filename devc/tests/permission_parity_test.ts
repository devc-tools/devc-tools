import { assertEquals } from 'jsr:@std/assert@^1';
import { devcontainerArgv } from '../devcontainer_selfexec.ts';
import { fromFileUrl } from 'jsr:@std/path';

/**
 * Four places spell out the Deno permissions devc runs with, and they must agree. Nothing used
 * to check that, and they drifted: `scripts/bash_aliases.sh` was missing `--allow-sys` while
 * `SOURCE_CHILD_PERMISSIONS` had it, even though that constant's own doc comment says to keep
 * them in step.
 *
 * The drift was invisible for as long as the embedded devcontainer CLI only ever ran in a child
 * process spawned with `SOURCE_CHILD_PERMISSIONS`. It surfaced the moment something ran the CLI
 * *in* a from-source devc — `devc __devcontainer …`, which each Feature's own
 * `test/run-features-test.sh` now does — because then the permissions come from whatever
 * launched devc. The CLI calls
 * `os.release()` while starting any real subcommand and dies without `--allow-sys` on a bare
 * `Object.release (ext:deno_node/os.ts)` stack. `--version` and `--help` return before that
 * call, so neither smoke-tests it.
 *
 * The canonical set is read out of {@link devcontainerArgv} rather than scraped from source, so
 * this test cannot drift from the constant it is guarding. The other three are parsed, since
 * they live in a shell script and a task definition.
 *
 * Order is not compared — the four lists genuinely differ in order today and that is harmless.
 * Membership is what matters.
 */

/** The permissions {@link devcontainerArgv} actually hands a from-source child. */
const CANONICAL: string[] = devcontainerArgv([], {
  execPath: '/unused',
  standalone: false,
  mainModule: 'file:///unused/main.ts',
}).filter((arg) => arg.startsWith('--allow-')).sort();

async function repoText(relative: string): Promise<string> {
  return await Deno.readTextFile(fromFileUrl(import.meta.resolve(relative)));
}

/** Every distinct `--allow-*` flag in `text`, sorted. */
function allowFlags(text: string): string[] {
  return [...new Set(text.match(/--allow-[a-z-]+/g) ?? [])].sort();
}

Deno.test('the canonical permission set is non-empty and includes --allow-sys', () => {
  // Guards the guard: a devcontainerArgv refactor that stopped emitting permissions would
  // otherwise make every assertion below trivially pass against an empty list.
  assertEquals(
    CANONICAL.length > 0,
    true,
    'devcontainerArgv emitted no --allow-* flags',
  );
  assertEquals(
    CANONICAL.includes('--allow-sys'),
    true,
    '--allow-sys is required: the embedded devcontainer CLI calls os.release() on startup',
  );
});

Deno.test("scripts/bash_aliases.sh's _DEVC_TOOLS_PERMS matches SOURCE_CHILD_PERMISSIONS", async () => {
  const source = await repoText('../../scripts/bash_aliases.sh');
  const assignment = /^_DEVC_TOOLS_PERMS="([^"]*)"/m.exec(source);
  assertEquals(
    assignment !== null,
    true,
    'could not find the _DEVC_TOOLS_PERMS assignment in scripts/bash_aliases.sh',
  );
  // The assignment's own value only — the surrounding comments name individual flags, and a
  // whole-file scan would match those too and pass no matter what the variable holds.
  assertEquals(allowFlags(assignment![1]), CANONICAL);
});

Deno.test("devc/deno.json's compile tasks match SOURCE_CHILD_PERMISSIONS", async () => {
  // Parsed rather than JSON.parse'd: deno.json permits comments, so it is not strict JSON.
  const source = await repoText('../deno.json');
  const tasks = [...source.matchAll(/"(build(?::release)?)":\s*"([^"]*)"/g)];
  assertEquals(
    tasks.map((t) => t[1]).sort(),
    ['build', 'build:release'],
    'expected exactly the build and build:release tasks in devc/deno.json',
  );
  for (const [, name, command] of tasks) {
    assertEquals(
      allowFlags(command),
      CANONICAL,
      `task "${name}" has a different permission set`,
    );
  }
});
