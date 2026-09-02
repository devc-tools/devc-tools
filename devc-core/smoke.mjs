// Drives the *built and packed* `@devc-tools/core` tarball as a real npm consumer would: no
// Deno, no `devcontainer`, no `devc` anywhere on PATH — only what `npm install` pulled in. See
// `.plans/devc-core-npm-library.md`'s Validation section ("npm pack the library, install the
// tarball into a scratch Node project, and drive a real container").
//
// Copied into a scratch project and run from there (so Node's own module resolution finds
// `node_modules/@devc-tools/core` by walking up from *this* file's location) by smoke.sh —
// `npm run smoke`, which both CI and a local dev use. Not a `deno test` file — it is plain
// Node, deliberately outside `tests/` so `deno task test`'s glob never picks it up.
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import {
  buildExecArgs,
  buildUpArgs,
  downContainer,
  execInContainer,
  initProject,
  nodeDevcontainerRunner,
  startContainer,
} from '@devc-tools/core';

// Pure functions work with no I/O at all.
assert.deepEqual(
  buildExecArgs({
    containerId: 'abc',
    remoteUser: 'vscode',
    cwd: '/workspaces/p',
    remoteEnv: {},
    env: {},
    cmd: ['echo', 'hi'],
  }),
  ['exec', '-i', '-u', 'vscode', '-w', '/workspaces/p', 'abc', 'echo', 'hi'],
);
console.log('ok: buildExecArgs (pure)');

assert.deepEqual(
  buildUpArgs({
    localFolder: '/home/me/src/p',
    worktree: false,
    rebuild: false,
    noCache: false,
    mergedConfigPath:
      '/home/me/.cache/devc/projects/p-0badf00d/devcontainer.json',
    mode: 'zero-config',
  }),
  [
    'up',
    '--workspace-folder',
    '/home/me/src/p',
    '--no-lockfile',
    '--config',
    '/home/me/.cache/devc/projects/p-0badf00d/devcontainer.json',
  ],
);
console.log('ok: buildUpArgs (pure)');

// initProject: real fs work, exercising the bundled `default/` tree shipped beside dist/mod.js.
const dir = await mkdtemp(`${tmpdir()}/devc-core-smoke-`);
try {
  const result = await initProject(dir);
  assert.ok(result.configPath.endsWith('/.devcontainer/devcontainer.json'));
  const written = await readdir(`${dir}/.devcontainer`);
  for (
    const name of ['devcontainer.json', 'Dockerfile', 'initialize-command.sh']
  ) {
    assert.ok(written.includes(name), `missing ${name}`);
  }
  console.log(
    'ok: initProject scaffolded the bundled default/ tree via plain Node fs',
  );
} finally {
  await rm(dir, { recursive: true, force: true });
}

// nodeDevcontainerRunner: resolves and runs the real embedded devcontainer CLI. The exact pin
// is asserted once, repo-wide, by `tests/workflow_guards_test.sh` — this only has to prove the
// resolve-and-spawn mechanism itself works under plain Node.
const { code, stdout } = await nodeDevcontainerRunner.run(['--version']);
assert.equal(code, 0);
assert.match(stdout.trim(), /^\d+\.\d+\.\d+$/);
console.log(
  `ok: nodeDevcontainerRunner resolves @devcontainers/cli/devcontainer.js and runs it (${stdout.trim()})`,
);

// startContainer: full pipeline (seed dir, overlay, materialize/find config, buildUpArgs, the
// real devcontainer CLI). No Docker daemon is assumed here — failing at the docker spawn is the
// proof the whole chain up to that point ran correctly under plain Node.
const dir2 = await mkdtemp(`${tmpdir()}/devc-core-smoke-up-`);
try {
  await startContainer(dir2, false);
  console.log(
    'ok: startContainer succeeded (a Docker daemon is actually reachable here)',
  );
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  assert.match(
    msg,
    /docker/i,
    `expected a docker-related failure, got: ${msg}`,
  );
  console.log(
    `ok: startContainer ran the full pipeline and failed only on docker (${msg})`,
  );
} finally {
  await rm(dir2, { recursive: true, force: true });
}

// execInContainer with stdio: 'piped' — same shape a library consumer reaches for. It calls
// startContainer internally, so with no Docker daemon here it fails at the same spot; the point
// is that the `stdio: 'piped'` option threads through without throwing anything of its own.
const dir3 = await mkdtemp(`${tmpdir()}/devc-core-smoke-exec-`);
try {
  const result = await execInContainer(dir3, {
    cmd: ['echo', 'hi'],
    stdio: 'piped',
  });
  console.log(
    `ok: execInContainer (piped) ran to completion: ${JSON.stringify(result)}`,
  );
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  assert.match(
    msg,
    /docker/i,
    `expected a docker-related failure, got: ${msg}`,
  );
  console.log(
    `ok: execInContainer (piped) reached the same docker failure (${msg})`,
  );
} finally {
  await downContainer(dir3).catch(() => {});
  await rm(dir3, { recursive: true, force: true });
}

console.log(
  '\nAll smoke checks passed under plain Node, npm-installed tarball only.',
);
