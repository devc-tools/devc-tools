import {
  BRIDGE_CAPABILITIES,
  BRIDGE_CAPABILITY_REQUIRES,
  type BridgeCapability,
  isBridgeCapability,
} from '@devc-tools/core/bridge.ts';

export interface AttachArgs {
  /** The path argument, if given. Callers should default to `Deno.cwd()` when absent. */
  target?: string;
  rebuild: boolean;
  /** When true, keep attach/build output on screen (skip the first-prompt clear). */
  noClear: boolean;
  /**
   * `--cwd` value exactly as written, unresolved: a container-absolute path, or a host path
   * that `main.ts` translates through the container's mount table. Absent when not given.
   */
  cwd?: string;
  /**
   * Everything after `--`, forwarded verbatim to the launched command (`devc claude`/`copilot`/
   * `pi`/`herdr`). Absent when there are none. `devc attach` launches no command, so it
   * rejects them.
   */
  extraArgs?: string[];
}

/** The flags `parseAttachArgs` accepts before `--`; any other flag there is an error. */
const ATTACH_OWN_FLAGS = new Set(['--build', '--no-clear', '--cwd']);

/**
 * Parses `devc attach` / `devc claude` / `devc copilot` / `devc pi` / `devc herdr` arguments.
 *
 * Unlike the other parsers here this one cannot use a plain
 * `args.find((a) => !a.startsWith('--'))` for the positional path: `--cwd` takes a value, and
 * a space-separated `--cwd /some/path` would otherwise make `/some/path` look like the
 * positional target and silently attach to the wrong project. Both spellings are accepted —
 * `--cwd <path>` and `--cwd=<path>` — because users will try both.
 *
 * **Forwarded args.** Only what follows `--` is forwarded, verbatim:
 * `devc herdr -- --session foo`. Before `--`, only devc's own flags and one PATH are accepted;
 * anything else throws. Strict on purpose: forwarding from the first unknown flag would make
 * a flag the wrapped CLI shares with devc (`--cwd`, say) go to one program or the other
 * depending on where it was written, silently. It also stops `devc herdr --session foo` from
 * attaching to a project named `foo`, as it once did.
 */
export function parseAttachArgs(args: string[]): AttachArgs {
  let rebuild = false;
  let noClear = false;
  let target: string | undefined;
  let cwd: string | undefined;
  let extraArgs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') {
      extraArgs = args.slice(i + 1);
      break;
    }
    const ownFlag = ATTACH_OWN_FLAGS.has(arg) || arg.startsWith('--cwd=');
    if (arg.startsWith('-') ? !ownFlag : target !== undefined) {
      throw new Error(`unexpected argument '${arg}'`);
    }
    if (arg === '--build') {
      rebuild = true;
      continue;
    }
    if (arg === '--no-clear') {
      noClear = true;
      continue;
    }
    if (arg === '--cwd') {
      const value = args[i + 1];
      // A trailing `--cwd` with no value, or one followed by another flag, leaves `cwd`
      // unset rather than throwing — and must not swallow that flag.
      if (value !== undefined && !value.startsWith('--')) {
        if (value !== '') cwd = value;
        i++;
      }
      continue;
    }
    if (arg.startsWith('--cwd=')) {
      const value = arg.slice('--cwd='.length);
      if (value !== '') cwd = value;
      continue;
    }
    target = arg;
  }

  // Optional keys are omitted rather than set to `undefined` when not given, so the result
  // stays structurally identical to what this parser has always returned.
  const result: AttachArgs = { target, rebuild, noClear };
  if (cwd !== undefined) result.cwd = cwd;
  if (extraArgs.length > 0) result.extraArgs = extraArgs;
  return result;
}

/**
 * The Herdr session `devc herdr` uses unless told otherwise. A named session rather than
 * Herdr's default one because only a named session can be deleted outright
 * (`herdr session stop devc && herdr session delete devc`), which is how you recreate one
 * from scratch; the default session cannot be deleted.
 */
export const DEVC_HERDR_SESSION = 'devc';

/**
 * The args `devc herdr` launches `herdr` with: the user's forwarded args, prefixed with
 * `--session devc` unless they already chose where to go — `--session`/`--remote` — or ran a
 * subcommand (any positional, e.g. `session list`, `pane …`), which the prefix could redirect
 * or break.
 */
export function herdrLaunchArgs(extraArgs: string[]): string[] {
  const choosesTarget = extraArgs.some((a) =>
    !a.startsWith('-') ||
    a === '--session' || a.startsWith('--session=') ||
    a === '--remote' || a.startsWith('--remote=')
  );
  return choosesTarget
    ? extraArgs
    : ['--session', DEVC_HERDR_SESSION, ...extraArgs];
}

export interface UpArgs {
  /** The path argument, if given. Callers should default to `Deno.cwd()` when absent. */
  target?: string;
  /**
   * Print the merged effective config and exit, starting nothing.
   *
   * The effective config is generated into `~/.cache/devc/projects/<key>/`, not the project, so
   * this is how you read what devc will actually run — before the first `up`, and without
   * hunting for a cache path.
   */
  printConfig: boolean;
  json: boolean;
  /**
   * `--bridge-allow <list>`: write this workspace's devc-bridge policy granting exactly these
   * capabilities (canonical order) on its current branch. `null` — the flag is absent — means
   * *delete* the policy. A flag and never a config key: see `bridge.ts`.
   */
  bridgeAllow: BridgeCapability[] | null;
}

/** The one devc-owned flag that grants capabilities. Accepted by `up` and `build` only. */
export const BRIDGE_ALLOW_FLAG = '--bridge-allow';

/** Its predecessor, refused everywhere with a pointer to the replacement. */
export const BRIDGE_GIT_PUSH_FLAG = '--bridge-git-push';

/** Whether `arg` is `--bridge-allow` in either spelling (`--bridge-allow`, `--bridge-allow=…`). */
export function isBridgeAllowArg(arg: string): boolean {
  return arg === BRIDGE_ALLOW_FLAG || arg.startsWith(`${BRIDGE_ALLOW_FLAG}=`);
}

/**
 * Validate a `--bridge-allow` value: comma-separated, entries trimmed, empties dropped, every name
 * known, `pr-resolve` only with `pr-review`; returned deduplicated in canonical order. Throws with
 * the user-facing message.
 */
export function parseBridgeAllow(value: string): BridgeCapability[] {
  const valid = BRIDGE_CAPABILITIES.join(', ');
  const names = value.split(',').map((n) => n.trim()).filter((n) => n !== '');
  if (names.length === 0) {
    throw new Error(`${BRIDGE_ALLOW_FLAG} needs at least one of: ${valid}`);
  }
  for (const n of names) {
    if (!isBridgeCapability(n)) {
      throw new Error(`unknown capability ${n} — valid: ${valid}`);
    }
  }
  const grants = BRIDGE_CAPABILITIES.filter((c) => names.includes(c));
  for (const g of grants) {
    const needs = BRIDGE_CAPABILITY_REQUIRES[g];
    if (needs !== undefined && !grants.includes(needs)) {
      throw new Error(`${g} requires ${needs}`);
    }
  }
  return grants;
}

/**
 * Split `--bridge-allow` (both spellings) out of `args`: the capabilities, or null when absent, and
 * the remaining args. The space form consumes the next arg as its value, so it can never be read as
 * the target path. Throws for the flag given twice, a missing or invalid value, or the removed
 * `--bridge-git-push`.
 */
function takeBridgeAllow(
  args: string[],
): { bridgeAllow: BridgeCapability[] | null; rest: string[] } {
  let value: string | null = null;
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === BRIDGE_GIT_PUSH_FLAG) {
      throw new Error(
        `${BRIDGE_GIT_PUSH_FLAG} was replaced by ${BRIDGE_ALLOW_FLAG} git-push`,
      );
    }
    if (!isBridgeAllowArg(a)) {
      rest.push(a);
      continue;
    }
    if (value !== null) {
      throw new Error(`${BRIDGE_ALLOW_FLAG} given more than once`);
    }
    if (a === BRIDGE_ALLOW_FLAG) {
      value = i + 1 < args.length ? args[++i] : '';
    } else {
      value = a.slice(BRIDGE_ALLOW_FLAG.length + 1);
    }
  }
  return {
    bridgeAllow: value === null ? null : parseBridgeAllow(value),
    rest,
  };
}

/** Parses `devc up` arguments. Throws for an invalid `--bridge-allow`. */
export function parseUpArgs(args: string[]): UpArgs {
  const { bridgeAllow, rest } = takeBridgeAllow(args);
  const printConfig = rest.includes('--print-config');
  const json = rest.includes('--json');
  const target = rest.find((a) => !a.startsWith('--'));
  return { target, printConfig, json, bridgeAllow };
}

export interface BuildArgs {
  /** The path argument, if given. Callers should default to `Deno.cwd()` when absent. */
  target?: string;
  /** Drop the Docker layer cache for the image build (`--build-no-cache`). */
  noCache: boolean;
  json: boolean;
  /** As {@link UpArgs.bridgeAllow}. */
  bridgeAllow: BridgeCapability[] | null;
}

/** Parses `devc build` arguments. Throws for an invalid `--bridge-allow`. */
export function parseBuildArgs(args: string[]): BuildArgs {
  const { bridgeAllow, rest } = takeBridgeAllow(args);
  const noCache = rest.includes('--no-cache');
  const json = rest.includes('--json');
  const target = rest.find((a) => !a.startsWith('--'));
  return { target, noCache, json, bridgeAllow };
}
