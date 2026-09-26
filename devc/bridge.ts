// devc-bridge per-container identity, side-effect half: create each workspace's key directory,
// write, refresh and remove its policy, and clean both up on teardown and prune.
//
// **devc gains no dependency on devc-bridge.** Everything here is a file under
// `~/.config/devc-bridge/` — a path devc already names in its bridge mount — and nothing here
// invokes the bridge. The bridge mints a token into every key directory it finds; devc never
// writes a token, so there is nothing for the bridge to adopt.
//
// **The policy is the whole grant.** `policy/<key>.conf` names the one repo, remote and branch a
// container's capabilities act on, and which capabilities it has (`git-push`, `pr-review`,
// `pr-resolve`). Only `devc up` / `devc build` create it (with `--bridge-allow <list>`) or delete
// it (without). Every other start path only *refreshes* one that exists — and revokes it
// when the pin can no longer be derived safely, since a policy that outlives its preconditions
// is a grant nobody asked for.
//
// **Trust comes from the container, not the config.** The remote URL is read out of the repo's
// `.git/config`, which is only trustworthy while that file is frozen in the container. The
// `gitProtect` key cannot prove that — it lives in an agent-writable layer, and `devc up` reuses
// an existing container whose mounts were fixed when it was created — so every write checks the
// container's live mount table instead.

import {
  type BridgeCapability,
  bridgePaths,
  parsePolicy,
  type Pin,
  type PolicyRecord,
  resolvePin,
  serializePolicy,
} from '@devc-tools/core/bridge.ts';
import {
  type ContainerMount,
  getContainerMounts,
  listContainerFolders,
} from '@devc-tools/core/container.ts';
import {
  type MergedConfig,
  projectKey,
} from '@devc-tools/core/merged_config.ts';
import {
  gitProtectState,
  type ProtectedRow,
  workspaceMountRow,
  worktreeCommonDirRow,
} from '@devc-tools/core/overlay.ts';

/** Where the bridge mount lands in every container. */
const BRIDGE_TARGET = '/run/devc-bridge';

/**
 * What a start path does with the policy. See the module header. A grant carries its capabilities
 * (canonical order, validated by `parseBridgeAllow`) and replaces any earlier set.
 */
export type PolicyMode = 'revoke' | 'refresh' | { grant: BridgeCapability[] };

/** Injected so the tests can run against a temp home and a fake mount table. */
export interface BridgeDeps {
  home: string;
  /** The container's live mount table, or null when no container matches. */
  mounts: (localFolder: string) => Promise<ContainerMount[] | null>;
  /** Where notices go — stderr, so `--json` stdout stays clean. */
  log: (message: string) => void;
}

export function defaultDeps(): BridgeDeps {
  return {
    home: Deno.env.get('HOME') ?? '.',
    mounts: getContainerMounts,
    log: (m) => console.error(m),
  };
}

/** An explicit `--bridge-allow` whose preconditions do not hold. */
export class BridgeGrantError extends Error {}

async function removeIfPresent(
  path: string,
  recursive = false,
): Promise<boolean> {
  try {
    await Deno.remove(path, { recursive });
    return true;
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return false;
    throw e;
  }
}

/**
 * Create `keys/<key>/` for a workspace whose merged config mounts it. A bind mount with a missing
 * source is a hard error, so this must run before `devcontainer up`. No secret is written — the
 * bridge mints the token — and nothing is created for a workspace without the bridge Feature.
 */
export async function ensureKeyDir(
  merged: MergedConfig,
  deps: BridgeDeps = defaultDeps(),
): Promise<void> {
  if (merged.bridgeKey === null) return;
  const paths = bridgePaths(deps.home, merged.bridgeKey);
  await Deno.mkdir(paths.keysDir, { recursive: true, mode: 0o755 });
  await Deno.mkdir(paths.keyDir, { recursive: true, mode: 0o755 });
}

/** The pin for this workspace, or the first precondition that failed. */
export type DerivedPin =
  | { ok: true; record: Pin }
  | { ok: false; reason: string };

/**
 * Derive the publish pin for `localFolder`, checking every precondition in order:
 *
 * 1. the merged Features declare devc-bridge;
 * 2. `gitProtect` is not off (named separately only because it is the clearest message — the
 *    mount check in 5 would catch it anyway);
 * 3. the workspace is a bind-mounted repo devc can find;
 * 4. its `HEAD` names a branch and its config has exactly one `remote.origin.url`;
 * 5. the container's live mount table has that repo's git dir `config` and `hooks` read-only —
 *    the repo's own `.git`, or for a linked worktree the primary's git dir as the devcontainer
 *    CLI mounts it — and has this workspace's own `keys/<key>/` at `/run/devc-bridge` (a container
 *    still on a
 *    hand-written `run/` mount authenticates with the shared token, which no pin applies to.
 *    `null` (no container) fails it. `'skip'` skips it — only for the pre-`up` check, where no
 *    container exists yet to ask.
 */
export async function derivePin(
  merged: MergedConfig,
  localFolder: string,
  mounts: ContainerMount[] | null | 'skip',
  home: string = defaultDeps().home,
): Promise<DerivedPin> {
  if (merged.bridgeKey === null) {
    return { ok: false, reason: 'no devc-bridge Feature is declared' };
  }
  if (merged.gitProtect === false) {
    return {
      ok: false,
      reason:
        'gitProtect is off, so the repo config the pin is read from is not frozen',
    };
  }
  const row = await workspaceMountRow(merged.config, localFolder);
  if (row === null) {
    return {
      ok: false,
      reason: 'no bind-mounted workspace repo (Docker Compose, a read-only ' +
        'workspaceMount, or no .git above the project folder)',
    };
  }
  const pin = await resolvePin(row.source);
  if (!pin.ok) return { ok: false, reason: pin.reason };
  if (mounts === 'skip') return { ok: true, record: pin.record };
  if (mounts === null) {
    return {
      ok: false,
      reason: 'no container to verify git protection against',
    };
  }

  // The git dir whose config the pin trusts: the repo's own `.git`, or — for a linked worktree —
  // the primary's, at the target the devcontainer CLI mounts it on.
  let protectedRow: ProtectedRow;
  if (pin.worktree) {
    const common = await worktreeCommonDirRow(merged.config, localFolder);
    if (common === null) {
      return {
        ok: false,
        reason:
          `${localFolder} is a linked worktree whose primary git dir the devcontainer CLI ` +
          `does not mount (an absolute gitdir:, or both workspaceFolder and workspaceMount set)`,
      };
    }
    protectedRow = { ...common, kind: 'gitdir' };
  } else {
    protectedRow = { ...row, kind: 'repo' };
  }
  const state = gitProtectState(protectedRow, mounts);
  if (state.state !== 'protected') {
    return {
      ok: false,
      reason:
        `git protection is not in force in this container for ${protectedRow.target} ` +
        `(${state.problems.join('; ')}) — recreate it with \`devc build\``,
    };
  }

  // Read the remote from the file that is actually frozen — the host source of the container's
  // read-only `config` mount — not from a path derived through the writable `commondir` pointer.
  const gitDir = protectedRow.kind === 'gitdir'
    ? protectedRow.target
    : `${protectedRow.target}/.git`;
  const configMount = mounts.find((m) =>
    m.destination.replace(/\/+$/, '') === `${gitDir}/config`
  )!;
  const frozen = await resolvePin(row.source, {
    configPath: configMount.source,
  });
  if (!frozen.ok) return { ok: false, reason: frozen.reason };

  const keyDir = bridgePaths(home, merged.bridgeKey).keyDir;
  const tokenMount = mounts.find((m) =>
    m.destination.replace(/\/+$/, '') === BRIDGE_TARGET
  );
  if (tokenMount === undefined || tokenMount.source !== keyDir) {
    return {
      ok: false,
      reason: tokenMount === undefined
        ? `this container has nothing mounted at ${BRIDGE_TARGET}`
        : `this container mounts ${tokenMount.source} at ${BRIDGE_TARGET}, not its own ` +
          `${keyDir} — remove any hand-written devc-bridge mount and recreate it with \`devc build\``,
    };
  }
  return { ok: true, record: frozen.record };
}

/** The current policy for `key`: absent, unreadable as a pin, or the pin it holds. */
export type PolicyState =
  | { kind: 'absent' }
  | { kind: 'malformed' }
  | { kind: 'present'; record: PolicyRecord };

export async function readPolicy(
  key: string,
  deps: Pick<BridgeDeps, 'home'> = defaultDeps(),
): Promise<PolicyState> {
  let text: string;
  try {
    text = await Deno.readTextFile(bridgePaths(deps.home, key).policyFile);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return { kind: 'absent' };
    throw e;
  }
  const record = parsePolicy(text);
  return record === null ? { kind: 'malformed' } : { kind: 'present', record };
}

/** Write `policy/<key>.conf` atomically (same-directory temp + rename), mode 0600. */
async function writePolicy(
  key: string,
  record: PolicyRecord,
  deps: Pick<BridgeDeps, 'home'>,
): Promise<void> {
  const { policyDir, policyFile } = bridgePaths(deps.home, key);
  await Deno.mkdir(policyDir, { recursive: true, mode: 0o700 });
  const tmp = `${policyDir}/.${key}.conf.tmp-${crypto.randomUUID()}`;
  try {
    await Deno.writeTextFile(tmp, serializePolicy(record), { mode: 0o600 });
    await Deno.rename(tmp, policyFile);
  } catch (e) {
    await removeIfPresent(tmp).catch(() => {});
    throw e;
  }
}

/** Unlink this one key's policy — never a sweep of `policy/`. True when one was removed. */
export async function removePolicy(
  key: string,
  deps: Pick<BridgeDeps, 'home'> = defaultDeps(),
): Promise<boolean> {
  return await removeIfPresent(bridgePaths(deps.home, key).policyFile);
}

function describe(record: PolicyRecord): string {
  return `${
    record.grants.join(', ')
  } for ${record.branch} → ${record.remote} (${record.repo})`;
}

/**
 * Before `devcontainer up`, for an explicit `--bridge-allow`: fail fast on every precondition
 * that does not need a container, so the user is not handed a running container they believe can
 * publish. Removes any existing policy on failure — an explicit request that cannot be met must
 * not leave an older grant standing.
 */
export async function checkGrantBeforeUp(
  merged: MergedConfig,
  localFolder: string,
  deps: BridgeDeps = defaultDeps(),
): Promise<void> {
  const pin = await derivePin(merged, localFolder, 'skip', deps.home);
  if (pin.ok) return;
  await removePolicy(await projectKey(localFolder), deps);
  throw new BridgeGrantError(`--bridge-allow: ${pin.reason}`);
}

/**
 * After `devcontainer up`: apply `mode` to this workspace's policy.
 *
 * - `revoke` — unlink it. What `up`/`build` do without the flag.
 * - `{ grant }` — derive the pin against the live mount table and write it with exactly these
 *   capabilities, or remove any policy and throw {@link BridgeGrantError} naming the failed
 *   precondition.
 * - `refresh` — only when a policy exists: rewrite its pin from the current `HEAD`, keeping its
 *   capabilities, or, when the pin can no longer be derived (or the file is malformed), remove it
 *   and say so. Never creates one.
 */
export async function applyPolicy(
  mode: PolicyMode,
  merged: MergedConfig,
  localFolder: string,
  deps: BridgeDeps = defaultDeps(),
): Promise<void> {
  const key = await projectKey(localFolder);

  if (mode === 'revoke') {
    if (await removePolicy(key, deps)) {
      deps.log(
        'devc: devc-bridge capabilities revoked for this workspace (pass --bridge-allow to keep them)',
      );
    }
    return;
  }

  const current = await readPolicy(key, deps);
  let grants: BridgeCapability[];
  if (mode === 'refresh') {
    if (current.kind === 'absent') return;
    if (current.kind === 'malformed') {
      await removePolicy(key, deps);
      deps.log(
        `devc: devc-bridge policy at ${
          bridgePaths(deps.home, key).policyFile
        } was malformed and has been removed — re-run devc up --bridge-allow <list>`,
      );
      return;
    }
    grants = current.record.grants;
  } else {
    grants = mode.grant;
  }

  const pin = await derivePin(
    merged,
    localFolder,
    await deps.mounts(localFolder),
    deps.home,
  );
  if (!pin.ok) {
    await removePolicy(key, deps);
    if (mode !== 'refresh') {
      throw new BridgeGrantError(
        `the container is up, but --bridge-allow was not granted: ${pin.reason}`,
      );
    }
    deps.log(
      `devc: devc-bridge capabilities revoked — ${pin.reason}. ` +
        `Re-run \`devc up --bridge-allow ${
          grants.join(',')
        }\` once that is fixed.`,
    );
    return;
  }

  const record: PolicyRecord = { ...pin.record, grants };
  const unchanged = current.kind === 'present' &&
    serializePolicy(current.record) === serializePolicy(record);
  if (!unchanged) await writePolicy(key, record, deps);
  if (mode !== 'refresh') {
    deps.log(`devc: devc-bridge capabilities granted: ${describe(record)}`);
  } else if (!unchanged) {
    deps.log(`devc: devc-bridge pin refreshed: ${describe(record)}`);
  }
}

/** On `devc down`: remove this workspace's key directory and policy. Returns the paths removed. */
export async function removeBridgeFiles(
  localFolder: string,
  deps: Pick<BridgeDeps, 'home'> = defaultDeps(),
): Promise<string[]> {
  const paths = bridgePaths(deps.home, await projectKey(localFolder));
  const removed: string[] = [];
  if (await removeIfPresent(paths.keyDir, true)) removed.push(paths.keyDir);
  if (await removeIfPresent(paths.policyFile)) removed.push(paths.policyFile);
  return removed;
}

/**
 * Every key directory and policy no container maps to — running or stopped. Throws, removing
 * nothing, when the container list cannot be read: "docker is down" is not "no containers".
 */
export async function staleBridgeFiles(
  deps: Pick<BridgeDeps, 'home'> & {
    folders?: () => Promise<string[]>;
  } = defaultDeps(),
): Promise<string[]> {
  const folders = await (deps.folders ?? listContainerFolders)();
  const live = new Set(await Promise.all(folders.map((f) => projectKey(f))));
  const { keysDir, policyDir } = bridgePaths(deps.home, 'x');
  const stale: string[] = [];

  for (
    const [dir, keyOf] of [
      [keysDir, (e: Deno.DirEntry) => e.isDirectory ? e.name : null],
      [
        policyDir,
        (e: Deno.DirEntry) =>
          e.isFile && e.name.endsWith('.conf') ? e.name.slice(0, -5) : null,
      ],
    ] as const
  ) {
    let entries: Deno.DirEntry[];
    try {
      entries = await Array.fromAsync(Deno.readDir(dir));
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) continue;
      throw e;
    }
    for (const entry of entries) {
      const key = keyOf(entry);
      if (key !== null && !live.has(key)) stale.push(`${dir}/${entry.name}`);
    }
  }
  return stale.sort();
}

/** `devc prune`: remove what {@link staleBridgeFiles} found, unless `dryRun`. */
export async function pruneBridgeFiles(
  dryRun: boolean,
  deps: Pick<BridgeDeps, 'home'> & {
    folders?: () => Promise<string[]>;
  } = defaultDeps(),
): Promise<string[]> {
  const stale = await staleBridgeFiles(deps);
  if (!dryRun) {
    for (const path of stale) await removeIfPresent(path, true);
  }
  return stale;
}

/** The devc-bridge lines of `devc status`. Absent prints as absent, never as a blank. */
export async function bridgeStatusLines(
  merged: MergedConfig | null,
  localFolder: string,
  deps: Pick<BridgeDeps, 'home'> = defaultDeps(),
): Promise<string[]> {
  const key = merged?.bridgeKey ?? await projectKey(localFolder);
  const paths = bridgePaths(deps.home, key);
  const lines: string[] = [];
  lines.push(
    merged === null
      ? `devc-bridge: key ${key} (config could not be merged)`
      : merged.bridgeKey === null
      ? `devc-bridge: not enabled (no devc-bridge Feature declared) — key ${key}`
      : `devc-bridge: key ${key}`,
  );

  const exists = async (p: string) => {
    try {
      await Deno.stat(p);
      return true;
    } catch {
      return false;
    }
  };
  lines.push(
    `  token dir: ${
      await exists(paths.keyDir) ? 'present' : 'absent'
    } (${paths.keyDir})`,
  );
  lines.push(
    `  token:     ${
      await exists(paths.tokenFile)
        ? 'present'
        : 'absent — devc-bridge mints it while running'
    }`,
  );

  const policy = await readPolicy(key, deps);
  lines.push(
    policy.kind === 'absent'
      ? '  bridge:    absent — `devc up --bridge-allow <capabilities>` grants them'
      : policy.kind === 'malformed'
      ? `  bridge:    MALFORMED policy at ${paths.policyFile} — grants nothing`
      : `  bridge:    ${describe(policy.record)}`,
  );
  return lines;
}
