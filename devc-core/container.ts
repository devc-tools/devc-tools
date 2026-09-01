import process from 'node:process';
import { statSync } from 'node:fs';
import { normalizePath as _normalizePath } from './paths.ts';
import { resolvePosix } from './posix.ts';
import {
  CLAUDE_SEED_HOST_DIR,
  ensureClaudeSeedDir,
  resolveRemoteEnv,
} from './default_config.ts';
import {
  type ConfigMode,
  ensureMergedConfig,
  projectKey,
} from './merged_config.ts';
import { displayPath } from './config.ts';
import {
  type DevcontainerRunner,
  nodeDevcontainerRunner,
} from './devcontainer.ts';
import { output, status } from './exec.ts';
import { logNotice, logWarning } from './log.ts';

export type ContainerStatus = 'running' | 'stopped' | 'missing';

export interface ContainerInfo {
  containerId: string;
  remoteUser: string;
  remoteWorkspaceFolder: string;
  remoteEnv: Record<string, string>;
}

export interface ExecOptions {
  /** Container-side working directory. Defaults to remoteWorkspaceFolder. */
  cwd?: string;
  /** Extra env, applied on top of the container's remoteEnv. */
  env?: Record<string, string>;
  /** argv[0] and its arguments, exec'd directly (no shell). */
  cmd: string[];
  /**
   * `'inherit'` (default): stdin/stdout/stderr are the caller's own, streamed straight through
   * — `devc exec`'s shape. `'piped'`: stdin is not inherited, and stdout/stderr are captured
   * and returned on {@link ExecResult} instead of printed — what a library consumer wants.
   */
  stdio?: 'inherit' | 'piped';
  /**
   * The devcontainer CLI to run `up` through, when `exec` has to start the container first.
   * Same field, same default, as {@link StartOptions.devcontainer} — `execInContainer` calls
   * `startContainer` internally and has to forward whichever runner the caller bound.
   */
  devcontainer?: DevcontainerRunner;
}

export interface ExecResult {
  /** The command's own exit code. */
  code: number;
  /** Captured stdout — only set when `opts.stdio` was `'piped'`. */
  stdout?: string;
  /** Captured stderr — only set when `opts.stdio` was `'piped'`. */
  stderr?: string;
}

export interface ContainerMount {
  type: 'bind' | 'volume';
  /** Host-side path. For volumes, the docker-managed `/var/lib/docker/...` dir. */
  source: string;
  /** Container-side mount point. */
  destination: string;
  rw: boolean;
}

function normalizePath(p: string): string {
  return _normalizePath(p).toLowerCase();
}

/** One `docker ps` row: the container id, its `local_folder` label, and its state. */
export interface ContainerRow {
  id: string;
  labelPath: string;
  state: string;
}

/**
 * Picks the container for `localFolder` out of `docker ps`'s rows, which arrive
 * newest-created first.
 *
 * **More than one row can match**, and the state is reachable in normal use: the
 * devcontainer CLI keys a container on `devcontainer.local_folder` *and*
 * `devcontainer.config_file`, and when it finds a `local_folder` match carrying a
 * different `config_file` it builds a new container and leaves the old one in place
 * rather than removing it. Anything that changes the config path for a workspace —
 * a project gaining its own `.devcontainer/`, or the zero-config cache key moving —
 * therefore leaves two containers sharing one `local_folder`.
 *
 * So the choice is made explicitly rather than falling out of row order: prefer a
 * running container, and among equals take the newest. That is the one the most
 * recent `up` produced, which is what every caller here means by "the container for
 * this folder".
 */
export function selectContainer(
  rows: ContainerRow[],
  localFolder: string,
): { id: string; state: string } | null {
  const target = normalizePath(localFolder);
  const matches = rows.filter((r) => normalizePath(r.labelPath) === target);
  if (matches.length === 0) return null;
  const picked = matches.find((r) => r.state === 'running') ?? matches[0];
  return { id: picked.id, state: picked.state };
}

/**
 * Finds the container labeled `devcontainer.local_folder=<localFolder>` (after
 * `normalizePath`), via {@link selectContainer}. `all` controls whether stopped
 * containers are included (`docker ps -a`) or only running ones (`docker ps`).
 * Returns `null` if docker errors or no container matches.
 */
async function findContainer(
  localFolder: string,
  all: boolean,
): Promise<{ id: string; state: string } | null> {
  const { code, stdout } = await output('docker', {
    args: [
      'ps',
      ...(all ? ['-a'] : []),
      '--filter',
      'label=devcontainer.local_folder',
      '--format',
      '{{.ID}}\t{{.Label "devcontainer.local_folder"}}\t{{.State}}',
    ],
    stdout: 'piped',
    stderr: 'inherit',
  });
  if (code !== 0) return null;

  const rows = new TextDecoder().decode(stdout).trim().split('\n')
    .filter(Boolean)
    .map((line) => {
      const [id, labelPath, state] = line.split('\t');
      return { id, labelPath, state };
    });

  return selectContainer(rows, localFolder);
}

export async function getContainerStatus(
  localFolder: string,
): Promise<ContainerStatus> {
  const found = await findContainer(localFolder, true);
  if (found === null) return 'missing';
  return found.state === 'running' ? 'running' : 'stopped';
}

/**
 * Builds the `docker exec` argv for a non-interactive run: `-i` (never `-t`),
 * `-u remoteUser`, `-w cwd`, one `-e K=V` per env entry (remoteEnv first, then
 * `env` — so `env` overrides `remoteEnv` on key collision), the container id, and
 * finally `cmd` verbatim. Pure/exported for unit testing.
 */
export function buildExecArgs(input: {
  containerId: string;
  remoteUser: string;
  cwd: string;
  remoteEnv: Record<string, string>;
  env: Record<string, string>;
  cmd: string[];
}): string[] {
  const { containerId, remoteUser, cwd, remoteEnv, env, cmd } = input;
  // `env` overrides `remoteEnv` on key collision; spreading in this order keeps
  // one entry per key with `env`'s value winning.
  const merged = { ...remoteEnv, ...env };
  const envFlags = Object.entries(merged).flatMap((
    [k, v],
  ) => ['-e', `${k}=${v}`]);
  return [
    'exec',
    '-i',
    ...envFlags,
    '-u',
    remoteUser,
    '-w',
    cwd,
    containerId,
    ...cmd,
  ];
}

/**
 * Ensures the container for `localFolder` is running (via `startContainer`,
 * rebuild=false), then runs `opts.cmd` non-interactively via `docker exec -i`
 * (no TTY), with `-u remoteUser`, `-w (opts.cwd ?? remoteWorkspaceFolder)`, and
 * `-e` flags for remoteEnv then opts.env.
 *
 * `opts.stdio` (default `'inherit'`) picks which of two shapes this is: the CLI's, where
 * stdin/stdout/stderr are the caller's own and the result is just an exit code, or a library
 * consumer's, where `'piped'` captures stdout/stderr instead of printing them (and does not
 * inherit stdin — there is no terminal to read from). Throws only on infra failure (container
 * won't start / docker not runnable), never on the command's own non-zero exit.
 */
export async function execInContainer(
  localFolder: string,
  opts: ExecOptions,
): Promise<ExecResult> {
  const info = await startContainer(localFolder, false, {
    devcontainer: opts.devcontainer,
  });
  const args = buildExecArgs({
    containerId: info.containerId,
    remoteUser: info.remoteUser,
    cwd: opts.cwd ?? info.remoteWorkspaceFolder,
    remoteEnv: info.remoteEnv,
    env: opts.env ?? {},
    cmd: opts.cmd,
  });

  if (opts.stdio === 'piped') {
    const { code, stdout, stderr } = await output('docker', {
      args,
      stdin: 'null',
      stdout: 'piped',
      stderr: 'piped',
    });
    return {
      code,
      stdout: new TextDecoder().decode(stdout),
      stderr: new TextDecoder().decode(stderr),
    };
  }

  const { code } = await status('docker', {
    args,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  return { code };
}

/**
 * Parses the JSON emitted by `docker inspect --format '{{json .Mounts}}'` into a
 * `ContainerMount[]`. Maps `Type → type`, `Source → source`, `Destination →
 * destination`, `RW → rw`. `null`/empty/unparseable input → `[]`. Pure/exported
 * for unit testing.
 */
export function parseMounts(json: string | null): ContainerMount[] {
  if (!json) return [];
  // deno-lint-ignore no-explicit-any
  let raw: any;
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  return raw.map((m) => ({
    type: m.Type === 'volume' ? 'volume' : 'bind',
    source: m.Source,
    destination: m.Destination,
    rw: m.RW === true,
  }));
}

/**
 * Returns the mount table for `localFolder`'s container (found via
 * `findContainer(localFolder, true)` — running or stopped, never started), from
 * `docker inspect --format '{{json .Mounts}}'`. Returns `null` if no container
 * matches. Does not resolve symlinks in `source` (the caller does).
 */
export async function getContainerMounts(
  localFolder: string,
): Promise<ContainerMount[] | null> {
  const found = await findContainer(localFolder, true);
  if (found === null) return null;
  const json = await dockerInspect(found.id, '{{json .Mounts}}');
  return parseMounts(json);
}

async function isGitWorktree(localFolder: string): Promise<boolean> {
  const [commonDir, gitDir] = await Promise.all([
    output('git', {
      args: ['-C', localFolder, 'rev-parse', '--git-common-dir'],
      stdout: 'piped',
      stderr: 'null',
    }),
    output('git', {
      args: ['-C', localFolder, 'rev-parse', '--git-dir'],
      stdout: 'piped',
      stderr: 'null',
    }),
  ]);
  if (commonDir.code !== 0 || gitDir.code !== 0) return false;
  return new TextDecoder().decode(commonDir.stdout).trim() !==
    new TextDecoder().decode(gitDir.stdout).trim();
}

/**
 * Resolves a user-supplied path argument to an absolute, slash-normalized path
 * against `cwd` (default: the process cwd). A bare relative path such as `.` must
 * become absolute before it reaches container naming
 * (`containerNameForLocalFolder`), the per-project cache key
 * (`projectKey`), or the `devcontainer.local_folder` label match in
 * `findContainer` — otherwise `.` yields the invalid image tag `devc-.-<hash>`
 * and fails to match the absolute path the `devcontainer` CLI records in the
 * label (so `status`/`stop`/`down`/`mounts` can't find the container). An
 * already-absolute argument is returned normalized as-is. Mirrors how
 * `devcontainer up` resolves `--workspace-folder` internally.
 */
export function resolveLocalFolder(
  pathArg?: string,
  cwd: string = process.cwd(),
): string {
  return resolvePosix(_normalizePath(cwd), _normalizePath(pathArg ?? '.'));
}

/**
 * Derives a deterministic container name for `localFolder`:
 * `devc-<sanitized-basename>-<8-hex-sha256-prefix>`, mirroring the devcontainer CLI's
 * `vsc-<workspaceFolderBasename>-<hash>` convention for auto-built image tags. The hash
 * is over `normalizePath(localFolder)` (lowercased), so:
 *  - the name is stable across runs for the same folder
 *  - two folders with the same basename (e.g. two checkouts of the same repo) get
 *    different names
 * The basename is sanitized to `[a-zA-Z0-9_.-]` (other characters become `-`); an empty
 * basename (e.g. `localFolder === "/"`) falls back to `"workspace"`. The `devc-` prefix
 * guarantees the result starts with an alphanumeric character (Docker container name
 * requirement) even if the basename starts with `.` or `-`.
 *
 * The `<basename>-<hash>` half is {@link import("./merged_config.ts").projectKey}, which also
 * names that project's merged-config cache directory — the container and its config are meant to
 * be recognizably about the same project.
 */
export async function containerNameForLocalFolder(
  localFolder: string,
): Promise<string> {
  return `devc-${await projectKey(localFolder)}`;
}

/**
 * The started container's own environment (its image `ENV` plus the `devcontainer.json`
 * `containerEnv` that `docker run -e` applied), as a `NAME -> value` record.
 *
 * This is what `${containerEnv:VAR}` in `remoteEnv` resolves against. The devcontainer CLI
 * does the equivalent from the inside; devc runs `exec`/`attach` through `docker exec`, which
 * carries `containerEnv` but never `remoteEnv`, so it has to read the same environment back
 * out here — see `resolveRemoteEnv`.
 *
 * Best-effort, matching {@link dockerInspect}: `{}` when the container cannot be inspected or
 * reports no env, which leaves the tokens unresolved rather than substituting a wrong value.
 */
async function inspectContainerEnv(
  containerId: string,
): Promise<Record<string, string>> {
  const json = await dockerInspect(containerId, '{{json .Config.Env}}');
  if (json === null) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return {};
  }
  // `.Config.Env` is null, not [], on a container that declares none.
  if (!Array.isArray(parsed)) return {};
  const env: Record<string, string> = {};
  for (const entry of parsed) {
    if (typeof entry !== 'string') continue;
    const eq = entry.indexOf('=');
    // Docker writes `NAME=value`; a bare `NAME` (no `=`) is not a value to substitute.
    if (eq === -1) continue;
    env[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return env;
}

async function dockerInspect(
  containerId: string,
  format: string,
): Promise<string | null> {
  try {
    const { code, stdout } = await output('docker', {
      args: ['inspect', '--format', format, containerId],
      stdout: 'piped',
      stderr: 'null',
    });
    if (code !== 0) return null;
    return new TextDecoder().decode(stdout).trim();
  } catch {
    return null;
  }
}

/**
 * The warning text for a container-name conflict, in two shapes.
 *
 * A conflict on a *different* workspace is a hash collision between two folders whose
 * names happen to agree, and it may clear on its own if the other container is on its
 * way out — so that message says to re-run.
 *
 * A conflict on the *same* workspace is a different animal. The name is derived from
 * the workspace path alone (see {@link containerNameForLocalFolder}), so two containers
 * wanting it means two containers for one folder — the state the devcontainer CLI leaves
 * behind whenever a workspace's config path changes: it keys a container on
 * `devcontainer.local_folder` *and* `devcontainer.config_file`, rejects a `local_folder`
 * match whose `config_file` differs, builds a new container, and only ever *removes* a
 * container carrying no `config_file` label at all. Nothing will clear that one, so
 * telling the user to wait (as the cross-workspace message does) would send them to wait
 * for something that never happens. Name the removal command instead.
 *
 * Pure/exported so both shapes are assertable without a Docker daemon.
 */
export function renameConflictWarning(input: {
  containerId: string;
  conflictId: string;
  desiredName: string;
  localFolder: string;
  otherLocalFolder: string | null;
}): string {
  const {
    containerId,
    conflictId,
    desiredName,
    localFolder,
    otherLocalFolder,
  } = input;

  const sameWorkspace = otherLocalFolder !== null &&
    normalizePath(otherLocalFolder) === normalizePath(localFolder);

  if (sameWorkspace) {
    return `warning: two containers exist for workspace ${localFolder}. ${containerId} is the ` +
      `current one; ${conflictId} is stale — it holds the name "${desiredName}", so the current ` +
      `container keeps its default name. Nothing will remove it automatically; once you are sure ` +
      `you do not need it:\n  docker rm -f ${conflictId}`;
  }

  return `warning: could not rename container ${containerId} (workspace: ${localFolder}) to ` +
    `"${desiredName}" — container ${conflictId} (workspace: ${
      otherLocalFolder ?? 'unknown'
    }) ` +
    `already has that name. If ${conflictId} is being removed, this is transient — re-run ` +
    `\`devc attach\` once it's gone. ${containerId} will keep its default name for now.`;
}

/**
 * Best-effort: if the container's current name (from `docker inspect --format
 * '{{.Name}}'`, with the leading `/` stripped) already equals `desiredName`, returns
 * (no-op — the reuse/restart case).
 *
 * Otherwise, checks whether some *other* container already holds `desiredName` (via
 * `docker ps -a --filter name=^<desiredName>$ --format '{{.ID}}'`, excluding
 * `containerId`). If found, warns and returns without renaming — `containerId` keeps
 * its Docker-assigned name for now. The warning comes in two shapes, told apart by the
 * conflicting container's own `devcontainer.local_folder` label (fetched via `docker
 * inspect --format '{{index .Config.Labels "devcontainer.local_folder"}}'`): a
 * *different* workspace is a hash collision that may clear on its own, while the *same*
 * workspace is a stale duplicate that nothing will ever remove — see the comment at the
 * branch.
 *
 * Otherwise (no conflict) runs `docker rename <containerId> <desiredName>`.
 *
 * Never throws and never aborts `devc attach` — naming is cosmetic — but a conflict
 * is surfaced loudly (stderr warning with a concrete next step) rather than swallowed,
 * since an unrenamed container is otherwise indistinguishable from one where renaming
 * was simply never attempted.
 */
async function renameContainerIfNeeded(
  containerId: string,
  desiredName: string,
  localFolder: string,
): Promise<void> {
  try {
    const currentName = await dockerInspect(containerId, '{{.Name}}');
    if (
      currentName !== null && currentName.replace(/^\//, '') === desiredName
    ) return;

    const { stdout } = await output('docker', {
      args: [
        'ps',
        '-a',
        '--filter',
        `name=^${desiredName}$`,
        '--format',
        '{{.ID}}',
      ],
      stdout: 'piped',
      stderr: 'null',
    });
    const conflictId = new TextDecoder().decode(stdout).trim().split('\n')
      .map((id) => id.trim())
      .find((id) => id && id !== containerId);

    if (conflictId) {
      const otherLocalFolder = await dockerInspect(
        conflictId,
        '{{index .Config.Labels "devcontainer.local_folder"}}',
      );
      logWarning(
        renameConflictWarning({
          containerId,
          conflictId,
          desiredName,
          localFolder,
          otherLocalFolder,
        }),
      );
      return;
    }

    await output('docker', {
      args: ['rename', containerId, desiredName],
      stdout: 'null',
      stderr: 'inherit',
    });
  } catch {
    // naming is cosmetic — never abort devc attach
  }
}

/**
 * Best-effort: tags the image currently used by `containerId` (its image ID, from
 * `docker inspect --format '{{.Image}}'`) as `<name>:latest` — an *additional* alias
 * tag, not a replacement. Does not remove or alter the devcontainer CLI's own
 * `vsc-<basename>-<hash>` tag, which the CLI uses to detect "image already built,
 * skip rebuild" on the next `up`; deleting or repointing that tag would force a
 * rebuild on every `devc attach`. `docker tag` is idempotent/overwriting, so calling
 * this on every `startContainer` keeps the alias pointing at the current image even
 * after a rebuild. Swallows failures from either `docker` call.
 */
async function tagImageIfNeeded(
  containerId: string,
  name: string,
): Promise<void> {
  try {
    const imageId = await dockerInspect(containerId, '{{.Image}}');
    if (imageId === null) return;

    await output('docker', {
      args: ['tag', imageId, `${name}:latest`],
      stdout: 'null',
      stderr: 'inherit',
    });
  } catch {
    // image alias tagging is cosmetic — never abort devc attach
  }
}

/**
 * Best-effort dump of captured `devcontainer up` stdout as `warning` lines
 * (stderr under the default sink — see `log.ts`) when a build fails. The CLI emits one JSON log record per line (typically
 * `{"type":"...","level":N,"text":"..."}`); we print each record's `text` field
 * when present, falling back to the raw line. This is the "print on failure"
 * diagnostic — stdout is otherwise consumed only to parse the final outcome JSON,
 * so postCreate/build detail on it would be invisible.
 */
function dumpBuildOutput(text: string): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  logWarning('--- devcontainer up output ---');
  for (const line of trimmed.split('\n')) {
    try {
      const rec = JSON.parse(line);
      logWarning(
        typeof rec?.text === 'string' ? rec.text.replace(/\r?\n$/, '') : line,
      );
    } catch {
      logWarning(line);
    }
  }
  logWarning('--- end devcontainer up output ---');
}

/**
 * Fail-fast guard for the container-creating commands (attach/claude/up/exec):
 * throws if `localFolder` doesn't exist or isn't a directory, so a mistyped path
 * never reaches `devcontainer up` — which would otherwise try to build a brand-new
 * container for the bogus path. Lookup-only commands (status/stop/down/mounts) do
 * not use this: for them a missing directory simply has no matching container.
 */
export function assertLocalFolderExists(localFolder: string): void {
  let info: ReturnType<typeof statSync>;
  try {
    info = statSync(localFolder);
  } catch {
    throw new Error(`no such directory: ${localFolder}`);
  }
  if (!info.isDirectory()) {
    throw new Error(`not a directory: ${localFolder}`);
  }
}

/** Extra knobs for the image build performed by `devcontainer up`. */
export interface StartOptions {
  /** Pass `--build-no-cache`, so the image is rebuilt from scratch. */
  noCache?: boolean;
  /** The devcontainer CLI to run `up` through. Defaults to {@link nodeDevcontainerRunner}. */
  devcontainer?: DevcontainerRunner;
}

/**
 * Builds the full `devcontainer up` argv. Pure/exported for unit testing, in the same spirit as
 * {@link buildExecArgs}.
 *
 * There are no per-mount, per-env or per-Feature args any more: everything the overlay
 * contributes is already inside the merged config at `mergedConfigPath` (see
 * {@link import("./merged_config.ts").ensureMergedConfig}), which is the whole point of merging
 * rather than translating to flags.
 *
 * How that file is delivered is the one thing `mode` decides, and the difference matters:
 *
 * - **`project`** → `--override-config`. The CLI takes the config's *content* from this file but
 *   still records the project's own `.devcontainer/devcontainer.json` as `configFilePath`, so
 *   relative `build.dockerfile`/`context`/`dockerComposeFile` and local Features resolve where
 *   the project meant them to, `.devcontainer-lock.json` is still found beside it, and the
 *   container keeps the identity labels it has always had (so VS Code still matches it).
 * - **`zero-config`** → `--config`. There is no project config to anchor to, and the merged file
 *   is the config path for every purpose. Deliberately *not* `--override-config` here: that
 *   would record `<project>/.devcontainer/devcontainer.json` — the same identity a later
 *   `devc init` produces — so devc would silently reuse this container for a project that had
 *   since gained its own config.
 */
export function buildUpArgs(input: {
  localFolder: string;
  worktree: boolean;
  rebuild: boolean;
  noCache: boolean;
  /** The merged effective config to run. */
  mergedConfigPath: string;
  /** Which flag carries it — see above. */
  mode: ConfigMode;
}): string[] {
  const args = ['up', '--workspace-folder', input.localFolder];
  if (input.worktree) args.push('--mount-git-worktree-common-dir');
  if (input.rebuild) args.push('--remove-existing-container');
  if (input.noCache) args.push('--build-no-cache');
  args.push(
    input.mode === 'project' ? '--override-config' : '--config',
    input.mergedConfigPath,
  );
  return args;
}

export async function startContainer(
  localFolder: string,
  rebuild = false,
  opts: StartOptions = {},
): Promise<ContainerInfo> {
  // Guard before any git/docker/devcontainer work so a bad path fails fast
  // instead of spinning up a container for it.
  assertLocalFolderExists(localFolder);

  // The ~/.claude seed mount's source must exist before `devcontainer up` runs: a bind mount
  // with a missing source is a hard error, not an auto-created directory.
  // Announced on creation only: the directory is empty and stays that way until the user puts
  // something in it, so without this the one place their own CLAUDE.md/settings.json can reach
  // the container is a path they have to already know about.
  const seed = await ensureClaudeSeedDir();
  if (seed.created) {
    logNotice(
      `devc: created ${
        displayPath(CLAUDE_SEED_HOST_DIR)
      } — files you drop in here (CLAUDE.md, settings.json, statusline.sh, …) are linked into the container's ~/.claude`,
    );
  }

  const worktree = await isGitWorktree(localFolder);

  // The effective config: the base config (the project's own, or the materialized bundled
  // default) with devc's own layer and both `devc.json` overlays merged in, written to this
  // project's cache directory. The `devc.json` overlay applies in *both* modes — a project with
  // its own config is exactly the case where a dev most often wants a local, gitignored mount —
  // and nothing is ever written into the project itself, so its `.devcontainer/` stays
  // standalone.
  const merged = await ensureMergedConfig(localFolder);

  const args = buildUpArgs({
    localFolder,
    worktree,
    rebuild,
    noCache: opts.noCache === true,
    mergedConfigPath: merged.path,
    mode: merged.mode,
  });

  // The devcontainer CLI is a `DevcontainerRunner`, not resolved from PATH — see
  // `devcontainer.ts`. Same argv, same captured stdout the PATH binary produced.
  const runner = opts.devcontainer ?? nodeDevcontainerRunner;
  const { code, stdout: text } = await runner.run(args);

  // devcontainer up emits one JSON object per line; the final line is the outcome
  const lines = text.trim().split('\n').filter(Boolean);
  if (lines.length === 0) {
    dumpBuildOutput(text);
    throw new Error(
      `devcontainer up failed with exit code ${code} (no output)`,
    );
  }

  // deno-lint-ignore no-explicit-any
  let result: any;
  try {
    result = JSON.parse(lines[lines.length - 1]);
  } catch {
    // The final line wasn't the expected outcome JSON — surface everything so
    // the real error (build/postCreate failure, etc.) isn't lost.
    dumpBuildOutput(text);
    throw new Error(
      `devcontainer up failed with exit code ${code} (unparseable output)`,
    );
  }

  if (result.outcome !== 'success') {
    dumpBuildOutput(text);
    throw new Error(
      `devcontainer up failed: ${result.message ?? JSON.stringify(result)}`,
    );
  }

  const name = await containerNameForLocalFolder(localFolder);
  await renameContainerIfNeeded(result.containerId, name, localFolder);
  await tagImageIfNeeded(result.containerId, name);

  // Re-derive `remoteEnv` from the merged config — `docker exec` (how exec/attach run) never
  // sees it otherwise. One call over one object: the overlay's own `remoteEnv` is already folded
  // into it, so there is no second layer to apply. Done after the `up` so
  // `${containerWorkspaceFolder}` resolves against the CLI's own `remoteWorkspaceFolder`, and
  // so `${containerEnv:…}` has a started container to read its environment back from.
  const remoteEnv = resolveRemoteEnv(
    merged.config,
    result.remoteWorkspaceFolder,
    localFolder,
    await inspectContainerEnv(result.containerId),
  );

  return {
    containerId: result.containerId,
    remoteUser: result.remoteUser,
    remoteWorkspaceFolder: result.remoteWorkspaceFolder,
    remoteEnv,
  };
}

/**
 * Recreate the container for `localFolder` from scratch: `devcontainer up` with
 * `--remove-existing-container` (plus `--build-no-cache` when asked). This — not an
 * image-only build — is what makes a `devcontainer.json` change take effect, because
 * mounts are bound at container-create time.
 *
 * Backs both `devc build` and the `devc config` post-apply rebuild prompt.
 */
export function rebuildContainer(
  localFolder: string,
  opts: StartOptions = {},
): Promise<ContainerInfo> {
  return startContainer(localFolder, true, opts);
}

export async function stopContainer(localFolder: string): Promise<void> {
  const found = await findContainer(localFolder, false);
  if (found === null) return;

  await output('docker', {
    args: ['stop', found.id],
    stdout: 'inherit',
    stderr: 'inherit',
  });
}

/**
 * Stops (if running) and removes the container for `localFolder`. No-op if no
 * container (running or stopped) matches. After this, the next `devc attach` for
 * `localFolder` creates a brand-new container.
 */
export async function downContainer(localFolder: string): Promise<void> {
  const found = await findContainer(localFolder, true);
  if (found === null) return;

  if (found.state === 'running') {
    await output('docker', {
      args: ['stop', found.id],
      stdout: 'inherit',
      stderr: 'inherit',
    });
  }

  await output('docker', {
    args: ['rm', found.id],
    stdout: 'inherit',
    stderr: 'inherit',
  });
}
