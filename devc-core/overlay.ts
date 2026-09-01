// The `devc.json` overlay: an optional, devc-only file contributing `devcontainer.json` keys on
// top of whichever `devcontainer.json` is in play.
//
// The governing invariant: **whatever lands in `.devcontainer/` must run without `devc` installed
// at all.** Nothing in this module writes to a project's `devcontainer.json`; the overlay is
// merged into an effective config materialized under `~/.cache/devc/` (see `merged_config.ts`)
// and the project's own files are never touched. A checkout without `devc` still builds and runs
// from the standard config; it just does not get the overlay's contributions. Un-augmented, not
// broken.
//
// The overlay serves two equally valid shapes, and neither is canonical:
//
// - **Committed** — the repo has adopted `devc` as a tool it depends on.
// - **Gitignored** — an individual dev adds bind mounts for their own machine, in a repo that
//   need not know `devc` exists. Because the overlay is invisible to the repo, the
//   `.devcontainer/` everyone else checks out is untouched by definition.

import { readFile, stat } from 'node:fs/promises';
import { parse as parseJsoncLoose, type ParseError } from 'jsonc-parser';
import { CONFIG_DIR, declaresFeatureNamed } from './default_config.ts';
import { isNotADirectory, isNotFound } from './errors.ts';
import { logWarning } from './log.ts';
import { type ConfigObject, mountTarget, REPLACE_KEY } from './merge.ts';

/**
 * Parse JSONC (comments and trailing commas both allowed), throwing when `jsonc-parser`
 * reports any real problem. `allowTrailingComma` is what keeps a trailing comma out of the
 * error list — without it, `jsonc-parser` still recovers a value but also reports the comma
 * itself as an error, which would make a spec-legal file fail here.
 */
function parseJsonc(text: string): unknown {
  const errors: ParseError[] = [];
  const value = parseJsoncLoose(text, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    const [first] = errors;
    throw new SyntaxError(
      `JSONC parse error ${first.error} at offset ${first.offset}`,
    );
  }
  return value;
}

/** One loaded overlay file: its config layer, and the one devc-only key. */
export interface DevcOverlay {
  /**
   * The `devcontainer.json` keys this file contributes, as written — no substitution, no
   * normalization. Merged as one layer by {@link import("./merge.ts").mergeConfigs}, so it may
   * also carry that module's `$replace` directive.
   */
  config: ConfigObject;
  /**
   * False disables every Feature devc contributes on its own (see {@link devcContributions}).
   * Default `true`. The one overlay key that is *not* a `devcontainer.json` key and never
   * reaches the merged config.
   *
   * Also the one key where the project does **not** win: the effective value is
   * `user && project` — a **veto**, not "more specific wins". The user-level file belongs to the
   * machine's owner, and a repo talking a machine back into running devc's baseline after the
   * owner turned it off is not a thing anyone asked for. A project *can* turn it off even when
   * the user left it on, same as any other opt-out.
   */
  baselineFeatures: boolean;
}

/** The devc-only keys an overlay may carry. Everything else must be a `devcontainer.json` key. */
const DEVC_ONLY_KEYS = ['baselineFeatures', REPLACE_KEY] as const;

/**
 * Every key a `devcontainer.json` may carry, including the three deprecated top-level VS Code
 * ones the CLI still migrates (`extensions`, `settings`, `devPort`).
 *
 * This is a **typo guard, not a schema**: an unknown key warns and is passed through to the
 * merged config, where the CLI ignores it. It exists because the overlay went from four known
 * keys to the whole spec, and losing "you wrote `mount`, not `mounts`" with it would have been a
 * real cost.
 */
const KNOWN_CONFIG_KEYS: readonly string[] = [
  'name',
  'image',
  'build',
  'dockerFile',
  'context',
  'dockerComposeFile',
  'service',
  'runServices',
  'workspaceFolder',
  'workspaceMount',
  'runArgs',
  'overrideCommand',
  'shutdownAction',
  'init',
  'privileged',
  'capAdd',
  'securityOpt',
  'mounts',
  'features',
  'overrideFeatureInstallOrder',
  'containerEnv',
  'remoteEnv',
  'containerUser',
  'remoteUser',
  'updateRemoteUserUID',
  'userEnvProbe',
  'forwardPorts',
  'portsAttributes',
  'otherPortsAttributes',
  'appPort',
  'initializeCommand',
  'onCreateCommand',
  'updateContentCommand',
  'postCreateCommand',
  'postStartCommand',
  'postAttachCommand',
  'waitFor',
  'customizations',
  'hostRequirements',
  'extensions',
  'settings',
  'devPort',
];

/**
 * Project-level overlay locations, relative to the project folder, in first-hit-wins order.
 *
 * Both directories are first-class and behave identically. `.devcontainer/devc.json` often suits
 * a gitignored local override — one file to ignore, sitting beside the config it overlays —
 * while `.devc/` suits a repo that wants `devc`'s files grouped in one place.
 */
const PROJECT_CANDIDATES = [
  '.devc/devc.jsonc',
  '.devc/devc.json',
  '.devcontainer/devc.jsonc',
  '.devcontainer/devc.json',
] as const;

/** User-level overlay filenames, relative to the global config dir, in first-hit-wins order. */
const USER_CANDIDATES = ['devc.jsonc', 'devc.json'] as const;

/** An overlay contributing nothing. `baselineFeatures` defaults `true`, as a file omitting it does. */
export function emptyOverlay(): DevcOverlay {
  return { config: {}, baselineFeatures: true };
}

async function firstExisting(paths: readonly string[]): Promise<string | null> {
  for (const path of paths) {
    try {
      await stat(path);
      return path;
    } catch (err) {
      // `NotADirectory` is the same answer as `NotFound` here: a candidate whose parent is a
      // regular file (a project with a `.devcontainer` *file*) has no overlay at that path.
      // Anything else — a permissions failure, say — is a real problem and still throws.
      if (!isNotFound(err) && !isNotADirectory(err)) throw err;
    }
  }
  return null;
}

/**
 * Path of `localFolder`'s project overlay — `.devc/devc.jsonc`, `.devc/devc.json`,
 * `.devcontainer/devc.jsonc`, `.devcontainer/devc.json`, first hit wins — or `null` when it has
 * none. Only the winner is ever read; the losers are *not* merged.
 */
export function findProjectOverlayPath(
  localFolder: string,
): Promise<string | null> {
  return firstExisting(
    PROJECT_CANDIDATES.map((rel) => `${localFolder}/${rel}`),
  );
}

/** Where `devc config` will write, and whether that file has to be created first. */
export interface OverlayTarget {
  /** Absolute path of the overlay file to write. */
  path: string;
  /** True when nothing is there yet and the file must be seeded. */
  creating: boolean;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The overlay file `devc config` should write for `localFolder`.
 *
 * An existing overlay always wins, in {@link findProjectOverlayPath}'s order — devc never
 * creates a second overlay beside one that is already there, since only the first hit is ever
 * read and the loser would silently do nothing.
 *
 * With none present, the new file goes beside the config it overlays (`.devcontainer/`) when
 * that directory exists, and into `.devc/` otherwise. The second case is what lets `devc config`
 * work on a zero-config project: recording a mount must not drag in a whole `.devcontainer/`
 * the user would then have to maintain.
 */
export async function resolveProjectOverlayTarget(
  localFolder: string,
): Promise<OverlayTarget> {
  const existing = await findProjectOverlayPath(localFolder);
  if (existing !== null) return { path: existing, creating: false };
  const dir = (await isDirectory(`${localFolder}/.devcontainer`))
    ? '.devcontainer'
    : '.devc';
  return { path: `${localFolder}/${dir}/devc.jsonc`, creating: true };
}

/**
 * Path of the user-level overlay — `~/.config/devc/devc.jsonc` then
 * `~/.config/devc/devc.json` — or `null` when neither exists. `configDir` defaults to the real
 * global config dir and only needs overriding in tests.
 */
export function findUserOverlayPath(
  configDir: string = CONFIG_DIR,
): Promise<string | null> {
  return firstExisting(USER_CANDIDATES.map((name) => `${configDir}/${name}`));
}

function typeError(path: string, detail: string): Error {
  return new Error(`${path}: ${detail}`);
}

/**
 * True when `text` contains nothing but whitespace and comments — a stub file the user created
 * and has not filled in yet, which is "no overlay" rather than a syntax error.
 *
 * The comment stripping is naive (it does not respect string literals), which is fine for this
 * question alone: any file with a real token keeps at least one character — a string literal's
 * own quote survives the `//`-to-end-of-line cut — so a file with content never reads as blank.
 */
function isTokenFree(text: string): boolean {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .trim() === '';
}

/**
 * Shape-check `mounts`, whose only job is a better error than Docker's.
 *
 * Deliberately *loose*: overlay mounts land in the merged config's `mounts` array, where the
 * full `devcontainer.json` vocabulary applies — `readonly`, `consistency`, object form, any
 * field order. (They used to become `devcontainer up --mount` args, whose grammar is a strict
 * subset, and devc validated against the CLI's own regex so a rejected spec could name the file.
 * That constraint is gone with the flag.) So this checks only that an entry could name a mount
 * at all; everything past that is Docker's to complain about, in Docker's own vocabulary.
 */
function checkMounts(path: string, value: unknown): void {
  if (!Array.isArray(value)) {
    throw typeError(path, '"mounts" must be an array of mount specs');
  }
  value.forEach((entry, i) => {
    if (
      typeof entry !== 'string' && (typeof entry !== 'object' || entry === null)
    ) {
      throw typeError(path, `"mounts"[${i}] must be a string or an object`);
    }
    if (mountTarget(entry) === null) {
      throw typeError(
        path,
        `"mounts"[${i}] (${
          typeof entry === 'string' ? entry : JSON.stringify(entry)
        }): no mount target — a string spec needs a "target=" field, an object form a "target" property`,
      );
    }
  });
}

/**
 * Unlike a malformed `mounts`, a malformed `baselineFeatures` **warns and is ignored** (falling
 * back to the default `true`) rather than failing the load. `mounts` is a hard error because
 * silently starting a container missing a mount is worse than refusing to start; a mistyped
 * `baselineFeatures` has no such asymmetry — either value is a container that comes up, so there
 * is nothing here worth failing over.
 */
function readBaselineFeatures(path: string, value: unknown): boolean {
  if (typeof value !== 'boolean') {
    logWarning(
      `devc: ignoring non-boolean "baselineFeatures" in ${path} (must be true or false) — defaulting to true`,
    );
    return true;
  }
  return value;
}

/**
 * Parse one overlay file, whatever its extension: both `.json` and `.jsonc` go through
 * `parseJsonc`, so the suffix is naming convention only.
 *
 * Parsing is deliberately *unforgiving*. This file exists only for `devc`, is small and
 * hand-written, and its whole purpose is to change how a container comes up: silently starting
 * one without its contributions is worse than a hard error naming the file. Unknown top-level
 * keys are the one exception — those warn and are passed through, so a typo like `"mount"` is
 * visible without being fatal.
 *
 * A file with no JSON tokens at all — empty, whitespace, or only comments, i.e. one a user has
 * created but not filled in — counts as no overlay rather than an error. It has to be caught
 * before `parseJsonc`, which reports "unexpected end of JSONC input" for it exactly as it does
 * for a genuinely truncated file.
 */
export async function loadOverlayFile(path: string): Promise<DevcOverlay> {
  const text = await readFile(path, 'utf8');
  if (isTokenFree(text)) return emptyOverlay();

  let parsed: unknown;
  try {
    parsed = parseJsonc(text);
  } catch (err) {
    throw typeError(
      path,
      `could not parse as JSONC (${err instanceof Error ? err.message : err})`,
    );
  }

  // `parseJsonc` yields `null` for an empty (or whitespace/comment-only) file.
  if (parsed === null || parsed === undefined) return emptyOverlay();
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw typeError(path, 'expected a JSON object at the top level');
  }

  const raw = parsed as ConfigObject;
  for (const key of Object.keys(raw)) {
    if (
      !KNOWN_CONFIG_KEYS.includes(key) &&
      !(DEVC_ONLY_KEYS as readonly string[]).includes(key)
    ) {
      logWarning(
        `devc: unknown key "${key}" in ${path} — not a devcontainer.json key, so it will have no effect`,
      );
    }
  }
  if (raw.mounts !== undefined) checkMounts(path, raw.mounts);

  const { baselineFeatures, ...config } = raw;
  return {
    config,
    baselineFeatures: baselineFeatures === undefined
      ? true
      : readBaselineFeatures(path, baselineFeatures),
  };
}

/** The overlay layers for one project, plus the effective `baselineFeatures`. */
export interface DevcOverlays {
  /**
   * Config layers to merge, **lowest first**: the user-level file, then the project one.
   *
   * They stay separate rather than being pre-merged because the merge is not associative in
   * the way that would need: a project's `$replace` must replace what the base config *and* the
   * user overlay said, which only holds if the base is already in the fold when the project
   * layer lands.
   */
  layers: ConfigObject[];
  /** `user && project` — see {@link DevcOverlay.baselineFeatures} for why this one is a veto. */
  baselineFeatures: boolean;
}

/**
 * The overlay layers for `localFolder`: the user-level file, then the project-level one. Applies
 * in *both* modes — a project with its own `devcontainer.json` gets the overlay just as the
 * zero-config path does.
 *
 * `configDir` defaults to the real `~/.config/devc` and only needs overriding in tests.
 */
export async function loadOverlays(
  localFolder: string,
  configDir: string = CONFIG_DIR,
): Promise<DevcOverlays> {
  const [userPath, projectPath] = await Promise.all([
    findUserOverlayPath(configDir),
    findProjectOverlayPath(localFolder),
  ]);
  const [user, project] = await Promise.all([
    userPath === null ? emptyOverlay() : loadOverlayFile(userPath),
    projectPath === null ? emptyOverlay() : loadOverlayFile(projectPath),
  ]);
  return {
    layers: [user.config, project.config],
    baselineFeatures: user.baselineFeatures && project.baselineFeatures,
  };
}

/**
 * The `devc-config` Feature devc contributes to every container it starts — dynamically, via
 * {@link devcContributions} only. Deliberately **not** also declared in the bundled
 * `devcontainer.json` (`devc-core/default/devcontainer.json`): what this Feature does (running a
 * `devc-post-create.sh` a project committed for devc's own convention) is devc-specific, so
 * unlike the other bundled Features it is fine for a `devc init`-scaffolded project to lose it
 * once `devc` itself is uninstalled. See `features/devc-config/README.md`.
 *
 * **Exact version, not the floating `:0`** — a departure from the bundled `devcontainer.json`,
 * which uses `:0` for every Feature it lists. Those are opt-in; this one is forced on every
 * container devc starts, so a bad Feature publish would otherwise reach every user's next build
 * with no devc release and no opt-in anywhere. Bumping it is a devc release, deliberately.
 * Guarded by `tests/workflow_guards_test.sh` against `features/devc-config/devcontainer-feature.json`'s
 * own `version` — a comment saying "keep these in step" is how pins drift.
 */
export const DEVC_CONFIG_FEATURE =
  'ghcr.io/devc-tools/features/devc-config:0.1.1';

/**
 * The Features devc contributes to every container it starts, id paired with the bare name
 * {@link declaresFeatureNamed} matches against. Exactly one entry today; a later plan can add
 * more (see `.plans/archived/devc-inject-project-hook.md`'s Not in this plan).
 */
const BASELINE_FEATURES: readonly { id: string; name: string }[] = [
  { id: DEVC_CONFIG_FEATURE, name: 'devc-config' },
];

/**
 * The token bind mount the devc-bridge Feature needs, contributed whenever something opts into
 * that Feature.
 *
 * Read-only, and that is why it has to be a config `mounts` entry: a Feature cannot declare it
 * (the Feature schema's `Mount` has no such field), and it could not ride the overlay back when
 * overlay mounts became `devcontainer up --mount` args, whose grammar has no `readonly` either.
 * A writable token mount would let a container pin the host token for the next start.
 *
 * It used to be spliced into the *materialized cache config* as a JSONC fence, which meant it
 * reached zero-config containers only — devc will not write into a project's `.devcontainer/`,
 * so project-mode users copied the line in by hand. As a merge layer it reaches both, and devc
 * still writes nothing into the project.
 */
export const BRIDGE_MOUNT =
  'type=bind,source=${localEnv:HOME}/.config/devc-bridge/run,target=/run/devc-bridge,readonly';

/**
 * devc's own layer for `config` — the merged result of the base config and both overlays, which
 * is what decides whether devc still has anything to add.
 *
 * Returned as a layer to merge **under** everything else, so a config or overlay declaring any
 * of this itself simply wins. Two contributions:
 *
 * - **Baseline Features.** Skipped when `baselineFeatures` is false, or when `config` already
 *   declares a Feature of that name by *any* spelling ({@link declaresFeatureNamed}). Matching
 *   by name rather than id is what stops a consumer's `…/devc-config:0` and devc's
 *   `…/devc-config:0.1.0` from both installing — two ids are two Features to the CLI, and the
 *   hook would run twice.
 * - **The bridge token mount**, when the merged Features opt into a Feature named `devc-bridge`.
 *   A mount the user declared on the same target wins through the merge's own target dedupe, so
 *   there is nothing to check for here.
 */
export function devcContributions(
  config: ConfigObject,
  baselineFeatures: boolean,
): ConfigObject {
  const layer: ConfigObject = {};
  const declared = (typeof config.features === 'object' &&
      config.features !== null && !Array.isArray(config.features))
    ? config.features as ConfigObject
    : {};

  if (baselineFeatures) {
    const features: ConfigObject = {};
    for (const feature of BASELINE_FEATURES) {
      if (declaresFeatureNamed(declared, feature.name)) continue;
      features[feature.id] = {};
    }
    if (Object.keys(features).length > 0) layer.features = features;
  }

  if (declaresFeatureNamed(declared, 'devc-bridge')) {
    layer.mounts = [BRIDGE_MOUNT];
  }

  return layer;
}
