// devc's list of projects: the folders the user pinned and the ones devc started recently, kept in
// `~/.config/devc/projects.json`. Every CLI start path records the folder it started
// (`container.ts`), and `devc web` lists them — so a project shows up there even while its
// container is stopped or gone.
//
// Not the global config (`~/.config/devc/config.json`, which the config wizard edits) and not
// devc-core's `~/.cache/devc/projects/<key>/` merged-config cache: this file is rewritten by
// starts and by `devc web`, and holds nothing but folders.

import { dirname } from 'jsr:@std/path';
import { CONFIG_DIR } from '@devc-tools/core/default_config.ts';

export const PROJECTS_PATH = `${CONFIG_DIR}/projects.json`;

/** How many unpinned projects are remembered; pinned ones are always kept. */
export const MAX_RECENT = 20;

export interface ProjectEntry {
  /** Absolute host path, exactly as the start path got it (the `devcontainer.local_folder` label). */
  localFolder: string;
  pinned: boolean;
  /** ISO time of the last start, `null` for a project pinned but never started. */
  lastUsed: string | null;
}

function isEntry(v: unknown): v is ProjectEntry {
  if (typeof v !== 'object' || v === null) return false;
  const e = v as Record<string, unknown>;
  return typeof e.localFolder === 'string' && e.localFolder.startsWith('/') &&
    typeof e.pinned === 'boolean' &&
    (e.lastUsed === null || typeof e.lastUsed === 'string');
}

/** Missing or unreadable file → []. Drops malformed entries; never throws. */
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
  }).map(({ localFolder, pinned, lastUsed }) => ({
    localFolder,
    pinned,
    lastUsed,
  }));
}

/** Newest first; never-used last. */
function byRecency(a: ProjectEntry, b: ProjectEntry): number {
  return (b.lastUsed ?? '').localeCompare(a.lastUsed ?? '');
}

/**
 * Bumps `localFolder` to `now` (adding it unpinned if new), then keeps every pinned entry plus
 * the {@link MAX_RECENT} most recent unpinned ones. Pure.
 */
export function recordUse(
  list: ProjectEntry[],
  localFolder: string,
  now: Date,
): ProjectEntry[] {
  const lastUsed = now.toISOString();
  const found = list.some((e) => e.localFolder === localFolder);
  const next = found
    ? list.map((e) => e.localFolder === localFolder ? { ...e, lastUsed } : e)
    : [...list, { localFolder, pinned: false, lastUsed }];
  const keep = new Set(
    next.filter((e) => !e.pinned).sort(byRecency).slice(0, MAX_RECENT),
  );
  return next.filter((e) => e.pinned || keep.has(e)).sort(byRecency);
}

/** Pins or unpins a folder; pinning an unknown one adds it with `lastUsed: null`. Pure. */
export function setPinned(
  list: ProjectEntry[],
  localFolder: string,
  pinned: boolean,
): ProjectEntry[] {
  if (list.some((e) => e.localFolder === localFolder)) {
    return list.map((e) =>
      e.localFolder === localFolder ? { ...e, pinned } : e
    );
  }
  return pinned ? [...list, { localFolder, pinned, lastUsed: null }] : list;
}

/** Drops a folder from the list. Pure. */
export function forget(
  list: ProjectEntry[],
  localFolder: string,
): ProjectEntry[] {
  return list.filter((e) => e.localFolder !== localFolder);
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
      JSON.stringify({ version: 1, projects: next }, null, 2) + '\n',
    );
    await Deno.rename(tmp, path);
  } catch (e) {
    await Deno.remove(tmp).catch(() => {});
    throw e;
  }
  return next;
}
