// Thin re-export over `@devc-tools/core`'s container lifecycle, pre-bound to the CLI's own
// `DevcontainerRunner` (the `__devcontainer` self-exec — see `devcontainer_selfexec.ts`) so
// `main.ts` and `tui/config_flow.ts` keep importing the same names from the same place and
// neither learns that a runner exists. `attachToContainer` and `sessionNameForWorkspaceFolder`
// are re-exported from `attach.ts` for the same reason — nothing outside this module and
// `attach.ts` itself needs to know that lifecycle and attach now live apart.
//
// Every start path bound here also runs the start hooks — the ancestor-repo mount guard
// (`git_root_guard.ts`) and the devc-bridge hooks (`bridge.ts`), whose files `downContainer`
// tears down again — so no command can start a container that skips them. Each also records
// the project in devc's projects list (`projects.ts`), which `devc web` shows.

import {
  connectionFor as _connectionFor,
  type ContainerInfo,
  downContainer as _downContainer,
  execInContainer as _execInContainer,
  type ExecOptions,
  type ExecResult,
  getContainerStatus,
  startContainer as _startContainer,
  type StartOptions,
} from '@devc-tools/core/container.ts';
import type { DevcontainerRunner } from '@devc-tools/core/devcontainer.ts';
import { selfExecDevcontainerRunner } from './devcontainer_selfexec.ts';
import {
  applyPolicy,
  checkDefaultsBeforeUp,
  checkGrantBeforeUp,
  ensureKeyDir,
  type PolicyMode,
  removeBridgeFiles,
} from './bridge.ts';
import {
  guardAncestorRepoMount,
  type GuardDeps,
  terminalConfirm,
} from './git_root_guard.ts';
import { recordUse, updateProjects } from './projects.ts';

export {
  assertLocalFolderExists,
  buildUpArgs,
  type ContainerInfo,
  type ContainerMount,
  containerNameForLocalFolder,
  type ContainerStatus,
  dockerExecArgv,
  type DockerExecSpec,
  type ExecOptions,
  type ExecResult,
  getContainerMounts,
  getContainerStatus,
  loginShellArgv,
  parseMounts,
  resolveLocalFolder,
  type StartOptions,
  stopContainer,
} from '@devc-tools/core/container.ts';

export { attachToContainer, sessionNameForWorkspaceFolder } from './attach.ts';
export type { AttachOptions } from './attach.ts';

/** The CLI's start options: core's, plus what to do with the devc-bridge policy. */
export interface CliStartOptions extends StartOptions {
  /**
   * `refresh` (the default) for every start path except `up`/`build`, which pass `{ grant }` with
   * `--bridge-allow <list>`, `{ defaultGrant }` without it when `bridgeDefaultAllow` or
   * `bridgeRepoAllow` is set, and `revoke` otherwise. See `bridge.ts`.
   */
  bridgePolicy?: PolicyMode;
  /**
   * How the ancestor-repo guard asks and warns. Defaults to the terminal (no question at all
   * when stdin/stdout is not one) and stderr; `devc web` answers "no" and shows the warning in
   * the start's output instead, since its own terminal is not the user's.
   */
  guard?: Pick<GuardDeps, 'confirm' | 'warn'>;
}

/**
 * The hooks every CLI start path runs: ask before creating a container whose workspace mount
 * would be an ancestor repo (`git_root_guard.ts`); then the devc-bridge ones — create this
 * workspace's key directory before `up` (a bind mount's source must exist), then write, refresh
 * or revoke its policy after.
 */
function startHooks(
  localFolder: string,
  mode: PolicyMode,
  rebuild: boolean,
  guard?: CliStartOptions['guard'],
): Pick<StartOptions, 'beforeUp' | 'afterUp'> {
  return {
    beforeUp: async (merged) => {
      await guardAncestorRepoMount(merged, localFolder, rebuild, {
        containerExists: async () =>
          await getContainerStatus(localFolder) !== 'missing',
        confirm: guard ? guard.confirm : terminalConfirm(),
        warn: guard ? guard.warn : (m) => console.error(m),
      });
      // A default grant never fails the start for a repo's preconditions, but a `--bridge-repo`
      // that names nothing pinnable is still a mistake on the command line.
      if (typeof mode === 'object' && 'grant' in mode) {
        await checkGrantBeforeUp(merged, localFolder, undefined, mode.repos);
      } else if (typeof mode === 'object' && 'defaultGrant' in mode) {
        await checkDefaultsBeforeUp(merged, localFolder, undefined, mode.repos);
      }
      await ensureKeyDir(merged);
    },
    afterUp: (merged) => applyPolicy(mode, merged, localFolder),
  };
}

/** {@link _startContainer}, pre-bound to the CLI's self-exec `DevcontainerRunner`. */
export async function startContainer(
  localFolder: string,
  rebuild = false,
  opts: CliStartOptions = {},
): Promise<ContainerInfo> {
  const { bridgePolicy = 'refresh', guard, ...rest } = opts;
  const info = await _startContainer(localFolder, rebuild, {
    devcontainer: selfExecDevcontainerRunner,
    ...startHooks(localFolder, bridgePolicy, rebuild, guard),
    ...rest,
  });
  await recordProject(localFolder);
  return info;
}

/**
 * {@link _connectionFor}, pre-bound to the CLI's self-exec `DevcontainerRunner` (`runner`
 * overrides it, e.g. to capture the CLI's stderr). No start hooks and no project recording:
 * those are start effects, and this starts nothing.
 */
export function connectionFor(
  localFolder: string,
  containerId: string,
  runner: DevcontainerRunner = selfExecDevcontainerRunner,
): Promise<ContainerInfo> {
  return _connectionFor(localFolder, containerId, { devcontainer: runner });
}

/**
 * Bumps `localFolder` in devc's projects list. Best-effort: a failure is one warning, never a
 * failed start.
 */
async function recordProject(localFolder: string): Promise<void> {
  try {
    await updateProjects((list) => recordUse(list, localFolder, new Date()));
  } catch (e) {
    console.error(
      `devc: could not record ${localFolder} in the projects list: ${
        e instanceof Error ? e.message : e
      }`,
    );
  }
}

/** {@link _startContainer} with `rebuild: true`, pre-bound the same way. */
export function rebuildContainer(
  localFolder: string,
  opts: CliStartOptions = {},
): Promise<ContainerInfo> {
  return startContainer(localFolder, true, opts);
}

/**
 * {@link _execInContainer}, pre-bound to the CLI's self-exec `DevcontainerRunner` — `exec`
 * starts the container first (via `startContainer`) when it is not already running, so it needs
 * the same binding `startContainer` above does, start hooks included (a bridge refresh).
 */
export async function execInContainer(
  localFolder: string,
  opts: ExecOptions,
): Promise<ExecResult> {
  const result = await _execInContainer(localFolder, {
    devcontainer: selfExecDevcontainerRunner,
    ...startHooks(localFolder, 'refresh', false),
    ...opts,
  });
  await recordProject(localFolder);
  return result;
}

/**
 * {@link _downContainer}, plus teardown of this workspace's devc-bridge key directory and policy —
 * devc created them, so devc removes them. Done whether or not a container was found, so a
 * leftover from an earlier `down` goes too.
 */
export async function downContainer(localFolder: string): Promise<boolean> {
  const removed = await _downContainer(localFolder);
  await removeBridgeFiles(localFolder);
  return removed;
}
