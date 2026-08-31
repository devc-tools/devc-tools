import type { Dirent } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import process from 'node:process';
import { parse as parseJsoncLoose, type ParseError } from 'jsonc-parser';
import { basenamePosix } from './posix.ts';
import { isAlreadyExists, isDirectoryNotEmpty, isNotFound } from './errors.ts';
import { logWarning } from './log.ts';

// Embedded `devc-core/default/` directory, read via `node:fs/promises`. Under `deno run` /
// `node` from source this resolves to the real source tree; under a `deno compile --include
// default` binary it resolves to the embedded virtual filesystem, which `node:fs` reads
// unmodified — see `.plans/devc-core-npm-library.md`'s Validation section.
const DEFAULT_DIR_URL = new URL('./default/', import.meta.url);

/** The global config directory, `~/.config/devc`. */
export const CONFIG_DIR = `${homeDir()}/.config/devc`;

/**
 * User-level template directory, `~/.config/devc/templates`. A **sparse** overlay on the bundled
 * `default/` tree: any file placed here overrides the same-named bundled file, per file, in both
 * the zero-config cache ({@link ensureDefaultConfig}) and what `devc init` writes into a
 * project ({@link copyBundledAssets}).
 *
 * Never seeded. It stays absent until the user creates it and holds only the files they want to
 * change, so a `devc` upgrade keeps shipping its new defaults for everything else — the reason
 * this is an overlay rather than a one-time copy of the whole tree. Deleting a file from here
 * restores the bundled version on the next run.
 */
export const TEMPLATES_DIR = `${CONFIG_DIR}/templates`;

/**
 * Overlay filenames that must never ride the template layer into a devcontainer.
 *
 * `templates/` and the `devc.json` overlay are adjacent paths with opposite meanings, and the
 * mistake is an easy one: `templates/` holds files that are *copied into* a project's
 * `.devcontainer/` and run without `devc` installed, while the overlay is a devc-only layer read
 * from `CONFIG_DIR` and applied as `devcontainer up` flags at launch. A `devc.json` left in
 * `templates/` would be copied to `<project>/.devcontainer/devc.json` by
 * {@link copyBundledAssets} and read back as that project's *own* overlay — the highest-precedence
 * slot — putting one machine's bind mounts into every scaffolded repo.
 *
 * So it is skipped, and {@link overlayDirFrom} says so as a `warning` (stderr, by default —
 * see `log.ts`): silently dropping the file would
 * leave exactly the "why isn't my overlay working" that put it there.
 */
const TEMPLATE_OVERLAY_FILENAMES: readonly string[] = [
  'devc.json',
  'devc.jsonc',
];

/**
 * Host directory holding the user's `~/.claude` config for containers. Bind-mounted read-only
 * onto the `agents` Feature's fixed seed path
 * (`/usr/local/share/devc-features/agents/claude-seed`); that Feature's own `post-create.sh`
 * symlinks every top-level *file* from it into the `~/.claude` volume (directories are ignored
 * — the `devc:skills` fence owns `~/.claude/skills/`).
 */
export const CLAUDE_SEED_HOST_DIR = `${CONFIG_DIR}/.claude`;

/** Outcome of `ensureClaudeSeedDir`. */
export interface ClaudeSeedResult {
  /** True when this call created the directory (false when it already existed). */
  created: boolean;
}

/**
 * Create the host seed directory if absent, and report whether this call is what created it.
 *
 * The directory starts and stays **empty** — what reaches the container is whatever the user
 * puts here, and nothing else. Nothing is ever copied out of the host's real `~/.claude`: those
 * are that machine's personal settings, and silently republishing them into every container is
 * the user's call to make, not devc's. Earlier versions did copy three files in on first
 * creation, as a migration off the per-file bind mounts; that is gone, and a setup still on the
 * old shape moves its files across by hand (see the README).
 *
 * The bundled default's `initializeCommand` also creates this directory, so a project config
 * works without `devc` installed. This function still runs on every `up` because it owns the one
 * thing a shell one-liner cannot: the not-a-directory guard.
 *
 * `seedDir` defaults to the real path and only needs overriding in tests.
 */
export async function ensureClaudeSeedDir(
  seedDir: string = CLAUDE_SEED_HOST_DIR,
): Promise<ClaudeSeedResult> {
  // Whether we created it has to be decided before the mkdir: recursive mkdir succeeds
  // silently on an existing directory, so it cannot report the difference. lstat (not stat) so
  // a dangling symlink counts as present and falls into the guard below rather than looking
  // like a fresh creation.
  const created = await lstat(seedDir).then(() => false).catch(() => true);
  try {
    await mkdir(seedDir, { recursive: true });
  } catch (err) {
    // Recursive mkdir is not quite `mkdir -p`: it reports AlreadyExists when the path is a
    // regular file or a dangling symlink. Fall through to the guard, which says why.
    if (!isAlreadyExists(err)) throw err;
  }

  // Verify we actually have a directory — otherwise the problem resurfaces later as an opaque
  // "bind source path does not exist" from Docker.
  const info = await stat(seedDir).catch(() => null);
  if (info === null || !info.isDirectory()) {
    throw new Error(
      `${seedDir} exists but is not a directory (expected the devc ~/.claude config folder)`,
    );
  }
  return { created };
}

/**
 * Path to `localFolder`'s own devcontainer config (`.devcontainer/devcontainer.json`, else
 * `.devcontainer.json`) — i.e. "project mode" — or `null` when it has none and the zero-config
 * path applies.
 *
 * Returns the *path*, not just a boolean, because callers need to read the config that is
 * actually in play: `remoteEnv` has to come from the project's own file in project mode, and a
 * boolean left no way to reach it (see {@link loadResolvedRemoteEnv}).
 */
export async function findOwnDevcontainerConfig(
  localFolder: string,
): Promise<string | null> {
  for (const rel of ['.devcontainer/devcontainer.json', '.devcontainer.json']) {
    const path = `${localFolder}/${rel}`;
    try {
      await stat(path);
      return path;
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }
  return null;
}

function homeDir(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? '.';
}

/** Recursively copies the embedded `default/` tree to a real directory on disk. */
async function copyDir(sourceUrl: URL, destDir: string): Promise<void> {
  await mkdir(destDir, { recursive: true });
  const entries = await readdir(sourceUrl, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      await copyDir(
        new URL(`${entry.name}/`, sourceUrl),
        `${destDir}/${entry.name}`,
      );
    } else {
      const bytes = await readFile(new URL(entry.name, sourceUrl));
      await writeFile(`${destDir}/${entry.name}`, bytes);
    }
  }
}

/**
 * Recursively copies a real on-disk directory over `destDir`, overwriting per file and recursing
 * into subdirectories. Files already in `destDir` that the source does not have are left alone —
 * this is an overlay, not a mirror. A missing `sourceDir` is a silent no-op.
 *
 * This is the *only* mechanism the template layer has, so every caller passes
 * {@link TEMPLATES_DIR} as `sourceDir` and the {@link TEMPLATE_OVERLAY_FILENAMES} guard lives
 * here rather than at the call sites. It applies at the top level only: a nested
 * `scripts/devc.json` is an ordinary data file with no overlay meaning. `topLevel` is internal to
 * the recursion and should not be passed.
 *
 * `copyFile` rather than read+write: unlike {@link copyDir}'s embedded-asset path, this
 * copies from a real filesystem where the user's own modes are worth preserving.
 */
async function overlayDirFrom(
  sourceDir: string,
  destDir: string,
  topLevel = true,
): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(sourceDir, { withFileTypes: true });
  } catch (err) {
    // A missing template dir is the common case — it is never seeded.
    if (isNotFound(err)) return;
    throw err;
  }

  await mkdir(destDir, { recursive: true });
  for (const entry of entries) {
    if (
      topLevel && !entry.isDirectory() &&
      TEMPLATE_OVERLAY_FILENAMES.includes(entry.name)
    ) {
      logWarning(
        `devc: ignoring ${sourceDir}/${entry.name} — the devc.json overlay is read from ` +
          `${CONFIG_DIR}/devc.jsonc, not from the templates directory (which holds files copied ` +
          `into a project's .devcontainer/). Move it up one level to apply it to every project.`,
      );
      continue;
    }
    if (entry.isDirectory()) {
      await overlayDirFrom(
        `${sourceDir}/${entry.name}`,
        `${destDir}/${entry.name}`,
        false,
      );
    } else {
      await copyFile(
        `${sourceDir}/${entry.name}`,
        `${destDir}/${entry.name}`,
      );
    }
  }
}

/**
 * Copies the embedded `devc-core/default/` tree into `cacheDir` (default
 * `~/.cache/devc/default`), overwriting any existing copy, overlays any user
 * {@link TEMPLATES_DIR} files on top of it per file, and returns the path to the copied
 * `devcontainer.json` — suitable for `devcontainer up --config <path>`.
 *
 * The steps are ordered, and the order is load-bearing:
 *
 * 1. Remove the prior copy, so a file dropped between versions does not linger forever.
 * 2. Copy the embedded tree.
 * 3. Overlay `templatesDir`, per file — so deleting a template restores the bundled version.
 * 4. Apply the `initializeCommand` path rewrite below, *after* the overlay, so a
 *    user-supplied `templates/devcontainer.json` gets it too. It is a `replaceAll` of an
 *    exact token, so a template that rewrote that line itself simply no-ops.
 *
 * The copy is near-verbatim: the bundled default carries no local Feature, so
 * zero-config and `devc config` projects share the same `.devcontainer/` shape. The baseline
 * is delivered by Features declared in the config itself (`agents`, `git-container-config`)
 * plus the bundled `Dockerfile` for its base image, both of which the source config already
 * spells out. `@devcontainers/cli` accepts JSONC, so the copied config keeps its comments.
 *
 * One path rewrite is applied, because `initializeCommand` is referenced relative to a
 * project `.devcontainer/` that does not exist in the zero-config path (the workspace is the
 * user's project, and this cache dir is not mounted into the container): it runs on the
 * *host* → resolved to `initialize-command.sh` in the directory this tree will finally live
 * in (`opts.finalDir`, defaulting to `cacheDir`). `postCreateCommand` needs no equivalent
 * rewrite — it is delivered by Features now, which resolve their own paths at create time,
 * not by a script referenced relative to a project `.devcontainer/`.
 *
 * The plain string replace preserves the config's comments; the token matches the source
 * verbatim. It is why the project-mode config can reference a clean in-project
 * `initialize-command.sh` (so edits apply on recreate) while the hidden zero-config copy
 * still resolves.
 *
 * Writes **unconditionally**, to exactly the directory it is handed. That is the whole of its
 * contract, and it is what makes it directly testable. Production code does not call it: the
 * zero-config path goes through {@link ensureDefaultConfig}, whose content-addressed cache is
 * what keeps two processes (or two projects) from rewriting one shared directory under each
 * other.
 *
 * `cacheDir` / `templatesDir` default to the real `~/.cache/devc/default` and
 * {@link TEMPLATES_DIR}, and only need overriding in tests. `opts.finalDir` is for the staging
 * case — see its own note below.
 */
export async function materializeDefaultConfig(
  cacheDir: string = `${homeDir()}/.cache/devc/default`,
  templatesDir: string = TEMPLATES_DIR,
  opts: {
    /**
     * The directory this tree will live in once it is in place; the `initializeCommand` rewrite
     * resolves against it rather than against `cacheDir`. Defaults to `cacheDir`, so a caller
     * that writes straight to the final location — every caller before
     * {@link ensureDefaultConfig} existed, and every existing test — is unaffected.
     *
     * Set it when materializing into a staging directory that will be renamed into place: the
     * baked `initializeCommand` path is absolute, so a tree written under `.tmp-…/` and renamed
     * would point `initializeCommand` at a directory that no longer exists. The final path is
     * known before the write (it is a pure function of the inputs), which is what makes passing
     * it in possible at all.
     */
    finalDir?: string;
  } = {},
): Promise<string> {
  const finalDir = opts.finalDir ?? cacheDir;

  // Remove any prior copy so files dropped between versions don't linger.
  await rm(cacheDir, { recursive: true, force: true }).catch(() => {});
  await copyDir(DEFAULT_DIR_URL, cacheDir);
  await overlayDirFrom(templatesDir, cacheDir);

  const configPath = `${cacheDir}/devcontainer.json`;
  const raw = await readFile(configPath, 'utf8');
  const rewritten = raw.replaceAll(
    '${localWorkspaceFolder}/.devcontainer/initialize-command.sh',
    `${finalDir}/initialize-command.sh`,
  );
  if (rewritten !== raw) await writeFile(configPath, rewritten);

  return configPath;
}

/**
 * Every file under a directory, as relative posix paths sorted lexicographically.
 *
 * Sorted **globally**, over the full relative path, rather than per directory as the recursion
 * descends: it is the one ordering that does not depend on how the walk happens to interleave
 * files and subdirectories, and the key below is only stable if the order is.
 *
 * `readdir` returns entries in whatever order the filesystem hands them over — insertion order on
 * ext4, roughly alphabetical on APFS, arbitrary on a `deno compile` VFS — so nothing here may
 * depend on it.
 */
async function listTreeUrl(root: URL, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      out.push(
        ...await listTreeUrl(
          new URL(`${entry.name}/`, root),
          `${prefix}${entry.name}/`,
        ),
      );
    } else {
      out.push(`${prefix}${entry.name}`);
    }
  }
  return prefix === '' ? out.sort() : out;
}

/**
 * {@link listTreeUrl} for a real on-disk directory. A missing directory contributes nothing —
 * {@link TEMPLATES_DIR} is never seeded, so its absence is the common case, not an error.
 */
async function listTreeDir(root: string, prefix = ''): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (err) {
    if (isNotFound(err)) return [];
    throw err;
  }
  const out: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      out.push(
        ...await listTreeDir(
          `${root}/${entry.name}`,
          `${prefix}${entry.name}/`,
        ),
      );
    } else {
      out.push(`${prefix}${entry.name}`);
    }
  }
  return prefix === '' ? out.sort() : out;
}

/** Separates a file's path from its bytes in the key's hash stream. */
const KEY_SEPARATOR = new Uint8Array([0]);

/**
 * The cache key for a materialized default config: `sha256`, hex, first 12 chars, over — in this
 * order — every file of the bundled `default/` tree and every file of `templatesDir`. Each file
 * contributes its posix relative path, a `NUL`, then its bytes.
 *
 * **Everything that changes the output must be in here.** {@link ensureDefaultConfig} skips the
 * write entirely on a hit, so an input outside the key is an input the user can change with no
 * visible effect — which is why `templatesDir` is hashed and not merely defaulted. That is the
 * one way to get this design wrong.
 *
 * The path, the `NUL` and the sorted order are all load-bearing: without the path a file rename
 * would not register, without the separator `ab`+`c` and `a`+`bc` would collide, and without the
 * sort the key would depend on filesystem enumeration order and differ machine to machine.
 *
 * 12 hex chars is 48 bits. This is a cache key over a handful of directories on one machine, not
 * a security boundary — a collision needs ~16M distinct devc/template combinations before it is
 * even worth thinking about, and the cost of one would be a stale config, not a compromise.
 */
async function defaultConfigKey(templatesDir: string): Promise<string> {
  const hash = createHash('sha256');
  for (const rel of await listTreeUrl(DEFAULT_DIR_URL)) {
    hash.update(rel);
    hash.update(KEY_SEPARATOR);
    hash.update(await readFile(new URL(rel, DEFAULT_DIR_URL)));
  }
  for (const rel of await listTreeDir(templatesDir)) {
    hash.update(rel);
    hash.update(KEY_SEPARATOR);
    hash.update(await readFile(`${templatesDir}/${rel}`));
  }
  return hash.digest('hex').slice(0, 12);
}

/**
 * The content-addressed zero-config cache, and what the lifecycle actually calls. Returns the
 * path to a materialized `devcontainer.json` for the current bundled `default/` tree and
 * templates — writing **nothing** when a directory for those inputs already exists.
 *
 * This exists because the obvious implementation — {@link materializeDefaultConfig} straight into
 * one shared `~/.cache/devc/default` on every start — is a shared mutable path, and three
 * separate problems fall out of it:
 *
 * - A per-project input (the devc-bridge opt-in, back when it was spliced in here) was resolved
 *   from that project's overlay while the directory was shared across *all* of them, so two
 *   projects wrote different content to the same file. Nothing varies per project in this tree
 *   any more — the overlay is merged in `merged_config.ts` now — but the hazard is the reason
 *   the cache is keyed rather than shared.
 * - Two copies of core on one machine (an installed `devc` binary and a library consumer's
 *   embedded copy) each carry their own bundled `default/`. Alternating between them rewrote the
 *   config under the other, which `devcontainer up` reads as a changed config — a container
 *   rebuild from nothing the user did.
 * - The unconditional `rm -rf` could land while another process's `devcontainer up` was reading
 *   that same config.
 *
 * Keying the directory by its inputs closes all three at once: distinct versions and template
 * revisions get distinct directories, so nothing clobbers anything; `rename` is
 * atomic within a filesystem, so no reader ever sees a half-written tree; and identical inputs
 * give an identical path, so the absolute `initialize-command.sh` baked into the config is stable
 * and nothing rebuilds spuriously.
 *
 * It is also cheaper than what it replaces. Every `up` — and every `execInContainer`, which goes
 * through `startContainer` — used to pay an `rm -rf` plus a full tree copy. A hit is now a hash
 * and a `stat`.
 *
 * The miss path stages into a sibling `.tmp-<pid>-<rand>/` and `rename`s it onto the target.
 * Losing that `rename` to another process is a success, not a failure: it won, its tree is
 * complete and byte-identical (same key, same inputs), so the staging copy is simply discarded.
 *
 * `cacheRoot` holds *many* `default-<key>/` directories — it is the parent, unlike
 * {@link materializeDefaultConfig}'s `cacheDir`, which is one materialized tree. Both it and
 * `templatesDir` default to the real paths and only need overriding in tests.
 */
export async function ensureDefaultConfig(
  cacheRoot: string = `${homeDir()}/.cache/devc`,
  templatesDir: string = TEMPLATES_DIR,
): Promise<string> {
  const target = `${cacheRoot}/default-${await defaultConfigKey(templatesDir)}`;
  const configPath = `${target}/devcontainer.json`;

  // The hit test is on the config file rather than the directory, so a tree left half-written by
  // something other than this function (an interrupted older devc, a manual `cp`) does not read
  // as a hit. Within this function a partial tree is unreachable by construction — `rename` is
  // atomic — but the cache root outlives any one version of this code.
  try {
    await stat(configPath);
    return configPath;
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }

  // Staged as a *sibling* of the target, which is what makes the `rename` a same-filesystem
  // metadata operation rather than a copy. pid + random so two processes — or two concurrent
  // starts inside one process — never share a staging directory.
  await mkdir(cacheRoot, { recursive: true });
  const staging = `${cacheRoot}/.tmp-${process.pid}-${
    Math.random().toString(36).slice(2, 10)
  }`;
  try {
    // `finalDir` is the trap this whole function has to avoid: the tree is written under
    // `staging` but its `initializeCommand` must name `target`, which will not exist until the
    // `rename` below succeeds.
    await materializeDefaultConfig(staging, templatesDir, {
      finalDir: target,
    });
    try {
      await rename(staging, target);
    } catch (err) {
      // Another process materialized the same key between our `stat` and our `rename`. Its tree
      // is complete and identical to ours, so there is nothing to do but drop ours — overwriting
      // would reintroduce exactly the write-under-a-reader race this design removes.
      if (!isAlreadyExists(err) && !isDirectoryNotEmpty(err)) throw err;
    }
  } finally {
    // A no-op after a successful `rename`; the cleanup that matters is the lost-race and
    // thrown-partway cases, neither of which should leave a `.tmp-` directory behind.
    await rm(staging, { recursive: true, force: true }).catch(() => {});
  }

  return configPath;
}

/**
 * True when `features` declares a Feature whose id names `name`, by any spelling.
 *
 * Matched on the id's last path segment with the tag stripped, so `…/<name>`, `…/<name>:0`,
 * `:1`, a pinned `:0.1.0` and a local `./features/<name>` all count. A registry other than
 * ghcr.io/devc-tools/features counts too — a Feature *named* `name` means the same thing whoever
 * published it, and guessing otherwise would silently miss it.
 */
export function declaresFeatureNamed(
  features: Record<string, unknown>,
  name: string,
): boolean {
  return Object.keys(features).some((id) => {
    // Strip an OCI tag, but not a `:` that belongs to a path or a port.
    const colon = id.lastIndexOf(':');
    const untagged = colon >= 0 && !id.slice(colon + 1).includes('/')
      ? id.slice(0, colon)
      : id;
    return untagged.replace(/\/+$/, '').split('/').pop() === name;
  });
}

/**
 * True when `features` opts into the devc-bridge Feature, by any spelling — a Feature *named*
 * devc-bridge needs the token mount regardless of who published it. A thin wrapper over
 * {@link declaresFeatureNamed}, kept because callers reach for "does this opt into the bridge"
 * more directly than the general question. The mount itself is contributed by
 * {@link import("./overlay.ts").devcContributions}.
 */
export function declaresBridgeFeature(
  features: Record<string, unknown>,
): boolean {
  return declaresFeatureNamed(features, 'devc-bridge');
}

/**
 * Copy the whole embedded `default/` tree into `destDir` (a project's `.devcontainer/`) — the
 * `devcontainer.json`, the `Dockerfile`, and the `initialize-command.sh` lifecycle entry
 * script — then overlay `templatesDir` on top, per file, so a user's own `Dockerfile` or
 * `devcontainer.json` reaches project mode too.
 *
 * Every bundled file goes through the same two steps, `devcontainer.json` included. It used to be
 * excluded here and written separately by the caller, back when `devc config` spliced its managed
 * mount fences into the text on first creation; those fences now live in the `devc.json` overlay,
 * so nothing needs the config as an editable string on the way in and the exception bought only a
 * second code path to keep in sync.
 */
export async function copyBundledAssets(
  destDir: string,
  templatesDir: string = TEMPLATES_DIR,
): Promise<void> {
  await copyDir(DEFAULT_DIR_URL, destDir);
  await overlayDirFrom(templatesDir, destDir);
}

/**
 * Copy the bundled assets into `destDir` (a project's `.devcontainer/`) via
 * {@link copyBundledAssets}, then restore the exec bit on the one lifecycle entry script left.
 * Returns the top-level paths written, in a stable order (`devcontainer.json` first), for
 * callers that report them.
 *
 * `copyBundledAssets` writes files 0644, so the chmod is what lets a dev run the script by
 * hand (invoked as `bash "<path>"` by `initializeCommand`, so this is cleanliness rather than
 * correctness).
 */
export async function installBundledAssets(
  destDir: string,
  templatesDir: string = TEMPLATES_DIR,
): Promise<string[]> {
  await copyBundledAssets(destDir, templatesDir);

  await chmod(`${destDir}/initialize-command.sh`, 0o755);

  return [
    `${destDir}/devcontainer.json`,
    `${destDir}/Dockerfile`,
    `${destDir}/initialize-command.sh`,
  ];
}

/**
 * Substitutes `devcontainer.json`-style variables in a string value:
 * `${containerWorkspaceFolder}`, `${localEnv:VARNAME}`, and — when
 * `localWorkspaceFolder` is supplied — `${localWorkspaceFolder}` and
 * `${localWorkspaceFolderBasename}`. Anything else (`${containerEnv:...}`,
 * `${devcontainerId}`, …) is left as-is: values passed directly to Docker (e.g. `-e`) are
 * never processed by the `devcontainer` CLI, and the rest cannot be resolved host-side.
 *
 * `containerWorkspaceFolder` is the caller-supplied container-side mount path — the
 * `remoteWorkspaceFolder` reported by `devcontainer up`, which accounts for both plain
 * workspaces and git worktrees.
 */
export function substituteVars(
  value: string,
  containerWorkspaceFolder: string,
  localWorkspaceFolder?: string,
): string {
  let out = value.replaceAll(
    '${containerWorkspaceFolder}',
    containerWorkspaceFolder,
  );
  if (localWorkspaceFolder !== undefined) {
    // Basename first: `${localWorkspaceFolder}` is a prefix of
    // `${localWorkspaceFolderBasename}`, so the other order would rewrite the longer token
    // into `<path>Basename}`.
    out = out
      .replaceAll(
        '${localWorkspaceFolderBasename}',
        basenamePosix(localWorkspaceFolder),
      )
      .replaceAll('${localWorkspaceFolder}', localWorkspaceFolder);
  }
  return out.replace(/\$\{localEnv:([^}]+)\}/g, (_, varName: string) => {
    return varName === 'HOME' ? homeDir() : process.env[varName] ?? '';
  });
}

/**
 * Parse the devcontainer config at `configPath` as JSONC, throwing an error naming the file when
 * it cannot be read or is not a JSON object.
 *
 * **Deliberately unforgiving**, unlike the forgiving reads this replaced. The result is a layer
 * of the merge that produces the effective config (see `merged_config.ts`), and a config devc
 * failed to read is a container built from something other than what the project asked for —
 * worse than refusing to start. `jsonc-parser` accepts comments and trailing commas, so a failure
 * here is malformed JSON that `devcontainer up` would reject seconds later anyway.
 */
export async function loadConfigStrict(
  configPath: string,
): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readFile(configPath, 'utf8');
  } catch (err) {
    throw new Error(
      `${configPath}: could not be read (${
        err instanceof Error ? err.message : err
      })`,
    );
  }

  const errors: ParseError[] = [];
  const parsed = parseJsoncLoose(text, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    const [first] = errors;
    throw new Error(
      `${configPath}: could not parse as JSONC (error ${first.error} at offset ${first.offset})`,
    );
  }
  // An empty file parses to `undefined`; a config has to be an object to merge at all.
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${configPath}: expected a JSON object at the top level`);
  }
  return parsed as Record<string, unknown>;
}

/**
 * `config`'s `remoteEnv`, with the variables {@link substituteVars} handles resolved in each
 * value. Returns `{}` when it declares none.
 *
 * This is what makes `remoteEnv` reach `devc exec`/`attach`: those run via `docker exec`, which
 * applies the container's `containerEnv` but never `remoteEnv` — `remoteEnv` is applied by the
 * *client* per connection (VS Code to its terminals, `devcontainer exec` to its child) and is not
 * stored on the container for anyone to inherit. So devc re-derives it.
 *
 * `config` is the **merged** config — the one `devcontainer up` was actually given — so the
 * overlay's own `remoteEnv` is already folded in and there is no second layer to apply here.
 * Non-string values are skipped (the spec says strings).
 *
 * This is the one place devc still substitutes `${…}` itself, because these values are handed to
 * `docker exec` rather than to the devcontainer CLI, which never sees them.
 */
export function resolveRemoteEnv(
  config: Record<string, unknown>,
  containerWorkspaceFolder: string,
  localWorkspaceFolder?: string,
): Record<string, string> {
  const baseEnv = config.remoteEnv;
  if (
    typeof baseEnv !== 'object' || baseEnv === null || Array.isArray(baseEnv)
  ) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(baseEnv)
      .filter((entry): entry is [string, string] =>
        typeof entry[1] === 'string'
      )
      .map(([k, v]) => [
        k,
        substituteVars(v, containerWorkspaceFolder, localWorkspaceFolder),
      ]),
  );
}
