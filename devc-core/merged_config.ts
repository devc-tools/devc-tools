// The effective `devcontainer.json` devc hands to the CLI: the base config with devc's own layer
// and both `devc.json` overlays merged into it, materialized under `~/.cache/devc/`.
//
// **Why a cache file and not one in the project.** A generated config inside a git worktree is
// also a file inside a Docker build context (a config with `"context": ".."` makes the project
// root the context), it shows up in `git status` for a repo that need not know devc exists, and
// it would carry the *user-level* overlay's contents — that machine's paths and any `remoteEnv`
// values — into a committable location. A delete-after-run step would also race a second devc
// process on the same project, which is the failure `ensureDefaultConfig`'s own doc comment
// describes at length. None of that buys anything: `--override-config` keeps relative paths and
// container identity anchored to the project's config wherever the file itself lives.
//
// **Why the path is stable per project.** `@devcontainers/cli` labels a container with
// `devcontainer.local_folder` + `devcontainer.config_file` and refuses to reuse a container whose
// `config_file` differs — without removing it, even under `--remove-existing-container` (verified
// in 0.88.0's own container lookup). A config path that moved would strand a container per move,
// permanently. So the path is keyed on the project, never on content.

import { mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import process from 'node:process';
import {
  ensureDefaultConfig,
  findOwnDevcontainerConfig,
  loadConfigStrict,
  TEMPLATES_DIR,
} from './default_config.ts';
import { type ConfigObject, mergeConfigs } from './merge.ts';
import {
  assertGitProtectSupported,
  BRIDGE_CLIENT_MOUNT_KEY,
  BRIDGE_CLIENT_SUBPATH,
  classifyGitRows,
  declaresBridge,
  devcContributions,
  GIT_PROTECT_KEY,
  type GitProtect,
  gitProtectLayer,
  loadOverlays,
  type ProtectedRow,
  readBridgeClientMount,
  readGitProtect,
  stripDevcOnlyKeys,
  type UnprotectedRow,
} from './overlay.ts';
import { basenamePosix, dirnamePosix, resolvePosix } from './posix.ts';
import { normalizePath } from './paths.ts';
import { CONFIG_DIR } from './default_config.ts';

/**
 * Which config the merge started from, and therefore how the merged file is delivered:
 *
 * - `project` — the project has its own `devcontainer.json`, so the merged file is passed as
 *   `--override-config` and the CLI keeps resolving relative paths and container identity
 *   against the project's own config.
 * - `zero-config` — there is none, so the merged file is passed as `--config` and *is* the config
 *   path for every purpose.
 */
export type ConfigMode = 'project' | 'zero-config';

/** The materialized effective config for one project. */
export interface MergedConfig {
  /** Absolute path of the written `devcontainer.json`. */
  path: string;
  /** Its contents, as merged — saves every caller a re-read and re-parse. */
  config: ConfigObject;
  /** How it must be delivered to `devcontainer up`. See {@link ConfigMode}. */
  mode: ConfigMode;
  /** The config the merge started from, for messages that need to name it. */
  baseConfigPath: string;
  /**
   * The resolved `gitProtect` setting. Carried here because
   * {@link import("./overlay.ts").stripDevcOnlyKeys} takes the key back out of `config` before
   * the CLI sees it, and `devc status` still has to report which of the three states applies.
   */
  gitProtect: GitProtect;
  /**
   * The repo rows git protection was derived for — empty when `gitProtect` is `false`, and also
   * when nothing bind-mounted here is a repo. `devc status` checks these against the container's
   * live mount table; see {@link import("./overlay.ts").gitProtectState}.
   */
  protectedRows: ProtectedRow[];
  /**
   * Rows holding git config devc could **not** freeze — an umbrella mount of a folder of repos,
   * or a git dir with no `hooks` directory. Reported by every start path and `devc status`, never
   * derived for.
   */
  unprotectedRows: UnprotectedRow[];
  /**
   * This workspace's devc-bridge key ({@link projectKey}) when the merged Features opt into the
   * devc-bridge Feature, and so the container mounts `~/.config/devc-bridge/keys/<key>/`; `null`
   * when they do not. Carried so the CLI can create that directory before `devcontainer up` —
   * core itself writes nothing under `~/.config/devc-bridge/`.
   */
  bridgeKey: string | null;
  /**
   * Whether devc mounts the host's installed devc-bridge client over the Feature's copy
   * ({@link import("./overlay.ts").bridgeClientMount}): {@link BRIDGE_CLIENT_MOUNTED} when it
   * does, otherwise the reason it does not (see {@link bridgeClientDecision}), and `null` when the
   * bridge is not enabled at all. Carried so `devc status` can report it without re-deriving.
   */
  bridgeClient: string | null;
}

/** {@link MergedConfig.bridgeClient}'s value when the client mount is contributed. */
export const BRIDGE_CLIENT_MOUNTED = 'mounted';

/** ELF `e_machine` values devc knows, mapped to the `uname -m` spelling. */
const ELF_MACHINES: Record<number, string> = {
  0x3e: 'x86_64',
  0xb7: 'aarch64',
};

/** The host arch in `uname -m` spelling; an unmapped `process.arch` is returned raw. */
function hostArch(): string {
  switch (process.arch) {
    case 'x64':
      return 'x86_64';
    case 'arm64':
      return 'aarch64';
    default:
      return process.arch;
  }
}

/**
 * The first 20 bytes of `path` if it is a regular file, else `null` (missing, a directory, or
 * unreadable — every one of which means there is no host client to mount).
 */
async function readHeader(path: string): Promise<Uint8Array | null> {
  let handle;
  try {
    handle = await open(path, 'r');
    if (!(await handle.stat()).isFile()) return null;
    const buf = new Uint8Array(20);
    const { bytesRead } = await handle.read(buf, 0, 20, 0);
    return buf.subarray(0, bytesRead);
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * Decide whether the host client mount applies to `provisional` (the merge of the base config
 * and both overlays). Returns `null` when the bridge is not declared,
 * {@link BRIDGE_CLIENT_MOUNTED} when every condition holds, and otherwise the first failing
 * condition's reason — the exact string `devc status` prints:
 *
 * 1. the merged Features declare devc-bridge;
 * 2. `bridgeClientMount` is not `false`;
 * 3. not a Docker Compose project (Compose drops `readonly`, which would leave one writable
 *    binary shared by every container);
 * 4. `<home>/.config/devc-bridge/client/devc-bridge` is a regular file (a missing bind source
 *    fails `docker run`);
 * 5. it starts with the ELF magic (a placeholder must not shadow a working client);
 * 6. its `e_machine` matches the host arch.
 *
 * Reads the **host** file, in this process — never `uname -m`, which is the Feature's rule inside
 * the image.
 */
export async function bridgeClientDecision(
  provisional: ConfigObject,
  home: string,
): Promise<string | null> {
  if (!declaresBridge(provisional)) return null;
  if (
    !readBridgeClientMount(
      provisional[BRIDGE_CLIENT_MOUNT_KEY],
      'the merged config',
    )
  ) {
    return `${BRIDGE_CLIENT_MOUNT_KEY} is false`;
  }
  if (provisional.dockerComposeFile !== undefined) {
    return 'Docker Compose project — readonly would be dropped';
  }
  const header = await readHeader(
    `${home}/${BRIDGE_CLIENT_SUBPATH}/devc-bridge`,
  );
  if (header === null) {
    return `no host client at ~/${BRIDGE_CLIENT_SUBPATH}/devc-bridge`;
  }
  if (
    header.length < 20 || header[0] !== 0x7f || header[1] !== 0x45 ||
    header[2] !== 0x4c || header[3] !== 0x46
  ) {
    return 'host client is not a Linux binary';
  }
  const machine = header[18] | (header[19] << 8);
  const elfArch = ELF_MACHINES[machine] ?? `unknown(${machine})`;
  const host = hostArch();
  if (elfArch !== host) return `host client is ${elfArch}, host is ${host}`;
  return BRIDGE_CLIENT_MOUNTED;
}

function homeDir(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? '.';
}

/**
 * The per-project cache directory name: `<sanitized-basename>-<8-hex-sha256-prefix>` over the
 * normalized (lowercased) project path.
 *
 * The same scheme as the container name, minus its `devc-` prefix — see
 * {@link import("./container.ts").containerNameForLocalFolder}, which is built on this so the
 * directory and the container are visibly about the same project. Two checkouts sharing a
 * basename get different keys; the same folder gets the same key forever, which is the property
 * container identity depends on.
 */
export async function projectKey(localFolder: string): Promise<string> {
  const normalized = normalizePath(localFolder).toLowerCase();
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(normalized),
  );
  const hash = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 8);
  const base = basenamePosix(normalized).replace(/[^a-zA-Z0-9_.-]/g, '-') ||
    'workspace';
  return `${base}-${hash}`;
}

/** Where {@link ensureMergedConfig} writes for `localFolder`. */
export async function mergedConfigPath(
  localFolder: string,
  cacheRoot: string = `${homeDir()}/.cache/devc`,
): Promise<string> {
  return `${cacheRoot}/projects/${await projectKey(
    localFolder,
  )}/devcontainer.json`;
}

/**
 * The Feature lockfile `@devcontainers/cli` writes beside a config named `devcontainer.json`.
 * Nothing devc runs produces one any more — `buildUpArgs` passes `--no-lockfile` — so this only
 * ever finds one left by a devc old enough to have allowed it.
 *
 * Deleted rather than tolerated. With `--no-lockfile` the file is inert, but an inert file that
 * *looks* authoritative is worse than none: a stale one here is what silently pinned `agents`
 * and `node-nvmrc` to `0.1.0` long after they had declared their volumes, and it cost a whole
 * investigation pass to find (`.plans/pending/zero-config-feature-mounts.md`).
 *
 * Only devc's own per-project cache directory is ever touched. A `devcontainer-lock.json` in a
 * project's `.devcontainer/` belongs to that project — devc does not remove it, exactly as it
 * does not write one there.
 */
const LOCKFILE_NAME = 'devcontainer-lock.json';

/**
 * Path keys resolved relative to the config file's own directory by the devcontainer CLI
 * (`path.posix.resolve(dirname(configFilePath), value)` in 0.88.0), listed as
 * `[containing object, key]`.
 *
 * Only rewritten in `zero-config` mode, where the merged file itself becomes the config path and
 * a relative value would resolve into the cache directory beside it rather than into the
 * materialized default tree the value was written for. In `project` mode the CLI still records
 * the project's own config path, so relative values already resolve where the project meant —
 * rewriting them there would be wrong, not merely unnecessary.
 */
const RELATIVE_PATH_KEYS: readonly [string | null, string][] = [
  ['build', 'dockerfile'],
  ['build', 'context'],
  [null, 'dockerFile'],
  [null, 'context'],
];

/** `config` with its config-relative path values resolved against `baseDir`. */
function absolutizePaths(config: ConfigObject, baseDir: string): ConfigObject {
  const out: ConfigObject = { ...config };
  for (const [container, key] of RELATIVE_PATH_KEYS) {
    if (container === null) {
      if (typeof out[key] === 'string') {
        out[key] = resolvePosix(baseDir, out[key] as string);
      }
      continue;
    }
    const nested = out[container];
    if (
      typeof nested !== 'object' || nested === null || Array.isArray(nested)
    ) {
      continue;
    }
    const value = (nested as ConfigObject)[key];
    if (typeof value !== 'string') continue;
    out[container] = {
      ...(nested as ConfigObject),
      [key]: resolvePosix(baseDir, value),
    };
  }
  return out;
}

/** Write `text` to `path` at mode 0600, atomically within its directory. */
async function writeAtomic(path: string, text: string): Promise<void> {
  const dir = dirnamePosix(path);
  await mkdir(dir, { recursive: true });
  // pid + random so two devc processes — or two concurrent starts inside one — never share a
  // staging file. `rename` is atomic within a filesystem, so a reader (the CLI, reading the
  // config it was handed) sees one whole version or the other, never a half-written one.
  const staging = `${path}.tmp-${process.pid}-${
    Math.random().toString(36).slice(2, 10)
  }`;
  try {
    await writeFile(staging, text, { mode: 0o600 });
    await rename(staging, path);
  } finally {
    await rm(staging, { force: true }).catch(() => {});
  }
}

/** Overrides for {@link ensureMergedConfig}; every one defaults to a real path and is test-only. */
export interface MergedConfigOptions {
  /** Root of devc's cache, holding both `default-<key>/` and `projects/<key>/`. */
  cacheRoot?: string;
  /** The user's template overlay directory. */
  templatesDir?: string;
  /** The global config directory the user-level `devc.json` is read from. */
  configDir?: string;
  /** The home directory the host devc-bridge client is looked for under. */
  home?: string;
}

/**
 * Materialize the effective config for `localFolder` and return it.
 *
 * The layers, lowest to highest, are `devc → git-protect → base → user devc.json →
 * project devc.json`. devc's own two layers are computed from the merge of the other three (they
 * must not add a Feature something else already declares, and the repos to protect are only
 * knowable once every layer's `mounts` are in one array), so the merge runs twice: once to know
 * what is there, once to put devc's contributions underneath it. Underneath is what makes both
 * overridable — a user mount on a derived target wins through the `mounts` target dedupe. One consequence worth knowing: `null` deletions are resolved in the
 * first pass, so `"features": null` clears the *base's* Features while devc's baseline still
 * applies — `baselineFeatures: false` is what turns devc's own contributions off.
 *
 * Writes on every call, unconditionally. The content is a pure function of its inputs, so
 * concurrent callers write identical bytes; a call after an overlay edit is exactly the point.
 */
export async function ensureMergedConfig(
  localFolder: string,
  opts: MergedConfigOptions = {},
): Promise<MergedConfig> {
  const cacheRoot = opts.cacheRoot ?? `${homeDir()}/.cache/devc`;

  const ownConfig = await findOwnDevcontainerConfig(localFolder);
  const mode: ConfigMode = ownConfig === null ? 'zero-config' : 'project';
  const baseConfigPath = ownConfig ??
    await ensureDefaultConfig(cacheRoot, opts.templatesDir ?? TEMPLATES_DIR);

  const [base, overlays] = await Promise.all([
    loadConfigStrict(baseConfigPath),
    loadOverlays(localFolder, opts.configDir ?? CONFIG_DIR),
  ]);

  const provisional = mergeConfigs([base, ...overlays.layers]);
  // Before deriving anything: a compose project cannot carry `readonly` mounts at all, so
  // protection there would be a control that looks present and is not. Fails the run.
  assertGitProtectSupported(provisional);
  const gitProtect = readGitProtect(
    provisional[GIT_PROTECT_KEY],
    'the merged config',
  );
  const { protectedRows, unprotectedRows } = await classifyGitRows(
    provisional,
    localFolder,
  );
  const key = await projectKey(localFolder);
  const bridgeKey = declaresBridge(provisional) ? key : null;
  const bridgeClient = await bridgeClientDecision(
    provisional,
    opts.home ?? homeDir(),
  );
  const merged = stripDevcOnlyKeys(mergeConfigs([
    devcContributions(
      provisional,
      overlays.baselineFeatures,
      key,
      bridgeClient === BRIDGE_CLIENT_MOUNTED,
    ),
    gitProtectLayer(protectedRows),
    provisional,
  ]));

  const config = mode === 'zero-config'
    ? absolutizePaths(merged, dirnamePosix(baseConfigPath))
    : merged;

  const path = await mergedConfigPath(localFolder, cacheRoot);
  await writeAtomic(path, `${JSON.stringify(config, null, 2)}\n`);
  // See LOCKFILE_NAME. `force` so the (overwhelmingly common) already-absent case is not an
  // error, and so two concurrent devc processes cannot lose the race to each other.
  await rm(`${dirnamePosix(path)}/${LOCKFILE_NAME}`, { force: true }).catch(
    () => {},
  );

  return {
    path,
    config,
    mode,
    baseConfigPath,
    gitProtect,
    protectedRows,
    unprotectedRows,
    bridgeKey,
    bridgeClient,
  };
}
