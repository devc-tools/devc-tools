// devc's list of projects: the folders the user added, kept in `~/.config/devc/projects.json`.
// **Add project** in `devc web` adds one, and so does every CLI start path (`container.ts`); only
// **Remove project** takes one out. `devc web` lists them, so a project shows up there even while
// its container is stopped or gone.
//
// Not the global config (`~/.config/devc/config.jsonc` or `config.json`, which the config wizard
// edits) and not devc-core's `~/.cache/devc/projects/<key>/` merged-config cache: this file is
// rewritten by starts and by `devc web`, and holds nothing but folders.

import { dirname } from 'jsr:@std/path';
import { CONFIG_DIR } from '@devc-tools/core/default_config.ts';

export const PROJECTS_PATH = `${CONFIG_DIR}/projects.json`;

export interface ProjectEntry {
  /** Absolute host path, exactly as the start path got it (the `devcontainer.local_folder` label). */
  localFolder: string;
  /**
   * Where `devc web` runs it when no devcontainer carries it: a container, or on this machine
   * (`web/projects_view.ts`'s `effectiveEnvironment`). Absent means unset.
   */
  environment?: ProjectEnvironment;
}

/** A project entry's `environment`. */
export type ProjectEnvironment = 'host' | 'container';

function isEnvironment(v: unknown): v is ProjectEnvironment {
  return v === 'host' || v === 'container';
}

function isEntry(v: unknown): v is ProjectEntry {
  if (typeof v !== 'object' || v === null) return false;
  const e = v as Record<string, unknown>;
  return typeof e.localFolder === 'string' && e.localFolder.startsWith('/');
}

/**
 * Missing or unreadable file → []. Drops malformed entries; never throws. Fields an older devc
 * wrote (`pinned`, `lastUsed`) are ignored, so every entry it kept is kept.
 */
export async function loadProjects(
  path = PROJECTS_PATH,
): Promise<ProjectEntry[]> {
  let data: unknown;
  try {
    data = JSON.parse(await Deno.readTextFile(path));
  } catch {
    return [];
  }
  const projects = (data as { projects?: unknown } | null)?.projects;
  if (!Array.isArray(projects)) return [];
  const seen = new Set<string>();
  return projects.filter((e): e is ProjectEntry => {
    if (!isEntry(e) || seen.has(e.localFolder)) return false;
    seen.add(e.localFolder);
    return true;
  }).map(({ localFolder, environment }) => ({
    localFolder,
    // A value this devc doesn't know is dropped, not the entry.
    ...(isEnvironment(environment) ? { environment } : {}),
  }));
}

/**
 * Adds `localFolder` when it isn't listed; with `environment`, sets where it runs too. Pure.
 */
export function addProject(
  list: ProjectEntry[],
  localFolder: string,
  environment?: ProjectEnvironment,
): ProjectEntry[] {
  const next = list.some((e) => e.localFolder === localFolder)
    ? list
    : [...list, { localFolder }];
  return environment === undefined
    ? next
    : setEnvironment(next, localFolder, environment);
}

/** Sets where a folder runs (see {@link ProjectEntry.environment}), adding it if new. Pure. */
export function setEnvironment(
  list: ProjectEntry[],
  localFolder: string,
  environment: ProjectEnvironment,
): ProjectEntry[] {
  if (list.some((e) => e.localFolder === localFolder)) {
    return list.map((e) =>
      e.localFolder === localFolder ? { ...e, environment } : e
    );
  }
  return [...list, { localFolder, environment }];
}

/** Drops a folder from the list. Pure. */
export function removeProject(
  list: ProjectEntry[],
  localFolder: string,
): ProjectEntry[] {
  return list.filter((e) => e.localFolder !== localFolder);
}

/**
 * An entry as written: with `pinned: true` and `lastUsed: null`, the fields an older devc requires,
 * so one still reading this file keeps every entry instead of dropping them all, and never ages
 * one out of its recent list.
 */
function written(e: ProjectEntry) {
  return {
    localFolder: e.localFolder,
    pinned: true,
    lastUsed: null,
    ...(e.environment ? { environment: e.environment } : {}),
  };
}

/**
 * Load → `change` → write. The write is atomic (a temp file renamed over the old one in the same
 * directory), so a reader never sees half a file.
 */
export async function updateProjects(
  change: (list: ProjectEntry[]) => ProjectEntry[],
  path = PROJECTS_PATH,
): Promise<ProjectEntry[]> {
  const next = change(await loadProjects(path));
  const dir = dirname(path);
  await Deno.mkdir(dir, { recursive: true });
  const tmp = await Deno.makeTempFile({ dir, prefix: '.projects-' });
  try {
    await Deno.writeTextFile(
      tmp,
      JSON.stringify({ version: 1, projects: next.map(written) }, null, 2) +
        '\n',
    );
    await Deno.rename(tmp, path);
  } catch (e) {
    await Deno.remove(tmp).catch(() => {});
    throw e;
  }
  return next;
}
