// Every `docker exec` devc makes into a devcontainer — the CLI's and `devc web`'s alike — must be
// built by core's `dockerExecArgv`, so they all reach the container the same way (user,
// `remoteEnv`, working directory). A hand-built argv is how `devc web` once started Herdr servers
// without `remoteEnv`. This fails on any `'exec',` array element outside `dockerExecArgv`'s own
// file; an object property (`action: 'exec',`) or a call argument (`f('exec', …)`) is not one.

import { assertEquals } from 'jsr:@std/assert@^1';
import { fromFileUrl, join, relative } from 'jsr:@std/path';

const ROOT = fromFileUrl(new URL('../../', import.meta.url));
const ALLOWED = new Set(['devc-core/container.ts']);
// An array element: first on its line, or right after `[`.
const EXEC_ELEMENT = /(^\s*|\[\s*)['"]exec['"]\s*,/;

async function* sources(dir: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(dir)) {
    const path = join(dir, entry.name);
    if (entry.isDirectory) {
      if (['tests', 'node_modules', 'vendor', 'static'].includes(entry.name)) {
        continue;
      }
      yield* sources(path);
    } else if (entry.name.endsWith('.ts')) {
      yield path;
    }
  }
}

Deno.test('only dockerExecArgv builds a docker exec argv', async () => {
  const offenders: string[] = [];
  for (const top of ['devc', 'devc-core']) {
    for await (const path of sources(join(ROOT, top))) {
      const rel = relative(ROOT, path);
      if (ALLOWED.has(rel)) continue;
      const lines = (await Deno.readTextFile(path)).split('\n');
      lines.forEach((line, i) => {
        if (EXEC_ELEMENT.test(line)) offenders.push(`${rel}:${i + 1}`);
      });
    }
  }
  assertEquals(offenders, [], 'use dockerExecArgv from devc-core/container.ts');
});
