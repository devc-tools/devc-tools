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
// and which capabilities each line has (`gh-push`, `gh-pr-read`, `gh-pr-reply`, `gh-pr-viewed`,
// `gh-pr-resolve`, `gh-pr-resolve-copilot`, `gh-pr-request-review`), always as the explicit list —
// `--bridge-allow gh` is expanded before it gets here. Only `devc up` / `devc build` create it, and
// only on GitHub remotes, in one of two ways:
//
// - **Flags.** `--bridge-allow <list>` tries the workspace repo, then each extra repo the user
//   names with `--bridge-repo PATH` on the same command, and pins each that passes its own checks
//   with exactly `<list>`, skipping the rest with a notice; it fails only when none pass. Neither
//   default key is read.
// - **Defaults** (no `--bridge-allow`). `bridgeDefaultAllow` and `bridgeRepoAllow` in
//   `~/.config/devc/config.jsonc` (or `config.json`) decide: the workspace repo and each
//   `--bridge-repo` get their repo's `bridgeRepoAllow` entry, else `bridgeDefaultAllow`; every
//   other git-protected repo mount whose repo has a non-empty entry is pinned too, and so is each
//   linked worktree of it mounted here (a `<repo>.worktrees` mirror). A repo's entry is chosen by the common
//   git dir of the frozen `config` the pin's remote is read from — never by a container-writable
//   `.git` file or `commondir`. A default grant that cannot pin something logs why and lets the
//   start succeed, where an explicit one fails it.
//
// `--bridge-allow none`, or no flag and neither default key, deletes it. The defaults live in that
// file and never in a devc config layer: every layer `up` merges is agent-writable or merged with
// one that is, and no container mounts `config.jsonc` or `config.json` (the same host-only
// folder). Every other start path only *refreshes* one that exists:
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
  MAX_PINNED_REPOS,
  parseGitdirPointer,
  parsePolicy,
  type PinnedRepo,
  type PolicyLine,
  policyProblem,
  type PolicyRecord,
  resolvePin,
  serializePolicy,
  targetProblem,
  uniformGrants,
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
import {
  gitDirTarget,
  parseMountSpec,
  unfoldHome,
} from '@devc-tools/core/mounts.ts';
import { isAbsolutePosix, resolvePosix } from '@devc-tools/core/posix.ts';
import { RepoMetadataError, resolveRepo } from '@devc-tools/core/repo.ts';
import {
  BRIDGE_CLIENT_TARGET,
  gitProtectState,
  type ProtectedRow,
  workspaceMountRow,
  worktreeCommonDirRow,
} from '@devc-tools/core/overlay.ts';
import {
  BRIDGE_REPO_FLAG,
  type BridgeRepoAllowEntry,
  expandBridgeRepo,
} from './args.ts';

/** Where the bridge mount lands in every container. */
const BRIDGE_TARGET = '/run/devc-bridge';

/**
 * `bridgeRepoAllow` resolved ({@link resolveRepoAllow}): each repo's realpathed common git dir to
 * its grants (canonical order; `[]` is "no default for this repo").
 */
export type RepoAllow = ReadonlyMap<string, BridgeCapability[]>;

/**
 * What a start path does with the policy. See the module header. A grant carries its capabilities
 * (canonical order, validated by `parseBridgeAllow`) and the `--bridge-repo` paths as typed, and
 * replaces any earlier policy whole. A default grant carries `bridgeDefaultAllow`'s capabilities
 * (validated by `parseBridgeDefaultAllow`; null when it is not set), the `--bridge-repo` paths as
 * typed, and `bridgeRepoAllow` resolved; it fails only for an ineligible `--bridge-repo` or, with
 * one given, pins that cannot stand together.
 */
export type PolicyMode = 'revoke' | 'refresh' | {
  grant: BridgeCapability[];
  repos?: string[];
} | {
  defaultGrant: BridgeCapability[] | null;
  repos?: string[];
  repoAllow?: RepoAllow;
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

/**
 * A repo's pin and container path, or the first precondition that failed. `commonDir` is the
 * realpathed git dir holding the frozen `config` the pin's remote was read from — the host source
 * of the live container's read-only `config` mount, which the container cannot change — and is
 * what picks the repo's `bridgeRepoAllow` entry. Null before `up` (no mount table yet) or when that
 * source no longer resolves.
 */
export type DerivedPin =
  | { ok: true; record: PinnedRepo; commonDir: string | null }
  | { ok: false; reason: string };

/** The common git dir a frozen `config` mount's host source lives in, realpathed, or null. */
async function frozenCommonDir(configSource: string): Promise<string | null> {
  return await realPathOrNull(dirOf(configSource));
}

/** A mount target with trailing slashes dropped, as the mount table and the policy spell it. */
function normalizeTarget(target: string): string {
  return target.replace(/\/+$/, '');
}

/**
 * Why no repo can be pinned in this container at all, or null — the checks made once, before any
 * repo's, by a grant, the pre-`up` check and refresh alike:
 *
 * 1. the merged Features declare devc-bridge;
 * 2. `gitProtect` is not off (named separately only because it is the clearest message — each
 *    repo's mount check would catch it anyway);
 * 3. with a live mount table: a container exists (`null` fails), and it has this workspace's own
 *    `keys/<key>/` at `/run/devc-bridge` (a container still on a hand-written `run/` mount
 *    authenticates with the shared token, which no pin applies to). `'skip'` skips 3 — only for
 *    the pre-`up` check, where no container exists yet to ask.
 */
function containerProblem(
  merged: MergedConfig,
  mounts: ContainerMount[] | null | 'skip',
  home: string,
): string | null {
  if (merged.bridgeKey === null) return 'no devc-bridge Feature is declared';
  if (merged.gitProtect === false) {
    return 'gitProtect is off, so the repo config the pin is read from is not frozen';
  }
  if (mounts === 'skip') return null;
  if (mounts === null) return 'no container to verify git protection against';
  const keyDir = bridgePaths(home, merged.bridgeKey).keyDir;
  const tokenMount = mounts.find((m) =>
    m.destination.replace(/\/+$/, '') === BRIDGE_TARGET
  );
  if (tokenMount === undefined) {
    return `this container has nothing mounted at ${BRIDGE_TARGET}`;
  }
  if (tokenMount.source !== keyDir) {
    return `this container mounts ${tokenMount.source} at ${BRIDGE_TARGET}, not its own ` +
      `${keyDir} — remove any hand-written devc-bridge mount and recreate it with \`devc build\``;
  }
  return null;
}

/**
 * Derive the publish pin for the workspace repo of `localFolder`, checking every per-repo
 * precondition in order ({@link containerProblem} has already passed):
 *
 * 1. the workspace is a bind-mounted repo devc can find;
 * 2. its `HEAD` names a branch and its config has exactly one `remote.origin.url`, and that URL
 *    is a GitHub remote — every capability acts through the host's `gh` login, so push is
 *    GitHub-only (`gh-push` re-checks for itself, since a policy file can be edited by hand);
 * 3. the container's live mount table has that repo's git dir `config` and `hooks` read-only —
 *    the repo's own `.git`, or for a linked worktree the primary's git dir as the devcontainer
 *    CLI mounts it. `'skip'` skips it, as for {@link containerProblem}.
 */
async function derivePin(
  merged: MergedConfig,
  localFolder: string,
  mounts: ContainerMount[] | null | 'skip',
): Promise<DerivedPin> {
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
  if (mounts === 'skip') {
    return { ok: true, record: { ...pin.record, target }, commonDir: null };
  }
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
  return {
    ok: true,
    record: { ...frozen.record, target },
    commonDir: await frozenCommonDir(configMount.source),
  };
}

/**
 * Derive the pin for one extra `--bridge-repo` row — a `repo` row of `merged.protectedRows`,
 * whose working tree is `repo` on the host (already resolved through symlinks). The same per-repo
 * checks as {@link derivePin}'s 2 and 3: `HEAD` names a branch, exactly one GitHub
 * `remote.origin.url`, and the row's `.git/config` and `.git/hooks` read-only in the live
 * container, with the remote read from the host source of that frozen `config` mount. The
 * container-wide checks are {@link containerProblem}'s, made once for the grant.
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
  if (mounts === 'skip') {
    return { ok: true, record: { ...pin.record, target }, commonDir: null };
  }
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
  return {
    ok: true,
    record: { ...frozen.record, target },
    commonDir: await frozenCommonDir(configMount.source),
  };
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
 * A linked worktree an extra pin may name ({@link matchWorktree}): its host working tree, its path
 * in the container, and the git-protected row whose git dir is its common dir — the primary's,
 * whose frozen `config` and `hooks` are the only config and hooks git uses for the worktree.
 */
interface WorktreeMatch {
  repo: string;
  target: string;
  gitDirRow: ProtectedRow;
  /** The container path of that common git dir. */
  gitDir: string;
}

/** The container path of a protected row's git dir: `<target>/.git`, or a `gitdir` row's target. */
function containerGitDir(row: ProtectedRow): string {
  const target = normalizeTarget(row.target);
  return row.kind === 'gitdir' ? target : gitDirTarget(target);
}

/** The host path of a protected row's git dir, resolved through symlinks, or null if missing. */
async function hostGitDir(
  row: ProtectedRow,
  home: string,
): Promise<string | null> {
  const source = unfoldHome(row.source, home);
  return await realPathOrNull(
    row.kind === 'gitdir' ? source : `${source}/.git`,
  );
}

async function readTextOrNull(path: string): Promise<string | null> {
  try {
    return await Deno.readTextFile(path);
  } catch {
    return null;
  }
}

/**
 * The deepest bind mount of this workspace whose host source (resolved through symlinks) is or
 * contains `repo`, or null. The workspace mount is not in `mounts`, so it is a candidate of its own.
 */
async function containingMount(
  repo: string,
  merged: MergedConfig,
  localFolder: string,
  home: string,
): Promise<{ source: string; target: string } | null> {
  const candidates: { source: string; target: string }[] = [];
  const workspace = await workspaceMountRow(merged.config, localFolder);
  if (workspace !== null) candidates.push(workspace);
  if (Array.isArray(merged.config.mounts)) {
    for (const entry of merged.config.mounts) {
      const spec = parseMountSpec(entry);
      if (spec === null || spec.type !== 'bind' || spec.source === null) {
        continue;
      }
      candidates.push({ source: spec.source, target: spec.target });
    }
  }
  let best: { source: string; target: string } | null = null;
  for (const c of candidates) {
    const source = await realPathOrNull(unfoldHome(c.source, home));
    if (source === null) continue;
    if (repo !== source && !repo.startsWith(`${source}/`)) continue;
    if (best === null || source.length > best.source.length) {
      best = { source, target: c.target };
    }
  }
  return best;
}

/**
 * Whether the linked worktree at `repo` (a host path, resolved through symlinks, whose `.git` is a
 * file) may be pinned as an extra repo, and where it sits in the container. Each check is the one
 * that keeps the container's git on the frozen config; the first that fails is the reason:
 *
 * 1. It is inside a bind mount (the deepest one whose source contains it) — a `<repo>.worktrees`
 *    row, or a row mounting the worktree itself. That gives its container path.
 * 2. Its `gitdir:` pointer is relative: an absolute one names a host path the container lacks.
 * 3. The pointer is honest — `<C>/worktrees/<name>`, whose `gitdir` points back at this `.git` and
 *    whose `commondir` is `<C>` (the checks `gh-push`'s `pointer_problem` makes) — and `<C>` is the
 *    git dir of a git-protected row: a `repo` row's `.git`, or a `gitdir` row such as the CLI's
 *    common-dir mount for a worktree workspace.
 * 4. The same relative pointer, resolved from the container path, lands on that row's git dir in
 *    the container — so git in the container uses the frozen config, not some other copy.
 *
 * Whether protection is actually in force is checked against the live mount table later, as for
 * any pin ({@link deriveWorktreePin}).
 */
async function matchWorktree(
  repo: string,
  merged: MergedConfig,
  localFolder: string,
  home: string,
): Promise<{ ok: true; match: WorktreeMatch } | { ok: false; reason: string }> {
  // 1. The deepest bind mount containing it.
  const best = await containingMount(repo, merged, localFolder, home);
  if (best === null) {
    return {
      ok: false,
      reason:
        'a linked worktree that is not inside any bind mount of this workspace',
    };
  }
  const target = normalizeTarget(best.target) +
    repo.slice(best.source.length);

  // 2. A relative pointer.
  const rel = parseGitdirPointer(await readTextOrNull(`${repo}/.git`) ?? '');
  if (rel === null) {
    return { ok: false, reason: 'its .git is a file with no gitdir: line' };
  }
  if (isAbsolutePosix(rel)) {
    return {
      ok: false,
      reason:
        'its .git uses an absolute gitdir: path, which does not resolve inside the container — ' +
        'run git worktree repair --relative-paths',
    };
  }

  // 3. An honest pointer into a protected git dir.
  const pointed = resolvePosix(repo, rel);
  const g = await realPathOrNull(pointed);
  const notProtected = {
    ok: false as const,
    reason: `its .git points at ${
      g ?? pointed
    }, which is not the worktrees/ dir of a git-protected repo here`,
  };
  const m = g === null ? null : /^(.+)\/worktrees\/([^/]+)$/.exec(g);
  if (g === null || m === null) return notProtected;
  const [, commonDir, name] = m;
  const back = (await readTextOrNull(`${g}/gitdir`))?.trim();
  if (back === undefined || back === '') return notProtected;
  const backPath = isAbsolutePosix(back) ? back : resolvePosix(g, back);
  const backDir = await realPathOrNull(dirOf(backPath));
  if (
    backDir === null || `${backDir}/${baseOf(backPath)}` !== `${repo}/.git`
  ) {
    return notProtected;
  }
  const common = (await readTextOrNull(`${g}/commondir`))?.trim();
  if (common === undefined || common === '') return notProtected;
  const commonPath = isAbsolutePosix(common) ? common : resolvePosix(g, common);
  if (await realPathOrNull(commonPath) !== commonDir) return notProtected;
  let gitDirRow: ProtectedRow | null = null;
  for (const row of merged.protectedRows) {
    if (await hostGitDir(row, home) === commonDir) {
      gitDirRow = row;
      break;
    }
  }
  if (gitDirRow === null) return notProtected;

  // 4. The same pointer, from inside the container.
  const gitDir = containerGitDir(gitDirRow);
  const expected = `${gitDir}/worktrees/${name}`;
  const inside = resolvePosix(target, rel);
  if (inside !== expected) {
    return {
      ok: false,
      reason:
        `its gitdir: pointer resolves to ${inside} inside the container, not ${expected}`,
    };
  }
  return { ok: true, match: { repo, target, gitDirRow, gitDir } };
}

function dirOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i <= 0 ? '/' : path.slice(0, i);
}

function baseOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/**
 * The pin for a linked worktree {@link matchWorktree} accepted: its own branch (`HEAD` in its
 * `<C>/worktrees/<name>` dir) and the primary's GitHub remote, read from the frozen `config` —
 * before `up`, from `<C>/config` itself. With a live mount table, the common git dir's `config`
 * and `hooks` must be read-only in the container, as for any pin.
 */
async function deriveWorktreePin(
  match: WorktreeMatch,
  mounts: ContainerMount[] | null | 'skip',
): Promise<DerivedPin> {
  const badTarget = targetProblem(match.target);
  if (badTarget !== null) {
    return {
      ok: false,
      reason:
        `its container path ${match.target} cannot be pinned (${badTarget})`,
    };
  }
  const pin = await resolvePin(match.repo);
  if (!pin.ok) return { ok: false, reason: pin.reason };
  if (!isGitHubRemote(pin.record.remote)) {
    return { ok: false, reason: notGitHubReason(pin.record.remote) };
  }
  if (mounts === 'skip') {
    return {
      ok: true,
      record: { ...pin.record, target: match.target },
      commonDir: null,
    };
  }
  if (mounts === null) {
    return {
      ok: false,
      reason: 'no container to verify git protection against',
    };
  }
  const state = gitProtectState(match.gitDirRow, mounts);
  if (state.state !== 'protected') {
    return {
      ok: false,
      reason:
        `git protection is not in force in this container for ${match.target} ` +
        `(${state.problems.join('; ')}) — recreate it with \`devc build\``,
    };
  }
  const configMount = mounts.find((m) =>
    normalizeTarget(m.destination) === `${match.gitDir}/config`
  )!;
  const frozen = await resolvePin(match.repo, {
    configPath: configMount.source,
  });
  if (!frozen.ok) return { ok: false, reason: frozen.reason };
  if (!isGitHubRemote(frozen.record.remote)) {
    return { ok: false, reason: notGitHubReason(frozen.record.remote) };
  }
  // The entry follows the frozen `config` mount git protection verified, not the `.git` pointer
  // `matchWorktree` followed to choose it: that pointer is container-writable.
  return {
    ok: true,
    record: { ...frozen.record, target: match.target },
    commonDir: await frozenCommonDir(configMount.source),
  };
}

/**
 * The rows `--bridge-repo` may name as a whole repo: every git-protected `repo` row of the merged
 * config except the workspace's own (at its own target or mounted again elsewhere), and not a row
 * whose source does not exist. A linked worktree is never one (its `.git` is a file, so git
 * protection does not classify it as a repo); {@link matchWorktree} decides those.
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
 * What `--bridge-repo <arg>` names — a protected repo row, or a linked worktree
 * {@link matchWorktree} accepts — or throws {@link BridgeGrantError} saying why it names neither:
 * no such directory, the workspace repo itself, a worktree that fails one of its checks, or
 * anything else that is not a git-protected repo mount here (listing the ones that are).
 */
async function matchBridgeRepo(
  arg: string,
  rows: EligibleRow[],
  merged: MergedConfig,
  localFolder: string,
  home: string,
): Promise<EligibleRow | WorktreeMatch> {
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
    throw refuse('this is the workspace repo, which devc always tries to pin');
  }
  let dotGitIsFile = false;
  try {
    dotGitIsFile = (await Deno.stat(`${real}/.git`)).isFile;
  } catch { /* no .git at all */ }
  if (dotGitIsFile) {
    const worktree = await matchWorktree(real, merged, localFolder, home);
    if (!worktree.ok) throw refuse(worktree.reason);
    return worktree.match;
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
 * What each `--bridge-repo` names ({@link matchBridgeRepo}), in order, or throws
 * {@link BridgeGrantError} for the first that names nothing pinnable or the same repo as an
 * earlier one.
 */
async function matchBridgeRepos(
  repos: readonly string[],
  rows: EligibleRow[],
  merged: MergedConfig,
  localFolder: string,
  home: string,
): Promise<{ arg: string; match: EligibleRow | WorktreeMatch }[]> {
  const used = new Set<string>();
  const out: { arg: string; match: EligibleRow | WorktreeMatch }[] = [];
  for (const arg of repos) {
    const match = await matchBridgeRepo(arg, rows, merged, localFolder, home);
    if (used.has(match.repo)) {
      throw new BridgeGrantError(
        `${BRIDGE_REPO_FLAG} ${arg} given more than once`,
      );
    }
    used.add(match.repo);
    out.push({ arg, match });
  }
  return out;
}

/** The pin for what {@link matchBridgeRepo} matched: a whole repo row or a linked worktree. */
async function deriveMatch(
  match: EligibleRow | WorktreeMatch,
  mounts: ContainerMount[] | null | 'skip',
): Promise<DerivedPin> {
  return 'row' in match
    ? await deriveExtraPin(match.row, match.repo, mounts)
    : await deriveWorktreePin(match, mounts);
}

/**
 * Why two of `pins` cannot stand together, or null. Pins on one GitHub `<owner>/<name>` share
 * `gh-push`'s per-remote mirror, which is fine for different branches — worktrees of one primary —
 * but not for the same branch twice, and not through two URL spellings: the mirror's `origin`
 * must equal each line's remote. `labels[i]` names `pins[i]` in the message.
 */
function sameRepoProblem(
  pins: readonly PinnedRepo[],
  labels: readonly string[],
): string | null {
  for (let i = 0; i < pins.length; i++) {
    for (let j = 0; j < i; j++) {
      const a = gitHubRepoOf(pins[j].remote)!;
      if (a.toLowerCase() !== gitHubRepoOf(pins[i].remote)!.toLowerCase()) {
        continue;
      }
      if (pins[j].branch === pins[i].branch) {
        return `${labels[j]} and ${labels[i]} both push branch ${
          pins[i].branch
        } to github.com/${a}`;
      }
      if (pins[j].remote !== pins[i].remote) {
        return `${labels[j]} and ${
          labels[i]
        } reach github.com/${a} through different URLs ` +
          `(${pins[j].remote}, ${pins[i].remote})`;
      }
    }
  }
  return null;
}

/** The workspace candidate's label in skip notices and the no-repo-can-be-pinned error. */
const WORKSPACE_LABEL = 'the workspace repo';

/** A candidate repo a grant skipped: its label and the precondition it failed. */
interface SkippedRepo {
  label: string;
  reason: string;
}

/**
 * The pins a grant writes — the workspace repo, then each `--bridge-repo` in order, each kept only
 * when it passes its own preconditions — plus the candidates skipped, or the reason the grant
 * fails, already worded for the user: a {@link containerProblem}, no candidate passing (with one
 * candidate, its own reason; with more, every candidate's), or a {@link sameRepoProblem} among the
 * passing pins. `mounts` is the live table, or `'skip'` before `up`. Eligibility failures throw
 * {@link BridgeGrantError} directly, worded on their own: an argument that names nothing pinnable
 * is a mistake on the command line, never a skip. A `--bridge-repo` is labelled as typed.
 */
async function derivePins(
  merged: MergedConfig,
  localFolder: string,
  repos: readonly string[],
  mounts: ContainerMount[] | null | 'skip',
  home: string,
): Promise<
  | { ok: true; pins: PinnedRepo[]; skipped: SkippedRepo[] }
  | { ok: false; reason: string }
> {
  const problem = containerProblem(merged, mounts, home);
  if (problem !== null) return { ok: false, reason: problem };
  const candidates: { label: string; pin: DerivedPin }[] = [{
    label: WORKSPACE_LABEL,
    pin: await derivePin(merged, localFolder, mounts),
  }];
  const rows = repos.length === 0
    ? []
    : await eligibleRows(merged, localFolder, home);
  for (
    const { arg, match } of await matchBridgeRepos(
      repos,
      rows,
      merged,
      localFolder,
      home,
    )
  ) {
    candidates.push({ label: arg, pin: await deriveMatch(match, mounts) });
  }

  const pins: PinnedRepo[] = [];
  const labels: string[] = [];
  const skipped: SkippedRepo[] = [];
  for (const [i, { label, pin }] of candidates.entries()) {
    if (pin.ok) {
      pins.push(pin.record);
      // A conflict names the workspace by its host path, as the user would recognize it.
      labels.push(i === 0 ? pin.record.repo : label);
    } else {
      skipped.push({ label, reason: pin.reason });
    }
  }
  if (pins.length === 0) {
    return {
      ok: false,
      reason: skipped.length === 1
        ? skipped[0].reason
        : `no repo can be pinned — ${
          skipped.map((r) => `${r.label}: ${r.reason}`).join('; ')
        }`,
    };
  }
  const shared = sameRepoProblem(pins, labels);
  if (shared !== null) return { ok: false, reason: shared };
  return { ok: true, pins, skipped };
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

/** One policy line with its own grants, for a policy whose lines differ (and the defaults' log). */
function describeLine(r: PolicyLine): string {
  return `${describeRepo(r)}: ${r.grants.join(', ')}`;
}

/** `bridgeRepoAllow` named two repos that are one, or another problem only resolving shows. */
export class RepoAllowError extends Error {}

/**
 * Resolve `bridgeRepoAllow`'s entries ({@link BridgeRepoAllowEntry}, already validated) to their
 * repos' common git dirs (`resolveRepo(...).commonDir`, the identity repo overlays use). A key
 * that is not a folder, or not in a git repo, or whose git metadata cannot be read, is ignored
 * with `devc: bridgeRepoAllow: ignoring <key>: <reason>` — the list is global, and a repo may have
 * been moved or deleted. Two keys naming one repo throw {@link RepoAllowError}. These are the
 * user's own host paths, read once, before anything starts — nothing here comes from a container.
 */
export async function resolveRepoAllow(
  entries: readonly BridgeRepoAllowEntry[],
  log: (message: string) => void,
): Promise<RepoAllow> {
  const grants = new Map<string, BridgeCapability[]>();
  const keyOf = new Map<string, string>();
  for (const entry of entries) {
    let reason: string | null = null;
    let commonDir = '';
    try {
      if (!(await Deno.stat(entry.path)).isDirectory) reason = 'no such folder';
    } catch {
      reason = 'no such folder';
    }
    if (reason === null) {
      try {
        const identity = await resolveRepo(entry.path);
        if (identity === null) reason = 'not in a git repo';
        else commonDir = identity.commonDir;
      } catch (e) {
        reason = e instanceof RepoMetadataError ? e.message : String(e);
      }
    }
    if (reason !== null) {
      log(`devc: bridgeRepoAllow: ignoring ${entry.key}: ${reason}`);
      continue;
    }
    const earlier = keyOf.get(commonDir);
    if (earlier !== undefined) {
      throw new RepoAllowError(
        `${earlier} and ${entry.key} name the same repo`,
      );
    }
    keyOf.set(commonDir, entry.key);
    grants.set(commonDir, entry.grants);
  }
  return grants;
}

/**
 * Before `devcontainer up`, for an explicit `--bridge-allow`: fail fast when the preconditions
 * that do not need a container already leave nothing to pin — the container-wide ones, an
 * ineligible `--bridge-repo`, or no candidate passing — so the user is not handed a running
 * container they believe can publish. A candidate that fails is not reported here; the grant
 * after `up` reports every skip once. Removes any existing policy on failure — an explicit
 * request that cannot be met must not leave an older grant standing.
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
 * Before `devcontainer up`, for a default grant with `--bridge-repo`s: a typo still fails the
 * start. Each `--bridge-repo` must name something pinnable ({@link matchBridgeRepo}); per-repo
 * preconditions are not checked — the defaults never fail a start for those. Nothing is checked
 * when a container-wide problem stands (logged after `up`, or silent without the Feature). Removes
 * any existing policy on failure, as {@link checkGrantBeforeUp} does.
 */
export async function checkDefaultsBeforeUp(
  merged: MergedConfig,
  localFolder: string,
  deps: BridgeDeps = defaultDeps(),
  repos: readonly string[] = [],
): Promise<void> {
  if (repos.length === 0) return;
  if (containerProblem(merged, 'skip', deps.home) !== null) return;
  try {
    await matchBridgeRepos(
      repos,
      await eligibleRows(merged, localFolder, deps.home),
      merged,
      localFolder,
      deps.home,
    );
  } catch (e) {
    await removePolicy(await projectKey(localFolder), deps);
    throw e;
  }
}

/**
 * The host working trees of the linked worktrees registered in the common git dir `commonDir`
 * (realpathed), by name: each `worktrees/<name>/gitdir` back-pointer's directory, resolved through
 * symlinks. One whose working tree is gone is left out. Only which worktrees to try comes from
 * here — {@link matchWorktree} checks each one's pointers, and {@link deriveWorktreePin} reads
 * the grants' identity from the frozen `config`.
 */
async function linkedWorktrees(commonDir: string): Promise<string[]> {
  const names: string[] = [];
  try {
    for await (const e of Deno.readDir(`${commonDir}/worktrees`)) {
      if (e.isDirectory) names.push(e.name);
    }
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of names.sort()) {
    const g = `${commonDir}/worktrees/${name}`;
    const back = (await readTextOrNull(`${g}/gitdir`))?.trim();
    if (back === undefined || back === '') continue;
    const backPath = isAbsolutePosix(back) ? back : resolvePosix(g, back);
    const wt = await realPathOrNull(dirOf(backPath));
    if (wt !== null && !out.includes(wt)) out.push(wt);
  }
  return out;
}

/** The defaults' label for a mounted repo pinned because `bridgeRepoAllow` names it. */
function autoLabel(row: ProtectedRow, home: string): string {
  return tildePath(unfoldHome(row.source, home), home);
}

/** The prefix of every notice the defaults log about a repo or the whole grant. */
const DEFAULTS = 'defaults';

/**
 * The lines a default grant writes, and the notices to log first, or why it grants nothing at
 * all. Candidates, in order: the workspace repo, each `--bridge-repo`, then each other
 * {@link eligibleRows} repo whose `bridgeRepoAllow` entry is non-empty, then each linked worktree
 * of such a repo inside a bind mount of this workspace ({@link linkedWorktrees}). A candidate's grants are
 * its repo's entry, else `bridgeDefaultAllow`, else none — the repo being the one whose frozen
 * `config` the pin's remote came from ({@link DerivedPin}'s `commonDir`). Whether a candidate is
 * tried at all is decided first, from its host git dir, so a repo with nothing to grant costs no
 * notice; the grants themselves only ever come from the frozen identity.
 *
 * Throws {@link BridgeGrantError} for an ineligible `--bridge-repo`, and — with a `--bridge-repo`
 * given — for pins that cannot stand together ({@link sameRepoProblem}).
 */
async function deriveDefaultLines(
  mode: {
    defaultGrant: BridgeCapability[] | null;
    repos?: string[];
    repoAllow?: RepoAllow;
  },
  merged: MergedConfig,
  localFolder: string,
  mounts: ContainerMount[] | null,
  home: string,
): Promise<
  | { ok: true; lines: PolicyLine[]; notices: string[] }
  | { ok: false; reason: string; notices: string[] }
> {
  const notices: string[] = [];
  const problem = containerProblem(merged, mounts, home);
  if (problem !== null) return { ok: false, reason: problem, notices };
  const repoAllow: RepoAllow = mode.repoAllow ?? new Map();
  const repos = mode.repos ?? [];
  const fallback = mode.defaultGrant ?? [];
  const grantsFor = (commonDir: string | null) =>
    commonDir !== null && repoAllow.has(commonDir)
      ? repoAllow.get(commonDir)!
      : fallback;

  type Candidate = {
    label: string;
    kind: 'workspace' | 'flag' | 'map';
    /** The host git dir, for deciding whether to try; never for the grants. */
    hostDir: string | null;
    derive: () => Promise<DerivedPin>;
  };
  const candidates: Candidate[] = [];
  const workspace = await workspaceMountRow(merged.config, localFolder);
  let workspaceDir: string | null = null;
  if (workspace !== null) {
    try {
      workspaceDir =
        (await resolveRepo(unfoldHome(workspace.source, home)))?.commonDir ??
          null;
    } catch { /* derivePin reports it, if it is tried */ }
  }
  candidates.push({
    label: WORKSPACE_LABEL,
    kind: 'workspace',
    hostDir: workspaceDir,
    derive: () => derivePin(merged, localFolder, mounts),
  });
  const rows = repos.length === 0 && repoAllow.size === 0
    ? []
    : await eligibleRows(merged, localFolder, home);
  const flagged = await matchBridgeRepos(
    repos,
    rows,
    merged,
    localFolder,
    home,
  );
  const used = new Set(flagged.map((f) => f.match.repo));
  for (const { arg, match } of flagged) {
    candidates.push({
      label: arg,
      kind: 'flag',
      hostDir: await hostGitDir(
        'row' in match ? match.row : match.gitDirRow,
        home,
      ),
      derive: () => deriveMatch(match, mounts),
    });
  }
  for (const r of rows) {
    if (used.has(r.repo)) continue;
    const hostDir = await hostGitDir(r.row, home);
    if (hostDir === null || (repoAllow.get(hostDir)?.length ?? 0) === 0) {
      continue;
    }
    candidates.push({
      label: autoLabel(r.row, home),
      kind: 'map',
      hostDir,
      derive: () => deriveExtraPin(r.row, r.repo, mounts),
    });
  }
  // Then each linked worktree of a mapped repo that sits in a bind mount here — a
  // `<repo>.worktrees` mirror, say — other than the workspace itself and any `--bridge-repo`.
  // One outside every mount is not in this container and is passed over silently.
  const workspaceRepo = workspace === null
    ? null
    : await realPathOrNull(unfoldHome(workspace.source, home));
  const listed = new Set<string>();
  for (const row of repoAllow.size === 0 ? [] : merged.protectedRows) {
    const hostDir = await hostGitDir(row, home);
    if (
      hostDir === null || listed.has(hostDir) ||
      (repoAllow.get(hostDir)?.length ?? 0) === 0
    ) {
      continue;
    }
    listed.add(hostDir);
    for (const wt of await linkedWorktrees(hostDir)) {
      if (wt === workspaceRepo || used.has(wt)) continue;
      if (await containingMount(wt, merged, localFolder, home) === null) {
        continue;
      }
      used.add(wt);
      const label = tildePath(wt, home);
      candidates.push({
        label,
        kind: 'map',
        hostDir,
        derive: async () => {
          const match = await matchWorktree(wt, merged, localFolder, home);
          return match.ok
            ? await deriveWorktreePin(match.match, mounts)
            : { ok: false, reason: match.reason };
        },
      });
    }
  }

  const noGrants = (c: Candidate) => {
    if (c.kind === 'flag') {
      notices.push(
        `devc: not pinning ${c.label}: no default grants for it — pass --bridge-allow`,
      );
    }
  };
  const lines: PolicyLine[] = [];
  const labels: string[] = [];
  for (const c of candidates) {
    if (grantsFor(c.hostDir).length === 0) {
      noGrants(c);
      continue;
    }
    if (lines.length >= MAX_PINNED_REPOS) {
      notices.push(
        `devc: ${DEFAULTS}: not pinning ${c.label}: a policy pins at most ${MAX_PINNED_REPOS} repos`,
      );
      continue;
    }
    const pin = await c.derive();
    if (!pin.ok) {
      notices.push(`devc: ${DEFAULTS}: not pinning ${c.label}: ${pin.reason}`);
      continue;
    }
    // A mounted repo is pinned only for its own entry, read from the frozen identity.
    if (
      c.kind === 'map' &&
      (pin.commonDir === null ||
        (repoAllow.get(pin.commonDir)?.length ?? 0) === 0)
    ) {
      continue;
    }
    const grants = grantsFor(pin.commonDir);
    if (grants.length === 0) {
      noGrants(c);
      continue;
    }
    lines.push({ ...pin.record, grants });
    labels.push(c.kind === 'workspace' ? pin.record.repo : c.label);
  }
  const shared = sameRepoProblem(lines, labels);
  if (shared !== null) {
    if (repos.length > 0) {
      throw new BridgeGrantError(
        `the container is up, but the defaults were not granted: ${shared}`,
      );
    }
    return { ok: false, reason: shared, notices };
  }
  return { ok: true, lines, notices };
}

/**
 * After `devcontainer up`: apply `mode` to this workspace's policy.
 *
 * - `revoke` — unlink it. What `up`/`build` do with `--bridge-allow none`, or with neither the
 *   flag nor a default key.
 * - `{ grant }` — derive the workspace pin and one per `--bridge-repo` against the live mount
 *   table and write the ones that pass with exactly these capabilities, logging each candidate
 *   skipped and why; or, when {@link derivePins} fails, remove any policy and throw
 *   {@link BridgeGrantError} with its reason.
 * - `{ defaultGrant }` — the defaults ({@link deriveDefaultLines}): each line with its own
 *   grants, every skip logged with the `defaults:` prefix. A workspace without the Feature is
 *   revoked (logged only when a policy was removed); a container-wide failure, or pins that cannot
 *   stand together without a `--bridge-repo`, remove any policy and log why; no pins at all remove
 *   any policy quietly. It throws only for a `--bridge-repo` mistake.
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

  if (
    mode === 'revoke' ||
    (typeof mode === 'object' && 'defaultGrant' in mode &&
      merged.bridgeKey === null)
  ) {
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

  const write = async (record: PolicyRecord) => {
    const unchanged = current.kind === 'present' &&
      serializePolicy(current.record) === serializePolicy(record);
    if (!unchanged) await writePolicy(key, record, deps);
  };

  if ('defaultGrant' in mode) {
    let derived;
    try {
      derived = await deriveDefaultLines(
        mode,
        merged,
        localFolder,
        await deps.mounts(localFolder),
        deps.home,
      );
    } catch (e) {
      await removePolicy(key, deps);
      throw e;
    }
    for (const n of derived.notices) deps.log(n);
    if (!derived.ok) {
      await removePolicy(key, deps);
      deps.log(`devc: ${DEFAULTS}: not granted: ${derived.reason}`);
      return;
    }
    if (derived.lines.length === 0) {
      await removePolicy(key, deps);
      return;
    }
    await write({ repos: derived.lines });
    deps.log('devc: devc-bridge capabilities granted (defaults):');
    for (const r of derived.lines) deps.log(`devc:   ${describeLine(r)}`);
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

  const record: PolicyRecord = {
    repos: pins.pins.map((p) => ({ ...p, grants })),
  };
  await write(record);
  for (const r of pins.skipped) {
    deps.log(`devc: --bridge-allow: not pinning ${r.label}: ${r.reason}`);
  }
  deps.log(`devc: devc-bridge capabilities granted: ${grants.join(', ')}`);
  for (const r of record.repos) deps.log(`devc:   ${describeRepo(r)}`);
}

/**
 * {@link applyPolicy}'s refresh of a present policy: the stored pins stand only while every one
 * still matches what the container shows. {@link containerProblem} is checked first. The line
 * whose `target` is the workspace mount's is re-derived as the workspace repo — a grant that
 * skipped the workspace has no such line; every other line by finding the protected row with its
 * stored `repo` and `target`, or — for a linked worktree — through {@link matchWorktree} again.
 * The first line that fails or drifted revokes the whole policy, named by its host path when more
 * than one repo is pinned; so does a pair the same-repo rule ({@link sameRepoProblem}) no longer
 * allows. A workspace that has become pinnable since is not added: only a grant writes.
 */
async function refreshPolicy(
  key: string,
  stored: PolicyRecord,
  merged: MergedConfig,
  localFolder: string,
  deps: BridgeDeps,
): Promise<void> {
  const multi = stored.repos.length > 1;
  const workspace = await workspaceMountRow(merged.config, localFolder);
  const workspaceTarget = workspace === null
    ? null
    : normalizeTarget(workspace.target);
  const extras = stored.repos.some((line) => line.target !== workspaceTarget);
  // Lines that differ came from the defaults, and a plain `devc up` re-applies them.
  const uniform = uniformGrants(stored);
  const regrant = uniform === null
    ? 'devc up'
    : `devc up --bridge-allow ${uniform.join(',')}${
      extras ? ` ${BRIDGE_REPO_FLAG} …` : ''
    }`;
  const prefix = (line: PinnedRepo) => multi ? `${line.repo}: ` : '';
  const revoke = async (message: string) => {
    await removePolicy(key, deps);
    deps.log(`devc: devc-bridge capabilities revoked — ${message}`);
  };

  const mounts = await deps.mounts(localFolder);
  const problem = containerProblem(merged, mounts, deps.home);
  if (problem !== null) {
    await revoke(`${problem}. Re-run \`${regrant}\` once that is fixed.`);
    return;
  }
  const rows = extras ? await eligibleRows(merged, localFolder, deps.home) : [];
  const derivedPins: PinnedRepo[] = [];
  for (const line of stored.repos) {
    let derived: DerivedPin;
    if (line.target === workspaceTarget) {
      derived = await derivePin(merged, localFolder, mounts);
    } else {
      const match = rows.find((r) =>
        r.repo === line.repo && normalizeTarget(r.row.target) === line.target
      );
      derived = match !== undefined
        ? await deriveExtraPin(match.row, match.repo, mounts)
        : await refreshWorktreeLine(line, merged, localFolder, mounts, deps);
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
    derivedPins.push(derived.record);
  }
  const shared = sameRepoProblem(
    derivedPins,
    derivedPins.map((p) => p.repo),
  );
  if (shared !== null) {
    await revoke(`${shared}. Re-run \`${regrant}\` once that is fixed.`);
  }
}

/**
 * Refresh's re-derivation of an extra line no protected repo row matches: a linked worktree goes
 * through {@link matchWorktree} and {@link deriveWorktreePin} again (a moved container path then
 * shows as drift); anything else is no longer a pinnable mount.
 */
async function refreshWorktreeLine(
  line: PinnedRepo,
  merged: MergedConfig,
  localFolder: string,
  mounts: ContainerMount[] | null,
  deps: BridgeDeps,
): Promise<DerivedPin> {
  const gone: DerivedPin = {
    ok: false,
    reason:
      `${line.repo} is no longer a git-protected repo mount at ${line.target}`,
  };
  const repo = await realPathOrNull(line.repo);
  if (repo === null) return gone;
  try {
    if (!(await Deno.stat(`${repo}/.git`)).isFile) return gone;
  } catch {
    return gone;
  }
  const worktree = await matchWorktree(repo, merged, localFolder, deps.home);
  if (!worktree.ok) return { ok: false, reason: worktree.reason };
  return await deriveWorktreePin(worktree.match, mounts);
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
  if (policy.kind !== 'present') {
    lines.push(
      policy.kind === 'absent'
        ? '  bridge:    absent — `devc up --bridge-allow <capabilities>` grants them'
        : `  bridge:    MALFORMED policy at ${paths.policyFile} (${policy.reason}) — grants nothing`,
    );
    return lines;
  }
  const uniform = uniformGrants(policy.record);
  if (uniform !== null) {
    lines.push(`  bridge:    ${uniform.join(', ')}`);
    for (const r of policy.record.repos) lines.push(`    ${describeRepo(r)}`);
  } else {
    // Grants differ per line: each repo carries its own, and there is no single grants line.
    lines.push('  bridge:');
    for (const r of policy.record.repos) lines.push(`    ${describeLine(r)}`);
  }
  return lines;
}
