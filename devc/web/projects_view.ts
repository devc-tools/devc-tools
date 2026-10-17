// The `projects` message `devc web` sends: every folder in devc's projects list, plus every folder
// a devcontainer (running or stopped) carries in its label, each with its container status. Pure,
// so the merge is tested without Docker; `server.ts` supplies the inputs.

import { basename } from 'jsr:@std/path';
import type { ProjectEntry } from '../projects.ts';

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
}

/**
 * Merges the projects list with what discovery knows. `running` and `stopped` are the
 * `localFolder`s of running and stopped containers; a folder with both counts as running.
 * Sorted by name, then folder.
 */
export function buildProjects(
  entries: readonly ProjectEntry[],
  running: Iterable<string>,
  stopped: Iterable<string>,
  starting: ReadonlySet<string>,
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
  })).sort((a, b) =>
    a.name.localeCompare(b.name) || a.localFolder.localeCompare(b.localFolder)
  );
}

/**
 * Why a project message is refused while container starts are off (`devc web --live`: the page
 * comes from a checkout agents can write to), or `null` when it may go ahead. Off, nothing may
 * start a container or bring in a folder: `start_project`, `add_project` and pinning are
 * refused. Stop, unpin and forget never widen what can be reached, so they stay allowed.
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
  return null;
}
