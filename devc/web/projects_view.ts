// The `projects` message `devc web` sends: every folder in devc's projects list, plus every folder
// a devcontainer (running or stopped) carries in its label, each with its container status. Pure,
// so the merge is tested without Docker; `server.ts` supplies the inputs.

import { basename } from 'jsr:@std/path';
import type { ProjectEntry } from '../projects.ts';
import type { MountedRepo } from './git_repo.ts';
import type { GitStatus } from './git_status.ts';

/** A project's container: running, only stopped ones, or none at all. */
export type ProjectContainer = 'running' | 'stopped' | 'missing';

export interface ProjectView {
  localFolder: string;
  name: string;
  pinned: boolean;
  lastUsed: string | null;
  container: ProjectContainer;
  /** A `start_project` for it is in flight. */
  starting: boolean;
  /**
   * Its repos, the folder itself first: with a container, every repo that container mounts and
   * the worktrees beside them; without one, just the folder.
   */
  repos: RepoView[];
}

/** One repo in a project, and its push/pull state. */
export interface RepoView extends MountedRepo {
  name: string;
  /** Its branch against its upstream; `null` when it is no repo or detached, absent until read. */
  git?: GitStatus | null;
}

/**
 * Merges the projects list with what discovery knows. `running` and `stopped` are the
 * `localFolder`s of running and stopped containers; a folder with both counts as running.
 * `repos` holds each container's mounted repos by project folder (a folder missing from it has
 * just itself), and `git` each repo's push/pull state, when read. Sorted by name, then folder.
 */
export function buildProjects(
  entries: readonly ProjectEntry[],
  running: Iterable<string>,
  stopped: Iterable<string>,
  starting: ReadonlySet<string>,
  repos: ReadonlyMap<string, readonly MountedRepo[]> = new Map(),
  git: ReadonlyMap<string, GitStatus | null> = new Map(),
): ProjectView[] {
  const runningSet = new Set(running);
  const stoppedSet = new Set(stopped);
  const byFolder = new Map<string, ProjectEntry>();
  for (const e of entries) byFolder.set(e.localFolder, e);
  for (const folder of [...runningSet, ...stoppedSet]) {
    if (!byFolder.has(folder)) {
      byFolder.set(folder, {
        localFolder: folder,
        pinned: false,
        lastUsed: null,
      });
    }
  }
  return [...byFolder.values()].map((e) => ({
    localFolder: e.localFolder,
    name: basename(e.localFolder) || e.localFolder,
    pinned: e.pinned,
    lastUsed: e.lastUsed,
    container: runningSet.has(e.localFolder)
      ? 'running' as const
      : stoppedSet.has(e.localFolder)
      ? 'stopped' as const
      : 'missing' as const,
    starting: starting.has(e.localFolder),
    repos: (repos.get(e.localFolder) ??
      [{ folder: e.localFolder, worktreeOf: null }]).map((r) => ({
        ...r,
        name: basename(r.folder) || r.folder,
        ...(git.has(r.folder) ? { git: git.get(r.folder) } : {}),
      })),
  })).sort((a, b) =>
    a.name.localeCompare(b.name) || a.localFolder.localeCompare(b.localFolder)
  );
}

/**
 * Why a project message is refused while container starts are off (`devc web --live`: the page
 * comes from a checkout agents can write to), or `null` when it may go ahead. Off, nothing may
 * start a container or bring in a folder: `start_project`, `add_project` and pinning are
 * refused, and so is `list_host_dir`, which only serves "Add project…". Stop, unpin and forget never widen what can be reached, so they stay allowed.
 */
export function projectRefusal(
  msg: { type: string; pinned?: boolean },
  startsAllowed: boolean,
): string | null {
  if (startsAllowed) return null;
  const off = 'is off while devc web runs with --live';
  if (msg.type === 'start_project') return `starting containers ${off}`;
  if (msg.type === 'add_project') return `adding projects ${off}`;
  if (msg.type === 'pin_project' && msg.pinned) return `pinning ${off}`;
  if (msg.type === 'list_host_dir') return `browsing host folders ${off}`;
  return null;
}

/**
 * Whether `root` is one of the repo folders of the project at `localFolder` in `projects` (as the
 * `projects` message lists them): the folders `list_dir`, `read_file` and
 * `open_file` may address files under.
 */
export function isProjectRepo(
  projects: readonly ProjectView[],
  localFolder: string,
  root: string,
): boolean {
  return projects.some((p) =>
    p.localFolder === localFolder && p.repos.some((r) => r.folder === root)
  );
}
