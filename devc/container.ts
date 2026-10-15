// Thin re-export over `@devc-tools/core`'s container lifecycle, pre-bound to the CLI's own
// `DevcontainerRunner` (the `__devcontainer` self-exec — see `devcontainer_selfexec.ts`) so
// `main.ts` and `tui/config_flow.ts` keep importing the same names from the same place and
// neither learns that a runner exists. `attachToContainer` and `sessionNameForWorkspaceFolder`
// are re-exported from `attach.ts` for the same reason — nothing outside this module and
// `attach.ts` itself needs to know that lifecycle and attach now live apart.
//
// Every start path bound here also runs the start hooks — the ancestor-repo mount guard
// (`git_root_guard.ts`) and the devc-bridge hooks (`bridge.ts`), whose files `downContainer`
// tears down again — so no command can start a container that skips them.

import {
  type ContainerInfo,
  downContainer as _downContainer,
  execInContainer as _execInContainer,
  type ExecOptions,
  type ExecResult,
  getContainerStatus,
  startContainer as _startContainer,
  type StartOptions,
} from '@devc-tools/core/container.ts';
import { selfExecDevcontainerRunner } from './devcontainer_selfexec.ts';
import {
  applyPolicy,
  checkGrantBeforeUp,
  ensureKeyDir,
  type PolicyMode,
  removeBridgeFiles,
} from './bridge.ts';
import { guardAncestorRepoMount, terminalConfirm } from './git_root_guard.ts';

export {
  assertLocalFolderExists,
  buildExecArgs,
  buildUpArgs,
  type ContainerInfo,
  type ContainerMount,
  containerNameForLocalFolder,
  type ContainerStatus,
  type ExecOptions,
  type ExecResult,
  getContainerMounts,
  getContainerStatus,
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
   * `--bridge-allow` and `revoke` without it. See `bridge.ts`.
   */
  bridgePolicy?: PolicyMode;
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
): Pick<StartOptions, 'beforeUp' | 'afterUp'> {
  return {
    beforeUp: async (merged) => {
      await guardAncestorRepoMount(merged, localFolder, rebuild, {
        containerExists: async () =>
          await getContainerStatus(localFolder) !== 'missing',
        confirm: terminalConfirm(),
        warn: (m) => console.error(m),
      });
      if (typeof mode === 'object') {
        await checkGrantBeforeUp(merged, localFolder, undefined, mode.repos);
      }
      await ensureKeyDir(merged);
    },
    afterUp: (merged) => applyPolicy(mode, merged, localFolder),
  };
}

/** {@link _startContainer}, pre-bound to the CLI's self-exec `DevcontainerRunner`. */
export function startContainer(
  localFolder: string,
  rebuild = false,
  opts: CliStartOptions = {},
): Promise<ContainerInfo> {
  const { bridgePolicy = 'refresh', ...rest } = opts;
  return _startContainer(localFolder, rebuild, {
    devcontainer: selfExecDevcontainerRunner,
    ...startHooks(localFolder, bridgePolicy, rebuild),
    ...rest,
  });
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
export function execInContainer(
  localFolder: string,
  opts: ExecOptions,
): Promise<ExecResult> {
  return _execInContainer(localFolder, {
    devcontainer: selfExecDevcontainerRunner,
    ...startHooks(localFolder, 'refresh', false),
    ...opts,
  });
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
