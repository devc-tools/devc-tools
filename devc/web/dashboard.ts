// `devc web`'s dashboard: one repo file the user marks as the place every session starts (a
// generated `dashboard.html`, a `focus.md`), in `~/.config/devc/dashboard.json`. Server-side, as
// pinned files are, so every devc web window on this host opens the same one, and each host (home,
// work) has its own. Not a pinned file: a file can be the dashboard, pinned, both or neither.

import { dirname } from 'jsr:@std/path';
import { CONFIG_DIR } from '@devc-tools/core/default_config.ts';

export const DASHBOARD_PATH = `${CONFIG_DIR}/dashboard.json`;

/** A repo file: `path` is relative to `root`, one of the repo folders of the project `localFolder`. */
export interface DashboardFile {
  localFolder: string;
  root: string;
  path: string;
}

interface DashboardJson {
  version: 1;
  file: DashboardFile | null;
}

function isDashboardFile(v: unknown): v is DashboardFile {
  if (typeof v !== 'object' || v === null) return false;
  const f = v as Record<string, unknown>;
  return typeof f.localFolder === 'string' && f.localFolder.startsWith('/') &&
    typeof f.root === 'string' && f.root.startsWith('/') &&
    typeof f.path === 'string' && f.path !== '' && !f.path.startsWith('/');
}

/** Missing, unreadable or malformed → null; never throws. */
export async function readDashboard(
  path = DASHBOARD_PATH,
): Promise<DashboardFile | null> {
  let data: unknown;
  try {
    data = JSON.parse(await Deno.readTextFile(path));
  } catch {
    return null;
  }
  const file = (data as { file?: unknown } | null)?.file;
  if (!isDashboardFile(file)) return null;
  return { localFolder: file.localFolder, root: file.root, path: file.path };
}

/**
 * Writes the dashboard atomically (a temp file renamed over the old one in the same directory), so
 * a reader never sees half a file.
 */
export async function writeDashboard(
  file: DashboardFile | null,
  path = DASHBOARD_PATH,
): Promise<void> {
  const dir = dirname(path);
  await Deno.mkdir(dir, { recursive: true });
  const tmp = await Deno.makeTempFile({ dir, prefix: '.dashboard-' });
  try {
    const json: DashboardJson = { version: 1, file };
    await Deno.writeTextFile(tmp, JSON.stringify(json, null, 2) + '\n');
    await Deno.rename(tmp, path);
  } catch (e) {
    await Deno.remove(tmp).catch(() => {});
    throw e;
  }
}

/** What the page is sent. */
export function dashboardMessage(file: DashboardFile | null) {
  return { type: 'dashboard' as const, file };
}
