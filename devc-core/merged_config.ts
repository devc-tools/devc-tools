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

import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import process from 'node:process';
import {
  ensureDefaultConfig,
  findOwnDevcontainerConfig,
  loadConfigStrict,
  TEMPLATES_DIR,
} from './default_config.ts';
import { type ConfigObject, mergeConfigs } from './merge.ts';
import { devcContributions, loadOverlays } from './overlay.ts';
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
}

/**
 * Materialize the effective config for `localFolder` and return it.
 *
 * The layers, lowest to highest, are `devc → base → user devc.json → project devc.json`. devc's
 * own layer is computed from the merge of the other three (it must not add a Feature something
 * else already declares), so the merge runs twice: once to know what is there, once to put devc's
 * contribution underneath it. One consequence worth knowing: `null` deletions are resolved in the
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
  const merged = mergeConfigs([
    devcContributions(provisional, overlays.baselineFeatures),
    provisional,
  ]);

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

  return { path, config, mode, baseConfigPath };
}
