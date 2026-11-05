// One Herdr workspace per repo: a new pane goes into the workspace of the repo its `cwd` is in,
// labeled with that repo's card name, found again by that label in Herdr's live state on every
// create. Nothing is stored, so it survives server restarts and adopts a workspace the user made
// in the TUI under the same label. Keyed by repo, not by folder: `open_file` starts in the
// file's own folder, and a workspace per folder would be noise.

import type { MountedRepo } from './git_repo.ts';
import {
  BridgeError,
  bridgeRequest,
  createdPane,
  createShell,
  type HerdrTarget,
} from './herdr_bridge.ts';
import { repoName } from './projects_view.ts';

/** A folder without its trailing `/`s (`/` stays `/`). */
function trimSlash(folder: string): string {
  return folder.replace(/\/+$/, '') || '/';
}

/**
 * The repo whose workspace a pane at `cwd` belongs in: the repo with the deepest
 * `containerFolder` holding `cwd`, else the primary repo (`folder === localFolder`), else null
 * (the primary isn't mounted, or the repos aren't read yet). Repos with no `containerFolder` never
 * count.
 */
export function workspaceRepo(
  cwd: string | undefined,
  repos: readonly MountedRepo[],
  localFolder: string,
): MountedRepo | null {
  const mounted = repos.filter((r) => r.containerFolder !== null);
  if (cwd !== undefined) {
    let best: MountedRepo | null = null;
    let bestLen = -1;
    for (const r of mounted) {
      const dir = trimSlash(r.containerFolder as string);
      const inside = cwd === dir ||
        cwd.startsWith(dir === '/' ? '/' : `${dir}/`);
      if (inside && dir.length > bestLen) {
        best = r;
        bestLen = dir.length;
      }
    }
    if (best !== null) return best;
  }
  return mounted.find((r) => r.folder === localFolder) ?? null;
}

/** The label of a repo's workspace: its card's name (`repoName`). */
export function workspaceLabel(repo: MountedRepo): string {
  return repoName(repo.folder, repo.containerFolder);
}

/**
 * The id of the workspace labeled exactly `label` in a `workspace.list` result, the lowest
 * `number` when several are; null when none is.
 */
export function workspaceByLabel(
  listed: unknown,
  label: string,
): string | null {
  const all = (listed as { workspaces?: unknown } | undefined)?.workspaces;
  if (!Array.isArray(all)) return null;
  let best: { id: string; n: number } | null = null;
  for (const w of all) {
    const ws = w as {
      workspace_id?: unknown;
      label?: unknown;
      number?: unknown;
    };
    if (ws?.label !== label || typeof ws.workspace_id !== 'string') continue;
    const n = typeof ws.number === 'number' ? ws.number : Infinity;
    if (best === null || n < best.n) best = { id: ws.workspace_id, n };
  }
  return best?.id ?? null;
}

/** Each environment's last create, so creates for one environment run one at a time. */
const chains = new Map<string, Promise<unknown>>();

/** Runs `job` after every earlier job for `key` has settled. */
function serialized<T>(key: string, job: () => Promise<T>): Promise<T> {
  const run = (chains.get(key) ?? Promise.resolve()).then(job, job);
  const tail = run.catch(() => {});
  chains.set(key, tail);
  void tail.then(() => {
    if (chains.get(key) === tail) chains.delete(key);
  });
  return run;
}

/** Where a pane is wanted, and the environment it is in. */
export interface RepoShellOptions {
  /** The environment's id: creates for one id are serialized. */
  key: string;
  cwd?: string;
  /** An explicit workspace (the page's `new_shell`): used as is, no repo lookup. */
  workspace_id?: string;
  repos: readonly MountedRepo[];
  localFolder: string;
}

/**
 * A new pane in its own Herdr tab, in the workspace of the repo `cwd` is in: found by label with
 * `workspace.list`, else made with `workspace.create`, whose first tab's root pane is the new
 * pane. With an explicit `workspace_id`, or no repo to go by, it is {@link createShell}.
 */
export function createRepoShell(
  t: HerdrTarget,
  opts: RepoShellOptions,
): Promise<{ pane_id: string; tab_id: string }> {
  const cwd = opts.cwd !== undefined ? { cwd: opts.cwd } : {};
  if (opts.workspace_id !== undefined) {
    return createShell(t, { workspace_id: opts.workspace_id, ...cwd });
  }
  const repo = workspaceRepo(opts.cwd, opts.repos, opts.localFolder);
  if (repo === null) return createShell(t, cwd);
  const label = workspaceLabel(repo);
  return serialized(opts.key, async () => {
    const id = workspaceByLabel(
      await bridgeRequest(t, 'workspace.list', {}),
      label,
    );
    if (id !== null) {
      try {
        return await createShell(t, { workspace_id: id, ...cwd });
      } catch (e) {
        // Closed between the list and the create: make it again.
        if (!(e instanceof BridgeError && e.code === 'workspace_not_found')) {
          throw e;
        }
      }
    }
    return createdPane(
      t,
      await bridgeRequest(t, 'workspace.create', {
        ...cwd,
        label,
        focus: false,
      }),
    );
  });
}
