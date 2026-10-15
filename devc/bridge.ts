// devc-bridge per-container identity, side-effect half: create each workspace's key directory,
// write, re-check and remove its policy, and clean both up on teardown and prune.
//
// **devc gains no dependency on devc-bridge.** Everything here is a file under
// `~/.config/devc-bridge/` — a path devc already names in its bridge mount — and nothing here
// invokes the bridge. The bridge mints a token into every key directory it finds; devc never
// writes a token, so there is nothing for the bridge to adopt.
//
// **The policy is the whole grant.** `policy/<key>.conf` names the repos a container's
// capabilities act on — each one's host path, remote, branch and container path, one line each —
// and which capabilities it has (`gh-push`, `gh-pr-review`, `gh-pr-resolve`,
// `gh-pr-request-review`), always as the explicit list — `--bridge-allow gh` is expanded before it
// gets here. The workspace repo is always line 1; an extra repo is pinned only when the user names
// it with `--bridge-repo PATH` on the same command — devc never pins a mounted repo it was not
// told to. Only `devc up` / `devc build` create it (with `--bridge-allow <list>`) or delete it
// (without), and only on GitHub remotes. Every other start path only *refreshes* one that exists:
// it re-derives every line and revokes the whole policy when any of them fails or no longer
// matches, since a policy that outlives its preconditions is a grant nobody asked for. Refresh
// never writes the policy — `HEAD` is agent-writable, so a pin that followed it would let the agent
// choose its own branch at the user's next `attach`.
//
// **Trust comes from the container, not the config.** The remote URL is read out of the repo's
// `.git/config`, which is only trustworthy while that file is frozen in the container. The
// `gitProtect` key cannot prove that — it lives in an agent-writable layer, and `devc up` reuses
// an existing container whose mounts were fixed when it was created — so every write checks the
// container's live mount table instead.

import {
  type BridgeCapability,
  bridgePaths,
  gitHubRepoOf,
  isGitHubRemote,
  parsePolicy,
  type PinnedRepo,
  policyProblem,
  type PolicyRecord,
  resolvePin,
  serializePolicy,
  targetProblem,
} from '@devc-tools/core/bridge.ts';
import {
  type ContainerMount,
  getContainerMounts,
  listContainerFolders,
} from '@devc-tools/core/container.ts';
import {
  BRIDGE_CLIENT_MOUNTED,
  type MergedConfig,
  projectKey,
} from '@devc-tools/core/merged_config.ts';
import { unfoldHome } from '@devc-tools/core/mounts.ts';
import {
  BRIDGE_CLIENT_TARGET,
  gitProtectState,
  type ProtectedRow,
  workspaceMountRow,
  worktreeCommonDirRow,
} from '@devc-tools/core/overlay.ts';
import { BRIDGE_REPO_FLAG, expandBridgeRepo } from './args.ts';

/** Where the bridge mount lands in every container. */
const BRIDGE_TARGET = '/run/devc-bridge';

/**
 * What a start path does with the policy. See the module header. A grant carries its capabilities
 * (canonical order, validated by `parseBridgeAllow`) and the `--bridge-repo` paths as typed, and
 * replaces any earlier policy whole.
 */
export type PolicyMode = 'revoke' | 'refresh' | {
  grant: BridgeCapability[];
  repos?: string[];
};

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

/** Why a pin on `remote` is refused: every `gh-*` capability needs a github.com remote. */
function notGitHubReason(remote: string): string {
  return `origin ${remote} is not a github.com remote`;
}

/** A repo's pin and container path, or the first precondition that failed. */
export type DerivedPin =
  | { ok: true; record: PinnedRepo }
  | { ok: false; reason: string };

/** A mount target with trailing slashes dropped, as the mount table and the policy spell it. */
function normalizeTarget(target: string): string {
  return target.replace(/\/+$/, '');
}

/**
 * Derive the publish pin for `localFolder`, checking every precondition in order:
 *
 * 1. the merged Features declare devc-bridge;
 * 2. `gitProtect` is not off (named separately only because it is the clearest message — the
 *    mount check in 5 would catch it anyway);
 * 3. the workspace is a bind-mounted repo devc can find;
 * 4. its `HEAD` names a branch and its config has exactly one `remote.origin.url`, and that URL
 *    is a GitHub remote — every capability acts through the host's `gh` login, so push is
 *    GitHub-only (`gh-push` re-checks for itself, since a policy file can be edited by hand);
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
  // The line's `target`: what the bridge commands' `--repo` selects by.
  const target = normalizeTarget(row.target);
  const badTarget = targetProblem(target);
  if (badTarget !== null) {
    return {
      ok: false,
      reason:
        `the workspace mount target ${row.target} cannot be pinned (${badTarget})`,
    };
  }
  const pin = await resolvePin(row.source);
  if (!pin.ok) return { ok: false, reason: pin.reason };
  if (!isGitHubRemote(pin.record.remote)) {
    return { ok: false, reason: notGitHubReason(pin.record.remote) };
  }
  if (mounts === 'skip') return { ok: true, record: { ...pin.record, target } };
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
  if (!isGitHubRemote(frozen.record.remote)) {
    return { ok: false, reason: notGitHubReason(frozen.record.remote) };
  }

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
  return { ok: true, record: { ...frozen.record, target } };
}

/**
 * Derive the pin for one extra `--bridge-repo` row — a `repo` row of `merged.protectedRows`,
 * whose working tree is `repo` on the host (already resolved through symlinks). The same per-repo
 * checks as {@link derivePin}'s 4 and 5: `HEAD` names a branch, exactly one GitHub
 * `remote.origin.url`, and the row's `.git/config` and `.git/hooks` read-only in the live
 * container, with the remote read from the host source of that frozen `config` mount. The
 * container-wide checks are {@link derivePin}'s, made once for the workspace.
 */
async function deriveExtraPin(
  row: ProtectedRow,
  repo: string,
  mounts: ContainerMount[] | null | 'skip',
): Promise<DerivedPin> {
  const target = normalizeTarget(row.target);
  const badTarget = targetProblem(target);
  if (badTarget !== null) {
    return {
      ok: false,
      reason: `its mount target ${row.target} cannot be pinned (${badTarget})`,
    };
  }
  const pin = await resolvePin(repo);
  if (!pin.ok) return { ok: false, reason: pin.reason };
  if (!isGitHubRemote(pin.record.remote)) {
    return { ok: false, reason: notGitHubReason(pin.record.remote) };
  }
  if (mounts === 'skip') return { ok: true, record: { ...pin.record, target } };
  if (mounts === null) {
    return {
      ok: false,
      reason: 'no container to verify git protection against',
    };
  }
  const state = gitProtectState(row, mounts);
  if (state.state !== 'protected') {
    return {
      ok: false,
      reason:
        `git protection is not in force in this container for ${target} ` +
        `(${state.problems.join('; ')}) — recreate it with \`devc build\``,
    };
  }
  const configMount = mounts.find((m) =>
    normalizeTarget(m.destination) === `${target}/.git/config`
  )!;
  const frozen = await resolvePin(repo, { configPath: configMount.source });
  if (!frozen.ok) return { ok: false, reason: frozen.reason };
  if (!isGitHubRemote(frozen.record.remote)) {
    return { ok: false, reason: notGitHubReason(frozen.record.remote) };
  }
  return { ok: true, record: { ...frozen.record, target } };
}

/** `path` with a leading `home` shown as `~`, the way the user wrote it in `devc:source`. */
function tildePath(path: string, home: string): string {
  return path === home
    ? '~'
    : path.startsWith(`${home}/`)
    ? `~${path.slice(home.length)}`
    : path;
}

async function realPathOrNull(path: string): Promise<string | null> {
  try {
    return await Deno.realPath(path);
  } catch {
    return null;
  }
}

/** One `repo` row an extra pin may name, with its host working tree resolved through symlinks. */
interface EligibleRow {
  row: ProtectedRow;
  repo: string;
}

/**
 * The rows `--bridge-repo` may name: every git-protected `repo` row of the merged config except
 * the workspace's own (at its own target or mounted again elsewhere). A linked worktree is never one (its `.git` is a file, so git protection
 * does not classify it as a repo), and nor is a row whose source does not exist.
 */
async function eligibleRows(
  merged: MergedConfig,
  localFolder: string,
  home: string,
): Promise<EligibleRow[]> {
  const workspace = await workspaceMountRow(merged.config, localFolder);
  const workspaceTarget = workspace === null
    ? null
    : normalizeTarget(workspace.target);
  const workspaceRepo = workspace === null
    ? null
    : await realPathOrNull(unfoldHome(workspace.source, home));
  const rows: EligibleRow[] = [];
  for (const row of merged.protectedRows) {
    if (row.kind !== 'repo') continue;
    if (normalizeTarget(row.target) === workspaceTarget) continue;
    const repo = await realPathOrNull(unfoldHome(row.source, home));
    // The workspace repo mounted a second time is still the workspace repo: line 1 pins it.
    if (repo !== null && repo !== workspaceRepo) rows.push({ row, repo });
  }
  return rows;
}

/**
 * The row `--bridge-repo <arg>` names, or throws {@link BridgeGrantError} saying why it names
 * none: no such directory, the workspace repo itself, a linked worktree, or anything else that is
 * not a git-protected repo mount here (listing the ones that are).
 */
async function matchBridgeRepo(
  arg: string,
  rows: EligibleRow[],
  merged: MergedConfig,
  localFolder: string,
  home: string,
): Promise<EligibleRow> {
  const real = await realPathOrNull(
    expandBridgeRepo(arg, home, Deno.cwd()),
  );
  const refuse = (why: string) =>
    new BridgeGrantError(`${BRIDGE_REPO_FLAG} ${arg}: ${why}`);
  if (real === null) throw refuse('no such directory');
  const match = rows.find((r) => r.repo === real);
  if (match !== undefined) return match;

  const workspace = await workspaceMountRow(merged.config, localFolder);
  if (
    workspace !== null &&
    await realPathOrNull(unfoldHome(workspace.source, home)) === real
  ) {
    throw refuse('this is the workspace repo, which is always pinned');
  }
  let dotGitIsFile = false;
  try {
    dotGitIsFile = (await Deno.stat(`${real}/.git`)).isFile;
  } catch { /* no .git at all */ }
  if (dotGitIsFile) {
    throw refuse(
      'a linked worktree mounted as an extra folder is not git-protected, so it cannot be pinned',
    );
  }
  throw refuse(
    rows.length === 0
      ? 'not a git-protected repo mount in this workspace — no extra repo mounts are git-protected'
      : `not a git-protected repo mount in this workspace — pinnable: ${
        rows.map((r) => tildePath(unfoldHome(r.row.source, home), home))
          .join(', ')
      }`,
  );
}

/**
 * Every pin a grant writes, workspace first, then each `--bridge-repo` in order — or the reason
 * the grant fails, already worded for the user. `mounts` is the live table, or `'skip'` before
 * `up`. Eligibility failures throw {@link BridgeGrantError} directly, worded on their own; a
 * repo's failed precondition comes back as `<PATH>: <reason>`, `PATH` as the user typed it.
 */
async function derivePins(
  merged: MergedConfig,
  localFolder: string,
  repos: readonly string[],
  mounts: ContainerMount[] | null | 'skip',
  home: string,
): Promise<{ ok: true; pins: PinnedRepo[] } | { ok: false; reason: string }> {
  const workspace = await derivePin(merged, localFolder, mounts, home);
  if (!workspace.ok) return workspace;
  const pins = [workspace.record];
  const labels = [workspace.record.repo];
  const rows = repos.length === 0
    ? []
    : await eligibleRows(merged, localFolder, home);
  const used = new Set<EligibleRow>();
  for (const arg of repos) {
    const match = await matchBridgeRepo(arg, rows, merged, localFolder, home);
    if (used.has(match)) {
      throw new BridgeGrantError(
        `${BRIDGE_REPO_FLAG} ${arg} given more than once`,
      );
    }
    used.add(match);
    const pin = await deriveExtraPin(match.row, match.repo, mounts);
    if (!pin.ok) return { ok: false, reason: `${arg}: ${pin.reason}` };
    pins.push(pin.record);
    labels.push(arg);
  }
  // Two lines on one GitHub repo would make gh-push's per-remote mirror ambiguous. Only a repo and
  // its own checkout or worktree can do this, so it is refused rather than reconciled.
  for (let i = 0; i < pins.length; i++) {
    for (let j = 0; j < i; j++) {
      const a = gitHubRepoOf(pins[j].remote)!;
      if (a.toLowerCase() === gitHubRepoOf(pins[i].remote)!.toLowerCase()) {
        return {
          ok: false,
          reason: `${labels[j]} and ${labels[i]} both push to github.com/${a}`,
        };
      }
    }
  }
  return { ok: true, pins };
}

/**
 * The first pin field that differs, in the order repo, remote, branch, target, as the words of
 * the refresh revoke message — or null when the pins are identical.
 */
function pinDrift(
  stored: PinnedRepo,
  derived: PinnedRepo,
): { what: string; now: string; was: string } | null {
  if (stored.repo !== derived.repo) {
    return { what: 'workspace repo', now: derived.repo, was: stored.repo };
  }
  if (stored.remote !== derived.remote) {
    return { what: 'origin', now: derived.remote, was: stored.remote };
  }
  if (stored.branch !== derived.branch) {
    return { what: 'branch', now: derived.branch, was: stored.branch };
  }
  if (stored.target !== derived.target) {
    return { what: 'container path', now: derived.target, was: stored.target };
  }
  return null;
}

/** The current policy for `key`: absent, unreadable as a pin, or the pin it holds. */
export type PolicyState =
  | { kind: 'absent' }
  | { kind: 'malformed'; reason: string }
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
  const reason = policyProblem(text);
  if (reason !== null) return { kind: 'malformed', reason };
  return { kind: 'present', record: parsePolicy(text)! };
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

/** One pinned repo as the grant log and `devc status` print it. */
function describeRepo(r: PinnedRepo): string {
  return `${r.target}: ${r.branch} → ${r.remote} (${r.repo})`;
}

/**
 * Before `devcontainer up`, for an explicit `--bridge-allow`: fail fast on every precondition
 * that does not need a container — for the workspace repo and each `--bridge-repo` in `repos` — so
 * the user is not handed a running container they believe can publish. Removes any existing
 * policy on failure — an explicit request that cannot be met must not leave an older grant
 * standing.
 */
export async function checkGrantBeforeUp(
  merged: MergedConfig,
  localFolder: string,
  deps: BridgeDeps = defaultDeps(),
  repos: readonly string[] = [],
): Promise<void> {
  const key = await projectKey(localFolder);
  let pins;
  try {
    pins = await derivePins(merged, localFolder, repos, 'skip', deps.home);
  } catch (e) {
    await removePolicy(key, deps);
    throw e;
  }
  if (pins.ok) return;
  await removePolicy(key, deps);
  throw new BridgeGrantError(`--bridge-allow: ${pins.reason}`);
}

/**
 * After `devcontainer up`: apply `mode` to this workspace's policy.
 *
 * - `revoke` — unlink it. What `up`/`build` do without the flag.
 * - `{ grant }` — derive the workspace pin and one per `--bridge-repo` against the live mount
 *   table and write them with exactly these capabilities, or remove any policy and throw
 *   {@link BridgeGrantError} naming the failed precondition (and, for an extra repo, the repo).
 *   All or nothing: one repo that fails fails the grant.
 * - `refresh` — only when a policy exists: re-derive every line and compare it with the stored
 *   one. All identical → nothing is written or logged. Any line can no longer be derived, differs
 *   in repo, origin, branch or container path, or the file is malformed → remove the whole policy
 *   and say so. Never creates or rewrites one: `HEAD` is agent-writable, so only an explicit
 *   `--bridge-allow` moves a pin.
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
  if (mode === 'refresh') {
    if (current.kind === 'absent') return;
    if (current.kind === 'malformed') {
      await removePolicy(key, deps);
      deps.log(
        `devc: devc-bridge policy at ${
          bridgePaths(deps.home, key).policyFile
        } was malformed (${current.reason}) and has been removed — re-run devc up --bridge-allow <list>`,
      );
      return;
    }
    await refreshPolicy(key, current.record, merged, localFolder, deps);
    return;
  }

  const grants = mode.grant;
  let pins;
  try {
    pins = await derivePins(
      merged,
      localFolder,
      mode.repos ?? [],
      await deps.mounts(localFolder),
      deps.home,
    );
  } catch (e) {
    await removePolicy(key, deps);
    throw e;
  }
  if (!pins.ok) {
    await removePolicy(key, deps);
    throw new BridgeGrantError(
      `the container is up, but --bridge-allow was not granted: ${pins.reason}`,
    );
  }

  const record: PolicyRecord = { grants, repos: pins.pins };
  const unchanged = current.kind === 'present' &&
    serializePolicy(current.record) === serializePolicy(record);
  if (!unchanged) await writePolicy(key, record, deps);
  deps.log(`devc: devc-bridge capabilities granted: ${grants.join(', ')}`);
  for (const r of record.repos) deps.log(`devc:   ${describeRepo(r)}`);
}

/**
 * {@link applyPolicy}'s refresh of a present policy: the stored pins stand only while every one
 * still matches what the container shows. Line 1 is re-derived as the workspace repo; each later
 * line by finding the protected row with its stored `repo` and `target`. The first line that
 * fails or drifted revokes the whole policy, named by its host path when more than one repo is
 * pinned.
 */
async function refreshPolicy(
  key: string,
  stored: PolicyRecord,
  merged: MergedConfig,
  localFolder: string,
  deps: BridgeDeps,
): Promise<void> {
  const multi = stored.repos.length > 1;
  const regrant = `devc up --bridge-allow ${stored.grants.join(',')}${
    multi ? ` ${BRIDGE_REPO_FLAG} …` : ''
  }`;
  const prefix = (line: PinnedRepo) => multi ? `${line.repo}: ` : '';
  const revoke = async (message: string) => {
    await removePolicy(key, deps);
    deps.log(`devc: devc-bridge capabilities revoked — ${message}`);
  };

  const mounts = await deps.mounts(localFolder);
  const rows = multi ? await eligibleRows(merged, localFolder, deps.home) : [];
  for (let i = 0; i < stored.repos.length; i++) {
    const line = stored.repos[i];
    let derived: DerivedPin;
    if (i === 0) {
      derived = await derivePin(merged, localFolder, mounts, deps.home);
    } else {
      const match = rows.find((r) =>
        r.repo === line.repo && normalizeTarget(r.row.target) === line.target
      );
      derived = match === undefined
        ? {
          ok: false,
          reason:
            `${line.repo} is no longer a git-protected repo mount at ${line.target}`,
        }
        : await deriveExtraPin(match.row, match.repo, mounts);
    }
    if (!derived.ok) {
      await revoke(
        `${
          prefix(line)
        }${derived.reason}. Re-run \`${regrant}\` once that is fixed.`,
      );
      return;
    }
    const drift = pinDrift(line, derived.record);
    if (drift !== null) {
      await revoke(
        `${
          prefix(line)
        }the ${drift.what} is now ${drift.now}, but they were granted for ` +
          `${drift.was}. Run \`${regrant}\` to grant it.`,
      );
      return;
    }
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

/**
 * The `client:` line of `devc status`: whether devc mounts the host's installed client over the
 * Feature's copy (`merged.bridgeClient`). Mounts are fixed when a container is created, so a
 * "mounted" decision is checked against the live mount table — an existing container created
 * before the host client was installed still runs the Feature's copy until it is recreated.
 */
async function clientStatusLine(
  bridgeClient: string | null,
  localFolder: string,
  deps: Pick<BridgeDeps, 'mounts'>,
): Promise<string> {
  if (bridgeClient !== BRIDGE_CLIENT_MOUNTED) {
    return `  client:    Feature's copy — ${bridgeClient}`;
  }
  const line =
    '  client:    host copy, mounted read-only (~/.config/devc-bridge/client)';
  // A mount table that cannot be read (docker down) is reported as no container: no suffix.
  const mounts = await deps.mounts(localFolder).catch(() => null);
  if (
    mounts !== null &&
    !mounts.some((m) =>
      m.destination.replace(/\/+$/, '') === BRIDGE_CLIENT_TARGET
    )
  ) {
    return `${line} — not in this container yet; run \`devc build\``;
  }
  return line;
}

/** The devc-bridge lines of `devc status`. Absent prints as absent, never as a blank. */
export async function bridgeStatusLines(
  merged: MergedConfig | null,
  localFolder: string,
  deps: Pick<BridgeDeps, 'home' | 'mounts'> = defaultDeps(),
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
  if (merged !== null && merged.bridgeKey !== null) {
    lines.push(
      await clientStatusLine(merged.bridgeClient, localFolder, deps),
    );
  }

  const policy = await readPolicy(key, deps);
  lines.push(
    policy.kind === 'absent'
      ? '  bridge:    absent — `devc up --bridge-allow <capabilities>` grants them'
      : policy.kind === 'malformed'
      ? `  bridge:    MALFORMED policy at ${paths.policyFile} (${policy.reason}) — grants nothing`
      : `  bridge:    ${policy.record.grants.join(', ')}`,
  );
  if (policy.kind === 'present') {
    for (const r of policy.record.repos) lines.push(`    ${describeRepo(r)}`);
  }
  return lines;
}
