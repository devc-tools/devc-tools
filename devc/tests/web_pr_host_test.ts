import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert';
import { fromFileUrl, join } from 'jsr:@std/path';
import { grantsProblem, parsePolicy } from '@devc-tools/core/bridge.ts';
import {
  HOST_PR_GRANTS,
  hostPolicyDir,
  hostPrBackend,
  hostPrKey,
  materializeHostBuiltins,
} from '../web/pr_host.ts';
import { parsePrFiles } from '../web/pr_review.ts';
import type { EnvExec, RunLimits } from '../web/environment.ts';
import { runCapped } from '../web/proc.ts';

const LIMITS: RunLimits = { timeoutMs: 30_000, maxOutput: 1 << 20 };
const BUILTINS = fromFileUrl(
  new URL('../../devc-bridge/builtin/', import.meta.url),
);

async function git(cwd: string, ...args: string[]) {
  const out = await new Deno.Command('git', {
    args,
    cwd,
    stdout: 'null',
    stderr: 'piped',
    env: {
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
    },
  }).output();
  if (out.code !== 0) throw new Error(new TextDecoder().decode(out.stderr));
}

/** A temp dir holding a repo (`repo/`, origin `remote`, on branch `feat`) and a home (`home/`). */
async function fixture(remote = 'https://github.com/o/r.git') {
  const dir = await Deno.realPath(
    await Deno.makeTempDir({ prefix: 'pr-host-' }),
  );
  const repo = join(dir, 'repo');
  await Deno.mkdir(repo);
  await git(repo, 'init', '-q', '-b', 'feat');
  await git(repo, 'remote', 'add', 'origin', remote);
  await Deno.mkdir(join(dir, 'home'));
  return { dir, repo, home: join(dir, 'home') };
}

/** An environment whose limited runs are local, with `path` first on PATH. */
const envWith = (path: string) => ({
  runLimited: (x: EnvExec, limits: RunLimits) =>
    runCapped(x.cmd[0], x.cmd.slice(1), limits, {
      ...(x.cwd !== undefined ? { cwd: x.cwd } : {}),
      env: { ...x.env, PATH: `${path}:${Deno.env.get('PATH') ?? ''}` },
    }),
});

Deno.test('HOST_PR_GRANTS is a valid grant list: every PR capability, canonical order', () => {
  assertEquals(grantsProblem(HOST_PR_GRANTS), null);
  assert(!HOST_PR_GRANTS.includes('gh-push'));
  assert(!HOST_PR_GRANTS.includes('gh-pr-resolve-copilot'));
});

Deno.test('hostPrKey: web- and 16 hex chars, per folder', () => {
  assert(/^web-[0-9a-f]{16}$/.test(hostPrKey('/src/app')));
  assertEquals(hostPrKey('/src/app'), hostPrKey('/src/app'));
  assert(hostPrKey('/src/app') !== hostPrKey('/src/lib'));
});

Deno.test('host pin: target is the repo folder; a detached HEAD or another remote is the problem', async () => {
  const t = await fixture();
  try {
    const pr = hostPrBackend({
      env: envWith('/nowhere'),
      home: t.home,
      builtins: () => Promise.resolve(BUILTINS),
    });
    assertEquals(await pr.pin(t.repo), {
      target: t.repo,
      grants: HOST_PR_GRANTS,
    });
    await Deno.writeTextFile(join(t.repo, '.git/HEAD'), `${'a'.repeat(40)}\n`);
    const detached = await pr.pin(t.repo);
    assert('problem' in detached);
    assertStringIncludes(detached.problem, 'detached');
  } finally {
    await Deno.remove(t.dir, { recursive: true });
  }
  const other = await fixture('https://gitlab.com/o/r.git');
  try {
    const pr = hostPrBackend({
      env: envWith('/nowhere'),
      home: other.home,
      builtins: () => Promise.resolve(BUILTINS),
    });
    assertEquals(await pr.pin(other.repo), {
      problem: 'https://gitlab.com/o/r.git is not a GitHub remote',
    });
  } finally {
    await Deno.remove(other.dir, { recursive: true });
  }
});

Deno.test('host run: the recipe gets its key, policy dir and --repo, and a 0600 policy of one line', async () => {
  const t = await fixture();
  try {
    const recipes = join(t.dir, 'recipes');
    await Deno.mkdir(recipes);
    await Deno.writeTextFile(
      join(recipes, 'gh-pr-files'),
      '#!/bin/sh\nprintf "%s\\n" "KEY=$DEVC_BRIDGE_KEY" "DIR=$DEVC_BRIDGE_POLICY_DIR" "PWD=$(pwd)" "$@"\n',
    );
    await Deno.chmod(join(recipes, 'gh-pr-files'), 0o755);
    const pr = hostPrBackend({
      env: envWith('/nowhere'),
      home: t.home,
      builtins: () => Promise.resolve(recipes),
    });
    const run = await pr.run('gh-pr-files', t.repo, ['--as', 'human'], LIMITS);
    assert(run.kind === 'exit');
    const key = hostPrKey(t.repo);
    const dir = hostPolicyDir(t.home);
    assertEquals(run.stdout.trimEnd().split('\n'), [
      `KEY=${key}`,
      `DIR=${dir}`,
      'PWD=/',
      '--repo',
      t.repo,
      '--as',
      'human',
    ]);
    const file = join(dir, `${key}.conf`);
    assertEquals((await Deno.stat(file)).mode! & 0o777, 0o600);
    assertEquals((await Deno.stat(dir)).mode! & 0o777, 0o700);
    assertEquals(parsePolicy(await Deno.readTextFile(file)), {
      repos: [{
        repo: t.repo,
        remote: 'https://github.com/o/r.git',
        branch: 'feat',
        grants: HOST_PR_GRANTS,
        target: t.repo,
      }],
    });
  } finally {
    await Deno.remove(t.dir, { recursive: true });
  }
});

/** A `gh` that answers gh-pr-files' calls from fixtures, applying `--jq` with the real `jq`. */
const GH_STUB = String.raw`#!/usr/bin/env bash
[ "$1" = auth ] && exit 0
shift # api
jqf='' query='' endpoint=''
while [ $# -gt 0 ]; do
  case $1 in
    --jq) jqf=$2; shift 2 ;;
    -f|-F) case $2 in query=*) query=$2 ;; esac; shift 2 ;;
    --paginate) shift ;;
    *) endpoint=$1; shift ;;
  esac
done
case $endpoint in
  repos/o/r) json='{"full_name":"o/r"}' ;;
  graphql)
    case $query in
      *pullRequests*) json='{"data":{"repository":{"pullRequests":{"nodes":[{"id":"PR_kw1","number":7,"url":"https://github.com/o/r/pull/7","headRefOid":"0123456789abcdef0123456789abcdef01234567","headRepository":{"nameWithOwner":"o/r"},"baseRepository":{"nameWithOwner":"o/r"}}]}}}}' ;;
      *) json='{"data":{"repository":{"pullRequest":{"title":"Fix it","state":"OPEN","isDraft":false,"baseRefName":"main","headRefName":"feat","changedFiles":1,"author":{"login":"me"},"files":{"pageInfo":{"hasNextPage":false,"endCursor":null},"nodes":[{"path":"src/a.ts","viewerViewedState":"VIEWED"}]}}}}}' ;;
    esac ;;
  repos/o/r/pulls/7/files*) json='[{"filename":"src/a.ts","status":"modified","additions":1,"deletions":0,"patch":"@@ -1 +1,2 @@\n a\n+b"}]' ;;
  *) echo "unexpected gh api $endpoint" >&2; exit 1 ;;
esac
printf '%s' "$json" | jq -r "$jqf"
`;

Deno.test({
  name:
    'the real gh-pr-files takes the synthesized policy, and its listing parses',
  ignore: Deno.build.os === 'windows',
  fn: async () => {
    const t = await fixture();
    try {
      const bin = join(t.dir, 'bin');
      await Deno.mkdir(bin);
      await Deno.writeTextFile(join(bin, 'gh'), GH_STUB);
      await Deno.chmod(join(bin, 'gh'), 0o755);
      const pr = hostPrBackend({
        env: envWith(bin),
        home: t.home,
        builtins: () => Promise.resolve(BUILTINS),
      });
      const run = await pr.run('gh-pr-files', t.repo, [], LIMITS);
      assert(run.kind === 'exit');
      assertEquals([run.code, run.stderr], [0, '']);
      const files = parsePrFiles(run.stdout);
      assert(files !== null, run.stdout);
      assertEquals(files.pr.number, 7);
      assertEquals(
        files.files.map((f) => [f.path, f.viewed]),
        [['src/a.ts', 'VIEWED']],
      );
    } finally {
      await Deno.remove(t.dir, { recursive: true });
    }
  },
});

Deno.test('materializeHostBuiltins copies every gh-pr-* recipe, executable, and replaces the old set', async () => {
  const dir = await Deno.makeTempDir();
  try {
    const target = join(dir, 'web-builtin');
    await Deno.mkdir(target);
    await Deno.writeTextFile(join(target, 'stale'), '');
    await materializeHostBuiltins(target);
    const names = [];
    for await (const e of Deno.readDir(target)) names.push(e.name);
    assert(names.includes('gh-pr-files'));
    assert(!names.includes('gh-push') && !names.includes('stale'));
    assert(names.every((n) => n.startsWith('gh-pr-')));
    assertEquals(
      (await Deno.stat(join(target, 'gh-pr-files'))).mode! & 0o777,
      0o755,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
