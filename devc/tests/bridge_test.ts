// devc-bridge per-container identity, side-effect half: the key directory, the policy's grant /
// refresh / revoke rules, teardown and prune — all against a temp `$HOME` and a fake mount table,
// so nothing here needs Docker. Every repo fixture carries a planted `core.fsmonitor`; its marker
// staying absent is the proof that none of this ran git on the "host".

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from 'jsr:@std/assert@^1';
import { bridgePaths } from '@devc-tools/core/bridge.ts';
import type { ContainerMount } from '@devc-tools/core/container.ts';
import {
  ensureMergedConfig,
  type MergedConfig,
  projectKey,
} from '@devc-tools/core/merged_config.ts';
import {
  applyPolicy,
  type BridgeDeps,
  BridgeGrantError,
  bridgeStatusLines,
  checkGrantBeforeUp,
  ensureKeyDir,
  pruneBridgeFiles,
  readPolicy,
  removeBridgeFiles,
} from '../bridge.ts';

const BRIDGE_FEATURE = 'ghcr.io/devc-tools/features/devc-bridge:0';

interface Fixture {
  dir: string;
  home: string;
  project: string;
  marker: string;
  logs: string[];
  /** A fully protected container: repo frozen, own key dir at `/run/devc-bridge`. */
  frozen: ContainerMount[];
  merged: (overlay?: Record<string, unknown>) => Promise<MergedConfig>;
  deps: (mounts: ContainerMount[] | null) => BridgeDeps;
  setHead: (text: string) => Promise<void>;
}

async function write(path: string, text: string): Promise<void> {
  await Deno.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true });
  await Deno.writeTextFile(path, text);
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * The mount table of a container with `target`'s repo frozen, as git protection leaves it, and
 * — when `keyDir` is given — its own devc-bridge key directory at `/run/devc-bridge`.
 */
function protectedMounts(
  target: string,
  keyDir?: string,
  gitDirSource = '/h/.git',
): ContainerMount[] {
  return [
    ...(keyDir === undefined ? [] : [{
      type: 'bind' as const,
      source: keyDir,
      destination: '/run/devc-bridge',
      rw: false,
    }]),
    { type: 'bind', source: '/h', destination: target, rw: true },
    { type: 'bind', source: '/h', destination: `${target}/.git`, rw: true },
    {
      type: 'bind',
      source: `${gitDirSource}/config`,
      destination: `${target}/.git/config`,
      rw: false,
    },
    {
      type: 'bind',
      source: '/h',
      destination: `${target}/.git/hooks`,
      rw: false,
    },
  ];
}

async function withFixture(fn: (f: Fixture) => Promise<void>): Promise<void> {
  const dir = await Deno.realPath(
    await Deno.makeTempDir({ prefix: 'devc-bridge-cli-' }),
  );
  try {
    const home = `${dir}/home`;
    const project = `${dir}/proj`;
    const marker = `${dir}/fsmonitor-fired`;
    const hook = `${dir}/fsmonitor.sh`;
    await write(hook, `#!/bin/sh\ntouch '${marker}'\n`);
    await Deno.chmod(hook, 0o755);
    await write(`${project}/.git/HEAD`, 'ref: refs/heads/feat/x\n');
    await Deno.mkdir(`${project}/.git/objects`, { recursive: true });
    await write(
      `${project}/.git/config`,
      `[core]\n\tfsmonitor = ${hook}\n[remote "origin"]\n\turl = git@github.com:acme/proj.git\n`,
    );
    const logs: string[] = [];
    const keyDir = bridgePaths(home, await projectKey(project)).keyDir;
    await fn({
      frozen: protectedMounts('/workspaces/proj', keyDir, `${project}/.git`),
      dir,
      home,
      project,
      marker,
      logs,
      merged: async (overlay = {}) => {
        await write(
          `${project}/.devcontainer/devcontainer.json`,
          JSON.stringify({
            image: 'ubuntu',
            features: { [BRIDGE_FEATURE]: {} },
          }),
        );
        await write(`${project}/.devc/devc.json`, JSON.stringify(overlay));
        return await ensureMergedConfig(project, {
          cacheRoot: `${dir}/cache`,
          templatesDir: `${dir}/no-templates`,
          configDir: `${dir}/config`,
        });
      },
      deps: (mounts) => ({
        home,
        mounts: () => Promise.resolve(mounts),
        log: (m) => logs.push(m),
      }),
      setHead: (text) => Deno.writeTextFile(`${project}/.git/HEAD`, text),
    });
    assertEquals(await exists(marker), false, 'something ran git in the repo');
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

const SHA1 = '0123456789abcdef0123456789abcdef01234567';

// ── the key directory ───────────────────────────────────────────────────────────────────────

Deno.test('ensureKeyDir creates keys/<key>/ with no token in it', async () => {
  await withFixture(async (f) => {
    const merged = await f.merged();
    await ensureKeyDir(merged, f.deps(null));
    const paths = bridgePaths(f.home, merged.bridgeKey!);
    assert((await Deno.stat(paths.keyDir)).isDirectory);
    assertEquals(await Array.fromAsync(Deno.readDir(paths.keyDir)), []);
  });
});

Deno.test('ensureKeyDir creates nothing without the devc-bridge Feature', async () => {
  await withFixture(async (f) => {
    const merged = await f.merged({ features: { [BRIDGE_FEATURE]: null } });
    assertEquals(merged.bridgeKey, null);
    await ensureKeyDir(merged, f.deps(null));
    assertEquals(await exists(`${f.home}/.config/devc-bridge`), false);
  });
});

// ── grant ───────────────────────────────────────────────────────────────────────────────────

Deno.test('grant writes the pin when the container has the repo frozen', async () => {
  await withFixture(async (f) => {
    const merged = await f.merged();
    await applyPolicy(
      'grant',
      merged,
      f.project,
      f.deps(f.frozen),
    );
    const key = await projectKey(f.project);
    const file = bridgePaths(f.home, key).policyFile;
    assertEquals(
      await Deno.readTextFile(file),
      `${f.project}\tgit@github.com:acme/proj.git\tfeat/x\n`,
    );
    assertEquals((await Deno.stat(file)).mode! & 0o777, 0o600);
    assertStringIncludes(f.logs.join('\n'), 'granted: feat/x');
  });
});

Deno.test('grant is refused, and an older policy removed, when the container is not frozen', async () => {
  await withFixture(async (f) => {
    const merged = await f.merged();
    // An older grant, from before the container was recreated without protection.
    await applyPolicy(
      'grant',
      merged,
      f.project,
      f.deps(f.frozen),
    );
    const unfrozen = f.frozen.map((m) => ({
      ...m,
      rw: true,
    }));
    const err = await assertRejects(
      () => applyPolicy('grant', merged, f.project, f.deps(unfrozen)),
      BridgeGrantError,
    );
    assertStringIncludes(err.message, 'git protection is not in force');
    assertStringIncludes(err.message, 'read-write');
    assertEquals(
      await readPolicy(await projectKey(f.project), f.deps(null)),
      { kind: 'absent' },
    );
  });
});

Deno.test('grant checks the live mounts, not the gitProtect key', async () => {
  // The config says protection is on; the (reused) container has none of the mounts. The key
  // alone must not be enough — that is the whole point of reading the mount table.
  await withFixture(async (f) => {
    const merged = await f.merged();
    assertEquals(merged.gitProtect, true);
    const bare = [{
      type: 'bind' as const,
      source: f.project,
      destination: '/workspaces/proj',
      rw: true,
    }];
    await assertRejects(
      () => applyPolicy('grant', merged, f.project, f.deps(bare)),
      BridgeGrantError,
      'not a mountpoint',
    );
  });
});

Deno.test('grant is refused for a container still on a hand-written run/ mount', async () => {
  // It authenticates with the shared token, which no pin applies to — a policy written for it
  // would be a grant that can never be used, and a status line that lies about it.
  await withFixture(async (f) => {
    const legacy = f.frozen.map((m) =>
      m.destination === '/run/devc-bridge'
        ? { ...m, source: `${f.home}/.config/devc-bridge/run` }
        : m
    );
    await assertRejects(
      async () =>
        applyPolicy('grant', await f.merged(), f.project, f.deps(legacy)),
      BridgeGrantError,
      'not its own',
    );
    const none = f.frozen.filter((m) => m.destination !== '/run/devc-bridge');
    await assertRejects(
      async () =>
        applyPolicy('grant', await f.merged(), f.project, f.deps(none)),
      BridgeGrantError,
      'nothing mounted at /run/devc-bridge',
    );
  });
});

Deno.test('grant with gitProtect off, no Feature, or no container: each named', async () => {
  await withFixture(async (f) => {
    const frozen = f.deps(f.frozen);
    await assertRejects(
      async () =>
        applyPolicy(
          'grant',
          await f.merged({ gitProtect: false }),
          f.project,
          frozen,
        ),
      BridgeGrantError,
      'gitProtect is off',
    );
    await assertRejects(
      async () =>
        applyPolicy(
          'grant',
          await f.merged({ features: { [BRIDGE_FEATURE]: null } }),
          f.project,
          frozen,
        ),
      BridgeGrantError,
      'no devc-bridge Feature',
    );
    await assertRejects(
      async () =>
        applyPolicy('grant', await f.merged(), f.project, f.deps(null)),
      BridgeGrantError,
      'no container',
    );
  });
});

Deno.test('checkGrantBeforeUp fails fast on a detached HEAD, before any container exists', async () => {
  await withFixture(async (f) => {
    await f.setHead(`${SHA1}\n`);
    await assertRejects(
      async () => checkGrantBeforeUp(await f.merged(), f.project, f.deps(null)),
      BridgeGrantError,
      'detached',
    );
  });
});

// ── refresh ─────────────────────────────────────────────────────────────────────────────────

Deno.test('refresh never creates a policy', async () => {
  await withFixture(async (f) => {
    await applyPolicy(
      'refresh',
      await f.merged(),
      f.project,
      f.deps(f.frozen),
    );
    assertEquals(
      await readPolicy(await projectKey(f.project), f.deps(null)),
      { kind: 'absent' },
    );
  });
});

Deno.test('refresh rewrites the pin after a branch switch', async () => {
  await withFixture(async (f) => {
    const merged = await f.merged();
    const deps = f.deps(f.frozen);
    await applyPolicy('grant', merged, f.project, deps);
    await f.setHead('ref: refs/heads/feat/next\n');
    await applyPolicy('refresh', merged, f.project, deps);
    const policy = await readPolicy(await projectKey(f.project), deps);
    assertEquals(
      policy.kind === 'present' && policy.record.branch,
      'feat/next',
    );
    assertStringIncludes(f.logs.join('\n'), 'refreshed: feat/next');
  });
});

Deno.test('refresh revokes, and says so, when the pin can no longer be derived', async () => {
  await withFixture(async (f) => {
    const merged = await f.merged();
    const deps = f.deps(f.frozen);
    await applyPolicy('grant', merged, f.project, deps);
    await f.setHead(`${SHA1}\n`);
    await applyPolicy('refresh', merged, f.project, deps);
    assertEquals(
      await readPolicy(await projectKey(f.project), deps),
      { kind: 'absent' },
    );
    assertStringIncludes(f.logs.join('\n'), 'revoked');
  });
});

// ── revoke, teardown, prune ─────────────────────────────────────────────────────────────────

Deno.test('revoke unlinks this key only, never a sweep of policy/', async () => {
  await withFixture(async (f) => {
    const merged = await f.merged();
    const deps = f.deps(f.frozen);
    await applyPolicy('grant', merged, f.project, deps);
    const other = bridgePaths(f.home, 'other-12345678').policyFile;
    await Deno.writeTextFile(other, '/o\tu\tb\n');

    await applyPolicy('revoke', merged, f.project, deps);
    assertEquals(
      await readPolicy(await projectKey(f.project), deps),
      { kind: 'absent' },
    );
    assertEquals(await Deno.readTextFile(other), '/o\tu\tb\n');
  });
});

Deno.test('removeBridgeFiles takes the key dir and the policy', async () => {
  await withFixture(async (f) => {
    const merged = await f.merged();
    const deps = f.deps(f.frozen);
    await ensureKeyDir(merged, deps);
    await applyPolicy('grant', merged, f.project, deps);
    const paths = bridgePaths(f.home, merged.bridgeKey!);
    assertEquals(
      (await removeBridgeFiles(f.project, deps)).sort(),
      [
        paths.keyDir,
        paths.policyFile,
      ].sort(),
    );
    assertEquals(await exists(paths.keyDir), false);
    assertEquals(await exists(paths.policyFile), false);
  });
});

Deno.test('prune removes a stale key and leaves a live one', async () => {
  await withFixture(async (f) => {
    const live = bridgePaths(f.home, await projectKey('/code/live'));
    const stale = bridgePaths(f.home, await projectKey('/code/gone'));
    for (const p of [live, stale]) {
      await Deno.mkdir(p.keyDir, { recursive: true });
      await write(p.policyFile, '/r\tu\tb\n');
    }
    const deps = {
      home: f.home,
      folders: () => Promise.resolve(['/code/live']),
    };

    const planned = await pruneBridgeFiles(true, deps);
    assertEquals(planned, [stale.keyDir, stale.policyFile].sort());
    assert(await exists(stale.keyDir), '--dry-run removed something');

    assertEquals(await pruneBridgeFiles(false, deps), planned);
    assertEquals(await exists(stale.keyDir), false);
    assertEquals(await exists(stale.policyFile), false);
    assert(await exists(live.keyDir));
    assert(await exists(live.policyFile));
  });
});

Deno.test('prune removes nothing when the container list cannot be read', async () => {
  await withFixture(async (f) => {
    const p = bridgePaths(f.home, 'gone-00000000');
    await Deno.mkdir(p.keyDir, { recursive: true });
    await assertRejects(() =>
      pruneBridgeFiles(false, {
        home: f.home,
        folders: () => Promise.reject(new Error('docker ps failed')),
      })
    );
    assert(await exists(p.keyDir));
  });
});

// ── status ──────────────────────────────────────────────────────────────────────────────────

Deno.test('status prints absent as absent, and the pin when there is one', async () => {
  await withFixture(async (f) => {
    const merged = await f.merged();
    const before = await bridgeStatusLines(merged, f.project, f.deps(null));
    assertStringIncludes(
      before.join('\n'),
      `devc-bridge: key ${merged.bridgeKey}`,
    );
    assertStringIncludes(before.join('\n'), 'token dir: absent');
    assertStringIncludes(before.join('\n'), 'git push:  absent');

    await applyPolicy(
      'grant',
      merged,
      f.project,
      f.deps(f.frozen),
    );
    const after = await bridgeStatusLines(merged, f.project, f.deps(null));
    assertStringIncludes(
      after.join('\n'),
      'git push:  feat/x → git@github.com:acme/proj.git',
    );
  });
});

Deno.test('status names a malformed policy rather than showing a pin', async () => {
  await withFixture(async (f) => {
    const merged = await f.merged();
    await write(bridgePaths(f.home, merged.bridgeKey!).policyFile, 'nope\n');
    const lines = await bridgeStatusLines(merged, f.project, f.deps(null));
    assertStringIncludes(lines.join('\n'), 'MALFORMED');
  });
});

// ── linked worktrees (plan devc-git-protect-git-dirs § Step 5) ──────────────────────────────

/**
 * A linked worktree of the fixture's `proj`, made of files alone, plus its merged config and the
 * mount table of a container where the CLI's common-dir mount (`/workspaces/proj/.git`) is frozen.
 */
async function worktreeOf(f: Fixture) {
  const wt = `${f.dir}/proj.worktrees/wt`;
  const wtGitDir = `${f.project}/.git/worktrees/wt`;
  await Deno.mkdir(`${f.project}/.git/hooks`, { recursive: true });
  await write(`${wtGitDir}/HEAD`, 'ref: refs/heads/feat/wt\n');
  await write(`${wtGitDir}/commondir`, '../..\n');
  await write(`${wt}/.git`, 'gitdir: ../../proj/.git/worktrees/wt\n');
  await write(
    `${wt}/.devcontainer/devcontainer.json`,
    JSON.stringify({
      image: 'ubuntu',
      features: { [BRIDGE_FEATURE]: {} },
    }),
  );
  const merged = await ensureMergedConfig(wt, {
    cacheRoot: `${f.dir}/cache`,
    templatesDir: `${f.dir}/no-templates`,
    configDir: `${f.dir}/config`,
  });
  const keyDir = bridgePaths(f.home, merged.bridgeKey!).keyDir;
  const gitDir = '/workspaces/proj/.git';
  const frozen: ContainerMount[] = [
    {
      type: 'bind',
      source: keyDir,
      destination: '/run/devc-bridge',
      rw: false,
    },
    {
      type: 'bind',
      source: wt,
      destination: '/workspaces/proj.worktrees/wt',
      rw: true,
    },
    {
      type: 'bind',
      source: `${f.project}/.git`,
      destination: gitDir,
      rw: true,
    },
    {
      type: 'bind',
      source: `${f.project}/.git/config`,
      destination: `${gitDir}/config`,
      rw: false,
    },
    {
      type: 'bind',
      source: `${f.project}/.git/hooks`,
      destination: `${gitDir}/hooks`,
      rw: false,
    },
  ];
  return { wt, wtGitDir, merged, frozen };
}

Deno.test('a worktree container is granted once the primary git dir is frozen', async () => {
  await withFixture(async (f) => {
    const { wt, merged, frozen } = await worktreeOf(f);
    assertEquals(merged.protectedRows.map((r) => [r.target, r.kind]), [
      ['/workspaces/proj/.git', 'gitdir'],
    ]);
    await applyPolicy('grant', merged, wt, f.deps(frozen));
    const policy = await readPolicy(merged.bridgeKey!, f.deps(null));
    assertEquals(policy, {
      kind: 'present',
      record: {
        repo: wt,
        remote: 'git@github.com:acme/proj.git',
        branch: 'feat/wt',
      },
    });
  });
});

Deno.test('a worktree grant is refused while the primary git dir is writable', async () => {
  await withFixture(async (f) => {
    const { wt, merged, frozen } = await worktreeOf(f);
    const writable = frozen.filter((m) =>
      !m.destination.startsWith('/workspaces/proj/.git/')
    );
    await assertRejects(
      () => applyPolicy('grant', merged, wt, f.deps(writable)),
      BridgeGrantError,
      'not in force in this container for /workspaces/proj/.git',
    );
  });
});

Deno.test('the pin reads the frozen config, not whatever commondir points at', async () => {
  // `.git/worktrees/<name>/commondir` lives in the primary's git dir, which stays writable — only
  // `config` and `hooks` are frozen. An agent can repoint it at a config it wrote; the pin must
  // still come from the host source of the container's read-only config mount.
  await withFixture(async (f) => {
    const { wt, wtGitDir, merged, frozen } = await worktreeOf(f);
    await write(
      `${f.dir}/evil/config`,
      '[remote "origin"]\n\turl = git@github.com:attacker/x.git\n',
    );
    await Deno.writeTextFile(`${wtGitDir}/commondir`, `${f.dir}/evil\n`);
    await applyPolicy('grant', merged, wt, f.deps(frozen));
    const policy = await readPolicy(merged.bridgeKey!, f.deps(null));
    assertEquals(
      policy.kind === 'present' && policy.record.remote,
      'git@github.com:acme/proj.git',
    );
  });
});
