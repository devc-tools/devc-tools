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
import {
  type BridgeCapability,
  bridgePaths,
  WORKTREE_CONFIG_REASON,
} from '@devc-tools/core/bridge.ts';
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
  checkDefaultsBeforeUp,
  checkGrantBeforeUp,
  ensureKeyDir,
  type PolicyMode,
  pruneBridgeFiles,
  readPolicy,
  removeBridgeFiles,
  type RepoAllow,
  RepoAllowError,
  resolveRepoAllow,
} from '../bridge.ts';
import { parseBridgeRepoAllow, parseUpArgs } from '../args.ts';

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
          home,
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

/** The grant most tests make: two capabilities, so the fourth field is visibly a list. */
const GRANT: PolicyMode = { grant: ['gh-push', 'gh-pr-read'] };

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
    await applyPolicy(GRANT, merged, f.project, f.deps(f.frozen));
    const key = await projectKey(f.project);
    const file = bridgePaths(f.home, key).policyFile;
    assertEquals(
      await Deno.readTextFile(file),
      `${f.project}\tgit@github.com:acme/proj.git\tfeat/x\tgh-push,gh-pr-read\t/workspaces/proj\n`,
    );
    assertEquals((await Deno.stat(file)).mode! & 0o777, 0o600);
    assertEquals(f.logs, [
      'devc: devc-bridge capabilities granted: gh-push, gh-pr-read',
      `devc:   /workspaces/proj: feat/x → git@github.com:acme/proj.git (${f.project})`,
    ]);
  });
});

Deno.test('grant is refused, and an older policy removed, when the container is not frozen', async () => {
  await withFixture(async (f) => {
    const merged = await f.merged();
    // An older grant, from before the container was recreated without protection.
    await applyPolicy(GRANT, merged, f.project, f.deps(f.frozen));
    const unfrozen = f.frozen.map((m) => ({
      ...m,
      rw: true,
    }));
    const err = await assertRejects(
      () => applyPolicy(GRANT, merged, f.project, f.deps(unfrozen)),
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
    const bare = [
      ...f.frozen.filter((m) => m.destination === '/run/devc-bridge'),
      {
        type: 'bind' as const,
        source: f.project,
        destination: '/workspaces/proj',
        rw: true,
      },
    ];
    await assertRejects(
      () => applyPolicy(GRANT, merged, f.project, f.deps(bare)),
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
        applyPolicy(GRANT, await f.merged(), f.project, f.deps(legacy)),
      BridgeGrantError,
      'not its own',
    );
    const none = f.frozen.filter((m) => m.destination !== '/run/devc-bridge');
    await assertRejects(
      async () => applyPolicy(GRANT, await f.merged(), f.project, f.deps(none)),
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
          GRANT,
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
          GRANT,
          await f.merged({ features: { [BRIDGE_FEATURE]: null } }),
          f.project,
          frozen,
        ),
      BridgeGrantError,
      'no devc-bridge Feature',
    );
    await assertRejects(
      async () => applyPolicy(GRANT, await f.merged(), f.project, f.deps(null)),
      BridgeGrantError,
      'no container',
    );
  });
});

// ── default grant (bridgeDefaultAllow) ──────────────────────────────────────────────────────

const DEFAULT_GRANT: PolicyMode = {
  defaultGrant: ['gh-pr-read', 'gh-pr-viewed'],
};

Deno.test('a default grant writes the policy and logs the (defaults) lines', async () => {
  await withFixture(async (f) => {
    await applyPolicy(
      DEFAULT_GRANT,
      await f.merged(),
      f.project,
      f.deps(f.frozen),
    );
    const file = bridgePaths(f.home, await projectKey(f.project)).policyFile;
    assertEquals(
      await Deno.readTextFile(file),
      `${f.project}\tgit@github.com:acme/proj.git\tfeat/x\tgh-pr-read,gh-pr-viewed\t/workspaces/proj\n`,
    );
    assertEquals(f.logs, [
      'devc: devc-bridge capabilities granted (defaults):',
      `devc:   /workspaces/proj: feat/x → git@github.com:acme/proj.git (${f.project}): gh-pr-read, gh-pr-viewed`,
    ]);
    // The same default again: unchanged, and the policy file is not rewritten.
    const before = (await Deno.stat(file)).mtime;
    f.logs.length = 0;
    await applyPolicy(
      DEFAULT_GRANT,
      await f.merged(),
      f.project,
      f.deps(f.frozen),
    );
    assertEquals((await Deno.stat(file)).mtime, before);
    assertEquals(f.logs.length, 2);
  });
});

Deno.test('a default grant with no GitHub origin logs the skip, removes an old policy and does not throw', async () => {
  await withFixture(async (f) => {
    const merged = await f.merged();
    await applyPolicy(GRANT, merged, f.project, f.deps(f.frozen));
    const origin = 'git@gitlab.com:acme/proj.git';
    await Deno.writeTextFile(
      `${f.project}/.git/config`,
      `[remote "origin"]\n\turl = ${origin}\n`,
    );
    f.logs.length = 0;
    await applyPolicy(DEFAULT_GRANT, merged, f.project, f.deps(f.frozen));
    assertEquals(f.logs, [
      `devc: defaults: not pinning the workspace repo: origin ${origin} is not a github.com remote`,
    ]);
    assertEquals(
      await readPolicy(await projectKey(f.project), f.deps(null)),
      { kind: 'absent' },
    );
  });
});

Deno.test('a default grant never fails: a detached HEAD, gitProtect off, no container', async () => {
  await withFixture(async (f) => {
    await f.setHead(`${SHA1}\n`);
    await applyPolicy(
      DEFAULT_GRANT,
      await f.merged(),
      f.project,
      f.deps(f.frozen),
    );
    await f.setHead('ref: refs/heads/feat/x\n');
    await applyPolicy(
      DEFAULT_GRANT,
      await f.merged({ gitProtect: false }),
      f.project,
      f.deps(f.frozen),
    );
    await applyPolicy(DEFAULT_GRANT, await f.merged(), f.project, f.deps(null));
    assertEquals(f.logs.length, 3, f.logs.join('\n'));
    // A repo's precondition skips it; a container-wide one grants nothing.
    assert(
      f.logs[0].startsWith('devc: defaults: not pinning the workspace repo: '),
      f.logs[0],
    );
    for (const line of f.logs.slice(1)) {
      assert(line.startsWith('devc: defaults: not granted: '), line);
    }
    assertStringIncludes(f.logs[0], 'detached');
    assertStringIncludes(f.logs[1], 'gitProtect is off');
    assertStringIncludes(f.logs[2], 'no container');
  });
});

Deno.test('a default grant with no Feature logs nothing, and removes a policy as revoke does', async () => {
  await withFixture(async (f) => {
    const noFeature = await f.merged({ features: { [BRIDGE_FEATURE]: null } });
    await applyPolicy(DEFAULT_GRANT, noFeature, f.project, f.deps(f.frozen));
    assertEquals(f.logs, []);
    await applyPolicy(GRANT, await f.merged(), f.project, f.deps(f.frozen));
    f.logs.length = 0;
    await applyPolicy(DEFAULT_GRANT, noFeature, f.project, f.deps(f.frozen));
    assertEquals(f.logs, [
      'devc: devc-bridge capabilities revoked for this workspace (pass --bridge-allow to keep them)',
    ]);
  });
});

Deno.test('refresh with no policy and a default configured still writes nothing', async () => {
  await withFixture(async (f) => {
    await write(
      `${f.home}/.config/devc/config.json`,
      JSON.stringify({ bridgeDefaultAllow: ['gh-pr-read'] }),
    );
    await applyPolicy('refresh', await f.merged(), f.project, f.deps(f.frozen));
    assertEquals(
      await readPolicy(await projectKey(f.project), f.deps(null)),
      { kind: 'absent' },
    );
    assertEquals(f.logs, []);
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

Deno.test('refresh revokes, never moves, the pin after a branch switch', async () => {
  // `HEAD` is agent-writable: a pin that followed it would let the agent pick its own branch.
  await withFixture(async (f) => {
    const merged = await f.merged();
    const deps = f.deps(f.frozen);
    await applyPolicy(GRANT, merged, f.project, deps);
    await f.setHead('ref: refs/heads/feat/next\n');
    await applyPolicy('refresh', merged, f.project, deps);
    assertEquals(
      await readPolicy(await projectKey(f.project), deps),
      { kind: 'absent' },
    );
    assertStringIncludes(
      f.logs.join('\n'),
      'devc: devc-bridge capabilities revoked — the branch is now feat/next, but they were ' +
        'granted for feat/x. Run `devc up --bridge-allow gh-push,gh-pr-read` to grant it.',
    );
    assert(!f.logs.some((l) => l.includes('refreshed')));
  });
});

Deno.test('refresh revokes, and says so, when the pin can no longer be derived', async () => {
  await withFixture(async (f) => {
    const merged = await f.merged();
    const deps = f.deps(f.frozen);
    await applyPolicy(GRANT, merged, f.project, deps);
    await f.setHead(`${SHA1}\n`);
    await applyPolicy('refresh', merged, f.project, deps);
    assertEquals(
      await readPolicy(await projectKey(f.project), deps),
      { kind: 'absent' },
    );
    assertStringIncludes(
      f.logs.join('\n'),
      'devc: devc-bridge capabilities revoked — ',
    );
    assertStringIncludes(
      f.logs.join('\n'),
      'Re-run `devc up --bridge-allow gh-push,gh-pr-read` once that is fixed.',
    );
  });
});

Deno.test('refresh removes a malformed (pre-grants, three-field) policy and says so', async () => {
  await withFixture(async (f) => {
    const merged = await f.merged();
    const deps = f.deps(f.frozen);
    const file = bridgePaths(f.home, merged.bridgeKey!).policyFile;
    await write(file, `${f.project}\tgit@github.com:acme/proj.git\tfeat/x\n`);
    await applyPolicy('refresh', merged, f.project, deps);
    assertEquals(await exists(file), false);
    assertStringIncludes(
      f.logs.join('\n'),
      `devc: devc-bridge policy at ${file} was malformed (line 1: want 5 tab-separated fields, found 3) and has been removed — re-run devc up --bridge-allow <list>`,
    );
  });
});

/** Point the fixture repo's `remote.origin.url` at `url`, keeping the fsmonitor tripwire. */
async function setOrigin(f: Fixture, url: string): Promise<void> {
  const config = `${f.project}/.git/config`;
  const text = await Deno.readTextFile(config);
  await Deno.writeTextFile(
    config,
    text.replace(/url = .*/, `url = ${url}`),
  );
}

Deno.test('a grant on a non-GitHub origin is refused, before up and after', async () => {
  await withFixture(async (f) => {
    const origin = `${f.dir}/remote.git`;
    const merged = await f.merged();
    await applyPolicy(GRANT, merged, f.project, f.deps(f.frozen));
    await setOrigin(f, origin);
    const before = await assertRejects(
      () => checkGrantBeforeUp(merged, f.project, f.deps(null)),
      BridgeGrantError,
    );
    assertEquals(
      before.message,
      `--bridge-allow: origin ${origin} is not a github.com remote`,
    );
    assertEquals(
      await readPolicy(merged.bridgeKey!, f.deps(null)),
      { kind: 'absent' },
      'an explicit request that cannot be met removes the older grant',
    );
    const after = await assertRejects(
      () => applyPolicy(GRANT, merged, f.project, f.deps(f.frozen)),
      BridgeGrantError,
    );
    assertEquals(
      after.message,
      `the container is up, but --bridge-allow was not granted: origin ${origin} is not a github.com remote`,
    );
  });
});

Deno.test('refresh revokes a grant whose origin stopped being GitHub', async () => {
  await withFixture(async (f) => {
    const origin = `${f.dir}/remote.git`;
    const merged = await f.merged();
    const deps = f.deps(f.frozen);
    await applyPolicy(GRANT, merged, f.project, deps);
    await setOrigin(f, origin);
    await applyPolicy('refresh', merged, f.project, deps);
    assertEquals(await readPolicy(merged.bridgeKey!, deps), {
      kind: 'absent',
    });
    assertStringIncludes(
      f.logs.join('\n'),
      `devc: devc-bridge capabilities revoked — origin ${origin} is not a github.com remote. ` +
        'Re-run `devc up --bridge-allow gh-push,gh-pr-read` once that is fixed.',
    );
  });
});

Deno.test('refresh revokes a grant whose origin changed to another GitHub repo', async () => {
  await withFixture(async (f) => {
    const merged = await f.merged();
    const deps = f.deps(f.frozen);
    await applyPolicy(GRANT, merged, f.project, deps);
    await setOrigin(f, 'git@github.com:acme/other.git');
    await applyPolicy('refresh', merged, f.project, deps);
    assertEquals(await readPolicy(merged.bridgeKey!, deps), {
      kind: 'absent',
    });
    assertStringIncludes(
      f.logs.join('\n'),
      'the origin is now git@github.com:acme/other.git, but they were granted for ' +
        'git@github.com:acme/proj.git',
    );
    assert(!f.logs.some((l) => l.includes('refreshed')));
  });
});

Deno.test('refresh of an unchanged pin writes nothing and logs nothing', async () => {
  await withFixture(async (f) => {
    const merged = await f.merged();
    const deps = f.deps(f.frozen);
    await applyPolicy(GRANT, merged, f.project, deps);
    const file = bridgePaths(f.home, merged.bridgeKey!).policyFile;
    const before = await Deno.readTextFile(file);
    const mtime = (await Deno.stat(file)).mtime;
    const logged = f.logs.length;
    await applyPolicy('refresh', merged, f.project, deps);
    assertEquals(await Deno.readTextFile(file), before);
    assertEquals((await Deno.stat(file)).mtime, mtime);
    assertEquals(f.logs.slice(logged), [], 'the refresh logged nothing');
    assert(!f.logs.some((l) => l.includes('refreshed')));
  });
});

Deno.test('refresh removes a policy holding a pre-rename capability name', async () => {
  await withFixture(async (f) => {
    const merged = await f.merged();
    const deps = f.deps(f.frozen);
    const file = bridgePaths(f.home, merged.bridgeKey!).policyFile;
    await write(
      file,
      `${f.project}\tgit@github.com:acme/proj.git\tfeat/x\tgit-push,pr-review\t/workspaces/proj\n`,
    );
    await applyPolicy('refresh', merged, f.project, deps);
    assertEquals(await exists(file), false);
    assertStringIncludes(
      f.logs.join('\n'),
      'was malformed (line 1: unknown capability "git-push") and has been removed',
    );
  });
});

Deno.test('refresh removes a policy from before the PR grants split, naming the rename', async () => {
  await withFixture(async (f) => {
    const merged = await f.merged();
    const deps = f.deps(f.frozen);
    const file = bridgePaths(f.home, merged.bridgeKey!).policyFile;
    await write(
      file,
      `${f.project}\tgit@github.com:acme/proj.git\tfeat/x\tgh-push,gh-pr-review,gh-pr-resolve\t/workspaces/proj\n`,
    );
    await applyPolicy('refresh', merged, f.project, deps);
    assertEquals(await exists(file), false);
    assertStringIncludes(
      f.logs.join('\n'),
      'was malformed (line 1: gh-pr-review was split — grant gh-pr-read,gh-pr-reply instead) and has been removed — re-run devc up --bridge-allow <list>',
    );
  });
});

Deno.test('a new grant replaces the earlier set rather than merging', async () => {
  await withFixture(async (f) => {
    const merged = await f.merged();
    const deps = f.deps(f.frozen);
    await applyPolicy(
      { grant: ['gh-push', 'gh-pr-read', 'gh-pr-resolve'] },
      merged,
      f.project,
      deps,
    );
    await applyPolicy({ grant: ['gh-push'] }, merged, f.project, deps);
    const policy = await readPolicy(merged.bridgeKey!, deps);
    assertEquals(
      policy.kind === 'present' && policy.record.repos.map((r) => r.grants),
      [['gh-push']],
    );
  });
});

// ── revoke, teardown, prune ─────────────────────────────────────────────────────────────────

Deno.test('revoke unlinks this key only, never a sweep of policy/', async () => {
  await withFixture(async (f) => {
    const merged = await f.merged();
    const deps = f.deps(f.frozen);
    await applyPolicy(GRANT, merged, f.project, deps);
    const other = bridgePaths(f.home, 'other-12345678').policyFile;
    await Deno.writeTextFile(other, '/o\tu\tb\n');

    await applyPolicy('revoke', merged, f.project, deps);
    assertEquals(
      await readPolicy(await projectKey(f.project), deps),
      { kind: 'absent' },
    );
    assertStringIncludes(
      f.logs.join('\n'),
      'devc: devc-bridge capabilities revoked for this workspace (pass --bridge-allow to keep them)',
    );
    assertEquals(await Deno.readTextFile(other), '/o\tu\tb\n');
  });
});

Deno.test('removeBridgeFiles takes the key dir and the policy', async () => {
  await withFixture(async (f) => {
    const merged = await f.merged();
    const deps = f.deps(f.frozen);
    await ensureKeyDir(merged, deps);
    await applyPolicy(GRANT, merged, f.project, deps);
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
    assertStringIncludes(
      before.join('\n'),
      '  bridge:    absent — `devc up --bridge-allow <capabilities>` grants them',
    );

    await applyPolicy(GRANT, merged, f.project, f.deps(f.frozen));
    const after = await bridgeStatusLines(merged, f.project, f.deps(null));
    assertStringIncludes(
      after.join('\n'),
      `  bridge:    gh-push, gh-pr-read\n` +
        `    /workspaces/proj: feat/x → git@github.com:acme/proj.git (${f.project})`,
    );
  });
});

Deno.test('status names a malformed policy rather than showing a pin', async () => {
  await withFixture(async (f) => {
    const merged = await f.merged();
    await write(bridgePaths(f.home, merged.bridgeKey!).policyFile, 'nope\n');
    const lines = await bridgeStatusLines(merged, f.project, f.deps(null));
    assertStringIncludes(
      lines.join('\n'),
      `  bridge:    MALFORMED policy at ${
        bridgePaths(f.home, merged.bridgeKey!).policyFile
      } (line 1: want 5 tab-separated fields, found 1) — grants nothing`,
    );
  });
});

/** Install a host-arch ELF header as the host client under `home`. */
async function installHostClient(home: string): Promise<void> {
  const bytes = new Uint8Array(64);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
  bytes[18] = Deno.build.arch === 'aarch64' ? 0xb7 : 0x3e;
  const dir = `${home}/.config/devc-bridge/client`;
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeFile(`${dir}/devc-bridge`, bytes);
}

const CLIENT_MOUNTED =
  '  client:    host copy, mounted read-only (~/.config/devc-bridge/client)';

Deno.test('status: the client line follows the token line, host copy when mounted', async () => {
  await withFixture(async (f) => {
    await installHostClient(f.home);
    const merged = await f.merged();
    const withClient: ContainerMount[] = [...f.frozen, {
      type: 'bind',
      source: `${f.home}/.config/devc-bridge/client`,
      destination: '/usr/local/share/devc-bridge/client',
      rw: false,
    }];
    const lines = await bridgeStatusLines(
      merged,
      f.project,
      f.deps(withClient),
    );
    const token = lines.findIndex((l) => l.startsWith('  token:'));
    assertEquals(lines[token + 1], CLIENT_MOUNTED);

    // No container at all: nothing to compare against, so no suffix.
    assert(
      (await bridgeStatusLines(merged, f.project, f.deps(null))).includes(
        CLIENT_MOUNTED,
      ),
    );
  });
});

Deno.test('status: an existing container without the client mount is told to rebuild', async () => {
  await withFixture(async (f) => {
    await installHostClient(f.home);
    const merged = await f.merged();
    const lines = await bridgeStatusLines(
      merged,
      f.project,
      f.deps(f.frozen),
    );
    assert(
      lines.includes(
        `${CLIENT_MOUNTED} — not in this container yet; run \`devc build\``,
      ),
      lines.join('\n'),
    );
  });
});

Deno.test("status: the Feature's copy, with the reason, when devc does not mount", async () => {
  await withFixture(async (f) => {
    await installHostClient(f.home);
    const merged = await f.merged({ bridgeClientMount: false });
    const lines = await bridgeStatusLines(
      merged,
      f.project,
      f.deps(f.frozen),
    );
    assert(
      lines.includes(
        "  client:    Feature's copy — bridgeClientMount is false",
      ),
      lines.join('\n'),
    );
  });
});

Deno.test('status: no client line when the bridge is not enabled', async () => {
  await withFixture(async (f) => {
    const merged = await f.merged();
    const lines = await bridgeStatusLines(
      { ...merged, bridgeKey: null, bridgeClient: null },
      f.project,
      f.deps(null),
    );
    assertEquals(lines.some((l) => l.includes('client:')), false);
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
    home: f.home,
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
    await applyPolicy(GRANT, merged, wt, f.deps(frozen));
    const policy = await readPolicy(merged.bridgeKey!, f.deps(null));
    assertEquals(policy, {
      kind: 'present',
      record: {
        repos: [{
          repo: wt,
          remote: 'git@github.com:acme/proj.git',
          branch: 'feat/wt',
          grants: ['gh-push', 'gh-pr-read'],
          target: '/workspaces/proj.worktrees/wt',
        }],
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
      () => applyPolicy(GRANT, merged, wt, f.deps(writable)),
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
    await applyPolicy(GRANT, merged, wt, f.deps(frozen));
    const policy = await readPolicy(merged.bridgeKey!, f.deps(null));
    assertEquals(
      policy.kind === 'present' && policy.record.repos[0].remote,
      'git@github.com:acme/proj.git',
    );
  });
});

// ── extra repos: --bridge-repo ──────────────────────────────────────────────────────────────

/**
 * A second repo under the fixture home (`~/extra`, origin `acme/extra`, on `feat/extra`), with the
 * fsmonitor tripwire, mounted at `/workspaces/extra` through the project's devc.json. Returns the
 * merged config and the mount table of a container with both repos frozen.
 */
async function withExtra(
  f: Fixture,
  opts: { origin?: string; mounts?: string[] } = {},
) {
  const extra = `${f.home}/extra`;
  await write(`${extra}/.git/HEAD`, 'ref: refs/heads/feat/extra\n');
  await Deno.mkdir(`${extra}/.git/objects`, { recursive: true });
  await Deno.mkdir(`${extra}/.git/hooks`, { recursive: true });
  await write(
    `${extra}/.git/config`,
    `[core]\n\tfsmonitor = ${f.dir}/fsmonitor.sh\n[remote "origin"]\n\turl = ${
      opts.origin ?? 'git@github.com:acme/extra.git'
    }\n`,
  );
  const merged = await f.merged({
    mounts: [
      `source=${extra},target=/workspaces/extra,type=bind`,
      ...(opts.mounts ?? []),
    ],
  });
  const target = '/workspaces/extra';
  const frozen: ContainerMount[] = [
    ...f.frozen,
    { type: 'bind', source: extra, destination: target, rw: true },
    {
      type: 'bind',
      source: `${extra}/.git`,
      destination: `${target}/.git`,
      rw: true,
    },
    {
      type: 'bind',
      source: `${extra}/.git/config`,
      destination: `${target}/.git/config`,
      rw: false,
    },
    {
      type: 'bind',
      source: `${extra}/.git/hooks`,
      destination: `${target}/.git/hooks`,
      rw: false,
    },
  ];
  return { extra, merged, frozen };
}

const EXTRA_GRANT: PolicyMode = {
  grant: ['gh-push', 'gh-pr-read'],
  repos: ['~/extra'],
};

Deno.test('--bridge-repo pins an extra protected repo as line 2, and logs one line per repo', async () => {
  await withFixture(async (f) => {
    const { extra, merged, frozen } = await withExtra(f);
    await checkGrantBeforeUp(merged, f.project, f.deps(null), ['~/extra']);
    await applyPolicy(EXTRA_GRANT, merged, f.project, f.deps(frozen));
    const grants = 'gh-push,gh-pr-read';
    assertEquals(
      await Deno.readTextFile(
        bridgePaths(f.home, merged.bridgeKey!).policyFile,
      ),
      `${f.project}\tgit@github.com:acme/proj.git\tfeat/x\t${grants}\t/workspaces/proj\n` +
        `${extra}\tgit@github.com:acme/extra.git\tfeat/extra\t${grants}\t/workspaces/extra\n`,
    );
    assertEquals(f.logs, [
      'devc: devc-bridge capabilities granted: gh-push, gh-pr-read',
      `devc:   /workspaces/proj: feat/x → git@github.com:acme/proj.git (${f.project})`,
      `devc:   /workspaces/extra: feat/extra → git@github.com:acme/extra.git (${extra})`,
    ]);
  });
});

Deno.test('--bridge-repo: ~/x after =, a literal ~/x and the absolute path pin the same repo', async () => {
  await withFixture(async (f) => {
    const { extra, merged, frozen } = await withExtra(f);
    const home = Deno.env.get('HOME');
    Deno.env.set('HOME', f.home);
    try {
      for (
        const args of [
          ['--bridge-repo=~/extra'],
          ['--bridge-repo', '~/extra'],
          ['--bridge-repo', extra],
        ]
      ) {
        const { bridgeAllow, bridgeRepos } = parseUpArgs([
          '--bridge-allow',
          'gh-push',
          ...args,
        ]);
        assert(Array.isArray(bridgeAllow));
        await applyPolicy(
          { grant: bridgeAllow, repos: bridgeRepos },
          merged,
          f.project,
          f.deps(frozen),
        );
        const policy = await readPolicy(merged.bridgeKey!, f.deps(null));
        assertEquals(
          policy.kind === 'present' && policy.record.repos[1],
          {
            repo: extra,
            remote: 'git@github.com:acme/extra.git',
            branch: 'feat/extra',
            grants: ['gh-push'],
            target: '/workspaces/extra',
          },
          args.join(' '),
        );
      }
      // `~user` is not expanded: it is a relative path, and there is no such directory.
      const err = await assertRejects(
        () =>
          applyPolicy(
            { grant: ['gh-push'], repos: ['~nobody/extra'] },
            merged,
            f.project,
            f.deps(frozen),
          ),
        BridgeGrantError,
      );
      assertEquals(
        err.message,
        '--bridge-repo ~nobody/extra: no such directory',
      );
    } finally {
      if (home === undefined) Deno.env.delete('HOME');
      else Deno.env.set('HOME', home);
    }
  });
});

Deno.test('--bridge-repo that names no eligible row: each refusal is exact, and no policy stays', async () => {
  await withFixture(async (f) => {
    // A linked worktree whose git dir does not exist and a plain folder, both mounted as extra
    // folders, and a repo not mounted.
    const wt = `${f.home}/extra.worktrees/wt`;
    await write(`${wt}/.git`, 'gitdir: ../../extra/.git/worktrees/wt\n');
    const plain = `${f.home}/plain`;
    await Deno.mkdir(plain, { recursive: true });
    const loose = `${f.dir}/loose`;
    await write(`${loose}/.git/HEAD`, 'ref: refs/heads/main\n');
    const { merged, frozen } = await withExtra(f, {
      mounts: [
        `source=${wt},target=/workspaces/wt,type=bind`,
        `source=${plain},target=/workspaces/plain,type=bind`,
      ],
    });
    const pinnable =
      'not a git-protected repo mount in this workspace — pinnable: ~/extra';
    const cases: [string, string][] = [
      [
        f.project,
        `--bridge-repo ${f.project}: this is the workspace repo, which devc always tries to pin`,
      ],
      [`${f.dir}/nope`, `--bridge-repo ${f.dir}/nope: no such directory`],
      [loose, `--bridge-repo ${loose}: ${pinnable}`],
      [
        wt,
        `--bridge-repo ${wt}: its .git points at ${f.home}/extra/.git/worktrees/wt, which is not ` +
        'the worktrees/ dir of a git-protected repo here',
      ],
      [plain, `--bridge-repo ${plain}: ${pinnable}`],
    ];
    for (const [repo, message] of cases) {
      await applyPolicy(GRANT, merged, f.project, f.deps(frozen));
      for (
        const run of [
          () => checkGrantBeforeUp(merged, f.project, f.deps(null), [repo]),
          () =>
            applyPolicy(
              { grant: ['gh-push'], repos: [repo] },
              merged,
              f.project,
              f.deps(frozen),
            ),
        ]
      ) {
        const err = await assertRejects(run, BridgeGrantError);
        assertEquals(err.message, message);
        assertEquals(
          await readPolicy(merged.bridgeKey!, f.deps(null)),
          { kind: 'absent' },
          repo,
        );
        await applyPolicy(GRANT, merged, f.project, f.deps(frozen));
      }
    }
  });
});

Deno.test('--bridge-repo with no extra protected mount says there are none', async () => {
  await withFixture(async (f) => {
    const merged = await f.merged();
    const err = await assertRejects(
      () =>
        applyPolicy(
          { grant: ['gh-push'], repos: [f.dir] },
          merged,
          f.project,
          f.deps(f.frozen),
        ),
      BridgeGrantError,
    );
    assertEquals(
      err.message,
      `--bridge-repo ${f.dir}: not a git-protected repo mount in this workspace — no extra repo mounts are git-protected`,
    );
  });
});

/** The policy file's repos, or null when there is none. */
async function pinnedRepos(f: Fixture, merged: MergedConfig) {
  const policy = await readPolicy(merged.bridgeKey!, f.deps(null));
  return policy.kind === 'present' ? policy.record.repos : null;
}

Deno.test('an extra repo whose .git/config is writable in the container is skipped, with a notice', async () => {
  await withFixture(async (f) => {
    const { merged, frozen } = await withExtra(f);
    const writable = frozen.map((m) =>
      m.destination === '/workspaces/extra/.git/config' ? { ...m, rw: true } : m
    );
    await applyPolicy(EXTRA_GRANT, merged, f.project, f.deps(writable));
    assertEquals((await pinnedRepos(f, merged))?.map((r) => r.repo), [
      f.project,
    ]);
    assertEquals(f.logs, [
      'devc: --bridge-allow: not pinning ~/extra: git protection is not in force in this ' +
      'container for /workspaces/extra (/workspaces/extra/.git/config is mounted read-write) — ' +
      'recreate it with `devc build`',
      'devc: devc-bridge capabilities granted: gh-push, gh-pr-read',
      `devc:   /workspaces/proj: feat/x → git@github.com:acme/proj.git (${f.project})`,
    ]);
  });
});

Deno.test('an extra repo with a detached HEAD passes the pre-up check and is skipped after up', async () => {
  await withFixture(async (f) => {
    const { extra, merged, frozen } = await withExtra(f);
    await Deno.writeTextFile(`${extra}/.git/HEAD`, `${SHA1}\n`);
    await checkGrantBeforeUp(merged, f.project, f.deps(null), ['~/extra']);
    assertEquals(f.logs, []);
    await applyPolicy(EXTRA_GRANT, merged, f.project, f.deps(frozen));
    assertEquals((await pinnedRepos(f, merged))?.map((r) => r.repo), [
      f.project,
    ]);
    assertStringIncludes(
      f.logs[0],
      `devc: --bridge-allow: not pinning ~/extra: HEAD is detached in ${extra} — `,
    );
  });
});

Deno.test('a workspace repo with no origin is skipped, and the extra repo pinned alone', async () => {
  await withFixture(async (f) => {
    const { extra, merged, frozen } = await withExtra(f);
    const config = `${f.project}/.git/config`;
    await Deno.writeTextFile(
      config,
      (await Deno.readTextFile(config)).replace(/\[remote[^]*$/, ''),
    );
    await checkGrantBeforeUp(merged, f.project, f.deps(null), ['~/extra']);
    await applyPolicy(EXTRA_GRANT, merged, f.project, f.deps(frozen));
    assertEquals(
      await Deno.readTextFile(
        bridgePaths(f.home, merged.bridgeKey!).policyFile,
      ),
      `${extra}\tgit@github.com:acme/extra.git\tfeat/extra\tgh-push,gh-pr-read\t/workspaces/extra\n`,
    );
    assertEquals(f.logs, [
      'devc: --bridge-allow: not pinning the workspace repo: the repo has no remote.origin.url',
      'devc: devc-bridge capabilities granted: gh-push, gh-pr-read',
      `devc:   /workspaces/extra: feat/extra → git@github.com:acme/extra.git (${extra})`,
    ]);

    // Refresh keeps it while nothing changed — and does not add the workspace once it has an
    // origin again: only a grant writes.
    const file = bridgePaths(f.home, merged.bridgeKey!).policyFile;
    const before = await Deno.readTextFile(file);
    const mtime = (await Deno.stat(file)).mtime;
    f.logs.length = 0;
    await applyPolicy('refresh', merged, f.project, f.deps(frozen));
    await Deno.writeTextFile(
      config,
      '[remote "origin"]\n\turl = git@github.com:acme/proj.git\n',
      { append: true },
    );
    await applyPolicy('refresh', merged, f.project, f.deps(frozen));
    assertEquals(await Deno.readTextFile(file), before);
    assertEquals((await Deno.stat(file)).mtime, mtime);
    assertEquals(f.logs, []);

    // A one-line extra-only policy: no repo prefix, and the hint carries --bridge-repo.
    await Deno.writeTextFile(`${extra}/.git/HEAD`, 'ref: refs/heads/main\n');
    await applyPolicy('refresh', merged, f.project, f.deps(frozen));
    assertEquals(await pinnedRepos(f, merged), null);
    assertEquals(f.logs, [
      'devc: devc-bridge capabilities revoked — the branch is now main, but they were granted ' +
      'for feat/extra. Run `devc up --bridge-allow gh-push,gh-pr-read --bridge-repo …` to ' +
      'grant it.',
    ]);
  });
});

Deno.test('a workspace repo with a detached HEAD is skipped beside a passing extra repo', async () => {
  await withFixture(async (f) => {
    const { extra, merged, frozen } = await withExtra(f);
    await f.setHead(`${SHA1}\n`);
    await applyPolicy(EXTRA_GRANT, merged, f.project, f.deps(frozen));
    assertEquals((await pinnedRepos(f, merged))?.map((r) => r.repo), [extra]);
    assertStringIncludes(
      f.logs[0],
      `devc: --bridge-allow: not pinning the workspace repo: HEAD is detached in ${f.project} — `,
    );
  });
});

Deno.test('of two extra repos, the one with a non-GitHub origin is skipped', async () => {
  await withFixture(async (f) => {
    const extra2 = `${f.home}/extra2`;
    await write(`${extra2}/.git/HEAD`, 'ref: refs/heads/feat/two\n');
    await Deno.mkdir(`${extra2}/.git/objects`, { recursive: true });
    await write(
      `${extra2}/.git/config`,
      '[remote "origin"]\n\turl = git@github.com:acme/two.git\n',
    );
    const { extra, merged, frozen } = await withExtra(f, {
      mounts: [`source=${f.home}/extra2,target=/workspaces/extra2,type=bind`],
    });
    await write(
      `${extra}/.git/config`,
      `[remote "origin"]\n\turl = ${f.dir}/remote.git\n`,
    );
    const both = [
      ...frozen,
      ...protectedMounts('/workspaces/extra2', undefined, `${extra2}/.git`),
    ];
    await applyPolicy(
      { grant: ['gh-push'], repos: ['~/extra', '~/extra2'] },
      merged,
      f.project,
      f.deps(both),
    );
    assertEquals((await pinnedRepos(f, merged))?.map((r) => r.repo), [
      f.project,
      extra2,
    ]);
    assertEquals(
      f.logs[0],
      `devc: --bridge-allow: not pinning ~/extra: origin ${f.dir}/remote.git is not a github.com remote`,
    );
  });
});

Deno.test('a grant where no candidate passes lists every reason, before up and after', async () => {
  await withFixture(async (f) => {
    const { merged, frozen } = await withExtra(f, {
      origin: `${f.dir}/remote.git`,
    });
    await applyPolicy(GRANT, merged, f.project, f.deps(frozen));
    const config = `${f.project}/.git/config`;
    await Deno.writeTextFile(
      config,
      (await Deno.readTextFile(config)).replace(/\[remote[^]*$/, ''),
    );
    const reason =
      'no repo can be pinned — the workspace repo: the repo has no ' +
      `remote.origin.url; ~/extra: origin ${f.dir}/remote.git is not a github.com remote`;
    const err = await assertRejects(
      () => checkGrantBeforeUp(merged, f.project, f.deps(null), ['~/extra']),
      BridgeGrantError,
    );
    assertEquals(err.message, `--bridge-allow: ${reason}`);
    assertEquals(await pinnedRepos(f, merged), null);
    const after = await assertRejects(
      () => applyPolicy(EXTRA_GRANT, merged, f.project, f.deps(frozen)),
      BridgeGrantError,
    );
    assertEquals(
      after.message,
      `the container is up, but --bridge-allow was not granted: ${reason}`,
    );
  });
});

Deno.test('a workspace with no origin and no --bridge-repo keeps the exact old error', async () => {
  await withFixture(async (f) => {
    const merged = await f.merged();
    const config = `${f.project}/.git/config`;
    await Deno.writeTextFile(
      config,
      (await Deno.readTextFile(config)).replace(/\[remote[^]*$/, ''),
    );
    const err = await assertRejects(
      () => checkGrantBeforeUp(merged, f.project, f.deps(null)),
      BridgeGrantError,
    );
    assertEquals(
      err.message,
      '--bridge-allow: the repo has no remote.origin.url',
    );
  });
});

Deno.test('container-wide checks fail the grant even when an extra repo passes', async () => {
  await withFixture(async (f) => {
    const { merged, frozen } = await withExtra(f);
    const config = `${f.project}/.git/config`;
    await Deno.writeTextFile(
      config,
      (await Deno.readTextFile(config)).replace(/\[remote[^]*$/, ''),
    );
    // The token mount is checked before any repo: its message, not the missing origin.
    const err = await assertRejects(
      () =>
        applyPolicy(
          EXTRA_GRANT,
          merged,
          f.project,
          f.deps(frozen.filter((m) => m.destination !== '/run/devc-bridge')),
        ),
      BridgeGrantError,
    );
    assertEquals(
      err.message,
      'the container is up, but --bridge-allow was not granted: this container has nothing ' +
        'mounted at /run/devc-bridge',
    );
  });
});

Deno.test('two passing extra repos on one GitHub repo and branch are refused with the workspace skipped', async () => {
  await withFixture(async (f) => {
    const { merged, frozen } = await withExtraWorktree(f);
    const config = `${f.project}/.git/config`;
    await Deno.writeTextFile(
      config,
      (await Deno.readTextFile(config)).replace(/\[remote[^]*$/, ''),
    );
    await write(
      `${f.home}/extra/.git/worktrees/wt/HEAD`,
      'ref: refs/heads/feat/extra\n',
    );
    const err = await assertRejects(
      () =>
        applyPolicy(
          { grant: ['gh-push'], repos: ['~/extra', '~/extra.worktrees/wt'] },
          merged,
          f.project,
          f.deps(frozen),
        ),
      BridgeGrantError,
    );
    assertEquals(
      err.message,
      'the container is up, but --bridge-allow was not granted: ~/extra and ' +
        '~/extra.worktrees/wt both push branch feat/extra to github.com/acme/extra',
    );
  });
});

Deno.test('two pinned repos on one GitHub repo, in different URL shapes, are refused', async () => {
  await withFixture(async (f) => {
    await setOrigin(f, 'git@github.com:acme/x.git');
    const { merged, frozen } = await withExtra(f, {
      origin: 'https://github.com/acme/x',
    });
    for (
      const [run, prefix] of [
        [
          () =>
            checkGrantBeforeUp(merged, f.project, f.deps(null), ['~/extra']),
          '--bridge-allow: ',
        ],
        [
          () => applyPolicy(EXTRA_GRANT, merged, f.project, f.deps(frozen)),
          'the container is up, but --bridge-allow was not granted: ',
        ],
      ] as const
    ) {
      const err = await assertRejects(run, BridgeGrantError);
      assertEquals(
        err.message,
        `${prefix}${f.project} and ~/extra reach github.com/acme/x through different URLs ` +
          '(git@github.com:acme/x.git, https://github.com/acme/x)',
      );
    }
    assertEquals(
      await readPolicy(merged.bridgeKey!, f.deps(null)),
      { kind: 'absent' },
    );
  });
});

Deno.test("refresh revokes the whole policy when an extra repo's HEAD moves, naming the repo", async () => {
  await withFixture(async (f) => {
    const { extra, merged, frozen } = await withExtra(f);
    const deps = f.deps(frozen);
    await applyPolicy(EXTRA_GRANT, merged, f.project, deps);
    await Deno.writeTextFile(
      `${extra}/.git/HEAD`,
      'ref: refs/heads/feat/other\n',
    );
    await applyPolicy('refresh', merged, f.project, deps);
    assertEquals(await readPolicy(merged.bridgeKey!, deps), {
      kind: 'absent',
    });
    assertStringIncludes(
      f.logs.join('\n'),
      `devc: devc-bridge capabilities revoked — ${extra}: the branch is now feat/other, but ` +
        'they were granted for feat/extra. Run `devc up --bridge-allow gh-push,gh-pr-read ' +
        '--bridge-repo …` to grant it.',
    );
  });
});

Deno.test('refresh of an unchanged multi-repo policy writes nothing and logs nothing', async () => {
  await withFixture(async (f) => {
    const { merged, frozen } = await withExtra(f);
    const deps = f.deps(frozen);
    await applyPolicy(EXTRA_GRANT, merged, f.project, deps);
    const file = bridgePaths(f.home, merged.bridgeKey!).policyFile;
    const before = await Deno.readTextFile(file);
    const mtime = (await Deno.stat(file)).mtime;
    const logged = f.logs.length;
    await applyPolicy('refresh', merged, f.project, deps);
    assertEquals(await Deno.readTextFile(file), before);
    assertEquals((await Deno.stat(file)).mtime, mtime);
    assertEquals(f.logs.slice(logged), []);
  });
});

Deno.test('refresh revokes, with the repo named, when an extra repo is no longer protected', async () => {
  await withFixture(async (f) => {
    const { extra, merged, frozen } = await withExtra(f);
    await applyPolicy(EXTRA_GRANT, merged, f.project, f.deps(frozen));
    const unfrozen = frozen.filter((m) =>
      m.destination !== '/workspaces/extra/.git/hooks'
    );
    await applyPolicy('refresh', merged, f.project, f.deps(unfrozen));
    assertEquals(await readPolicy(merged.bridgeKey!, f.deps(null)), {
      kind: 'absent',
    });
    assertStringIncludes(
      f.logs.join('\n'),
      `devc: devc-bridge capabilities revoked — ${extra}: git protection is not in force`,
    );
    assertStringIncludes(
      f.logs.join('\n'),
      'Re-run `devc up --bridge-allow gh-push,gh-pr-read --bridge-repo …` once that is fixed.',
    );
  });
});

Deno.test('status prints one indented line per pinned repo', async () => {
  await withFixture(async (f) => {
    const { extra, merged, frozen } = await withExtra(f);
    await applyPolicy(EXTRA_GRANT, merged, f.project, f.deps(frozen));
    const lines = await bridgeStatusLines(merged, f.project, f.deps(null));
    const at = lines.indexOf('  bridge:    gh-push, gh-pr-read');
    assert(at >= 0, lines.join('\n'));
    assertEquals(lines.slice(at + 1), [
      `    /workspaces/proj: feat/x → git@github.com:acme/proj.git (${f.project})`,
      `    /workspaces/extra: feat/extra → git@github.com:acme/extra.git (${extra})`,
    ]);
  });
});

// ── linked worktrees as extra repos (plan bridge-worktree-extra-repos) ──────────────────────

/**
 * Write a linked worktree of the primary at `primary` (a host repo with a `.git` dir), at host
 * path `wt`, as git lays one out with relative pointers: `wt/.git` → `<rel>`, and in
 * `<primary>/.git/worktrees/<name>/` a `HEAD`, a `gitdir` back-pointer and a `commondir`.
 */
async function linkWorktree(
  primary: string,
  wt: string,
  name: string,
  rel: string,
  branch: string,
): Promise<string> {
  const gitDir = `${primary}/.git/worktrees/${name}`;
  await write(`${gitDir}/HEAD`, `ref: refs/heads/${branch}\n`);
  await write(`${gitDir}/commondir`, '../..\n');
  await write(`${gitDir}/gitdir`, `${wt}/.git\n`);
  await write(`${wt}/.git`, `gitdir: ${rel}\n`);
  return gitDir;
}

/**
 * The motivating setup: the workspace is worktree `wt` of `proj` (as {@link worktreeOf}), and
 * `proj.worktrees` is also mounted whole, holding a second worktree `wt2` of the same repo.
 */
async function worktreePair(f: Fixture, opts: { branch2?: string } = {}) {
  const base = await worktreeOf(f);
  const wt2 = `${f.dir}/proj.worktrees/wt2`;
  await linkWorktree(
    f.project,
    wt2,
    'wt2',
    '../../proj/.git/worktrees/wt2',
    opts.branch2 ?? 'feat/wt2',
  );
  await write(
    `${base.wt}/.devcontainer/devcontainer.json`,
    JSON.stringify({
      image: 'ubuntu',
      features: { [BRIDGE_FEATURE]: {} },
      mounts: [
        `source=${f.dir}/proj.worktrees,target=/workspaces/proj.worktrees,type=bind`,
      ],
    }),
  );
  const merged = await ensureMergedConfig(base.wt, {
    cacheRoot: `${f.dir}/cache`,
    templatesDir: `${f.dir}/no-templates`,
    configDir: `${f.dir}/config`,
    home: f.home,
  });
  const frozen: ContainerMount[] = [
    ...base.frozen,
    {
      type: 'bind',
      source: `${f.dir}/proj.worktrees`,
      destination: '/workspaces/proj.worktrees',
      rw: true,
    },
  ];
  return { wt: base.wt, wt2, merged, frozen };
}

Deno.test('a second worktree of the workspace repo is pinned beside the workspace worktree', async () => {
  await withFixture(async (f) => {
    const { wt, wt2, merged, frozen } = await worktreePair(f);
    await checkGrantBeforeUp(merged, wt, f.deps(null), [wt2]);
    await applyPolicy(
      { grant: ['gh-push'], repos: [wt2] },
      merged,
      wt,
      f.deps(frozen),
    );
    const policy = await readPolicy(merged.bridgeKey!, f.deps(null));
    assertEquals(policy.kind === 'present' && policy.record.repos, [
      {
        repo: wt,
        remote: 'git@github.com:acme/proj.git',
        branch: 'feat/wt',
        grants: ['gh-push'],
        target: '/workspaces/proj.worktrees/wt',
      },
      {
        repo: wt2,
        remote: 'git@github.com:acme/proj.git',
        branch: 'feat/wt2',
        grants: ['gh-push'],
        target: '/workspaces/proj.worktrees/wt2',
      },
    ]);
    assertEquals(await exists(f.marker), false);
  });
});

Deno.test("a second worktree on the workspace worktree's branch is refused", async () => {
  await withFixture(async (f) => {
    const { wt, wt2, merged, frozen } = await worktreePair(f, {
      branch2: 'feat/wt',
    });
    const err = await assertRejects(
      () =>
        applyPolicy(
          { grant: ['gh-push'], repos: [wt2] },
          merged,
          wt,
          f.deps(frozen),
        ),
      BridgeGrantError,
    );
    assertEquals(
      err.message,
      `the container is up, but --bridge-allow was not granted: ${wt} and ${wt2} both push ` +
        'branch feat/wt to github.com/acme/proj',
    );
  });
});

Deno.test('refresh revokes when a pinned extra worktree switches branch, and keeps an unchanged one', async () => {
  await withFixture(async (f) => {
    const { wt, wt2, merged, frozen } = await worktreePair(f);
    const deps = f.deps(frozen);
    await applyPolicy({ grant: ['gh-push'], repos: [wt2] }, merged, wt, deps);
    const file = bridgePaths(f.home, merged.bridgeKey!).policyFile;
    const before = await Deno.readTextFile(file);
    const mtime = (await Deno.stat(file)).mtime;
    f.logs.length = 0;
    await applyPolicy('refresh', merged, wt, deps);
    assertEquals(await Deno.readTextFile(file), before);
    assertEquals((await Deno.stat(file)).mtime, mtime);
    assertEquals(f.logs, []);

    await write(
      `${f.project}/.git/worktrees/wt2/HEAD`,
      'ref: refs/heads/main\n',
    );
    await applyPolicy('refresh', merged, wt, deps);
    assertEquals(await readPolicy(merged.bridgeKey!, deps), {
      kind: 'absent',
    });
    assertStringIncludes(
      f.logs.join('\n'),
      `${wt2}: the branch is now main, but they were granted for feat/wt2`,
    );
  });
});

/**
 * An extra repo `~/extra` (as {@link withExtra}) with `~/extra.worktrees` mounted at `mountTarget`,
 * holding worktree `wt` of it whose `.git` points by `rel`.
 */
async function withExtraWorktree(
  f: Fixture,
  opts: { mountTarget?: string; rel?: string } = {},
) {
  const wt = `${f.home}/extra.worktrees/wt`;
  const mountTarget = opts.mountTarget ?? '/workspaces/extra.worktrees';
  const { extra, merged, frozen } = await withExtra(f, {
    mounts: [
      `source=${f.home}/extra.worktrees,target=${mountTarget},type=bind`,
    ],
  });
  const gitDir = await linkWorktree(
    extra,
    wt,
    'wt',
    opts.rel ?? '../../extra/.git/worktrees/wt',
    'feat/extra-wt',
  );
  return { extra, wt, gitDir, merged, frozen };
}

Deno.test("a worktree of another protected repo mount is pinned with that repo's frozen remote", async () => {
  await withFixture(async (f) => {
    const { wt, merged, frozen } = await withExtraWorktree(f);
    await applyPolicy(
      { grant: ['gh-push'], repos: ['~/extra.worktrees/wt'] },
      merged,
      f.project,
      f.deps(frozen),
    );
    const policy = await readPolicy(merged.bridgeKey!, f.deps(null));
    assertEquals(policy.kind === 'present' && policy.record.repos[1], {
      repo: wt,
      remote: 'git@github.com:acme/extra.git',
      branch: 'feat/extra-wt',
      grants: ['gh-push'],
      target: '/workspaces/extra.worktrees/wt',
    });
  });
});

Deno.test('an extra worktree whose primary git dir is writable in the container is skipped', async () => {
  await withFixture(async (f) => {
    const { merged, frozen } = await withExtraWorktree(f);
    const writable = frozen.map((m) =>
      m.destination === '/workspaces/extra/.git/hooks' ? { ...m, rw: true } : m
    );
    await applyPolicy(
      { grant: ['gh-push'], repos: ['~/extra.worktrees/wt'] },
      merged,
      f.project,
      f.deps(writable),
    );
    assertEquals((await pinnedRepos(f, merged))?.map((r) => r.repo), [
      f.project,
    ]);
    assertStringIncludes(
      f.logs[0],
      'devc: --bridge-allow: not pinning ~/extra.worktrees/wt: git protection is not in force ' +
        'in this container for /workspaces/extra.worktrees/wt (/workspaces/extra/.git/hooks is ' +
        'mounted read-write)',
    );
  });
});

Deno.test('extra worktrees that fail a check are refused, each with its reason', async () => {
  await withFixture(async (f) => {
    const refusal = async (
      merged: MergedConfig,
      frozen: ContainerMount[],
      arg: string,
    ) =>
      (await assertRejects(
        () =>
          applyPolicy(
            { grant: ['gh-push'], repos: [arg] },
            merged,
            f.project,
            f.deps(frozen),
          ),
        BridgeGrantError,
      )).message;

    // Not inside any bind mount.
    {
      const { extra, merged, frozen } = await withExtra(f);
      const loose = `${f.dir}/elsewhere/wt`;
      await linkWorktree(
        extra,
        loose,
        'loose',
        `../../home/extra/.git/worktrees/loose`,
        'feat/l',
      );
      assertEquals(
        await refusal(merged, frozen, loose),
        `--bridge-repo ${loose}: a linked worktree that is not inside any bind mount of this ` +
          'workspace',
      );
    }
    // An absolute gitdir: pointer.
    {
      const { wt, gitDir, merged, frozen } = await withExtraWorktree(f);
      await write(`${wt}/.git`, `gitdir: ${gitDir}\n`);
      assertEquals(
        await refusal(merged, frozen, wt),
        `--bridge-repo ${wt}: its .git uses an absolute gitdir: path, which does not resolve ` +
          'inside the container — run git worktree repair --relative-paths',
      );
    }
    // A wrong back-reference.
    {
      const { extra, wt, gitDir, merged, frozen } = await withExtraWorktree(f);
      await write(`${gitDir}/gitdir`, `${extra}/somewhere-else/.git\n`);
      assertEquals(
        await refusal(merged, frozen, wt),
        `--bridge-repo ${wt}: its .git points at ${gitDir}, which is not the worktrees/ dir of ` +
          'a git-protected repo here',
      );
    }
    // A pointer into a git dir no protected row covers.
    {
      const { merged, frozen } = await withExtra(f, {
        mounts: [
          `source=${f.home}/other.worktrees,target=/workspaces/other.worktrees,type=bind`,
        ],
      });
      const other = `${f.home}/other`;
      await write(`${other}/.git/HEAD`, 'ref: refs/heads/main\n');
      await Deno.mkdir(`${other}/.git/objects`, { recursive: true });
      const wt = `${f.home}/other.worktrees/wt`;
      const gitDir = await linkWorktree(
        other,
        wt,
        'wt',
        '../../other/.git/worktrees/wt',
        'feat/o',
      );
      assertEquals(
        await refusal(merged, frozen, wt),
        `--bridge-repo ${wt}: its .git points at ${gitDir}, which is not the worktrees/ dir of ` +
          'a git-protected repo here',
      );
    }
    // A mount target that breaks the sibling layout, so the pointer lands elsewhere inside.
    {
      const { wt, merged, frozen } = await withExtraWorktree(f, {
        mountTarget: '/elsewhere/deep/extra.worktrees',
      });
      assertEquals(
        await refusal(merged, frozen, wt),
        `--bridge-repo ${wt}: its gitdir: pointer resolves to /elsewhere/deep/extra/.git/worktrees/wt ` +
          'inside the container, not /workspaces/extra/.git/worktrees/wt',
      );
    }
    // The primary's frozen config enables extensions.worktreeConfig: a precondition of the repo,
    // not of the argument, so the worktree is skipped and the workspace still pinned.
    {
      const { extra, wt, merged, frozen } = await withExtraWorktree(f);
      const config = `${extra}/.git/config`;
      await Deno.writeTextFile(
        config,
        (await Deno.readTextFile(config)) +
          '[extensions]\n\tworktreeConfig = true\n',
      );
      await applyPolicy(
        { grant: ['gh-push'], repos: [wt] },
        merged,
        f.project,
        f.deps(frozen),
      );
      assertEquals(
        f.logs[0],
        `devc: --bridge-allow: not pinning ${wt}: ${WORKTREE_CONFIG_REASON}`,
      );
      assertEquals((await pinnedRepos(f, merged))?.map((r) => r.repo), [
        f.project,
      ]);
      await applyPolicy('revoke', merged, f.project, f.deps(frozen));
    }
    assertEquals(
      await readPolicy(await projectKey(f.project), f.deps(null)),
      { kind: 'absent' },
    );
  });
});

Deno.test('extensions.worktreeConfig on the workspace repo refuses the grant, and revokes on refresh', async () => {
  await withFixture(async (f) => {
    const merged = await f.merged();
    const deps = f.deps(f.frozen);
    const config = `${f.project}/.git/config`;
    const plain = await Deno.readTextFile(config);
    await Deno.writeTextFile(
      config,
      plain + '[extensions]\n\tworktreeConfig = true\n',
    );
    const err = await assertRejects(
      () => applyPolicy(GRANT, merged, f.project, deps),
      BridgeGrantError,
    );
    assertStringIncludes(err.message, WORKTREE_CONFIG_REASON);

    await Deno.writeTextFile(config, plain);
    await applyPolicy(GRANT, merged, f.project, deps);
    await Deno.writeTextFile(
      config,
      plain + '[extensions]\n\tworktreeConfig = true\n',
    );
    await applyPolicy('refresh', merged, f.project, deps);
    assertEquals(await readPolicy(merged.bridgeKey!, deps), {
      kind: 'absent',
    });
    assertStringIncludes(f.logs.join('\n'), WORKTREE_CONFIG_REASON);
  });
});

// ── per-repo default grants (plan bridge-per-repo-grants) ───────────────────────────────────

/** A primary repo at `path` with `remote` and `branch`, carrying the fsmonitor tripwire. */
async function makeRepo(
  f: Fixture,
  path: string,
  remote: string,
  branch = 'main',
): Promise<void> {
  await write(`${path}/.git/HEAD`, `ref: refs/heads/${branch}\n`);
  await Deno.mkdir(`${path}/.git/objects`, { recursive: true });
  await Deno.mkdir(`${path}/.git/hooks`, { recursive: true });
  await write(
    `${path}/.git/config`,
    `[core]\n\tfsmonitor = ${f.dir}/fsmonitor.sh\n[remote "origin"]\n\turl = ${remote}\n`,
  );
}

/** The live mounts git protection leaves for repo `source` at `target`. */
function repoMounts(
  source: string,
  target: string,
  configSource = `${source}/.git/config`,
): ContainerMount[] {
  return [
    { type: 'bind', source, destination: target, rw: true },
    {
      type: 'bind',
      source: `${source}/.git`,
      destination: `${target}/.git`,
      rw: true,
    },
    {
      type: 'bind',
      source: configSource,
      destination: `${target}/.git/config`,
      rw: false,
    },
    {
      type: 'bind',
      source: `${source}/.git/hooks`,
      destination: `${target}/.git/hooks`,
      rw: false,
    },
  ];
}

/** `bridgeRepoAllow` resolved as `up` resolves it, keyed by host path; notices into `f.logs`. */
async function repoAllow(
  f: Fixture,
  entries: Record<string, BridgeCapability[]>,
): Promise<RepoAllow> {
  return await resolveRepoAllow(
    Object.entries(entries).map(([key, grants]) => ({
      key,
      path: key,
      grants,
    })),
    (m) => f.logs.push(m),
  );
}

async function policyLines(f: Fixture, merged: MergedConfig) {
  const policy = await readPolicy(merged.bridgeKey!, f.deps(null));
  return policy.kind === 'present'
    ? policy.record.repos.map((r) => [r.repo, r.grants.join(',')])
    : null;
}

Deno.test('defaults: the workspace gets its entry, else bridgeDefaultAllow', async () => {
  await withFixture(async (f) => {
    const merged = await f.merged();
    const deps = f.deps(f.frozen);
    await applyPolicy(
      {
        defaultGrant: ['gh-pr-read'],
        repoAllow: await repoAllow(f, {
          [f.project]: ['gh-pr-read', 'gh-pr-reply'],
        }),
      },
      merged,
      f.project,
      deps,
    );
    assertEquals(await policyLines(f, merged), [
      [f.project, 'gh-pr-read,gh-pr-reply'],
    ]);
    await applyPolicy(
      { defaultGrant: ['gh-pr-read'], repoAllow: new Map() },
      merged,
      f.project,
      deps,
    );
    assertEquals(await policyLines(f, merged), [[f.project, 'gh-pr-read']]);
    // An [] entry for the workspace: silently not pinned, and the old policy removed.
    f.logs.length = 0;
    await applyPolicy(
      {
        defaultGrant: ['gh-pr-read'],
        repoAllow: await repoAllow(f, { [f.project]: [] }),
      },
      merged,
      f.project,
      deps,
    );
    assertEquals(await policyLines(f, merged), null);
    assertEquals(f.logs, []);
  });
});

Deno.test('defaults: a --bridge-repo worktree of a mapped repo gets the entry, and the grant log names each line', async () => {
  await withFixture(async (f) => {
    const { extra, wt, merged, frozen } = await withExtraWorktree(f);
    const mode: PolicyMode = {
      defaultGrant: ['gh-pr-read'],
      repos: [wt],
      repoAllow: await repoAllow(f, {
        [extra]: ['gh-pr-read', 'gh-pr-reply'],
      }),
    };
    await checkDefaultsBeforeUp(merged, f.project, f.deps(null), [wt]);
    await applyPolicy(mode, merged, f.project, f.deps(frozen));
    // The workspace, the --bridge-repo, then the mapped mount itself.
    assertEquals(await policyLines(f, merged), [
      [f.project, 'gh-pr-read'],
      [wt, 'gh-pr-read,gh-pr-reply'],
      [extra, 'gh-pr-read,gh-pr-reply'],
    ]);
    assertEquals(f.logs, [
      'devc: devc-bridge capabilities granted (defaults):',
      `devc:   /workspaces/proj: feat/x → git@github.com:acme/proj.git (${f.project}): gh-pr-read`,
      `devc:   /workspaces/extra.worktrees/wt: feat/extra-wt → git@github.com:acme/extra.git (${wt}): gh-pr-read, gh-pr-reply`,
      `devc:   /workspaces/extra: feat/extra → git@github.com:acme/extra.git (${extra}): gh-pr-read, gh-pr-reply`,
    ]);
    // Written with each line's own grants.
    assertEquals(
      await Deno.readTextFile(
        bridgePaths(f.home, merged.bridgeKey!).policyFile,
      ),
      `${f.project}\tgit@github.com:acme/proj.git\tfeat/x\tgh-pr-read\t/workspaces/proj\n` +
        `${wt}\tgit@github.com:acme/extra.git\tfeat/extra-wt\tgh-pr-read,gh-pr-reply\t/workspaces/extra.worktrees/wt\n` +
        `${extra}\tgit@github.com:acme/extra.git\tfeat/extra\tgh-pr-read,gh-pr-reply\t/workspaces/extra\n`,
    );

    // An [] entry: the --bridge-repo is named and skipped, and the mount is not pinned.
    f.logs.length = 0;
    await applyPolicy(
      { ...mode, repoAllow: await repoAllow(f, { [extra]: [] }) },
      merged,
      f.project,
      f.deps(frozen),
    );
    assertEquals(await policyLines(f, merged), [[f.project, 'gh-pr-read']]);
    assertEquals(f.logs, [
      `devc: not pinning ${wt}: no default grants for it — pass --bridge-allow`,
      'devc: devc-bridge capabilities granted (defaults):',
      `devc:   /workspaces/proj: feat/x → git@github.com:acme/proj.git (${f.project}): gh-pr-read`,
    ]);
  });
});

Deno.test('defaults: an unnamed mounted repo is pinned only for a non-empty entry', async () => {
  await withFixture(async (f) => {
    const { extra, merged, frozen } = await withExtra(f);
    const deps = f.deps(frozen);
    await applyPolicy(
      {
        defaultGrant: null,
        repoAllow: await repoAllow(f, { [extra]: ['gh-pr-read'] }),
      },
      merged,
      f.project,
      deps,
    );
    // No bridgeDefaultAllow and no entry for the workspace: only the mapped mount.
    assertEquals(await policyLines(f, merged), [[extra, 'gh-pr-read']]);
    await applyPolicy(
      {
        defaultGrant: ['gh-push'],
        repoAllow: await repoAllow(f, { [extra]: [] }),
      },
      merged,
      f.project,
      deps,
    );
    assertEquals(await policyLines(f, merged), [[f.project, 'gh-push']]);
    // bridgeDefaultAllow alone never pins a repo nobody named.
    await applyPolicy(
      { defaultGrant: ['gh-push'], repoAllow: new Map() },
      merged,
      f.project,
      deps,
    );
    assertEquals(await policyLines(f, merged), [[f.project, 'gh-push']]);
  });
});

Deno.test("defaults: a mapped repo's mounted worktrees are pinned with its entry, unnamed", async () => {
  await withFixture(async (f) => {
    const { extra, wt, merged, frozen } = await withExtraWorktree(f);
    // In the mirror with an absolute pointer: skipped, with its reason.
    const bad = `${f.home}/extra.worktrees/bad`;
    await linkWorktree(
      extra,
      bad,
      'bad',
      `${extra}/.git/worktrees/bad`,
      'feat/bad',
    );
    // Outside every mount: not in this container, passed over silently.
    await linkWorktree(
      extra,
      `${f.home}/elsewhere/wt3`,
      'wt3',
      '../../extra/.git/worktrees/wt3',
      'feat/wt3',
    );
    const deps = f.deps(frozen);
    const mode: PolicyMode = {
      defaultGrant: ['gh-pr-read'],
      repoAllow: await repoAllow(f, {
        [extra]: ['gh-pr-read', 'gh-pr-reply'],
      }),
    };
    await applyPolicy(mode, merged, f.project, deps);
    assertEquals(await policyLines(f, merged), [
      [f.project, 'gh-pr-read'],
      [extra, 'gh-pr-read,gh-pr-reply'],
      [wt, 'gh-pr-read,gh-pr-reply'],
    ]);
    assertEquals(f.logs, [
      'devc: defaults: not pinning ~/extra.worktrees/bad: its .git uses an absolute gitdir: ' +
      'path, which does not resolve inside the container — run git worktree repair --relative-paths',
      'devc: devc-bridge capabilities granted (defaults):',
      `devc:   /workspaces/proj: feat/x → git@github.com:acme/proj.git (${f.project}): gh-pr-read`,
      `devc:   /workspaces/extra: feat/extra → git@github.com:acme/extra.git (${extra}): gh-pr-read, gh-pr-reply`,
      `devc:   /workspaces/extra.worktrees/wt: feat/extra-wt → git@github.com:acme/extra.git (${wt}): gh-pr-read, gh-pr-reply`,
    ]);

    // Refresh re-derives the worktree line and keeps the policy as it is.
    const file = bridgePaths(f.home, merged.bridgeKey!).policyFile;
    const before = await Deno.readTextFile(file);
    f.logs.length = 0;
    await applyPolicy('refresh', merged, f.project, deps);
    assertEquals(await Deno.readTextFile(file), before);
    assertEquals(f.logs, []);

    // An [] entry pins neither the repo nor its worktrees, and says nothing about them.
    f.logs.length = 0;
    await applyPolicy(
      { ...mode, repoAllow: await repoAllow(f, { [extra]: [] }) },
      merged,
      f.project,
      deps,
    );
    assertEquals(await policyLines(f, merged), [[f.project, 'gh-pr-read']]);
    assertEquals(f.logs.some((l) => l.includes('not pinning')), false);
  });
});

Deno.test('defaults: in a worktree workspace, a sibling worktree of the mapped repo is pinned', async () => {
  await withFixture(async (f) => {
    const { wt, wt2, merged, frozen } = await worktreePair(f);
    await applyPolicy(
      {
        defaultGrant: null,
        repoAllow: await repoAllow(f, { [f.project]: ['gh-pr-read'] }),
      },
      merged,
      wt,
      f.deps(frozen),
    );
    // The workspace worktree once, as line 1; its sibling after it.
    assertEquals(await policyLines(f, merged), [
      [wt, 'gh-pr-read'],
      [wt2, 'gh-pr-read'],
    ]);
  });
});

Deno.test('defaults: a worktree whose .git is repointed at a mapped repo is not given its entry', async () => {
  await withFixture(async (f) => {
    // 1. The mapped repo is not mounted here: the repointed worktree names nothing pinnable.
    {
      const { wt, merged, frozen } = await withExtraWorktree(f);
      const other = `${f.home}/other`;
      await makeRepo(f, other, 'git@github.com:acme/other.git');
      await linkWorktree(
        other,
        wt,
        'wt',
        '../../other/.git/worktrees/wt',
        'feat/other-wt',
      );
      const mode: PolicyMode = {
        defaultGrant: ['gh-pr-read'],
        repos: [wt],
        repoAllow: await repoAllow(f, {
          [other]: ['gh-pr-read', 'gh-pr-reply'],
        }),
      };
      const before = await assertRejects(
        () => checkDefaultsBeforeUp(merged, f.project, f.deps(null), [wt]),
        BridgeGrantError,
      );
      assertStringIncludes(
        before.message,
        'which is not the worktrees/ dir of a git-protected repo here',
      );
      await assertRejects(
        () => applyPolicy(mode, merged, f.project, f.deps(frozen)),
        BridgeGrantError,
        'which is not the worktrees/ dir of a git-protected repo here',
      );
      assertEquals(await policyLines(f, merged), null);
      await Deno.remove(f.home, { recursive: true });
    }
    // 2. It is mounted, but the frozen config the container really has is the old repo's: the
    // entry follows the frozen data, not the pointer.
    {
      const { extra, wt, frozen } = await withExtraWorktree(f);
      const other = `${f.home}/other`;
      await makeRepo(f, other, 'git@github.com:acme/other.git');
      const merged = await f.merged({
        mounts: [
          `source=${extra},target=/workspaces/extra,type=bind`,
          `source=${f.home}/extra.worktrees,target=/workspaces/extra.worktrees,type=bind`,
          `source=${other},target=/workspaces/other,type=bind`,
        ],
      });
      await linkWorktree(
        other,
        wt,
        'wt',
        '../../other/.git/worktrees/wt',
        'feat/other-wt',
      );
      const mounts = [
        ...frozen,
        {
          type: 'bind' as const,
          source: `${f.home}/extra.worktrees`,
          destination: '/workspaces/extra.worktrees',
          rw: true,
        },
        ...repoMounts(other, '/workspaces/other', `${extra}/.git/config`),
      ];
      await applyPolicy(
        {
          defaultGrant: ['gh-pr-read'],
          repos: [wt],
          repoAllow: await repoAllow(f, {
            [other]: ['gh-pr-read', 'gh-pr-reply'],
          }),
        },
        merged,
        f.project,
        f.deps(mounts),
      );
      const lines = await policyLines(f, merged);
      assertEquals(lines, [[f.project, 'gh-pr-read'], [wt, 'gh-pr-read']]);
    }
  });
});

Deno.test('bridgeRepoAllow: two keys naming one repo fail, a key for a deleted folder is ignored', async () => {
  await withFixture(async (f) => {
    const { extra, wt } = await withExtraWorktree(f);
    // A worktree and a subfolder of its primary both name the primary's repo.
    await Deno.mkdir(`${extra}/src`);
    const err = await assertRejects(
      () =>
        resolveRepoAllow([
          { key: '~/gone', path: `${f.home}/gone`, grants: ['gh-pr-read'] },
          { key: '~/proj', path: f.project, grants: [] },
          { key: '~/extra/src', path: `${extra}/src`, grants: ['gh-pr-read'] },
          { key: '~/extra.worktrees/wt', path: wt, grants: [] },
        ], (m) => f.logs.push(m)),
      RepoAllowError,
    );
    assertEquals(
      err.message,
      '~/extra/src and ~/extra.worktrees/wt name the same repo',
    );
    assertEquals(f.logs, [
      'devc: bridgeRepoAllow: ignoring ~/gone: no such folder',
    ]);
    f.logs.length = 0;
    await Deno.mkdir(`${f.dir}/plain`);
    const ok = await resolveRepoAllow([
      { key: '/plain', path: `${f.dir}/plain`, grants: ['gh-pr-read'] },
      { key: '~/extra', path: extra, grants: ['gh-pr-read'] },
    ], (m) => f.logs.push(m));
    assertEquals([...ok.entries()], [[
      await Deno.realPath(`${extra}/.git`),
      ['gh-pr-read'],
    ]]);
    assertEquals(f.logs, [
      'devc: bridgeRepoAllow: ignoring /plain: not in a git repo',
    ]);
  });
});

Deno.test('bridgeRepoAllow: the paths of one ;-separated key resolve on their own', async () => {
  await withFixture(async (f) => {
    const { extra, wt } = await withExtraWorktree(f);
    await Deno.mkdir(`${f.dir}/plain`);
    // Two paths of one key that name the same repo are the same refusal as two keys.
    const err = await assertRejects(
      () =>
        resolveRepoAllow(
          parseBridgeRepoAllow({ [`${extra};${wt}`]: ['gh-pr-read'] })!,
          (m) => f.logs.push(m),
        ),
      RepoAllowError,
    );
    assertEquals(err.message, `${extra} and ${wt} name the same repo`);
    // Each path stands alone: one not in a repo is ignored, the other still applies.
    f.logs.length = 0;
    const ok = await resolveRepoAllow(
      parseBridgeRepoAllow({
        [`${f.dir}/plain ; ${extra}`]: ['gh-pr-read', 'gh-pr-viewed'],
      })!,
      (m) => f.logs.push(m),
    );
    assertEquals([...ok.entries()], [[
      await Deno.realPath(`${extra}/.git`),
      ['gh-pr-read', 'gh-pr-viewed'],
    ]]);
    assertEquals(f.logs, [
      `devc: bridgeRepoAllow: ignoring ${f.dir}/plain: not in a git repo`,
    ]);
  });
});

Deno.test('defaults: an explicit --bridge-allow ignores the map — every pin gets the list, no map repo is pinned', async () => {
  await withFixture(async (f) => {
    const { merged, frozen } = await withExtra(f);
    await applyPolicy(
      { grant: ['gh-push'] },
      merged,
      f.project,
      f.deps(frozen),
    );
    assertEquals(await policyLines(f, merged), [[f.project, 'gh-push']]);
    assertEquals(f.logs, [
      'devc: devc-bridge capabilities granted: gh-push',
      `devc:   /workspaces/proj: feat/x → git@github.com:acme/proj.git (${f.project})`,
    ]);
  });
});

Deno.test('defaults: past 16 repos, a candidate is skipped with the cap notice', async () => {
  await withFixture(async (f) => {
    const mounts: string[] = [];
    const live: ContainerMount[] = [...f.frozen];
    const entries: Record<string, BridgeCapability[]> = {};
    for (let i = 0; i < 16; i++) {
      const repo = `${f.home}/r${i}`;
      await makeRepo(f, repo, `git@github.com:acme/r${i}.git`);
      mounts.push(`source=${repo},target=/workspaces/r${i},type=bind`);
      live.push(...repoMounts(repo, `/workspaces/r${i}`));
      entries[repo] = ['gh-pr-read'];
    }
    const merged = await f.merged({ mounts });
    await applyPolicy(
      { defaultGrant: ['gh-push'], repoAllow: await repoAllow(f, entries) },
      merged,
      f.project,
      f.deps(live),
    );
    const lines = await policyLines(f, merged);
    assertEquals(lines?.length, 16);
    assertEquals(lines?.[0], [f.project, 'gh-push']);
    assertEquals(
      f.logs[0],
      'devc: defaults: not pinning ~/r15: a policy pins at most 16 repos',
    );
    assertEquals(
      f.logs[1],
      'devc: devc-bridge capabilities granted (defaults):',
    );
  });
});

Deno.test('defaults: the cap counts repos, so a worktree of a pinned repo is pinned past 16 lines', async () => {
  await withFixture(async (f) => {
    const mounts: string[] = [];
    const live: ContainerMount[] = [...f.frozen];
    const entries: Record<string, BridgeCapability[]> = {};
    for (let i = 0; i < 16; i++) {
      const repo = `${f.home}/r${i}`;
      await makeRepo(f, repo, `git@github.com:acme/r${i}.git`);
      mounts.push(`source=${repo},target=/workspaces/r${i},type=bind`);
      live.push(...repoMounts(repo, `/workspaces/r${i}`));
      entries[repo] = ['gh-pr-read'];
    }
    const wt = `${f.home}/r0.worktrees/wt`;
    await linkWorktree(
      `${f.home}/r0`,
      wt,
      'wt',
      '../../r0/.git/worktrees/wt',
      'feat/r0-wt',
    );
    mounts.push(
      `source=${f.home}/r0.worktrees,target=/workspaces/r0.worktrees,type=bind`,
    );
    live.push({
      type: 'bind',
      source: `${f.home}/r0.worktrees`,
      destination: '/workspaces/r0.worktrees',
      rw: true,
    });
    const merged = await f.merged({ mounts });
    await applyPolicy(
      { defaultGrant: ['gh-push'], repoAllow: await repoAllow(f, entries) },
      merged,
      f.project,
      f.deps(live),
    );
    const lines = await policyLines(f, merged);
    assertEquals(lines?.length, 17);
    assertEquals(lines?.[16], [wt, 'gh-pr-read']);
    assertEquals(
      f.logs[0],
      'devc: defaults: not pinning ~/r15: a policy pins at most 16 repos',
    );
  });
});

Deno.test('defaults: per-repo preconditions skip with the defaults: prefix, and a same-repo clash only fails with a --bridge-repo', async () => {
  await withFixture(async (f) => {
    const { extra, merged, frozen } = await withExtra(f);
    await Deno.writeTextFile(`${extra}/.git/HEAD`, `${SHA1}\n`);
    await applyPolicy(
      {
        defaultGrant: ['gh-pr-read'],
        repoAllow: await repoAllow(f, { [extra]: ['gh-pr-read'] }),
      },
      merged,
      f.project,
      f.deps(frozen),
    );
    assertEquals(await policyLines(f, merged), [[f.project, 'gh-pr-read']]);
    assertEquals(
      f.logs[0],
      `devc: defaults: not pinning ~/extra: HEAD is detached in ${extra} — check out the branch to publish`,
    );
    // The mapped repo pushes the workspace's own repo and branch.
    await Deno.writeTextFile(`${extra}/.git/HEAD`, 'ref: refs/heads/feat/x\n');
    await Deno.writeTextFile(
      `${extra}/.git/config`,
      '[remote "origin"]\n\turl = git@github.com:acme/proj.git\n',
    );
    const mode: PolicyMode = {
      defaultGrant: ['gh-pr-read'],
      repoAllow: await repoAllow(f, { [extra]: ['gh-pr-read'] }),
    };
    f.logs.length = 0;
    await applyPolicy(mode, merged, f.project, f.deps(frozen));
    assertEquals(await policyLines(f, merged), null);
    assertEquals(f.logs, [
      `devc: defaults: not granted: ${f.project} and ~/extra both push branch feat/x to github.com/acme/proj`,
    ]);
    await assertRejects(
      () =>
        applyPolicy(
          { ...mode, repos: [extra] },
          merged,
          f.project,
          f.deps(frozen),
        ),
      BridgeGrantError,
      `the container is up, but the defaults were not granted: ${f.project} and ${extra} both push branch feat/x`,
    );
  });
});

Deno.test('defaults: a --bridge-repo typo fails before up and after, and nothing else does', async () => {
  await withFixture(async (f) => {
    const { merged, frozen } = await withExtra(f);
    await assertRejects(
      () =>
        checkDefaultsBeforeUp(merged, f.project, f.deps(null), [
          `${f.home}/nope`,
        ]),
      BridgeGrantError,
      `--bridge-repo ${f.home}/nope: no such directory`,
    );
    await assertRejects(
      () =>
        applyPolicy(
          { defaultGrant: ['gh-pr-read'], repos: [`${f.home}/nope`] },
          merged,
          f.project,
          f.deps(frozen),
        ),
      BridgeGrantError,
      'no such directory',
    );
    // The workspace repo itself is not a --bridge-repo.
    await assertRejects(
      () => checkDefaultsBeforeUp(merged, f.project, f.deps(null), [f.project]),
      BridgeGrantError,
      'this is the workspace repo',
    );
    // A detached HEAD is a precondition: the pre-up check passes.
    await Deno.writeTextFile(`${f.home}/extra/.git/HEAD`, `${SHA1}\n`);
    await checkDefaultsBeforeUp(merged, f.project, f.deps(null), [
      `${f.home}/extra`,
    ]);
  });
});

Deno.test('refresh of a mixed policy re-derives every line, and its hint is devc up', async () => {
  await withFixture(async (f) => {
    const { extra, merged, frozen } = await withExtra(f);
    const deps = f.deps(frozen);
    await applyPolicy(
      {
        defaultGrant: ['gh-pr-read'],
        repoAllow: await repoAllow(f, {
          [extra]: ['gh-pr-read', 'gh-pr-reply'],
        }),
      },
      merged,
      f.project,
      deps,
    );
    const file = bridgePaths(f.home, merged.bridgeKey!).policyFile;
    const before = await Deno.readTextFile(file);
    f.logs.length = 0;
    await applyPolicy('refresh', merged, f.project, deps);
    assertEquals(await Deno.readTextFile(file), before);
    assertEquals(f.logs, []);
    await Deno.writeTextFile(
      `${extra}/.git/HEAD`,
      'ref: refs/heads/feat/other\n',
    );
    await applyPolicy('refresh', merged, f.project, deps);
    assertEquals(await policyLines(f, merged), null);
    assertEquals(f.logs, [
      `devc: devc-bridge capabilities revoked — ${extra}: the branch is now feat/other, but ` +
      'they were granted for feat/extra. Run `devc up` to grant it.',
    ]);
  });
});

Deno.test("status: per-repo grant lines when they differ, today's lines when they are the same", async () => {
  await withFixture(async (f) => {
    const { extra, merged, frozen } = await withExtra(f);
    await applyPolicy(
      {
        defaultGrant: ['gh-pr-read'],
        repoAllow: await repoAllow(f, {
          [extra]: ['gh-pr-read', 'gh-pr-reply'],
        }),
      },
      merged,
      f.project,
      f.deps(frozen),
    );
    let lines = await bridgeStatusLines(merged, f.project, f.deps(null));
    let at = lines.indexOf('  bridge:');
    assert(at >= 0, lines.join('\n'));
    assertEquals(lines.slice(at + 1), [
      `    /workspaces/proj: feat/x → git@github.com:acme/proj.git (${f.project}): gh-pr-read`,
      `    /workspaces/extra: feat/extra → git@github.com:acme/extra.git (${extra}): gh-pr-read, gh-pr-reply`,
    ]);
    await applyPolicy(
      {
        defaultGrant: ['gh-pr-read'],
        repoAllow: await repoAllow(f, { [extra]: ['gh-pr-read'] }),
      },
      merged,
      f.project,
      f.deps(frozen),
    );
    lines = await bridgeStatusLines(merged, f.project, f.deps(null));
    at = lines.indexOf('  bridge:    gh-pr-read');
    assert(at >= 0, lines.join('\n'));
    assertEquals(lines.slice(at + 1), [
      `    /workspaces/proj: feat/x → git@github.com:acme/proj.git (${f.project})`,
      `    /workspaces/extra: feat/extra → git@github.com:acme/extra.git (${extra})`,
    ]);
  });
});
