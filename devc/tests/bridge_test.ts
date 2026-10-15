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
  type PolicyMode,
  pruneBridgeFiles,
  readPolicy,
  removeBridgeFiles,
} from '../bridge.ts';
import { parseUpArgs } from '../args.ts';

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
const GRANT: PolicyMode = { grant: ['gh-push', 'gh-pr-review'] };

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
      `${f.project}\tgit@github.com:acme/proj.git\tfeat/x\tgh-push,gh-pr-review\t/workspaces/proj\n`,
    );
    assertEquals((await Deno.stat(file)).mode! & 0o777, 0o600);
    assertEquals(f.logs, [
      'devc: devc-bridge capabilities granted: gh-push, gh-pr-review',
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
    const bare = [{
      type: 'bind' as const,
      source: f.project,
      destination: '/workspaces/proj',
      rw: true,
    }];
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
        'granted for feat/x. Run `devc up --bridge-allow gh-push,gh-pr-review` to grant it.',
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
      'Re-run `devc up --bridge-allow gh-push,gh-pr-review` once that is fixed.',
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
        'Re-run `devc up --bridge-allow gh-push,gh-pr-review` once that is fixed.',
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

Deno.test('a new grant replaces the earlier set rather than merging', async () => {
  await withFixture(async (f) => {
    const merged = await f.merged();
    const deps = f.deps(f.frozen);
    await applyPolicy(
      { grant: ['gh-push', 'gh-pr-review', 'gh-pr-resolve'] },
      merged,
      f.project,
      deps,
    );
    await applyPolicy({ grant: ['gh-push'] }, merged, f.project, deps);
    const policy = await readPolicy(merged.bridgeKey!, deps);
    assertEquals(policy.kind === 'present' && policy.record.grants, [
      'gh-push',
    ]);
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
      `  bridge:    gh-push, gh-pr-review\n` +
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
        grants: ['gh-push', 'gh-pr-review'],
        repos: [{
          repo: wt,
          remote: 'git@github.com:acme/proj.git',
          branch: 'feat/wt',
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
  grant: ['gh-push', 'gh-pr-review'],
  repos: ['~/extra'],
};

Deno.test('--bridge-repo pins an extra protected repo as line 2, and logs one line per repo', async () => {
  await withFixture(async (f) => {
    const { extra, merged, frozen } = await withExtra(f);
    await checkGrantBeforeUp(merged, f.project, f.deps(null), ['~/extra']);
    await applyPolicy(EXTRA_GRANT, merged, f.project, f.deps(frozen));
    const grants = 'gh-push,gh-pr-review';
    assertEquals(
      await Deno.readTextFile(
        bridgePaths(f.home, merged.bridgeKey!).policyFile,
      ),
      `${f.project}\tgit@github.com:acme/proj.git\tfeat/x\t${grants}\t/workspaces/proj\n` +
        `${extra}\tgit@github.com:acme/extra.git\tfeat/extra\t${grants}\t/workspaces/extra\n`,
    );
    assertEquals(f.logs, [
      'devc: devc-bridge capabilities granted: gh-push, gh-pr-review',
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
        await applyPolicy(
          { grant: bridgeAllow!, repos: bridgeRepos },
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
    // A linked worktree and a plain folder, both mounted as extra folders, and a repo not mounted.
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
        `--bridge-repo ${f.project}: this is the workspace repo, which is always pinned`,
      ],
      [`${f.dir}/nope`, `--bridge-repo ${f.dir}/nope: no such directory`],
      [loose, `--bridge-repo ${loose}: ${pinnable}`],
      [
        wt,
        `--bridge-repo ${wt}: a linked worktree mounted as an extra folder is not git-protected, so it cannot be pinned`,
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

Deno.test('an extra repo whose .git/config is writable in the container fails the whole grant', async () => {
  await withFixture(async (f) => {
    const { merged, frozen } = await withExtra(f);
    await applyPolicy(EXTRA_GRANT, merged, f.project, f.deps(frozen));
    const writable = frozen.map((m) =>
      m.destination === '/workspaces/extra/.git/config' ? { ...m, rw: true } : m
    );
    const err = await assertRejects(
      () => applyPolicy(EXTRA_GRANT, merged, f.project, f.deps(writable)),
      BridgeGrantError,
    );
    assertStringIncludes(
      err.message,
      'the container is up, but --bridge-allow was not granted: ~/extra: git protection is not ' +
        'in force in this container for /workspaces/extra (/workspaces/extra/.git/config is ' +
        'mounted read-write)',
    );
    assertEquals(
      await readPolicy(merged.bridgeKey!, f.deps(null)),
      { kind: 'absent' },
    );
  });
});

Deno.test('checkGrantBeforeUp checks an extra repo before up, naming it', async () => {
  await withFixture(async (f) => {
    const { extra, merged } = await withExtra(f);
    await Deno.writeTextFile(`${extra}/.git/HEAD`, `${SHA1}\n`);
    await assertRejects(
      () => checkGrantBeforeUp(merged, f.project, f.deps(null), ['~/extra']),
      BridgeGrantError,
      `--bridge-allow: ~/extra: HEAD is detached in ${extra}`,
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
        `${prefix}${f.project} and ~/extra both push to github.com/acme/x`,
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
        'they were granted for feat/extra. Run `devc up --bridge-allow gh-push,gh-pr-review ' +
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
      'Re-run `devc up --bridge-allow gh-push,gh-pr-review --bridge-repo …` once that is fixed.',
    );
  });
});

Deno.test('status prints one indented line per pinned repo', async () => {
  await withFixture(async (f) => {
    const { extra, merged, frozen } = await withExtra(f);
    await applyPolicy(EXTRA_GRANT, merged, f.project, f.deps(frozen));
    const lines = await bridgeStatusLines(merged, f.project, f.deps(null));
    const at = lines.indexOf('  bridge:    gh-push, gh-pr-review');
    assert(at >= 0, lines.join('\n'));
    assertEquals(lines.slice(at + 1), [
      `    /workspaces/proj: feat/x → git@github.com:acme/proj.git (${f.project})`,
      `    /workspaces/extra: feat/extra → git@github.com:acme/extra.git (${extra})`,
    ]);
  });
});
