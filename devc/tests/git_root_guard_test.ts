// The ancestor-repo mount guard, driven with injected deps: no Docker, no TTY, no filesystem.

import { assertEquals, assertRejects } from 'jsr:@std/assert@^1';
import type { MergedConfig } from '@devc-tools/core/merged_config.ts';
import {
  ancestorRepoRoot,
  guardAncestorRepoMount,
  type GuardDeps,
} from '../git_root_guard.ts';

const PROJECT = '/home/me/code/new-project';
const ANCESTOR = '/home/me/code';

const rootAt = (root: string | null) => () => Promise.resolve(root);

function merged(config: MergedConfig['config'] = {}): MergedConfig {
  return { config } as MergedConfig;
}

/** Deps recording what was warned and asked; `answer` null means "no terminal". */
function deps(opts: {
  root: string | null;
  exists?: boolean;
  answer?: boolean | null;
}) {
  const warned: string[] = [];
  const asked: string[] = [];
  const answer = opts.answer === undefined ? true : opts.answer;
  const d: GuardDeps = {
    findRoot: rootAt(opts.root),
    containerExists: () => Promise.resolve(opts.exists ?? false),
    confirm: answer === null ? null : (q) => {
      asked.push(q);
      return Promise.resolve(answer);
    },
    warn: (m) => warned.push(m),
  };
  return { d, warned, asked };
}

Deno.test('ancestorRepoRoot: only an ancestor root counts', async () => {
  assertEquals(await ancestorRepoRoot({}, PROJECT, rootAt(ANCESTOR)), ANCESTOR);
  assertEquals(await ancestorRepoRoot({}, PROJECT, rootAt(PROJECT)), null);
  assertEquals(await ancestorRepoRoot({}, PROJECT, rootAt(null)), null);
});

Deno.test('ancestorRepoRoot: config-decided mounts are left alone', async () => {
  const find = rootAt(ANCESTOR);
  assertEquals(
    await ancestorRepoRoot(
      { workspaceMount: 'source=/x,target=/y,type=bind' },
      PROJECT,
      find,
    ),
    null,
  );
  assertEquals(
    await ancestorRepoRoot({ dockerComposeFile: 'compose.yml' }, PROJECT, find),
    null,
  );
});

Deno.test('guard: asks before creating, proceeds on yes', async () => {
  const { d, warned, asked } = deps({ root: ANCESTOR, answer: true });
  await guardAncestorRepoMount(merged(), PROJECT, false, d);
  assertEquals(warned.length, 1);
  assertEquals(asked, [`Mount ${ANCESTOR} anyway?`]);
});

Deno.test('guard: declining throws', async () => {
  const { d } = deps({ root: ANCESTOR, answer: false });
  await assertRejects(
    () => guardAncestorRepoMount(merged(), PROJECT, false, d),
    Error,
    'cancelled',
  );
});

Deno.test('guard: silent once the container exists', async () => {
  const { d, warned, asked } = deps({ root: ANCESTOR, exists: true });
  await guardAncestorRepoMount(merged(), PROJECT, false, d);
  assertEquals(warned, []);
  assertEquals(asked, []);
});

Deno.test('guard: a rebuild asks again even with a container', async () => {
  const { d, asked } = deps({ root: ANCESTOR, exists: true });
  await guardAncestorRepoMount(merged(), PROJECT, true, d);
  assertEquals(asked.length, 1);
});

Deno.test('guard: no terminal warns and proceeds', async () => {
  const { d, warned } = deps({ root: ANCESTOR, answer: null });
  await guardAncestorRepoMount(merged(), PROJECT, false, d);
  assertEquals(warned.length, 1);
});

Deno.test('guard: a project that is its own repo root is not asked about', async () => {
  const { d, warned, asked } = deps({ root: PROJECT });
  await guardAncestorRepoMount(merged(), PROJECT, false, d);
  assertEquals(warned, []);
  assertEquals(asked, []);
});
