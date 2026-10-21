import {
  BRIDGE_CAPABILITIES,
  BRIDGE_CAPABILITY_REQUIRES,
  type BridgeCapability,
  isBridgeCapability,
  MAX_PINNED_REPOS,
  retiredCapabilityReason,
} from '@devc-tools/core/bridge.ts';
import { unfoldHome } from '@devc-tools/core/mounts.ts';
import { isAbsolutePosix, resolvePosix } from '@devc-tools/core/posix.ts';

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

export interface WebArgs {
  /** `--port N`: the 127.0.0.1 port to listen on. */
  port: number;
  /** `--session NAME`: the Herdr session to use in each container. */
  session: string;
  /**
   * `--live` (or `--source`/`--live-yolo`, which imply it): serve a devc-tools checkout's
   * **page** live instead of the built-in one. The server stays devc's own, and refuses to start
   * containers or add projects, so page code an agent writes reaches only running containers.
   * Never on by default.
   */
  live: boolean;
  /**
   * `--live-yolo`: `--live` plus the checkout's **server** code, restarted on every change
   * that passes `deno check`. Full trust: that code runs on the host as the user, hence the
   * name.
   */
  liveServer: boolean;
  /** Open the page in the default browser once it is served; `--no-open` turns it off. */
  open: boolean;
  /**
   * `--source DIR`, as typed: the checkout's `devc/` directory, for this run. Absent when not
   * given; `main.ts` then takes `"webSource"` from the global config and resolves it.
   */
  source?: string;
}

/** The port `devc web` listens on unless `--port` says otherwise. */
export const DEVC_WEB_DEFAULT_PORT = 48228;

/**
 * Parses `devc web` arguments: `--port N`, `--session NAME` and `--source DIR` (each also as
 * `--flag=value`), and the bare flags `--live` and `--live-yolo`. `--source` and
 * `--live-yolo` imply `--live`. Strict: an unknown argument, a missing value, a value on a bare
 * flag or a port outside 1–65535 throws.
 */
export function parseWebArgs(args: string[]): WebArgs {
  let port = DEVC_WEB_DEFAULT_PORT;
  let session = DEVC_HERDR_SESSION;
  let source: string | undefined;
  let live = false;
  let liveServer = false;
  let open = true;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const eq = arg.indexOf('=');
    const flag = arg.startsWith('--') && eq !== -1 ? arg.slice(0, eq) : arg;
    if (flag === '--no-open') {
      if (flag !== arg) throw new Error(`${flag} takes no value`);
      open = false;
      continue;
    }
    if (flag === '--live' || flag === '--live-yolo') {
      if (flag !== arg) throw new Error(`${flag} takes no value`);
      live = true;
      if (flag === '--live-yolo') liveServer = true;
      continue;
    }
    if (flag !== '--port' && flag !== '--session' && flag !== '--source') {
      throw new Error(`unexpected argument '${arg}'`);
    }
    const value = flag === arg ? args[++i] : arg.slice(eq + 1);
    if (value === undefined || value === '') {
      throw new Error(`${flag} needs a value`);
    }
    if (flag === '--port') {
      const n = /^[0-9]+$/.test(value) ? Number(value) : NaN;
      if (!(n >= 1 && n <= 65535)) {
        throw new Error(
          `--port must be a number from 1 to 65535, got '${value}'`,
        );
      }
      port = n;
    } else if (flag === '--source') {
      source = value;
      live = true;
    } else session = value;
  }
  return {
    port,
    session,
    live,
    liveServer,
    open,
    ...(source !== undefined ? { source } : {}),
  };
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
   * capabilities (canonical order) on its current branch. `'none'` — `--bridge-allow none` —
   * means *delete* the policy. `null` — the flag is absent — means `bridgeDefaultAllow` from
   * `~/.config/devc/config.json` when it is set, and delete otherwise. Never a devc config key:
   * see `bridge.ts`.
   */
  bridgeAllow: BridgeCapability[] | 'none' | null;
  /**
   * `--bridge-repo PATH`, each as typed, in command-line order: extra repos the grant pins
   * alongside the workspace repo. Empty when none were given; never non-empty without
   * {@link bridgeAllow}. Resolved and checked against the container in `bridge.ts`.
   */
  bridgeRepos: string[];
}

/** The one devc-owned flag that grants capabilities. Accepted by `up` and `build` only. */
export const BRIDGE_ALLOW_FLAG = '--bridge-allow';

/**
 * Names one extra repo for the grant to pin, by host path. Accepted by `up` and `build` only,
 * repeatable, and only alongside {@link BRIDGE_ALLOW_FLAG}. A flag and never a config key, for
 * the same reason as `--bridge-allow`: every config layer that could set it is agent-writable.
 */
export const BRIDGE_REPO_FLAG = '--bridge-repo';

/** At most this many `--bridge-repo`s: the policy pins the workspace repo too. */
export const MAX_BRIDGE_REPOS = MAX_PINNED_REPOS - 1;

/** Whether `arg` is `--bridge-repo` in either spelling (`--bridge-repo`, `--bridge-repo=…`). */
export function isBridgeRepoArg(arg: string): boolean {
  return arg === BRIDGE_REPO_FLAG || arg.startsWith(`${BRIDGE_REPO_FLAG}=`);
}

/**
 * A `--bridge-repo` value as an absolute host path, not yet resolved through symlinks: a leading
 * `~` or `~/` expands to `home`, and a relative path resolves against `cwd`. The expansion is
 * devc's to do — the shell does not tilde-expand `--bridge-repo=~/x` (bash and zsh only do after
 * `=` in a real variable assignment) or a quoted `"~/x"`. `~user` is left alone, so it resolves as
 * a relative path and then fails as a directory that does not exist.
 */
export function expandBridgeRepo(
  value: string,
  home: string | undefined,
  cwd: string,
): string {
  const unfolded = value === '~' || value.startsWith('~/')
    ? unfoldHome(value, home)
    : value;
  return isAbsolutePosix(unfolded) ? unfolded : resolvePosix(cwd, unfolded);
}

/** Its predecessor, refused everywhere with a pointer to the replacement. */
export const BRIDGE_GIT_PUSH_FLAG = '--bridge-git-push';

/** Whether `arg` is `--bridge-allow` in either spelling (`--bridge-allow`, `--bridge-allow=…`). */
export function isBridgeAllowArg(arg: string): boolean {
  return arg === BRIDGE_ALLOW_FLAG || arg.startsWith(`${BRIDGE_ALLOW_FLAG}=`);
}

/**
 * The two reserved `--bridge-allow` entries that stand for every capability named `gh-*`. Exact
 * tokens, not a glob: `*`, `gh-pr-*` and `GH` are unknown capabilities. Expanded here, so a
 * policy file only ever holds the explicit list — a capability a later release adds is not granted
 * to an existing container until it is re-granted.
 */
const BRIDGE_ALLOW_ALL_GH = ['gh', 'gh-*'];

/** The `--bridge-allow` value that grants nothing: the policy is removed. */
export const BRIDGE_ALLOW_NONE = 'none';

/** `wanted` in canonical order, or throws `<cap> requires <needed>` for a missing requirement. */
function canonicalGrants(wanted: ReadonlySet<string>): BridgeCapability[] {
  const grants = BRIDGE_CAPABILITIES.filter((c) => wanted.has(c));
  for (const g of grants) {
    const needs = BRIDGE_CAPABILITY_REQUIRES[g];
    if (needs !== undefined && !grants.includes(needs)) {
      throw new Error(`${g} requires ${needs}`);
    }
  }
  return grants;
}

/**
 * Validate a `--bridge-allow` value: comma-separated, entries trimmed, empties dropped, `gh` and
 * `gh-*` expanded to every `gh-` capability, every other name known, and each capability's
 * requirement (`BRIDGE_CAPABILITY_REQUIRES`) present; returned deduplicated in canonical order.
 * `none` alone returns `'none'`, and combined with anything else is refused. Throws with the
 * user-facing message.
 */
export function parseBridgeAllow(value: string): BridgeCapability[] | 'none' {
  const valid = `${BRIDGE_CAPABILITIES.join(', ')} (or ${
    BRIDGE_ALLOW_ALL_GH.join(' / ')
  } for all of them)`;
  const names = value.split(',').map((n) => n.trim()).filter((n) => n !== '');
  if (names.length === 0) {
    throw new Error(`${BRIDGE_ALLOW_FLAG} needs at least one of: ${valid}`);
  }
  if (names.includes(BRIDGE_ALLOW_NONE)) {
    if (names.length > 1) {
      throw new Error(
        `${BRIDGE_ALLOW_FLAG} ${BRIDGE_ALLOW_NONE} can't be combined with capabilities`,
      );
    }
    return BRIDGE_ALLOW_NONE;
  }
  const wanted = new Set<string>();
  for (const n of names) {
    if (BRIDGE_ALLOW_ALL_GH.includes(n)) {
      for (const c of BRIDGE_CAPABILITIES) {
        if (c.startsWith('gh-')) wanted.add(c);
      }
    } else if (isBridgeCapability(n)) {
      wanted.add(n);
    } else {
      throw new Error(
        retiredCapabilityReason(n) ??
          `unknown capability ${n} — valid: ${valid}`,
      );
    }
  }
  return canonicalGrants(wanted);
}

/** The key in `~/.config/devc/config.json` that holds the default grant. */
export const BRIDGE_DEFAULT_ALLOW_KEY = 'bridgeDefaultAllow';

/**
 * Validate `bridgeDefaultAllow` as read raw from the global config: an array of capability names,
 * each trimmed, every one known — `gh` and `gh-*` refused, since a default re-expanded on every
 * `up` would grant a later release's capabilities silently — and each requirement present;
 * returned deduplicated in canonical order. Absent, `null` or `[]` → null (no default). Throws
 * the bare `<reason>`; the caller names the file and key.
 */
export function parseBridgeDefaultAllow(
  raw: unknown,
): BridgeCapability[] | null {
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw) || raw.some((v) => typeof v !== 'string')) {
    throw new Error('must be an array of capability names');
  }
  if (raw.length === 0) return null;
  const wanted = new Set<string>();
  for (const entry of raw as string[]) {
    const n = entry.trim();
    if (BRIDGE_ALLOW_ALL_GH.includes(n)) {
      throw new Error(
        `${JSON.stringify(n)} is not allowed here — list each capability`,
      );
    }
    if (!isBridgeCapability(n)) {
      throw new Error(
        retiredCapabilityReason(n) ??
          `unknown capability ${n} — valid: ${BRIDGE_CAPABILITIES.join(', ')}`,
      );
    }
    wanted.add(n);
  }
  return canonicalGrants(wanted);
}

/**
 * Split `--bridge-allow` and `--bridge-repo` (both spellings each) out of `args`: the
 * capabilities, or null when absent, the repos as typed, and the remaining args. The space forms
 * consume the next arg as their value, so it can never be read as the target path. Throws for
 * `--bridge-allow` given twice, a missing or invalid value, the removed `--bridge-git-push`,
 * `--bridge-repo` without `--bridge-allow` or with `--bridge-allow none`, the same repo named twice, or more than
 * {@link MAX_BRIDGE_REPOS} of them.
 */
function takeBridgeFlags(
  args: string[],
): {
  bridgeAllow: BridgeCapability[] | 'none' | null;
  bridgeRepos: string[];
  rest: string[];
} {
  let value: string | null = null;
  const bridgeRepos: string[] = [];
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === BRIDGE_GIT_PUSH_FLAG) {
      throw new Error(
        `${BRIDGE_GIT_PUSH_FLAG} was replaced by ${BRIDGE_ALLOW_FLAG} gh-push`,
      );
    }
    if (isBridgeRepoArg(a)) {
      const repo = a === BRIDGE_REPO_FLAG
        ? (i + 1 < args.length ? args[++i] : '')
        : a.slice(BRIDGE_REPO_FLAG.length + 1);
      if (repo === '') throw new Error(`${BRIDGE_REPO_FLAG} needs a path`);
      bridgeRepos.push(repo);
      continue;
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
  const bridgeAllow = value === null ? null : parseBridgeAllow(value);
  if (bridgeRepos.length > 0 && bridgeAllow === null) {
    throw new Error(`${BRIDGE_REPO_FLAG} requires ${BRIDGE_ALLOW_FLAG}`);
  }
  if (bridgeRepos.length > 0 && bridgeAllow === BRIDGE_ALLOW_NONE) {
    throw new Error(
      `${BRIDGE_REPO_FLAG} requires ${BRIDGE_ALLOW_FLAG} with capabilities`,
    );
  }
  if (bridgeRepos.length > MAX_BRIDGE_REPOS) {
    throw new Error(
      `${BRIDGE_REPO_FLAG} given ${bridgeRepos.length} times — at most ${MAX_BRIDGE_REPOS}, ` +
        `since a policy pins at most ${MAX_PINNED_REPOS} repos with the workspace repo`,
    );
  }
  // The same repo twice, however it was spelled, compared after symlinks are resolved. A path
  // that does not resolve compares as spelled; `bridge.ts` refuses it as no such directory.
  const seen = new Set<string>();
  for (const repo of bridgeRepos) {
    const abs = expandBridgeRepo(repo, Deno.env.get('HOME'), Deno.cwd());
    let real = abs.replace(/(?<=.)\/+$/, '');
    try {
      real = Deno.realPathSync(abs);
    } catch { /* compared as spelled */ }
    if (seen.has(real)) {
      throw new Error(`${BRIDGE_REPO_FLAG} ${repo} given more than once`);
    }
    seen.add(real);
  }
  return { bridgeAllow, bridgeRepos, rest };
}

/** Parses `devc up` arguments. Throws for an invalid `--bridge-allow` or `--bridge-repo`. */
export function parseUpArgs(args: string[]): UpArgs {
  const { bridgeAllow, bridgeRepos, rest } = takeBridgeFlags(args);
  const printConfig = rest.includes('--print-config');
  const json = rest.includes('--json');
  const target = rest.find((a) => !a.startsWith('--'));
  return { target, printConfig, json, bridgeAllow, bridgeRepos };
}

export interface BuildArgs {
  /** The path argument, if given. Callers should default to `Deno.cwd()` when absent. */
  target?: string;
  /** Drop the Docker layer cache for the image build (`--build-no-cache`). */
  noCache: boolean;
  json: boolean;
  /** As {@link UpArgs.bridgeAllow}. */
  bridgeAllow: BridgeCapability[] | 'none' | null;
  /** As {@link UpArgs.bridgeRepos}. */
  bridgeRepos: string[];
}

/** Parses `devc build` arguments. Throws for an invalid `--bridge-allow` or `--bridge-repo`. */
export function parseBuildArgs(args: string[]): BuildArgs {
  const { bridgeAllow, bridgeRepos, rest } = takeBridgeFlags(args);
  const noCache = rest.includes('--no-cache');
  const json = rest.includes('--json');
  const target = rest.find((a) => !a.startsWith('--'));
  return { target, noCache, json, bridgeAllow, bridgeRepos };
}

export interface ConfigArgs {
  /** The path argument, if given. Callers should default to `Deno.cwd()` when absent. */
  target?: string;
  /** `--global`: reconfigure the code/skills roots only. */
  global: boolean;
  /** `--repo`: write the overlay shared by every checkout of the target's git repo. */
  repo: boolean;
}

/**
 * Parses `devc config` arguments: `--global`, `--repo`, and at most one PATH. Strict, like
 * {@link parseAttachArgs}: an unknown flag or a second path throws rather than being ignored, so
 * a typo cannot quietly configure the wrong scope.
 */
export function parseConfigArgs(args: string[]): ConfigArgs {
  let target: string | undefined;
  let global = false;
  let repo = false;
  for (const arg of args) {
    if (arg === '--global') global = true;
    else if (arg === '--repo') repo = true;
    else if (arg.startsWith('-') || target !== undefined) {
      throw new Error(`unexpected argument '${arg}'`);
    } else target = arg;
  }
  if (global && repo) {
    throw new Error('--global and --repo cannot be combined');
  }
  return { target, global, repo };
}
