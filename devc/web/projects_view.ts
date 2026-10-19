// The `projects` message `devc web` sends: every folder in devc's projects list, plus every folder
// a devcontainer (running or stopped) carries in its label, each with its container status. Pure,
// so the merge is tested without Docker; `server.ts` supplies the inputs.

import { basename } from 'jsr:@std/path';
import type { ProjectEntry } from '../projects.ts';
import type { MountedRepo } from './git_repo.ts';
import { type GitReading, type GitStatus, isGitProblem } from './git_status.ts';

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
  /** Why `git` is `null` for a folder that is a repo: `detached HEAD`, a timed-out or failed git call. */
  gitProblem?: string;
}

/**
 * Merges the projects list with what discovery knows. `running` and `stopped` are the
 * `localFolder`s of running and stopped containers; a folder with both counts as running.
 * `repos` holds each container's mounted repos by project folder (a folder missing from it has
 * just itself), and `git` each repo's push/pull state (or why it has none), when read. Sorted by name, then folder.
 */
export function buildProjects(
  entries: readonly ProjectEntry[],
  running: Iterable<string>,
  stopped: Iterable<string>,
  starting: ReadonlySet<string>,
  repos: ReadonlyMap<string, readonly MountedRepo[]> = new Map(),
  git: ReadonlyMap<string, GitReading> = new Map(),
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
        ...gitFields(git, r.folder),
      })),
  })).sort((a, b) =>
    a.name.localeCompare(b.name) || a.localFolder.localeCompare(b.localFolder)
  );
}

/** A repo's `git` (and `gitProblem`) fields from its reading; none until it is read. */
function gitFields(
  git: ReadonlyMap<string, GitReading>,
  folder: string,
): Pick<RepoView, 'git' | 'gitProblem'> {
  if (!git.has(folder)) return {};
  const reading = git.get(folder) ?? null;
  return isGitProblem(reading)
    ? { git: null, gitProblem: reading.problem }
    : { git: reading };
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

/**
 * The repo of the project at `localFolder` that holds `hostPath`, as `{root, path}` for
 * `read_file` (`path` relative to `root`, `''` for the root itself), or null when it is in none.
 * Nested repos (a worktree inside its repo's folder) go to the innermost.
 */
export function repoFileFor(
  projects: readonly ProjectView[],
  localFolder: string,
  hostPath: string,
): { root: string; path: string } | null {
  let root: string | null = null;
  for (const p of projects) {
    if (p.localFolder !== localFolder) continue;
    for (const { folder } of p.repos) {
      const inside = hostPath === folder ||
        hostPath.startsWith(folder === '/' ? '/' : `${folder}/`);
      if (inside && (root === null || folder.length > root.length)) {
        root = folder;
      }
    }
  }
  if (root === null) return null;
  return {
    root,
    path: hostPath === root
      ? ''
      : hostPath.slice(root === '/' ? 1 : root.length + 1),
  };
}
