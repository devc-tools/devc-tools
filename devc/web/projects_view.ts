// The `projects` message `devc web` sends: every folder in devc's projects list, plus every folder
// a devcontainer (running or stopped) carries in its label, each with its container status. Pure,
// so the merge is tested without Docker; `server.ts` supplies the inputs.

import { basename } from 'jsr:@std/path';
import type { ProjectEntry } from '../projects.ts';
import type { EnvironmentKind } from './environment.ts';
import type { MountedRepo } from './git_repo.ts';
import type { ChangesReading, GitChanges } from './git_changes.ts';
import { type GitReading, type GitStatus, isGitProblem } from './git_status.ts';

/** A project's container: running, only stopped ones, or none at all. */
export type ProjectContainer = 'running' | 'stopped' | 'missing';

export interface ProjectView {
  localFolder: string;
  name: string;
  container: ProjectContainer;
  /** A `start_project` for it is in flight. */
  starting: boolean;
  /** Where it runs: see {@link effectiveEnvironment}. */
  environment: EnvironmentKind;
  /**
   * Its repos, the folder itself first: with a container, every repo that container mounts and
   * the worktrees beside them; without one, just the folder. The rest go by `name`, each
   * followed by its worktrees, also by `name`.
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
  /** Its working tree's changes; absent until read, or while its environment isn't running. */
  changes?: GitChanges;
  /** Why there is no `changes` for a repo that should have one. */
  changesProblem?: string;
}

/**
 * Where a project runs: in a container when a devcontainer (running or stopped) carries its
 * folder; else its entry's `environment` when this server has that kind; else in a container
 * when Docker is there, otherwise on this machine.
 */
export function effectiveEnvironment(
  entry: Pick<ProjectEntry, 'environment'> | undefined,
  hasContainer: boolean,
  available: readonly EnvironmentKind[],
): EnvironmentKind {
  if (hasContainer) return 'container';
  if (entry?.environment && available.includes(entry.environment)) {
    return entry.environment;
  }
  return available.includes('container') ? 'container' : 'host';
}

/** What {@link buildProjects} needs to say where each project runs. */
export interface EnvironmentFacts {
  /** The folders a devcontainer, running or stopped, carries. */
  containers: ReadonlySet<string>;
  /** The kinds this server can run. */
  available: readonly EnvironmentKind[];
}

/**
 * Merges the projects list with what discovery knows. `running` and `stopped` are the
 * `localFolder`s of running and stopped containers; a folder with both counts as running.
 * `repos` holds each container's mounted repos by project folder (a folder missing from it has
 * just itself), and `git` each repo's push/pull state (or why it has none), when read. `changes`
 * holds each running project's repos' changes to commit (or why there are none), by project
 * folder, then repo folder. Sorted by name, then folder.
 */
export function buildProjects(
  entries: readonly ProjectEntry[],
  running: Iterable<string>,
  stopped: Iterable<string>,
  starting: ReadonlySet<string>,
  repos: ReadonlyMap<string, readonly MountedRepo[]> = new Map(),
  git: ReadonlyMap<string, GitReading> = new Map(),
  environments?: EnvironmentFacts,
  changes: ReadonlyMap<string, ReadonlyMap<string, ChangesReading>> = new Map(),
): ProjectView[] {
  const runningSet = new Set(running);
  const stoppedSet = new Set(stopped);
  const facts = environments ?? {
    containers: new Set([...runningSet, ...stoppedSet]),
    available: ['container'] as const,
  };
  const byFolder = new Map<string, ProjectEntry>();
  for (const e of entries) byFolder.set(e.localFolder, e);
  for (const folder of [...runningSet, ...stoppedSet]) {
    if (!byFolder.has(folder)) {
      byFolder.set(folder, { localFolder: folder });
    }
  }
  return [...byFolder.values()].map((e) => ({
    localFolder: e.localFolder,
    name: basename(e.localFolder) || e.localFolder,
    container: runningSet.has(e.localFolder)
      ? 'running' as const
      : stoppedSet.has(e.localFolder)
      ? 'stopped' as const
      : 'missing' as const,
    starting: starting.has(e.localFolder),
    environment: effectiveEnvironment(
      e,
      facts.containers.has(e.localFolder),
      facts.available,
    ),
    repos: byRepoName(
      (repos.get(e.localFolder) ??
        [{
          folder: e.localFolder,
          worktreeOf: null,
          containerFolder: null,
          primaryFolder: null,
        }])
        .map((r) => ({
          ...r,
          name: repoName(r.folder, r.containerFolder),
          ...gitFields(git, r.folder),
          ...changesFields(changes.get(e.localFolder)?.get(r.folder)),
        })),
    ),
  })).sort((a, b) =>
    a.name.localeCompare(b.name) || a.localFolder.localeCompare(b.localFolder)
  );
}

/**
 * `repos` (the project folder first) reordered by the names the sidebar shows: the first stays
 * first, the other repos follow by name, then folder, and each is followed by its worktrees
 * (`worktreeOf` it) in the same order. A worktree whose repo is not listed goes as a repo.
 */
function byRepoName(repos: readonly RepoView[]): RepoView[] {
  if (repos.length === 0) return [];
  const [first, ...rest] = repos;
  const order = (a: RepoView, b: RepoView) =>
    a.name.localeCompare(b.name) || a.folder.localeCompare(b.folder);
  const folders = new Set(repos.map((r) => r.folder));
  const isTop = (r: RepoView) =>
    r.worktreeOf === null || !folders.has(r.worktreeOf);
  const out: RepoView[] = [];
  for (const top of [first, ...rest.filter(isTop).sort(order)]) {
    out.push(top);
    out.push(
      ...rest.filter((r) => !isTop(r) && r.worktreeOf === top.folder).sort(
        order,
      ),
    );
  }
  return out;
}

/**
 * A repo's name in the sidebar: its path under `/workspaces` in the container
 * (`/workspaces/tools/devc-tools` → `tools/devc-tools`), else its folder's basename.
 */
export function repoName(
  folder: string,
  containerFolder: string | null,
): string {
  const inside = containerFolder?.replace(/\/+$/, '') ?? '';
  const prefix = '/workspaces/';
  if (inside.startsWith(prefix) && inside.length > prefix.length) {
    return inside.slice(prefix.length);
  }
  return basename(folder) || folder;
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

/** A repo's `changes` (or `changesProblem`) field from its reading; none until it is read. */
function changesFields(
  reading: ChangesReading | undefined,
): Pick<RepoView, 'changes' | 'changesProblem'> {
  if (reading === undefined) return {};
  return 'problem' in reading
    ? { changesProblem: reading.problem }
    : { changes: reading };
}

/**
 * What a `/ws` connection may do. `page`: anything holding the page token, which counts as the
 * page. `desktop`: devc-desktop's bundled Containers pane, which came with the desktop token
 * (`--desktop-channel`) and whose clicks the user made in the app's own view.
 */
export type WsRole = 'page' | 'desktop';

/** The modes {@link projectRefusal} weighs: `startWeb`'s `projectStarts` and `desktopProjects`. */
export interface ProjectModes {
  /** Off under `devc web --live`: the page comes from a checkout agents can write to. */
  startsAllowed: boolean;
  /** Off under `--live-yolo`: the server code itself comes from such a checkout. */
  desktopProjects: boolean;
}

/** The project messages only the `desktop` role may send when starts are off for a page. */
const DESKTOP_GRANTS = [
  'start_project',
  'add_project',
  'set_project_environment',
  'list_host_dir',
  'stop_project',
  'down_project',
];

/**
 * Why a project message from a connection of `role` is refused, or `null` when it may go ahead.
 *
 * A page, while container starts are off (`devc web --live`): nothing may start a container or
 * bring in a folder, so `start_project` and `add_project` are refused, and so is `list_host_dir`,
 * which only serves "Add project…". Stop and remove never widen what can be reached, so they stay
 * allowed. A start can still be asked of devc-desktop (`request_project`); the refusal says so.
 *
 * The desktop role may do all of that under `--live` too (and stop and remove), since the user
 * confirmed it in the app. Under `--live-yolo` it may do none of it: the server is then code a
 * container may have written, which the app's confirm must not appear to vouch for.
 */
export function projectRefusal(
  msg: { type: string },
  role: WsRole,
  modes: ProjectModes,
): string | null {
  if (role === 'desktop') {
    if (modes.desktopProjects || !DESKTOP_GRANTS.includes(msg.type)) {
      return null;
    }
    return "devc-desktop's Containers pane starts, stops and adds nothing while devc web runs with --live-yolo: hide the pane (Layout → Containers Pane) to use devc web's own Projects section";
  }
  if (modes.startsAllowed) return null;
  const off = 'is off while devc web runs with --live';
  if (msg.type === 'start_project') {
    return `starting containers ${off}: in devc-desktop, Start asks it instead`;
  }
  if (msg.type === 'add_project') return `adding projects ${off}`;
  if (msg.type === 'set_project_environment') {
    return `changing where projects run ${off}`;
  }
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
